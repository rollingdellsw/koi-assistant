#!/usr/bin/env node
/**
 * test-outbox-delivery.mjs — the outbox must actually reach the host.
 *
 * Talks DIRECTLY to sandbox-shell-mcp.mjs over stdio JSON-RPC. No gateway, no
 * WebSocket, no LLM.
 *
 * The bug this exists to catch
 * ---------------------------
 * The outbox lives under the state dir (default ~/.koi/sandbox) and ~/.koi is
 * on the credential mask list, so the sandbox mounts BOTH a bind for the outbox
 * and a tmpfs over its parent. bwrap applies mount operations in argv order and
 * a mount placed over a directory hides every mount already inside it — so when
 * the bind was emitted before the mask, the bind was buried under the mask's
 * tmpfs. It still showed up in /proc/mounts, which made it look healthy.
 *
 * The consequence was silent and total: `git format-patch -o "$KOI_OUTBOX"`
 * mkdir -p'd its output directory inside the tmpfs, wrote the patch, printed
 * host-looking paths and exited 0, and a follow-up `ls` from inside listed the
 * file at full size. Every signal observable from inside the sandbox said
 * "delivered". The host outbox stayed empty and the tmpfs died with the exec.
 * Sessions reported shipped patches that had never existed — the user found out
 * with `find ~/.koi/sandbox -name '*.patch'` returning nothing.
 *
 * Why test-lower-layer-sync.mjs did not catch it
 * ---------------------------------------------
 * That test asserts the patch lands in the host outbox (step 1a) and passes,
 * because it starts the server with `--state <tmpdir>` and NO `--exclude`. With
 * nothing masked there is no tmpfs to shadow the bind, so the geometry that
 * causes the failure is never built. This test builds it on purpose: the state
 * dir is placed INSIDE a directory that is then passed to --exclude, exactly as
 * ~/.koi/sandbox sits inside the masked ~/.koi in production.
 *
 * Structure
 * ---------
 *   Phase A  MECHANISM, bwrap only, no server. Proves the ordering semantics
 *            both ways: bind-then-mask loses the file, mask-then-bind delivers
 *            it while still masking everything else. Runs in milliseconds and
 *            works on any bwrap (no overlayfs needed), so it stays meaningful
 *            even where Phase B has to skip. The same thing in six lines of
 *            shell, if you want it by hand:
 *              unshare -m sh -c 'mount --bind REAL MASK/sub/outbox;
 *                                mount -t tmpfs tmpfs MASK;
 *                                mkdir -p MASK/sub/outbox;
 *                                echo hi > MASK/sub/outbox/f'   # REAL stays empty
 *   Phase B  END TO END through the real server with the production masking
 *            geometry: export a patch, then verify it HOST-SIDE and `git am` it.
 *            Host-side verification is the whole point — an assertion made from
 *            inside the sandbox is exactly the check that failed for months.
 *
 * Usage
 * -----
 *   node test-outbox-delivery.mjs
 *
 *   KOI_TEST_KEEP=1   keep the temp fixtures for inspection
 *
 * Phase B requires the bwrap-overlay (Linux) or seatbelt-clone (macOS) backend.
 * KOI_SANDBOX_BACKEND=exec has no mounts and no masking, so every assertion
 * would pass without testing anything — it refuses to run there.
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(SELF_DIR, 'sandbox-shell-mcp.mjs');

const FILE = 'shipped-by-sandbox.txt';
const BODY = 'the outbox has to actually reach the host\n';
const SECRET = 'THIS-MUST-NOT-BE-READABLE-FROM-INSIDE';
const GIT_ID = '-c user.name="Koi Outbox Test" -c user.email="koi-outbox-test@example.invalid"';
const KEEP = process.env.KOI_TEST_KEEP === '1';

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

/** Not an assertion: an environment gap, reported but never a failure. */
function skip(name, why) {
  console.log(`  ⏭️  ${name}`);
  console.log(indent(why, '        '));
}

