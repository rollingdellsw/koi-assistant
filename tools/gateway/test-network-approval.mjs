#!/usr/bin/env node
// =============================================================================
// test-network-approval.mjs — exercise sandbox egress policy WITHOUT an LLM.
//
//   node test-network-approval.mjs              # all offline suites
//   node test-network-approval.mjs --preflight  # is pasta/nft/squid installed?
//   node test-network-approval.mjs --gateway    # + live gateway round trip
//   node test-network-approval.mjs --only 3     # one suite
//
// What each suite covers:
//
//   1  policy engine    — pattern matching, deny-beats-allow, file round trip
//   2  ACL helper       — Squid's helper protocol, in-process, no Squid needed
//   3  approval loop    — the real sandbox server (stdio MCP, --net policy) +
//                         the real ACL helper + a fake side panel. This is the
//                         one that matters: it proves an "ask" reaches the
//                         client, the answer gets back through the in-order
//                         request queue, and an "always" grant is persisted.
//   4  gateway          — the same elicitation over the WebSocket the extension
//                         actually uses. Needs a running gateway (--gateway).
//   5  live proxy       — is the INSTALLED squid + helper actually answering,
//                         and applying the policy? Runs automatically whenever
//                         something is listening on the proxy port.
//   6  enforcement      — can a sandboxed process reach the network WITHOUT
//                         the proxy? Suites 1-5 all test the DECISION; this is
//                         the one that tests that the decision cannot be
//                         sidestepped. Runs `confine` for real inside
//                         `unshare -Urn`; needs no squid, pasta or root.
//
// Everything runs against a throwaway KOI_HOME, so your real
// ~/.koi/network-policy.json is never read or written.
//
// Suite 3 runs the server with KOI_NET_TEST=1, which skips the pasta/nft/squid
// preflight. That tests the DECISION path only — no enforcement happens there.
// Suite 6 covers the other half: it runs the real `confine` in a throwaway
// namespace and checks that the filter cannot be removed by the command it
// confines. Run --preflight to see whether the host could enforce for real.
// =============================================================================

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import http from 'http';
import assert from 'assert';
import { fileURLToPath } from 'url';

import {
  parseAllowFile, loadPolicy, savePolicy, emptyPolicy, ensurePolicy,
  hostMatches, evaluate, upsertRule, isLoopbackHost,
} from './koi-net-policy.mjs';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(SELF_DIR, 'sandbox-shell-mcp.mjs');
const HELPER = path.join(SELF_DIR, 'koi-net-acl.mjs');
const SETUP = path.join(SELF_DIR, 'koi-net-setup.sh');

const ARGS = process.argv.slice(2);
const only = (() => {
  const i = ARGS.indexOf('--only');
  return i >= 0 ? Number(ARGS[i + 1]) : null;
})();
const gatewayUrl = (() => {
  const i = ARGS.indexOf('--gateway');
  if (i < 0) return null;
  const next = ARGS[i + 1];
  return next && !next.startsWith('--') ? next : 'ws://localhost:8080/mcp/sandbox';
})();

let passed = 0, failed = 0;
const ok = (name) => { passed++; console.log(`  \u2713 ${name}`); };
const bad = (name, e) => { failed++; console.log(`  \u2717 ${name}\n      ${e.message}`); };

async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { bad(name, e); }
}
function suite(n, title) {
  if (only !== null && only !== n) return false;
  console.log(`\n[${n}] ${title}`);
  return true;
}

