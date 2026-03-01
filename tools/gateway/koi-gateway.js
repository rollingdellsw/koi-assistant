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
// Configuration
// =============================================================================

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
  }

  async start() {
    return new Promise((resolve, reject) => {
      console.log(`[MCP:${this.name}] Starting: ${this.config.command} ${this.config.args.join(' ')}`);

      const env = { ...process.env, ...this.config.env };

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
        reject(error);
      });

      this.process.on('close', (code) => {
        console.log(`[MCP:${this.name}] Process exited with code ${code}`);
        this.ready = false;
      });

      // Give it a moment to start
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.ready = true;
          resolve();
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
    this.wss = new WebSocketServer({ port: this.config.port });

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
              mcpProcess = await this.getOrCreateMCPProcess(serverName, serverConfig);
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
        // Note: We don't stop the MCP process here to allow reuse
        // In production, you'd want connection pooling with timeouts
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

  validateAuth(token) {
    // In 'sso' mode, validate the token
    // For now, this is a placeholder
    if (this.config.auth.mode === 'sso') {
      // TODO: Implement actual SSO validation
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
