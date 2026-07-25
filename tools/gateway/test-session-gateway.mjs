#!/usr/bin/env node
/**
 * test-session-gateway.mjs — verifies the fresh-per-session overlay contract.
 *
 * The overlay that holds a session's edits is scoped to the MCP `initialize`
 * handshake, i.e. to a client connection. The observable contract:
 *   - A NEW connection starts every project from the read-only host tree (a
 *     "FRESH" base) and never inherits a previous session's unshipped edits.
 *   - Within ONE connection, switching a project away and back reuses the same
 *     overlay so in-progress work is not lost (covered by test-sandbox-gateway).
 *   - resume:"<session>" deliberately reattaches a prior session's overlay.
 *
 * The gateway pools the sandbox process across connections, so proving "a new
 * session is clean even against the same process" requires TWO real, sequential
 * connections — which is why this lives in its own file rather than the single-
 * client suite. Run:
 *   node tools/gateway/test-session-gateway.mjs
 *
 * Env: GATEWAY_URL (default ws://localhost:8080), SERVER_NAME (default sandbox).
 *
 * NOTE: connections are opened one at a time. Do not run concurrent sessions
 * against a single pooled process — the session id is process-global, so
 * overlapping connections would clobber each other's session.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { GatewayClient, section } from './test-sandbox-gateway.mjs';

const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://localhost:8080';
const SERVER_NAME = process.env.SERVER_NAME || 'sandbox';

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  \u2705 ${label}`); }
  else { failed++; console.log(`  \u274c ${label}${detail ? ` \u2014 ${detail}` : ''}`); }
}

async function newConnection(name) {
  const c = new GatewayClient(GATEWAY_URL, SERVER_NAME);
  await c.connect();
  await c.rpc('initialize', {
    protocolVersion: '2024-11-05',
    clientInfo: { name, version: '1.0.0' },
    capabilities: {},
  });
  c.notify('notifications/initialized');
  return c;
}

async function main() {
  console.log(`Connecting to ${GATEWAY_URL}/mcp/${SERVER_NAME} (two sequential sessions) ...`);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-session-'));
  const greenfieldPath = path.join(os.tmpdir(), `koi-session-greenfield-${Date.now()}`); // deliberately NOT created
  const marker = `koi-fresh-probe-${Date.now()}.txt`;
  let session1 = null;

  // ---- session 1: write a marker into its overlay --------------------------
  section('session 1 (first connection) edits its overlay');
  {
    const c1 = await newConnection('session1');
    try {
      const open1 = await c1.callTool('sandbox_open_project', { path: project });
      check('session 1 opens FRESH from host', open1.success === true && open1.baseKind === 'FRESH', JSON.stringify(open1.base));
      session1 = open1.session;
      check('session 1 has a session id', typeof session1 === 'string' && session1.length > 0);
      const w = await c1.callTool('sandbox_write_file', { path: marker, content: 'from session 1\n' });
      check('session 1 write ok', w.success === true, JSON.stringify(w)?.slice(0, 150));
      const r = await c1.callTool('sandbox_exec', { command: `cat -- '${marker}'` });
      check('session 1 sees its own overlay edit', r.exitCode === 0 && /from session 1/.test(r.stdout || ''), r.stderr);
    } finally { c1.close(); }
  }
  await new Promise((r) => setTimeout(r, 400));

  // ---- session 2: a NEW connection must start from the host base -----------
  section('session 2 (second connection) starts fresh from host');
  {
    const c2 = await newConnection('session2');
    try {
      const open2 = await c2.callTool('sandbox_open_project', { path: project });
      check('session 2 gets a different session id', typeof open2.session === 'string' && open2.session !== session1, `${open2.session} vs ${session1}`);
      check('session 2 reports FRESH base', open2.baseKind === 'FRESH', JSON.stringify(open2.base));
      check('session 2 lists session 1 under priorSessions', (open2.priorSessions || []).some((s) => s.id === session1), JSON.stringify(open2.priorSessions));
      const r = await c2.callTool('sandbox_exec', { command: `cat -- '${marker}'` });
      check('session 2 does NOT inherit session 1 overlay edit', r.exitCode !== 0, `unexpectedly read: ${(r.stdout || '').trim()}`);

      // ---- resume: deliberately reattach session 1's overlay --------------
      section('resume reattaches a prior session on demand');
      const open3 = await c2.callTool('sandbox_open_project', { path: project, resume: session1 });
      check('resume reattaches the requested session', open3.success === true && open3.resumed === true && open3.session === session1, JSON.stringify(open3)?.slice(0, 200));
      const r3 = await c2.callTool('sandbox_exec', { command: `cat -- '${marker}'` });
      check('resumed overlay shows session 1 edit again', r3.exitCode === 0 && /from session 1/.test(r3.stdout || ''), r3.stderr);

      // ---- resume with a bogus id is rejected -----------------------------
      const openBad = await c2.callTool('sandbox_open_project', { path: project, resume: 'no-such-session-xyz' });
      check('resume with unknown session id is rejected', openBad.success === false, JSON.stringify(openBad)?.slice(0, 150));

      // cleanup: attached to session 1's overlay now — remove the marker.
      await c2.callTool('sandbox_exec', { command: `rm -f -- '${marker}'` }).catch(() => {});

      // ---- greenfield stays off the host ----------------------------------
      // Opening a path that does not exist must never create it on the host:
      // the new project lives entirely in the session overlay, same isolation
      // contract as edits to an existing project.
      section('greenfield project never touches the host');
      const gfOpen = await c2.callTool('sandbox_open_project', { path: greenfieldPath });
      check('greenfield opens and is flagged', gfOpen.success === true && gfOpen.greenfield === true, JSON.stringify(gfOpen)?.slice(0, 200));
      check('greenfield reports FRESH base', gfOpen.baseKind === 'FRESH', JSON.stringify(gfOpen.base));
      check('open did NOT create the path on the host', !fs.existsSync(greenfieldPath), `${greenfieldPath} exists on host!`);
      const gfW = await c2.callTool('sandbox_write_file', { path: 'index.js', content: 'console.log(1)\n' });
      check('greenfield write ok', gfW.success === true, JSON.stringify(gfW)?.slice(0, 150));
      check('write did NOT create the path on the host', !fs.existsSync(greenfieldPath), `${greenfieldPath} exists on host!`);
    } finally { c2.close(); }
  }

  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(greenfieldPath, { recursive: true, force: true }); // best-effort; normally absent

  section('RESULT');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(failed === 0
    ? '  \ud83c\udf89 fresh-per-session base verified (new connection = clean overlay; resume reattaches).'
    : '  \u26a0\ufe0f Some checks failed \u2014 see above.');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(`\n\u274c Test run failed: ${e.message}`); process.exit(1); });
