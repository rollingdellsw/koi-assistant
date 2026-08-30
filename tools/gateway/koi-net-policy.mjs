// =============================================================================
// koi-net-policy.mjs — network egress policy engine + approval broker
// -----------------------------------------------------------------------------
// Two consumers, one file:
//
//   * koi-net-acl.mjs  (Squid external ACL helper) — evaluates every request
//     Squid cannot decide from its own static ACLs, and asks the broker when
//     the policy says "ask".
//   * sandbox-shell-mcp.mjs — hosts the broker: a unix-socket server that
//     turns an "ask" into an MCP elicitation request on the live client
//     connection (the Chrome extension), and writes the answer back.
//
// The enforcement itself is NOT here. That is pasta (namespace networking),
// nftables (default-drop, proxy only) and Squid (the proxy). This file is only
// the decision layer those tools call out to — the part that has to know about
// the user.
//
// Policy file format (~/.koi/network-policy.json):
//   {
//     "version": 1,
//     "default": "ask" | "deny" | "allow",
//     "rules": [
//       { "host": "*.npmjs.org", "ports": [80, 443], "decision": "allow",
//         "source": "default" | "user", "note": "..." }
//     ]
//   }
//
// Matching: `deny` rules are evaluated before `allow` rules, so an explicit
// deny always wins regardless of file order. Host patterns are exact names or
// a single leading `*.` wildcard (`*.example.com` also matches
// `example.com`). Omitted `ports` means every port.
// =============================================================================

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

export const KOI_HOME = process.env.KOI_HOME || path.join(os.homedir(), '.koi');
export const DEFAULT_POLICY_PATH =
  process.env.KOI_NETWORK_POLICY || path.join(KOI_HOME, 'network-policy.json');
/** Broker socket. Not per-session: Squid and its helper outlive one session. */
export const DEFAULT_BROKER_SOCK =
  process.env.KOI_NETWORK_SOCK || path.join(KOI_HOME, 'approval.sock');

const VALID_DECISIONS = new Set(['allow', 'deny', 'ask']);

// -----------------------------------------------------------------------------
// Policy file
// -----------------------------------------------------------------------------

export function emptyPolicy() {
  return { version: 1, default: 'ask', rules: [] };
}

/**
 * Parse an allowlist in the `sandbox-exclude.default` style: one host pattern
 * per line, `#` comments, blank lines ignored. An optional `:port,port` suffix
 * narrows the rule. This is the file the installer ships and the user edits.
 */
export function parseAllowFile(text) {
  const rules = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const m = /^(!?)([^\s:]+)(?::([\d,]+))?$/.exec(line);
    if (!m) continue;
    const [, bang, host, ports] = m;
    rules.push({
      host,
      ...(ports ? { ports: ports.split(',').map(Number).filter(Number.isFinite) } : {}),
      decision: bang === '!' ? 'deny' : 'allow',
      source: 'default',
    });
  }
  return rules;
}

export function loadPolicy(file = DEFAULT_POLICY_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return emptyPolicy();
  }
  const policy = emptyPolicy();
  if (VALID_DECISIONS.has(parsed?.default)) policy.default = parsed.default;
  if (Array.isArray(parsed?.rules)) {
    for (const r of parsed.rules) {
      if (typeof r?.host !== 'string' || !VALID_DECISIONS.has(r?.decision)) continue;
      if (r.decision === 'ask') continue; // "ask" is the default, not a rule
      policy.rules.push({
        host: r.host,
        ...(Array.isArray(r.ports) ? { ports: r.ports.map(Number).filter(Number.isFinite) } : {}),
        decision: r.decision,
        source: r.source === 'default' ? 'default' : 'user',
        ...(r.note ? { note: String(r.note) } : {}),
        ...(r.addedAt ? { addedAt: String(r.addedAt) } : {}),
      });
    }
  }
  return policy;
}

