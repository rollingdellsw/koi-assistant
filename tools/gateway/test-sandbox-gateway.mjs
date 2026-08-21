#!/usr/bin/env node
/**
 * test-sandbox-gateway.mjs — Standalone test client for the sandbox MCP server.
 *
 * Drives the Koi Gateway over WebSocket exactly like the Chrome extension does
 * (auth handshake, then JSON-RPC), with no LLM session required — same idea as
 * test-gateway.js for the postgresql server.
 *
 * Usage (run from the directory where `ws` is installed, e.g. tools/gateway):
 *   node test-sandbox-gateway.mjs                 # full test suite
 *   node test-sandbox-gateway.mjs exec "npm test" # ad-hoc single command
 *   node test-sandbox-gateway.mjs diff            # git status+diff inside the sandbox
 *   node test-sandbox-gateway.mjs export [range]  # git format-patch to the outbox
 *   node test-sandbox-gateway.mjs reset           # wipe the overlay (and its git commits)
 *
 * Env:
 *   GATEWAY_URL   default ws://localhost:8080
 *   SERVER_NAME   default sandbox
 *   TEST_PORT     default 8765 (for the dev-server visibility test)
 */

import WebSocket from 'ws';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://localhost:8080';
const SERVER_NAME = process.env.SERVER_NAME || 'sandbox';
const TEST_PORT = parseInt(process.env.TEST_PORT || '8765', 10);

// =============================================================================
// Minimal MCP-over-gateway client
// =============================================================================