function tmpHome(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `koi-nettest-${label}-`));
  return dir;
}
const cleanup = [];
process.on('exit', () => {
  for (const fn of cleanup) { try { fn(); } catch { /* best effort */ } }
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// =============================================================================
// 1. Policy engine
// =============================================================================
async function suitePolicy() {
  if (!suite(1, 'Policy engine')) return;

  await test('exact and wildcard host matching', () => {
    assert.equal(hostMatches('github.com', 'github.com'), true);
    assert.equal(hostMatches('github.com', 'evil-github.com'), false);
    assert.equal(hostMatches('*.npmjs.org', 'registry.npmjs.org'), true);
    // A bare-apex match matters: *.npmjs.org must cover npmjs.org, or the
    // allowlist quietly misses the host people actually write down.
    assert.equal(hostMatches('*.npmjs.org', 'npmjs.org'), true);
    assert.equal(hostMatches('*.npmjs.org', 'notnpmjs.org'), false);
    assert.equal(hostMatches('GitHub.com', 'github.com.'), true);
  });

  await test('an IP literal does not inherit its domain\'s grant', () => {
    // The proxy keys on whatever is in `CONNECT <host>:<port>`, so an IP is
    // just another host string. Allowing a NAME must not allow the ADDRESS it
    // resolves to: a CDN moves, and the address the user approved is not the
    // one they thought they were approving.
    assert.equal(hostMatches('github.com', '140.82.114.4'), false);
    assert.equal(hostMatches('*.github.com', '140.82.114.4'), false);
    // ...and an IP rule is honoured exactly, so it can be granted deliberately.
    assert.equal(hostMatches('140.82.114.4', '140.82.114.4'), true);
  });

  await test('CIDR ranges are NOT supported (documented limitation)', () => {
    // Compared as a literal string, so a range silently matches nothing. This
    // asserts the limitation on purpose: someone will eventually write
    // "10.0.0.0/8" expecting a subnet, and the failure is otherwise invisible
    // — the rule just never fires. If range support is ever added, this test
    // SHOULD fail and be replaced.
    assert.equal(hostMatches('10.0.0.0/8', '10.1.2.3'), false);
    assert.equal(hostMatches('192.168.0.0/16', '192.168.1.10'), false);
  });

  await test('IPv6 literals match exactly, and are not wildcard-matched', () => {
    assert.equal(hostMatches('::1', '::1'), true);
    assert.equal(hostMatches('*.example.com', '2606:4700::1111'), false);
  });

  await test('allow file parses ports, comments and ! denials', () => {
    const rules = parseAllowFile([
      '# comment', '', 'github.com', '*.npmjs.org', 'internal.corp:8080,8443',
      '!169.254.169.254   # metadata',
    ].join('\n'));
    assert.equal(rules.length, 4);
    assert.deepEqual(rules[2].ports, [8080, 8443]);
    assert.equal(rules[3].decision, 'deny');
  });

  await test('deny beats allow regardless of file order', () => {
    const policy = {
      version: 1, default: 'ask',
      rules: [
        { host: '*.example.com', decision: 'allow' },
        { host: 'secrets.example.com', decision: 'deny' },
      ],
    };
    assert.equal(evaluate(policy, { host: 'www.example.com', port: 443 }).decision, 'allow');
    assert.equal(evaluate(policy, { host: 'secrets.example.com', port: 443 }).decision, 'deny');
  });

  await test('a session grant cannot override a standing deny', () => {
    const policy = { version: 1, default: 'ask', rules: [{ host: 'evil.test', decision: 'deny' }] };
    const session = [{ host: 'evil.test', decision: 'allow', source: 'session' }];
    assert.equal(evaluate(policy, { host: 'evil.test', port: 443 }, session).decision, 'deny');
  });

  await test('port-scoped rules only match their ports', () => {
    const policy = { version: 1, default: 'ask', rules: [{ host: 'db.test', ports: [5432], decision: 'allow' }] };
    assert.equal(evaluate(policy, { host: 'db.test', port: 5432 }).decision, 'allow');
    assert.equal(evaluate(policy, { host: 'db.test', port: 443 }).decision, 'ask');
  });

  await test('IP rules evaluate like any other rule, deny included', () => {
    const policy = {
      version: 1, default: 'ask',
      rules: [
        { host: '203.0.113.7', decision: 'allow' },
        { host: '169.254.169.254', decision: 'deny' },
      ],
    };
    assert.equal(evaluate(policy, { host: '203.0.113.7', port: 443 }).decision, 'allow');
    assert.equal(evaluate(policy, { host: '169.254.169.254', port: 80 }).decision, 'deny');
    // An address nobody mentioned is not implicitly reachable.
    assert.equal(evaluate(policy, { host: '8.8.8.8', port: 443 }).decision, 'ask');
  });

  await test('the shipped allowlist denies cloud metadata by IP', () => {
    // 169.254.169.254 is reachable from any cloud dev box and a single GET is
    // a credential theft. It ships as an explicit `!` deny, and deny beats
    // allow, so no approval dialog can grant it either.
    const rules = parseAllowFile(fs.readFileSync(
      path.join(SELF_DIR, 'koi-network-allow.default'), 'utf8'));
    const policy = { version: 1, default: 'ask', rules };
    assert.equal(evaluate(policy, { host: '169.254.169.254', port: 80 }).decision, 'deny');
    assert.equal(
      evaluate(policy, { host: '169.254.169.254', port: 80 },
        [{ host: '169.254.169.254', decision: 'allow', source: 'session' }]).decision,
      'deny',
      'a session grant must not be able to open cloud metadata',
    );
  });

  await test('loopback is allowed without an allowlist entry', () => {
    // The sandbox reaching a service it is itself running is not egress, and
    // the policy file cannot carry this rule: ensurePolicy writes it once, so
    // a seeded entry would never reach an existing install.
    const policy = { ...emptyPolicy(), default: 'deny' };
    for (const host of ['localhost', '127.0.0.1', '127.0.0.53', '::1', '[::1]',
                        'app.localhost', 'LOCALHOST']) {
      assert.equal(
        evaluate(policy, { host, port: 3000 }).decision, 'allow',
        `${host} should be treated as loopback`,
      );
    }
  });

  await test('loopback lookalikes are not treated as loopback', () => {
    // The check must be an equality/prefix test, not a substring one: a name
    // an attacker controls must never inherit the loopback grant.
    const policy = { ...emptyPolicy(), default: 'deny' };
    for (const host of ['localhost.evil.com', '127.0.0.1.evil.com', 'notlocalhost',
                        'localhost.com', '1.2.3.4', 'evil.com']) {
      assert.equal(isLoopbackHost(host), false, `${host} must not be loopback`);
      assert.equal(evaluate(policy, { host, port: 443 }).decision, 'deny');
    }
  });

  await test('an explicit deny still overrides the loopback built-in', () => {
    // The built-in sits after the deny sweep precisely so this stays possible.
    const policy = {
      version: 1, default: 'ask',
      rules: [{ host: 'localhost', decision: 'deny', source: 'user' }],
    };
    assert.equal(evaluate(policy, { host: 'localhost', port: 3000 }).decision, 'deny');
  });

  await test('unmatched falls through to the policy default', () => {
    assert.equal(evaluate(emptyPolicy(), { host: 'x.test', port: 443 }).decision, 'ask');
    assert.equal(
      evaluate({ ...emptyPolicy(), default: 'deny' }, { host: 'x.test', port: 443 }).decision,
      'deny',
    );
  });

  await test('policy survives a save/load round trip', () => {
    const home = tmpHome('policy');
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const file = path.join(home, 'network-policy.json');
    let p = emptyPolicy();
    p = upsertRule(p, { host: 'example.test', decision: 'allow' }, file);
    const reloaded = loadPolicy(file);
    assert.equal(reloaded.rules.length, 1);
    assert.equal(reloaded.rules[0].source, 'user');
    assert.ok(reloaded.rules[0].addedAt, 'grant should record when it was made');
    assert.equal(evaluate(reloaded, { host: 'example.test', port: 443 }).decision, 'allow');
  });

  await test('a corrupt policy file degrades to ask, not to allow', () => {
    const home = tmpHome('corrupt');
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const file = path.join(home, 'network-policy.json');
    fs.writeFileSync(file, '{ this is not json');
    assert.equal(loadPolicy(file).default, 'ask');
    assert.equal(loadPolicy(file).rules.length, 0);
  });

  await test('ensurePolicy seeds from the shipped allowlist, once', () => {
    const home = tmpHome('seed');
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const file = path.join(home, 'network-policy.json');
    const allow = path.join(SELF_DIR, 'koi-network-allow.default');
    const seeded = ensurePolicy(file, allow);
    assert.ok(seeded.rules.length > 5, 'default allowlist should not be empty');
    assert.equal(evaluate(seeded, { host: 'registry.npmjs.org', port: 443 }).decision, 'allow');
    assert.equal(evaluate(seeded, { host: '169.254.169.254', port: 80 }).decision, 'deny');
    // Second call must not clobber user edits.
    savePolicy({ ...seeded, rules: [] }, file);
    assert.equal(ensurePolicy(file, allow).rules.length, 0);
  });
}

// =============================================================================
// 2. ACL helper protocol
// =============================================================================

/** Drive koi-net-acl.mjs the way Squid does. */
function startHelper({ policyFile, sock, timeoutMs = 4000, concurrency = true }) {
  const args = ['--policy', policyFile, '--sock', sock, '--timeout-ms', String(timeoutMs)];
  const child = spawn(process.execPath, [HELPER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiters = new Map();
  let buf = '', seq = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      const m = concurrency ? /^(\d+)\s+(.*)$/.exec(line) : null;
      const id = m ? m[1] : '0';
      const body = m ? m[2] : line;
      const w = waiters.get(id);
      if (w) { waiters.delete(id); w(body.trim()); }
    }
  });
  child.stderr.on('data', () => { /* helper debug is off by default */ });
  return {
    child,
    ask(host, port = 443, method = 'CONNECT', uri = `${host}:${port}`) {
      const id = String(++seq);
      return new Promise((resolve) => {
        waiters.set(id, resolve);
        const fields = [host, port, method, uri].map(encodeURIComponent).join(' ');
        child.stdin.write(concurrency ? `${id} ${fields}\n` : `${fields}\n`);
      });
    },
    stop() { try { child.kill('SIGTERM'); } catch { /* gone */ } },
  };
}

async function suiteHelper() {
  if (!suite(2, 'Squid ACL helper protocol')) return;

  const home = tmpHome('helper');
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const policyFile = path.join(home, 'network-policy.json');
  savePolicy({
    version: 1, default: 'ask',
    rules: [
      { host: '*.npmjs.org', decision: 'allow', source: 'default' },
      { host: 'blocked.test', decision: 'deny', source: 'default' },
    ],
  }, policyFile);

  // No broker socket exists: "ask" has nobody to ask.
  const h = startHelper({ policyFile, sock: path.join(home, 'nobody.sock'), timeoutMs: 1500 });
  cleanup.push(() => h.stop());

  await test('allowlisted host answers OK', async () => {
    assert.equal(await h.ask('registry.npmjs.org'), 'OK');
  });

  await test('denied host answers ERR with a reason', async () => {
    const r = await h.ask('blocked.test');
    assert.ok(r.startsWith('ERR'), `expected ERR, got ${r}`);
    assert.ok(/network policy/.test(r), `reason should name the policy: ${r}`);
  });

  await test('unknown host with no approval channel is DENIED, not allowed', async () => {
    const r = await h.ask('unknown.test');
    assert.ok(r.startsWith('ERR'), `expected ERR, got ${r}`);
    assert.ok(/no approval channel/.test(r), r);
  });

  await test('out-of-order replies keep their channel ids', async () => {
    // Squid's concurrency mode allows out-of-order answers; the ids must not
    // get crossed, or one request's verdict is applied to another.
    const [a, b, c] = await Promise.all([
      h.ask('registry.npmjs.org'), h.ask('blocked.test'), h.ask('registry.npmjs.org'),
    ]);
    assert.equal(a, 'OK');
    assert.ok(b.startsWith('ERR'));
    assert.equal(c, 'OK');
  });

  await test('a bare IP is asked about, not silently allowed', async () => {
    // The helper is running with no broker socket, so "ask" surfaces as this
    // specific ERR. What matters is that an IP reaches the ask path at all
    // rather than being waved through as unmatched.
    const r = await h.ask('8.8.8.8');
    assert.ok(r.startsWith('ERR'), `expected ERR for an unapproved IP, got ${r}`);
    assert.ok(/no approval channel/.test(r), r);
  });

  await test('an allowlisted name does not let its IP through', async () => {
    // *.npmjs.org is allowed in this suite's policy; the address behind it is
    // not, and must still be asked about.
    assert.equal(await h.ask('registry.npmjs.org'), 'OK');
    const byIp = await h.ask('104.16.0.1');
    assert.ok(byIp.startsWith('ERR'), `an IP inherited a name's grant: ${byIp}`);
  });

  await test('an explicitly allowed IP is granted', async () => {
    savePolicy({
      version: 1, default: 'ask',
      rules: [{ host: '203.0.113.7', decision: 'allow', source: 'user' }],
    }, policyFile);
    await wait(20); // mtime granularity
    assert.equal(await h.ask('203.0.113.7'), 'OK');
  });

  await test('policy edits are picked up without restarting the helper', async () => {
    savePolicy({
      version: 1, default: 'ask',
      rules: [{ host: 'late.test', decision: 'allow', source: 'user' }],
    }, policyFile);
    await wait(20); // mtime granularity
    assert.equal(await h.ask('late.test'), 'OK');
  });

  h.stop();
}

// =============================================================================
// 3. Full approval loop: server + helper + fake side panel
// =============================================================================

/** Minimal stdio MCP client — what the extension does, minus the extension. */
function startServer({ home, project }) {
  const child = spawn(process.execPath, [
    SERVER, '--net', 'policy', '--no-lsp', '--project', project,
    '--state', path.join(home, 'sandbox'),
    '--net-policy', path.join(home, 'network-policy.json'),
    '--net-allow', path.join(SELF_DIR, 'koi-network-allow.default'),
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      KOI_HOME: home,
      KOI_NET_TEST: '1',
      KOI_NETWORK_SOCK: path.join(home, 'approval.sock'),
      // This suite never runs a command in the sandbox, only the approval
      // round trip, so the filesystem backend is irrelevant — and requiring
      // bwrap here would make the tests unrunnable on a machine that has not
      // installed it yet, which is exactly when you want to run them.
      KOI_SANDBOX_BACKEND: 'exec',
    },
  });

  const pending = new Map();
  const stderr = [];
  /** Set by the test to answer elicitation requests. */
  let onRequest = async () => ({ action: 'decline' });
  let buf = '', id = 0;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method !== undefined && msg.id !== undefined) {
        // Server -> client request. Answer asynchronously, exactly as
        // RemoteMCPClient.handleServerRequest does.
        void Promise.resolve(onRequest(msg)).then((result) => {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
        });
        continue;
      }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => stderr.push(d));

  const rpc = (method, params) => new Promise((resolve, reject) => {
    const rid = ++id;
    const timer = setTimeout(() => { pending.delete(rid); reject(new Error(`${method} timed out`)); }, 20_000);
    pending.set(rid, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
  });

  return {
    child, rpc, stderr,
    setRequestHandler(fn) { onRequest = fn; },
    stop() { try { child.kill('SIGTERM'); } catch { /* gone */ } },
  };
}

