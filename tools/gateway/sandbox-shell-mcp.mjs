#!/usr/bin/env node
/**
 * sandbox-shell-mcp.mjs — Sandboxed host access MCP server for the Koi Gateway
 *
 * Zero-dependency MCP server (stdio, newline-delimited JSON-RPC) that gives the
 * LLM session a shell inside a lightweight sandbox:
 *
 *   - read-only view of the full host OS
 *   - writes land in an overlay (host is never mutated)
 *   - all host commands available (compilers, build tools, node, cargo, make,
 *     git, editors, ...) — language-agnostic; any project the host toolchain
 *     can build works
 *   - host network reachable (dev servers started inside are visible on
 *     localhost, so the Chrome extension can observe/operate them)
 *   - "network writes" prevented by credential masking + a git wrapper that
 *     blocks push/send-pack (see README notes: read vs write cannot be
 *     distinguished at the packet layer, so enforcement is at the
 *     credential/tool layer)
 *
 * IMPORTANT (bwrap-overlay):
 *   Each sandbox_exec / service starts a *new* bwrap with its own overlay
 *   mount over a shared upperdir. Writes from one invocation may not be
 *   visible to an already-running service (no reliable Vite HMR). After
 *   overlay edits, restart services (sandbox_restart_service) before
 *   browser-verify. Host PATH is preserved so fnm/nvm Node is available.
 *
 * Backends (selected automatically):
 *   linux  → bubblewrap (bwrap) with an overlayfs mount over the project dir
 *            (WSL2 Ubuntu 24.04 works out of the box: kernel >= 5.11 with
 *             unprivileged overlayfs-in-userns, bwrap 0.9)
 *   darwin → sandbox-exec (seatbelt) + APFS copy-on-write clone of the project
 *            as the "overlay" (cp -c), writes denied outside the workspace
 *   exec   → no isolation, plain exec (DEV/TEST ONLY, opt-in via
 *            KOI_SANDBOX_BACKEND=exec)
 *
 * Design (v2, minimal toolset):
 *   The security boundary is the sandbox environment, not the tool layer, so
 *   the LLM gets a SHELL (sandbox_exec) and uses ordinary commands for
 *   reading (cat/rg), diffing (git diff), committing (git commit — the
 *   overlay makes .git writable without touching the host repo) and shipping
 *   (git format-patch -o "$KOI_OUTBOX"). Server-side tools exist only where
 *   the shell fundamentally cannot do the job:
 *     - services:   each exec is its own bwrap PID namespace; background
 *                   processes die with it, so long-running services must be
 *                   spawned and owned by this server
 *     - reset:      the overlay upperdir lives on the host, outside the
 *                   sandbox's writable view — wiping it is a host-side op
 *     - disk gc:    same reason. Session overlays are a CACHE (see
 *                   --max-overlay-size, default 10GB): once the total exceeds
 *                   the cap the OLDEST overlays are deleted automatically
 *     - open_project/info: server state management
 *
 * Usage (spawned by koi-gateway.js, see gateway-config.json):
 *   node sandbox-shell-mcp.mjs [--project /path/to/project] [--net host|loopback]
 *   --project is optional (KOI_PROJECT env also honored). Without it the
 *   server boots projectless, scoped to $HOME, and the session picks the
 *   project at runtime with sandbox_open_project — the server is not tied to
 *   a single project by design.
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  DEFAULT_POLICY_PATH, DEFAULT_BROKER_SOCK, KOI_HOME,
  ensurePolicy, loadPolicy, ApprovalBroker,
} from './koi-net-policy.mjs';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);

// =============================================================================
// `review` CLI — host-side, READ-ONLY live view of a session overlay
// -----------------------------------------------------------------------------
// `node sandbox-shell-mcp.mjs review [...]` lets the user run git log / show /
// diff / status against the MERGED view (host tree + the LLM's overlay edits)
// while a topic or interactive session is running — a "watch window" onto what
// the model is writing, before anything is exported or applied.
//
// Isolation: on Linux this mounts a SEPARATE overlay via bwrap --ro-overlay,
// which takes no upperdir/workdir — it uses the session's upperdir only as a
// read-only LOWER layer (later --overlay-src is the higher layer, so overlay
// edits win over the host tree). It therefore cannot collide with the running
// sandbox's writable mounts and can never dirty the overlay; git runs with
// --no-optional-locks so even status/diff write nothing. Each invocation (and
// each --watch tick) is a fresh mount, so a view raced against a mid-write
// worker self-heals on the next tick.
//
// This block must run BEFORE any server side effects (parseArgs banner,
// setProject, network broker): review is a pure CLI and must not spawn
// children.
// =============================================================================

function reviewUsage() {
  return [
    'usage: node sandbox-shell-mcp.mjs review [options] [git args... | outbox]',
    '',
    '  Read-only merged view (host tree + overlay edits) of a sandbox session,',
    '  safe to use WHILE the session/topic is running. Never writes the overlay.',
    '',
    '  (no git args)         summary: log --oneline -12, status -sb, diff --stat HEAD',
    '  <git args...>         passed through to git in the merged view',
    '                        e.g.  review log -p -1 | review show HEAD | review diff HEAD~1',
    '  outbox                list the exported patch series on the host',
    '',
    '  --watch               re-render every interval (Ctrl-C to stop)',
    '  -n, --interval SEC    watch interval in seconds (default 3)',
    '  --project PATH        project dir (default: the live server\'s current.json pointer)',
    '  --session ID|LABEL    pick a session overlay (default: live session, else most recent)',
    '  --state DIR           state base dir (default ~/.koi/sandbox)',
  ].join('\n');
}

function reviewParseArgs(argv) {
  const f = { git: [], watch: false, interval: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--watch') f.watch = true;
    else if ((a === '-n' || a === '--interval') && argv[i + 1]) f.interval = Math.max(1, parseFloat(argv[++i]) || 3);
    else if (a === '--project' && argv[i + 1]) f.project = argv[++i];
    else if (a === '--session' && argv[i + 1]) f.session = argv[++i];
    else if (a === '--state' && argv[i + 1]) f.state = path.resolve(argv[++i]);
    else if (a === '-h' || a === '--help') f.help = true;
    else f.git.push(a);
  }
  return f;
}

/** Resolve which project + session overlay to view. Priority: explicit flags,
 *  then the live server's current.json pointer, then the most recent session
 *  on disk. Throws with an actionable message (including the available
 *  session ids/labels) when nothing matches. */
function reviewResolveTarget(f) {
  const stateBase = f.state || path.join(os.homedir(), '.koi', 'sandbox');
  let pointer = null;
  try { pointer = JSON.parse(fs.readFileSync(path.join(stateBase, 'current.json'), 'utf8')); } catch { /* no live pointer */ }
  const project = f.project ? path.resolve(f.project) : (pointer && pointer.project);
  if (!project) {
    throw new Error(`no live pointer at ${path.join(stateBase, 'current.json')} (server not started yet?) — pass --project <dir>`);
  }
  const id = crypto.createHash('sha1').update(project).digest('hex').slice(0, 10);
  const projectRoot = path.join(stateBase, id);
  const sessionsRoot = path.join(projectRoot, 'sessions');
  const sessions = listProjectSessions(sessionsRoot); // hoisted; fs/path only
  let sessionId = null;
  if (f.session) {
    const hit = sessions.find((s) => s.id === f.session) || sessions.find((s) => s.label === f.session);
    if (!hit) {
      const have = sessions.map((s) => `${s.id}${s.label ? ` (label: ${s.label})` : ''}`).join('\n    ') || '(none)';
      throw new Error(`no session with id or label '${f.session}' for ${project}\n  available:\n    ${have}`);
    }
    sessionId = hit.id;
  } else if (pointer && pointer.project === project && pointer.sessionId
      && sessions.some((s) => s.id === pointer.sessionId)) {
    sessionId = pointer.sessionId; // the session the live server is attached to
  } else if (sessions.length > 0) {
    sessionId = sessions[0].id;    // most recently touched
  } else {
    throw new Error(`no session overlays on disk for ${project} (looked in ${sessionsRoot})`);
  }
  const state = path.join(sessionsRoot, sessionId);
  const found = sessions.find((s) => s.id === sessionId);
  return {
    project, sessionId, label: found && found.label,
    upper: path.join(state, 'upper'),
    workspace: path.join(state, 'workspace'), // darwin CoW clone
    // Project-level outbox first (current layout), per-session second (legacy).
    outboxes: [path.join(projectRoot, 'outbox'), path.join(state, 'outbox')].filter((d) => fs.existsSync(d)),
  };
}

function reviewGitArgv(target, gitArgs) {
  const git = ['git', '--no-pager', '--no-optional-locks',
    '-c', 'core.fsmonitor=false', '-c', 'color.ui=auto', ...gitArgs];
  if (process.platform === 'darwin') {
    // Seatbelt backend: the session workspace is a plain CoW clone on disk —
    // no mount needed, just run git there (still with --no-optional-locks).
    return { cmd: git[0], args: git.slice(1), cwd: target.workspace };
  }
  // overlayfs forbids one layer being an ancestor of another; this bites the
  // projectless $HOME scope (upper lives under ~/.koi). Refuse with guidance.
  const rel = path.relative(target.project, target.upper);
  if (!rel.startsWith('..')) {
    throw new Error('project dir contains the overlay state (projectless $HOME scope?) — pass --project <real project dir>');
  }
  return {
    cmd: findBwrapBin(),
    args: [
      '--ro-bind', '/', '/',
      '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
      '--overlay-src', target.project,
      '--overlay-src', target.upper, // later src = higher layer: overlay edits win
      '--ro-overlay', target.project,
      '--die-with-parent',
      '--chdir', target.project,
      ...git,
    ],
    cwd: undefined,
  };
}

function reviewRunGit(target, gitArgs) {
  const { cmd, args, cwd } = reviewGitArgv(target, gitArgs);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd });
  if (r.error) { process.stderr.write(`review: ${cmd}: ${r.error.message}\n`); return 127; }
  return r.status == null ? 1 : r.status;
}

function reviewHeader(target) {
  return `# koi-sandbox review — ${target.project}\n` +
    `# session ${target.sessionId}${target.label ? ` (label: ${target.label})` : ''}` +
    ` — merged read-only view (host tree + overlay edits)`;
}

function reviewSummary(target) {
  process.stdout.write(reviewHeader(target) + '\n\n');
  let rc = 0;
  for (const [title, args] of [
    ['── git log ──', ['log', '--oneline', '--decorate', '-12']],
    ['── git status ──', ['status', '-sb']],
    ['── git diff --stat HEAD ──', ['diff', '--stat', 'HEAD']],
  ]) {
    process.stdout.write(title + '\n');
    rc = reviewRunGit(target, args) || rc;
    process.stdout.write('\n');
  }
  return rc;
}

function reviewOutbox(target) {
  process.stdout.write(reviewHeader(target) + '\n\n');
  let any = false;
  for (const dir of target.outboxes) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.patch')).sort(); } catch { continue; }
    if (names.length === 0) continue;
    any = true;
    process.stdout.write(`# outbox: ${dir}\n`);
    for (const n of names) {
      try {
        const st = fs.statSync(path.join(dir, n));
        process.stdout.write(`  ${n}  (${st.size} bytes, ${st.mtime.toISOString()})\n`);
      } catch { process.stdout.write(`  ${n}\n`); }
    }
    process.stdout.write(`\napply with:  cd ${target.project} && git am '${path.join(dir, '*.patch')}'\n\n`);
  }
  if (!any) process.stdout.write('(no exported patches yet)\n');
  return 0;
}

async function runReviewCli(argv) {
  const f = reviewParseArgs(argv);
  if (f.help) { process.stdout.write(reviewUsage() + '\n'); return 0; }
  let target;
  const once = () => {
    if (f.git[0] === 'outbox') return reviewOutbox(target);
    if (f.git.length === 0) return reviewSummary(target);
    process.stdout.write(reviewHeader(target) + '\n\n');
    return reviewRunGit(target, f.git);
  };
  try { target = reviewResolveTarget(f); }
  catch (e) { process.stderr.write(`review: ${e.message}\n${f.watch ? '' : reviewUsage() + '\n'}`); return 2; }
  if (!f.watch) {
    try { return once(); }
    catch (e) { process.stderr.write(`review: ${e.message}\n`); return 2; }
  }
  for (;;) {
    process.stdout.write('\x1b[2J\x1b[H');
    try { once(); } catch (e) { process.stderr.write(`review: ${e.message}\n`); }
    process.stdout.write(`\n(watching — refreshes every ${f.interval}s, Ctrl-C to stop)\n`);
    await new Promise((r) => setTimeout(r, f.interval * 1000));
    // Re-resolve each tick unless pinned: the live session can rotate mid-topic.
    if (!f.session) {
      try { target = reviewResolveTarget(f); } catch { /* keep showing the last-known target */ }
    }
  }
}

if (process.argv[2] === 'review') {
  process.exit(await runReviewCli(process.argv.slice(3)));
}

// -----------------------------------------------------------------------------
// Top-level `--help` / `-h`. The `review` subcommand has its own `--help`
// (handled above, before this point), so this only prints the server usage —
// including a pointer to the read-only `review` debug command.
// -----------------------------------------------------------------------------
function mainUsage() {
  return [
    'usage: node sandbox-shell-mcp.mjs [options]',
    '       node sandbox-shell-mcp.mjs review [options] [git args...]   (see: review --help)',
    '',
    '  Sandboxed host-access MCP server (stdio, newline-delimited JSON-RPC) for',
    '  the Koi Gateway. Gives the LLM session a shell inside a lightweight overlay',
    '  sandbox: the host is visible READ-ONLY, writes land in a per-session overlay',
    '  (host is never mutated), the host network is reachable, and network writes',
    '  are blocked at the credential/git layer.',
    '',
    'Server options:',
    '  --project PATH        project dir = writable-overlay scope, default cwd, and',
    '                        diff/export root (optional; KOI_PROJECT env also honored).',
    '                        Without it the server boots projectless scoped to $HOME',
    '                        and the session opens a project at runtime with',
    '                        sandbox_open_project({ path }).',
    '  --net MODE            egress mode for sandboxed processes. One of:',
    '                          host      (default) full host network, no filtering.',
    '                          loopback  no network at all.',
    '                          policy    default-deny egress through a filtering',
    '                                    proxy; unknown destinations prompt the user.',
    '                                    Needs pasta, nft and squid — check with',
    '                                    `koi-net-setup.sh preflight`.',
    '  --net-policy FILE     policy file for --net policy',
    `                        (default ${DEFAULT_POLICY_PATH}).`,
    '  --net-allow FILE      allowlist used to SEED the policy file on first run',
    '                        (default koi-network-allow.default next to this script).',
    '  --proxy-port N        egress proxy port for --net policy (default 3129 —',
    '                        NOT 3128, which is the distro squid default).',
    '  --allow-creds         allow access to host credentials (~/.ssh, ~/.npmrc, etc)',
    '  --state DIR           state base dir for overlays/sessions (default: ~/.koi/sandbox).',
    '  --max-overlay-size SZ disk cap for ALL session overlays under --state',
    '                        (default 10GB; accepts 10GB/512MB/2g/bytes, 0 = unlimited).',
    '                        Overlays are a cache: over the cap the oldest ones are',
    '                        deleted automatically. The live/in-use overlays and the',
    '                        per-project outbox (exported patches) are never evicted.',
    '  -h, --help            show this help and exit.',
    '',
    'Debug / review command:',
    '  review [git args...]  READ-ONLY live view (host tree + the LLM\'s overlay edits)',
    '                        of a running session — inspect what the model is writing',
    '                        WHILE a topic/session runs, before anything is exported or',
    '                        applied. Never touches the overlay.',
    '                          review                 summary (log/status/diff --stat)',
    '                          review <git args...>   e.g. review show HEAD | review diff HEAD~1',
    '                          review outbox          list the exported patch series',
    '                          review --watch [-n S]  live-refresh (default 3s)',
    '                          review --session ID    pick a specific session overlay',
    '                        Run  node sandbox-shell-mcp.mjs review --help  for full options.',
    '',
    '',
    'Environment:',
    '  KOI_PROJECT           default value for --project.',
    '  KOI_SANDBOX_BACKEND   force the backend: exec = NO isolation (DEV/TEST ONLY).',
    '  KOI_SANDBOX_PERSIST   1 = resume/persist the overlay session across restarts',
    '                        instead of starting fresh each connection.',
    '  KOI_SANDBOX_MAX_OVERLAY  default value for --max-overlay-size.',
    '',
    'Examples:',
    '  node sandbox-shell-mcp.mjs --project ~/code/app --net host',
    '  node sandbox-shell-mcp.mjs review --watch -n 2     # live-refresh every 2s',
    '  node sandbox-shell-mcp.mjs review show HEAD        # inspect the latest overlay commit',
  ].join('\n');
}

if (process.argv.slice(2).some((a) => a === '-h' || a === '--help')) {
  process.stdout.write(mainUsage() + '\n');
  process.exit(0);
}

// =============================================================================
// CLI / configuration
// =============================================================================

const SIZE_UNITS = {
  b: 1, kb: 1024, k: 1024, mb: 1024 ** 2, m: 1024 ** 2,
  gb: 1024 ** 3, g: 1024 ** 3, tb: 1024 ** 4, t: 1024 ** 4,
};

/**
 * Parse a human size ("10GB", "512mb", "2g", "1073741824") into bytes.
 * 0 / off / none / unlimited disable the cap. Unparseable input falls back to
 * `fallback` with a warning rather than killing the server on a typo in the
 * gateway config — a bad size must not cost the user their shell.
 */
function parseSizeSpec(spec, fallback) {
  if (spec == null) return fallback;
  const s = String(spec).trim().toLowerCase();
  if (s === '') return fallback;
  if (s === '0' || s === 'off' || s === 'none' || s === 'unlimited') return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)b?$/.exec(s.replace(/ib\b/g, 'b'));
  const unit = m ? SIZE_UNITS[m[2] || 'b'] ?? SIZE_UNITS[`${m[2]}b`] : undefined;
  if (!m || !unit) {
    process.stderr.write(`[sandbox-shell] WARNING: bad size value '${spec}' — using ${formatBytes(fallback)}\n`);
    return fallback;
  }
  return Math.round(parseFloat(m[1]) * unit);
}