export class GatewayClient {
  constructor(url, server) {
    this.url = `${url}/mcp/${server}`;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('error', reject);
      this.ws.on('open', () => {
        // Gateway protocol: first message must be auth
        this.ws.send(JSON.stringify({ type: 'auth' }));
      });
      this.ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.type === 'ready') { resolve(); return; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej, timer } = this.pending.get(msg.id);
          clearTimeout(timer);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.code}: ${msg.error.message}`));
          else res(msg.result);
        }
      });
      this.ws.on('close', (code, reason) => {
        for (const { reject: rej, timer } of this.pending.values()) {
          clearTimeout(timer);
          rej(new Error(`connection closed: ${code} ${reason}`));
        }
        this.pending.clear();
      });
    });
  }

  rpc(method, params, timeoutMs = 180_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  notify(method, params) {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  /** Call an MCP tool; returns the parsed JSON payload from content[0].text. */
  async callTool(name, args = {}) {
    const result = await this.rpc('tools/call', { name, arguments: args });
    const text = result?.content?.[0]?.text ?? '';
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    return { isError: !!result?.isError, ...payload };
  }

  close() { try { this.ws.close(); } catch {} }
}

// =============================================================================
// Test harness
// =============================================================================

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}
export function section(title) { console.log(`\n━━ ${title} ${'━'.repeat(Math.max(0, 50 - title.length))}`); }
export function show(obj, max = 800) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  console.log(s.length > max ? s.slice(0, max) + `\n  … [${s.length - max} more chars]` : s);
}

async function fullSuite(client) {
  // --- initialize -----------------------------------------------------------
  section('MCP handshake');
  const init = await client.rpc('initialize', {
    protocolVersion: '2024-11-05',
    clientInfo: { name: 'test-sandbox-gateway', version: '1.0.0' },
    capabilities: {},
  });
  client.notify('notifications/initialized');
  check('initialize', init?.serverInfo?.name === 'koi-sandbox-shell', JSON.stringify(init));
  check('server version >= 2.0', typeof init?.serverInfo?.version === 'string' && init.serverInfo.version >= '2.0.0', JSON.stringify(init?.serverInfo));

  const toolList = await client.rpc('tools/list', {});
  const toolNames = (toolList?.tools || []).map((t) => t.name);
  console.log(`  tools: ${toolNames.join(', ')}`);
  check('tools/list includes sandbox_exec', toolNames.includes('sandbox_exec'));
  check('tools/list includes overlay_fs_sync', toolNames.includes('overlay_fs_sync'));
  check('tools/list includes sandbox_restart_service', toolNames.includes('sandbox_restart_service'));
  check('shell-replaceable tools pruned (read_file/write_file/apply_patch/diff/export gone)',
    !toolNames.includes('sandbox_read_file') && !toolNames.includes('sandbox_write_file') && !toolNames.includes('sandbox_apply_patch') && !toolNames.includes('sandbox_diff') && !toolNames.includes('sandbox_export_patch'));

  // --- info -----------------------------------------------------------------
  section('sandbox_info');
  const info = await client.callTool('sandbox_info');
  show(info);
  check('backend reported', typeof info.backend === 'string');
  check('services is running-only array', Array.isArray(info.services));
  check('notes mention restart', Array.isArray(info.notes) && info.notes.some((n) => /restart/i.test(n)));
  let projectRoot = info.project;
  let sandboxRoot = info.sandboxRoot;

  // --- overlay_fs_sync ------------------------------------------------------
  section('overlay_fs_sync');
  const syncRes = await client.callTool('overlay_fs_sync');
  show(syncRes);
  check('overlay_fs_sync succeeds', syncRes.success === true && typeof syncRes.session === 'string');

  const targetArg = process.argv[2] && process.argv[2] !== 'reset' ? path.resolve(process.argv[2]) : null;
  if (targetArg || !info.projectOpened) {
    section('open target project');
    const testProj = targetArg || fs.mkdtempSync(path.join(os.tmpdir(), 'koi-suite-'));
    console.log(`  opening workspace at ${testProj}`);
    const openRes = await client.callTool('sandbox_open_project', { path: testProj });
    check('open provisioned project', openRes.success === true && openRes.project === testProj);
    projectRoot = testProj;
    sandboxRoot = testProj;
  }

  // --- basic exec -----------------------------------------------------------
  section('sandbox_exec basics');
  const hello = await client.callTool('sandbox_exec', {
    command: 'echo "cwd=$(pwd) user=$(whoami) node=$(node --version 2>/dev/null || echo n/a)"',
  });
  show(hello.stdout?.trim());
  check('exec exit 0', hello.exitCode === 0);
  check('runs in sandbox root', (hello.stdout || '').includes(`cwd=${sandboxRoot}`));
  // Host PATH is inherited: if fnm/nvm node is on the host PATH, sandbox should see a modern node.
  // Soft signal only — still pass on systems with only system node.
  const pathProbe = await client.callTool('sandbox_exec', {
    command: 'echo "PATH_HAS_KOI=$(echo \"$PATH\" | tr : \"\\n\" | grep -c \"/tmp/koi/bin\" || true)"; echo "which_node=$(command -v node)"',
  });
  show(pathProbe.stdout?.trim());
  check('wrapper bin first on PATH', /PATH_HAS_KOI=[1-9]/.test(pathProbe.stdout || ''));

  // --- host is read-only ----------------------------------------------------
  section('host read-only guarantee');
  const roProbe = await client.callTool('sandbox_exec', {
    command: 'touch /etc/koi-probe 2>&1 && echo HOST_WRITABLE || echo HOST_WRITE_BLOCKED; ' +
             'touch "$HOME/koi-probe-home" 2>&1 && echo HOME_WRITABLE || echo HOME_WRITE_BLOCKED',
  });
  show(roProbe.stdout?.trim());
  check('/etc not writable', (roProbe.stdout || '').includes('HOST_WRITE_BLOCKED'));
  check('$HOME not writable', (roProbe.stdout || '').includes('HOME_WRITE_BLOCKED'));

  // --- credential masking ---------------------------------------------------
  section('credential masking');
  const creds = await client.callTool('sandbox_exec', {
    command: 'echo "ssh_entries=$(ls -A ~/.ssh 2>/dev/null | wc -l)"; ' +
             'echo "netrc=$(wc -c < ~/.netrc 2>/dev/null || echo absent)"',
  });
  show(creds.stdout?.trim());
  check('~/.ssh empty or absent', /ssh_entries=0/.test(creds.stdout || ''));

  // --- git push blocked -----------------------------------------------------
  section('git push blocked');
  const push = await client.callTool('sandbox_exec', { command: 'git push origin main; echo rc=$?' });
  show((push.stderr || '') + (push.stdout || ''));
  check('push blocked by wrapper', (push.stderr || '').includes('koi-sandbox') && /rc=1/.test(push.stdout || ''));

  // --- overlay write isolation ---------------------------------------------
  section('overlay write isolation (via sandbox_exec)');
  const marker = `koi-sandbox-test/hello-${Date.now()}.txt`;
  const wr = await client.callTool('sandbox_exec', { command: `mkdir -p koi-sandbox-test && echo "written in the sandbox" > '${marker}'` });
  check('sandbox_exec write ok', wr.exitCode === 0, wr.stderr);
  const rd = await client.callTool('sandbox_exec', { command: `cat -- '${marker}'` });
  check('file visible inside sandbox (shell cat)', rd.exitCode === 0 && /written in the sandbox/.test(rd.stdout || ''));
  // This test client runs ON THE HOST — the file must NOT exist in the real tree.
  const hostHasIt = fs.existsSync(`${projectRoot}/${marker}`);
  check('file NOT in real host tree', !hostHasIt, `${projectRoot}/${marker} exists on host!`);

  // --- background service + host-visible port ------------------------------
  section('dev server visible on host localhost (browser loop)');
  await client.callTool('sandbox_stop_service', { name: 'koitest' }).catch(() => {});
  const svc = await client.callTool('sandbox_start_service', {
    name: 'koitest',
    command: `node -e "require('http').createServer((q,s)=>s.end('sandbox-ok')).listen(${TEST_PORT},'127.0.0.1',()=>console.log('listening ${TEST_PORT}'))"`,
    ready_pattern: 'listening',
  });
  check('service started', svc.success === true, svc.earlyLog);
  check('service ready flag', svc.ready === true, JSON.stringify({ ready: svc.ready, log: svc.earlyLog }));
  let body = '';
  for (let i = 0; i < 10 && body !== 'sandbox-ok'; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try { body = await (await fetch(`http://127.0.0.1:${TEST_PORT}/`)).text(); } catch {}
  }
  // This fetch runs on the HOST — same path Chrome will use.
  check(`host can reach http://127.0.0.1:${TEST_PORT}`, body === 'sandbox-ok', `got: ${body || '(no response)'}`);
  const logs = await client.callTool('sandbox_service_logs', { name: 'koitest' });
  check('service logs captured', /listening/.test(logs.log || ''));

  // Overlay write while service is running
  const wrWhile = await client.callTool('sandbox_exec', {
    command: 'echo "service was running" > koi-sandbox-test/while-running.txt',
  });
  check('exec write while running ok', wrWhile.exitCode === 0);

  // restart_service keeps the same command and frees the port
  const restarted = await client.callTool('sandbox_restart_service', {
    name: 'koitest',
    ready_pattern: 'listening',
  });
  check('restart succeeds', restarted.success === true && restarted.restarted === true, JSON.stringify(restarted));
  body = '';
  for (let i = 0; i < 10 && body !== 'sandbox-ok'; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try { body = await (await fetch(`http://127.0.0.1:${TEST_PORT}/`)).text(); } catch {}
  }
  check('host reaches service after restart', body === 'sandbox-ok', `got: ${body || '(no response)'}`);

  // info.services should list only running services as objects
  const infoRun = await client.callTool('sandbox_info');
  check('info.services includes koitest object', Array.isArray(infoRun.services) && infoRun.services.some((s) => s.name === 'koitest' && s.status === 'running'));

  const stop = await client.callTool('sandbox_stop_service', { name: 'koitest' });
  check('service stopped', stop.success === true);
  const infoStopped = await client.callTool('sandbox_info');
  check('stopped service not in running list', Array.isArray(infoStopped.services) && !infoStopped.services.some((s) => s.name === 'koitest'));

  // --- open project ---------------------------------------------------------
  section('sandbox_open_project');
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-test-proj-'));
  const switchRes = await client.callTool('sandbox_open_project', { path: tmpProject });
  check('switch project succeeds', switchRes.success === true && switchRes.project === tmpProject);

  const write2 = await client.callTool('sandbox_exec', { command: 'echo "test" > new-proj-file.txt' });
  check('write in new project', write2.exitCode === 0);

  const switchBack = await client.callTool('sandbox_open_project', { path: projectRoot });
  check('switch back succeeds', switchBack.success === true && switchBack.project === projectRoot);

  const read2 = await client.callTool('sandbox_exec', { command: 'cat -- new-proj-file.txt' });
  check('file from other project is isolated', read2.exitCode !== 0);

  fs.rmSync(tmpProject, { recursive: true, force: true });

  // --- git-native shipping ------------------------------------------------
  // Commits happen INSIDE the sandbox: the overlay makes .git writable, so
  // `git commit` records history in the overlay only. `git format-patch -o
  // "$KOI_OUTBOX"` writes patch files through the outbox bind mount, which is
  // the only host-visible write path.
  section('git-native shipping (commit in overlay, format-patch to outbox)');
  const GIT_ID = '-c user.email=koi@test -c user.name=koi-test -c commit.gpgsign=false';
  const isHostRepo = fs.existsSync(path.join(projectRoot, '.git'));
  let hostHeadBefore = null;
  if (isHostRepo) {
    try {
      hostHeadBefore = execSync(`git -C ${projectRoot} rev-parse HEAD`, { encoding: 'utf8' }).trim();
    } catch { /* repo with no commits yet */ }
  } else {
    // Non-git project: baseline the host tree in the overlay .git first.
    // Using --allow-empty prevents staging test artifacts, keeping the tree dirty for subsequent tests.
    const init = await client.callTool('sandbox_exec', {
      command: `git init -q . && git ${GIT_ID} commit -qm baseline --allow-empty --no-verify`,
      timeout_ms: 300_000,
    });
    check('non-git project: overlay git baseline created', init.exitCode === 0, init.stderr);
  }

  const commit = await client.callTool('sandbox_exec', {
    command: `git add -Af koi-sandbox-test && git ${GIT_ID} commit -m "koi sandbox test commit" --no-verify && git rev-parse HEAD`,
  });
  show(((commit.stderr || '') + (commit.stdout || '')).trim(), 600);
  check('git commit inside sandbox succeeds', commit.exitCode === 0, commit.stderr);
  check('git wrapper prints overlay-commit hint', /koi-sandbox: commit recorded/.test(commit.stderr || ''));
  const sandboxHead = (commit.stdout || '').trim().split('\n').pop() || '';
  check('commit hash returned', /^[0-9a-f]{40}$/.test(sandboxHead), sandboxHead);
  if (hostHeadBefore) {
    // The critical guarantee: the HOST repo never sees the sandbox commit.
    const hostHeadAfter = execSync(`git -C ${projectRoot} rev-parse HEAD`, { encoding: 'utf8' }).trim();
    check('host repo HEAD unchanged', hostHeadAfter === hostHeadBefore, `${hostHeadBefore} -> ${hostHeadAfter}`);
    check('sandbox HEAD diverged from host', sandboxHead !== hostHeadAfter);
  }
  const fp = await client.callTool('sandbox_exec', {
    command: 'git format-patch -1 -o "$KOI_OUTBOX" HEAD',
  });
  check('format-patch to $KOI_OUTBOX succeeds', fp.exitCode === 0, fp.stderr);
  const patchName = path.basename(((fp.stdout || '').trim().split('\n').pop() || ''));
  // Re-read the outbox from a fresh sandbox_info: the overlay is session-scoped,
  // so the outbox captured before the project was opened (line ~140) may point
  // at a different session than the one format-patch just wrote to.
  const infoNow = await client.callTool('sandbox_info');
  const hostPatchPath = patchName ? path.join(infoNow.outbox, patchName) : '';
  check('patch file visible on host outbox', !!hostPatchPath && fs.existsSync(hostPatchPath), hostPatchPath || '(no filename in output)');
  if (hostPatchPath) console.log(`  apply with: git -C ${projectRoot} am ${hostPatchPath}`);

  // --- greenfield (new project, host path absent) --------------------------
  // A brand-new project has no host-side base, so: (1) opening it must NOT
  // create anything on the host, and (2) the deliverable is the WHOLE tree
  // shipped as a git bundle that `git clone` reconstitutes — format-patch/git am
  // would have nothing to apply onto.
  section('greenfield project (host path absent → whole-tree bundle ship)');
  const gfPath = path.join(os.tmpdir(), `koi-greenfield-${Date.now()}`); // deliberately NOT created
  const gfOpen = await client.callTool('sandbox_open_project', { path: gfPath });
  check('greenfield open succeeds', gfOpen.success === true && gfOpen.project === gfPath, JSON.stringify(gfOpen)?.slice(0, 200));
  check('greenfield flagged in open_project', gfOpen.greenfield === true, JSON.stringify(gfOpen)?.slice(0, 200));
  check('open did NOT create the dir on the host', !fs.existsSync(gfPath), `${gfPath} exists on host!`);

  const gfInfo = await client.callTool('sandbox_info');
  check('info reports greenfield', gfInfo.greenfield === true);
  check('gitWorkflow ships via bundle', JSON.stringify(gfInfo.gitWorkflow || '').includes('bundle'));

  const gfWrite = await client.callTool('sandbox_exec', { command: `mkdir -p src && echo 'export const hi = () => "hi";' > src/index.js` });
  check('greenfield write ok', gfWrite.exitCode === 0, gfWrite.stderr);
  check('write did NOT create the dir on the host', !fs.existsSync(gfPath), `${gfPath} exists on host!`);
  const gfCat = await client.callTool('sandbox_exec', { command: 'cat -- src/index.js' });
  check('greenfield file visible in sandbox', gfCat.exitCode === 0 && /hi/.test(gfCat.stdout || ''), gfCat.stderr);

  const gfShip = await client.callTool('sandbox_exec', {
    command: `git init -q . && git add -A && git ${GIT_ID} commit -qm "initial" --no-verify && git bundle create "$KOI_OUTBOX/project.bundle" HEAD && echo BUNDLED`,
    timeout_ms: 300_000,
  });
  check('greenfield commit + bundle succeeds', gfShip.exitCode === 0 && /BUNDLED/.test(gfShip.stdout || ''), (gfShip.stderr || '') + (gfShip.stdout || ''));

  const gfInfo2 = await client.callTool('sandbox_info');
  const bundlePath = path.join(gfInfo2.outbox, 'project.bundle');
  check('bundle visible on host outbox', fs.existsSync(bundlePath), bundlePath);

  // The Q2 guarantee: the exported bundle reconstitutes the whole project on the
  // host with a plain `git clone` — no pre-existing base required.
  let cloneOk = false, cloneDir = null;
  if (fs.existsSync(bundlePath)) {
    cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koi-gf-clone-'));
    const target = path.join(cloneDir, 'app');
    try {
      execSync(`git clone -q "${bundlePath}" "${target}"`, { stdio: 'pipe' });
      cloneOk = fs.existsSync(path.join(target, 'src', 'index.js'));
      if (cloneOk) console.log(`  materialize with: git clone "${bundlePath}" <target-dir>`);
    } catch { cloneOk = false; }
  }
  check('bundle clones into a full project on the host', cloneOk, 'git clone of the exported bundle did not reproduce the tree');
  if (cloneDir) fs.rmSync(cloneDir, { recursive: true, force: true });
  check('greenfield host path never materialized by the sandbox', !fs.existsSync(gfPath), `${gfPath} exists on host!`);
  fs.rmSync(gfPath, { recursive: true, force: true }); // best-effort; normally absent

  // --- summary --------------------------------------------------------------
  section('RESULT');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(failed === 0
    ? '  🎉 Sandbox MCP server is fully operational.'
    : '  ⚠️ Some checks failed — see above.');
  console.log('\n  NOTE: test artifacts (koi-sandbox-test/) and the test git commit live only in the overlay.');
  console.log('  Run `node test-sandbox-gateway.mjs reset` to discard them (outbox patches survive).');
  return failed === 0;
}