async function waitForSocket(p, ms = 8000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fs.existsSync(p)) {
      // Existing is not the same as accepting; probe it.
      const okNow = await new Promise((resolve) => {
        const s = net.createConnection(p);
        s.once('connect', () => { s.destroy(); resolve(true); });
        s.once('error', () => resolve(false));
      });
      if (okNow) return true;
    }
    await wait(100);
  }
  return false;
}

async function suiteLoop() {
  if (!suite(3, 'Approval loop (server + helper + fake side panel)')) return;

  const home = tmpHome('loop');
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));

  const policyFile = path.join(home, 'network-policy.json');
  const sock = path.join(home, 'approval.sock');

  const server = startServer({ home, project });
  cleanup.push(() => server.stop());

  let helper = null;
  try {
    await test('server starts in policy mode and seeds a policy file', async () => {
      const init = await server.rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, elicitation: {} },
        clientInfo: { name: 'test-network-approval', version: '1.0.0' },
      });
      assert.ok(init.serverInfo, 'no serverInfo in initialize result');
      assert.ok(fs.existsSync(policyFile), `policy file not created at ${policyFile}`);
      assert.ok(await waitForSocket(sock), `approval broker never listened on ${sock}`);
    });

    await test('sandbox_network_policy reports the seeded rules', async () => {
      const res = await server.rpc('tools/call', { name: 'sandbox_network_policy', arguments: {} });
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.mode, 'policy');
      assert.ok(body.allowed.includes('registry.npmjs.org'), 'npm registry should be pre-allowed');
      assert.ok(body.denied.includes('169.254.169.254'), 'metadata endpoint should be denied');
      assert.match(body.unmatched, /prompts the user/);
    });

    helper = startHelper({ policyFile, sock, timeoutMs: 15_000 });
    cleanup.push(() => helper.stop());

    await test('pre-allowed host never reaches the user', async () => {
      let asked = false;
      server.setRequestHandler(async () => { asked = true; return { action: 'decline' }; });
      assert.equal(await helper.ask('registry.npmjs.org'), 'OK');
      await wait(150);
      assert.equal(asked, false, 'allowlisted host should not have prompted');
    });

    let seen = null;
    await test('unknown host prompts the side panel and the answer gets back', async () => {
      server.setRequestHandler(async (msg) => {
        seen = msg;
        return { action: 'accept', content: { decision: 'allow', scope: 'always' } };
      });
      const r = await helper.ask('example.test', 443, 'CONNECT', 'example.test:443');
      assert.equal(r, 'OK', `expected OK after approval, got ${r}`);
      assert.ok(seen, 'no elicitation request arrived');
      assert.equal(seen.method, 'elicitation/create');
      assert.equal(seen.params['koi/network'].host, 'example.test');
      assert.equal(
        seen.params['koi/network'].directionKnown, false,
        'a CONNECT tunnel must not claim the direction is known',
      );
      assert.match(seen.params.message, /example\.test/);
    });

    await test('"always" is persisted to the policy file', async () => {
      const p = loadPolicy(policyFile);
      const rule = p.rules.find((r) => r.host === 'example.test');
      assert.ok(rule, 'granted host missing from the policy file');
      assert.equal(rule.decision, 'allow');
      assert.equal(rule.source, 'user');
    });

    await test('a persisted grant does not prompt again', async () => {
      let asked = false;
      server.setRequestHandler(async () => { asked = true; return { action: 'decline' }; });
      assert.equal(await helper.ask('example.test'), 'OK');
      await wait(150);
      assert.equal(asked, false, 'previously-granted host prompted a second time');
    });

    await test('"once" grants nothing beyond the single request', async () => {
      let asks = 0;
      server.setRequestHandler(async () => {
        asks++;
        return { action: 'accept', content: { decision: 'allow', scope: 'once' } };
      });
      assert.equal(await helper.ask('oneshot.test'), 'OK');
      assert.equal(await helper.ask('oneshot.test'), 'OK');
      assert.equal(asks, 2, 'a "once" grant should prompt on every request');
      assert.equal(loadPolicy(policyFile).rules.some((r) => r.host === 'oneshot.test'), false);
    });

    await test('"session" grant lives in memory only', async () => {
      let asks = 0;
      server.setRequestHandler(async () => {
        asks++;
        return { action: 'accept', content: { decision: 'allow', scope: 'session' } };
      });
      assert.equal(await helper.ask('sess.test'), 'OK');
      assert.equal(await helper.ask('sess.test'), 'OK');
      assert.equal(asks, 1, 'session grant should have suppressed the second prompt');
      assert.equal(
        loadPolicy(policyFile).rules.some((r) => r.host === 'sess.test'), false,
        'a session grant must not be written to disk',
      );
    });

    await test('a new client session clears session grants', async () => {
      // initialize == a new connection. The next request for the host granted
      // "for this session" must prompt again.
      await server.rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, elicitation: {} },
        clientInfo: { name: 'test-network-approval', version: '1.0.0' },
      });
      await wait(200);
      let asked = false;
      server.setRequestHandler(async () => {
        asked = true;
        return { action: 'accept', content: { decision: 'deny', scope: 'once' } };
      });
      const r = await helper.ask('sess.test');
      assert.ok(r.startsWith('ERR'), `expected the grant to be gone, got ${r}`);
      assert.equal(asked, true, 'session grant survived a session rotation');
    });

    await test('declining denies', async () => {
      server.setRequestHandler(async () => ({ action: 'decline' }));
      const r = await helper.ask('declined.test');
      assert.ok(r.startsWith('ERR'), `expected ERR, got ${r}`);
    });

    await test('"always deny" is persisted and stops prompting', async () => {
      let asks = 0;
      server.setRequestHandler(async () => {
        asks++;
        return { action: 'accept', content: { decision: 'deny', scope: 'always' } };
      });
      assert.ok((await helper.ask('nope.test')).startsWith('ERR'));
      assert.ok((await helper.ask('nope.test')).startsWith('ERR'));
      assert.equal(asks, 1);
      const rule = loadPolicy(policyFile).rules.find((r) => r.host === 'nope.test');
      assert.equal(rule?.decision, 'deny');
    });

    await test('a long approval does not block other tool calls', async () => {
      // The regression this exists for: the server processes stdin strictly in
      // order, so an approval REPLY queued behind the exec that triggered it
      // would deadlock. Hold a prompt open and prove the channel still works.
      let release;
      const held = new Promise((r) => { release = r; });
      server.setRequestHandler(async () => {
        await held;
        return { action: 'accept', content: { decision: 'allow', scope: 'once' } };
      });
      const asking = helper.ask('slow.test');
      await wait(300);
      const info = await server.rpc('tools/call', { name: 'sandbox_info', arguments: {} });
      assert.ok(info.content[0].text.length > 0, 'server stopped answering while a prompt was open');
      release();
      assert.equal(await asking, 'OK');
    });

    await test('a slow answer is still applied, so a retry succeeds', async () => {
      // The proxy will not hold a connection forever, so the helper answers
      // "approve it and retry" first and keeps the prompt open. The regression
      // this guards: throwing the late answer away, which made the retry
      // prompt all over again — an approval the user gave and never got.
      const slow = startHelper({ policyFile, sock, timeoutMs: 1200 });
      try {
        let release;
        const held = new Promise((r) => { release = r; });
        server.setRequestHandler(async () => {
          await held;
          return { action: 'accept', content: { decision: 'allow', scope: 'always' } };
        });

        const first = await slow.ask('late.test');
        assert.ok(first.startsWith('ERR'), `expected a hold-expired refusal, got ${first}`);
        assert.match(first, /retry|approval/i, `refusal should tell the user what to do: ${first}`);

        release();                       // the user finally clicks Allow
        await wait(400);

        const rule = loadPolicy(policyFile).rules.find((r) => r.host === 'late.test');
        assert.ok(rule, 'late approval was discarded instead of recorded');
        assert.equal(rule.decision, 'allow');

        let askedAgain = false;
        server.setRequestHandler(async () => { askedAgain = true; return { action: 'decline' }; });
        assert.equal(await slow.ask('late.test'), 'OK', 'retry should now pass');
        assert.equal(askedAgain, false, 'retry prompted again despite a recorded grant');
      } finally {
        slow.stop();
      }
    });

    await test('killing the client denies instead of hanging', async () => {
      server.setRequestHandler(async () => new Promise(() => {})); // never answers
      const started = Date.now();
      const r = await helper.ask('hang.test');
      assert.ok(r.startsWith('ERR'), `expected a denial, got ${r}`);
      assert.ok(Date.now() - started < 25_000, 'denial took too long');
    });
  } finally {
    helper?.stop();
    server.stop();
  }
}

