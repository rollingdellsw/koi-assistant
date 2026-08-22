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
// setProject, LSP start): review is a pure CLI and must not spawn children.
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
    cmd: 'bwrap',
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
    '  --net host|loopback   host-network visibility for sandboxed processes',
    '                        (default: host — dev servers started inside are visible',
    '                        on localhost so the extension can operate them).',
    '  --allow-creds         allow access to host credentials (~/.ssh, ~/.npmrc, etc)',
    '  --state DIR           state base dir for overlays/sessions (default: ~/.koi/sandbox).',
    '  --max-overlay-size SZ disk cap for ALL session overlays under --state',
    '                        (default 10GB; accepts 10GB/512MB/2g/bytes, 0 = unlimited).',
    '                        Overlays are a cache: over the cap the oldest ones are',
    '                        deleted automatically. The live/in-use overlays and the',
    '                        per-project outbox (exported patches) are never evicted.',
    '  --lsp PATH            code-intelligence (lsp_search) entry to load',
    '                        (default: the bundle shipped next to this script;',
    '                        KOI_LSP_ENTRY overrides).',
    '  --no-lsp              disable the merged LSP tools entirely.',
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
    '  KOI_LSP_ENTRY         override the LSP entry, or set empty to disable LSP.',
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
    state: null,
    // Disk budget for the session-overlay cache under --state. Deployment
    // policy, so it is set in the gateway config (args) or the unit (env);
    // 10GB is a sane default for a dev box that also has to build things.
    maxOverlayBytes: parseSizeSpec(process.env.KOI_SANDBOX_MAX_OVERLAY, DEFAULT_MAX_OVERLAY_BYTES),
    // Code-intelligence child (lsp_search) is now merged into this server. Its
    // compiled entry defaults to the bundle shipped next to this script; the
    // path can be overridden, and an empty value disables LSP entirely.
    lsp: process.env.KOI_LSP_ENTRY !== undefined
      ? process.env.KOI_LSP_ENTRY
      : path.join(SELF_DIR, 'lsp_search', 'dist', 'index.js'),
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
    else if (args[i] === '--state' && args[i + 1]) out.state = path.resolve(args[++i]);
    else if ((args[i] === '--max-overlay-size' || args[i] === '--max-overlay') && args[i + 1]) {
      out.maxOverlayBytes = parseSizeSpec(args[++i], DEFAULT_MAX_OVERLAY_BYTES);
    }
    else if (args[i].startsWith('--max-overlay-size=')) {
      out.maxOverlayBytes = parseSizeSpec(args[i].slice('--max-overlay-size='.length), DEFAULT_MAX_OVERLAY_BYTES);
    }
    else if (args[i] === '--lsp' && args[i + 1]) out.lsp = args[++i];
    else if (args[i] === '--no-lsp') out.lsp = '';
    else if (args[i] === '--exclude' && args[i + 1]) out.exclude.push(args[++i]);
    else if (args[i].startsWith('--exclude=')) out.exclude.push(args[i].slice('--exclude='.length));
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
      const protectedBy = live ? 'live' : (sessionInUse(dir) ? 'in-use' : null);
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