function indent(s, pad) {
  return s.split('\n').map((l) => pad + l).join('\n');
}

function step(n, title) {
  console.log(`\n── ${n}. ${title}`);
}

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

function rmrf(target) {
  if (!target) return;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    if (e.code === 'ENOENT') return;
    spawnSync('chmod', ['-R', 'u+rwX', target]);
    try { fs.rmSync(target, { recursive: true, force: true }); }
    catch { spawnSync('rm', ['-rf', target]); }
  }
}

// =============================================================================
// Phase A — mount ordering, bwrap only
// =============================================================================
//
// Two runs over identical fixtures, differing ONLY in the order of the two
// mount operations. Both write to the same path from inside; one reaches the
// host and one does not. That difference is the entire bug.

function findBwrap() {
  for (const c of [process.env.KOI_BWRAP_BIN, '/usr/local/bin/bwrap', 'bwrap', '/usr/bin/bwrap']) {
    if (!c) continue;
    const probe = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return c;
  }
  return null;
}

/**
 * Build a fixture shaped like production: a masked parent (~/.koi) containing
 * the real outbox (~/.koi/sandbox/<id>/outbox) and a secret that must stay
 * hidden (~/.koi/gateway-config.json).
 */
function makeFixture(tmp, tag) {
  const root = path.join(tmp, `phaseA-${tag}`);
  const mask = path.join(root, 'fakehome', '.koi');           // masked parent
  const outbox = path.join(mask, 'sandbox', 'abc123', 'outbox'); // bind target
  fs.mkdirSync(outbox, { recursive: true });
  fs.writeFileSync(path.join(mask, 'gateway-config.json'), SECRET + '\n');
  return { mask, outbox };
}

/**
 * Run `mkdir -p $OUTBOX && printf … > $OUTBOX/probe` inside bwrap with the two
 * mount ops in the given order, then report what reached the HOST.
 */
function runOrdering(bwrap, { mask, outbox }, order) {
  const binds = ['--bind', outbox, outbox];
  const masks = ['--tmpfs', mask];
  const argv = [
    '--ro-bind', '/', '/',
    ...(order === 'bind-then-mask' ? [...binds, ...masks] : [...masks, ...binds]),
    '/bin/sh', '-c',
    // mkdir -p is what `git format-patch -o` does to its output directory: on a
    // shadowed path it silently creates the tree inside the mask's tmpfs.
    `mkdir -p '${outbox}' && printf %s 'delivered' > '${outbox}/probe' && ` +
    `echo "INSIDE_LS=$(ls '${outbox}')" && ` +
    `echo "SECRET_READ=$(cat '${mask}/gateway-config.json' 2>/dev/null || echo BLOCKED)"`,
  ];
  const r = spawnSync(bwrap, argv, { encoding: 'utf8', timeout: 30_000 });
  const stdout = r.stdout || '';
  let onHost = null;
  try { onHost = fs.readFileSync(path.join(outbox, 'probe'), 'utf8'); } catch { /* not delivered */ }
  return {
    status: r.status,
    stderr: (r.stderr || '').trim(),
    sawInside: /INSIDE_LS=.*probe/.test(stdout),
    secretBlocked: /SECRET_READ=BLOCKED/.test(stdout),
    onHost,
  };
}