function formatBytes(n) {
  if (!n) return 'unlimited';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`;
}

const DEFAULT_MAX_OVERLAY_BYTES = 10 * 1024 ** 3; // 10GB

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    allowCreds: false,
    project: process.env.KOI_PROJECT || null,
    net: 'host',
    netPolicy: process.env.KOI_NETWORK_POLICY || DEFAULT_POLICY_PATH,
    netAllow: process.env.KOI_NETWORK_ALLOW || path.join(SELF_DIR, 'koi-network-allow.default'),
    netSock: process.env.KOI_NETWORK_SOCK || DEFAULT_BROKER_SOCK,
    // 3129, not 3128: the sandbox proxy runs as the user next to whatever
    // squid.service the distro already has on the default port.
    proxyPort: Number(process.env.KOI_PROXY_PORT || 3129),
    state: null,
    // Disk budget for the session-overlay cache under --state. Deployment
    // policy, so it is set in the gateway config (args) or the unit (env);
    // 10GB is a sane default for a dev box that also has to build things.
    maxOverlayBytes: parseSizeSpec(process.env.KOI_SANDBOX_MAX_OVERLAY, DEFAULT_MAX_OVERLAY_BYTES),
    // Credential/secret paths to mask inside the sandbox. There is no built-in
    // list — what to mask is deployment policy, so it is supplied entirely here
    // (see the systemd unit / gateway-config.json). Comma-separated; `~` and
    // `$HOME` are expanded; bare names resolve against $HOME. Repeatable.
    // KOI_SANDBOX_EXCLUDE is the env channel: the Gateway spawns this server
    // with its own environment inherited, so the unit can set it directly.
    exclude: process.env.KOI_SANDBOX_EXCLUDE ? [process.env.KOI_SANDBOX_EXCLUDE] : [],
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) out.project = args[++i];
    else if (args[i] === '--allow-creds') {
      out.allowCreds = true;
      process.env.KOI_ALLOW_CREDS = '1';
    }
    else if (args[i] === '--net' && args[i + 1]) out.net = args[++i];
    else if (args[i] === '--net-policy' && args[i + 1]) out.netPolicy = path.resolve(args[++i]);
    else if (args[i] === '--net-allow' && args[i + 1]) out.netAllow = path.resolve(args[++i]);
    else if (args[i] === '--proxy-port' && args[i + 1]) out.proxyPort = Number(args[++i]);
    else if (args[i] === '--state' && args[i + 1]) out.state = path.resolve(args[++i]);
    else if ((args[i] === '--max-overlay-size' || args[i] === '--max-overlay') && args[i + 1]) {
      out.maxOverlayBytes = parseSizeSpec(args[++i], DEFAULT_MAX_OVERLAY_BYTES);
    }
    else if (args[i].startsWith('--max-overlay-size=')) {
      out.maxOverlayBytes = parseSizeSpec(args[i].slice('--max-overlay-size='.length), DEFAULT_MAX_OVERLAY_BYTES);
    }
    else if (args[i] === '--exclude' && args[i + 1]) out.exclude.push(args[++i]);
    else if (args[i].startsWith('--exclude=')) out.exclude.push(args[i].slice('--exclude='.length));
  }
  if (!['host', 'loopback', 'policy'].includes(out.net)) {
    process.stderr.write(
      `sandbox-shell-mcp: unknown --net mode '${out.net}' (expected host|loopback|policy)\n`);
    process.exit(1);
  }
  if (out.net === 'policy') {
    if (process.env.KOI_NET_TEST === '1') {
      // Approval-path test harness (test-network-approval.mjs). Skips ONLY the
      // enforcement preflight so the broker/elicitation round trip can be
      // exercised without pasta/nft/squid installed. Nothing is confined in
      // this mode, so it must never be how a real session starts — hence a
      // flag nobody sets by accident, and a banner in every sandbox_info.
      process.stderr.write(
        '[sandbox-shell] *** KOI_NET_TEST=1: egress enforcement preflight SKIPPED. ***\n' +
        '[sandbox-shell] *** The sandbox is NOT network-confined in this mode. ***\n');
    } else {
      // Fail at boot, not at the first blocked command: a "policy" sandbox
      // whose enforcement tools are missing would silently be a `host` sandbox.
      // --running, not the plain setup check: by the time this server boots the
      // proxy is supposed to be UP, so "port free" would be the failure and
      // "port busy" the success. Using the wrong mode here made a correctly
      // running proxy abort the sandbox with "port is already in use".
      const probe = spawnSync(path.join(SELF_DIR, 'koi-net-setup.sh'), ['preflight', '--running'], { encoding: 'utf8' });
      const report = `${probe.stdout || ''}${probe.stderr || ''}`;
      if (probe.error || probe.status !== 0) {
        process.stderr.write(
          '[sandbox-shell] --net policy requires a RUNNING egress proxy' +
          (process.platform === 'darwin' ? '' : ', pasta and nft') + ':\n' + report +
          'Install the missing pieces, or start with --net host / --net loopback.\n');
        process.exit(1);

      }
      process.stderr.write(report);
    }
  }
  if (out.project && out.project.includes('${')) {
    process.stderr.write(
      `sandbox-shell-mcp: project path placeholder was not substituted: ${out.project}\n` +
      'Pass --project <dir> (or set KOI_PROJECT) with an expanded absolute path.\n');
    process.exit(1);
  }
  if (!out.project) {
    // Projectless boot (by design: the LLM switches projects freely at
    // runtime via sandbox_open_project). $HOME serves as a neutral home-base
    // overlay until a project is opened.
    out.project = os.homedir();
    out.defaultProject = true;
    process.stderr.write(
      '[sandbox-shell] no --project given; starting projectless with $HOME as ' +
      'the initial scope. Open a project with sandbox_open_project({ path }).\n');
  }
  return out;
}

const OPTS = parseArgs();

// Per-file tracing of lower->upper reconciliation. Off by default (it is one
// line per refreshed file, every exec); reconciliation FAILURES are logged
// unconditionally regardless of this flag — a silent desync is the one
// outcome nobody can debug from the outside.
const SYNC_DEBUG = process.env.KOI_SANDBOX_DEBUG_SYNC === '1';

const OUTPUT_CAP = 200 * 1024;      // per-stream cap for exec output
const LOG_CAP = 500 * 1024;         // per-service ring buffer
const DEFAULT_TIMEOUT_MS = 120_000;

function log(msg) {
  process.stderr.write(`[sandbox-shell] ${msg}\n`);
}

// =============================================================================
// Build identity — "is the running process the code on disk?"
// =============================================================================
// A long-lived server keeps serving whatever it loaded at import time. Edit the
// file, forget to restart (or restart a unit pointing at a different copy) and
// the fix is on disk while the bug is live — with a green test suite, because
// tests spawn a fresh server from the checkout and never touch the running one.
//
// That is not hypothetical: it is how the outbox mask-shadowing bug survived
// its own fix. The session that investigated had to infer the running version
// from mount IDs in /proc/self/mountinfo, because nothing in the protocol could
// answer "which code are you?". These fields answer it directly, and `stale`
// answers the sharper question — whether the file has changed underneath us
// since we loaded it, which is exactly the forgot-to-restart case.
const PROCESS_STARTED_AT = new Date().toISOString();
const BUILD_LOADED = readBuildIdentity();

function readBuildIdentity() {
  try {
    const buf = fs.readFileSync(SELF_PATH);
    return {
      file: SELF_PATH,
      sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12),
      mtime: fs.statSync(SELF_PATH).mtime.toISOString(),
      bytes: buf.length,
    };
  } catch (e) {
    return { file: SELF_PATH, sha256: null, mtime: null, bytes: null, error: e.message };
  }
}

/** Build identity plus whether the file on disk has moved on without us. */
function buildStatus() {
  const onDisk = readBuildIdentity();
  const stale = !!(BUILD_LOADED.sha256 && onDisk.sha256 && onDisk.sha256 !== BUILD_LOADED.sha256);
  return {
    ...BUILD_LOADED,
    startedAt: PROCESS_STARTED_AT,
    stale,
    ...(stale ? { onDisk: { sha256: onDisk.sha256, mtime: onDisk.mtime, bytes: onDisk.bytes } } : {}),
  };
}

// =============================================================================
// Project state — mutable so the sandbox can switch projects at runtime
// (sandbox_open_project) without a restart. The full host is always visible
// read-only; the "project" only determines the writable overlay location,
// default cwd, relative-path root, and diff/export scope. Each project keeps
// its own persistent overlay state dir, keyed by path hash.
// =============================================================================

let BACKEND = null; // assigned after the initial setProject()

const PROJ = { path: null, id: null, state: null, sessionId: null, dirs: null };

/**
 * Host-visible directory holding this session's project tree.
 *
 * linux  → the overlayfs upperdir (this session's writes)
 * darwin → the CoW workspace clone (the whole tree)
 *
 * For a GREENFIELD project the upperdir IS the entire project, because the
 * lower layer is empty — so `cp -r <this>/. <target>/` is a complete, always-
 * available delivery that needs no commit, no export and no surviving session.
 * For an existing project it holds only changed files.
 */
function projectTreeHostPath() {
  if (!PROJ.dirs) return undefined;
  return process.platform === 'darwin' ? PROJ.dirs.workspace : PROJ.dirs.upper;
}

// A "session id" scopes the writable overlay. It is rotated once per client
// connection (on the MCP `initialize` handshake), NOT per sandbox_open_project
// call. Consequences:
//   - Within one connection, switching projects away and back reuses the same
//     overlay, so in-progress work is never silently lost.
//   - A new client connection (a new LLM session — even against a gateway that
//     pools this process) re-initializes, gets a new session id, and therefore
//     starts every project FRESH from the read-only host tree: the stable base
//     the user actually sees on disk, never a previous session's unexported
//     intermediate edits. Inheriting a stale overlay would make the model's
//     view diverge from the human's — a subtle, hard-to-debug class of bug.
// Reattaching a prior session's overlay is opt-in (resume), and a clean slate
// mid-connection is available via fresh:true / KOI_SANDBOX_PERSIST=1 restores
// the old always-persist behavior.
function newSessionId() {
  return new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
}

// The current connection's session id. Rotated on `initialize`; may be pointed
// at a prior session by an explicit resume.
let SESSION_ID = newSessionId();

// Conversation-scoped session key. A transport reconnect (idle socket closed
// by the browser, a dropped WebSocket mid-build, a gateway-pooled process
// serving a returning client) re-runs `initialize`, and rotating SESSION_ID on
// every handshake made each reconnect look like a brand-new LLM session: the
// next sandbox_open_project attached an EMPTY overlay and the model's
// in-progress edits vanished from view. Only the client knows whether a
// handshake continues an existing conversation, so it may say so by sending a
// stable key in the initialize params:
//
//   params._meta['koi/sessionKey']                      (preferred)
//   params.capabilities.experimental.koiSession.key     (SDK-friendly form)
//
// Same key as the previous handshake -> a reconnect: SESSION_ID and the
// session's network grants are kept. The key is also recorded (as a digest) on
// the session overlay it attaches, so the conversation finds its overlay again
// after a server restart. A client that sends no key keeps the old behavior.
let SESSION_KEY = null;

function sessionKeyDigest(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 32);
}

function readSessionKeyFromInit(params) {
  const k = params?._meta?.['koi/sessionKey'] ?? params?.capabilities?.experimental?.koiSession?.key;
  return typeof k === 'string' && k.trim() !== '' ? k.trim() : null;
}

function sessionKeyDigestOf(stateDir) {
  try { return fs.readFileSync(path.join(stateDir, 'sessionkey'), 'utf8').trim() || null; } catch { return null; }
}

/** Make `stateDir` the one overlay of this project that answers to `key`. */
function claimSessionKey(sessionsRoot, stateDir, key) {
  const digest = sessionKeyDigest(key);
  let names = [];
  try { names = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* none */ }
  for (const name of names) {
    const dir = path.join(sessionsRoot, name);
    if (dir !== stateDir && sessionKeyDigestOf(dir) === digest) {
      try { fs.unlinkSync(path.join(dir, 'sessionkey')); } catch { /* best effort */ }
    }
  }
  try { fs.writeFileSync(path.join(stateDir, 'sessionkey'), digest + '\n'); } catch { /* best effort */ }
}

// Enumerate existing session overlays for a project (most recent first), with
// a cheap "changed files" count so nothing in the overlay is ever invisible.
function listProjectSessions(sessionsRoot) {
  let names = [];
  try { names = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
  const out = names.map((name) => {
    const upper = path.join(sessionsRoot, name, 'upper');
    let changed = 0, mtimeMs = 0, label;
    try { changed = countFilesRec(upper); } catch { /* ignore */ }
    try { mtimeMs = fs.statSync(path.join(sessionsRoot, name)).mtimeMs; } catch { /* ignore */ }
    try { label = fs.readFileSync(path.join(sessionsRoot, name, 'label'), 'utf8').trim() || undefined; } catch { /* unlabeled */ }
    return { id: name, changedFiles: changed, mtimeMs, ...(label ? { label } : {}) };
  });
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function countFilesRec(dir) {
  let n = 0, entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (e.isDirectory()) n += countFilesRec(path.join(dir, e.name));
    else n += 1;
  }
  return n;
}

/** Root of all sandbox state: <base>/<projectId>/{sessions/<sessionId>,outbox}. */
function stateBaseDir() {
  return OPTS.state || path.join(os.homedir(), '.koi', 'sandbox');
}

// =============================================================================
// Overlay disk budget — session overlays are a CACHE, not storage
// -----------------------------------------------------------------------------
// Every connection mints a new session overlay, every `npm install` inside one
// materializes node_modules into its upperdir, and nothing ever deleted them:
// ~/.koi/sandbox grows without bound until the host runs out of disk — at which
// point builds fail inside the sandbox for reasons the model cannot see or fix.
//
// The fix follows from what an overlay actually IS: a scratch layer over a host
// tree that the user still has. The durable outputs live elsewhere — exported
// patches/bundles in the PROJECT-level outbox (never evicted), and the host repo
// itself. So overlays can be treated as cache: keep total usage under a cap and
// evict the least recently used overlays when it is exceeded.
//
// Never evicted:
//   - the overlay this server is attached to (PROJ.state)
//   - overlays another live server process is attached to (fresh `inuse` marker
//     with a pid that still exists) — concurrent gateway-spawned servers must
//     not delete each other's work
//   - outbox dirs: they sit at the PROJECT level, outside sessions/, and are the
//     deliverable
//
// Cost control: the sweep walks session dirs with lstat, so results for
// non-live sessions are cached (they only change if another process writes
// them) and the sweep runs off the tool-call path (see scheduleOverlayGc).
// =============================================================================

const MAX_OVERLAY_BYTES = OPTS.maxOverlayBytes;
const OVERLAY_GC_LOW_WATER = 0.85;        // sweep down to 85% of the cap
const OVERLAY_GC_MIN_INTERVAL_MS = 30_000; // debounce between sweeps
const OVERLAY_GC_PERIOD_MS = 5 * 60_000;   // idle safety net (long-running services)
const OVERLAY_WALK_ENTRY_CAP = 500_000;    // bail out of pathological trees
const OVERLAY_USAGE_TTL_MS = 10 * 60_000;  // cache TTL for non-live sessions
const OVERLAY_INUSE_STALE_MS = 30 * 60_000;
// A session overlay that still holds work when the server attaches a different
// overlay for the same project is pinned for this long. Without the pin, the
// detached overlay is only protected by its `inuse` marker (30 min), and a few
// fresh sessions that each rebuild `target/` or `node_modules` can push the
// cache over its cap and evict the one overlay holding the unexported work.
const OVERLAY_DETACH_PIN_MS = 24 * 60 * 60_000;

/** dir -> { bytes, files, newestMtimeMs, truncated, at } */
const overlayUsageCache = new Map();

/** Result of the most recent sweep; surfaced in sandbox_info. */
let LAST_OVERLAY_GC = null;

/**
 * Disk usage of a directory tree. Uses st.blocks (actual allocation, like du)
 * when available, counts a hardlinked inode once, never follows symlinks, and
 * also reports the newest mtime found — that is the LRU key, and it is far more
 * accurate than the session dir's own mtime (which does not change when a
 * nested file is written).
 */
function dirUsage(dir) {
  let bytes = 0, files = 0, truncated = false, seenEntries = 0;
  let newestMtimeMs = 0;
  try { newestMtimeMs = fs.statSync(dir).mtimeMs; } catch { return { bytes: 0, files: 0, newestMtimeMs: 0, truncated: false }; }
  const hardlinks = new Set();
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seenEntries > OVERLAY_WALK_ENTRY_CAP) { truncated = true; stack.length = 0; break; }
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(p); continue; }
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.nlink > 1) {
        const key = `${st.dev}:${st.ino}`;
        if (hardlinks.has(key)) continue;
        hardlinks.add(key);
      }
      bytes += typeof st.blocks === 'number' && st.blocks >= 0 ? st.blocks * 512 : st.size;
      files++;
      if (st.mtimeMs > newestMtimeMs) newestMtimeMs = st.mtimeMs;
    }
  }
  return { bytes, files, newestMtimeMs, truncated };
}

function sessionUsage(dir, { live = false } = {}) {
  const hit = overlayUsageCache.get(dir);
  if (!live && hit && Date.now() - hit.at < OVERLAY_USAGE_TTL_MS) return hit;
  const u = { ...dirUsage(dir), at: Date.now() };
  overlayUsageCache.set(dir, u);
  return u;
}

/** Mark this session as attached, so a sibling server never evicts it. */
function touchSessionInUse() {
  if (!PROJ.state) return;
  try {
    fs.writeFileSync(path.join(PROJ.state, 'inuse'),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n');
  } catch { /* best effort — worst case this overlay looks evictable */ }
}

/** Protect a detached session overlay from GC eviction until `until`. */
function pinSession(dir, reason, ms = OVERLAY_DETACH_PIN_MS) {
  const until = new Date(Date.now() + ms).toISOString();
  try { fs.writeFileSync(path.join(dir, 'pinned'), JSON.stringify({ until, reason }) + '\n'); } catch { /* best effort */ }
  return until;
}

function sessionPinned(dir) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'pinned'), 'utf8'));
    return Date.parse(rec.until) > Date.now();
  } catch { return false; }
}

/** True if another (or this) live process is attached to the session at `dir`. */
function sessionInUse(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, 'inuse'), 'utf8'); } catch { return false; }
  let rec;
  try { rec = JSON.parse(raw); } catch { return false; }
  const at = Date.parse(rec.at || '');
  if (!Number.isFinite(at) || Date.now() - at > OVERLAY_INUSE_STALE_MS) return false;
  if (!rec.pid) return false;
  try { process.kill(rec.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Structural guard: only ever delete <base>/<projectId>/sessions/<sessionId>. */
function isEvictableSessionDir(dir) {
  const rel = path.relative(stateBaseDir(), dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  return parts.length === 3 && parts[1] === 'sessions';
}

/** Every session overlay on disk, with usage and its protection status. */
function listOverlaySessions() {
  const base = stateBaseDir();
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return out; }
  for (const projectId of projects) {
    const sessionsRoot = path.join(base, projectId, 'sessions');
    let ids = [];
    try { ids = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { continue; }
    for (const sessionId of ids) {
      const dir = path.join(sessionsRoot, sessionId);
      const live = PROJ.state === dir;
      const usage = sessionUsage(dir, { live });
      let label;
      try { label = fs.readFileSync(path.join(dir, 'label'), 'utf8').trim() || undefined; } catch { /* unlabeled */ }
      const protectedBy = live ? 'live' : (sessionInUse(dir) ? 'in-use' : (sessionPinned(dir) ? 'pinned' : null));
      out.push({ dir, projectId, sessionId, label, live, protectedBy, ...usage });
    }
  }
  return out;
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

/**
 * Enforce the cap: delete the least recently used unprotected overlays until
 * total usage is back under the low-water mark. Returns a summary (also stored
 * in LAST_OVERLAY_GC for sandbox_info).
 */
function enforceOverlayBudget(reason = 'periodic') {
  if (!MAX_OVERLAY_BYTES) return null;
  const sessions = listOverlaySessions();
  let total = sessions.reduce((n, s) => n + s.bytes, 0);
  const result = {
    at: new Date().toISOString(), reason,
    limit: MAX_OVERLAY_BYTES, limitHuman: formatBytes(MAX_OVERLAY_BYTES),
    usedBefore: total, sessions: sessions.length, evicted: [], freedBytes: 0,
  };
  if (total > MAX_OVERLAY_BYTES) {
    const target = Math.floor(MAX_OVERLAY_BYTES * OVERLAY_GC_LOW_WATER);
    const candidates = sessions
      .filter((s) => !s.protectedBy && isEvictableSessionDir(s.dir))
      .sort((a, b) => a.newestMtimeMs - b.newestMtimeMs); // oldest first
    for (const c of candidates) {
      if (total <= target) break;
      try { rmrf(c.dir); }
      catch (e) { log(`overlay cache: could not evict ${c.sessionId}: ${e.message}`); continue; }
      overlayUsageCache.delete(c.dir);
      total -= c.bytes;
      result.freedBytes += c.bytes;
      result.evicted.push({
        session: c.sessionId, project: c.projectId, ...(c.label ? { label: c.label } : {}),
        bytes: c.bytes, human: formatBytes(c.bytes),
        lastUsed: c.newestMtimeMs ? new Date(c.newestMtimeMs).toISOString() : null,
      });
    }
  }
  result.used = total;
  result.usedHuman = formatBytes(total);
  result.overBudget = total > MAX_OVERLAY_BYTES;
  if (result.evicted.length) {
    log(`overlay cache: freed ${formatBytes(result.freedBytes)} by evicting ${result.evicted.length} old session overlay(s) — ` +
        `now ${formatBytes(total)} / ${formatBytes(MAX_OVERLAY_BYTES)} (${reason})`);
  }
  if (result.overBudget) {
    // Nothing evictable left: what remains is the live session (and any
    // sibling server's). We do NOT delete in-progress work to satisfy a cache
    // cap — say so loudly instead, and surface it to the session (see
    // overlayPressureMeta) so the model can stop installing things.
    log(`overlay cache: STILL OVER BUDGET — ${formatBytes(total)} / ${formatBytes(MAX_OVERLAY_BYTES)} ` +
        'with only live/in-use overlays left. Raise --max-overlay-size or free space manually.');
  }
  LAST_OVERLAY_GC = result;
  return result;
}

let overlayGcTimer = null;
let overlayGcPending = null;
let overlayGcLastAt = 0;
let overlayGcRunning = false;

/**
 * Request a sweep. Debounced and deferred so the (synchronous) tree walk never
 * lands in the middle of a tool call: writes are frequent, the cap is not a
 * hard quota, and a few seconds of lag costs nothing.
 */
function scheduleOverlayGc(reason) {
  if (!MAX_OVERLAY_BYTES || overlayGcTimer) return;
  overlayGcPending = reason;
  const wait = Math.max(0, OVERLAY_GC_MIN_INTERVAL_MS - (Date.now() - overlayGcLastAt));
  overlayGcTimer = setTimeout(() => {
    overlayGcTimer = null;
    const r = overlayGcPending; overlayGcPending = null;
    if (overlayGcRunning) return;
    overlayGcRunning = true;
    try { touchSessionInUse(); enforceOverlayBudget(r); }
    catch (e) { log(`overlay cache sweep failed: ${e.message}`); }
    finally { overlayGcRunning = false; overlayGcLastAt = Date.now(); }
  }, wait);
  overlayGcTimer.unref?.();
}

if (MAX_OVERLAY_BYTES) {
  const t = setInterval(() => scheduleOverlayGc('periodic'), OVERLAY_GC_PERIOD_MS);
  t.unref?.();
}

/** Budget status for sandbox_info (uses the usage cache; live session rescanned). */
function overlayBudgetStatus() {
  if (!MAX_OVERLAY_BYTES) {
    return { limit: 0, limitHuman: 'unlimited', enforcement: 'disabled (--max-overlay-size 0)' };
  }
  const sessions = listOverlaySessions();
  const used = sessions.reduce((n, s) => n + s.bytes, 0);
  const mine = sessions.find((s) => s.live);
  return {
    limit: MAX_OVERLAY_BYTES,
    limitHuman: formatBytes(MAX_OVERLAY_BYTES),
    used, usedHuman: formatBytes(used),
    sessions: sessions.length,
    thisSessionBytes: mine ? mine.bytes : 0,
    thisSessionHuman: formatBytes(mine ? mine.bytes : 0),
    overBudget: used > MAX_OVERLAY_BYTES,
    lastSweep: LAST_OVERLAY_GC
      ? { at: LAST_OVERLAY_GC.at, reason: LAST_OVERLAY_GC.reason, evicted: LAST_OVERLAY_GC.evicted.length, freed: formatBytes(LAST_OVERLAY_GC.freedBytes) }
      : null,
    note: 'Session overlays are a CACHE with a disk cap: when the total is exceeded the oldest overlays are deleted automatically. This session\'s overlay and any other live session are never evicted, and neither is the outbox — but an abandoned overlay may be gone when you try to resume it, so ship work (outbox / commits) rather than parking it in an old session.',
  };
}

/**
 * Attached to write/exec results only when the cache is over budget and cannot
 * shrink further — i.e. when THIS session's writes are the problem. Silent
 * otherwise, so the normal path costs nothing.
 */
/**
 * Current egress policy, for sandbox_info and sandbox_network_policy. Read from
 * disk each time: an "always" grant from the approval dialog is written by the
 * ACL helper, not by this process, so a cached copy would go stale the moment
 * the user approves something.
 */
function networkPolicySummary() {
  let policy;
  try {
    policy = loadPolicy(OPTS.netPolicy);
  } catch (e) {
    return { error: `policy unreadable (${e.message}) — every request will prompt` };
  }
  const fmt = (r) => (Array.isArray(r.ports) && r.ports.length ? `${r.host}:${r.ports.join(',')}` : r.host);
  return {
    file: OPTS.netPolicy,
    proxyPort: OPTS.proxyPort,
    unmatched: policy.default === 'ask'
      ? 'prompts the user (denied when no session is attached to answer)'
      : policy.default,
    allowed: policy.rules.filter((r) => r.decision === 'allow').map(fmt),
    denied: policy.rules.filter((r) => r.decision === 'deny').map(fmt),
  };
}

function overlayPressureMeta() {
  if (!LAST_OVERLAY_GC || !LAST_OVERLAY_GC.overBudget) return {};
  return {
    diskPressure: {
      used: LAST_OVERLAY_GC.usedHuman,
      limit: LAST_OVERLAY_GC.limitHuman,
      hint: 'The sandbox overlay cache is over its disk cap and only live sessions remain, so nothing more can be reclaimed automatically. Avoid writing large trees (node_modules, build output, downloads) into the overlay; they are not part of the deliverable. Ship finished work to the outbox and let the user raise --max-overlay-size if the project genuinely needs more.',
    },
  };
}


/**
 * Look up the directory hierarchy starting from startPath to find the root
 * containing a .git directory (or file for worktrees/submodules).
 * If no .git is found, returns null.
 */
function findGitRoot(startPath) {
  if (!startPath) return null;
  let curr = path.resolve(startPath);
  try {
    const st = fs.statSync(curr);
    if (!st.isDirectory()) curr = path.dirname(curr);
  } catch {
    curr = path.dirname(curr);
  }

  while (curr && curr !== path.dirname(curr)) {
    const gitPath = path.join(curr, '.git');
    try {
      if (fs.existsSync(gitPath)) {
        return curr;
      }
    } catch { /* ignore */ }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return null;
}

function setProject(projectPath, { resume = null, fresh = false, label = null } = {}) {
  let expandedPath = projectPath;
  if (!expandedPath || expandedPath.trim() === '') {
    expandedPath = findGitRoot(process.cwd()) || process.cwd() || os.homedir();
  } else if (expandedPath === '~') {
    expandedPath = os.homedir();
  } else if (expandedPath.startsWith('~/')) {
    expandedPath = path.join(os.homedir(), expandedPath.slice(2));
  }
  let p = path.resolve(expandedPath);
  const gitRoot = findGitRoot(p);
  if (gitRoot) {
    if (gitRoot !== p) {
      log(`resolved project path ${p} up to git root: ${gitRoot}`);
    }
    p = gitRoot;
  }
  // Whether the project already exists on the host decides two things WITHOUT
  // ever mutating the host tree:
  //   hostAbsent  -> the path does not exist. We must NOT create it on the host
  //                  (that breaks the read-only-host invariant and litters the
  //                  filesystem with empty dirs from abandoned topics). Instead
  //                  the overlay mounts an EMPTY scratch lowerdir at a
  //                  sandbox-internal path; the whole new project lives in the
  //                  overlay upper and is materialized on the host only when the
  //                  USER applies the exported bundle — exactly like patches for
  //                  existing projects.
  //   greenfield  -> there is no host-side git base to apply a delta onto, so
  //                  the ship contract becomes a whole tree (git bundle ->
  //                  git clone), not format-patch/git am. Currently this is the
  //                  hostAbsent case; an existing non-git dir keeps the delta
  //                  flow because its files ARE the base.
  let hostExists = false, isDir = false;
  try { const st = fs.statSync(p); hostExists = true; isDir = st.isDirectory(); } catch { /* absent */ }
  if (hostExists && !isDir) throw new Error(`project path exists but is not a directory: ${p}`);
  const hostAbsent = !hostExists;
  const greenfield = hostAbsent;
  if (greenfield) {
    log(`project dir does not exist on host: ${p} — starting an empty greenfield overlay (host untouched; ship with git bundle -> git clone).`);
  }
  const id = crypto.createHash('sha1').update(p).digest('hex').slice(0, 10);
  const stateBase = stateBaseDir();
  const projectRoot = path.join(stateBase, id);
  const sessionsRoot = path.join(projectRoot, 'sessions');
  fs.mkdirSync(sessionsRoot, { recursive: true });

  // Choose the session overlay to attach:
  //   resume === '<id>'  -> reattach that specific prior session
  //   resume === true    -> reattach the most recent prior session
  //   fresh === true     -> rotate to a brand-new empty session (mid-connection)
  //   otherwise          -> this connection's session (SESSION_ID); reused
  //                         across open_project calls, so switch-back is stable.
  let sessionId = null;
  let resumed = false;
  let resumedByKey = false;
  const persistDefault = process.env.KOI_SANDBOX_PERSIST === '1';
  const wantResume = resume != null ? resume : (persistDefault && !fresh ? true : null);
  if (fresh) {
    SESSION_ID = newSessionId();
  } else if (wantResume) {
    const sessions = listProjectSessions(sessionsRoot);
    if (typeof wantResume === 'string') {
      if (sessions.some((s) => s.id === wantResume)) { sessionId = wantResume; resumed = true; }
      else {
        // Not a session id — try it as a LABEL (most recent labeled match).
        // Labels let long-running integrations (e.g. a topic runner) pin "the
        // overlay for topic X" without carrying raw timestamp ids around.
        const byLabel = sessions.find((s) => s.label === wantResume);
        if (byLabel) { sessionId = byLabel.id; resumed = true; }
        else throw new Error(`resume: no session with id or label '${wantResume}' for this project — it never existed, or it was evicted by the overlay disk cache (see sandbox_info.priorSessions / overlayBudget)`);
      }
    } else if (sessions.length > 0) {
      sessionId = sessions[0].id; resumed = true;
    }
  } else if (SESSION_KEY) {
    // The conversation already has an overlay for this project (from before a
    // reconnect or a server restart): attach it instead of an empty one.
    const digest = sessionKeyDigest(SESSION_KEY);
    const byKey = listProjectSessions(sessionsRoot).find((s) => sessionKeyDigestOf(path.join(sessionsRoot, s.id)) === digest);
    if (byKey) {
      sessionId = byKey.id;
      resumedByKey = true;
      // Re-attaching the overlay we are already on is a continuation.
      resumed = path.join(sessionsRoot, byKey.id) !== PROJ.state;
    }
  }
  if (!sessionId) sessionId = SESSION_ID;

  const state = path.join(sessionsRoot, sessionId);
  // "fresh" == this session's overlay does not exist yet == starting from host.
  const startedFromHost = !fs.existsSync(path.join(state, 'upper'));
  const dirs = {
    upper: path.join(state, 'upper'),         // overlayfs upperdir (linux)
    work: path.join(state, 'work'),           // overlayfs workdir  (linux)
    lower: path.join(state, 'lower'),         // EMPTY greenfield lower (linux)
    workspace: path.join(state, 'workspace'), // CoW clone          (darwin)
    bin: path.join(state, 'bin'),             // git wrapper etc., first on PATH
    // Exported patches (host-visible). PROJECT-level, not per-session: the
    // patch series is the topic's durable deliverable and must survive a
    // pruned/abandoned session overlay (a topic recovers by `git am`-ing the
    // outbox into a new overlay). Re-exports are deterministic — format-patch
    // from the fixed base overwrites the same filenames — so sequential
    // sessions of one topic dedupe naturally. (Concurrent sessions on the
    // same project already corrupt shared sandbox state and are unsupported.)
    outbox: path.join(projectRoot, 'outbox'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  if (label != null && String(label).trim() !== '') {
    try { fs.writeFileSync(path.join(state, 'label'), String(label).trim() + '\n'); } catch { /* best effort */ }
  }
  let sessionLabel;
  try { sessionLabel = fs.readFileSync(path.join(state, 'label'), 'utf8').trim() || undefined; } catch { /* unlabeled */ }
  if (SESSION_KEY) claimSessionKey(sessionsRoot, state, SESSION_KEY);
  Object.assign(PROJ, { path: p, id, state, sessionId, sessionLabel, sessionsRoot, resumed, resumedByKey, startedFromHost, hostAbsent, greenfield, dirs });
  // Live pointer for the host-side `review` CLI: which project + session
  // overlay the server is currently attached to. Best-effort; review falls
  // back to --project / most-recent-session when absent or stale.
  try {
    fs.writeFileSync(path.join(stateBase, 'current.json'), JSON.stringify({
      project: p, projectId: id, sessionId,
      label: sessionLabel || null,
      upper: dirs.upper, outbox: dirs.outbox,
      updatedAt: new Date().toISOString(),
    }, null, 2) + '\n');
  } catch { /* best effort */ }
  installGitWrapper();
  // Claim this overlay (so a sibling server's sweep never evicts it) and ask
  // for a budget sweep: attaching a new session is exactly when older ones
  // become garbage.
  touchSessionInUse();
  overlayUsageCache.delete(state);
  scheduleOverlayGc('open-project');
  if (typeof BACKEND !== 'undefined' && BACKEND) BACKEND.onProjectChanged();
}

// =============================================================================
// git wrapper — blocks push/send-pack inside the sandbox
// =============================================================================

function installGitWrapper() {
  const realGit = (spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' })
    .stdout || '/usr/bin/git').trim() || '/usr/bin/git';
  // Greenfield ships the WHOLE tree (no host base for a delta); existing repos
  // ship a delta. Plain "-quoted so $KOI_OUTBOX expands to the real path in the
  // printed hint (matches the surrounding double-quoted echo).
  const shipCmd = PROJ.greenfield
    ? 'SHA=$(git rev-parse --short HEAD); BR=$(git symbolic-ref --quiet --short HEAD) || { git checkout -B main; BR=main; }; rm -f "$KOI_OUTBOX"/project-*.bundle; git bundle create "$KOI_OUTBOX/project-$SHA.bundle" "$BR" HEAD'
    : 'git format-patch -o "$KOI_OUTBOX" <base>..HEAD';
  const wrapper = `#!/bin/sh
# Koi sandbox git wrapper: block network-write subcommands, hint on commit.
for a in "$@"; do
  case "$a" in
    --) break ;;
    stash) break ;; # 'git stash push' is local-only; stash never touches the network
    push|send-pack) echo "koi-sandbox: 'git $a' is blocked (no network writes from the sandbox). Ship with: ${shipCmd}" >&2; exit 1 ;;
  esac