// =============================================================================
// 4. Over the gateway WebSocket (optional)
// =============================================================================
async function suiteGateway() {
  if (gatewayUrl === null) return;
  if (!suite(4, `Gateway round trip (${gatewayUrl})`)) return;

  let WebSocket;
  try {
    ({ default: WebSocket } = await import('ws'));
  } catch {
    console.log('  - skipped: `ws` is not installed (npm i ws)');
    return;
  }

  await test('gateway forwards a server-initiated request to the client', async () => {
    const ws = new WebSocket(gatewayUrl);
    const pending = new Map();
    let seq = 0, sawServerRequest = false;

    await new Promise((resolve, reject) => {
      ws.on('open', () => { ws.send(JSON.stringify({ type: 'auth', token: null })); });
      ws.on('error', reject);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ready') { resolve(); return; }
        if (msg.method !== undefined && msg.id !== undefined) {
          // Prove the reverse direction works end to end. Deny: this is a live
          // gateway and the test must not grant anything.
          sawServerRequest = true;
          ws.send(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { action: 'accept', content: { decision: 'deny', scope: 'once' } },
          }));
          return;
        }
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p(msg); }
      });
      setTimeout(() => reject(new Error('gateway did not become ready')), 10_000);
    });

    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
      pending.set(id, (m) => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });

    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, elicitation: {} },
      clientInfo: { name: 'test-network-approval', version: '1.0.0' },
    });
    const tools = await rpc('tools/list', {});
    const names = tools.tools.map((t) => t.name);
    assert.ok(names.includes('sandbox_network_policy'), 'sandbox_network_policy not exposed');

    const res = await rpc('tools/call', { name: 'sandbox_network_policy', arguments: {} });
    const body = JSON.parse(res.content[0].text);
    console.log(`      gateway sandbox is in --net ${body.mode} mode`);
    if (body.mode !== 'policy') {
      console.log('      (start the gateway sandbox with --net policy to exercise prompts)');
    }
    void sawServerRequest;
    ws.close();
  });
}