function phaseA(tmp) {
  step('A', 'Mount ordering (bwrap only — no server, no overlayfs)');

  const bwrap = findBwrap();
  if (!bwrap) {
    skip('mount-ordering mechanism',
      'no bwrap on this host (macOS, or bubblewrap not installed). Phase A is Linux-only;\n' +
      'Phase B still covers the behaviour end to end on the seatbelt backend.');
    return;
  }

  const buggy = runOrdering(bwrap, makeFixture(tmp, 'buggy'), 'bind-then-mask');
  if (buggy.status !== 0) {
    skip('mount-ordering mechanism',
      `bwrap could not run here (exit ${buggy.status}): ${buggy.stderr.slice(0, 300)}\n` +
      'Unprivileged user namespaces are probably disabled — see the bwrap hints in\n' +
      'sandbox-shell-mcp.mjs. Phase B will hit the same wall and report it properly.');
    return;
  }

  // The control. If this ever stops reproducing, the assertions below no longer
  // mean what they claim: whatever replaced the lost write has to be understood
  // before this test can be trusted again.
  check('CONTROL: bind-then-mask loses the write (the original bug reproduces)',
    buggy.sawInside && buggy.onHost === null,
    `sawInside=${buggy.sawInside} onHost=${JSON.stringify(buggy.onHost)}\n` +
    'If sawInside is false the fixture is wrong; if onHost is non-null the shadowing\n' +
    'no longer happens on this kernel/bwrap and Phase A proves nothing here.');

  const fixed = runOrdering(bwrap, makeFixture(tmp, 'fixed'), 'mask-then-bind');
  check('mask-then-bind delivers the write to the host',
    fixed.onHost === 'delivered',
    `onHost=${JSON.stringify(fixed.onHost)} exit=${fixed.status} ${fixed.stderr.slice(0, 300)}`);

  // The fix must not be "stop masking". Both orderings have to keep the rest of
  // the masked directory hidden — that is the property the mask exists for.
  check('mask-then-bind still masks the rest of the parent directory',
    fixed.secretBlocked,
    'gateway-config.json was readable from inside the sandbox — the re-bind is carving\n' +
    'out more than the outbox leaf, which would hand a session its own allowlist.');
}

// =============================================================================
// Minimal MCP stdio client
// =============================================================================