done
# Ship hygiene, enforced rather than merely documented: an artifact carrying
# installed dependencies or build output is unreviewable (a 51MB bundle of
# node_modules was shipped this way) and the user cannot tell it from the
# real thing until it lands. Prompts leak; this does not.
case " $* " in
  *" bundle "*|*" format-patch "*)
    __koi_junk=$("${realGit}" ls-files 2>/dev/null | grep -E '(^|/)(node_modules|dist|build|target|\\.venv|__pycache__|\\.next)/' | head -n 3)
    if [ -n "$__koi_junk" ]; then
      echo "koi-sandbox: refusing to ship — tracked files include dependencies or build output, e.g.:" >&2
      echo "$__koi_junk" >&2
      echo "  Fix: write .gitignore, then  git rm -r --cached <dir> && git commit --amend" >&2
      exit 1
    fi ;;
esac
# Never let git daemonize inside the sandbox: detached gc / fsmonitor daemons
# inherit the exec's pipes, escape the timeout's group-kill, and hang the tool
# call. Repacking is pointless in an overlay anyway (gc.auto=0).
"${realGit}" -c gc.auto=0 -c gc.autoDetach=false -c maintenance.auto=false -c core.fsmonitor=false "$@"
rc=$?
case " $* " in
  *" commit "*)
    if [ $rc -eq 0 ] && [ -n "$KOI_OUTBOX" ]; then
      echo "koi-sandbox: commit recorded in the overlay only (host repo untouched). Ship when ready: ${shipCmd}" >&2
    fi ;;