// =============================================================================
// Ad-hoc subcommands
// =============================================================================

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  console.log(`Connecting to ${GATEWAY_URL}/mcp/${SERVER_NAME} ...`);
  const client = new GatewayClient(GATEWAY_URL, SERVER_NAME);
  try {
    await client.connect();
  } catch (e) {
    console.error(`\n❌ Cannot connect: ${e.message}`);
    console.error('   Is the gateway running?  node tools/gateway/koi-gateway.js --config tools/gateway/gateway-config.json');
    process.exit(1);
  }
  console.log('Connected & authenticated.\n');

  let ok = true;
  try {
    if (!cmd) {
      ok = await fullSuite(client);
    } else {
      await client.rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '1' }, capabilities: {} });
      client.notify('notifications/initialized');
      switch (cmd) {
        case 'exec':
          show(await client.callTool('sandbox_exec', { command: rest.join(' ') || 'pwd' }), 20_000); break;
        case 'diff':
          show(await client.callTool('sandbox_exec', {
            command: 'git status --short; git --no-pager diff HEAD',
          }), 20_000); break;
        case 'export':
          show(await client.callTool('sandbox_exec', {
            command: `git format-patch -o "$KOI_OUTBOX" ${rest.join(' ') || '-1 HEAD'}`,
          }), 20_000); break;
        case 'reset':
          show(await client.callTool('sandbox_reset')); break;
        case 'info':
          show(await client.callTool('sandbox_info')); break;
        case 'logs':
          show(await client.callTool('sandbox_service_logs', { name: rest[0] })); break;
        default:
          console.error(`Unknown subcommand: ${cmd} (use: exec|diff|export|reset|info|logs|restart)`); ok = false;
      }
    }
  } catch (e) {
    console.error(`\n❌ Test run failed: ${e.message}`);
    ok = false;
  } finally {
    client.close();
  }
  process.exit(ok ? 0 : 1);
}

const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();