#!/usr/bin/env node
/**
 * Koi Gateway - Simple WebSocket to MCP stdio bridge
 *
 * Usage:
 *   node koi-gateway.js [--config ./gateway-config.json] [--port 8080]
 *
 * This bridges WebSocket connections from the Chrome Extension to MCP servers
 * running as child processes (stdio transport).
 */

import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// =============================================================================
// Crash-proofing
// =============================================================================

// This bridge is a single point of failure for every Koi session on the host,
// and when it dies the only symptom anyone sees is a "Koi Gateway unavailable"
// banner in the side panel — which reads like a network problem and sent one
// investigation into Blender's addon for a week. Two handlers so that a bug
// here produces a stack trace and a live process instead of silence and a dead
// port. Neither is a substitute for the specific listeners added below; they
// are the net under them.
process.on('uncaughtException', (error) => {
  console.error('[Gateway] UNCAUGHT EXCEPTION — staying up:',
    (error && error.stack) || String(error));
});
process.on('unhandledRejection', (reason) => {
  console.error('[Gateway] UNHANDLED REJECTION — staying up:',
    (reason && reason.stack) || String(reason));
});

// Anything at or above this many bytes gets logged on the way through, in both
// directions. A tool that returns an image (get_viewport_screenshot) produces
// one frame two orders of magnitude larger than everything else on the wire,
// and until now nothing recorded whether that frame left the gateway, which is
// the whole question when the client reports a 1006 close.
const LARGE_FRAME_BYTES = Number(process.env.KOI_GW_LARGE_FRAME || 64 * 1024);

// A single JSON-RPC line should never approach this. If the accumulator does,
// either the child is emitting something that is not newline-delimited JSON or
// a frame is genuinely enormous; say so rather than growing until the heap
// gives out.
const STDOUT_BUFFER_WARN_BYTES = Number(
  process.env.KOI_GW_BUFFER_WARN || 8 * 1024 * 1024,
);

// =============================================================================
// Configuration
// =============================================================================

// Only these browser origins may open a WebSocket to the Gateway. The Gateway
// fronts arbitrary code execution (sandbox-shell), and although it binds to
// loopback, any web page in the user's own browser can still reach
// ws://127.0.0.1 — WebSocket upgrades are not subject to CORS. Browsers DO send
// an Origin header on the upgrade, so we reject any request whose Origin is not
// the Koi extension. Non-browser clients (the test harness, curl) send no
// Origin and are allowed through; tighten this with an auth token if the host
// is shared. Override via `allowedOrigins` in the config file.
const DEFAULT_ALLOWED_ORIGINS = [
  'chrome-extension://aedfofodkbfgnjknkjpockkgajemkbng', // Koi (official)
  'chrome-extension://ckcmgcddobmmbcneegigkkdfljiademi', // Koi (dev/unpacked)
];

const DEFAULT_CONFIG = {
  port: 8080,
  auth: { mode: 'none' },
  servers: {
    postgres: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres'],
      env: {
        // Will be overridden by config file or environment
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://localhost:5432/postgres'
      }
    }
  }
};

function loadConfig() {
  const args = process.argv.slice(2);
  let configPath = null;
  let port = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      configPath = args[i + 1];
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
  }

  let config = { ...DEFAULT_CONFIG };

  if (configPath) {
    try {
      const fileContent = fs.readFileSync(path.resolve(configPath), 'utf8');
      const fileConfig = JSON.parse(fileContent);
      config = { ...config, ...fileConfig };
      console.log(`[Gateway] Loaded config from ${configPath}`);
    } catch (error) {
      console.error(`[Gateway] Failed to load config: ${error.message}`);
      process.exit(1);
    }
  }

  if (port) {
    config.port = port;
  }

  return config;
}

// =============================================================================
// MCP Process Manager
// =============================================================================