esac
exit $rc
`;
  const p = path.join(PROJ.dirs.bin, 'git');
  fs.writeFileSync(p, wrapper, { mode: 0o755 });
}

// Initialize initial project scope from CLI
setProject(OPTS.project);

// =============================================================================
// Backends
// =============================================================================

const H = os.homedir();
// Credential/secret paths masked inside the sandbox.
//
// There is deliberately NO built-in list here. What counts as a secret is
// deployment policy, not server policy — it varies per host and per user — so
// the whole set is supplied by `--exclude` / KOI_SANDBOX_EXCLUDE, configured in
// the systemd unit (or gateway-config.json). The server only applies what it is
// given. Consequence: with no --exclude, NOTHING is masked; the unit installed
// by koi-gateway-installer carries the standard list.
//
// Directories are masked with a tmpfs and files with a /dev/null ro-bind. Each
// path is classified by what it actually is on disk, so callers pass paths
// without needing to know which mechanism applies.

/** Expand `~`, `$HOME`, and bare/relative names into absolute host paths. */
function expandMaskPath(spec) {
  let s = String(spec).trim();
  if (s === '') return null;
  s = s.replace(/^\$HOME(?=$|\/)/, H).replace(/^~(?=$|\/)/, H);
  return path.isAbsolute(s) ? path.normalize(s) : path.join(H, s);
}

/** Split a comma/newline-separated --exclude value into absolute paths. */
function parseExcludeList(spec) {
  return String(spec).split(/[,\n]/).map(expandMaskPath).filter((p) => p !== null);
}

/**
 * Resolve every --exclude / KOI_SANDBOX_EXCLUDE entry into the two masking
 * lists. Paths that don't exist on this host are skipped (a shared exclude list
 * is expected to name tools that aren't installed everywhere), so we summarise
 * rather than warn per path.
 */
function buildMaskLists() {
  const dirs = [], files = [], seen = new Set();
  let configured = 0, missing = 0;
  for (const spec of OPTS.exclude) {
    for (const p of parseExcludeList(spec)) {
      if (seen.has(p)) continue;
      seen.add(p);
      configured++;
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        missing++;
        continue;
      }
      (st.isDirectory() ? dirs : files).push(p);
    }
  }
  if (configured === 0) {
    process.stderr.write(
      '[sandbox-shell] WARNING: no --exclude given — NO credential masking is ' +
      'active. Host secrets (~/.ssh, ~/.aws, shell history, ...) are readable ' +
      'inside the sandbox. Set --exclude or KOI_SANDBOX_EXCLUDE in the unit.\n');
  } else {
    process.stderr.write(
      `[sandbox-shell] masking ${dirs.length + files.length} path(s) ` +
      `(${configured} configured, ${missing} not present on this host)\n`);
  }
  return { dirs, files };
}

const { dirs: CRED_DIRS, files: CRED_FILES } = buildMaskLists();


const SHELL_BIN = (() => {
  for (const candidate of ['/bin/bash', '/usr/bin/bash', '/bin/sh']) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return '/bin/sh';
})();

const BASE_ENV = {
  HOME: H,
  TERM: 'dumb',
  CI: '1',
  DEBIAN_FRONTEND: 'noninteractive',
  LANG: process.env.LANG || 'C.UTF-8',
  GIT_TERMINAL_PROMPT: '0',        // never hang on credential prompts
  GIT_ASKPASS: '/bin/true',
  KOI_SANDBOX: '1',
  // macOS/Seatbelt fallback: redirect cache dirs to writable tmpfs
  NPM_CONFIG_CACHE: '/tmp/koi/npm-cache',
  YARN_CACHE_FOLDER: '/tmp/koi/yarn-cache',
  PIP_CACHE_DIR: '/tmp/koi/pip-cache',
};

/** Keep wrapper dir first, then host PATH (fnm/nvm/volta/...). */
function composeSandboxPath(wrapperPrefix) {
  const host = process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const parts = host.split(path.delimiter).filter(Boolean).filter((p) => p !== wrapperPrefix);
  return [wrapperPrefix, ...parts].join(path.delimiter);
}

// Where a greenfield (host-absent) project is mounted inside the sandbox. It
// lives under the /tmp tmpfs so bwrap can create the mountpoint — bwrap cannot
// mkdir a new leaf under the read-only host bind, which is why a non-existent
// host path can't be mounted at its real location without first creating it on
// the host (the thing we are deliberately avoiding).
const GREENFIELD_MOUNT = '/tmp/koi/project';

// Second, independent spelling of the outbox inside the sandbox (bwrap only).
// It lives under our own /tmp tmpfs, so unlike the host-path bind it cannot be
// shadowed by a credential mask no matter what --exclude contains. Kept as a
// compatibility alias, and used as the automatic fallback when the delivery
// self-check finds the host-path spelling unreachable.
const OUTBOX_ALIAS_INSIDE = '/tmp/koi/outbox';

// Host paths, used as-is inside the sandbox: the whole host tree is ro-bound at
// /, so the scripts shipped next to this server are visible at their real path.
const NET_SETUP = path.join(SELF_DIR, 'koi-net-setup.sh');
const PASTA_BIN = process.env.KOI_PASTA_BIN || 'pasta';

// Does this pasta forward host-loopback connections to the namespace's
// LOOPBACK, or to its interface address?
//
// `-t auto` republishes ports the namespace binds onto host loopback, which is
// what makes a sandbox dev server reachable from the browser. Newer passt
// changed where those forwarded connections land: they now arrive on the
// namespace's interface address rather than 127.0.0.1, so a dev server bound to
// 127.0.0.1 inside (the default for Vite, Next, Rails, Flask, and most others)
// never sees them. The port looks published from the host and the connection
// dies at the last hop.
//
// The same release that changed the default added --host-lo-to-ns-lo to restore
// it, so the flag's EXISTENCE is the version test: if pasta knows the option,
// it has the new default and we want the old behaviour. Older builds neither
// need it nor accept it, and passing an unknown flag makes pasta exit — hence
// probing rather than assuming. Probed once; `pasta --help` is cheap but this
// runs on every exec and every service start.
//
// Set KOI_PASTA_HOST_LO=0 to opt out (or 1 to force it on).
const PASTA_HOST_LO_FLAG = '--host-lo-to-ns-lo';

// Does this host need pasta pinned to IPv4?
//
// On WSL2 in NAT mode, a dev server published by `-t auto` is reachable at the
// distro's eth0 address but NOT at localhost, and the failure is silent in a
// confusing way: Windows gets "empty reply" on ::1 and "could not connect" on
// 127.0.0.1 for the same port.
//
// Two IPv6 facts compose into that. First, pasta's host-side socket is
// dual-stack (`ss` shows `*:8123`), and a dual-stack listener appears ONLY in
// /proc/net/tcp6, never in /proc/net/tcp. WSL's localhost relay discovers
// ports by reading those two tables, so it published the port on IPv6 alone —
// hence connect-refused on 127.0.0.1. Second, pasta preserves the connection's
// address family into the namespace, so the IPv6 half that DID get published
// arrives as ::1 inside, where a dev server bound to 127.0.0.1 is not
// listening: pasta accepts, finds nothing, and closes with no bytes. That is
// the "empty reply", and it is what the browser hits, because Windows resolves
// localhost to ::1 first.
//
// `-4` collapses both: the host socket lands in /proc/net/tcp where the relay
// can see it, and the forwarded connection stays IPv4 all the way to an IPv4
// server. Scoped to WSL-in-NAT because it is a workaround for that relay's
// discovery, not a general improvement — mirrored networking shares Windows'
// loopback and does not need it, and on Linux/macOS it would only strip IPv6
// for no reason.
//
// Egress is unaffected: in policy mode everything outbound goes to squid at the
// namespace's IPv4 gateway address (koi-net-setup.sh), which `-4` leaves alone.
//
// Set KOI_PASTA_IPV4=0 to opt out (or 1 to force it on).
const PASTA_IPV4_FLAG = '-4';

const pastaNeedsIpv4Only = (() => {
  let cached = null;
  return () => {
    if (cached !== null) return cached;
    const override = process.env.KOI_PASTA_IPV4;
    if (override === '0') return (cached = false);
    if (override === '1') return (cached = true);
    let isWsl = !!process.env.WSL_DISTRO_NAME || !!process.env.WSL_INTEROP;
    if (!isWsl) {
      try { isWsl = /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { /* not WSL */ }
    }
    // Mirrored networking shares the Windows loopback outright, so the relay
    // (and its /proc table scan) is not in the path at all. Its marker is the
    // synthetic loopback0 interface, which NAT mode does not have.
    const mirrored = fs.existsSync('/sys/class/net/loopback0');
    return (cached = isWsl && !mirrored);
  };
})();

const pastaSupportsHostLo = (() => {
  let cached = null;
  return () => {
    if (cached !== null) return cached;
    const override = process.env.KOI_PASTA_HOST_LO;
    if (override === '0') return (cached = false);
    if (override === '1') return (cached = true);
    try {
      const r = spawnSync(PASTA_BIN, ['--help'], { encoding: 'utf8', timeout: 5000 });
      cached = `${r.stdout || ''}${r.stderr || ''}`.includes(PASTA_HOST_LO_FLAG);
    } catch {
      cached = false;
    }
    return cached;
  };
})();

function findBwrapBin() {
  if (process.env.KOI_BWRAP_BIN) return process.env.KOI_BWRAP_BIN;
  for (const c of ['/usr/local/bin/bwrap', 'bwrap', '/usr/bin/bwrap']) {
    try {
      const probe = spawnSync(c, ['--help'], { encoding: 'utf8' });
      if (!probe.error && ((probe.stdout || '') + (probe.stderr || '')).includes('--overlay-src')) {
        return c;
      }
    } catch { /* continue */ }
  }
  return 'bwrap';
}

class BwrapBackend {
  constructor() {
    this.bwrapBin = findBwrapBin();
    this.name = 'bwrap-overlay';
    this.onProjectChanged();
    const probe = spawnSync(this.bwrapBin, ['--version'], { encoding: 'utf8' });
    if (probe.error) {
      throw new Error(
        "bubblewrap not found. Please install bubblewrap (>= 0.11.0).\n" +
        "Note: Ubuntu/Debian apt repositories often ship older versions (< 0.11.0).\n" +
        "To build and install bwrap 0.11.0+ from source:\n" +
        "  sudo apt install -y meson ninja-build libcap-dev\n" +
        "  git clone https://github.com/containers/bubblewrap.git\n" +
        "  cd bubblewrap && meson setup _build && meson compile -C _build && sudo meson install -C _build"
      );
    }

    const helpProbe = spawnSync(this.bwrapBin, ['--help'], { encoding: 'utf8' });
    const helpOut = (helpProbe.stdout || '') + (helpProbe.stderr || '');
    if (!helpOut.includes('--overlay-src')) {
      const ver = (probe.stdout || '').trim();
      throw new Error(
        `bubblewrap version is too old (${ver || 'unknown'} at ${this.bwrapBin}).\n` +
        "The sandbox requires bubblewrap >= 0.11.0 for overlayfs support (--overlay-src / --overlay).\n" +
        "Default distro packages (e.g. Ubuntu 22.04 / 24.04) ship older versions without this feature.\n" +
        "To build and install bwrap 0.11.0+ from source:\n" +
        "  sudo apt install -y meson ninja-build libcap-dev\n" +
        "  git clone https://github.com/containers/bubblewrap.git\n" +
        "  cd bubblewrap && meson setup _build && meson compile -C _build && sudo meson install -C _build"
      );
    }

    const permProbe = spawnSync(this.bwrapBin, ['--ro-bind', '/', '/', 'true'], { encoding: 'utf8' });
    if (permProbe.status !== 0) {
      const permErr = (permProbe.stderr || '') + (permProbe.stdout || '');
      if (/uid_map|user mappings|Operation not permitted|permission denied/i.test(permErr)) {
        throw new Error(
          "bubblewrap cannot create user namespaces (Operation not permitted).\n" +
          "On Ubuntu 24.04 (due to AppArmor unprivileged-userns restrictions), run:\n" +
          "  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\n" +
          "To make it permanent, add it to /etc/sysctl.d/99-userns.conf\n" +
          "On Debian or other distros, run:\n" +
          "  sudo sysctl -w kernel.unprivileged_userns_clone=1\n" +
          "Or grant setuid permissions:\n" +
          "  sudo chmod u+s $(which bwrap)"
        );
      }
      throw new Error(`bubblewrap preflight probe failed (exit code ${permProbe.status}):\n${permErr}`);
    }
  }

  onProjectChanged() {
    // Greenfield: mount at a sandbox-internal path (empty lower); the real host
    // path does not exist and is never created here.
    this.root = PROJ.hostAbsent ? GREENFIELD_MOUNT : PROJ.path;
    // The outbox is visible at its OWN host path, so $KOI_OUTBOX, the paths
    // `git format-patch` prints, and the path the user is told to open are the
    // same string. This used to be /tmp/koi/outbox, which meant every export
    // printed a path that does not exist on the host, one line away from
    // sandbox_info.outbox which does — and a session quoting the first path it
    // saw handed the user a location holding nothing. The other two backends
    // (seatbelt, exec) already report the host path here; this makes bwrap
    // agree with them instead of being the one that needs a translation rule.
    this.outboxInside = PROJ.dirs.outbox;
  }

  /** Build the argv that runs `shCmd` inside the sandbox. */
  wrap(shCmd, { cwd } = {}) {
    const argv = [this.bwrapBin,
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--tmpfs', '/run',
      // Overlay: read-write view of the project, backed by upper/work on the
      // host. Greenfield uses an EMPTY scratch lower and a sandbox-internal dest
      // (this.root) so the host tree is never required to exist — nor created.
      '--overlay-src', PROJ.hostAbsent ? PROJ.dirs.lower : PROJ.path,
      '--overlay', PROJ.dirs.upper, PROJ.dirs.work, this.root,
      // Tool wrappers first on PATH. NOTE: mountpoints must live under a
      // writable mount — the ro-bound root cannot grow new directories, so
      // /koi/bin would fail with "Can't mkdir parents". /tmp is our tmpfs.
      '--ro-bind', PROJ.dirs.bin, '/tmp/koi/bin',
      '--unshare-pid',
      '--die-with-parent',
    ];

    // MASKS BEFORE BINDS — this order is load-bearing, not cosmetic.
    //
    // bwrap applies operations in argv order, and a mount placed over a
    // directory SHADOWS every mount already inside it. The outbox lives at
    // <state>/<project>/outbox, state defaults to ~/.koi/sandbox, and ~/.koi is
    // on the credential mask list (it holds gateway-config.json and, under
    // --net policy, network-policy.json). So binding the outbox first and
    // masking ~/.koi second buried the bind under the mask's tmpfs: the bind
    // still existed — it is visible in /proc/mounts, which made this look
    // healthy — but nothing could reach it through the path.
    //
    // The failure was silent and total. `git format-patch -o "$KOI_OUTBOX"`
    // mkdir -p'd its output directory inside the tmpfs, wrote the patch,
    // printed host-looking paths and exited 0; `ls "$KOI_OUTBOX"` from inside
    // then listed the file at full size. Every signal a session can observe
    // said "delivered" while the host outbox stayed empty, and the tmpfs died
    // with the exec. Sessions reported shipped patches that never existed.
    //
    // Emitting the masks first and re-binding the outbox afterwards inverts
    // that: the tmpfs goes down over ~/.koi, then the outbox is mounted on top
    // of it. Bind SOURCES resolve through bwrap's saved oldroot, so masking the
    // destination-side path does not hide the source, and the destination's
    // parents are mkdir'd in the (writable) tmpfs — the same mechanism that
    // already lets /tmp/koi/bin exist under the tmpfs at /tmp. Everything else
    // under ~/.koi stays masked; only the one leaf is carved back out.
    for (const d of CRED_DIRS) argv.push('--tmpfs', d);
    for (const f of CRED_FILES) argv.push('--ro-bind', '/dev/null', f);

    // Outbox stays host-writable so exports survive. Bound at its own host
    // path: the directory always exists by now (setProject creates it and
    // ensureSessionDirs re-creates it ahead of every exec and service), so
    // bwrap has a mountpoint even though the root is a ro-bind that cannot
    // grow new leaves. The /tmp/koi/outbox spelling is kept as an alias so a
    // session resumed mid-task, holding the old path from an earlier turn,
    // does not start failing on it; it is also the fallback the delivery
    // self-check switches to if the host-path spelling is ever unreachable
    // again, since /tmp is our own tmpfs and no mask entry can shadow it.
    argv.push('--bind', PROJ.dirs.outbox, PROJ.dirs.outbox);
    argv.push('--bind', PROJ.dirs.outbox, OUTBOX_ALIAS_INSIDE);

    // ...AND THEN SEAL THE MASK. The bind above carves out exactly ONE leaf:
    // the outbox of the project that is open RIGHT NOW. Everything else under a
    // masked dir is still the mask's own tmpfs -- and a tmpfs is WRITABLE.
    //
    // That turned every *wrong* outbox path into silent data loss with the exact
    // signature of the mount-ordering bug fixed above:
    //
    //   git format-patch -o <state>/<stale-hash>/outbox ...
    //     -> mkdir -p succeeds (tmpfs), the write succeeds, exit 0,
    //        host-looking paths are printed, `ls` shows the patch at full
    //        size -- and it evaporates when the exec's namespace dies.
    //
    // A wrong path is not hypothetical: the outbox is keyed by a hash of the
    // project path, so it CHANGES under a session at sandbox_open_project (the
    // projectless $HOME-scoped outbox is a different directory) and again on
    // resume. A session quoting a path it read one turn too early hits exactly
    // this, and every signal it can observe says "delivered".
    //
    // Remounting the mask read-only makes that failure LOUD: a stale path now
    // fails with EROFS at mkdir/open instead of succeeding into a void. The
    // nested outbox bind keeps its own mount flags, so the real outbox stays
    // writable, and masked content stays just as hidden (the tmpfs is empty
    // either way). Nothing inside the sandbox legitimately writes under these
    // dirs: koi-net-setup.sh's in-sandbox `confine` path only installs nft
    // rules and exports proxy vars, while `proxy` -- which does write
    // <mask>/squid -- runs on the host, outside this namespace.
    for (const d of CRED_DIRS) argv.push('--remount-ro', d);

    // Make common global caches writable but ephemeral to fix EROFS during installs
    const CACHE_DIRS = ['.npm', '.cargo/registry', '.cache/pip', '.cache/yarn', '.local/share/pnpm', '.gradle/caches'];
    for (const d of CACHE_DIRS) {
      const hostPath = path.join(H, d);
      if (fs.existsSync(hostPath)) {
        argv.push('--overlay-src', hostPath, '--tmp-overlay', hostPath);
      }
    }

    // Egress modes:
    //   loopback  own netns with only lo — no network at all.
    //   policy    pasta OWNS the netns (see below), so bwrap must NOT unshare
    //             it here; the filtering happens inside via koi-net-setup.sh.
    //   host      unchanged: the host's network namespace.
    if (OPTS.net === 'loopback') argv.push('--unshare-net'); // lo only, fully offline
    argv.push('--clearenv');
    const env = {
      ...BASE_ENV,
      PATH: composeSandboxPath('/tmp/koi/bin'),
      KOI_OUTBOX: this.outboxInside, // git format-patch -o "$KOI_OUTBOX" lands on the host
      ...(OPTS.net === 'policy' ? { KOI_PROXY_PORT: String(OPTS.proxyPort) } : {}),
    };
    for (const [k, v] of Object.entries(env)) argv.push('--setenv', k, String(v));
    argv.push('--chdir', cwd || this.root);
    if (OPTS.net === 'policy') {
      // koi-net-setup.sh installs the nftables egress filter inside the
      // namespace and exports HTTPS_PROXY, then execs the real command. It
      // refuses to exec if the filter cannot be installed, so a command never
      // runs believing it is confined when it is not.
      argv.push(NET_SETUP, 'confine', '--', SHELL_BIN, '-c', shCmd);
    } else {
      argv.push(SHELL_BIN, '-c', shCmd);
    }
    if (OPTS.net === 'policy') {
      // pasta creates the network namespace, gives it usermode networking, and
      // (`-t auto`) republishes ports the namespace binds onto host loopback —
      // which is how dev servers stay reachable from the browser without
      // handing the sandbox the host's own network stack. --host-lo-to-ns-lo,
      // where supported, keeps those forwarded connections landing on the
      // namespace's loopback, so a server bound to 127.0.0.1 inside is
      // reachable without being told to bind 0.0.0.0.
      const pasta = [PASTA_BIN, '--config-net', '-t', 'auto',
        ...(pastaSupportsHostLo() ? [PASTA_HOST_LO_FLAG] : []),
        ...(pastaNeedsIpv4Only() ? [PASTA_IPV4_FLAG] : []),
        '-q', '--'];
      return { cmd: pasta[0], args: [...pasta.slice(1), ...argv], spawnEnv: process.env };
    }
    return { cmd: argv[0], args: argv.slice(1), spawnEnv: process.env };
  }

  reset() {
    rmrf(PROJ.dirs.upper);
    rmrf(PROJ.dirs.work);
    fs.mkdirSync(PROJ.dirs.upper, { recursive: true });
    fs.mkdirSync(PROJ.dirs.work, { recursive: true });
  }
}

class SeatbeltBackend {
  constructor() {
    this.name = 'seatbelt-clone';
    this.onProjectChanged();
  }

  onProjectChanged() {
    this.root = PROJ.dirs.workspace;
    this.outboxInside = PROJ.dirs.outbox; // host path; writable per seatbelt profile
    this.ensureWorkspace();
    this.profile = path.join(PROJ.state, 'sandbox.sb');
    // macOS has no netns, so the proxy runs on host loopback and seatbelt just
    // narrows outbound to it. Same policy engine, same dialog; only the
    // enforcement primitive differs.
    const netRules = OPTS.net === 'loopback'
      ? `(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))`
      : OPTS.net === 'policy'
        ? `(deny network-outbound)\n(allow network-outbound (remote ip "localhost:${OPTS.proxyPort}"))`
        : '';
    // Credential masking. On Linux these paths are replaced with a tmpfs or a
    // /dev/null bind, so they are ABSENT. Seatbelt cannot swap a mount, but it
    // can refuse the read — and it must, because `(allow default)` above
    // permits file-read* everywhere. Without this a macOS session reads
    // ~/.ssh/id_ed25519 and ~/.aws/credentials as easily as any other file,
    // while sandbox_info cheerfully reported them as "masked".
    //
    // SBPL is LAST-match-wins, so these denies must come after (allow default)
    // to take effect. Paths are realpath'd: subpath matches literally, and
    // /tmp -> /private/tmp (etc.) would otherwise silently match nothing.
    // `subpath` covers a directory tree; a single file needs `literal`. Using
    // subpath on a file matches nothing, which would have left ~/.netrc,
    // ~/.npmrc and the other credential FILES readable while looking masked.
    const rp = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const maskRules = [
      ...CRED_DIRS.map((p) => `  (subpath ${JSON.stringify(rp(p))})`),
      ...CRED_FILES.map((p) => `  (literal ${JSON.stringify(rp(p))})`),
    ].join('\n');
    const credRules = maskRules === ''
      ? ''
      : `(deny file-read* file-write*\n${maskRules})`;

    // SBPL is last-match-wins, and the sandbox's own state (workspace, outbox,
    // git wrapper) lives UNDER ~/.koi, which the standard exclude list masks.
    // With the deny emitted last it therefore overrode the write allowances it
    // was never meant to touch — the Linux twin of the bind-shadowing bug, and
    // worse here, because the deny covers file-read* too: the CoW workspace
    // clone and the outbox both became unreadable and unwritable, so the mac
    // backend could neither work nor ship. Order is now: blanket deny, masks,
    // then the state carve-out, so the narrower, deliberate rule wins.
    fs.writeFileSync(this.profile, `(version 1)