function setProject(projectPath, { resume = null, fresh = false, label = null } = {}) {
  let expandedPath = projectPath;
  if (expandedPath === '~') {
    expandedPath = os.homedir();
  } else if (expandedPath.startsWith('~/')) {
    expandedPath = path.join(os.homedir(), expandedPath.slice(2));
  }
  const p = path.resolve(expandedPath);
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
  Object.assign(PROJ, { path: p, id, state, sessionId, sessionLabel, sessionsRoot, resumed, startedFromHost, hostAbsent, greenfield, dirs });
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

class BwrapBackend {
  constructor() {
    this.name = 'bwrap-overlay';
    this.onProjectChanged();
    const probe = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
    if (probe.error) {
      throw new Error(
        "bubblewrap not found. Install it: sudo apt install bubblewrap\n" +
        "On Ubuntu 24.04, if bwrap fails with a userns permission error, the AppArmor\n" +
        "unprivileged-userns restriction is blocking it; install the bwrap apparmor\n" +
        "profile or set: sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0"
      );
    }
  }

  onProjectChanged() {
    // Greenfield: mount at a sandbox-internal path (empty lower); the real host
    // path does not exist and is never created here.
    this.root = PROJ.hostAbsent ? GREENFIELD_MOUNT : PROJ.path;
    this.outboxInside = '/tmp/koi/outbox'; // bind mount of PROJ.dirs.outbox
  }

  /** Build the argv that runs `shCmd` inside the sandbox. */
  wrap(shCmd, { cwd } = {}) {
    const argv = ['bwrap',
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
      // Outbox stays host-writable so exports survive.
      '--bind', PROJ.dirs.outbox, '/tmp/koi/outbox',
      '--unshare-pid',
      '--die-with-parent',
    ];
    for (const d of CRED_DIRS) argv.push('--tmpfs', d);
    for (const f of CRED_FILES) argv.push('--ro-bind', '/dev/null', f);

    // Make common global caches writable but ephemeral to fix EROFS during installs
    const CACHE_DIRS = ['.npm', '.cargo/registry', '.cache/pip', '.cache/yarn', '.local/share/pnpm', '.gradle/caches'];
    for (const d of CACHE_DIRS) {
      const hostPath = path.join(H, d);
      if (fs.existsSync(hostPath)) {
        argv.push('--overlay-src', hostPath, '--tmp-overlay', hostPath);
      }
    }

    if (OPTS.net === 'loopback') argv.push('--unshare-net'); // lo only, fully offline
    argv.push('--clearenv');
    const env = {
      ...BASE_ENV,
      PATH: composeSandboxPath('/tmp/koi/bin'),
      KOI_OUTBOX: this.outboxInside, // git format-patch -o "$KOI_OUTBOX" lands on the host
    };
    for (const [k, v] of Object.entries(env)) argv.push('--setenv', k, String(v));
    argv.push('--chdir', cwd || this.root);
    argv.push(SHELL_BIN, '-c', shCmd);
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
    const netRules = OPTS.net === 'loopback'
      ? `(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))`
      : '';
    fs.writeFileSync(this.profile, `(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (subpath "${PROJ.dirs.workspace}")
  (subpath "${PROJ.dirs.outbox}")
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
// Merged code intelligence (lsp_search)
// -----------------------------------------------------------------------------
// The LSP search server used to be a separate Gateway endpoint the LLM had to
// wire up by hand (set_workspace, kept in sync with sandbox_open_project). It
// is now spawned and owned by THIS server as a child process, and its tools
// (search / get_references / get_hover / get_implementation /
// get_file_structure / get_lsp_diagnostics) are re-exported through this one
// endpoint. Opening a project (sandbox_open_project) automatically points the
// LSP workspace at it — the session never calls set_workspace itself.
//
// The child is launched with SEARCH_MCP_READONLY=1 so it cannot write to the
// real host tree (search_and_replace is dropped); every mutation still flows
// through the sandbox overlay and leaves only as an exported patch.
// =============================================================================

class LspChild {
  constructor(entry) {
    this.entry = entry;          // compiled lsp_search entry, or '' to disable
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();    // id -> { resolve, reject, timer }
    this.tools = [];             // tools/list from the child (set_workspace removed)
    this.ready = false;          // handshake + tools/list complete
    this.available = false;      // child is up and usable
    this.workspace = null;       // last synced workspace root
    this.lastError = null;
  }

  start() {
    if (!this.entry) { log('lsp: disabled (--no-lsp / empty entry)'); return; }
    if (!fs.existsSync(this.entry)) {
      this.lastError = `entry not found: ${this.entry}`;
      log(`lsp: ${this.lastError} — code-intelligence tools disabled ` +
          '(build it, or pass --lsp <path>/dist/index.js)');
      return;
    }
    const env = { ...process.env, SEARCH_MCP_READONLY: '1' };
    this.proc = spawn('node', [this.entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d) => this._onData(d.toString()));
    this.proc.stderr.on('data', () => { /* child logs to stderr; ignore */ });
    this.proc.on('exit', (code) => {
      this.ready = false; this.available = false;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`lsp child exited (${code})`)); }
      this.pending.clear();
      this.lastError = `child exited (${code})`;
      log(`lsp: ${this.lastError}`);
    });
    this.proc.on('error', (e) => { this.available = false; this.lastError = e.message; log(`lsp: spawn error ${e.message}`); });
    this._init().catch((e) => { this.lastError = e.message; log(`lsp: init failed ${e.message}`); });
  }

  _onData(chunk) {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || 'lsp error'));
        else p.resolve(msg.result);
      }
    }
  }

  _rpc(method, params, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.exitCode !== null) return reject(new Error('lsp child not running'));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`lsp ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  _notify(method, params) {
    try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch { /* gone */ }
  }

  async _init() {
    await this._rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'koi-sandbox-shell', version: '2.2.0' },
    }, 20_000);
    this._notify('notifications/initialized', {});
    const list = await this._rpc('tools/list', {}, 20_000);
    // Hide set_workspace from the LLM: sandbox_open_project drives it.
    this.tools = (list?.tools || []).filter((t) => t.name !== 'set_workspace');
    this.ready = true;
    this.available = true;
    log(`lsp: ready (${this.tools.length} tools)`);
    // If a project was already opened before the child finished booting, sync.
    if (PROJ.path && PROJ.path !== os.homedir()) this.setWorkspace(PROJ.path).catch(() => {});
  }

  async setWorkspace(p) {
    if (!this.ready) return { available: false, reason: this.lastError || 'lsp not ready' };
    try {
      await this._rpc('tools/call', { name: 'set_workspace', arguments: { path: p } }, 30_000);
      this.workspace = p;
      return { available: true, workspace: p };
    } catch (e) {
      return { available: false, error: e.message };
    }
  }

  hasTool(name) { return this.tools.some((t) => t.name === name); }

  call(name, args) { return this._rpc('tools/call', { name, arguments: args || {} }, 120_000); }

  // --- Design 2: editor-style document sync -------------------------------
  // The sandbox overlay is the source of truth for in-session edits, but the
  // language servers index the read-only HOST tree. Rather than have them
  // re-read a mount they can't see, we push the current overlay buffer for
  // each edited file to the child, which forwards didOpen/didChange to the
  // real language server (and keeps an in-memory overlay for text search).
  // This makes navigation/diagnostics reflect unshipped edits without any
  // dependency on overlay mount visibility.
  async syncDocument(absPath, text) {
    if (!this.ready || !this.hasTool('sync_document')) return { synced: false };
    try {
      await this._rpc('tools/call', { name: 'sync_document', arguments: { path: absPath, text } }, 30_000);
      return { synced: true };
    } catch (e) {
      return { synced: false, error: e.message };
    }
  }

  async resetDocuments() {
    if (!this.ready || !this.hasTool('sync_reset')) return { synced: false };
    try {
      await this._rpc('tools/call', { name: 'sync_reset', arguments: {} }, 30_000);
      return { synced: true };
    } catch { return { synced: false }; }
  }

  status() {
    return {
      available: this.available,
      workspace: this.workspace,
      tools: this.tools.map((t) => t.name),
      documentSync: this.hasTool('sync_document'),
      ...(this.available ? {} : { error: this.lastError }),
    };
  }

  stop() { try { this.proc && this.proc.exitCode === null && this.proc.kill('SIGTERM'); } catch { /* ignore */ } }
}