/** Atomic write — a torn policy file is indistinguishable from "no policy". */
export function savePolicy(policy, file = DEFAULT_POLICY_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(policy, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Create the policy file from the shipped allowlist if it does not exist yet.
 * Never overwrites: once the user has edited their policy it is theirs.
 */
export function ensurePolicy(file = DEFAULT_POLICY_PATH, allowFile = null) {
  if (fs.existsSync(file)) return loadPolicy(file);
  const policy = emptyPolicy();
  if (allowFile !== null) {
    try {
      policy.rules = parseAllowFile(fs.readFileSync(allowFile, 'utf8'));
    } catch { /* ship an empty (all-ask) policy rather than failing to boot */ }
  }
  savePolicy(policy, file);
  return policy;
}

// -----------------------------------------------------------------------------
// Matching
// -----------------------------------------------------------------------------

export function hostMatches(pattern, host) {
  const p = String(pattern).toLowerCase().replace(/\.$/, '');
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return h === base || h.endsWith('.' + base);
  }
  return h === p;
}

export function ruleMatches(rule, host, port) {
  if (!hostMatches(rule.host, host)) return false;
  if (Array.isArray(rule.ports) && rule.ports.length > 0) {
    return rule.ports.includes(Number(port));
  }
  return true;
}

/**
 * Decide a single request. `sessionRules` are in-memory grants from this
 * session's approvals; they are consulted after the file's explicit denies so
 * a session grant can never override a standing deny.
 */
export function evaluate(policy, { host, port }, sessionRules = []) {
  const all = [...policy.rules, ...sessionRules];
  for (const r of all) {
    if (r.decision === 'deny' && ruleMatches(r, host, port)) {
      return { decision: 'deny', rule: r };
    }
  }
  for (const r of all) {
    if (r.decision === 'allow' && ruleMatches(r, host, port)) {
      return { decision: 'allow', rule: r };
    }
  }
  return { decision: policy.default, rule: null };
}

/** Add (or replace) a rule for `host` and persist. Returns the new policy. */
export function upsertRule(policy, rule, file = DEFAULT_POLICY_PATH) {
  const next = {
    ...policy,
    rules: policy.rules.filter(
      (r) => !(r.host === rule.host && r.decision === rule.decision && r.source === 'user'),
    ),
  };
  next.rules.push({ ...rule, source: 'user', addedAt: new Date().toISOString() });
  savePolicy(next, file);
  return next;
}

// -----------------------------------------------------------------------------
// Broker (server side — lives in sandbox-shell-mcp.mjs)
// -----------------------------------------------------------------------------

/**
 * Unix-socket server the ACL helper talks to.
 *
 * Asks are SERIALISED. The side panel holds exactly one pending confirmation
 * (`useBackgroundMessages` has a single state slot), so a second dialog would
 * silently replace the first and strand its resolver until the 5-minute
 * timeout. A parallel `npm install` produces bursts of these, so they queue —
 * and identical host:port asks that arrive while one is pending share its
 * answer instead of prompting twice.
 */
export class ApprovalBroker {
  /**
   * @param {object} opts
   * @param {string} opts.socketPath
   * @param {(req: object) => Promise<{decision: string, scope: string}>} opts.asker
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ socketPath = DEFAULT_BROKER_SOCK, asker, log = () => {} }) {
    this.socketPath = socketPath;
    this.asker = asker;
    this.log = log;
    this.server = null;
    this.clients = new Set();
    this.queue = Promise.resolve();
    this.inFlight = new Map(); // "host:port" -> Promise<decision>
  }

  start() {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    try { fs.unlinkSync(this.socketPath); } catch { /* not there */ }
    this.server = net.createServer((sock) => this._onClient(sock));
    this.server.on('error', (e) => this.log(`approval broker error: ${e.message}`));
    this.server.listen(this.socketPath, () => {
      // Only this user's helper may ask. The socket is the one channel that can
      // pop a dialog, so it must not be world-writable.
      try { fs.chmodSync(this.socketPath, 0o600); } catch { /* best effort */ }
      this.log(`approval broker listening at ${this.socketPath}`);
    });
    return this;
  }

  /** Tell connected helpers to drop session-scoped grants. */
  resetSession(sessionId) {
    const line = JSON.stringify({ type: 'session_reset', session: sessionId }) + '\n';
    for (const c of this.clients) {
      try { c.write(line); } catch { /* helper went away */ }
    }
  }

  stop() {
    for (const c of this.clients) { try { c.destroy(); } catch { /* ignore */ } }
    this.clients.clear();
    try { this.server?.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
  }

  _onClient(sock) {
    this.clients.add(sock);
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'ask') void this._handleAsk(sock, msg);
      }
    });
    sock.on('error', () => { /* helper restarts are normal */ });
    sock.on('close', () => this.clients.delete(sock));
  }

  async _handleAsk(sock, msg) {
    const key = `${msg.host}:${msg.port}`;
    let pending = this.inFlight.get(key);
    if (pending === undefined) {
      // Chain onto the queue so only one dialog is ever open at a time.
      pending = this.queue.then(() => this.asker(msg)).catch((e) => ({
        decision: 'deny',
        scope: 'once',
        reason: e instanceof Error ? e.message : String(e),
      }));
      this.inFlight.set(key, pending);
      this.queue = pending.then(() => {}, () => {});
      pending.then(
        () => this.inFlight.delete(key),
        () => this.inFlight.delete(key),
      );
    }
    const answer = await pending;
    const reply = {
      type: 'decision',
      id: msg.id,
      decision: answer.decision === 'allow' ? 'allow' : 'deny',
      scope: ['once', 'session', 'always'].includes(answer.scope) ? answer.scope : 'once',
      ...(answer.reason ? { reason: answer.reason } : {}),
    };
    try { sock.write(JSON.stringify(reply) + '\n'); } catch { /* helper gone */ }
  }
}