(allow default)
(deny file-write*)
${credRules}
(allow file-read* file-write*
  (subpath "${PROJ.state}")
  (subpath "${PROJ.dirs.workspace}")
  (subpath "${PROJ.dirs.outbox}"))
(allow file-write*
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (subpath "/dev"))
${netRules}
`);
  }

  ensureWorkspace() {
    if (PROJ.path === os.homedir()) {
      // Projectless boot: cloning all of $HOME would be enormous. Defer until
      // a real project is opened via sandbox_open_project.
      log('seatbelt: projectless ($HOME) — workspace clone deferred until sandbox_open_project');
      return;
    }
    if (PROJ.hostAbsent) {
      // Greenfield: nothing on the host to clone. The new project starts empty
      // in the workspace and ships whole with git bundle -> git clone. The host
      // path is never created here.
      return;
    }
    if (fs.readdirSync(PROJ.dirs.workspace).length > 0) {
      this.ensureGitAlternates();
      return;
    }
    // APFS clonefile: instant copy-on-write clone; fall back to plain copy.
    const clone = spawnSync('cp', ['-cR', PROJ.path + '/.', PROJ.dirs.workspace]);
    if (clone.status !== 0) spawnSync('cp', ['-R', PROJ.path + '/.', PROJ.dirs.workspace]);
    this.ensureGitAlternates();
  }

  ensureGitAlternates() {
    if (!PROJ.dirs?.workspace || !PROJ.path) return;
    const hostGitObjects = path.join(PROJ.path, '.git', 'objects');
    if (!fs.existsSync(hostGitObjects)) return;
    try {
      const altDir = path.join(PROJ.dirs.workspace, '.git', 'objects', 'info');
      const altFile = path.join(altDir, 'alternates');
      fs.mkdirSync(altDir, { recursive: true });
      if (!fs.existsSync(altFile) || fs.readFileSync(altFile, 'utf8').trim() !== hostGitObjects) {
        fs.writeFileSync(altFile, hostGitObjects + '\n');
      }
    } catch { /* best effort */ }
  }

  wrap(shCmd, { cwd } = {}) {
    const env = {
      ...BASE_ENV,
      PATH: `${PROJ.dirs.bin}:` + (process.env.PATH || '/usr/local/bin:/usr/bin:/bin'),
      KOI_OUTBOX: this.outboxInside,
    };
    // Mask credentials by pointing tools at empty config where env allows.
    env.GIT_SSH_COMMAND = 'false'; // ssh-based fetch/push both blocked on mac backend
    if (OPTS.net === 'policy') {
      const proxy = `http://127.0.0.1:${OPTS.proxyPort}`;
      Object.assign(env, {
        HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
      });
    }
    return {
      cmd: 'sandbox-exec',
      args: ['-f', this.profile, SHELL_BIN, '-c', `cd ${JSON.stringify(cwd || this.root)} && ${shCmd}`],
      spawnEnv: env,
    };
  }

  reset() {
    rmrf(PROJ.dirs.workspace);
    fs.mkdirSync(PROJ.dirs.workspace, { recursive: true });
    this.ensureWorkspace();
  }
}

class ExecBackend { // DEV/TEST ONLY — no isolation
  constructor() {
    this.name = 'exec-UNSAFE';
    this.onProjectChanged();
    log('WARNING: exec backend has NO isolation. Dev/test only.');
  }
  onProjectChanged() {
    // Greenfield has no host dir; the (unisolated) exec backend works in a
    // scratch dir under state instead of creating anything on the host.
    if (PROJ.hostAbsent) fs.mkdirSync(PROJ.dirs.workspace, { recursive: true });
    this.root = PROJ.hostAbsent ? PROJ.dirs.workspace : PROJ.path;
    this.outboxInside = PROJ.dirs.outbox;
  }
  wrap(shCmd, { cwd } = {}) {
    return {
      cmd: SHELL_BIN,
      args: ['-c', `cd ${JSON.stringify(cwd || this.root)} && ${shCmd}`],
      spawnEnv: { ...process.env, ...BASE_ENV, PATH: `${PROJ.dirs.bin}:${process.env.PATH}`, KOI_OUTBOX: this.outboxInside },
    };
  }
  reset() {}
}

function pickBackend() {
  if (process.env.KOI_SANDBOX_BACKEND === 'exec') return new ExecBackend();
  if (process.platform === 'darwin') return new SeatbeltBackend();
  return new BwrapBackend();
}
BACKEND = pickBackend();
log(`backend=${BACKEND.name} project=${PROJ.path} net=${OPTS.net} state=${PROJ.state} overlayCap=${formatBytes(MAX_OVERLAY_BYTES)}`);

// =============================================================================
// Network approval bridge (--net policy)
// -----------------------------------------------------------------------------
// The Squid ACL helper decides everything it can from the policy file. When the
// policy says "ask" it opens the broker socket below, and this server turns
// that into an MCP `elicitation/create` request on the live client connection —
// i.e. the side panel's existing confirmation dialog.
//
// Nothing here enforces anything. If this bridge is down, the helper's ask
// fails and the request is DENIED; the sandbox does not fall open.
// =============================================================================

/** Server-initiated JSON-RPC requests, keyed by id, awaiting a client reply. */
const outbound = new Map();
let outboundSeq = 0;

/**
 * Ask the connected client something. String ids ("koi-net-N") so they can
 * never collide with the client's own numeric ids on the shared channel.
 */
