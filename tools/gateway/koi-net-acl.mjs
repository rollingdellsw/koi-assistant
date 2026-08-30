#!/usr/bin/env node
// =============================================================================
// koi-net-acl.mjs — Squid external ACL helper for sandbox egress
// -----------------------------------------------------------------------------
// Squid spawns this and speaks its documented helper protocol on stdin/stdout:
//
//   with concurrency=N:   <channel-id> SP <field> SP <field> ... LF
//   reply:                <channel-id> SP OK|ERR [SP key="value"]... LF
//
// The fields are whatever koi-squid.conf's `external_acl_type` format string
// asks for; this helper expects, in order:  %DST %PORT %METHOD %URI
// Squid percent-encodes each field, so they are decoded before use.
//
// Decision order:
//   1. policy file explicit deny        -> ERR
//   2. policy file / session allow      -> OK
//   3. policy default                   -> ERR (deny) / OK (allow)
//   4. policy default "ask"             -> ask the user via the broker socket,
//                                          then persist per the chosen scope
//
// Fail-closed everywhere: an unreadable policy file means "ask", and an ask
// with no session attached means deny. The sandbox never silently gets out.
//
// Standalone use (no Squid) for testing:
//   echo '1 github.com 443 CONNECT github.com:443' | node koi-net-acl.mjs
// =============================================================================

import fs from 'fs';
import path from 'path';
import {
  DEFAULT_POLICY_PATH, DEFAULT_BROKER_SOCK,
  loadPolicy, evaluate, upsertRule, ApprovalClient,
} from './koi-net-policy.mjs';

function parseArgs(argv) {
  // How long a request is held open waiting for a human.
  //
  // Short on purpose. Squid gives up on a slow helper on its own schedule and
  // answers the client with a bare 500, which tells the user nothing and looks
  // identical for "you clicked Deny" and "you clicked Allow". Answering well
  // inside that window means the message the user sees is ours. The prompt is
  // NOT cancelled — a late click is still recorded (see onLate in decide()), so
  // "approve it, run it again" always works.
  //
  // Raise it with KOI_APPROVAL_TIMEOUT_MS or --timeout-ms if your proxy is
  // configured to wait longer and you would rather the command just proceed.
  const out = {
    policy: DEFAULT_POLICY_PATH,
    sock: DEFAULT_BROKER_SOCK,
    timeoutMs: Number(process.env.KOI_APPROVAL_TIMEOUT_MS) || 60_000,
    debug: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--policy' && argv[i + 1]) out.policy = path.resolve(argv[++i]);
    else if (argv[i] === '--sock' && argv[i + 1]) out.sock = path.resolve(argv[++i]);
    else if (argv[i] === '--timeout-ms' && argv[i + 1]) out.timeoutMs = Number(argv[++i]);
    else if (argv[i] === '--debug') out.debug = true;
    else if (argv[i] === '-h' || argv[i] === '--help') { usage(); process.exit(0); }
  }
  return out;
}

function usage() {
  process.stdout.write([
    'usage: koi-net-acl.mjs [--policy FILE] [--sock PATH] [--timeout-ms MS] [--debug]',
    '',
    '  Squid external ACL helper. Reads "[id] DST PORT METHOD URI" lines on stdin,',
    '  writes "[id] OK" / "[id] ERR message=..." on stdout.',
    '',
    `  --policy      policy file (default ${DEFAULT_POLICY_PATH})`,
    `  --sock        approval broker socket (default ${DEFAULT_BROKER_SOCK})`,
    '  --timeout-ms  how long to hold a request waiting for the user (default 60000,',
    '                or KOI_APPROVAL_TIMEOUT_MS). A late answer is still recorded,',
    '                so a slower click means "retry", not "denied".',
  ].join('\n') + '\n');
}

const OPTS = parseArgs(process.argv.slice(2));

const debug = (msg) => { if (OPTS.debug) process.stderr.write(`[koi-net-acl] ${msg}\n`); };

/** Squid URL-encodes helper fields; `-` means "not available". */
function unesc(field) {
  if (field === undefined || field === '-') return '';
  try { return decodeURIComponent(field); } catch { return field; }
}

// Reloaded when the file's mtime changes so a user edit (or an "always" grant
// written by another helper process) takes effect without restarting Squid.
let policy = loadPolicy(OPTS.policy);
let policyMtime = statMtime(OPTS.policy);

function statMtime(f) {
  try { return fs.statSync(f).mtimeMs; } catch { return 0; }
}