const LSP = new LspChild(OPTS.lsp);
LSP.start();

// =============================================================================
// Overlay -> LSP re-sync
// -----------------------------------------------------------------------------
// Edits reach the overlay through the shell (sandbox_exec), which the LSP
// child never observes, so its buffers are refreshed in bulk instead of
// edit-by-edit: on resuming a previous session's overlay, and on switching
// projects and back (set_workspace clears the child's buffers while the
// overlay keeps the edits).
// This walks the overlay upperdir and re-pushes every plausible text file so
// code intelligence matches what the shell sees. Bounded and best-effort: the
// compiler remains ground truth for anything skipped.
// =============================================================================

const RESYNC_SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'build', 'out', '.next', '.cache', '__pycache__', 'vendor']);
const RESYNC_MAX_FILES = 300;
const RESYNC_MAX_BYTES = 512 * 1024;

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

/**
 * Reconcile lower layer (host) mutations to the upper layer (overlay).
 * Fast, synchronous local check run before mutating tool handlers.
 *
 * Only files present in BOTH layers are refreshed: a host file with no overlay
 * copy is not shadowed, so overlayfs already shows it through the lower layer.
 *
 * Never throws. This runs at the head of sandbox_exec, where an exception would
 * surface as the shell command itself failing — a maintenance step must not be
 * able to take out the tool call it precedes.
 */