// -----------------------------------------------------------------------------
// Broker client (used by the ACL helper)
// -----------------------------------------------------------------------------

export class ApprovalClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.socketPath]
   * @param {number} [opts.timeoutMs] How long to hold the proxy request open.
   *   Deliberately well under any proxy-side limit: Squid answers the client
   *   itself if it gives up first, and a 500 from Squid is much harder to act
   *   on than our own "approve it and retry" message.
   */
  constructor({ socketPath = DEFAULT_BROKER_SOCK, timeoutMs = 45_000 } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.sock = null;
    this.pending = new Map();
    /**
     * Asks we stopped waiting for but that the user may still answer. Keeping
     * them means a slow answer is not thrown away: the grant is recorded, so
     * the retry the user is about to make succeeds instead of prompting again.
     */
    this.late = new Map();
    this.onSessionReset = () => {};
  }

  /** Resolves false when no broker is listening (no session attached). */
  async connect() {
    if (this.sock !== null && !this.sock.destroyed) return true;
    return new Promise((resolve) => {
      const sock = net.createConnection(this.socketPath);
      let buf = '';
      const fail = () => { this.sock = null; resolve(false); };
      sock.once('error', fail);
      sock.once('connect', () => {
        sock.removeListener('error', fail);
        sock.on('error', () => this._drop());
        sock.on('close', () => this._drop());
        sock.on('data', (chunk) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            if (line.trim() === '') continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.type === 'session_reset') { this.onSessionReset(msg.session); continue; }
            const p = this.pending.get(msg.id);
            if (p !== undefined) { this.pending.delete(msg.id); p(msg); continue; }
            const l = this.late.get(msg.id);
            if (l !== undefined) { this.late.delete(msg.id); l(msg); }
          }
        });
        this.sock = sock;
        resolve(true);
      });
    });
  }

  _drop() {
    this.sock = null;
    for (const [, resolve] of this.pending) {
      resolve({ decision: 'deny', scope: 'once', reason: 'approval channel closed' });
    }
    this.pending.clear();
    this.late.clear();
  }

  /**
   * Ask the user. Denies (never hangs) when nothing is listening.
   *
   * @param {object} req
   * @param {(msg: object) => void} [req.onLate] Called if the answer arrives
   *   after we gave up, so the decision can still be recorded.
   */
  async ask({ host, port, method, uri, onLate }) {
    const ok = await this.connect();
    if (!ok) {
      return { decision: 'deny', scope: 'once', reason: 'no approval channel (no session attached)' };
    }
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The dialog is still open on the other side. Park a late handler so
        // the user's eventual answer is not silently discarded.
        if (typeof onLate === 'function') this.late.set(id, onLate);
        resolve({
          decision: 'deny',
          scope: 'once',
          timedOut: true,
          reason: 'still waiting for your approval — answer the prompt, then run this again',
        });
      }, this.timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      try {
        this.sock.write(JSON.stringify({ type: 'ask', id, host, port, method, uri }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ decision: 'deny', scope: 'once', reason: `ask failed: ${e.message}` });
      }
    });
  }

  close() {
    try { this.sock?.destroy(); } catch { /* ignore */ }
    this.sock = null;
  }
}
