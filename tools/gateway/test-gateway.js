#!/usr/bin/env node
/**
 * Gateway Test Client
 *
 * Tests the WebSocket connection to the gateway and executes a simple query.
 *
 * Usage:
 *   node test-gateway.js [table_name]
 *
 * Examples:
 *   node test-gateway.js              # Lists tables
 *   node test-gateway.js sessions     # Queries sessions table
 */

import WebSocket from 'ws';

const GATEWAY_URL = 'ws://localhost:8080/mcp/postgres';
const TABLE_NAME = process.argv[2] || null;

let callId = 0;
const pendingCalls = new Map();

function log(prefix, ...args) {
  console.log(`[${prefix}]`, ...args);
}

async function main() {
  log('Test', `Connecting to ${GATEWAY_URL}`);

  const ws = new WebSocket(GATEWAY_URL);

  ws.on('open', () => {
    log('Test', 'Connected, sending auth...');
    ws.send(JSON.stringify({ type: 'auth', token: null }));
  });

  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());

    // Handle gateway protocol messages
    if (msg.type === 'ready') {
      log('Test', `Gateway ready for server: ${msg.server}`);
      await runTests(ws);
      return;
    }

    if (msg.type === 'error') {
      log('Error', msg.message);
      ws.close();
      return;
    }

    // Handle JSON-RPC responses
    if (msg.jsonrpc === '2.0' && msg.id !== undefined) {
      const pending = pendingCalls.get(msg.id);
      if (pending) {
        pendingCalls.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || 'RPC Error'));
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  });

  ws.on('error', (error) => {
    log('Error', error.message);
  });

  ws.on('close', (code, reason) => {
    log('Test', `Connection closed: ${code} ${reason}`);
    process.exit(code === 1000 ? 0 : 1);
  });
}

function sendRequest(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = ++callId;
    pendingCalls.set(id, { resolve, reject });

    const request = { jsonrpc: '2.0', id, method, params };
    ws.send(JSON.stringify(request));

    // Timeout after 30s
    setTimeout(() => {
      if (pendingCalls.has(id)) {
        pendingCalls.delete(id);
        reject(new Error('Request timeout'));
      }
    }, 30000);
  });
}

async function runTests(ws) {
  try {
    // Step 1: Initialize MCP
    log('Test', 'Initializing MCP protocol...');
    await sendRequest(ws, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    log('Test', 'MCP initialized');

    // Step 2: List available tools
    log('Test', 'Listing tools...');
    const toolsResult = await sendRequest(ws, 'tools/list', {});
    const tools = toolsResult.tools || [];
    log('Test', `Available tools: ${tools.map(t => t.name).join(', ')}`);

    // Step 3: Execute a query
    if (TABLE_NAME) {
      log('Test', `Querying table: ${TABLE_NAME}`);
      const queryResult = await sendRequest(ws, 'tools/call', {
        name: 'query',
        arguments: {
          sql: `SELECT * FROM ${TABLE_NAME} LIMIT 5`
        }
      });

      log('Result', JSON.stringify(queryResult, null, 2));
    } else {
      // List tables
      log('Test', 'Listing tables...');
      const queryResult = await sendRequest(ws, 'tools/call', {
        name: 'query',
        arguments: {
          sql: `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
        }
      });

      log('Result', JSON.stringify(queryResult, null, 2));
    }

    log('Test', '✅ All tests passed!');
    ws.close(1000, 'Tests complete');

  } catch (error) {
    log('Error', `Test failed: ${error.message}`);
    ws.close(1011, 'Test failed');
  }
}

main().catch(console.error);