// =============================================================================
async function suitePreflight() {
  if (!ARGS.includes('--preflight')) return;
  console.log('\n[0] Enforcement preflight (pasta / nft / squid)');
  await new Promise((resolve) => {
    const p = spawn('bash', [SETUP, 'preflight'], { stdio: 'inherit' });
    p.on('exit', (code) => {
      console.log(code === 0
        ? '  \u2713 host can enforce --net policy for real'
        : '  ! host is missing enforcement tools; --net policy will refuse to start');
      resolve();
    });
  });
}

// =============================================================================
// 5. The installed proxy, end to end
// =============================================================================
async function suiteLiveProxy() {
  const port = Number(process.env.KOI_PROXY_PORT || 3129);

  const listening = await new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
    setTimeout(() => { sock.destroy(); resolve(false); }, 2000);
  });

  if (!suite(5, `Live egress proxy (127.0.0.1:${port})`)) return;
  if (!listening) {
    console.log('  - skipped: nothing is listening there. Enable it with:');
    console.log('      ./koi-gateway-installer network on');
    console.log('    (or set KOI_PROXY_PORT if a different port was chosen)');
    return;
  }

  // Plain HTTP through the proxy, no curl dependency: what matters is squid's
  // own status line, which tells us whether the ACL helper answered at all.
  const through = (host) => new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET', path: `http://${host}/`,
      headers: { Host: host }, timeout: 70_000,
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.end();
  });

  await test('proxy refuses a denied host with 403', async () => {
    const code = await through('169.254.169.254');
    assert.equal(
      code, 403,
      `expected 403 from the policy helper, got ${code}. Anything else means ` +
      'squid is up but the helper is not answering — check ' +
      'journalctl --user -u koi-egress -n 30',
    );
  });

  await test('an unapproved host is refused, not silently allowed', async () => {
    // Nothing is attached to answer a prompt here, so the helper must deny —
    // never allow, never hang forever.
    const code = await through('koi-network-test.invalid');
    assert.ok(
      code === 403 || code === 502 || code === 503,
      `expected a refusal for an unapproved host, got ${code}`,
    );
  });
}