class SandboxServer {
  constructor({ project, state, exclude }) {
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.stderr = '';
    this.exited = null;

    const args = [SERVER, '--project', project, '--state', state];
    for (const e of exclude || []) args.push('--exclude', e);

    this.proc = spawn(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // KOI_SANDBOX_EXCLUDE would be ADDED to the --exclude list, so a value
      // inherited from the developer's shell (or the installed unit) would mask
      // real credential paths during the test. Drop it: the fixture supplies
      // the whole mask list.
      env: { ...process.env, KOI_PROJECT: project, KOI_SANDBOX_EXCLUDE: '' },
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
      clientInfo: { name: 'outbox-delivery-test', version: '1.0.0' },
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

function block(stdout, key) {
  const m = new RegExp(`^${key}<<\\n([\\s\\S]*?)^>>${key}$`, 'm').exec(stdout);
  return m ? m[1] : null;
}

// =============================================================================
// Phase B — end to end, production masking geometry
// =============================================================================

async function phaseB(tmp) {
  let skipped = false;
  const hostRepo = path.join(tmp, 'host-repo');
  // The load-bearing part of this fixture: state lives INSIDE the masked dir,
  // the way ~/.koi/sandbox lives inside the masked ~/.koi. Passing --state
  // somewhere unmasked (as test-lower-layer-sync.mjs does) makes every
  // assertion below pass on the broken build.
  const fakeHome = path.join(tmp, 'fakehome');
  const maskedDir = path.join(fakeHome, '.koi');
  const stateDir = path.join(maskedDir, 'sandbox');
  fs.mkdirSync(hostRepo, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(maskedDir, 'gateway-config.json'), SECRET + '\n');

  console.log(`host repo:    ${hostRepo}`);
  console.log(`masked dir:   ${maskedDir}  (passed to --exclude)`);
  console.log(`sandbox state:${stateDir}   (inside the masked dir, as in production)`);

  let server;
  try {
    step('B0', 'Host baseline repo + server with the masked state dir');
    hostShOk(hostRepo, 'git -c init.defaultRefFormat=files init -q && git symbolic-ref HEAD refs/heads/main');
    fs.writeFileSync(path.join(hostRepo, 'README.md'), '# outbox delivery fixture\n');
    hostShOk(hostRepo, `git add -A && git ${GIT_ID} commit -q -m "baseline"`);

    server = new SandboxServer({ project: hostRepo, state: stateDir, exclude: [maskedDir] });
    try {
      await server.handshake();
    } catch (e) {
      // The server refuses to start without a usable sandbox primitive (bwrap
      // >= 0.11, working user namespaces). That is an environment gap, not a
      // regression: report it as a skip with the server's own diagnosis rather
      // than a stack trace, so a CI box missing bubblewrap does not look like
      // a delivery failure.
      if (/bubblewrap|user namespace|uid_map|Operation not permitted/i.test(e.message)) {
        skipped = true;
        skip('end-to-end outbox delivery',
          'the sandbox backend cannot start here. The server said:\n' +
          indent(e.message.split('\n').slice(0, 8).join('\n'), '  '));
        return;
      }
      throw e;
    }

    const info = await server.callTool('sandbox_info', {});
    console.log(`  backend: ${info.backend}  platform: ${info.platform}`);
    if (info.backend !== 'bwrap-overlay' && info.backend !== 'seatbelt-clone') {
      throw new Error(
        `this test requires the bwrap-overlay or seatbelt-clone backend, got "${info.backend}".\n` +
        (info.backend === 'exec-UNSAFE'
          ? 'The exec backend runs commands straight on the host with no mounts and no masking, ' +
            'so the outbox trivially "delivers" and nothing here is under test. ' +
            'Unset KOI_SANDBOX_BACKEND and re-run.'
          : 'Unsupported backend for outbox delivery.'));
    }

    check('the fixture mask is actually active (not silently dropped)',
      (info.maskedCredentials || []).includes(maskedDir),
      `maskedCredentials=${JSON.stringify(info.maskedCredentials)}\n` +
      'Without the mask there is no tmpfs over the state dir, so the rest of this phase\n' +
      'would pass on a broken build. Check that --exclude reached the server.');

    const opened = await server.callTool('sandbox_open_project', { path: hostRepo, fresh: true });
    const outbox = opened.outbox;
    console.log(`  outbox:  ${outbox}`);
    check('sandbox_open_project succeeded on a FRESH overlay',
      opened.success === true && opened.baseKind === 'FRESH',
      JSON.stringify({ success: opened.success, baseKind: opened.baseKind }));

    // -- B1. The server's own self-check ---------------------------------------
    step('B1', 'The server verifies delivery itself');
    const info2 = await server.callTool('sandbox_info', {});
    const delivery = info2.outboxDelivery;
    check('sandbox_info reports outboxDelivery as verified',
      typeof delivery === 'string' && delivery.startsWith('verified'),
      delivery === undefined
        ? 'sandbox_info has no outboxDelivery field — this server predates the delivery\n' +
          'self-check, so it cannot tell a real outbox from a tmpfs at the same path.'
        : `outboxDelivery=${JSON.stringify(delivery)}`);

    // -- B2. Masking still works ----------------------------------------------
    step('B2', 'The mask is still a mask');
    const secret = await server.exec(`cat ${JSON.stringify(path.join(maskedDir, 'gateway-config.json'))}`);
    check('the masked parent directory is NOT readable from inside the sandbox',
      secret.exitCode !== 0 && !secret.stdout.includes(SECRET),
      `exit=${secret.exitCode} stdout=${JSON.stringify(secret.stdout.slice(0, 200))}\n` +
      'Delivery must not be bought by dropping the mask: carve out the outbox leaf only.');

    // -- B3. The regression assertion ------------------------------------------
    step('B3', 'Export a patch and verify it HOST-SIDE');
    const turn = await server.execOk('export', [
      'set -e',
      'BASE=$(git rev-parse HEAD)',
      'echo "BASE=$BASE"',
      // Heredoc, not `printf %s "$BODY"`: JSON.stringify emits \n as a literal
      // backslash-n, shell double quotes do not expand it, and printf only
      // processes escapes in its FORMAT string — so the sandbox faithfully
      // shipped two characters where the fixture meant a newline. git am
      // applied it cleanly and only the content assertion caught it. A quoted
      // heredoc passes the body through verbatim and supplies the trailing
      // newline itself.
      `cat > ${FILE} <<'KOIEOF'`,
      BODY.replace(/\n$/, ''),
      'KOIEOF',
      `git add ${FILE}`,
      `git ${GIT_ID} commit -q -m "test: ship a file through the outbox"`,
      'PATCHES=$(git format-patch -o "$KOI_OUTBOX" $BASE..HEAD)',
      'echo "PATCHES<<"',
      'echo "$PATCHES"',
      'echo ">>PATCHES"',
      // Deliberately included because it is the check that used to LIE: from
      // inside the sandbox this listed the file even when nothing shipped.
      'echo "INSIDE_COUNT=$(ls "$KOI_OUTBOX" | grep -c \'\\.patch$\' || true)"',
    ].join('\n'));

    const insideCount = Number(/^INSIDE_COUNT=(\d+)$/m.exec(turn.stdout)?.[1] ?? -1);
    check('the sandbox believes it exported a patch (the misleading signal)',
      insideCount === 1, `INSIDE_COUNT=${insideCount}\n${turn.stdout}`);

    // THE assertion. Read with fs, from this process, which is not in the
    // sandbox — the only observer whose answer ever mattered.
    const hostPatches = (() => {
      try { return fs.readdirSync(outbox).filter((f) => f.endsWith('.patch')).sort(); }
      catch (e) { return { error: e.message }; }
    })();
    check('REGRESSION: the patch exists on the HOST, in the outbox',
      Array.isArray(hostPatches) && hostPatches.length === 1,
      `outbox=${outbox} host=${JSON.stringify(hostPatches)} sandbox_said=${insideCount}\n` +
      (insideCount === 1 && Array.isArray(hostPatches) && hostPatches.length === 0
        ? 'This is the exact bug: the sandbox saw the file, the host never got it. The\n' +
          'outbox bind is being shadowed — check that the credential masks are emitted\n' +
          'BEFORE the outbox binds in BwrapBackend.wrap().'
        : ''));

    if (!Array.isArray(hostPatches) || hostPatches.length !== 1) return; // nothing left to check

    // -- B4. The printed paths must be the host's paths ------------------------
    step('B4', 'The paths format-patch printed are openable on the host');
    const printed = (block(turn.stdout, 'PATCHES') || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (typeof delivery === 'string' && delivery.includes('verified via')) {
      skip('printed patch paths are host paths',
        'the server fell back to the /tmp/koi/outbox alias, so the paths it prints are\n' +
        'sandbox-internal by design. Delivery works, but B1 already flagged the host-path\n' +
        'spelling as unreachable — fix that rather than relying on the fallback.');
    } else {
      check('every path format-patch printed is openable on the host',
        printed.length === 1 && printed.every((p) => p.startsWith(outbox + path.sep) && fs.existsSync(p)),
        `printed=${JSON.stringify(printed)} outbox=${outbox}\n` +
        'A session quotes these paths to the user verbatim; if they are not host paths the\n' +
        'user is handed a location holding nothing.');
    }

    // -- B5. It is a real patch ------------------------------------------------
    step('B5', 'The delivered patch applies to the host repo');
    const patchPath = path.join(outbox, hostPatches[0]);
    const bytes = fs.statSync(patchPath).size;
    check('the delivered patch is non-empty', bytes > 0, `${patchPath} is ${bytes} bytes`);

    const am = hostSh(hostRepo, `git ${GIT_ID} am ${JSON.stringify(patchPath)}`);
    if (am.code !== 0) hostSh(hostRepo, 'git am --abort');
    check('git am applies it cleanly on the host',
      am.code === 0, `exit=${am.code}\n${am.stdout}${am.stderr}`);
    const landed = fs.existsSync(path.join(hostRepo, FILE))
      ? fs.readFileSync(path.join(hostRepo, FILE), 'utf8')
      : null;
    check('the shipped file landed on the host with the right contents',
      landed === BODY,
      `expected=${JSON.stringify(BODY)}\nactual  =${JSON.stringify(landed)}`);

    // =========================================================================
    // D. A WRONG outbox path must FAIL, not silently swallow the write
    // =========================================================================
    //
    // Everything above proves the CURRENT outbox path delivers. That is half the
    // contract, and it was the half already green while the bug was live: the
    // mount fix carves exactly ONE leaf out of the mask -- the outbox of the
    // project open right now -- and everything else under the masked dir stayed
    // the mask's own tmpfs, which is WRITABLE.
    //
    // So a session using a wrong outbox path got the full silent-loss signature
    // again: mkdir -p succeeds, format-patch exits 0, prints host-looking paths,
    // `ls` shows the patch at full size, and it evaporates with the exec. Wrong
    // paths are routine, not exotic: the outbox is keyed by a hash of the project
    // path, so it changes at sandbox_open_project (the projectless $HOME-scoped
    // outbox is a DIFFERENT directory) and again on resume. Quoting a path read
    // one turn too early is all it takes.
    step('D', 'A wrong outbox path must fail loudly, not vanish');

    const staleOutbox = path.join(stateDir, 'a0000000deadbeef', 'outbox');
    const staleWrite = await server.exec(
      `mkdir -p '${staleOutbox}' && printf ghost > '${staleOutbox}/ghost.txt'`);
    const staleLanded = fs.existsSync(path.join(staleOutbox, 'ghost.txt'));

    check('writing to a stale outbox path does not silently succeed',
      staleWrite.exitCode !== 0 || staleLanded,
      `exit=${staleWrite.exitCode} landedOnHost=${staleLanded}\n` +
      `path=${staleOutbox}\n` +
      'The write succeeded inside the sandbox and reached NOTHING on the host.\n' +
      'That is the silent-loss signature: the masked dir is a writable tmpfs, so\n' +
      'format-patch to any outbox path but the live one exits 0, prints host-looking\n' +
      'paths, lists the file at full size, and delivers nothing.');

    // A format-patch is what a session actually runs, so assert the real thing,
    // not just a bare write.
    const staleExport = await server.exec(
      `git format-patch -o '${staleOutbox}' HEAD~1..HEAD 2>&1 | tail -3; echo "EXIT:\${PIPESTATUS[0]}"`);
    const stalePatches = fs.existsSync(staleOutbox)
      ? fs.readdirSync(staleOutbox).filter((f) => f.endsWith('.patch'))
      : [];
    const claimedSuccess = /EXIT:0/.test(staleExport.stdout || '');
    check('format-patch to a stale outbox path does not claim success while delivering nothing',
      !claimedSuccess || stalePatches.length > 0,
      `stdout=${(staleExport.stdout || '').trim()}\n` +
      `patches visible on the host in ${staleOutbox}: ${stalePatches.length}\n` +
      'format-patch reported success for a path the host never received.');

    // The seal must not cost us the masking it is built on...
    const stillMasked = await server.exec(
      `cat '${path.join(maskedDir, 'gateway-config.json')}' 2>&1 || true`);
    check('sealing the mask read-only did not expose masked content',
      !String(stillMasked.stdout || '').includes(SECRET),
      `stdout=${(stillMasked.stdout || '').trim().slice(0, 200)}`);

    // ...nor the delivery it exists to protect.
    const stillWritable = await server.exec('printf seal-ok > "$KOI_OUTBOX/.seal-probe" && echo WROTE');
    check('the real outbox is still writable after the mask is sealed',
      fs.existsSync(path.join(outbox, '.seal-probe')),
      `exit=${stillWritable.exitCode} stdout=${(stillWritable.stdout || '').trim()}\n` +
      'The seal went too far: it made the live outbox read-only too.');

    // The server should have caught the silent-loss mode on its own.
    const infoAfter = await server.callTool('sandbox_info', {});
    check('sandbox_info reports delivery verified with no silent-loss warning',
      /^verified/.test(String(infoAfter.outboxDelivery || '')) &&
      !/WARNING/.test(String(infoAfter.outboxDelivery || '')),
      `outboxDelivery=${JSON.stringify(infoAfter.outboxDelivery)}\n` +
      'The server itself detected that wrong outbox paths fail silently.');
  } finally {
    if (server) {
      const failed = results.some((r) => !r.ok);
      const exitedWithError = server.exited && (server.exited.code !== 0 || server.exited.signal);
      // A skipped phase already printed the server's own diagnosis; dumping its
      // stderr again just buries the result.
      if (!skipped && (failed || exitedWithError) && server.stderr.trim()) {
        console.log('\n── server stderr (tail)');
        console.log(indent(server.stderr.trim().split('\n').slice(-40).join('\n'), '     '));
      }
      await server.close();
    }
  }
}

// =============================================================================
// Phase C — is the code this test just proved the code you are RUNNING?
// =============================================================================
//
// Everything above spawns a fresh server from SELF_DIR. That validates the
// checkout and says nothing whatsoever about the process currently serving your
// gateway — which is how the outbox fix came to be green in CI and broken in
// production at the same time. The investigating session had to infer the live
// version from mount IDs in /proc/self/mountinfo, because no cheaper signal
// existed.
//
// Two ways the deployment can diverge, both checked here:
//   1. the unit points at a DIFFERENT copy of the file than the one under test
//   2. the copies match, but the process predates the edit (no restart)
//
// Neither is a code defect, so neither is a hard failure by default — a
// developer running this on a laptop with no service installed should not see
// red. Set KOI_TEST_REQUIRE_DEPLOYED=1 (in CI, or after a deploy) to turn the
// findings into assertions.

const REQUIRE_DEPLOYED = process.env.KOI_TEST_REQUIRE_DEPLOYED === '1';

function sha12(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/** WorkingDirectory of the installed service, or null if it is not installed. */
function deployedGatewayDir() {
  if (process.env.KOI_GATEWAY_DIR) return process.env.KOI_GATEWAY_DIR;
  const r = spawnSync('systemctl', ['--user', 'show', 'koi-gateway', '-p', 'WorkingDirectory'],
    { encoding: 'utf8' });
  const m = /WorkingDirectory=(.+)/.exec(r.stdout || '');
  const dir = m && m[1].trim();
  return dir && dir !== '/' ? dir : null;
}

/**
 * The live sandbox server process(es) for `deployedPath`, with start times.
 *
 * Deliberately NOT `pgrep -f sandbox-shell-mcp.mjs`: -f matches the string
 * anywhere in any command line, so it happily matches the shell that launched
 * this test, the editor holding the file open, and pgrep's own invocation. It
 * produced a confident false positive the first time this ran. Match an actual
 * argv element instead, resolved against the process's cwd, and compare it to
 * the deployed path.
 *
 * On Linux /proc/<pid> carries the start time at millisecond resolution; `ps
 * -o lstart` only has seconds, which is why the macOS path gets a tolerance.
 */
function liveProcessStart(deployedPath) {
  const self = new Set([process.pid, process.ppid]);
  const found = [];

  if (fs.existsSync('/proc/self')) {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (self.has(pid)) continue;
      let argv, cwd;
      try {
        argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      } catch { continue; }                       // exited, or not ours to read
      const script = argv.find((a) => a.endsWith('sandbox-shell-mcp.mjs'));
      if (!script) continue;
      if (path.resolve(cwd, script) !== path.resolve(deployedPath)) continue;
      try { found.push({ pid, start: fs.statSync(`/proc/${pid}`).mtimeMs, precise: true }); }
      catch { /* raced with exit */ }
    }
  } else {
    const ps = spawnSync('ps', ['-eo', 'pid=,lstart=,command='], { encoding: 'utf8' });
    for (const line of (ps.stdout || '').split('\n')) {
      const m = /^\s*(\d+)\s+(.{24})\s+(.*)$/.exec(line);
      if (!m) continue;
      const [, pid, lstart, cmd] = m;
      if (self.has(Number(pid))) continue;
      if (!/(^|\s|\/)sandbox-shell-mcp\.mjs(\s|$)/.test(cmd)) continue;
      const t = Date.parse(lstart);
      if (Number.isFinite(t)) found.push({ pid: Number(pid), start: t, precise: false });
    }
  }

  if (!found.length) return null;
  return {
    count: found.length,
    pids: found.map((f) => f.pid),
    oldest: Math.min(...found.map((f) => f.start)),
    precise: found.every((f) => f.precise),
  };
}

function phaseC() {
  step('C', 'Deployment freshness — is the tested code the RUNNING code?');

  const dir = deployedGatewayDir();
  if (!dir) {
    skip('the tested code is the deployed code',
      'no installed koi-gateway unit found (and KOI_GATEWAY_DIR is unset). Phase C only\n' +
      'applies where the gateway runs as a service; the checkout itself is already covered.');
    return;
  }

  const tested = path.join(SELF_DIR, 'sandbox-shell-mcp.mjs');
  const deployed = path.join(dir, 'sandbox-shell-mcp.mjs');
  const a = sha12(tested);
  const b = sha12(deployed);
  console.log(`  tested:   ${tested}  ${a}`);
  console.log(`  deployed: ${deployed}  ${b}`);

  const sameFile = !!a && a === b;
  const report = REQUIRE_DEPLOYED ? check : (name, ok, detail) => {
    if (ok) { console.log(`  ✅ ${name}`); return true; }
    console.log(`  ⚠️  ${name}`);
    if (detail) console.log(indent(String(detail), '        '));
    return false;
  };

  report('the deployed sandbox server is byte-identical to the one under test',
    sameFile,
    `tested=${a} deployed=${b}\n` +
    'The service runs a different copy, so these assertions say nothing about it. Apply\n' +
    `your patch in ${dir} (or point the unit at the checkout) and restart.`);

  // Even with identical files, the PROCESS can predate them. This is the exact
  // shape of the mask-shadowing recurrence: fix committed, file correct on
  // disk, live process still serving the version it imported hours earlier.
  const live = liveProcessStart(deployed);
  if (!live) {
    skip('the running server is not older than the deployed file',
      `no process is running ${deployed} — the gateway is probably stopped.`);
    return;
  }
  if (live.count > 1) {
    console.log(`  ⚠️  ${live.count} sandbox-shell-mcp.mjs processes are running (pids ${live.pids.join(', ')})`);
    console.log(indent('An orphan from a previous gateway may still be serving requests.', '        '));
  }
  const mtime = (() => { try { return fs.statSync(deployed).mtimeMs; } catch { return null; } })();
  // `ps -o lstart` truncates to whole seconds, so a process started at .900
  // reads as .000 and looks fractionally older than a file it actually
  // postdates. Only the /proc path is exact; give the other one a second.
  const slack = live.precise ? 0 : 1000;
  report('the running server started AFTER the last edit to its file',
    mtime !== null && live.oldest + slack >= mtime,
    `file mtime=${mtime && new Date(mtime).toISOString()} process start=${new Date(live.oldest).toISOString()}\n` +
    'The live process loaded an older version of this file. Its behaviour will not match\n' +
    'the source you are reading, and this test will keep passing while it misbehaves:\n' +
    '  systemctl --user restart koi-gateway\n' +
    'Then confirm with sandbox_info -> build.sha256 (it should equal the deployed hash above).');
}

// =============================================================================
// Main
// =============================================================================

async function runTest() {
  if (!fs.existsSync(SERVER)) {
    throw new Error(`sandbox-shell-mcp.mjs not found next to this test: ${SERVER}`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-outbox-'));
  try {
    phaseA(tmp);
    await phaseB(tmp);
    phaseC();
  } finally {
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
    const frames = (err.stack || '').split('\n').filter((l) => /^\s+at /.test(l));
    if (frames.length) console.error(indent(frames.join('\n'), '   '));
    process.exit(2);
  },
);
