#!/usr/bin/env node
/**
 * test-session-continuity.mjs — session continuity across reconnects, and
 * reconciliation that never drops overlay work silently.
 *
 * Talks DIRECTLY to sandbox-shell-mcp.mjs over stdio JSON-RPC, like
 * test-lower-layer-sync.mjs. Unlike that test it runs with the exec backend on
 * purpose: everything checked here is host-side bookkeeping — which session
 * overlay `initialize` + `sandbox_open_project` attach, and what
 * reconcileLowerToUpper does to files in the upperdir. It stands in for
 * overlayfs copy-ups by writing into the upperdir directly, so it needs no
 * bubblewrap and runs anywhere Node and git do.
 *
 * What it proves
 * --------------
 *   1. A reconnect that sends the same session key CONTINUES the overlay.
 *   2. The key finds the overlay again after a server restart.
 *   3. A different key is a different conversation: fresh overlay, no bogus
 *      "resume" advice, but the other conversation's overlay is pinned.
 *   4. Without a key, re-opening after a reconnect still attaches a fresh
 *      overlay (unchanged), but now says so: detachedSession + exact resume
 *      call, a sandbox_info note, and a GC pin. Resume brings the work back.
 *   5. A newer host write over uncommitted overlay content refreshes the file
 *      AND saves the overlay version, reported in hostSync.
 *   6. Overlay content git already has is refreshed without a spurious copy.
 *   7. A host deletion propagates to an overlay copy reconciliation installed,
 *      but never to a file the session created.
 *   8. An overlay branch tip the host lacks keeps a ref when the host ref wins.
 *   9. `initialize` is answered while a long sandbox_exec is still running.
 *
 * Usage:  node test-session-continuity.mjs      (KOI_TEST_KEEP=1 keeps temp dirs)
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(SELF_DIR, 'sandbox-shell-mcp.mjs');
const KEEP = process.env.KOI_TEST_KEEP === '1';
const GIT_ID = '-c user.name="Koi Continuity Test" -c user.email="koi-continuity-test@example.invalid"';
// The reconciler's no-manifest fallback compares mtimes; leave slack for 1s fs granularity.
const MTIME_SETTLE_MS = Number(process.env.KOI_TEST_MTIME_SETTLE_MS || 1100);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}`);
  if (!ok && detail !== undefined) console.log(`        ${String(detail).split('\n').join('\n        ')}`);
  return !!ok;
}

function step(n, title) {
  console.log(`\n── ${n}. ${title}`);
}

function hostShOk(cwd, command) {
  const r = spawnSync('/bin/bash', ['-c', command], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`host command failed (exit ${r.status}): ${command}\n${r.stdout}${r.stderr}`);
  return r.stdout;
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function findFiles(dir, name, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(p, name, acc);
    else if (e.name === name) acc.push(p);
  }
  return acc;
}

class SandboxServer {
  constructor({ project, state }) {
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.stderr = '';
    this.proc = spawn(process.execPath, [SERVER, '--project', project, '--state', state], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KOI_SANDBOX_BACKEND: 'exec', KOI_SANDBOX_PERSIST: '' },
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      const lines = this.buf.split('\n');
      this.buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`rpc error ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => { this.stderr = (this.stderr + c).slice(-32 * 1024); });
    this.exited = new Promise((r) => this.proc.once('exit', r));
  }

  rpc(method, params = {}, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`rpc timeout: ${method}\n${this.stderr}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** A client handshake; `key` is the conversation's session key, if any. */
  async handshake(key = null) {
    const params = { protocolVersion: '2024-11-05', clientInfo: { name: 'continuity-test', version: '1' }, capabilities: {} };
    if (key) params._meta = { 'koi/sessionKey': key };
    const res = await this.rpc('initialize', params);
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return res;
  }

  async tool(name, args = {}) {
    const res = await this.rpc('tools/call', { name, arguments: args });
    const text = (res.content || []).map((c) => c.text || '').join('\n');
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  async close() {
    try { this.proc.stdin.end(); } catch { /* gone */ }
    const t = setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
    await this.exited;
    clearTimeout(t);
  }
}