// =============================================================================
// 6. Enforcement — is the sandbox actually FORCED through the proxy?
// -----------------------------------------------------------------------------
// Every other suite approaches the proxy as a client and asks "does the policy
// engine decide correctly?". None of them asks the load-bearing question:
// can a process inside the sandbox reach the network WITHOUT the proxy?
//
// It could not, and the suite was green anyway. `confine` installed the
// nftables filter with CAP_NET_ADMIN and then exec'd the payload while still
// holding it, so `nft flush ruleset` deleted the filter and direct egress
// worked. The allowlist, the dialog and the metadata denials all sat on top of
// a filter the payload owned.
//
// These tests run `confine` for real inside `unshare -Urn` — a throwaway user
// + network namespace. That needs no pasta, no squid and no root, so the
// property is checked on any Linux box instead of only where the full stack is
// installed. KOI_PROXY_HOST is pinned because the private netns has no default
// route to discover.
// =============================================================================

/**
 * Single-quote for the shell. NOT JSON.stringify: that produces double quotes,
 * so the OUTER shell expands `$HTTPS_PROXY` in a payload before `confine` has
 * exported it, and the test silently asserts against the wrong shell's env.
 */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Run a shell snippet in a throwaway user+network namespace.
 *
 * `beforeConfine` runs with capabilities INTACT, in the same namespace, after
 * confine has exited. That is the only way to inspect the installed ruleset:
 * the confined payload cannot list it, because listing needs the CAP_NET_ADMIN
 * that confine drops — which is itself the property under test.
 */