function sendServerRequest(method, params, timeoutMs = 330_000) {
  const id = `koi-net-${++outboundSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      outbound.delete(id);
      reject(new Error(`no answer to ${method} within ${timeoutMs}ms`));
    }, timeoutMs);
    outbound.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || 'client error'));
      else resolve(msg.result);
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

let NET_BROKER = null;

/**
 * Whether the connected client said it can prompt the user (MCP `elicitation`
 * capability, sent on initialize). Without it there is nobody to ask, so an
 * "ask" verdict is a denial — and saying so immediately is much better than
 * parking a real connection for five minutes first while a build times out.
 */
let CLIENT_CAN_PROMPT = false;

if (OPTS.net === 'policy') {
  try {
    ensurePolicy(OPTS.netPolicy, OPTS.netAllow);
  } catch (e) {
    log(`WARNING: could not seed network policy ${OPTS.netPolicy}: ${e.message}`);
  }
  NET_BROKER = new ApprovalBroker({
    socketPath: OPTS.netSock,
    log,
    asker: async (req) => {
      if (!CLIENT_CAN_PROMPT) {
        return {
          decision: 'deny',
          scope: 'once',
          reason: 'no client able to prompt the user (unattended run, or a client that did not declare the MCP elicitation capability)',
        };
      }
      const summary = req.method === 'CONNECT' || !req.method
        ? `${req.host}:${req.port}`
        : `${req.method} ${req.host}:${req.port}`;
      const result = await sendServerRequest('elicitation/create', {
        message: `The sandbox wants to connect to ${summary}.`,
        requestedSchema: {
          type: 'object',
          properties: {
            decision: { type: 'string', enum: ['allow', 'deny'] },
            scope: { type: 'string', enum: ['once', 'session', 'always'] },
          },
          required: ['decision', 'scope'],
        },
        // Structured payload for the network dialog. Clients that only know
        // generic elicitation still render `message` and can answer.
        'koi/network': {
          host: req.host,
          port: req.port,
          method: req.method || null,
          uri: req.uri || null,
          project: PROJ.path,
          session: PROJ.sessionId,
          // Honest about what the proxy can and cannot see: over TLS it gets
          // CONNECT host:port and nothing else, so a pull/push choice here
          // would be unenforceable.
          directionKnown: Boolean(req.method) && req.method !== 'CONNECT',
        },
      });
      const content = result?.content ?? result ?? {};
      if (result?.action === 'decline' || result?.action === 'cancel') {
        return { decision: 'deny', scope: 'once', reason: 'user declined' };
      }
      return {
        decision: content.decision === 'allow' ? 'allow' : 'deny',
        scope: content.scope || 'once',
      };
    },
  }).start();
}

// =============================================================================
// Overlay -> host reconciliation
// -----------------------------------------------------------------------------
// Code intelligence is no longer an MCP surface. The server used to spawn the
// compiled lsp_search bundle as a child and re-export its tools (search,
// get_references, get_hover, get_implementation, get_file_structure,
// get_lsp_diagnostics, search_ast, read_ast_node) through this endpoint. That
// duplicated navigation the session can perform for itself: the language
// servers, ast-grep and ripgrep are all on the host PATH, so the LLM reaches
// them the same way it reaches every other tool — as a shell command through
// sandbox_exec, reading through the overlay and therefore seeing its own
// unshipped edits with no buffer-sync protocol in between.
//
// What survives is the part the shell cannot do for itself: keeping the
// overlay's copy of a file from going stale when the HOST changes underneath
// it. That reconciliation runs at the head of sandbox_exec and on demand via
// overlay_fs_sync.
// =============================================================================

const RESYNC_SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'build', 'out', '.next', '.cache', '__pycache__', 'vendor']);
const RESYNC_MAX_FILES = 300;

/**
 * Overwrite an overlay file with the host's newer version.
 *
 * git creates loose objects and packfiles read-only (0444), so a plain
 * copyFileSync onto an existing one fails with EACCES for every user except
 * root — root bypasses the mode bit, which is why this reproduces on a normal
 * account and not under a privileged container. Unlink and retry, then carry
 * the host's mode across so the overlay copy keeps the same permissions.
 */
function copyHostFileOverUpper(hostFile, upperFile, mode) {
  try {
    fs.copyFileSync(hostFile, upperFile);
  } catch (e) {
    if (e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
    // The upperdir is ours and tool calls are serialized, so replacing the
    // file wholesale is safe. Note this touches the upperdir directly, NOT
    // the overlay mount, so no whiteout is created by the unlink.
    fs.unlinkSync(upperFile);
    fs.copyFileSync(hostFile, upperFile);
  }
  if (mode !== undefined) {
    try { fs.chmodSync(upperFile, mode & 0o7777); } catch { /* best effort */ }
  }
}

// Where reconciliation keeps what it would otherwise overwrite. Both live under
// the overlay's .git so the session can read them through its own tree and
// `git status` never shows them. The walk must not descend into either.
const PRESERVE_DIR = 'koi-preserved';
const PRESERVE_SKIP_RELS = new Set([
  path.join('.git', PRESERVE_DIR),
  path.join('.git', 'refs', PRESERVE_DIR),
]);

function isGitMetaPath(rel) {
  return rel === '.git' || rel.startsWith('.git' + path.sep);
}

// -- sync manifest ------------------------------------------------------------
// "host mtime newer than the overlay copy" cannot tell a host change from an
// overlay change, cannot see a host write that carries an older mtime (rsync -t,
// tar x), and cannot notice host deletions. So every time reconciliation writes
// a file into the overlay it records the host stat (mtime, ctime, size, inode)
// and the resulting overlay stat. Next time:
//   host stat unchanged              -> the host did not change; skip
//   overlay stat unchanged           -> nothing in the overlay to lose
//   both changed and contents differ -> a real conflict: preserve, then refresh
// Files the overlay copied up on its own (the session edited them) have no
// record; for those the old mtime rule decides, and anything that differs is
// treated as session work.

function syncManifestPath() {
  return PROJ.state ? path.join(PROJ.state, 'sync-manifest.json') : null;
}

function loadSyncManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(syncManifestPath(), 'utf8'));
    if (m && typeof m === 'object' && m.files && typeof m.files === 'object') return m;
  } catch { /* absent or corrupt: start over */ }
  return { v: 1, files: {} };
}

function saveSyncManifest(m) {
  const p = syncManifestPath();
  if (!p) return;
  try {
    fs.writeFileSync(p + '.tmp', JSON.stringify(m));
    fs.renameSync(p + '.tmp', p);
  } catch (e) {
    log(`reconcile: could not save sync manifest: ${e.message}`);
  }
}

function hostStamp(st) {
  return { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino };
}

function sameHostStamp(a, b) {
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size && a.ino === b.ino;
}

function recordSync(manifest, rel, hostStat, upperFile) {
  try {
    const up = fs.statSync(upperFile);
    manifest.files[rel] = { host: hostStamp(hostStat), upper: { mtimeMs: up.mtimeMs, size: up.size } };
  } catch { delete manifest.files[rel]; }
}

// -- preservation helpers -----------------------------------------------------

function filesEqual(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

/**
 * Is this object already stored by git? `includeOverlay` also accepts loose
 * objects the session wrote into the overlay's object store. An answer of
 * false only ever causes an extra preserved copy, never a lost one — so a
 * SHA-256 repo, a packed overlay store or a missing git binary all fail safe.
 */
function gitObjectKnown(sha, { type = null, includeOverlay = false } = {}) {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return false;
  const upperDir = projectTreeHostPath();
  if (includeOverlay && upperDir &&
      fs.existsSync(path.join(upperDir, '.git', 'objects', sha.slice(0, 2), sha.slice(2)))) {
    return true;
  }
  const r = spawnSync('git', ['-C', PROJ.path, 'cat-file', '-e', type ? `${sha}^{${type}}` : sha],
    { stdio: 'ignore', timeout: 5000 });
  return r.status === 0;
}

function gitBlobSha1(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

function preserveStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Copy the overlay's version of `rel` aside before the host version replaces it. */
function preserveOverlayFile(rel, upperFile, stamp) {
  const upperDir = projectTreeHostPath();
  const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
  // A worktree/submodule `.git` FILE cannot hold a subdirectory; fall back to
  // the session state dir (host-visible, possibly not readable in the sandbox).
  const gitDirUsable = isDir(path.join(PROJ.path, '.git')) || isDir(path.join(upperDir, '.git'));
  const relPosix = rel.split(path.sep).join('/');
  const hostDest = gitDirUsable
    ? path.join(upperDir, '.git', PRESERVE_DIR, stamp, rel)
    : path.join(PROJ.state, 'preserved', stamp, rel);
  fs.mkdirSync(path.dirname(hostDest), { recursive: true });
  fs.copyFileSync(upperFile, hostDest);
  return {
    path: relPosix,
    // What the session can open: inside the sandbox tree when possible.
    savedTo: gitDirUsable ? path.posix.join(BACKEND.root, '.git', PRESERVE_DIR, stamp, relPosix) : hostDest,
  };
}

/**
 * Before the host's branch ref replaces the overlay's, keep the overlay tip
 * reachable if the host does not have that commit (unexported work, or work
 * the user applied under a different sha). A ref, not a copy: `git log <ref>`.
 */
function preserveOverlayRef(rel, upperFile, hostFile, stamp) {
  const headsPrefix = path.join('.git', 'refs', 'heads') + path.sep;
  if (!rel.startsWith(headsPrefix)) return null;
  let overlaySha, hostSha;
  try {
    overlaySha = fs.readFileSync(upperFile, 'utf8').trim();
    hostSha = fs.readFileSync(hostFile, 'utf8').trim();
  } catch { return null; }
  if (!overlaySha || overlaySha === hostSha) return null;
  if (gitObjectKnown(overlaySha, { type: 'commit' })) return null;
  const branch = rel.slice(headsPrefix.length).split(path.sep).join('/');
  const refRel = `refs/${PRESERVE_DIR}/${stamp}/${branch}`;
  const dest = path.join(projectTreeHostPath(), '.git', ...refRel.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, overlaySha + '\n');
  return { branch, sha: overlaySha, ref: refRel };
}

/**
 * Reconcile lower layer (host) mutations to the upper layer (overlay).
 * Fast, synchronous local check run before mutating tool handlers.
 *
 * Only files present in the overlay are considered: a host file with no
 * overlay copy is not shadowed, so overlayfs already shows it through the
 * lower layer. The sandbox view follows the host — when both sides changed a
 * file, the host version is installed — but the overlay's version is never
 * dropped silently: uncommitted content is copied aside and overlay-only
 * commits keep a ref. Everything done is returned so the caller can report it.
 *
 * Never throws. This runs at the head of sandbox_exec, where an exception would
 * surface as the shell command itself failing — a maintenance step must not be
 * able to take out the tool call it precedes.
 */
function reconcileLowerToUpper() {
  const hostRoot = PROJ.path;
  const upperDir = projectTreeHostPath();
  const result = { reconciled: 0, files: [], failures: [], preserved: [], preservedRefs: [], removed: [], truncated: false };
  if (!hostRoot || !upperDir || !fs.existsSync(hostRoot) || !fs.existsSync(upperDir)) {
    return result;
  }
  if (process.platform === 'darwin' && typeof BACKEND !== 'undefined' && BACKEND?.ensureGitAlternates) {
    BACKEND.ensureGitAlternates();
  }
  const { files, failures, preserved, preservedRefs, removed } = result;
  const manifest = loadSyncManifest();
  let manifestDirty = false;
  const stamp = preserveStamp();
  const seen = new Set();
  try {
    const walked = collectOverlayFiles(upperDir);
    result.truncated = walked.length >= RESYNC_MAX_FILES;
    for (const rel of walked) {
      seen.add(rel);
      const hostFile = path.join(hostRoot, rel);
      const upperFile = path.join(upperDir, rel);
      try {
        const upperStat = fs.statSync(upperFile);
        const entry = manifest.files[rel];
        const rec = entry && entry.host && entry.upper ? entry : undefined;
        const overlayChanged = !rec || upperStat.mtimeMs !== rec.upper.mtimeMs || upperStat.size !== rec.upper.size;

        let hostStat = null;
        try { hostStat = fs.statSync(hostFile); }
        catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }

        if (!hostStat) {
          // Deleted on the host. Propagate only a copy this function installed
          // and the session has not touched since; anything else is session work.
          if (rec && !overlayChanged) {
            fs.unlinkSync(upperFile);
            delete manifest.files[rel];
            manifestDirty = true;
            removed.push(rel.split(path.sep).join('/'));
          }
          continue;
        }
        if (!hostStat.isFile()) continue;

        const hostChanged = rec ? !sameHostStamp(hostStamp(hostStat), rec.host) : hostStat.mtimeMs > upperStat.mtimeMs;
        if (!hostChanged) continue;

        if (hostStat.size === upperStat.size && filesEqual(hostFile, upperFile)) {
          recordSync(manifest, rel, hostStat, upperFile); // same bytes: just re-baseline
          manifestDirty = true;
          continue;
        }

        if (overlayChanged) {
          if (isGitMetaPath(rel)) {
            const kept = preserveOverlayRef(rel, upperFile, hostFile, stamp);
            if (kept) preservedRefs.push(kept);
          } else if (!gitObjectKnown(gitBlobSha1(upperFile), { includeOverlay: true })) {
            preserved.push(preserveOverlayFile(rel, upperFile, stamp));
          }
        }
        copyHostFileOverUpper(hostFile, upperFile, hostStat.mode);
        recordSync(manifest, rel, hostStat, upperFile);
        manifestDirty = true;
        files.push(rel);
      } catch (e) {
        if (e.code === 'ENOENT') continue; // vanished mid-walk
        failures.push({ path: rel, error: e.message });
      }
    }
  } catch (e) {
    failures.push({ path: '(walk)', error: e.message });
  }
  if (!result.truncated) {
    for (const rel of Object.keys(manifest.files)) {
      if (!seen.has(rel)) { delete manifest.files[rel]; manifestDirty = true; }
    }
  }
  if (manifestDirty) saveSyncManifest(manifest);
  result.reconciled = files.length;
  if (failures.length) {
    log(`reconcile: ${failures.length} file(s) could NOT be refreshed from the host — ` +
      `the sandbox may be reading stale content: ` +
      failures.slice(0, 5).map((f) => `${f.path} (${f.error})`).join('; ') +
      (failures.length > 5 ? `; +${failures.length - 5} more` : ''));
  }
  if (preserved.length || preservedRefs.length) {
    log(`reconcile: preserved ${preserved.length} overlay file version(s) and ${preservedRefs.length} overlay ref(s) before refreshing from the host`);
  }
  if (result.truncated) {
    log(`reconcile: walk stopped at ${RESYNC_MAX_FILES} overlay files — files beyond the cap were not checked against the host`);
  }
  if (SYNC_DEBUG) {
    log(`reconcile: ${files.length} refreshed, ${removed.length} removed, ${failures.length} failed` +
      (files.length ? ` [${files.slice(0, 20).join(', ')}${files.length > 20 ? ', …' : ''}]` : ''));
  }
  return result;
}

/** Tool-result fields describing what reconciliation did; empty when nothing happened. */
function hostSyncReport(rec) {
  const out = {};
  if (rec.files.length || rec.removed.length || rec.preserved.length || rec.preservedRefs.length) {
    const toPosix = (r) => r.split(path.sep).join('/');
    out.hostSync = {
      refreshedFromHost: rec.files.slice(0, 20).map(toPosix),
      ...(rec.files.length > 20 ? { refreshedMore: rec.files.length - 20 } : {}),
      ...(rec.removed.length ? { removedBecauseDeletedOnHost: rec.removed.slice(0, 20) } : {}),
      ...(rec.preserved.length ? { preservedOverlayVersions: rec.preserved } : {}),
      ...(rec.preservedRefs.length ? { preservedOverlayRefs: rec.preservedRefs } : {}),
      note: 'The host changed these paths since the overlay last saw them (e.g. the user applied patches), so the sandbox now shows the host versions.' +
        (rec.preserved.length ? ' Your overlay copies held content git did not have; they were saved first — diff each savedTo against the file and re-apply what is still needed.' : '') +
        (rec.preservedRefs.length ? ' Overlay commits the host does not have stay reachable at each preservedOverlayRefs[].ref (git log <ref>).' : '') +
        ' If you noted a <base> sha for format-patch, re-read it with git rev-parse HEAD.',
    };
  }
  const warnings = [];
  if (rec.failures.length) {
    warnings.push(`${rec.failures.length} file(s) could not be refreshed from the host and may be stale: ` +
      rec.failures.slice(0, 5).map((f) => f.path).join(', '));
  }
  if (rec.truncated) {
    warnings.push(`only the first ${RESYNC_MAX_FILES} overlay files were checked against the host; later ones may be stale`);
  }
  if (warnings.length) out.syncWarning = warnings.join('; ');
  return out;
}

/**
 * Does a session overlay hold anything worth keeping? Worktree files outside
 * build/dependency dirs, or git refs written in the overlay (commits,
 * branches). Used to decide whether detaching from it deserves a warning.
 */
function summarizeOverlayWork(stateDir) {
  if (process.platform === 'darwin') {
    // The clone backend's workspace is the whole tree, so "files present" says
    // nothing about edits. Assume it may hold work.
    return { hasWork: true, changedFiles: null, gitRefsWritten: null };
  }
  const upper = path.join(stateDir, 'upper');
  const worktree = collectOverlayFiles(upper, '', [], { skipGit: true });
  let gitRefsWritten = false;
  try {
    gitRefsWritten = countFilesRec(path.join(upper, '.git', 'refs', 'heads')) > 0 ||
      fs.existsSync(path.join(upper, '.git', 'packed-refs'));
  } catch { /* no overlay git state */ }
  return {
    hasWork: worktree.length > 0 || gitRefsWritten,
    changedFiles: worktree.length,
    ...(worktree.length >= RESYNC_MAX_FILES ? { changedFilesCapped: true } : {}),
    sample: worktree.slice(0, 5).map((r) => r.split(path.sep).join('/')),
    gitRefsWritten,
  };
}

function collectOverlayFiles(upperDir, relBase = '', acc = [], { skipGit = false } = {}) {
  if (acc.length >= RESYNC_MAX_FILES) return acc;
  let entries;
  try { entries = fs.readdirSync(path.join(upperDir, relBase), { withFileTypes: true }); } catch { return acc; }
  // Walk .git first: refs and index must reconcile even when a large worktree
  // would exhaust RESYNC_MAX_FILES before readdir order reached them.
  if (!relBase) entries.sort((a, b) => (b.name === '.git') - (a.name === '.git'));
  for (const e of entries) {
    if (acc.length >= RESYNC_MAX_FILES) break;
    const rel = relBase ? path.join(relBase, e.name) : e.name;
    if (e.isDirectory()) {
      if (RESYNC_SKIP_DIRS.has(e.name)) continue;
      if (rel === '.git' && skipGit) continue;
      // Allow .git to be synced so host commits reflect in the sandbox, but skip other hidden dirs
      if (e.name.startsWith('.') && rel !== '.git') continue;
      // The object store is content-addressed and immutable: a path that
      // exists in both layers holds the same bytes by construction, so
      // copying it is pure waste (and a hard error, since git writes loose
      // objects 0444). Host-only objects were never copied here anyway —
      // overlayfs merges them in from the lower layer. Pruning also stops
      // thousands of objects from consuming the RESYNC_MAX_FILES budget
      // before the walk reaches .git/refs and .git/index, which are the
      // entries that actually have to reconcile for a later commit to work.
      if (rel === path.join('.git', 'objects')) continue;
      // Reconciliation's own safety copies exist only in the overlay.
      if (PRESERVE_SKIP_RELS.has(rel)) continue;
      collectOverlayFiles(upperDir, rel, acc, { skipGit });
    } else if (e.isFile()) {
      acc.push(rel);
    }
    // Anything else (overlayfs whiteouts are char devices) is skipped.
  }
  return acc;
}

// =============================================================================
// Execution helpers
// =============================================================================

function capAppend(buf, chunk, cap) {
  if (buf.length >= cap) return buf;
  return (buf + chunk).slice(0, cap);
}

/**
 * True once this process has had to recreate overlay directories that vanished
 * underneath it. Surfaced in sandbox_info.notes so a client is told, rather
 * than quietly inheriting a session that is not the one it thinks it is.
 */
let OVERLAY_RECREATED = false;

/** Most recent detach from an overlay that still held work (sandbox_info note). */
let LAST_DETACHED = null;

/**
 * The open project lives in memory and outlives any single client, but the
 * directories behind it do not. Delete `~/.koi/sandbox/<id>/sessions/<sid>/`
 * between runs — a cleanup, a prune, a wiped workspace — and PROJ still names
 * it, sandbox_info still reports it as open with its greenfield flag and its
 * "running" services, and every single exec dies at the mount:
 *
 *   bwrap: Can't find source path .../sessions/<sid>/upper: No such file or directory
 *
 * The server cannot tell the client that from inside a spawn failure, so the
 * failure looks like the sandbox being unreachable and never heals on its own.
 * Recreate the missing directories instead. An empty `upper` is exactly what a
 * fresh overlay over the host tree looks like, so for a normal project this is
 * a correct recovery; for a greenfield project the tree was already gone, and
 * an empty project is at least an honest one.
 */
function ensureSessionDirs() {
  if (!PROJ || !PROJ.dirs) return;
  // Only the host-backed overlay plumbing. `workspace` (darwin CoW clone) is
  // deliberately excluded: an empty directory is NOT an equivalent recovery
  // there, and silently minting one would hide the loss.
  const needed = [PROJ.dirs.upper, PROJ.dirs.work, PROJ.dirs.lower, PROJ.dirs.bin, PROJ.dirs.outbox];
  const missing = needed.filter((d) => d && !fs.existsSync(d));
  if (missing.length === 0) return;
  for (const d of missing) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* surfaced by the failing exec */ }
  }
  OVERLAY_RECREATED = true;
  // Services started against the destroyed overlay are meaningless now: their
  // processes are dead or serving a tree that no longer exists, yet
  // sandbox_info would keep advertising them as "running" — which is how a
  // worker was told "vite-dev (running) at :5173, do NOT start it" and then
  // failed to restart a service belonging to a session that had been deleted.
  for (const svc of services.values()) {
    if (svc.exitCode == null) {
      try { process.kill(-svc.child.pid, 'SIGKILL'); } catch { /* already gone */ }
      svc.exitCode = -1;
    }
  }
  log(`session overlay directories were missing and have been recreated: ${missing.join(', ')} — this session starts from the host tree again; prior overlay writes are gone.`);
  // dirs.bin is on PATH inside the sandbox; an empty one breaks the git wrapper.
  try { installGitWrapper(); } catch { /* best effort */ }
}

// =============================================================================
// Outbox delivery self-check
// =============================================================================
// The outbox is the only channel by which work leaves the sandbox, and nothing
// ever PROVED it worked. That is how the mask-shadowing bug above survived: the
// export wrote into a tmpfs that happened to sit at the right path, and every
// check available from inside the sandbox — exit status, the paths git printed,
// a follow-up `ls` — confirmed a file that would never exist on the host. A
// session cannot tell those apart from inside, which makes this the server's
// job, not the model's.
//
// So verify it the only way that means anything: write a nonce from INSIDE the
// sandbox and read it back from the HOST. Once per session, off the hot path.
// Ordering fixes get reverted; a probe keeps catching the next variant.
// =============================================================================

/** { key, ok, inside, fellBack, detail } for the current backend+session. */
let OUTBOX_DELIVERY = null;

function probeOutboxOnce(insidePath) {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const name = `.koi-delivery-probe-${nonce}`;
  const hostPath = path.join(PROJ.dirs.outbox, name);
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  let r;
  try {
    const { cmd, args, spawnEnv } = BACKEND.wrap(
      `mkdir -p ${q(insidePath)} && printf %s ${q(nonce)} > ${q(`${insidePath}/${name}`)}`, {});
    r = spawnSync(cmd, args, { env: spawnEnv, encoding: 'utf8', timeout: 30_000 });
  } catch (e) {
    return { ok: false, detail: `could not spawn the probe: ${e.message}` };
  }
  let got = null;
  try { got = fs.readFileSync(hostPath, 'utf8'); } catch { /* not delivered */ }
  try { fs.unlinkSync(hostPath); } catch { /* nothing to clean */ }
  if (got === nonce) return { ok: true };
  if (got !== null) return { ok: false, detail: 'a file appeared on the host but its contents differ' };
  const err = ((r && (r.stderr || '')) || '').trim().replace(/\s+/g, ' ').slice(0, 300);
  return {
    ok: false,
    detail: r && r.status === 0
      ? `the write succeeded inside the sandbox but nothing appeared at ${hostPath} — ${insidePath} is not the host outbox (a mask or another mount is shadowing the bind)`
      : `the probe command failed inside the sandbox (exit ${r ? r.status : '?'})${err ? `: ${err}` : ''}`,
  };
}

/**
 * The NEGATIVE half of the delivery contract.
 *
 * probeOutboxOnce proves the current outbox path reaches the host. That alone is
 * not enough: it only ever exercises the single leaf carved out of the mask, so
 * it passed with full marks while every OTHER path under the mask silently
 * swallowed writes into the mask's writable tmpfs. The bug it missed is the one
 * sessions actually hit, because the outbox path changes under them
 * (projectless -> project, and again on resume).
 *
 * So assert the complement: a plausible-but-WRONG outbox path must not look like
 * a successful delivery. Writing there should fail outright; if it does succeed,
 * the write must at least appear on the host. Succeeding AND vanishing is the
 * silent-loss signature, and it gets reported.
 */
function probeStaleOutboxRejected() {
  // Same shape as a real outbox (<state-base>/<project-hash>/outbox) but a hash
  // no project maps to, and never created host-side -- so a pass leaves nothing
  // behind and a host-side appearance is unambiguous.
  const stale = path.join(stateBaseDir(), 'koi-stale-probe-0000000000', 'outbox');
  const name = '.koi-stale-probe';
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  let r;
  try {
    const { cmd, args, spawnEnv } = BACKEND.wrap(
      `mkdir -p ${q(stale)} && printf stale > ${q(`${stale}/${name}`)}`, {});
    r = spawnSync(cmd, args, { env: spawnEnv, encoding: 'utf8', timeout: 30_000 });
  } catch (e) {
    return { ok: true, detail: `could not spawn the stale probe: ${e.message}` };
  }
  // Refused: the mask is sealed. Expected path.
  if (r && r.status !== 0) return { ok: true };

  let landed = false;
  try { landed = fs.existsSync(path.join(stale, name)); } catch { /* treat as absent */ }
  try { fs.rmSync(path.join(stateBaseDir(), 'koi-stale-probe-0000000000'), { recursive: true, force: true }); } catch { /* best effort */ }
  if (landed) {
    return { ok: false, detail: `a write to ${stale} succeeded and reached the host — the mask is not covering ${stateBaseDir()}.` };
  }
  return {
    ok: false,
    detail: `a write to ${stale} succeeded inside the sandbox but reached nothing on the host — ` +
      'writes to a wrong outbox path are being swallowed by a writable mask tmpfs, so ' +
      'format-patch to a stale or projectless outbox path exits 0, prints host-looking ' +
      'paths, lists the file at full size, and delivers nothing.',
  };
}

function verifyOutboxDelivery() {
  const key = `${BACKEND?.name || 'none'}:${PROJ.state}`;
  if (OUTBOX_DELIVERY && OUTBOX_DELIVERY.key === key) return OUTBOX_DELIVERY;

  const inside = BACKEND.outboxInside;
  const first = probeOutboxOnce(inside);
  if (first.ok) {
    // Delivery works for the CURRENT path. Now check that a WRONG path fails
    // loudly rather than silently — the half that used to go unverified.
    const stale = BACKEND?.name === 'bwrap-overlay' ? probeStaleOutboxRejected() : { ok: true };
    if (!stale.ok) log(`outbox delivery: the live path works, but WRONG paths fail SILENTLY — ${stale.detail}`);
    OUTBOX_DELIVERY = {
      key, ok: true, inside, fellBack: false, detail: null,
      staleSilent: stale.ok ? null : stale.detail,
    };
    return OUTBOX_DELIVERY;
  }

  // The host-path spelling did not reach the host. On bwrap there is a second,
  // independent bind under our own /tmp tmpfs that no --exclude entry can
  // shadow; a delivery at a less pretty path beats no delivery at all.
  let detail = first.detail, fellBack = false;
  if (BACKEND?.name === 'bwrap-overlay' && inside !== OUTBOX_ALIAS_INSIDE) {
    const second = probeOutboxOnce(OUTBOX_ALIAS_INSIDE);
    if (second.ok) {
      BACKEND.outboxInside = OUTBOX_ALIAS_INSIDE;
      fellBack = true;
    } else {
      detail += `; the ${OUTBOX_ALIAS_INSIDE} alias failed too (${second.detail})`;
    }
  }
  OUTBOX_DELIVERY = { key, ok: fellBack, inside: BACKEND.outboxInside, fellBack, detail };
  log(fellBack
    ? `outbox delivery: ${inside} does not reach the host (${detail}). $KOI_OUTBOX now points at ${OUTBOX_ALIAS_INSIDE}, which does. Exports still land in ${PROJ.dirs.outbox} on the host.`
    : `outbox delivery: BROKEN — ${detail}. Exports from this session will NOT reach the host; sessions are being warned.`);
  return OUTBOX_DELIVERY;
}

/** Commands whose whole point is to ship something out of the sandbox. */
const SHIPPING_CMD_RE = /KOI_OUTBOX|format-patch|git\s+bundle/;

function execInSandbox(shCmd, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, outputCap = OUTPUT_CAP } = {}) {
  ensureSessionDirs();
  // Probed once per session, before the first command runs, so a broken outbox
  // is known by the time anything tries to use it.
  const delivery = verifyOutboxDelivery();
  return new Promise((resolve) => {
    const { cmd, args, spawnEnv } = BACKEND.wrap(shCmd, { cwd });
    const child = spawn(cmd, args, {
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group so timeouts kill the whole tree
    });
    let stdout = '', stderr = '', timedOut = false, done = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout = capAppend(stdout, d.toString(), outputCap); });
    child.stderr.on('data', (d) => { stderr = capAppend(stderr, d.toString(), outputCap); });
    const settle = (code, signal) => {
      if (done) return; done = true; clearTimeout(timer);
      if (code !== 0 && code != null) {
        if (/Unknown option --overlay-src/i.test(stderr)) {
          stderr += '\n[sandbox hint] bubblewrap lacks --overlay-src (bubblewrap >= 0.11.0 is required for overlayfs support).\n' +
            'Please build and install bwrap 0.11.0+: https://github.com/containers/bubblewrap';
        } else if (/uid_map|user mappings|clone: Operation not permitted/i.test(stderr)) {
          stderr += '\n[sandbox hint] bubblewrap failed to configure user namespaces (Operation not permitted).\n' +
            'On Ubuntu 24.04 run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\n' +
            'or grant setuid permissions: sudo chmod u+s $(which bwrap)';
        }
      }
      // A shipping command that "succeeded" into a broken outbox is the exact
      // shape of the original bug: exit 0, plausible paths, nothing delivered.
      // Contradict it here, where the session is actually reading.
      if (!delivery.ok && SHIPPING_CMD_RE.test(shCmd)) {
        stderr += `\n[koi-sandbox] OUTBOX DELIVERY IS BROKEN — this export did NOT reach the host.\n` +
          `  ${delivery.detail}\n` +
          `  Do not tell the user anything was shipped. Report this failure instead;\n` +
          `  the work is still in the overlay, host-visible at ${projectTreeHostPath()}.\n`;
      }
      resolve({ exitCode: code ?? -1, signal, stdout, stderr, timedOut });
    };
    child.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + `\nspawn error: ${e.message}`, timedOut });
    });
    // Resolve on 'exit', NOT 'close': 'close' additionally waits for stdio
    // pipes to close, and a daemonized grandchild (git gc --auto, fsmonitor,
    // build daemons) inherits the pipes, setsid()s out of the process group
    // (surviving the group SIGKILL), and holds them open forever — hanging
    // the promise and, via the in-order queue, the whole server. After exit,
    // give the pipes a short grace period to flush remaining output.
    child.on('exit', (code, signal) => {
      const grace = setTimeout(() => settle(code, signal), 250);
      child.once('close', () => { clearTimeout(grace); settle(code, signal); });
    });
  });
}

function resolveRel(rel) {
  const abs = path.resolve(BACKEND.root, rel || '.');
  const outside = path.relative(BACKEND.root, abs).startsWith('..');
  return { abs, outside };
}

// =============================================================================
// Background services (dev servers, watchers)
// =============================================================================

const services = new Map(); // name -> { child, log, cmd, cwd, startedAt, exitCode }

function serviceSummary(name, svc) {
  return {
    name,
    cmd: svc.cmd,
    cwd: svc.cwd || null,
    startedAt: new Date(svc.startedAt).toISOString(),
    status: svc.exitCode == null ? 'running' : `exited(${svc.exitCode})`,
    exitCode: svc.exitCode,
    urls: extractServiceUrls(svc.log),
  };
}

function listRunningServices() {
  const out = [];
  for (const [name, svc] of services) {
    if (svc.exitCode == null) out.push(serviceSummary(name, svc));
  }
  return out;
}

function listAllServices() {
  return [...services.entries()].map(([name, svc]) => serviceSummary(name, svc));
}

function extractServiceUrls(log) {
  if (!log) return [];
  const urls = [];
  const re = /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0):\d+\S*/g;
  let m;
  while ((m = re.exec(log))) {
    urls.push(m[0].replace('0.0.0.0', '127.0.0.1'));
  }
  return [...new Set(urls)];
}

/**
 * What the caller can actually do with the port this service just opened.
 *
 * `policy` mode is NOT the isolated case: pasta runs with `-t auto`, which
 * republishes namespace-bound ports onto host loopback. Collapsing it into the
 * loopback branch told the caller its dev server was unreachable when it was
 * one navigation away.
 *
 * Two caveats worth stating, because both cost real debugging time:
 *  - `-t auto` reads listening sockets from the namespace's /proc/net/tcp, so a
 *    server bound to 127.0.0.1 is not usefully republished. Bind 0.0.0.0.
 *  - On WSL2 the Windows-side `localhost` relay does not always reach the
 *    republished port, so a browser on the host may need the VM's IP instead.
 */
function serviceReachabilityNote() {
  if (OPTS.net === 'loopback') {
    return 'loopback mode: service ports are isolated inside the sandbox network namespace.';
  }
  const base = OPTS.net === 'host'
    ? 'Ports opened by this service are reachable at http://localhost:<port> from the browser.'
    : 'Ports bound to 0.0.0.0 are republished onto host loopback (pasta -t auto), so the browser can '
      + 'open http://localhost:<port>. A server bound only to 127.0.0.1 is not forwarded — pass --host 0.0.0.0. '
      + 'On WSL2, if localhost does not resolve to the service, try the VM IP from `ip -4 addr show eth0`.';
  return `${base} After overlay edits, call sandbox_restart_service before expecting UI changes.`;
}

function startService(name, shCmd, cwd) {
  if (services.has(name) && services.get(name).exitCode == null) {
    throw new Error(`service '${name}' already running (stop it first, or use sandbox_restart_service)`);
  }
  if (services.has(name)) services.delete(name);
  ensureSessionDirs();
  const { cmd, args, spawnEnv } = BACKEND.wrap(shCmd, { cwd });
  const child = spawn(cmd, args, { env: spawnEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const svc = { child, log: '', cmd: shCmd, cwd: cwd || BACKEND.root, startedAt: Date.now(), exitCode: null };
  const push = (d) => { svc.log = capAppend(svc.log, d.toString(), LOG_CAP); };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  // 'exit' (not 'close'): a service whose descendants daemonize would
  // otherwise never be observed as exited, blocking stop/restart.
  child.on('exit', (code) => { svc.exitCode = code ?? -1; });
  child.on('error', (e) => { svc.exitCode = -1; push(`spawn error: ${e.message}\n`); });
  services.set(name, svc);
  scheduleOverlayGc('service');
  return svc;
}

async function waitForServiceBoot(svc, { timeoutMs = 8000, readyPattern } = {}) {
  const re = readyPattern
    ? new RegExp(readyPattern, 'i')
    : /ready|listening|Local:\s|started server|Vite\s|sandbox-ok/i;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (svc.exitCode != null) break;
    if (re.test(svc.log)) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  return {
    ready: svc.exitCode == null && re.test(svc.log),
    exited: svc.exitCode != null,
  };
}

/** Stop and wait for exit so ports free before restart. */
async function stopService(name, { waitMs = 5000, remove = true } = {}) {
  const svc = services.get(name);
  if (!svc) throw new Error(`no such service: ${name}`);
  if (svc.exitCode != null) {
    if (remove) services.delete(name);
    return { success: true, name, alreadyStopped: true };
  }
  try { process.kill(-svc.child.pid, 'SIGTERM'); } catch { try { svc.child.kill('SIGTERM'); } catch {} }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && svc.exitCode == null) {
    await new Promise((r) => setTimeout(r, 40));
  }
  if (svc.exitCode == null) {
    try { process.kill(-svc.child.pid, 'SIGKILL'); } catch { try { svc.child.kill('SIGKILL'); } catch {} }
    const hardDeadline = Date.now() + 1500;
    while (Date.now() < hardDeadline && svc.exitCode == null) {
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  if (remove) services.delete(name);
  return { success: true, name, exitCode: svc.exitCode };
}

async function restartService(name, { command, cwd, readyPattern, bootTimeoutMs } = {}) {
  const prev = services.get(name);
  const cmd = command || prev?.cmd;
  const dir = cwd || prev?.cwd || BACKEND.root;
  if (!cmd) throw new Error(`cannot restart '${name}': no previous command and none provided`);
  if (prev && prev.exitCode == null) {
    await stopService(name, { waitMs: 5000, remove: true });
    await new Promise((r) => setTimeout(r, 150));
  } else if (prev) {
    services.delete(name);
  }
  const svc = startService(name, cmd, dir);
  await waitForServiceBoot(svc, { timeoutMs: bootTimeoutMs || 8000, readyPattern });
  return svc;
}

function stopAllServices() {
  for (const name of [...services.keys()]) {
    try {
      const svc = services.get(name);
      if (!svc || svc.exitCode != null) { services.delete(name); continue; }
      try { process.kill(-svc.child.pid, 'SIGTERM'); } catch { try { svc.child.kill('SIGTERM'); } catch {} }
      setTimeout(() => { try { process.kill(-svc.child.pid, 'SIGKILL'); } catch {} }, 3000).unref();
    } catch { /* ignore */ }
  }
}


function shutdownChildren() {
  stopAllServices();
  try { NET_BROKER?.stop(); } catch { /* ignore */ }
}
process.on('exit', shutdownChildren);
process.on('SIGINT', () => { shutdownChildren(); process.exit(0); });
process.on('SIGTERM', () => { shutdownChildren(); process.exit(0); });


// =============================================================================
// Tool definitions
// =============================================================================

const TOOLS = [
  {
    name: 'sandbox_exec',
    tier: 'safe',
    description:
      'Run a shell command inside the sandbox (read-only host, writes go to the overlay; ' +
      'git push and other credentialed network writes are blocked). This is the primary tool: ' +
      'read files (cat/sed/rg), build/test (make/cargo/npm/pytest), inspect changes (git status/diff), ' +
      'checkpoint work (git add/commit — commits live in the overlay .git, the host repo is untouched) ' +
      'and ship (git format-patch -o "$KOI_OUTBOX" <base>..HEAD writes host-visible patch files). ' +
      'Working directory defaults to the project root. Returns exit code, stdout, stderr. ' +
      'Before the command runs, host-side changes (e.g. patches the user applied) are reconciled into the overlay; ' +
      'when that changed anything the result carries hostSync (refreshed/removed paths, and saved copies of any overlay content that was replaced).',
    displayMessage: '🧪 sandbox $ {{command}}{{#cwd}}  (in {{cwd}}){{/cwd}}',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command (passed to /bin/bash -c)' },
        cwd: { type: 'string', description: 'Working directory, relative to project root' },
        timeout_ms: { type: 'number', description: `Timeout in ms (default ${DEFAULT_TIMEOUT_MS})` },
        max_output: { type: 'number', description: `Per-stream output cap in bytes (default ${OUTPUT_CAP}). Use a small cap (e.g. 8192) for chatty commands like installs/builds so the output does not flood the LLM context; combine with tail/grep for the interesting part.` },
      },
      required: ['command'],
    },
  },
  {
    name: 'sandbox_network_policy',
    tier: 'safe',
    description:
      'Show the sandbox network egress policy: which hosts are allowed without asking, ' +
      'which are denied outright, and what happens to everything else. Read-only — the ' +
      'policy is the user\'s, and is changed only by them (in the file) or by answering ' +
      'an approval prompt. Call this when a fetch/install fails with a policy message, so ' +
      'you can tell the user which host to approve instead of retrying blindly.',
    displayMessage: '🛡️ Reading network policy',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sandbox_start_service',
    tier: 'mutating',
    description:
      'Start a long-running command (dev server, test watcher) inside the sandbox as a named background service. ' +
      'In host and policy network modes its ports are reachable on localhost (bind 0.0.0.0, not 127.0.0.1), so the browser can open the app directly. ' +
      'Waits for a ready/listening log line. After overlay file edits, use sandbox_restart_service — ' +
      'running services do not reliably see later overlay writes (separate bwrap mounts).',
    displayMessage: '🚀 Starting service {{name}}: {{command}}',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        command: { type: 'string' },
        cwd: { type: 'string' },
        ready_pattern: { type: 'string', description: 'Optional regex (case-insensitive) matched against service logs for readiness' },
        boot_timeout_ms: { type: 'number', description: 'Max wait for ready log (default 8000)' },
      },
      required: ['name', 'command'],
    },
  },
  {
    name: 'sandbox_restart_service',
    tier: 'safe',
    description:
      'Stop a named service (waiting for exit so ports free), then start it again with the same command ' +
      '(or a new command if provided). Required after overlay edits so the process re-reads files in a fresh bwrap mount.',
    displayMessage: '🔄 Restarting service {{name}}',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        command: { type: 'string', description: 'Optional new command; defaults to the previous one' },
        cwd: { type: 'string' },
        ready_pattern: { type: 'string' },
        boot_timeout_ms: { type: 'number' },
      },
      required: ['name'],
    },
  },
  {
    name: 'sandbox_service_logs',
    tier: 'safe',
    description: 'Get status and recent output of a background service (or list all services if name is omitted).',
    displayMessage: '📜 Logs for {{name|default:all services}}',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        tail: { type: 'number', description: 'Return only the last N bytes of the log' },
      },
    },
  },
  {
    name: 'sandbox_stop_service',
    tier: 'safe',
    description: 'Stop a named background service and wait for it to exit (so ports free for restart).',
    displayMessage: '🛑 Stopping service {{name}}',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'sandbox_open_project',
    tier: 'safe',
    description: 'Open a project directory on the host: sets the writable overlay location, working directory, and relative path root. New sessions start each project FRESH from the host tree; re-opening within this session CONTINUES its overlay. Do NOT call this just to recover from a dropped connection — call sandbox_info first; if project and session are unchanged, keep working. Pass resume to reattach a previous session overlay (see sandbox_info.priorSessions), or fresh:true to force a clean overlay mid-session. If the response contains detachedSession or resumeHint and you are continuing the same task, resume that session immediately. Existing running services are NOT stopped.',
    displayMessage: '📂 Opening project {{path}}',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute project directory on the host' },
        resume: {
          anyOf: [{ type: 'string' }, { type: 'boolean' }],
          description: 'Session id OR label from sandbox_info.priorSessions to reattach that overlay, or true for the most recent prior session',
        },
        fresh: { type: 'boolean', description: 'Force a brand-new empty overlay for this session' },
        label: { type: 'string', description: 'Optional human-readable tag stored on the session overlay (e.g. a topic id); later resumable by this label and shown in priorSessions' },
      },
      required: ['path'],
    },
  },
  {
    name: 'sandbox_reset',
    tier: 'safe',
    description: 'Discard ALL of THIS session\'s sandbox changes (wipe the current session\'s overlay / workspace back to the host state; other sessions\' overlays are untouched). This is a host-side operation the shell cannot perform: the overlay upperdir is outside the sandbox. Also discards any git commits made in the overlay (exported patches in the outbox survive). Running services keep their processes but lose file state.',
    displayMessage: '♻️ Resetting sandbox overlay',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'overlay_fs_sync',
    tier: 'safe',
    description: 'Reconcile the overlay with the host tree now and report what changed. This already happens automatically before every sandbox_exec; call it only to get the report without running a command. Refreshes overlay files the host modified, removes overlay copies of files the host deleted, and saves overlay content it replaces (see hostSync).',
    displayMessage: '🔄 Syncing overlay filesystem',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sandbox_info',
    tier: 'safe',
    description: 'Show sandbox configuration: backend, project root, network mode, state dirs, running services.',
    displayMessage: 'ℹ️ Sandbox info',
    inputSchema: { type: 'object', properties: {} },
  },
];

// =============================================================================
// Tool implementations
// =============================================================================

const handlers = {
  async sandbox_exec({ command, cwd, timeout_ms, max_output }) {
    // Keep this overlay's `inuse` marker fresh for the whole session, not just
    // the 30 minutes after sandbox_open_project.
    touchSessionInUse();
    const rec = reconcileLowerToUpper();
    const dir = cwd ? resolveRel(cwd).abs : BACKEND.root;
    // Clamp the per-stream cap to [1 KiB, OUTPUT_CAP]; callers use small caps
    // to keep chatty build/install logs from flooding an LLM context window.
    const cap = Number.isFinite(max_output) && max_output > 0
      ? Math.max(1024, Math.min(Math.floor(max_output), OUTPUT_CAP))
      : OUTPUT_CAP;
    const r = await execInSandbox(command, { cwd: dir, timeoutMs: timeout_ms || DEFAULT_TIMEOUT_MS, outputCap: cap });
    const truncated = r.stdout.length >= cap || r.stderr.length >= cap;
    // A command is the main way bytes land in the overlay (installs, builds).
    scheduleOverlayGc('exec');
    return {
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      stdout: r.stdout,
      stderr: r.stderr,
      ...overlayPressureMeta(),
      // What reconciliation did before the command ran: refreshed, removed and
      // preserved paths (hostSync), and anything that may still be stale
      // (syncWarning). Silence here used to hide overwritten session edits.
      ...hostSyncReport(rec),
      ...(truncated ? { truncated: true, outputCap: cap, hint: 'Output hit the cap. Re-run piped through tail/grep, or raise max_output if you truly need more.' } : {}),
    };
  },

  async sandbox_start_service({ name, command, cwd, ready_pattern, boot_timeout_ms }) {
    const dir = cwd ? resolveRel(cwd).abs : BACKEND.root;
    const svc = startService(name, command, dir);
    const boot = await waitForServiceBoot(svc, {
      timeoutMs: boot_timeout_ms || 8000,
      readyPattern: ready_pattern,
    });
    return {
      success: svc.exitCode == null,
      name,
      status: svc.exitCode == null ? 'running' : `exited(${svc.exitCode})`,
      ready: boot.ready,
      urls: extractServiceUrls(svc.log),
      earlyLog: svc.log.slice(-4000),
      note: serviceReachabilityNote(),
    };
  },

  async sandbox_restart_service({ name, command, cwd, ready_pattern, boot_timeout_ms }) {
    try {
      const svc = await restartService(name, {
        command,
        cwd: cwd ? resolveRel(cwd).abs : undefined,
        readyPattern: ready_pattern,
        bootTimeoutMs: boot_timeout_ms,
      });
      return {
        success: svc.exitCode == null,
        name,
        status: svc.exitCode == null ? 'running' : `exited(${svc.exitCode})`,
        urls: extractServiceUrls(svc.log),
        earlyLog: svc.log.slice(-4000),
        restarted: true,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  async sandbox_service_logs({ name, tail }) {
    if (!name) {
      return {
        services: listAllServices(),
        running: listRunningServices().map((s) => s.name),
      };
    }
    const svc = services.get(name);
    if (!svc) return { success: false, error: `no such service: ${name}` };
    const logOut = tail ? svc.log.slice(-tail) : svc.log.slice(-20_000);
    return {
      name, cmd: svc.cmd,
      status: svc.exitCode == null ? 'running' : `exited(${svc.exitCode})`,
      urls: extractServiceUrls(svc.log),
      log: logOut,
    };
  },

  async sandbox_stop_service({ name }) {
    try {
      return await stopService(name);
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  async sandbox_open_project({ path: p, resume = null, fresh = false, label = null }) {
    try {
      const prev = PROJ.state ? { state: PROJ.state, sessionId: PROJ.sessionId, path: PROJ.path } : null;
      setProject(p, { resume, fresh, label });
      const prior = listProjectSessions(PROJ.sessionsRoot).filter((s) => s.id !== PROJ.sessionId);
      const baseKind = PROJ.resumed ? 'RESUMED' : (PROJ.startedFromHost ? 'FRESH' : 'CONTINUING');

      // Leaving an overlay that still holds work for the same project is how
      // edits "vanish": a reconnect re-ran initialize, and re-opening the
      // project attached a new overlay. Say so, name the exact resume call, and
      // pin the old overlay so the disk cache cannot evict it meanwhile.
      let detachedSession = null;
      if (prev && prev.state !== PROJ.state && prev.path === PROJ.path) {
        const work = summarizeOverlayWork(prev.state);
        // An overlay claimed by a DIFFERENT session key belongs to another
        // conversation: keep it safe, but do not advise resuming it here.
        const prevKey = sessionKeyDigestOf(prev.state);
        const otherConversation = !!SESSION_KEY && !!prevKey && prevKey !== sessionKeyDigest(SESSION_KEY);
        if (work.hasWork && otherConversation) {
          pinSession(prev.state, 'detached-other-conversation');
        } else if (work.hasWork) {
          const deliberate = !!fresh || resume != null;
          detachedSession = {
            session: prev.sessionId,
            ...work,
            pinnedUntil: pinSession(prev.state, 'detached-with-work'),
            action: deliberate
              ? 'You explicitly switched overlays; the previous one is kept (pinned) in case you need it.'
              : `If you are continuing the same task, call sandbox_open_project({ path: ${JSON.stringify(PROJ.path)}, resume: ${JSON.stringify(prev.sessionId)} }) now — this new overlay does not contain that work.`,
          };
          LAST_DETACHED = { ...detachedSession, at: new Date().toISOString(), deliberate };
        }
      }
      // A FRESH overlay after a server restart has no `prev` to compare with,
      // so also point at the most recent prior overlay that holds work.
      let resumeHint = null;
      if (baseKind === 'FRESH' && !fresh && !detachedSession && !PROJ.greenfield) {
        const myKey = SESSION_KEY ? sessionKeyDigest(SESSION_KEY) : null;
        for (const cand of prior.slice(0, 3)) {
          // Never point a conversation at an overlay another conversation claimed.
          const candKey = sessionKeyDigestOf(path.join(PROJ.sessionsRoot, cand.id));
          if (myKey && candKey && candKey !== myKey) continue;
          const work = summarizeOverlayWork(path.join(PROJ.sessionsRoot, cand.id));
          if (work.hasWork) {
            resumeHint = `Prior overlay ${cand.id}${cand.label ? ` (label ${cand.label})` : ''} holds work ` +
              `(${work.changedFiles ?? 'unknown'} changed file(s)${work.gitRefsWritten ? ', overlay git refs' : ''}). ` +
              `If this continues that task, call sandbox_open_project({ path: ${JSON.stringify(PROJ.path)}, resume: ${JSON.stringify(cand.id)} }).`;
            break;
          }
        }
      }
      const gfNote = PROJ.greenfield
        ? `GREENFIELD: this path does not exist on the host. The overlay is empty and the host is untouched — build the project from scratch here. DELIVERY IS ALREADY GUARANTEED: everything you write lands in ${projectTreeHostPath()} on the host, and the user is handed \`cp -r <that>/. <project>/\` at the end of the run, whether or not you commit, export, or finish. So do not spend budget protecting the work from being lost — it cannot be. Do still \`git init\`, WRITE .gitignore FIRST (node_modules/, dist/, build/, target/, .venv/, __pycache__/, .next/, coverage/, *.log, .env), then \`git add -A && git commit\`: that is what makes the result REVIEWABLE rather than a directory the user has to excavate. Optionally also \`SHA=$(git rev-parse --short HEAD); BR=$(git symbolic-ref --quiet --short HEAD) || { git checkout -B main; BR=main; }; rm -f "$KOI_OUTBOX"/project-*.bundle; git bundle create "$KOI_OUTBOX/project-$SHA.bundle" "$BR" HEAD\` for a clean-history clone; never a bare project.bundle (a fixed name overwrites silently, and a bundle carrying only HEAD clones detached). format-patch/git am do NOT apply — there is no host base to apply a delta onto.`
        : null;
      const baseNote = gfNote || {
        FRESH: 'FRESH session: overlay is empty; you are working from the host tree exactly as it exists on disk (the stable base the user sees).',
        CONTINUING: 'CONTINUING this connection\'s session: reusing the overlay you already opened here (your in-progress edits are present).',
        RESUMED: PROJ.resumedByKey
          ? 'RESUMED this conversation\'s overlay (matched by session key after a reconnect or server restart; your earlier edits are present).'
          : 'RESUMED a previous session overlay (edits from that session are present on top of the host tree).',
      }[baseKind];
      return {
        success: true,
        project: PROJ.path,
        session: PROJ.sessionId,
        ...(PROJ.sessionLabel ? { label: PROJ.sessionLabel } : {}),
        base: baseNote,
        baseKind,
        greenfield: PROJ.greenfield,
        resumed: PROJ.resumed,
        // The outbox is keyed by a hash of the PROJECT PATH, so opening a
        // different project silently invalidates any previously-noted path.
        // Returned here (not only from sandbox_info) so a caller that switches
        // projects mid-session cannot keep using a stale value it noted at
        // startup and hand the user a path that does not exist.
        outbox: PROJ.dirs.outbox,
        overlayHostPath: projectTreeHostPath(),
        // Host-side live review of this overlay (for the USER, not for you):
        reviewCommand: `node ${SELF_PATH} review --watch`,
        priorSessions: prior,
        ...(detachedSession ? { detachedSession } : {}),
        ...(resumeHint ? { resumeHint } : {}),
        note: (detachedSession && !LAST_DETACHED.deliberate
          ? `WARNING: this call detached overlay ${detachedSession.session}, which holds work for this project. ${detachedSession.action} `
          : '')
          + (baseKind === 'FRESH'
          ? 'New empty overlay activated.'
          : baseKind === 'CONTINUING'
            ? 'Existing session overlay reactivated.'
            : 'Resumed overlay activated.')
          + (prior.length ? ` ${prior.length} other session overlay(s) exist for this project — pass resume:"<session>" to reattach one, otherwise they are ignored.` : ''),
        // Navigation is a shell concern: run rg / ast-grep / the project's own
        // language tooling through sandbox_exec. They read through the overlay,
        // so they already see this session's unshipped edits.
        codeNavigation: 'Use sandbox_exec: `rg` for text, `ast-grep run -p \'<pattern>\' --lang <lang>` for structure, and the project\'s own compiler/LSP CLI (tsc --noEmit, cargo check, gopls, rust-analyzer) for semantics and diagnostics.',
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  async sandbox_reset() {
    BACKEND.reset();
    try { fs.rmSync(syncManifestPath(), { force: true }); } catch { /* none */ }
    overlayUsageCache.delete(PROJ.state); // the freed space must show up immediately
    return { success: true, session: PROJ.sessionId, note: 'overlay/workspace wiped back to host state; in-overlay git commits are gone (patches already in the outbox survive)' };
  },

  async sandbox_info() {
    return {
      backend: BACKEND.name,
      platform: process.platform,
      project: PROJ.path,
      sandboxRoot: BACKEND.root,
      network: OPTS.net,
      // How a port bound INSIDE the sandbox becomes reachable from the host
      // browser. Stated here because the rule is not guessable from inside: the
      // namespace is per-exec, so a server started in one sandbox_exec is
      // invisible to a curl run in the next one, and on a pasta without
      // --host-lo-to-ns-lo a server bound to 127.0.0.1 is invisible to the
      // browser as well.
      ...(OPTS.net === 'policy' && BACKEND.name === 'bwrap-overlay'
        ? {
            devServerAccess: {
              publishedTo: 'host loopback, same port (pasta -t auto)',
              bindInside: pastaSupportsHostLo()
                ? '127.0.0.1 or 0.0.0.0 — both reachable'
                : '0.0.0.0 REQUIRED — this pasta forwards host loopback to the namespace interface, so a 127.0.0.1-bound server is unreachable (npm run dev -- --host 0.0.0.0)',
              namespaceScope: 'one network namespace PER exec/service: a server started in one call is not reachable by localhost from another call. Start the server and probe it in the SAME command, or read the service log.',
              ...(pastaNeedsIpv4Only()
                ? { hostPlatform: 'WSL2 in NAT mode: pasta is pinned to IPv4 (-4) so the port lands in /proc/net/tcp where the Windows localhost relay can find it. localhost:<port> works from Windows. IPv6 is not forwarded into the sandbox; a server bound to ::1 only will be unreachable.' }
                : {}),
            },
          }
        : {}),
      ...(OPTS.net === 'policy' ? { networkPolicy: networkPolicySummary() } : {}),
      state: PROJ.state,
      session: PROJ.sessionId,
      ...(PROJ.sessionLabel ? { sessionLabel: PROJ.sessionLabel } : {}),
      greenfield: PROJ.greenfield,
      // Host-visible directory holding this session's writes. On a GREENFIELD
      // project it contains the entire project tree, so `cp -r` delivers the
      // work with no git step at all — the one delivery path that still works
      // when the session dies mid-way. On an existing project it holds only
      // changed files, so it is a diagnostic, not a deliverable.
      overlayHostPath: projectTreeHostPath(),
      sessionBase: PROJ.greenfield ? 'empty (greenfield — project does not exist on host yet)'
        : PROJ.resumed ? 'resumed-overlay'
        : (PROJ.startedFromHost ? 'host-tree (fresh)' : 'host-tree + this session\'s edits'),
      priorSessions: PROJ.sessionsRoot ? listProjectSessions(PROJ.sessionsRoot).filter((s) => s.id !== PROJ.sessionId) : [],
      overlayBudget: overlayBudgetStatus(),
      outbox: PROJ.dirs.outbox,
      reviewCommand: `node ${SELF_PATH} review --watch`,
      // Report what is ACTUALLY enforced by the live backend, not the
      // configured wish-list. The exec backend masks nothing at all, and
      // saying otherwise is worse than the gap itself: the session is told
      // ~/.ssh is unreadable and reports that to the user.
      maskedCredentials: BACKEND?.name === 'exec-UNSAFE'
        ? []
        : [...CRED_DIRS, ...CRED_FILES],
      credentialMasking: BACKEND?.name === 'exec-UNSAFE'
        ? 'NONE — the exec backend has no isolation; every host secret is readable.'
        : BACKEND?.name === 'seatbelt-clone'
          ? 'seatbelt deny-read rules (macOS): the paths above are unreadable, but they still EXIST on disk, unlike the Linux tmpfs masking.'
          : 'tmpfs / /dev/null binds (Linux): the paths above are absent from the sandbox filesystem.',
      services: listRunningServices(),
      servicesAll: listAllServices(),
      // Equal to `outbox` on every backend now — the sandbox sees the outbox at
      // its host path. Kept as a field so existing clients keep working, and so
      // a backend that ever cannot do this has somewhere to say so.
      outboxInside: BACKEND.outboxInside,
      // Which code is answering. Compare against the checkout before trusting
      // that a fix is live; `stale: true` means this process loaded a version
      // of its own file that no longer exists on disk.
      build: buildStatus(),
      // VERIFIED, not assumed: a nonce written from inside the sandbox was read
      // back from the host path above. Anything less than `verified` means an
      // export can exit 0 and still deliver nothing.
      outboxDelivery: (() => {
        const d = verifyOutboxDelivery();
        if (!d.ok) return `BROKEN — ${d.detail}`;
        const base = d.fellBack
          ? `verified via ${d.inside} (the host-path spelling was unreachable; files still land in ${PROJ.dirs.outbox})`
          : 'verified (nonce written inside, read back on the host)';
        // Both halves must hold: the right path delivers AND a wrong one fails
        // loudly. Reporting only the first is how silent loss stayed invisible.
        return d.staleSilent ? `${base}; WARNING: ${d.staleSilent}` : base;
      })(),
      projectOpened: PROJ.path !== os.homedir(),
      gitWorkflow: PROJ.greenfield
        ? {
            newProject: 'This path does not exist on the host yet — ship the WHOLE tree, not a delta patch. There is no host base for format-patch/git am to apply onto.',
            deliver: `PRIMARY, and automatic: the whole tree is already host-visible at ${projectTreeHostPath()}. The user materializes it with \`mkdir -p <project> && cp -r ${projectTreeHostPath()}/. <project>/\`. This works even if the session dies before committing, so delivery is never at risk — everything below is about making the result reviewable, not about saving it.`,
            ignoreFirst: 'BEFORE the first add: write .gitignore covering node_modules/, dist/, build/, target/, .venv/, __pycache__/, .next/, coverage/, *.log, .env. Source and config only — keep the manifest AND the lockfile; the user rebuilds from those. Dependencies and build output must never enter the artifact.',
            init: 'git init && git add -A && git commit -m "initial"  — run only AFTER .gitignore exists; every file lives in the overlay (host untouched)',
            shipOptional: 'SHA=$(git rev-parse --short HEAD); BR=$(git symbolic-ref --quiet --short HEAD) || { git checkout -B main; BR=main; }; rm -f "$KOI_OUTBOX"/project-*.bundle; git bundle create "$KOI_OUTBOX/project-$SHA.bundle" "$BR" HEAD  — OPTIONAL extra: a host-visible, sha-stamped bundle for a clean-history clone. The copy above already delivers the work; skip this rather than run out of budget on it.',
            verify: 'git ls-files | wc -l (expect tens, not thousands) and du -h "$KOI_OUTBOX"/project-*.bundle (expect KB to low MB). A large count or size means .gitignore was written too late — git rm -r --cached the offending dirs, commit, and re-bundle. Also confirm the sha in the bundle filename matches git rev-parse --short HEAD; a mismatch means the export is stale and this session shipped nothing.',
            hostApply: 'cp -r <overlayHostPath>/. <target-dir>/ for the full working tree (default), or git clone "<outbox>/project-<sha>.bundle" <target-dir> for committed history only. Quote the real filename from ls "$KOI_OUTBOX", never the <sha> placeholder',
          }
        : {
            inspect: 'git status / git diff (via sandbox_exec)',
            checkpoint: 'git add -A <paths> && git commit  — lands in the overlay .git only; the host repo is never touched',
            ship: 'git format-patch -o "$KOI_OUTBOX" <base>..HEAD  — patch files appear on the host in the outbox dir',
            nonGitProjects: 'host dir exists but is not a git repo: git init && git add -A && git commit -m baseline, then work and commit; ship the DELTA with git format-patch -o "$KOI_OUTBOX" baseline..HEAD; apply on the host with git apply (NOT git am — there is no repo) onto the existing files',
            hostApply: 'git am <outbox>/*.patch (repo projects), or git apply per file (non-git projects)',
          },
      notes: [
        ...(buildStatus().stale
          ? [`THIS PROCESS IS RUNNING STALE CODE: ${SELF_PATH} has changed on disk since this server loaded it (loaded ${BUILD_LOADED.sha256}, on disk ${readBuildIdentity().sha256}). Any fix in that file is NOT live here. Restart the gateway before trusting behaviour or reporting a bug against the current source — and note that a test suite run from the checkout will pass while this process still misbehaves.`]
          : []),
        ...(verifyOutboxDelivery().staleSilent
          ? [`OUTBOX PATHS FAIL SILENTLY: exports to the CURRENT $KOI_OUTBOX are delivered, but a wrong outbox path does not error — ${verifyOutboxDelivery().staleSilent} This matters because the outbox is keyed by a hash of the project path: it changes at sandbox_open_project and on resume. Re-read it from the LATEST sandbox_info / sandbox_open_project response immediately before every export, and never quote one from an earlier turn.`]
          : []),
        ...(!verifyOutboxDelivery().ok
          ? [`OUTBOX DELIVERY IS BROKEN: a nonce written to $KOI_OUTBOX from inside the sandbox did not appear on the host (${verifyOutboxDelivery().detail}). format-patch / git bundle will still exit 0 and still print paths — they are writing somewhere that never reaches the user. Do NOT claim anything was shipped. The overlay itself is host-visible at ${projectTreeHostPath()}; use that, and tell the user the outbox is broken.`]
          : []),
        ...(LAST_DETACHED && !LAST_DETACHED.deliberate && LAST_DETACHED.session !== PROJ.sessionId
          ? [`DETACHED OVERLAY WITH WORK: at ${LAST_DETACHED.at} this server moved off overlay ${LAST_DETACHED.session} for this project (${LAST_DETACHED.changedFiles ?? 'unknown'} changed file(s)${LAST_DETACHED.gitRefsWritten ? ', overlay git refs' : ''}). It is pinned until ${LAST_DETACHED.pinnedUntil}. ${LAST_DETACHED.action}`]
          : []),
        ...(OVERLAY_RECREATED
          ? ['OVERLAY RECREATED: this session\'s overlay directories had been deleted on the host and were recreated empty. Any writes, commits or services from before that point are GONE, and the session/greenfield/services fields above describe the session as it is NOW, not as it was. Re-check git log and the outbox before trusting continuity notes from an earlier session.']
          : []),
        ...(PROJ.path === os.homedir()
          ? ['NO PROJECT OPENED: currently scoped to $HOME as a placeholder. Call sandbox_open_project({ path }) with the absolute project path before working.']
          : []),
        ...(PROJ.greenfield
          ? [`GREENFIELD: the project path does not exist on the host. Nothing is created on the host by the sandbox — build here. Delivery is automatic and cannot fail: the tree is host-visible at ${projectTreeHostPath()} and the user copies it out. Commit for reviewability; a git bundle is optional. Do NOT use format-patch/git am; there is no host base.`]
          : []),
        ...(LAST_OVERLAY_GC && LAST_OVERLAY_GC.evicted.length
          ? [`OVERLAY CACHE GC: ${LAST_OVERLAY_GC.evicted.length} old session overlay(s) were deleted to stay under the ${LAST_OVERLAY_GC.limitHuman} disk cap (${LAST_OVERLAY_GC.evicted.map((e) => e.label || e.session).join(', ')}). Those sessions can no longer be resumed; exported patches/bundles in the outbox are unaffected.`]
          : []),
        ...(LAST_OVERLAY_GC && LAST_OVERLAY_GC.overBudget
          ? [`DISK PRESSURE: overlay cache is at ${LAST_OVERLAY_GC.usedHuman} against a ${LAST_OVERLAY_GC.limitHuman} cap and only live sessions remain, so nothing more can be reclaimed. Keep large artifacts (node_modules, build output, downloads) out of the overlay and ship finished work to the outbox.`]
          : []),
        'Host PATH is inherited (toolchains via fnm/nvm/rustup/pyenv work if on host PATH).',
        'Code navigation is shell-based: rg for text, ast-grep for structure, the project\'s own compiler/LSP CLI for semantics — all through sandbox_exec, all reading through the overlay. There are no navigation tools on this endpoint.',
        'Each session starts from a FRESH overlay over the host tree (the stable base on disk). Previous sessions do not leak in — pass resume:"<session>" to sandbox_open_project to reattach one deliberately.',
        'Overlay writes may not reach already-running services; use sandbox_restart_service after edits.',
        'git push is blocked; commits are cheap local checkpoints — use them freely.',
        ...(OPTS.net === 'policy' && process.env.KOI_NET_TEST === '1'
          ? ['TEST MODE (KOI_NET_TEST=1): the approval path is live but NOTHING IS ENFORCED — egress is not confined. Do not use this mode for real work.']
          : []),
        ...(OPTS.net === 'policy'
          ? ['NETWORK IS FILTERED: egress goes through a policy proxy. Hosts outside the allowlist prompt the user and block until they answer, so a failing fetch may be a policy denial rather than a network fault — check the error text and call sandbox_network_policy to see the current rules. Do not try to edit the policy file; it is masked from the sandbox.']
          : []),
      ],
    };
  },

  async sandbox_network_policy() {
    if (OPTS.net !== 'policy') {
      return {
        success: true,
        mode: OPTS.net,
        note: OPTS.net === 'host'
          ? 'Egress is unfiltered in host network mode; there is no policy to show.'
          : 'Network is fully disabled (loopback mode).',
      };
    }
    return { success: true, mode: 'policy', ...networkPolicySummary() };
  },

  async overlay_fs_sync() {
    try {
      // 1. Lower-to-Upper Reconciliation: detect host modifications.
      // Shares reconcileLowerToUpper with sandbox_exec deliberately — this used
      // to be a second copy of the same loop, and the two drifted: a fault in
      // one path stayed invisible because the other still worked.
      const rec = reconcileLowerToUpper();
      const hostUpdated = rec.reconciled;
      const report = hostSyncReport(rec);

      // 2. Invalidate disk cache and usage stats
      overlayUsageCache.delete(PROJ.state);
      const budget = overlayBudgetStatus();

      return {
        success: true,
        session: PROJ.sessionId,
        hostMutationsReconciled: hostUpdated,
        ...report,
        ...(rec.failures.length ? {
          reconcileFailures: rec.failures,
          hint: 'Some overlay files could not be refreshed from the host; commands may still read stale content for those paths.',
        } : {}),
        overlayHostPath: projectTreeHostPath(),
        overlayBudget: budget,
        syncedAt: new Date().toISOString(),
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

};


// =============================================================================
// MCP over stdio (newline-delimited JSON-RPC 2.0)
// =============================================================================

process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') { shutdownChildren(); process.exit(0); }
});

function send(msg) {
  try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch { /* client gone */ }
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    switch (method) {
      case 'initialize': {
        // A new conversation = a new session: rotate so every project it opens
        // starts fresh from the host tree (unless it explicitly resumes). A
        // RECONNECT of the same conversation is not a new session — when the
        // client sends the same session key as the previous handshake, keep
        // SESSION_ID and the session's network grants. Without a key the two
        // cannot be told apart, so the old rotate-on-every-handshake behavior
        // stays, and sandbox_open_project warns when that detaches work.
        const key = readSessionKeyFromInit(params);
        const reconnect = key !== null && key === SESSION_KEY;
        SESSION_KEY = key;
        if (reconnect) {
          log(`initialize: same session key — reconnect of session ${SESSION_ID}; overlay and grants kept`);
        } else {
          SESSION_ID = newSessionId();
        }
        // A client that cannot show a dialog must not be asked. Re-read on
        // every initialize: the same pooled server process is reused across
        // connections, and the next client may be a headless one.
        CLIENT_CAN_PROMPT = params?.capabilities?.elicitation !== undefined;
        if (OPTS.net === 'policy' && !CLIENT_CAN_PROMPT) {
          log('client did not declare the elicitation capability — network prompts are unavailable, so anything outside the allowlist will be denied.');
        }
        // Session-scoped network grants belong to the conversation that made
        // them; a new client must not inherit "allow evil.example.com".
        if (!reconnect) NET_BROKER?.resetSession(SESSION_ID);
        // The previous connection's overlay just became garbage — good moment
        // to check the cache budget.
        scheduleOverlayGc('initialize');
        reply({
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'koi-sandbox-shell', version: '2.2.0' },
        });
        break;
      }
      case 'notifications/initialized':
      case 'initialized':
        break; // notification, no reply
      case 'ping':
        reply({});
        break;
      case 'tools/list':
        reply({ tools: TOOLS });
        break;
      case 'tools/call': {
        const { name, arguments: args = {} } = params || {};
        const handler = handlers[name];
        if (handler) {
          try {
            const result = await handler(args);
            reply({
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
              isError: result && result.success === false,
            });
          } catch (e) {
            reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
          }
          break;
        }
        fail(-32602, `Unknown tool: ${name}`);
        break;
      }
      default:
        if (id !== undefined) fail(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    fail(-32603, e.message);
  }
}

let stdinBuf = '';
let inFlight = 0;
let queue = Promise.resolve(); // strict in-order execution of tool calls
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  const lines = stdinBuf.split('\n');
  stdinBuf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    // Reply to a request WE sent (a network-approval elicitation). It must NOT
    // enter the in-order queue: the sandbox_exec whose network access is being
    // approved is sitting at the head of that queue, so queueing the answer
    // behind it deadlocks both, and the approval expires unanswered.
    if (msg.method === undefined && msg.id !== undefined && outbound.has(msg.id)) {
      const settle = outbound.get(msg.id);
      outbound.delete(msg.id);
      try { settle(msg); } catch (e) { log(`approval reply handler threw: ${e.message}`); }
      continue;
    }
    // Handshake and liveness never wait behind a running tool call. A client
    // that reconnects during a long build used to have its `initialize` queued
    // behind that build, time out, and drop again. Neither touches the open
    // project, so answering them immediately cannot race a command.
    if (msg.method === 'initialize' || msg.method === 'ping') {
      handleMessage(msg).catch(() => {});
      continue;
    }
    inFlight++;
    queue = queue.then(() => handleMessage(msg)).catch(() => {}).finally(() => { inFlight--; });
  }
});
process.stdin.on('end', () => {
  // Drain pending tool calls before shutting down.
  const t = setInterval(() => {
    if (inFlight === 0) { clearInterval(t); shutdownChildren(); process.exit(0); }
  }, 50);
});

// Printed at startup so `journalctl --user -u koi-gateway | grep build=` answers
// "which code is the live service running?" without attaching to anything.
log(`build=${BUILD_LOADED.sha256} mtime=${BUILD_LOADED.mtime} file=${BUILD_LOADED.file}`);
log('ready (stdio MCP)');