async function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-continuity-'));
  const repo = path.join(tmp, 'host-repo');
  const state = path.join(tmp, 'sandbox-state');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  let server = null;

  try {
    hostShOk(repo, 'git -c init.defaultRefFormat=files init -q && git symbolic-ref HEAD refs/heads/main');
    fs.writeFileSync(path.join(repo, 'runtime.rs'), '// base\n');
    fs.writeFileSync(path.join(repo, 'lib.rs'), '// lib base\n');
    hostShOk(repo, `git add -A && git ${GIT_ID} commit -q -m baseline`);

    server = new SandboxServer({ project: repo, state });

    // -- 1. same key reconnect ------------------------------------------------
    step(1, 'Reconnect with the same session key continues the overlay');
    await server.handshake('conv-A');
    let o = await server.tool('sandbox_open_project', { path: repo });
    const sessionA = o.session;
    check('first open is FRESH', o.baseKind === 'FRESH', o.baseKind);
    fs.writeFileSync(path.join(o.overlayHostPath, 'wip-a.rs'), '// conversation A work in progress\n');

    await server.handshake('conv-A');
    o = await server.tool('sandbox_open_project', { path: repo });
    check('re-open after same-key reconnect is CONTINUING', o.baseKind === 'CONTINUING', o.baseKind);
    check('same session id after reconnect', o.session === sessionA, `${o.session} vs ${sessionA}`);
    check('no detachedSession on a continuation', !o.detachedSession, JSON.stringify(o.detachedSession));

    // -- 2. server restart ------------------------------------------------------
    step(2, 'The session key finds the overlay after a server restart');
    await server.close();
    server = new SandboxServer({ project: repo, state });
    await server.handshake('conv-A');
    o = await server.tool('sandbox_open_project', { path: repo });
    check('open after restart is RESUMED', o.baseKind === 'RESUMED', o.baseKind);
    check('resumed by key into the same session', o.session === sessionA && /session key/.test(o.base), `${o.session} ${o.base}`);
    check('work in progress is visible again', fs.existsSync(path.join(o.overlayHostPath, 'wip-a.rs')));

    // -- 3. different key -------------------------------------------------------
    step(3, 'A different key is a different conversation');
    await server.handshake('conv-B');
    o = await server.tool('sandbox_open_project', { path: repo });
    check('different conversation gets a FRESH overlay', o.baseKind === 'FRESH' && o.session !== sessionA, `${o.baseKind} ${o.session}`);
    check('no resume advice pointing at another conversation', !o.detachedSession && !o.resumeHint, JSON.stringify(o.detachedSession || o.resumeHint));
    check('conversation A overlay is pinned against GC', findFiles(state, 'pinned').some((p) => p.includes(sessionA)));

    // -- 4. no key: warn, pin, resume --------------------------------------------
    step(4, 'Without a key, a reconnect + re-open warns and can be resumed');
    await server.handshake();
    o = await server.tool('sandbox_open_project', { path: repo });
    const sessionL = o.session;
    fs.writeFileSync(path.join(o.overlayHostPath, 'wip-legacy.rs'), '// legacy client work in progress\n');

    await server.handshake(); // the reconnect: rotates SESSION_ID as before
    o = await server.tool('sandbox_open_project', { path: repo });
    check('re-open without key is still FRESH (behavior kept)', o.baseKind === 'FRESH' && o.session !== sessionL, `${o.baseKind} ${o.session}`);
    const d = o.detachedSession || {};
    check('detachedSession names the overlay that holds the work', d.session === sessionL && d.changedFiles === 1, JSON.stringify(d));
    check('detachedSession gives the exact resume call', typeof d.action === 'string' && d.action.includes(`resume: "${sessionL}"`), d.action);
    check('note leads with a WARNING', /^WARNING: this call detached overlay/.test(o.note || ''), o.note);
    check('detached overlay is pinned', findFiles(state, 'pinned').some((p) => p.includes(sessionL)));
    const info = await server.tool('sandbox_info');
    check('sandbox_info carries a DETACHED OVERLAY note', (info.notes || []).some((n) => n.startsWith('DETACHED OVERLAY WITH WORK') && n.includes(sessionL)));
    o = await server.tool('sandbox_open_project', { path: repo, resume: sessionL });
    check('resume brings the work back', o.baseKind === 'RESUMED' && fs.existsSync(path.join(o.overlayHostPath, 'wip-legacy.rs')), o.baseKind);
    const upper = o.overlayHostPath;

    // -- 5. conflict: uncommitted overlay content vs newer host write -----------
    step(5, 'Newer host write over uncommitted overlay content is preserved and reported');
    const quiet = await server.tool('sandbox_exec', { command: 'true' });
    check('no hostSync when nothing changed on the host', !quiet.hostSync && !quiet.syncWarning, JSON.stringify(quiet.hostSync || quiet.syncWarning));
    const WIP = '// agent: uncommitted fix in progress\n';
    fs.writeFileSync(path.join(upper, 'runtime.rs'), WIP);
    await sleep(MTIME_SETTLE_MS);
    fs.writeFileSync(path.join(repo, 'runtime.rs'), '// host: user applied a patch\n');
    let r = await server.tool('sandbox_exec', { command: 'true' });
    const hs = r.hostSync || {};
    check('runtime.rs reported as refreshed', (hs.refreshedFromHost || []).includes('runtime.rs'), JSON.stringify(hs));
    check('overlay now shows the host version', readIfExists(path.join(upper, 'runtime.rs')) === '// host: user applied a patch\n');
    const kept = (hs.preservedOverlayVersions || [])[0];
    check('overlay version reported as preserved', kept && kept.path === 'runtime.rs' && /koi-preserved/.test(kept.savedTo), JSON.stringify(hs));
    const keptOnDisk = findFiles(path.join(upper, '.git', 'koi-preserved'), 'runtime.rs');
    check('preserved copy holds the uncommitted content', keptOnDisk.length === 1 && readIfExists(keptOnDisk[0]) === WIP, keptOnDisk.join(', '));
    r = await server.tool('sandbox_exec', { command: 'true' });
    check('no repeat report once the manifest is baselined', !r.hostSync, JSON.stringify(r.hostSync));

    // -- 6. content git already has ------------------------------------------------
    step(6, 'Overlay content that git already stores is refreshed without a copy');
    fs.writeFileSync(path.join(upper, 'lib.rs'), '// lib base\n'); // identical to the committed blob
    fs.utimesSync(path.join(upper, 'lib.rs'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    fs.writeFileSync(path.join(repo, 'lib.rs'), '// lib: host changed\n');
    r = await server.tool('sandbox_exec', { command: 'true' });
    check('lib.rs refreshed', (r.hostSync?.refreshedFromHost || []).includes('lib.rs'), JSON.stringify(r.hostSync));
    check('no preserved copy for content git already has', !(r.hostSync?.preservedOverlayVersions || []).some((p) => p.path === 'lib.rs'), JSON.stringify(r.hostSync));

    // -- 7. deletions ---------------------------------------------------------------
    step(7, 'Host deletion propagates only to copies reconciliation installed');
    fs.writeFileSync(path.join(upper, 'agent-new.rs'), '// created by the session\n');
    fs.rmSync(path.join(repo, 'runtime.rs'));
    r = await server.tool('sandbox_exec', { command: 'true' });
    check('deleted host file removed from the overlay', (r.hostSync?.removedBecauseDeletedOnHost || []).includes('runtime.rs') && !fs.existsSync(path.join(upper, 'runtime.rs')), JSON.stringify(r.hostSync));
    check('session-created file untouched', fs.existsSync(path.join(upper, 'agent-new.rs')));

    // -- 8. refs ------------------------------------------------------------------------
    step(8, 'An overlay branch tip the host lacks keeps a ref');
    const fakeTip = 'deadbeef'.repeat(5);
    fs.mkdirSync(path.join(upper, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(upper, '.git', 'refs', 'heads', 'main'), fakeTip + '\n');
    await sleep(MTIME_SETTLE_MS);
    hostShOk(repo, `git add -A && git ${GIT_ID} commit -q -m "host: apply"`);
    const hostHead = hostShOk(repo, 'git rev-parse HEAD').trim();
    r = await server.tool('sandbox_exec', { command: 'true' });
    const pref = (r.hostSync?.preservedOverlayRefs || [])[0];
    check('overlay ref reported as preserved', pref && pref.branch === 'main' && pref.sha === fakeTip, JSON.stringify(r.hostSync));
    check('preserved ref file points at the overlay tip', pref && readIfExists(path.join(upper, '.git', ...pref.ref.split('/')))?.trim() === fakeTip);
    check('branch ref now follows the host', readIfExists(path.join(upper, '.git', 'refs', 'heads', 'main'))?.trim() === hostHead);

    // -- 9. out-of-band initialize ------------------------------------------------------------
    step(9, 'initialize is answered while a long command runs');
    const longExec = server.tool('sandbox_exec', { command: 'sleep 3; echo done' });
    await sleep(300);
    const t0 = Date.now();
    await server.handshake('conv-C');
    const waited = Date.now() - t0;
    check('handshake did not wait for the running command', waited < 1500, `${waited}ms`);
    const longRes = await longExec;
    check('the running command still completed', longRes.exitCode === 0 && /done/.test(longRes.stdout), JSON.stringify(longRes));
  } finally {
    const failed = results.some((x) => !x.ok);
    if (server) {
      if (failed && server.stderr.trim()) console.log(`\n── server stderr (tail)\n${server.stderr.trim().split('\n').slice(-30).join('\n')}`);
      await server.close();
    }
    if (KEEP) console.log(`\n(KOI_TEST_KEEP=1 — left behind: ${tmp})`);
    else fs.rmSync(tmp, { recursive: true, force: true });
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