class MCPProcess {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.process = null;
    this.ready = false;
    this.buffer = '';
    this.messageHandlers = new Set();
    // The handler that receives server-initiated REQUESTS (e.g. a network
    // approval elicitation). Exactly one client may answer a request; the most
    // recently attached connection is the one the user is looking at.
    this.primaryHandler = null;
    // True once any connection has forwarded an `initialize`. The child
    // outlives the WebSocket that created it, so a reconnecting client sends a
    // second initialize to an already-initialized server. That is not legal
    // MCP and different servers react differently; log it rather than let it
    // present as an unexplained failure two calls later.
    this.initialized = false;
    // Set by the Gateway so a child that dies is evicted from the process map
    // instead of lingering as a not-ready entry.
    this.onExit = null;
  }

  async start() {
    return new Promise((resolve, reject) => {
      console.log(`[MCP:${this.name}] Starting: ${this.config.command} ${this.config.args.join(' ')}`);

      const env = { ...process.env, ...this.config.env };
      let settled = false;
      const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

      this.process = spawn(this.config.command, this.config.args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.process.stdout.on('data', (data) => {
        this.handleStdout(data.toString());
      });

      this.process.stderr.on('data', (data) => {
        console.error(`[MCP:${this.name}:stderr] ${data.toString().trim()}`);
      });

      // THE crash path this file did not survive. `send()` writes to
      // this.process.stdin; if the child is gone — blender-mcp exited, the
      // `podman exec` lost its container — the write raises EPIPE as an
      // 'error' EVENT on the stream, and a stream error with no listener is
      // rethrown by Node as an uncaught exception, which takes the whole
      // gateway down and with it every other server it was bridging. Nothing
      // in the request path caused it and nothing in the logs explained it:
      // the client just saw its socket close 1006 and the port stay dead.
      //
      // Note which client triggers it. The Chrome extension pings every 20s
      // (RemoteMCPClient.startKeepAlive); the smoke test never pings. So a
      // child that died quietly is fatal from the extension and invisible from
      // the test harness — exactly the asymmetry that made this look like a
      // browser-side bug.
      for (const [label, stream] of [
        ['stdin', this.process.stdin],
        ['stdout', this.process.stdout],
        ['stderr', this.process.stderr],
      ]) {
        if (!stream) continue;
        stream.on('error', (error) => {
          console.error(
            `[MCP:${this.name}:${label}] stream error ${error.code || ''} ${error.message}`,
          );
          if (label === 'stdin') this.ready = false;
        });
      }

      this.process.on('error', (error) => {
        console.error(`[MCP:${this.name}] Process error:`, error.message);
        this.ready = false;
        settle(reject, error);
      });

      this.process.on('close', (code, signal) => {
        console.log(
          `[MCP:${this.name}] Process exited with code ${code}${signal ? ` (signal ${signal})` : ''}`,
        );
        this.ready = false;
        // If it dies before the startup grace period, the client must NOT be
        // told the server is ready (previously this raced and "authenticated"
        // clients against a dead process).
        settle(reject, new Error(`MCP server '${this.name}' exited with code ${code} during startup`));
        // After the grace period settle() is a no-op, so this is the only
        // notification anybody gets that the child is gone.
        if (typeof this.onExit === 'function') {
          try { this.onExit(this, code, signal); } catch (e) {
            console.error(`[MCP:${this.name}] onExit handler threw:`, e.message);
          }
        }
      });

      // Give it a moment to start
      setTimeout(() => {
        if (this.process && !this.process.killed && this.process.exitCode === null) {
          this.ready = true;
          settle(resolve);
        }
      }, 500);
    });
  }

  handleStdout(data) {
    this.buffer += data;

    if (this.buffer.length >= STDOUT_BUFFER_WARN_BYTES) {
      console.error(
        `[MCP:${this.name}] stdout accumulator at ${this.buffer.length} bytes ` +
        `with no newline yet — the child may not be emitting NDJSON`,
      );
    }

    // MCP uses newline-delimited JSON
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      // Parse and dispatch are now separate. They used to share one try block,
      // so a handler that threw — ws.send() on a socket in the wrong state, for
      // instance — was reported as `Invalid JSON: {"jsonrpc"...`. That is a
      // message that sends you to look at the payload when the payload was
      // fine, and it is why "the gateway corrupts large frames" was a working
      // theory for as long as it was.
      let message;
      try {
        message = JSON.parse(line);
      } catch (e) {
        console.error(
          `[MCP:${this.name}] Invalid JSON (${Buffer.byteLength(line)} bytes):`,
          line.substring(0, 100),
        );
        continue;
      }

      const bytes = Buffer.byteLength(line);
      if (bytes >= LARGE_FRAME_BYTES) {
        console.log(
          `[MCP:${this.name}] <- child: ${bytes} bytes, id=${JSON.stringify(message.id)}, ` +
          `handlers=${this.messageHandlers.size}`,
        );
      }

      // Snapshot the Set: a handler may remove itself (its socket closing
      // mid-dispatch does exactly that), and mutating a Set while iterating it
      // silently skips entries.
      for (const handler of [...this.messageHandlers]) {
        try {
          handler(message, bytes);
        } catch (e) {
          console.error(
            `[MCP:${this.name}] message handler threw on a ${bytes}-byte frame:`,
            (e && e.stack) || e.message,
          );
        }
      }
    }
  }

  send(message) {
    const stdin = this.process && this.process.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      // Silently returning here used to mean a client waited out its full
      // 150s RPC timeout against a child that had already exited.
      console.error(
        `[MCP:${this.name}] dropping ${message.method || 'response'} ` +
        `(id=${JSON.stringify(message.id)}): child stdin is gone`,
      );
      this.ready = false;
      return false;
    }
    try {
      stdin.write(JSON.stringify(message) + '\n');
      return true;
    } catch (error) {
      console.error(
        `[MCP:${this.name}] stdin.write threw ${error.code || ''}: ${error.message}`,
      );
      this.ready = false;
      return false;
    }
  }

  addMessageHandler(handler) {
    this.messageHandlers.add(handler);
    this.primaryHandler = handler;
  }

  removeMessageHandler(handler) {
    this.messageHandlers.delete(handler);
    if (this.primaryHandler === handler) {
      this.primaryHandler = [...this.messageHandlers].pop() || null;
    }
  }

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.ready = false;
    }
  }
}