function currentPolicy() {
  const m = statMtime(OPTS.policy);
  if (m !== policyMtime) {
    policy = loadPolicy(OPTS.policy);
    policyMtime = m;
    debug('policy reloaded');
  }
  return policy;
}

/** Session-scoped grants. Cleared when the broker reports a new session. */
let sessionRules = [];

const approvals = new ApprovalClient({ socketPath: OPTS.sock, timeoutMs: OPTS.timeoutMs });
approvals.onSessionReset = (session) => {
  sessionRules = [];
  debug(`session reset (${session}) — session grants cleared`);
};

/**
 * `CONNECT github.com:443` carries no method or path: over TLS the proxy sees
 * the host and nothing else. Direction (pull vs push) is therefore unknowable
 * without ssl_bump, and the dialog says so rather than offering a choice that
 * cannot be enforced.
 */
function describe(host, port, method) {
  return method === 'CONNECT' || method === ''
    ? `${host}:${port} (TLS tunnel — request direction not visible)`
    : `${method} ${host}:${port}`;
}

async function decide(host, port, method, uri) {
  if (host === '') return { ok: false, message: 'no destination host' };

  const verdict = evaluate(currentPolicy(), { host, port }, sessionRules);
  if (verdict.decision === 'allow') {
    debug(`allow ${host}:${port} (rule ${verdict.rule?.host ?? 'default'})`);
    return { ok: true };
  }
  if (verdict.decision === 'deny') {
    return {
      ok: false,
      message: verdict.rule
        ? `blocked by network policy rule '${verdict.rule.host}'`
        : 'blocked by network policy default=deny',
    };
  }

  // Recording a decision is the same work whether it arrived while the request
  // was still open or long after the proxy gave up on it, so it lives in one
  // place that both paths call.
  const applyScope = (a) => {
    const rule = { host, decision: a.decision === 'allow' ? 'allow' : 'deny' };
    if (a.scope === 'session') {
      sessionRules.push({ ...rule, source: 'session' });
    } else if (a.scope === 'always') {
      try {
        policy = upsertRule(currentPolicy(), rule, OPTS.policy);
        policyMtime = statMtime(OPTS.policy);
      } catch (e) {
        debug(`could not persist rule: ${e.message}`);
        sessionRules.push({ ...rule, source: 'session' }); // degrade to session scope
      }
    }
  };

  const answer = await approvals.ask({
    host,
    port,
    method,
    uri,
    summary: describe(host, port, method),
    // The prompt outlives the request. Squid will not hold a connection open
    // indefinitely, so we answer first and let the click land afterwards —
    // without this the user's approval is silently thrown away and the retry
    // asks all over again.
    onLate: (a) => {
      debug(`late answer ${host}:${port} -> ${a.decision}/${a.scope}`);
      applyScope(a);
    },
  });
  debug(`ask ${host}:${port} -> ${answer.decision}/${answer.scope}`);

  // A timeout is not a decision: recording it would write a `deny` rule for a
  // question the user is still looking at.
  if (answer.timedOut !== true) applyScope(answer);

  return answer.decision === 'allow'
    ? { ok: true }
    : { ok: false, message: answer.reason ?? 'denied by user' };
}

// -----------------------------------------------------------------------------
// Helper protocol loop
// -----------------------------------------------------------------------------

function reply(channel, res) {
  const body = res.ok
    ? 'OK'
    : `ERR message=${JSON.stringify(res.message ?? 'denied')}`;
  process.stdout.write(channel === null ? `${body}\n` : `${channel} ${body}\n`);
}

async function handleLine(line) {
  const parts = line.trim().split(/\s+/);
  // With concurrency=N Squid prefixes a numeric channel id. Detect it rather
  // than requiring the operator to keep two configs in sync.
  const hasChannel = /^\d+$/.test(parts[0]) && parts.length > 1;
  const channel = hasChannel ? parts[0] : null;
  const fields = hasChannel ? parts.slice(1) : parts;

  const host = unesc(fields[0]).toLowerCase();
  const port = Number(unesc(fields[1])) || 443;
  const method = unesc(fields[2]).toUpperCase();
  const uri = unesc(fields[3]);

  try {
    reply(channel, await decide(host, port, method, uri));
  } catch (e) {
    reply(channel, { ok: false, message: `policy helper error: ${e.message}` });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  // Deliberately NOT awaited in order: Squid's concurrency mode exists so a
  // helper can answer out of order, and one parked approval must not stall
  // every other request behind it.
  for (const line of lines) if (line.trim() !== '') void handleLine(line);
});
process.stdin.on('end', () => { approvals.close(); process.exit(0); });
process.on('SIGTERM', () => { approvals.close(); process.exit(0); });