function reconcileLowerToUpper() {
  const hostRoot = PROJ.path;
  const upperDir = projectTreeHostPath();
  if (!hostRoot || !upperDir || !fs.existsSync(hostRoot) || !fs.existsSync(upperDir)) {
    return { reconciled: 0, files: [], failures: [] };
  }
  if (process.platform === 'darwin' && typeof BACKEND !== 'undefined' && BACKEND?.ensureGitAlternates) {
    BACKEND.ensureGitAlternates();
  }
  const files = [];
  const failures = [];
  try {
    for (const rel of collectOverlayFiles(upperDir)) {
      const hostFile = path.join(hostRoot, rel);
      const upperFile = path.join(upperDir, rel);
      try {
        // statSync + ENOENT beats an existsSync pair: one syscall each, and no
        // window between the check and the copy.
        const hostStat = fs.statSync(hostFile);
        const upperStat = fs.statSync(upperFile);
        if (!hostStat.isFile() || hostStat.mtimeMs <= upperStat.mtimeMs) continue;
        copyHostFileOverUpper(hostFile, upperFile, hostStat.mode);
        files.push(rel);
      } catch (e) {
        if (e.code === 'ENOENT') continue; // present in only one layer
        failures.push({ path: rel, error: e.message });
      }
    }
  } catch (e) {
    failures.push({ path: '(walk)', error: e.message });
  }
  if (failures.length) {
    log(`reconcile: ${failures.length} file(s) could NOT be refreshed from the host — ` +
      `the sandbox may be reading stale content: ` +
      failures.slice(0, 5).map((f) => `${f.path} (${f.error})`).join('; ') +
      (failures.length > 5 ? `; +${failures.length - 5} more` : ''));
  }
  if (SYNC_DEBUG) {
    log(`reconcile: ${files.length} refreshed, ${failures.length} failed` +
      (files.length ? ` [${files.slice(0, 20).join(', ')}${files.length > 20 ? ', …' : ''}]` : ''));
  }
  return { reconciled: files.length, files, failures };
}