// =============================================================================
// WebSocket Gateway
// =============================================================================

class Gateway {
  constructor(config) {
    this.config = config;
    this.wss = null;
    this.mcpProcesses = new Map(); // serverName -> MCPProcess
    this.connectionSeq = 0;
  }

  start() {
    // Loopback only: the gateway now fronts arbitrary code execution
    // (sandbox-shell), so it must never be reachable from the LAN.
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.config.port });

    console.log(`[Gateway] Listening on ws://localhost:${this.config.port}`);
    console.log(`[Gateway] Available MCP servers: ${Object.keys(this.config.servers).join(', ')}`);
    console.log(`[Gateway] Auth mode: ${this.config.auth.mode}`);

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (error) => {
      console.error('[Gateway] Server error:', error.message);
    });
  }

  async handleConnection(ws, req) {
    // Origin allowlist: block drive-by connections from arbitrary web pages in
    // the user's browser. A browser always sends Origin on the WS upgrade; a
    // missing Origin means a non-browser client (test harness / curl).
    const origin = req.headers.origin;
    if (origin && !this.isAllowedOrigin(origin)) {
      console.log(`[Gateway] Rejected connection from disallowed origin: ${origin}`);
      ws.close(1008, 'Origin not allowed');
      return;
    }

    const url = new URL(req.url, `http://localhost:${this.config.port}`);
    const pathParts = url.pathname.split('/').filter(Boolean);

    // Expected path: /mcp/{serverName}
    if (pathParts[0] !== 'mcp' || !pathParts[1]) {
      console.log(`[Gateway] Invalid path: ${req.url}`);
      ws.close(1008, 'Invalid path. Use /mcp/{serverName}');
      return;
    }

    const serverName = pathParts[1];
    const serverConfig = this.config.servers[serverName];

    if (!serverConfig) {
      console.log(`[Gateway] Unknown server: ${serverName}`);
      ws.close(1008, `Unknown MCP server: ${serverName}`);
      return;
    }

    console.log(`[Gateway] New connection for server: ${serverName}`);

    // Wait for auth message
    let authenticated = false;
    let mcpProcess = null;

    // One MCP process serves every connection for this server name, and each
    // client numbers its JSON-RPC requests from 1. Broadcasting every message
    // to every connection let a reconnected client receive the previous
    // connection's late reply under an id it had just reused — a result
    // attributed to the wrong call. Requests are therefore forwarded under a
    // connection-scoped id and responses are routed back only to their sender,
    // with the client's original id restored. A response whose connection has
    // closed is dropped.
    const connectionId = ++this.connectionSeq;
    const idPrefix = `koi-gw:${connectionId}:`;

    // One place where anything reaches the browser, so one place that knows
    // whether it got there. `ws.send(data)` with no callback reports a failure
    // by emitting 'error' on the socket, which is handled far away from the
    // frame that caused it; with a callback the failure is attributable. The
    // size log either side of it answers the only question that matters when a
    // client reports a 1006 close on a screenshot: did the big frame leave
    // this process, and did it flush?
    const sendToClient = (payload, note) => {
      if (ws.readyState !== ws.OPEN) {
        console.error(
          `[Gateway] dropping ${note} for ${serverName} #${connectionId}: ` +
          `socket readyState ${ws.readyState}`,
        );
        return;
      }
      const json = JSON.stringify(payload);
      const bytes = Buffer.byteLength(json);
      if (bytes >= LARGE_FRAME_BYTES) {
        console.log(
          `[Gateway] -> #${connectionId} ${serverName}: sending ${bytes} bytes ` +
          `(${note}, already buffered ${ws.bufferedAmount})`,
        );
      }
      try {
        ws.send(json, (error) => {
          if (error) {
            console.error(
              `[Gateway] -> #${connectionId} ${serverName}: send FAILED after ` +
              `${bytes} bytes (${note}): ${error.message}`,
            );
          } else if (bytes >= LARGE_FRAME_BYTES) {
            console.log(
              `[Gateway] -> #${connectionId} ${serverName}: flushed ${bytes} bytes (${note})`,
            );
          }
        });
      } catch (error) {
        console.error(
          `[Gateway] -> #${connectionId} ${serverName}: send threw on ${bytes} ` +
          `bytes (${note}): ${error.message}`,
        );
      }
    };

    const messageHandler = (mcpMessage) => {
      const hasId = mcpMessage.id !== undefined && mcpMessage.id !== null;
      if (mcpMessage.method === undefined) {
        // Response: deliver only to the connection that sent the request.
        if (!hasId || typeof mcpMessage.id !== 'string' || !mcpMessage.id.startsWith(idPrefix)) return;
        let originalId;
        try { originalId = JSON.parse(mcpMessage.id.slice(idPrefix.length)); } catch { return; }
        sendToClient({ ...mcpMessage, id: originalId }, `response id=${originalId}`);
        return;
      }
      if (hasId && mcpProcess && mcpProcess.primaryHandler !== messageHandler) {
        return; // server-initiated request: exactly one client answers it
      }
      sendToClient(mcpMessage, `server ${mcpMessage.method}`); // notifications go to every client
    };

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        // First message must be auth
        if (!authenticated) {
          if (message.type === 'auth') {
            // Validate auth (for now, just accept in 'none' mode)
            if (this.config.auth.mode === 'none' || this.validateAuth(message.token)) {
              authenticated = true;

              // Get or create MCP process
              try {
                mcpProcess = await this.getOrCreateMCPProcess(serverName, serverConfig);
              } catch (spawnError) {
                console.error(`[Gateway] Failed to start MCP '${serverName}':`, spawnError.message);
                ws.close(1011, `MCP server failed to start: ${spawnError.message}`.slice(0, 120));
                return;
              }
              mcpProcess.addMessageHandler(messageHandler);

              // Send ready
              ws.send(JSON.stringify({ type: 'ready', server: serverName }));
              console.log(`[Gateway] Client authenticated for ${serverName}`);
            } else {
              ws.close(1008, 'Unauthorized');
            }
          } else {
            ws.close(1008, 'First message must be auth');
          }
          return;
        }

        // Forward JSON-RPC messages to MCP process. Client requests travel
        // under a connection-scoped id (see messageHandler); notifications and
        // the client's replies to server-initiated requests pass through as-is.
        if (message.jsonrpc === '2.0') {
          const isRequest = message.method !== undefined && message.id !== undefined && message.id !== null;

          // The child outlives the socket that spawned it, so a reconnecting
          // client re-runs the handshake against a server that is already
          // initialized. Flag it: it is not legal MCP, servers differ in how
          // they react, and it happens on every reconnect the extension makes
          // while the test harness only ever does it once.
          if (message.method === 'initialize') {
            if (mcpProcess.initialized) {
              console.log(
                `[Gateway] NOTE: '${serverName}' child was already initialized; ` +
                `forwarding a second initialize from #${connectionId}`,
              );
            }
            mcpProcess.initialized = true;
          }

          const forwarded = mcpProcess.send(
            isRequest ? { ...message, id: idPrefix + JSON.stringify(message.id) } : message,
          );
          // Tell the caller now instead of letting it time out in 150s.
          if (!forwarded && isRequest) {
            sendToClient(
              {
                jsonrpc: '2.0',
                id: message.id,
                error: {
                  code: -32000,
                  message:
                    `MCP server '${serverName}' is not running (its stdin is closed). ` +
                    `The gateway will respawn it on the next connection.`,
                },
              },
              'child-gone error',
            );
          }
        }
      } catch (error) {
        console.error('[Gateway] Message handling error:', error.message);
      }
    });

    ws.on('close', () => {
      console.log(`[Gateway] Connection closed for ${serverName}`);
      if (mcpProcess) {
        mcpProcess.removeMessageHandler(messageHandler);
        // MCP process is kept alive for reuse by subsequent connections.
        // TODO: Add idle timeout to reclaim processes with no active clients,
        // and connection pooling for high-concurrency deployments.
      }
    });

    ws.on('error', (error) => {
      console.error(`[Gateway] WebSocket error:`, error.message);
    });
  }

  async getOrCreateMCPProcess(name, config) {
    let mcp = this.mcpProcesses.get(name);

    // A not-ready entry used to be replaced but never stopped, so the old
    // child kept running unreferenced. For `blender` that is not cosmetic:
    // each child opens the addon's socket on 127.0.0.1:9876, the addon serves
    // exactly one client at a time, and a second `podman exec blender-mcp`
    // holding it produces the whole "connection closed" family of symptoms
    // from a bridge that is otherwise healthy.
    if (mcp && !mcp.ready) {
      console.log(`[Gateway] Reaping dead MCP '${name}' before respawn`);
      mcp.stop();
      this.mcpProcesses.delete(name);
      mcp = null;
    }

    if (!mcp) {
      mcp = new MCPProcess(name, config);
      mcp.onExit = (dead) => {
        if (this.mcpProcesses.get(name) === dead) this.mcpProcesses.delete(name);
      };
      await mcp.start();
      this.mcpProcesses.set(name, mcp);
    }

    return mcp;
  }

  isAllowedOrigin(origin) {
    const allow = this.config.allowedOrigins || DEFAULT_ALLOWED_ORIGINS;
    return allow.includes(origin);
  }

  validateAuth(token) {
    // SSO validation architecture (see enterprise-data-security.md):
    // The Gateway validates the user's SSO token against the corporate IdP
    // (Okta, Azure AD, Google Workspace). It does NOT implement SSO itself —
    // the browser extension obtains the token via chrome.identity and forwards
    // it here. The Gateway's job is to confirm the token is valid before
    // proxying MCP requests to backend servers that hold sensitive credentials.
    if (this.config.auth.mode === 'sso') {
      // TODO: Implement IdP token verification (e.g. OIDC introspection endpoint)
      return token && token.length > 0;
    }
    return true;
  }

  stop() {
    for (const [name, mcp] of this.mcpProcesses) {
      console.log(`[Gateway] Stopping MCP: ${name}`);
      mcp.stop();
    }
    this.mcpProcesses.clear();

    if (this.wss) {
      this.wss.close();
    }
  }
}

// =============================================================================
// Main
// =============================================================================

const config = loadConfig();
const gateway = new Gateway(config);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Gateway] Shutting down...');
  gateway.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Gateway] Received SIGTERM, shutting down...');
  gateway.stop();
  process.exit(0);
});

gateway.start();

console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    Koi Gateway Started                       ║
╠══════════════════════════════════════════════════════════════╣
║  WebSocket URL: ws://localhost:${config.port.toString().padEnd(27)}║
║  Auth Mode: ${config.auth.mode.padEnd(44)}║
║                                                              ║
║  Available MCP servers:                                      ║
${Object.keys(config.servers).map(s => `║    • ${s.padEnd(52)}║`).join('\n')}
║                                                              ║
║  Press Ctrl+C to stop                                        ║
╚══════════════════════════════════════════════════════════════╝
`);