function inNetns(script) {
  return new Promise((resolve) => {
    const child = spawn('unshare', ['-Urn', 'bash', '-c', script],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => resolve({ code: -1, out, err, unavailable: true }));
    child.on('exit', (code) => resolve({ code, out, err, unavailable: false }));
  });
}

/** Run `payload` through the real `confine`. */
function inConfine(payload, { proxyHost = '127.0.0.1', proxyPort = 3199 } = {}) {
  return inNetns(
    `KOI_PROXY_HOST=${proxyHost} KOI_PROXY_PORT=${proxyPort} ` +
    `${shq(SETUP)} confine -- /bin/bash -c ${shq(payload)}`,
  );
}

async function suiteEnforcement() {
  if (!suite(6, 'Egress enforcement (the filter must outlive the payload)')) return;

  if (process.platform !== 'linux') {
    console.log('  - skipped: Linux-only (macOS confines with sandbox-exec)');
    return;
  }

  // Establish the harness works at all before trusting a negative result: a
  // blocked `unshare` would make every test below "pass" for the wrong reason.
  const probe = await inConfine('echo READY');
  if (probe.unavailable || !/READY/.test(probe.out)) {
    console.log('  - skipped: cannot create a user+network namespace here');
    console.log(`      ${(probe.err || '(no stderr)').trim().split('\n')[0]}`);
    console.log('    (unprivileged userns may be disabled, or nft is missing)');
    return;
  }

  await test('the payload cannot flush the egress filter', async () => {
    const r = await inConfine(
      'nft flush ruleset >/dev/null 2>&1 && echo FLUSHED || echo DENIED');
    assert.match(
      r.out, /DENIED/,
      'the confined command removed its own egress filter — CAP_NET_ADMIN is ' +
      'still held after confine exec\'d the payload, so the whole network ' +
      'policy is one `nft flush ruleset` away from being off',
    );
  });

  await test('CAP_NET_ADMIN and CAP_NET_RAW are dropped from the bounding set', async () => {
    // The bounding set is what makes the drop irreversible: without clearing
    // it, the payload regains the capability in a nested user namespace.
    const r = await inConfine('grep CapBnd /proc/self/status');
    const hex = /CapBnd:\s*([0-9a-f]+)/.exec(r.out)?.[1];
    assert.ok(hex, `could not read CapBnd: ${r.out}${r.err}`);
    const caps = BigInt('0x' + hex);
    const CAP_NET_ADMIN = 12n, CAP_NET_RAW = 13n;
    assert.equal((caps >> CAP_NET_ADMIN) & 1n, 0n, 'CAP_NET_ADMIN still in bounding set');
    assert.equal((caps >> CAP_NET_RAW) & 1n, 0n, 'CAP_NET_RAW still in bounding set');
  });

  await test('the capability cannot be regained in a nested user namespace', async () => {
    const r = await inConfine(
      'unshare -Ur nft flush ruleset >/dev/null 2>&1 && echo FLUSHED || echo DENIED');
    assert.match(r.out, /DENIED/, 'a nested userns handed CAP_NET_ADMIN back');
  });

  await test('the installed filter is default-drop except to the proxy', async () => {
    // Inspected from OUTSIDE confine: `nft list ruleset` needs CAP_NET_ADMIN,
    // and confine drops it. Running confine in a subshell means its exec
    // replaces only that subshell, leaving this one privileged and in the same
    // netns, looking at the rules confine actually installed.
    const r = await inNetns(
      `( KOI_PROXY_HOST=127.0.0.1 KOI_PROXY_PORT=3199 ${shq(SETUP)} confine -- /bin/true ); ` +
      'nft list ruleset',
    );
    assert.match(r.out, /policy drop/, `output chain is not default-drop:\n${r.out}${r.err}`);
    assert.match(r.out, /tcp dport 3199 accept/, 'proxy port is not the accepted destination');
    // Any OTHER accept would be a hole. Drop the three sanctioned lines and
    // nothing permissive may remain.
    const rest = r.out
      .split('\n')
      .filter((l) => !/dport 3199|established|oif "lo"/.test(l));
    assert.ok(
      !rest.some((l) => /\baccept\b/.test(l)),
      `unexpected accept rule widens the filter:\n${rest.join('\n')}`,
    );
  });

  await test('a command still runs, and still gets the proxy env', async () => {
    // The drop must not cost functionality: this is what would break if
    // setpriv/capsh were wired up wrong.
    const r = await inConfine('echo "ran=$? proxy=$HTTPS_PROXY"');
    assert.match(r.out, /ran=0/, `payload did not run: ${r.out}${r.err}`);
    assert.match(r.out, /proxy=http:\/\/127\.0\.0\.1:3199/, 'HTTPS_PROXY not exported');
    assert.equal(r.code, 0, `confine exited ${r.code}: ${r.err}`);
  });

  await test('confine refuses to run when the filter cannot be installed', async () => {
    // Fail-closed is the whole posture; assert it rather than assuming it.
    //
    // A stub `nft` that exits non-zero, shadowing the real one on PATH. Better
    // than emptying PATH: that also breaks the script's own `dirname`/`ip`
    // calls, so it would exit non-zero for an unrelated reason and the test
    // would pass without ever reaching the branch it means to check.
    const dir = tmpHome('nonft');
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'nft'),
      '#!/bin/sh\necho "nft: simulated failure" >&2\nexit 1\n', { mode: 0o755 });

    const r = await inNetns(
      `PATH=${shq(dir)}:$PATH KOI_PROXY_HOST=127.0.0.1 ${shq(SETUP)} ` +
      'confine -- /bin/echo PAYLOAD_RAN',
    );
    assert.ok(!/PAYLOAD_RAN/.test(r.out), 'the payload ran with no egress filter installed');
    assert.equal(r.code, 78, `expected exit 78 (refuse), got ${r.code}: ${r.err}`);
  });
}

async function main() {
  console.log('Koi sandbox network-approval tests (no LLM session required)');
  await suitePreflight();
  await suitePolicy();
  await suiteHelper();
  await suiteLoop();
  await suiteGateway();
  await suiteLiveProxy();
  await suiteEnforcement();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
