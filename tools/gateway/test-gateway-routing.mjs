#!/usr/bin/env node
/**
 * test-gateway-routing.mjs — JSON-RPC routing through koi-gateway when one
 * pooled MCP process serves several WebSocket connections.
 *
 * Runs the real gateway against a tiny fake MCP server (no sandbox, no browser).
 *
 *   1. A reply that arrives after its connection closed is dropped — it must
 *      not reach the reconnected client that reused the same request id.
 *   2. Two live clients using the same request id each get only their own reply.
 *   3. A server-initiated request goes to exactly one client (the newest);
 *      notifications still go to every client.
 *
 * Usage:  node test-gateway-routing.mjs
 */

import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.join(SELF_DIR, 'koi-gateway.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}`);
  if (!ok && detail !== undefined) console.log(`        ${detail}`);
}

const FAKE_SERVER = `
let buf = '';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', (c) => {
  buf += c;
  const lines = buf.split('\\n'); buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'slow') setTimeout(() => out({ jsonrpc: '2.0', id: m.id, result: { tag: m.params.tag } }), 800);
    else if (m.method === 'fast') out({ jsonrpc: '2.0', id: m.id, result: { tag: m.params.tag } });
    else if (m.method === 'trigger') {
      out({ jsonrpc: '2.0', id: 'srv-1', method: 'elicitation/create', params: {} });
      out({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } });
      out({ jsonrpc: '2.0', id: m.id, result: {} });
    }
  }
});
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function connectClient(port, name) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const ws = await new Promise((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${port}/mcp/fake`);
        s.once('open', () => resolve(s));
        s.once('error', reject);
      });
      const client = { name, ws, messages: [] };
      ws.on('message', (d) => client.messages.push(JSON.parse(d.toString())));
      ws.send(JSON.stringify({ type: 'auth', token: '' }));
      for (let i = 0; i < 100 && !client.messages.some((m) => m.type === 'ready'); i++) await sleep(50);
      if (!client.messages.some((m) => m.type === 'ready')) throw new Error(`${name}: no ready`);
      return client;
    } catch (e) {
      if (attempt === 49) throw e;
      await sleep(100);
    }
  }
  throw new Error('unreachable');
}

const send = (client, msg) => client.ws.send(JSON.stringify({ jsonrpc: '2.0', ...msg }));
const replies = (client, id) => client.messages.filter((m) => m.id === id && m.method === undefined && m.type === undefined);

async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(25); }
  return pred();
}

async function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-gw-routing-'));
  const fake = path.join(tmp, 'fake-mcp.mjs');
  fs.writeFileSync(fake, FAKE_SERVER);
  const port = await freePort();
  const config = path.join(tmp, 'gateway-config.json');
  fs.writeFileSync(config, JSON.stringify({
    port, auth: { mode: 'none' }, allowedOrigins: [],
    servers: { fake: { command: process.execPath, args: [fake] } },
  }));

  const gw = spawn(process.execPath, [GATEWAY, '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
  let gwLog = '';
  gw.stdout.on('data', (d) => { gwLog += d; });
  gw.stderr.on('data', (d) => { gwLog += d; });
  const clients = [];

  try {
    console.log('\n── 1. Late reply after reconnect');
    const a = await connectClient(port, 'A'); clients.push(a);
    send(a, { id: 1, method: 'slow', params: { tag: 'A' } });
    await sleep(100);
    a.ws.close();
    const b = await connectClient(port, 'B'); clients.push(b);
    send(b, { id: 1, method: 'fast', params: { tag: 'B' } });
    await waitFor(() => replies(b, 1).length >= 1);
    await sleep(1200); // the slow reply for A has now arrived at the gateway
    const bIds = replies(b, 1).map((m) => m.result?.tag);
    check('reconnected client got its own reply', bIds.includes('B'), JSON.stringify(bIds));
    check("closed connection's late reply was not delivered to it", !bIds.includes('A'), JSON.stringify(bIds));
    check('client-visible ids are restored (numeric 1)', replies(b, 1).every((m) => m.id === 1));

    console.log('\n── 2. Same id on two live connections');
    const c = await connectClient(port, 'C'); clients.push(c);
    send(b, { id: 5, method: 'fast', params: { tag: 'B5' } });
    send(c, { id: 5, method: 'fast', params: { tag: 'C5' } });
    await waitFor(() => replies(b, 5).length >= 1 && replies(c, 5).length >= 1);
    await sleep(200);
    check('B received only B5', JSON.stringify(replies(b, 5).map((m) => m.result?.tag)) === '["B5"]', JSON.stringify(replies(b, 5)));
    check('C received only C5', JSON.stringify(replies(c, 5).map((m) => m.result?.tag)) === '["C5"]', JSON.stringify(replies(c, 5)));

    console.log('\n── 3. Server-initiated requests and notifications');
    send(c, { id: 9, method: 'trigger', params: {} });
    await waitFor(() => replies(c, 9).length >= 1);
    await sleep(200);
    const elicit = (cl) => cl.messages.filter((m) => m.method === 'elicitation/create').length;
    const notes = (cl) => cl.messages.filter((m) => m.method === 'notifications/message').length;
    check('server request delivered to exactly one client (the newest)', elicit(c) === 1 && elicit(b) === 0, `B=${elicit(b)} C=${elicit(c)}`);
    check('notification delivered to every client', notes(b) === 1 && notes(c) === 1, `B=${notes(b)} C=${notes(c)}`);
  } finally {
    for (const cl of clients) { try { cl.ws.close(); } catch { /* closed */ } }
    gw.kill('SIGTERM');
    await new Promise((r) => gw.once('exit', r));
    if (results.some((x) => !x.ok)) console.log(`\n── gateway log (tail)\n${gwLog.split('\n').slice(-25).join('\n')}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${'─'.repeat(60)}`);
  if (!failed.length) { console.log(`✅ PASS — ${results.length}/${results.length} assertions`); return 0; }
  console.log(`❌ FAIL — ${failed.length}/${results.length} assertions failed:`);
  for (const f of failed) console.log(`   • ${f.name}`);
  return 1;
}

runTest().then((code) => process.exit(code), (err) => {
  console.error(`\n💥 ERROR: ${err.message}`);
  process.exit(2);
});
