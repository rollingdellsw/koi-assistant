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
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

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
// Auto-build — servers can declare an "autoBuild" block in the config:
//   "autoBuild": {
//     "dir": "./lsp_search",                  // package dir (relative to cwd)
//     "check": "dist/index.js",               // build output to test for
//     "srcDir": "src",                        // rebuilt if sources are newer
//     "commands": ["npm install", "npm run build"]
//   }
// Runs at gateway startup, before listening. Skipped when the check file
// exists and is newer than every file under srcDir. KOI_REBUILD=1 forces.
// =============================================================================

function newestMtime(dir) {
  let newest = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      newest = Math.max(newest, newestMtime(p));
    } else if (ent.isFile()) {
      try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch { /* ignore */ }
    }
  }
  return newest;
}

function autoBuildServers(config) {
  for (const [name, srv] of Object.entries(config.servers)) {
    const ab = srv.autoBuild;
    if (!ab || !ab.dir) continue;
    const dir = path.resolve(ab.dir);
    if (!fs.existsSync(dir)) {
      console.error(`[Gateway] ${name}: autoBuild dir not found: ${dir} — skipping (server will not start)`);
      continue;
    }
    const checkPath = ab.check ? path.join(dir, ab.check) : null;
    const force = process.env.KOI_REBUILD === '1';
    if (!force && checkPath && fs.existsSync(checkPath)) {
      const built = fs.statSync(checkPath).mtimeMs;
      const src = newestMtime(path.join(dir, ab.srcDir || 'src'));
      if (built >= src) {
        console.log(`[Gateway] ${name}: build up to date (${ab.check}; KOI_REBUILD=1 to force)`);
        continue;
      }
      console.log(`[Gateway] ${name}: sources newer than ${ab.check} — rebuilding`);
    }
    const commands = ab.commands || ['npm install', 'npm run build'];
    let ok = true;
    for (const cmd of commands) {
      console.log(`[Gateway] ${name}: running '${cmd}' in ${dir} ...`);
      const r = spawnSync(cmd, { cwd: dir, shell: true, stdio: 'inherit' });
      if (r.status !== 0) {
        console.error(`[Gateway] ${name}: '${cmd}' failed (exit ${r.status}); this server will likely fail to start.`);
        ok = false;
        break;
      }
    }
    if (ok) console.log(`[Gateway] ${name}: build complete`);
  }
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

      this.process.on('error', (error) => {
        console.error(`[MCP:${this.name}] Process error:`, error.message);
        settle(reject, error);
      });

      this.process.on('close', (code) => {
        console.log(`[MCP:${this.name}] Process exited with code ${code}`);
        this.ready = false;
        // If it dies before the startup grace period, the client must NOT be
        // told the server is ready (previously this raced and "authenticated"
        // clients against a dead process).
        settle(reject, new Error(`MCP server '${this.name}' exited with code ${code} during startup`));
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

    // MCP uses newline-delimited JSON
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          for (const handler of this.messageHandlers) {
            handler(message);
          }
        } catch (e) {
          console.error(`[MCP:${this.name}] Invalid JSON:`, line.substring(0, 100));
        }
      }
    }
  }

  send(message) {
    if (this.process && this.process.stdin.writable) {
      const json = JSON.stringify(message);
      this.process.stdin.write(json + '\n');
    }
  }

  addMessageHandler(handler) {
    this.messageHandlers.add(handler);
  }

  removeMessageHandler(handler) {
    this.messageHandlers.delete(handler);
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

    const messageHandler = (mcpMessage) => {
      ws.send(JSON.stringify(mcpMessage));
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

        // Forward JSON-RPC messages to MCP process
        if (message.jsonrpc === '2.0') {
          mcpProcess.send(message);
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

    if (!mcp || !mcp.ready) {
      mcp = new MCPProcess(name, config);
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
autoBuildServers(config);
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
