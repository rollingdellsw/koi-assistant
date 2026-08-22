#!/usr/bin/env node
/**
 * test-lower-layer-sync.mjs — deterministic lower-layer -> upper-layer sync test.
 *
 * Talks DIRECTLY to sandbox-shell-mcp.mjs over stdio JSON-RPC. No gateway, no
 * WebSocket, no LLM: the behaviour under test is pure filesystem/git
 * reconciliation, so the test is a straight-line script with hard assertions.
 *
 * What it proves
 * --------------
 * The sandbox writes into an overlay upperdir that SHADOWS the host tree. Once
 * the model has touched a file (or committed, which touches .git/index and
 * .git/refs/heads/<branch>), later host-side mutations of those same paths are
 * invisible to the sandbox until they are reconciled. The reconciliation runs
 * automatically at the head of the sandbox_exec handler
 * (reconcileLowerToUpper), so a session that comes back for a second turn must
 * see the host's newer content AND the host's newer git refs without anyone
 * calling overlay_fs_sync.
 *
 * The git half is the part that actually matters: if refs/index do not
 * reconcile, the sandbox commits on a stale parent and the exported patch no
 * longer applies to the host with `git am`. That is the failure this test is
 * built to catch, so the final assertion is a real `git am` on a real host repo.
 *
 * Scenario (mirrors the hand-run procedure)
 * -----------------------------------------
 *   Turn 1   sandbox creates app-config-auto.txt, commits it in the overlay,
 *            exports BASE..HEAD to $KOI_OUTBOX
 *   Host     `git am` that patch, then mutate the file again and commit it
 *            -> host HEAD is now two commits ahead of the sandbox's parent and
 *               the file content differs from what the overlay holds
 *   Control  assert the overlay upperdir is STILL stale on disk (proves the
 *            next step is reconciliation, not overlayfs passthrough)
 *   Turn 2   the FIRST sandbox_exec after the host mutation must already show
 *            the host content, the host HEAD, and a clean `git status`
 *   Ship     sandbox appends + commits + exports NEW_BASE..HEAD; the host
 *            applies it with `git am` and must land with zero conflicts
 *
 * Usage
 * -----
 *   node test-lower-layer-sync.mjs
 *
 *   KOI_TEST_KEEP=1              keep the temp host repo + sandbox state
 *   KOI_TEST_MTIME_SETTLE_MS=..  mtime granularity guard (default 1100)
 *
 * Requires the bwrap-overlay (Linux) or seatbelt-clone (macOS) backend.
 * KOI_SANDBOX_BACKEND=exec has no isolation layer, so the test would pass
 * vacuously — it refuses to run there.
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(SELF_DIR, 'sandbox-shell-mcp.mjs');

const FILE = 'app-config-auto.txt';
const TURN1_BODY = 'MODE=initial_sandbox_layer\nVERSION=1.0.0\n';
const HOST_BODY = 'MODE=host_layer_mutation_verified 2\n';
const TURN2_LINE = 'STATUS=automatic_sync_working';

// Identity is passed per-invocation so the test never depends on the host's
// global git config (and never writes to it).
const GIT_ID = '-c user.name="Koi Sync Test" -c user.email="koi-sync-test@example.invalid"';

// reconcileLowerToUpper compares mtimes, so the host write must be strictly
// newer than the overlay copy. ext4/btrfs give ns resolution and the gap is
// already tens of ms, but a coarse-granularity fs (1s) needs real slack.
const MTIME_SETTLE_MS = Number(process.env.KOI_TEST_MTIME_SETTLE_MS || 1100);
const KEEP = process.env.KOI_TEST_KEEP === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =============================================================================
// Assertions
// =============================================================================

const results = [];

function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}`);
  if (!ok && detail) console.log(indent(String(detail), '        '));
  return !!ok;
}

function indent(s, pad) {
  return s.split('\n').map((l) => pad + l).join('\n');
}

function step(n, title) {
  console.log(`\n── ${n}. ${title}`);
}

// =============================================================================
// Host-side shell (plain, unsandboxed — this IS the lower layer)
// =============================================================================

function hostSh(cwd, command) {
  const r = spawnSync('/bin/bash', ['-c', command], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true' },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function hostShOk(cwd, command) {
  const r = hostSh(cwd, command);
  if (r.code !== 0) {
    throw new Error(`host command failed (exit ${r.code}): ${command}\n${r.stdout}${r.stderr}`);
  }
  return r;
}

// =============================================================================
// Minimal MCP stdio client (newline-delimited JSON-RPC 2.0)
// =============================================================================

class SandboxServer {
  constructor({ project, state }) {
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.stderr = '';
    this.exited = null;

    this.proc = spawn(process.execPath, [SERVER, '--project', project, '--state', state, '--no-lsp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Belt and braces with --no-lsp: the code-intelligence child is
        // irrelevant here and only adds startup latency and failure modes.
        KOI_LSP_ENTRY: '',
        KOI_PROJECT: project,
      },
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-64 * 1024); });
    this.proc.on('exit', (code, signal) => {
      this.exited = { code, signal };
      const errDetail = this.stderr.trim() ? `\n--- server stderr ---\n${this.stderr.trim()}` : '';
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`server exited (code=${code} signal=${signal})${errDetail}`));
      }
      this.pending.clear();
    });
  }

  _onStdout(chunk) {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === undefined) continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`rpc error ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }

  rpc(method, params = {}, timeoutMs = 180_000) {
    if (this.exited) return Promise.reject(new Error('server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  /** tools/call, unwrapping the MCP { content:[{text}] } envelope back to JSON. */
  async callTool(name, args = {}) {
    const res = await this.rpc('tools/call', { name, arguments: args });
    const text = (res.content || []).map((c) => c.text || '').join('\n');
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (res.isError) {
      const e = new Error(`tool ${name} failed: ${parsed.error || text}`);
      e.result = parsed;
      throw e;
    }
    return parsed;
  }

  exec(command, opts = {}) {
    return this.callTool('sandbox_exec', { command, ...opts });
  }

  /** exec that throws on a non-zero exit, with the full transcript attached. */
  async execOk(label, command, opts = {}) {
    const r = await this.exec(command, opts);
    if (r.exitCode !== 0 || r.timedOut) {
      throw new Error(
        `sandbox exec failed [${label}] exit=${r.exitCode} timedOut=${!!r.timedOut}\n` +
        `--- command ---\n${command}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
    }
    return r;
  }

  async handshake() {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'lower-layer-sync-test', version: '2.0.0' },
      capabilities: {},
    }, 60_000);
    this.notify('notifications/initialized');
  }

  async close() {
    if (this.exited) return;
    try { this.proc.stdin.end(); } catch { /* already gone */ }
    const dead = new Promise((r) => this.proc.once('exit', r));
    const timer = setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
    await dead;
    clearTimeout(timer);
  }
}

// =============================================================================
// Small parsing helpers — sandbox commands print KEY=value / KEY<< ... >>KEY
// =============================================================================

function field(stdout, key) {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(stdout);
  return m ? m[1].trim() : null;
}

function block(stdout, key) {
  const m = new RegExp(`^${key}<<\\n([\\s\\S]*?)^>>${key}$`, 'm').exec(stdout);
  return m ? m[1] : null;
}

function listPatches(outbox) {
  try {
    return fs.readdirSync(outbox).filter((f) => f.endsWith('.patch')).sort();
  } catch {
    return [];
  }
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/**
 * Recursively remove a directory tree, robust to overlayfs workdir (mode 0000),
 * read-only git objects (mode 0444), and permission quirks on Linux/gLinux.
 */
function rmrf(target) {
  if (!target) return;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    if (e.code === 'ENOENT') return;
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      try {
        spawnSync('chmod', ['-R', 'u+rwX', target]);
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        try {
          spawnSync('rm', ['-rf', target]);
        } catch {
          if (fs.existsSync(target)) throw e;
        }
      }
    } else {
      throw e;
    }
  }
}

// =============================================================================
// Test
// =============================================================================

async function runTest() {
  if (!fs.existsSync(SERVER)) {
    throw new Error(`sandbox-shell-mcp.mjs not found next to this test: ${SERVER}`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-lower-sync-'));
  const hostRepo = path.join(tmp, 'host-repo');
  const stateDir = path.join(tmp, 'sandbox-state');
  fs.mkdirSync(hostRepo, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  console.log(`host repo:    ${hostRepo}`);
  console.log(`sandbox state:${stateDir}`);

  let server;
  try {
    // -- 0. Host baseline repo -------------------------------------------------
    step(0, 'Host baseline repo (lower layer)');
    // `git init -b` is not available on older git; symbolic-ref is universal.
    hostShOk(hostRepo, 'git -c init.defaultRefFormat=files init -q && git symbolic-ref HEAD refs/heads/main');
    fs.writeFileSync(path.join(hostRepo, 'README.md'), '# lower-layer sync fixture\n');
    hostShOk(hostRepo, `git add -A && git ${GIT_ID} commit -q -m "baseline"`);
    const hostBase = hostShOk(hostRepo, 'git rev-parse HEAD').stdout.trim();
    check('host repo initialised with a baseline commit', /^[0-9a-f]{40}$/.test(hostBase), hostBase);

    // -- 0b. Server up, project opened -----------------------------------------
    server = new SandboxServer({ project: hostRepo, state: stateDir });
    await server.handshake();

    const info = await server.callTool('sandbox_info', {});
    console.log(`  backend: ${info.backend}  platform: ${info.platform}`);
    if (info.backend !== 'bwrap-overlay' && info.backend !== 'seatbelt-clone') {
      throw new Error(
        `this test requires the bwrap-overlay or seatbelt-clone backend, got "${info.backend}".\n` +
        (info.backend === 'exec-UNSAFE'
          ? 'The exec backend writes straight to the host tree — there is no upper layer to shadow ' +
            'the lower one, so every assertion here would pass without testing anything. ' +
            'Unset KOI_SANDBOX_BACKEND and re-run.'
          : 'Unsupported backend for lower->upper reconciliation.'));
    }

    const opened = await server.callTool('sandbox_open_project', { path: hostRepo, fresh: true });
    check('sandbox_open_project succeeded on a FRESH overlay',
      opened.success === true && opened.baseKind === 'FRESH',
      JSON.stringify({ success: opened.success, baseKind: opened.baseKind }));

    const outbox = opened.outbox;
    const upperDir = opened.overlayHostPath;
    console.log(`  outbox:  ${outbox}`);
    console.log(`  upper:   ${upperDir}`);

    // -- 1. Turn 1: create, commit, export -------------------------------------
    step(1, 'Turn 1 — sandbox creates the file, commits in the overlay, exports the patch');
    const turn1 = await server.execOk('turn-1', [
      'set -e',
      'BASE=$(git rev-parse HEAD)',
      'echo "BASE=$BASE"',
      `cat > ${FILE} <<'KOIEOF'`,
      TURN1_BODY.replace(/\n$/, ''),
      'KOIEOF',
      `git add ${FILE}`,
      `git ${GIT_ID} commit -q -m "test: turn 1 initial upper-layer file creation"`,
      'echo "SANDBOX_HEAD=$(git rev-parse HEAD)"',
      'PATCHES=$(git format-patch -o "$KOI_OUTBOX" $BASE..HEAD)',
      'echo "PATCHES<<"',
      'echo "$PATCHES"',
      'echo ">>PATCHES"',
    ].join('\n'));

    const sandboxBase = field(turn1.stdout, 'BASE');
    const sandboxHead1 = field(turn1.stdout, 'SANDBOX_HEAD');
    check('turn 1 committed on top of the host baseline', sandboxBase === hostBase,
      `sandbox BASE=${sandboxBase} hostBase=${hostBase}`);
    check('turn 1 produced a new overlay commit', !!sandboxHead1 && sandboxHead1 !== hostBase, sandboxHead1);

    const patchesAfterTurn1 = listPatches(outbox);
    check('turn 1 patch landed in the host-visible outbox', patchesAfterTurn1.length === 1,
      `outbox=${outbox} entries=${JSON.stringify(patchesAfterTurn1)}`);
    const turn1Patch = path.join(outbox, patchesAfterTurn1[0] || '');

    check('host repo is untouched by the sandbox commit',
      hostShOk(hostRepo, 'git rev-parse HEAD').stdout.trim() === hostBase &&
      !fs.existsSync(path.join(hostRepo, FILE)),
      'the sandbox must not have written through to the lower layer');

    // -- 2. Host mutates the lower layer ---------------------------------------
    step(2, 'Host applies the patch and mutates the lower layer further');
    // The overlay copy was written a moment ago; make sure the host writes are
    // unambiguously newer even on a 1s-granularity filesystem.
    await sleep(MTIME_SETTLE_MS);

    const am1 = hostSh(hostRepo, `git ${GIT_ID} am ${JSON.stringify(turn1Patch)}`);
    check('host `git am` applied the turn 1 patch cleanly', am1.code === 0,
      `${am1.stdout}${am1.stderr}`);

    fs.writeFileSync(path.join(hostRepo, FILE), HOST_BODY);
    hostShOk(hostRepo, `git ${GIT_ID} commit -q -am "host: lower-layer mutation"`);
    const hostHead = hostShOk(hostRepo, 'git rev-parse HEAD').stdout.trim();
    check('host HEAD advanced past the sandbox parent',
      hostHead !== hostBase && hostHead !== sandboxHead1, `hostHead=${hostHead}`);

    // -- 3. Control: the overlay is genuinely stale right now ------------------
    step(3, 'Control — the overlay upperdir is still stale on disk');
    // Without this check the next step could be passing for the wrong reason:
    // overlayfs shows lower-layer files that were never copied up, so a test
    // that never established shadowing would prove nothing about reconciliation.
    const upperFileBefore = readIfExists(path.join(upperDir, FILE));
    const upperRefBefore = (readIfExists(path.join(upperDir, '.git', 'refs', 'heads', 'main')) || '').trim();
    check('overlay holds a shadowing copy of the file, still at turn 1 content',
      upperFileBefore === TURN1_BODY,
      `upper=${JSON.stringify(upperFileBefore)} expected=${JSON.stringify(TURN1_BODY)}`);
    check('overlay holds a shadowing copy of refs/heads/main, still at the turn 1 commit',
      upperRefBefore === sandboxHead1,
      `upperRef=${upperRefBefore || '(absent)'} sandboxHead1=${sandboxHead1}`);

    // -- 4. Turn 2 first exec: automatic reconciliation ------------------------
    step(4, 'Turn 2 — the FIRST sandbox_exec must already see the host state (no overlay_fs_sync)');
    const probe = await server.execOk('turn-2-probe', [
      'echo "CONTENT<<"',
      `cat ${FILE}`,
      'echo ">>CONTENT"',
      'echo "HEAD=$(git rev-parse HEAD)"',
      'echo "STATUS<<"',
      'git status --porcelain',
      'echo ">>STATUS"',
    ].join('\n'));

    const seenContent = block(probe.stdout, 'CONTENT');
    const seenHead = field(probe.stdout, 'HEAD');
    const seenStatus = (block(probe.stdout, 'STATUS') || '').trim();

    const contentOk = check('sandbox sees the host file content',
      seenContent === HOST_BODY,
      `saw=${JSON.stringify(seenContent)} expected=${JSON.stringify(HOST_BODY)}`);
    const headOk = check('sandbox git HEAD equals host HEAD (refs reconciled)',
      seenHead === hostHead,
      `sandbox=${seenHead} host=${hostHead}`);
    const statusOk = check('sandbox `git status` is clean (index reconciled, no phantom diff)',
      seenStatus === '',
      seenStatus);

    // Diagnostic only: distinguish "reconciliation is broken" from
    // "reconciliation works but is not being triggered automatically".
    if (!contentOk || !headOk || !statusOk) {
      console.log('\n  ⚠ automatic path failed — probing explicit overlay_fs_sync to localise the fault');
      const sync = await server.callTool('overlay_fs_sync', {});
      console.log(indent(JSON.stringify(sync, null, 2), '     '));
      const after = await server.exec(`cat ${FILE}; echo "HEAD=$(git rev-parse HEAD)"`);
      console.log(indent(after.stdout, '     '));
      console.log('  ⚠ if the above is correct, reconcileLowerToUpper() is fine but ' +
        'sandbox_exec is not calling it (or is calling it too late).');
      console.log('  ⚠ this probe has now reconciled the overlay, so steps 5-6 below no ' +
        'longer exercise the automatic path — read them as ship-path checks only.');
    }

    // -- 5. Turn 2 edit, commit, incremental export ----------------------------
    step(5, 'Turn 2 — append, commit on the reconciled HEAD, export only the delta');
    const turn2 = await server.execOk('turn-2-ship', [
      'set -e',
      'NEW_BASE=$(git rev-parse HEAD)',
      'echo "NEW_BASE=$NEW_BASE"',
      `printf '%s\\n' ${JSON.stringify(TURN2_LINE)} >> ${FILE}`,
      `git ${GIT_ID} commit -q -am "test: turn 2 follow-up append"`,
      'echo "TURN2_HEAD=$(git rev-parse HEAD)"',
      'echo "TURN2_PARENT=$(git rev-parse HEAD^)"',
      'git format-patch -o "$KOI_OUTBOX" $NEW_BASE..HEAD > /dev/null',
    ].join('\n'));

    check('turn 2 committed on the HOST head, not the stale overlay head',
      field(turn2.stdout, 'TURN2_PARENT') === hostHead,
      `parent=${field(turn2.stdout, 'TURN2_PARENT')} hostHead=${hostHead}`);

    const newPatches = listPatches(outbox).filter((f) => !patchesAfterTurn1.includes(f));
    check('turn 2 exported exactly one incremental patch', newPatches.length === 1,
      JSON.stringify(listPatches(outbox)));
    const turn2Patch = path.join(outbox, newPatches[0] || '');

    // -- 6. The payoff: the delta applies to the host ---------------------------
    step(6, 'Host applies the turn 2 delta with `git am`');
    const am2 = hostSh(hostRepo, `git ${GIT_ID} am ${JSON.stringify(turn2Patch)}`);
    if (am2.code !== 0) hostSh(hostRepo, 'git am --abort');
    check('host `git am` applied the turn 2 patch with zero conflicts', am2.code === 0,
      `${am2.stdout}${am2.stderr}`);

    const finalHostFile = readIfExists(path.join(hostRepo, FILE));
    check('host file now carries both the host mutation and the turn 2 append',
      finalHostFile === HOST_BODY + TURN2_LINE + '\n',
      `host=${JSON.stringify(finalHostFile)}`);
    check('host working tree is clean after the apply',
      hostShOk(hostRepo, 'git status --porcelain').stdout.trim() === '');
  } finally {
    if (server) {
      const failed = results.some((r) => !r.ok);
      const exitedWithError = server.exited && (server.exited.code !== 0 || server.exited.signal);
      if ((failed || exitedWithError || results.length === 0) && server.stderr.trim()) {
        console.log('\n── server stderr (tail)');
        console.log(indent(server.stderr.trim().split('\n').slice(-40).join('\n'), '     '));
      }
      await server.close();
    }
    if (KEEP) console.log(`\n(KOI_TEST_KEEP=1 — left behind: ${tmp})`);
    else rmrf(tmp);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(60)}`);
  if (failed.length === 0) {
    console.log(`✅ PASS — ${results.length}/${results.length} assertions`);
    return 0;
  }
  console.log(`❌ FAIL — ${failed.length}/${results.length} assertions failed:`);
  for (const f of failed) console.log(`   • ${f.name}`);
  return 1;
}

runTest().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\n💥 ERROR: ${err.message}`);
    // Frames only — err.message is often multi-line (command transcripts) and
    // err.stack repeats all of it before the first frame.
    const frames = (err.stack || '').split('\n').filter((l) => /^\s+at /.test(l));
    if (frames.length) console.error(indent(frames.join('\n'), '   '));
    process.exit(2);
  },
);