function collectOverlayFiles(upperDir, relBase = '', acc = []) {
  if (acc.length >= RESYNC_MAX_FILES) return acc;
  let entries;
  try { entries = fs.readdirSync(path.join(upperDir, relBase), { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (acc.length >= RESYNC_MAX_FILES) break;
    const rel = relBase ? path.join(relBase, e.name) : e.name;
    if (e.isDirectory()) {
      if (RESYNC_SKIP_DIRS.has(e.name)) continue;
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
      collectOverlayFiles(upperDir, rel, acc);
    } else if (e.isFile()) {
      acc.push(rel);
    }
    // Anything else (overlayfs whiteouts are char devices) is skipped.
  }
  return acc;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Push overlay upperdir contents into the LSP buffers. Returns a summary. */
async function resyncOverlayToLsp() {
  if (!LSP.ready || !LSP.hasTool('sync_document')) return { resynced: 0, skipped: 0, reason: 'document sync unavailable' };
  const upper = projectTreeHostPath();
  if (!upper || !fs.existsSync(upper)) return { resynced: 0, skipped: 0 };
  const rels = collectOverlayFiles(upper);
  let resynced = 0, skipped = 0;
  for (const rel of rels) {
    try {
      if (rel.startsWith('.git/')) { skipped++; continue; }
      const st = fs.statSync(path.join(upper, rel));
      if (!st.isFile() || st.size > RESYNC_MAX_BYTES) { skipped++; continue; }
      const buf = fs.readFileSync(path.join(upper, rel));
      if (looksBinary(buf)) { skipped++; continue; }
      const r = await LSP.syncDocument(path.join(PROJ.path, rel), buf.toString('utf8'));
      if (r.synced) resynced++; else skipped++;
    } catch { skipped++; }
  }
  const capped = rels.length >= RESYNC_MAX_FILES;
  return { resynced, skipped, ...(capped ? { capped: true } : {}) };
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

function execInSandbox(shCmd, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, outputCap = OUTPUT_CAP } = {}) {
  ensureSessionDirs();
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


function shutdownChildren() { stopAllServices(); try { LSP.stop(); } catch { /* ignore */ } }
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
      'Working directory defaults to the project root. Returns exit code, stdout, stderr.',
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
    name: 'sandbox_start_service',
    tier: 'mutating',
    description:
      'Start a long-running command (dev server, test watcher) inside the sandbox as a named background service. ' +
      'In host network mode its ports are reachable on localhost, so the browser can open the app directly. ' +
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
    description: 'Open a project directory on the host: sets the writable overlay location, working directory, relative path root, and points code intelligence (LSP) at the same project. New sessions start each project FRESH from the host tree; re-opening within this session CONTINUES its overlay. Pass resume to reattach a previous session overlay (see sandbox_info.priorSessions), or fresh:true to force a clean overlay mid-session. Existing running services are NOT stopped.',
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
    description: 'Synchronizes the gateway overlay filesystem and language server buffers to ensure the host, overlay, and LSP states are aligned.',
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
      // A failed refresh means this command may have read a stale file. Say so
      // rather than letting the session act on content it cannot tell is old.
      ...(rec.failures.length ? {
        syncWarning: `${rec.failures.length} file(s) could not be refreshed from the host and may be stale: ` +
          rec.failures.slice(0, 5).map((f) => f.path).join(', '),
      } : {}),
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
      note: OPTS.net === 'host'
        ? 'Ports opened by this service are reachable at http://localhost:<port> from the browser. After overlay edits, call sandbox_restart_service before expecting UI changes.'
        : 'loopback mode: service ports are isolated inside the sandbox network namespace.',
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
      setProject(p, { resume, fresh, label });
      // A fresh overlay means the LSP's edit buffers must be cleared too so
      // code intelligence reflects the host tree, not a stale session.
      if (PROJ.startedFromHost || fresh) await LSP.resetDocuments().catch(() => {});
      // Point code-intelligence at the same project automatically — the
      // session no longer calls set_workspace itself. Non-blocking failure:
      // the sandbox is fully usable even if LSP is unavailable.
      const lsp = await LSP.setWorkspace(PROJ.path);
      // Overlay already has edits (RESUMED, or CONTINUING after a workspace
      // switch cleared the LSP buffers): re-push them so code intelligence
      // matches what the shell sees. Best-effort and bounded.
      let resync;
      if (!PROJ.startedFromHost && !fresh) {
        resync = await resyncOverlayToLsp().catch(() => undefined);
      }
      const prior = listProjectSessions(PROJ.sessionsRoot).filter((s) => s.id !== PROJ.sessionId);
      const baseKind = PROJ.resumed ? 'RESUMED' : (PROJ.startedFromHost ? 'FRESH' : 'CONTINUING');
      const gfNote = PROJ.greenfield
        ? `GREENFIELD: this path does not exist on the host. The overlay is empty and the host is untouched — build the project from scratch here. DELIVERY IS ALREADY GUARANTEED: everything you write lands in ${projectTreeHostPath()} on the host, and the user is handed \`cp -r <that>/. <project>/\` at the end of the run, whether or not you commit, export, or finish. So do not spend budget protecting the work from being lost — it cannot be. Do still \`git init\`, WRITE .gitignore FIRST (node_modules/, dist/, build/, target/, .venv/, __pycache__/, .next/, coverage/, *.log, .env), then \`git add -A && git commit\`: that is what makes the result REVIEWABLE rather than a directory the user has to excavate. Optionally also \`SHA=$(git rev-parse --short HEAD); BR=$(git symbolic-ref --quiet --short HEAD) || { git checkout -B main; BR=main; }; rm -f "$KOI_OUTBOX"/project-*.bundle; git bundle create "$KOI_OUTBOX/project-$SHA.bundle" "$BR" HEAD\` for a clean-history clone; never a bare project.bundle (a fixed name overwrites silently, and a bundle carrying only HEAD clones detached). format-patch/git am do NOT apply — there is no host base to apply a delta onto.`
        : null;
      const baseNote = gfNote || {
        FRESH: 'FRESH session: overlay is empty; you are working from the host tree exactly as it exists on disk (the stable base the user sees).',
        CONTINUING: 'CONTINUING this connection\'s session: reusing the overlay you already opened here (your in-progress edits are present).',
        RESUMED: 'RESUMED a previous session overlay (edits from that session are present on top of the host tree).',
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
        ...(resync ? { lspResync: resync } : {}),
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
        note: (baseKind === 'FRESH'
          ? 'New empty overlay activated; code intelligence pointed at the same project.'
          : baseKind === 'CONTINUING'
            ? 'Existing session overlay reactivated; code intelligence pointed at the same project.'
            : 'Resumed overlay activated; code intelligence pointed at the same project.')
          + (prior.length ? ` ${prior.length} other session overlay(s) exist for this project — pass resume:"<session>" to reattach one, otherwise they are ignored.` : ''),
        codeIntelligence: lsp.available
          ? { available: true, tools: LSP.tools.map((t) => t.name), documentSync: LSP.hasTool('sync_document'), note: 'search / get_references / get_hover / get_implementation / get_file_structure / get_lsp_diagnostics are ready (indexing may warm up in the background for Rust/C++).' }
          : { available: false, reason: lsp.reason || lsp.error || 'lsp not available', note: 'Fall back to shell rg/grep for navigation.' },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  async sandbox_reset() {
    BACKEND.reset();
    overlayUsageCache.delete(PROJ.state); // the freed space must show up immediately
    await LSP.resetDocuments().catch(() => {});
    return { success: true, session: PROJ.sessionId, note: 'overlay/workspace wiped back to host state; in-overlay git commits are gone (patches already in the outbox survive); LSP edit buffers cleared' };
  },

  async sandbox_info() {
    return {
      backend: BACKEND.name,
      platform: process.platform,
      project: PROJ.path,
      sandboxRoot: BACKEND.root,
      network: OPTS.net,
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
      maskedCredentials: [...CRED_DIRS, ...CRED_FILES],
      services: listRunningServices(),
      servicesAll: listAllServices(),
      outboxInside: BACKEND.outboxInside,
      projectOpened: PROJ.path !== os.homedir(),
      codeIntelligence: LSP.status(),
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
        ...(OVERLAY_RECREATED
          ? ['OVERLAY RECREATED: this session\'s overlay directories had been deleted on the host and were recreated empty. Any writes, commits or services from before that point are GONE, and the session/greenfield/services fields above describe the session as it is NOW, not as it was. Re-check git log and the outbox before trusting continuity notes from an earlier session.']
          : []),
        ...(PROJ.path === os.homedir()
          ? ['NO PROJECT OPENED: currently scoped to $HOME as a placeholder. Call sandbox_open_project({ path }) with the absolute project path before working — this also points code intelligence (LSP) at the project automatically; no separate set_workspace call is needed.']
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
        'Each session starts from a FRESH overlay over the host tree (the stable base on disk). Previous sessions do not leak in — pass resume:"<session>" to sandbox_open_project to reattach one deliberately.',
        'Overlay writes may not reach already-running services; use sandbox_restart_service after edits.',
        'git push is blocked; commits are cheap local checkpoints — use them freely.',
      ],
    };
  },

  async overlay_fs_sync() {
    try {
      // 1. Lower-to-Upper Reconciliation: detect host modifications.
      // Shares reconcileLowerToUpper with sandbox_exec deliberately — this used
      // to be a second copy of the same loop, and the two drifted: a fault in
      // one path stayed invisible because the other still worked.
      const rec = reconcileLowerToUpper();
      const hostUpdated = rec.reconciled;

      // 2. Resync reconciled overlay files into LSP memory buffers
      let lspResync;
      if (LSP.available && !PROJ.startedFromHost) {
        lspResync = await resyncOverlayToLsp().catch((err) => ({ error: err.message }));
      }

      // 3. Invalidate disk cache and usage stats
      overlayUsageCache.delete(PROJ.state);
      const budget = overlayBudgetStatus();

      return {
        success: true,
        session: PROJ.sessionId,
        hostMutationsReconciled: hostUpdated,
        ...(rec.failures.length ? {
          reconcileFailures: rec.failures,
          hint: 'Some overlay files could not be refreshed from the host; commands may still read stale content for those paths.',
        } : {}),
        overlayHostPath: projectTreeHostPath(),
        lspResync: lspResync || { status: 'up-to-date' },
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
      case 'initialize':
        // A new client connection = a new session. Rotate so every project
        // opened on this connection starts fresh from the host tree (unless the
        // caller explicitly resumes). This holds even when the gateway pools
        // this process across connections.
        SESSION_ID = newSessionId();
        // The previous connection's overlay just became garbage — good moment
        // to check the cache budget.
        scheduleOverlayGc('initialize');
        reply({
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'koi-sandbox-shell', version: '2.2.0' },
        });
        break;
      case 'notifications/initialized':
      case 'initialized':
        break; // notification, no reply
      case 'ping':
        reply({});
        break;
      case 'tools/list':
        // Sandbox tools + re-exported code-intelligence tools from the child.
        reply({ tools: [...TOOLS, ...LSP.tools] });
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
        // Forward code-intelligence tools to the merged LSP child verbatim
        // (the child already returns the MCP { content, isError } shape).
        if (LSP.hasTool(name)) {
          try {
            const result = await LSP.call(name, args);
            reply(result);
          } catch (e) {
            reply({ content: [{ type: 'text', text: `Error (code intelligence): ${e.message}` }], isError: true });
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

log('ready (stdio MCP)');