// ============================================================
// freecad_mcp.js — the freecad-live bridge, native transport.
//
// This talks to a FreeCAD process running on the user's own machine, through
// an HTTP endpoint that koi_bridge.py opens *inside* that process. The browser
// tab, when there is one, shows a WebRTC/KasmVNC stream of that FreeCAD's real
// Qt window: the human clicks in it, this file writes to it, and both are the
// same document in the same interpreter.
//
// It used to drive a WebAssembly build of FreeCAD in the tab. That transport is
// gone, and the reasons are worth keeping written down, because they are the
// reasons this file's shape still makes sense:
//
//   * A snippet that did not return froze the wasm main thread with no way to
//     interrupt it from JS. The only exit was a tab reload, which cost the user
//     a ~277 MB load AND their unsaved document. That failure mode is why the
//     old code carried a sticky `wedged` flag: it could not recover, so it gave
//     up loudly. Native FreeCAD survives the same snippet — the process lives,
//     the document is on disk, and the next call is allowed to try. `wedged`
//     is replaced by `busy`, which is a fact rather than a funeral.
//   * The rendezvous. freecad_run_python returns an int, so structured output
//     had to leave through MEMFS or a tagged print. The bridge returns the
//     payload in the HTTP response.
//   * The 250 ms poll floor. Every exec cost at least one poll interval, by
//     construction, a dozen times a turn. The bridge answers when the job is
//     done.
//   * MEMFS did not survive the tab, so export was the only persistence the
//     user had. Now a save is a save.
//   * The wasm build shipped a subset of workbenches. What is available here is
//     whatever the user's FreeCAD has — which is a question with an answer, so
//     scripts/test_native.js asks it rather than assuming.
//
// What did NOT change, and must not: everything above execPython. koi_cad, the
// transaction envelope, the whitelist and its two-sided contract, the
// fingerprint resolver, lint, the BOM. Those were never about wasm.
//
// ---- The evidence model -------------------------------------
//
// "Which build is this?" still has three independent answers that fail
// independently, so all three are still collected and reported separately —
// they just point at different things now:
//
//   runtime   — App.ConfigGet("BuildRevisionHash") etc., read out of the live
//               interpreter. Authoritative, and now more so than before: it is
//               the same process the human is looking at.
//   deploy    — the FreeCAD install the bridge is running inside, reported by
//               /hello. Survives the interpreter being too busy to answer.
//   transport — the bridge itself: protocol version, pid, GUI or headless, and
//               the size and mtime of the binary on disk. Needs no document and
//               no interpreter call at all.
//
// The pin is compared against all three, and it matters MORE on native than it
// did on a frozen wasm mirror. A mirrored deploy was bytes on a disk that
// nobody touched. An install moves under `apt upgrade`, `docker pull latest`
// or an AppImage swap — without anybody deciding to change CAD behaviour that
// day. `pin-mode: strict` turns drift into a refusal at attach.
// ============================================================

// --- Constants -----------------------------------------------

// Where koi_bridge.py listens. Loopback on purpose and in both halves: the
// bridge binds 127.0.0.1 so nothing off-machine can reach it, and this is the
// address that binding produces.
//
// An MCP script runs in a sandboxed iframe with no chrome.* APIs and no
// sockets, so runtime.fetch is the only way out of it. That is why the bridge
// is HTTP over loopback rather than a Unix socket or `docker exec`: those are
// not reachable from here, whatever a container diagram says.
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8765";

// The wire contract between this file and tools/koi_bridge.py. Bumped when the
// shape of /exec or /hello changes; the bridge reports its own and attach
// refuses a mismatch rather than letting it surface three calls later as a
// missing field.
const BRIDGE_PROTOCOL = 1;

// /hello is a liveness check, not a boot. If nothing answers this fast, there
// is nothing there — FreeCAD is not running, or it is running without the
// macro.
const BRIDGE_HELLO_TIMEOUT = 4000; // ms

// Attach waits for the interpreter, which on a cold FreeCAD start is a few
// seconds, not the three minutes a 277 MB wasm load used to need.
const ATTACH_TIMEOUT = 60000; // ms
const EXEC_TIMEOUT = 20000; // ms

// The optional stream tab: KasmVNC/Selkies serving the FreeCAD desktop. The
// bridge does not need it and never talks to it — it exists so the human can
// see and touch the model.
const DEFAULT_STREAM_URL = null;

// --- Session state -------------------------------------------

const state = {
  bridgeUrl: null, // origin koi_bridge.py listens on
  bridgeToken: null, // shared secret, if the bridge was started with one
  bridgeSource: null, // "argument" | "skill-config" | "default"
  streamUrl: null, // optional WebRTC/VNC view of the same FreeCAD
  bridge: null, // /hello, once read: protocol, pid, gui, app, fingerprint
  pin: null, // { version, commit, fingerprint, mode }
  pinSource: null,
  attached: false,
  // A job the bridge told us is still on the GUI thread. Deliberately NOT
  // sticky: the old wasm `wedged` flag was permanent because a frozen wasm main
  // thread could only be cleared by a reload that destroyed the document.
  // Native FreeCAD comes back. Refusing forever would be a lie about a process
  // that is still alive.
  busy: null,
  koiCadVersion: null, // set once the in-process module is loaded
  koiCadRevived: 0,    // times the module had to be re-bootstrapped mid-session
  koiCadOps: null, // op names the process reported, checked against OP_SPECS
  koiCadFile: null, // where the process actually imported it from
  koiCadReplacedStale: false, // a previous session's module was evicted
  build: null, // runtime layer, once read
  deploy: null, // deploy layer (the install the bridge runs inside)
  transport: null, // transport layer (the bridge itself)
  pinStatus: null, // { match, drift: [...] }
  jobSeq: 0,
};

// --- Bridge configuration ------------------------------------
//
// The endpoint is configuration, not code. A bridge on another port, a bridge
// inside a container with a published port, and the default are one case with
// a different origin.

function serverConfig() {
  try {
    return (typeof runtime !== "undefined" && runtime.config) || {};
  } catch (_) {
    return {};
  }
}

// How a SKILL.md key reaches a server entry is not contractually fixed — the
// frontmatter spells it `bridge-url`, a parser may camelCase or snake_case it,
// or nest author keys under config:/options:. Look in all of them; the cost is
// a few property reads and the alternative is a setting that silently does
// nothing.
function configValue(cfg, name) {
  const hyphen = name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  const snake = name.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
  const scopes = [cfg, cfg && cfg.config, cfg && cfg.options, cfg && cfg.settings];
  for (const scope of scopes) {
    if (!scope || typeof scope !== "object") continue;
    for (const key of [name, hyphen, snake]) {
      if (scope[key] !== undefined) return scope[key];
    }
  }
  return undefined;
}

function serverConfigKeys() {
  const cfg = serverConfig();
  const keys = Object.keys(cfg);
  for (const nested of ["config", "options", "settings"]) {
    if (cfg[nested] && typeof cfg[nested] === "object") {
      keys.push(...Object.keys(cfg[nested]).map((k) => nested + "." + k));
    }
  }
  return keys;
}

/** Accepts "127.0.0.1:8765", "http://127.0.0.1:8765" or a trailing slash. */
function normalizeBridgeUrl(input) {
  let base = String(input == null ? "" : input).trim();
  const eq = base.indexOf("=");
  if (eq !== -1 && base.slice(0, eq).indexOf("/") === -1) base = base.slice(eq + 1).trim();
  if ((base[0] === '"' && base.endsWith('"')) || (base[0] === "'" && base.endsWith("'"))) {
    base = base.slice(1, -1).trim();
  }
  base = base || DEFAULT_BRIDGE_URL;
  if (!/^https?:\/\//i.test(base)) base = "http://" + base;
  let u;
  try {
    u = new URL(base);
  } catch (_) {
    throw new Error(
      "Invalid bridge URL: " + base + ". Pass an absolute URL, e.g. " + DEFAULT_BRIDGE_URL
    );
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Bridge URL must be http(s): " + base);
  }
  return u.origin;
}

function bridgeConfig() {
  if (!state.bridgeUrl) {
    const cfg = serverConfig();
    const configured = configValue(cfg, "bridgeUrl");
    state.bridgeUrl = normalizeBridgeUrl(configured || DEFAULT_BRIDGE_URL);
    state.bridgeSource = configured ? "skill-config" : "default";
    const tok = configValue(cfg, "bridgeToken");
    state.bridgeToken = tok ? String(tok) : null;
    const stream = configValue(cfg, "streamUrl");
    state.streamUrl = stream ? String(stream).trim() : DEFAULT_STREAM_URL;
  }
  return {
    bridgeUrl: state.bridgeUrl,
    tokenSet: !!state.bridgeToken,
    streamUrl: state.streamUrl,
    source: state.bridgeSource,
  };
}

function setBridgeConfig(args) {
  bridgeConfig(); // resolve defaults first so a partial set does not wipe them
  if (args.bridgeUrl !== undefined) {
    state.bridgeUrl = normalizeBridgeUrl(args.bridgeUrl);
    state.bridgeSource = "argument";
  }
  if (args.bridgeToken !== undefined) {
    state.bridgeToken = args.bridgeToken ? String(args.bridgeToken) : null;
  }
  if (args.streamUrl !== undefined) {
    state.streamUrl = args.streamUrl ? String(args.streamUrl).trim() : null;
  }
  // Pointing at a different FreeCAD invalidates every layer of evidence, the
  // attach, and the koi_cad that was loaded into the old process.
  state.bridge = null;
  state.build = null;
  state.deploy = null;
  state.transport = null;
  state.pinStatus = null;
  state.attached = false;
  state.koiCadVersion = null;
  state.koiCadFile = null;
  state.koiCadReplacedStale = false;
  state.busy = null;
  return bridgeConfig();
}

// --- The pin -------------------------------------------------

function pinConfig() {
  if (!state.pin) {
    const cfg = serverConfig();
    const version = configValue(cfg, "pinVersion");
    const commit = configValue(cfg, "pinCommit");
    const fingerprint = configValue(cfg, "pinFingerprint");
    const mode = String(configValue(cfg, "pinMode") || "warn").toLowerCase();
    state.pin = {
      version: version ? String(version) : null,
      commit: commit ? String(commit) : null,
      fingerprint: fingerprint ? String(fingerprint) : null,
      mode: ["off", "warn", "strict"].indexOf(mode) === -1 ? "warn" : mode,
    };
    state.pinSource = version || commit || fingerprint ? "skill-config" : "unset";
  }
  return state.pin;
}

function setPin(args) {
  pinConfig();
  if (args.pinVersion !== undefined) state.pin.version = args.pinVersion || null;
  if (args.pinCommit !== undefined) state.pin.commit = args.pinCommit || null;
  if (args.pinFingerprint !== undefined) {
    state.pin.fingerprint = args.pinFingerprint || null;
  }
  if (args.pinMode !== undefined) {
    const m = String(args.pinMode).toLowerCase();
    if (["off", "warn", "strict"].indexOf(m) === -1) {
      throw new Error("pinMode must be off, warn or strict");
    }
    state.pin.mode = m;
  }
  state.pinSource = "argument";
  state.pinStatus = null;
  return state.pin;
}

// Commit hashes get abbreviated at every layer that touches them (git, the
// build system, a human copying one into YAML), so compare by prefix on the
// shorter of the two rather than demanding string equality.
function commitMatches(pinned, actual) {
  if (!pinned || !actual) return null;
  const a = String(pinned).toLowerCase();
  const b = String(actual).toLowerCase();
  const n = Math.min(a.length, b.length);
  if (n < 7) return a === b;
  return a.slice(0, n) === b.slice(0, n);
}

/**
 * Compare the pin against every layer of evidence that was actually collected.
 * A layer that could not be read is not a mismatch — it is an absence, and the
 * two need different responses (fix the server vs. stop and re-probe).
 */
function evaluatePin() {
  const pin = pinConfig();
  const drift = [];
  const missing = [];

  const version =
    (state.build && state.build.exeVersion) ||
    (state.deploy && state.deploy.app && state.deploy.app.version) ||
    null;
  const commit =
    (state.build && state.build.commit) ||
    (state.deploy && state.deploy.app && state.deploy.app.commit) ||
    null;
  const fingerprint =
    (state.deploy && state.deploy.fingerprint) ||
    (state.transport && state.transport.fingerprint) ||
    null;

  if (pin.version) {
    if (!version) missing.push("version");
    else if (String(version) !== String(pin.version)) {
      drift.push({ field: "version", pinned: pin.version, actual: version });
    }
  }
  if (pin.commit) {
    if (!commit) missing.push("commit");
    else if (commitMatches(pin.commit, commit) === false) {
      drift.push({ field: "commit", pinned: pin.commit, actual: commit });
    }
  }
  if (pin.fingerprint) {
    if (!fingerprint) missing.push("fingerprint");
    else if (String(fingerprint) !== String(pin.fingerprint)) {
      drift.push({ field: "fingerprint", pinned: pin.fingerprint, actual: fingerprint });
    }
  }

  const pinned = !!(pin.version || pin.commit || pin.fingerprint);
  state.pinStatus = {
    pinned,
    mode: pin.mode,
    // null, not false, when nothing is pinned. `false` reads as "the build
    // disagrees with the pin", which is a different and much louder claim than
    // "there is no pin", and the gate in run.js branches on exactly this.
    match: pinned ? drift.length === 0 && missing.length === 0 : null,
    drift,
    unverifiable: missing,
    observed: { version, commit, fingerprint },
  };
  return state.pinStatus;
}

/**
 * The YAML to paste into SKILL.md. K0's deliverable is not a report that a
 * version was observed — it is the deploy actually being pinned, and a skill
 * script cannot write SKILL.md, so it hands back the exact block instead.
 */
function pinBlock() {
  const observed = (state.pinStatus && state.pinStatus.observed) || {};
  const cfg = bridgeConfig();
  const lines = [
    "mcp-servers:",
    "  - name: freecad_bridge",
    "    script: mcp/freecad_mcp.js",
    "    bridge-url: " + cfg.bridgeUrl,
  ];
  if (cfg.streamUrl) lines.push("    stream-url: " + cfg.streamUrl);
  if (observed.version) lines.push("    pin-version: \"" + observed.version + "\"");
  if (observed.commit) lines.push("    pin-commit: \"" + observed.commit + "\"");
  if (observed.fingerprint) {
    lines.push("    pin-fingerprint: \"" + observed.fingerprint + "\"");
  }
  lines.push("    pin-mode: strict");
  return lines.join("\n");
}

// --- The bridge ----------------------------------------------
//
// One request per call, and the whole surface is three endpoints:
//
//   GET  /hello   who is there: protocol, pid, GUI or headless, the FreeCAD
//                 it is inside, and a fingerprint of the binary on disk.
//   POST /exec    run this Python on the thread that owns the document.
//   GET  /file    read back something export wrote, so the user can save it
//                 out of the browser without a filesystem dialog.
//
// The dispatch rule that used to be about JSPI is now about Qt, and it survives
// unchanged in substance: the snippet runs on the thread that owns the
// document, never on the HTTP worker. FreeCAD's Python is not thread-safe, and
// a document mutated off the GUI thread is a crash with a stack trace that
// blames the wrong line. koi_bridge.py marshals; this side just waits.

/**
 * One request to the bridge.
 *
 * runtime.fetch is a proxy through the extension background, so loopback is
 * reachable and CORS does not apply to us — which is also exactly why the
 * bridge sends no CORS headers: a random page attempting the same POST is
 * stopped by the browser before it arrives.
 *
 * The GET fallback exists because `body` support in the proxy cannot be
 * verified from inside this sandbox, and a transport whose only path fails at
 * the first POST is not a transport.
 */
async function bridgeFetch(path, payload, timeoutMs) {
  const cfg = bridgeConfig();
  const url = cfg.bridgeUrl + path;
  const headers = { "Content-Type": "application/json" };
  if (state.bridgeToken) headers["X-Koi-Token"] = state.bridgeToken;
  const opts = {
    skipAuth: true,
    headers,
    timeoutMs: timeoutMs || BRIDGE_HELLO_TIMEOUT,
  };
  if (payload !== undefined && payload !== null) {
    opts.method = "POST";
    opts.body = JSON.stringify(payload);
  }
  let res;
  // No urlencoded fallback. It used to retry a failed POST as
  // ?payload=...&token=..., which put the shared secret in a query string --
  // into shell history, access logs, browser history and Referer headers --
  // and, worse, made every bridge call issuable as a simple request: no custom
  // header, so no CORS preflight, so any page the human happened to be
  // visiting could drive an interpreter that executes arbitrary Python. A
  // fallback that downgrades authentication is worse than the failure it was
  // covering for, so the failure is now reported instead.
  res = await runtime.fetch(url, opts);
  if (!res) throw new Error("no response from the bridge at " + url);
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    /* non-JSON body — reported below alongside the status */
  }
  if (!res.ok) {
    const err = (json && (json.error || json.detail)) || "HTTP " + res.status;
    const wrapped = new Error(err);
    wrapped.status = res.status;
    wrapped.body = json;
    throw wrapped;
  }
  return json;
}

/**
 * Ask the bridge who it is.
 *
 * Cheap, needs no document, and it is the whole of discovery. The wasm build
 * needed a shape-based hunt across `window` for an Emscripten module whose
 * global name was nobody's contract; here, something answering /hello with a
 * protocol number is a FreeCAD process with the macro loaded, and nothing else
 * is.
 */
async function readBridgeHello(refresh) {
  if (state.bridge && !refresh) return state.bridge;
  const cfg = bridgeConfig();
  try {
    const hello = await bridgeFetch("/hello", null, BRIDGE_HELLO_TIMEOUT);
    if (!hello || hello.ok !== true) {
      state.bridge = {
        available: false,
        url: cfg.bridgeUrl,
        error: (hello && hello.error) || "the endpoint answered without ok:true",
      };
      return state.bridge;
    }
    state.bridge = Object.assign({ available: true, url: cfg.bridgeUrl }, hello);
  } catch (e) {
    state.bridge = {
      available: false,
      url: cfg.bridgeUrl,
      status: e.status || null,
      error: e.message,
    };
  }
  return state.bridge;
}

function bridgeDownMessage(detail) {
  const cfg = bridgeConfig();
  const b = state.bridge || {};
  return (
    "No FreeCAD bridge is answering at " + cfg.bridgeUrl +
    (detail || b.error ? " (" + (detail || b.error) + ")" : "") +
    ".\n\nStart FreeCAD with the bridge macro loaded:\n\n" +
    "    freecad tools/koi_bridge.py        # GUI — the co-design case\n" +
    "    freecadcmd tools/koi_bridge.py     # headless, no human in the loop\n\n" +
    "It has to run inside the FreeCAD the human is looking at. A second " +
    "interpreter started next to it — `docker exec ... freecadcmd script.py` — " +
    "has its own document, and nothing built there ever appears on their screen."
  );
}

/**
 * What the bridge last said was running. Advisory ONLY — nothing refuses on it.
 *
 * The first version of this file gated every tool on it, and that reproduced
 * the exact defect the transport change was meant to remove. The wasm `wedged`
 * flag was sticky because a frozen main thread could not clear itself; this one
 * was sticky for a stupider reason — the only thing that cleared it was a
 * successful call, and the gate refused to make one. A six-second sleep locked
 * the session out permanently, which is worse than what it replaced, because at
 * least the wasm build was telling the truth.
 *
 * The bridge is the authority on whether the bridge is busy. It answers 409 in
 * microseconds without touching the document, so asking it is cheap and asking
 * a cached flag is wrong. Every call goes out. This value exists to be
 * *reported* — in freecad_probe, in freecad_config, and in the error text when
 * a 409 comes back — and never to decide anything.
 */
function busyNote() {
  if (!state.busy) return null;
  const since = state.busy.since ? " since " + state.busy.since : "";
  return "a job has been on the FreeCAD thread" + since;
}

/**
 * Run a Python snippet in the FreeCAD process and return what it produced.
 *
 * The snippet is still responsible for serialising its own errors — see
 * wrapPython — because a traceback that only reaches FreeCAD's report view is
 * a traceback this side cannot read.
 */
// The module can go away underneath us, and until now nothing noticed.
//
// ensureKoiCad caches state.koiCadVersion and returns early on every call
// after the first. That is right when the FreeCAD it bootstrapped is the
// FreeCAD still running -- and wrong the moment that process restarts. The
// module lives in a temp directory on sys.path of THAT interpreter; a restart
// takes both with it, while this server goes on believing 0.7.1 is loaded.
// Every subsequent call then dies with ModuleNotFoundError, forever, with no
// path back except reloading the extension. A full test run reported one pass
// out of sixteen for exactly this reason, and not one line of the output said
// "FreeCAD restarted" -- because nothing here knew.
//
// A cached fact about another process is a fact with an expiry date nobody
// can see. So: notice the specific error, re-run the bootstrap once, and
// retry. If the reload fails, say what happened rather than passing an import
// error up as if it were the answer to the question that was asked.
const KOI_MISSING_RE = /No module named ['"]koi_cad['"]/;
let koiReviving = false;

async function execPython(body, timeoutMs) {
  const first = await execPythonOnce(body, timeoutMs);
  const d = first && first.data;
  if (!d || d.ok !== false || !KOI_MISSING_RE.test(String(d.error || ""))) {
    return first;
  }
  // Guarded, because the bootstrap snippet imports koi_cad too: without this
  // a FreeCAD that cannot load the module at all would recurse until the
  // stack ran out instead of reporting why.
  if (koiReviving) return first;

  koiReviving = true;
  let boot;
  try {
    state.koiCadVersion = null;
    state.koiCadFile = null;
    boot = await ensureKoiCad(true);
  } catch (e) {
    throw new Error(
      "koi_cad is not loaded in the FreeCAD this server is attached to, and " +
        "re-loading it failed: " + e.message + " The usual cause is that " +
        "FreeCAD restarted since the last call — the module lives in a temp " +
        "directory on that process's sys.path and goes with it. Nothing was " +
        "lost in the document; ask the user to confirm FreeCAD is up, then " +
        "call freecad_attach again."
    );
  } finally {
    koiReviving = false;
  }

  const again = await execPythonOnce(body, timeoutMs);
  state.koiCadRevived = (state.koiCadRevived || 0) + 1;
  try {
    runtime.console.warn(
      "freecad_mcp: koi_cad had vanished from the FreeCAD process; " +
        "re-bootstrapped " + boot + " and retried."
    );
  } catch (_) { /* console is best-effort */ }
  const data = again && again.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    // Said out loud on the first reply after a revive, because a restarted
    // FreeCAD is not the one that held the baseline: the turn diff, the
    // isolate record and every koi id that was never saved to disk went with
    // the old process. Reporting the call as ordinary would hide that.
    data.bridgeReloaded = true;
    data.bridgeReloadedNote =
      "koi_cad was missing from the FreeCAD process and was re-loaded before " +
      "this call, which almost always means FreeCAD restarted. The user-diff " +
      "baseline is gone, so this turn cannot tell what the human changed, and " +
      "any koi id from before the restart only survives if the document was " +
      "saved. Re-read the document before editing it.";
  }
  return again;
}

async function execPythonOnce(body, timeoutMs) {
  const budget = timeoutMs || EXEC_TIMEOUT;
  const id = "koi" + ++state.jobSeq + "_" + Date.now();
  let res;
  try {
    res = await bridgeFetch(
      "/exec",
      { id, code: wrapPython(body), timeoutMs: budget },
      // The transport waits a little longer than the job so that a job hitting
      // its own deadline reports as a deadline rather than as a dead socket.
      budget + 5000
    );
  } catch (e) {
    if (e.status === 409) {
      const running = (e.body && e.body.running) || { since: null };
      state.busy = running;
      throw new Error(
        "FreeCAD is busy: " + ((e.body && e.body.error) || e.message) +
          (running.elapsedMs ? " (" + running.elapsedMs + "ms so far)" : "") +
          ". Nothing was lost and nothing is stuck — the refusal came from the " +
          "bridge, not from a cached flag here, so simply calling again once " +
          "the job returns will work."
      );
    }
    if (e.status === 504) {
      state.busy = (e.body && e.body.running) || { since: null };
      throw new Error(
        "The snippet outran its " + budget + "ms budget and is still running on " +
          "the FreeCAD GUI thread. The process survives it, the document is on " +
          "disk, and calls will be accepted again once it returns — but nothing " +
          "here can interrupt work inside the geometry kernel, so send bounded " +
          "loops."
      );
    }
    if (e.status === 401 || e.status === 403) {
      throw new Error(
        "The bridge rejected the token. A 401 here means the bridge is up and " +
          "guarded, not that it is broken. Ask the user to open Skills \u2192 " +
          "freecad-live \u2192 Run and enter bridgeUrl and bridgeToken there " +
          "\u2014 do not ask them to paste the token into the chat, where it " +
          "would be stored in the transcript. The value is the " +
          "KOI_BRIDGE_TOKEN the bridge was started with; on the documented " +
          "deploy, `grep KOI_BRIDGE_TOKEN ~/freecad-stream/bridge.env` on the " +
          "FreeCAD host."
      );
    }
    state.bridge = null;
    state.attached = false;
    throw new Error(bridgeDownMessage(e.message));
  }
  // The bridge answered, so it was not busy. True whether the snippet itself
  // succeeded or raised.
  state.busy = null;
  if (!res || res.ok !== true) {
    throw new Error("the bridge refused the snippet: " + ((res && res.error) || "unknown"));
  }
  if (res.payload == null) {
    throw new Error(
      "The bridge ran the snippet (rc=" + res.rc + ") and it produced no " +
        "payload. Every snippet is wrapped to produce one, so this is a bridge " +
        "bug rather than a Python error."
    );
  }
  try {
    return { data: JSON.parse(res.payload), channel: "bridge", rc: res.rc, ms: res.ms };
  } catch (_) {
    throw new Error("the bridge payload was not JSON: " + String(res.payload).slice(0, 200));
  }
}

function wrapPython(body) {
  // Indented into a function so a snippet can `return` a dict, and wrapped so
  // an exception arrives typed instead of as a return code.
  //
  // There is no rendezvous file and no tagged print any more: those existed
  // because freecad_run_python returns an int and the payload had to leave
  // through MEMFS or stdout. The bridge reads _koi_s out of the namespace it
  // exec'd into. A stray /tmp/koi_fc_out.json on somebody's real filesystem
  // would be worse than useless.
  const indented = body
    .split("\n")
    .map((l) => "    " + l)
    .join("\n");
  return (
    "import json as _koi_json\n" +
    "def _koi_body():\n" +
    indented +
    "\n" +
    "try:\n" +
    "    _koi_d = _koi_body()\n" +
    "except Exception as _koi_e:\n" +
    "    _koi_d = {'ok': False, 'error': '%s: %s' % (type(_koi_e).__name__, _koi_e)}\n" +
    "_koi_s = _koi_json.dumps(_koi_d)\n"
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Evidence collection -------------------------------------

const VERSION_PY = [
  "import sys",
  "try:",
  "    import FreeCAD as App",
  "except Exception as e:",
  "    return {'ok': False, 'error': 'FreeCAD not importable: %s' % e}",
  "def cg(k):",
  "    try:",
  "        return App.ConfigGet(k) or ''",
  "    except Exception:",
  "        return ''",
  "occ = ''",
  "try:",
  "    import Part",
  "    occ = str(getattr(Part, 'OCC_VERSION', ''))",
  "except Exception:",
  "    pass",
  "gui = False",
  "try:",
  "    import FreeCADGui",
  "    gui = bool(FreeCADGui.getMainWindow())",
  "except Exception:",
  "    pass",
  "return {",
  "    'ok': True,",
  "    'exeVersion': cg('ExeVersion'),",
  "    'major': cg('BuildVersionMajor'),",
  "    'minor': cg('BuildVersionMinor'),",
  "    'point': cg('BuildVersionPoint'),",
  "    'suffix': cg('BuildVersionSuffix'),",
  "    'revision': cg('BuildRevision'),",
  "    'commit': cg('BuildRevisionHash'),",
  "    'branch': cg('BuildRevisionBranch'),",
  "    'buildDate': cg('BuildRevisionDate'),",
  "    'version': list(App.Version()),",
  "    'python': sys.version.split()[0],",
  "    'occt': occ,",
  "    'guiUp': gui,",
  "}",
].join("\n");

async function readRuntimeBuild() {
  const res = await execPython(VERSION_PY, EXEC_TIMEOUT);
  const d = res.data || {};
  if (!d.ok) throw new Error("version probe failed in Python: " + (d.error || "unknown"));
  // ExeVersion is "26.3"; the suffix ("dev") is what distinguishes a
  // development snapshot from a release and belongs in the pinned string.
  const composed =
    d.exeVersion && d.suffix && String(d.exeVersion).indexOf(d.suffix) === -1
      ? d.exeVersion + d.suffix
      : d.exeVersion;
  state.build = {
    exeVersion: composed || d.exeVersion || null,
    commit: d.commit || null,
    branch: d.branch || null,
    buildDate: d.buildDate || null,
    revision: d.revision || null,
    version: d.version || null,
    python: d.python || null,
    occt: d.occt || null,
    guiUp: !!d.guiUp,
    channel: res.channel,
    readAt: new Date().toISOString(),
  };
  return state.build;
}

/**
 * The deploy and transport layers, both out of /hello.
 *
 * They are still two layers rather than one because they still fail
 * independently in the way that matters: the transport layer says a bridge is
 * there and which one, and it answers even when the interpreter is mid-recompute
 * and the runtime layer cannot. The deploy layer says which FreeCAD that bridge
 * is inside — the binary, its size and its mtime — which is the layer that
 * catches an `apt upgrade` or a re-pulled container image that leaves the
 * version string alone and moves the behaviour.
 */
async function readBridgeEvidence(refresh) {
  const hello = await readBridgeHello(refresh);
  if (!hello.available) {
    const err = hello.error || "no bridge";
    state.deploy = { available: false, url: hello.url, error: err };
    state.transport = { available: false, url: hello.url, error: err };
    return hello;
  }
  const app = hello.app || {};
  state.deploy = {
    available: true,
    kind: "install",
    url: hello.url,
    app: {
      version: app.version || null,
      commit: app.commit || null,
      branch: app.branch || null,
      buildDate: app.buildDate || null,
      occt: app.occt || null,
      python: app.python || null,
      exe: app.exe || null,
      // The file the fingerprint was taken from, which is not the same as the
      // thing that launched the process — see _core_path() in koi_bridge.py.
      core: app.core || null,
      resourceDir: app.resourceDir || null,
    },
    fingerprint: hello.fingerprint || null,
    note:
      "There is no koi-build.json because there is no deploy directory. The " +
      "binary on disk is the deploy, and its size and mtime are the fingerprint.",
  };
  state.transport = {
    available: true,
    kind: "bridge",
    url: hello.url,
    protocol: hello.protocol,
    pid: hello.pid,
    gui: !!hello.gui,
    mode: hello.mode || (hello.gui ? "gui" : "headless"),
    started: hello.started || null,
    exe: app.exe || null,
    core: app.core || null,
    bytes: hello.exeBytes != null ? String(hello.exeBytes) : null,
    lastModified: hello.exeModified || null,
    exportDir: hello.exportDir || null,
    // Whether a handover is possible at all. Collected here, with the rest of
    // the evidence, so it is known at attach rather than at the moment
    // somebody needs it.
    exportWritable: hello.exportWritable !== false,
    exportError: hello.exportError || null,
    tokenRequired: !!hello.tokenRequired,
    fingerprint: hello.fingerprint || null,
  };
  const insecure = insecureBridgeWarning();
  if (insecure) state.bridge.insecureTransport = insecure;
  return hello;
}

/**
 * The token authenticates a channel that runs arbitrary Python. Over loopback
 * or an SSH tunnel, plain HTTP is fine — the bytes never touch a wire. Pointed
 * at another machine over http://, every call ships the secret and the whole
 * document in the clear to anyone on the path, and the deployment guide's own
 * advice is a tunnel. Worth saying once per attach rather than never.
 */
function insecureBridgeWarning() {
  let host;
  try {
    host = new URL(state.bridgeUrl || DEFAULT_BRIDGE_URL);
  } catch (_) {
    return null;
  }
  if (host.protocol !== "http:") return null;
  const h = host.hostname;
  const loopback =
    h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" ||
    /^127\./.test(h);
  if (loopback) return null;
  return (
    "the bridge is " + host.origin + ": plain HTTP to another host, so the " +
    "token and every document travel the network in the clear. Tunnel it " +
    "(ssh -N -L 8765:127.0.0.1:8765 user@host) and point bridge-url at " +
    "http://localhost:8765, or terminate TLS in front of it."
  );
}

function protocolStatus() {
  const b = state.bridge || {};
  if (!b.available) return { ok: false, expected: BRIDGE_PROTOCOL, found: null };
  return {
    ok: Number(b.protocol) === BRIDGE_PROTOCOL,
    expected: BRIDGE_PROTOCOL,
    found: b.protocol == null ? null : Number(b.protocol),
  };
}

// --- Tools ---------------------------------------------------

// --- koi_cad: the in-process runtime ---------------------------
//
// Shipped as a string and written into the FreeCAD process's temp dir at
// bootstrap rather than kept in a .py file beside this one. There is no way for
// an MCP server to read its own skill directory, and duplicating the source in
// two places is how the two copies drift. One definition, here.
//
// None of this changed when the transport did, and that is the point: it was
// never about WebAssembly. Everything in it is still a probe result rather than
// a plan, and every result below was measured on the pinned build:
//
//   envelope     App.setActiveTransaction / closeActiveTransaction. The
//                Document-level pair is a silent no-op on abort while the GUI
//                owns a transaction, which is the normal co-editing state.
//   entry gate   HasPendingTransaction, sealed deliberately before we start.
//   guiBusy      first statement inside the mutating call, never at sync().
//   undo         measured and reported, never promised — the same call booked
//                1 entry in one run and 0 in the next.
//   lint         measures. A pocket that removed nothing reported Up-to-date
//                and isValid(), and errors land on the feature, not the Body.
//   loops        every one bounded. The cost of an unbounded one is lower than
//                it was — the process survives, the document is on disk — but
//                it still holds the GUI thread, and the human is watching that
//                window freeze while it runs.

const KOI_CAD_PY = String.raw`
VERSION = "0.9.0"

import json as _json
import math as _math

import FreeCAD as App

try:
    import FreeCADGui as Gui
except Exception:
    Gui = None

DRAIN_LIMIT = 8


class GuiBusy(Exception):
    pass


class KoiOpError(Exception):
    """A bad request: named, so the dispatcher can say what was wrong."""
    pass


class KoiTimeout(Exception):
    """A script that ran past its deadline. See _exec_with_deadline."""
    pass


# ---------- GUI gate (K6) ----------

def gui_state():
    dlg = False
    in_edit = None
    if Gui is not None:
        try:
            dlg = bool(Gui.Control.activeDialog())
        except Exception:
            dlg = False
        try:
            if Gui.ActiveDocument is not None:
                v = Gui.ActiveDocument.getInEdit()
                if v is not None:
                    # str() of a view provider varies between builds; the
                    # object name is the part worth reporting.
                    obj = getattr(v, "Object", None)
                    in_edit = getattr(obj, "Name", None) or "unknown"
        except Exception:
            in_edit = None
    return {"activeDialog": dlg, "inEdit": in_edit, "busy": bool(dlg or in_edit)}


def gate():
    st = gui_state()
    if st["busy"]:
        raise GuiBusy(
            "the user has an edit session open (%s)"
            % (st["inEdit"] or "dialog")
        )
    return st


# ---------- transactions ----------

def _pending(doc):
    try:
        v = doc.HasPendingTransaction
        return bool(v() if callable(v) else v)
    except Exception:
        return None


def seal(doc):
    # Closing the user's in-flight transaction turns their work into an undo
    # entry they still own. Non-destructive, and it is the only way to stop our
    # transaction from landing inside theirs.
    # Force the commit boundary first: closing an active transaction that holds
    # only the user's work turns it into an undo entry of their own, which is
    # where it belonged before we opened anything.
    closed = False
    try:
        App.closeActiveTransaction(False)
        closed = True
    except Exception:
        closed = False

    # Then drain -- but stop when draining stops working. Measured: this build
    # can report HasPendingTransaction forever while commitTransaction clears
    # nothing, and spinning to the limit only burns calls and hides the fact.
    n = 0
    stalled = False
    while _pending(doc) and n < DRAIN_LIMIT:
        doc.commitTransaction()
        n += 1
        if n >= 2 and _pending(doc):
            stalled = True
            break
    return {"sealed": n, "boundary": closed, "drainStalled": stalled,
            "stillPending": _pending(doc)}


def _open(name):
    App.setActiveTransaction(name)


def _close(abort):
    try:
        App.closeActiveTransaction(bool(abort))
    except TypeError:
        App.closeActiveTransaction()


# ---------- projection ----------

def _scalars(obj):
    out = {}
    for p in obj.PropertiesList:
        if p in ("Label2", "_ElementMapVersion", "_GroupTouched"):
            continue
        try:
            v = obj.getPropertyByName(p)
        except Exception:
            continue
        if isinstance(v, bool) or isinstance(v, int) or isinstance(v, str):
            out[p] = v
        elif isinstance(v, float):
            out[p] = round(v, 6)
        elif hasattr(v, "Value") and hasattr(v, "UserString"):
            try:
                out[p] = round(float(v.Value), 6)
            except Exception:
                pass
        elif hasattr(v, "Base") and hasattr(v, "Rotation"):
            try:
                b = v.Base
                q = v.Rotation.Q
                # q and -q are the same rotation, so one of them has to be
                # chosen or every 180-degree placement diffs against itself.
                # Keying on q[3] leaves exactly that case unnormalised, since
                # a 180-degree rotation has w == 0: key on the first non-zero
                # component instead.
                lead = 0.0
                for _c in q:
                    if abs(_c) > 1e-9:
                        lead = _c
                        break
                if lead < 0:
                    q = (-q[0], -q[1], -q[2], -q[3])
                out[p] = {
                    "pos": [round(b.x, 6), round(b.y, 6), round(b.z, 6)],
                    "rot": [round(q[0], 6), round(q[1], 6), round(q[2], 6), round(q[3], 6)]
                }
            except Exception:
                pass
    if hasattr(obj, "ExpressionEngine"):
        try:
            ee = obj.ExpressionEngine
            if ee:
                out["ExpressionEngine"] = [(pair[0], pair[1]) for pair in ee]
        except Exception:
            pass
    return out


def _shape_metrics(obj):
    sh = getattr(obj, "Shape", None)
    if sh is None:
        return None
    try:
        if sh.isNull():
            return {"null": True}
        bb = sh.BoundBox
        return {
            "volume": round(sh.Volume, 6),
            "area": round(sh.Area, 6),
            "faces": len(sh.Faces),
            "edges": len(sh.Edges),
            "bbox": [round(bb.XLength, 6), round(bb.YLength, 6), round(bb.ZLength, 6)],
        }
    except Exception:
        return None



# App::Origin and the six datum features inside it are scaffolding every Body
# and Part carries. They are never edited, never referenced by id, and there
# are seven of them per body -- so a five-body assembly reports thirty-five
# tree nodes nobody asked about, in the payload that opens every turn, on the
# screen of a human trying to find their bracket.
ORIGIN_TYPES = ("App::Origin", "App::Plane", "App::Line", "App::Point")


def _tree(doc=None):
    doc = doc or App.ActiveDocument
    if doc is None:
        return []

    # 1. Collect all subgroup items (items that belong to an inner group/body)
    subgroup_children = set()
    for o in doc.Objects:
        if o.TypeId in ("App::DocumentObjectGroup", "PartDesign::Body"):
            for c in getattr(o, "Group", []):
                if c is not None:
                    subgroup_children.add(c.Name)

    # 2. Collect all children across any group
    is_child = set()
    for o in doc.Objects:
        if hasattr(o, "Group"):
            for c in getattr(o, "Group", []):
                if c is not None:
                    is_child.add(c.Name)

    def _node(o):
        res = {"name": o.Name, "type": o.TypeId, "label": o.Label}
        children = []
        if hasattr(o, "Group"):
            for c in getattr(o, "Group", []):
                if c is not None:
                    # If this is an App::Part, avoid duplicating items that are already nested in a subgroup
                    if o.TypeId == "App::Part" and c.Name in subgroup_children:
                        continue
                    if c.TypeId in ORIGIN_TYPES:
                        continue
                    children.append(_node(c))
        if children:
            res["children"] = children
        return res

    # Roots are objects not in any Group, excluding loose Origin features
    roots = []
    for o in doc.Objects:
        if o.Name not in is_child:
            # Filter out standalone default Origin planes/axes from root view to keep context clean
            if o.TypeId in ORIGIN_TYPES:
                continue
            roots.append(o)

    roots.sort(key=lambda x: x.Name)
    return [_node(o) for o in roots]

def get_node(name, doc=None):
    # Takes a koi id, an internal Name or a Label, because every other entry
    # point does and an id that works in call() but not here is a trap.
    doc = doc or App.ActiveDocument
    if doc is None:
        return {"id": name, "error": "no active document"}
    o = resolve(doc, name) or doc.getObject(str(name))
    if o is None:
        for cand in doc.Objects:
            if cand.Label == str(name):
                o = cand
                break
    if o is None:
        return {"id": name, "error": "object %r not found" % name}
    return {
        "id": name,
        "name": o.Name,
        "type": o.TypeId,
        "label": o.Label,
        "state": list(o.State),
        "valid": bool(o.isValid()),
        "props": _scalars(o),
        "shape": _shape_metrics(o)
    }


def get_nodes(names, doc=None):
    # One round trip for a drill-down. The poll interval puts a floor of a
    # quarter second on every exec, so twenty objects one at a time is five
    # seconds and twenty tool calls of context.
    doc = doc or App.ActiveDocument
    out = []
    for n in list(names or [])[:GET_LIMIT]:
        out.append(get_node(n, doc))
    return {"nodes": out, "requested": len(names or []),
            "returned": len(out), "limit": GET_LIMIT}

def project(doc=None):
    # Full walk. K2 measured 2-3 ms for 40 objects / 674 properties, so the
    # incremental version in the design is deferred until a real document says
    # otherwise -- and this stays the harness's correctness oracle either way.
    doc = doc or App.ActiveDocument
    if doc is None:
        return {"document": None, "objects": []}
    objs = []
    for o in doc.Objects:
        row = {
            "name": o.Name,
            "type": o.TypeId,
            "label": o.Label,
            "state": list(o.State),
            "valid": bool(o.isValid()),
            "props": _scalars(o),
            "shape": _shape_metrics(o),
        }
        # Carried here rather than derived later: FullyConstrained is not in
        # PropertiesList, so _scalars never sees it, and without it in the
        # projection a sketch that lost its constraints between turns is
        # invisible to the diff.
        if "Sketcher::SketchObject" in o.TypeId:
            try:
                row["fullyConstrained"] = bool(getattr(o, "FullyConstrained", False))
            except Exception:
                row["fullyConstrained"] = None
        objs.append(row)
    objs.sort(key=lambda r: r["name"])
    return {
        "document": doc.Name,
        "objects": objs,
        "undoNames": list(doc.UndoNames)[-4:],
    }


def _error_set(doc):
    bad = set()
    for o in doc.Objects:
        try:
            if not o.isValid():
                bad.add(o.Name)
            else:
                st = [s.lower() for s in o.State]
                if "invalid" in st or "error" in st:
                    bad.add(o.Name)
        except Exception:
            bad.add(o.Name)
    return bad


# ---------- lint ----------

SUBTRACTIVE = ("Pocket", "Groove", "Hole", "Cut")
ADDITIVE = ("Pad", "Revolution", "Loft", "Pipe", "AdditiveBox")
# Dress-up features change the volume in either direction -- a fillet on a
# convex edge removes, on a concave edge adds -- so the rule is that it must
# change SOMETHING. A fillet on the wrong edge reports Up-to-date and
# isValid() exactly the way a pocket into thin air does.
DRESS = ("Fillet", "Chamfer", "Draft", "Thickness")
GET_LIMIT = 64         # objects per freecad_get
LINK_LIMIT = 256       # instances per link_array
TOPO_KINDS = ("Face", "Edge", "Vertex")
HELIX_TYPES = ("Part::Helix", "AdditiveHelix", "SubtractiveHelix")
SLIVER_ABS = 0.01      # mm^2
SLIVER_REL = 1e-4      # of the largest face
# Scaffolding with a Shape that is not a solid. A datum plane's Shape is a
# single FACE, and OCC's volume integral over an open face is the cone from
# the origin to it -- NOT zero for anything offset from the origin. A datum at
# z=40 therefore measured as a solid of some hundreds of mm^3, failed
# isClosed(), and reported "solid is not closed" on every deep lint of an
# otherwise clean session. The integral was never the question; whether there
# is a solid is.
DATUM_TYPES = frozenset((
    "PartDesign::Plane", "PartDesign::Line", "PartDesign::Point",
    "PartDesign::CoordinateSystem", "PartDesign::ShapeBinder",
    "PartDesign::SubShapeBinder", "App::Plane", "App::Line", "App::Origin",
))


def _solids_of(o):
    """The solids in an object's shape, or None when it has none.

    The one gate every rule that says the word "solid" has to pass first.
    """
    if str(getattr(o, "TypeId", "")) in DATUM_TYPES:
        return None
    sh = getattr(o, "Shape", None)
    if sh is None:
        return None
    try:
        if sh.isNull():
            return None
        solids = list(getattr(sh, "Solids", None) or [])
    except Exception:
        return None
    return solids or None


def _link_pairs(v):
    # An App::PropertyLinkSub is (obj, [subs]); a LinkSubList is a list of
    # those. Normalise so the caller does not have to care which it got.
    if v is None:
        return []
    if isinstance(v, tuple) and len(v) == 2:
        return [v]
    if isinstance(v, list):
        return [x for x in v if isinstance(x, tuple) and len(x) == 2]
    return []


def _topo_refs(o):
    """Sub-element references this feature depends on (8.1)."""
    found = []
    for p in o.PropertiesList:
        try:
            if "LinkSub" not in o.getTypeIdOfProperty(p):
                continue
            v = o.getPropertyByName(p)
        except Exception:
            continue
        for tgt, subs in _link_pairs(v):
            for s in (subs or []):
                if not s:
                    continue
                bare = s.lstrip("?")
                if any(bare.startswith(k) for k in TOPO_KINDS):
                    found.append({"prop": p, "on": getattr(tgt, "Name", "?"),
                                  "sub": s, "mapped": s != bare})
    return found


def _size_from_tap(d):
    """Which thread a drill diameter is the tap drill for, if any."""
    if not d:
        return None
    for k, f in FASTENERS.items():
        if abs(f["tap"] - d) < 0.02:
            return f["d"]
    return None


def _stock_lint(o):
    out = []
    tid = o.TypeId
    if "PartDesign::Hole" in tid:
        try:
            d = round(float(o.Diameter), 3)
        except Exception:
            return out
        if d > 0 and not any(abs(d - s) < 0.02 for s in drill_sizes()):
            out.append({"level": "warn", "object": o.Name, "code": "non-stock",
                        "message": "%.2f mm is not a standard drill or "
                                   "clearance size; it cannot be drilled "
                                   "without a special tool" % d})
        # 8.2 / the engagement rule: a tapped hole shallower than 1.5xD
        # strips the first time it is torqued.
        #
        # Written against three unknowns rather than one guess: whether this
        # build spells the flag Threaded, what its ThreadSize enum contains,
        # and whether DepthType reads back as "Dimension". A blind hole
        # drilled to a tap-drill diameter is a tapped hole whatever the
        # enum says, so the nominal size is recovered from the geometry when
        # the property does not give it.
        try:
            threaded = bool(getattr(o, "Threaded", False))
            size = str(getattr(o, "ThreadSize", "") or "")
            nom = (FASTENERS.get(size) or {}).get("d") or _size_from_tap(d)
            depth_type = str(getattr(o, "DepthType", "") or "")
            through = "through" in depth_type.lower()
            depth = None
            if not through:
                try:
                    depth = float(o.Depth)
                except Exception:
                    depth = None
            if threaded and nom and depth and depth < ENGAGEMENT_RATIO * nom - 1e-6:
                out.append({
                    "level": "warn", "object": o.Name,
                    "code": "thread-engagement",
                    "message": "%s tapped only %.1f mm deep; %.1f mm (1.5xD) "
                               "is the minimum before the thread strips"
                               % (size or ("M%g" % nom), depth,
                                  ENGAGEMENT_RATIO * nom)})
        except Exception:
            pass
    return out


def _thread_geometry(o):
    tid = o.TypeId
    if any(k in tid for k in HELIX_TYPES):
        return "helical geometry"
    if "PartDesign::Hole" in tid:
        for attr in ("ModelActualThread", "ModelThread"):
            try:
                if bool(getattr(o, attr, False)):
                    return "a hole set to model its actual thread"
            except Exception:
                continue
    return None


def _deep_shape_lint(o, out):
    # Solids, not volume: see DATUM_TYPES. Every rule below judges a closed
    # solid, and an object that has none is not a failing solid, it is a
    # different kind of object.
    if _solids_of(o) is None:
        return
    sh = o.Shape
    try:
        if sh.Volume <= 1e-9:
            return
    except Exception:
        return
    try:
        if not sh.isClosed():
            out.append({"level": "warn", "object": o.Name, "code": "open-shape",
                        "message": "solid is not closed; downstream booleans "
                                   "and exports will fail in ways that do not "
                                   "name this feature"})
    except Exception:
        pass
    try:
        faces = sh.Faces
        if len(faces) > 2000:
            return
        areas = []
        for f in faces:
            areas.append(f.Area)
        if not areas:
            return
        big = max(areas)
        thin = [a for a in areas
                if a < SLIVER_ABS and a < big * SLIVER_REL]
        if thin:
            out.append({"level": "warn", "object": o.Name, "code": "sliver-face",
                        "message": "%d sliver face(s), smallest %.6f mm^2; "
                                   "these break fillets and exports later, "
                                   "far from the feature that made them"
                                   % (len(thin), min(thin))})
    except Exception:
        pass


def _dress_backed_names(doc):
    """Dress-up features whose elements can be re-derived from a filter.

    A chamfer placed from a query stores that query (see _dress_out), so its
    Edge66 is a cache and not the authority. Warning about it every turn for
    the rest of the session is noise on top of a solved problem, and noise in
    the mandatory turn opener is what makes a real topo-ref warning invisible.
    """
    try:
        return set(k[len(DRESS_PREFIX):] for k in _meta(doc)
                   if k.startswith(DRESS_PREFIX))
    except Exception:
        return set()


def lint(doc=None, deep=False):
    # Measures, because state flags do not catch the case that matters: a
    # subtractive feature pointed into empty space recomputes to Up-to-date,
    # isValid() True, and removes nothing.
    #
    # deep=False by default because lint runs on the mandatory turn opener and
    # on every edit. The cheap rules read properties the document already has;
    # the deep ones walk face lists, which is the one thing here that scales
    # with model size rather than object count. freecad_measure asks for deep.
    doc = doc or App.ActiveDocument
    out = []
    if doc is None:
        return out
    dressed = _dress_backed_names(doc)
    for o in doc.Objects:
        try:
            # A suppressed feature is one the user has deliberately switched
            # off. It contributes no material BY DESIGN, so every measured
            # rule below fires on it every turn -- removed-nothing on a pocket
            # somebody suppressed on purpose is the definition of a warning
            # that trains its reader to skip the section.
            if _suppressed(o):
                continue
            # An invalid object used to end the walk here. That put the
            # diagnosis exactly where it could not be reached: a sketch with
            # contradictory constraints IS invalid, so "invalid: Touched,
            # Invalid" was all anyone got, while the constraint numbers that
            # say why sat one rule further down. The rules below run on a
            # broken object too -- that is the object they are for.
            invalid = not o.isValid()
            if invalid:
                out.append({"level": "error", "object": o.Name,
                            "code": "invalid",
                            "message": "feature is invalid: %s" % list(o.State)})
            else:
                st = [s.lower() for s in o.State]
                if "touched" in st:
                    out.append({"level": "warn", "object": o.Name, "code": "touched",
                                "message": "not recomputed since its last change"})

            tid = o.TypeId
            # Skipped when the feature is invalid: its shape is whatever
            # survived the failed recompute, so a volume comparison against it
            # would be a measurement of nothing, reported as if it meant
            # something.
            base = None if invalid else getattr(o, "BaseFeature", None)
            if base is not None and getattr(base, "Shape", None) is not None:
                try:
                    before = base.Shape.Volume
                    after = o.Shape.Volume
                    if any(k in tid for k in SUBTRACTIVE) and after >= before - 1e-6:
                        out.append({
                            "level": "warn", "object": o.Name, "code": "removed-nothing",
                            "message": "subtractive feature removed no material "
                                       "(volume %.3f -> %.3f); check its direction "
                                       "or profile" % (before, after)})
                    if any(k in tid for k in ADDITIVE) and after <= before + 1e-6:
                        out.append({
                            "level": "warn", "object": o.Name, "code": "added-nothing",
                            "message": "additive feature added no material "
                                       "(volume %.3f -> %.3f)" % (before, after)})
                    if any(k in tid for k in DRESS) and abs(after - before) <= 1e-6:
                        out.append({
                            "level": "warn", "object": o.Name,
                            "code": "changed-nothing",
                            "message": "dress-up feature changed no material "
                                       "(volume %.3f -> %.3f); it is on the "
                                       "wrong element or too small to bite"
                                       % (before, after)})
                except Exception:
                    pass

            if "Sketcher::SketchObject" in tid:
                try:
                    if not bool(getattr(o, "FullyConstrained", False)):
                        out.append({"level": "warn", "object": o.Name,
                                    "code": "dof", "message":
                                    "sketch is not fully constrained; it will "
                                    "drift when anything upstream moves"})
                    # A conflict is an error, not a warning: the solver is
                    # fighting the next edit rather than merely permitting it.
                    conf = [int(x) for x in (getattr(o, "ConflictingConstraints", None) or [])]
                    red = [int(x) for x in (getattr(o, "RedundantConstraints", None) or [])]
                    part = [int(x) for x in (getattr(o, "PartiallyRedundantConstraints", None) or [])]
                    if conf:
                        out.append({"level": "error", "object": o.Name,
                                    "code": "conflicting-constraints",
                                    "message": "conflicting constraints %s; the "
                                               "sketch cannot solve as written"
                                               % conf[:8]})
                    if red or part:
                        out.append({"level": "warn", "object": o.Name,
                                    "code": "redundant-constraints",
                                    "message": "redundant constraints %s; they "
                                               "fight the solver on the next "
                                               "dimensional change"
                                               % (red + part)[:8]})
                except Exception:
                    pass

            # 8.1: a picked sub-element name is the reference that breaks on
            # the next upstream insert. AI-authored ones are banned outright;
            # this cannot tell who authored it, so it reports every one and
            # says which are element-mapped.
            try:
                for r in ([] if o.Name in dressed else _topo_refs(o)):
                    out.append({
                        "level": "warn", "object": o.Name, "code": "topo-ref",
                        "message": "%s references %s on %s%s; prefer a datum, "
                                   "and re-validate a user pick every turn"
                                   % (r["prop"], r["sub"], r["on"],
                                      " (element-mapped, so it survives more "
                                      "than a raw index would)" if r["mapped"]
                                      else " (raw index -- it will move)")})
            except Exception:
                pass

            # 8.2: a dimension that cannot be bought or drilled.
            try:
                for w in _stock_lint(o):
                    out.append(w)
            except Exception:
                pass

            # 8.4: threads are a specification, never cut geometry.
            try:
                th = _thread_geometry(o)
                if th:
                    out.append({"level": "warn", "object": o.Name,
                                "code": "modeled-thread",
                                "message": "%s: threads carry nothing a hole "
                                           "spec lacks and cost recompute and "
                                           "render time" % th})
            except Exception:
                pass

            # A link that points at nothing means the recompute is already
            # lying about what this model contains.
            try:
                if "Link" in tid and "LinkedObject" in o.PropertiesList:
                    if o.getPropertyByName("LinkedObject") is None:
                        out.append({"level": "error", "object": o.Name,
                                    "code": "broken-link",
                                    "message": "link has no target"})
            except Exception:
                pass

            if deep:
                _deep_shape_lint(o, out)
        except Exception as e:
            out.append({"level": "warn", "object": getattr(o, "Name", "?"),
                        "code": "lint-failed", "message": str(e)})
    try:
        out.extend(_split_lint(doc))
    except Exception as e:
        out.append({"level": "warn", "object": "?", "code": "lint-failed",
                    "message": "split check: %s" % e})
    try:
        out.extend(_fem_lint(doc))
    except Exception as e:
        out.append({"level": "warn", "object": "?", "code": "lint-failed",
                    "message": "fem check: %s" % e})
    return out


SPLIT_PREFIX = "koi.split."


def _split_sources(doc):
    """Solids that a split_body cut halves out of and that are now duplicates.

    The source stays in the document on purpose -- re-splitting needs it -- but
    it is the same material as both halves. Counting it is what put StemSource
    AND both halves AND the pattern in one BOM and made the fabricated mass
    honest only for a reader who already knew which lines to ignore.
    """
    out = set()
    m = _meta(doc)
    for k in sorted(m):
        if not k.startswith(SPLIT_PREFIX):
            continue
        try:
            rec = _json.loads(m[k])
        except Exception:
            continue
        names = rec.get("names") or []
        if not any(doc.getObject(n) is not None for n in names):
            continue
        src = rec.get("source")
        if src and doc.getObject(str(src)) is not None:
            out.add(str(src))
    return out


def _link_masters(doc):
    """Objects that App::Links point at -- the definition, not an instance."""
    out = set()
    for o in doc.Objects[:2000]:
        if o.TypeId != "App::Link":
            continue
        try:
            linked = o.LinkedObject
        except Exception:
            continue
        if linked is not None:
            out.add(linked.Name)
    return out


def _split_lint(doc):
    """Halves whose source has moved since they were cut.

    split_body takes a snapshot and its result says so -- but "said once, in
    turn 4" is not a check, and the halves are what gets exported. This is the
    check: the source's volume at the moment of the split is recorded, and any
    later turn that changed it is reported, every turn, until the split is
    re-run.
    """
    rows = []
    m = _meta(doc)
    for k in sorted(m):
        if not k.startswith(SPLIT_PREFIX):
            continue
        try:
            rec = _json.loads(m[k])
        except Exception:
            continue
        names = rec.get("names") or []
        if not any(doc.getObject(n) is not None for n in names):
            continue        # the halves are gone; nothing to be stale
        src = doc.getObject(str(rec.get("source") or ""))
        if src is None:
            rows.append({
                "level": "warn", "object": names[0], "code": "split-source-gone",
                "message": "the solid these halves were cut from (%s) is no "
                           "longer in the document, so the split cannot be "
                           "re-run as it was" % rec.get("source")})
            continue
        now = _vol(src)
        was = rec.get("sourceVolume")
        if now is None or was is None:
            continue
        was = float(was)
        if abs(now - was) > max(1e-6, abs(was) * 1e-6):
            rows.append({
                "level": "warn", "object": src.Name, "code": "split-stale",
                "message": "%s has changed since it was split (%.3f -> %.3f). "
                           "%s are snapshots and still describe the old "
                           "shape: re-run split_body, and do not export them "
                           "as they are"
                           % (src.Name, was, now,
                              ", ".join(rec.get("ids") or names))})
    return rows


# ---------- ids and provenance (4.2) ----------
#
# An id (sk.plate, bolt.mount) is what binds a turn-3 reference to a turn-7
# edit. Name is immutable but opaque; Label is what the user sees and is free
# to change or collide. So the mapping lives in doc.Meta, which is the only
# store here that survives save/reload.
#
# Probed shape, not assumed: Meta hands back a copy on read, so a mutation has
# to be assigned back, and register() verifies by re-reading rather than
# trusting the assignment. If the property is missing on this build the module
# degrades to in-memory and says so, because an id store that silently forgets
# is worse than no id store.

ID_PREFIX = "koi.id."
ORIGIN_PREFIX = "koi.origin."

_FALLBACK = {}


def _meta(doc):
    try:
        m = doc.Meta
        return dict(m) if m else {}
    except Exception:
        return dict(_FALLBACK.get(doc.Name, {}))


def _meta_set(doc, key, value):
    value = str(value)
    d = _meta(doc)
    d[key] = value
    try:
        doc.Meta = d
        if _meta(doc).get(key) == value:
            return True
    except Exception:
        pass
    _FALLBACK.setdefault(doc.Name, {})[key] = value
    return False


def register(doc, kid, obj, turn=None):
    persisted = True
    if kid:
        persisted = _meta_set(doc, ID_PREFIX + str(kid), obj.Name) and persisted
    origin = "ai:%s" % turn if turn else "ai"
    persisted = _meta_set(doc, ORIGIN_PREFIX + obj.Name, origin) and persisted
    return persisted


def resolve(doc, ref):
    # Id first, then Name, then a Label but only when it is unambiguous. A
    # Label that names two objects resolves to neither: picking the first would
    # edit an arbitrary one of them.
    if not isinstance(ref, str) or not ref:
        return None
    name = _meta(doc).get(ID_PREFIX + ref)
    if name:
        o = doc.getObject(name)
        if o is not None:
            return o
    o = doc.getObject(ref)
    if o is not None:
        return o
    hits = [x for x in doc.Objects if x.Label == ref]
    return hits[0] if len(hits) == 1 else None


def ids(doc=None):
    doc = doc or App.ActiveDocument
    if doc is None:
        return {"ids": [], "revertedAiObjects": [], "persisted": None}
    m = _meta(doc)
    known = []
    reverted = []
    for k in sorted(m):
        if not k.startswith(ID_PREFIX):
            continue
        kid = k[len(ID_PREFIX):]
        name = m[k]
        present = doc.getObject(name) is not None
        known.append({"id": kid, "name": name, "present": present})
        if not present:
            # The user deleted something we made. That is a rejection signal
            # (5.2), and it must never be silently re-created.
            reverted.append(kid)
    return {
        "ids": known,
        "revertedAiObjects": reverted,
        "persisted": doc.Name not in _FALLBACK,
    }


def _safe_name(s, fallback):
    out = "".join(c if (c.isalnum() or c == "_") else "_" for c in str(s or ""))
    while out.startswith("_"):
        out = out[1:]
    if not out or out[0].isdigit():
        out = fallback + ("_" + out if out else "")
    return out[:60]


# ---------- ops: the whitelist (6.3) ----------
#
# Deliberately short. 6.2 says bespoke surface is earned, not assumed, and the
# next measurement is channel economics: build the same bracket through call()
# and through script() and compare. These are the calls that measurement needs,
# and nothing else has earned a schema yet.
#
# Each op is (doc, args, kid) -> JSON-able dict, raising KoiOpError for a bad
# request. The envelope owns transactions, gating, recompute and rollback; an
# op never touches any of them.


def _need(args, key):
    if key not in args or args[key] is None:
        raise KoiOpError("missing required argument %r" % (key,))
    return args[key]


def _num(args, key, default=None):
    v = args.get(key, default)
    if v is None:
        raise KoiOpError("missing required argument %r" % (key,))
    try:
        return float(v)
    except Exception:
        raise KoiOpError("%r must be a number, got %r" % (key, v))


def _numx(args, key, default=None):
    """A FEATURE dimension: a number, or a document expression to BIND to it.

    The same contract _dim() gives a sketch primitive, on the other half of
    the model. A sketch could say {"d": "koi_params.bore"} and a pad could
    not, so every parametric extrude was pad(length: 40) followed immediately
    by feature_edit(expressions: {Length: "koi_params.StackHeight"}) -- two
    calls, two transactions and two undo entries for one intent, and a
    literal 40 sitting in the document in between that nobody meant.

    A numeric string is a number the caller quoted, not an expression: "40"
    binds to nothing and evaluating it as a document expression is a failure
    with a misleading message.

    Returns (float, expression-or-None).
    """
    v = args.get(key, default)
    if isinstance(v, str):
        expr = v.strip()
        if not expr:
            raise KoiOpError("%r is an empty expression" % (key,))
        try:
            return float(expr), None
        except ValueError:
            pass
        value, err = _eval_expr(expr)
        if value is None:
            raise _expr_error(expr, key, err,
                              "'koi_params.StackHeight', 'koi_params.pitch / 2'")
        return float(value), expr
    if v is None:
        raise KoiOpError("missing required argument %r" % (key,))
    try:
        return float(v), None
    except Exception:
        raise KoiOpError(
            "%r must be a number or an expression string, got %r" % (key, v))


def _bound_to(obj, prop):
    """The expression the document says is on this property, or None.

    Read back rather than trusted, for the reason the sketch binder reads its
    own bindings back: a dimension that silently stayed a literal looks
    identical until the day somebody changes the parameter and nothing moves.
    """
    try:
        for p in (obj.ExpressionEngine or []):
            if str(p[0]).lstrip(".") == prop:
                return str(p[1])
    except Exception:
        pass
    return None


def _set_dim(obj, prop, args, key, default=None):
    """Set a feature dimension from a number or an expression, and verify it."""
    value, expr = _numx(args, key, default)
    if prop not in obj.PropertiesList:
        raise KoiOpError(
            "this build's %s has no %s to set" % (obj.TypeId, prop))
    try:
        setattr(obj, prop, value)
    except Exception as e:
        raise KoiOpError(
            "could not set %s.%s to %g: %s: %s"
            % (obj.Name, prop, value, type(e).__name__, e))
    out = {"prop": prop, "value": _plain(value)}
    if expr:
        try:
            obj.setExpression(prop, expr)
        except Exception as e:
            raise KoiOpError(
                "could not bind %s.%s to %r: %s: %s"
                % (obj.Name, prop, expr, type(e).__name__, e))
        out["expression"] = expr
        out["verified"] = _bound_to(obj, prop) is not None
        if not out["verified"]:
            out["note"] = (
                "%s.%s did not keep its expression and is a literal: it will "
                "NOT follow a change to the parameter. Say so rather than "
                "reporting a parametric feature." % (obj.Name, prop))
    return out


def _expr_of(value, expr):
    """A dimension as expression text: the binding, or its literal.

    So a composed expression -- a centre that is half a width from a corner --
    can be built out of arguments that are a mix of the two.
    """
    return ("(" + expr + ")") if expr else ("%.10g" % float(value))


def _plain(v):
    if isinstance(v, bool) or isinstance(v, int) or isinstance(v, str):
        return v
    if isinstance(v, float):
        return round(v, 6)
    try:
        return round(float(v), 6)
    except Exception:
        return str(v)


def _vol(obj):
    try:
        return round(obj.Shape.Volume, 6)
    except Exception:
        return None


def _resolve_or_die(doc, ref, what):
    o = resolve(doc, ref)
    if o is None:
        raise KoiOpError(
            "no %s named %r. Known ids: %s"
            % (what, ref, ", ".join(r["id"] for r in ids(doc)["ids"]) or "none"))
    return o


# A sketch lives in exactly one Body, and a pad built on it can go nowhere
# else. Only these two: 'target' and 'base' can legitimately name something in
# a different body from the one being built in, and guessing there would put a
# feature in the wrong solid -- which is worse than asking.
BODY_HINT_KEYS = ("sketch", "profile")


def _resolve_body(doc, ref, args=None):
    if ref:
        b = _resolve_or_die(doc, ref, "body")
        if "PartDesign::Body" not in b.TypeId:
            raise KoiOpError("%s is a %s, not a Body" % (b.Name, b.TypeId))
        return b
    bodies = [o for o in doc.Objects if o.TypeId == "PartDesign::Body"]
    if len(bodies) == 1:
        return bodies[0]
    if not bodies:
        raise KoiOpError("no body in the document; call fn 'body' first")

    # The second body in a document used to break every pad after it: the
    # caller had already said which body it meant, by naming a sketch that is
    # inside one, and this asked again anyway. Refusing on an ambiguity the
    # arguments resolve is a refusal the caller cannot act on except by
    # repeating itself.
    if args:
        for key in BODY_HINT_KEYS:
            r = args.get(key)
            if not isinstance(r, str) or not r:
                continue
            owner = resolve(doc, r)
            if owner is None:
                continue
            b = _owning_body(owner)
            if b is not None:
                return b
    raise KoiOpError(
        "several bodies (%s); pass body=<id>. A sketch or profile argument "
        "would also have settled it -- this is asked only because nothing in "
        "this call names a body or anything inside one."
        % ", ".join(b.Name for b in bodies))


def _origin_plane(body, which):
    want = {"XY": "XY_Plane", "XZ": "XZ_Plane", "YZ": "YZ_Plane"}.get(
        str(which).upper())
    if want is None:
        raise KoiOpError("on must be XY, XZ or YZ, not %r" % (which,))
    for o in body.Origin.OriginFeatures:
        if want in o.Name:
            return o
    raise KoiOpError("body %s has no %s" % (body.Name, want))


def _origin_axis(body, which):
    """The body's own X/Y/Z datum line. A PartDesign pattern needs a real
    axis object, not a vector: a Placement-based rotation would move the
    feature, and a pattern has to stay inside the solid's DAG."""
    want = {"X": "X_Axis", "Y": "Y_Axis", "Z": "Z_Axis"}.get(
        str(which or "Z").upper().lstrip("+"))
    if want is None:
        raise KoiOpError("axis must be X, Y or Z, not %r" % (which,))
    for o in body.Origin.OriginFeatures:
        if want in o.Name:
            return o
    raise KoiOpError("body %s has no %s" % (body.Name, want))


ATTACH_PROPS = ("AttachmentSupport", "Support")


def _attach_to(obj, owner, sub="", mode="FlatFace"):
    """Set an attachment, whichever spelling this build has.

    Returns True only when one of them actually took. The caller has to check:
    a hasattr() guard that silently skips the write turns a renamed property
    into an op that reports success and attaches nothing.
    """
    ok = False
    for prop in ATTACH_PROPS:
        if prop not in obj.PropertiesList:
            continue
        try:
            setattr(obj, prop, [(owner, sub or "")])
            ok = True
            break
        except Exception:
            continue
    if ok and "MapMode" in obj.PropertiesList:
        try:
            obj.MapMode = str(mode)
        except Exception:
            pass
    return ok


def _offset_z(obj, dz):
    """Set AttachmentOffset.Base.z.

    The property returns a copy, so setting .Base.z through it is discarded
    with no error. The whole placement has to go back.
    """
    if "AttachmentOffset" not in obj.PropertiesList:
        return False
    try:
        pl = obj.AttachmentOffset
        b = pl.Base
        pl.Base = App.Vector(b.x, b.y, float(dz))
        obj.AttachmentOffset = pl
        return True
    except Exception:
        return False


def _place(obj, x, y, z):
    """Same copy-semantics trap as _offset_z, on Placement itself."""
    try:
        pl = obj.Placement
        pl.Base = App.Vector(float(x), float(y), float(z))
        obj.Placement = pl
        return True
    except Exception:
        return False


def _pos(obj):
    try:
        b = obj.Placement.Base
        return [round(b.x, 6), round(b.y, 6), round(b.z, 6)]
    except Exception:
        return None


def _attach_readback(obj):
    """What the document holds, not what we asked it to hold."""
    out = {"support": None, "sub": "", "mapMode": None, "offsetZ": None,
           "placement": _pos(obj)}
    for prop in ATTACH_PROPS:
        try:
            sup = getattr(obj, prop, None)
        except Exception:
            sup = None
        if not sup:
            continue
        try:
            out["support"] = sup[0][0].Name
            subs = sup[0][1]
            if isinstance(subs, str):
                out["sub"] = subs
            elif subs:
                out["sub"] = subs[0]
        except Exception:
            pass
        break
    try:
        out["mapMode"] = str(obj.MapMode)
    except Exception:
        pass
    try:
        out["offsetZ"] = round(float(obj.AttachmentOffset.Base.z), 6)
    except Exception:
        pass
    return out


def _attach_map(doc, obj, owner, sub, mode=None, offset=None):
    """Attach, recompute, and MEASURE that the object moved onto the target.

    Two things were wrong with doing this inline. The mode: FlatFace maps to a
    planar FACE, so with no subelement -- a datum plane, a whole object -- it
    is accepted, written, and maps nothing; ObjectXY is the mode for that case.
    And the check: reading back 'support' proves the property was set, not
    that the attachment did anything, so a sketch could sit at the origin
    while the readback said yes.

    An explicit mode is an instruction and is the only one tried. Otherwise the
    likely one goes first and the other is measured as a fallback, in the same
    try-and-measure style as _ensure_cuts.
    """
    if mode:
        modes = [str(mode)]
    elif sub:
        modes = ["FlatFace", "ObjectXY"]
    else:
        modes = ["ObjectXY", "FlatFace"]

    target_at = _pos(owner)
    tried = []
    read = {"support": None}
    for m in modes:
        tried.append(m)
        if not _attach_to(obj, owner, sub, m):
            continue
        if offset is not None:
            _offset_z(obj, offset)
        doc.recompute()
        read = _attach_readback(obj)
        read["moved"] = _attached_moved(read.get("placement"), target_at, offset)
        if read.get("support") and read["moved"]:
            break
    read["modesTried"] = tried
    read["targetAt"] = target_at
    read.setdefault("moved", False)
    return read


def _attached_moved(placement, target_at, offset=None):
    """Did the attachment actually put it where the target is?

    The target sitting at the global origin is the one case this cannot
    distinguish from a no-op -- so it is not treated as a failure. Everywhere
    else, an object still at [0,0,0] when its support is not is a dropped
    attachment reported as a good one.
    """
    if placement is None or target_at is None:
        return False
    want = list(target_at)
    if offset:
        want[2] = want[2] + float(offset)
    if max(abs(v) for v in want) < 1e-9:
        return True
    return max(abs(placement[i] - want[i]) for i in range(3)) < 1e-3


def _attach(sk, plane):
    if not _attach_to(sk, plane, "", "FlatFace"):
        raise KoiOpError(
            "%s exposes neither AttachmentSupport nor Support; this build "
            "cannot attach it to %s" % (sk.Name, plane.Name))


def _sk_dof(sk):
    # Report what the build actually exposes rather than assuming an API. The
    # boolean is the one every build has; the number is nicer when present.
    out = {"fullyConstrained": bool(getattr(sk, "FullyConstrained", False))}
    for name in ("getDoF", "DoF", "dofs"):
        try:
            v = getattr(sk, name)
            v = v() if callable(v) else v
            if isinstance(v, int) and not isinstance(v, bool):
                out["dof"] = v
                break
        except Exception:
            continue
    return out


def _eval_expr(expr, doc=None):
    """What a document expression evaluates to right now, or None.

    Only to give the geometry a sensible starting value: the expression itself
    is what ends up on the constraint, and the sketch takes its real dimension
    from that on the next recompute. Nothing here depends on this being right,
    but a circle built at r=10 and then solved to r=2 makes the solver work
    for no reason and looks alarming on the stream.
    """
    doc = doc or App.ActiveDocument
    if doc is None:
        return None, None
    hosts = []
    sh = params_sheet(doc, create=False)
    if sh is not None:
        hosts.append(sh)
    hosts.extend(doc.Objects[:1])
    err = None
    for h in hosts:
        try:
            v = h.evalExpression(str(expr))
        except Exception as e:
            err = "%s: %s" % (type(e).__name__, e)
            continue
        try:
            return float(getattr(v, "Value", v)), None
        except Exception:
            continue
    return None, err


def _expr_error(expr, key, err, kind):
    """Why an expression did not evaluate, in the caller's terms.

    The parameter sheet stores plain floats, so a sheet reference is
    unit-bare and mixing it with a unit literal raises a unit mismatch
    inside the expression engine. A bare koi_params.X evaluates fine,
    which makes the failure read as bad syntax rather than a unit rule --
    and the error the engine raised was being discarded, so nothing in the
    reply said which of the two it was.
    """
    if err and "Unit mismatch" in err:
        bare = " ".join(expr.replace("mm", "").replace("deg", "").split())
        return KoiOpError(
            "%r could not be evaluated for %r: the parameter sheet holds "
            "PLAIN NUMBERS in the document's own units (mm, deg), so a "
            "sheet reference carries no unit and mixing it with a unit "
            "literal is a unit mismatch. Write it unit-bare -- %r -- or "
            "put no unit on any term. (%s)" % (expr, key, bare, err))
    return KoiOpError(
        "could not evaluate %r for %r. This is a document expression -- %s "
        "-- so the alias has to exist before the feature that binds to it: "
        "set it with fn 'param', or insert the component that publishes "
        "it.%s" % (expr, key, kind, (" (%s)" % err) if err else ""))


def _dim(g, key, default=None):
    """A primitive's dimension: a number, or an expression to BIND to it.

    The doctrine has always been to bind a dimension to the sheet rather than
    type the same literal twice, and until now a sketch was the one place that
    could not: the only channel was setExpression('Constraints[3]', ...) with
    the 3 guessed from the order these builders happen to add constraints in.
    That index is not stable and not knowable from outside, so the binding got
    skipped and the numbers got typed.

    A string here is a document expression -- {"type": "circle",
    "d": "koi_params.bore", "x": "koi_params.pitch / 2"} -- and the builder
    hands back the constraint index it landed on, so the caller never sees one.
    """
    v = g.get(key, default)
    if isinstance(v, str):
        expr = v.strip()
        if not expr:
            raise KoiOpError("%r is an empty expression" % (key,))
        value, err = _eval_expr(expr)
        if value is None:
            raise _expr_error(expr, key, err,
                              "'koi_params.bore', 'koi_params.pitch / 2'")
        return float(value), expr
    if v is None:
        raise KoiOpError("missing required argument %r" % (key,))
    try:
        return float(v), None
    except Exception:
        raise KoiOpError(
            "%r must be a number or an expression string, got %r" % (key, v))


def _sk_rect(sk, C, Part, V, g):
    x, x_e = _dim(g, "x", 0.0)
    y, y_e = _dim(g, "y", 0.0)
    w, w_e = _dim(g, "w")
    h, h_e = _dim(g, "h")
    if w <= 0 or h <= 0:
        raise KoiOpError("rect w and h must be positive")
    # A mechanical part is almost always symmetric about an axis that goes
    # through the origin -- a steerer bore, a shaft centreline -- and this
    # builder only ever took a bottom-left corner. So an envelope centred on
    # the bore was written as {x: -25, y: "-koi_params.BodyWidth / 2"}: a
    # negated half-dimension, by hand, once per rectangle, and every one of
    # them a chance to be off by half a width in a way nothing downstream can
    # detect. The corner is still what the constraints anchor; where the
    # halving happens is the only thing that changes.
    anchor = str(g.get("anchor") or "corner").strip().lower()
    if anchor in ("centre", "center"):
        if x_e or w_e:
            x_e = _expr_of(x, x_e) + " - " + _expr_of(w, w_e) + " / 2"
        if y_e or h_e:
            y_e = _expr_of(y, y_e) + " - " + _expr_of(h, h_e) + " / 2"
        x -= w / 2.0
        y -= h / 2.0
    elif anchor != "corner":
        raise KoiOpError(
            "rect anchor must be 'corner' (x, y is the bottom-left) or "
            "'center' (x, y is the middle), not %r" % (g.get("anchor"),))
    gs = []
    pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    for i in range(4):
        a = pts[i]
        b = pts[(i + 1) % 4]
        gs.append(sk.addGeometry(
            Part.LineSegment(V(a[0], a[1], 0), V(b[0], b[1], 0)), False))
    for i in range(4):
        sk.addConstraint(C("Coincident", gs[i], 2, gs[(i + 1) % 4], 1))
    sk.addConstraint(C("Horizontal", gs[0]))
    sk.addConstraint(C("Horizontal", gs[2]))
    sk.addConstraint(C("Vertical", gs[1]))
    sk.addConstraint(C("Vertical", gs[3]))
    # Anchored on purpose. A rectangle with both dimensions and no position is
    # dof=2 and slides the moment anything upstream moves -- which is the
    # lint warning this module already emits, so emitting the geometry that
    # trips it would be indefensible.
    bind = {}
    # A bound position needs a dimension to carry the expression, so the
    # coincident shortcut is only for a corner that really is at the origin
    # and staying there.
    if abs(x) < 1e-9 and abs(y) < 1e-9 and not x_e and not y_e:
        sk.addConstraint(C("Coincident", gs[0], 1, -1, 1))
    else:
        ix = sk.addConstraint(C("DistanceX", -1, 1, gs[0], 1, x))
        iy = sk.addConstraint(C("DistanceY", -1, 1, gs[0], 1, y))
        if x_e:
            bind[ix] = x_e
        if y_e:
            bind[iy] = y_e
    iw = sk.addConstraint(C("DistanceX", gs[0], 1, gs[0], 2, w))
    ih = sk.addConstraint(C("DistanceY", gs[1], 1, gs[1], 2, h))
    if w_e:
        bind[iw] = w_e
    if h_e:
        bind[ih] = h_e
    out = {"type": "rect", "geo": gs}
    if bind:
        out["bind"] = bind
    return out


def _sk_circle(sk, C, Part, V, g):
    x, x_e = _dim(g, "x", 0.0)
    y, y_e = _dim(g, "y", 0.0)
    if g.get("r") is not None:
        r, r_e = _dim(g, "r")
    elif g.get("d") is not None:
        d, d_e = _dim(g, "d")
        r = d / 2.0
        # The constraint is a radius, so a diameter expression is bound as
        # one. Halving it here rather than making the caller do it is the
        # whole point: they said the bore is that alias, not half of it.
        r_e = ("(" + d_e + ") / 2") if d_e else None
    else:
        raise KoiOpError("circle needs r or d")
    if r <= 0:
        raise KoiOpError("circle radius must be positive")
    i = sk.addGeometry(
        Part.Circle(V(x, y, 0), V(0, 0, 1), r), bool(g.get("construction")))
    bind = {}
    ir = sk.addConstraint(C("Radius", i, r))
    if r_e:
        bind[ir] = r_e
    if abs(x) < 1e-9 and abs(y) < 1e-9 and not x_e and not y_e:
        sk.addConstraint(C("Coincident", i, 3, -1, 1))
    else:
        ix = sk.addConstraint(C("DistanceX", -1, 1, i, 3, x))
        iy = sk.addConstraint(C("DistanceY", -1, 1, i, 3, y))
        if x_e:
            bind[ix] = x_e
        if y_e:
            bind[iy] = y_e
    out = {"type": "circle", "geo": [i]}
    if bind:
        out["bind"] = bind
    return out


def _sk_slot(sk, C, Part, V, g):
    """A rounded slot: two caps, two flanks, fully constrained.

    The primitive the last session had to compute by hand. A weight-reduction
    flute with rounded ends is the single most common non-rectangular pocket
    in a machined part, and with only rect, circle and polyline the way to
    draw one was to generate the cap points with trigonometry in a script and
    emit a polyline -- which then carries no dimensions, cannot be bound to a
    parameter, and lint-warns about degrees of freedom every turn.

    length is tip to tip, width is across the flanks, angle is degrees
    anticlockwise from +X. x, y is the CENTRE, because a slot has no
    meaningful corner.
    """
    cx, cx_e = _dim(g, "x", 0.0)
    cy, cy_e = _dim(g, "y", 0.0)
    L, L_e = _dim(g, "length")
    W, W_e = _dim(g, "width")
    a = float(g.get("angle") or 0.0)
    if W <= 0:
        raise KoiOpError("slot width must be positive")
    if L <= W:
        raise KoiOpError(
            "slot length is measured tip to tip and must be greater than its "
            "width (got length %g, width %g); at length == width a slot is a "
            "circle of d=%g, and the flanks have no length to constrain"
            % (L, W, W))
    r = W / 2.0
    half = (L - W) / 2.0
    t0 = _math.radians(a)
    ca, sa = _math.cos(t0), _math.sin(t0)
    c1 = (cx - half * ca, cy - half * sa)
    c2 = (cx + half * ca, cy + half * sa)
    arc1 = sk.addGeometry(Part.ArcOfCircle(
        Part.Circle(V(c1[0], c1[1], 0), V(0, 0, 1), r),
        t0 + _math.pi / 2.0, t0 + 3.0 * _math.pi / 2.0), False)
    arc2 = sk.addGeometry(Part.ArcOfCircle(
        Part.Circle(V(c2[0], c2[1], 0), V(0, 0, 1), r),
        t0 - _math.pi / 2.0, t0 + _math.pi / 2.0), False)
    # ArcOfCircle(u1, u2) starts at u1 and runs anticlockwise, so PosId 1 is
    # the point at u1 and PosId 2 the point at u2. Spelled out because the
    # chain below is wrong in a way that still closes if they are swapped.
    p1 = (c1[0] - r * sa, c1[1] + r * ca)   # arc1 start
    p2 = (c1[0] + r * sa, c1[1] - r * ca)   # arc1 end
    p3 = (c2[0] + r * sa, c2[1] - r * ca)   # arc2 start
    p4 = (c2[0] - r * sa, c2[1] + r * ca)   # arc2 end
    ln1 = sk.addGeometry(
        Part.LineSegment(V(p2[0], p2[1], 0), V(p3[0], p3[1], 0)), False)
    ln2 = sk.addGeometry(
        Part.LineSegment(V(p4[0], p4[1], 0), V(p1[0], p1[1], 0)), False)
    # Endpoint-to-endpoint Tangent, NOT Coincident plus Tangent: in Sketcher
    # the endpoint form implies the coincidence, and adding both is exactly
    # the redundancy this module's own lint warns about every turn.
    sk.addConstraint(C("Tangent", arc1, 2, ln1, 1))
    sk.addConstraint(C("Tangent", ln1, 2, arc2, 1))
    sk.addConstraint(C("Tangent", arc2, 2, ln2, 1))
    sk.addConstraint(C("Tangent", ln2, 2, arc1, 1))
    sk.addConstraint(C("Equal", arc1, arc2))
    bind = {}
    ir = sk.addConstraint(C("Radius", arc1, r))
    if W_e:
        bind[ir] = _expr_of(W, W_e) + " / 2"
    # Anchored on the two cap centres rather than on length and angle: those
    # are four dimensions the solver can take directly, and they leave the
    # sketch at dof 0 without an angle constraint whose sign convention
    # differs between builds.
    ix1 = sk.addConstraint(C("DistanceX", -1, 1, arc1, 3, c1[0]))
    iy1 = sk.addConstraint(C("DistanceY", -1, 1, arc1, 3, c1[1]))
    ix2 = sk.addConstraint(C("DistanceX", -1, 1, arc2, 3, c2[0]))
    iy2 = sk.addConstraint(C("DistanceY", -1, 1, arc2, 3, c2[1]))
    if cx_e or cy_e or L_e or W_e:
        # Composed so that a slot whose length is a parameter still has cap
        # centres that follow it. The trig factor is emitted even at angle 0,
        # where it is cos(0deg)=1 and sin(0deg)=0, so there is one form to be
        # right about rather than two.
        leg = "(" + _expr_of(L, L_e) + " - " + _expr_of(W, W_e) + ") / 2"
        ang = "%.10g" % a
        ex, ey = _expr_of(cx, cx_e), _expr_of(cy, cy_e)
        bind[ix1] = ex + " - " + leg + " * cos(" + ang + "deg)"
        bind[iy1] = ey + " - " + leg + " * sin(" + ang + "deg)"
        bind[ix2] = ex + " + " + leg + " * cos(" + ang + "deg)"
        bind[iy2] = ey + " + " + leg + " * sin(" + ang + "deg)"
    out = {"type": "slot", "geo": [arc1, arc2, ln1, ln2],
           "centers": [[round(c1[0], 6), round(c1[1], 6)],
                       [round(c2[0], 6), round(c2[1], 6)]],
           "radius": round(r, 6)}
    if bind:
        out["bind"] = bind
    return out


def _sk_line(sk, C, Part, V, g):
    f = _need(g, "from")
    t = _need(g, "to")
    if not (isinstance(f, list) and isinstance(t, list) and
            len(f) >= 2 and len(t) >= 2):
        raise KoiOpError("line needs from:[x,y] and to:[x,y]")
    i = sk.addGeometry(
        Part.LineSegment(V(float(f[0]), float(f[1]), 0),
                         V(float(t[0]), float(t[1]), 0)),
        bool(g.get("construction")))
    return {"type": "line", "geo": [i]}


def _sk_arc(sk, C, Part, V, g):
    """Arc of a circle, angles in degrees, measured the way a human says them.

    Constrained like _sk_circle -- radius plus a located centre -- because an
    arc that carries neither is dof=3 and slides under the next upstream edit.
    The two ENDPOINTS stay free: an arc is almost always one link in a chain,
    and constraining its ends here would fight the Coincident that joins it to
    its neighbour.
    """
    x, x_e = _dim(g, "x", 0.0)
    y, y_e = _dim(g, "y", 0.0)
    if g.get("r") is not None:
        r, r_e = _dim(g, "r")
    elif g.get("d") is not None:
        d, d_e = _dim(g, "d")
        r = d / 2.0
        r_e = ("(" + d_e + ") / 2") if d_e else None
    else:
        raise KoiOpError("arc needs r or d")
    if r <= 0:
        raise KoiOpError("arc radius must be positive")
    a0 = _math.radians(_num(g, "start", 0.0))
    a1 = _math.radians(_num(g, "end", 180.0))
    if abs(a1 - a0) < 1e-9:
        raise KoiOpError("arc start and end are the same angle; use a circle")
    i = sk.addGeometry(
        Part.ArcOfCircle(Part.Circle(V(x, y, 0), V(0, 0, 1), r), a0, a1),
        bool(g.get("construction")))
    bind = {}
    ir = sk.addConstraint(C("Radius", i, r))
    if r_e:
        bind[ir] = r_e
    if abs(x) < 1e-9 and abs(y) < 1e-9 and not x_e and not y_e:
        sk.addConstraint(C("Coincident", i, 3, -1, 1))
    else:
        ix = sk.addConstraint(C("DistanceX", -1, 1, i, 3, x))
        iy = sk.addConstraint(C("DistanceY", -1, 1, i, 3, y))
        if x_e:
            bind[ix] = x_e
        if y_e:
            bind[iy] = y_e
    out = {"type": "arc", "geo": [i]}
    if bind:
        out["bind"] = bind
    return out


def _sk_polyline(sk, C, Part, V, g):
    """A chain of segments through points, optionally closed.

    This is the channel for a GENERATED profile -- an involute flank, a cam,
    an offset outline -- which is the case rect/circle cannot express and the
    reason freecad_script used to be the only way to draw one.

    Points are joined Coincident so the chain is one wire; they are NOT
    dimensioned, because 200 computed points want 400 dimensions nobody will
    read. That leaves the sketch under-constrained, which lint reports and
    which would be noise on every turn -- so 'fix: true' blocks the geometry
    instead. Blocked is honest: these points came from a formula, not from a
    design intent a solver could preserve.
    """
    pts = g.get("points")
    if not isinstance(pts, list) or len(pts) < 2:
        raise KoiOpError("polyline needs points:[[x,y], ...] with at least two")
    if len(pts) > 400:
        raise KoiOpError(
            "polyline is capped at 400 points (got %d); a profile that dense "
            "is a spline, and a sketch that large recomputes slowly on every "
            "downstream edit" % len(pts))
    for i, pt in enumerate(pts):
        if not (isinstance(pt, list) and len(pt) >= 2):
            raise KoiOpError("polyline points[%d] must be [x, y]" % i)
    closed = bool(g.get("closed"))
    construction = bool(g.get("construction"))
    n = len(pts)
    segs = n if closed else n - 1
    gs = []
    for i in range(segs):
        a = pts[i]
        b = pts[(i + 1) % n]
        if abs(float(a[0]) - float(b[0])) < 1e-9 and \
                abs(float(a[1]) - float(b[1])) < 1e-9:
            raise KoiOpError(
                "polyline points[%d] and points[%d] are the same point; a "
                "zero-length segment will not build" % (i, (i + 1) % n))
        gs.append(sk.addGeometry(
            Part.LineSegment(V(float(a[0]), float(a[1]), 0),
                             V(float(b[0]), float(b[1]), 0)), construction))
    for i in range(len(gs) - 1):
        sk.addConstraint(C("Coincident", gs[i], 2, gs[i + 1], 1))
    if closed and len(gs) > 2:
        sk.addConstraint(C("Coincident", gs[-1], 2, gs[0], 1))
    blocked = 0
    if g.get("fix"):
        for i in gs:
            try:
                sk.addConstraint(C("Block", i))
                blocked += 1
            except Exception:
                # Not every build carries Block. Reported rather than raised:
                # a loose generated profile still pads, it just lints.
                break
    return {"type": "polyline", "geo": gs, "closed": closed,
            "points": len(pts), "blocked": blocked}


def _sk_bspline(sk, C, Part, V, g):
    """A B-spline through control poles.

    polyline caps at 400 points because a sketch that dense recomputes slowly
    on every downstream edit -- but a 72-tooth involute flank IS that dense as
    line segments, and capping it just pushes the profile out of the whitelist
    and into a script. A spline says the same curve in 40 poles, which is what
    the cap was protecting in the first place.

    Poles, not interpolation: buildFromPoles is the one construction every
    build here exposes, and a caller computing an involute already has the
    curve in hand. Blocked with fix:true for the same reason polyline is --
    these points came from a formula, not from an intent a solver can keep.
    """
    poles = g.get("poles") or g.get("points")
    if not isinstance(poles, list) or len(poles) < 3:
        raise KoiOpError("bspline needs poles:[[x,y], ...] with at least three")
    if len(poles) > 200:
        raise KoiOpError(
            "bspline is capped at 200 poles (got %d); past that the sketch "
            "solver costs more on every downstream edit than the profile is "
            "worth" % len(poles))
    for i, p in enumerate(poles):
        if not (isinstance(p, list) and len(p) >= 2):
            raise KoiOpError("bspline poles[%d] must be [x, y]" % i)
    periodic = bool(g.get("closed") or g.get("periodic"))
    pts = [V(float(p[0]), float(p[1]), 0) for p in poles]
    try:
        bs = Part.BSplineCurve()
        bs.buildFromPoles(pts, periodic)
    except Exception as e:
        raise KoiOpError(
            "this build would not build a B-spline from %d poles (%s: %s); "
            "fall back to polyline for this profile"
            % (len(pts), type(e).__name__, e))
    try:
        i = sk.addGeometry(bs, bool(g.get("construction")))
    except Exception as e:
        raise KoiOpError(
            "this build's Sketcher would not accept a B-spline (%s: %s); "
            "fall back to polyline for this profile" % (type(e).__name__, e))
    blocked = 0
    if g.get("fix"):
        try:
            sk.addConstraint(C("Block", i))
            blocked = 1
        except Exception:
            # Same as polyline: reported rather than raised. A loose generated
            # profile still pads, it just lints.
            blocked = 0
    return {"type": "bspline", "geo": [i], "poles": len(pts),
            "periodic": periodic, "blocked": blocked}


# One table, two callers. sketch builds a profile and sketch_edit adds to
# one that already exists; a primitive that only half of them accepts is a
# primitive that works until the day somebody edits instead of rebuilding.
SK_BUILDERS = {"rect": _sk_rect, "circle": _sk_circle, "slot": _sk_slot,
               "line": _sk_line, "arc": _sk_arc, "polyline": _sk_polyline,
               "bspline": _sk_bspline}


def _sk_constraint(C, c):
    if not isinstance(c, dict):
        raise KoiOpError("each constraint must be an object")
    t = c.get("type")
    a = c.get("args")
    if not isinstance(t, str) or not isinstance(a, list):
        raise KoiOpError("constraint needs type:str and args:[...]")
    return C(*([t] + list(a)))


# ---------- viewport hygiene ----------
#
# The human is watching this document in a stream, and everything built here
# is scaffolded: a datum plane per feature, a sketch per feature, every one of
# them a translucent sheet in front of the solid. The session that produced
# this code ended with the model invisible behind six datum planes and the
# user asking what had gone wrong. Nothing had. They simply could not see it,
# which for a co-design session is the same thing.
#
# So construction geometry is hidden the moment the feature that consumed it
# exists, and the camera is re-fitted when the model outgrows the view. Both
# are reported rather than silent: hiding something changes what the user
# sees, and they did not ask for it.

AUTO_VIEW_KEY = "koi.view.auto"
CONSTRUCTION_TYPES = ("PartDesign::Plane", "PartDesign::Line",
                      "PartDesign::Point", "PartDesign::CoordinateSystem")
FIT_GROWTH = 1.25       # re-fit when the visible model outgrows the view
# An origin plane is INFINITE. Its BoundBox comes back at 1e100 per axis and
# the diagonal at 3.46e100 -- which is the span every view_fit reported on any
# document containing a Body, because a Body brings an Origin with it. It is
# not a large model; it is a plane. Anything past this is scaffolding
# pretending to be geometry, and no real part is a kilometre across.
SPAN_MAX = 1.0e6        # mm
CONTAINER_TYPES = ("App::Part", "App::DocumentObjectGroup", "PartDesign::Body")


def _suppressed(o):
    """Whether this feature has been switched off rather than deleted.

    PartDesign features carry a Suppressed flag, and it is the answer to the
    failure that cost a session its Tip: deleting a feature in the MIDDLE of a
    body rewires BaseFeature for everything after it, and doing that in the
    same transaction as a recreate collapsed a 102009 mm3 body to the 1289 mm3
    of the one cut that survived. Suppression takes the material away and
    leaves the DAG, the ids and the user's references where they were.
    """
    try:
        return bool(getattr(o, "Suppressed", False))
    except Exception:
        return False


def _visible(o):
    try:
        return bool(getattr(o, "Visibility", False))
    except Exception:
        return False


def _ours(doc, o):
    """Did this session make it? Only our own scaffolding gets hidden.

    A datum plane the human made is theirs, and turning it off because our
    sketch happened to attach to it is exactly the sort of quiet edit 5.2
    exists to prevent.
    """
    try:
        return bool(_meta(doc).get(ORIGIN_PREFIX + o.Name))
    except Exception:
        return False


def _hide(doc, o, hidden):
    if o is None or not _visible(o):
        return False
    try:
        o.Visibility = False
    except Exception:
        return False
    hidden.append(o.Name)
    return True


def _container_of(o):
    """The Part, Body or group that owns this object, or None."""
    try:
        for p in (o.InList or [])[:64]:
            if str(getattr(p, "TypeId", "")) not in CONTAINER_TYPES:
                continue
            try:
                if o.Name in [c.Name for c in (getattr(p, "Group", []) or [])]:
                    return p
            except Exception:
                continue
    except Exception:
        pass
    return None


def _drawn(doc, o):
    """Is this object's SOLID on screen right now, and what is switching it off?

    Visibility is a property of a container as much as of a shape, and the two
    disagree in exactly the case that costs a session: after split_body the
    solid lives in a PartDesign::FeatureBase, and hiding that leaves the Body
    reading Visibility True with nothing drawn. show() answering already:True
    was correct about the container and useless about the shape -- the reply
    said the assembly was framed while the screen held six floating bolts.

    So this walks to whatever actually carries the shape, then up through
    everything that can switch it off, and reports the objects responsible by
    name rather than a bare boolean.
    """
    chain = []
    shape_from = o
    if str(getattr(o, "TypeId", "")) == "PartDesign::Body":
        tip = getattr(o, "Tip", None)
        if tip is not None:
            shape_from = tip
            chain.append(tip)
    cur = o
    seen = set()
    for _ in range(8):
        if cur is None or cur.Name in seen:
            break
        seen.add(cur.Name)
        chain.append(cur)
        cur = _container_of(cur)
    off = []
    for c in chain:
        try:
            if "Visibility" in c.PropertiesList and not _visible(c):
                off.append(c.Name)
        except Exception:
            continue
    return {"drawn": not off, "hiddenBy": off, "shapeFrom": shape_from.Name}


def _finite_bb(bb):
    try:
        vals = (bb.XMin, bb.YMin, bb.ZMin, bb.XMax, bb.YMax, bb.ZMax)
    except Exception:
        return False
    for v in vals:
        try:
            if not _math.isfinite(float(v)) or abs(float(v)) > SPAN_MAX:
                return False
        except Exception:
            return False
    return True


def _bbox_of(o):
    sh = getattr(o, "Shape", None)
    if sh is None:
        return None
    try:
        if sh.isNull():
            return None
        bb = sh.BoundBox
    except Exception:
        return None
    if not _finite_bb(bb):
        return None
    return [[round(bb.XMin, 3), round(bb.YMin, 3), round(bb.ZMin, 3)],
            [round(bb.XMax, 3), round(bb.YMax, 3), round(bb.ZMax, 3)]]


def _target_report(doc, o):
    """What a caller needs to claim, or not claim, that the user can see this.

    label, volume, bbox and actuallyDrawn per target -- the four the reply was
    missing when it reported a framed assembly over an empty viewport.
    """
    d = _drawn(doc, o)
    shp = doc.getObject(d["shapeFrom"]) or o
    row = {"name": o.Name, "label": o.Label, "id": _id_of(doc, o.Name),
           "visible": _visible(o), "drawn": d["drawn"],
           "shapeFrom": d["shapeFrom"], "volume": _vol(shp)}
    if d["hiddenBy"]:
        row["hiddenBy"] = d["hiddenBy"]
    bb = _bbox_of(shp)
    if bb:
        row["bbox"] = bb
    return row


def _supports_of(obj):
    """Whatever this object is attached to, on either spelling of the property."""
    out = []
    for prop in ATTACH_PROPS:
        if prop not in obj.PropertiesList:
            continue
        try:
            for pair in (getattr(obj, prop) or []):
                o = pair[0] if isinstance(pair, (tuple, list)) else pair
                if o is not None:
                    out.append(o)
        except Exception:
            continue
    return out


def _tidy_construction(doc, sk):
    """Hide a consumed profile sketch and the datum it stands on."""
    hidden = []
    if sk is None:
        return hidden
    _hide(doc, sk, hidden)
    for owner in _supports_of(sk):
        if str(getattr(owner, "TypeId", "")) in CONSTRUCTION_TYPES and \
                _ours(doc, owner):
            _hide(doc, owner, hidden)
    return hidden


def _span_detail(doc):
    """The extent of the visible MODEL, and what was left out of it.

    Datums and origin planes are excluded by type and anything with a
    non-finite or absurd bounding box by measurement, because those are the
    same objects arriving by two routes and either one alone let a 3.46e100
    span through. A span that large is not a fact about the model; it made
    every fit useless and every "is it framed" answer a guess.
    """
    lo = [None, None, None]
    hi = [None, None, None]
    seen = []
    ignored = []
    for o in doc.Objects[:400]:
        if not _visible(o):
            continue
        if str(getattr(o, "TypeId", "")) in DATUM_TYPES:
            ignored.append(o.Name)
            continue
        sh = getattr(o, "Shape", None)
        if sh is None:
            continue
        try:
            if sh.isNull():
                continue
            bb = sh.BoundBox
        except Exception:
            continue
        if not _finite_bb(bb):
            ignored.append(o.Name)
            continue
        mins = (bb.XMin, bb.YMin, bb.ZMin)
        maxs = (bb.XMax, bb.YMax, bb.ZMax)
        for i in range(3):
            lo[i] = mins[i] if lo[i] is None else min(lo[i], mins[i])
            hi[i] = maxs[i] if hi[i] is None else max(hi[i], maxs[i])
        seen.append(o.Name)
    span = None
    if seen and lo[0] is not None:
        span = round(_math.sqrt(sum((hi[i] - lo[i]) ** 2 for i in range(3))), 6)
    # Deliberately NOT "visible": show() already uses that key for the
    # boolean it was asked for, and merging this dict into its reply
    # overwrote the answer with a list of names.
    out = {"span": span, "spanFrom": seen[:64], "spanCount": len(seen)}
    if ignored:
        out["ignored"] = ignored[:32]
        out["ignoredNote"] = (
            "%d infinite or datum object(s) are visible and are NOT part of "
            "the span: an origin plane measures 1e100 across and would be the "
            "only thing the camera ever fitted" % len(ignored))
    if span is not None and lo[0] is not None:
        out["bbox"] = [[round(lo[i], 3) for i in range(3)],
                       [round(hi[i], 3) for i in range(3)]]
    return out


def _doc_span(doc):
    """The diagonal of the visible model, or None for an empty view."""
    return _span_detail(doc)["span"]


def _auto_view(doc):
    return _meta(doc).get(AUTO_VIEW_KEY) != "off"


def _fit_view():
    if Gui is None:
        return False
    try:
        gdoc = Gui.ActiveDocument
        if gdoc is None and App.ActiveDocument is not None:
            try:
                gdoc = Gui.getDocument(App.ActiveDocument.Name)
            except Exception:
                gdoc = None
        if gdoc is None:
            return False
        view = getattr(gdoc, "ActiveView", None)
        if view is None and hasattr(gdoc, "activeView"):
            try:
                view = gdoc.activeView()
            except Exception:
                view = None
        if view and hasattr(view, "fitAll"):
            try:
                view.fitAll()
            except Exception:
                pass
        try:
            Gui.SendMsgToActiveView("ViewFit")
        except Exception:
            pass
        try:
            if view and hasattr(view, "repaint"):
                view.repaint()
            if hasattr(Gui, "updateGui"):
                Gui.updateGui()
        except Exception:
            pass
        return True
    except Exception:
        return False


_QT_WIDGETS = None


def _qt_widgets():
    """PySide's widget module, or None. Imported lazily, once, and cached.

    Not assumed to be in globals(). The first version of this tested
    'QtGui' in globals(), which is False in this module on every build --
    nothing ever imports it -- so the branch that raised the document window
    was dead code that read as a fix. QMdiArea moved from QtGui to QtWidgets
    in Qt5, so the Qt4 spelling is the LAST thing tried rather than the first.
    """
    global _QT_WIDGETS
    if _QT_WIDGETS is not None:
        return _QT_WIDGETS or None
    mod = False
    for name, attr in (("PySide6", "QtWidgets"), ("PySide2", "QtWidgets"),
                       ("PySide", "QtWidgets"), ("PySide", "QtGui")):
        try:
            m = __import__(name, globals(), locals(), [attr])
            cand = getattr(m, attr, None)
            if cand is not None and hasattr(cand, "QMdiArea"):
                mod = cand
                break
        except Exception:
            continue
    _QT_WIDGETS = mod
    return _QT_WIDGETS or None


def _raise_document_window(doc):
    """Bring this document's own MDI tab to the front.

    A two-document session -- the model and the parameter spreadsheet, which
    is every session that uses koi_params -- can leave the spreadsheet tab in
    front while the model is edited behind it. The human watching the stream
    then sees a table of numbers and concludes nothing was built.
    """
    w = _qt_widgets()
    if Gui is None or w is None or doc is None:
        return False
    try:
        mw = Gui.getMainWindow()
        mdi = mw.findChild(w.QMdiArea) if mw is not None else None
        if mdi is None:
            return False
        wanted = [n for n in (getattr(doc, "Name", None),
                              getattr(doc, "Label", None)) if n]
        matches = [sw for sw in mdi.subWindowList()
                   if any(n in (sw.windowTitle() or "") for n in wanted)]
        if not matches:
            return False
        # Prefer the 3D view over the spreadsheet tab of the SAME document:
        # koi_params opens one, and raising it hides the model behind a table
        # of numbers, which is the failure this function exists to undo.
        pick = matches[0]
        for sw in matches:
            try:
                if _is_3d_view(sw.widget()):
                    pick = sw
                    break
            except Exception:
                continue
        if mdi.activeSubWindow() is not pick:
            mdi.setActiveSubWindow(pick)
        try:
            pick.raise_()
        except Exception:
            pass
        return True
    except Exception:
        return False


GUI_SYNC_KEY = "koi.view.sync"


def _gui_sync(doc):
    """Make the human's window show the document we just changed.

    Deliberately NOT part of _auto_fit, and the reason is the bug this fixes.
    Whether the CAMERA moves is the human's business and is rationed on
    purpose -- a view that jumps on every pocket is worse than one that never
    moves. Whether the viewport REDRAWS is not a policy question at all: a
    window still showing the pre-pocket solid is simply wrong. Because the
    only Gui.updateGui() on the write path lived inside _fit_view, and
    _fit_view only ran when the model grew by a quarter, every ordinary edit
    -- pocket, fillet, draft, a parameter change -- completed with no repaint
    at all. freecad_render looked right the whole time because saveImage()
    renders the scene graph offscreen and never touches the on-screen view,
    which is exactly why the two disagreed.

    Cheap enough to run unconditionally: on an unchanged view the redraw is a
    no-op, and updateGui() is one pass of the event loop.
    """
    if Gui is None:
        return None
    if _meta(doc).get(GUI_SYNC_KEY) == "off":
        return {"synced": False, "why": "view_fit({sync: false})"}
    out = {"raised": _raise_document_window(doc), "redrawn": False}
    gdoc, view, is_front = _resolve_gui_view(doc)
    if view is None:
        out["note"] = ("no 3D view in this document to redraw -- the viewport "
                       "the human is watching may be stale")
        return out
    out["frontTab"] = bool(is_front)
    # redraw() is the Coin-level invalidate and is what a scene-graph change
    # actually needs; repaint()/update() are the Qt fallbacks for builds that
    # do not expose it.
    for name in ("redraw", "repaint", "update"):
        fn = getattr(view, name, None)
        if not callable(fn):
            continue
        try:
            fn()
            out["redrawn"] = True
            out["how"] = name
            break
        except Exception:
            continue
    try:
        Gui.updateGui()
        out["pumped"] = True
    except Exception:
        out["pumped"] = False
    if not out["redrawn"] and not out.get("pumped"):
        out["note"] = ("the 3D view refused both a redraw and an event-loop "
                       "pass; treat what the human can see as stale and say so")
    return out


def _auto_fit(doc, before):
    """Re-centre the camera when the model outgrew the view.

    Not on every edit: the camera belongs to the human, and a view that jumps
    on every pocket is worse than one that never moves. It fires when there
    was nothing to see before, or when the visible extent grew by a quarter,
    which is what a new body and a doubled plate look like from here. It never
    fires on a shrink, so isolate does not move their camera.
    """
    if Gui is None or not _auto_view(doc):
        return None
    after = _doc_span(doc)
    if after is None or after <= 1e-9:
        return None
    if before is not None and before > 1e-9 and after <= before * FIT_GROWTH:
        return None
    if not _fit_view():
        return None
    return {"fitted": True, "spanBefore": before, "spanAfter": after,
            "why": "the model outgrew the view" if before else
                   "there was nothing in the view"}


def _op_view_fit(doc, args, kid):
    """Fit now, and/or turn the automatic fit off for this document."""
    out = {}
    if "auto" in args:
        _meta_set(doc, AUTO_VIEW_KEY, "on" if args.get("auto") else "off")
    if "sync" in args:
        _meta_set(doc, GUI_SYNC_KEY, "on" if args.get("sync") else "off")
    out["auto"] = _auto_view(doc)
    out["sync"] = _meta(doc).get(GUI_SYNC_KEY) != "off"
    out.update(_span_detail(doc))
    if out.get("span") is None:
        out["emptyNote"] = (
            "nothing with a finite shape is visible, so there is nothing to "
            "fit. Do not report a framed model")
    if Gui is None or Gui.ActiveDocument is None:
        out["fitted"] = False
        out["error"] = "no GUI document to fit -- this FreeCAD is headless"
        return out
    out["fitted"] = _fit_view()
    out["guiSync"] = _gui_sync(doc)
    return out


def _op_body(doc, args, kid):
    b = doc.addObject(
        "PartDesign::Body", _safe_name(kid or args.get("label"), "Body"))
    if args.get("label"):
        b.Label = str(args["label"])
    register(doc, kid, b, args.get("turn"))
    return {"name": b.Name, "label": b.Label}


# ---------- external geometry ----------
#
# The hole the parametric story had. Every dimension in this skill traces back
# to koi_params or to a literal; nothing could trace back to the MODEL. So a
# cover plate sketched to match a housing carried the housing's width as a
# number, and the day the housing changed the plate silently did not.
#
# addExternal projects a model edge or face into the sketch, and constraints
# can then be written against it -- which is the difference between a plate
# that is 60 mm wide and a plate that is as wide as the thing it bolts to.
#
# It is addressed the same way fillet addresses an edge, and for the same
# reason: refs from a user pick, or a query whose FILTER is stored and re-run.
# An authored Edge7 renumbers on the next upstream edit, and here that does
# not merely error -- FreeCAD drops every constraint that referenced it.

EXT_PREFIX = "koi.ext."
EXTERNAL_LIMIT = 32
# GeoIds: -1 is the sketch's X axis, -2 its Y axis, and external geometry
# starts at -3 in the order it was added. This is the address a constraint
# uses, so the op reports it rather than leaving the caller to count.
EXTERNAL_GEOID_BASE = -3


def _ext_count(sk):
    try:
        return len(list(getattr(sk, "ExternalGeometry", []) or []))
    except Exception:
        return 0


def _constraint_count(sk):
    try:
        return len(list(getattr(sk, "Constraints", []) or []))
    except Exception:
        return 0


def _ext_refs(doc, body, args, what):
    """(refs, stored filter) for external geometry -- or (None, None).

    Same contract as _dress_target: external:[...] from a user pick, or
    query:{...} whose description survives a renumber. Defaults to kind
    'edge', which is what a sketch projects in almost every case.
    """
    refs = args.get("external") or args.get("externals")
    if isinstance(refs, str):
        refs = [refs]
    if refs and not isinstance(refs, list):
        raise KoiOpError("external must be a list of refs, not %r" % (refs,))
    qspec = None
    if not refs and args.get("query"):
        # Positionally compatible with both signatures of _dress_query: edge
        # is its default and is what a sketch projects in almost every case,
        # so this does not depend on the kind parameter existing.
        refs, qspec = _dress_query(doc, body, args, what)
    if not refs:
        return None, None
    if len(refs) > EXTERNAL_LIMIT:
        raise KoiOpError(
            "external geometry is capped at %d references per sketch"
            % EXTERNAL_LIMIT)
    return refs, qspec


def _add_externals(doc, sk, refs, what):
    """Project each ref into the sketch, and report the GeoId it landed on.

    Verified by counting rather than by trusting the call: addExternal
    returns a build-dependent value and refuses silently on some of them, and
    an external that was never added reads exactly like one that was until a
    constraint against its GeoId fails to solve.
    """
    out = []
    for r in refs:
        owner, sub = _resolve_ref_sub(doc, r)
        if owner is None:
            raise KoiOpError("%r did not resolve to an object" % (r,))
        if not sub:
            raise KoiOpError(
                "%r names an object, not an edge or face; %s needs an element "
                "reference" % (r, what))
        if owner.Name == sk.Name:
            raise KoiOpError(
                "a sketch cannot project its own geometry as external")
        before = _ext_count(sk)
        try:
            sk.addExternal(owner.Name, sub)
        except Exception as e:
            msg = str(e)
            if "circular" in msg.lower() or "dependency" in msg.lower():
                raise KoiOpError(
                    "%s:%s is downstream of this sketch, so projecting it "
                    "would make the document depend on itself. Project from a "
                    "feature EARLIER in the tree, or from another body through "
                    "fn 'bind'." % (owner.Name, sub))
            raise KoiOpError(
                "could not project %s:%s into %s: %s: %s"
                % (owner.Name, sub, sk.Name, type(e).__name__, e))
        after = _ext_count(sk)
        if after != before + 1:
            raise KoiOpError(
                "%s:%s was not projected into %s -- the call did not raise "
                "and the external list is unchanged at %d. PartDesign refuses "
                "geometry from another body this way; use fn 'bind' for that."
                % (owner.Name, sub, sk.Name, after))
        out.append({"ref": "%s:%s" % (owner.Name, sub),
                    "owner": owner.Name, "sub": sub,
                    "geoId": EXTERNAL_GEOID_BASE - before})
    return out


def _ext_remember(doc, sk, refs, qspec):
    """Keep the filter, and the refs it produced, next to the sketch."""
    rec = {"refs": [r.get("ref") for r in refs]}
    if qspec:
        rec["query"] = dict(qspec)
    _meta_set(doc, EXT_PREFIX + sk.Name, _json.dumps(rec))


def _ext_durability(qspec, what):
    if qspec:
        return ("the filter is kept with this sketch, so an upstream change "
                "that renumbers the edges is re-resolved instead of dropping "
                "the projection. It is re-derived, not durable: check the "
                "result")
    return ("these are element INDICES. An upstream change renumbers them, "
            "and FreeCAD DELETES every constraint that referenced the "
            "projection when that happens -- which is worse than an error, "
            "because the sketch still solves. Place it with query:{...} "
            "instead if the model is still moving")


def _reheal_external(doc, names):
    """Re-run the stored filter for sketches whose projection just broke.

    Separate from _reheal_dress because the repair is destructive: putting an
    external back means deleting the old one, and FreeCAD drops every
    constraint that referenced its GeoId when it goes. So the constraints are
    counted before and after, and a heal that cost the sketch constraints is
    reported as a loss rather than as a fix.
    """
    healed = []
    m = _meta(doc)
    for name in list(names)[:16]:
        raw = m.get(EXT_PREFIX + str(name))
        if not raw:
            continue
        sk = doc.getObject(str(name))
        if sk is None:
            continue
        try:
            rec = _json.loads(raw)
            q = dict(rec.get("query") or {})
        except Exception:
            continue
        if not q:
            # Placed by ref, not by filter. There is nothing to re-derive, and
            # guessing would be authoring an index.
            continue
        was_refs = list(rec.get("refs") or [])
        was_constraints = _constraint_count(sk)
        try:
            res = query(q, doc)
        except Exception:
            continue
        refs = list(res.get("refs") or [])
        if not refs or refs == was_refs:
            continue
        try:
            for i in range(_ext_count(sk) - 1, -1, -1):
                sk.delExternal(i)
            added = _add_externals(doc, sk, refs, "external geometry")
        except Exception:
            continue
        now_constraints = _constraint_count(sk)
        rec["refs"] = [r["ref"] for r in added]
        _meta_set(doc, EXT_PREFIX + sk.Name, _json.dumps(rec))
        row = {"sketch": sk.Name, "was": was_refs,
               "now": rec["refs"], "matched": res.get("matched"),
               "constraintsBefore": was_constraints,
               "constraintsAfter": now_constraints}
        if now_constraints < was_constraints:
            row["lostConstraints"] = was_constraints - now_constraints
            row["note"] = (
                "re-projecting cost this sketch %d constraint(s): FreeCAD "
                "deletes what referenced the old projection. The sketch may "
                "solve and be the wrong shape -- check it before reporting "
                "the edit" % (was_constraints - now_constraints))
        healed.append(row)
    return healed


def _op_bind(doc, args, kid):
    """A SubShapeBinder: geometry from ELSEWHERE, usable in this body.

    addExternal refuses across bodies, which is the case that matters --
    a cover plate is its own body and the housing it matches is another. The
    binder is a real object in the target body holding a link to the source,
    so a sketch can attach to it or project from it like anything local, and
    it follows the source when the source moves.
    """
    body = _resolve_body(doc, args.get("body"), args)
    raw = args.get("of") or args.get("target") or args.get("source")
    if not raw:
        raise KoiOpError(
            "bind needs of: the object, or '<object>:Face3', to bring into "
            "this body")
    owner, sub = _resolve_ref_sub(doc, raw)
    if owner is None:
        raise KoiOpError("of %r did not resolve" % (raw,))
    b = body.newObject("PartDesign::SubShapeBinder", _safe_name(kid, "Binder"))
    try:
        b.Support = [(owner, [sub] if sub else [""])]
    except Exception as e:
        raise KoiOpError(
            "could not bind %s to %s: %s: %s"
            % (owner.Name, body.Name, type(e).__name__, e))
    # Relative binders track the source through its container placement, which
    # is what "follows the housing" means once the housing sits in an App::Part.
    if "relative" in args:
        _set_if(b, "Relative", bool(args["relative"]))
    b.Label = str(args.get("label") or kid)
    if args.get("visible") is not True:
        try:
            b.Visibility = False
        except Exception:
            pass
    doc.recompute()
    if not b.isValid():
        raise KoiOpError(
            "the binder did not build on %s%s: %s"
            % (owner.Name, (":" + sub) if sub else "",
               ", ".join(list(getattr(b, "State", []))) or "invalid"))
    register(doc, kid, b, args.get("turn"))
    return {"name": b.Name, "of": owner.Name, "sub": sub or None,
            "relative": bool(getattr(b, "Relative", False)),
            "bbox": _bbox_of(b),
            "note": ("project from this with sketch({external: ['%s:Edge1']}) "
                     "or attach to it with sketch({on: '%s'}) -- it is a "
                     "local object now, and it moves when %s moves"
                     % (kid or b.Name, kid or b.Name, owner.Name))}


def _op_sketch(doc, args, kid):
    import Part
    import Sketcher
    from FreeCAD import Vector as V

    body = _resolve_body(doc, args.get("body"), args)
    geom = args.get("geometry")
    if not isinstance(geom, list) or not geom:
        raise KoiOpError("geometry must be a non-empty list")
    if len(geom) > 64:
        raise KoiOpError("geometry is capped at 64 primitives per sketch")

    sk = doc.addObject(
        "Sketcher::SketchObject", _safe_name(kid, "Sketch"))
    body.addObject(sk)
    # 'on' is an origin plane OR a datum/ref id. Attaching at creation rather
    # than making the caller follow every sketch with fn 'attach' saves a
    # round trip, a transaction and a confirmation for one intent -- and the
    # readback is the same one 'attach' does, so it cannot silently no-op.
    on = args.get("on") or args.get("plane") or "XY"
    if str(on).upper() in ("XY", "XZ", "YZ"):
        _attach(sk, _origin_plane(body, on))
        attached_to = str(on).upper()
    else:
        owner, sub = _resolve_ref_sub(doc, on)
        if owner is None:
            raise KoiOpError(
                "on %r is neither an origin plane (XY, XZ, YZ) nor anything "
                "that resolves; pass a datum id or a captured ref" % (on,))
        offset = None if args.get("offset") is None else _num(args, "offset")
        attached_to = owner.Name + ((":" + sub) if sub else "")
        read = _attach_map(doc, sk, owner, sub, args.get("mode"), offset)
        if not read.get("support"):
            raise KoiOpError(
                "%s exposes neither AttachmentSupport nor Support, so the "
                "sketch could not be attached to %s on this build"
                % (sk.Name, owner.Name))
        if not read.get("moved"):
            raise KoiOpError(
                "the sketch attached to %s but stayed at the origin: it "
                "reads %s and %s is at %s. Modes tried: %s. A sketch built "
                "here would pad in the wrong place, so this refuses rather "
                "than building it."
                % (attached_to, read.get("placement"), owner.Name,
                   read.get("targetAt"), ", ".join(read.get("modesTried") or [])))

    # Projected BEFORE the primitives. External GeoIds are assigned in the
    # order they are added and a constraint written against one has to know
    # its address, so they are fixed before anything can reference them.
    ext_refs, ext_qspec = _ext_refs(doc, body, args, "external geometry")
    externals = (_add_externals(doc, sk, ext_refs, "external geometry")
                 if ext_refs else [])

    C = Sketcher.Constraint
    made = []
    builders = SK_BUILDERS
    for i, g in enumerate(geom):
        if not isinstance(g, dict):
            raise KoiOpError("geometry[%d] must be an object" % i)
        b = builders.get(g.get("type"))
        if b is None:
            raise KoiOpError(
                "geometry[%d]: unknown type %r (rect, circle, line, arc, "
                "polyline, bspline)"
                % (i, g.get("type")))
        made.append(b(sk, C, Part, V, g))

    extra = args.get("constraints") or []
    if len(extra) > 128:
        raise KoiOpError("constraints are capped at 128 per sketch")
    for c in extra:
        sk.addConstraint(_sk_constraint(C, c))

    # The expressions the primitives asked for, on the constraint indices the
    # builders actually landed on. Bound here rather than in the builders so
    # the whole sketch exists first: an expression that fails to take must not
    # leave half a profile behind, and raising here is inside the envelope.
    bindings = []
    for m in made:
        for idx, expr in sorted((m.pop("bind", None) or {}).items()):
            try:
                sk.setExpression("Constraints[%d]" % int(idx), expr)
            except Exception as e:
                raise KoiOpError(
                    "could not bind constraint %d to %r: %s: %s"
                    % (int(idx), expr, type(e).__name__, e))
            bindings.append({"constraint": int(idx), "expression": expr})

    if args.get("visible") is False or args.get("visible") is None:
        sk.Visibility = False
    doc.recompute()
    register(doc, kid, sk, args.get("turn"))
    out = {"name": sk.Name, "geometry": made, "on": attached_to,
           "conflicts": [int(x) for x in (getattr(sk, "ConflictingConstraints", None) or [])],
           "redundancies": [int(x) for x in (getattr(sk, "RedundantConstraints", None) or [])]}
    if externals:
        _ext_remember(doc, sk, externals, ext_qspec)
        out["external"] = externals
        out["externalDurability"] = _ext_durability(ext_qspec, "sketch")
        if ext_qspec:
            out["externalQuery"] = ext_qspec
        out["externalNote"] = (
            "geoId is the address a constraint uses: "
            "constraints:[{type:'Distance', args:[%d, 1, 0, 5.0]}] measures "
            "from the first projection. A sketch that PROJECTS a dimension "
            "and then writes it as a literal anyway has not become "
            "parametric; constrain to the projection or do not project it."
            % (externals[0]["geoId"],))
    if bindings:
        # Read back, for the reason bolt_sketch reads its own binding back: a
        # dimension that silently stayed a literal looks identical until the
        # day somebody changes the parameter and nothing moves.
        engine = {}
        try:
            engine = dict((p[0], p[1]) for p in (sk.ExpressionEngine or []))
        except Exception:
            engine = {}
        for b in bindings:
            path = "Constraints[%d]" % b["constraint"]
            b["verified"] = bool(path in engine or ("." + path) in engine)
            try:
                b["value"] = _plain(sk.Constraints[b["constraint"]].Value)
            except Exception:
                b["value"] = None
        out["bindings"] = bindings
        if not all(b["verified"] for b in bindings):
            out["bindingNote"] = (
                "at least one dimension did not keep its expression and is a "
                "literal: it will NOT follow a change to the parameter. Say "
                "so rather than reporting a parametric sketch.")
    out.update(_sk_dof(sk))
    # Reported here and REFUSED at pad/pocket, deliberately: a sketch is
    # allowed to be scaffolding (an arc and a line that a later sketch
    # references), and only extruding one that encloses nothing is the error.
    prof = _profile_report(sk)
    if prof is not None:
        out["profile"] = prof
        if not prof.get("closed") or not prof.get("area"):
            out["profileNote"] = (
                "this sketch encloses no area, so pad and pocket will REFUSE "
                "it. Fully constrained and closed-looking is not the same as "
                "closed: check wires vs closed above.")
        elif prof.get("overlaps"):
            out["profileNote"] = (
                "two of these outlines overlap without nesting. PartDesign "
                "will not union them; pad/pocket refuse rather than silently "
                "building one of them. One outline per sketch.")
    return out


def _sk_object(doc, ref):
    sk = _resolve_or_die(doc, ref, "sketch")
    if "Sketch" not in str(getattr(sk, "TypeId", "")):
        raise KoiOpError(
            "%s is a %s, not a sketch. sketch_edit changes profiles; use "
            "feature_edit for a feature's properties."
            % (sk.Name, sk.TypeId))
    return sk


def _sk_is_construction(sk, i):
    for getter in ("getConstruction",):
        try:
            return bool(getattr(sk, getter)(i))
        except Exception:
            pass
    try:
        return bool(sk.Geometry[i].Construction)
    except Exception:
        return False


def _sk_geometry_rows(sk):
    """Every geoId with the numbers that identify it to a human.

    Enough to say WHICH circle without a screenshot, and not the full
    definition of the curve: the caller is choosing a geoId to edit, not
    reconstructing the sketch.
    """
    rows = []
    geo = list(getattr(sk, "Geometry", []) or [])
    for i, g in enumerate(geo):
        kind = type(g).__name__.replace("Geom", "")
        row = {"geoId": i, "type": kind,
               "construction": _sk_is_construction(sk, i)}
        try:
            if kind in ("Circle", "ArcOfCircle"):
                c = g.Center
                row["center"] = [round(c.x, 4), round(c.y, 4)]
                row["radius"] = round(g.Radius, 4)
                if kind == "ArcOfCircle":
                    a0, a1 = g.FirstParameter, g.LastParameter
                    row["angles"] = [round(_math.degrees(a0), 3),
                                     round(_math.degrees(a1), 3)]
            elif kind == "LineSegment":
                s, e = g.StartPoint, g.EndPoint
                row["from"] = [round(s.x, 4), round(s.y, 4)]
                row["to"] = [round(e.x, 4), round(e.y, 4)]
                row["length"] = round(s.distanceToPoint(e), 4)
            elif "BSpline" in kind:
                row["poles"] = len(g.getPoles())
        except Exception:
            pass
        rows.append(row)
    return rows


def _sk_expressions(sk):
    out = {}
    try:
        for path, expr in (sk.ExpressionEngine or []):
            out[str(path).lstrip(".")] = str(expr)
    except Exception:
        pass
    return out


def _sk_constraint_rows(sk):
    engine = _sk_expressions(sk)
    rows = []
    for i, c in enumerate(list(getattr(sk, "Constraints", []) or [])):
        row = {"index": i, "type": str(getattr(c, "Type", "?"))}
        name = str(getattr(c, "Name", "") or "")
        if name:
            row["name"] = name
        for attr, key in (("First", "first"), ("Second", "second"),
                          ("Third", "third")):
            v = getattr(c, attr, None)
            if isinstance(v, int) and v != -2000:
                row[key] = v
        try:
            if getattr(c, "Value", None) is not None:
                row["value"] = _plain(round(float(c.Value), 6))
        except Exception:
            pass
        if getattr(c, "IsDriving", True) is False:
            row["driving"] = False
        expr = engine.get("Constraints[%d]" % i)
        if expr is None and name:
            expr = engine.get("Constraints." + name)
        if expr:
            row["expression"] = expr
        rows.append(row)
    return rows


def _op_sketch_get(doc, args, kid):
    """Read a sketch back: geometry, constraints, bindings, degrees of freedom.

    This exists because sketch_edit could not: an edit addresses a geoId or a
    constraint index, and before this there was no way to learn one except by
    remembering what the call that built the sketch returned -- which is the
    same class of mistake as authoring Face6 from memory, one level down.
    Indices shift when geometry is deleted, so read them in the turn you use
    them.
    """
    sk = _sk_object(doc, _need(args, "target"))
    out = {"name": sk.Name, "label": sk.Label,
           "geometry": _sk_geometry_rows(sk),
           "constraints": _sk_constraint_rows(sk),
           "external": int(getattr(sk, "ExternalGeometry", None) is not None
                           and len(sk.ExternalGeometry) or 0),
           "conflicts": [int(x) for x in
                         (getattr(sk, "ConflictingConstraints", None) or [])],
           "redundancies": [int(x) for x in
                            (getattr(sk, "RedundantConstraints", None) or [])],
           "visible": bool(getattr(sk, "Visibility", False))}
    out.update(_sk_dof(sk))
    prof = _profile_report(sk)
    if prof is not None:
        out["profile"] = prof
    used = [o.Name for o in doc.Objects
            if sk in (getattr(o, "OutList", None) or [])]
    if used:
        out["usedBy"] = used[:16]
        out["usedByNote"] = (
            "editing this sketch rebuilds %s. Dry-run the change if anything "
            "downstream could break." % ", ".join(used[:16]))
    return out


def _op_sketch_edit(doc, args, kid):
    """Change a sketch that already exists, instead of rebuilding it.

    The rule everywhere else in this file is feature_edit before replacement,
    because a rebuild throws away the DAG, the downstream features and the
    user's own references. Sketches were the exception, and they are the
    object that changes most: adding one hole to a profile meant deleting the
    sketch, which meant deleting the pad, which meant deleting everything
    attached to the pad.

    Order is fixed and matters: removals, then geometry, then constraints,
    then expressions. Deleting a geoId renumbers every id above it, so
    removals go last-first and are reported by the ids they had when the call
    was written.

    What this refuses to be quiet about: deleting geometry deletes every
    constraint that referenced it. FreeCAD does that silently, the sketch
    still solves, and what it solves to is a different shape. The constraint
    count before and after comes back either way.
    """
    import Part
    import Sketcher
    from FreeCAD import Vector as V

    sk = _sk_object(doc, _need(args, "target"))
    C = Sketcher.Constraint

    before_dof = _sk_dof(sk)
    before_geo = len(list(getattr(sk, "Geometry", []) or []))
    before_cons = len(list(getattr(sk, "Constraints", []) or []))

    out = {"name": sk.Name, "removed": [], "added": [],
           "constraintsAdded": 0, "constraintsRemoved": []}

    # ---- removals, descending. An ascending loop deletes geoId 2 and then
    # deletes whatever moved into 5, which is not what the caller named.
    rem = args.get("remove")
    if rem is not None:
        if not isinstance(rem, list):
            raise KoiOpError("remove must be a list of geoIds")
        ids_ = sorted(set(int(x) for x in rem), reverse=True)
        for i in ids_:
            if i < 0:
                raise KoiOpError(
                    "geoId %d is external geometry; remove it with "
                    "removeExternal, not remove" % i)
            if i >= before_geo:
                raise KoiOpError(
                    "geoId %d does not exist: this sketch has %d elements "
                    "(0..%d). Read them with fn 'sketch_get' in the same turn "
                    "you edit them -- indices move."
                    % (i, before_geo, before_geo - 1))
            sk.delGeometry(i)
        out["removed"] = sorted(ids_)

    drop = args.get("removeConstraints")
    if drop is not None:
        if not isinstance(drop, list):
            raise KoiOpError("removeConstraints must be a list of indices")
        names = dict((str(getattr(c, "Name", "") or ""), i)
                     for i, c in enumerate(list(sk.Constraints or []))
                     if getattr(c, "Name", ""))
        want = []
        for x in drop:
            if isinstance(x, str) and not x.lstrip("-").isdigit():
                if x not in names:
                    raise KoiOpError("no constraint named %r" % x)
                want.append(names[x])
            else:
                want.append(int(x))
        for i in sorted(set(want), reverse=True):
            sk.delConstraint(i)
        out["constraintsRemoved"] = sorted(set(want))

    # Counted HERE, before anything is added. The builders write constraints
    # of their own (a rect is four lines and eight constraints), so a count
    # taken at the end cannot tell a cascade from a rectangle.
    cons_after_removals = len(list(getattr(sk, "Constraints", []) or []))
    cascade = (before_cons - len(out["constraintsRemoved"])) - cons_after_removals

    # ---- geometry, through the same builders 'sketch' uses.
    add = args.get("add") or []
    if not isinstance(add, list):
        raise KoiOpError("add must be a list of primitives")
    if len(add) > 64:
        raise KoiOpError("add is capped at 64 primitives per call")
    made = []
    for i, g in enumerate(add):
        if not isinstance(g, dict):
            raise KoiOpError("add[%d] must be an object" % i)
        b = SK_BUILDERS.get(g.get("type"))
        if b is None:
            raise KoiOpError(
                "add[%d]: unknown type %r (%s)"
                % (i, g.get("type"), ", ".join(sorted(SK_BUILDERS))))
        made.append(b(sk, C, Part, V, g))
    out["added"] = made

    extra = args.get("constraints") or []
    if not isinstance(extra, list):
        raise KoiOpError("constraints must be a list of {type, args}")
    if len(extra) > 128:
        raise KoiOpError("constraints are capped at 128 per call")
    for c in extra:
        sk.addConstraint(_sk_constraint(C, c))
    out["constraintsAdded"] = len(extra)

    # ---- construction toggles. A profile line that should have been a
    # centreline is a lint warning forever otherwise.
    con = args.get("construction")
    if con is not None:
        if not isinstance(con, dict):
            raise KoiOpError(
                "construction must be an object of {geoId: true|false}")
        toggled = []
        for k, v in con.items():
            i = int(k)
            try:
                sk.setConstruction(i, bool(v))
            except Exception as e:
                raise KoiOpError(
                    "could not set construction on geoId %d: %s: %s"
                    % (i, type(e).__name__, e))
            toggled.append({"geoId": i, "construction": bool(v)})
        out["construction"] = toggled

    # ---- expressions last, on indices that have stopped moving.
    bindings = []
    for m in made:
        for idx, expr in sorted((m.pop("bind", None) or {}).items()):
            bindings.append({"constraint": int(idx), "expression": str(expr)})
    exprs = args.get("expressions")
    if exprs is not None:
        if not isinstance(exprs, dict):
            raise KoiOpError(
                "expressions must be an object of {constraintIndexOrName: "
                "expression}")
        named = dict((str(getattr(c, "Name", "") or ""), i)
                     for i, c in enumerate(list(sk.Constraints or []))
                     if getattr(c, "Name", ""))
        for k, expr in exprs.items():
            key = str(k)
            if key.lstrip("-").isdigit():
                idx = int(key)
            elif key in named:
                idx = named[key]
            else:
                raise KoiOpError(
                    "expressions key %r is neither a constraint index nor the "
                    "name of a constraint on this sketch" % key)
            bindings.append({"constraint": idx, "expression": str(expr)})
    for b in bindings:
        try:
            sk.setExpression("Constraints[%d]" % b["constraint"],
                             b["expression"])
        except Exception as e:
            raise KoiOpError(
                "could not bind constraint %d to %r: %s: %s"
                % (b["constraint"], b["expression"], type(e).__name__, e))

    if args.get("visible") is not None:
        sk.Visibility = bool(args["visible"])

    doc.recompute()

    after_cons = len(list(getattr(sk, "Constraints", []) or []))
    out["geometry"] = _sk_geometry_rows(sk)
    out["constraintCount"] = {"before": before_cons, "after": after_cons}
    out["dofBefore"] = before_dof
    out.update(_sk_dof(sk))
    out["conflicts"] = [int(x) for x in
                        (getattr(sk, "ConflictingConstraints", None) or [])]
    out["redundancies"] = [int(x) for x in
                           (getattr(sk, "RedundantConstraints", None) or [])]

    if bindings:
        engine = _sk_expressions(sk)
        for b in bindings:
            path = "Constraints[%d]" % b["constraint"]
            b["verified"] = bool(path in engine)
            try:
                b["value"] = _plain(sk.Constraints[b["constraint"]].Value)
            except Exception:
                b["value"] = None
        out["bindings"] = bindings
        if not all(b["verified"] for b in bindings):
            out["bindingNote"] = (
                "at least one dimension did not keep its expression and is a "
                "literal: it will NOT follow a change to the parameter. Say "
                "so rather than reporting a parametric sketch.")

    # The measurement this op exists to make impossible to miss. Deleting
    # geometry takes its constraints with it, without an error and without
    # the sketch failing to solve -- it simply solves to a different shape.
    if cascade > 0:
        out["constraintsLost"] = cascade
        out["constraintsLostNote"] = (
            "%d constraint(s) went with the geometry that was removed -- "
            "nobody asked for those. FreeCAD deletes them silently and the "
            "sketch still solves, at whatever shape is left. Check the "
            "profile and the DOF before reporting this edit as clean."
            % cascade)

    prof = _profile_report(sk)
    if prof is not None:
        out["profile"] = prof
        if not prof.get("closed") or not prof.get("area"):
            out["profileNote"] = (
                "this sketch no longer encloses an area, so pad and pocket "
                "will REFUSE it and any feature already built on it is in "
                "error. That is this edit, not something that was already "
                "wrong.")
    return out


PROFILE_AREA_TOL = 1e-6


def _profile_faces(sk):
    """The closed outlines a pad or pocket would actually get from a sketch.

    A Sketch's Shape is a compound of EDGES: no Area, no Faces. So "does this
    profile enclose anything" is not readable off the sketch and was never
    checked -- a closed, fully constrained five-segment polyline that encloses
    nothing came back from fn 'sketch' looking exactly like one that encloses a
    triangle, and the difference only showed up as a pocket that removed 0 and
    reported ok.

    Returns rows with the face objects attached (internal use only -- they do
    not survive JSON), or None when there is no shape to read.
    """
    import Part
    sh = getattr(sk, "Shape", None)
    if sh is None:
        return None
    try:
        if sh.isNull():
            return None
        edges = list(sh.Edges)
    except Exception:
        return None
    if not edges:
        return []
    try:
        clusters = Part.sortEdges(edges)
    except Exception:
        clusters = [edges]
    rows = []
    for cl in clusters:
        row = {"edges": len(cl), "closed": False, "area": None, "face": None}
        try:
            w = Part.Wire(cl)
            row["closed"] = bool(w.isClosed())
        except Exception:
            w = None
        if w is not None and row["closed"]:
            try:
                f = Part.Face(w)
                row["face"] = f
                row["area"] = round(float(f.Area), 6)
            except Exception:
                row["face"] = None
        rows.append(row)
    return rows


def _profile_report(sk):
    """What a sketch encloses, as numbers a caller can act on."""
    rows = _profile_faces(sk)
    if rows is None:
        return None
    closed = [r for r in rows if r["closed"]]
    usable = [r for r in closed if r.get("area")]
    rep = {"wires": len(rows), "closed": len(closed),
           "open": len(rows) - len(closed),
           "areas": [r["area"] for r in usable],
           "area": round(sum(r["area"] for r in usable), 6) if usable else 0.0}
    # Two outlines that overlap PARTIALLY are the multi-profile trap. A
    # circle, a pinch rectangle and an extension rectangle drawn in one sketch
    # do not union: PartDesign builds one of them and reports success, which
    # is how a stem body came back as its pinch boss alone. Nesting is a
    # different thing and legitimate -- an outline fully inside another is a
    # hole -- so the two are told apart by measurement rather than assumed.
    overlaps = []
    nested = []
    for i in range(len(usable)):
        for j in range(i + 1, len(usable)):
            try:
                common = round(float(
                    usable[i]["face"].common(usable[j]["face"]).Area), 6)
            except Exception:
                continue
            if common <= PROFILE_AREA_TOL:
                continue
            inner = min(usable[i]["area"], usable[j]["area"])
            if abs(common - inner) <= PROFILE_AREA_TOL:
                nested.append({"outer": i, "inner": j})
                continue
            overlaps.append({"a": i, "b": j, "commonArea": common})
    if overlaps:
        rep["overlaps"] = overlaps
    if nested:
        # An outline inside another is a hole, and the solid this sketch makes
        # is smaller than the sum above by the area of each one. Said, because
        # "area: 109" on a 100 mm2 plate with a 9 mm2 hole is a number that
        # would otherwise get quoted.
        rep["nested"] = nested
        rep["areaNote"] = ("area is the sum of the outlines; %d of them are "
                           "holes inside another, so the padded face is "
                           "smaller than this" % len(nested))
    return rep


def _profile_gate(sk, what):
    """Refuse to extrude a profile that cannot make the solid it implies.

    Fails closed, like a sketch with conflicting constraints, and for the same
    reason: both produce a feature that recomputes clean and does nothing.
    """
    rep = _profile_report(sk)
    if rep is None:
        return None
    if not rep.get("closed") or not rep.get("area"):
        raise KoiOpError(
            "%s encloses no area to %s: %d wire(s), %d of them closed, total "
            "area %s. A wire whose ends do not meet -- or one that closes but "
            "is not planar -- builds a feature that recomputes clean, reports "
            "Up-to-date and removes or adds nothing. Close the profile "
            "(polyline closed:true) rather than extruding a line."
            % (sk.Name, what, rep.get("wires", 0), rep.get("closed", 0),
               rep.get("area")))
    if rep.get("overlaps"):
        raise KoiOpError(
            "%s holds %d closed outlines and %d pair(s) of them overlap "
            "without nesting. PartDesign does not union overlapping wires in "
            "one sketch -- it builds ONE of them and reports success. Draw "
            "one outline per sketch and %s each of them, or move them apart. "
            "(An outline entirely inside another is a hole, and is fine.)"
            % (sk.Name, rep.get("closed"), len(rep["overlaps"]), what))
    return rep


def _op_pad(doc, args, kid):
    body = _resolve_body(doc, args.get("body"), args)
    sk = _resolve_or_die(doc, _need(args, "sketch"), "sketch")
    # Before the feature exists, so a refusal leaves no half-built pad behind.
    profile = _profile_gate(sk, "pad")
    pad = body.newObject("PartDesign::Pad", _safe_name(kid, "Pad"))
    pad.Profile = sk
    dim = _set_dim(pad, "Length", args, "length")
    if args.get("reversed"):
        pad.Reversed = True
    if args.get("midplane") or args.get("symmetric"):
        pad.Midplane = True
    hidden = _tidy_construction(doc, sk)
    doc.recompute()
    register(doc, kid, pad, args.get("turn"))
    # Echoed because the reply used to show length:40 and nothing else, so a
    # midplane pad and a one-way pad of the same length were the same three
    # lines of JSON. Both were only ever trusted after a separate bbox call.
    out = {"name": pad.Name, "length": _plain(pad.Length), "volume": _vol(pad),
           "reversed": bool(getattr(pad, "Reversed", False)),
           "midplane": bool(getattr(pad, "Midplane", False)),
           "bbox": _bbox_of(pad), "hidden": hidden}
    if profile:
        out["profile"] = profile
    if dim.get("expression"):
        out["dimension"] = dim
    refilled = _refilled_voids(pad)
    if refilled:
        out["refilled"] = refilled
        out["note"] = (
            "this pad fused over material that %s had cut away, filling %s "
            "mm3 of it back in. Through-all holes below the tip do NOT "
            "reopen through a pad added above them: the bolt path is solid "
            "again in the new material. Suppress this pad, or re-cut those "
            "holes at the tip, if the openings were meant to stay."
            % (", ".join(r["feature"] for r in refilled[:4]),
               ", ".join("%.3f" % r["volume"] for r in refilled[:4])))
    return out


def _removed(feat):
    # What the feature actually took away. The same measurement lint uses, on
    # purpose: an op and the lint that judges it must not be able to disagree.
    base = getattr(feat, "BaseFeature", None)
    if base is None or getattr(base, "Shape", None) is None:
        return None
    try:
        return round(base.Shape.Volume - feat.Shape.Volume, 6)
    except Exception:
        return None


AT_PROFILE_TOL = 0.05   # mm; a cut starts at its own profile or it is not it


def _cut_lump(feat):
    """The material this feature actually took away, as a shape."""
    base = getattr(feat, "BaseFeature", None)
    if base is None or getattr(base, "Shape", None) is None:
        return None
    try:
        lump = base.Shape.cut(feat.Shape)
    except Exception:
        return None
    try:
        if lump.isNull() or lump.Volume <= 1e-9:
            return None
    except Exception:
        return None
    return lump


def _cut_at_profile(feat, sk):
    """How far the removed material sits from the profile that asked for it.

    Volume alone cannot tell a hole from the wrong hole. Tapping the face of a
    split part with the direction reversed did not remove nothing -- it drilled
    into the leftover of the other half and took 128 mm3 with it, which every
    check here read as success. Where the material went is the discriminator:
    a cut belongs to its profile and starts at it.

    None when there is nothing to compare, which is never read as a failure.
    """
    lump = _cut_lump(feat)
    if lump is None or sk is None:
        return None
    prof = getattr(sk, "Shape", None)
    if prof is None:
        return None
    try:
        if prof.isNull():
            return None
        gpl = _global_placement(sk)
        if gpl is not None:
            prof = prof.copy()
            prof.Placement = gpl
        return round(float(lump.distToShape(prof)[0]), 6)
    except Exception:
        return None


def _cut_quality(feat, sk):
    return _removed(feat), _cut_at_profile(feat, sk)


def _cut_solids(feat):
    """How many separate lumps this cut took out.

    A drill that passes through a bore that is already there removes material,
    stops at the void, and starts again on the far side -- two lumps for one
    circle. Volume cannot see that (it is short, not zero) and neither can
    isValid(); the count can, and it costs one boolean that _cut_lump has
    already computed for the profile check.
    """
    lump = _cut_lump(feat)
    if lump is None:
        return None
    try:
        return len(lump.Solids)
    except Exception:
        return None


VOID_SCAN_LIMIT = 12


def _upstream_voids(feat, cap=VOID_SCAN_LIMIT):
    """(name, shape) of the material each earlier cut in this chain removed."""
    out = []
    node = getattr(feat, "BaseFeature", None)
    depth = 0
    while node is not None and len(out) < cap and depth < cap * 4:
        depth += 1
        tid = str(getattr(node, "TypeId", ""))
        if any(k in tid for k in SUBTRACTIVE) and not _suppressed(node):
            base = getattr(node, "BaseFeature", None)
            try:
                if base is not None and getattr(base, "Shape", None) is not None:
                    lump = base.Shape.cut(node.Shape)
                    if not lump.isNull() and lump.Volume > 1e-9:
                        out.append((node.Name, lump))
            except Exception:
                pass
        node = getattr(node, "BaseFeature", None)
    return out


def _refilled_voids(feat):
    """Cuts upstream that this additive feature has just filled back in.

    The PartDesign DAG trap this surface had no answer for. A pad at the tip
    is fused with everything below it INCLUDING the empty space a hole took
    out, so bar-clamp pads added over a through-drilled face left the new 6 mm
    bands solid. It recomputed clean, reported Up-to-date, isValid() was true,
    lint was silent, and the only tell was a volume that did not match intent
    -- found by hand, three steps later.

    Bounded: the chain is walked at most VOID_SCAN_LIMIT cuts back, and each
    one costs one common(). The answer is a measurement, so it is reported
    rather than refused: recapping a hole on purpose (a blind pocket floor, a
    boss over a clearance slot) is a real thing to want.
    """
    base = getattr(feat, "BaseFeature", None)
    if base is None or getattr(base, "Shape", None) is None:
        return []
    try:
        added = feat.Shape.cut(base.Shape)
        if added.isNull() or added.Volume <= 1e-9:
            return []
    except Exception:
        return []
    hits = []
    for name, void in _upstream_voids(feat):
        try:
            over = added.common(void)
            v = 0.0 if over.isNull() else float(over.Volume)
        except Exception:
            continue
        if v > 1e-6:
            hits.append({"feature": name, "volume": round(v, 6)})
    return hits


def _ensure_cuts(doc, feat, told, sk=None):
    """A subtractive feature that cut nothing -- or cut somewhere else.

    Pulled out of _op_pocket because the identical bug then shipped in
    _op_hole: a ThroughAll cut from a sketch on the XY plane goes -Z while the
    pad goes +Z, so it recomputes clean, reports Up-to-date and isValid(), and
    removes nothing. Which side the material is on is a fact about the
    document, so measure it rather than inheriting whatever the platform
    defaults to.

    "Removed something" was too weak a test. It passed a body tap that cut the
    wrong way through leftover material, and the wrong-way taps only surfaced
    later from isInside probes. So the direction is judged on removal AND on
    where the removal landed.

    Only when the caller did not say. An explicit reversed is an instruction.
    """
    removed, at = _cut_quality(feat, sk)
    if told or "Reversed" not in feat.PropertiesList:
        return removed, False, at
    nothing = removed is None or removed <= 1e-6
    astray = at is not None and at > AT_PROFILE_TOL
    if not nothing and not astray:
        return removed, False, at
    was = bool(feat.Reversed)
    feat.Reversed = not was
    doc.recompute()
    again, at2 = _cut_quality(feat, sk)
    got_none = again is None or again <= 1e-6
    stray2 = at2 is not None and at2 > AT_PROFILE_TOL
    if not got_none and not stray2:
        return again, True, at2
    # One side removes material and the other removes NOTHING. The first
    # version of this ranked both failures the same and put the feature back
    # the way the caller had it, which is how a tapped hole on a datum plane
    # came back removed:0 with ok:true and the note "check the profile, not
    # the direction" -- while feature_edit Reversed:true on the very same
    # feature cut 400 mm3. A profile deliberately standing off the face reads
    # astray by construction, so standoff alone must not outvote "this
    # direction drills into air". Cutting nothing is never the better of two.
    if nothing and not got_none:
        return again, True, at2
    # Neither direction is right: put it back the way the caller had it and
    # let the note say which of the two failures this is.
    feat.Reversed = was
    doc.recompute()
    removed, at = _cut_quality(feat, sk)
    return removed, False, at


def _cut_note(removed, flipped, told, what="cut", at=None):
    if flipped:
        msg = ("the %s was not cutting the material under its profile, so "
               "its direction was flipped; it now removes %.3f"
               % (what, removed or 0.0))
        if at is not None and at > AT_PROFILE_TOL:
            msg += (". The material it took still starts %0.2f mm from its "
                    "own profile -- normal for a profile on a datum that "
                    "stands off the face, and the signature of a cut into "
                    "the wrong material otherwise. Probe it" % at)
        return msg
    if removed is not None and removed <= 1e-6:
        return ("this %s removes no material%s" %
                (what, " in the direction you asked for" if told else
                 " in either direction -- check the profile, not the direction"))
    if at is not None and at > AT_PROFILE_TOL:
        return ("this %s removed %.3f mm3, and the material it took starts "
                "%0.2f mm from its own profile. Turning it round did not "
                "land on the profile either, so this is either a cut into "
                "the wrong material -- a wrong-way tap that ate leftover "
                "stock reads exactly like this and volume alone cannot see "
                "it -- or a profile deliberately standing off the face on a "
                "datum. Probe it before reporting the feature as asked for"
                % (what, removed or 0.0, at))
    return None


def _op_pocket(doc, args, kid):
    body = _resolve_body(doc, args.get("body"), args)
    sk = _resolve_or_die(doc, _need(args, "sketch"), "sketch")
    profile = _profile_gate(sk, "cut")
    pk = body.newObject("PartDesign::Pocket", _safe_name(kid, "Pocket"))
    pk.Profile = sk
    dim = None
    if args.get("through"):
        pk.Type = "ThroughAll"
    else:
        dim = _set_dim(pk, "Length", args, "length")
    told = "reversed" in args and args["reversed"] is not None and str(args["reversed"]).lower() != "auto"
    if told:
        pk.Reversed = bool(args["reversed"])
    told_mid = "midplane" in args or "symmetric" in args
    if told_mid:
        _set_if(pk, "Midplane", bool(args.get("midplane") or args.get("symmetric")))
    # Measured, exactly like the flip below and for the same reason. A through
    # cut from a sketch on a plane that runs THROUGH the material goes one way
    # and leaves the other half of the bore standing -- it recomputes clean,
    # reports Up-to-date, and is almost never what a centre plane meant. Which
    # side the material is on is a fact about the document, so read it.
    auto_mid = False
    if args.get("through") and not told_mid and not told:
        if _straddles(pk, sk):
            auto_mid = bool(_set_if(pk, "Midplane", True))
    hidden = _tidy_construction(doc, sk)
    doc.recompute()

    removed, flipped, at = _ensure_cuts(doc, pk, told, sk)
    register(doc, kid, pk, args.get("turn"))
    out = {"name": pk.Name, "through": bool(args.get("through")),
           "reversed": bool(pk.Reversed), "removed": removed,
           "midplane": bool(getattr(pk, "Midplane", False)),
           "flipped": flipped, "volume": _vol(pk), "hidden": hidden,
           "removedAtProfile": at}
    if profile:
        out["profile"] = profile
    if dim and dim.get("expression"):
        out["dimension"] = dim
    note = _cut_note(removed, flipped, told, "pocket", at)
    if note:
        out["note"] = note
    if auto_mid:
        out["midplaneNote"] = (
            "the profile plane runs through the material, so this through cut "
            "was made symmetric and removes both ways. Pass midplane:false to "
            "cut one way only.")
    return out


def _straddles(feat, sk):
    """Is the profile plane inside the material this feature will cut?

    Vertices rather than the bounding box: a bbox is axis-aligned and the
    profile plane usually is not, so a box test answers a different question
    on every sketch that is not on XY, XZ or YZ.
    """
    base = getattr(feat, "BaseFeature", None)
    shape = getattr(base, "Shape", None) if base is not None else None
    if shape is None:
        return None
    try:
        pl = _global_placement(sk)
        n = pl.Rotation.multVec(App.Vector(0, 0, 1))
        p = pl.Base
        above = below = 0.0
        for v in shape.Vertexes[:4000]:
            d = (v.Point - p).dot(n)
            if d > above:
                above = d
            elif d < below:
                below = d
        return above > 1e-6 and below < -1e-6
    except Exception:
        return None


def _op_feature_edit(doc, args, kid):
    # 8.5: the default response to a change request. Editing a property keeps
    # the DAG, the downstream features and the user's references; rebuilding
    # throws all three away.
    tgt = _resolve_or_die(doc, _need(args, "target"), "object")
    props = args.get("props") or {}
    exprs = args.get("expressions") or {}
    if not isinstance(props, dict) or not isinstance(exprs, dict):
        raise KoiOpError("props and expressions must be objects")
    if not props and not exprs:
        raise KoiOpError("nothing to change: pass props and/or expressions")
    changed = []
    for k in sorted(props):
        if k not in tgt.PropertiesList:
            raise KoiOpError(
                "%s has no property %r. It has: %s"
                % (tgt.Name, k, ", ".join(sorted(tgt.PropertiesList)[:40])))
        before = _plain(tgt.getPropertyByName(k))
        setattr(tgt, k, props[k])
        changed.append({"prop": k, "from": before,
                        "to": _plain(tgt.getPropertyByName(k))})
    for k in sorted(exprs):
        v = exprs[k]
        tgt.setExpression(k, None if v in (None, "") else str(v))
        changed.append({"prop": k, "expression": v})
    doc.recompute()
    return {"name": tgt.Name, "changed": changed, "volume": _vol(tgt)}

def _owning_body(o):
    """The PartDesign Body this object lives in, or None.

    Two ways of asking, because one of them came back empty on the build this
    was tested against and the failure was silent: _tip_warning returned None
    for a Pad that is plainly inside a Body, so the notTip note never fired
    and a mid-tree measurement went out unlabelled -- the exact thing the note
    exists to prevent.

    getParentGeoFeatureGroup first, since it is the direct question. Then the
    Group walk, which is slower, bounded, and true by construction: a feature
    is in the Body whose Group holds it.
    """
    if o is None:
        return None
    tid = str(getattr(o, "TypeId", ""))
    if tid == "PartDesign::Body":
        return o
    try:
        b = o.getParentGeoFeatureGroup()
        if b is not None and str(getattr(b, "TypeId", "")) == "PartDesign::Body":
            return b
    except Exception:
        pass
    doc = getattr(o, "Document", None)
    if doc is None:
        return None
    name = getattr(o, "Name", None)
    for cand in doc.Objects[:2000]:
        if str(getattr(cand, "TypeId", "")) != "PartDesign::Body":
            continue
        try:
            for member in (cand.Group or []):
                if getattr(member, "Name", None) == name:
                    return cand
        except Exception:
            continue
    return None

def _tip_warning(o):
    """A PartDesign feature that is NOT its body's tip, or None.

    In PartDesign every feature owns the whole solid AS IT WAS at that point
    in the tree. Measuring the pad of a plate that is pocketed two features
    later returns the volume before the holes -- correctly, and it looks
    exactly like the answer to the question that was asked.

    This is not hypothetical. The suite written for this file measured
    pad.plate on a plate with two bores, got 24000 for a part that is
    22994.8, and read it as the pocket having silently failed. The pocket was
    fine. The object was the wrong one to ask, and nothing said so.

    The number is right. The note says which number it is.
    """
    tid = str(getattr(o, "TypeId", ""))
    if not tid.startswith("PartDesign::") or tid == "PartDesign::Body":
        return None
    body = _owning_body(o)
    if body is None:
        # Said rather than skipped. A PartDesign feature always belongs to a
        # Body; not finding one means this check could not run, and a check
        # that quietly does not run is indistinguishable from a check that
        # passed -- which is how the first version of this shipped.
        return {"body": None, "tip": None,
                "note": ("%s is a PartDesign feature but no owning Body could "
                         "be found, so whether this is the finished solid or "
                         "an intermediate one was NOT checked. Treat the "
                         "numbers as possibly mid-tree." % o.Name)}
    tip = getattr(body, "Tip", None)
    if tip is None or tip.Name == o.Name:
        return None
    return {
        "body": body.Name, "tip": tip.Name,
        "note": (
            "%s is a feature in the MIDDLE of %s, not its tip (%s). In "
            "PartDesign a feature's shape is the solid as it was at THAT "
            "point in the tree, so this reading is from before every feature "
            "after it -- the holes cut later are not in it. Ask %s or %s for "
            "the finished part."
            % (o.Name, body.Name, tip.Name, body.Name, tip.Name)),
    }


def _tip_owner(doc, o):
    """(body, tip) when this object is a feature inside a PartDesign Body."""
    tid = str(getattr(o, "TypeId", ""))
    if not tid.startswith("PartDesign::") or "Body" in tid:
        return None, None
    body = _owning_body(o)
    if body is None:
        return None, None
    return body, getattr(body, "Tip", None)


def _dependents(o):
    """What would lose its input if this object went away.

    The owning Body and the scaffolding it brings are not dependents: a Body
    contains its features, it does not consume them.
    """
    out = []
    for d in (getattr(o, "InList", None) or [])[:64]:
        if d is None or d.Name == o.Name:
            continue
        tid = str(getattr(d, "TypeId", ""))
        if "Body" in tid or "Origin" in tid or tid.endswith("DocumentObjectGroup"):
            continue
        out.append(d.Name)
    return sorted(set(out))


def _op_delete(doc, args, kid):
    """Remove an object -- unless removing it would rewire something else.

    The scariest ten minutes of the field session went through this op. A
    pocket in the MIDDLE of a body removed nothing, so it was deleted and
    recreated at the tip in one transaction; deleting it rewired BaseFeature
    for every feature after it, the body went from 102009 mm3 to the 1289 mm3
    of the single cut that survived, and a flute's Placement jumped to
    [0, -24, 0]. Recovery needed doc.undo() through the script channel, which
    the envelope then tried to roll back.

    None of that was visible at the moment of the delete: it returned
    {"removed": "Pocket002"} and ok:true. So the check happens BEFORE the
    removal, and the alternative is named in the refusal rather than left for
    the caller to think of.
    """
    tgt = _resolve_or_die(doc, _need(args, "target"), "object")
    name = tgt.Name
    forced = bool(args.get("force"))
    body, tip = _tip_owner(doc, tgt)
    blocked = None
    if body is not None and tip is not None and tip.Name != name:
        blocked = (
            "%s is in the MIDDLE of %s -- the tip is %s. Deleting it rewires "
            "BaseFeature for every feature after it, which has collapsed a "
            "body to a single cut and moved the placements of features that "
            "were never touched. Use fn 'suppress' to switch it off and keep "
            "the tree, or add the replacement at the tip and suppress this "
            "one." % (name, body.Name, tip.Name))
    else:
        deps = _dependents(tgt)
        if deps:
            blocked = (
                "%s is the input of %s. Deleting it leaves them without a "
                "shape to work from, and they report the loss only on the "
                "next recompute. Delete those first, or fn 'suppress' this "
                "one if it is a feature." % (name, ", ".join(deps[:8])))
    if blocked and not forced:
        raise KoiOpError(
            blocked + " Pass force:true only if you have already told the "
            "user what will break.")
    doc.removeObject(name)
    doc.recompute()
    out = {"removed": name}
    if blocked:
        out["forced"] = True
        out["note"] = ("this delete was FORCED past a refusal: " + blocked +
                       " Check the tip and the volume before reporting it.")
    if body is not None:
        out["body"] = body.Name
        now = getattr(body, "Tip", None)
        out["tip"] = None if now is None else now.Name
        out["volume"] = _vol(now) if now is not None else None
    return out


def _op_suppress(doc, args, kid):
    """Switch a feature off without deleting it.

    The op the delete refusal points at, and the one the field session did not
    have. Suppression takes the material away and leaves the DAG, the ids, the
    downstream features and the user's picked references exactly where they
    were -- which is the whole difference between "this cut was wrong" and a
    body that has to be rebuilt.

    Measured, not asserted: the reply carries the tip's volume either side, so
    a suppression that changed nothing says so instead of reading as success.
    """
    tgt = _resolve_or_die(doc, _need(args, "target"), "object")
    want = args.get("suppressed")
    want = True if want is None else bool(want)
    if "Suppressed" not in tgt.PropertiesList:
        raise KoiOpError(
            "%s is a %s and has no Suppressed property on this build, so it "
            "cannot be switched off. Suppression is a PartDesign feature "
            "flag: pass a feature inside a body. A document-level object is "
            "hidden with fn 'show' or removed with fn 'delete'."
            % (tgt.Name, tgt.TypeId))
    body, tip = _tip_owner(doc, tgt)
    measured = tip if tip is not None else tgt
    before = _vol(measured)
    if not _set_if(tgt, "Suppressed", want):
        raise KoiOpError("%s would not take Suppressed=%s" % (tgt.Name, want))
    doc.recompute()
    got = bool(getattr(tgt, "Suppressed", False))
    if got != want:
        raise KoiOpError(
            "%s reads Suppressed=%s after being asked for %s; a feature that "
            "is still contributing material while the reply says it is off is "
            "the one thing this op must not do" % (tgt.Name, got, want))
    after = _vol(measured)
    out = {"name": tgt.Name, "label": tgt.Label, "suppressed": got,
           "body": None if body is None else body.Name,
           "tip": None if tip is None else tip.Name,
           "volume": after, "volumeBefore": before,
           "volumeDelta": None if (before is None or after is None)
                          else round(after - before, 6)}
    if before is not None and after is not None and abs(after - before) <= 1e-6:
        out["note"] = (
            "suppressing %s changed no material -- it was already "
            "contributing nothing. Say that rather than reporting a fix."
            % tgt.Name)
    elif got:
        out["note"] = ("%s is off and left in the tree; lint no longer reports "
                       "it, and suppressed:false puts it back." % tgt.Name)
    return out


VIEW_PRESETS = {
    "iso": "viewIsometric", "front": "viewFront", "rear": "viewRear",
    "top": "viewTop", "bottom": "viewBottom", "left": "viewLeft",
    "right": "viewRight",
}


def _is_3d_view(v):
    """A 3D view, as opposed to a TechDraw page or a spreadsheet tab.

    ActiveView is whatever MDI tab is in front, and in a document with a
    drawing in it that is routinely not the 3D view at all. A TechDraw page
    has neither viewIsometric nor saveImage, which is the whole difference
    that matters here.
    """
    return v is not None and hasattr(v, "saveImage") and hasattr(v, "viewIsometric")


def _resolve_gui_view(doc):
    """(gdoc, 3D view, is_front_tab) for the document the human is looking at.

    One resolver for view_set and render both. The copy render used to carry
    left out setActiveDocument, which is how a two-document session ends up
    capturing the wrong window and reporting it as a success.

    The front tab is preferred and is not switched: a render is an
    observation, and yanking the human off the drawing they were reading to
    photograph a model is the same rudeness as moving their camera. When the
    front tab is not a 3D view, the document's 3D view is used where it sits
    and the caller is told so, because a picture of the model captioned as
    what the human is looking at is exactly the lie this tool exists to stop.
    """
    if Gui is None:
        return None, None, False
    gdoc = Gui.ActiveDocument
    if gdoc is None and doc is not None:
        try:
            gdoc = Gui.getDocument(doc.Name)
        except Exception:
            gdoc = None
    if gdoc is None and App.ActiveDocument is not None:
        try:
            gdoc = Gui.getDocument(App.ActiveDocument.Name)
        except Exception:
            gdoc = None
    if gdoc is None:
        return None, None, False
    try:
        Gui.setActiveDocument(gdoc.Document.Name)
    except Exception:
        pass
    front = getattr(gdoc, "ActiveView", None)
    if front is None and hasattr(gdoc, "activeView"):
        try:
            front = gdoc.activeView()
        except Exception:
            front = None
    if _is_3d_view(front):
        return gdoc, front, True
    try:
        others = list(gdoc.mdiViewsOfType("Gui::View3DInventor"))
    except Exception:
        others = []
    for v in others:
        if _is_3d_view(v):
            return gdoc, v, False
    return gdoc, None, False


def _preset_fn(preset):
    """VIEW_PRESETS lookup that refuses a typo instead of ignoring it.

    Swallowing an unknown preset renders whatever the camera happened to hold
    and then reports the preset that was asked for, which is a result that
    lies about what is in the picture.
    """
    if preset in (None, ""):
        return None
    fn = VIEW_PRESETS.get(str(preset).lower())
    if fn is None:
        raise KoiOpError(
            "preset must be one of %s" % ", ".join(sorted(VIEW_PRESETS)))
    return fn


def _frame_view(view, fn, fit):
    if fn:
        getattr(view, fn)()
    if fit:
        if hasattr(view, "fitAll"):
            try:
                view.fitAll()
            except Exception:
                pass
        try:
            Gui.SendMsgToActiveView("ViewFit")
        except Exception:
            pass
    try:
        if hasattr(view, "repaint"):
            view.repaint()
        if hasattr(Gui, "updateGui"):
            Gui.updateGui()
    except Exception:
        pass


def _get_camera(view):
    try:
        return view.getCamera()
    except Exception:
        return None


def _parse_camera(s):
    if not s:
        return {}
    import re
    props = {}
    m_type = re.search(r'(OrthographicCamera|PerspectiveCamera)', str(s))
    if m_type:
        props['type'] = m_type.group(1)
    for line in str(s).splitlines():
        line = line.strip()
        if not line or line.startswith('#') or line.endswith('{') or line == '}':
            continue
        parts = line.split()
        if len(parts) >= 2:
            key = parts[0]
            try:
                nums = [float(p) for p in parts[1:]]
                props[key] = nums
            except ValueError:
                props[key] = parts[1:]
    return props


def _cameras_match(cam1, cam2, tol=1e-2):
    if not cam1 or not cam2:
        return False
    if " ".join(str(cam1).split()) == " ".join(str(cam2).split()):
        return True
    p1 = _parse_camera(cam1)
    p2 = _parse_camera(cam2)
    if not p1 or not p2:
        return False
    if p1.get('type') != p2.get('type'):
        return False
    for key in ['position', 'orientation', 'height', 'focalDistance', 'heightAngle']:
        if key in p1 and key in p2:
            v1, v2 = p1[key], p2[key]
            if len(v1) != len(v2):
                return False
            for a, b in zip(v1, v2):
                if abs(a - b) > tol:
                    return False
    return True


def _set_camera(view, cam):
    """Put the camera back, and check that it went back.

    setCamera swallows a malformed string on some builds, so the return value
    is a comparison against what the view actually holds afterwards rather
    than "the call did not raise".
    """
    if not cam:
        return False
    try:
        view.setCamera(cam)
        if hasattr(view, "repaint"):
            view.repaint()
        if hasattr(Gui, "updateGui"):
            Gui.updateGui()
    except Exception:
        return False
    now = _get_camera(view)
    return bool(now) and _cameras_match(now, cam)


def _op_view_set(doc, args, kid):
    # 'view' is the word half the callers reach for first, and refusing it
    # costs a turn to learn a synonym rather than to design anything.
    preset = str(args.get("preset") or args.get("view") or "iso").lower()
    fn = _preset_fn(preset)
    gdoc, view, front = _resolve_gui_view(doc)
    if gdoc is None:
        return {"preset": preset, "applied": False,
                "error": "no GUI document to point"}
    if view is None:
        return {"preset": preset, "applied": False,
                "error": "no 3D view in this document to point: every open tab "
                         "is a drawing, a spreadsheet or the start page"}
    if not hasattr(view, fn):
        return {"preset": preset, "applied": False,
                "error": "this build's view has no %s" % fn}
    _frame_view(view, fn, args.get("fit", True))
    _gui_sync(doc)
    out = {"preset": preset, "applied": True}
    if not front:
        out["isFrontTab"] = False
        out["note"] = ("the 3D view was pointed, but it is not the tab in "
                       "front — the human is looking at something else")
    return out


RENDER_INLINE_LIMIT = 4000000


def render_view(width=800, height=600, background="Current", view_preset=None,
                fit=True, img_format="png", save_path=None, restore=True,
                inline=True, doc=None):
    """Snapshot the 3D view through FreeCAD's own renderer.

    Two things this is careful about. The camera is an observation, not an
    edit: framing for the shot and leaving the human's view somewhere else is
    the same rudeness as moving their mouse, so the camera is put back unless
    restore:False says otherwise. And the bytes are optional: inline:False
    returns the metadata and the path only, because a base64 payload has one
    safe channel out of here and the whitelist dispatcher is not it.
    """
    import os, tempfile, base64

    # Arguments are checked before the GUI is touched. A bad preset or a
    # missing savePath is wrong no matter what tab is in front, and reporting
    # it as a view problem sends the caller to fix the wrong thing.
    fn = _preset_fn(view_preset)

    bg_map = {
        "current": "Current",
        "white": "White",
        "black": "Black",
        "transparent": "Transparent",
    }
    bg = bg_map.get(str(background).lower(), "Current")

    fmt = str(img_format or "png").lower()
    ext = ".png" if fmt == "png" else ".jpg" if fmt in ("jpg", "jpeg") else ".png"
    if bg == "Transparent" and ext != ".png":
        return {"ok": False, "applied": False,
                "error": "a transparent background needs format:'png'; JPEG has no alpha"}
    if not inline and not save_path:
        raise KoiOpError(
            "render through the dispatcher returns metadata only, so it needs "
            "savePath to leave anything behind. Pass savePath, or call the "
            "freecad_render tool, which returns the pixels themselves.")
    if save_path:
        save_path = confined_path(save_path, (ext,))

    if Gui is None:
        return {"ok": False, "applied": False,
                "error": "no GUI available: FreeCAD must have a GUI to render viewports"}
    doc = doc or App.ActiveDocument
    gdoc, view, front = _resolve_gui_view(doc)
    if gdoc is None:
        return {"ok": False, "applied": False,
                "error": "no active GUI document to render"}
    if view is None:
        return {"ok": False, "applied": False,
                "error": "this document has no 3D view open: every tab is a "
                         "drawing, a spreadsheet or the start page. Open the "
                         "model tab, or ask the user to"}
    if fn and not hasattr(view, fn):
        return {"ok": False, "applied": False,
                "error": "this build's 3D view has no %s" % fn}

    tmp_path = save_path
    cleanup_temp = False
    if not tmp_path:
        fd, tmp_path = tempfile.mkstemp(prefix="koi_render_", suffix=ext)
        os.close(fd)
        cleanup_temp = True

    cam = _get_camera(view) if (restore and (fn or fit)) else None
    try:
        w = max(64, min(int(width or 800), 3840))
        h = max(64, min(int(height or 600), 2160))
        _frame_view(view, fn, fit)
        view.saveImage(tmp_path, w, h, bg)
        if not os.path.exists(tmp_path) or os.path.getsize(tmp_path) == 0:
            return {"ok": False, "applied": False,
                    "error": "saveImage failed to produce a valid image file"}

        file_size = os.path.getsize(tmp_path)
        b64 = None
        if inline:
            if file_size > RENDER_INLINE_LIMIT:
                return {"ok": False, "applied": False,
                        "sizeBytes": file_size,
                        "error": ("the render is %d bytes, over the %d-byte inline "
                                  "limit: ask for smaller width/height, or pass "
                                  "savePath and read the file"
                                  % (file_size, RENDER_INLINE_LIMIT))}
            with open(tmp_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("ascii")

        # Put the camera back before the reply is built, so cameraRestored
        # reports a fact rather than an intention. The finally below is left
        # as the safety net for the paths that never get here.
        restored = _set_camera(view, cam) if cam is not None else None
        cam = None
        if restored is False and fit:
            _frame_view(view, fn, fit=True)
            _gui_sync(doc)

        mime = "image/png" if ext == ".png" else "image/jpeg"
        note = "Rendered %dx%d %s viewport" % (w, h, fmt.upper())
        if not front:
            note += (" — NOT the tab in front: the human is looking at a "
                     "drawing or spreadsheet, not at this")
        if restored is False:
            note += " — the camera could not be put back where it was"
        out = {
            "ok": True,
            "applied": True,
            "width": w,
            "height": h,
            "sizeBytes": file_size,
            "mimeType": mime,
            "format": fmt,
            "view": str(view_preset).lower() if view_preset else None,
            "path": save_path or None,
            "isFrontTab": front,
            "cameraRestored": restored,
            "note": note,
        }
        if inline:
            out["imageData"] = b64
        return out
    except Exception as e:
        return {"ok": False, "applied": False,
                "error": "%s: %s" % (type(e).__name__, str(e))}
    finally:
        if cam is not None:
            _set_camera(view, cam)
        if cleanup_temp and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass


def _op_render(doc, args, kid):
    # No pixels through this door. A dispatcher result is JSON in a text
    # block, a batch is capped at 24 steps, and 24 base64 PNGs in one reply is
    # a payload nobody can read and everybody pays for.
    return render_view(
        width=args.get("width", 800),
        height=args.get("height", 600),
        background=args.get("background", "Current"),
        view_preset=args.get("view") or args.get("preset"),
        fit=args.get("fit", True),
        img_format=args.get("format", "png"),
        save_path=args.get("savePath") or args.get("path"),
        restore=args.get("restore", True),
        inline=False,
        doc=doc,
    )


def _op_ids(doc, args, kid):
    return ids(doc)


# ---------- topological references (8.1) ----------
#
# Face6 is not a name, it is an index into a list that a recompute is free to
# reorder. The AI captures a reference in turn 3 and uses it in turn 7, which
# is when it bites.
#
# K5 measured the failure mode on this build and it changed the shape of this
# code: a reference held through a dimensional change and through unrelated
# topology, and when its own geometry was cut away it broke LOUDLY --
# ValueError, Touched/Invalid -- rather than quietly attaching elsewhere. So
# this is a resolver for loud breakage. It detects an unresolvable reference
# and re-derives from what generated the element. It does not have to prove a
# name still means what it meant, and it says so when it cannot.
#
# The invariance ranking is 8.1's, and the order matters more than the weights:
#   1. generating attribution   survives dimensional change entirely
#   2. adjacency and ordering   survives it mostly
#   3. surface type and normal  survives it for the common cases
#   4. area and centroid        TIE-BREAK ONLY, never a key -- these are
#                               exactly what a parametric edit perturbs

REF_PREFIX = "koi.ref."
REF_LIMIT = 32
CANDIDATE_LIMIT = 500
KIND_ATTR = {"Face": "Faces", "Edge": "Edges", "Vertex": "Vertexes"}

W_HISTORY = 40.0
W_TYPE = 20.0
W_DIR = 15.0
W_ADJ = 10.0
W_RANK = 8.0
W_SIZE = 4.0    # tie-break
W_NEAR = 3.0    # tie-break
MIN_SCORE = 25.0
MIN_MARGIN = 8.0
DIR_TOL = 1e-3


def _kind_of(sub):
    bare = str(sub or "").lstrip("?")
    for k in KIND_ATTR:
        if bare.startswith(k):
            return k
    return None


def _sub_shape(shape, sub):
    """(subshape, via). Mapped names first, raw index last -- that is the
    order of trustworthiness, and via records which one answered."""
    for via, getter in (
        ("getElement", lambda: shape.getElement(sub)),
        ("attr", lambda: getattr(shape, str(sub).lstrip("?"))),
    ):
        try:
            s = getter()
            if s is not None:
                return s, via
        except Exception:
            continue
    kind = _kind_of(sub)
    if kind:
        try:
            idx = int(str(sub).lstrip("?")[len(kind):]) - 1
            lst = getattr(shape, KIND_ATTR[kind])
            if 0 <= idx < len(lst):
                return lst[idx], "index"
        except Exception:
            pass
    return None, "unresolvable"


def _vec3(v):
    return [round(v.x, 6), round(v.y, 6), round(v.z, 6)]


def _unit(v):
    try:
        n = v.normalize()
        return _vec3(n)
    except Exception:
        return None


def _same_dir(a, b, tol=DIR_TOL):
    if not a or not b:
        return None
    return all(abs(a[i] - b[i]) < tol for i in range(3))


def _invariants(ss, kind):
    inv = {"kind": kind}
    try:
        inv["center"] = _vec3(ss.CenterOfMass)
    except Exception:
        try:
            inv["center"] = _vec3(ss.Point)
        except Exception:
            pass
    if kind == "Face":
        try:
            inv["surface"] = type(ss.Surface).__name__
        except Exception:
            pass
        try:
            inv["size"] = round(ss.Area, 6)
        except Exception:
            pass
        try:
            r = ss.ParameterRange
            n = ss.normalAt((r[0] + r[1]) / 2.0, (r[2] + r[3]) / 2.0)
            if str(getattr(ss, "Orientation", "")) == "Reversed":
                n = n.negative()
            inv["direction"] = _unit(n)
        except Exception:
            pass
        try:
            inv["edgeCount"] = len(ss.Edges)
        except Exception:
            pass
    elif kind == "Edge":
        try:
            inv["surface"] = type(ss.Curve).__name__
        except Exception:
            pass
        try:
            inv["size"] = round(ss.Length, 6)
        except Exception:
            pass
        try:
            inv["direction"] = _unit(ss.tangentAt(ss.FirstParameter))
        except Exception:
            pass
    return inv


def _adjacency(shape, ss, kind):
    """Which kinds of face this one borders. Survives a dimensional change:
    growing a pad does not change what its side face touches."""
    if kind != "Face":
        return None
    try:
        import Part
        sig = {}
        for e in list(ss.Edges)[:64]:
            for f in list(shape.ancestorsOfType(e, Part.Face))[:8]:
                try:
                    if f.isSame(ss):
                        continue
                except Exception:
                    continue
                t = type(f.Surface).__name__
                sig[t] = sig.get(t, 0) + 1
        return sig
    except Exception:
        return None


def _axis_rank(centers, mine):
    """Ordering along the body axes. A side face stays the second-from-bottom
    face when the pad grows; its centroid does not stay anywhere."""
    if mine is None:
        return None
    out = {}
    for i, axis in enumerate("xyz"):
        vals = sorted(set(round(c[i], 4) for c in centers if c))
        try:
            out[axis] = vals.index(round(mine[i], 4))
        except ValueError:
            return None
    out["of"] = len(centers)
    return out


def _history(obj, sub):
    """Generating attribution, if this build exposes it. Probed, not assumed:
    the API has moved between branches, so try what exists and record what
    answered rather than depending on a signature."""
    out = {"available": False}
    try:
        import Part
        fn = getattr(Part, "getElementHistory", None)
        if fn is None:
            fn = getattr(getattr(Part, "Feature", None), "getElementHistory", None)
        if fn is None:
            out["reason"] = "no getElementHistory on this build"
            return out
        h = fn(obj, sub)
        out["available"] = True
        out["trace"] = _hist_str(h)
    except Exception as e:
        out["reason"] = "%s: %s" % (type(e).__name__, str(e)[:100])
    return out


def _useful_history(h, own_name):
    """Attribution, but only when it attributes to something else.

    Measured on this build: a Part::Box face reports its history as
    [["Plate", "Face6", []]] -- itself, with no source. Comparing that between
    candidates is comparing NAMES, which is the one signal 8.1 says must not be
    a key: it would hand 40 points to the stale name during exactly the
    re-derivation that exists because the name moved. So self-attribution
    counts as no attribution.
    """
    if not h or not h.get("available"):
        return None
    trace = h.get("trace")
    if not isinstance(trace, list) or not trace:
        return None
    useful = []
    for entry in trace:
        if not isinstance(entry, list):
            useful.append(entry)
            continue
        # (owner, name, sources): a self-reference with no sources says only
        # "this face is this face".
        if len(entry) >= 3 and not entry[2] and entry[1] == own_name:
            continue
        useful.append(entry)
    return useful or None


def _hist_str(h, depth=0):
    # Bounded, and stringified here rather than at the boundary: whatever this
    # build returns has to survive json.dumps.
    if depth > 3:
        return "..."
    if h is None:
        return None
    if isinstance(h, (str, int, float, bool)):
        return h
    if isinstance(h, (list, tuple)):
        return [_hist_str(x, depth + 1) for x in list(h)[:8]]
    name = getattr(h, "Name", None)
    return name if name else str(h)[:80]


def fingerprint(owner, sub, doc=None, source="given"):
    doc = doc or App.ActiveDocument
    o = _resolve_or_die(doc, owner, "object") if not hasattr(owner, "Name") else owner
    shape = getattr(o, "Shape", None)
    if shape is None or shape.isNull():
        raise KoiOpError("%s has no shape to reference" % o.Name)
    kind = _kind_of(sub)
    if kind is None:
        raise KoiOpError("%r is not a Face, Edge or Vertex name" % (sub,))
    ss, via = _sub_shape(shape, sub)
    if ss is None:
        raise KoiOpError("%s has no %s right now" % (o.Name, sub))
    inv = _invariants(ss, kind)
    lst = list(getattr(shape, KIND_ATTR[kind], []))[:CANDIDATE_LIMIT]
    centers = []
    for c in lst:
        try:
            centers.append(_vec3(c.CenterOfMass))
        except Exception:
            centers.append(None)
    fp = {
        "owner": o.Name,
        "sub": sub,
        "mapped": str(sub).startswith("?"),
        "via": via,
        "source": source,
        "history": _history(o, sub),
        "adjacency": _adjacency(shape, ss, kind),
        "axisRank": _axis_rank(centers, inv.get("center")),
    }
    fp.update(inv)
    return fp


def _score(fp, cand, adj, rank, hist):
    s = 0.0
    why = []
    ft, ct = fp.get("surface"), cand.get("surface")
    if ft and ct and ft == ct:
        s += W_TYPE
        why.append("type")
    elif ft and ct:
        return -1.0, ["type-mismatch"]
    if _same_dir(fp.get("direction"), cand.get("direction")):
        s += W_DIR
        why.append("direction")
    fh = _useful_history(fp.get("history"), fp.get("sub"))
    ch = _useful_history({"available": True, "trace": hist}, cand.get("_name"))
    if fh is not None and ch is not None and fh == ch:
        s += W_HISTORY
        why.append("history")
    fa = fp.get("adjacency")
    if fa and adj is not None and fa == adj:
        s += W_ADJ
        why.append("adjacency")
    fr, cr = fp.get("axisRank"), rank
    if fr and cr and all(fr.get(a) == cr.get(a) for a in "xyz"):
        s += W_RANK
        why.append("ordering")
    # Tie-break only. 8.1 is explicit that these are the worst discriminators
    # available, because a parametric edit moves all of them at once.
    a, b = fp.get("size"), cand.get("size")
    if a and b:
        s += W_SIZE * max(0.0, 1.0 - abs(a - b) / max(a, b))
    p, q = fp.get("center"), cand.get("center")
    if p and q:
        d = sum((p[i] - q[i]) ** 2 for i in range(3)) ** 0.5
        s += W_NEAR / (1.0 + d)
    return s, why


def _compatible(fp, inv):
    """Does the element under the stored name still look like the same thing?
    Type and direction only: area and centroid are supposed to move."""
    ft, it = fp.get("surface"), inv.get("surface")
    if ft and it and ft != it:
        return False
    fd, idr = fp.get("direction"), inv.get("direction")
    if fd and idr and not _same_dir(fd, idr):
        return False
    return True


def resolve_ref(fp, doc=None):
    doc = doc or App.ActiveDocument
    if doc is None:
        return {"status": "broken", "reason": "no-document"}
    owner = doc.getObject(fp.get("owner")) or resolve(doc, fp.get("owner"))
    if owner is None:
        return {"status": "broken", "reason": "owner-gone",
                "message": "%s no longer exists" % fp.get("owner")}
    shape = getattr(owner, "Shape", None)
    if shape is None or shape.isNull():
        return {"status": "broken", "reason": "no-shape",
                "message": "%s has no shape; it may have failed to recompute"
                           % owner.Name}
    kind = fp.get("kind") or _kind_of(fp.get("sub"))
    if kind is None:
        return {"status": "broken", "reason": "not-a-subelement"}

    # 1. The stored name, and then a check that it still means the same thing.
    ss, via = _sub_shape(shape, fp.get("sub"))
    moved_to = None
    if ss is not None:
        inv = _invariants(ss, kind)
        if _compatible(fp, inv) and via != "index":
            return {"status": "stored", "sub": fp.get("sub"), "via": via,
                    "owner": owner.Name}
        if not _compatible(fp, inv):
            moved_to = inv
        # via == "index" means the element map did not answer and a raw index
        # did. That is the fragile path by construction -- Face2 after a
        # recompute need not be the Face2 that was captured, and two parallel
        # faces are equally "compatible" -- so it does not get to assert the
        # answer. It falls through and has to win the re-derivation below,
        # which either confirms the name or names a better one.

    # 2. Re-derive. Only reached when the name is gone or now points at
    # something else -- the case the ranking exists for.
    lst = list(getattr(shape, KIND_ATTR[kind], []))[:CANDIDATE_LIMIT]
    centers = []
    for c in lst:
        try:
            centers.append(_vec3(c.CenterOfMass))
        except Exception:
            centers.append(None)
    scored = []
    for i, cand in enumerate(lst):
        name = "%s%d" % (kind, i + 1)
        try:
            ci = _invariants(cand, kind)
            ci["_name"] = name
            sc, why = _score(fp, ci,
                             _adjacency(shape, cand, kind),
                             _axis_rank(centers, ci.get("center")),
                             (_history(owner, name) or {}).get("trace"))
        except Exception:
            continue
        if sc > 0:
            scored.append((sc, name, why))
    scored.sort(key=lambda r: -r[0])
    if not scored or scored[0][0] < MIN_SCORE:
        return {"status": "broken", "reason": "no-candidate",
                "owner": owner.Name, "capturedSub": fp.get("sub"),
                "message": "%s is gone from %s and nothing else matches what "
                           "generated it. Ask the user to pick it again."
                           % (fp.get("sub"), owner.Name)}
    best = scored[0]
    margin = best[0] - (scored[1][0] if len(scored) > 1 else 0.0)
    if margin < MIN_MARGIN:
        return {"status": "ambiguous", "owner": owner.Name,
                "capturedSub": fp.get("sub"),
                "candidates": [{"sub": r[1], "score": round(r[0], 2)}
                               for r in scored[:4]],
                "message": "several elements match %s equally well; guessing "
                           "would attach to the wrong one. Ask the user."
                           % fp.get("sub")}
    if best[1] == fp.get("sub") and ss is not None:
        # The raw index was right after all, and now it is checked rather than
        # assumed.
        return {"status": "stored", "sub": fp.get("sub"), "via": "index-verified",
                "owner": owner.Name, "score": round(best[0], 2),
                "margin": round(margin, 2)}
    return {"status": "rederived", "sub": best[1], "owner": owner.Name,
            "capturedSub": fp.get("sub"), "score": round(best[0], 2),
            "margin": round(margin, 2), "matchedOn": best[2],
            "movedTo": moved_to and moved_to.get("surface"),
            # The re-derived name is a raw index, not a mapped name: it is
            # accurate now and no more durable than any other index.
            "message": "%s now resolves to %s (matched on %s); re-capture it "
                       "to get a durable reference"
                       % (fp.get("sub"), best[1], ", ".join(best[2]) or "geometry")}


def capture_ref(rid, owner, sub, doc=None, source="given"):
    doc = doc or App.ActiveDocument
    fp = fingerprint(owner, sub, doc, source)
    ok = _meta_set(doc, REF_PREFIX + str(rid), _json.dumps(fp))
    return {"id": rid, "fingerprint": fp, "persisted": ok}


def stored_refs(doc=None):
    doc = doc or App.ActiveDocument
    out = []
    if doc is None:
        return out
    m = _meta(doc)
    for k in sorted(m):
        if not k.startswith(REF_PREFIX):
            continue
        try:
            out.append((k[len(REF_PREFIX):], _json.loads(m[k])))
        except Exception:
            continue
        if len(out) >= REF_LIMIT:
            break
    return out


def revalidate(doc=None):
    """Every stored pick, re-checked. 8.1: user picks are re-validated every
    turn, not trusted from the turn they were made."""
    rows = []
    for rid, fp in stored_refs(doc):
        try:
            r = resolve_ref(fp, doc)
        except Exception as e:
            r = {"status": "broken", "reason": "resolve-failed",
                 "message": "%s: %s" % (type(e).__name__, e)}
        r["id"] = rid
        r.setdefault("owner", fp.get("owner"))
        r.setdefault("capturedSub", fp.get("sub"))
        rows.append(r)
    return rows


def refs_report(doc=None):
    rows = revalidate(doc)
    broken = [r["id"] for r in rows if r["status"] in ("broken", "ambiguous")]
    return {"refs": rows, "broken": broken,
            "moved": [r["id"] for r in rows if r["status"] == "rederived"]}


def _split_ref(ref):
    if isinstance(ref, dict):
        return _need(ref, "owner"), _need(ref, "sub")
    s = str(ref)
    if ":" not in s:
        raise KoiOpError("a reference looks like 'Pad:Face3', not %r" % (ref,))
    a, b = s.split(":", 1)
    return a.strip(), b.strip()


def selection_refs():
    """What the user has clicked. This is the only reference source 8.1
    sanctions: an AI-authored face reference is banned, and the difference
    between the two is provenance, which nothing downstream can recover."""
    if Gui is None:
        return []
    out = []
    try:
        for s in Gui.Selection.getSelectionEx()[:16]:
            obj = getattr(s, "Object", None)
            for sub in (list(getattr(s, "SubElementNames", []) or [])[:8]):
                if obj is not None and sub:
                    out.append({"owner": obj.Name, "sub": sub})
    except Exception:
        return []
    return out


# ---------- finding an element without authoring an index (8.1) ----------
#
# 8.1 bans an AI-authored topological name, and it is right to: Face6 is an
# index into a list a recompute reorders. But the ban left no legitimate way
# to reach an element at all -- fillet, chamfer and shell all need 'refs', and
# the only sanctioned source was a user click. So an unattended turn either
# stopped and asked, or reached for freecad_script and enumerated Shape.Faces
# by hand, which is authoring an index with extra steps.
#
# What is actually banned is *choosing by index*. Choosing by geometry -- the
# +Z face at z=25, the four vertical edges longer than 10 -- is the same act
# the fingerprint resolver performs when it re-derives, and it is stable under
# exactly the edits an index is not. So: query selects geometrically and hands
# back candidates WITH their ambiguity, and 'ref' is still what makes one
# durable. The index never has to be guessed, and a query that matches three
# faces says three rather than picking the first.

QUERY_LIMIT = 40
AXIS_WORDS = {
    "+X": (1.0, 0.0, 0.0), "-X": (-1.0, 0.0, 0.0),
    "+Y": (0.0, 1.0, 0.0), "-Y": (0.0, -1.0, 0.0),
    "+Z": (0.0, 0.0, 1.0), "-Z": (0.0, 0.0, -1.0),
    "X": (1.0, 0.0, 0.0), "Y": (0.0, 1.0, 0.0), "Z": (0.0, 0.0, 1.0),
}


def _dir_arg(v, what):
    if v is None:
        return None
    if isinstance(v, str):
        d = AXIS_WORDS.get(v.strip().upper())
        if d is None:
            raise KoiOpError(
                "%s must be one of %s, or [x, y, z], not %r"
                % (what, ", ".join(sorted(AXIS_WORDS)), v))
        return list(d)
    if isinstance(v, list) and len(v) == 3:
        try:
            n = App.Vector(*[float(x) for x in v]).normalize()
            return [round(n.x, 6), round(n.y, 6), round(n.z, 6)]
        except Exception:
            raise KoiOpError("%s [x, y, z] must be a non-zero vector" % what)
    raise KoiOpError("%s must be '+Z' or [x, y, z], not %r" % (what, v))


def _sub_radius(ss, kind):
    try:
        g = ss.Surface if kind == "Face" else ss.Curve
        r = getattr(g, "Radius", None)
        return None if r is None else round(float(r), 6)
    except Exception:
        return None


def query(args, doc=None):
    """Elements of one object, chosen by geometry rather than by index."""
    doc = doc or App.ActiveDocument
    if doc is None:
        raise KoiOpError("no active document")
    owner = _resolve_or_die(doc, _need(args, "of"), "object")
    kind = str(args.get("kind") or "face").strip().lower()
    if kind not in ("face", "edge"):
        raise KoiOpError("kind must be 'face' or 'edge', not %r"
                         % (args.get("kind"),))
    kind = "Face" if kind == "face" else "Edge"
    shape = getattr(owner, "Shape", None)
    if shape is None or shape.isNull():
        raise KoiOpError("%s has no shape to query" % owner.Name)
    items = list(getattr(shape, KIND_ATTR[kind]))
    if len(items) > CANDIDATE_LIMIT:
        raise KoiOpError(
            "%s has %d %ss, past the %d-element bound; query a simpler "
            "feature or narrow it upstream"
            % (owner.Name, len(items), kind.lower(), CANDIDATE_LIMIT))

    want_dir = _dir_arg(args.get("normal") or args.get("direction"),
                        "normal" if kind == "Face" else "direction")
    want_surface = args.get("surface")
    want_surface = str(want_surface).lower() if want_surface else None
    at = args.get("at")
    if at is not None and not isinstance(at, dict):
        raise KoiOpError("at must be {x: .., y: .., z: ..} with any subset")
    tol = float(args.get("tol") or 0.1)
    min_size = args.get("minSize")
    max_size = args.get("maxSize")
    want_size = args.get("size")
    want_r = args.get("radius")
    limit = int(args.get("limit") or 12)
    limit = max(1, min(limit, QUERY_LIMIT))

    rows = []
    for idx, ss in enumerate(items):
        sub = "%s%d" % (kind, idx + 1)
        inv = _invariants(ss, kind)
        r = _sub_radius(ss, kind)
        if want_surface:
            surf = str(inv.get("surface", "")).lower()
            surf_base = surf.replace("surface", "").replace("curve", "").replace("geom", "")
            if want_surface != surf and want_surface != surf_base:
                continue
        # Direction is compared with the caller's tolerance, not DIR_TOL: a
        # near-planar face off by a thousandth of a degree is still the top.
        if want_dir is not None:
            got = inv.get("direction")
            if not got:
                continue
            if sum(a * b for a, b in zip(got, want_dir)) < 1.0 - max(tol * 1e-2, 1e-6):
                continue
        if at is not None:
            c = inv.get("center")
            if not c:
                continue
            bad = False
            for ax, i in (("x", 0), ("y", 1), ("z", 2)):
                if at.get(ax) is not None and abs(c[i] - float(at[ax])) > tol:
                    bad = True
                    break
            if bad:
                continue
        size = inv.get("size")
        if min_size is not None and (size is None or size < float(min_size) - tol):
            continue
        if max_size is not None and (size is None or size > float(max_size) + tol):
            continue
        if want_size is not None:
            if isinstance(want_size, (list, tuple)) and len(want_size) == 2:
                if size is None or size < float(want_size[0]) - tol or size > float(want_size[1]) + tol:
                    continue
            elif isinstance(want_size, dict):
                s_min = want_size.get("min")
                s_max = want_size.get("max")
                if s_min is not None and (size is None or size < float(s_min) - tol):
                    continue
                if s_max is not None and (size is None or size > float(s_max) + tol):
                    continue
            elif str(want_size).lower() in ("longest", "max", "shortest", "min"):
                pass
            else:
                try:
                    target_sz = float(want_size)
                    if size is None or abs(size - target_sz) > tol:
                        continue
                except (ValueError, TypeError):
                    pass
        if want_r is not None and (r is None or abs(r - float(want_r)) > tol):
            continue
        row = {"sub": sub, "ref": "%s:%s" % (owner.Name, sub),
               "surface": inv.get("surface"), "size": size,
               "center": inv.get("center"), "direction": inv.get("direction")}
        if r is not None:
            row["radius"] = r
        rows.append(row)

    order = str(args.get("sort") or "size").lstrip("-")
    rev = str(args.get("sort") or "").startswith("-")
    keyer = {
        "size": lambda r: (r.get("size") is None, r.get("size") or 0.0),
        "x": lambda r: ((r.get("center") or [0, 0, 0])[0],),
        "y": lambda r: ((r.get("center") or [0, 0, 0])[1],),
        "z": lambda r: ((r.get("center") or [0, 0, 0])[2],),
    }.get(order)
    if keyer is None:
        raise KoiOpError("sort must be size, x, y or z (optionally '-size')")
    rows.sort(key=keyer, reverse=rev)

    # How many the caller MEANT. A four-corner chamfer is one intent that
    # matches four edges, and reporting that as ambiguous made a correct
    # selection read like a failure -- so the session narrowed a filter it
    # should have left alone, or fell back to enumerating Shape.Edges.
    # 'expect' says the number, and only a mismatch is ambiguous.
    want = args.get("expect")
    matched = len(rows)
    kept = rows[:limit]
    if want in (None, "one", 1):
        ambiguous = matched != 1
    elif want in ("many", "all", "any"):
        ambiguous = matched == 0
    else:
        try:
            ambiguous = matched != int(want)
        except Exception:
            raise KoiOpError(
                "expect must be 'one', 'many' or a count, not %r" % (want,))
    stale = _tip_warning(owner)
    out = {"of": owner.Name, "kind": kind, "total": len(items),
           "matched": matched, "returned": len(kept),
           "candidates": kept,
           # Ready to hand to fillet, chamfer or shell without rebuilding the
           # list by hand -- which is where a transcription error goes in.
           "refs": [r["ref"] for r in kept],
           "expected": want if want is not None else "one",
           "ambiguous": ambiguous}
    if stale:
        # Worth more here than anywhere else: a query against a mid-tree
        # feature returns elements that are NOT on the finished part, and
        # every one of them is a ref a later fillet will happily take.
        out["notTip"] = stale
        out["notTipNote"] = stale["note"] + (
            " Elements found here may not exist on the finished solid, and a "
            "ref captured from one is a ref to a face nobody will ever see.")
    if matched == 0:
        out["note"] = (
            "nothing matched. Loosen a filter or widen tol -- and do NOT fall "
            "back to guessing an index: %s has %d %ss and which one is which "
            "changes on the next recompute."
            % (owner.Name, len(items), kind.lower()))
    elif matched == 1:
        out["note"] = (
            "exactly one match, so this selection is unambiguous. Capture it "
            "with fn 'ref' ({ref: %r}) before using it in a later turn -- the "
            "sub name itself is an index and is accurate only right now."
            % rows[0]["ref"])
    else:
        out["note"] = (
            "%d elements matched. The refs list above is the whole set, "
            "ready for fillet, chamfer or shell -- pass expect:'many' to say "
            "that is "
            "what you meant and stop this reading as ambiguous. Otherwise "
            "narrow with at/minSize/radius. Do not pick the first one because "
            "it is first: iteration order is not a design intent." % matched)
    return out


def _op_query(doc, args, kid):
    return query(args, doc)


def _op_ref(doc, args, kid):
    src = "given"
    if args.get("from") == "selection":
        picks = selection_refs()
        if not picks:
            raise KoiOpError(
                "nothing is selected. Ask the user to click the face or edge "
                "they mean -- a reference this side invents is banned (8.1)")
        owner, sub = picks[0]["owner"], picks[0]["sub"]
        src = "selection"
    else:
        owner, sub = _split_ref(_need(args, "ref"))
    return capture_ref(kid, owner, sub, doc, src)


# ---------- purchased parts (7) ----------
#
# 7.1: a component is not a solid. It is an interface (bore d25 h6, OD d37 H7,
# width 7), an envelope (d37 x 7 plus clearance) and metadata (SKF 6805-2Z,
# 21 g, purchased). The solid is only how you look at it.
#
# So the table below is the product, and the geometry is generated from it.
# Clearance is ISO 273 (close / normal / loose), head dimensions are ISO 4762
# socket head cap screw, tap drill is the standard coarse-pitch drill.
#
# 8.4, and it is not negotiable: nothing here cuts a thread. A fastener is a
# shank and a head; a tapped hole is a thread SPECIFICATION. Helical geometry
# costs recompute and render time and carries nothing a spec lacks.

FASTENERS = {
    "M2":   {"d": 2.0,  "pitch": 0.40, "tap": 1.60,  "clearance": {"close": 2.2,  "normal": 2.4,  "loose": 2.6},
             "head_d": 3.8,  "head_h": 2.0,  "cbore_d": 4.3,  "socket": 1.5},
    "M2.5": {"d": 2.5,  "pitch": 0.45, "tap": 2.05,  "clearance": {"close": 2.7,  "normal": 2.9,  "loose": 3.1},
             "head_d": 4.5,  "head_h": 2.5,  "cbore_d": 5.0,  "socket": 2.0},
    "M3":   {"d": 3.0,  "pitch": 0.50, "tap": 2.50,  "clearance": {"close": 3.2,  "normal": 3.4,  "loose": 3.6},
             "head_d": 5.5,  "head_h": 3.0,  "cbore_d": 6.5,  "socket": 2.5},
    "M4":   {"d": 4.0,  "pitch": 0.70, "tap": 3.30,  "clearance": {"close": 4.3,  "normal": 4.5,  "loose": 4.8},
             "head_d": 7.0,  "head_h": 4.0,  "cbore_d": 8.0,  "socket": 3.0},
    "M5":   {"d": 5.0,  "pitch": 0.80, "tap": 4.20,  "clearance": {"close": 5.3,  "normal": 5.5,  "loose": 5.8},
             "head_d": 8.5,  "head_h": 5.0,  "cbore_d": 10.0, "socket": 4.0},
    "M6":   {"d": 6.0,  "pitch": 1.00, "tap": 5.00,  "clearance": {"close": 6.4,  "normal": 6.6,  "loose": 7.0},
             "head_d": 10.0, "head_h": 6.0,  "cbore_d": 11.0, "socket": 5.0},
    "M8":   {"d": 8.0,  "pitch": 1.25, "tap": 6.80,  "clearance": {"close": 8.4,  "normal": 9.0,  "loose": 10.0},
             "head_d": 13.0, "head_h": 8.0,  "cbore_d": 15.0, "socket": 6.0},
    "M10":  {"d": 10.0, "pitch": 1.50, "tap": 8.50,  "clearance": {"close": 10.5, "normal": 11.0, "loose": 12.0},
             "head_d": 16.0, "head_h": 10.0, "cbore_d": 18.0, "socket": 8.0},
    "M12":  {"d": 12.0, "pitch": 1.75, "tap": 10.20, "clearance": {"close": 13.0, "normal": 13.5, "loose": 14.5},
             "head_d": 18.0, "head_h": 12.0, "cbore_d": 20.0, "socket": 10.0},
}

# 8.2: non-stock dimensions are a lint error, not a taste question. A 7.3 mm
# plate cannot be bought and a 9.3 mm hole cannot be drilled.
STOCK_PLATE = (1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0,
               15.0, 16.0, 20.0, 25.0, 30.0)
ENGAGEMENT_RATIO = 1.5   # a tapped hole shallower than 1.5xD strips

PARAM_SHEET = "koi_params"


def fastener(size):
    f = FASTENERS.get(str(size).upper().replace("M", "M"))
    if f is None:
        raise KoiOpError("no fastener %r in the table; have %s"
                         % (size, ", ".join(sorted(FASTENERS, key=lambda k: FASTENERS[k]["d"]))))
    return f


def drill_sizes():
    out = set()
    for f in FASTENERS.values():
        out.add(f["tap"])
        for v in f["clearance"].values():
            out.add(v)
    return sorted(out)


# ---------- the parameter sheet ----------
#
# 7.3 says diameter and counterbore are bound BY EXPRESSION to the fastener's
# published interface, so swapping the fastener updates the plate. An
# expression needs something to point at, so the interface lands in a
# spreadsheet and the features bind to its aliases. Swapping a fastener then
# rewrites cells and FreeCAD's own recompute does the propagation -- which is
# the entire reason for choosing a parametric engine.

def _alias(*parts):
    s = "_".join(str(p) for p in parts if p not in (None, ""))
    out = "".join(c if (c.isalnum() or c == "_") else "_" for c in s)
    while "__" in out:
        out = out.replace("__", "_")
    if out and out[0].isdigit():
        out = "p_" + out
    return out[:60]


def params_sheet(doc=None, create=True):
    doc = doc or App.ActiveDocument
    if doc is None:
        return None
    sh = doc.getObject(PARAM_SHEET)
    if sh is None and create:
        sh = doc.addObject("Spreadsheet::Sheet", PARAM_SHEET)
        sh.Label = "Koi parameters"
        _meta_set(doc, "koi.params.next", "1")
    return sh


def _next_cell(doc, sh):
    used = 0
    m = _meta(doc)
    try:
        used = int(m.get("koi.params.next", "1"))
    except Exception:
        used = 1
    # Bounded: the sheet is for interface values, not for a dataset.
    if used > 400:
        raise KoiOpError("the parameter sheet is full (400 rows)")
    _meta_set(doc, "koi.params.next", str(used + 1))
    return "A%d" % used, "B%d" % used


def param_set(alias, value, doc=None, label=None):
    """Set an aliased cell, creating it the first time. Returns the alias."""
    doc = doc or App.ActiveDocument
    sh = params_sheet(doc)
    if sh is None:
        raise KoiOpError("no document for the parameter sheet")
    alias = _alias(alias)
    cell = None
    try:
        cell = sh.getCellFromAlias(alias)
    except Exception:
        cell = None
    if not cell:
        lc, cell = _next_cell(doc, sh)
        try:
            sh.set(lc, str(label or alias))
        except Exception:
            pass
        sh.set(cell, str(value))
        sh.setAlias(cell, alias)
    else:
        sh.set(cell, str(value))
    return alias


def param_get(alias, doc=None):
    doc = doc or App.ActiveDocument
    sh = params_sheet(doc, create=False)
    if sh is None:
        return None
    try:
        return sh.get(_alias(alias))
    except Exception:
        return None


def params(doc=None):
    doc = doc or App.ActiveDocument
    sh = params_sheet(doc, create=False)
    if sh is None:
        return {}
    out = {}
    m = _meta(doc)
    try:
        n = int(m.get("koi.params.next", "1"))
    except Exception:
        n = 1
    for i in range(1, min(n, 401)):
        cell = "B%d" % i
        try:
            a = sh.getAlias(cell)
        except Exception:
            a = None
        if not a:
            continue
        try:
            out[a] = _plain(sh.get(a))
        except Exception:
            continue
    return out


def publish_interface(pid, values, doc=None):
    """Put a component's published interface into the sheet under its id."""
    written = {}
    for k in sorted(values):
        v = values[k]
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            written[k] = param_set(_alias(pid, k), round(float(v), 6), doc,
                                   label="%s.%s" % (pid, k))
    return written


# ---------- the catalog ----------
#
# 7.2: three data files, and a generator that reads a small spec. Anything
# else -- bearings, extrusion profiles, a vendor's own envelope -- is a
# user-contributed file against this same spec, not core work.

CATALOG = {
    "NEMA17_envelope": {
        "id": "NEMA17_envelope",
        "kind": "motor",
        "body": [
            {"box": [42.3, 42.3, 34]},
            {"cyl": {"d": 22, "h": 2, "at": [0, 0, 34]}},
        ],
        "shaft": {"d": 5, "l": 24},
        "interfaces": {
            "face": {"datum": "plane", "at": [0, 0, 34]},
            "bolts": {"pattern": "square", "pitch": 31, "thread": "M3"},
        },
        "meta": {"mpn": "17HS4401", "mass_g": 280, "purchased": True},
    },
    "NEMA23_envelope": {
        "id": "NEMA23_envelope",
        "kind": "motor",
        "body": [
            {"box": [56.4, 56.4, 51]},
            {"cyl": {"d": 38.1, "h": 1.6, "at": [0, 0, 51]}},
        ],
        "shaft": {"d": 6.35, "l": 21},
        "interfaces": {
            "face": {"datum": "plane", "at": [0, 0, 51]},
            "bolts": {"pattern": "square", "pitch": 47.14, "thread": "M5"},
        },
        "meta": {"mpn": "23HS5628", "mass_g": 700, "purchased": True},
    },
    "6805_bearing": {
        "id": "6805_bearing",
        "kind": "bearing",
        "body": [
            {"cyl": {"d": 37, "h": 7, "at": [0, 0, 0]}},
            {"cyl": {"d": 25, "h": 7, "at": [0, 0, 0]}, "cut": True},
        ],
        "interfaces": {
            "bore": {"d": 25, "fit": "h6"},
            "od": {"d": 37, "fit": "H7"},
            "width": {"value": 7},
        },
        "meta": {"mpn": "SKF 6805-2Z", "mass_g": 21, "purchased": True},
    },
}


def _spec_interface_values(spec):
    """The numbers a design is measured against, flattened for the sheet."""
    out = {}
    for name, iface in (spec.get("interfaces") or {}).items():
        if not isinstance(iface, dict):
            continue
        for k in ("d", "pitch", "value", "h", "l"):
            if isinstance(iface.get(k), (int, float)):
                out[_alias(name, k) if k != "value" else _alias(name)] = iface[k]
    sh = spec.get("shaft") or {}
    for k in ("d", "l"):
        if isinstance(sh.get(k), (int, float)):
            out[_alias("shaft", k)] = sh[k]
    return out


def build_envelope(spec, name, doc=None):
    """Boxes and cylinders in, one envelope solid out. Bounded at 32 pieces."""
    import Part
    doc = doc or App.ActiveDocument
    pieces = spec.get("body") or []
    if not pieces:
        raise KoiOpError("spec %r has no body" % spec.get("id"))
    if len(pieces) > 32:
        raise KoiOpError("an envelope is capped at 32 primitives")
    solid = None
    cuts = []
    for i, p in enumerate(pieces):
        if not isinstance(p, dict):
            raise KoiOpError("body[%d] must be an object" % i)
        if "box" in p:
            b = p["box"]
            if not (isinstance(b, list) and len(b) == 3):
                raise KoiOpError("body[%d].box must be [x, y, z]" % i)
            at = p.get("at") or [-b[0] / 2.0, -b[1] / 2.0, 0]
            sh = Part.makeBox(float(b[0]), float(b[1]), float(b[2]),
                              App.Vector(float(at[0]), float(at[1]), float(at[2])))
        elif "cyl" in p:
            c = p["cyl"]
            at = c.get("at") or [0, 0, 0]
            sh = Part.makeCylinder(float(c["d"]) / 2.0, float(c["h"]),
                                   App.Vector(float(at[0]), float(at[1]), float(at[2])))
        else:
            raise KoiOpError("body[%d] must have box or cyl" % i)
        if p.get("cut"):
            cuts.append(sh)
        else:
            solid = sh if solid is None else solid.fuse(sh)
    if solid is None:
        raise KoiOpError("spec %r is all cuts and no material" % spec.get("id"))
    shaft = spec.get("shaft")
    if isinstance(shaft, dict) and shaft.get("d") and shaft.get("l"):
        face = ((spec.get("interfaces") or {}).get("face") or {}).get("at") or [0, 0, 0]
        solid = solid.fuse(Part.makeCylinder(
            float(shaft["d"]) / 2.0, float(shaft["l"]),
            App.Vector(float(face[0]), float(face[1]), float(face[2]))))
    for c in cuts:
        solid = solid.cut(c)
    obj = doc.addObject("Part::Feature", name)
    obj.Shape = solid.removeSplitter() if hasattr(solid, "removeSplitter") else solid
    return obj


def bolt_positions(spec):
    """Where the fasteners go, in the component's own frame."""
    b = ((spec.get("interfaces") or {}).get("bolts") or {})
    if not b:
        return []
    pitch = float(b.get("pitch") or 0)
    if b.get("pattern") == "square" and pitch > 0:
        h = pitch / 2.0
        return [[-h, -h], [h, -h], [h, h], [-h, h]]
    if b.get("pattern") == "circle" and pitch > 0:
        import math
        n = int(b.get("count") or 4)
        n = max(1, min(n, 32))
        r = pitch / 2.0
        return [[round(r * math.cos(2 * math.pi * i / n), 6),
                 round(r * math.sin(2 * math.pi * i / n), 6)] for i in range(n)]
    return []


STEEL_G_PER_MM3 = 0.00785


def _steel_mass(volume_mm3):
    """Grams, from the envelope. Approximate and said to be: a socket head
    cap screw is not a cylinder plus a cylinder, and the thread relief and the
    socket both remove material. Good to a few percent, which is what a BOM
    total needs -- and far better than the None it replaces, which silently
    dropped every fastener out of the mass."""
    return round(float(volume_mm3) * STEEL_G_PER_MM3, 3)


def _fastener_spec(size, length):
    f = fastener(size)
    return {
        "id": "iso4762_%sx%g" % (size, length),
        "kind": "fastener",
        "body": [
            {"cyl": {"d": f["d"], "h": float(length), "at": [0, 0, -float(length)]}},
            {"cyl": {"d": f["head_d"], "h": f["head_h"], "at": [0, 0, 0]}},
        ],
        "interfaces": {
            "clearance": {"d": f["clearance"]["normal"]},
            "close": {"d": f["clearance"]["close"]},
            "tap": {"d": f["tap"]},
            "head": {"d": f["head_d"], "h": f["head_h"]},
            "cbore": {"d": f["cbore_d"]},
            "thread": {"value": f["d"], "pitch": f["pitch"]},
        },
        "meta": {"standard": "ISO 4762", "size": size, "length": length,
                 # A designation, not a vendor part number: ISO 4762 M5x16
                 # identifies the item to any supplier, which is what a BOM
                 # line is for. A real MPN comes from the user's vendor.
                 "mpn": "ISO 4762 %s x %g" % (size, length),
                 "mass_g": _steel_mass(
                     _math.pi / 4.0 * f["d"] ** 2 * float(length)
                     + _math.pi / 4.0 * f["head_d"] ** 2 * f["head_h"]),
                 "purchased": True, "modeledThread": False},
    }


def _op_insert(doc, args, kid):
    catalog = args.get("catalog")
    spec = args.get("spec")
    if args.get("fastener"):
        spec = _fastener_spec(str(args["fastener"]),
                              float(args.get("length") or 16))
    elif catalog:
        spec = CATALOG.get(str(catalog))
        if spec is None:
            raise KoiOpError("no catalog part %r; have %s"
                             % (catalog, ", ".join(sorted(CATALOG))))
    if not isinstance(spec, dict):
        raise KoiOpError("pass catalog, fastener or an inline spec")

    obj = build_envelope(spec, _safe_name(kid, "Part"), doc)
    at = args.get("at") or [0, 0, 0]
    if not (isinstance(at, list) and len(at) == 3):
        raise KoiOpError("at must be [x, y, z]")
    obj.Placement.Base = App.Vector(float(at[0]), float(at[1]), float(at[2]))
    obj.Label = str(args.get("label") or spec.get("id") or kid)

    published = publish_interface(kid, _spec_interface_values(spec), doc)
    _meta_set(doc, "koi.part." + str(kid), _json.dumps({
        "spec": spec.get("id"), "kind": spec.get("kind"),
        "meta": spec.get("meta") or {}, "aliases": published,
        "size": (spec.get("meta") or {}).get("size"),
        # The pattern itself, not just the pitch it published. bolt_sketch
        # needs to know it is four holes on a square and not six on a circle,
        # and re-deriving that from the catalog fails for an inline spec.
        "bolts": ((spec.get("interfaces") or {}).get("bolts") or {}),
    }))
    register(doc, kid, obj, args.get("turn"))
    doc.recompute()
    return {"name": obj.Name, "spec": spec.get("id"), "kind": spec.get("kind"),
            "aliases": published, "boltPositions": bolt_positions(spec),
            "meta": spec.get("meta") or {},
            "volume": _vol(obj)}


def component(pid, doc=None):
    doc = doc or App.ActiveDocument
    raw = _meta(doc).get("koi.part." + str(pid))
    if not raw:
        return None
    try:
        return _json.loads(raw)
    except Exception:
        return None


def _op_swap(doc, args, kid):
    """The demo, and the whole argument: change the part, not the plate."""
    pid = str(_need(args, "target"))
    rec = component(pid, doc)
    if rec is None:
        raise KoiOpError("%r is not an inserted component" % pid)
    obj = resolve(doc, pid)
    before = dict(params(doc))

    if args.get("fastener"):
        spec = _fastener_spec(str(args["fastener"]),
                              float(args.get("length") or
                                    (rec.get("meta") or {}).get("length") or 16))
    elif args.get("catalog"):
        spec = CATALOG.get(str(args["catalog"]))
        if spec is None:
            raise KoiOpError("no catalog part %r" % args["catalog"])
    else:
        raise KoiOpError("pass fastener or catalog to swap to")

    placement = None
    if obj is not None:
        # Assigning Shape assigns the shape's OWN placement with it, which is
        # the origin: a swap moved every seated part back to 0,0,0 and the
        # only sign of it was the model. The seat is not part of what changed.
        try:
            placement = App.Placement(obj.Placement)
        except Exception:
            placement = None
        new = build_envelope(spec, "_koi_tmp", doc)
        obj.Shape = new.Shape
        doc.removeObject(new.Name)
        if placement is not None:
            obj.Placement = placement
        obj.Label = str(spec.get("id"))
    published = publish_interface(pid, _spec_interface_values(spec), doc)
    _meta_set(doc, "koi.part." + str(pid), _json.dumps({
        "spec": spec.get("id"), "kind": spec.get("kind"),
        "meta": spec.get("meta") or {}, "aliases": published,
        "size": (spec.get("meta") or {}).get("size"),
        "bolts": ((spec.get("interfaces") or {}).get("bolts") or {}),
    }))
    doc.recompute()
    after = params(doc)
    moved = sorted(k for k in after
                   if k in before and before[k] != after[k])
    return {"target": pid, "spec": spec.get("id"), "aliases": published,
            "changed": [{"alias": k, "from": before[k], "to": after[k]}
                        for k in moved],
            "boltPositions": bolt_positions(spec),
            "placement": None if obj is None else _pos(obj),
            "placementKept": placement is not None,
            # Nothing here touched the plate. Whatever moved on it moved
            # because an expression pointed at these cells.
            "propagatedVia": "expressions on " + PARAM_SHEET}


# ---------- holes ----------

HOLE_DEPTHS = ("Dimension", "ThroughAll")


def _set_if(obj, prop, value):
    """Set a property when this build has it, and say whether it took.

    PartDesign::Hole's property set has moved between versions; guessing which
    spelling exists produces a hole that silently ignores half its
    specification.
    """
    if prop not in obj.PropertiesList:
        return False
    try:
        setattr(obj, prop, value)
        return True
    except Exception:
        return False


def _bind(obj, prop, expr):
    if prop not in obj.PropertiesList:
        return False
    try:
        obj.setExpression(prop, expr)
        return True
    except Exception:
        return False


def _thread_size_enum(h, size):
    """This build's own spelling of a thread size, or None.

    'M5' was written to ThreadSize, refused by the enumeration, and left the
    hole Threaded at whatever the default was -- M4, so the diameter silently
    became 3.3 and the reply managed to say ThreadSize: false and
    ThreadedVerified: true about the same hole. The enumeration is readable.
    Guessing its spelling is not, and neither is writing to it blind.

    Returns (spelling, options). Matches 'M5' against 'M5x0.8' by taking the
    pitch from the fastener table when the enumeration lists several.
    """
    opts = []
    try:
        opts = [str(x) for x in (h.getEnumerationsOfProperty("ThreadSize") or [])]
    except Exception:
        opts = []
    want = str(size).strip().upper()
    if not opts:
        return want, opts          # nothing to check against; the readback will
    for o in opts:
        if o.upper() == want:
            return o, opts
    pre = [o for o in opts if o.upper().split("X")[0] == want]
    if len(pre) == 1:
        return pre[0], opts
    if pre:
        try:
            pitch = float(fastener(want)["pitch"])
        except Exception:
            pitch = None
        if pitch is not None:
            for o in pre:
                tail = o.upper().split("X", 1)[1] if "X" in o.upper() else ""
                try:
                    if abs(float(tail) - pitch) < 1e-9:
                        return o, opts
                except Exception:
                    continue
    return None, opts


def _cbore_from_table(size):
    """(diameter, depth) for a socket head sitting flush in a counterbore."""
    f = fastener(size)
    return float(f["cbore_d"]), float(f["head_h"])


def _hole_source(args, doc):
    """Resolve spec:{from:'bolt.mount.clearance'} to (alias, value)."""
    spec = args.get("spec")
    if isinstance(spec, dict) and spec.get("from"):
        ref = str(spec["from"])
        parts = ref.rsplit(".", 1)
        if len(parts) != 2:
            raise KoiOpError("spec.from looks like 'bolt.mount.clearance'")
        pid, what = parts
        if component(pid, doc) is None:
            raise KoiOpError("%r is not an inserted component" % pid)
        alias = _alias(pid, what, "d")
        if param_get(alias, doc) is None:
            alias = _alias(pid, what)
        if param_get(alias, doc) is None:
            raise KoiOpError("%s publishes no %r" % (pid, what))
        return alias, _plain(param_get(alias, doc))
    if isinstance(spec, dict) and spec.get("clearance"):
        f = fastener(spec["clearance"])
        return None, f["clearance"][str(spec.get("fit") or "normal")]
    if isinstance(spec, dict) and spec.get("tap"):
        return None, fastener(spec["tap"])["tap"]
    return None, None


def _profile_diameter(sk):
    """The smallest circle in a hole's profile sketch.

    A profile made of circles already states the hole size, and refusing it
    for want of a 'diameter' argument makes the composition this surface is
    built on -- bolt_sketch, then hole -- fail on its first use with 'missing
    required argument'. Smallest, not first: a sketch that mixes sizes is
    ambiguous, and the tighter hole is the one that will not pass a bolt.

    Circles only. ArcOfCircle carries a Radius too, and a filleted corner in
    the profile is not a hole.
    """
    ds = []
    for g in (getattr(sk, "Geometry", None) or []):
        if type(g).__name__ != "Circle":
            continue
        r = getattr(g, "Radius", None)
        if r is None:
            continue
        try:
            ds.append(round(float(r) * 2.0, 6))
        except Exception:
            continue
    if not ds:
        return None, None
    return min(ds), len(set(ds))


def _profile_circles(sk):
    """How many holes this profile asks for -- the denominator for the check
    below. Construction geometry is layout, not a hole."""
    n = 0
    geo = getattr(sk, "Geometry", None) or []
    for i, g in enumerate(geo):
        if type(g).__name__ != "Circle":
            continue
        try:
            if sk.getConstruction(i):
                continue
        except Exception:
            if bool(getattr(g, "Construction", False)):
                continue
        n += 1
    return n


def _op_hole(doc, args, kid):
    body = _resolve_body(doc, args.get("body"), args)
    sk = _resolve_or_die(doc, _need(args, "sketch"), "sketch")
    h = body.newObject("PartDesign::Hole", _safe_name(kid, "Hole"))
    h.Profile = sk
    applied = {}

    alias, value = _hole_source(args, doc)
    source = "spec" if value is not None else None
    sizes = None
    dia_expr = None
    if value is None and args.get("diameter") is None:
        value, sizes = _profile_diameter(sk)
        if value is not None:
            source = "profile"
    if value is None:
        value, dia_expr = _numx(args, "diameter")
        source = source or "argument"
    applied["Diameter"] = _set_if(h, "Diameter", float(value))
    # This is the propagation. The plate does not know it has an M5 hole; it
    # knows its diameter is that cell. An alias from a spec still wins --
    # it is the published interface of a real part -- and a caller-supplied
    # expression is the same mechanism reached directly.
    bound_to = (PARAM_SHEET + "." + alias) if alias else dia_expr
    if bound_to:
        applied["DiameterExpression"] = _bind(h, "Diameter", bound_to)
        if not applied["DiameterExpression"]:
            raise KoiOpError(
                "%s would not take the expression %r on Diameter, so the "
                "hole is a literal %g and will not follow a change to it"
                % (h.Name, bound_to, float(value)))

    # A depth that is quietly ignored is the wrong hole behind a green reply.
    # 'through' defaulted to True, so hole(depth: 18) wrote ThroughAll, left
    # Depth reading the bbox diagonal (240), and drilled the faceplate bolts
    # through the entire stem -- with 18 in the request and nothing in the
    # reply to disagree with it. A depth now MEANS Dimension, and asking for
    # both is refused rather than silently resolved in favour of one.
    drill = None
    has_depth = args.get("depth") is not None
    through = args.get("through")
    if through is None:
        through = not has_depth
    through = bool(through)
    if through and has_depth:
        raise KoiOpError(
            "through:true and depth:%s cannot both hold: ThroughAll drills the "
            "whole solid and the depth is ignored, which is how a 18 mm bolt "
            "hole became a 240 mm one. Pass through:false with the depth, or "
            "drop the depth." % (args.get("depth"),))
    if through:
        applied["DepthType"] = _set_if(h, "DepthType", "ThroughAll")
    else:
        if not has_depth:
            raise KoiOpError(
                "through:false needs a depth: how far to drill. Pass depth, "
                "or through:true for a hole that goes all the way.")
        applied["DepthType"] = _set_if(h, "DepthType", "Dimension")
        applied["Depth"] = _set_dim(h, "Depth", args, "depth")
        # Read back. Both halves of this have been dropped by a build before,
        # and a Dimension hole that stayed ThroughAll looks like success from
        # the write side.
        got_type = str(getattr(h, "DepthType", ""))
        if got_type != "Dimension":
            raise KoiOpError(
                "%s would not take DepthType=Dimension -- it reads %r, so the "
                "depth you asked for would be ignored and the hole would go "
                "all the way through" % (h.Name, got_type))
        # Where the bottom actually is. A drilled hole does not end flat: the
        # point angle carries it r/tan(angle/2) deeper than the number that
        # was asked for -- 1.65 mm on an M5.5, which is the difference between
        # a blind hole and one that breaks through a 5 mm wall. Depth alone
        # cannot say that, and quoting it as the depth of the hole is how a
        # wall gets sized against the wrong number.
        point = str(getattr(h, "DrillPoint", "") or "")
        if point.lower().startswith("angle"):
            angle = _plain(getattr(h, "DrillPointAngle", None)) or 118.0
            rad = (_plain(getattr(h, "Diameter", None)) or 0.0) / 2.0
            half = _math.radians(float(angle) / 2.0)
            tip = (rad / _math.tan(half)) if half > 1e-9 else 0.0
            to_tip = bool(getattr(h, "DrillForDepth", False))
            asked_depth = _plain(getattr(h, "Depth", None)) or 0.0
            drill = {"point": "angled", "angle": round(float(angle), 6),
                     "tipLength": round(tip, 6), "depthIsToTip": to_tip,
                     "bottomAt": round(asked_depth if to_tip
                                       else asked_depth + tip, 6)}
        elif point:
            drill = {"point": point.lower(), "tipLength": 0.0,
                     "depthIsToTip": True,
                     "bottomAt": _plain(getattr(h, "Depth", None))}

    cb = args.get("counterbore")
    if not cb and (args.get("cbore_d") is not None or args.get("cbore_depth") is not None or
                   args.get("counterbore_diameter") is not None or args.get("counterbore_depth") is not None):
        cb_d = args.get("cbore_d") if args.get("cbore_d") is not None else args.get("counterbore_diameter")
        cb_dp = args.get("cbore_depth") if args.get("cbore_depth") is not None else args.get("counterbore_depth")
        cb = {}
        if cb_d is not None:
            cb["diameter"] = cb_d
        if cb_dp is not None:
            cb["depth"] = cb_dp

    # counterbore: true, or counterbore: 'M5'. The table already holds cbore_d
    # and head_h for every size in it, and the caller was still typing 10 and 5
    # from memory next to a spec that said M5 two lines up -- or building an
    # extra sketch because the one spec the hole would not take as one spec was
    # the head. One size in, a head that sits flush out.
    cb_from = None
    if cb is True or isinstance(cb, str):
        want = cb if isinstance(cb, str) else None
        if want is None:
            sp = args.get("spec")
            if isinstance(sp, dict):
                want = sp.get("clearance") or sp.get("tap")
        if want is None:
            want = args.get("threadSize")
        if want is None:
            raise KoiOpError(
                "counterbore:true needs a size to look up. Pass "
                "spec:{clearance:'M5'} alongside it, or counterbore:'M5'")
        cb_d, cb_h = _cbore_from_table(str(want).split("X")[0])
        cb = {"diameter": cb_d, "depth": cb_h}
        cb_from = str(want)
    elif isinstance(cb, dict) and cb.get("fastener"):
        cb_from = str(cb["fastener"])
        cb_d, cb_h = _cbore_from_table(cb_from.split("X")[0])
        cb = {"diameter": cb.get("diameter", cb_d),
              "depth": cb.get("depth", cb_h)}

    if cb:
        applied["HoleCutType"] = _set_if(h, "HoleCutType", "Counterbore")
        cb_alias = None
        cb_val = None
        cb_expr = None
        if isinstance(cb, dict):
            if cb.get("from"):
                cb_alias, cb_val = _hole_source({"spec": cb}, doc)
            elif cb.get("diameter") is not None or cb.get("d") is not None:
                cb_val, cb_expr = _numx(cb, "diameter" if cb.get("diameter") is not None else "d")
            if cb.get("depth") is not None:
                applied["HoleCutDepth"] = _set_if(h, "HoleCutDepth", float(cb["depth"]))
        elif isinstance(cb, (int, float, str)):
            cb_val, cb_expr = _numx({"d": cb}, "d")
        if cb_val is not None:
            applied["HoleCutDiameter"] = _set_if(h, "HoleCutDiameter", float(cb_val))
            cb_bind = (PARAM_SHEET + "." + cb_alias) if cb_alias else cb_expr
            if cb_bind:
                applied["HoleCutDiameterExpression"] = _bind(
                    h, "HoleCutDiameter", cb_bind)

    # 8.4. Threaded is a specification; ModelThread would cut a helix, and
    # this is the one place a caller could ask for that by accident.
    thread_note = None
    thread_size = None
    if args.get("threaded"):
        size = args.get("threadSize") or (isinstance(args.get("spec"), dict)
                                          and args["spec"].get("tap"))
        if size:
            applied["ThreadType"] = _set_if(h, "ThreadType", "ISOMetricProfile")
            spelled, opts = _thread_size_enum(h, size)
            if spelled is None:
                raise KoiOpError(
                    "this build spells thread sizes %s, and %r is not one of "
                    "them. Writing it anyway is what turned an M5 tap into an "
                    "M4 at diameter 3.3 with nothing in the reply to show it, "
                    "so nothing was written."
                    % (", ".join(opts[:16]) or "(unreadable)", size))
            applied["ThreadSize"] = _set_if(h, "ThreadSize", spelled)
            got = str(getattr(h, "ThreadSize", ""))
            if not applied["ThreadSize"] or got != spelled:
                raise KoiOpError(
                    "%s would not take thread size %r -- it reads %r. A hole "
                    "left Threaded at the wrong size is drilled to the wrong "
                    "tap diameter and nothing downstream can tell"
                    % (h.Name, spelled, got or None))
            thread_size = spelled
        applied["Threaded"] = _set_if(h, "Threaded", True)
        # Read it back. A thread spec that did not take leaves a drilled hole
        # that everything downstream will treat as tapped, and the engagement
        # rule has nothing to fire on.
        if not bool(getattr(h, "Threaded", False)):
            thread_note = ("this build did not accept a thread specification "
                           "on the hole -- it is drilled, not tapped, and the "
                           "engagement check cannot apply to it")
        applied["ThreadedVerified"] = bool(getattr(h, "Threaded", False))
    _set_if(h, "ModelThread", False)
    _set_if(h, "ModelActualThread", False)

    told = "reversed" in args and args["reversed"] is not None and str(args["reversed"]).lower() != "auto"
    if told:
        applied["Reversed"] = _set_if(h, "Reversed", bool(args["reversed"]))
    hidden = _tidy_construction(doc, sk)
    doc.recompute()

    removed, flipped, at = _ensure_cuts(doc, h, told, sk)
    register(doc, kid, h, args.get("turn"))
    out = {"name": h.Name, "diameter": _plain(getattr(h, "Diameter", value)),
           "diameterFrom": source, "boundTo": bound_to,
           "depthType": str(getattr(h, "DepthType", "")),
           "depth": None if through else _plain(getattr(h, "Depth", None)),
           "through": through,
           "applied": applied, "removed": removed, "flipped": flipped,
           "removedAtProfile": at,
           "reversed": bool(getattr(h, "Reversed", False)), "hidden": hidden,
           "threaded": bool(args.get("threaded")), "modeledThread": False}
    if drill:
        out["drillPoint"] = drill
        if drill.get("tipLength"):
            out["depthNote"] = (
                "this hole is drilled, not bored: the point angle takes it to "
                "%.3f mm, %.3f past the %s it was asked for. Size a wall "
                "against bottomAt, not against depth."
                % (drill["bottomAt"], drill["tipLength"], out["depth"]))
    if thread_size:
        out["threadSize"] = thread_size
    if cb_from:
        out["counterboreFrom"] = cb_from
        out["counterbore"] = {"diameter": _plain(getattr(h, "HoleCutDiameter", None)),
                              "depth": _plain(getattr(h, "HoleCutDepth", None))}
    # Threading rewrites Diameter to the tap drill without saying so, which is
    # how an M5 that had become an M4 stayed invisible until somebody read
    # Diameter. Asked and got, side by side.
    asked = None if value is None else round(float(value), 6)
    if asked is not None and out["diameter"] is not None and \
            abs(float(out["diameter"]) - asked) > 1e-6:
        out["diameterAsked"] = asked
        out["diameterNote"] = (
            "the hole reads %s and %g was asked for: setting a thread "
            "specification moves Diameter to the tap drill for that size. "
            "Quote the readback, not the request"
            % (out["diameter"], asked))
    if source == "profile" and sizes and sizes > 1:
        out["profileNote"] = (
            "the profile sketch holds %d different circle sizes and every "
            "hole here is cut at the smallest. Pass diameter, or split the "
            "sketch, if that is not what you meant." % sizes)
    # What a clean hole in solid stock would have taken, next to what this one
    # took. The session that asked for this read 266 mm3 where pi r^2 L said
    # 665: four M5 taps whose path entered a bore that was already there, and
    # the wall ahead of that bore was 4.4 mm. Nothing in the reply said so --
    # ok:true, removed:266, and the arithmetic was done by hand two steps
    # later. It is one multiplication and one Solids count, so it is done here.
    circles = _profile_circles(sk)
    lumps = _cut_solids(h)
    bore = {"circles": circles, "cutSolids": lumps, "removed": removed}
    ideal = None
    if circles and not through:
        d = _plain(getattr(h, "Diameter", None))
        dp = _plain(getattr(h, "Depth", None))
        if d and dp:
            ideal = round(_math.pi * (float(d) / 2.0) ** 2
                          * float(dp) * circles, 6)
    if ideal:
        bore["idealVolume"] = ideal
        if removed is not None:
            bore["ratio"] = round(float(removed) / ideal, 4)
    out["boreCheck"] = bore
    crossings = (lumps is not None and circles and lumps > circles)
    short = (ideal and removed is not None and removed < ideal * 0.9
             and removed > 1e-6)
    if crossings or short:
        bits = []
        if crossings:
            bits.append(
                "the cut came out as %d separate lumps for %d circle(s), "
                "which is what a drill does when its path crosses a void "
                "that is already there and starts cutting again on the far "
                "side" % (lumps, circles))
        if short:
            bits.append(
                "it removed %.3f mm3 where a clean %s x %s in solid stock is "
                "%.3f (%.0f%%)"
                % (removed, out["diameter"], out["depth"], ideal,
                   100.0 * float(removed) / ideal))
        out["boreNote"] = (
            ". ".join(bits) + ". Measure the wall between this hole and "
            "whatever it ran into before reporting it as drilled -- a bolt "
            "that enters an existing bore is not a fastener, it is a leak "
            "path through the part.")
    note = _cut_note(removed, flipped, told, "hole", at)
    if note:
        out["note"] = note
    if thread_note:
        out["threadNote"] = thread_note
    return out


def _bolt_layout(rec, spec_bolts=None):
    """(pattern, count, angles) for a component's bolt interface."""
    b = spec_bolts if spec_bolts is not None else (rec or {}).get("bolts") or {}
    if not isinstance(b, dict) or not b:
        raise KoiOpError(
            "this component publishes no bolt pattern. insert one that does "
            "(a motor envelope), or place the holes yourself with a sketch of "
            "circles.")
    pattern = str(b.get("pattern") or "")
    if pattern == "square":
        return "square", 4, None
    if pattern == "circle":
        n = int(b.get("count") or 4)
        n = max(1, min(n, 32))
        return "circle", n, [360.0 * i / n for i in range(n)]
    raise KoiOpError("unsupported bolt pattern %r (square or circle)"
                     % (b.get("pattern"),))


def _op_bolt_sketch(doc, args, kid):
    """A sketch of circles on an inserted component's bolt pattern, with the
    POSITIONS bound by expression to its published pitch.

    Without this, half the swap story was a literal. 'hole' already binds its
    diameter to bolt.mount.clearance, so an M5 to M6 swap moved the diameter
    -- but the model had to read boltPositions out of the insert reply and
    write those coordinates into a sketch by hand, so swapping a NEMA 17 for a
    NEMA 23 moved the motor's own bolt circle from 31 to 47 and left the
    plate's four holes exactly where they were. A design that looks
    parametric and is not is worse than one that never claimed to be.

    So the DistanceX/DistanceY constraints that locate each circle are bound
    to koi_params.<pid>_bolts_pitch, and FreeCAD's recompute does the rest --
    the same mechanism, and the same argument, as the diameter binding.
    """
    body = _resolve_body(doc, args.get("body"), args)
    pid = str(_need(args, "component"))
    rec = component(pid, doc)
    if rec is None:
        raise KoiOpError("%r is not an inserted component" % pid)

    alias = _alias(pid, "bolts_pitch")
    pitch = param_get(alias, doc)
    if pitch is None:
        raise KoiOpError(
            "%s publishes no bolt pitch under %s; re-insert it, or place the "
            "holes with a plain sketch" % (pid, alias))
    pitch = float(_plain(pitch))
    pattern, count, angles = _bolt_layout(rec)

    d = args.get("d")
    if d is None and args.get("clearance"):
        f = fastener(str(args["clearance"]))
        d = f["clearance"][str(args.get("fit") or "normal")]
    if d is None:
        # The pattern knows its own thread; a clearance hole for it is the
        # only sane default and the table is the only place to get it from.
        thread = ((rec.get("bolts") or {}).get("thread"))
        if thread:
            d = fastener(str(thread))["clearance"][
                str(args.get("fit") or "normal")]
    if d is None:
        raise KoiOpError("pass d, or clearance:'M5', or insert a component "
                         "whose bolt pattern names its thread")
    r = float(d) / 2.0

    at = args.get("at") or [0, 0]
    if not (isinstance(at, list) and len(at) >= 2):
        raise KoiOpError("at must be [x, y] -- where the pattern is centred")
    cx, cy = float(at[0]), float(at[1])

    import Part
    import Sketcher
    from FreeCAD import Vector as V

    sk = doc.addObject("Sketcher::SketchObject", _safe_name(kid, "BoltSketch"))
    body.addObject(sk)
    on = args.get("on", "XY")
    if str(on).upper() in ("XY", "XZ", "YZ"):
        _attach(sk, _origin_plane(body, on))
        attached_to = str(on).upper()
    else:
        owner, sub = _resolve_ref_sub(doc, on)
        if owner is None:
            raise KoiOpError(
                "on %r is neither an origin plane nor anything that resolves"
                % (on,))
        offset = None if args.get("offset") is None else _num(args, "offset")
        attached_to = owner.Name + ((":" + sub) if sub else "")
        read = _attach_map(doc, sk, owner, sub, args.get("mode"), offset)
        if not read.get("moved"):
            raise KoiOpError(
                "the bolt sketch attached to %s but stayed at the origin, so "
                "the holes would be cut in the wrong place" % attached_to)

    C = Sketcher.Constraint
    half = "%s.%s / 2" % (PARAM_SHEET, alias)
    positions, bound, unbound = [], [], []
    for i in range(count):
        if pattern == "square":
            sx = 1.0 if i in (1, 2) else -1.0
            sy = 1.0 if i in (2, 3) else -1.0
            x, y = cx + sx * pitch / 2.0, cy + sy * pitch / 2.0
            ex = ("%s%s" % ("" if sx > 0 else "-", half))
            ey = ("%s%s" % ("" if sy > 0 else "-", half))
        else:
            a = angles[i]
            x = cx + (pitch / 2.0) * _math.cos(_math.radians(a))
            y = cy + (pitch / 2.0) * _math.sin(_math.radians(a))
            ex = "%s * cos(%gdeg)" % (half, a)
            ey = "%s * sin(%gdeg)" % (half, a)
        if abs(cx) > 1e-9:
            ex = "%s + %g" % (ex, cx)
        if abs(cy) > 1e-9:
            ey = "%s + %g" % (ey, cy)

        g = sk.addGeometry(Part.Circle(V(x, y, 0), V(0, 0, 1), r), False)
        sk.addConstraint(C("Radius", g, r))
        ix = sk.addConstraint(C("DistanceX", -1, 1, g, 3, x))
        iy = sk.addConstraint(C("DistanceY", -1, 1, g, 3, y))
        nx, ny = "bx%d" % i, "by%d" % i
        try:
            sk.renameConstraint(ix, nx)
            sk.renameConstraint(iy, ny)
            sk.setExpression(".Constraints.%s" % nx, ex)
            sk.setExpression(".Constraints.%s" % ny, ey)
            bound.extend([nx, ny])
        except Exception as e:
            unbound.append({"index": i, "error": "%s: %s"
                            % (type(e).__name__, e)})
        positions.append([round(x, 6), round(y, 6)])

    sk.Visibility = False
    doc.recompute()
    register(doc, kid, sk, args.get("turn"))

    # Read the binding back. A position that silently stayed a literal is the
    # exact failure this op exists to remove, and it is invisible until the
    # swap that was supposed to move it does not.
    ee = ""
    try:
        ee = str(sk.ExpressionEngine)
    except Exception:
        ee = ""
    verified = alias in ee
    out = {"name": sk.Name, "on": attached_to, "component": pid,
           "pattern": pattern, "count": count, "pitch": pitch,
           "diameter": round(float(d), 6), "positions": positions,
           "boundTo": PARAM_SHEET + "." + alias, "constraints": bound,
           "bindingVerified": verified}
    out.update(_sk_dof(sk))
    if unbound:
        out["unbound"] = unbound
    if not verified:
        out["note"] = (
            "the positions did NOT bind to %s -- they are literals, so "
            "swapping %s will move its diameter and leave these holes where "
            "they are. Say so rather than reporting a parametric pattern."
            % (alias, pid))
    else:
        out["note"] = (
            "positions are bound to %s.%s: swapping %s moves these holes on "
            "the next recompute. Cut them with fn 'hole' on this sketch."
            % (PARAM_SHEET, alias, pid))
    return out


def _param_value(v):
    """A number, or a quantity with units: '45 mm', '1.5 in', '12 deg'.

    CAD is thought about in units and the schema only took a bare number, so
    every value arrived stripped by hand -- which is a conversion done in the
    caller's head, in a skill whose whole argument is that conversions done in
    somebody's head are where the 0.2 mm comes from. Quantity does it here,
    and the document's own units (mm, deg) come back out.
    """
    if isinstance(v, bool):
        raise KoiOpError("value must be a number or a quantity, not a boolean")
    if isinstance(v, (int, float)):
        return float(v), None
    s = str(v).strip()
    if not s:
        raise KoiOpError("value is empty")
    try:
        q = App.Units.Quantity(s)
        value = float(q.Value)
    except Exception:
        raise KoiOpError(
            "%r is not a number or a quantity this build can parse. Units are "
            "welcome -- '45 mm', '1.5 in', '12 deg' -- and are converted to "
            "the document's own." % (s,))
    return value, s


def _op_param(doc, args, kid):
    name = str(_need(args, "alias"))
    out = {"alias": _alias(name)}
    if "value" in args:
        value, given = _param_value(args["value"])
        param_set(name, value, doc, args.get("label"))
        if given is not None:
            out["given"] = given
        out["set"] = _plain(value)
        # A spreadsheet cell is a COMPUTED property: until the sheet
        # recomputes, reading it back gives None, which this op then reported
        # as the string "None" and made every successful set look like a
        # failure. Recompute, then read.
        sh = params_sheet(doc, create=False)
        for _try in range(2):
            if sh is None:
                break
            try:
                sh.touch()
            except Exception:
                pass
            doc.recompute()
            if param_get(name, doc) is not None:
                break
            try:
                sh.recompute()
            except Exception:
                pass
    got = param_get(name, doc)
    out["value"] = None if got is None else _plain(got)
    if "value" in args and out["value"] is None:
        out["note"] = (
            "the cell was written but the sheet still reads nothing back "
            "after a recompute. Anything binding to %s will not evaluate "
            "yet -- check the sheet before building on it." % out["alias"])
    return out


def _op_library(doc, args, kid):
    what = str(args.get("what") or "all")
    out = {}
    if what in ("all", "fasteners"):
        out["fasteners"] = FASTENERS
    if what in ("all", "catalog"):
        out["catalog"] = dict(
            (k, {"kind": v.get("kind"), "meta": v.get("meta"),
                 "interfaces": v.get("interfaces")})
            for k, v in CATALOG.items())
    if what in ("all", "stock"):
        out["stockPlate"] = list(STOCK_PLATE)
        out["drillSizes"] = drill_sizes()
    if what in ("all", "params"):
        # The only section of this op that is about a document rather than
        # about the tables. Empty and SAID to be empty, so a caller reading
        # params:{} does not conclude the sheet is empty when there is no
        # sheet to be empty.
        if doc is None:
            out["params"] = {}
            out["components"] = {}
            out["documentNote"] = (
                "no document is open, so params and components are empty "
                "rather than absent. The fastener, catalog and stock tables "
                "above are compiled in and are complete")
        else:
            out["params"] = params(doc)
            out["components"] = dict(
                (r["id"], component(r["id"], doc))
                for r in ids(doc)["ids"] if component(r["id"], doc))
    return out


# ---------- the turn boundary (5.2, 5.4) ----------
#
# Between our turns the human has been working. A reply written against the
# document as we left it overwrites their work, so the turn opens by asking
# what THEY changed. The baseline lives in the module rather than in the MCP
# because it has to survive the MCP server restarting without outliving the
# FreeCAD process: a stale baseline from a previous document would report the
# whole model as a user edit. That split is why it lives here and not in JS.

_BASELINE = {"proj": None, "rev": 0, "doc": None}


def observe(doc=None):
    """Take the current state as the new baseline. Called after we look and
    after we edit, so our own work never comes back as a user change."""
    doc = doc or App.ActiveDocument
    if doc is None:
        return _BASELINE["rev"]
    _BASELINE["proj"] = project(doc)
    _BASELINE["doc"] = doc.Name
    _BASELINE["rev"] += 1
    return _BASELINE["rev"]


def _dof_map(proj):
    out = {}
    for o in (proj or {}).get("objects", []):
        if o.get("fullyConstrained") is not None:
            out[o["name"]] = bool(o["fullyConstrained"])
    return out


def user_diff(doc=None):
    doc = doc or App.ActiveDocument
    if doc is None:
        return {"baseline": False, "summary": "no document is open"}
    cur = project(doc)
    base = _BASELINE.get("proj")
    if base is None or _BASELINE.get("doc") != doc.Name:
        return {"baseline": False, "added": [], "removed": [], "changed": [],
                "revertedAiObjects": [], "dofChanges": [],
                "summary": "first look at this document in this session, so "
                           "there is nothing to compare against yet"}
    d = _diff(base, cur)
    # An object we made that is no longer here was deleted by the user. That
    # is a rejection (5.2) and it is never silently re-created.
    origins = _meta(doc)
    reverted = []
    for name in d.get("removed", []):
        if origins.get(ORIGIN_PREFIX + name):
            kid = None
            for k, v in origins.items():
                if k.startswith(ID_PREFIX) and v == name:
                    kid = k[len(ID_PREFIX):]
                    break
            reverted.append(kid or name)
    b_dof, c_dof = _dof_map(base), _dof_map(cur)
    dof_changes = [{"object": k, "was": b_dof[k], "now": c_dof[k]}
                   for k in sorted(c_dof) if k in b_dof and b_dof[k] != c_dof[k]]
    parts = []
    if d.get("added"):
        parts.append("added " + ", ".join(d["added"][:6]))
    if d.get("removed"):
        parts.append("removed " + ", ".join(d["removed"][:6]))
    if d.get("changed"):
        parts.append("changed " + ", ".join(
            c.get("name", "?") for c in d["changed"][:6]))
    if reverted:
        parts.append("REVERTED work of ours: " + ", ".join(reverted))
    return {"baseline": True, "added": d.get("added", []),
            "removed": d.get("removed", []), "changed": d.get("changed", []),
            "revertedAiObjects": reverted, "dofChanges": dof_changes,
            "rev": _BASELINE["rev"],
            "summary": "; ".join(parts) or "nothing changed since the last turn"}


def health(doc=None):
    doc = doc or App.ActiveDocument
    if doc is None:
        return {"errors": [], "touched": [], "underconstrained": []}
    errors, touched, loose = [], [], []
    for o in doc.Objects[:500]:
        try:
            if not o.isValid():
                errors.append(o.Name)
                continue
            if "touched" in [s.lower() for s in o.State]:
                touched.append(o.Name)
            if "Sketcher::SketchObject" in o.TypeId and \
                    not bool(getattr(o, "FullyConstrained", False)):
                loose.append(o.Name)
        except Exception:
            continue
    return {"errors": errors, "touched": touched, "underconstrained": loose}


def selection(doc=None):
    """The user's pointing device, with a fingerprint so 'this one' resolves."""
    out = []
    for pick in selection_refs()[:8]:
        row = dict(pick)
        try:
            row["fingerprint"] = fingerprint(pick["owner"], pick["sub"],
                                             doc, "selection")
        except Exception as e:
            row["error"] = "%s: %s" % (type(e).__name__, e)
        out.append(row)
    return out


# ---------- the change report (5.4) ----------
#
# The turn boundary is a design review and the dry-run diff is the review
# packet. An engineer will not accept a parametric change from an AI without
# seeing the blast radius, and "3 objects changed" is not a blast radius --
# which feature moved, by how much, and what broke is.

def _counts_as_part(row):
    t = row.get("type") or ""
    return not (t.startswith("PartDesign::") and "Body" not in t)


def change_report(before, after, new_errors=None, refs_broken=None):
    d = _diff(before, after)
    bmap = dict((o["name"], o) for o in (before or {}).get("objects", []))
    amap = dict((o["name"], o) for o in (after or {}).get("objects", []))

    def vol(o):
        return ((o or {}).get("shape") or {}).get("volume")

    deltas = []
    for name in sorted(amap):
        av, bv = vol(amap[name]), vol(bmap.get(name))
        if av is None or bv is None:
            continue
        if abs(av - bv) > 1e-6:
            deltas.append({"object": name, "from": round(bv, 6),
                           "to": round(av, 6), "delta": round(av - bv, 6)})
    # A PartDesign Body and its tip Pad report the same solid. Summing every
    # object counts the model twice and turns the total into a number that
    # looks precise and means nothing.
    def total(m):
        return sum(v for v in (vol(o) for o in m.values()
                               if _counts_as_part(o)) if v)

    total_before, total_after = total(bmap), total(amap)

    bits = []
    if d.get("added"):
        bits.append("%d added" % len(d["added"]))
    if d.get("removed"):
        bits.append("%d removed" % len(d["removed"]))
    if d.get("changed"):
        bits.append("%d changed" % len(d["changed"]))
    if deltas:
        bits.append("volume moved on %s" % ", ".join(x["object"] for x in deltas[:4]))
    if new_errors:
        bits.append("BROKE: " + ", ".join(new_errors[:6]))
    if refs_broken:
        bits.append("broke references: " + ", ".join(refs_broken[:6]))
    return {
        "added": d.get("added", []),
        "removed": d.get("removed", []),
        "changed": d.get("changed", []),
        "volumeDeltas": deltas,
        "totalVolume": {"from": round(total_before, 6),
                        "to": round(total_after, 6),
                        "delta": round(total_after - total_before, 6)},
        "broke": list(new_errors or []),
        "refsBroken": list(refs_broken or []),
        "summary": "; ".join(bits) or "no measurable change",
    }


# ---------- view (6.3) ----------
#
# isolate is the highest-value screenshot helper: internal features are
# invisible until their surroundings are hidden. It is also the one view
# operation that changes what the user sees and cannot be undone by Ctrl+Z,
# so it records what it hid and can put it back.

ISOLATE_KEY = "koi.isolate"


def _isolate_keep(doc, o, keep):
    """Everything that has to stay visible for this object to be on screen.

    Two exclusions and one inclusion, all measured. OutListRecursive on a Body
    walks into its Origin, so an isolate meant to frame one part kept three
    INFINITE planes -- and the fit that followed reported a span of 3.46e100
    and framed nothing. And a split half's solid lives in a
    PartDesign::FeatureBase, which reads like scaffolding and is not: hide it
    and the Body still reports Visibility True over an empty viewport.

    So: solid and instances, including FeatureBase, excluding Origin.
    """
    keep.add(o.Name)
    try:
        kids = list(o.OutListRecursive or [])[:400]
    except Exception:
        kids = []
    for c in kids:
        if str(getattr(c, "TypeId", "")) in DATUM_TYPES:
            continue
        keep.add(c.Name)
    tip = getattr(o, "Tip", None)
    if tip is not None:
        keep.add(tip.Name)
    base = getattr(o, "BaseFeature", None)
    if base is not None:
        keep.add(base.Name)
    return keep


def _op_isolate(doc, args, kid):
    refs = args.get("targets")
    if isinstance(refs, str):
        refs = [refs]
    if not isinstance(refs, list) or not refs:
        raise KoiOpError("targets must be a non-empty list of objects to keep")
    targets = [_resolve_or_die(doc, r, "object") for r in refs[:32]]
    keep = set()
    for o in targets:
        _isolate_keep(doc, o, keep)

    was = {}
    hidden = []
    for o in doc.Objects[:500]:
        try:
            if o.Name in keep:
                continue
            if not _visible(o):
                continue
            was[o.Name] = True
            o.Visibility = False
            hidden.append(o.Name)
        except Exception:
            continue

    # Then make what was kept actually visible. isolate promises the user can
    # see these, and the promise was being kept for the container while the
    # shape stayed dark. Recorded as False so view_restore puts each one back
    # to the hidden it was, rather than leaving the document brighter than it
    # found it.
    revealed = []
    for o in targets:
        for name in _drawn(doc, o)["hiddenBy"]:
            h = doc.getObject(name)
            if h is None:
                continue
            try:
                h.Visibility = True
            except Exception:
                continue
            was.setdefault(name, False)
            revealed.append(name)
    doc.recompute()
    if was:
        _meta_set(doc, ISOLATE_KEY, _json.dumps(was))

    rows = [_target_report(doc, o) for o in targets]
    out = {"kept": sorted(keep), "hidden": hidden, "targets": rows,
           "restoreWith": "view_restore"}
    out.update(_span_detail(doc))
    if revealed:
        out["revealed"] = revealed
    dark = [r["name"] for r in rows if not r.get("drawn")]
    if dark:
        out["notDrawn"] = dark
        out["note"] = (
            "%s could not be made visible (see hiddenBy). Do NOT tell the "
            "user it is on screen" % ", ".join(dark))
    return out


def _op_show(doc, args, kid):
    """Show or hide a named set of objects.

    The bulk primitive the presentation story was missing. isolate hides
    everything ELSE, which is exactly right for a screenshot of one pocket
    inside a housing and exactly wrong for "show the faceplate and the bolts,
    hide the jig" -- and the fallback for that was a Python loop writing
    Visibility, which is a loop over the one property the user is watching.

    Reports what actually changed rather than what was asked for: setting
    Visibility on something already visible is a no-op, and a caller who reads
    it as success will believe the model is on screen when it is not.
    """
    refs = args.get("targets")
    if isinstance(refs, str):
        refs = [refs]
    if not isinstance(refs, list) or not refs:
        raise KoiOpError(
            "targets must be a non-empty list of objects. To hide everything "
            "except a few, use isolate")
    if len(refs) > 64:
        raise KoiOpError("show is capped at 64 objects per call")
    want = args.get("visible")
    want = True if want is None else bool(want)
    changed, already, failed = [], [], []
    for r in refs:
        o = _resolve_or_die(doc, r, "object")
        if "Visibility" not in o.PropertiesList:
            failed.append({"name": o.Name,
                           "why": "this object has no Visibility property"})
            continue
        if _visible(o) == want:
            already.append(o.Name)
            continue
        try:
            o.Visibility = want
        except Exception as e:
            failed.append({"name": o.Name,
                           "why": "%s: %s" % (type(e).__name__, e)})
            continue
        if _visible(o) != want:
            # Written and not taken. A body inside a hidden Part is the usual
            # cause, and it looks identical to success from the write side.
            failed.append({"name": o.Name,
                           "why": "the document still reads visibility %s "
                                  "afterwards" % _visible(o)})
            continue
        changed.append(o.Name)
    doc.recompute()
    # Per target, and about the SHAPE. An 'already: true' was the reply that let
    # a session claim a full assembly was framed while the screen held six
    # bolts: it was the truth about the container and said nothing about
    # whether a solid was drawn.
    rows = [_target_report(doc, _resolve_or_die(doc, r, "object"))
            for r in refs]
    out = {"visible": want, "changed": changed, "already": already,
           "targets": rows}
    out.update(_span_detail(doc))
    if failed:
        out["failed"] = failed
        out["note"] = (
            "%d object(s) did not take the change -- say so rather than "
            "reporting that the user can see them" % len(failed))
    if want:
        dark = [r["name"] for r in rows if not r.get("drawn")]
        if dark:
            out["notDrawn"] = dark
            out["note"] = (
                "%s reads visible but nothing of it is drawn -- something "
                "above it in hiddenBy is off. Show that instead, and do not "
                "report these as on screen" % ", ".join(dark))
    return out


# ---------- looking inside ----------
#
# Everything in this file that verifies internal geometry does it with a
# number, which is right and is not sufficient: at some point the human has
# to SEE that the pocket clears the boss. Until now that meant isolate, hide
# the housing, take a picture, restore -- four calls, a changed document and
# a view of the pocket from outside a part that is no longer there.
#
# A clip plane is the tool for this and it belongs to the VIEW, not the
# model. Nothing is cut, no geometry changes, no recompute happens, and the
# document is byte-identical afterwards. What the human sees is the inside.
#
# The one thing to be honest about: this is a clip, not a capped section.
# The cut face is open, so you are looking into a hollow shell rather than at
# a solid cross-section with a hatched face. It answers "does that pocket
# break through" perfectly and "how thick is that wall" not at all -- that is
# measure_between's job.

_SECTIONS = {}


def _active_3d_view():
    if Gui is None:
        return None
    try:
        gdoc = Gui.activeDocument()
        view = gdoc.activeView() if gdoc is not None else None
        return view if _is_3d_view(view) else None
    except Exception:
        return None


def _section_clear(doc):
    key = doc.Name if doc is not None else "*"
    node = _SECTIONS.pop(key, None)
    if node is None:
        return False
    view = _active_3d_view()
    if view is None:
        return False
    try:
        sg = view.getSceneGraph()
        sg.removeChild(node)
        if hasattr(view, "redraw"):
            view.redraw()
        elif hasattr(view, "repaint"):
            view.repaint()
        if hasattr(Gui, "updateGui"):
            Gui.updateGui()
        return True
    except Exception:
        return False


def _op_view_section(doc, args, kid):
    """Clip the 3D view on a plane so the human can see inside.

    off:true removes it, and so does view_restore -- leaving a session's clip
    plane on the human's view after the question it answered has been settled
    is the same class of mistake as leaving their model isolated.
    """
    if Gui is None:
        raise KoiOpError(
            "this FreeCAD is headless, so there is no view to clip. "
            "freecad_render still works and shows the outside; for what is "
            "inside, use freecad_measure and fn 'measure_between'.")
    view = _active_3d_view()
    if view is None:
        raise KoiOpError("no 3D view is active in this document")

    if args.get("off") or args.get("enabled") is False:
        removed = _section_clear(doc)
        _gui_sync(doc)
        return {"enabled": False, "removed": removed,
                "note": ("the view is unclipped" if removed
                         else "there was no section cut to remove")}

    try:
        from pivy import coin
    except Exception as e:
        raise KoiOpError(
            "this build has no pivy/coin binding available to this "
            "interpreter (%s), so the view cannot be clipped from here. Ask "
            "the human to use View > Persistent section cut instead."
            % type(e).__name__)

    plane = str(args.get("plane") or "XZ").upper()
    normals = {"XY": (0.0, 0.0, 1.0), "XZ": (0.0, 1.0, 0.0),
               "YZ": (1.0, 0.0, 0.0)}
    if args.get("normal") is not None:
        n = args["normal"]
        if not (isinstance(n, list) and len(n) == 3):
            raise KoiOpError("normal must be [x, y, z]")
        nx, ny, nz = float(n[0]), float(n[1]), float(n[2])
        plane = "custom"
    elif plane in normals:
        nx, ny, nz = normals[plane]
    else:
        raise KoiOpError(
            "plane must be XY, XZ or YZ, or pass normal:[x, y, z]")
    if args.get("flip"):
        nx, ny, nz = -nx, -ny, -nz
    offset = float(args.get("offset") or 0.0)

    _section_clear(doc)
    clip = coin.SoClipPlane()
    clip.plane.setValue(coin.SbPlane(coin.SbVec3f(nx, ny, nz), offset))
    clip.on = True
    try:
        sg = view.getSceneGraph()
        sg.insertChild(clip, 0)
    except Exception as e:
        raise KoiOpError(
            "the clip plane could not be inserted into the scene graph: "
            "%s: %s" % (type(e).__name__, e))
    _SECTIONS[doc.Name if doc is not None else "*"] = clip
    _gui_sync(doc)

    return {"enabled": True, "plane": plane,
            "normal": [nx, ny, nz], "offset": offset,
            "note": (
                "this clips the VIEW, not the model: no geometry changed, "
                "nothing recomputed, and the cut face is OPEN rather than "
                "capped -- you are looking into a hollow shell. Which half "
                "disappears is a viewer convention, so pass flip:true if it "
                "took the half you wanted to see. Turn it off with "
                "off:true before handing the view back."),
            "measureNote": (
                "a clipped view shows that a wall exists. It does not show "
                "that the wall is 2.4 mm -- that is fn 'measure_between'.")}


def _op_view_restore(doc, args, kid):
    # A section cut is part of "put their view back", and forgetting it here
    # is how a human ends up with half a model on screen and a session that
    # has already moved on to talking about something else.
    unclipped = _section_clear(doc)
    raw = _meta(doc).get(ISOLATE_KEY)
    if not raw:
        return {"restored": [], "sectionRemoved": unclipped,
                "note": ("the section cut was removed; nothing was isolated"
                         if unclipped else "nothing was isolated")}
    try:
        was = _json.loads(raw)
    except Exception:
        return {"restored": [], "error": "the stored visibility record is unreadable"}
    # An origin plane is scaffolding, never presentation. isolate hid 18 of
    # them along with everything else, and restoring them "correctly" put 18
    # translucent infinite planes back over the two parts the session had
    # spent an hour on. Restore is still honest -- it says what it left off,
    # and includeOrigins:true puts them back for a caller who wants the
    # document byte-identical to how they found it.
    # The same argument, and the same measurement, for the solid a split_body
    # cut halves out of. isolate correctly dropped it; restore correctly put
    # it back; the result was the unsplit source sitting exactly on top of the
    # assembly it had been cut into, which reads on screen as one solid part
    # and in a pair check as everything interfering with itself.
    with_origins = bool(args.get("includeOrigins"))
    with_sources = bool(args.get("includeSources"))
    try:
        sources = set() if with_sources else _split_sources(doc)
    except Exception:
        sources = set()
    back = []
    rehidden = []
    origins = []
    left_sources = []
    for name in sorted(was):
        o = doc.getObject(name)
        if o is None:
            continue
        if (not with_origins and was.get(name)
                and str(getattr(o, "TypeId", "")) in ORIGIN_TYPES):
            origins.append(name)
            continue
        if not with_sources and was.get(name) and name in sources:
            left_sources.append(name)
            continue
        # The record holds what each object WAS, not a flag that it was
        # hidden: isolate may have turned something on to keep its promise
        # that the target is visible, and restore has to put that back too.
        want = bool(was[name]) if isinstance(was, dict) else True
        try:
            o.Visibility = want
        except Exception:
            continue
        (back if want else rehidden).append(name)
    _meta_set(doc, ISOLATE_KEY, "")
    doc.recompute()
    out = {"restored": back}
    if rehidden:
        out["rehidden"] = rehidden
    if origins:
        out["originsLeftHidden"] = origins
        out["note"] = (
            "%d origin plane/axis object(s) were visible before isolate and "
            "have been LEFT hidden: putting them back is what turns a framed "
            "part into a stack of translucent infinite planes. The document "
            "is otherwise as it was; pass includeOrigins:true to restore "
            "those too." % len(origins))
    if left_sources:
        out["splitSourcesLeftHidden"] = left_sources
        out["note"] = ((out.get("note", "") + " ") if out.get("note") else "") + (
            "%s is the solid a split_body cut halves out of and has been LEFT "
            "hidden: restoring it puts the whole unsplit part back on top of "
            "the two halves, which looks like one part on screen and reads as "
            "self-interference in a pair check. Pass includeSources:true if "
            "the document has to go back exactly as it was found."
            % ", ".join(left_sources))
    out.update(_span_detail(doc))
    return out


# ---------- export (10) ----------
#
# A handover and a checkpoint. The user's own File > Save is real here, so
# and this is the user's only way to get their work out of a sandbox whose
# filesystem is volatile.

# MEMFS had /tmp and nothing else. A real host has a temp dir that is not
# always /tmp (and is not /tmp at all on Windows), and a user who wants exports
# somewhere they can find them sets KOI_EXPORT_DIR before starting FreeCAD.
def _export_dir():
    import os, tempfile
    d = os.environ.get("KOI_EXPORT_DIR")
    return d if d else os.path.join(tempfile.gettempdir(), "koi_export")


EXPORT_DIR = _export_dir()
EXPORT_FORMATS = ("FCSTD", "STEP", "BREP", "STL")


def confined_path(path, allowed_ext):
    """Resolve a caller-supplied write path inside EXPORT_DIR, or refuse it.

    Everything else in this runtime builds its own filenames; a path that
    arrives from the caller is a write primitive, and this process has the
    human's config directory mounted. The InitGui.py under the config mount
    is executed on every FreeCAD start, so one unconfined savePath is the
    difference between a screenshot tool and a persistence mechanism — and the
    caller here can be a document's own text, by way of an injection.

    realpath first, so a symlink planted inside the export directory cannot
    point out of it, and the extension is pinned to the format actually being
    written, so the primitive cannot produce a .py or a .FCMacro whatever the
    rest of the name says.
    """
    import os
    root = os.path.realpath(EXPORT_DIR)
    raw = str(path or "").strip()
    if not raw:
        raise KoiOpError("path is empty")
    cand = raw if os.path.isabs(raw) else os.path.join(root, raw)
    try:
        os.makedirs(root, exist_ok=True)
    except Exception:
        pass
    real = os.path.realpath(cand)
    if real != root and not real.startswith(root + os.sep):
        raise KoiOpError(
            "path must stay inside the export directory (%s): %r resolves to "
            "%r. Pass a bare filename, or a path under that directory."
            % (root, raw, real))
    ext = os.path.splitext(real)[1].lower()
    allowed = tuple(e.lower() for e in allowed_ext)
    if ext not in allowed:
        raise KoiOpError(
            "path must end in %s, not %r" % (" or ".join(allowed), ext))
    parent = os.path.dirname(real)
    if not os.path.isdir(parent):
        try:
            os.makedirs(parent, exist_ok=True)
        except Exception as e:
            raise KoiOpError("cannot create %s: %s" % (parent, e))
    return real


# ---------- paths that arrive from the caller: the READ side ----------
#
# confined_path above is the WRITE policy and is unchanged. This is the read
# policy, and it is deliberately wider and still not "anywhere on the disk".
#
# A read is not a write, but open_document reads a whole document tree back
# into the conversation and import_geometry pulls a file into the model, so an
# unconfined read path is an exfiltration primitive -- and the thing that can
# ask for it includes a document's own text, by way of an injection. So a path
# has to sit under a root somebody already chose: the export directory,
# whatever KOI_OPEN_DIRS names, and the directory of a document the human
# already has open (they opened it, so it is already theirs and already on
# their screen).
#
# The FreeCAD config and macro directories are refused from BOTH sides. Files
# under them execute at every start, which is the whole reason confined_path
# exists; reading them back is the other half of the same problem.

OPEN_FORMATS = {
    ".fcstd": "FCStd", ".step": "STEP", ".stp": "STEP",
    ".iges": "IGES", ".igs": "IGES", ".brep": "BREP", ".brp": "BREP",
}
IMPORT_FORMATS = ("STEP", "IGES", "BREP")
IMPORT_EXTS = tuple(e for e, f in sorted(OPEN_FORMATS.items())
                    if f in IMPORT_FORMATS)


def _real(p):
    import os
    try:
        return os.path.realpath(p)
    except Exception:
        return None


def _banned_roots():
    """Directories no caller-supplied path may touch, in either direction."""
    out = []
    for fn in ("getUserAppDataDir", "getUserMacroDir", "getUserConfigDir"):
        try:
            d = getattr(App, fn)()
        except Exception:
            continue
        r = _real(d) if d else None
        if r and r not in out:
            out.append(r)
    return out


def _open_roots():
    import os
    roots = []

    def add(d):
        if not d:
            return
        r = _real(d)
        if r and os.path.isdir(r) and r not in roots:
            roots.append(r)

    add(EXPORT_DIR)
    for part in str(os.environ.get("KOI_OPEN_DIRS") or "").split(os.pathsep):
        add(part.strip())
    # Every document the human already has open. This is the root that makes
    # the common case work without configuration: "open the other half of this
    # assembly" is a sibling of a file they opened themselves.
    for name in App.listDocuments():
        try:
            fn = App.getDocument(name).FileName
        except Exception:
            continue
        if fn:
            add(os.path.dirname(fn))
    return roots


def _resolve_in_roots(path, allowed_ext, must_exist=True, what="path"):
    """Resolve a caller-supplied path under an allowed root, or refuse it."""
    import os
    raw = str(path or "").strip()
    if not raw:
        raise KoiOpError("%s is empty" % what)
    roots = _open_roots()
    base = roots[0] if roots else EXPORT_DIR
    real = _real(raw if os.path.isabs(raw) else os.path.join(base, raw))
    if real is None:
        raise KoiOpError("%s %r cannot be resolved" % (what, raw))

    for bad in _banned_roots():
        if real == bad or real.startswith(bad + os.sep):
            raise KoiOpError(
                "%r is inside FreeCAD's own configuration directory (%s). "
                "That directory is refused for reading and for writing: "
                "files under it are executed at every FreeCAD start."
                % (raw, bad))

    inside = any(real == r or real.startswith(r + os.sep) for r in roots)
    if not inside:
        raise KoiOpError(
            "%r resolves to %r, which is not under any directory this session "
            "may read. Allowed right now: %s. To add one, start the bridge "
            "with KOI_OPEN_DIRS set (colon-separated), or have the human open "
            "one file from that directory in FreeCAD first -- its folder then "
            "counts as theirs."
            % (raw, real, ", ".join(roots) or "(none)"))

    ext = os.path.splitext(real)[1].lower()
    allowed = tuple(e.lower() for e in allowed_ext)
    if ext not in allowed:
        raise KoiOpError(
            "%s must end in %s, not %r" % (what, " or ".join(allowed), ext))
    if must_exist:
        if not os.path.isfile(real):
            raise KoiOpError("no file at %s" % real)
    else:
        parent = os.path.dirname(real)
        if not os.path.isdir(parent):
            raise KoiOpError("%s does not exist" % parent)
    return real


def export_doc(fmt="FCStd", targets=None, doc=None):
    import os
    doc = doc or App.ActiveDocument
    if doc is None:
        raise KoiOpError("no document to export")
    fmt = str(fmt).upper().replace(".", "")
    if fmt not in EXPORT_FORMATS:
        raise KoiOpError("format must be one of %s" % ", ".join(EXPORT_FORMATS))
    try:
        os.makedirs(EXPORT_DIR, exist_ok=True)
    except Exception:
        pass
    ext = {"FCSTD": "FCStd", "STEP": "step", "BREP": "brep", "STL": "stl"}[fmt]
    name = "%s.%s" % (_safe_name(doc.Name, "document"), ext)
    path = EXPORT_DIR + "/" + name
    bound_before = str(getattr(doc, "FileName", "") or "")

    if fmt == "FCSTD":
        # saveCopy, NOT saveAs.
        #
        # saveAs REBINDS doc.FileName to the path it wrote. This function is
        # documented as a checkpoint that leaves the human's work alone, and
        # under saveAs it silently moved where their File > Save goes: open
        # ~/projects/bracket.FCStd, take one FCStd checkpoint, and every save
        # they make afterwards lands in the export directory instead of their
        # project file. The title bar changes; nobody reads the title bar.
        #
        # saveCopy writes the same bytes and changes nothing about the open
        # document. If a build has no saveCopy this refuses rather than
        # falling back to saveAs -- silently rebinding their file is worse
        # than not having a checkpoint.
        if not hasattr(doc, "saveCopy"):
            raise KoiOpError(
                "this build's Document has no saveCopy, so an FCStd export "
                "could only be written with saveAs, which would rebind the "
                "human's file to the export directory. Refusing. Export STEP "
                "instead, or have them save from FreeCAD.")
        doc.saveCopy(path)
    else:
        objs = []
        for r in (targets or []):
            objs.append(_resolve_or_die(doc, r, "object"))
        if not objs:
            objs = parts(doc) or [o for o in doc.Objects
                                  if getattr(o, "Shape", None) is not None]
        if not objs:
            raise KoiOpError("nothing with a shape to export")
        if fmt == "STEP":
            import Import
            Import.export(objs, path)
        elif fmt == "BREP":
            import Part
            Part.export(objs, path)
        else:
            import Mesh
            Mesh.export(objs, path)
    size = 0
    try:
        size = os.path.getsize(path)
    except Exception:
        pass
    if size <= 0:
        raise KoiOpError("the export wrote no bytes to %s" % path)
    bound_after = str(getattr(doc, "FileName", "") or "")
    out = {"path": path, "name": name, "format": fmt, "bytes": size,
           "objects": [o.Name for o in (objs if fmt != "FCSTD" else doc.Objects)][:64],
           "documentFile": bound_after or None,
           "rebound": bound_after != bound_before}
    if out["rebound"]:
        # Measured, not assumed. If this ever comes back true the checkpoint
        # has moved the human's save target and they have to hear it now,
        # not the next time they press Ctrl+S.
        out["reboundNote"] = (
            "the export changed which file this document saves to: it was %r "
            "and is now %r. Tell the user, and have them File > Save As back "
            "to their own file before doing anything else."
            % (bound_before or "(unsaved)", bound_after))
    return out



def _resolve_ref_sub(doc, r, default_owner=None):
    """A ref id, an 'object:Sub' pair or an object id -> (owner, sub).

    8.1: broken and ambiguous stop here. Falling through to the raw-name path
    turned a stored ref whose face had gone into a subelement literally named
    "pick.top" -- an attachment to nothing, reported as an attachment.
    """
    if not r:
        return default_owner, ""
    raw = _meta(doc).get(REF_PREFIX + str(r))
    if raw:
        fp = _json.loads(raw)
        res = resolve_ref(fp, doc)
        status = res.get("status")
        if status in ("stored", "rederived"):
            return doc.getObject(res["owner"]), res["sub"]
        raise KoiOpError(
            "reference %r is %s: %s"
            % (r, status,
               res.get("message") or res.get("reason") or
               "ask the user to pick it again"))

    if ":" in str(r):
        o_name, sub = str(r).split(":", 1)
        owner = resolve(doc, o_name) or doc.getObject(o_name)
        if owner is not None:
            return owner, sub

    o = resolve(doc, r) or doc.getObject(str(r))
    if o is not None:
        return o, ""

    if _kind_of(str(r)) is not None:
        raise KoiOpError(
            "%r is a raw topological name. Indices renumber on recompute, so "
            "they cannot be authored here: ask the user to click it and "
            "capture it with fn 'ref', or pass '<object>:%s' if you are "
            "naming an element of a specific object." % (r, r))

    raise KoiOpError(
        "%r is not a known ref id, object id or '<object>:Sub' reference"
        % (r,))


def _op_datum_plane(doc, args, kid):
    body = _resolve_body(doc, args.get("body"), args)
    base = args.get("base")
    on = args.get("on") or args.get("plane")
    if base and isinstance(base, str) and base.upper() in ("XY", "XZ", "YZ"):
        on = base.upper()
        base = None
    if not base and not on:
        raise KoiOpError(
            "datum_plane needs on=XY|XZ|YZ (an origin plane) or base=<ref id> "
            "(a face the user picked)")
    if base:
        owner, sub = _resolve_ref_sub(doc, base)
        mode = str(args.get("mode") or "FlatFace")
    else:
        # _origin_plane walks Origin.OriginFeatures. App::Origin has no
        # XY_Plane attribute, so getattr() on it returns None and produces an
        # unattached plane sitting at the global origin.
        owner, sub, mode = _origin_plane(body, on), "", "FlatFace"

    dp = body.newObject("PartDesign::Plane", _safe_name(kid, "DatumPlane"))
    if not _attach_to(dp, owner, sub, mode):
        raise KoiOpError(
            "the datum plane would not attach to %s: this build exposes "
            "neither AttachmentSupport nor Support" % owner.Name)
    offset, offset_expr = (0.0, None)
    if args.get("offset") is not None:
        offset, offset_expr = _numx(args, "offset")
    if offset and not _offset_z(dp, offset):
        raise KoiOpError("this build's datum plane has no AttachmentOffset")
    # A datum's offset is the most common parametric dimension in the whole
    # surface -- the plane the top face sits on IS the stack height -- and it
    # lives inside a placement rather than on a plain property, so the path
    # is spelled out. Bound after the literal is applied so the readback
    # below still compares against a number.
    offset_bound = None
    if offset_expr:
        for path in ("AttachmentOffset.Base.z", ".AttachmentOffset.Base.z"):
            try:
                dp.setExpression(path, offset_expr)
                offset_bound = _bound_to(dp, "AttachmentOffset.Base.z")
                break
            except Exception:
                continue
    dp.Label = str(args.get("label") or kid)
    # Scaffolding, so off by default. A stack of translucent datum planes is
    # what the user sees instead of their model, and the one that is worth
    # looking at is the exception rather than the rule -- pass visible:true
    # for it.
    if not args.get("visible"):
        try:
            dp.Visibility = False
        except Exception:
            pass
    register(doc, kid, dp, args.get("turn"))
    doc.recompute()

    # Read back. Both writes above are ones this build has silently dropped
    # before -- the attachment because the property was renamed, the offset
    # because the placement came back as a copy.
    got = _attach_readback(dp)
    if got["support"] != owner.Name:
        raise KoiOpError(
            "the datum plane did not attach: asked for %s, the document reads "
            "%r" % (owner.Name, got["support"]))
    if abs((got["offsetZ"] or 0.0) - offset) > 1e-6:
        raise KoiOpError(
            "the datum plane offset did not take: asked for %g, the document "
            "reads %r" % (offset, got["offsetZ"]))
    # Which way is "+offset" here. XZ's normal is -Y, so offset:+BodyWidth/2
    # on it lands at y = -24 -- correct, surprising, and previously knowable
    # only by reading the placement back and working it out. Say it.
    pl = _global_placement(dp)
    # _unit takes a Vector and returns a list. Handing it a list produced
    # AttributeError -> None, so every datum in the field session reported
    # "moves along None" and the sign of an offset on XZ stayed unknowable --
    # which is the one thing this line exists to say.
    normal = _unit(pl.Rotation.multVec(App.Vector(0, 0, 1)))
    out = {"name": dp.Name, "attachedTo": got["support"], "sub": got["sub"],
           "mapMode": got["mapMode"], "offset": got["offsetZ"],
           "visible": _visible(dp), "placement": got["placement"],
           "normal": normal,
           "at": [round(pl.Base.x, 6), round(pl.Base.y, 6),
                  round(pl.Base.z, 6)]}
    if offset:
        out["offsetMoves"] = (
            "a positive offset moves along %s, so this plane sits at %s"
            % (normal, out["at"])) if normal else (
            "the plane's normal could not be read on this build, so the "
            "direction of a positive offset is not knowable from here: it "
            "sits at %s, and XZ's normal is -Y, so +offset on XZ lands at "
            "negative y" % (out["at"],))
    if offset_expr:
        out["offsetExpression"] = offset_expr
        out["offsetBound"] = bool(offset_bound)
        if not offset_bound:
            out["offsetNote"] = (
                "the offset is a literal %g: this build would not take an "
                "expression on AttachmentOffset.Base.z, so the plane will "
                "NOT follow a change to %r" % (offset, offset_expr))
    return out


DRESS_PREFIX = "koi.dress."


def _dress_query(doc, body, args, what, kind="edge"):
    """Run a caller's element FILTER and return (refs, the filter as stored).

    kind is what the op works on when the caller did not say. It is not
    cosmetic: draft and shell act on FACES, and a filter that defaults to
    edges hands them a list of edges, which fails inside BRep with a message
    about the base rather than about the filter. The default is also what
    _reheal_dress re-runs later, so getting it wrong here is durable.

    The reason this exists is the blast radius. A chamfer holds Edge124, an
    upstream parameter grows by 6 mm, the edges renumber, the chamfer errors,
    and the envelope aborts the ENTIRE parametric write -- which then costs a
    delete of the holes, a delete of the chamfer, the parameter change, a
    re-query, a re-chamfer and a re-cut of the holes. Outer edges are half the
    visual design of a boxy part, so "do not chamfer if you plan to change a
    dimension" is not a workable rule.

    The filter is not a durable reference; nothing here is. But it is
    RE-RUNNABLE, which the index is not, so the same intent -- the four
    vertical edges at this size, in this direction -- can be resolved again
    against the shape that exists after the change. See _reheal_dress.
    """
    q = dict(args.get("query") or {})
    if not q:
        return None, None
    if not q.get("of"):
        base = args.get("base")
        if base:
            q["of"] = str(base)
        elif getattr(body, "Tip", None):
            q["of"] = body.Tip.Name
        else:
            raise KoiOpError(
                "%s by query needs something to query: pass base, or use a "
                "body that has a tip" % what)
    q.setdefault("kind", kind)
    q.setdefault("expect", "many")
    res = query(q, doc)
    refs = list(res.get("refs") or [])
    if not refs:
        raise KoiOpError(
            "the %s query matched no edges. %s" % (what, res.get("note") or ""))
    if res.get("ambiguous"):
        # Which object was queried, said out loud. The same filter run through
        # fn 'query' and through here returned different counts in a real
        # session -- 2 edges and 3 -- and the difference was never the filter:
        # 'of' defaulted to the body TIP, which had moved on by the time the
        # chamfer was written. A count mismatch is unreadable without knowing
        # what was counted.
        raise KoiOpError(
            "the %s query ran against %s and matched %d edge(s); expect said "
            "%r. fn 'query' with this same filter and of:%r returns the same "
            "number -- if it did not, the two calls resolved 'of' to "
            "different objects. Say how many you meant (expect:'many', or a "
            "count) rather than taking whichever came first."
            % (what, q.get("of"), res.get("matched"), res.get("expected"),
               q.get("of")))
    return refs, q


def _dress_target(doc, body, args, what, kind="edge"):
    """(owner, [subs], filter) for a dress-up feature, or a refusal.

    No default edge. "Edge1", or the last straight edge, is a topological name
    authored on this side -- the one thing 8.1 bans outright, and worse than
    the ban suggests because iteration order changes it under an upstream
    edit. The user picks it, fn 'ref' captures it -- or fn 'query' describes
    it, and passing that description here as query keeps it.
    """
    refs = args.get("refs") or []
    if isinstance(refs, str):
        refs = [refs]
    qspec = None
    if not refs:
        refs, qspec = _dress_query(doc, body, args, what, kind)
    if not refs:
        raise KoiOpError(
            "%s needs refs: the edges to work on, as ref ids captured from a "
            "user pick (fn 'ref') or '<object>:Edge3' -- or a query: the same "
            "filter fn 'query' takes, which is kept and re-run when an "
            "upstream change renumbers the edges. Choosing an edge here would "
            "mean authoring an index that renumbers on the next recompute."
            % what)

    owner = None
    if args.get("base"):
        owner = _resolve_or_die(doc, args["base"], "base object")
    elif getattr(body, "Tip", None):
        owner = body.Tip

    subs = []
    for r in refs:
        o, sub = _resolve_ref_sub(doc, r, owner)
        if o is None:
            raise KoiOpError("%r did not resolve to an object" % (r,))
        if not sub:
            raise KoiOpError(
                "%r names an object, not an edge or face; %s needs an element "
                "reference" % (r, what))
        # If o or owner is a PartDesign Body, resolve to its active Tip feature
        if str(getattr(o, "TypeId", "")) == "PartDesign::Body" and getattr(o, "Tip", None):
            o = o.Tip
        if owner is not None and str(getattr(owner, "TypeId", "")) == "PartDesign::Body" and getattr(owner, "Tip", None):
            owner = owner.Tip
        if owner is not None and o.Name != owner.Name:
            raise KoiOpError(
                "%s takes elements from one feature: %r is on %s, the base is "
                "%s" % (what, r, o.Name, owner.Name))
        owner = o
        subs.append(sub)
    if owner is None:
        raise KoiOpError("%s needs a base object (or a body with a tip)" % what)
    return owner, subs, qspec


def _dress_remember(doc, feat, owner, qspec):
    """Keep the filter next to the feature it placed."""
    if not qspec:
        return False
    q = dict(qspec)
    q["of"] = owner.Name
    _meta_set(doc, DRESS_PREFIX + feat.Name,
              _json.dumps({"query": q, "of": owner.Name}))
    return True


def _dress_out(doc, out, owner, qspec, what):
    """Finish a dress-up reply: keep the filter, and say how durable this is.

    It takes the feature by NAME out of the reply rather than as a variable,
    because the fillet and chamfer versions of this block were near-identical
    and got transposed twice while being patched -- once leaving the chamfer's
    local inside _op_fillet, once the fillet's inside _op_chamfer. Both are
    NameErrors that fire only when somebody actually dresses an edge, and both
    got through review because the two blocks read identically. One block now,
    and no local to get wrong.
    """
    feat = doc.getObject(str(out.get("name") or ""))
    if feat is not None and _dress_remember(doc, feat, owner, qspec):
        out["query"] = qspec
        out["durability"] = (
            "the filter is kept with this %s, so an upstream change that "
            "renumbers the edges is re-resolved instead of aborting the "
            "write. It is re-derived, not durable: check the result" % what)
    else:
        out["durability"] = (
            "these are edge INDICES. An upstream dimension change renumbers "
            "them and this feature errors, which aborts the whole edit. Place "
            "it with query:{...} instead if the model is still moving")
    return out


def _reheal_dress(doc, names):
    """Re-run the stored filter for dress features that just broke.

    The topological naming problem, bounded. This does not make Edge124
    durable -- it re-derives which edges the caller MEANT from a description
    that survived the change, and only for features that were placed that way.
    Reported, never silent: the edges may not be the same edges, and a caller
    that is told the chamfer was re-resolved can check it.
    """
    m = _meta(doc)
    healed = []
    for name in list(names)[:16]:
        raw = m.get(DRESS_PREFIX + str(name))
        if not raw:
            continue
        feat = doc.getObject(str(name))
        if feat is None:
            continue
        try:
            rec = _json.loads(raw)
            q = dict(rec.get("query") or {})
        except Exception:
            continue
        owner = doc.getObject(str(rec.get("of") or "")) or \
            getattr(feat, "BaseFeature", None)
        if owner is None:
            continue
        q["of"] = owner.Name
        was = []
        try:
            was = [str(x) for x in (_link_pairs(getattr(feat, "Base", None))[0][1]
                                    if _link_pairs(getattr(feat, "Base", None))
                                    else [])]
        except Exception:
            was = []
        try:
            res = query(q, doc)
        except Exception:
            continue
        subs = [r.split(":", 1)[1] for r in (res.get("refs") or []) if ":" in r]
        if not subs:
            # Fallback: re-try with relaxed size tolerance for upstream geometric changes
            q_rel = dict(q)
            q_rel["tol"] = max(float(q.get("tol") or 0.1) * 10.0, 5.0)
            if "minSize" in q_rel:
                try:
                    q_rel["minSize"] = max(0.1, float(q_rel["minSize"]) * 0.7)
                except Exception:
                    pass
            if "maxSize" in q_rel:
                try:
                    q_rel["maxSize"] = float(q_rel["maxSize"]) * 1.3
                except Exception:
                    pass
            try:
                res_rel = query(q_rel, doc)
                subs = [r.split(":", 1)[1] for r in (res_rel.get("refs") or []) if ":" in r]
            except Exception:
                pass
        if not subs or subs == was:
            continue
        try:
            feat.Base = (owner, subs)
        except Exception:
            continue
        healed.append({"feature": feat.Name, "base": owner.Name,
                       "was": was, "now": subs, "matched": res.get("matched")})
    return healed


def _dress_failed(feat, owner, subs, what, why):
    # A dress-up feature that will not build leaves err=None in the envelope --
    # the abort comes from newErrors, not an exception -- so the reason arrives
    # as a status string in a field the caller has to go looking for. Say it
    # here, next to the edge that caused it.
    msg = ""
    try:
        gs = getattr(feat, "getStatusString", None)
        if callable(gs):
            msg = str(gs())
    except Exception:
        pass
    if not msg:
        msg = ", ".join(list(getattr(feat, "State", []))) or "invalid"
    raise KoiOpError(
        "the %s did not build on %s of %s: %s. %s"
        % (what, ", ".join(subs) or "?", owner.Name, msg, why))


def _dress_tolerate(doc, feat, owner, subs, what):
    """Build with the edges that will take it, and name the ones that will not.

    "Chamfer the four corners" is ONE intent. Sent as four steps it is four
    features, and the fifth step raising rolled back the four that had already
    built -- the batch is atomic on purpose and that is the right default.
    Sent as one feature, one edge that BRep will not chamfer fails the whole
    set with 'command not done'. Neither outcome is what was asked for, so the
    edges that cannot take it are dropped BY NAME and the rest build.

    Off by default: silently chamfering three of four corners is its own way
    to be wrong, and it has to be asked for.
    """
    kept = list(subs)
    dropped = []
    for sub in list(subs):
        try:
            if feat.isValid():
                break
        except Exception:
            pass
        if len(kept) <= 1:
            break
        kept = [s for s in kept if s != sub]
        dropped.append(sub)
        try:
            feat.Base = (owner, kept)
        except Exception:
            break
        doc.recompute()
    return kept, dropped


def _dress_dropped_note(what, dropped, kept):
    return ("%d of the edges asked for would not take a %s and were dropped "
            "so the rest could build: %s. This feature now covers %d edge(s), "
            "not the set that was requested -- check the ones named before "
            "reporting the intent as done."
            % (len(dropped), what, ", ".join(dropped[:8]), len(kept)))


def _op_fillet(doc, args, kid):
    body = _resolve_body(doc, args.get("body"), args)
    owner, subs, qspec = _dress_target(doc, body, args, "fillet")
    before = _vol(owner)
    f = body.newObject("PartDesign::Fillet", _safe_name(kid, "Fillet"))
    f.Base = (owner, subs)
    dim = _set_dim(f, "Radius", args, "radius", 1.0)
    radius = dim["value"]
    f.Label = str(args.get("label") or kid)
    register(doc, kid, f, args.get("turn"))
    doc.recompute()
    dropped = []
    if not f.isValid() and bool(args.get("tolerant")) and len(subs) > 1:
        subs, dropped = _dress_tolerate(doc, f, owner, subs, "fillet")
    if not f.isValid():
        _dress_failed(f, owner, subs, "fillet",
                      "A blend needs a sharp edge: a tangent seam, or a "
                      "radius wider than the face beside it, will not build.")
    after = _vol(f)
    out = {"name": f.Name, "radius": radius, "edges": subs,
           "base": owner.Name, "volume": after, "volumeBefore": before,
           "volumeDelta": None if (before is None or after is None)
                          else round(after - before, 6)}
    if dim.get("expression"):
        out["dimension"] = dim
    if dropped:
        out["droppedEdges"] = dropped
        out["note"] = _dress_dropped_note("fillet", dropped, subs)
    return _dress_out(doc, out, owner, qspec, "fillet")


def _op_chamfer(doc, args, kid):
    body = _resolve_body(doc, args.get("body"), args)
    owner, subs, qspec = _dress_target(doc, body, args, "chamfer")
    before = _vol(owner)
    c = body.newObject("PartDesign::Chamfer", _safe_name(kid, "Chamfer"))
    c.Base = (owner, subs)
    dim = _set_dim(c, "Size", args, "size", 1.0)
    size = dim["value"]
    c.Label = str(args.get("label") or kid)
    register(doc, kid, c, args.get("turn"))
    doc.recompute()
    if not c.isValid():
        _dress_failed(c, owner, subs, "chamfer",
                      "A chamfer needs a sharp edge between two faces: a "
                      "tangent seam, or a size wider than the face beside it, "
                      "will not build.")
    after = _vol(c)
    out = {"name": c.Name, "size": size, "edges": subs,
           "base": owner.Name, "volume": after, "volumeBefore": before,
           "volumeDelta": None if (before is None or after is None)
                          else round(after - before, 6)}
    if dim.get("expression"):
        out["dimension"] = dim
    return _dress_out(doc, out, owner, qspec, "chamfer")


def _op_link_array(doc, args, kid):
    target = _resolve_or_die(doc, _need(args, "target"), "target")
    _refuse_feature_as_link(target, "link_array")
    count = int(_num(args, "count", 2))
    if count < 1:
        raise KoiOpError("count must be at least 1")
    if count > LINK_LIMIT:
        # Every loop through this channel carries a bound, and this one's
        # bound would otherwise be whatever number the model typed.
        raise KoiOpError(
            "count %d is over the %d-instance bound; an array that large is a "
            "real request but has to be asked for deliberately"
            % (count, LINK_LIMIT))
    step = args.get("step") or [10, 0, 0]
    if not (isinstance(step, list) and len(step) == 3):
        raise KoiOpError("step must be [x, y, z]")
    try:
        step = [float(s) for s in step]
    except Exception:
        raise KoiOpError("step must be three numbers, got %r" % (step,))

    grp = doc.addObject("App::DocumentObjectGroup", _safe_name(kid, "LinkArray"))
    grp.Label = str(args.get("label") or kid)

    links = []
    for i in range(count):
        lnk = doc.addObject("App::Link", _safe_name("%s_%d" % (kid, i), "Link"))
        lnk.LinkedObject = target
        # Placement comes back as a copy: assigning through it drops the move
        # and leaves the whole array stacked on the master.
        _place(lnk, step[0] * i, step[1] * i, step[2] * i)
        grp.addObject(lnk)
        links.append(lnk.Name)

    register(doc, kid, grp, args.get("turn"))
    doc.recompute()

    placed = [_pos(doc.getObject(n)) for n in links]
    want = [[round(step[0] * i, 6), round(step[1] * i, 6), round(step[2] * i, 6)]
            for i in range(count)]
    if placed != want:
        raise KoiOpError(
            "the link placements did not take: asked for %s, the document "
            "reads %s" % (want[:3], placed[:3]))
    shaped = sum(1 for n in links if _vol(doc.getObject(n)) is not None)
    out = {"name": grp.Name, "count": count, "links": links,
           "linkedTo": target.Name, "placements": placed, "withShape": shaped}
    if shaped != count:
        # Said rather than assumed: interference and clearance walk shapes, so
        # a link that exposes none is a bolt pattern nothing will ever check.
        out["note"] = ("%d of %d links expose no shape, so interference and "
                       "clearance cannot see them" % (count - shaped, count))
    return out


def _op_attach(doc, args, kid):
    target = _resolve_or_die(doc, _need(args, "target"), "target")
    owner, sub = _resolve_ref_sub(doc, _need(args, "base"))
    if owner is None:
        raise KoiOpError("base %r did not resolve to an object"
                         % (args.get("base"),))
    was = _attach_readback(target)
    if not _attach_to(target, owner, sub, args.get("mode") or "FlatFace"):
        raise KoiOpError(
            "%s exposes neither AttachmentSupport nor Support: on this build "
            "it can be placed but not attached" % target.Name)
    offset = args.get("offset")
    if offset is not None and not _offset_z(target, float(offset)):
        raise KoiOpError("%s has no AttachmentOffset" % target.Name)

    doc.recompute()

    got = _attach_readback(target)
    if got["support"] != owner.Name:
        raise KoiOpError(
            "%s did not attach to %s: the document reads %r"
            % (target.Name, owner.Name, got["support"]))
    if offset is not None and abs((got["offsetZ"] or 0.0) - float(offset)) > 1e-6:
        raise KoiOpError(
            "the offset did not take: asked for %g, the document reads %r"
            % (float(offset), got["offsetZ"]))
    return {"name": target.Name, "attachedTo": got["support"],
            "sub": got["sub"], "mapMode": got["mapMode"],
            "offsetZ": got["offsetZ"], "placement": got["placement"],
            "placementBefore": was["placement"]}


# ---------- revolved features ----------
#
# The vocabulary gap the whitelist shipped with: pad and pocket express prisms
# and nothing else, so every shaft, boss, bore, seat and retaining groove --
# most of what a mechanism is made of -- fell through to freecad_script, which
# is where ids stop being registered and the DAG stops being editable. These
# are the same shape as pad/pocket down to the measurement, on purpose.

REV_AXES = {"V": "V_Axis", "H": "H_Axis"}


def _rev_axis(sk, which):
    w = str(which or "V").upper()
    name = REV_AXES.get(w)
    if name is None:
        raise KoiOpError(
            "axis must be V (the sketch's vertical axis) or H (its "
            "horizontal), not %r" % (which,))
    return (sk, [name])


def _op_revolve(doc, args, kid):
    body = _resolve_body(doc, args.get("body"), args)
    sk = _resolve_or_die(doc, _need(args, "sketch"), "sketch")
    rv = body.newObject("PartDesign::Revolution", _safe_name(kid, "Revolution"))
    rv.Profile = sk
    rv.ReferenceAxis = _rev_axis(sk, args.get("axis"))
    applied = {"Angle": _set_dim(rv, "Angle", args, "angle", 360.0)}
    if args.get("midplane"):
        applied["Midplane"] = _set_if(rv, "Midplane", True)
    if "reversed" in args:
        applied["Reversed"] = _set_if(rv, "Reversed", bool(args["reversed"]))
    hidden = _tidy_construction(doc, sk)
    doc.recompute()
    if not rv.isValid():
        _dress_failed(rv, sk, [], "revolution",
                      "A revolution needs a closed profile that stays on one "
                      "side of its axis: a profile crossing the axis sweeps "
                      "through itself.")
    register(doc, kid, rv, args.get("turn"))
    vol = _vol(rv)
    out = {"name": rv.Name, "angle": _plain(getattr(rv, "Angle", None)),
           "axis": str(args.get("axis") or "V"), "volume": vol,
           "applied": applied, "hidden": hidden}
    if vol is not None and vol <= 1e-6:
        out["note"] = ("this revolution encloses no volume -- check the "
                       "profile and which axis it turns about")
    return out


def _op_groove(doc, args, kid):
    body = _resolve_body(doc, args.get("body"), args)
    sk = _resolve_or_die(doc, _need(args, "sketch"), "sketch")
    gr = body.newObject("PartDesign::Groove", _safe_name(kid, "Groove"))
    gr.Profile = sk
    gr.ReferenceAxis = _rev_axis(sk, args.get("axis"))
    dim = _set_dim(gr, "Angle", args, "angle", 360.0)
    told = "reversed" in args and args["reversed"] is not None and str(args["reversed"]).lower() != "auto"
    if told:
        _set_if(gr, "Reversed", bool(args["reversed"]))
    hidden = _tidy_construction(doc, sk)
    doc.recompute()
    # Same measurement as pocket and hole. A groove that turns the wrong way
    # recomputes clean, reports Up-to-date and removes nothing.
    removed, flipped, at = _ensure_cuts(doc, gr, told, sk)
    register(doc, kid, gr, args.get("turn"))
    out = {"name": gr.Name, "angle": _plain(getattr(gr, "Angle", None)),
           "axis": str(args.get("axis") or "V"),
           "reversed": bool(getattr(gr, "Reversed", False)),
           "removed": removed, "removedAtProfile": at,
           "volume": _vol(gr), "hidden": hidden}
    if dim.get("expression"):
        out["dimension"] = dim
    note = _cut_note(removed, flipped, told, "groove", at)
    if note:
        out["note"] = note
    return out



# ---------- swept and lofted features ----------
#
# Loft and pipe are the two shapes pad/pocket/revolve/groove cannot say: a
# transition between sections, and a profile carried along a path. Everything
# else here -- the profile gate before the feature exists, the measurement
# after it, the note when a cut removes nothing -- is the same contract the
# prismatic ops already keep, on purpose.

PIPE_MODES = ("Fixed", "Frenet", "Auxiliary", "Binormal", "Curvilinear")
PIPE_TRANSITIONS = ("Transformed", "RightCorner", "RoundCorner")

LOFT_SECTION_LIMIT = 32


def _enum_arg(args, key, allowed, what):
    """One of a fixed set, case-insensitively -- or a refusal naming the set.

    The first version silently dropped anything it did not recognise, so
    transition:'roundcorner' built a Transformed sweep and reported success.
    A typo that changes the geometry and reports the default is the failure
    mode this whole module is written against.
    """
    if key not in args or args[key] is None:
        return None
    want = str(args[key]).strip().lower()
    for a in allowed:
        if a.lower() == want:
            return a
    raise KoiOpError(
        "%s %s must be one of %s, not %r"
        % (what, key, ", ".join(allowed), args[key]))


def _loft_sections(doc, args, what):
    raw = args.get("sketches") or args.get("sections") or args.get("profiles")
    if not isinstance(raw, list) or len(raw) < 2:
        raise KoiOpError(
            "%s requires a list of at least 2 sketch ids under 'sketches'" % what)
    if len(raw) > LOFT_SECTION_LIMIT:
        raise KoiOpError(
            "%s is capped at %d section sketches" % (what, LOFT_SECTION_LIMIT))
    sks = [_resolve_or_die(doc, s, "sketch") for s in raw]
    seen = set()
    for s in sks:
        if s.Name in seen:
            raise KoiOpError(
                "%s lists %s twice: a section repeated in place is a "
                "zero-length transition and will not solve" % (what, s.Name))
        seen.add(s.Name)
        # Before the feature exists, so a refusal leaves no half-built loft.
        _profile_gate(s, what)
    return sks


def _loft_shape(loft, args):
    if "ruled" in args:
        loft.Ruled = bool(args["ruled"])
    if "closed" in args:
        loft.Closed = bool(args["closed"])


def _spine_of(sk_path, what):
    """The path edges, named at build time.

    An empty spine is the swept version of an open profile: PartDesign builds
    it, reports Up-to-date, and adds nothing. Refuse it here rather than
    measure it later.
    """
    shape = getattr(sk_path, "Shape", None)
    edges = list(getattr(shape, "Edges", []) or [])
    if not edges:
        raise KoiOpError(
            "%s has no edges to sweep along: a path sketch needs at least one "
            "line, arc or spline" % sk_path.Name)
    return (sk_path, ["Edge%d" % (i + 1) for i in range(len(edges))])


def _pipe_setup(doc, args, kid, typeid, prefix, what):
    body = _resolve_body(doc, args.get("body"), args)
    sk_prof = _resolve_or_die(doc, _need(args, "sketch"), "sketch")
    sk_path = _resolve_or_die(doc, _need(args, "path"), "path")
    if sk_path.Name == sk_prof.Name:
        raise KoiOpError(
            "%s was given %s as both profile and path" % (what, sk_prof.Name))
    _profile_gate(sk_prof, what)
    spine = _spine_of(sk_path, what)
    mode = _enum_arg(args, "mode", PIPE_MODES, what)
    transition = _enum_arg(args, "transition", PIPE_TRANSITIONS, what)
    pipe = body.newObject(typeid, _safe_name(kid, prefix))
    pipe.Profile = sk_prof
    pipe.Spine = spine
    if mode:
        pipe.Mode = mode
    if transition:
        pipe.Transition = transition
    pipe.Label = str(args.get("label") or kid)
    hidden = _tidy_construction(doc, sk_prof) + _tidy_construction(doc, sk_path)
    return pipe, sk_prof, sk_path, hidden


def _cut_only_note(feat, sk, what):
    """removed, removedAtProfile, and the note when a cut did nothing.

    Loft and pipe have no Reversed to try, so _ensure_cuts has nothing to
    flip; the MEASUREMENT it exists for still applies, and a subtractive
    feature that reports success while removing nothing is the exact bug the
    pocket/groove path was written to catch.
    """
    removed, at = _cut_quality(feat, sk)
    note = None
    if removed is not None and removed <= 1e-6:
        note = ("this %s removes no material -- check that the sections or "
                "the path actually pass through the solid" % what)
    elif at is not None and at > AT_PROFILE_TOL:
        note = ("this %s removed %.3f mm3, and the material it took starts "
                "%0.2f mm from its own profile. Probe it" % (what, removed, at))
    return removed, at, note


def _op_loft(doc, args, kid):
    body = _resolve_body(doc, args.get("body"), args)
    sks = _loft_sections(doc, args, "loft")
    loft = body.newObject("PartDesign::AdditiveLoft", _safe_name(kid, "Loft"))
    loft.Profile = sks[0]
    loft.Sections = sks[1:]
    _loft_shape(loft, args)
    loft.Label = str(args.get("label") or kid)
    hidden = []
    for s in sks:
        hidden.extend(_tidy_construction(doc, s))
    doc.recompute()
    if not loft.isValid():
        _dress_failed(loft, sks[0], [], "loft",
                      "A loft failed to solve -- check that all section sketches are closed and have compatible orientation.")
    register(doc, kid, loft, args.get("turn"))
    vol = _vol(loft)
    out = {"name": loft.Name, "sketches": [s.Name for s in sks],
           "ruled": bool(getattr(loft, "Ruled", False)),
           "closed": bool(getattr(loft, "Closed", False)),
           "volume": vol, "bbox": _bbox_of(loft), "hidden": hidden}
    if vol is not None and vol <= 1e-6:
        out["note"] = ("this loft encloses no volume -- check the section "
                       "order and that the sections do not lie in one plane")
    return out


def _op_subtractive_loft(doc, args, kid):
    body = _resolve_body(doc, args.get("body"), args)
    sks = _loft_sections(doc, args, "subtractive_loft")
    loft = body.newObject("PartDesign::SubtractiveLoft", _safe_name(kid, "SubtractiveLoft"))
    loft.Profile = sks[0]
    loft.Sections = sks[1:]
    _loft_shape(loft, args)
    loft.Label = str(args.get("label") or kid)
    hidden = []
    for s in sks:
        hidden.extend(_tidy_construction(doc, s))
    doc.recompute()
    if not loft.isValid():
        _dress_failed(loft, sks[0], [], "subtractive_loft",
                      "A subtractive loft failed to solve -- check that all section sketches are closed and intersect the solid.")
    removed, at, note = _cut_only_note(loft, sks[0], "subtractive loft")
    register(doc, kid, loft, args.get("turn"))
    vol = _vol(loft)
    out = {"name": loft.Name, "sketches": [s.Name for s in sks],
           "ruled": bool(getattr(loft, "Ruled", False)),
           "closed": bool(getattr(loft, "Closed", False)),
           "removed": removed, "removedAtProfile": at,
           "volume": vol, "hidden": hidden}
    if note:
        out["note"] = note
    return out


def _op_pipe(doc, args, kid):
    pipe, sk_prof, sk_path, hidden = _pipe_setup(
        doc, args, kid, "PartDesign::AdditivePipe", "Pipe", "pipe")
    doc.recompute()
    if not pipe.isValid():
        _dress_failed(pipe, sk_prof, [], "pipe",
                      "A pipe (sweep) failed to solve -- check that the path touches the profile and does not self-intersect.")
    register(doc, kid, pipe, args.get("turn"))
    vol = _vol(pipe)
    out = {"name": pipe.Name, "sketch": sk_prof.Name, "path": sk_path.Name,
           "mode": getattr(pipe, "Mode", "Fixed"),
           "transition": getattr(pipe, "Transition", "Transformed"),
           "volume": vol, "bbox": _bbox_of(pipe), "hidden": hidden}
    if vol is not None and vol <= 1e-6:
        out["note"] = ("this sweep encloses no volume -- check that the path "
                       "starts at the profile and has real length")
    return out


def _op_subtractive_pipe(doc, args, kid):
    pipe, sk_prof, sk_path, hidden = _pipe_setup(
        doc, args, kid, "PartDesign::SubtractivePipe", "SubtractivePipe",
        "subtractive_pipe")
    doc.recompute()
    if not pipe.isValid():
        _dress_failed(pipe, sk_prof, [], "subtractive_pipe",
                      "A subtractive pipe failed to solve -- check that the path touches the profile and intersects the solid.")
    removed, at, note = _cut_only_note(pipe, sk_prof, "subtractive sweep")
    register(doc, kid, pipe, args.get("turn"))
    vol = _vol(pipe)
    out = {"name": pipe.Name, "sketch": sk_prof.Name, "path": sk_path.Name,
           "mode": getattr(pipe, "Mode", "Fixed"),
           "transition": getattr(pipe, "Transition", "Transformed"),
           "removed": removed, "removedAtProfile": at,
           "volume": vol, "hidden": hidden}
    if note:
        out["note"] = note
    return out


def _op_draft(doc, args, kid):
    body = _resolve_body(doc, args.get("body"), args)
    # "face", not the default edge: a draft acts on faces, and a query that
    # silently filtered edges handed BRep a list it cannot use and reported
    # the failure against the base instead of against the filter.
    owner, subs, qspec = _dress_target(doc, body, args, "draft", "face")
    before = _vol(owner)
    np_arg = args.get("neutralPlane") or args.get("plane") or "XY"
    if str(np_arg).upper() in ("XY", "XZ", "YZ"):
        np_obj = _origin_plane(body, np_arg)
        neutral_plane = (np_obj, [""])
    else:
        np_owner, np_sub = _resolve_ref_sub(doc, np_arg)
        if np_owner is None:
            raise KoiOpError("neutralPlane %r does not resolve" % (np_arg,))
        neutral_plane = (np_owner, [np_sub] if np_sub else [""])
    dr = body.newObject("PartDesign::Draft", _safe_name(kid, "Draft"))
    dr.Base = (owner, subs)
    dr.NeutralPlane = neutral_plane
    dim = _set_dim(dr, "Angle", args, "angle", 1.5)
    angle = dim["value"]
    if "reversed" in args:
        dr.Reversed = bool(args["reversed"])
    dr.Label = str(args.get("label") or kid)
    register(doc, kid, dr, args.get("turn"))
    doc.recompute()
    if not dr.isValid():
        _dress_failed(dr, owner, subs, "draft",
                      "A draft angle failed to solve -- check that the neutral plane and drafted faces are valid.")
    after = _vol(dr)
    delta = None if (before is None or after is None) else round(after - before, 6)
    out = {"name": dr.Name, "angle": angle, "faces": subs,
           "neutralPlane": neutral_plane[0].Name,
           "reversed": bool(getattr(dr, "Reversed", False)),
           "base": owner.Name, "volume": after, "volumeBefore": before,
           "volumeDelta": delta,
           "taper": None if delta is None else
                    ("inward" if delta < -1e-6 else
                     "outward" if delta > 1e-6 else "none")}
    if delta is not None and abs(delta) <= 1e-6:
        # A draft that recomputes clean and changes nothing is the mould-tool
        # version of a pocket that cuts nothing: the part ships without the
        # release angle it was drawn to have.
        out["note"] = ("this draft changed no volume -- the faces may already "
                       "lie in the neutral plane, or none of the refs are "
                       "faces this draft can pull")
    if dim.get("expression"):
        out["dimension"] = dim
    return _dress_out(doc, out, owner, qspec, "draft")


# ---------- patterns ----------

AXIS_VECTORS = {"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}


def _axis_vector(which):
    v = AXIS_VECTORS.get(str(which or "Z").upper())
    if v is None:
        raise KoiOpError("axis must be X, Y or Z, not %r" % (which,))
    return App.Vector(*v)


def _xyz(v, what):
    if not (isinstance(v, list) and len(v) == 3):
        raise KoiOpError("%s must be [x, y, z]" % what)
    try:
        return [float(x) for x in v]
    except Exception:
        raise KoiOpError("%s must be three numbers, got %r" % (what, v))


def _refuse_feature_as_link(o, fn):
    """A feature inside a body is not something to make copies OF.

    The guard in _pattern_features has always pointed one way: hand a Body to
    pattern and it names polar_array. The reverse was silent, and it is the
    commoner mistake -- six holes in a plate reads like an array, so the array
    ops got handed a pocket. App::Link takes it: the result is copies of the
    hole's own shape standing next to the plate, the plate still has one hole,
    interference then reports the copies against everything, and nothing in
    that chain says what went wrong.
    """
    tid = str(getattr(o, "TypeId", ""))
    if tid.startswith("PartDesign::") and "Body" not in tid:
        raise KoiOpError(
            "%s is a %s -- a feature INSIDE a body, and %s makes App::Link "
            "copies of whole objects. Linking a feature gives you copies of "
            "the hole standing beside the plate, while the plate still has "
            "one hole in it. Six holes in ONE plate are fn 'pattern' "
            "(kind:'polar'), which repeats the feature inside the body; to "
            "array the whole part, pass the body." % (o.Name, tid, fn))


def _op_polar_array(doc, args, kid):
    """Rotational repeats, as App::Links like link_array.

    Three planets at 120 degrees, three lugs, six bolts on a circle: the
    single most common arrangement in a mechanism, and the one link_array's
    [x, y, z] step cannot express at all. Links rather than copies for the
    same reason link_array uses them -- cost is driven by unique parts, and a
    six-instance pattern should be one master and six placements.
    """
    target = _resolve_or_die(doc, _need(args, "target"), "target")
    _refuse_feature_as_link(target, "polar_array")
    count = int(_num(args, "count", 3))
    if count < 1:
        raise KoiOpError("count must be at least 1")
    if count > LINK_LIMIT:
        raise KoiOpError(
            "count %d is over the %d-instance bound; an array that large is a "
            "real request but has to be asked for deliberately"
            % (count, LINK_LIMIT))
    angle = float(_num(args, "angle", 360.0))
    axis = _axis_vector(args.get("axis"))
    center = App.Vector(*_xyz(args.get("center") or [0, 0, 0], "center"))
    # A full turn closes on itself, so N instances are N steps; a partial
    # sweep puts an instance at each end, so N instances are N-1 steps.
    full = abs(abs(angle) - 360.0) < 1e-9
    if count == 1:
        step = 0.0
    elif full:
        step = angle / count
    else:
        step = angle / (count - 1)

    grp = doc.addObject("App::DocumentObjectGroup",
                        _safe_name(kid, "PolarArray"))
    grp.Label = str(args.get("label") or kid)

    base_pl = target.Placement
    links, want = [], []
    for i in range(count):
        lnk = doc.addObject("App::Link", _safe_name("%s_%d" % (kid, i), "Link"))
        lnk.LinkedObject = target
        rot = App.Rotation(axis, step * i)
        pos = rot.multVec(base_pl.Base - center) + center
        # The whole Placement goes back in one assignment. Mutating through
        # the property writes to a copy and drops the move, which is the trap
        # link_array documents and which produces an array stacked on its
        # master with no error.
        lnk.Placement = App.Placement(pos, rot.multiply(base_pl.Rotation))
        grp.addObject(lnk)
        links.append(lnk.Name)
        want.append([round(pos.x, 6), round(pos.y, 6), round(pos.z, 6)])

    register(doc, kid, grp, args.get("turn"))
    doc.recompute()

    placed = [_pos(doc.getObject(n)) for n in links]
    for got, expect in zip(placed, want):
        if got is None or max(abs(a - b) for a, b in zip(got, expect)) > 1e-6:
            raise KoiOpError(
                "the link placements did not take: asked for %s, the document "
                "reads %s" % (want[:3], placed[:3]))
    shaped = sum(1 for n in links if _vol(doc.getObject(n)) is not None)
    out = {"name": grp.Name, "count": count, "links": links,
           "linkedTo": target.Name, "stepDegrees": round(step, 6),
           "axis": str(args.get("axis") or "Z"), "placements": placed,
           "withShape": shaped}
    if shaped != count:
        out["note"] = ("%d of %d links expose no shape, so interference and "
                       "clearance cannot see them" % (count - shaped, count))
    return out


PATTERN_TYPES = {"polar": "PartDesign::PolarPattern",
                 "linear": "PartDesign::LinearPattern"}


# Which property holds "the features to repeat". PartDesign::Transformed has
# carried both spellings across versions, and a pattern whose originals never
# got set builds an object that reports valid and whose Shape raises on access
# — which is indistinguishable, from the outside, from a pattern whose
# instances overlapped. Twelve assertions in test_ops2.js hung off that
# ambiguity for two builds running.
PATTERN_ORIGINALS = ("Transformed", "Originals")


def _pattern_attach(p, feats):
    """Attach the features to repeat, and prove they attached.

    Set-and-verify rather than set-and-hope: _set_if reports whether the write
    raised, not whether the property took a list it was willing to accept. A
    Transformed feature will accept an empty assignment and then produce
    nothing, so the read-back is the actual test.
    """
    present = [x for x in PATTERN_ORIGINALS if x in p.PropertiesList]
    if not present:
        raise KoiOpError(
            "this build's %s has no property for the features to repeat: "
            "looked for %s, found %s. The pattern op cannot work on this "
            "build until the spelling is known."
            % (p.TypeId, " or ".join(PATTERN_ORIGINALS),
               ", ".join(sorted(p.PropertiesList))))
    for prop in present:
        if not _set_if(p, prop, feats):
            continue
        try:
            got = [o.Name for o in (getattr(p, prop) or [])]
        except Exception:
            got = []
        if got:
            return prop, got
    raise KoiOpError(
        "%s would not hold the features to repeat. Property %s exists and the "
        "assignment did not raise, but reading it back gives nothing, so the "
        "pattern would build an empty feature. Features offered: %s."
        % (p.TypeId, " and ".join(present), ", ".join(f.Name for f in feats)))


def _vol_or_why(obj):
    """Volume, or the reason there is not one.

    _vol() collapses every failure into None, which is right for the callers
    that only need a number and useless for the one that has to explain itself.
    A pattern that cannot be measured is the module's hardest error to read,
    so it gets the exception text rather than a shrug.
    """
    try:
        s = obj.Shape
    except Exception as e:
        return None, "Shape raised: %s: %s" % (type(e).__name__, e)
    try:
        if s.isNull():
            return None, "the feature's shape is null"
    except Exception:
        pass
    try:
        return round(s.Volume, 6), None
    except Exception as e:
        return None, "Volume raised: %s: %s" % (type(e).__name__, e)


def _pattern_features(doc, body, args):
    """Which features get repeated. The body's tip by default."""
    raw = args.get("features") or args.get("feature")
    if isinstance(raw, str):
        raw = [raw]
    if not raw:
        tip = getattr(body, "Tip", None)
        if tip is None:
            raise KoiOpError(
                "pattern needs features: the ids of the pad/pocket/hole to "
                "repeat, and %s has no tip to fall back on" % body.Name)
        return [tip]
    if not isinstance(raw, list):
        raise KoiOpError("features must be a list of ids")
    out = []
    for r in raw[:16]:
        f = _resolve_or_die(doc, r, "feature")
        tid = str(getattr(f, "TypeId", ""))
        # "PartDesign::" alone is not the test -- a Body is PartDesign:: too,
        # and handing one to a PolarPattern transforms the body into itself:
        # it reports valid, its Shape then raises on access, and every later
        # op on that document fails somewhere else with a confusing message.
        # The rest of this module spells the test the same way.
        if not (tid.startswith("PartDesign::") and "Body" not in tid):
            raise KoiOpError(
                "%s is a %s, not a PartDesign feature. An in-body pattern "
                "repeats a feature inside its own body -- to repeat a whole "
                "solid, use polar_array or link_array instead."
                % (f.Name, tid))
        out.append(f)
    return out


def _pattern_plans(p, kind, total, count):
    """(mode, value) attempts, best first.

    FreeCAD 1.x gave Transformed features a Mode, and it changed what the
    number means: with Mode 'angle' the Angle is the step BETWEEN instances,
    so a 360 that used to sweep the full circle now puts all six instances on
    top of each other. The result reports valid and its Shape then raises on
    access -- which is exactly how this arrived, as 'shape cannot be
    measured' three sections downstream.

    Rather than guess an enum spelling that has already moved once, ask the
    object what it accepts, try the overall reading first, and keep the step
    reading as a fallback for builds that only have it. Same shape as
    _attach_map: attempt, read back, say which one answered.
    """
    modes = []
    try:
        modes = [str(m) for m in p.getEnumerationsOfProperty("Mode")]
    except Exception:
        modes = []
    # Legacy builds have no Mode at all and read the number as the total.
    if not modes:
        return [(None, total)], modes

    # Classify on the STEP words, not the total ones. This build offers
    # ("Extent", "Spacing") -- no "overall" anywhere -- and a chooser looking
    # for the total by name picked Extent as the step, handed it 60 degrees
    # across six instances, and stacked them 10 degrees apart. Naming the
    # step is the reliable half: "spacing" and its synonyms mean the gap
    # between instances on every spelling this has shipped as, and whatever
    # is left over is the total.
    STEP_WORDS = ("spacing", "step", "increment", "interval", "between")
    step = None
    for m in modes:
        low = m.lower().replace(" ", "_")
        if any(w in low for w in STEP_WORDS):
            step = m
            break
    rest = [m for m in modes if m != step]
    total_mode = None
    for m in rest:
        low = m.lower().replace(" ", "_")
        if "overall" in low or "extent" in low or "total" in low:
            total_mode = m
            break
    if total_mode is None and rest:
        total_mode = rest[0]
    if step is None:
        # No step word matched, but a two-mode enum still has a second
        # reading — ("angle", "overall_angle") names the step "angle", which
        # matches nothing. Whatever is left after the total is the candidate.
        for m in rest:
            if m != total_mode:
                step = m
                break

    # A full circle divides by count; a partial sweep divides by the gaps.
    n = count if (kind == "polar" and abs(total - 360.0) < 1e-9) else max(count - 1, 1)
    per = total / float(n)

    plans = []
    if total_mode:
        plans.append((total_mode, total))
    if step:
        plans.append((step, per))
    # Crossed readings, last. They cost one recompute each and only run when
    # the named ones failed to produce a measurable shape -- which is exactly
    # the situation where the naming turned out not to mean what it says.
    if total_mode:
        plans.append((total_mode, per))
    if step:
        plans.append((step, total))
    return (plans or [(None, total)]), modes


def _op_pattern(doc, args, kid):
    """Repeat a FEATURE inside its body, fused into the solid.

    This is the gap polar_array does not fill and was never meant to.
    polar_array makes App::Link instances of a whole object: right for three
    planets or six bolts, and useless for six holes in one plate, because the
    links are separate objects with their own shapes and the plate still has
    one hole in it. A bolt circle, a row of slots, a ring of gear teeth are
    all one feature repeated INSIDE the solid, which is a PartDesign pattern
    and nothing else.

    Measured like every other feature here: a pattern that fused nothing, or
    cut nothing, recomputes clean and reports isValid().
    """
    body = _resolve_body(doc, args.get("body"), args)
    kind = str(args.get("kind") or "polar").strip().lower()
    tid = PATTERN_TYPES.get(kind)
    if tid is None:
        raise KoiOpError("kind must be polar or linear, not %r"
                         % (args.get("kind"),))
    count = int(_num(args, "count", 3))
    if count < 2:
        raise KoiOpError("count must be at least 2; one instance is not a "
                         "pattern")
    if count > LINK_LIMIT:
        raise KoiOpError(
            "count %d is over the %d-instance bound; a pattern that large is "
            "a real request but has to be asked for deliberately"
            % (count, LINK_LIMIT))

    feats = _pattern_features(doc, body, args)
    before = _vol(body)
    p = body.newObject(tid, _safe_name(kid, kind.capitalize() + "Pattern"))
    applied = {}
    originals_prop, originals = _pattern_attach(p, feats)
    applied[originals_prop] = originals
    applied["Occurrences"] = _set_if(p, "Occurrences", count)
    # FreeCAD 1.x added TransformMode to Transformed features. Not written —
    # the default is what the GUI uses — but recorded, because it changes what
    # the pattern acts on and a failure that turns out to be this should not
    # have to be guessed at twice.
    if "TransformMode" in p.PropertiesList:
        try:
            applied["TransformMode"] = str(p.TransformMode)
        except Exception:
            pass

    if kind == "polar":
        axis = _origin_axis(body, args.get("axis") or "Z")
        applied["Axis"] = _set_if(p, "Axis", (axis, [""]))
        total = float(_num(args, "angle", 360.0))
        prop = "Angle"
        detail = {"axis": str(args.get("axis") or "Z"), "angle": total}
    else:
        which = str(args.get("direction") or args.get("axis") or "X")
        axis = _origin_axis(body, which)
        applied["Direction"] = _set_if(p, "Direction", (axis, [""]))
        total = float(_num(args, "length", 0.0))
        if total <= 0:
            raise KoiOpError("a linear pattern needs length > 0 (the total "
                             "span, not the step)")
        prop = "Length"
        detail = {"direction": which, "length": total,
                  "step": round(total / max(count - 1, 1), 6)}
    if "reversed" in args:
        applied["Reversed"] = _set_if(p, "Reversed", bool(args["reversed"]))

    p.Label = str(args.get("label") or kid)

    plans, modes = _pattern_plans(p, kind, total, count)
    tried = []
    after = None
    used = None
    fallback = None
    for mode, value in plans:
        if mode is not None:
            _set_if(p, "Mode", mode)
        _set_if(p, prop, value)
        doc.recompute()
        v, why = _vol_or_why(p)
        attempt = {"mode": mode, prop.lower(): round(value, 6),
                   "volume": v, "valid": bool(p.isValid())}
        if why:
            attempt["why"] = why
            # The body still has whatever the previous tip gave it. Reported
            # because a feature that cannot be measured while the body still
            # can is a different failure from both of them going dark.
            attempt["bodyVolume"] = _vol(body)
            try:
                attempt["state"] = [str(x) for x in p.State]
            except Exception:
                pass
        tried.append(attempt)
        if v is None:
            continue
        if before is None or abs(v - before) > 1e-6:
            after, used = v, {"mode": mode, prop.lower(): round(value, 6)}
            break
        # Readable but it changed nothing. Keep it as a floor and try the
        # next reading -- a no-op is still worth reporting if it is all
        # this build can do, but it is not worth preferring.
        if fallback is None:
            fallback = (v, {"mode": mode, prop.lower(): round(value, 6)})
    if after is None and fallback is not None:
        after, used = fallback

    applied["Mode"] = (used or {}).get("mode")
    applied[prop] = (used or {}).get(prop.lower())

    if not p.isValid():
        _dress_failed(p, body, [f.Name for f in feats], kind + " pattern",
                      "Instances that overlap each other, or that fall off "
                      "the material entirely, will not build. Check the count "
                      "against the angle or the length.")
    if after is None:
        # isValid() said yes and the volume could not be read: the shape is
        # there in name only. Reporting a pattern here would hand the caller a
        # feature whose every downstream use fails somewhere else -- a boolean
        # complaining the base has no shape, a probe raising on Shape.Faces.
        raise KoiOpError(
            "the %s pattern built an object whose shape cannot be measured "
            "under any reading of %s this build accepts, so it is broken "
            "however it reports. Features attached to %s: %s. Modes offered: "
            "%s. Applied: %s. Tried: %s. The per-attempt 'why' says whether "
            "the shape is null or the access raised; a bodyVolume equal to "
            "volumeBefore means the feature errored and the body fell back to "
            "its previous tip. Otherwise check that the instances do not "
            "overlap each other and that the axis is the one you meant."
            % (kind, prop, originals_prop, ", ".join(originals) or "none",
               ", ".join(modes) or "none", _json.dumps(applied, default=str),
               _json.dumps(tried)))
    register(doc, kid, p, args.get("turn"))
    out = {"name": p.Name, "kind": kind, "count": count,
           "features": [f.Name for f in feats], "applied": applied,
           "volume": after, "volumeBefore": before,
           "volumeDelta": None if (before is None or after is None)
                          else round(after - before, 6),
           "modeUsed": (used or {}).get("mode"),
           "modesOffered": modes}
    if len(tried) > 1:
        # Which reading answered is not trivia: it is the difference between
        # Angle meaning the sweep and Angle meaning the step, and a caller
        # who edits this feature later needs to know which number they are
        # looking at.
        out["modesTried"] = tried
    out.update(detail)
    if before is not None and after is not None and abs(after - before) < 1e-6:
        # The failure this whole module exists for: FreeCAD is happy, the
        # solid did not change, and a screenshot cannot tell you either.
        out["note"] = (
            "this pattern changed nothing -- the instances landed on top of "
            "the original, or outside the material. It recomputes clean and "
            "reports valid, so believe this number over the state flags.")
    return out


MIRROR_NORMALS = {"XY": (0, 0, 1), "XZ": (0, 1, 0), "YZ": (1, 0, 0)}


def _op_mirror(doc, args, kid):
    target = _resolve_or_die(doc, _need(args, "target"), "target")
    plane = str(args.get("plane") or "XY").upper()
    n = MIRROR_NORMALS.get(plane)
    if n is None:
        raise KoiOpError("plane must be XY, XZ or YZ, not %r"
                         % (args.get("plane"),))
    base = _xyz(args.get("base") or [0, 0, 0], "base")
    before = _vol(target)
    m = doc.addObject("Part::Mirroring", _safe_name(kid, "Mirror"))
    m.Source = target
    m.Normal = App.Vector(*n)
    m.Base = App.Vector(*base)
    m.Label = str(args.get("label") or kid)
    register(doc, kid, m, args.get("turn"))
    doc.recompute()
    after = _vol(m)
    if after is None:
        raise KoiOpError(
            "the mirror of %s produced no shape; Part::Mirroring needs a "
            "source with a solid shape" % target.Name)
    out = {"name": m.Name, "plane": plane, "base": base, "source": target.Name,
           "volume": after, "volumeSource": before}
    if before is not None and abs(after - before) > 1e-6:
        # A mirror is a rigid motion. A volume that moved means the source was
        # not what we mirrored -- usually a link or a group, not a solid.
        out["note"] = ("the mirror's volume (%.3f) differs from its source's "
                       "(%.3f); check that %s is a single solid"
                       % (after, before, target.Name))
    return out


# ---------- primitive solids ----------


PRIMITIVES = {
    "box": ("Part::Box", ("Length", "Width", "Height")),
    "cylinder": ("Part::Cylinder", ("Radius", "Height")),
    "sphere": ("Part::Sphere", ("Radius",)),
    "cone": ("Part::Cone", ("Radius1", "Radius2", "Height")),
}


def _op_primitive(doc, args, kid):
    """A box, cylinder, sphere or cone as a document-level solid.

    Added because 'boolean' needs two solids and the whitelist could only make
    one by way of a Body, a sketch and a pad -- three calls, three ids and a
    feature tree, for a cutting cylinder that exists to be subtracted and then
    forgotten. A tool solid is not a designed feature and modelling it as one
    put the most common use of 'boolean' out of reach of the call channel.

    This is deliberately NOT a way to model parts: a Part::Box carries no
    sketch, no constraints and nothing to bind an expression to, so a design
    built from these is a design nobody can change later. Use it for tool
    solids and envelopes; use sketch + pad for anything the user will edit.
    """
    kind = str(args.get("kind") or "").strip().lower()
    entry = PRIMITIVES.get(kind)
    if entry is None:
        raise KoiOpError("kind must be one of %s, not %r"
                         % (", ".join(sorted(PRIMITIVES)), args.get("kind")))
    tid, props = entry
    obj = doc.addObject(tid, _safe_name(kid, kind.capitalize()))
    applied = {}
    for p in props:
        # d is the number on a drawing; Radius is the number in the API.
        if p == "Radius" and args.get("d") is not None:
            d, d_e = _numx(args, "d")
            applied[p] = _set_if(obj, p, d / 2.0)
            # Halved onto the radius the way a sketch circle's diameter is:
            # the caller said the bore is that alias, not half of it.
            if d_e and not _bind(obj, p, "(" + d_e + ") / 2"):
                raise KoiOpError(
                    "%s would not take the expression %r on %s"
                    % (obj.Name, d_e, p))
            continue
        key = p if args.get(p) is not None else p.lower()
        if args.get(key) is None:
            raise KoiOpError("a %s needs %s (got %s)"
                             % (kind, ", ".join(props), sorted(args)))
        dim = _set_dim(obj, p, args, key)
        applied[p] = dim if dim.get("expression") else True

    at = args.get("at") or [0, 0, 0]
    if not (isinstance(at, list) and len(at) == 3):
        raise KoiOpError("at must be [x, y, z]")
    obj.Placement.Base = App.Vector(*[float(x) for x in at])
    obj.Label = str(args.get("label") or kid)
    register(doc, kid, obj, args.get("turn"))
    doc.recompute()

    v = _vol(obj)
    if v is None or v <= 1e-9:
        raise KoiOpError(
            "the %s came out with no volume; check the dimensions" % kind)
    # A caller who asks for a d12 cylinder and reads the box back has to get 12.
    #
    # Neither of the easy answers gives that. Shape.BoundBox comes off the
    # tessellation. optimalBoundingBox() defaults to useTriangulation=True,
    # which is not the same thing but is still mesh-derived, and OCCT pads the
    # result so the box is guaranteed to contain the shape: on this build a d12
    # x 30 cylinder measured 12.087 x 12 x 30.087 — over, not under, and by
    # enough to fail a 0.05 check.
    #
    # optimalBoundingBox(False) computes from the exact geometry. Slower, and
    # the only one of the three that answers the question that was asked. The
    # via string names which one replied, so a build missing the exact path is
    # visible in the result rather than silently loose.
    bb, via = None, None
    for call, name in (
        (lambda: obj.Shape.optimalBoundingBox(False), "optimalBoundingBox(exact)"),
        (lambda: obj.Shape.optimalBoundingBox(), "optimalBoundingBox(tessellated)"),
        (lambda: obj.Shape.BoundBox, "boundBox"),
    ):
        try:
            bb, via = call(), name
            break
        except Exception:
            continue
    if bb is None:
        raise KoiOpError(
            "the %s built but no bounding box could be read from it" % kind)
    return {"name": obj.Name, "kind": kind, "applied": applied,
            "at": [round(float(x), 6) for x in at], "volume": v,
            "bbox": [round(bb.XLength, 6), round(bb.YLength, 6),
                     round(bb.ZLength, 6)], "bboxVia": via}


# ---------- booleans between bodies ----------

BOOL_TYPES = {"cut": "Part::Cut", "fuse": "Part::Fuse",
              "common": "Part::Common"}


def _op_boolean(doc, args, kid):
    """Cut, fuse or intersect two solids.

    PartDesign works inside one body; a housing minus its internals, or two
    bodies joined, is a document-level boolean and there was no way to ask for
    one. Measured rather than trusted, for the reason 6.5 exists: a cut that
    removes nothing recomputes clean and reports isValid().
    """
    op = str(args.get("op") or "cut").lower()
    tid = BOOL_TYPES.get(op)
    if tid is None:
        raise KoiOpError("op must be cut, fuse or common, not %r"
                         % (args.get("op"),))
    base = _resolve_or_die(doc, _need(args, "base"), "base object")
    tool = _resolve_or_die(doc, _need(args, "tool"), "tool object")
    if base.Name == tool.Name:
        raise KoiOpError("base and tool are the same object")
    v_base = _vol(base)
    v_tool = _vol(tool)
    if v_base is None or v_tool is None:
        raise KoiOpError(
            "a boolean needs two solids: %s has %s shape, %s has %s"
            % (base.Name, "a" if v_base is not None else "no",
               tool.Name, "a" if v_tool is not None else "no"))
    b = doc.addObject(tid, _safe_name(kid, op.capitalize()))
    b.Base = base
    b.Tool = tool
    b.Label = str(args.get("label") or kid)
    register(doc, kid, b, args.get("turn"))
    doc.recompute()
    if not b.isValid():
        _dress_failed(b, base, [tool.Name], op,
                      "Coplanar faces and zero-thickness contact are the "
                      "usual cause: overlap the tool slightly rather than "
                      "matching the face exactly.")
    after = _vol(b)
    out = {"name": b.Name, "op": op, "base": base.Name, "tool": tool.Name,
           "volume": after, "volumeBase": v_base, "volumeTool": v_tool,
           "volumeDelta": None if (after is None or v_base is None)
                          else round(after - v_base, 6)}
    if after is not None and v_base is not None:
        delta = after - v_base
        if op == "cut" and delta > -1e-6:
            out["note"] = ("this cut removed nothing -- the tool does not "
                           "overlap the base")
        elif op == "fuse" and delta < 1e-6:
            out["note"] = ("this fuse added nothing -- the tool is already "
                           "inside the base")
        elif op == "common" and after <= 1e-6:
            out["note"] = ("the intersection is empty -- these two solids do "
                           "not overlap")
    return out


def _op_shell(doc, args, kid):
    """Hollow a solid, opening the faces the USER picked.

    refs is required for the same reason fillet's is (8.1): the open face is a
    topological name, and one authored here renumbers under the next upstream
    edit into a different face of the same housing.
    """
    body = _resolve_body(doc, args.get("body"), args)
    owner, subs, _q = _dress_target(doc, body, args, "shell", "face")
    before = _vol(owner)
    th = body.newObject("PartDesign::Thickness", _safe_name(kid, "Thickness"))
    th.Base = (owner, subs)
    dim = _set_dim(th, "Value", args, "thickness", 2.0)
    if "reversed" in args:
        _set_if(th, "Reversed", bool(args["reversed"]))
    th.Label = str(args.get("label") or kid)
    register(doc, kid, th, args.get("turn"))
    doc.recompute()
    if not th.isValid():
        _dress_failed(th, owner, subs, "shell",
                      "A wall thinner than the smallest feature it has to "
                      "follow, or an opening on a filleted face, will not "
                      "build.")
    after = _vol(th)
    out = {"name": th.Name, "thickness": _plain(getattr(th, "Value", None)),
           "dimension": dim if dim.get("expression") else None,
           "faces": subs, "base": owner.Name, "volume": after,
           "volumeBefore": before,
           "volumeDelta": None if (before is None or after is None)
                          else round(after - before, 6)}
    if before is not None and after is not None and after >= before - 1e-6:
        out["note"] = ("this shell removed nothing; the wall may be thicker "
                       "than the part, or Reversed may be wrong")
    return out


# ---------- placement ----------


def _op_place(doc, args, kid):
    """Move or turn an existing object, and read the result back.

    Exposed because a co-design session that can create a part and cannot move
    it is not a co-design session: laying a bearing on a shaft, spacing an
    exploded view, seating a motor on a plate are all placement, and every one
    of them was a freecad_script call.
    """
    tgt = _resolve_or_die(doc, _need(args, "target"), "object")
    tid = str(getattr(tgt, "TypeId", ""))
    if tid.startswith("PartDesign::") and "Body" not in tid:
        raise KoiOpError(
            "%s is a %s -- a feature inside a body. Its position comes from "
            "its sketch's attachment and from the body's own placement, and "
            "writing Placement on it is discarded without an error. Place the "
            "body, or move the datum the sketch is attached to."
            % (tgt.Name, tid))
    before = _pos(tgt)
    at = args.get("at")
    rotate = args.get("rotate")
    if at is None and rotate is None:
        raise KoiOpError("place needs at:[x,y,z], rotate:{...}, or both")

    pl = tgt.Placement
    base = pl.Base
    rot = pl.Rotation
    if at is not None:
        xyz = _xyz(at, "at")
        if args.get("relative"):
            base = App.Vector(base.x + xyz[0], base.y + xyz[1],
                              base.z + xyz[2])
        else:
            base = App.Vector(*xyz)
    if rotate is not None:
        if not isinstance(rotate, dict):
            raise KoiOpError("rotate must be {axis: 'Z', angle: 120}")
        step = App.Rotation(_axis_vector(rotate.get("axis")),
                            float(_num(rotate, "angle", 0.0)))
        rot = step.multiply(rot) if args.get("relative") else step
    # One assignment, whole placement: the property returns a copy and writes
    # through it are dropped without an error.
    tgt.Placement = App.Placement(base, rot)
    doc.recompute()

    got = _pos(tgt)
    want = [round(base.x, 6), round(base.y, 6), round(base.z, 6)]
    if got is None or max(abs(a - b) for a, b in zip(got, want)) > 1e-6:
        raise KoiOpError(
            "the placement did not take: asked for %s, the document reads %s. "
            "On this build that usually means the object is attached to "
            "something and its position is owned by the attachment."
            % (want, got))
    return {"name": tgt.Name, "at": got, "wasAt": before,
            "rotation": [round(float(x), 6)
                         for x in tgt.Placement.Rotation.Q],
            "movedBy": None if before is None else
                       [round(got[i] - before[i], 6) for i in range(3)]}


# ---------- the bill of materials ----------


# ---------- material and mass ----------
#
# The BOM reported a mass for every purchased part, because the catalog
# carries one, and NOTHING for the bodies the design is actually made of --
# so the one column somebody asked for had a hole in it exactly where the
# machined parts were, and the honest note that said so was the whole answer.
#
# Mass is not an exotic property. It is volume, which is already measured
# exactly, times a density, which is a number off a datasheet. What was
# missing was somewhere to put the density.
#
# g/cm3, which is what datasheets quote and what makes the arithmetic
# checkable by eye: volume in mm3 divided by 1000, times this, is grams.

MATERIALS = {
    "aluminium-6061": {"density": 2.70, "note": "6061-T6, the default shop aluminium"},
    "aluminium-7075": {"density": 2.81, "note": "7075-T6, stronger, poor to weld"},
    "aluminium-cast": {"density": 2.66, "note": "A356 / LM25 casting alloy"},
    "steel-1018": {"density": 7.87, "note": "mild steel bar and plate"},
    "steel-4140": {"density": 7.85, "note": "alloy steel, shafts and fixtures"},
    "stainless-304": {"density": 7.90, "note": "austenitic, general corrosion service"},
    "stainless-316": {"density": 7.98, "note": "austenitic, marine and chemical"},
    "stainless-17-4": {"density": 7.75, "note": "precipitation hardening"},
    "cast-iron": {"density": 7.20, "note": "grey iron, machine bases"},
    "brass-360": {"density": 8.49, "note": "free-machining brass"},
    "bronze-932": {"density": 8.80, "note": "bearing bronze"},
    "copper": {"density": 8.96, "note": "electrical and thermal"},
    "titanium-6al4v": {"density": 4.43, "note": "grade 5"},
    "magnesium-az31": {"density": 1.77, "note": "light, flammable in chip form"},
    "zinc-zamak3": {"density": 6.60, "note": "die casting"},
    "abs": {"density": 1.04, "note": "printed or moulded"},
    "asa": {"density": 1.07, "note": "ABS with UV resistance"},
    "pla": {"density": 1.24, "note": "printed prototypes only"},
    "petg": {"density": 1.27, "note": "printed, tougher than PLA"},
    "nylon-pa12": {"density": 1.01, "note": "SLS and MJF"},
    "nylon-pa6": {"density": 1.14, "note": "cast and machined stock"},
    "polycarbonate": {"density": 1.20, "note": "guards and windows"},
    "acrylic": {"density": 1.18, "note": "PMMA, laser cut"},
    "pom-acetal": {"density": 1.41, "note": "Delrin, gears and bushings"},
    "ptfe": {"density": 2.20, "note": "seals, low friction"},
    "peek": {"density": 1.32, "note": "high temperature"},
    "hdpe": {"density": 0.95, "note": "tanks, wear strips"},
    "uhmw": {"density": 0.93, "note": "wear strips, chain guides"},
    "rubber-nbr": {"density": 1.20, "note": "gaskets and O-rings"},
    "epoxy-g10": {"density": 1.85, "note": "FR4 / G10 laminate"},
    "plywood": {"density": 0.60, "note": "birch, varies with species"},
    "glass": {"density": 2.50, "note": "soda-lime"},
}

MATERIAL_PREFIX = "koi.material."


def material_of(doc, obj):
    """The material record on an object, or None. Stored per object NAME.

    Per name rather than per koi id on purpose: an imported solid and a body
    the user made themselves both have a name and neither necessarily has an
    id, and a mass that only works for objects this session created is a mass
    that is missing exactly where a human would go looking for it.
    """
    if doc is None or obj is None:
        return None
    raw = _meta(doc).get(MATERIAL_PREFIX + obj.Name)
    if not raw:
        return None
    try:
        return _json.loads(raw)
    except Exception:
        return None


def mass_of(doc, obj):
    """Grams, or None. mm3 / 1000 * g/cm3."""
    rec = material_of(doc, obj)
    if not rec:
        return None
    vol = _vol(obj)
    if vol is None:
        return None
    try:
        return round(vol / 1000.0 * float(rec["density"]), 3)
    except Exception:
        return None


def _op_material(doc, args, kid):
    """Assign a density so a part has a mass.

    With no target it returns the table and writes nothing -- 'what densities
    do you know' is a question worth asking before deciding, and it should not
    cost a transaction.

    What this is NOT: a FreeCAD material assignment with appearance, thermal
    and structural cards. It is the one property that makes a BOM add up. If
    a session needs the rest, that is FreeCAD's own material editor and the
    human drives it.
    """
    if not args.get("target") and not args.get("targets") and not args.get("all"):
        return {"materials": MATERIALS, "count": len(MATERIALS),
                "note": "g/cm3. Pass target (or targets, or all:true) with "
                        "name, or with density for something not in this list."}

    raw = args.get("targets")
    if raw is None:
        raw = [args["target"]] if args.get("target") else []
    if not isinstance(raw, list):
        raise KoiOpError("targets must be a list")
    if args.get("all"):
        raw = [o.Name for o in doc.Objects[:2000]
               if o.TypeId == "PartDesign::Body" or _is_solidish(o)]
    if not raw:
        raise KoiOpError("nothing to assign a material to")
    if len(raw) > 200:
        raise KoiOpError("materials are capped at 200 objects per call")

    clearing = bool(args.get("clear")) or str(args.get("name") or "").lower() == "none"
    density = None
    name = None
    if not clearing:
        if args.get("density") is not None:
            density = float(args["density"])
            name = str(args.get("name") or "custom")
            if density <= 0 or density > 25:
                raise KoiOpError(
                    "density is g/cm3 and %r is not a material anybody has: "
                    "aluminium is 2.7, steel 7.87, and the densest thing on "
                    "this planet is under 23." % density)
        else:
            name = str(_need(args, "name")).strip().lower()
            rec = MATERIALS.get(name)
            if rec is None:
                near = [k for k in sorted(MATERIALS) if name.split("-")[0] in k]
                raise KoiOpError(
                    "no material %r. %s Pass density (g/cm3) for anything not "
                    "in the table -- and quote the datasheet rather than "
                    "recalling it."
                    % (name,
                       ("Did you mean: " + ", ".join(near) + ".") if near
                       else "Call fn 'material' with no target for the list."))
            density = float(rec["density"])

    rows = []
    total = 0.0
    for r in raw:
        o = _resolve_or_die(doc, r, "object")
        if clearing:
            _meta_set(doc, MATERIAL_PREFIX + o.Name, "")
            rows.append({"object": o.Name, "id": _id_of(doc, o.Name),
                         "material": None, "massG": None})
            continue
        _meta_set(doc, MATERIAL_PREFIX + o.Name,
                  _json.dumps({"name": name, "density": density}))
        vol = _vol(o)
        mass = mass_of(doc, o)
        row = {"object": o.Name, "id": _id_of(doc, o.Name), "label": o.Label,
               "material": name, "density": density,
               "volumeMm3": vol, "massG": mass}
        try:
            row["centerOfMass"] = _v3(o.Shape.CenterOfMass)
        except Exception:
            pass
        if mass is None:
            row["note"] = (
                "no volume to weigh: this object has no solid, so the density "
                "is stored and the mass is not a number yet")
        else:
            total += mass
        rows.append(row)

    out = {"assigned": rows, "count": len(rows),
           "totalMassG": round(total, 3) if not clearing else None}
    if not clearing:
        out["note"] = (
            "mass is volume times density and nothing else -- no fillet is "
            "estimated, no fastener is included, and a body that was never "
            "given a material still weighs nothing in the BOM.")
    return out


def bom(doc=None):
    """What this design is made of: bought parts with quantities, made parts.

    7.1 argues a component is an interface and metadata rather than a solid,
    and insert stores exactly that -- but nothing read it back out, so the MPN
    and the mass were write-only. Quantity counts App::Link instances,
    because that is what a pattern produces: one master and N links is one
    line of N, not N lines.
    """
    doc = doc or App.ActiveDocument
    if doc is None:
        return {"purchased": [], "fabricated": [], "totalMassG": None}

    # name -> how many links point at it, bounded like every other walk here
    inst = {}
    for o in doc.Objects[:2000]:
        if o.TypeId != "App::Link":
            continue
        try:
            linked = o.LinkedObject
        except Exception:
            continue
        if linked is not None:
            inst[linked.Name] = inst.get(linked.Name, 0) + 1

    purchased, total, unknown = [], 0.0, []
    for row in ids(doc)["ids"]:
        rec = component(row["id"], doc)
        if not rec or not row["present"]:
            continue
        meta = rec.get("meta") or {}
        qty = inst.get(row["name"], 0) or 1
        mass = meta.get("mass_g")
        # seated vs catalog-only. A line for a part that is in the document
        # but has never been put anywhere is a real BOM line and a different
        # claim, and the list read identically either way.
        obj = doc.getObject(row["name"])
        seated = inst.get(row["name"], 0) > 0
        if not seated and obj is not None:
            try:
                b = obj.Placement.Base
                seated = (abs(b.x) + abs(b.y) + abs(b.z)) > 1e-6
            except Exception:
                seated = False
        line = {"id": row["id"], "name": row["name"],
                "spec": rec.get("spec"), "kind": rec.get("kind"),
                "mpn": meta.get("mpn"), "qty": qty,
                "role": "seated" if seated else "catalog-only",
                "massEachG": mass,
                "massTotalG": None if mass is None else round(mass * qty, 3)}
        if mass is None:
            unknown.append(row["id"])
        else:
            total += mass * qty
        purchased.append(line)

    sources = _split_sources(doc)
    fabricated = []
    omitted = []
    no_material = []
    fab_total = 0.0
    fab_mass = 0.0
    for o in doc.Objects[:2000]:
        if o.TypeId != "PartDesign::Body":
            continue
        if component(_id_of(doc, o.Name) or "", doc):
            continue
        row = {"name": o.Name, "label": o.Label,
               "id": _id_of(doc, o.Name),
               "qty": inst.get(o.Name, 0) or 1,
               "role": "part", "volumeMm3": _vol(o)}
        # The column that used to be empty for every part anybody makes.
        mrec = material_of(doc, o)
        row["material"] = (mrec or {}).get("name")
        row["massEachG"] = mass_of(doc, o)
        if o.Name in sources:
            # The solid the halves were cut out of. Still needed to re-split,
            # never made, and the same material as both halves: listing it as
            # a third part is how a two-part assembly billed for three.
            row["role"] = "split-source"
            row["madeAs"] = "split into halves; not fabricated as one piece"
            omitted.append(o.Name)
        else:
            fab_total += (row["volumeMm3"] or 0.0) * (row["qty"] or 1)
            if row["massEachG"] is None:
                no_material.append(row["id"] or o.Name)
            else:
                row["massTotalG"] = round(row["massEachG"] * (row["qty"] or 1), 3)
                fab_mass += row["massTotalG"]
        fabricated.append(row)

    out = {"purchased": purchased, "fabricated": fabricated,
           "fabricatedVolumeMm3": round(fab_total, 3),
           "fabricatedMassG": round(fab_mass, 3),
           "purchasedMassG": round(total, 3) if purchased else 0.0,
           "totalMassG": round(total + fab_mass, 3)}
    notes = []
    if no_material:
        # The honest version of the hole this used to have. A part with no
        # density is not a part that weighs nothing.
        out["noMaterialFor"] = no_material
        notes.append(
            "%s have no material, so they contribute NOTHING to the mass "
            "total -- that total is not the weight of this design until they "
            "do. fn 'material' assigns one" % ", ".join(no_material[:12]))
    if unknown:
        # Said rather than silently summed: a total that quietly omits three
        # parts is worse than no total.
        out["massUnknownFor"] = unknown
        notes.append("the mass total excludes %s -- their catalog entry "
                     "carries no mass_g" % ", ".join(unknown))
    if omitted:
        out["notFabricated"] = omitted
        notes.append("%s is role split-source: it is the solid the halves "
                     "were cut from, is not a part anybody makes, and is not "
                     "in fabricatedVolumeMm3" % ", ".join(omitted))
    if notes:
        out["note"] = " ".join(notes)
    return out


def _op_recompute(doc, args, kid):
    """Force a rebuild, and optionally refine what the booleans left behind.

    Two things nothing else could ask for. A document can sit touched-but-not
    -rebuilt, or land in an error state that a plain edit will not clear, and
    the only move available was delete-and-rebuild -- which throws away the
    DAG to fix a stale flag.

    refine:true sets Refine on every feature that has the property and rebuilds.
    That is what removes the coplanar splitter edges a boolean leaves across a
    face: deepLint reports them as sliver faces, exports carry them into the
    next CAD, and nothing in this file could do anything about them.

    Refining must not change the volume -- it removes edges, not material --
    so the volume before and after are both reported and a difference is
    called out rather than left for somebody to notice.
    """
    targets = args.get("targets")
    if targets is not None and not isinstance(targets, list):
        raise KoiOpError("targets must be a list")
    objs = None
    if targets:
        objs = [_resolve_or_die(doc, t, "object") for t in targets[:200]]

    def snapshot(items):
        rows = {}
        for o in items:
            try:
                rows[o.Name] = {
                    "volume": _vol(o),
                    "faces": len(o.Shape.Faces) if getattr(o, "Shape", None) else None,
                    "edges": len(o.Shape.Edges) if getattr(o, "Shape", None) else None,
                }
            except Exception:
                rows[o.Name] = {"volume": None, "faces": None, "edges": None}
        return rows

    watched = objs if objs is not None else [
        o for o in doc.Objects[:2000] if _is_solidish(o)]
    before = snapshot(watched)
    errs_before = [o.Name for o in doc.Objects[:2000]
                   if "Invalid" in (getattr(o, "State", None) or [])]
    touched_before = [o.Name for o in doc.Objects[:2000]
                      if "Touched" in (getattr(o, "State", None) or [])]

    refined = []
    if args.get("refine"):
        scope = objs if objs is not None else list(doc.Objects[:2000])
        expanded = []
        for o in scope:
            expanded.append(o)
            # A Body's features are where Refine actually lives; naming the
            # body and having nothing happen is the silent no-op this file
            # exists to stop shipping.
            for c in (getattr(o, "Group", None) or []):
                expanded.append(c)
        for o in expanded[:2000]:
            if not hasattr(o, "Refine"):
                continue
            try:
                if o.Refine is not True:
                    o.Refine = True
                    refined.append(o.Name)
            except Exception:
                continue
        if not refined:
            # Reported, not raised: everything already refined is a fine
            # state to be in, and it is not the same as the property not
            # existing on this build.
            pass

    if args.get("touch"):
        for o in (objs if objs is not None else doc.Objects[:2000]):
            try:
                o.touch()
            except Exception:
                continue

    force = bool(args.get("force"))
    try:
        doc.recompute(objs, force)
    except TypeError:
        doc.recompute()

    after = snapshot(watched)
    errs_after = [o.Name for o in doc.Objects[:2000]
                  if "Invalid" in (getattr(o, "State", None) or [])]
    touched_after = [o.Name for o in doc.Objects[:2000]
                     if "Touched" in (getattr(o, "State", None) or [])]

    changed = []
    volume_moved = []
    for name, b in before.items():
        a = after.get(name) or {}
        if b.get("faces") != a.get("faces") or b.get("edges") != a.get("edges"):
            changed.append({"object": name,
                            "faces": [b.get("faces"), a.get("faces")],
                            "edges": [b.get("edges"), a.get("edges")]})
        bv, av = b.get("volume"), a.get("volume")
        if bv is not None and av is not None and abs(bv - av) > 1e-6:
            volume_moved.append({"object": name, "volume": [bv, av],
                                 "delta": round(av - bv, 6)})

    out = {"recomputed": True, "force": force,
           "scope": [o.Name for o in objs] if objs is not None else "document",
           "errorsBefore": errs_before, "errorsAfter": errs_after,
           "touchedBefore": len(touched_before), "touchedAfter": len(touched_after),
           "topologyChanged": changed[:32]}
    if refined:
        out["refined"] = refined[:64]
        out["refinedCount"] = len(refined)
        removed = sum((c["faces"][0] or 0) - (c["faces"][1] or 0)
                      for c in changed if c["faces"][0] and c["faces"][1])
        out["facesRemoved"] = removed
        out["refineNote"] = (
            "Refine removes the coplanar splitter edges a boolean leaves "
            "behind. It is a property on the features, so it stays on and "
            "applies to every later rebuild -- this is not a one-off cleanup.")
    if volume_moved:
        # The measurement that makes refine safe to run. Refining changes
        # topology, never material; if the volume moved, something else did.
        out["volumeChanged"] = volume_moved[:16]
        out["volumeChangedNote"] = (
            "the volume moved during this recompute. A refine cannot do that "
            "-- it removes edges, not material -- so something else rebuilt "
            "differently. Do not report this as a clean cleanup; measure "
            "before trusting the model.")
    fixed = [n for n in errs_before if n not in errs_after]
    broke = [n for n in errs_after if n not in errs_before]
    if fixed:
        out["errorsCleared"] = fixed
    if broke:
        out["errorsIntroduced"] = broke
        out["errorsIntroducedNote"] = (
            "these were healthy before the recompute and are in error after "
            "it. A forced rebuild does not create geometry problems; it "
            "reveals ones the stale flags were hiding.")
    return out


CAP_MODULES = (
    "Part", "PartDesign", "Sketcher", "Spreadsheet", "Import", "Mesh",
    "Draft", "Assembly", "TechDraw", "Material", "BOPTools", "importDXF",
    "importSVG", "MeshPart", "Fem", "Path",
    # CAM. Listed as the dotted paths rather than as "Path", because "Path
    # imports" and "the CAM operations import" are different facts and the
    # second one is the one a cam call depends on. The workbench was
    # PathScripts before 1.0 and the operation modules moved with it, so both
    # spellings are asked about and the answer says which one this build has.
    "Path.Main.Job", "Path.Op.Profile", "Path.Op.Pocket", "Path.Op.Drilling",
    "Path.Op.Adaptive", "Path.Tool.Controller", "Path.Post.Command",
    "PathScripts.PathJob",
    # FEM. Same reasoning: "Fem imports" and "a solve can run here" are
    # different facts. ObjectsFem builds the objects, gmshtools meshes and
    # ccxtools solves -- and the last two shell out to gmsh and ccx, which are
    # separate programs that a container carrying the workbench often does not
    # have. fn 'fem' reports the binaries; this reports the Python side.
    "ObjectsFem", "femmesh.gmshtools", "femtools.ccxtools",
)


def _op_capabilities(doc, args, kid):
    """What this FreeCAD can actually do, asked rather than assumed.

    K0 says every claim this skill makes is a claim about one build. This is
    the op that lets a session check one before making it -- and it exists
    right now for a specific reason: the Assembly workbench in 1.0+ carries a
    real constraint solver, this skill positions parts instead, and wiring
    joints means writing against an API whose spelling is not the same in
    every build. Nothing here guesses at that spelling. It reports what the
    interpreter exposes so the next patch can be written against a fact.
    """
    import importlib
    mods = {}
    for name in CAP_MODULES:
        row = {"available": False}
        try:
            m = importlib.import_module(name)
            row["available"] = True
            v = getattr(m, "__version__", None) or getattr(m, "Version", None)
            if isinstance(v, str):
                row["version"] = v
            f = getattr(m, "__file__", None)
            if f:
                row["file"] = str(f)
        except Exception as e:
            row["error"] = type(e).__name__
        mods[name] = row

    out = {"modules": mods, "gui": Gui is not None,
           "freecad": App.ConfigGet("ExeVersion"),
           "build": App.ConfigGet("BuildRevisionHash")}

    if mods.get("Assembly", {}).get("available"):
        try:
            import Assembly
            names = sorted(n for n in dir(Assembly) if not n.startswith("_"))
            out["assemblyApi"] = names[:64]
        except Exception:
            pass
        for extra in ("JointObject", "UtilsAssembly"):
            try:
                m = __import__(extra)
                out.setdefault("assemblyHelpers", {})[extra] = sorted(
                    n for n in dir(m) if not n.startswith("_"))[:48]
            except Exception:
                out.setdefault("assemblyHelpers", {})[extra] = None
    if doc is not None:
        try:
            types = [t for t in doc.supportedTypes()
                     if t.startswith("Assembly::") or t.startswith("TechDraw::")]
            out["documentTypes"] = sorted(types)[:48]
        except Exception:
            out["documentTypes"] = None

    out["note"] = (
        "available means importable in THIS interpreter, which is the only "
        "thing that matters and is not the same as installed. A module that "
        "imports is still not a scripted workflow: assembly joints and "
        "TechDraw drawings are NOT wired into this skill, and importing "
        "Assembly does not make them so. Say what is here rather than what "
        "the workbench menu shows.")
    return out


def _op_bom(doc, args, kid):
    return bom(doc)


# ---------- documents ----------


def _op_new_document(args, kid):
    """Create a document and make it active.

    Outside the envelope, because a transaction belongs to a document and
    there is none to open one on until this has run. It also takes the
    baseline: a document created this turn has by definition not been changed
    by the user behind our back, and without that the stale gate would refuse
    the first edit ever made.
    """
    name = _safe_name(args.get("name") or kid or "Design", "Design")
    existed = name in App.listDocuments()
    if existed and args.get("reuse") is False:
        raise KoiOpError(
            "a document named %r is already open; pass a different name, or "
            "leave reuse alone to keep working in it" % name)
    doc = App.getDocument(name) if existed else App.newDocument(name)
    # Undo has to be on BEFORE the first transaction or the envelope's abort
    # has nothing to abort and one Ctrl+Z does not put the edit back.
    try:
        doc.UndoMode = 1
    except Exception:
        pass
    try:
        App.setActiveDocument(doc.Name)
    except Exception:
        pass
    if Gui is not None:
        # A new document is the one moment the camera is nobody's yet, so
        # framing it here is not taking it off the human. The window-raising
        # and the redraw are the shared helpers: the hand-rolled version this
        # replaces tested 'QtGui' in globals(), which is never true in this
        # module, so its MDI branch never ran.
        try:
            Gui.setActiveDocument(doc.Name)
        except Exception:
            pass
        _raise_document_window(doc)
        try:
            gdoc = Gui.activeDocument()
            view = gdoc.activeView() if gdoc is not None else None
            if _is_3d_view(view):
                view.viewAxonometric()
                view.fitAll()
        except Exception:
            pass
        _gui_sync(doc)
    if args.get("label"):
        doc.Label = str(args["label"])
    observe(doc)
    # sorted(...) over the KEYS: listDocuments() returns a dict of
    # name -> Document, and handing Document objects to json.dumps raises
    # inside the rendezvous, after the work is already done -- the op
    # succeeds and reports nothing, which is worse than failing.
    return {"name": doc.Name, "label": doc.Label, "created": not existed,
            "reused": existed, "undoMode": _plain(getattr(doc, "UndoMode", None)),
            "documents": sorted(App.listDocuments())}


def _bbox_union(boxes):
    """One box around several. An App::Part has no Shape of its own, so the
    bbox of a grouped import has to come from what is inside it -- and
    reporting None there reads as "no geometry", which is the one thing an
    import must never say when it worked."""
    live = [b for b in boxes if b]
    if not live:
        return None
    lo = [min(b[0][i] for b in live) for i in range(3)]
    hi = [max(b[1][i] for b in live) for i in range(3)]
    return [[round(v, 3) for v in lo], [round(v, 3) for v in hi]]


def _op_open_document(args, kid):
    """Open an FCStd from disk and adopt it.

    Outside the envelope for the same reason new_document is: a transaction
    belongs to a document, and there is not one to open it on yet. It takes
    the baseline too -- a document opened this turn has by definition not been
    changed behind our back since we read it.

    The koi ids come back with it. register() writes into doc.Meta, which is
    saved inside the FCStd, so reopening a file this skill built restores every
    id: turn 7 of a session next week can still edit what turn 3 built. A
    document that was NOT built here has no ids at all, and the reply says so
    rather than letting a later call fail one reference at a time.
    """
    import os
    path = _resolve_in_roots(_need(args, "path"), (".fcstd",), True, "path")

    doc = None
    reused = False
    for name in App.listDocuments():
        d = App.getDocument(name)
        try:
            fn = _real(str(d.FileName)) if d.FileName else None
        except Exception:
            fn = None
        if fn and fn == path:
            # Already open. Opening it twice gives two documents holding one
            # design and a human who cannot tell which window is real.
            doc = d
            reused = True
            break
    if doc is None:
        doc = App.openDocument(path)

    try:
        doc.UndoMode = 1
    except Exception:
        pass
    try:
        App.setActiveDocument(doc.Name)
    except Exception:
        pass
    if Gui is not None:
        try:
            Gui.setActiveDocument(doc.Name)
        except Exception:
            pass
        _raise_document_window(doc)
        try:
            gdoc = Gui.activeDocument()
            view = gdoc.activeView() if gdoc is not None else None
            if _is_3d_view(view) and args.get("fit") is not False:
                view.viewAxonometric()
                view.fitAll()
        except Exception:
            pass
        _gui_sync(doc)
    observe(doc)

    known = ids(doc)
    errors = [o.Name for o in doc.Objects
              if getattr(o, "State", None) and "Invalid" in o.State][:16]
    out = {"name": doc.Name, "label": doc.Label,
           "fileName": str(getattr(doc, "FileName", "") or "") or None,
           "opened": not reused, "reused": reused,
           "objects": len(doc.Objects),
           "idCount": len(known["ids"]),
           "ids": known["ids"][:64],
           "revertedAiObjects": known["revertedAiObjects"],
           "documents": sorted(App.listDocuments()),
           "sizeBytes": (os.path.getsize(path) if os.path.isfile(path) else None)}
    if errors:
        out["recomputeErrors"] = errors
        out["recomputeNote"] = (
            "%d object(s) came off disk in an error state. That is how the "
            "file was saved, not something this session did -- say so before "
            "editing, and do not report the document as healthy."
            % len(errors))
    if not known["ids"]:
        out["idNote"] = (
            "nothing in this document carries a koi id: it was not built "
            "through this skill. Address objects by Name or Label, and note "
            "that an id only exists for what this session creates."
        )
    return out


def _op_save(args, kid):
    """Write the human's document to its own file.

    This is the one op that touches the file the human opened, so it is not
    something to do on a hunch: ask, or do it because they asked. It exists
    because the alternative was worse -- before it, forty AI-authored
    transactions lived only in RAM and the FCStd on disk was whatever it was
    an hour ago, with export as the only way out and export deliberately
    writing somewhere else.

    With no path it saves in place, which needs the document to have a file
    already. With a path it is Save As, and Save As REBINDS the document: every
    later save goes to the new file. That is what the caller asked for, and the
    reply says it happened in those words.
    """
    import os
    doc = (App.getDocument(str(args["document"])) if args.get("document")
           else App.ActiveDocument)
    if doc is None:
        raise KoiOpError("no document to save")
    before = str(getattr(doc, "FileName", "") or "")

    if args.get("path"):
        path = _resolve_in_roots(args["path"], (".fcstd",), False, "path")
        if os.path.isfile(path) and args.get("overwrite") is not True:
            raise KoiOpError(
                "%s already exists. Pass overwrite:true if replacing it is "
                "what you meant -- this is the human's filesystem, and a save "
                "that lands on an existing file is not recoverable from here."
                % path)
        doc.saveAs(path)
        did = "saveAs"
    else:
        if not before:
            raise KoiOpError(
                "this document has never been saved, so there is no file to "
                "save it to. Pass path (a .FCStd under a directory this "
                "session may write), or ask the human to File > Save As once.")
        doc.save()
        path = before
        did = "save"

    after = str(getattr(doc, "FileName", "") or "")
    size = 0
    try:
        size = os.path.getsize(after or path)
    except Exception:
        pass
    if size <= 0:
        raise KoiOpError("the save wrote no bytes to %s" % (after or path))
    out = {"path": after or path, "bytes": size, "action": did,
           "name": doc.Name, "touched": bool(getattr(doc, "Modified", False)),
           "rebound": after != before,
           "previousFile": before or None}
    if out["rebound"]:
        out["reboundNote"] = (
            "this document now saves to %r instead of %r. Every File > Save "
            "the human makes from here goes to the new file. Say so."
            % (after, before or "(nowhere -- it was unsaved)"))
    return out


def _op_import(doc, args, kid):
    """Bring foreign geometry in: a supplier STEP, a customer IGES, a BREP.

    What arrives is a SHAPE, and this is honest about that rather than
    pretending the tree came with it. There are no features, no sketches, no
    parameters and nothing to bind an expression to. It is exactly as editable
    as a casting somebody handed you: you can measure it, interfere against it,
    cut with it and place it, and to change it you go back to whoever made it.

    Which is also why it is worth having. The purchased-part model in this
    skill is an interface and an envelope, and that is the right thing to
    DESIGN against -- but at some point somebody has to check that the real
    connector shell clears the real boss, and no envelope answers that.
    """
    import os
    path = _resolve_in_roots(_need(args, "path"), IMPORT_EXTS, True, "path")
    fmt = OPEN_FORMATS[os.path.splitext(path)[1].lower()]

    before = set(o.Name for o in doc.Objects)
    if fmt in ("STEP", "IGES"):
        import Import
        Import.insert(path, doc.Name)
    else:
        import Part
        shape = Part.Shape()
        shape.read(path)
        obj = doc.addObject("Part::Feature", _safe_name(kid, "Imported"))
        obj.Shape = shape
    doc.recompute()
    added = [o for o in doc.Objects if o.Name not in before]
    if not added:
        raise KoiOpError(
            "%s imported without adding a single object. The file parsed and "
            "contained nothing this build could turn into geometry." % fmt)

    # More than one object is the normal case for a STEP assembly, and a
    # loose handful of solids in the document root is not addressable as the
    # one thing the caller asked for. An App::Part holds them, carries a
    # Placement so 'place' can move the lot, and is what the tree already
    # understands as a container.
    holder = added[0]
    grouped = False
    if len(added) > 1:
        holder = doc.addObject("App::Part", _safe_name(kid, "Imported"))
        for o in added:
            holder.addObject(o)
        grouped = True
        doc.recompute()

    holder.Label = str(args.get("label") or kid or os.path.basename(path))
    at = args.get("at")
    if at is not None:
        if not (isinstance(at, list) and len(at) == 3):
            raise KoiOpError("at must be [x, y, z]")
        holder.Placement.Base = App.Vector(float(at[0]), float(at[1]),
                                           float(at[2]))

    solids = 0
    volume = 0.0
    for o in added:
        try:
            solids += len(o.Shape.Solids)
            volume += o.Shape.Volume
        except Exception:
            continue

    _meta_set(doc, "koi.import." + str(kid), _json.dumps({
        "path": path, "format": fmt,
        "objects": [o.Name for o in added][:64],
        "grouped": grouped, "solids": solids,
    }))
    register(doc, kid, holder, args.get("turn"))
    doc.recompute()

    out = {"name": holder.Name, "format": fmt, "path": path,
           "objects": [o.Name for o in added][:64],
           "objectCount": len(added), "grouped": grouped,
           "solids": solids, "volume": round(volume, 6),
           "bbox": _bbox_union([_bbox_of(o) for o in added]),
           "note": (
               "imported geometry: a shape, not a feature tree. It has no "
               "sketches, no parameters and nothing to bind an expression "
               "to, so a change means a new file from whoever made it. "
               "Measure it and cut with it; do not try to edit it.")}
    if not solids:
        out["solidNote"] = (
            "this file arrived as surfaces or shells, with no closed solid. "
            "It will not boolean and it has no volume to interfere against -- "
            "say that rather than treating it as a part.")
    return out


def _id_of(doc, name):
    for row in ids(doc)["ids"]:
        if row["name"] == name:
            return row["id"]
    return None


def _registered_names(doc):
    return set(row["name"] for row in ids(doc)["ids"])


# Objects a Body brings with it. Reporting these as orphans would bury the one
# line that matters under eight that never mattered.
ORPHAN_NOISE = ("App::Origin", "App::Plane", "App::Line",
                "App::OriginGroupExtension")


def _flag_orphans(doc, res):
    """Name what a script created and did not register.

    8.5 says an object nobody can name in turn 7 is an object the next edit
    has to rebuild. freecad_call enforces that by refusing a creating call
    with no id -- but freecad_script is the channel that has to exist for
    everything the whitelist cannot say, and it had no equivalent. It still
    does not refuse (a script that computes a profile legitimately makes
    scaffolding), but it stops being silent.
    """
    if doc is None or not res.get("applied"):
        return res
    added = (res.get("diff") or {}).get("added") or []
    if not added:
        return res
    known = _registered_names(doc)
    orphans = []
    for name in added[:64]:
        if name in known:
            continue
        o = doc.getObject(name)
        if o is None or str(getattr(o, "TypeId", "")) in ORPHAN_NOISE:
            continue
        orphans.append({"name": name, "type": o.TypeId, "label": o.Label})
    if orphans:
        res["unregisteredObjects"] = orphans
        res["unregisteredNote"] = (
            "%d object(s) this script created carry no koi id, so a later "
            "turn cannot address them and will have to rebuild rather than "
            "edit. Register the ones that are real parts: "
            "koi.register(doc, 'pad.base', obj)."
            % len(orphans))
    return res


# ---------- designed overlap ----------
#
# "anything above zero means they cannot both exist" is true for a bracket and
# a motor, and false for every meshing gear pair, press fit and tapped hole in
# the domain this skill is aimed at. Left alone, the first gearbox turns
# interference permanently red and the check stops being read -- which is
# worse than not having it, because a real clash then arrives in a list the
# user has learned to skip.
#
# So an overlap can be declared, with a bound and a reason, and it is stored
# on the document rather than in the session: the declaration is a design
# decision, and it has to survive the turn that made it. Anything past the
# bound is still a hit. An allowance is a stated tolerance, not a mute button.

ALLOW_PREFIX = "koi.allow."


def _allow_key(a, b):
    return "|".join(sorted([str(a), str(b)]))


def allowances(doc=None):
    doc = doc or App.ActiveDocument
    out = {}
    if doc is None:
        return out
    for k, v in _meta(doc).items():
        if not k.startswith(ALLOW_PREFIX):
            continue
        try:
            out[k[len(ALLOW_PREFIX):]] = _json.loads(v)
        except Exception:
            continue
    return out


def _op_allow(doc, args, kid):
    """Declare that a pair is designed to overlap, up to a bound."""
    raw = args.get("pairs")
    if not raw and args.get("a") and args.get("b"):
        raw = [[args["a"], args["b"]]]
    if not isinstance(raw, list) or not raw:
        raise KoiOpError("pairs must be [[a, b], ...] (or pass a and b)")
    if len(raw) > 64:
        raise KoiOpError("allow is capped at 64 pairs per call")
    clear = bool(args.get("clear"))
    up_to = args.get("upTo")
    why = str(args.get("why") or "").strip()
    if not clear and not why:
        raise KoiOpError(
            "why is required: an allowance without a reason is an unexplained "
            "exception, and the next turn cannot tell it from a mistake")
    done = []
    for p in raw:
        if not (isinstance(p, list) and len(p) == 2):
            raise KoiOpError("each pair must be [a, b]")
        a = _resolve_or_die(doc, p[0], "object")
        b = _resolve_or_die(doc, p[1], "object")
        key = _allow_key(a.Name, b.Name)
        if clear:
            m = _meta(doc)
            m.pop(ALLOW_PREFIX + key, None)
            try:
                doc.Meta = m
            except Exception:
                pass
            done.append({"pair": [a.Name, b.Name], "cleared": True})
            continue
        rec = {"why": why}
        if up_to is not None:
            rec["upTo"] = round(float(up_to), 6)
        _meta_set(doc, ALLOW_PREFIX + key, _json.dumps(rec))
        done.append({"pair": [a.Name, b.Name], "upTo": rec.get("upTo"),
                     "why": why})
    return {"allowances": done, "stored": len(allowances(doc)),
            "note": ("an allowance bounds an overlap, it does not hide one: "
                     "anything past upTo is still reported as a hit")}


# ---------- seating a part in a hole ----------
#
# This is not an assembly mate and must not be described as one. The skill has
# no constraints and says so; what this removes is the ARITHMETIC a mate would
# have saved. A fastener from the table lands at the origin pointing +Z, and
# seating six of them in six counterbores was six hand-computed positions and
# two hand-written quaternions in the session that asked for this. None of
# that is design intent -- the intent is "this bolt goes in that hole" -- and
# every one of those numbers was a chance to be quietly wrong.
#
# Nothing is constrained afterwards. Move the plate and the bolt stays where
# it was. Every result says so.


def _scaled(v, k):
    # Vector.multiply mutates in place on this build, which turns "a point
    # along the axis" into "the axis, destroyed".
    return App.Vector(v.x * k, v.y * k, v.z * k)


def _rot_from_z(n):
    """A rotation taking +Z onto n, including the 180-degree case.

    App.Rotation(a, b) has to invent an axis when b is exactly -a, and what it
    invents has differed between builds -- an identity rotation in the worst
    of them, which seats a bolt pointing the wrong way and reports success. A
    hole cut downwards is not an edge case, so it is spelled out.
    """
    z = App.Vector(0, 0, 1)
    if z.dot(n) < -0.999999:
        return App.Rotation(App.Vector(1, 0, 0), 180)
    return App.Rotation(z, n)


def _profile_of(feat):
    p = getattr(feat, "Profile", None)
    if isinstance(p, (tuple, list)) and p:
        p = p[0]
    return p


def _global_placement(o):
    try:
        return o.getGlobalPlacement()
    except Exception:
        return o.Placement


def _sketch_circles(sk):
    """Global centres and diameters of the real circles in a sketch."""
    pl = _global_placement(sk)
    out = []
    for i, g in enumerate(getattr(sk, "Geometry", None) or []):
        if type(g).__name__ != "Circle":
            continue
        construction = False
        try:
            construction = bool(getattr(g, "Construction", False))
        except Exception:
            construction = False
        if not construction:
            try:
                construction = bool(sk.getConstruction(i))
            except Exception:
                pass
        if construction:
            continue
        try:
            c = pl.multVec(App.Vector(g.Center.x, g.Center.y, 0.0))
            out.append({"at": _vec3(c), "d": round(float(g.Radius) * 2.0, 6)})
        except Exception:
            continue
    return out, pl


def _pick_instance(circles, args, what):
    near = args.get("near")
    if near is not None:
        p = _xyz(near, "near")
        def _d2(c):
            return sum((c["at"][i] - p[i]) ** 2 for i in range(3))
        ranked = sorted(circles, key=_d2)
        if len(ranked) > 1 and abs(_d2(ranked[0]) - _d2(ranked[1])) < 1e-9:
            raise KoiOpError(
                "near %s is the same distance from two of them (%s and %s): "
                "name one exactly"
                % (p, ranked[0]["at"], ranked[1]["at"]))
        return ranked[0], [c for c in circles if c is not ranked[0]]
    if len(circles) == 1:
        return circles[0], []
    raise KoiOpError(
        "%s has %d instances and mate seats ONE part: pass near:[x, y, z] to "
        "say which. They are at %s -- and picking one by position is the "
        "point, an index into that list renumbers on the next recompute."
        % (what, len(circles), [c["at"] for c in circles]))


def _hole_axis_circles(doc, hole):
    """(outward axis, every hole instance, source) for a hole feature.

    Lifted out of _mate_frame because it was already computing all of this
    and then throwing every instance but one away. A pattern op needs the
    same read and must not be a second implementation of it -- two readings
    of "which way does this hole point" that can disagree is exactly the
    class of bug _ensure_cuts exists to catch.
    """
    feat = _resolve_or_die(doc, hole, "hole feature")
    sk = feat if "Sketch" in str(feat.TypeId) else _profile_of(feat)
    if sk is None:
        raise KoiOpError(
            "%s has no profile sketch, so there is no axis to read. Pass "
            "the sketch, or ref=<a cylindrical face>" % feat.Name)
    circles, pl = _sketch_circles(sk)
    if not circles:
        raise KoiOpError(
            "%s holds no circles, so there is no hole axis to read" % sk.Name)
    n = pl.Rotation.multVec(App.Vector(0, 0, 1))
    # A hole cuts AWAY from its sketch normal, so the head seats on the
    # +normal side. Read Reversed rather than assuming it: _ensure_cuts
    # flips the feature when the profile was on the wrong side, and a bolt
    # fitted to the un-flipped answer points into thin air.
    if bool(getattr(feat, "Reversed", False)):
        n = n.negative()
    return _unit(n), circles, "sketch:" + sk.Name


def _mate_frame(doc, args):
    """(outward axis, seat point, diameter) for whatever the caller named.

    Two sources, and the sketch is the good one: a hole's profile sketch IS
    the face the head seats on, its normal IS the hole axis and its circles
    ARE where the holes are. Hunting for the right cylinder in the finished
    solid means choosing one of three per hole -- counterbore, drill, tip --
    by index, which is what 8.1 bans.
    """
    hole = args.get("hole")
    ref = args.get("ref")
    if not hole and not ref:
        raise KoiOpError(
            "mate needs hole=<id of a hole, pocket or its profile sketch> or "
            "ref=<a cylindrical face the user picked>")
    if hole:
        axis, circles, source = _hole_axis_circles(doc, hole)
        chosen, others = _pick_instance(circles, args, source.split(":")[-1])
        return {"axis": axis, "at": chosen["at"], "d": chosen["d"],
                "source": source, "others": others,
                "instances": len(circles)}

    owner, sub_name = _resolve_ref_sub(doc, ref)
    if not sub_name or _kind_of(sub_name) != "Face":
        raise KoiOpError(
            "ref must name a FACE, e.g. a captured pick or 'Pad:Face7', not %r"
            % (ref,))
    ss = _sub_shape(owner.Shape, sub_name)
    surf = getattr(ss, "Surface", None)
    if type(surf).__name__ != "Cylinder":
        raise KoiOpError(
            "%s is a %s, not a cylinder: mate reads the axis off the bore"
            % (ref, type(surf).__name__))
    ax = App.Vector(surf.Axis.x, surf.Axis.y, surf.Axis.z).normalize()
    c = surf.Center
    pts = [App.Vector(v.X, v.Y, v.Z) for v in (ss.Vertexes or [])]
    if not pts:
        pts = [ss.CenterOfMass]
    ts = [(p - c).dot(ax) for p in pts]
    # Which end of the bore is the mouth is a fact about where the material
    # is, and nothing in the face itself settles it -- so the far end along
    # the axis is the default and flip is the other one, said out loud.
    t = min(ts) if args.get("flip") else max(ts)
    out_v = ax.negative() if args.get("flip") else ax
    seat = App.Vector(c.x + ax.x * t, c.y + ax.y * t, c.z + ax.z * t)
    return {"axis": _unit(out_v), "at": _vec3(seat),
            "d": round(float(surf.Radius) * 2.0, 6),
            "source": "face:" + owner.Name + ":" + sub_name, "others": [],
            "instances": 1,
            "note": "the seat is the end of the bore at %s along its axis; "
                    "pass flip:true for the other end" % _vec3(seat)}


def _mate_fit(doc, pid, hole_d):
    """Does the bolt this names actually pass through the hole it names."""
    rec = component(str(pid), doc) if pid else None
    if not rec or hole_d is None:
        return None
    size = rec.get("size")
    if not size:
        return None
    try:
        d = fastener(size)["d"]
    except Exception:
        return None
    out = {"shankDiameter": d, "holeDiameter": hole_d,
           "diametralClearance": round(hole_d - d, 6)}
    if hole_d < d - 1e-6:
        out["fitNote"] = (
            "the %s shank is %g and this hole is %g: the bolt does not pass "
            "through it. Seated anyway -- say so rather than reporting an "
            "assembly" % (size, d, hole_d))
    return out


def _op_mate(doc, args, kid):
    tgt = _resolve_or_die(doc, _need(args, "target"), "object")
    tid = str(getattr(tgt, "TypeId", ""))
    if tid.startswith("PartDesign::") and "Body" not in tid:
        raise KoiOpError(
            "%s is a %s -- a feature inside a body. Its position comes from "
            "its sketch's attachment, and a Placement written on it is "
            "discarded without an error. Mate the body." % (tgt.Name, tid))
    frame = _mate_frame(doc, args)
    axis = frame.get("axis")
    if not axis:
        raise KoiOpError("could not read an axis from %s" % frame["source"])
    n = App.Vector(*axis)
    if args.get("flip") and frame["source"].startswith("sketch:"):
        n = n.negative()
    seat = frame["at"]
    offset = float(args.get("offset") or 0.0)
    base = App.Vector(seat[0] + n.x * offset, seat[1] + n.y * offset,
                      seat[2] + n.z * offset)
    rot = _rot_from_z(n)
    spin = args.get("spin")
    if spin is not None:
        rot = App.Rotation(n, float(spin)).multiply(rot)
    tgt.Placement = App.Placement(base, rot)
    doc.recompute()

    got = _pos(tgt)
    want = [round(base.x, 6), round(base.y, 6), round(base.z, 6)]
    if got is None or max(abs(a - b) for a, b in zip(got, want)) > 1e-6:
        raise KoiOpError(
            "the placement did not take: asked for %s, the document reads %s. "
            "On this build that usually means the object is attached to "
            "something and its position is owned by the attachment."
            % (want, got))
    # Read the part's own axis back out of the document rather than trusting
    # the rotation we just wrote: this is the whole claim the op is making.
    seated = _unit(tgt.Placement.Rotation.multVec(App.Vector(0, 0, 1)))
    out = {"name": tgt.Name, "at": got, "axis": _vec3(n),
           "seatedAxis": seated,
           "alignedWithAxis": bool(_same_dir(seated, _vec3(n), 1e-4)),
           "seat": seat, "from": frame["source"], "offset": offset,
           "instances": frame.get("instances"),
           "rotation": [round(float(x), 6) for x in tgt.Placement.Rotation.Q]}
    if frame.get("others"):
        out["otherInstances"] = [c["at"] for c in frame["others"]][:16]
    fit = _mate_fit(doc, args.get("target"), frame.get("d"))
    if fit:
        out.update(fit)
    notes = [n_ for n_ in (frame.get("note"),) if n_]
    notes.append(
        "this is a placement, not a mate: nothing constrains it afterwards, "
        "and an edit that moves %s will leave %s where it is"
        % (frame["source"].split(":")[-1], tgt.Name))
    out["note"] = " ".join(notes)
    return out


FASTENER_PATTERN_LIMIT = 32


def _seat_offset(doc, hole_ref):
    """How far along the axis a head has to drop to sit in its counterbore.

    Zero for a plain hole. For a counterbored one the depth is a property of
    the feature that cut it, so nobody should have to measure their own model
    and hand the number back to it.
    """
    if not hole_ref:
        return 0.0, "none"
    try:
        feat = _resolve_or_die(doc, hole_ref, "hole feature")
    except KoiOpError:
        return 0.0, "none"
    cut = str(getattr(feat, "HoleCutType", "") or "")
    if "Counterbore" not in cut and "Counterdrill" not in cut:
        return 0.0, "none"
    try:
        depth = float(getattr(feat, "HoleCutDepth", 0.0))
    except Exception:
        return 0.0, "none"
    if depth <= 1e-9:
        return 0.0, "none"
    return -round(depth, 6), "counterbore"


def _op_fastener_pattern(doc, args, kid):
    """One fastener per instance of a hole pattern, inserted and seated.

    The arithmetic 'mate' removes, times the number of holes. Seating four
    faceplate bolts and two pinch bolts was six 'insert' calls and six 'mate'
    calls carrying six hand-written near:[x, y, z] triples -- twelve
    operations and twelve chances to transpose a sign -- when the hole feature
    already knew where all six of them were and 'mate' was already reading
    every one of them before discarding five.

    One master and N links, like polar_array and for the same reason: cost is
    driven by unique parts, and the BOM reads a pattern as one line of N
    rather than N lines of one.
    """
    size = str(_need(args, "fastener"))
    length = float(_num(args, "length", 16.0))
    axis, circles, source = _hole_axis_circles(doc, _need(args, "hole"))
    if len(circles) > FASTENER_PATTERN_LIMIT:
        raise KoiOpError(
            "%s has %d instances, over the %d-fastener bound for one call; "
            "a pattern that large is a real request but has to be asked for "
            "deliberately" % (source, len(circles), FASTENER_PATTERN_LIMIT))
    # Sorted, so instance 3 is the same hole on the next run: the iteration
    # order of Sketch.Geometry is not a design intent and is not stable.
    circles = sorted(circles,
                     key=lambda c: (c["at"][0], c["at"][1], c["at"][2]))

    n = App.Vector(*axis)
    if args.get("flip"):
        n = n.negative()
    rot = _rot_from_z(n)
    if args.get("spin") is not None:
        rot = App.Rotation(n, float(args["spin"])).multiply(rot)
    # A head sitting proud of a counterbored face is the default nobody
    # wants, and the depth is already in the document. Read it rather than
    # asking for it again.
    offset_from = "argument"
    if args.get("offset") is None:
        offset, offset_from = _seat_offset(doc, args.get("hole"))
    else:
        offset = float(args["offset"])
    seats = [App.Vector(c["at"][0] + n.x * offset,
                        c["at"][1] + n.y * offset,
                        c["at"][2] + n.z * offset) for c in circles]

    spec = _fastener_spec(size, length)
    master = build_envelope(spec, _safe_name(kid, "Part"), doc)
    master.Label = str(args.get("label") or spec.get("id"))
    master.Placement = App.Placement(seats[0], rot)
    # HIDDEN. The master was left visible at seat 0 and a link was put at seat
    # 0 as well, so the first bolt of every pattern was two bolts in the same
    # hole -- visible in the tree, doubled on screen, and kept by isolate. It
    # is the definition the links point at, not an instance.
    try:
        master.Visibility = False
    except Exception:
        pass

    grp = doc.addObject("App::DocumentObjectGroup",
                        _safe_name(str(kid) + "_set", "FastenerSet"))
    grp.Label = str(args.get("label") or kid)
    links = []
    for i, seat in enumerate(seats):
        lnk = doc.addObject("App::Link",
                            _safe_name("%s_%d" % (kid, i), "Link"))
        lnk.LinkedObject = master
        # The whole Placement in one assignment: mutating through the
        # property writes to a copy and drops the move, which produces a
        # pattern stacked on its master with no error.
        lnk.Placement = App.Placement(seat, rot)
        grp.addObject(lnk)
        links.append(lnk.Name)

    published = publish_interface(kid, _spec_interface_values(spec), doc)
    _meta_set(doc, "koi.part." + str(kid), _json.dumps({
        "spec": spec.get("id"), "kind": spec.get("kind"),
        "meta": spec.get("meta") or {}, "aliases": published,
        "size": (spec.get("meta") or {}).get("size"),
        "bolts": ((spec.get("interfaces") or {}).get("bolts") or {}),
    }))
    register(doc, kid, master, args.get("turn"))
    register(doc, str(kid) + ".set", grp, args.get("turn"))
    doc.recompute()

    placed = [_pos(doc.getObject(nm)) for nm in links]
    want = [[round(s.x, 6), round(s.y, 6), round(s.z, 6)] for s in seats]
    for got, expect in zip(placed, want):
        if got is None or max(abs(a - b) for a, b in zip(got, expect)) > 1e-6:
            raise KoiOpError(
                "the fastener placements did not take: asked for %s, the "
                "document reads %s" % (want[:3], placed[:3]))
    seated = _unit(master.Placement.Rotation.multVec(App.Vector(0, 0, 1)))
    shaped = sum(1 for nm in links if _vol(doc.getObject(nm)) is not None)
    shank = fastener(size)["d"]
    tight = min(c["d"] for c in circles)
    out = {"name": master.Name, "group": grp.Name, "count": len(circles),
           "links": links, "spec": spec.get("id"), "aliases": published,
           "at": want, "axis": _vec3(n), "seatedAxis": seated,
           "alignedWithAxis": bool(_same_dir(seated, _vec3(n), 1e-4)),
           "from": source, "offset": offset, "offsetFrom": offset_from,
           "withShape": shaped, "masterHidden": not _visible(master),
           "instances": links,
           "shankDiameter": shank, "tightestHoleDiameter": tight,
           "diametralClearance": round(tight - shank, 6),
           "note": "one HIDDEN master and %d visible links, so seat 0 holds "
                   "one bolt and the BOM reads this as one line of %d. These "
                   "are placements and not mates: nothing constrains them, "
                   "and an edit that moves the plate will leave them where "
                   "they are. isolate the group (%s) to frame the set."
                   % (len(circles), len(circles), str(kid) + ".set")}
    if shaped != len(links):
        out["shapeNote"] = (
            "%d of %d links expose no shape, so interference and clearance "
            "cannot see them" % (len(links) - shaped, len(links)))
    # The fit check 'mate' does, run against the TIGHTEST hole rather than
    # one of them: a pattern is seated only if every instance passes.
    if tight < shank - 1e-6:
        out["fitNote"] = (
            "the %s shank is %g and the tightest hole in this pattern is %g: "
            "it does not pass through. Seated anyway -- say so rather than "
            "reporting an assembly" % (size, shank, tight))
    return out


# ---------- splitting one solid into two parts ----------


def _split_plane(doc, args):
    """(point, unit normal, name, offset, expression, datum) for the cutting plane.

    offset takes an expression like every other dimension on this surface. It
    cannot be BOUND -- the halves are snapshots and there is no feature to
    hang a binding on -- but refusing to evaluate it meant the one dimension
    that decides where a part is cut in two was the one that had to be typed
    as a literal next to a sheet that already held it.
    """
    plane = args.get("plane") or "XY"
    offset, offset_expr = (0.0, None)
    if args.get("offset") is not None:
        offset, offset_expr = _numx(args, "offset")
    word = str(plane).upper()
    if word in ("XY", "XZ", "YZ"):
        n = {"XY": App.Vector(0, 0, 1), "XZ": App.Vector(0, 1, 0),
             "YZ": App.Vector(1, 0, 0)}[word]
        return _scaled(n, offset), n, word, offset, offset_expr, None
    owner, _sub = _resolve_ref_sub(doc, plane)
    if owner is None:
        raise KoiOpError(
            "plane must be XY, XZ, YZ or the id of a datum plane, not %r"
            % (plane,))
    pl = _global_placement(owner)
    n = pl.Rotation.multVec(App.Vector(0, 0, 1))
    b = pl.Base
    return (App.Vector(b.x + n.x * offset, b.y + n.y * offset,
                       b.z + n.z * offset), n, owner.Name, offset, offset_expr, owner)


def _half_space_span(shape):
    bb = shape.BoundBox
    return max(bb.XLength, bb.YLength, bb.ZLength, 1.0) * 4.0 + 10.0


def _half_space_placement(shape, point, normal, sign, gap, span=None):
    if span is None:
        span = _half_space_span(shape)
    bb = shape.BoundBox
    try:
        u = App.Vector(normal.x, normal.y, normal.z).normalize()
    except Exception:
        raise KoiOpError("the split plane has no usable normal")
    n = _scaled(u, sign)
    c = bb.Center
    d = (c.x - point.x) * u.x + (c.y - point.y) * u.y + (c.z - point.z) * u.z
    on_plane = App.Vector(c.x - u.x * d, c.y - u.y * d, c.z - u.z * d)
    base = App.Vector(on_plane.x + n.x * (gap / 2.0),
                      on_plane.y + n.y * (gap / 2.0),
                      on_plane.z + n.z * (gap / 2.0))
    box = App.Placement(App.Vector(-span / 2.0, -span / 2.0, 0.0), App.Rotation())
    return App.Placement(base, _rot_from_z(n)).multiply(box)


def _half_space(shape, point, normal, sign, gap, span=None):
    """A box big enough to be a half-space for this shape, on one side.

    Centred on the SOLID and not on the plane's own origin. The first version
    of this centred the box on the plane's own point, which for XY/XZ/YZ is
    the world origin plus an offset along one axis -- so a bar 200 mm out in
    X, split on XZ, got a half-space sitting at x=0 that missed it entirely
    and reported the side as empty. The plane is infinite; the box standing in
    for it has to cover the shape, wherever the shape is.
    """
    import Part
    bb = shape.BoundBox
    L = max(bb.XLength, bb.YLength, bb.ZLength, 1.0) * 4.0 + 10.0
    try:
        u = App.Vector(normal.x, normal.y, normal.z).normalize()
    except Exception:
        raise KoiOpError("the split plane has no usable normal")
    n = _scaled(u, sign)
    # The shape's centre dropped onto the plane: the lateral origin the box
    # has to be built around.
    c = bb.Center
    d = (c.x - point.x) * u.x + (c.y - point.y) * u.y + (c.z - point.z) * u.z
    on_plane = App.Vector(c.x - u.x * d, c.y - u.y * d, c.z - u.z * d)
    base = App.Vector(on_plane.x + n.x * (gap / 2.0),
                      on_plane.y + n.y * (gap / 2.0),
                      on_plane.z + n.z * (gap / 2.0))
    box = Part.makeBox(L, L, L, App.Vector(-L / 2.0, -L / 2.0, 0.0))
    # Composed rather than assigned: whether makeBox put the corner into the
    # geometry or into the placement differs between builds, and composing is
    # correct under both.
    box.Placement = App.Placement(base, _rot_from_z(n)).multiply(box.Placement)
    return box


def _body_from_shape(doc, name, shape, label=None):
    """A PartDesign Body holding an existing solid -- or a plain feature, and
    the truth about which.

    PartDesign::FeatureBase is how the GUI's "make a body from this solid"
    works, and it is what makes the half a real Body that pads and pockets can
    be added to. It is also the piece most likely to differ between builds, so
    it is attempted, measured and abandoned rather than assumed.
    """
    made = []
    why = None
    try:
        body = doc.addObject("PartDesign::Body", _safe_name(name, "Body"))
        made.append(body)
        base = doc.addObject("PartDesign::FeatureBase",
                             _safe_name(str(name) + "_base", "Base"))
        made.append(base)
        base.Shape = shape
        body.Group = list(getattr(body, "Group", [])) + [base]
        body.BaseFeature = base
        body.Tip = base
        doc.recompute()
        v = _vol(body)
        want = round(shape.Volume, 6)
        if v is not None and abs(v - want) <= max(1e-6, abs(want) * 1e-6):
            if label:
                body.Label = str(label)
            return body, True, None
        why = "the Body read back %r where the half measures %g" % (v, want)
    except Exception as e:
        why = "%s: %s" % (type(e).__name__, e)
    for o in reversed(made):
        try:
            doc.removeObject(o.Name)
        except Exception:
            pass
    obj = doc.addObject("Part::Feature", _safe_name(name, "Solid"))
    obj.Shape = shape
    if label:
        obj.Label = str(label)
    return obj, False, why


def _remove_subtree(doc, obj, gone=None, depth=0):
    """Remove an object and the scaffolding it owns.

    doc.removeObject on a PartDesign Body takes the Body and leaves its
    FeatureBase and its Origin behind as orphans -- which is how a replaced
    split half left half of itself in the tree.
    """
    gone = [] if gone is None else gone
    if obj is None or depth > 4:
        return gone
    kids = list(getattr(obj, "Group", []) or [])[:64]
    kids += list(getattr(obj, "OriginFeatures", []) or [])[:16]
    for g in kids:
        if g is None or getattr(g, "Name", None) in gone:
            continue
        _remove_subtree(doc, g, gone, depth + 1)
    try:
        name = obj.Name
        doc.removeObject(name)
        gone.append(name)
    except Exception:
        pass
    return gone


def _split_half_work(o):
    """Features somebody added to a split half after it was cut.

    Not _dependents: a Body owns its features through Group, so nothing
    downstream shows up in the Body's InList and a half carrying a pocket, a
    hole and two sketches looked exactly as free to delete as an untouched
    one.
    """
    out = []
    if "PartDesign::Body" in str(getattr(o, "TypeId", "")):
        for g in list(getattr(o, "Group", []) or [])[:200]:
            gt = str(getattr(g, "TypeId", ""))
            if gt == "PartDesign::FeatureBase" or "Origin" in gt:
                continue
            if gt.startswith("PartDesign::") or gt.startswith("Sketcher::"):
                out.append(g.Name)
    out.extend(_dependents(o))
    return sorted(set(out))


def _prior_split(doc, kid, kids):
    """The halves an earlier run of THIS split left in the document."""
    seen, out = set(), []
    names = []
    raw = _meta(doc).get(SPLIT_PREFIX + str(kid))
    if raw:
        try:
            names = list((_json.loads(raw) or {}).get("names") or [])
        except Exception:
            names = []
    for ref in list(names) + [str(k) for k in kids]:
        o = doc.getObject(str(ref)) or resolve(doc, str(ref))
        if o is not None and o.Name not in seen:
            seen.add(o.Name)
            out.append(o)
    return out


def _purge_stale_split_records(doc, kid, src_name, names, ids):
    """Drop split records that this split supersedes.

    Records are keyed by kid, but _split_lint reads every one of them. A
    re-split under a NEW id therefore leaves the old record behind, still
    pointing at the same halves with the old source volume, and it reports
    split-stale forever -- on halves that are current, with no op able to
    clear it. Re-running split_body is the recovery this skill documents
    for split-stale, so the recovery was what created the fault.
    """
    cur = SPLIT_PREFIX + str(kid)
    mine = set(str(n) for n in (names or []))
    mine |= set(str(i) for i in (ids or []))
    purged = []
    for k in sorted(_meta(doc)):
        if not k.startswith(SPLIT_PREFIX) or k == cur:
            continue
        try:
            rec = _json.loads(_meta(doc)[k])
        except Exception:
            continue
        if str(rec.get("source") or "") != str(src_name):
            continue
        theirs = set(str(n) for n in (rec.get("names") or []))
        theirs |= set(str(i) for i in (rec.get("ids") or []))
        if not (theirs & mine):
            continue
        for nm in list(rec.get("cuts") or []) + list(rec.get("tools") or []):
            o = doc.getObject(str(nm))
            if o is not None:
                try:
                    _remove_subtree(doc, o)
                except Exception:
                    pass
        d = _meta(doc)
        d.pop(k, None)
        try:
            doc.Meta = d
        except Exception:
            pass
        _FALLBACK.get(doc.Name, {}).pop(k, None)
        purged.append(k)
    return purged


def _op_split_body(doc, args, kid):
    """Cut one solid into two parts, each in its own body.

    PartDesign refuses a feature whose result is more than one solid -- the
    clamp slit through a bore fails with "Result has multiple solids", which
    is not a mistake the caller made but the workbench saying this is two
    parts. So the split happens at document level and each half comes back as
    something features can be added to.

    The halves used to be snapshots, and that was the expensive part. Nothing
    bound them to the solid they came from, so a bolt clearance hole added to
    the main body three turns later did not reach them: lint said split-stale,
    the recovery was to split again, and the working rule became "split LAST"
    -- a scheduling constraint invented by this tool and obeyed by the human.

    They are live now. Each half is a Part::MultiCommon of the source and a
    half-space box, wrapped in a Body through PartDesign::FeatureBase, so the
    source is a LINK and the DAG recomputes both halves on every upstream
    edit. What that buys is the ordinary CAD expectation: edit the sketch,
    both halves follow. What it costs is said in the reply rather than
    discovered -- the source has to stay in the document, and a sketch on a
    FACE of a half is still attached by topological name and can still break
    when that face moves.

    live:false asks for the old snapshot, and a build that will not make the
    chain falls back to one and says which of the two you got.
    """
    src = _resolve_or_die(doc, _need(args, "target"), "solid")
    shape = getattr(src, "Shape", None)
    if shape is None or shape.isNull() or shape.Volume <= 1e-9:
        raise KoiOpError("%s has no solid shape to split" % src.Name)
    point, normal, plane_name, offset, offset_expr, datum = _split_plane(doc, args)
    gap, gap_expr = (0.0, None)
    if args.get("gap") is not None:
        gap, gap_expr = _numx(args, "gap")
    if gap < 0:
        raise KoiOpError("gap is the width of the cut and cannot be negative")

    kids = args.get("ids")
    if kids is None:
        kids = [str(kid) + ".a", str(kid) + ".b"]
    if not (isinstance(kids, list) and len(kids) == 2):
        raise KoiOpError(
            "ids must be [idA, idB] -- this makes two objects and each one "
            "needs a handle a later turn can edit")
    labels = args.get("labels") or [None, None]
    if not (isinstance(labels, list) and len(labels) == 2):
        raise KoiOpError("labels must be [labelA, labelB]")

    # Re-splitting is the documented recovery for split-stale, so it has to
    # REPLACE. It did not: the same ids registered onto fresh objects, the old
    # pair stayed in the document as body_faceplate001 / body_main001, labels
    # uniquified StemBody -> StemBody001, the BOM listed both generations and
    # the fabricated volume roughly doubled. Cleanup was a hand delete of an
    # unnamed pair. A recovery path that forks the assembly is not one.
    prior = [o for o in _prior_split(doc, kid, kids) if o.Name != src.Name]
    recreate = bool(args.get("recreate"))
    forced = bool(args.get("force"))

    prec = {}
    try:
        prec = _json.loads(_meta(doc).get(SPLIT_PREFIX + str(kid)) or "{}") or {}
    except Exception:
        prec = {}
    ptools = [str(x) for x in (prec.get("tools") or [])] + [None, None]
    pcuts = [str(x) for x in (prec.get("cuts") or [])] + [None, None]

    v0 = round(shape.Volume, 6)
    want_live = args.get("live") is None or bool(args.get("live"))
    span = _half_space_span(shape)
    # An expression can be BOUND to the cut only when the plane is one of the
    # three world planes, because then the offset is exactly one component of
    # the box's own Placement. A datum plane carries the offset inside its own
    # attachment and the box would have to be attached to it to follow; that
    # is not done, so lint watches the datum instead (split-plane-moved).
    axis = {"XY": "z", "XZ": "y", "YZ": "x"}.get(plane_name)
    off_s, gap_s = _expr_of(offset, offset_expr), _expr_of(gap, gap_expr)
    pieces = []
    for sign, side in ((1.0, "a"), (-1.0, "b")):
        piece = shape.common(_half_space(shape, point, normal, sign, gap, span))
        vol = 0.0
        try:
            vol = piece.Volume
        except Exception:
            vol = 0.0
        if vol <= 1e-9:
            raise KoiOpError(
                "side %s of the plane is empty: %s spans %s and the plane at "
                "%s does not pass through it. Move it with offset."
                % (side, src.Name, _vec3(shape.BoundBox.Center),
                   _vec3(point)))
        expr = None
        if offset_expr or gap_expr:
            expr = off_s
            if gap > 0 or gap_expr:
                expr = off_s + (" + " if sign > 0 else " - ") + gap_s + " / 2"
        pieces.append((side, piece,
                       _half_space_placement(shape, point, normal, sign, gap,
                                             span),
                       expr))

    out = {"plane": plane_name, "gap": gap, "offset": offset,
           "source": src.Name, "normal": _vec3(normal),
           "sourceVolume": v0, "asBodies": True, "live": want_live,
           "halves": [], "sides": {}}
    if offset_expr:
        out["offsetExpression"] = offset_expr
    if gap_expr:
        out["gapExpression"] = gap_expr

    replaced = []
    if recreate and prior:
        carrying = [(o.Name, _split_half_work(o)) for o in prior]
        carrying = [(n, w) for n, w in carrying if w]
        if carrying and not forced:
            raise KoiOpError(
                "this split has already been run and its halves carry work: %s. "
                "Recreating drops them. Pass force:true or omit recreate to update in-place."
                % "; ".join("%s (%s)" % (n, ", ".join(w[:6])) for n, w in carrying))
        for o in prior:
            _remove_subtree(doc, o, replaced)
        for nm in list(pcuts[:2]) + list(ptools[:2]):
            o = doc.getObject(str(nm)) if nm else None
            if o is not None:
                _remove_subtree(doc, o, replaced)
        ptools, pcuts = [None, None], [None, None]
        if replaced:
            doc.recompute()
        prior = []

    total = 0.0
    tools_created = []
    cuts_created = []
    for (side, piece, plc, expr), skid, lbl, ptool, pcut in zip(pieces, kids, labels, ptools, pcuts):
        existing = doc.getObject(str(skid)) or resolve(doc, str(skid))
        is_body = True
        why = None
        obj = None
        if existing is not None and not recreate:
            obj = existing
            if "PartDesign::Body" in str(getattr(obj, "TypeId", "")):
                base = getattr(obj, "BaseFeature", None)
                if base is None or "FeatureBase" not in str(getattr(base, "TypeId", "")):
                    for g in list(getattr(obj, "Group", []) or []):
                        if "FeatureBase" in str(getattr(g, "TypeId", "")):
                            base = g
                            break
                if base is not None:
                    base.Shape = piece
                    if lbl:
                        obj.Label = str(lbl)
                    doc.recompute()
                    try:
                        base.purgeTouched()
                    except Exception:
                        pass
                    is_body = True
                else:
                    is_body = False
                    why = "existing body has no FeatureBase"
            elif hasattr(obj, "Shape"):
                obj.Shape = piece
                if lbl:
                    obj.Label = str(lbl)
                doc.recompute()
                is_body = False
            else:
                is_body = False
                why = "existing object is not a Body or Shape"
        else:
            obj, is_body, why = _body_from_shape(doc, skid, piece, lbl)
            register(doc, skid, obj, args.get("turn"))

        v = _vol(obj)
        total += v or 0.0
        which = "positive" if side == "a" else "negative"
        drawn_info = _drawn(doc, obj)
        row = {"side": side, "of": which, "id": skid, "name": obj.Name,
               "body": is_body, "volume": v, "solids": len(piece.Solids),
               "bbox": _bbox_of(obj), "drawn": drawn_info["drawn"]}
        if not is_body:
            out["asBodies"] = False
            row["why"] = why
        out["halves"].append(row)
        out["sides"][which] = {"id": skid, "name": obj.Name, "volume": v,
                               "bbox": row["bbox"], "drawn": drawn_info["drawn"]}

    # Recorded so the staleness of these halves becomes a measurement rather
    # than a sentence in one turn's reply. See _split_lint.
    _meta_set(doc, SPLIT_PREFIX + str(kid), _json.dumps({
        "source": src.Name, "sourceVolume": v0, "plane": plane_name,
        "gap": gap, "ids": list(kids),
        "names": [h["name"] for h in out["halves"]],
    }))

    superseded = _purge_stale_split_records(
        doc, kid, src.Name, [h["name"] for h in out["halves"]], kids)
    if superseded:
        out["supersededRecords"] = superseded

    if str(args.get("keep") or "hide") == "hide":
        hidden = []
        _hide(doc, src, hidden)
        out["hidSource"] = hidden
    doc.recompute()

    # A FeatureBase built by assignment reads Touched after the recompute that
    # made it, so every turn after a split carried two body_*_base touched
    # warnings that were never going to clear. Not wrong, and that is the
    # problem: they were the loudest thing in lint, and a removed-nothing on a
    # tapped hole arrived underneath them.
    for row in out["halves"]:
        o = doc.getObject(row["name"])
        if o is None:
            continue
        try:
            if hasattr(o, "Visibility"):
                o.Visibility = True
            if hasattr(o, "ViewObject") and o.ViewObject:
                o.ViewObject.Visibility = True
        except Exception:
            pass
        for x in [o] + list(getattr(o, "Group", []) or [])[:16]:
            try:
                if hasattr(x, "Visibility"):
                    x.Visibility = True
                if hasattr(x, "ViewObject") and x.ViewObject:
                    x.ViewObject.Visibility = True
            except Exception:
                pass
            try:
                x.purgeTouched()
            except Exception:
                pass

    if Gui and getattr(Gui, "ActiveDocument", None):
        try:
            av = getattr(Gui.ActiveDocument, "ActiveView", None)
            if av and hasattr(av, "fitAll"):
                av.fitAll()
        except Exception:
            pass

    out["volumeRemovedByCut"] = round(v0 - total, 6)
    if replaced:
        out["replaced"] = replaced
    out["updated"] = bool(prior and not recreate)
    notes = ["ids[0] (%s) is the half on the POSITIVE side of the plane "
             "normal %s; ids[1] (%s) is the negative side -- read sides.* "
             "rather than assuming an order"
             % (kids[0], _vec3(normal), kids[1])]
    notes.append(
        "these halves are snapshots of %s, not features of it: an "
        "upstream edit does not reach them and the split has to be "
        "made again -- so split LAST, and treat anything you build on a "
        "half as frozen" % src.Name)
    if out["updated"]:
        notes.append(
            "the existing halves were updated in place: their FeatureBase shapes "
            "were refreshed and downstream features were preserved and recomputed.")
    if replaced:
        notes.append(
            "this REPLACED the halves an earlier run of the same split left "
            "behind (%s): re-splitting reuses the ids rather than adding a "
            "second generation next to the first"
            % ", ".join(replaced[:6]))
    if not out["asBodies"]:
        notes.append(
            "this build would not take a PartDesign::FeatureBase, so the "
            "halves are plain solids: they can be moved, measured, booleaned "
            "and exported, but not padded or pocketed")
    if gap <= 0 and abs(out["volumeRemovedByCut"]) > max(1e-6, v0 * 1e-6):
        notes.append(
            "the halves do not add up to the original (%g vs %g) even though "
            "the cut has no width -- check the plane"
            % (total, v0))
    out["note"] = " ".join(notes)
    return out


# ---------- many calls, one transaction ----------

BATCH_LIMIT = 24

# Which ops bring an object into being, and therefore need an id of their own
# inside a batch. The dispatcher enforces this per call; a batch step never
# reaches the dispatcher.
# ---------- dimensional inspection between two things ----------
#
# freecad_measure answers questions about OBJECTS: volume, bbox, centre of
# mass, and the minimum distance between one part and another. The question an
# engineer actually asks all day is a level down from that and was not
# answerable at all: how far is this hole from that edge, are these two faces
# parallel, what is the angle of that chamfer, is this bore coaxial with that
# one. All of those are WITHIN a part, where the pair walk never looks.
#
# The whole argument of this skill is measure rather than look, and a
# screenshot cannot tell 12.0 from 12.4. So this is the missing instrument,
# and it is deliberately built on the two things that already exist: query
# finds the entity, ref captures it, and this measures between them.

ANGLE_TOL_DEG = 0.05
COAX_TOL = 1e-4


def _shape_of_ref(doc, r, what):
    """A ref id, an object:Sub pair or an object id -> (owner, sub, shape)."""
    owner, sub_name = _resolve_ref_sub(doc, r)
    if owner is None:
        raise KoiOpError("%s %r does not resolve to anything" % (what, r))
    shape = getattr(owner, "Shape", None)
    if shape is None:
        raise KoiOpError(
            "%s (%s) has no shape to measure. Datums and sketches are not "
            "measurable this way; measure the feature they made."
            % (owner.Name, owner.TypeId))
    if not sub_name:
        return owner, "", shape
    try:
        el = shape.getElement(sub_name)
    except Exception as e:
        raise KoiOpError(
            "%s has no element %r on this recompute (%s). Element names "
            "renumber -- re-run the query, or ask the user to pick it again."
            % (owner.Name, sub_name, type(e).__name__))
    return owner, sub_name, el


def _v3(v):
    return [round(v.x, 4), round(v.y, 4), round(v.z, 4)]


def _entity_geometry(shape):
    """What KIND of thing this is, and the numbers that define it.

    Reported for its own sake as well as for the pair: 'what is that circle'
    is a question with an exact answer, and reading a diameter off a render is
    how a 6.2 becomes a 6.
    """
    out = {}
    kind = shape.ShapeType if hasattr(shape, "ShapeType") else "?"
    out["shapeType"] = kind
    try:
        if kind == "Face":
            surf = shape.Surface
            sname = type(surf).__name__
            out["surface"] = sname
            out["area"] = round(shape.Area, 4)
            if sname == "Plane":
                out["normal"] = _v3(surf.Axis)
                out["position"] = _v3(surf.Position)
                out["direction"] = _v3(surf.Axis)
            elif sname in ("Cylinder", "Cone"):
                out["axis"] = _v3(surf.Axis)
                out["position"] = _v3(surf.Center)
                out["direction"] = _v3(surf.Axis)
                out["radius"] = round(float(surf.Radius), 4)
                out["diameter"] = round(float(surf.Radius) * 2.0, 4)
            elif sname == "Sphere":
                out["position"] = _v3(surf.Center)
                out["radius"] = round(float(surf.Radius), 4)
        elif kind == "Edge":
            curve = shape.Curve
            cname = type(curve).__name__
            out["curve"] = cname
            out["length"] = round(shape.Length, 4)
            if cname in ("Line", "LineSegment"):
                out["direction"] = _v3(curve.Direction)
                out["from"] = _v3(shape.Vertexes[0].Point)
                out["to"] = _v3(shape.Vertexes[-1].Point)
            elif cname in ("Circle", "ArcOfCircle"):
                c = curve.Center if hasattr(curve, "Center") else curve.Circle.Center
                ax = curve.Axis if hasattr(curve, "Axis") else curve.Circle.Axis
                rad = curve.Radius if hasattr(curve, "Radius") else curve.Circle.Radius
                out["center"] = _v3(c)
                out["position"] = _v3(c)
                out["axis"] = _v3(ax)
                out["direction"] = _v3(ax)
                out["radius"] = round(float(rad), 4)
                out["diameter"] = round(float(rad) * 2.0, 4)
        elif kind == "Vertex":
            out["point"] = _v3(shape.Point)
            out["position"] = _v3(shape.Point)
        else:
            if getattr(shape, "Volume", 0):
                out["volume"] = round(shape.Volume, 4)
            out["area"] = round(shape.Area, 4)
    except Exception:
        pass
    try:
        out["centerOfMass"] = _v3(shape.CenterOfMass)
    except Exception:
        pass
    return out


def _as_vec(seq):
    return App.Vector(float(seq[0]), float(seq[1]), float(seq[2]))


def _axis_distance(p1, d1, p2, d2):
    """Distance between two infinite lines: parallel, or skew, or crossing.

    This is the number a bore-to-bore dimension actually is. The minimum
    distance between the two cylindrical FACES is that number minus both
    radii, which is a different question and is also reported -- confusing
    them is how a wall thickness gets called a hole spacing.
    """
    delta = p2.sub(p1)
    cross = d1.cross(d2)
    if cross.Length < 1e-9:
        along = delta.dot(d1)
        perp = delta.sub(App.Vector(d1.x * along, d1.y * along, d1.z * along))
        return round(perp.Length, 4), True
    return round(abs(delta.dot(cross)) / cross.Length, 4), False


def _op_measure_between(doc, args, kid):
    """Measure between two entities, or report one exactly.

    Reads its refs the way fillet and chamfer do: a ref id captured from a
    user pick, an object:Sub pair from query, or a whole object. It never
    authors an index, and it says which recompute the numbers came from by
    failing loudly when an element name no longer resolves.
    """
    a_ref = _need(args, "a")
    owner_a, sub_a, sh_a = _shape_of_ref(doc, a_ref, "a")
    geo_a = _entity_geometry(sh_a)
    out = {"a": {"ref": str(a_ref), "object": owner_a.Name,
                 "element": sub_a or None, "geometry": geo_a}}
    stale_a = _tip_warning(owner_a)
    if stale_a:
        out["a"]["notTip"] = stale_a

    if args.get("b") is None:
        # One entity is a legitimate question: what IS that. A diameter read
        # off a picture is a diameter nobody should machine to.
        out["note"] = (
            "one entity measured. Pass b to get the distance, the angle and "
            "the axis relationship between two.")
        return out

    owner_b, sub_b, sh_b = _shape_of_ref(doc, args["b"], "b")
    geo_b = _entity_geometry(sh_b)
    out["b"] = {"ref": str(args["b"]), "object": owner_b.Name,
                "element": sub_b or None, "geometry": geo_b}
    stale_b = _tip_warning(owner_b)
    if stale_b:
        out["b"]["notTip"] = stale_b
    if stale_a or stale_b:
        out["notTipNote"] = (
            "at least one of these is a mid-tree feature rather than the "
            "finished solid, so the distance is between geometry as it was "
            "part-way through the build. Measure the body.")
    out["sameObject"] = owner_a.Name == owner_b.Name

    # -- the minimum gap. This is what a feeler gauge would read.
    try:
        dist, pts, _info = sh_a.distToShape(sh_b)
        out["minDistance"] = round(float(dist), 4)
        if pts:
            p1, p2 = pts[0][0], pts[0][1]
            out["closestPoints"] = [_v3(p1), _v3(p2)]
        out["touching"] = float(dist) <= 1e-7
    except Exception as e:
        out["minDistanceError"] = "%s: %s" % (type(e).__name__, e)

    # -- centre to centre, which is the dimension a drawing carries.
    ca = geo_a.get("center") or geo_a.get("position") or geo_a.get("centerOfMass")
    cb = geo_b.get("center") or geo_b.get("position") or geo_b.get("centerOfMass")
    if ca and cb:
        d = _as_vec(cb).sub(_as_vec(ca))
        out["centerDistance"] = round(d.Length, 4)
        out["centerDelta"] = [round(d.x, 4), round(d.y, 4), round(d.z, 4)]

    # -- direction: angle, parallel, perpendicular, coaxial.
    da, db = geo_a.get("direction"), geo_b.get("direction")
    if da and db:
        va, vb = _as_vec(da), _as_vec(db)
        try:
            ang = _math.degrees(va.getAngle(vb))
        except Exception:
            ang = None
        if ang is not None:
            out["angleDeg"] = round(ang, 4)
            # 179.97 degrees between two normals is two parallel faces
            # pointing away from each other, which is the normal way for a
            # plate's top and bottom to be reported. Saying "not parallel"
            # there would be true about the normals and wrong about the part.
            acute = min(ang, 180.0 - ang)
            out["angleBetweenDeg"] = round(acute, 4)
            out["parallel"] = acute <= ANGLE_TOL_DEG
            out["perpendicular"] = abs(acute - 90.0) <= ANGLE_TOL_DEG
        if ca and cb:
            axd, par = _axis_distance(_as_vec(ca), va, _as_vec(cb), vb)
            out["axisDistance"] = axd
            out["axesParallel"] = par
            out["coaxial"] = bool(par and axd <= COAX_TOL)
            ra, rb = geo_a.get("radius"), geo_b.get("radius")
            if ra is not None and rb is not None and par:
                out["wallBetween"] = round(axd - float(ra) - float(rb), 4)
                out["wallNote"] = (
                    "wallBetween is axisDistance minus both radii: the "
                    "material left between the two bores. Negative means they "
                    "break into each other.")
    if out.get("parallel") and out.get("minDistance") is not None:
        out["offset"] = out["minDistance"]
        out["offsetNote"] = (
            "these are parallel, so minDistance is the offset between them -- "
            "the number to quote for a wall thickness or a plate gap.")
    return out


CREATING_OPS = frozenset((
    "body", "sketch", "pad", "pocket", "hole", "bolt_sketch", "datum_plane",
    "fillet", "chamfer", "shell", "revolve", "groove", "mirror", "boolean",
    "primitive", "pattern", "polar_array", "link_array", "insert", "ref",
    "split_body", "fastener_pattern", "import_geometry",
))


def _op_batch(doc, args, kid):
    """Several whitelisted calls in one transaction and one round trip.

    The cost of this surface was never the geometry. A plate with a
    counterbored bolt pattern is a dozen calls, and each one is an LLM turn, a
    dispatch, a transaction, a recompute and a diff -- the session that asked
    for this spent twenty-five round trips on a two-part bracket. The envelope
    already serialises a list of writes correctly. It was simply never given
    one.

    Atomic, and that is the point: a step that raises propagates, the envelope
    aborts, and the document goes back to before the batch. Half a bolt
    pattern is not a state anybody asked for. The error names the step that
    failed and the ones that had already run.
    """
    steps = args.get("ops")
    if not isinstance(steps, list) or not steps:
        raise KoiOpError("ops must be a non-empty list of {fn, args, id}")
    if len(steps) > BATCH_LIMIT:
        raise KoiOpError(
            "a batch is capped at %d steps and this one has %d. Send the rest "
            "as a second batch -- a longer transaction is a longer freeze on "
            "the window the user is watching." % (BATCH_LIMIT, len(steps)))
    done = []
    for i, st in enumerate(steps):
        if not isinstance(st, dict):
            raise KoiOpError("ops[%d] must be an object {fn, args, id}" % i)
        fn = str(st.get("fn") or "")
        spec = OPS.get(fn)
        if spec is None:
            raise KoiOpError("ops[%d]: unknown fn %r; have %s"
                             % (i, fn, ", ".join(sorted(OPS))))
        if fn == "batch":
            raise KoiOpError("ops[%d]: batches do not nest" % i)
        if spec["mode"] == "document":
            raise KoiOpError(
                "ops[%d]: %r happens outside the envelope and cannot be a "
                "step. Create the document first, then batch the rest."
                % (i, fn))
        st_args = st.get("args")
        st_args = st_args if isinstance(st_args, dict) else {}
        st_id = st.get("id")
        if fn in CREATING_OPS and not st_id:
            raise KoiOpError(
                "ops[%d]: %r creates an object, so it needs an id -- a handle "
                "like 'pad.base' that turn 7 can edit" % (i, fn))
        try:
            res = spec["fn"](doc, st_args, st_id)
        except Exception as e:
            raise KoiOpError(
                "step %d of %d (%s%s) failed, so the whole batch was rolled "
                "back: %s: %s. Steps that had run: %s"
                % (i + 1, len(steps), fn,
                   " " + str(st_id) if st_id else "",
                   type(e).__name__, e,
                   ", ".join(d["fn"] for d in done) or "none"))
        done.append({"step": i, "fn": fn, "id": st_id, "result": res})
    return {"steps": done, "count": len(done),
            "note": "one transaction: the undo entry below covers all %d "
                    "steps" % len(done)}


# ---------- 15. manufacturability: DFM and CAM ----------
#
# Everything above this line answers "is the model what I meant". Nothing
# above it answers "can this be MADE", and those are different questions with
# different failure modes. A part can be dimensionally perfect, recompute
# clean, pass interference, and weigh exactly what the BOM says, and still be
# a shape no rotating cutter can produce. The internal corner with a zero
# radius is the canonical case: trivially valid geometry, and it does not
# exist in metal.
#
# Two layers, and the split is the one lint/deepLint already makes:
#
#   dfm()   Pure OCC. No CAM workbench, no toolpath, no post processor, and
#           therefore no dependency on how THIS build spells Path.Main.Job.
#           Internal corner radii, tool reach per setup direction, undercuts,
#           enclosed voids, hole depth ratios -- and the residual: the volume
#           of material a cutter of radius r cannot reach NO MATTER how many
#           axes the machine has. That last number is a lower bound on
#           unmachinability, and it is the definitive one.
#
#   cam     The real CAM workbench: a Job, a stock, a tool controller, the
#           operations, and the toolpaths they generate. An operation that
#           generates ZERO path commands is the workbench saying it could not
#           machine that feature with that tool -- feedback nothing in this
#           module could have derived on its own. Version-fragile by nature,
#           so the API is PROBED and the spelling it found is reported, the
#           same way capabilities does it.
#
# Neither is a substitute for a machinist. Both are things a tool can run,
# which is the whole point: a manufacturability claim that came out of a
# language model is a guess, and one that came out of an offset operation is
# a measurement.

CAM_AXES = {
    "+Z": (0.0, 0.0, 1.0), "-Z": (0.0, 0.0, -1.0),
    "+X": (1.0, 0.0, 0.0), "-X": (-1.0, 0.0, 0.0),
    "+Y": (0.0, 1.0, 0.0), "-Y": (0.0, -1.0, 0.0),
}

# Stock end mill diameters, mm. Same argument as drill_sizes(): a 4.7 mm
# corner radius is not a matter of taste, it is a tool nobody has.
ENDMILL_SIZES = (0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0,
                 10.0, 12.0, 16.0, 20.0, 25.0)

# Depth-to-diameter ratios past which a cut stops being routine. 3xD is a
# stock end mill; 5xD needs a long-reach or a necked tool and slower feeds;
# past that it is a conversation with the shop, not a CAD decision.
FLUTE_RATIO = 3.0
LONG_REACH_RATIO = 5.0
DRILL_DEPTH_RATIO = 5.0

# Budgets. Every check here scales with face count rather than object count,
# which is the same reason deepLint is opt-in. Exceeding a budget is reported
# as truncation, never as a pass -- a check that did not run is not a check
# that succeeded.
DFM_FACE_BUDGET = 240
DFM_EDGE_BUDGET = 1200
DFM_RAY_BUDGET = 900

DFM_PROCESSES = ("mill3axis", "mill5axis", "mill_any", "turn", "print_fdm")


def _unit_v(v):
    L = v.Length
    if L < 1e-12:
        return None
    return App.Vector(v.x / L, v.y / L, v.z / L)


def _axis_vec(name):
    t = CAM_AXES.get(str(name))
    if t is None:
        raise KoiOpError(
            "unknown axis %r; use one of %s"
            % (name, ", ".join(sorted(CAM_AXES))))
    return App.Vector(*t)


def _dfm_shape(o):
    try:
        s = o.Shape
    except Exception:
        return None
    if s is None or s.isNull():
        return None
    try:
        if s.Volume <= 1e-9:
            return None
    except Exception:
        return None
    return s


def _face_probe_point(f):
    """A point that is actually ON the face.

    CenterOfMass is off the surface for anything annular or L-shaped, and a
    ray cast from a point that is not on the part is a measurement of
    nothing that reports cleanly.
    """
    try:
        p = f.CenterOfMass
        if f.isInside(p, 1e-6, True):
            return p
    except Exception:
        pass
    try:
        u0, u1, v0, v1 = f.ParameterRange
        for du, dv in ((0.5, 0.5), (0.3, 0.3), (0.7, 0.7),
                       (0.3, 0.7), (0.7, 0.3)):
            p = f.valueAt(u0 + (u1 - u0) * du, v0 + (v1 - v0) * dv)
            if f.isInside(p, 1e-6, True):
                return p
    except Exception:
        pass
    try:
        return f.Vertexes[0].Point
    except Exception:
        return None


def _face_normal_at(f, p=None):
    """The RAW surface normal at a point on the face. Sign not yet decided.

    Deliberately does not touch f.Orientation. The first cut of this module
    flipped Reversed faces by hand, on the reasonable-sounding theory that
    normalAt() returns the surface normal rather than the face normal. It does
    not: normalAt() goes through BRepGProp_Face, which already applies the
    orientation, so the hand flip inverted every normal on the shape. The
    symptom was a plain rectangular plate reporting four SHARP INTERNAL
    CORNERS -- its four convex outside corners, read inside out -- and its top
    and bottom faces reported as unreachable from any direction.

    A convention that a build could change is a convention this module should
    not be reading. _outward_normal below measures the sign instead.
    """
    try:
        if p is None:
            u0, u1, v0, v1 = f.ParameterRange
            u, v = (u0 + u1) / 2.0, (v0 + v1) / 2.0
        else:
            u, v = f.Surface.parameter(p)
        n = App.Vector(f.normalAt(u, v))
    except Exception:
        return None
    return _unit_v(n)


def _step(p, n, d):
    return App.Vector(p.x + n.x * d, p.y + n.y * d, p.z + n.z * d)


def _face_sign(shape, f, p=None):
    """+1 if normalAt already points OUT of the material here, -1 if in.

    Two isInside calls at a point the face owns. Whichever side of the surface
    the solid is on is the inside, and that is a fact about this shape rather
    than a fact about how this build spells an enum. Costs about 0.5 ms a
    face, which is nothing next to the ray casting it feeds.

    None when both probes agree -- a step that landed inside on both sides is
    a thin wall or a point too near an edge, and a guess there would be a sign
    error in exactly the geometry that is hardest to check.
    """
    if p is None:
        p = _face_probe_point(f)
    if p is None:
        return None
    n = _face_normal_at(f, p)
    if n is None:
        return None
    for d in (1e-3, 1e-4, 1e-2):
        try:
            a = shape.isInside(_step(p, n, d), 1e-7, True)
            b = shape.isInside(_step(p, n, -d), 1e-7, True)
        except Exception:
            return None
        if a != b:
            return -1.0 if a else 1.0
    return None


def _outward_normal(shape, f, p=None):
    """(outward normal, point on the face, decided) for one face.

    The third element is False when the sign could not be measured. The caller counts
    those and says so rather than letting an undecided face quietly vote.
    """
    if p is None:
        p = _face_probe_point(f)
    if p is None:
        return None, None, False
    n = _face_normal_at(f, p)
    if n is None:
        return None, p, False
    sg = _face_sign(shape, f, p)
    if sg is None:
        return n, p, False
    if sg < 0:
        n = App.Vector(-n.x, -n.y, -n.z)
    return n, p, True


def _cyl_concave(shape, f):
    """Is this cylindrical face a bore, or a boss?

    Decided against the axis rather than against the solid: the outward
    normal of a bore wall points AWAY from material and so does the outward
    normal of a boss, so isInside cannot separate them. The radial direction
    can -- material outside the cylinder means a bore, and a bore is an
    internal corner that sets a maximum tool diameter.
    """
    try:
        s = f.Surface
        ax = _unit_v(App.Vector(s.Axis))
        c = App.Vector(s.Center)
    except Exception:
        return None
    n, p, decided = _outward_normal(shape, f)
    if p is None or n is None or ax is None or not decided:
        return None
    v = App.Vector(p.x - c.x, p.y - c.y, p.z - c.z)
    d = v.dot(ax)
    v = _unit_v(App.Vector(v.x - ax.x * d, v.y - ax.y * d, v.z - ax.z * d))
    if v is None:
        return None
    return n.dot(v) < 0.0


def _edge_concave(shape, e, fa, fb):
    """Concave means the material wraps the edge: an inside corner.

    For two faces fa, fb sharing edge e, let va be the inward tangent vector of fa
    perpendicular to e (pointing into fa), and nb be the outward normal of fb.
    If va . nb > 0, fa extends into the exterior halfspace of fb (an inside corner).
    If va . nb < 0, fa extends behind fb into the solid (an outside corner).
    A tangent join has |va . nb| == 0 and is neither.
    """
    try:
        u0, u1 = e.ParameterRange
        u = (u0 + u1) / 2.0
        p = e.valueAt(u)
        te = e.tangentAt(u)
    except Exception:
        return None
    sa = _face_sign(shape, fa)
    sb = _face_sign(shape, fb)
    na = _face_normal_at(fa, p)
    nb = _face_normal_at(fb, p)
    if na is None or nb is None or sa is None or sb is None:
        return None
    na = App.Vector(na.x * sa, na.y * sa, na.z * sa)
    nb = App.Vector(nb.x * sb, nb.y * sb, nb.z * sb)
    v = na.cross(te)
    if v.Length < 1e-6:
        return None
    v.normalize()
    step = 1e-3
    p_pos = p + v * step
    p_neg = p - v * step
    try:
        import Part
        d_pos = fa.distToShape(Part.Vertex(p_pos))[0]
        d_neg = fa.distToShape(Part.Vertex(p_neg))[0]
    except Exception:
        return None
    va = v if d_pos < d_neg else App.Vector(-v.x, -v.y, -v.z)
    dot = va.dot(nb)
    if dot > 1e-3:
        return True
    if dot < -1e-3:
        return False
    return False


def _offset_shape(shape, dist, tol=1e-4):
    """makeOffsetShape, whatever this build's signature is.

    The first cut passed intersection=True and every residual check on every
    part came back "erosion offset failed (TypeError)" -- which the honesty
    path then correctly reported as manufacturable: null, so the bug was loud
    rather than silent, but the check never ran once. FreeCAD spells the third
    parameter 'inter' and takes it positionally; the keyword does not exist.

    A compound is offset solid-by-solid and fused, because makeOffsetShape
    refuses a compound on some builds and a cut between two solids is a
    compound on more of them than you would expect.
    """
    d = float(dist)
    t = float(tol)
    last = None
    # inter=True is the third POSITIONAL parameter. The first cut passed it as
    # intersection=True, which is not a keyword this method has; the fix then
    # dropped it altogether, which is worse -- without intersection handling an
    # outward offset cannot close a slot narrower than twice the offset, which
    # is exactly the geometry the residual exists to find. Arc join first
    # because that is the true Minkowski ball; the rest are salvage.
    for args in ((d, t, True, False, 0, 0, False),
                 (d, t, True, False, 0, 2, False),
                 (d, t, False, False, 0, 0, False),
                 (d, t * 10, True, False, 0, 0, False)):
        try:
            r = shape.makeOffsetShape(*args)
            if r is None or r.isNull():
                continue
            v = float(r.Volume)
            # A "successful" offset that moved the volume the wrong way did
            # not do what was asked. Checked here rather than believed,
            # because the caller turns this straight into a verdict.
            if v <= 0:
                continue
            if d > 0 and v < float(shape.Volume) - 1e-6:
                continue
            if d < 0 and v > float(shape.Volume) + 1e-6:
                continue
            return r
        except Exception as e:
            last = e
    try:
        solids = list(shape.Solids)
    except Exception:
        solids = []
    if len(solids) > 1:
        parts = []
        for sol in solids:
            try:
                r = sol.makeOffsetShape(d, t)
                if r is not None and not r.isNull():
                    parts.append(r)
            except Exception as e:
                last = e
        if parts:
            out = parts[0]
            for extra in parts[1:]:
                try:
                    out = out.fuse(extra)
                except Exception:
                    pass
            return out
    raise KoiOpError("offset failed: %s: %s"
                     % (type(last).__name__ if last else "Unknown", last))


def _blocked_along(shape, start, d, reach, tol=1e-3):
    """Does a ray from p along d re-enter the solid?

    This is the undercut test and there is no cheaper one. A face whose
    normal points at the tool is still unmachinable if something else of the
    part stands in the way, and no property on the face records that.
    """
    import Part
    try:
        b = _step(start, d, reach)
        seg = Part.makeLine(start, b)
    except Exception:
        return None
    try:
        c = shape.common(seg)
        L = sum(x.Length for x in c.Edges)
    except Exception:
        return None
    return L > tol * 50


def _dfm_corners(shape, axis, tool_r):
    """Internal corners, which is where the maximum tool diameter comes from.

    A concave vertical wall-to-wall join is a corner a rotating cutter has to
    negotiate, and a cutter of radius r leaves radius r behind. A sharp one
    (radius zero) cannot be milled at all: not with a smaller tool, not with
    a slower feed. It is EDM, a corner relief, or a redesign, and saying so
    is more use than reporting a tool that would "nearly" fit.
    """
    out = {"sharp": [], "radii": [], "minRadius": None,
           "maxToolDiameter": None, "truncated": False}
    ax = axis
    seen = 0
    for f in shape.Faces:
        seen += 1
        if seen > DFM_FACE_BUDGET:
            out["truncated"] = True
            break
        try:
            if type(f.Surface).__name__ != "Cylinder":
                continue
            r = float(f.Surface.Radius)
            fax = _unit_v(App.Vector(f.Surface.Axis))
        except Exception:
            continue
        if fax is None or r <= 1e-9:
            continue
        if _cyl_concave(shape, f) is not True:
            continue
        # Only a corner whose axis lies along the tool axis constrains the
        # cutter's radius. A horizontal bore is a hole, drilled or bored, and
        # it is checked as one.
        if abs(fax.dot(ax)) < 0.98:
            continue
        out["radii"].append({"face": None, "radius": round(r, 4)})
        if out["minRadius"] is None or r < out["minRadius"]:
            out["minRadius"] = r
    # Sharp internal corners: a concave straight edge running along the tool
    # axis, shared by two planes.
    import Part
    idx = 0
    for e in shape.Edges:
        idx += 1
        if idx > DFM_EDGE_BUDGET:
            out["truncated"] = True
            break
        try:
            if type(e.Curve).__name__ != "Line":
                continue
            d = _unit_v(App.Vector(e.Vertexes[-1].Point.sub(e.Vertexes[0].Point)))
        except Exception:
            continue
        if d is None or abs(d.dot(ax)) < 0.98:
            continue
        try:
            fs = shape.ancestorsOfType(e, Part.Face)
        except Exception:
            continue
        if len(fs) != 2:
            continue
        if _edge_concave(shape, e, fs[0], fs[1]) is not True:
            continue
        try:
            length = float(e.Length)
        except Exception:
            length = None
        out["sharp"].append({"length": round(length, 3) if length else None})
    if out["minRadius"] is not None:
        out["maxToolDiameter"] = round(out["minRadius"] * 2.0, 4)
    out["sharpCount"] = len(out["sharp"])
    out["sharp"] = out["sharp"][:12]
    return out


def _dfm_reach(shape, axis_names, budget=DFM_RAY_BUDGET):
    """Which setup directions cover which faces, and what nothing covers.

    Two findings come out of this and they are not the same severity. A face
    reachable only from -Z when everything else is +Z is a SECOND SETUP: real
    money, a re-fixture, and a tolerance stack between the two -- but it can
    be made. A face reachable from no direction at all is an undercut, and no
    number of setups fixes it on a 3-axis machine.

    The first cut of this rejected every face with n.a <= 0.02, which threw
    away every wall PARALLEL to the tool axis -- the sides of a plate, the
    walls of a pocket, most of the cut surface on most milled parts. Those are
    cut by the side of the cutter, not its tip, and a plain plate came back
    with fifteen unreachable faces because of it. The gate is now "not turned
    AWAY from the tool", and perpendicular counts as reachable.
    """
    axes = [(n, _axis_vec(n)) for n in axis_names]
    try:
        bb = shape.BoundBox
        reach = float(bb.DiagonalLength) * 2.0 + 10.0
    except Exception:
        reach = 1000.0
    faces = list(shape.Faces)
    try:
        faces.sort(key=lambda f: -float(f.Area))
    except Exception:
        pass
    truncated = len(faces) > DFM_FACE_BUDGET
    faces = faces[:DFM_FACE_BUDGET]
    rays = 0
    undecided = 0
    cover = dict((n, 0) for n, _ in axes)
    face_axes = []
    unreachable = []
    unreachable_area = 0.0
    checked = 0
    for i, f in enumerate(faces):
        n, p, decided = _outward_normal(shape, f)
        if p is None or n is None:
            continue
        if not decided:
            # An undecided sign is not a vote. Counted and reported; the
            # caller turns a material number of them into notDetermined.
            undecided += 1
            continue
        checked += 1
        hit = set()
        for name, a in axes:
            # Turned away from the tool: the tip cannot see it and the flute
            # cannot either. Perpendicular (dot 0) is a WALL, which is the
            # most common machined surface there is.
            if n.dot(a) < -0.02:
                continue
            if rays >= budget:
                truncated = True
                break
            rays += 1
            # Step off the surface along the outward normal FIRST. A ray
            # started on a wall and sent along the tool axis runs inside that
            # wall's own face, and the boolean reports the part blocking
            # itself -- which is how every vertical face used to come back
            # unreachable even after the normals were right.
            b = _blocked_along(shape, _step(_step(p, n, 0.02), a, 0.02),
                               a, reach)
            if b is False:
                hit.add(name)
        if hit:
            face_axes.append(hit)
            for name in hit:
                cover[name] += 1
        else:
            try:
                area = float(f.Area)
            except Exception:
                area = 0.0
            unreachable_area += area
            if len(unreachable) < 16:
                unreachable.append({
                    "index": i,
                    "surface": type(f.Surface).__name__,
                    "areaMm2": round(area, 3),
                    "normal": [round(n.x, 4), round(n.y, 4), round(n.z, 4)],
                })
    # Greedy set cover: how few times does this part have to be re-clamped.
    # The first cut of this walked the axes once in popularity order and never
    # looked at what was left uncovered, so it reported one setup for a part
    # that needs three.
    setups = []
    left = [t for t in face_axes]
    while left and len(setups) < len(axes):
        best, best_n = None, 0
        for name, _ in axes:
            if name in setups:
                continue
            c = sum(1 for t in left if name in t)
            if c > best_n:
                best, best_n = name, c
        if best is None:
            break
        setups.append(best)
        left = [t for t in left if best not in t]
    return {
        "axes": [n for n, _ in axes],
        "coverage": dict((k, v) for k, v in cover.items()),
        "setupsSuggested": setups,
        "setupCount": len(setups),
        "unreachableFaces": unreachable,
        "unreachableFaceCount": len(unreachable),
        "unreachableAreaMm2": round(unreachable_area, 3),
        "facesChecked": checked,
        "facesUndecided": undecided,
        "raysCast": rays,
        "truncated": bool(truncated),
    }


def _dfm_stock_shape(shape, margin):
    import Part
    bb = shape.BoundBox
    m = float(margin)
    return Part.makeBox(
        bb.XLength + 2 * m, bb.YLength + 2 * m, bb.ZLength + 2 * m,
        App.Vector(bb.XMin - m, bb.YMin - m, bb.ZMin - m))


def _rot_to_z(a):
    """(rotation axis, degrees) that takes the axis onto +Z, or None when it is +Z."""
    z = App.Vector(0.0, 0.0, 1.0)
    d = max(-1.0, min(1.0, a.dot(z)))
    if d > 0.999999:
        return None
    if d < -0.999999:
        return (App.Vector(1.0, 0.0, 0.0), 180.0)
    ax = a.cross(z)
    return (ax, _math.degrees(_math.acos(d)))


def _rotated(sh, rot, inverse=False):
    c = sh.copy()
    if rot is not None:
        c.rotate(App.Vector(0.0, 0.0, 0.0), rot[0],
                 -rot[1] if inverse else rot[1])
    return c


def _offset2d(sh, d):
    """Offset a planar region in its own plane. Returns (shape or None, ok).

    None with ok=True means the region eroded away to nothing, which is a
    RESULT -- it is what a channel narrower than the tool does. ok=False means
    the operation could not be performed and nothing may be concluded.

    2D offsetting goes through BRepOffsetAPI_MakeOffset, which is a different
    and far more forgiving algorithm than the 3D BRepOffsetAPI_MakeOffsetShape
    that this replaced. That is the whole reason for the change of method: the
    3D one refuses an inward offset of any solid with a non-trivial cavity,
    which is every part worth checking.
    """
    try:
        src = list(sh.Faces)
    except Exception:
        return None, False
    if not src:
        return None, True
    import Part
    out = []
    for f in src:
        r = None
        for join, inter in ((0, False), (2, True)):
            try:
                r = f.makeOffset2D(float(d), join, False, False, inter)
                break
            except Exception:
                r = None
        if r is None or r.isNull():
            # This face did not survive. For an erosion that is the expected
            # outcome for anything narrower than the tool, so it is normally a
            # RESULT rather than a failure.
            #
            # Except when it cannot be: a region wider than the tool in both
            # directions does not erode away, so if that one refused, the
            # operation broke. Without this the caller would read a broken
            # offset as "the tool reaches nothing here" and invent an
            # obstruction out of an OCC failure -- the exact substitution this
            # module is built to refuse.
            try:
                fb = f.BoundBox
                span = 4.0 * abs(float(d))
                # The two LARGEST extents. A planar region has a zero third
                # one by definition, so testing all three would have made this
                # guard unreachable -- which is how a guard becomes a comment.
                dims = sorted((fb.XLength, fb.YLength, fb.ZLength))[1:]
                if dims[0] > span and dims[1] > span:
                    return None, False
            except Exception:
                pass
            continue
        try:
            for rf in r.Faces:
                if rf.Area > 1e-9:
                    out.append(rf)
        except Exception:
            continue
    if not out:
        return None, True
    return Part.makeCompound(out), True


def _faces_area(sh):
    try:
        return sum(float(f.Area) for f in sh.Faces)
    except Exception:
        return 0.0


def _residual_slab(shape, stock, r, axis_names, level_cap=32):
    """Material no cutter of this radius can reach, measured the way a mill works.

    For one tool axis: slice the part perpendicular to it, and at each level
    erode the free area by the tool radius to get the positions the tool
    CENTRE may occupy. Carry that down -- a centre position is only usable if
    it was usable at every level above, because a mill arrives from above and
    cannot appear inside a cavity. Dilate the surviving centres back to get
    the area actually swept, and whatever material is left is left.

    This is a better model than the 3D morphological opening it replaces, and
    not only because OCC will actually perform it. The opening used a SPHERE,
    so it left the tool's own radius in every internal corner and a perfectly
    ordinary pocket floor came back with a residual that had to be classified
    away. An end mill has a flat bottom and a straight flank, and this
    measures that: a square pocket floor comes back at zero, because that is
    what it machines to.

    Across several axes it is an intersection, not a sum: material is only
    unreachable if it is unreachable from EVERY setup direction allowed. A
    pocket in the underside of a plate is a second setup, not a defect, and
    summing per-axis residuals would have called it one.
    """
    import Part
    per_axis = {}
    solids = []
    levels_used = 0
    for name in axis_names[:6]:
        a = _axis_vec(name)
        rot = _rot_to_z(a)
        try:
            part = _rotated(shape, rot)
            stk = _rotated(stock, rot)
            bb = stk.BoundBox
        except Exception:
            return None
        if bb.ZLength <= 1e-6:
            return None
        n = max(6, min(level_cap, int(bb.ZLength / max(r * 0.5, 0.2)) + 1))
        h = bb.ZLength / n
        pad = max(r * 3.0, 5.0)
        levels_used += n
        prisms = []
        vol = 0.0
        approach = None
        for k in range(n):
            z = bb.ZMax - (k + 0.5) * h
            try:
                pl = Part.makePlane(
                    bb.XLength + 2 * pad, bb.YLength + 2 * pad,
                    App.Vector(bb.XMin - pad, bb.YMin - pad, z))
                sect = part.common(pl)
                solid_here = bool(sect and not sect.isNull() and sect.Faces)
                free = pl.cut(sect) if solid_here else pl
                stock_sect = stk.common(pl)
                neg = stock_sect.cut(sect) if solid_here else stock_sect
            except Exception:
                return None
            centres, ok = _offset2d(free, -r)
            if not ok:
                return None
            # Map centres to a common plane (z=0) so that .common(centres) across
            # slices at different z elevations intersects 2D planar shapes properly.
            centres_z0 = None
            if centres is not None:
                c_copy = centres.copy()
                c_copy.translate(App.Vector(0.0, 0.0, -z))
                centres_z0 = c_copy

            if k == 0:
                # The top slice is open air out to the padding, so its eroded
                # region cannot legitimately be empty. If it is, the offset
                # broke rather than the geometry being tight, and every level
                # below would inherit that as a false obstruction.
                if centres_z0 is None:
                    return None
                approach = centres_z0
            elif approach is None or centres_z0 is None:
                approach = None
            else:
                try:
                    approach = approach.common(centres_z0)
                except Exception:
                    return None
                if not _faces_area(approach) > 1e-9:
                    approach = None
            reach = None
            if approach is not None:
                app_at_z = approach.copy()
                app_at_z.translate(App.Vector(0.0, 0.0, z))
                reach, ok2 = _offset2d(app_at_z, r)
                if not ok2:
                    return None
            try:
                rem = neg.cut(reach) if reach is not None else neg
            except Exception:
                return None
            area = _faces_area(rem)
            if area > 1e-9:
                vol += area * h
                try:
                    rem.translate(App.Vector(0.0, 0.0, -h / 2.0))
                    prisms.append(_rotated(rem.extrude(App.Vector(0.0, 0.0, h)),
                                           rot, inverse=True))
                except Exception:
                    pass
        per_axis[name] = round(vol, 3)
        solids.append(Part.makeCompound(prisms) if prisms else None)

    if not solids:
        return None
    if any(s is None for s in solids):
        # One axis reaches everything, so nothing is unreachable from all of
        # them. That axis is the setup; the reach check says how many there
        # are.
        return {"volumeMm3": 0.0, "byAxis": per_axis, "levels": levels_used}
    acc = solids[0]
    for other in solids[1:]:
        try:
            acc = acc.common(other)
        except Exception:
            return None
        if acc is None or acc.isNull():
            return {"volumeMm3": 0.0, "byAxis": per_axis, "levels": levels_used}
    try:
        total = float(acc.Volume)
    except Exception:
        return None
    return {"volumeMm3": round(max(total, 0.0), 3), "byAxis": per_axis,
            "levels": levels_used}


def _residual_closing(shape, stock, r):
    """The axis-free bound: the morphological closing of the part, minus the part.

    A ball of radius r can occupy a point only if the whole ball misses the
    part, so material that is inside dilate-then-erode but outside the part is
    material no ball of that radius reaches from any direction at all. Written
    as a closing of the PART rather than an opening of the space around it,
    which matters: the space around a part is a box with a part-shaped hole in
    it, and OCC will not offset that inward. It offsets a part outward and
    back reasonably often.

    Kept as the fallback because it is axis-free and therefore a stronger
    claim than the slab measurement. Its weakness is the structuring element:
    a ball leaves its own radius in every internal corner, so the leftover has
    to be classified rather than believed.
    """
    try:
        grown = _offset_shape(shape, float(r))
        closed = _offset_shape(grown, -float(r))
        residual = closed.cut(shape).common(stock)
        rv = float(residual.Volume)
    except Exception as e:
        return None, str(e)
    if rv < 0:
        rv = 0.0
    skin = None
    if rv > 1e-3:
        probe_r = max(r * 0.3, 0.05)
        try:
            core = _offset_shape(residual, -probe_r)
            skin = (core is None or core.isNull()
                    or float(core.Volume) <= 1e-9)
        except Exception:
            skin = None
    return {"volumeMm3": round(rv, 3), "skinOnly": skin,
            "skinProbeRadius": round(max(r * 0.3, 0.05), 4)}, None


def _dfm_residual(shape, stock, radius, axis_names):
    """The volume a cutter of this radius cannot reach. The definitive number.

    Two methods, tried in order, and the reply always says which one answered
    because they do not mean quite the same thing:

      slab-2d       the mill model. Per setup direction, and a point counts as
                    unreachable only when every allowed direction fails it.
                    Flat-bottomed, so a square pocket floor reads zero.
      ball-closing  axis-free, and therefore the stronger claim when it works:
                    unreachable by a ball of that radius from ANY direction.
                    Leaves the tool's own corner radius behind, so its
                    leftover is classified as a skin or an obstruction.

    Read the obstructed flag. A raw volume is not a verdict under either method, and
    a leftover that could not be classified stays obstructed on purpose.
    """
    r = float(radius)
    out = {"toolRadius": round(r, 4), "volumeMm3": None, "fraction": None,
           "method": None, "ok": False, "obstructed": None, "skinOnly": None}
    try:
        neg = stock.cut(shape)
        neg_v = float(neg.Volume)
    except Exception as e:
        out["error"] = "stock minus part failed: %s" % type(e).__name__
        return out
    out["removeVolumeMm3"] = round(neg_v, 3)
    if neg_v <= 1e-6:
        out.update({"ok": True, "volumeMm3": 0.0, "fraction": 0.0,
                    "obstructed": False, "method": "none",
                    "note": "stock and part are the same volume; "
                            "nothing to remove"})
        return out

    errors = []
    slab = None
    try:
        slab = _residual_slab(shape, stock, r, axis_names)
    except Exception as e:
        errors.append("slab-2d: %s: %s" % (type(e).__name__, e))
    if slab is not None:
        rv = slab["volumeMm3"]
        # The slab measurement is sampled, so a thin sliver of numerical
        # leftover is not a finding. The floor is generous enough to survive
        # discretisation and far below anything a cutter genuinely misses.
        floor = max(2.0, 0.005 * neg_v)
        out.update({
            "ok": True, "method": "slab-2d", "volumeMm3": rv,
            "fraction": round(rv / neg_v, 6) if neg_v else None,
            "byAxis": slab["byAxis"], "levels": slab["levels"],
            "axes": list(axis_names), "skinOnly": False,
            "obstructed": bool(rv > floor),
            "significanceFloorMm3": round(floor, 3),
            "note": "measured per setup direction and intersected: this is "
                    "material unreachable from EVERY direction in axes. A flat "
                    "end mill is assumed, so square pocket floors read zero.",
        })
        return out
    if errors:
        out["slabError"] = errors[-1]

    closing, err = _residual_closing(shape, stock, r)
    if closing is None:
        out["error"] = (
            "both residual methods failed (slab-2d: %s; ball-closing: %s). "
            "These are OCC limits, not a verdict: do not report the part as "
            "machinable on the strength of them."
            % (errors[-1] if errors else "returned nothing", err))
        return out

    rv = closing["volumeMm3"]
    out.update({"ok": True, "method": "ball-closing", "volumeMm3": rv,
                "fraction": round(rv / neg_v, 6) if neg_v else None,
                "skinProbeRadius": closing["skinProbeRadius"]})
    if rv <= 1e-3:
        out["obstructed"] = False
        out["skinOnly"] = False
        return out
    skin = closing["skinOnly"]
    if skin is True:
        out["skinOnly"] = True
        out["obstructed"] = False
        out["skinNote"] = (
            "the leftover is nowhere thicker than %.2f mm: it is the corner "
            "radius a %.1f mm cutter leaves in an internal corner, not "
            "material it cannot reach. The corners will be radiused."
            % (closing["skinProbeRadius"] * 2, r * 2))
    else:
        out["skinOnly"] = False if skin is False else None
        out["obstructed"] = True
        if skin is None:
            out["skinNote"] = (
                "the leftover could not be classified, so it is reported as an "
                "obstruction. That is the loud direction on purpose.")
    return out


def _dfm_voids(shape):
    """A cavity with no opening. Subtractive processes cannot make one."""
    try:
        shells = len(shape.Shells)
    except Exception:
        return None
    if shells <= 1:
        return None
    return {"shells": shells,
            "message": "the solid has %d shells, so it encloses %d void(s) "
                       "with no opening to the outside. No milling, turning "
                       "or drilling operation can produce that; it is casting, "
                       "additive, or two parts joined." % (shells, shells - 1)}


def _dfm_holes(doc, obj):
    """The hole rules the stock lint does not cover.

    _stock_lint already refuses a non-stock diameter and a thread engagement
    under 1.5xD. These are the two that are about the DRILL rather than the
    fastener: how deep a jobber drill goes before it is a peck cycle and a
    special tool, and the flat bottom that a twist drill physically cannot
    leave.
    """
    out = []
    for o in doc.Objects:
        if "PartDesign::Hole" not in o.TypeId:
            continue
        if _suppressed(o):
            continue
        try:
            d = float(o.Diameter)
        except Exception:
            continue
        depth_type = str(getattr(o, "DepthType", "") or "")
        through = "through" in depth_type.lower()
        depth = None
        if not through:
            try:
                depth = float(o.Depth)
            except Exception:
                depth = None
        if d > 1e-6 and depth and depth / d > DRILL_DEPTH_RATIO:
            out.append({
                "level": "warn", "object": o.Name, "code": "dfm-hole-depth",
                "message": "%.2f mm hole %.1f mm deep is %.1fxD; past %.0fxD "
                           "it is a peck cycle with a long-series drill, not a "
                           "stock operation" % (d, depth, depth / d,
                                                DRILL_DEPTH_RATIO)})
        try:
            if not through and str(getattr(o, "DrillPoint", "")).lower() == "flat":
                out.append({
                    "level": "warn", "object": o.Name,
                    "code": "dfm-flat-bottom-hole",
                    "message": "a blind hole with a flat bottom cannot be "
                               "drilled -- a twist drill leaves a 118 deg cone. "
                               "It is an end mill (so the diameter has to be a "
                               "cutter size) or a second flat-bottom tool"})
        except Exception:
            pass
    return out


def _stock_tool_at_or_below(d):
    best = None
    for s in ENDMILL_SIZES:
        if s <= d + 1e-6:
            best = s
    return best


def dfm(targets=None, process="mill3axis", tool=None, axes=None,
        stock=None, stockMargin=None, checks=None, doc=None):
    """Can this be made? Measured, not asserted.

    Read-only: no transaction, no undo entry, nothing added to the document.
    That is deliberate and it is the same reasoning that makes freecad_measure
    safe -- a check that costs the user a confirmation is a check that stops
    being run.
    """
    doc = doc or App.ActiveDocument
    if doc is None:
        raise KoiOpError("no active document")
    proc = str(process or "mill3axis")
    if proc not in DFM_PROCESSES:
        raise KoiOpError("process must be one of %s"
                         % ", ".join(DFM_PROCESSES))
    want = set(checks or ("corners", "reach", "residual", "voids", "holes"))
    # The bounding box with no allowance. An allowance is real material, and
    # it is machined in a setup of its own; charging it to the first setup is
    # what made a plain plate's underside read as unreachable.
    margin = 0.0 if stockMargin is None else float(stockMargin)

    objs = []
    if targets:
        for t in targets:
            objs.append(_resolve_or_die(doc, t, "object"))
    else:
        objs = _presentation_parts(doc)
    objs = [o for o in objs if _dfm_shape(o) is not None]
    if not objs:
        raise KoiOpError(
            "nothing with a solid to check. Pass targets, or build something "
            "first -- dfm measures shapes, and a document of sketches has none")

    if axes:
        axis_names = [str(a) for a in axes]
        for a in axis_names:
            _axis_vec(a)
    elif proc == "mill3axis":
        axis_names = ["+Z", "-Z"]
    elif proc in ("mill5axis", "mill_any"):
        axis_names = ["+Z", "-Z", "+X", "-X", "+Y", "-Y"]
    else:
        axis_names = ["+Z"]

    reports = []
    findings = []
    verdict_bits = []
    unknown = []

    for o in objs:
        shape = _dfm_shape(o)
        r = {"object": o.Name, "label": o.Label,
             "volumeMm3": round(float(shape.Volume), 3),
             "faces": len(shape.Faces)}
        ax = _axis_vec(axis_names[0])

        if "corners" in want:
            c = _dfm_corners(shape, ax, None)
            r["corners"] = c
            if c.get("sharpCount"):
                findings.append({
                    "level": "error", "object": o.Name,
                    "code": "dfm-sharp-corner",
                    "message": "%d sharp internal corner(s) run along %s. A "
                               "rotating cutter leaves its own radius; a zero "
                               "radius is not a smaller tool, it is EDM, a "
                               "corner relief, or a redesign"
                               % (c["sharpCount"], axis_names[0])})
            if c.get("maxToolDiameter"):
                mt = c["maxToolDiameter"]
                st = _stock_tool_at_or_below(mt)
                r["corners"]["nearestStockTool"] = st
                if st is None:
                    findings.append({
                        "level": "error", "object": o.Name,
                        "code": "dfm-tool-too-large",
                        "message": "the tightest internal corner is %.3f mm "
                                   "diameter and the smallest stock end mill "
                                   "is %.1f mm" % (mt, ENDMILL_SIZES[0])})
                elif tool and float(tool) > mt + 1e-6:
                    findings.append({
                        "level": "error", "object": o.Name,
                        "code": "dfm-tool-too-large",
                        "message": "a %.1f mm cutter does not fit the tightest "
                                   "internal corner, which is %.3f mm across. "
                                   "%.1f mm is the largest that goes in"
                                   % (float(tool), mt, st)})
                elif abs(st - mt) > 0.01:
                    findings.append({
                        "level": "info", "object": o.Name,
                        "code": "dfm-corner-tool",
                        "message": "tightest internal corner is R%.3f, so the "
                                   "largest tool that fits is %.1f mm -- "
                                   "rounding the corner to R%.1f lets a bigger "
                                   "cutter in and costs nothing"
                                   % (mt / 2.0, st, st / 2.0)})

        if "reach" in want:
            rr = _dfm_reach(shape, axis_names)
            r["reach"] = rr
            if rr["unreachableFaceCount"]:
                findings.append({
                    "level": "error", "object": o.Name,
                    "code": "dfm-undercut",
                    "message": "%d face(s), %.1f mm2, are reachable from none "
                               "of %s. On a 3-axis machine that is an undercut: "
                               "no tool, no setup, no feed rate reaches them"
                               % (rr["unreachableFaceCount"],
                                  rr["unreachableAreaMm2"],
                                  ", ".join(axis_names))})
            if rr["setupCount"] > 1:
                findings.append({
                    "level": "warn", "object": o.Name,
                    "code": "dfm-multi-setup",
                    "message": "needs %d setups (%s). Each re-fixture is a "
                               "tolerance stack between the features cut before "
                               "and after it -- say so before quoting a "
                               "position tolerance across them"
                               % (rr["setupCount"],
                                  ", ".join(rr["setupsSuggested"]))})
            if rr["truncated"]:
                unknown.append("reach: budget exhausted on %s" % o.Name)
            if rr.get("facesUndecided") and rr["facesUndecided"] > max(
                    2, 0.1 * (rr["facesChecked"] or 1)):
                unknown.append(
                    "reach: the material side of %d face(s) on %s could not be "
                    "measured, so they were not checked"
                    % (rr["facesUndecided"], o.Name))

        if "residual" in want:
            if tool:
                td = float(tool)
                src = "argument"
            else:
                mt = ((r.get("corners") or {}).get("maxToolDiameter"))
                td = _stock_tool_at_or_below(mt) if mt else 6.0
                td = td or ENDMILL_SIZES[0]
                src = "derived from the tightest internal corner"
            st_shape = None
            if stock:
                so = _resolve_or_die(doc, stock, "stock object")
                st_shape = _dfm_shape(so)
            if st_shape is None:
                # The bounding box, with no allowance by default. An
                # allowance is real material and it is machined in a setup of
                # its own -- counting it here made the underside of every
                # plate read as unreachable from the side its top was cut
                # from, which is a fact about flipping the part, not about the
                # part.
                st_shape = _dfm_stock_shape(shape, margin)
                st_src = ("bounding box" if margin <= 0
                          else "bounding box + %.1f mm" % margin)
            else:
                st_src = stock
            res = _dfm_residual(shape, st_shape, td / 2.0, axis_names)
            res["toolDiameter"] = td
            res["toolSource"] = src
            res["stock"] = st_src
            r["residual"] = res
            if not res.get("ok"):
                unknown.append("residual: %s" % res.get("error", "did not run"))
            elif res.get("obstructed"):
                findings.append({
                    "level": "error", "object": o.Name,
                    "code": "dfm-unreachable-volume",
                    "message": "%.2f mm3 (%.2f%% of the material to remove) "
                               "cannot be reached by a %.1f mm cutter from any "
                               "of %s. It is not a setup problem -- the "
                               "finished part will not be the modelled shape. "
                               "(measured by %s)"
                               % (res["volumeMm3"],
                                  100.0 * (res.get("fraction") or 0.0), td,
                                  ", ".join(axis_names),
                                  res.get("method") or "?")})
            elif res.get("skinOnly") and (res.get("volumeMm3") or 0) > 1e-3:
                # Reported, never as a failure. An internal corner keeps the
                # cutter's own radius and that is what the part will have --
                # worth one line, because a drawing that calls it sharp is
                # a drawing the shop will phone about.
                findings.append({
                    "level": "info", "object": o.Name,
                    "code": "dfm-corner-leftover",
                    "message": "%.2f mm3 stays in the internal corners: that "
                               "is the R%.1f a %.1f mm cutter leaves, not "
                               "material it cannot reach. The corners will be "
                               "radiused, not square"
                               % (res["volumeMm3"], td / 2.0, td)})

        if "voids" in want:
            v = _dfm_voids(shape)
            if v:
                r["voids"] = v
                findings.append({
                    "level": "error", "object": o.Name,
                    "code": "dfm-internal-void", "message": v["message"]})

        reports.append(r)

    if "holes" in want:
        findings.extend(_dfm_holes(doc, None))

    errors = [f for f in findings if f["level"] == "error"]
    warns = [f for f in findings if f["level"] == "warn"]

    # Precedence, and it is the other way round from the obvious reading. A
    # blocking finding is DISPOSITIVE: a check that did not run can only ever
    # add more findings, never withdraw one, so an unmeasured residual cannot
    # make a sharp internal corner go away. Reporting "not determined" over a
    # measured error buried the only answer that mattered.
    if errors:
        manufacturable = False
        verdict = ("NOT MANUFACTURABLE as modelled by %s: %d blocking "
                   "finding(s). Fix the geometry -- these are not tolerances "
                   "to negotiate." % (proc, len(errors)))
        if unknown:
            verdict += (" %d further check(s) did not run (%s), so there may "
                        "be more than these."
                        % (len(unknown), "; ".join(unknown[:2])))
    elif unknown:
        manufacturable = None
        verdict = ("NOT DETERMINED. %d check(s) could not run: %s. Report this "
                   "as an unfinished check, not as a pass."
                   % (len(unknown), "; ".join(unknown[:4])))
    elif warns:
        manufacturable = True
        verdict = ("Manufacturable by %s, with %d thing(s) that cost money or "
                   "tolerance. Say what they are before the user commits."
                   % (proc, len(warns)))
    else:
        manufacturable = True
        verdict = ("Manufacturable by %s on every check that ran." % proc)

    return {
        "process": proc,
        "axes": axis_names,
        "objects": reports,
        "findings": findings,
        "errorCount": len(errors),
        "warnCount": len(warns),
        "notDetermined": unknown,
        "manufacturable": manufacturable,
        "verdict": verdict,
        "note": ("Geometry only. This does not know your machine, your work "
                 "holding, your material or your tolerances, and it does not "
                 "replace a quote. What it does know is measured: a residual "
                 "volume came out of an offset operation, not out of a "
                 "sentence. For toolpath-level proof run the cam op."),
    }


# ---------- the CAM workbench proper ----------

CAM_API_CANDIDATES = {
    "job": (("Path.Main.Job", "Create"), ("PathScripts.PathJob", "Create")),
    "profile": (("Path.Op.Profile", "Create"), ("PathScripts.PathProfile", "Create")),
    "pocket": (("Path.Op.Pocket", "Create"), ("PathScripts.PathPocketShape", "Create")),
    "drilling": (("Path.Op.Drilling", "Create"), ("PathScripts.PathDrilling", "Create")),
    "adaptive": (("Path.Op.Adaptive", "Create"), ("PathScripts.PathAdaptive", "Create")),
    "face": (("Path.Op.MillFace", "Create"), ("PathScripts.PathMillFace", "Create")),
    "helix": (("Path.Op.Helix", "Create"), ("PathScripts.PathHelix", "Create")),
    "bit": (("Path.Tool.Bit", None), ("PathScripts.PathToolBit", None)),
    "controller": (("Path.Tool.Controller", "Create"),
                   ("PathScripts.PathToolController", "Create")),
    "post": (("Path.Post.Command", None), ("PathScripts.PathPost", None)),
}

CAM_OP_KINDS = ("profile", "pocket", "drilling", "adaptive", "face", "helix")


def _import_probe(cands):
    """Which spelling of a workbench API this build has. Probed, never assumed.

    K0 with teeth: Path was PathScripts before 1.0 and the operation modules
    moved with it; the FEM mesh object renamed its own shape link in the same
    release. Guessing one spelling and catching ImportError would make "this
    workbench is not installed" and "this workbench moved" the same message,
    and they need different answers from the user.

    cands maps a key to an ordered tuple of (module, attribute-or-None). The
    first module that imports AND carries the attribute wins, and the winner
    is reported so a reply can say which one answered.
    """
    import importlib
    found = {}
    for key, spellings in cands.items():
        found[key] = None
        for modname, attr in spellings:
            try:
                m = importlib.import_module(modname)
            except Exception:
                continue
            if attr and not hasattr(m, attr):
                continue
            found[key] = {"module": modname, "m": m}
            break
    return found


def _api_report(api):
    return dict((k, (v["module"] if v else None)) for k, v in api.items())


def _cam_api():
    return _import_probe(CAM_API_CANDIDATES)


def _cam_api_report(api):
    return _api_report(api)


def _cam_require(api, key):
    v = api.get(key)
    if v is None:
        raise KoiOpError(
            "this FreeCAD has no importable %s module for CAM (tried %s). "
            "The CAM workbench is not available here -- say that rather than "
            "reporting the design as unverified for some other reason."
            % (key, ", ".join(c[0] for c in CAM_API_CANDIDATES[key])))
    return v["m"]


def _cam_jobs(doc):
    out = []
    for o in doc.Objects:
        try:
            if "Path::FeaturePython" in o.TypeId and hasattr(o, "Operations"):
                out.append(o)
            elif o.TypeId.startswith("Path::") and hasattr(o, "Stock"):
                out.append(o)
        except Exception:
            continue
    return out


def _cam_path_stats(op, clearance=None):
    """Read the toolpath. An empty one is the answer, not an error to swallow.

    An operation that generated no commands recomputed clean, reports no
    error, and shows nothing in the viewport that a screenshot would catch.
    It means the workbench could not machine that feature with that tool --
    which is exactly the definitive feedback this whole section exists for.
    """
    p = getattr(op, "Path", None)
    cmds = []
    try:
        cmds = list(getattr(p, "Commands", []) or [])
    except Exception:
        cmds = []
    x = y = z = 0.0
    cut = 0.0
    rapid = 0.0
    low_rapids = 0
    plunge = 0.0
    for c in cmds:
        try:
            nm = str(getattr(c, "Name", "")).upper()
            par = getattr(c, "Parameters", {}) or {}
            nx = float(par.get("X", x))
            ny = float(par.get("Y", y))
            nz = float(par.get("Z", z))
        except Exception:
            continue
        d = _math.sqrt((nx - x) ** 2 + (ny - y) ** 2 + (nz - z) ** 2)
        lateral = _math.sqrt((nx - x) ** 2 + (ny - y) ** 2)
        if nm in ("G0", "G00"):
            rapid += d
            if (clearance is not None and lateral > 1e-6
                    and (nz < clearance - 1e-6 or z < clearance - 1e-6)):
                low_rapids += 1
        elif nm in ("G1", "G01", "G2", "G02", "G3", "G03"):
            cut += d
            if lateral < 1e-6 and nz < z:
                plunge += (z - nz)
        x, y, z = nx, ny, nz
    out = {
        "name": op.Name,
        "label": op.Label,
        "type": op.TypeId,
        "commands": len(cmds),
        "cutLengthMm": round(cut, 3),
        "rapidLengthMm": round(rapid, 3),
        "plungeLengthMm": round(plunge, 3),
        "active": bool(getattr(op, "Active", True)),
    }
    if len(cmds) == 0:
        out["empty"] = True
        out["emptyNote"] = (
            "this operation generated ZERO path commands. It recomputes clean "
            "and shows nothing wrong: it means the workbench could not "
            "machine this feature with this tool. Do not report the job as "
            "verified.")
    if low_rapids:
        out["rapidsBelowClearance"] = low_rapids
        out["rapidNote"] = (
            "%d rapid move(s) travel sideways below the clearance height. On "
            "a real machine that is a G0 through stock." % low_rapids)
    return out


def _cam_tool_controller(doc, job, api, diameter, kind="endmill"):
    """A tool controller for the job, whatever this build calls one.

    A Job created from a template usually arrives with one. Creating a bit
    from scratch needs the shape files on disk, which a container image may
    not carry -- so the existing controller is reused where there is one and
    the failure is named where there is not, rather than a default tool being
    invented and every later number being about a tool nobody chose.
    """
    tcs = []
    try:
        tcs = list(job.Tools.Group)
    except Exception:
        tcs = []
    if tcs:
        tc = tcs[0]
        if diameter:
            try:
                tc.Tool.Diameter = App.Units.Quantity("%f mm" % float(diameter))
            except Exception:
                try:
                    tc.Tool.Diameter = float(diameter)
                except Exception:
                    pass
        return tc, "reused the job's default tool controller"
    bitmod = api.get("bit")
    ctlmod = api.get("controller")
    if not bitmod or not ctlmod:
        raise KoiOpError(
            "this job has no tool controller and this build exposes no way to "
            "create one from script (no %s). Add a tool in the CAM workbench "
            "and re-run." % ("Path.Tool.Bit/Controller",))
    raise KoiOpError(
        "this job has no tool controller. Creating a bit from script needs the "
        "tool shape files this install may not carry; add one tool in the CAM "
        "workbench (CAM > Tool Bit Library) and re-run. Nothing here will "
        "invent a tool, because every feed, radius and cycle time after it "
        "would be about a tool nobody chose.")


def _op_cam(doc, args, kid):
    """The CAM workbench, through the same envelope as everything else.

    mode:
      job     create a Job on a target solid, with stock. Registers the kid.
      op      add one operation to a job.
      verify  recompute and read every operation's toolpath.
      post    write G-code into the export directory.
      clear   delete the job and everything under it.
    """
    api = _cam_api()
    mode = str(args.get("mode") or "job")
    # Same rule as every other creating call, enforced here rather than in the
    # JS spec because only two of the five modes create anything. A Job with
    # no koi id is a Job the next turn has to find by label.
    if mode in ("job", "op") and not kid:
        raise KoiOpError(
            "cam mode %r creates an object, so it needs an id -- a handle like "
            "'cam.plate' or 'camop.rough' that a later turn can address" % mode)
    report = {"api": _cam_api_report(api), "mode": mode}

    if mode == "job":
        JobMod = _cam_require(api, "job")
        target = args.get("target")
        if not target:
            raise KoiOpError("cam job needs a target: the solid to machine")
        o = _resolve_or_die(doc, target, "object")
        if _dfm_shape(o) is None:
            raise KoiOpError(
                "%r has no solid to machine. A CAM job on a sketch or an empty "
                "body generates nothing and reports no error." % target)
        job = JobMod.Create(_safe_name(args.get("name") or kid or "Job", "Job"),
                            [o], None)
        try:
            doc.recompute()
        except Exception:
            pass
        report["job"] = job.Name
        report["model"] = o.Name
        try:
            report["stock"] = {"name": job.Stock.Name,
                               "volumeMm3": round(float(job.Stock.Shape.Volume), 3)}
        except Exception:
            report["stock"] = None
            report["stockNote"] = (
                "the job has no readable stock. Every removal number below is "
                "about nothing until it does.")
        try:
            report["toolControllers"] = [t.Name for t in job.Tools.Group]
        except Exception:
            report["toolControllers"] = []
        if not report["toolControllers"]:
            report["toolNote"] = (
                "this job arrived with no tool controller. Add one tool in the "
                "CAM workbench before adding operations -- an operation with no "
                "tool generates an empty path and reports no error.")
        if kid:
            register(doc, kid, job)
        return report

    if mode == "op":
        kind = str(args.get("op") or "profile")
        if kind not in CAM_OP_KINDS:
            raise KoiOpError("op must be one of %s" % ", ".join(CAM_OP_KINDS))
        OpMod = _cam_require(api, kind)
        job = _resolve_or_die(doc, args.get("job"), "cam job")
        opobj = OpMod.Create(_safe_name(kid or kind, kind))
        try:
            job.Proxy.addOperation(opobj, None)
        except Exception:
            try:
                grp = list(job.Operations.Group)
                grp.append(opobj)
                job.Operations.Group = grp
            except Exception as e:
                raise KoiOpError("could not add the operation to the job: %s" % e)
        # The gate, not a best effort. An operation with no tool controller
        # generates an empty path and reports no error -- which is exactly the
        # reading this whole tool exists to make impossible, so it is refused
        # here instead of surfacing three steps later as "not machinable".
        tc, tcnote = _cam_tool_controller(doc, job, api,
                                          args.get("toolDiameter"))
        report["toolController"] = {"name": tc.Name, "note": tcnote}
        try:
            opobj.ToolController = tc
        except Exception as e:
            raise KoiOpError(
                "this operation would not take the job's tool controller "
                "(%s), so any path it generated would be about no tool at "
                "all." % e)
        base = args.get("base")
        if base:
            pairs = []
            for b in base:
                obj, sub = _resolve_ref_sub(doc, b)
                pairs.append((obj, [sub] if sub else []))
            try:
                opobj.Base = pairs
            except Exception as e:
                raise KoiOpError("this operation would not take that base: %s" % e)
        for prop, val in (args.get("props") or {}).items():
            try:
                setattr(opobj, str(prop), val)
            except Exception as e:
                raise KoiOpError("%s does not accept %r: %s" % (kind, prop, e))
        try:
            doc.recompute()
        except Exception:
            pass
        clearance = None
        try:
            clearance = float(opobj.ClearanceHeight.Value)
        except Exception:
            pass
        report["operation"] = _cam_path_stats(opobj, clearance)
        if kid:
            register(doc, kid, opobj)
        return report

    if mode == "verify":
        job = _resolve_or_die(doc, args.get("job"), "cam job")
        try:
            doc.recompute()
        except Exception:
            pass
        ops = []
        try:
            ops = list(job.Operations.Group)
        except Exception:
            ops = []
        clearance = None
        stats = []
        for op in ops:
            try:
                clearance = float(op.ClearanceHeight.Value)
            except Exception:
                clearance = None
            stats.append(_cam_path_stats(op, clearance))
        empties = [s["name"] for s in stats if s.get("empty")]
        unsafe = [s["name"] for s in stats if s.get("rapidsBelowClearance")]
        report["job"] = job.Name
        report["operations"] = stats
        report["operationCount"] = len(stats)
        report["emptyOperations"] = empties
        report["rapidWarnings"] = unsafe
        report["totalCommands"] = sum(s["commands"] for s in stats)
        report["totalCutLengthMm"] = round(
            sum(s["cutLengthMm"] for s in stats), 3)
        if not stats:
            report["machinable"] = None
            report["verdict"] = (
                "this job has no operations, so nothing was verified. An empty "
                "job proves nothing and must not be reported as a pass.")
        elif empties:
            report["machinable"] = False
            report["verdict"] = (
                "%d of %d operations generated NO toolpath (%s). That is the "
                "workbench saying it could not machine those features with "
                "this tool." % (len(empties), len(stats), ", ".join(empties)))
        else:
            report["machinable"] = True
            report["verdict"] = (
                "every operation generated a toolpath: %d commands, %.1f mm of "
                "cutting. A toolpath exists; it has not been simulated against "
                "the stock, so this is proof of reachability, not of a correct "
                "finished part." % (report["totalCommands"],
                                    report["totalCutLengthMm"]))
        if unsafe:
            report["safetyNote"] = (
                "operations %s contain lateral rapids below their clearance "
                "height. Do not hand this G-code to a machine."
                % ", ".join(unsafe))
        return report

    if mode == "post":
        job = _resolve_or_die(doc, args.get("job"), "cam job")
        postmod = api.get("post")
        if postmod is None:
            raise KoiOpError(
                "this build exposes no scriptable post processor. The job and "
                "its toolpaths are real; the G-code has to come out of the CAM "
                "workbench by hand.")
        import os
        path = confined_path(args.get("savePath") or ((kid or job.Name) + ".nc"),
                             (".nc", ".gcode", ".ngc", ".tap"))
        # The post processor writes where the JOB says, not where we would
        # like: exportObjectsWith(needFilename=False) takes the filename off
        # the job. Reporting a confined path we never handed to it was how
        # this could answer with a path that had no file behind it.
        try:
            job.PostProcessorOutputFile = path
        except Exception as e:
            raise KoiOpError(
                "this job would not take an output filename (%s), so the post "
                "processor would write somewhere nobody here can name. Set it "
                "in the CAM workbench and post from there." % e)
        was = None
        try:
            was = os.path.getmtime(path)
        except Exception:
            was = None
        m = postmod["m"]
        ran = False
        for attr in ("CommandPathPost", "PathPost"):
            cls = getattr(m, attr, None)
            if cls is None:
                continue
            try:
                inst = cls()
                inst.exportObjectsWith([job], job, needFilename=False)
                ran = True
                break
            except Exception as e:
                report["postError"] = "%s: %s" % (type(e).__name__, e)
        if not ran:
            raise KoiOpError(
                "the post processor did not run: %s. The toolpaths are still "
                "real -- report the verification, not the G-code."
                % report.get("postError", "no usable entry point"))
        # Measured, like everything else here. A post processor that returns
        # without raising has still not necessarily written a file: it opens a
        # dialog on some builds and silently no-ops when the job has no post
        # processor selected.
        size = None
        try:
            now = os.path.getmtime(path)
            size = os.path.getsize(path)
            if was is not None and now <= was:
                size = None
        except Exception:
            size = None
        if not size:
            raise KoiOpError(
                "the post processor ran and no G-code file appeared at %s. On "
                "this build it may need a post processor chosen on the job, "
                "or it may be trying to open a save dialog. The toolpaths are "
                "still real -- report the verification, not the G-code."
                % path)
        report["job"] = job.Name
        report["savePath"] = path
        report["bytes"] = size
        report["note"] = (
            "G-code is written and NOT verified against a machine. Post output "
            "is machine-specific; the operator has to check it.")
        return report

    if mode == "clear":
        job = _resolve_or_die(doc, args.get("job"), "cam job")
        # A Job owns a Model group with a clone of the part, a Stock, an
        # Operations group, a Tools group and a SetupSheet. removeObject on
        # the Job alone leaves every one of them in the tree as an orphan --
        # and then reports "removed", which is the kind of claim this file is
        # supposed to measure rather than make.
        name = job.Name
        removed = _remove_subtree(doc, job)
        if name not in removed:
            raise KoiOpError(
                "could not remove the job %s; %s came out and the rest is "
                "still in the tree." % (name, ", ".join(removed) or "nothing"))
        report["removed"] = removed
        return report

    raise KoiOpError(
        "mode must be job, op, verify, post or clear (got %r)" % mode)


# ---------- CAE: linear static structural (FEM) ----------
#
# What this is for, and what it deliberately is not.
#
# Everything above answers "is the model what I meant" (measure) or "can it be
# made" (dfm, cam). Nothing above answers "does it survive the load", and the
# failure mode of that silence is specific and bad: asked whether a 3 mm wall
# is strong enough, a language model produces a confident sentence. A sentence
# is not a number, and the user cannot tell the difference. This is the channel
# that makes such a claim measurable -- or refuses to make it.
#
# It is a LINEAR STATIC solve and nothing else. Small displacements, linear
# elastic material, bonded everything, one load case, no contact, no
# plasticity, no buckling, no fatigue, no dynamics, no thermal. Each of those
# is a real way the part fails that this cannot see, so a von Mises number
# from here is evidence, never a certificate.
#
# Three silent failures it is built around, because all three "solve" cleanly
# and print a plausible number:
#
#   * an under-restrained model, where rigid-body motion reads as deflection.
#     Refused before the solver runs, not diagnosed after.
#   * a surface mesh on a solid: no volume elements means no stiffness at all.
#     Also refused rather than reported.
#   * a peak stress at a sharp re-entrant corner. That is a SINGULARITY: it
#     rises without bound as the mesh refines, so it is not a stress, and a
#     factor of safety divided out of it is not a factor of safety. Measured,
#     by asking how far the peak node is from the nearest concave edge, and
#     said out loud.

FEM_API_CANDIDATES = {
    "objects": (("ObjectsFem", "makeAnalysis"),),
    "gmsh": (("femmesh.gmshtools", "GmshTools"),),
    "ccx": (("femtools.ccxtools", "FemToolsCcx"),),
    "fem": (("Fem", None),),
}

# Spelling moves between builds exactly the way the CAM operation modules did,
# and for the same reason: this is a workbench under active rework. Probed by
# attribute, in preference order, and the one that answered is reported.
FEM_SOLVER_FACTORIES = (
    "makeSolverCalculixCcxTools", "makeSolverCcxTools",
    "makeSolverCalculiXCcxTools", "makeSolverCalculix", "makeSolverCalculiX",
)

FEM_CONSTRAINT_FACTORIES = {
    "fixed": ("makeConstraintFixed",),
    "force": ("makeConstraintForce",),
    "pressure": ("makeConstraintPressure",),
    "displacement": ("makeConstraintDisplacement",),
}

FEM_RESTRAINTS = ("fixed", "displacement")
FEM_LOADS = ("force", "pressure")

FEM_PREFIX = "koi.fem."

# Young's modulus (MPa), Poisson ratio, and the yield strength a factor of
# safety is divided out of -- for the materials where that number means
# something. Keyed to MATERIALS above so a body given a density for the BOM
# already names its own card.
#
# yield is None where a single number would be a lie: grey iron is brittle and
# does not yield, and a polymer's "yield" is a rate- and temperature-dependent
# number that a linear elastic solve has no business dividing by. Those
# materials still solve -- displacement is useful -- and the factor of safety
# comes back null with the reason attached, which is the honest answer.
FEM_MATERIALS = {
    "aluminium-6061": {"E": 68900, "nu": 0.33, "yield": 276,
                       "note": "6061-T6. Annealed -O is ~55 MPa: T6 is assumed"},
    "aluminium-7075": {"E": 71700, "nu": 0.33, "yield": 503, "note": "7075-T6"},
    "aluminium-cast": {"E": 72400, "nu": 0.33, "yield": 165,
                       "note": "A356-T6. Cast porosity is not modelled"},
    "steel-1018": {"E": 205000, "nu": 0.29, "yield": 370,
                   "note": "cold drawn. Hot rolled is ~220 -- check which you buy"},
    "steel-4140": {"E": 205000, "nu": 0.29, "yield": 655,
                   "note": "quenched and tempered. Annealed is ~415"},
    "stainless-304": {"E": 193000, "nu": 0.29, "yield": 215, "note": "annealed"},
    "stainless-316": {"E": 193000, "nu": 0.29, "yield": 205, "note": "annealed"},
    "stainless-17-4": {"E": 197000, "nu": 0.27, "yield": 1170, "note": "H900"},
    "cast-iron": {"E": 100000, "nu": 0.26, "yield": None,
                  "note": "grey iron is BRITTLE: it fractures without yielding, "
                          "and von Mises is the wrong failure criterion for it"},
    "brass-360": {"E": 97000, "nu": 0.31, "yield": 138, "note": "half hard is ~310"},
    "bronze-932": {"E": 100000, "nu": 0.34, "yield": 125, "note": "SAE 660"},
    "copper": {"E": 117000, "nu": 0.35, "yield": 70, "note": "annealed"},
    "titanium-6al4v": {"E": 113800, "nu": 0.342, "yield": 880, "note": "grade 5"},
    "magnesium-az31": {"E": 45000, "nu": 0.35, "yield": 200, "note": "AZ31B-H24"},
    "zinc-zamak3": {"E": 96000, "nu": 0.29, "yield": 221, "note": "die cast"},
    "abs": {"E": 2200, "nu": 0.35, "yield": None, "note": "polymer"},
    "asa": {"E": 2100, "nu": 0.35, "yield": None, "note": "polymer"},
    "pla": {"E": 3500, "nu": 0.36, "yield": None, "note": "polymer"},
    "petg": {"E": 2100, "nu": 0.38, "yield": None, "note": "polymer"},
    "nylon-pa6": {"E": 2700, "nu": 0.39, "yield": None,
                  "note": "polymer, and PA6 absorbs water: dry and conditioned "
                          "differ by more than a factor of two"},
    "nylon-pa12": {"E": 1700, "nu": 0.40, "yield": None, "note": "polymer"},
    "polycarbonate": {"E": 2300, "nu": 0.37, "yield": None, "note": "polymer"},
    "acrylic": {"E": 3200, "nu": 0.37, "yield": None, "note": "polymer, brittle"},
    "pom-acetal": {"E": 3100, "nu": 0.39, "yield": None, "note": "polymer"},
    "peek": {"E": 3900, "nu": 0.38, "yield": None, "note": "polymer"},
    "hdpe": {"E": 1000, "nu": 0.42, "yield": None, "note": "polymer, creeps"},
    "epoxy-g10": {"E": 18000, "nu": 0.20, "yield": None,
                  "note": "laminate: strongly ANISOTROPIC, and this solve is "
                          "isotropic. Treat any number from it as indicative"},
}

FEM_POLYMER_NOTE = (
    "this material has no yield strength in the table, so no factor of safety "
    "was computed. For a polymer that is deliberate: modulus and strength are "
    "rate- and temperature-dependent and the part creeps under a sustained "
    "load, so a linear elastic factor of safety against a single number would "
    "be a number nobody should act on. Displacement is still indicative. For a "
    "brittle material von Mises is the wrong criterion outright.")

# A mesh finer than this on a first pass is a solve the human sits through
# with a frozen window, and CalculiX is single threaded here.
FEM_NODE_WARN = 250000
FEM_SHARP_EDGE_BUDGET = 400


def _fem_api():
    return _import_probe(FEM_API_CANDIDATES)


def _fem_require(api, key):
    v = api.get(key)
    if v is None:
        raise KoiOpError(
            "this FreeCAD has no importable %s module (tried %s). The FEM "
            "workbench is not available here -- say that, rather than "
            "reporting the design as unverified for some other reason."
            % (key, ", ".join(c[0] for c in FEM_API_CANDIDATES[key])))
    return v["m"]


def _fem_binaries():
    """Where the two external programs are, or that they are not there.

    Neither gmsh nor CalculiX ships inside FreeCAD's Python: they are separate
    binaries, and a container image that has the FEM workbench menu very often
    has neither. That is a deployment fact, not a modelling one, and it is
    worth answering before a session designs a load case it cannot solve.
    check_prerequisites() is still the authority -- this is the early answer.
    """
    out = {"gmsh": None, "ccx": None}
    try:
        import shutil
    except Exception:
        shutil = None
    try:
        p = App.ParamGet("User parameter:BaseApp/Preferences/Mod/Fem/Gmsh")
        out["gmsh"] = p.GetString("gmshBinaryPath", "") or None
    except Exception:
        pass
    try:
        p = App.ParamGet("User parameter:BaseApp/Preferences/Mod/Fem/Ccx")
        out["ccx"] = p.GetString("ccxBinaryPath", "") or None
    except Exception:
        pass
    if shutil is not None:
        if not out["gmsh"]:
            out["gmsh"] = shutil.which("gmsh")
        if not out["ccx"]:
            for cand in ("ccx", "ccx_2.21", "ccx_2.20", "ccx_2.19", "CalculiX"):
                found = shutil.which(cand)
                if found:
                    out["ccx"] = found
                    break
    return out


def _fem_factory(OF, names, what):
    for n in names:
        f = getattr(OF, n, None)
        if callable(f):
            return f, n
    raise KoiOpError(
        "this build of ObjectsFem exposes no %s factory (tried %s). Report "
        "that the workbench is present but this call is not wired for this "
        "build -- do not improvise one." % (what, ", ".join(names)))


def _fem_add(analysis, obj):
    try:
        analysis.addObject(obj)
        return True
    except Exception:
        try:
            grp = list(analysis.Group)
            grp.append(obj)
            analysis.Group = grp
            return True
        except Exception:
            return False


def _fem_members(analysis):
    try:
        return list(analysis.Group)
    except Exception:
        return []


def _fem_of_type(analysis, frag):
    out = []
    for o in _fem_members(analysis):
        try:
            if frag in str(o.TypeId):
                out.append(o)
        except Exception:
            continue
    return out


def _fem_analysis(doc, ref):
    if not ref:
        raise KoiOpError(
            "this mode acts on an existing analysis, so it needs 'analysis': "
            "the id that mode 'study' registered")
    o = _resolve_or_die(doc, ref, "analysis")
    if "Fem::FemAnalysis" not in str(getattr(o, "TypeId", "")):
        raise KoiOpError(
            "%r is %s, not an FEM analysis. Pass the id that mode 'study' "
            "registered." % (ref, getattr(o, "TypeId", "?")))
    return o


def _fem_record(doc, analysis):
    raw = _meta(doc).get(FEM_PREFIX + analysis.Name)
    if not raw:
        return {}
    try:
        return _json.loads(raw)
    except Exception:
        return {}


def _fem_record_set(doc, analysis, patch):
    rec = _fem_record(doc, analysis)
    rec.update(patch)
    _meta_set(doc, FEM_PREFIX + analysis.Name, _json.dumps(rec))
    return rec


def _fem_shape_sig(o):
    """Cheap identity for "is this still the shape that was solved".

    Volume alone misses a fillet that moved material without changing it, so
    the face count and the bounding box go in too. It is a signature, not a
    hash of the BRep: it catches the edits a human would call a design change.
    """
    sh = _dfm_shape(o)
    if sh is None:
        return None
    try:
        bb = sh.BoundBox
        return {"volumeMm3": round(float(sh.Volume), 4),
                "faces": len(sh.Faces),
                "diagMm": round(float(bb.DiagonalLength), 4)}
    except Exception:
        return None


def _fem_sig_changed(a, b):
    if not a or not b:
        return False
    for k in ("volumeMm3", "faces", "diagMm"):
        va, vb = a.get(k), b.get(k)
        if va is None or vb is None:
            continue
        if k == "faces":
            if int(va) != int(vb):
                return True
        elif abs(float(va) - float(vb)) > max(1e-6, abs(float(va)) * 1e-6):
            return True
    return False


def _fem_results(analysis):
    out = []
    for o in _fem_members(analysis):
        try:
            if o.isDerivedFrom("Fem::FemResultObject"):
                out.append(o)
        except Exception:
            if "Result" in str(getattr(o, "TypeId", "")):
                out.append(o)
    return out


def _fem_mesh_obj(analysis):
    for o in _fem_members(analysis):
        try:
            if "Fem::FemMesh" in str(o.TypeId) or "MeshGmsh" in str(o.Name):
                if hasattr(o, "FemMesh"):
                    return o
        except Exception:
            continue
    return None


def _fem_mesh_stats(mesh):
    fm = getattr(mesh, "FemMesh", None)
    out = {"nodes": 0, "edges": 0, "faces": 0, "volumes": 0}
    if fm is None:
        return out
    for key, attr in (("nodes", "NodeCount"), ("edges", "EdgeCount"),
                      ("faces", "FaceCount"), ("volumes", "VolumeCount")):
        try:
            out[key] = int(getattr(fm, attr))
        except Exception:
            out[key] = 0
    try:
        out["elementSizeMm"] = round(float(mesh.CharacteristicLengthMax.Value), 4)
    except Exception:
        try:
            out["elementSizeMm"] = round(float(mesh.CharacteristicLengthMax), 4)
        except Exception:
            out["elementSizeMm"] = None
    return out


def _fem_qty(value, unit):
    try:
        return App.Units.Quantity("%.10g %s" % (float(value), unit))
    except Exception:
        return float(value)


def _fem_set(obj, prop, value):
    try:
        setattr(obj, prop, value)
        return True
    except Exception:
        return False


def _fem_read(obj, prop):
    try:
        v = getattr(obj, prop)
    except Exception:
        return None
    try:
        return round(float(v.Value), 6)
    except Exception:
        pass
    try:
        return round(float(v), 6)
    except Exception:
        return _plain(v)


def _fem_material_card(args):
    """(FreeCAD material dict, reply row). Refuses to invent a modulus.

    A density is enough for a BOM and is nowhere near enough for a solve. If
    the name is not in the table, an explicit E and nu are required rather
    than defaulted: every displacement and every stress scales with them, and
    a modulus recalled from memory is the kind of number this whole skill
    exists to stop being recalled from memory.
    """
    name = str(args.get("material") or "").strip().lower()
    E = args.get("E")
    nu = args.get("nu")
    rho = args.get("density")
    rec = FEM_MATERIALS.get(name) if name else None
    yld = None
    src = "argument"
    if rec is not None:
        src = "table"
        E = float(E) if E is not None else float(rec["E"])
        nu = float(nu) if nu is not None else float(rec["nu"])
        yld = rec.get("yield")
        if rho is None:
            drec = MATERIALS.get(name)
            rho = float(drec["density"]) if drec else None
    if E is None or nu is None:
        near = [k for k in sorted(FEM_MATERIALS)
                if name and name.split("-")[0] in k]
        raise KoiOpError(
            "no elastic properties for %r. %s Pass E (MPa) and nu explicitly "
            "for anything not in the table, and quote the datasheet rather "
            "than recalling it: every stress and every displacement in the "
            "result scales with them."
            % (name or "(no material given)",
               ("Did you mean: " + ", ".join(near) + ".") if near
               else "Call fn 'fem' with mode 'materials' for the list."))
    E = float(E)
    nu = float(nu)
    if E <= 0 or E > 1.5e6:
        raise KoiOpError(
            "E is Young's modulus in MPa and %r is not one: steel is 205000, "
            "aluminium 68900, a stiff polymer about 3000." % E)
    if nu <= -1.0 or nu >= 0.5:
        raise KoiOpError(
            "nu is Poisson's ratio and must be between -1 and 0.5 (0.5 is "
            "incompressible and will not solve); %r is not." % nu)
    if rho is None:
        rho = 7.85
    card = {
        "Name": name or "custom",
        "YoungsModulus": "%.10g MPa" % E,
        "PoissonRatio": "%.10g" % nu,
        "Density": "%.10g kg/m^3" % (float(rho) * 1000.0),
    }
    row = {"material": name or "custom", "youngsModulusMPa": E,
           "poissonRatio": nu, "densityGcm3": float(rho),
           "yieldMPa": yld, "source": src}
    if rec is not None and rec.get("note"):
        row["note"] = rec["note"]
    if yld is None:
        row["yieldNote"] = FEM_POLYMER_NOTE
    return card, row


def _fem_sharp_edges(shape, budget=FEM_SHARP_EDGE_BUDGET):
    """Concave edges with no radius: where a linear elastic peak is fiction.

    Same test the DFM corner check uses, without the tool-axis filter -- a
    stress riser does not care which way the cutter came from. A filleted
    corner sums to a tangent join and is correctly not counted.
    """
    import Part
    out = []
    seen = 0
    try:
        edges = shape.Edges
    except Exception:
        return out
    for e in edges:
        seen += 1
        if seen > budget:
            break
        try:
            fs = shape.ancestorsOfType(e, Part.Face)
        except Exception:
            continue
        if len(fs) != 2:
            continue
        if _edge_concave(shape, e, fs[0], fs[1]) is not True:
            continue
        out.append(e)
    return out


def _fem_singularity(shape, point, elem_size):
    """How far the peak node is from the nearest sharp internal corner.

    This is the whole reason a reported peak stress can be worthless. At a
    re-entrant corner the elastic solution is unbounded: halve the element
    size and the number goes up, forever. Distance is measured rather than
    guessed at, and the threshold is in elements rather than millimetres
    because that is the scale over which the singular field is resolved.
    """
    if point is None:
        return None
    sharp = _fem_sharp_edges(shape)
    if not sharp:
        return {"sharpEdges": 0, "peakNearCornerMm": None,
                "singularitySuspect": False}
    import Part
    try:
        v = Part.Vertex(App.Vector(point[0], point[1], point[2]))
    except Exception:
        return None
    best = None
    for e in sharp:
        try:
            d = float(e.distToShape(v)[0])
        except Exception:
            continue
        if best is None or d < best:
            best = d
    if best is None:
        return {"sharpEdges": len(sharp), "peakNearCornerMm": None,
                "singularitySuspect": False}
    band = max(2.0 * float(elem_size or 0.0), 0.5)
    out = {"sharpEdges": len(sharp),
           "peakNearCornerMm": round(best, 4),
           "bandMm": round(band, 4),
           "singularitySuspect": bool(best <= band)}
    if out["singularitySuspect"]:
        out["singularityNote"] = (
            "the peak stress node is %.3f mm from a SHARP internal corner, "
            "which is inside the band this mesh can resolve. At a zero-radius "
            "re-entrant corner the linear elastic stress is a SINGULARITY: it "
            "rises without bound as the mesh refines, so this peak is a "
            "property of the mesh and not of the part. Do not quote it and do "
            "not divide a factor of safety out of it. Either fillet the "
            "corner and re-solve -- which is what the part needs anyway -- or "
            "report the p99 field stress and say the peak was discarded and "
            "why." % best)
    return out


def _fem_result_stats(doc, analysis, result, shape, elem_size):
    """Read the result field. The peak alone is the number most likely to lie."""
    out = {"result": result.Name}
    vm = []
    disp = []
    try:
        vm = [float(x) for x in (result.vonMises or [])]
    except Exception:
        vm = []
    try:
        disp = [float(x) for x in (result.DisplacementLengths or [])]
    except Exception:
        disp = []
    out["nodeCount"] = len(vm)
    if not vm:
        out["readable"] = False
        out["note"] = (
            "the solver produced a result object with no von Mises field. "
            "Nothing here is a stress -- report it as a failed solve, not as "
            "a part that passed.")
        return out
    out["readable"] = True
    s = sorted(vm)

    def pct(p):
        i = int(round((len(s) - 1) * p))
        return s[max(0, min(len(s) - 1, i))]

    peak = s[-1]
    out["maxVonMisesMPa"] = round(peak, 4)
    out["p99VonMisesMPa"] = round(pct(0.99), 4)
    out["p95VonMisesMPa"] = round(pct(0.95), 4)
    out["medianVonMisesMPa"] = round(pct(0.5), 4)
    if disp:
        out["maxDisplacementMm"] = round(max(disp), 6)
    # Where the peak is, so the singularity test has somewhere to measure from.
    point = None
    try:
        idx = vm.index(peak)
        nid = list(result.NodeNumbers)[idx]
        node = result.Mesh.FemMesh.Nodes[nid]
        point = [float(node.x), float(node.y), float(node.z)]
        out["peakAt"] = [round(c, 4) for c in point]
        out["peakNode"] = int(nid)
    except Exception:
        out["peakAt"] = None
    try:
        sing = _fem_singularity(shape, point, elem_size)
        if sing:
            out.update(sing)
    except Exception as e:
        out["singularitySuspect"] = None
        out["singularityNote"] = (
            "the corner check did not run (%s), so whether this peak is a "
            "singularity is UNKNOWN. Unknown is not a pass." % e)
    # Small-strain sanity. Linear static assumes the deflection does not
    # change the stiffness; a beam that has moved a tenth of its own size has
    # left the assumption behind, and the usual cause is a missing restraint
    # rather than a bendy part.
    try:
        diag = float(shape.BoundBox.DiagonalLength)
        if disp and diag > 0:
            ratio = max(disp) / diag
            out["displacementOverSizePct"] = round(ratio * 100.0, 4)
            if ratio > 0.1:
                out["displacementImplausible"] = True
                out["displacementNote"] = (
                    "the largest displacement is %.1f%% of the part's own "
                    "size. Linear static assumes small displacements, so this "
                    "result is outside its own assumptions -- and the usual "
                    "cause is not a bendy part, it is a model that is not "
                    "properly restrained and is partly moving as a rigid "
                    "body. Check the restraints before reading anything "
                    "else." % (ratio * 100.0))
    except Exception:
        pass
    return out


def _fem_verdict(stats, yld):
    """The factor of safety, or a named refusal to compute one."""
    out = {}
    if not stats.get("readable"):
        out["solved"] = False
        return out
    out["solved"] = True
    if yld is None:
        out["factorOfSafety"] = None
        out["factorOfSafetyNote"] = FEM_POLYMER_NOTE
        return out
    peak = stats.get("maxVonMisesMPa") or 0.0
    p99 = stats.get("p99VonMisesMPa") or 0.0
    out["yieldMPa"] = yld
    out["factorOfSafetyPeak"] = round(yld / peak, 3) if peak > 1e-9 else None
    out["factorOfSafetyP99"] = round(yld / p99, 3) if p99 > 1e-9 else None
    if stats.get("singularitySuspect"):
        out["factorOfSafety"] = None
        out["factorOfSafetyNote"] = (
            "no single factor of safety is reported, because the peak stress "
            "sits on a sharp corner and is mesh-dependent. factorOfSafetyP99 "
            "is the field away from the singularity; it is not a substitute "
            "for filleting the corner and re-solving.")
    else:
        out["factorOfSafety"] = out["factorOfSafetyPeak"]
        if out["factorOfSafety"] is not None and out["factorOfSafety"] < 1.0:
            out["yields"] = True
            out["yieldNote"] = (
                "the peak von Mises stress EXCEEDS the yield strength: this "
                "part yields under the load as modelled. Say so plainly.")
    return out


def _fem_lint(doc):
    """Results that no longer describe the part they were solved on.

    The same class of failure as split-stale, and worse in consequence: a
    stale toolpath produces a bad part, a stale factor of safety produces a
    part somebody trusts. Recorded at solve time, checked every turn, and it
    keeps reporting until the analysis is re-solved or removed.
    """
    rows = []
    m = _meta(doc)
    for k in sorted(m):
        if not k.startswith(FEM_PREFIX):
            continue
        try:
            rec = _json.loads(m[k])
        except Exception:
            continue
        name = k[len(FEM_PREFIX):]
        analysis = doc.getObject(name)
        if analysis is None:
            continue
        if not rec.get("solvedSig"):
            continue
        if not _fem_results(analysis):
            continue
        target = doc.getObject(str(rec.get("target") or ""))
        if target is None:
            rows.append({
                "level": "warn", "object": name, "code": "fem-target-gone",
                "message": "the solid this analysis was solved on (%s) is no "
                           "longer in the document, so its results describe "
                           "nothing that exists" % rec.get("target")})
            continue
        now = _fem_shape_sig(target)
        if _fem_sig_changed(rec.get("solvedSig"), now):
            rows.append({
                "level": "warn", "object": target.Name, "code": "fem-stale",
                "message": "%s has changed since %s was solved. The stress "
                           "and displacement results, and any factor of "
                           "safety quoted from them, describe the OLD shape: "
                           "re-mesh and re-solve before repeating any of "
                           "them" % (target.Name, name)})
    return rows


def _fem_do_mesh(doc, api, analysis, rec, elem_size, report):
    """Create or update the mesh and generate it. Raises rather than returning
    a mesh nobody can solve on."""
    OF = _fem_require(api, "objects")
    target = doc.getObject(str(rec.get("target") or ""))
    if target is None:
        raise KoiOpError(
            "this analysis has no target solid recorded. Re-create it with "
            "mode 'study'.")
    mesh = _fem_mesh_obj(analysis)
    created = False
    if mesh is None:
        maker, spelled = _fem_factory(OF, ("makeMeshGmsh",), "mesh")
        mesh = maker(doc, _safe_name((rec.get("id") or "fem") + "_mesh", "FEMMesh"))
        created = True
        report["meshFactory"] = spelled
    # 1.0 renamed the mesh object's shape link from Part to Shape and kept
    # neither as an alias, so both are tried and the one that took is reported.
    bound = None
    for prop in ("Shape", "Part"):
        if hasattr(mesh, prop) and _fem_set(mesh, prop, target):
            bound = prop
            break
    if bound is None:
        raise KoiOpError(
            "this build's mesh object accepts neither Shape nor Part as the "
            "solid to mesh. Report that the FEM workbench is present but not "
            "wired for this build.")
    report["meshShapeProperty"] = bound
    if elem_size is not None:
        if not _fem_set(mesh, "CharacteristicLengthMax",
                        _fem_qty(elem_size, "mm")):
            _fem_set(mesh, "CharacteristicLengthMax", float(elem_size))
    if created:
        _fem_add(analysis, mesh)
    GmshTools = getattr(_fem_require(api, "gmsh"), "GmshTools")
    err = None
    try:
        err = GmshTools(mesh).create_mesh()
    except Exception as e:
        err = "%s: %s" % (type(e).__name__, e)
    doc.recompute()
    stats = _fem_mesh_stats(mesh)
    if err:
        stats["gmshError"] = str(err)[:800]
    bins = _fem_binaries()
    if stats["nodes"] == 0:
        raise KoiOpError(
            "gmsh produced NO nodes, so there is no mesh and nothing can be "
            "solved. gmsh binary: %s. %s"
            % (bins.get("gmsh") or "not found on PATH or in FreeCAD's "
                                   "preferences -- it is a separate program "
                                   "and this install may not carry it",
               ("gmsh said: %s" % str(err)[:400]) if err else ""))
    if stats["volumes"] == 0:
        raise KoiOpError(
            "the mesh has %d nodes and ZERO volume elements: it is a surface "
            "mesh on a solid, which has no stiffness. CalculiX would either "
            "refuse it or return a displacement field that means nothing. "
            "Check the target really is a solid, then re-mesh."
            % stats["nodes"])
    if stats["nodes"] > FEM_NODE_WARN:
        stats["sizeNote"] = (
            "%d nodes. CalculiX runs single threaded on the same thread that "
            "owns the document, and nothing can preempt it: the human's "
            "FreeCAD window will not respond until this solve finishes. Say "
            "so before starting it, or re-mesh coarser."
            % stats["nodes"])
    return mesh, stats


def _fem_do_solve(doc, api, analysis, report):
    """Run CalculiX. Everything that can be refused is refused BEFORE this."""
    ccxmod = _fem_require(api, "ccx")
    solvers = _fem_of_type(analysis, "Solver") or [
        o for o in _fem_members(analysis) if "Solver" in str(getattr(o, "Name", ""))]
    if not solvers:
        raise KoiOpError(
            "this analysis has no solver object. Re-create it with mode "
            "'study', which adds one.")
    solver = solvers[0]
    try:
        fea = ccxmod.FemToolsCcx(analysis, solver)
    except Exception:
        fea = ccxmod.FemToolsCcx()
    fea.update_objects()
    fea.setup_working_dir()
    fea.setup_ccx()
    msg = ""
    try:
        msg = fea.check_prerequisites() or ""
    except Exception as e:
        msg = "%s: %s" % (type(e).__name__, e)
    if msg:
        bins = _fem_binaries()
        raise KoiOpError(
            "CalculiX refused to run: %s. (ccx binary: %s.) Nothing was "
            "solved -- this is a missing prerequisite, not a result, and it "
            "must not be reported as one."
            % (str(msg)[:600],
               bins.get("ccx") or "not found on PATH or in FreeCAD's "
                                  "preferences; it is a separate program and "
                                  "this install may not carry it"))
    try:
        fea.purge_results()
    except Exception:
        pass
    fea.write_inp_file()
    import time as _time
    t0 = _time.time()
    fea.ccx_run()
    fea.load_results()
    report["solveSeconds"] = round(_time.time() - t0, 2)
    try:
        report["workingDir"] = str(fea.working_dir)
    except Exception:
        pass
    out = ""
    try:
        out = str(getattr(fea, "ccx_stdout", "") or "")
    except Exception:
        out = ""
    if "*ERROR" in out.upper():
        tail = [ln for ln in out.splitlines() if "*ERROR" in ln.upper()][:6]
        report["solverErrors"] = tail
        report["solverErrorNote"] = (
            "CalculiX printed an error while solving. Any result loaded after "
            "one of these is suspect: report the error, not the number.")
    return solver


def _op_fem(doc, args, kid):
    """Linear static structural analysis, through the same envelope.

    mode:
      materials  the elastic table. Writes nothing.
      study      create the Analysis, its solver and its material on a solid.
      constrain  add one restraint or one load, on refs the same rules as
                 fillet: a user pick or a query result, never an index this
                 side authored.
      mesh       generate the mesh and refuse the two useless outcomes.
      solve      pre-check, run CalculiX, read the field, judge it.
      converge   re-mesh finer, re-solve, and report whether the answer moved.
      result     read the last result again without re-solving.
      clear      delete the analysis and everything under it.
    """
    mode = str(args.get("mode") or "study")
    api = _fem_api()
    report = {"api": _api_report(api), "mode": mode,
              "binaries": _fem_binaries()}
    if mode == "materials":
        # Carries api and binaries deliberately: this is the cheapest call in
        # the group and it is the one worth making FIRST, because "gmsh and
        # CalculiX are not installed here" is a fact worth having before a
        # load case is designed rather than after.
        report["materials"] = FEM_MATERIALS
        report["count"] = len(FEM_MATERIALS)
        report["note"] = ("E in MPa, nu dimensionless, yield in MPa. A null "
                          "yield is deliberate: see yieldNote. Densities are "
                          "the same table fn 'material' uses.")
        return report

    if mode in ("study", "constrain") and not kid:
        raise KoiOpError(
            "fem mode %r creates an object, so it needs an id -- a handle "
            "like 'fea.bracket' or 'bc.mount_fixed' that a later turn can "
            "address" % mode)

    if mode == "study":
        OF = _fem_require(api, "objects")
        target = args.get("target")
        if not target:
            raise KoiOpError("fem study needs a target: the solid to analyse")
        o = _resolve_or_die(doc, target, "object")
        shape = _dfm_shape(o)
        if shape is None or not getattr(shape, "Solids", None):
            raise KoiOpError(
                "%r has no solid to analyse. An analysis on a sketch or an "
                "empty body meshes nothing and reports no error." % target)
        card, matrow = _fem_material_card(args)
        mk, spelled = _fem_factory(OF, ("makeAnalysis",), "analysis")
        analysis = mk(doc, _safe_name(args.get("name") or kid or "Analysis",
                                      "Analysis"))
        smk, sspelled = _fem_factory(OF, FEM_SOLVER_FACTORIES, "solver")
        solver = smk(doc, "SolverCalculiX")
        _fem_set(solver, "AnalysisType", "static")
        _fem_set(solver, "GeometricalNonlinearity", "linear")
        _fem_set(solver, "MaterialNonlinearity", "linear")
        _fem_add(analysis, solver)
        mmk, mspelled = _fem_factory(OF, ("makeMaterialSolid", "makeMaterial"),
                                     "material")
        mat = mmk(doc, "FemMaterial")
        try:
            m = mat.Material
            m.update(card)
            mat.Material = m
        except Exception as e:
            raise KoiOpError(
                "this build would not take a material card (%s). Without E "
                "and nu nothing solved here would mean anything, so this "
                "stops here rather than solving with a default." % e)
        _fem_add(analysis, mat)
        doc.recompute()
        # Read back rather than trusting the assignment: if the card did not
        # stick, every number downstream is about a material nobody chose.
        got = {}
        try:
            got = dict(mat.Material)
        except Exception:
            got = {}
        matrow["readback"] = {k: got.get(k) for k in
                              ("Name", "YoungsModulus", "PoissonRatio", "Density")}
        if not got.get("YoungsModulus"):
            raise KoiOpError(
                "the material card did not stick: the object reports no "
                "Young's modulus after assignment. Report the FEM workbench "
                "as not wired for this build rather than solving anyway.")
        sig = _fem_shape_sig(o)
        _fem_record_set(doc, analysis, {
            "id": kid, "target": o.Name, "targetId": _id_of(doc, o.Name),
            "material": matrow.get("material"), "yieldMPa": matrow.get("yieldMPa"),
            "createdSig": sig})
        register(doc, kid, analysis)
        report["analysis"] = analysis.Name
        report["target"] = o.Name
        report["solver"] = {"name": solver.Name, "factory": sspelled}
        report["materialFactory"] = mspelled
        report["analysisFactory"] = spelled
        report["material"] = matrow
        report["next"] = (
            "constrain: at least one restraint (fixed or displacement) AND at "
            "least one load (force or pressure). A solve without both is "
            "refused, because an unrestrained model returns rigid-body motion "
            "that reads exactly like deflection.")
        return report

    if mode == "clear":
        analysis = _fem_analysis(doc, args.get("analysis"))
        name = analysis.Name
        gone = _remove_subtree(doc, analysis)
        _meta_set(doc, FEM_PREFIX + name, "")
        report["removed"] = gone
        report["note"] = ("the analysis and its members are gone. The solid "
                          "it was solved on was not touched.")
        return report

    analysis = _fem_analysis(doc, args.get("analysis"))
    rec = _fem_record(doc, analysis)
    report["analysis"] = analysis.Name
    target = doc.getObject(str(rec.get("target") or ""))
    if target is None and mode in ("mesh", "solve", "converge", "result"):
        raise KoiOpError(
            "the solid this analysis was created on (%s) is not in the "
            "document. Nothing can be meshed or solved against it."
            % rec.get("target"))

    if mode == "constrain":
        OF = _fem_require(api, "objects")
        kind = str(args.get("kind") or "").strip().lower()
        if kind not in FEM_CONSTRAINT_FACTORIES:
            raise KoiOpError(
                "kind must be one of %s"
                % ", ".join(sorted(FEM_CONSTRAINT_FACTORIES)))
        refs = args.get("refs")
        if not isinstance(refs, list) or not refs:
            raise KoiOpError(
                "a boundary condition with no references restrains or loads "
                "nothing, and CalculiX will not say so. Pass refs: a user "
                "pick captured with fn 'ref', or the refs array from a query.")
        pairs = []
        resolved = []
        for r in refs[:64]:
            obj, sub = _resolve_ref_sub(doc, r)
            if not sub:
                raise KoiOpError(
                    "%r names a whole object. A boundary condition attaches "
                    "to a face, an edge or a vertex -- query the face you "
                    "mean, or have the user click it." % r)
            # The silent one. A reference onto a different object than the one
            # being meshed resolves fine, stores fine and finds NO NODES: the
            # solver then runs a model without that restraint or that load and
            # reports nothing wrong. Note that a PartDesign feature's own face
            # numbering is not the finished body's, so this cannot be repaired
            # by rewriting the index -- it has to be re-queried.
            if target is not None and obj.Name != target.Name:
                raise KoiOpError(
                    "%r is on %s, and this analysis meshes %s. A boundary "
                    "condition on anything other than the meshed solid finds "
                    "no nodes, and the solve then runs WITHOUT it and reports "
                    "nothing wrong. Query the face on %s instead: an "
                    "intermediate feature's face numbering is not the "
                    "finished body's, so this cannot be fixed by renumbering."
                    % (r, obj.Name, target.Name, target.Name))
            pairs.append((obj, sub))
            resolved.append(obj.Name + ":" + sub)
        mk, spelled = _fem_factory(OF, FEM_CONSTRAINT_FACTORIES[kind], kind)
        con = mk(doc, _safe_name(kid or ("Fem" + kind), "FemConstraint"))
        try:
            con.References = pairs
        except Exception as e:
            raise KoiOpError("this constraint would not take those references: %s" % e)
        applied = {}
        if kind == "force":
            val = _num(args, "magnitude")
            if not _fem_set(con, "Force", _fem_qty(val, "N")):
                _fem_set(con, "Force", float(val))
            applied["forceN"] = _fem_read(con, "Force")
            if args.get("direction"):
                dobj, dsub = _resolve_ref_sub(doc, args.get("direction"))
                if not _fem_set(con, "Direction", (dobj, [dsub] if dsub else [])):
                    raise KoiOpError(
                        "this build would not take that direction reference. "
                        "Omit it and the force acts normal to the loaded face.")
                applied["direction"] = dobj.Name + ":" + dsub
            else:
                applied["directionNote"] = (
                    "no direction given, so the force acts along the normal "
                    "of the referenced face. If the load is not normal to it, "
                    "that is a different load from the one you meant.")
            _fem_set(con, "Reversed", bool(args.get("reversed")))
            applied["reversed"] = bool(args.get("reversed"))
        elif kind == "pressure":
            val = _num(args, "magnitude")
            if not _fem_set(con, "Pressure", _fem_qty(val, "MPa")):
                _fem_set(con, "Pressure", float(val))
            applied["pressureMPa"] = _fem_read(con, "Pressure")
            _fem_set(con, "Reversed", bool(args.get("reversed")))
            applied["reversed"] = bool(args.get("reversed"))
            applied["unitNote"] = (
                "pressure is MPa, which is N/mm2. 1 bar is 0.1 MPa and 1 psi "
                "is 0.0068948 MPa -- convert with fn 'param' rather than in "
                "your head.")
        elif kind == "displacement":
            vals = args.get("values")
            if not isinstance(vals, dict) or not vals:
                raise KoiOpError(
                    "a displacement constraint needs values: {x, y, z}, where "
                    "a number is a prescribed displacement in mm, 'fix' is "
                    "held at zero, and an axis left out is free.")
            for ax in ("x", "y", "z"):
                v = vals.get(ax)
                A = ax.lower()
                if v is None:
                    _fem_set(con, A + "Free", True)
                    _fem_set(con, A + "Fix", False)
                    applied[ax] = "free"
                elif str(v).strip().lower() in ("fix", "fixed", "0", "0.0"):
                    _fem_set(con, A + "Free", False)
                    _fem_set(con, A + "Fix", True)
                    applied[ax] = "fixed"
                else:
                    _fem_set(con, A + "Free", False)
                    _fem_set(con, A + "Fix", False)
                    if not _fem_set(con, A + "Displacement", _fem_qty(v, "mm")):
                        _fem_set(con, A + "Displacement", float(v))
                    applied[ax] = _fem_read(con, A + "Displacement")
        for prop, val in (args.get("props") or {}).items():
            if not _fem_set(con, str(prop), val):
                raise KoiOpError(
                    "%s constraint does not accept %r on this build"
                    % (kind, prop))
        _fem_add(analysis, con)
        doc.recompute()
        register(doc, kid, con)
        # Readback: References is where a renumbered face silently becomes a
        # load on the wrong side of the part, and it recomputes clean.
        back = []
        try:
            for o, subs in con.References:
                for s in (subs if isinstance(subs, (list, tuple)) else [subs]):
                    back.append(o.Name + ":" + s)
        except Exception:
            back = None
        report["constraint"] = {
            "name": con.Name, "kind": kind, "factory": spelled,
            "requested": resolved, "stored": back, "applied": applied}
        if back is not None and sorted(back) != sorted(resolved):
            report["constraint"]["referenceNote"] = (
                "the constraint stored different references from the ones "
                "asked for. Check what it is actually attached to before "
                "solving; a load on the wrong face solves perfectly cleanly.")
        return report

    if mode == "mesh":
        size = args.get("elementSize")
        mesh, stats = _fem_do_mesh(doc, api, analysis, rec,
                                   None if size is None else float(size),
                                   report)
        _fem_record_set(doc, analysis, {"mesh": mesh.Name,
                                        "elementSizeMm": stats.get("elementSizeMm")})
        report["mesh"] = stats
        report["next"] = "solve"
        return report

    if mode in ("solve", "converge"):
        # By substring of TypeId rather than by exact type, and the material
        # by the property it carries rather than by type at all: ObjectsFem
        # has returned makeMaterialSolid as App::MaterialObjectPython on one
        # build and Fem::MaterialCommon on another, and a pre-check that
        # refuses a model which DOES have a material is the same class of
        # wrongness as one that lets a model through without one.
        members = {k: _fem_of_type(analysis, k) for k in
                   ("ConstraintFixed", "ConstraintForce",
                    "ConstraintPressure", "ConstraintDisplacement")}
        materials = [o for o in _fem_members(analysis)
                     if hasattr(o, "Material") and not "Constraint" in str(getattr(o, "TypeId", ""))]
        restraints = (members["ConstraintFixed"] +
                      members["ConstraintDisplacement"])
        loads = members["ConstraintForce"] + members["ConstraintPressure"]
        if not materials:
            raise KoiOpError(
                "this analysis has no material, so it has no stiffness. "
                "Re-create it with mode 'study'.")
        if not restraints:
            raise KoiOpError(
                "this model has NO restraint. A linear static solve of a "
                "floating body has no unique solution: CalculiX either fails "
                "with a singular stiffness matrix or returns rigid-body "
                "motion, and rigid-body motion looks exactly like an enormous "
                "deflection. Add a fixed or displacement constraint that "
                "removes all six degrees of freedom before solving.")
        if not loads:
            raise KoiOpError(
                "this model has no load. A solve with no load returns zero "
                "stress everywhere, and zero stress is not a pass.")
        mesh = _fem_mesh_obj(analysis)
        stats0 = _fem_mesh_stats(mesh) if mesh is not None else None
        if mesh is None or not stats0 or stats0.get("volumes", 0) <= 0:
            raise KoiOpError(
                "this analysis has no volume mesh. Run mode 'mesh' first -- "
                "and read what it says, because a mesh with no volume "
                "elements is the other way to get a clean solve that means "
                "nothing.")
        report["mesh"] = stats0
        _fem_do_solve(doc, api, analysis, report)
        doc.recompute()
        results = _fem_results(analysis)
        if not results:
            raise KoiOpError(
                "the solver ran and produced no result object. Report the "
                "solve as failed; do not describe the part as passing.")
        shape = _dfm_shape(target)
        stats = _fem_result_stats(doc, analysis, results[-1], shape,
                                  stats0.get("elementSizeMm"))
        report["field"] = stats
        report.update(_fem_verdict(stats, rec.get("yieldMPa")))
        sig = _fem_shape_sig(target)
        _fem_record_set(doc, analysis, {
            "solvedSig": sig, "elementSizeMm": stats0.get("elementSizeMm"),
            "peakMPa": stats.get("maxVonMisesMPa"),
            "p99MPa": stats.get("p99VonMisesMPa")})

        if mode == "converge":
            # One mesh is one number with no error bar. Two meshes is the
            # cheapest honest statement about whether the number is converged
            # -- and at a singular corner it will correctly refuse to be.
            factor = float(args.get("factor") or 0.6)
            if not (0.2 <= factor < 1.0):
                raise KoiOpError(
                    "factor is how much finer the second mesh is and must be "
                    "between 0.2 and 1.0; %r is not" % factor)
            base = stats0.get("elementSizeMm")
            if not base:
                raise KoiOpError(
                    "this mesh does not report a characteristic length, so a "
                    "second mesh cannot be scaled from it. Run mode 'mesh' "
                    "with an explicit elementSize first.")
            mesh2, stats2 = _fem_do_mesh(doc, api, analysis, rec,
                                         base * factor, report)
            _fem_do_solve(doc, api, analysis, report)
            doc.recompute()
            results = _fem_results(analysis)
            if not results:
                raise KoiOpError(
                    "the refined solve produced no result object; the coarse "
                    "result above stands alone and is therefore unconverged.")
            fine = _fem_result_stats(doc, analysis, results[-1], shape,
                                     stats2.get("elementSizeMm"))
            report["refined"] = {"mesh": stats2, "field": fine}

            def _delta(a, b):
                if not a or not b:
                    return None
                return round((b - a) / a * 100.0, 2)

            dpeak = _delta(stats.get("maxVonMisesMPa"), fine.get("maxVonMisesMPa"))
            dp99 = _delta(stats.get("p99VonMisesMPa"), fine.get("p99VonMisesMPa"))
            ddisp = _delta(stats.get("maxDisplacementMm"),
                           fine.get("maxDisplacementMm"))
            report["convergence"] = {
                "elementSizeMm": [stats0.get("elementSizeMm"),
                                  stats2.get("elementSizeMm")],
                "peakChangePct": dpeak, "p99ChangePct": dp99,
                "displacementChangePct": ddisp}
            conv = (dp99 is not None and abs(dp99) < 5.0 and
                    (ddisp is None or abs(ddisp) < 5.0))
            report["converged"] = bool(conv)
            report["convergence"]["note"] = (
                "the field moved %s%% between the two meshes. %s"
                % (dp99 if dp99 is not None else "?",
                   "Under 5%%, so the answer is mesh-independent to that "
                   "tolerance." if conv else
                   "That is NOT converged: the number depends on the mesh, so "
                   "quote it as an estimate or refine again. A peak that "
                   "keeps climbing while the p99 settles is the signature of "
                   "a corner singularity, not of a mesh that is too coarse."))
            report["field"] = fine
            report.update(_fem_verdict(fine, rec.get("yieldMPa")))
            _fem_record_set(doc, analysis, {
                "solvedSig": _fem_shape_sig(target),
                "elementSizeMm": stats2.get("elementSizeMm"),
                "peakMPa": fine.get("maxVonMisesMPa"),
                "p99MPa": fine.get("p99VonMisesMPa")})
        else:
            report["converged"] = None
            report["convergenceNote"] = (
                "one mesh is one number with no error bar. Whether it is "
                "mesh-independent is UNKNOWN until it is solved again finer: "
                "mode 'converge' does exactly that. Report converged:null as "
                "an unfinished check, never as a pass.")

        report["loadNote"] = (
            "the loads and restraints are the ones you were given or chose. "
            "Nothing here knows the real service load, the shock case, the "
            "clamping, or how the part is actually held -- and a linear "
            "static solve sees no contact, no buckling, no fatigue and no "
            "plasticity. This is evidence, not a certificate.")
        return report

    if mode == "result":
        results = _fem_results(analysis)
        if not results:
            report["solved"] = None
            report["note"] = ("this analysis has no results: it has not been "
                              "solved, or they were purged. Nothing to read.")
            return report
        mesh = _fem_mesh_obj(analysis)
        stats0 = _fem_mesh_stats(mesh) if mesh is not None else {}
        shape = _dfm_shape(target)
        stats = _fem_result_stats(doc, analysis, results[-1], shape,
                                  stats0.get("elementSizeMm"))
        report["field"] = stats
        report.update(_fem_verdict(stats, rec.get("yieldMPa")))
        now = _fem_shape_sig(target)
        if _fem_sig_changed(rec.get("solvedSig"), now):
            report["stale"] = True
            report["staleNote"] = (
                "%s has CHANGED since this was solved (%s -> %s). These "
                "results, and any factor of safety from them, describe the "
                "old shape. Re-mesh and re-solve before repeating any number "
                "here." % (target.Name, rec.get("solvedSig"), now))
        else:
            report["stale"] = False
        return report

    raise KoiOpError(
        "mode must be materials, study, constrain, mesh, solve, converge, "
        "result or clear (got %r)" % mode)


OPS = {
    "new_document": {"fn": _op_new_document, "mode": "document"},
    "open_document": {"fn": _op_open_document, "mode": "document"},
    "save": {"fn": _op_save, "mode": "document"},
    "import_geometry": {"fn": _op_import, "mode": "write"},
    "sketch_get": {"fn": _op_sketch_get, "mode": "read"},
    "sketch_edit": {"fn": _op_sketch_edit, "mode": "write"},
    "datum_plane": {"fn": _op_datum_plane, "mode": "write"},
    "fillet": {"fn": _op_fillet, "mode": "write"},
    "chamfer": {"fn": _op_chamfer, "mode": "write"},
    "link_array": {"fn": _op_link_array, "mode": "write"},
    "attach": {"fn": _op_attach, "mode": "write"},
    "body": {"fn": _op_body, "mode": "write"},
    "sketch": {"fn": _op_sketch, "mode": "write"},
    "pad": {"fn": _op_pad, "mode": "write"},
    "pocket": {"fn": _op_pocket, "mode": "write"},
    "feature_edit": {"fn": _op_feature_edit, "mode": "write"},
    "delete": {"fn": _op_delete, "mode": "write"},
    "suppress": {"fn": _op_suppress, "mode": "write"},
    "ref": {"fn": _op_ref, "mode": "write"},
    "query": {"fn": _op_query, "mode": "read"},
    "insert": {"fn": _op_insert, "mode": "write"},
    "swap": {"fn": _op_swap, "mode": "write"},
    "hole": {"fn": _op_hole, "mode": "write"},
    "bolt_sketch": {"fn": _op_bolt_sketch, "mode": "write"},
    "param": {"fn": _op_param, "mode": "write"},
    "lookup": {"fn": _op_library, "mode": "read"},
    # The old spelling. 'library' named the thing it reads rather than the act
    # of reading it, which is fine in a dispatch table and wrong in the line
    # the human watches: "FreeCAD library" is not something anybody did. Kept
    # dispatchable so a stored session or a suite that predates the rename
    # still runs; it is not advertised.
    "library": {"fn": _op_library, "mode": "read"},
    "view_set": {"fn": _op_view_set, "mode": "read"},
    "render": {"fn": _op_render, "mode": "read"},
    "isolate": {"fn": _op_isolate, "mode": "write"},
    "show": {"fn": _op_show, "mode": "write"},
    "view_restore": {"fn": _op_view_restore, "mode": "write"},
    "ids": {"fn": _op_ids, "mode": "read"},
    "bind": {"fn": _op_bind, "mode": "write"},
    "revolve": {"fn": _op_revolve, "mode": "write"},
    "groove": {"fn": _op_groove, "mode": "write"},
    "loft": {"fn": _op_loft, "mode": "write"},
    "subtractive_loft": {"fn": _op_subtractive_loft, "mode": "write"},
    "pipe": {"fn": _op_pipe, "mode": "write"},
    "subtractive_pipe": {"fn": _op_subtractive_pipe, "mode": "write"},
    "sweep": {"fn": _op_pipe, "mode": "write"},
    "subtractive_sweep": {"fn": _op_subtractive_pipe, "mode": "write"},
    "draft": {"fn": _op_draft, "mode": "write"},
    "polar_array": {"fn": _op_polar_array, "mode": "write"},
    "pattern": {"fn": _op_pattern, "mode": "write"},
    "mirror": {"fn": _op_mirror, "mode": "write"},
    "primitive": {"fn": _op_primitive, "mode": "write"},
    "boolean": {"fn": _op_boolean, "mode": "write"},
    "allow": {"fn": _op_allow, "mode": "write"},
    "shell": {"fn": _op_shell, "mode": "write"},
    "place": {"fn": _op_place, "mode": "write"},
    "mate": {"fn": _op_mate, "mode": "write"},
    "fastener_pattern": {"fn": _op_fastener_pattern, "mode": "write"},
    "split_body": {"fn": _op_split_body, "mode": "write"},
    "batch": {"fn": _op_batch, "mode": "write"},
    "view_fit": {"fn": _op_view_fit, "mode": "read"},
    "view_section": {"fn": _op_view_section, "mode": "read"},
    "bom": {"fn": _op_bom, "mode": "read"},
    "measure_between": {"fn": _op_measure_between, "mode": "read"},
    "material": {"fn": _op_material, "mode": "write"},
    "recompute": {"fn": _op_recompute, "mode": "write"},
    "capabilities": {"fn": _op_capabilities, "mode": "read"},
    "cam": {"fn": _op_cam, "mode": "write"},
    "fem": {"fn": _op_fem, "mode": "write"},
}

OP_NAMES = sorted(OPS)

# Reads that are about the TABLES rather than about the model. The fastener
# sizes, the catalog and the stock list are compiled into this module and are
# the same whether or not anything is open -- but every non-document op went
# through the same ActiveDocument gate, so attaching to a FreeCAD with no
# document made "what size is an M5 clearance hole" answer "No active
# document. Call new_document". That is the one question a session asks BEFORE
# it has decided what to build.
DOCLESS_OPS = frozenset(("lookup", "library", "capabilities"))


# ---------- measurement (6.4) ----------
#
# Numbers, not appearances. The whole reason this module exists is that a
# screenshot cannot tell a plate with a hole from a plate without one, and the
# state flags cannot either.

MEASURE_LIMIT = 64
PAIR_LIMIT = 256
BOOLEAN_LIMIT = 64


def _is_solidish(o):
    # Same gate as the deep lint, and for the same measurement: a datum plane
    # offset from the origin has a non-zero volume integral and would
    # otherwise be counted as a part, interfered against and put in the BOM.
    if _solids_of(o) is None:
        return False
    try:
        return o.Shape.Volume > 1e-9
    except Exception:
        return False


def _owned_by_body(o):
    # A Pad and the Body that contains it are the same material. Counting them
    # as two parts would report every model as interfering with itself.
    tid = o.TypeId
    if tid.startswith("PartDesign::") and "Body" not in tid:
        return True
    try:
        g = o.getParentGeoFeatureGroup()
        return g is not None and "Body" in g.TypeId
    except Exception:
        return False


def parts(doc=None):
    """The things a human would call parts: bodies, primitives, links."""
    doc = doc or App.ActiveDocument
    if doc is None:
        return []
    return [o for o in doc.Objects if _is_solidish(o) and not _owned_by_body(o)]


def _presentation_parts(doc):
    """The parts a human would count, which is not the same as every solid.

    parts() answers "what has a solid". This answers "what is in the design".
    The difference is everything that made a measure unreadable: the hidden
    solid a split was cut FROM and the hidden master a pattern's links point
    at. Both are real solids, both sit exactly on top of something else, and
    every pair check dutifully reported them interfering with their own copy.
    """
    doc = doc or App.ActiveDocument
    if doc is None:
        return []
    masters = _link_masters(doc)
    sources = _split_sources(doc)
    out = []
    for o in parts(doc):
        if not _visible(o) and (o.Name in masters or o.Name in sources):
            continue
        out.append(o)
    return out


def _metrics(o):
    m = _shape_metrics(o) or {}
    m["name"] = o.Name
    stale = _tip_warning(o)
    if stale:
        m["notTip"] = stale
    m["label"] = o.Label
    m["type"] = o.TypeId
    m["state"] = list(o.State)
    try:
        m["valid"] = bool(o.isValid())
    except Exception:
        m["valid"] = None
    sh = getattr(o, "Shape", None)
    if sh is not None:
        try:
            cg = sh.CenterOfMass
            m["cog"] = [round(cg.x, 6), round(cg.y, 6), round(cg.z, 6)]
        except Exception:
            pass
        try:
            bb = sh.BoundBox
            m["bboxMin"] = [round(bb.XMin, 6), round(bb.YMin, 6), round(bb.ZMin, 6)]
            m["bboxMax"] = [round(bb.XMax, 6), round(bb.YMax, 6), round(bb.ZMax, 6)]
        except Exception:
            pass
        try:
            m["closed"] = bool(sh.isClosed())
        except Exception:
            pass
    if "Sketcher::SketchObject" in o.TypeId:
        m.update(_sk_dof(o))
        m["conflicts"] = [int(x) for x in (getattr(o, "ConflictingConstraints", None) or [])]
        m["redundancies"] = [int(x) for x in (getattr(o, "RedundantConstraints", None) or [])]
    return m


def _bbox_apart(a, b, gap):
    # Separating-axis on the bounding boxes. Cheap, exact as a negative: two
    # shapes whose boxes are apart cannot touch. Never used as a positive.
    try:
        A = a.BoundBox
        B = b.BoundBox
    except Exception:
        return False
    return (A.XMax < B.XMin - gap or B.XMax < A.XMin - gap or
            A.YMax < B.YMin - gap or B.YMax < A.YMin - gap or
            A.ZMax < B.ZMin - gap or B.ZMax < A.ZMin - gap)


def _pairs_of(doc, refs, pairs):
    out = []
    if pairs:
        for p in pairs[:PAIR_LIMIT]:
            if not isinstance(p, (list, tuple)) or len(p) != 2:
                raise KoiOpError("each pair must be [a, b]")
            a = _resolve_or_die(doc, p[0], "object")
            b = _resolve_or_die(doc, p[1], "object")
            out.append((a, b))
        return out
    objs = [_resolve_or_die(doc, r, "object") for r in refs] if refs else parts(doc)
    objs = [o for o in objs if _is_solidish(o)]
    for i in range(len(objs)):
        for j in range(i + 1, len(objs)):
            out.append((objs[i], objs[j]))
            if len(out) >= PAIR_LIMIT:
                return out
    return out


def _instance_of(a, b):
    """True when one of these is an App::Link pointing at the other.

    A link and its master occupy the same space by definition when the master
    has not been moved away, and reporting bolts_face_set against bolts_face_0
    at a full bolt of common volume is a hit nobody can act on. It is
    structural, so it is reported as expected rather than dropped -- and it is
    decided from the link, not from whether the master happens to be hidden.
    """
    for x, y in ((a, b), (b, a)):
        if str(getattr(x, "TypeId", "")) != "App::Link":
            continue
        try:
            linked = x.LinkedObject
        except Exception:
            continue
        if linked is not None and linked.Name == y.Name:
            return True
    return False


def interference(refs=None, pairs=None, doc=None):
    """Common volume per pair. Zero for parts that merely touch.

    The bbox prefilter is not an optimisation detail -- 6.4 sells this as the
    check that runs every turn, and a full OCCT common across every pair is
    O(n^2) booleans. Boxes reject most pairs for the cost of six comparisons,
    and a rejection is exact: shapes whose boxes are apart cannot overlap.
    """
    doc = doc or App.ActiveDocument
    if doc is None:
        return {"pairs": [], "hits": []}
    allowed = allowances(doc)
    todo = _pairs_of(doc, refs, pairs)
    rows = []
    hits = []
    expected = []
    booleans = 0
    truncated = False
    for a, b in todo:
        if _bbox_apart(a.Shape, b.Shape, 0.0):
            rows.append({"a": a.Name, "b": b.Name, "volume": 0.0,
                         "method": "bbox"})
            continue
        if booleans >= BOOLEAN_LIMIT:
            truncated = True
            rows.append({"a": a.Name, "b": b.Name, "volume": None,
                         "method": "skipped"})
            continue
        booleans += 1
        try:
            common = a.Shape.common(b.Shape)
            v = round(common.Volume, 6)
        except Exception as e:
            rows.append({"a": a.Name, "b": b.Name, "volume": None,
                         "method": "failed", "error": str(e)})
            continue
        row = {"a": a.Name, "b": b.Name, "volume": v, "method": "boolean"}
        allow = allowed.get(_allow_key(a.Name, b.Name))
        if allow is not None:
            row["allowed"] = allow
        rows.append(row)
        if v <= 1e-6:
            continue
        if _instance_of(a, b):
            expected.append({
                "a": a.Name, "b": b.Name, "volume": v,
                "why": "one of these is a link to the other: an instance "
                       "standing on its own definition is not a clash"})
            continue
        if allow is None:
            hits.append({"a": a.Name, "b": b.Name, "volume": v})
            continue
        cap = allow.get("upTo")
        if cap is None or v <= float(cap) + 1e-6:
            expected.append({"a": a.Name, "b": b.Name, "volume": v,
                             "why": allow.get("why"), "upTo": cap})
        else:
            hits.append({"a": a.Name, "b": b.Name, "volume": v,
                         "upTo": cap, "why": allow.get("why"),
                         "over": round(v - float(cap), 6),
                         "note": "past its declared allowance"})
    out = {"pairs": rows, "hits": hits, "pairsChecked": len(rows),
           "booleansRun": booleans, "truncated": truncated}
    if expected:
        # Reported, never dropped. A designed overlap that stops being visible
        # is a designed overlap nobody re-checks when the design moves.
        out["expectedOverlaps"] = expected
    if allowed:
        out["allowances"] = allowed
    return out


def clearance(refs=None, pairs=None, doc=None):
    """Minimum distance per pair -- service gaps, wrench access, fit."""
    doc = doc or App.ActiveDocument
    if doc is None:
        return {"pairs": []}
    todo = _pairs_of(doc, refs, pairs)[:BOOLEAN_LIMIT]
    rows = []
    for a, b in todo:
        try:
            d = a.Shape.distToShape(b.Shape)
            dist = round(d[0], 6)
            pts = d[1][0] if len(d) > 1 and d[1] else None
            row = {"a": a.Name, "b": b.Name, "distance": dist}
            if pts:
                row["at"] = [[round(pts[0].x, 6), round(pts[0].y, 6), round(pts[0].z, 6)],
                             [round(pts[1].x, 6), round(pts[1].y, 6), round(pts[1].z, 6)]]
            rows.append(row)
        except Exception as e:
            rows.append({"a": a.Name, "b": b.Name, "distance": None,
                         "error": str(e)})
    return {"pairs": rows}


def measure(refs=None, pairs=None, want_interference=False,
            want_clearance=False, deep_lint=False, doc=None,
            parts_only=False):
    """Numbers about the model.

    parts_only is the difference between a verification a human can read and
    a dump. Without it the default set is every object with a Shape: origin
    planes with infinite boxes, every sketch, every intermediate pocket, and
    then the two bodies and six bolts that were the question truncated off the
    end -- with source-vs-snapshot and master-vs-link pairs filling the hits.
    """
    doc = doc or App.ActiveDocument
    if doc is None:
        return {"document": None, "objects": []}
    if refs:
        objs = [_resolve_or_die(doc, r, "object") for r in refs]
    elif parts_only:
        objs = _presentation_parts(doc)
        refs = [o.Name for o in objs]
    else:
        objs = [o for o in doc.Objects if getattr(o, "Shape", None) is not None]
    truncated = len(objs) > MEASURE_LIMIT
    out = {
        "document": doc.Name,
        "objects": [_metrics(o) for o in objs[:MEASURE_LIMIT]],
        "truncated": truncated,
        "parts": [o.Name for o in parts(doc)],
        "partsOnly": bool(parts_only),
    }
    if parts_only:
        out["measured"] = [o.Name for o in objs]
    if want_interference:
        out["interference"] = interference(refs, pairs, doc)
    if want_clearance:
        out["clearance"] = clearance(refs, pairs, doc)
    if deep_lint:
        out["lint"] = lint(doc, deep=True)
    return out


# ---------- the envelope ----------


def _repair_abort(doc, before_proj):
    """Put back what the abort should have left alone.

    The envelope's contract is that an aborted edit leaves the document as it
    was. On this build the abort can reach past our own transaction and
    RE-CREATE objects the user deleted -- measured twice, with fresh names
    (Origin004, body_doomed), so these are new objects produced during the
    rollback rather than the originals restored. Anything present now and
    absent when we started was made by our abort, and removing it is what
    honouring the contract means.

    Only additions are repairable. Something the abort dropped cannot be
    conjured back, and a reverted constraint cannot be re-deleted blind; both
    are reported instead.
    """
    known = set(o["name"] for o in (before_proj or {}).get("objects", []))
    removed, failed = [], []
    for _pass in range(2):
        stray = [o["name"] for o in project(doc).get("objects", [])
                 if o["name"] not in known]
        if not stray:
            break
        for name in stray[:64]:
            o = doc.getObject(name)
            if o is None:
                continue        # a parent took it with it
            try:
                doc.removeObject(name)
                removed.append(name)
            except Exception as e:
                failed.append({"name": name,
                               "error": "%s: %s" % (type(e).__name__, e)})
    return {"removed": sorted(set(removed)), "failed": failed}


def envelope(label, apply_fn, dry_run=False):
    # apply_fn(doc) -> anything JSON-able. Everything that mutates the document
    # goes through here: edit(), call() and script() differ only in what
    # apply_fn does.
    doc = App.ActiveDocument
    if doc is None:
        return {"ok": False, "applied": False, "aborted": True,
                "reason": "no-document", "code": "no-document",
                "error": "No active document. Open or create one first."}

    try:
        gate()
    except GuiBusy as e:
        # reason, not just code: every caller branches on reason, and a gate
        # that reports its refusal in a field nobody reads is not a gate.
        return {"ok": False, "applied": False, "aborted": True,
                "reason": "gui-busy", "code": "gui-busy", "error": str(e),
                "gui": gui_state()}

    sealed = seal(doc)

    # Measured before the edit so the automatic fit below can tell "the model
    # grew" from "the user hid something".
    span_before = _doc_span(doc)
    before_proj = project(doc)
    before_errors = _error_set(doc)
    u0 = len(doc.UndoNames)

    # Their work since we last looked. Read before we open a transaction, so
    # it describes the document we are about to edit rather than the one we
    # just edited.
    user_changed = user_diff(doc)

    aborted = False
    applied_lint = None
    reason = None
    err = None
    result = None
    new_errors = []
    applied_proj = None
    rehealed = []
    rehealed_ext = []

    _open(label)
    try:
        result = apply_fn(doc)
        doc.recompute()
        new_errors = sorted(_error_set(doc) - before_errors)
        # Before giving up on the whole edit. A dress-up feature placed by
        # query broke because its edges renumbered, not because the change was
        # wrong -- and aborting here is what turned "grow this by 6 mm" into
        # thirteen steps of manual recovery. Re-resolve, recompute, re-check.
        if new_errors:
            rehealed = _reheal_dress(doc, new_errors)
            # A broken projection breaks the SKETCH, and every feature built on
            # it errors with it -- so the names to try are the errors plus the
            # sketches they lead back to, not the errors alone.
            rehealed_ext = _reheal_external(doc, new_errors)
            if rehealed or rehealed_ext:
                doc.recompute()
                new_errors = sorted(_error_set(doc) - before_errors)
        # Captured HERE, while the edit is still in the document. A dry run is
        # about to roll this back, and a report written after the rollback
        # describes the rollback -- which is the one thing the caller already
        # knows and the opposite of what 5.4 asks for.
        applied_proj = project(doc)
        # Same reason, and the one the projection alone does not cover: lint
        # measures shapes. Run after the rollback it reports the health of the
        # document the user already has, so a dry run could not say "this
        # pocket would remove nothing" -- which is most of why anyone dry-runs.
        applied_lint = lint(doc)
        if new_errors:
            aborted, reason = True, "new-recompute-errors"
        elif dry_run:
            aborted, reason = True, "dry-run"
    except Exception as e:
        aborted, reason = True, "exception"
        err = "%s: %s" % (type(e).__name__, e)
        new_errors = []
        rehealed_ext = []

    _close(aborted)
    # Aborting the data layer alone can leave orphaned view providers.
    if aborted and Gui is not None:
        try:
            if Gui.ActiveDocument is not None:
                Gui.ActiveDocument.resetEdit()
        except Exception:
            pass
    doc.recompute()

    after_proj = project(doc)
    repair = None
    if aborted:
        repair = _repair_abort(doc, before_proj)
        if repair["removed"] or repair["failed"]:
            doc.recompute()
            after_proj = project(doc)

    fit = None if aborted else _auto_fit(doc, span_before)
    # Always, and after the fit: moving the camera is a scene change that
    # itself needs a redraw, and _auto_fit only redraws on the turns it
    # decides to move.
    gui_sync = None if aborted else _gui_sync(doc)

    u1 = len(doc.UndoNames)
    booked = u1 - u0

    res = {
        # ok  = the edit was correct.
        # applied = it is still in the document.
        # They differ for a dry run, which is a successful edit deliberately
        # rolled back -- reporting that as ok:false would make every preview
        # look like a failure.
        "ok": (err is None) and not new_errors,
        "applied": not aborted,
        "aborted": aborted,
        "reason": reason,
        "error": err,
        "newErrors": new_errors,
        "sealed": sealed,
        "undoEntries": booked,
        # Reported, not promised. The same call booked 1 entry in one run and 0
        # in the next; the user-facing claim is that one Ctrl+Z puts it back,
        # and that is only true when this is 1.
        "singleUndo": booked == 1,
        "diff": _diff(before_proj, after_proj),
        # A dry run reports the state it previewed; every other outcome reports
        # the document as it now stands.
        "lint": applied_lint if (aborted and reason == "dry-run"
                                 and applied_lint is not None) else lint(doc),
        "projection": after_proj,
        "result": result,
    }
    # Only when the user has picks stored, so a document with none pays
    # nothing. An edit that broke a reference has to say so in the same breath
    # as the edit, not wait for the next turn to discover it.
    if stored_refs(doc):
        rep = refs_report(doc)
        res["refs"] = rep["refs"]
        res["refsBroken"] = rep["broken"]
        res["refsMoved"] = rep["moved"]
    # 5.4: the review packet. Cheap -- both projections are already in hand --
    # and it is what turns "3 objects changed" into a blast radius.
    if user_changed.get("baseline") and (
            user_changed.get("added") or user_changed.get("removed") or
            user_changed.get("changed") or user_changed.get("revertedAiObjects")):
        res["userChanged"] = user_changed
    if fit:
        # The camera is theirs, so a move of it is reported like any other
        # change to what they see.
        res["viewFit"] = fit
    # Only when it did NOT work. A successful repaint is the expected case and
    # says nothing worth a line in every reply; a failed one means the human
    # is looking at a stale window while the reply says the edit landed, and
    # that has to reach the model in the same breath as the edit.
    if gui_sync is not None and not gui_sync.get("redrawn"):
        res["guiSync"] = gui_sync
        res["guiSyncNote"] = (
            "the edit is in the document but the 3D view was not refreshed. "
            "What the human can see may be the model as it was BEFORE this "
            "change -- say so rather than describing the viewport, and use "
            "freecad_render for a picture that is definitely current.")
    if rehealed:
        res["rehealed"] = rehealed
        res["rehealedNote"] = (
            "%s errored after this edit and %s edges were re-resolved from "
            "the filter stored with them. The edit was NOT aborted. These may "
            "not be the same edges -- check the result before reporting it"
            % (", ".join(r["feature"] for r in rehealed),
               "its" if len(rehealed) == 1 else "their"))
    if rehealed_ext:
        res["rehealedExternal"] = rehealed_ext
        lost = sum(r.get("lostConstraints") or 0 for r in rehealed_ext)
        res["rehealedExternalNote"] = (
            "%s had its projected geometry re-resolved from the filter stored "
            "with it. %s"
            % (", ".join(r["sketch"] for r in rehealed_ext),
               ("This cost %d constraint(s) -- FreeCAD deletes what "
                "referenced the old projection, so the sketch may solve and "
                "be the WRONG SHAPE. Check it before reporting this edit."
                % lost) if lost else
               "No constraints were lost, but these may not be the same "
               "edges -- check the result."))
    if aborted and reason == "dry-run" and applied_lint is not None:
        res["lintNote"] = ("lint describes the previewed state, not the "
                           "document: the change has been rolled back")
    res["report"] = change_report(before_proj, applied_proj or after_proj,
                                  new_errors, res.get("refsBroken"))
    # An abort is supposed to undo our edit and nothing else. It shares an undo
    # stack with the human, so measure that rather than trusting it: if the
    # document is not back where it started, something of theirs moved, and a
    # dry run that resurrects an object they deleted is worse than no dry run.
    if aborted:
        if repair and (repair["removed"] or repair["failed"]):
            res["abortRepaired"] = repair
        stray = _diff(before_proj, after_proj)
        if stray["added"] or stray["removed"] or stray["changed"]:
            res["abortOverreach"] = stray
            res["abortNote"] = (
                "rolling this back STILL did not leave the document as it "
                "was, after repair: "
                + ", ".join(
                    (["re-added " + ", ".join(stray["added"][:6])] if stray["added"] else [])
                    + (["dropped " + ", ".join(stray["removed"][:6])] if stray["removed"] else [])
                    + (["altered " + ", ".join(c["name"] for c in stray["changed"][:6])]
                       if stray["changed"] else []))
                + ". Tell the user and check anything they deleted recently.")
    # Re-baseline so our own edit does not come back next turn as something
    # the user did. An aborted edit changed nothing, so it leaves the baseline
    # alone.
    if not aborted:
        observe(doc)
    elif res.get("abortOverreach"):
        # The rollback did NOT put the document back, so the baseline no
        # longer describes anything that exists. Keeping it meant the next
        # turn read our own residue as the human's work and reported them as
        # having moved objects they had never touched -- a false rejection
        # signal, on the one check that decides whether we are allowed to
        # touch those objects at all.
        observe(doc)
        res["rebaselined"] = True
        res["rebaselineNote"] = (
            "the rollback left the document changed, so the turn baseline was "
            "retaken against what is actually there. Those changes are OURS: "
            "they will not appear as user edits next turn, and abortOverreach "
            "above is the only record of them.")
    return res


def _ns(doc):
    return {"App": App, "FreeCAD": App, "Gui": Gui, "doc": doc, "koi": _self()}


def edit(name, code, dry_run=False):
    def _apply(doc):
        ns = _ns(doc)
        exec(compile(code, "<koi-edit>", "exec"), ns, ns)
        return None

    return envelope(name, _apply, dry_run=dry_run)


# ---------- the dispatcher (6.2) ----------


def _stale_gate(doc):
    """Refuse to edit a document nobody has looked at.

    5.2 makes sync the mandatory turn opener. Enforcing "once per turn" needs
    to know where turns begin, which only the conversation layer sees -- but
    the failure that actually costs the user their work is narrower and is
    visible from here: editing a document this session has never read. That is
    not a discipline problem, it is editing blind, so it fails closed.

    Ongoing drift is reported, not refused. The user adding a box does not
    make our next edit wrong, and a rule that refuses every edit after every
    keystroke of theirs would train the model to sync mechanically rather than
    to read what changed.
    """
    pre = user_diff(doc)
    if pre.get("baseline") is False:
        return {
            "ok": False, "applied": False, "aborted": True,
            "reason": "no-sync", "code": "no-sync", "userDiff": pre,
            "error": "This document has not been read this session. Call "
                     "freecad_sync first: the human may have moved, deleted "
                     "or rejected something, and editing from a picture you "
                     "have never taken is how their work gets overwritten.",
        }
    return None


def call(fn, args=None, kid=None, label=None, dry_run=False):
    args = args if isinstance(args, dict) else {}
    spec = OPS.get(fn)
    if spec is None:
        return {"ok": False, "applied": False, "reason": "unknown-fn",
                "code": "unknown-fn", "error": "unknown fn %r" % (fn,),
                "available": sorted(OPS)}
    if spec["mode"] == "document":
        # Before the no-document check, necessarily: this is the op that ends
        # that condition. Outside the envelope too -- there is no document to
        # open a transaction on, and a document's creation is not something a
        # rollback can meaningfully undo.
        try:
            out = spec["fn"](args, kid)
        except Exception as e:
            return {"ok": False, "applied": False, "mode": "document",
                    "fn": fn, "id": kid,
                    "error": "%s: %s" % (type(e).__name__, e)}
        return {"ok": True, "applied": True, "mode": "document", "fn": fn,
                "id": kid, "result": out}

    doc = App.ActiveDocument
    if doc is None and fn in DOCLESS_OPS:
        # Dispatched with doc=None on purpose; the op reports which of its
        # sections it could not fill rather than pretending it filled them.
        try:
            out = spec["fn"](None, args, kid)
            return {"ok": True, "applied": False, "mode": spec["mode"],
                    "fn": fn, "id": kid, "result": out, "document": None}
        except Exception as e:
            return {"ok": False, "applied": False, "mode": spec["mode"],
                    "fn": fn, "id": kid,
                    "error": "%s: %s" % (type(e).__name__, e)}
    if doc is None:
        return {"ok": False, "applied": False, "reason": "no-document",
                "code": "no-document",
                "error": "No active document. Call freecad_call({fn: "
                         "'new_document'}) to make one, or ask the user to "
                         "open theirs."}

    if spec["mode"] == "read":
        # No transaction and no gate. A read that opened a transaction would
        # book an undo entry for looking, and refusing to measure while the
        # user has a sketch open would make the gate an obstacle rather than a
        # protection.
        try:
            out = spec["fn"](doc, args, kid)
            return {"ok": True, "applied": False, "mode": "read", "fn": fn,
                    "id": kid, "result": out}
        except Exception as e:
            return {"ok": False, "applied": False, "mode": "read", "fn": fn,
                    "id": kid, "error": "%s: %s" % (type(e).__name__, e)}

    blocked = _stale_gate(doc)
    if blocked is not None:
        blocked["fn"] = fn
        blocked["id"] = kid
        return blocked

    def _apply(d):
        return spec["fn"](d, args, kid)

    res = envelope(label or ("%s %s" % (fn, kid or "")).strip(), _apply,
                   dry_run=dry_run)
    res["fn"] = fn
    res["id"] = kid
    res["mode"] = "write"
    return res


# ---------- free Python (6.2) ----------


def _exec_with_deadline(code, ns, seconds):
    # sys.settrace is the only thing that can preempt a runaway Python loop
    # from inside this interpreter: the main thread is single-threaded, there
    # is no signal, and a JS-side timeout cannot interrupt a frame that never
    # yields (5.1). It does NOT bound work inside OCCT -- a heavy boolean runs
    # in C++ and emits no Python line events -- so this bounds our loops, not
    # the kernel's.
    import sys
    import time

    end = time.time() + float(seconds)

    def _hook(frame, event, arg):
        if time.time() > end:
            raise KoiTimeout(
                "script exceeded its %.1fs deadline; every loop sent through "
                "this channel must be bounded" % float(seconds))
        return _hook

    obj = compile(code, "<koi-script>", "exec")
    sys.settrace(_hook)
    try:
        exec(obj, ns, ns)
    finally:
        sys.settrace(None)
    return ns.get("result")


def script(code, label="Koi script", dry_run=False, deadline_s=10.0):
    blocked = _stale_gate(App.ActiveDocument) if App.ActiveDocument else None
    if blocked is not None:
        return blocked

    def _apply(doc):
        ns = _ns(doc)
        return {"returned": _exec_with_deadline(code, ns, deadline_s)}

    res = envelope(label, _apply, dry_run=dry_run)
    _flag_orphans(App.ActiveDocument, res)
    return res


def _diff(a, b):
    ai = dict((o["name"], o) for o in a.get("objects", []))
    bi = dict((o["name"], o) for o in b.get("objects", []))
    added = sorted(set(bi) - set(ai))
    removed = sorted(set(ai) - set(bi))
    changed = []
    for n in sorted(set(ai) & set(bi)):
        if ai[n]["props"] != bi[n]["props"] or ai[n]["shape"] != bi[n]["shape"]:
            fields = sorted(
                k for k in set(list(ai[n]["props"]) + list(bi[n]["props"]))
                if ai[n]["props"].get(k) != bi[n]["props"].get(k)
            )
            changed.append({"name": n, "fields": fields[:12]})
    return {"added": added, "removed": removed, "changed": changed}


def _self():
    import sys
    return sys.modules[__name__]
`;

// Bootstrap writes the module into the FreeCAD process's temp dir and imports
// it. The source travels as a Python string literal produced by JSON.stringify:
// every backslash, quote and newline is escaped, and JSON's escape set is a
// strict subset of Python's, so the payload is one line that Python parses back
// to the exact source. It must stay one line — wrapPython indents the body, and
// an embedded raw newline would land inside the indent.
//
// It is still shipped from here rather than read off disk beside koi_bridge.py,
// and the reason has not changed: an MCP server cannot read its own skill
// directory, and two copies of a 5,000-line module are two copies that drift.
// The bridge is deliberately dumb about CAD — it runs what it is given.
function bootstrapSnippet() {
  return (
    "import os, sys, importlib, tempfile, shutil\n" +
    "src = " + JSON.stringify(KOI_CAD_PY) + "\n" +
    "d = os.path.join(tempfile.gettempdir(), 'koi')\n" +
    "os.makedirs(d, exist_ok=True)\n" +
    "p = os.path.join(d, 'koi_cad.py')\n" +
    "open(p, 'w').write(src)\n" +
    // FIRST, not merely present. A previous session inserted its own temp
    // dir at position 0, so "already on sys.path" is not the same as "wins
    // the import" -- evicting the stale module and then importing again just
    // re-imports it from the same older directory. Measured: without this,
    // eviction reports success and the version stays 0.1.0.
    "if d in sys.path:\n" +
    "    sys.path.remove(d)\n" +
    "sys.path.insert(0, d)\n" +
    // A FreeCAD the human has had open for two days already has a koi_cad in
    // sys.modules, and importlib.reload() re-reads THAT module's __file__ --
    // which is the file some previous session wrote, under whatever TMPDIR
    // that session had, from whatever version of this skill was current then.
    // Reload is a no-op against the source we just wrote if the paths differ,
    // and the failure is silent: the module imports, reports a version, and
    // is missing every op added since. Dropping it from sys.modules is the
    // only way to be sure the source that runs is the source that shipped.
    "prev = sys.modules.get('koi_cad')\n" +
    "prev_file = getattr(prev, '__file__', None) if prev is not None else None\n" +
    "stale = prev is not None and os.path.abspath(prev_file or '') != os.path.abspath(p)\n" +
    "if stale:\n" +
    "    del sys.modules['koi_cad']\n" +
    // The .pyc is keyed on mtime and size, and two versions of this module
    // written inside the same second at the same length would be served from
    // cache. Cheap to rule out; expensive to diagnose.
    "shutil.rmtree(os.path.join(d, '__pycache__'), ignore_errors=True)\n" +
    "importlib.invalidate_caches()\n" +
    "import koi_cad\n" +
    "if not stale:\n" +
    "    importlib.reload(koi_cad)\n" +
    "return {'ok': True, 'version': koi_cad.VERSION, 'ops': koi_cad.OP_NAMES,\n" +
    "        'file': getattr(koi_cad, '__file__', None), 'wrote': p,\n" +
    "        'replacedStale': bool(stale), 'previousFile': prev_file}"
  );
}

// The version this server ships, read out of the source it ships rather than
// typed again here: two places to say 0.4.0 is one place to forget.
const KOI_CAD_VERSION =
  (KOI_CAD_PY.match(/^VERSION = "([^"]+)"/m) || [])[1] || null;

/**
 * Load the in-page module and prove the two whitelists agree.
 *
 * OP_SPECS below is authoritative for names and arguments because that is what
 * the LLM is shown and what gets validated before anything reaches the page.
 * `koi_cad.OPS` is authoritative for behaviour. Two tables, one contract — so
 * the bootstrap compares them and refuses on drift, rather than letting a
 * documented fn dispatch to nothing or an implemented fn stay unreachable.
 */
async function ensureKoiCad(force) {
  if (state.koiCadVersion && !force) return state.koiCadVersion;
  const res = await execPython(bootstrapSnippet(), 60000);
  const d = res.data || {};
  if (!d.ok) throw new Error("koi_cad bootstrap failed: " + (d.error || "unknown"));

  // Proved before the whitelists are compared, because a version mismatch
  // explains a drift report and drift does not explain itself. This is the
  // failure mode of attaching to a FreeCAD that has been open a long time:
  // some other koi_cad earlier on sys.path, or one this process imported
  // before the temp dir existed, wins the import and every op added since
  // reads as "declared but not implemented".
  if (KOI_CAD_VERSION && d.version && d.version !== KOI_CAD_VERSION) {
    throw new Error(
      "koi_cad version mismatch: this server ships " + KOI_CAD_VERSION +
        " and the FreeCAD process is running " + d.version + ", loaded from " +
        (d.file || "an unknown path") + " while the source was written to " +
        (d.wrote || "?") + ". Another koi_cad is winning the import — check " +
        "sys.path inside FreeCAD for a stale copy, or restart FreeCAD to " +
        "clear it."
    );
  }

  const inPage = (d.ops || []).slice().sort();
  const declared = Object.keys(OP_SPECS).sort();
  const aliases = Object.keys(OP_ALIASES);
  const missing = declared.filter((n) => inPage.indexOf(n) === -1);
  // An alias is implemented on purpose and undeclared on purpose, so it is
  // not drift. Everything else undeclared still is.
  const extra = inPage.filter(
    (n) => declared.indexOf(n) === -1 && aliases.indexOf(n) === -1);
  // And an alias that points at nothing, or is no longer implemented, is the
  // same class of bug one level down: a name the JS accepts and the page has
  // never heard of.
  const badAlias = aliases.filter(
    (n) => inPage.indexOf(n) === -1 || !OP_SPECS[OP_ALIASES[n]]);
  if (missing.length || extra.length || badAlias.length) {
    throw new Error(
      "koi_cad op whitelist drift: " +
        (missing.length ? "declared but not implemented: " + missing.join(", ") + ". " : "") +
        (extra.length ? "implemented but not declared: " + extra.join(", ") + ". " : "") +
        (badAlias.length ? "alias resolves to nothing: " + badAlias.join(", ") + ". " : "") +
        "Fix OP_SPECS, OP_ALIASES or koi_cad.OPS — a dispatcher whose halves " +
        "disagree either advertises a call that does nothing or hides one " +
        "that works. koi_cad " + (d.version || "?") + " from " +
        (d.file || "?") + (d.replacedStale ? " (replaced a stale module)" : "")
    );
  }
  state.koiCadVersion = d.version;
  state.koiCadOps = inPage;
  state.koiCadFile = d.file || null;
  state.koiCadReplacedStale = !!d.replacedStale;
  return d.version;
}

// --- The whitelist (§6.2, §6.3) -------------------------------
//
// Short on purpose. §6.2: bespoke surface is earned, not assumed, and the next
// measurement is channel economics — build the same bracket through
// freecad_call and through freecad_script, then promote only what pays for a
// schema. These are the calls that measurement needs.
//
//   mode    write ops run inside the envelope; read ops do not, because a read
//           that opened a transaction would book an undo entry for looking.
//   creates whether the op brings a new object into being, which is what makes
//           `id` mandatory: an object nobody can name in turn 7 is an object
//           the next edit has to rebuild rather than edit (§8.5).
const OP_SPECS = {
  open_document: {
    mode: "document", creates: false,
    summary:
      "Open an existing .FCStd from disk and adopt it. The path has to sit " +
      "under a directory this session may read: the export directory, " +
      "anything KOI_OPEN_DIRS names, or the folder of a document the human " +
      "already has open. koi ids come back with the file — they live in " +
      "doc.Meta, which is saved inside the FCStd — so a document this skill " +
      "built last week is still editable by id rather than by rebuild. A " +
      "document built elsewhere has none, and the reply says so.",
    props: { path: "string", fit: "boolean" },
    required: ["path"],
  },
  save: {
    mode: "document", creates: false,
    summary:
      "Save the human's document to its own file. With no path it saves in " +
      "place and needs the document to have been saved once already; with a " +
      "path it is Save As, which REBINDS the document so every later save " +
      "goes to the new file — the reply says which happened in those words. " +
      "This writes to the user's filesystem: do it because they asked, not " +
      "on a hunch. It is not freecad_export, which writes a copy elsewhere " +
      "and leaves their file alone.",
    props: { path: "string", document: "string", overwrite: "boolean" },
  },
  import_geometry: {
    mode: "write", creates: true,
    summary:
      "Import a STEP, IGES or BREP file as geometry: a supplier's connector, " +
      "a customer's mating part, a casting. What arrives is a SHAPE — no " +
      "features, no sketches, no parameters, nothing to bind an expression " +
      "to — and it is reported that way rather than dressed up as a model " +
      "you can edit. Use it to measure against, interfere against and cut " +
      "with; for a part you are DESIGNING against, 'insert' and its " +
      "interface is still the right thing. Several objects come in under one " +
      "App::Part so 'place' can move the lot. Same path rules as " +
      "open_document.",
    props: { path: "string", at: "array", label: "string" },
    required: ["path"],
  },
  sketch_get: {
    mode: "read", creates: false,
    summary:
      "Read a sketch back: every geoId with the numbers that identify it, " +
      "every constraint with its index, name, value and expression, the " +
      "degrees of freedom, the conflicts and what the profile encloses. This " +
      "is how you learn the geoId sketch_edit needs — indices shift when " +
      "geometry is deleted, so read them in the same turn you use them, and " +
      "never author one from memory.",
    props: { target: "string" },
    required: ["target"],
  },
  sketch_edit: {
    mode: "write", creates: false,
    summary:
      "Change a sketch in place instead of rebuilding it — add geometry, " +
      "remove geoIds, add or drop constraints, bind a dimension to the " +
      "parameter sheet, flip an element to construction. This is to sketches " +
      "what feature_edit is to features, and for the same reason: deleting a " +
      "sketch to add one hole deletes the pad, and everything attached to " +
      "it. Removals happen before adds, so the geoIds you pass are the ones " +
      "you read. Deleting geometry silently deletes the constraints that " +
      "used it — the reply counts them as constraintsLost, and a sketch that " +
      "lost constraints solves fine at the wrong shape.",
    props: { target: "string", add: "array", remove: "array",
             constraints: "array", removeConstraints: "array",
             expressions: "object", construction: "object",
             visible: "boolean" },
    required: ["target"],
  },
  measure_between: {
    mode: "read", creates: false,
    summary:
      "Measure BETWEEN two entities, or report one exactly: minimum " +
      "distance, centre-to-centre, axis-to-axis, angle, parallel, " +
      "perpendicular, coaxial, and the material left between two bores. " +
      "freecad_measure answers questions about whole objects and cannot " +
      "reach inside one — how far this hole is from that edge, whether " +
      "these two faces are parallel, what that chamfer's angle is. Takes " +
      "refs the way fillet does: a ref id from a user pick, an " +
      "'object:Face3' pair from query, or a whole object. Pass a alone to " +
      "ask what one thing IS — a diameter read off a render is a diameter " +
      "nobody should machine to.",
    props: { a: "string", b: "string" },
    required: ["a"],
  },
  cam: {
    mode: "write", creates: false,
    summary:
      "The CAM workbench: build a machining Job on a solid, add operations to " +
      "it, read the toolpaths they generated, and post G-code out. mode is " +
      "'job' (create the Job and its stock on target), 'op' (add one " +
      "operation of kind profile|pocket|drilling|adaptive|face|helix to job, " +
      "optionally with base refs and props), 'verify' (recompute and read " +
      "every operation's path), 'post' (write G-code into the export " +
      "directory) or 'clear' (delete the job). 'job' and 'op' create an " +
      "object and need an id. An operation that generates ZERO path commands " +
      "recomputes clean, reports no error and shows nothing on screen: it is " +
      "the workbench saying it could NOT machine that feature with that tool, " +
      "and it is the whole reason to run this rather than to assert " +
      "manufacturability. Slow, and the geometry kernel cannot be preempted, " +
      "so this is not a batch step.",
    props: { mode: "string", target: "string", job: "string", op: "string",
             base: "array", props: "object", name: "string",
             toolDiameter: "number", savePath: "string" },
  },
  fem: {
    mode: "write", creates: false,
    summary:
      "Linear static structural analysis (CalculiX): does the part survive " +
      "the load? mode is 'materials' (the elastic table, writes nothing), " +
      "'study' (Analysis + solver + material on target), 'constrain' (one " +
      "restraint or load of kind fixed|force|pressure|displacement on refs), " +
      "'mesh', 'solve', 'converge' (re-mesh finer and re-solve, which is the " +
      "only thing here that says whether the number is mesh-independent), " +
      "'result' (read the last solve again) or 'clear'. 'study' and " +
      "'constrain' create an object and need an id. refs follow the fillet " +
      "rule: a user pick or a query result, never an index authored here — a " +
      "load on a renumbered face solves perfectly cleanly. A model with no " +
      "restraint, no load, or no volume elements is REFUSED before the " +
      "solver runs, because each of those returns a plausible number that " +
      "means nothing. Slow, single threaded, and the human's window does not " +
      "respond while it solves: never a batch step.",
    props: { mode: "string", target: "string", analysis: "string",
             kind: "string", refs: "array", magnitude: "number",
             direction: "string", reversed: "boolean", values: "object",
             props: "object", material: "string", E: "number", nu: "number",
             density: "number", elementSize: "number", factor: "number",
             name: "string" },
  },
  material: {
    mode: "write", creates: false,
    summary:
      "Give a body a density so it has a mass, and so the BOM adds up. With " +
      "no target it returns the table (32 materials, g/cm3) and writes " +
      "nothing. With target or targets and name — 'aluminium-6061', " +
      "'stainless-304', 'pom-acetal' — or an explicit density for anything " +
      "not in the table. Mass is volume times density and nothing else: no " +
      "fasteners, no estimate for the fillets. A body with no material " +
      "weighs nothing in the BOM and the BOM says which ones those are.",
    props: { target: "string", targets: "array", name: "string",
             density: "number", all: "boolean", clear: "boolean" },
  },
  recompute: {
    mode: "write", creates: false,
    summary:
      "Force a rebuild, and optionally refine. force:true rebuilds a " +
      "document sitting touched-but-not-rebuilt or stuck in an error state a " +
      "plain edit will not clear — before this the only move was " +
      "delete-and-rebuild, which throws away the DAG to fix a stale flag. " +
      "refine:true sets Refine on every feature that has it, which removes " +
      "the coplanar splitter edges a boolean leaves across a face (the " +
      "sliver faces deepLint reports and nothing could fix). Refining cannot " +
      "change the volume, so the volume is measured either side and a " +
      "difference is reported as a problem rather than a result.",
    props: { targets: "array", force: "boolean", refine: "boolean",
             touch: "boolean" },
  },
  view_section: {
    mode: "read", creates: false,
    summary:
      "Clip the 3D view on a plane so the human can see inside — a pocket " +
      "in a housing, a bore through a boss. plane 'XY'|'XZ'|'YZ' or " +
      "normal:[x,y,z], with offset and flip. This clips the VIEW: no " +
      "geometry changes, nothing recomputes, and the cut face is OPEN " +
      "rather than capped, so it answers 'does that break through' and not " +
      "'how thick is that wall' — the second is measure_between. Turn it " +
      "off with off:true, and view_restore drops it too. Leaving a session's " +
      "clip on the human's view is the same mistake as leaving their model " +
      "isolated.",
    props: { plane: "string", normal: "array", offset: "number",
             flip: "boolean", off: "boolean", enabled: "boolean" },
  },
  capabilities: {
    mode: "read", creates: false,
    summary:
      "What this FreeCAD can actually do: which modules import in THIS " +
      "interpreter, whether there is a GUI, and what the Assembly API " +
      "exposes on this build. K0 says every claim this skill makes is a " +
      "claim about one build; this is how a session checks one instead of " +
      "assuming it. Importable is not the same as wired: assembly joints " +
      "and TechDraw drawings are NOT in this skill, and Assembly importing " +
      "cleanly does not make them available. Needs no document.",
    props: {},
  },
  new_document: {
    mode: "document", creates: false,
    summary:
      "Create a document and make it active. Every other write needs one, so " +
      "this is the first call of a session that starts from an empty app. It " +
      "reuses a document of the same name rather than making a second, and " +
      "it takes the sync baseline, so it does not have to be followed by a " +
      "freecad_sync before the first edit.",
    props: { name: "string", label: "string", reuse: "boolean" },
  },
  datum_plane: {
    mode: "write", creates: true,
    summary:
      "Datum plane in a body: on 'XY'|'XZ'|'YZ' with an offset, or base=<ref " +
      "id> for a face the user picked. Prefer this to a picked face for " +
      "anything a sketch will attach to — a datum survives a recompute that " +
      "renumbers Face6. Created INVISIBLE, because a stack of translucent " +
      "planes is what the user sees instead of their model; pass " +
      "visible:true for one they should actually look at.",
    props: { body: "string", base: "string", on: "string", plane: "string", mode: "string",
             offset: "number|string", visible: "boolean", label: "string" },
  },
  fillet: {
    mode: "write", creates: true,
    summary:
      "Fillet edges. Give it EITHER refs (ref ids from a user pick via fn " +
      "'ref', or '<object>:Edge3') or query: the same filter fn 'query' " +
      "takes — {direction:'+Z', minSize:20, expect:'many'}. Prefer query on " +
      "a model that is still moving: the filter is stored with the feature, " +
      "so an upstream dimension change that renumbers the edges is " +
      "re-resolved instead of erroring and aborting the whole edit. Never " +
      "author an edge index from memory either way.",
    props: { body: "string", base: "string", refs: "array", query: "object",
             radius: "number|string", label: "string" },
    required: ["radius"],
  },
  chamfer: {
    mode: "write", creates: true,
    summary:
      "Chamfer edges. Same rule as fillet: refs from a user pick, or query " +
      "with the fn 'query' filter — and query is what survives a parameter " +
      "change, because the filter is kept and re-run when the edges " +
      "renumber. Never an index authored from memory.",
    props: { body: "string", base: "string", refs: "array", query: "object",
             size: "number|string", label: "string" },
    required: ["size"],
  },
  link_array: {
    mode: "write", creates: true,
    summary:
      "App::Link instances of one WHOLE object, stepped by [x,y,z]. This is " +
      "how repeats stay cheap: 120 bolts are one master and 120 links. " +
      "Bounded at 256 instances. Not for a feature inside a body — a row of " +
      "slots in one plate is fn 'pattern', and this refuses a PartDesign " +
      "feature rather than handing back copies of the slot standing next to " +
      "the plate.",
    props: { target: "string", count: "number", step: "array", label: "string" },
    required: ["target", "count"],
  },
  bind: {
    mode: "write", creates: true,
    summary:
      "Bring geometry from ANOTHER body or part into this one, as a " +
      "PartDesign::SubShapeBinder: bind({of:'pad.housing:Face2'}). This is " +
      "the case external geometry cannot reach on its own — a cover plate is " +
      "its own body and the housing it matches is another — and addExternal " +
      "refuses across that line. The binder is a local object afterwards: " +
      "sketch({on: <id>}) attaches to it and sketch({external: ['<id>:" +
      "Edge1']}) projects from it, and it FOLLOWS the source when the source " +
      "moves, which is the whole point. relative:false pins it to the " +
      "source's own coordinates instead of tracking its container. Created " +
      "invisible; visible:true if the user should see it.",
    props: { body: "string", of: "string", target: "string", source: "string",
             relative: "boolean", visible: "boolean", label: "string" },
    required: ["of"],
  },
  attach: {
    mode: "write", creates: false,
    summary:
      "Attach an existing object (usually a sketch) to a datum or a picked " +
      "face, with an optional offset along the attachment normal. Reads the " +
      "attachment back and fails if it did not take.",
    props: { target: "string", base: "string", mode: "string", offset: "number" },
    required: ["target", "base"],
  },
  body: {
    mode: "write",
    creates: true,
    summary: "Create a PartDesign Body to hold features.",
    props: { label: "string", name: "string" },
  },
  // Note: the reply carries `profile` — wires, how many are closed, and the
  // enclosed area. A sketch is allowed to enclose nothing (scaffolding an
  // arc and a line for a later reference); it is EXTRUDING one that does
  // that pad and pocket refuse.
  sketch: {
    mode: "write",
    creates: true,
    summary:
      "Create a sketch and attach it, from declarative primitives. Any " +
      "dimension can be a NUMBER or an EXPRESSION STRING bound to the " +
      "parameter sheet — {type:'circle', d:'koi_params.bore', " +
      "x:'koi_params.pitch / 2'} — which is how a profile follows a " +
      "parameter instead of freezing a literal; the reply reports each " +
      "binding and whether it took. `on` is " +
      "'XY'|'XZ'|'YZ' or the id of a datum plane or a captured user pick — " +
      "attaching here saves a second call, and the attachment is read back " +
      "so it cannot silently no-op. Primitives: rect, circle and slot (all " +
      "come out fully constrained and anchored), line, arc (radius and centre " +
      "constrained, ends left free to join a chain), and polyline for a " +
      "GENERATED profile — an involute flank, a cam, an offset outline — " +
      "which is joined but not dimensioned; pass fix:true on it to block the " +
      "computed points rather than leave the sketch lint-warning every turn. " +
      "bspline says the same curve in far fewer points (poles:[[x,y],...], " +
      "closed, fix) — reach for it when a polyline would need hundreds of " +
      "segments, which is a sketch that recomputes slowly forever after.\n\n" +
      "rect takes anchor:'center', so x, y is the MIDDLE rather than the " +
      "bottom-left corner — a part symmetric about a bore is the normal " +
      "case, and negating half a width by hand is where an off-by-half-a-" +
      "dimension goes in. slot is a rounded slot ({x, y, length, width, " +
      "angle}), length measured tip to tip and x, y the centre: the " +
      "primitive a lightening flute needed, dimensioned and bindable rather " +
      "than computed polyline points that can never follow a parameter.\n\n" +
      "external PROJECTS model geometry into the sketch so a profile can " +
      "follow the part it mates with instead of repeating its numbers: " +
      "external:['pad.housing:Edge4'] from a user pick, or query:{...} — the " +
      "same filter fn 'query' takes, kept with the sketch and re-run when an " +
      "upstream change renumbers the edges. Prefer query, and not for the " +
      "reason fillet does: when a projection's reference goes, FreeCAD " +
      "DELETES every constraint that used it, so the sketch still solves and " +
      "is quietly the wrong shape. The reply reports a geoId per projection " +
      "(external geometry starts at -3) — that is the address constraints " +
      "use. Projecting and then writing the dimension as a literal anyway " +
      "buys nothing. addExternal refuses across bodies: use fn 'bind' first.",
    required: ["geometry"],
    props: {
      on: "string",
      mode: "string",
      offset: "number",
      body: "string",
      geometry: "array",
      constraints: "array",
      external: "array",
      query: "object",
      visible: "boolean",
    },
  },
  pad: {
    mode: "write",
    creates: true,
    summary:
      "Pad a sketch into a solid. `length` is a number OR an expression " +
      "string bound to the parameter sheet — length:'koi_params.StackHeight' " +
      "— which is one call rather than a literal pad followed by a " +
      "feature_edit to make it parametric. The reply reports the binding and " +
      "whether the document kept it. The profile is checked BEFORE the pad " +
      "is built: a sketch that encloses no area is refused rather than " +
      "extruded into nothing, and so are two outlines that overlap without " +
      "nesting — PartDesign does not union those, it builds one of them and " +
      "reports success. One closed outline per sketch, or one pad each.",
    required: ["sketch", "length"],
    props: {
      sketch: "string",
      length: "number|string",
      reversed: "boolean",
      midplane: "boolean",
      symmetric: "boolean",
      body: "string",
    },
  },
  pocket: {
    mode: "write",
    creates: true,
    summary:
      "Cut a sketch into the body. Pass through:true or a length. The cut " +
      "direction is measured rather than guessed: if the pocket as built " +
      "removes nothing it is flipped once and the result says so. Pass " +
      "reversed explicitly only to overrule that. A through cut whose " +
      "profile plane runs THROUGH the material is made symmetric on its own " +
      "— a bore sketched on a centre plane means both halves — and says so; " +
      "midplane:false cuts one way, midplane:true forces it either way. " +
      "Like pad, it refuses a profile that encloses no area: a closed, fully " +
      "constrained polyline whose wire has zero face is the shape of a cut " +
      "that removes nothing and reports ok.",
    required: ["sketch"],
    props: {
      sketch: "string",
      length: "number|string",
      through: "boolean",
      reversed: "boolean",
      midplane: "boolean",
      symmetric: "boolean",
      body: "string",
    },
  },
  feature_edit: {
    mode: "write",
    creates: false,
    summary:
      "Change properties or expression bindings on an existing object. This " +
      "is the default response to a change request — editing keeps the DAG, " +
      "the downstream features and the user's references; rebuilding does not.",
    required: ["target"],
    props: { target: "string", props: "object", expressions: "object" },
  },
  ref: {
    mode: "write",
    creates: true,
    summary:
      "Capture a durable reference to a face or edge the USER picked, under " +
      "an id. Pass from:'selection' to take what they have clicked, or " +
      "ref:'Pad:Face3' when they named it. Never invent one: a reference this " +
      "side authored is banned (8.1), and the id is what survives the next " +
      "recompute renumbering everything.",
    required: [],
    props: { ref: "string", from: "string" },
  },
  query: {
    mode: "read", creates: false,
    summary:
      "Find faces or edges of one object BY GEOMETRY rather than by index — " +
      "the +Z face at z=25, the circular edges of radius 3, the verticals " +
      "longer than 10. Filters: kind ('face'|'edge'), surface ('Plane', " +
      "'Cylinder', 'Line', 'Circle'), normal/direction ('+Z' or [x,y,z]), " +
      "at ({x,y,z}, any subset), tol, minSize, maxSize, radius, sort, " +
      "limit. THIS is how fillet, chamfer and shell get refs without a user " +
      "click: query, check `ambiguous`, then capture the one you meant with " +
      "fn 'ref'. It reports how many matched instead of picking the first — " +
      "if that is not 1 and you wanted one element, narrow it or ask.\n\n" +
      "For a selection that is MEANT to be plural — the four corner edges " +
      "of a plate, every hole rim — pass expect:'many' (or a count) so a " +
      "correct multi-element match stops reading as ambiguous, and hand the " +
      "returned `refs` array straight to fillet, chamfer or shell.",
    props: { of: "string", kind: "string", surface: "string",
             normal: "string", direction: "string", at: "object",
             tol: "number", minSize: "number", maxSize: "number", size: "number|array|object|string",
             radius: "number", sort: "string", limit: "number",
             expect: "string|number" },
    required: ["of"],
  },
  bolt_sketch: {
    mode: "write", creates: true,
    summary:
      "A sketch of clearance circles on an inserted component's bolt " +
      "pattern, positions bound BY EXPRESSION to its published pitch — so a " +
      "NEMA 17 to NEMA 23 swap moves the plate's holes, not just their " +
      "diameter. Pass component (the inserted part's id), on (plane, datum " +
      "or ref), at:[x,y] for the pattern centre, and d or clearance:'M5' if " +
      "not the thread's own clearance. Cut it with fn 'hole'. " +
      "bindingVerified:false means the positions are literals and will NOT " +
      "follow a swap — say so rather than reporting a parametric pattern.",
    props: { component: "string", on: "string", body: "string",
             at: "array", d: "number", clearance: "string", fit: "string",
             mode: "string", offset: "number", label: "string" },
    required: ["component"],
  },
  insert: {
    mode: "write",
    creates: true,
    summary:
      "Insert a purchased part: a fastener from the table (fastener:'M5', " +
      "length:16), a catalog component (catalog:'NEMA17_envelope'), or an " +
      "inline spec. It publishes the part's interface into the parameter " +
      "sheet so holes can bind to it — that binding is what makes a swap " +
      "propagate. Envelopes and specs only; no modelled threads.",
    required: [],
    props: { fastener: "string", length: "number", catalog: "string",
             spec: "object", at: "array", label: "string" },
  },
  swap: {
    mode: "write",
    creates: false,
    summary:
      "Swap an inserted component for another — M5 to M6, NEMA 17 to NEMA " +
      "23. It rewrites the published interface; every hole bound to it " +
      "follows on the next recompute. Change the part, not the plate.",
    required: ["target"],
    props: { target: "string", fastener: "string", length: "number",
             catalog: "string" },
  },
  hole: {
    mode: "write",
    creates: true,
    summary:
      "A PartDesign hole from a sketch of circles. Pass spec:{from: " +
      "'bolt.mount.clearance'} to bind its diameter to an inserted " +
      "fastener by expression — then a swap moves the hole too. With " +
      "neither spec nor diameter it takes the size from the profile " +
      "sketch's own circles (reported as diameterFrom), so a bolt_sketch " +
      "composes straight into this. counterbore:true (with spec) or " +
      "counterbore:'M5' takes cbore_d and head_h straight from the fastener " +
      "table, so a head sits flush without a second sketch. threaded:true " +
      "writes a thread SPECIFICATION and never cuts a helix — threadSize is " +
      "matched against this build's own enumeration ('M5' finds 'M5x0.8') " +
      "and REFUSES rather than leaving the hole tapped at some other size. " +
      "Threading moves Diameter to the tap drill: quote the readback. " +
      "`depth` MEANS a depth: it sets DepthType=Dimension and is verified " +
      "against the document, so a blind hole is a blind hole. Holes are " +
      "ThroughAll only when no depth is given or through:true is asked for, " +
      "and asking for through:true AND a depth is refused rather than " +
      "resolved in favour of one of them.",
    required: ["sketch"],
    props: { sketch: "string", spec: "object", diameter: "number|string",
             counterbore: "object|boolean|string",
             cbore_d: "number|string", cbore_depth: "number|string",
             counterbore_diameter: "number|string", counterbore_depth: "number|string",
             through: "boolean", depth: "number|string", reversed: "boolean",
             // depth implies DepthType=Dimension; through:true + depth refuses

             threaded: "boolean", threadSize: "string", body: "string" },
  },
  param: {
    mode: "write",
    creates: false,
    summary:
      "Read or set a named value in the parameter sheet. Bind features to " +
      "these rather than typing a literal twice. value takes a bare number " +
      "or a quantity with units — 45, '45 mm', '1.5 in', '12 deg' — and " +
      "converts to the document's own. The reply echoes what the sheet reads " +
      "back after its recompute, not what was sent.",
    required: ["alias"],
    props: { alias: "string", value: "number|string", label: "string" },
  },
  lookup: {
    mode: "read",
    creates: false,
    summary:
      "Look up the reference numbers: the fastener table, the catalog, the " +
      "stock sizes, and what this document has published " +
      "(what: 'all'|'fasteners'|'catalog'|'stock'|'params'). Quote these " +
      "rather than recalling them — a clearance hole that is 0.2 mm out " +
      "does not assemble.",
    props: { what: "string" },
  },
  delete: {
    mode: "write",
    creates: false,
    summary:
      "Remove an object — and it REFUSES the two deletes that quietly break " +
      "a model: a feature in the middle of a body (deleting it rewires " +
      "BaseFeature for everything after it, which has collapsed a body to a " +
      "single cut) and an object something else is built from. Both " +
      "refusals name fn 'suppress' instead, which is almost always what was " +
      "meant. force:true goes through anyway and the reply says it was " +
      "forced; the tip and volume come back either way.",
    required: ["target"],
    props: { target: "string", force: "boolean" },
  },
  suppress: {
    mode: "write",
    creates: false,
    summary:
      "Switch a feature off without deleting it: the material goes away and " +
      "the DAG, the ids, the downstream features and the user's picked refs " +
      "all stay. This is the answer to 'that pocket was wrong' — deleting it " +
      "mid-tree is what wrecks the tip. suppressed:false puts it back. The " +
      "reply carries the tip's volume before and after, so a suppression " +
      "that changed nothing says so. A suppressed feature is left out of " +
      "lint, because it is off on purpose.",
    required: ["target"],
    props: { target: "string", suppressed: "boolean" },
  },
  isolate: {
    mode: "write",
    creates: false,
    summary:
      "Hide everything except these objects. The highest-value screenshot " +
      "helper: an internal feature is invisible until its surroundings are " +
      "gone. Keeps the solid and its instances — INCLUDING the FeatureBase a " +
      "split half's solid lives in — and drops origin planes, which are " +
      "infinite and were making every fit that followed useless. Turns the " +
      "targets on if something above them was hiding them, and reports " +
      "{label, volume, bbox, drawn} per target: read `drawn`, not `already`, " +
      "before telling the user what is on screen. Records what it changed — " +
      "restore with view_restore, and do restore it.",
    required: ["targets"],
    props: { targets: "array" },
  },
  view_restore: {
    mode: "write",
    creates: false,
    summary:
      "Put back everything the last isolate hid — EXCEPT origin planes and " +
      "axes, which stay hidden. Those are scaffolding, never presentation: " +
      "restoring 18 translucent infinite planes over the part the session " +
      "just framed is worse than not restoring at all. The reply lists them " +
      "under originsLeftHidden, so nothing is dropped silently. Pass " +
      "includeOrigins:true when the document has to go back exactly as it " +
      "was found.",
    props: { includeOrigins: "boolean" },
  },
  show: {
    mode: "write", creates: false,
    summary:
      "Show or hide named objects: show({targets:['bar.a','bolt.b'], " +
      "visible:false}). The bulk half of presentation — isolate hides " +
      "everything ELSE, which is right for a screenshot of one internal " +
      "feature and wrong for 'show the faceplate, hide the jig'. It reports " +
      "what actually changed, what was already that way, and per target " +
      "{label, volume, bbox, drawn, hiddenBy} — because Visibility is a fact " +
      "about a CONTAINER: a Body reads true over a hidden FeatureBase and " +
      "nothing is drawn. Anything in notDrawn is not on screen, whatever " +
      "`already` says. Labels are feature_edit({props:{Label:'...'}}); " +
      "several of either in one batch is one round trip.",
    props: { targets: "array", visible: "boolean" },
    required: ["targets"],
  },
  view_set: {
    mode: "read",
    creates: false,
    summary:
      "Point the camera: iso, front, rear, top, bottom, left, right. Moves " +
      "the user's view, so say why before using it. preset is the argument; " +
      "view is accepted as an alias for it.",
    props: { preset: "string", view: "string", fit: "boolean" },
  },
  ids: {
    mode: "read",
    creates: false,
    summary:
      "Which koi ids exist, what they point at, and which ones the user has " +
      "deleted (revertedAiObjects — a rejection signal, never re-create them).",
    props: {},
  },
  loft: {
    mode: "write", creates: true,
    summary:
      "Create an additive loft (transition solid) between two or more section sketches. " +
      "sketches is a list of sketch ids (min 2, max 32). Supports ruled:true for ruled surfaces, " +
      "closed:true for closed looping lofts.",
    props: { body: "string", sketches: "array",
             ruled: "boolean", closed: "boolean", label: "string" },
    required: ["sketches"],
  },
  subtractive_loft: {
    mode: "write", creates: true,
    summary:
      "Cut a subtractive loft between two or more section sketches through the body's material. " +
      "sketches is a list of sketch ids (min 2, max 32). Measured like pocket and groove: " +
      "the reply carries removed and removedAtProfile, and a cut that removed nothing says so " +
      "instead of reporting a clean recompute.",
    props: { body: "string", sketches: "array",
             ruled: "boolean", closed: "boolean", label: "string" },
    required: ["sketches"],
  },
  pipe: {
    mode: "write", creates: true,
    summary:
      "Sweep a profile sketch along a spine/path sketch into a solid (AdditivePipe). " +
      "sketch is the profile, path is the trajectory. mode is 'Fixed'|'Frenet'|'Auxiliary'|'Binormal'|'Curvilinear' " +
      "(default 'Fixed'). transition is 'Transformed'|'RightCorner'|'RoundCorner' — an unrecognised " +
      "value is REFUSED, not quietly defaulted. A path sketch with no edges is refused too: an " +
      "empty spine builds, reports Up-to-date and adds nothing. Alias: sweep.",
    props: { body: "string", sketch: "string", path: "string",
             mode: "string", transition: "string", label: "string" },
    required: ["sketch", "path"],
  },
  subtractive_pipe: {
    mode: "write", creates: true,
    summary:
      "Cut a subtractive sweep of a profile sketch along a spine/path sketch through the solid (SubtractivePipe). " +
      "sketch is the profile, path is the trajectory. Measured like pocket: the reply carries " +
      "removed and removedAtProfile, and a sweep that cut nothing says so. Alias: subtractive_sweep.",
    props: { body: "string", sketch: "string", path: "string",
             mode: "string", transition: "string", label: "string" },
    required: ["sketch", "path"],
  },
  draft: {
    mode: "write", creates: true,
    summary:
      "Draft (taper) faces of a body relative to a neutral plane for mold release and manufacturing. " +
      "angle is the draft angle in degrees (or expression string). neutralPlane is 'XY'|'XZ'|'YZ', a datum id or a face ref. " +
      "refs or query specifies the FACES to draft — a query here defaults to kind:'face', and the " +
      "filter is kept with the feature the same way fillet's is. reversed:true flips the pull " +
      "direction; the reply reports taper ('inward'|'outward'|'none') and volumeDelta so which way " +
      "it went is measured rather than assumed.",
    props: { body: "string", base: "string", angle: "number|string", neutralPlane: "string",
             plane: "string", refs: "array", query: "object", reversed: "boolean", label: "string" },
    required: ["angle"],
  },
  revolve: {
    mode: "write", creates: true,
    summary:
      "Turn a sketch about one of its own axes into a solid — shafts, " +
      "bosses, seats, anything round. axis is 'V' (the sketch's vertical " +
      "axis, the default) or 'H'. The profile must stay on one side of that " +
      "axis. angle defaults to 360.",
    props: { sketch: "string", axis: "string", angle: "number|string",
             midplane: "boolean", reversed: "boolean", body: "string" },
    required: ["sketch"],
  },
  groove: {
    mode: "write", creates: true,
    summary:
      "The subtractive revolve: bores, counterbores turned in, O-ring and " +
      "retaining-ring grooves. Like pocket, the direction is measured rather " +
      "than guessed — a groove that removed nothing is flipped once and the " +
      "result says so.",
    props: { sketch: "string", axis: "string", angle: "number|string",
             reversed: "boolean", body: "string" },
    required: ["sketch"],
  },
  polar_array: {
    mode: "write", creates: true,
    summary:
      "Rotational repeats as App::Link instances of a WHOLE object: three " +
      "planets at 120°, six bolts on a circle, three mounting lugs. angle " +
      "360 (the default) divides the full turn into count steps; a partial " +
      "angle puts an instance at each end. Bounded at 256 instances, same as " +
      "link_array. Six holes in ONE plate are not this — that is fn " +
      "'pattern', which repeats a feature inside the body, and this refuses " +
      "a PartDesign feature rather than silently making copies of the hole.",
    props: { target: "string", count: "number", angle: "number",
             axis: "string", center: "array", label: "string" },
    required: ["target", "count"],
  },
  pattern: {
    mode: "write", creates: true,
    summary:
      "Repeat a FEATURE inside its own body, fused into the solid: six " +
      "holes on a bolt circle, a row of slots, a ring of teeth. kind is " +
      "'polar' (axis X|Y|Z, angle, default 360) or 'linear' (direction, " +
      "length = the total span). features is the id(s) of the pad/pocket/" +
      "hole to repeat, defaulting to the body's tip. Do not confuse this " +
      "with polar_array: that makes App::Link copies of a WHOLE object " +
      "(three planets, six bolts), and links cannot be cut into a plate. " +
      "Six holes in one plate are this. angle and length are always the " +
      "TOTAL sweep or span here — whether this build reads them as the step " +
      "between instances is resolved for you, and modeUsed says which " +
      "answered. Measured — a pattern that changed no volume is reported, " +
      "because it recomputes clean either way.",
    props: { body: "string", kind: "string", features: "array",
             count: "number", angle: "number", axis: "string",
             direction: "string", length: "number", reversed: "boolean",
             label: "string" },
    required: ["count"],
  },
  primitive: {
    mode: "write", creates: true,
    summary:
      "A box, cylinder, sphere or cone as a plain solid: kind plus its " +
      "dimensions (box: length/width/height; cylinder: radius or d, plus " +
      "height; cone: radius1/radius2/height) and at:[x,y,z]. This exists so " +
      "'boolean' has something to cut with — a tool solid is not a designed " +
      "feature. It carries no sketch, no constraints and nothing to bind an " +
      "expression to, so anything the user will want to change later is " +
      "still sketch + pad.",
    props: { kind: "string", length: "number|string", width: "number|string",
             height: "number|string", radius: "number|string",
             d: "number|string", radius1: "number|string",
             radius2: "number|string", at: "array", label: "string" },
    required: ["kind"],
  },
  allow: {
    mode: "write", creates: false,
    summary:
      "Declare that a pair of parts is DESIGNED to overlap, with a bound " +
      "and a reason: meshing gear flanks, a press fit, a tapped hole. " +
      "pairs:[[a,b],...], upTo (mm³, omit for any) and why (required). " +
      "Stored on the document, so it survives the turn. Without this the " +
      "first gearbox makes interference permanently red and the check stops " +
      "being read. It bounds an overlap, it does not hide one — anything " +
      "past upTo is still a hit, and everything allowed is still reported " +
      "under expectedOverlaps. clear:true removes them.",
    props: { pairs: "array", a: "string", b: "string", upTo: "number",
             why: "string", clear: "boolean" },
  },
  mirror: {
    mode: "write", creates: true,
    summary:
      "Mirror a solid across XY, XZ or YZ, optionally through a base point. " +
      "For the half of a symmetric part you do not want to model twice.",
    props: { target: "string", plane: "string", base: "array", label: "string" },
    required: ["target"],
  },
  boolean: {
    mode: "write", creates: true,
    summary:
      "cut, fuse or common between two solids — the document-level boolean " +
      "PartDesign cannot express, e.g. a housing minus its internals. " +
      "Measured: a cut that removed nothing, a fuse that added nothing and " +
      "an empty intersection are each reported rather than passed off as " +
      "success.",
    props: { op: "string", base: "string", tool: "string", label: "string" },
    required: ["base", "tool"],
  },
  shell: {
    mode: "write", creates: true,
    summary:
      "Hollow a solid to a wall thickness, opening the faces in refs. refs " +
      "is REQUIRED, same rule as fillet — a user pick or fn 'query' (the " +
      "+Z face at the top, say), never an index authored from memory.",
    props: { body: "string", base: "string", refs: "array",
             thickness: "number|string", reversed: "boolean", label: "string" },
    required: ["refs", "thickness"],
  },
  place: {
    mode: "write", creates: false,
    summary:
      "Move or turn an existing object: at:[x,y,z], rotate:{axis:'Z', " +
      "angle:120}, or both, with relative:true to add to where it already " +
      "is. Reads the placement back and fails if it did not take. Refuses a " +
      "PartDesign feature — those are positioned by their sketch's " +
      "attachment, not by a Placement write.",
    props: { target: "string", at: "array", rotate: "object",
             relative: "boolean" },
    required: ["target"],
  },
  batch: {
    mode: "write", creates: false,
    summary:
      "Several of the calls below in ONE transaction and one round trip: " +
      "ops:[{fn, args, id}, ...]. THIS is how a multi-feature sequence stops " +
      "costing a dozen turns — datum_plane, sketch, pad, sketch, pocket, " +
      "insert, mate is one call and one undo entry. Atomic: a step that " +
      "fails rolls the whole batch back and names the step, so there is " +
      "never half a bolt pattern to clean up. Steps that create still need " +
      "their own id. Capped at 24; new_document and batch cannot be steps. " +
      "Reach for it whenever the next three calls are already decided — and " +
      "not when step 2 depends on measuring step 1, because nothing is " +
      "measured until the batch returns.",
    props: { ops: "array" },
    required: ["ops"],
  },
  fastener_pattern: {
    mode: "write", creates: true,
    summary:
      "Insert ONE fastener and seat an instance of it in every hole of a " +
      "pattern: fastener_pattern({hole:'hole.face_bolts', fastener:'M5', " +
      "length:16}). It reads the axis and every seat off the hole's own " +
      "profile sketch, so there is no near:[x,y,z] per bolt and no " +
      "hand-computed position at all — the six inserts and six mates that " +
      "four faceplate bolts and two pinch bolts used to cost are one call. " +
      "One HIDDEN master and N App::Links, so seat 0 holds one bolt and not " +
      "two and the BOM reads it as one line of N. isolate the group " +
      "(<id>.set) to frame the set. offset defaults to the depth of the " +
      "hole's counterbore, so heads seat instead of standing on the face; " +
      "offset, spin and flip otherwise mean what they mean on mate, and like " +
      "mate this is a PLACEMENT: nothing is constrained afterwards. Bounded " +
      "at 32 instances. The fit check runs against the TIGHTEST hole in the " +
      "pattern rather than one of them.",
    props: { hole: "string", fastener: "string", length: "number",
             offset: "number", spin: "number", flip: "boolean",
             label: "string" },
    required: ["hole", "fastener"],
  },
  mate: {
    mode: "write", creates: false,
    summary:
      "Seat an inserted part in a hole: mate({target:'bolt.a', hole:'hole." +
      "mount', near:[x,y,z]}). It reads the axis and the seating face off " +
      "the hole's own profile sketch and writes the placement — the " +
      "arithmetic that was six hand-computed positions and two hand-written " +
      "quaternions for six bolts. ref:'<obj>:Face7' seats on a cylindrical " +
      "face instead. offset lifts along the axis (a washer), spin turns " +
      "about it, flip seats from the other side. This is NOT a mate: " +
      "nothing is constrained afterwards, and moving the plate leaves the " +
      "bolt where it was. A hole with several instances refuses until near " +
      "says which one.",
    props: { target: "string", hole: "string", ref: "string", near: "array",
             offset: "number", spin: "number", flip: "boolean" },
    required: ["target"],
  },
  split_body: {
    mode: "write", creates: true,
    summary:
      "Cut one solid into two parts on a plane: the clamp and its faceplate, " +
      "a split housing, anything PartDesign refuses with 'Result has " +
      "multiple solids' — which is the workbench saying this is two parts, " +
      "not a modelling error. plane is XY|XZ|YZ or a datum id, offset moves " +
      "it, gap is the width of the cut (the slit) — both take an expression " +
      "as well as a number — ids:[a,b] names the halves and labels:[a,b] " +
      "labels them. ids[0] is the half on the POSITIVE side of the plane " +
      "normal; the reply also returns sides:{positive,negative} with an id, " +
      "volume and bbox each, so read that rather than guessing the order. " +
      "Each half comes back as a PartDesign Body when the build allows it " +
      "(asBodies says), so features can still be added. Re-running split_body " +
      "updates existing halves in place, preserving downstream features.",
    props: { target: "string", plane: "string", offset: "number|string",
             gap: "number|string", ids: "array", labels: "array",
             keep: "string", recreate: "boolean", force: "boolean" },
    required: ["target"],
  },
  view_fit: {
    mode: "read", creates: false,
    summary:
      "Re-centre the camera on everything visible. Mostly unnecessary: a " +
      "write that grows the model past the view fits it automatically and " +
      "says so under viewFit. The span it reports covers the visible MODEL " +
      "only: origin planes are infinite and are listed under ignored rather " +
      "than counted, which is why every span used to read 3.46e100. Pass " +
      "auto:false to stop the automatic fit for this document when the user " +
      "is driving the camera themselves, auto:true to put it back.\n\n" +
      "Separately: every applied write refreshes the human's 3D viewport, " +
      "which is NOT the same thing as moving their camera and is not " +
      "rationed. That only shows up in a reply when it FAILED, as guiSync — " +
      "which means the window they are watching still shows the model as it " +
      "was, so describe the change from the reply and reach for " +
      "freecad_render rather than narrating a viewport you cannot see. " +
      "sync:false turns the refresh off for this document (a human dragging " +
      "the view during a long batch), sync:true puts it back.",
    props: { auto: "boolean", sync: "boolean" },
  },
  render: {
    mode: "read", creates: false,
    summary:
      "Write a snapshot of the FreeCAD 3D viewport to disk, through " +
      "Gui.ActiveDocument.ActiveView.saveImage(). Needs savePath, which must " +
      "land inside the export directory, and returns " +
      "the path and dimensions — never the pixels, because a dispatcher " +
      "result is JSON in a text block and a batch of them is 24 of those. " +
      "For an image anyone can look at, call the freecad_render tool. The " +
      "camera is framed for the shot and put back; restore:false leaves it.",
    props: {
      width: "number",
      height: "number",
      background: "string",
      view: "string",
      fit: "boolean",
      format: "string",
      savePath: "string",
      restore: "boolean",
    },
  },
  bom: {
    mode: "read", creates: false,
    summary:
      "The bill of materials: purchased components with MPN, quantity, mass " +
      "and a role of seated|catalog-only (a pattern counts as one line of N, " +
      "not N lines), plus the bodies that have to be made. A solid that a " +
      "split_body cut halves out of gets role split-source and is left out " +
      "of fabricatedVolumeMm3 — it is the same material as both halves and " +
      "nobody makes it. Quote this when the user asks what the design costs, " +
      "weighs or needs ordering.",
    props: {},
  },
};

function opCatalog() {
  return Object.keys(OP_SPECS)
    .map((k) => {
      const s = OP_SPECS[k];
      const req = (s.required || []).join(", ");
      return (
        "  " + k + " (" + s.mode + (s.creates ? ", needs id" : "") + ")" +
        (req ? " required: " + req : "") + " — " + s.summary
      );
    })
    .join("\n");
}

// Mirrors BATCH_LIMIT in koi_cad: a longer transaction is a longer freeze on
// the window the user is watching.
const BATCH_LIMIT = 24;

const TYPE_OF = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

/**
 * Old fn spellings that still dispatch but are no longer advertised.
 *
 * `fn` is what the human reads in their activity line, so a name that is a
 * noun for the data rather than a verb for the act shows up there as a
 * sentence nobody said: "FreeCAD library". Renaming is the fix, and dropping
 * the old key is not — scripts/test_parts.js calls it, and so does any
 * session transcript written before today. Resolved before validation, so an
 * old call takes the new spec rather than falling through as unknown.
 */
const OP_ALIASES = { library: "lookup", sweep: "pipe", subtractive_sweep: "subtractive_pipe" };

/**
 * Shallow validation, on this side of the bridge on purpose. A misspelled fn
 * or a missing length should cost a rejected tool call, not a round trip that
 * opens a transaction and aborts it.
 */
function validateOpArgs(spec, args) {
  const problems = [];
  for (const key of spec.required || []) {
    if (args[key] === undefined || args[key] === null) {
      problems.push("missing required argument '" + key + "'");
    }
  }
  const known = spec.props || {};
  for (const key of Object.keys(args)) {
    if (key === "turn" || key === "id" || key === "name" || key === "comment" || key === "description") continue;
    const want = known[key];
    if (!want) {
      problems.push(
        "unknown argument '" + key + "' (accepts: " +
          (Object.keys(known).join(", ") || "none") + ")"
      );
      continue;
    }
    const got = TYPE_OF(args[key]);
    // "number|string" for the arguments that take a bare number OR something
    // the document has to evaluate: a quantity with units, or an expression
    // bound to the parameter sheet.
    const allowed = String(want).split("|");
    const ok =
      allowed.indexOf(got) !== -1 ||
      // "object" covers a dict; an array is not one, and letting it through
      // here produces a Python-side TypeError a round trip later.
      (allowed.indexOf("object") !== -1 && got === "object") ||
      (allowed.indexOf("number") !== -1 && got === "string" &&
        args[key] !== "" && !isNaN(Number(args[key])));
    if (!ok) {
      problems.push("'" + key + "' should be " + want + ", got " + got);
    }
  }
  return problems;
}

// A dict cannot be spelled as a Python literal (true/false/null differ), so the
// argument bundle travels as JSON text and is parsed on the far side. The text
// itself is embedded the same way everything else is: JSON.stringify of the
// string, which Python parses back verbatim.
function pyPayload(obj) {
  return JSON.stringify(JSON.stringify(obj));
}

async function ensureAttached() {
  if (state.attached) return { attached: true };
  const att = await toolAttach();
  if (!att.attached) {
    return {
      attached: false,
      error: att.error || "Not attached. Call freecad_attach first.",
      detail: att.detail,
    };
  }
  return { attached: true };
}

async function toolCall(args) {
  args = args || {};
  const att = await ensureAttached();
  if (!att.attached) return { error: att.error, detail: att.detail };

  const fn = OP_ALIASES[String(args.fn || "")] || String(args.fn || "");
  const spec = OP_SPECS[fn];
  if (!spec) {
    return {
      error: "unknown fn '" + fn + "'",
      available: Object.keys(OP_SPECS),
      detail: "Available calls:\n" + opCatalog(),
    };
  }
  const opArgs = args.args && typeof args.args === "object" && !Array.isArray(args.args)
    ? args.args
    : {};
  const problems = validateOpArgs(spec, opArgs);
  if (problems.length) {
    return { error: "invalid args for " + fn + ": " + problems.join("; "), accepts: spec.props };
  }
  if (fn === "batch") {
    // Same validation every step would have had on its own, before anything
    // opens a transaction: a batch that fails on step 9 for a typo has
    // already recomputed eight features and rolled them back, and the user
    // watched it happen.
    const stepProblems = validateBatch(opArgs.ops);
    if (stepProblems.length) {
      return {
        error: "invalid batch: " + stepProblems.join("; "),
        detail: "Nothing was sent to FreeCAD. Fix the steps and resend.",
      };
    }
  }
  if (spec.creates && !args.id) {
    return {
      error:
        "'" + fn + "' creates an object, so it needs an id — a stable handle " +
        "like 'sk.plate' or 'pad.base'. Ids are what let a later turn edit " +
        "this object instead of rebuilding it.",
    };
  }

  await ensureKoiCad(false);
  const payload = pyPayload({
    fn,
    args: opArgs,
    id: args.id == null ? null : String(args.id),
    label: args.name == null ? null : String(args.name),
    dryRun: !!args.dryRun,
  });
  const res = await execPython(
    "import koi_cad, json\n" +
    "a = json.loads(" + payload + ")\n" +
    "return koi_cad.call(a['fn'], a['args'], a['id'], a['label'],\n" +
    "                    a['dryRun'])",
    args.timeoutMs || 120000
  );
  return annotateEdit(res.data || {}, args.detail);
}

async function toolScript(args) {
  args = args || {};
  const att = await ensureAttached();
  if (!att.attached) return { error: att.error, detail: att.detail };
  if (typeof args.python !== "string" || !args.python.trim()) {
    return { error: "python is required" };
  }
  await ensureKoiCad(false);
  // The deadline is the trace-hook bound inside Python; the transport timeout
  // has to outlast it or a script that IS being preempted looks like a wedge.
  const deadline = Math.max(0.5, Math.min(Number(args.deadlineSeconds) || 10, 120));
  const payload = pyPayload({
    code: args.python,
    label: String(args.name || "Koi script"),
    dryRun: !!args.dryRun,
    deadline,
  });
  const res = await execPython(
    "import koi_cad, json\n" +
    "a = json.loads(" + payload + ")\n" +
    "return koi_cad.script(a['code'], a['label'], a['dryRun'],\n" +
    "                      a['deadline'])",
    args.timeoutMs || Math.round(deadline * 1000) + 60000
  );
  return annotateEdit(res.data || {}, args.detail);
}

// The one thing the platform will not consistently give us, said out loud
// rather than promised away (§5.1).
function annotateEdit(d, detail) {
  // 4.2: the turn needs the delta -- diff, report, lint, the op's own result.
  // The projection is the internal oracle, and shipping the whole property
  // dump on every call is what makes a fifteen-call turn cost more context
  // than the document is worth. Still one flag away when it is wanted.
  if (d.projection && String(detail || "") !== "full") {
    d.objectCount = (d.projection.objects || []).length;
    delete d.projection;
  }
  if (d.applied && d.undoEntries > 1) {
    d.undoNote =
      "This edit booked " + d.undoEntries + " undo entries, so it may take " +
      "more than one Ctrl+Z to reverse. Tell the user.";
  } else if (d.applied && d.undoEntries === 0) {
    // Said plainly rather than dressed up as "may take more than one": an
    // annotation-only write books nothing, and Ctrl+Z will not undo it.
    d.undoNote =
      "This edit booked no undo entry, so Ctrl+Z will not reverse it. Tell " +
      "the user if it changed anything they would want back.";
  }
  if (d.userChanged) {
    d.userNote =
      "The human changed the document since you last looked at it: " +
      d.userChanged.summary + ". This edit went ahead on top of that — check " +
      "it is still what they want, and never re-create anything listed under " +
      "revertedAiObjects.";
  }
  if ((d.refsBroken || []).length) {
    d.refsNote =
      "This edit broke reference(s) the user picked: " +
      d.refsBroken.join(", ") + ". Do not guess a replacement — say which " +
      "one broke and ask them to pick it again.";
  }
  return d;
}

/**
 * Validate the steps of a batch here rather than in the document.
 *
 * The dispatcher checks fn, args and the id rule per call; a batch step never
 * reaches the dispatcher, and the whole value of the batch is that it does not
 * cost a round trip per step. A rejected batch should cost nothing at all.
 */
function validateBatch(ops) {
  const out = [];
  if (!Array.isArray(ops) || !ops.length) {
    return ["ops must be a non-empty array of {fn, args, id}"];
  }
  if (ops.length > BATCH_LIMIT) {
    return [
      "a batch is capped at " + BATCH_LIMIT + " steps and this one has " +
        ops.length + "; send the rest as a second batch",
    ];
  }
  ops.forEach((st, i) => {
    const where = "ops[" + i + "]";
    if (!st || typeof st !== "object" || Array.isArray(st)) {
      out.push(where + " must be an object {fn, args, id}");
      return;
    }
    const sfn = OP_ALIASES[String(st.fn || "")] || String(st.fn || "");
    const spec = OP_SPECS[sfn];
    if (!spec) {
      out.push(where + ": unknown fn '" + sfn + "'");
      return;
    }
    if (sfn === "batch") {
      out.push(where + ": batches do not nest");
      return;
    }
    if (spec.mode === "document") {
      out.push(
        where + ": '" + sfn + "' happens outside the envelope and cannot be " +
          "a step — create the document first, then batch the rest");
      return;
    }
    const sargs = st.args && typeof st.args === "object" && !Array.isArray(st.args)
      ? st.args
      : {};
    for (const p of validateOpArgs(spec, sargs)) out.push(where + ": " + p);
    if (spec.creates && !st.id) {
      out.push(
        where + ": '" + sfn + "' creates an object, so it needs an id — a " +
          "handle like 'pad.base' that a later turn can edit");
    }
  });
  return out;
}

/**
 * freecad_measure — numbers, at `safe` tier.
 *
 * It lived in the dispatcher first, which meant a confirmation prompt for
 * *looking at* the model. Measurement is the thing this design asks the model
 * to do constantly — verify the edit, check the fit, prove the hole is there —
 * and a check that costs a click is a check that does not get run. So it is
 * its own tool, and there is exactly one implementation of it.
 */
async function toolMeasure(args) {
  args = args || {};
  const att = await ensureAttached();
  if (!att.attached) return { error: att.error, detail: att.detail };
  const refs = Array.isArray(args.refs) ? args.refs.map(String) : null;
  const pairs = Array.isArray(args.pairs) ? args.pairs : null;
  if (pairs) {
    for (const p of pairs) {
      if (!Array.isArray(p) || p.length !== 2) {
        return { error: "each entry of pairs must be [a, b]" };
      }
    }
  }
  await ensureKoiCad(false);
  const payload = pyPayload({
    refs,
    pairs,
    interference: !!args.interference,
    clearance: !!args.clearance,
    deepLint: !!args.deepLint,
    partsOnly: !!args.partsOnly,
  });
  const res = await execPython(
    "import koi_cad, json\n" +
    "a = json.loads(" + payload + ")\n" +
    "return koi_cad.measure(a['refs'], a['pairs'], a['interference'],\n" +
    "                       a['clearance'], a['deepLint'], None,\n" +
    "                       a['partsOnly'])",
    args.timeoutMs || 120000
  );
  return res.data || {};
}

/**
 * freecad_dfm — can this be made?
 *
 * `safe` and read-only for exactly the reason freecad_measure is: a check that
 * costs the user a confirmation is a check that stops being run, and this one
 * is meant to run on every design before anything leaves the session. It opens
 * no transaction, writes nothing, and books no undo entry.
 *
 * It needs no CAM workbench. Everything it measures comes out of OCC — offsets,
 * ray casts and concavity tests — so it answers the same on a build that has
 * never had Path installed. freecad_cam is the layer above, and it is the one
 * that depends on how this build spells its API.
 */
async function toolDfm(args) {
  args = args || {};
  const att = await ensureAttached();
  if (!att.attached) return { error: att.error, detail: att.detail };
  await ensureKoiCad(false);
  const payload = pyPayload({
    targets: Array.isArray(args.targets) ? args.targets.map(String) : null,
    process: args.process ? String(args.process) : "mill3axis",
    tool: args.tool == null ? null : Number(args.tool),
    axes: Array.isArray(args.axes) ? args.axes.map(String) : null,
    stock: args.stock == null ? null : String(args.stock),
    // No default here on purpose. koi_cad.dfm's signature owns it, and when
    // this line carried its own copy the two drifted the first time one of
    // them changed: the Python moved to 0 and every call still arrived with
    // 2.0, so a plate's 2 mm underside allowance was measured against the
    // setup that machines its top and reported as unreachable material.
    stockMargin: args.stockMargin == null ? null : Number(args.stockMargin),
    checks: Array.isArray(args.checks) ? args.checks.map(String) : null,
  });
  const res = await execPython(
    "import koi_cad, json\n" +
    "a = json.loads(" + payload + ")\n" +
    "return koi_cad.dfm(a['targets'], a['process'], a['tool'], a['axes'],\n" +
    "                   a['stock'], a['stockMargin'], a['checks'])",
    args.timeoutMs || 300000
  );
  return res.data || {};
}

/**
 * freecad_cam — the toolpath, which is the proof freecad_dfm cannot give.
 *
 * `mutating`, because it puts a Job in the user's tree, and through the same
 * envelope as every other write so one Ctrl+Z takes it back out and the diff
 * says what appeared. The timeout is its own: adaptive clearing on a real part
 * takes tens of seconds inside the geometry kernel, which nothing here can
 * preempt — the human watches their window not respond for the duration, and
 * that is worth saying before starting a long one.
 */
async function toolCam(args) {
  args = args || {};
  const att = await ensureAttached();
  if (!att.attached) return { error: att.error, detail: att.detail };
  const mode = String(args.mode || "job");
  if (["job", "op", "verify", "post", "clear"].indexOf(mode) === -1) {
    return { error: "mode must be job, op, verify, post or clear" };
  }
  if ((mode === "job" || mode === "op") && !args.id) {
    return {
      error:
        "cam mode '" + mode + "' creates an object, so it needs an id — a " +
        "handle like 'cam.plate' or 'camop.rough'. Ids are what let a later " +
        "turn read this job's toolpaths instead of building a second one.",
    };
  }
  await ensureKoiCad(false);
  const opArgs = {
    mode,
    target: args.target == null ? null : String(args.target),
    job: args.job == null ? null : String(args.job),
    op: args.op == null ? null : String(args.op),
    base: Array.isArray(args.base) ? args.base.map(String) : null,
    props: args.props && typeof args.props === "object" ? args.props : null,
    name: args.name == null ? null : String(args.name),
    savePath: args.savePath == null ? null : String(args.savePath),
  };
  const payload = pyPayload({
    args: opArgs,
    id: args.id == null ? null : String(args.id),
    label: String(args.name || ("CAM " + mode)),
    dryRun: !!args.dryRun,
  });
  const res = await execPython(
    "import koi_cad, json\n" +
    "a = json.loads(" + payload + ")\n" +
    "return koi_cad.call('cam', a['args'], a['id'], a['label'], a['dryRun'])",
    args.timeoutMs || 600000
  );
  return annotateEdit(res.data || {}, args.detail);
}

/**
 * freecad_fem — does it survive the load?
 *
 * `mutating`, like freecad_cam and for the same reason: it puts an Analysis in
 * the user's tree, through the same envelope, so one Ctrl+Z takes it back out.
 * The timeout is the largest in this file. CalculiX is a separate program, it
 * is single threaded, and it runs on the thread that owns the document — the
 * human watches their window stop responding for the whole solve, and a mesh
 * fine enough to be interesting is minutes of that. Say so before starting one.
 *
 * Nothing here defaults a material, a load or a restraint. A modulus recalled
 * from memory scales every number in the result, and an unrestrained model
 * returns rigid-body motion that reads exactly like deflection — so both are
 * refused on the Python side rather than filled in on this one.
 */
async function toolFem(args) {
  args = args || {};
  const att = await ensureAttached();
  if (!att.attached) return { error: att.error, detail: att.detail };
  const mode = String(args.mode || "study");
  const MODES = ["materials", "study", "constrain", "mesh", "solve",
                 "converge", "result", "clear"];
  if (MODES.indexOf(mode) === -1) {
    return { error: "mode must be one of " + MODES.join(", ") };
  }
  if ((mode === "study" || mode === "constrain") && !args.id) {
    return {
      error:
        "fem mode '" + mode + "' creates an object, so it needs an id — a " +
        "handle like 'fea.bracket' or 'bc.mount_fixed'. Ids are what let a " +
        "later turn re-solve this study instead of building a second one.",
    };
  }
  if (mode === "constrain" && !Array.isArray(args.refs)) {
    return {
      error:
        "a boundary condition needs refs: the faces it acts on. Capture the " +
        "user's pick with freecad_call({fn:'ref'}) or hand over the `refs` " +
        "array from freecad_call({fn:'query'}) — an index authored here " +
        "loads the wrong face and solves clean.",
    };
  }
  await ensureKoiCad(false);
  const opArgs = {
    mode,
    target: args.target == null ? null : String(args.target),
    analysis: args.analysis == null ? null : String(args.analysis),
    kind: args.kind == null ? null : String(args.kind),
    refs: Array.isArray(args.refs) ? args.refs.map(String) : null,
    magnitude: args.magnitude == null ? null : Number(args.magnitude),
    direction: args.direction == null ? null : String(args.direction),
    reversed: !!args.reversed,
    values: args.values && typeof args.values === "object" ? args.values : null,
    props: args.props && typeof args.props === "object" ? args.props : null,
    material: args.material == null ? null : String(args.material),
    E: args.E == null ? null : Number(args.E),
    nu: args.nu == null ? null : Number(args.nu),
    density: args.density == null ? null : Number(args.density),
    elementSize: args.elementSize == null ? null : Number(args.elementSize),
    factor: args.factor == null ? null : Number(args.factor),
    name: args.name == null ? null : String(args.name),
  };
  const payload = pyPayload({
    args: opArgs,
    id: args.id == null ? null : String(args.id),
    label: String(args.name || ("FEM " + mode)),
    dryRun: !!args.dryRun,
  });
  // A solve is the longest single call this server makes. The two mesh-and-
  // solve modes get their own budget rather than sharing the CAM one: an
  // aborted transport on a solve that WAS running leaves the human with a
  // frozen window and no reply to explain it.
  const slow = mode === "solve" || mode === "converge";
  const res = await execPython(
    "import koi_cad, json\n" +
    "a = json.loads(" + payload + ")\n" +
    "return koi_cad.call('fem', a['args'], a['id'], a['label'], a['dryRun'])",
    args.timeoutMs || (slow ? 1800000 : mode === "mesh" ? 600000 : 120000)
  );
  return annotateEdit(res.data || {}, args.detail);
}

/**
 * freecad_resolve — is that pick still the thing it was?
 *
 * Read-only and `safe`, so re-validating costs nothing and therefore actually
 * happens. Capture is the other direction and lives in freecad_call, because
 * capture writes to the document and hands back an id.
 */
async function toolResolve(args) {
  args = args || {};
  const att = await ensureAttached();
  if (!att.attached) return { error: att.error, detail: att.detail };
  await ensureKoiCad(false);
  const payload = pyPayload({
    ids: Array.isArray(args.ids) ? args.ids.map(String) : null,
    refs: Array.isArray(args.refs) ? args.refs.map(String) : null,
    selection: !!args.selection,
  });
  const res = await execPython(
    "import koi_cad, json\n" +
    "a = json.loads(" + payload + ")\n" +
    "out = {'ok': True}\n" +
    "if a['selection']:\n" +
    "    out['selection'] = koi_cad.selection_refs()\n" +
    "if a['refs']:\n" +
    "    rows = []\n" +
    "    for r in a['refs'][:32]:\n" +
    "        try:\n" +
    "            o, sub = koi_cad._split_ref(r)\n" +
    "            rows.append({'ref': r,\n" +
    "                         'fingerprint': koi_cad.fingerprint(o, sub)})\n" +
    "        except Exception as e:\n" +
    "            rows.append({'ref': r, 'error': '%s: %s' % (type(e).__name__, e)})\n" +
    "    out['fingerprints'] = rows\n" +
    "if a['ids']:\n" +
    "    store = dict(koi_cad.stored_refs())\n" +
    "    rows = []\n" +
    "    for i in a['ids'][:32]:\n" +
    "        fp = store.get(i)\n" +
    "        if fp is None:\n" +
    "            rows.append({'id': i, 'status': 'unknown',\n" +
    "                         'message': 'no reference stored under that id'})\n" +
    "        else:\n" +
    "            r = koi_cad.resolve_ref(fp)\n" +
    "            r['id'] = i\n" +
    "            rows.append(r)\n" +
    "    out['resolved'] = rows\n" +
    "if not (a['ids'] or a['refs'] or a['selection']):\n" +
    "    out.update(koi_cad.refs_report())\n" +
    "return out",
    args.timeoutMs || 120000
  );
  return res.data || {};
}

// Read the file out of MEMFS and hand it to the browser as a download. The
// bytes never enter the conversation: a STEP file is megabytes of context for
// no benefit, and the user wants the file, not a transcript of it.
/**
 * freecad_export — still insurance, but insurance against much less (§10).
 *
 * On the wasm transport this was the ONLY persistence the user had: MEMFS died
 * with the tab, so the file had to be pushed through a Blob into the browser's
 * download folder in the same breath it was written, or it was gone. Here it
 * lands on the user's actual filesystem, and File > Save in FreeCAD saves. So
 * export goes back to being what its name says — handing over a STEP for a
 * manufacturer, or an FCStd checkpoint before a risky edit — and the reply says
 * where the file is rather than whether a download was taken.
 *
 * The URL is there so the user can pull it into their browser's download folder
 * with a click if they want it there. It is not the only copy any more.
 */
/**
 * freecad_render — direct, headless-safe snapshot of the FreeCAD 3D viewport.
 *
 * Saves an image of the live CAD active view directly via FreeCAD's native
 * Gui.ActiveDocument.ActiveView.saveImage() API, bypassing browser DOM,
 * WebRTC stream framing and window focus issues.
 *
 * The base64 it returns leaves through the image content block that callTool
 * builds for this one tool, and through nothing else. In a text block the
 * bytes are unreadable to the model, unreadable to the human, and cost tens of
 * thousands of tokens to say so — which is a render that fails at the one job
 * the tool exists for while every assertion about it passes.
 */
async function toolRender(args) {
  args = args || {};
  const att = await ensureAttached();
  if (!att.attached) return { error: att.error, detail: att.detail };
  if (state.bridge && state.bridge.gui === false) {
    return {
      ok: false,
      error: "This FreeCAD process is headless (no GUI). freecad_render requires a GUI view.",
    };
  }
  await ensureKoiCad(false);
  const payload = pyPayload({
    width: Number(args.width) || 800,
    height: Number(args.height) || 600,
    background: String(args.background || "Current"),
    view: args.view ? String(args.view) : null,
    fit: args.fit !== false,
    format: String(args.format || "png"),
    savePath: args.savePath ? String(args.savePath) : null,
    restore: args.restore !== false,
  });
  const res = await execPython(
    "import koi_cad, json\n" +
    "a = json.loads(" + payload + ")\n" +
    "return koi_cad.render_view(width=a['width'], height=a['height'],\n" +
    "                           background=a['background'], view_preset=a['view'],\n" +
    "                           fit=a['fit'], img_format=a['format'],\n" +
    "                           save_path=a['savePath'], restore=a['restore'])\n",
    args.timeoutMs || 60000
  );
  return res.data || {};
}

async function toolExport(args) {
  args = args || {};
  const att = await ensureAttached();
  if (!att.attached) return { error: att.error, detail: att.detail };

  // Ask before doing. The directory is checked on every /hello, so this costs
  // one cheap round trip and turns "FreeCADError: filesystem error: cannot
  // create directories" — raised from inside a save, with the document's fate
  // ambiguous — into a sentence with a fix in it.
  const hello = await readBridgeHello(true);
  if (hello.available && hello.exportWritable === false) {
    return {
      error:
        "Cannot export: " + (hello.exportDir || "the export directory") +
        " is not writable by FreeCAD (" + (hello.exportError || "no detail") + ").",
      exportDir: hello.exportDir,
      detail:
        "Nothing was written and nothing was lost — the document is untouched " +
        "and the user can still save it from FreeCAD. To fix the directory: " +
        "under rootless Podman a bind-mounted host directory belongs to a " +
        "subuid, not to the container's user, so\n" +
        "    podman unshare chown -R 1000:1000 <host path>\n" +
        "on the host; or restart the bridge with KOI_EXPORT_DIR pointing " +
        "somewhere the container already owns, such as /config/koi_export.",
    };
  }

  await ensureKoiCad(false);
  const payload = pyPayload({
    format: String(args.format || "FCStd"),
    targets: Array.isArray(args.targets) ? args.targets.map(String) : null,
  });
  const res = await execPython(
    "import koi_cad, json\n" +
    "a = json.loads(" + payload + ")\n" +
    "return koi_cad.export_doc(a['format'], a['targets'])",
    args.timeoutMs || 180000
  );
  const d = res.data || {};
  if (d.error || !d.path) return d;
  const cfg = bridgeConfig();
  d.persisted = "disk";
  d.url = cfg.bridgeUrl + "/file?path=" + encodeURIComponent(d.path);
  d.note =
    "Written to the user's filesystem at " + d.path + ". It is a real file and " +
    "it stays there — it is under the bridge's export directory, which the " +
    "deployment mounts on the host, so it is already where the human can " +
    "reach it. No download needed.";
  return d;
}

async function toolGet(args) {
  args = args || {};
  const att = await ensureAttached();
  if (!att.attached) return { error: att.error, detail: att.detail };
  const raw = args.ids != null ? args.ids : args.id;
  const wanted = (Array.isArray(raw) ? raw : [raw])
    .filter((v) => v != null && String(v).trim() !== "")
    .map(String);
  if (!wanted.length) return { error: "id (or ids) is required" };
  await ensureKoiCad(false);
  // Through pyPayload like every other argument bundle. An id interpolated
  // into the snippet is a quote away from breaking the source and rather less
  // than that away from executing whatever follows it.
  const payload = pyPayload({ ids: wanted });
  const res = await execPython(
    "import koi_cad, json\n" +
    "a = json.loads(" + payload + ")\n" +
    "return koi_cad.get_nodes(a['ids'])",
    args.timeoutMs || 30000
  );
  const d = res.data || {};
  // One id in, one node out: the caller asked about an object, not a list.
  if (Array.isArray(raw)) return d;
  return (d.nodes || [])[0] || d;
}

function treeCount(nodes) {
  return (nodes || []).reduce((n, x) => n + 1 + treeCount(x.children), 0);
}

/**
 * Trim the tree to a node budget, depth-first, keeping structure.
 *
 * K2 measured the full walk at 2-3 ms, so this is not about time — it is
 * about the turn. sync opens every turn by contract, and an unbounded tree
 * means a fifty-object document spends a growing share of every turn
 * re-reading itself. The count is always exact; only the listing is cut, and
 * the reply says so rather than looking like a smaller document.
 */
function trimTree(nodes, budget) {
  const out = [];
  for (const n of nodes || []) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    const row = { name: n.name, type: n.type, label: n.label };
    if (n.children && n.children.length) {
      const kids = trimTree(n.children, budget);
      if (kids.length) row.children = kids;
      if (kids.length < n.children.length) {
        row.childrenOmitted = n.children.length - kids.length;
      }
    }
    out.push(row);
  }
  return out;
}

async function toolSync(args) {
  args = args || {};
  const att = await ensureAttached();
  if (!att.attached) return { error: att.error, detail: att.detail };
  await ensureKoiCad(false);
  const res = await execPython(
    // App is a __main__ global in this build rather than something this
    // snippet imports; say it out loud instead of depending on it.
    "import FreeCAD as App\n" +
    "import koi_cad\n" +
    "d = {'ok': True, 'gui': koi_cad.gui_state(),\n" +
    "     'userDiff': koi_cad.user_diff(),\n" +
    "     'selection': koi_cad.selection(),\n" +
    "     'health': koi_cad.health(),\n" +
    "     'tree': koi_cad._tree(App.ActiveDocument),\n" +
    "     'lint': koi_cad.lint(),\n" +
    "     'refs': koi_cad.refs_report()}\n" +
    "d['rev'] = koi_cad.observe()\n" +
    "d['document'] = App.ActiveDocument.Name if App.ActiveDocument else None\n" +
    "return d",
    60000
  );
  const d = res.data || {};
  // An exec that failed produces {ok:false, error}. Shaping that into the
  // report below yields objectCount:0, lint:[], refs:[] — a clean bill of
  // health for a document this never looked at, handed to the one call whose
  // entire job is to say what changed while we were not looking. It read
  // exactly like an empty document. Refuse instead.
  if (d.ok === false || d.error) {
    return {
      error: "the turn check could not run: " + (d.error || "unknown"),
      detail:
        "This is NOT an empty or unchanged document — nothing was read. Do " +
        "not describe the model or report it as healthy. Fix the bridge " +
        "first: freecad_probe, then freecad_attach.",
    };
  }
  const full = String(args.detail || "") === "full";
  const nodeBudget = Math.max(1, Math.min(Number(args.limit) || 60, 400));
  const total = treeCount(d.tree);
  let tree = d.tree || [];
  let treeNote;
  if (!full && total > nodeBudget) {
    tree = trimTree(tree, { left: nodeBudget });
    treeNote =
      "showing " + nodeBudget + " of " + total + " nodes. Pass detail:'full' " +
      "for all of them, or freecad_get({ids:[...]}) to drill into the ones " +
      "you need — the count above is exact either way.";
  }
  const lintAll = d.lint || [];
  let lintRows = lintAll;
  let lintNote;
  if (!full && Array.isArray(lintAll) && lintAll.length > 25) {
    // Errors first: a truncated lint that dropped the errors and kept the
    // underconstrained-sketch warnings would be worse than no lint.
    const rank = (r) => (String((r || {}).severity || "") === "error" ? 0 : 1);
    lintRows = lintAll.slice().sort((a, b) => rank(a) - rank(b)).slice(0, 25);
    lintNote =
      lintAll.length + " lint rows, showing the first 25 with errors first. " +
      "Pass detail:'full' for the rest.";
  }
  return {
    document: d.document,
    // Nodes, not roots: one App::Part holding forty things is not a
    // one-object document, and this is the number the model reads.
    objectCount: total,
    // Advisory only. The gate that matters runs inside the mutating call, not
    // here: single-threaded wasm protects us within one exec, not between two.
    guiBusy: (d.gui || {}).busy,
    gui: d.gui,
    lint: lintRows,
    lintTotal: Array.isArray(lintAll) ? lintAll.length : undefined,
    lintNote: lintNote,
    // 8.1: user picks are re-validated every turn, not trusted from the turn
    // they were made. This is where that happens.
    refs: (d.refs || {}).refs || [],
    refsBroken: (d.refs || {}).broken || [],
    refsMoved: (d.refs || {}).moved || [],
    // 5.2: what the HUMAN changed since our last turn. Answering from the
    // document as we left it is how their work gets overwritten.
    userDiff: d.userDiff,
    // Their pointing device, fingerprinted, so "this one" resolves.
    selection: d.selection || [],
    health: d.health,
    rev: d.rev,
    tree: tree,
    treeNote: treeNote,
  };
}

async function toolEdit(args) {
  args = args || {};
  const att = await ensureAttached();
  if (!att.attached) return { error: att.error, detail: att.detail };
  if (typeof args.python !== "string" || !args.python.trim()) {
    return { error: "python is required" };
  }
  await ensureKoiCad(false);
  const name = JSON.stringify(String(args.name || "Koi edit"));
  const code = JSON.stringify(args.python);
  const res = await execPython(
    "import koi_cad\n" +
    "return koi_cad.edit(" + name + ",\n" +
    "                    " + code + ",\n" +
    "                    dry_run=" + (args.dryRun ? "True" : "False") + ")",
    args.timeoutMs || 120000
  );
  return annotateEdit(res.data || {}, args.detail || "full");
}

/**
 * freecad_exec — free Python, for the kill probes only.
 *
 * Tiering, stated plainly because it is a compromise. §6.2 says arbitrary code
 * is `dangerous`, which confirms on *every* call even in `--full-auto`. A probe
 * suite makes ~15 calls, so `dangerous` would mean fifteen Accept clicks per
 * run and the probes would not get run. This is `mutating` — one confirmation
 * per script run — on the argument that during the probe stage the caller is a
 * deterministic script in the repo, not the model improvising.
 *
 * That argument expires the moment there is an LLM-facing turn. When
 * `freecad_call` lands, this tool is deleted, not re-tiered: the point of the
 * split is that the validated dispatcher earns `mutating` and arbitrary code
 * does not.
 */
async function toolExec(args) {
  args = args || {};
  if (typeof args.python !== "string" || !args.python.trim()) {
    return { error: "python is required" };
  }
  const att = await ensureAttached();
  if (!att.attached) {
    return {
      error:
        "Not attached. Call freecad_attach first — exec needs the bridge " +
        "and the interpreter, and attach is what proves both are up.",
      detail: att.detail,
    };
  }
  try {
    const res = await execPython(args.python, args.timeoutMs || EXEC_TIMEOUT);
    return { ok: true, result: res.data, channel: res.channel, rc: res.rc };
  } catch (e) {
    // Not thrown: a probe that expects a failure needs to read the failure,
    // and an isError result would cost the caller its retry budget instead.
    return { ok: false, error: e.message };
  }
}

/**
 * freecad_exec and freecad_edit are arbitrary code at `mutating` tier, which is
 * exactly what the §6.2 split exists to prevent. The argument that justified
 * them — the caller is a deterministic script in the repo, not the model —
 * expired the moment freecad_call landed and gave the LLM a real write surface.
 *
 * They are not deleted, because scripts/test_probes.js and
 * scripts/test_koi_cad.js are the regression suite that keeps the pin honest,
 * and both need to set up conditions the envelope is supposed to handle
 * (breaking the document on purpose) without fifteen Accept clicks per run.
 *
 * So they are gated instead: off by default, and listTools does not mention
 * them, so the LLM never sees them. Set `probe-exec: on` in SKILL.md while
 * running the suites. This must be off before any LLM-facing session.
 */
function probeExecEnabled() {
  const v = configValue(serverConfig(), "probeExec");
  if (v === true) return true;
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return s === "on" || s === "true" || s === "1" || s === "yes";
}

const PROBE_ONLY_TOOLS = ["freecad_exec", "freecad_edit"];

function probeExecRefusal(name) {
  return {
    error:
      name + " is a probe-stage tool and is currently disabled. Use " +
      "freecad_call for structured edits, or freecad_script for free Python. " +
      "To run the probe suites, set `probe-exec: on` under the freecad_bridge " +
      "server in SKILL.md.",
  };
}

async function toolConfig(args) {
  args = args || {};
  try {
    if (
      args.bridgeUrl !== undefined ||
      args.bridgeToken !== undefined ||
      args.streamUrl !== undefined
    ) {
      setBridgeConfig(args);
    }
    if (
      args.pinVersion !== undefined ||
      args.pinCommit !== undefined ||
      args.pinFingerprint !== undefined ||
      args.pinMode !== undefined
    ) {
      setPin(args);
    }
  } catch (e) {
    return { error: e.message };
  }

  const cfg = bridgeConfig();
  const pin = pinConfig();
  const keys = serverConfigKeys();
  const out = {
    bridgeUrl: cfg.bridgeUrl,
    tokenSet: cfg.tokenSet,
    streamUrl: cfg.streamUrl,
    source: cfg.source,
    pin: { ...pin, source: state.pinSource },
    attached: state.attached,
    busy: state.busy || null,
    skillConfigKeys: keys,
  };
  if (cfg.source === "default" && !configValue(serverConfig(), "bridgeUrl")) {
    out.hint = keys.length
      ? "SKILL.md sent this server " + keys.join(", ") + " — no bridge-url among " +
        "them, so " + DEFAULT_BRIDGE_URL + " is in use."
      : "This server received no configuration from SKILL.md at all, so " +
        "bridge-url there cannot take effect. Pass bridgeUrl to this tool instead.";
  }
  if (pin.mode !== "off" && state.pinSource === "unset") {
    out.note =
      "No pin is configured. Run freecad_version() against this install and " +
      "paste the returned pinBlock into SKILL.md — that is K0, and it matters " +
      "more on an install that can be upgraded under you than it did on a " +
      "frozen mirror.";
  }
  return out;
}

async function toolProbe() {
  const cfg = bridgeConfig();
  const hello = await readBridgeHello(true);
  if (!hello.available) {
    return {
      bridge: false,
      bridgeUrl: cfg.bridgeUrl,
      error: hello.error,
      status: hello.status,
      hint: bridgeDownMessage(),
    };
  }
  const proto = protocolStatus();
  const app = hello.app || {};
  // /hello reads the pump's state directly, so this is the authoritative
  // answer to "is it still going?" — and the cheapest way for a caller that
  // just took a 409 or a 504 to find out when to try again.
  state.busy = hello.running || null;
  return {
    bridge: true,
    bridgeUrl: cfg.bridgeUrl,
    protocol: hello.protocol,
    protocolOk: proto.ok,
    protocolExpected: BRIDGE_PROTOCOL,
    pid: hello.pid,
    // The distinction the whole co-design story rests on. `gui: false` is a
    // usable session — headless builds geometry fine — but there is no human in
    // it: no selection to read, no view to restore, no window to watch.
    gui: !!hello.gui,
    mode: hello.mode,
    // Which thread the snippet lands on. If this is not the thread that owns
    // the document, every write is a race the crash report will blame on
    // something else.
    dispatch: hello.dispatch || null,
    exe: app.exe || null,
    exportDir: hello.exportDir || null,
    tokenRequired: !!hello.tokenRequired,
    running: hello.running || null,
    attached: state.attached,
    streamUrl: cfg.streamUrl,
    note: busyNote() || undefined,
  };
}

async function toolAttach(args) {
  args = args || {};
  const timeout = args.timeoutMs || ATTACH_TIMEOUT;
  const deadline = Date.now() + timeout;

  // Attaching is the recovery path: reaching here means the caller has dealt
  // with whatever was in the way. A previous busy job may well have finished.
  state.busy = null;
  // A FreeCAD that restarted has no koi_cad in it, and this side cannot tell a
  // restart from a reconnect, so re-install rather than trust the cache.
  state.koiCadVersion = null;
  state.koiCadFile = null;
  state.koiCadReplacedStale = false;

  const hello = await readBridgeHello(true);
  if (!hello.available) {
    return {
      attached: false,
      error: "No bridge at " + (state.bridgeUrl || DEFAULT_BRIDGE_URL) + ".",
      detail: hello.error,
      findings: bridgeDownMessage(),
    };
  }

  const proto = protocolStatus();
  if (!proto.ok) {
    return {
      attached: false,
      error:
        "Bridge protocol mismatch: this skill speaks " + proto.expected +
        ", koi_bridge.py speaks " + proto.found + ".",
      detail:
        "The two halves ship together. Copy tools/koi_bridge.py from this " +
        "version of the skill into the FreeCAD macro directory and reload it.",
      protocol: proto,
    };
  }

  // The bridge answering is not the interpreter being usable — FreeCAD may be
  // mid-recompute, or the human may have a modal open. Poll the real thing.
  let build = null;
  let probeErr = null;
  while (Date.now() < deadline) {
    try {
      build = await readRuntimeBuild();
      break;
    } catch (e) {
      probeErr = e.message;
      await sleep(2000);
    }
  }
  if (!build) {
    return {
      attached: false,
      bridge: { protocol: hello.protocol, pid: hello.pid, gui: !!hello.gui },
      error: "The bridge is up but the Python interpreter never answered.",
      detail: probeErr,
    };
  }

  state.attached = true;
  await readBridgeEvidence(true);
  const status = evaluatePin();

  if (status.pinned && !status.match && status.mode === "strict") {
    state.attached = false;
    return {
      attached: false,
      error: "Pinned build mismatch (pin-mode: strict).",
      build,
      pin: status,
      pinBlock: pinBlock(),
      detail:
        "The FreeCAD on this machine is not the build this skill was pinned " +
        "to. Re-run the kill probes against it before using it, then update " +
        "the pin block in SKILL.md.",
    };
  }

  const out = {
    attached: true,
    // One line, first, because this is what a human sees when a session opens.
    // The YAML pin block that used to land here is setup material: it belongs
    // in the run that sets the pin, not in front of somebody who came to
    // design a bracket.
    status: attachStatus(build, hello, status),
    transport: "bridge",
    protocol: hello.protocol,
    pid: hello.pid,
    gui: !!hello.gui,
    mode: hello.mode,
    dispatch: hello.dispatch || null,
    build,
    pin: status,
  };
  if (!status.pinned) {
    out.pinHint =
      "This build is not pinned. freecad_version() returns the block to " +
      "paste into SKILL.md — do that at the end of a setup run. Say this " +
      "once, in a sentence, and get on with the user's actual request.";
  }
  if (status.pinned && !status.match) {
    out.pinDrift =
      "This is not the build the skill was pinned to (" +
      (status.drift || []).map((d) => d.field).join(", ") +
      " moved). The probe suites measured a " +
      "different binary, so their results do not carry over — say that " +
      "plainly rather than softening it.";
  }
  if (hello.exportWritable === false) {
    // Not a refusal. Geometry works, the human can still File > Save, and a
    // session that stopped over this would be refusing the work to protect the
    // handover. But it has to be said now and out loud, because the alternative
    // is saying it three hours later when somebody asks for the STEP.
    out.warning =
      "The export directory is not writable: " + (hello.exportDir || "?") +
      " (" + (hello.exportError || "no detail") + "). Everything else works — " +
      "but freecad_export cannot write anything, so there is no way to hand " +
      "geometry over from this session. Under rootless Podman a bind mount is " +
      "owned by a subuid rather than the container's user:\n" +
      "    podman unshare chown -R 1000:1000 <host path>\n" +
      "or set KOI_EXPORT_DIR to a path the container owns, e.g. " +
      "/config/koi_export. Tell the user before they build anything they will " +
      "want out.";
  }
  // Load the module HERE rather than lazily on the first freecad_call.
  //
  // A FreeCAD the human already had open is the normal case, not the edge
  // one, and it is the case where the in-process module can disagree with
  // this server. Discovering that three calls into a build -- after a
  // new_document has already landed in their document -- is the worst place
  // to discover it. Not fatal: attach still succeeds, because probe and
  // version are exactly what somebody diagnosing this needs and refusing to
  // attach would take them away.
  try {
    await ensureKoiCad(true);
    out.koiCad = {
      version: state.koiCadVersion,
      file: state.koiCadFile,
      ops: (state.koiCadOps || []).length,
    };
    if (state.koiCadReplacedStale) {
      out.koiCadNote =
        "This FreeCAD had an older koi_cad loaded from a previous session; " +
        "it was replaced with the one this skill ships. Nothing in the " +
        "document changed — but if the human ran a koi call before this " +
        "attach, it ran against the old module.";
    }
  } catch (e) {
    out.koiCadError = String(e && e.message ? e.message : e);
    out.koiCadHint =
      "The edit channel is not usable until this is resolved: freecad_call " +
      "and freecad_script both load this module. freecad_probe, " +
      "freecad_version and freecad_sync still work. Restarting FreeCAD " +
      "clears a module a previous session left behind; if it survives that, " +
      "another koi_cad is earlier on sys.path.";
  }

  if (!hello.gui) {
    out.note =
      "This FreeCAD is headless. Geometry works; the human half does not — " +
      "there is no selection to read, no view to isolate or restore, and " +
      "nobody watching. Every rule about user picks still applies, but there " +
      "is no way to satisfy it: say so rather than authoring references " +
      "yourself.";
  }
  return out;
}

/**
 * The one line a session opens with.
 *
 * The friction this replaces was measured: a cold start printed a raw YAML
 * configuration block into the chat before the user had said anything, and
 * they had to ask for it to be ignored. Status is a sentence; the pin block is
 * a deliverable, and a deliverable nobody asked for is noise.
 */
function attachStatus(build, hello, pin) {
  const b = build || {};
  const version = b.exeVersion || b.version || "FreeCAD";
  const bits = [
    "Connected to FreeCAD " + version + (hello.gui ? " (GUI)" : " (headless)"),
  ];
  if (b.commit) bits.push("build " + String(b.commit).slice(0, 10));
  bits.push(
    pin.pinned
      ? (pin.match ? "pinned build matches" : "PINNED BUILD MISMATCH")
      : "unpinned"
  );
  return bits.join(", ") + ".";
}

async function toolVersion(args) {
  args = args || {};
  const want = Array.isArray(args.layers) && args.layers.length
    ? args.layers
    : ["runtime", "deploy", "transport"];

  const errors = {};
  const needsBridge =
    want.indexOf("deploy") !== -1 || want.indexOf("transport") !== -1;
  if (needsBridge && (args.refresh || !state.transport)) {
    await readBridgeEvidence(!!args.refresh);
  }
  if (want.indexOf("runtime") !== -1 && (args.refresh || !state.build)) {
    try {
      const hello = await readBridgeHello(false);
      if (!hello.available) throw new Error(hello.error || "no bridge");
      await readRuntimeBuild();
    } catch (e) {
      errors.runtime = e.message;
    }
  }

  const status = evaluatePin();
  const proto = protocolStatus();
  const out = {
    build: state.build,
    // Same object under the name the `layers` argument uses. Asking for
    // layers:["runtime"] and getting back a key called `build` is a trap every
    // caller falls into once.
    runtime: state.build,
    deploy: state.deploy,
    transport: state.transport,
    protocol: proto,
    pin: status,
    pinBlock: pinBlock(),
    errors: Object.keys(errors).length ? errors : undefined,
  };

  if (!proto.ok && state.bridge && state.bridge.available) {
    out.warning =
      "koi_bridge.py speaks protocol " + proto.found + " and this skill speaks " +
      proto.expected + ". They ship together; reinstall the macro.";
  }
  return out;
}

// --- MCP contract --------------------------------------------

return {
  listTools() {
    const tools = [
      {
        name: "freecad_config",
        description:
          "Read or set which FreeCAD process this session talks to, and the " +
          "build it is pinned to. Called with no arguments it only reports.",
        // The activity line is the only place the human sees what the model
        // is doing to their document without reading the transcript, so every
        // one of these carries the argument that distinguishes this call from
        // the last one. Mustache over the tool's own arguments: {{arg}},
        // {{#arg}}…{{/arg}} for the optional half of a sentence, and
        // {{arg|default:…}} where there is a documented default worth naming.
        displayMessage:
          "\u2699\ufe0f FreeCAD bridge config" +
          "{{#bridgeUrl}} \u2192 {{bridgeUrl}}{{/bridgeUrl}}" +
          "{{#pinMode}} \u00b7 pin {{pinMode}}{{/pinMode}}",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            bridgeUrl: {
              type: "string",
              description:
                "Where koi_bridge.py is listening, e.g. http://127.0.0.1:8765. " +
                "Loopback unless FreeCAD is in a container with a published port.",
            },
            bridgeToken: {
              type: "string",
              description:
                "Shared secret, if the bridge was started with one. Sent as " +
                "X-Koi-Token.",
            },
            streamUrl: {
              type: "string",
              description:
                "Optional. The WebRTC/VNC page showing this FreeCAD's window, " +
                "for the human. Nothing here talks to it.",
            },
            pinVersion: { type: "string", description: "Expected ExeVersion, e.g. 1.1.0dev." },
            pinCommit: { type: "string", description: "Expected BuildRevisionHash (prefix match)." },
            pinFingerprint: {
              type: "string",
              description: "Expected fingerprint of the FreeCAD binary on disk.",
            },
            pinMode: {
              type: "string",
              enum: ["off", "warn", "strict"],
              description: "strict refuses to attach to a build that is not the pinned one. Default warn.",
            },
          },
        },
      },
      {
        name: "freecad_probe",
        description:
          "Diagnostics for the bridge: whether a FreeCAD is answering, which " +
          "protocol it speaks, whether it has a GUI (and therefore a human), " +
          "which thread snippets land on, and whether a job is still running. " +
          "Read-only and immediate — it does not wait for the interpreter.",
        displayMessage: "🔍 Probing the FreeCAD bridge",
        tier: "safe",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "freecad_attach",
        description:
          "Attach to the FreeCAD the bridge is running inside: check the wire " +
          "protocol, wait for the interpreter, read the build identity, and " +
          "check it against the pin. Reports whether that FreeCAD has a GUI, " +
          "which decides whether there is a human in this session at all. " +
          "Never writes to the document.",
        displayMessage: "🔗 Attaching to FreeCAD",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            timeoutMs: {
              type: "number",
              description:
                "How long to wait for the interpreter. Default 60000 — the " +
                "bridge either answers or does not, and a FreeCAD that is " +
                "mid-recompute answers when it is done.",
            },
          },
        },
      },
      {
        name: "freecad_version",
        description:
          "Report the build identity from all three evidence layers (the live " +
          "interpreter, the install the bridge runs inside, and the bridge " +
          "itself), compare it with the pin, and return the YAML block to " +
          "paste into SKILL.md. An install moves under an upgrade in a way a " +
          "frozen deploy never did, so check this after one.",
        displayMessage:
          "\u{1F3F7}\ufe0f Reading FreeCAD build identity" +
          "{{#refresh}} \u00b7 re-reading{{/refresh}}",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            refresh: { type: "boolean", description: "Re-read instead of using cached evidence." },
            layers: {
              type: "array",
              items: { type: "string", enum: ["runtime", "deploy", "transport"] },
              description:
                "Which layers to collect. transport and deploy come from the " +
                "bridge and answer even while the interpreter is busy.",
            },
          },
        },
      },
      {
        name: "freecad_get",
        description:
          "Full properties, state and shape metrics for one object or a " +
          "handful. Takes a koi id ('pad.base'), an internal name ('Pad001') " +
          "or a label. This is the drill-down half of freecad_sync's tree: " +
          "the tree says what exists, this says what it is. Pass 'ids' to " +
          "read several in one round trip rather than one call each.",
        // This one had no displayMessage at all, so a drill-down showed up in
        // the activity line as a bare tool name.
        displayMessage:
          "\u{1F50E} Reading {{id|default:several FreeCAD objects}}",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "One id, name or label." },
            ids: {
              type: "array",
              items: { type: "string" },
              description: "Several, in one call (max 64).",
            },
          },
        }
      },
      {
        name: "freecad_sync",
        description:
          "Read the live document: the object tree, lint warnings, what the " +
          "human changed and what they have selected. Read-only. Call this " +
          "before editing so the reply is about the document as it is now, " +
          "not as it was.\n\nThe tree and the lint are trimmed on a large " +
          "document — objectCount and lintTotal are always exact, and " +
          "treeNote/lintNote say when something was cut. Drill in with " +
          "freecad_get rather than asking for detail:'full' by reflex.",
        displayMessage:
          "\u{1F504} Reading the FreeCAD document" +
          " ({{detail|default:summary}})",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            detail: {
              type: "string",
              enum: ["summary", "full"],
              description:
                "full returns every tree node and lint row. Default summary.",
            },
            limit: {
              type: "number",
              description: "Tree node budget for summary. Default 60, max 400.",
            },
          },
        },
      },
      {
        name: "freecad_render",
        description:
          "Snapshot the FreeCAD 3D viewport through FreeCAD's own renderer, " +
          "Gui.ActiveDocument.ActiveView.saveImage(). The image comes back as " +
          "an image, not as text, and does not depend on browser focus or on " +
          "the WebRTC stream being visible. Pixels are for the human's sanity " +
          "check — verify geometry with freecad_measure, and keep to about " +
          "two views a turn. The camera is framed for the shot and put back " +
          "where the human left it.",
        displayMessage:
          "📷 Rendering FreeCAD viewport" +
          "{{#view}} · {{view}}{{/view}}" +
          "{{#width}} ({{width}}x{{height}}){{/width}}",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            width: {
              type: "number",
              description: "Image width in pixels (default 800, max 3840).",
            },
            height: {
              type: "number",
              description: "Image height in pixels (default 600, max 2160).",
            },
            background: {
              type: "string",
              enum: ["Current", "White", "Black", "Transparent"],
              description: "Viewport background color. Default 'Current'.",
            },
            view: {
              type: "string",
              enum: ["iso", "front", "rear", "top", "bottom", "left", "right"],
              description: "Optional camera angle preset to frame before rendering.",
            },
            fit: {
              type: "boolean",
              description: "Whether to re-centre and fit all visible objects (default true).",
            },
            format: {
              type: "string",
              enum: ["png", "jpeg"],
              description: "Image format: 'png' (default) or 'jpeg'.",
            },
            savePath: {
              type: "string",
              description:
                "Optional. Also write the image to disk, as a bare filename " +
                "or a path inside the bridge's export directory — anywhere " +
                "else is refused, and the extension must match the format.",
            },
            restore: {
              type: "boolean",
              description:
                "Put the camera back where the human had it once the shot is " +
                "taken (default true). Pass false to leave the view framed.",
            },
            timeoutMs: { type: "number", description: "Default 60000." },
          },
        },
      },
      {
        name: "freecad_measure",
        description:
          "Measure the model: volume, area, bounding box, centre of mass, " +
          "face and edge counts, recompute state and validity, plus sketch " +
          "degrees of freedom and constraint conflicts. Set interference to " +
          "get the common volume of each pair of parts — zero for parts that " +
          "merely touch, non-zero means they cannot both exist. Set " +
          "clearance for the minimum distance between them. Read-only.\n\n" +
          "Verify with this rather than with a screenshot: a plate with no " +
          "hole looks exactly like a plate with one.",
        displayMessage:
          "\u{1F4CF} Measuring the FreeCAD model" +
          "{{#interference}} \u00b7 interference{{/interference}}" +
          "{{#clearance}} \u00b7 clearance{{/clearance}}" +
          "{{#deepLint}} \u00b7 deep lint{{/deepLint}}",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            refs: {
              type: "array",
              items: { type: "string" },
              description:
                "Objects to measure, by koi id, Name or Label. Omit to " +
                "measure everything that has a shape.",
            },
            pairs: {
              type: "array",
              items: { type: "array", items: { type: "string" } },
              description:
                "Explicit [a, b] pairs for interference and clearance. Omit " +
                "to check every pair of parts.",
            },
            interference: {
              type: "boolean",
              description:
                "Common volume per pair. Bounding boxes reject most pairs " +
                "first, so this is cheap enough to run every turn.",
            },
            clearance: {
              type: "boolean",
              description: "Minimum distance per pair, for gaps and access.",
            },
            deepLint: {
              type: "boolean",
              description:
                "Also run the rules that walk face lists — sliver faces and " +
                "unclosed solids. Left out of the per-turn lint because it " +
                "scales with model size, not object count.",
            },
            partsOnly: {
              type: "boolean",
              description:
                "Measure the parts a human would count — bodies and " +
                "purchased components — instead of every object that has a " +
                "shape. Leaves out origin planes with infinite boxes, " +
                "sketches and intermediate features, and drops the hidden " +
                "solid a split was cut from and the hidden master a " +
                "pattern's links point at, which otherwise fill the " +
                "interference hits with a part overlapping its own copy. " +
                "Use it for verification the user is going to read.",
            },
            timeoutMs: { type: "number", description: "Default 120000." },
          },
        },
      },
      {
        name: "freecad_dfm",
        description:
          "Can this be MADE? Read-only, and the answer is measured rather " +
          "than asserted.\n\nEverything freecad_measure reports is about " +
          "whether the model is what you meant. This is about whether the " +
          "shape exists in metal, which is a different question with a " +
          "different failure mode: a zero-radius internal corner is valid " +
          "geometry, recomputes clean, passes interference, and cannot be " +
          "milled by any cutter at any feed.\n\nIt checks internal corner " +
          "radii (which set the largest tool that fits), tool reach per setup " +
          "direction (undercuts, and how many times the part has to be " +
          "re-fixtured), enclosed voids, hole depth ratios, and the RESIDUAL: " +
          "the volume of material a cutter of that diameter cannot reach from " +
          "ANY direction. The residual is the definitive number — it is the " +
          "five-axis bound, so anything above zero means the finished part " +
          "will not be the modelled shape, whatever the machine.\n\nNeeds no " +
          "CAM workbench: it is OCC offsets and ray casts, so it answers the " +
          "same on a build that has never had Path installed. Run it before " +
          "exporting geometry to anybody who is going to make it. Read " +
          "`manufacturable`: false is a refusal, null means a check did not " +
          "run and is NOT a pass.",
        displayMessage:
          "\u{1F527} Checking manufacturability" +
          "{{#process}} \u00b7 {{process}}{{/process}}" +
          "{{#tool}} \u00b7 \u00f8{{tool}} mm{{/tool}}",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            targets: {
              type: "array",
              items: { type: "string" },
              description:
                "Objects to check, by koi id, Name or Label. Omit for the " +
                "parts a human would count — the same set partsOnly measures.",
            },
            process: {
              type: "string",
              enum: ["mill3axis", "mill5axis", "mill_any", "turn", "print_fdm"],
              description:
                "Which process the part has to survive. Default mill3axis, " +
                "which checks +Z and -Z and is what most of this skill's " +
                "output is actually made by.",
            },
            tool: {
              type: "number",
              description:
                "Cutter diameter in mm for the residual check. Omit and the " +
                "largest tool that fits the tightest internal corner is used, " +
                "which is the most optimistic case and therefore the right " +
                "default for a lower bound.",
            },
            axes: {
              type: "array",
              items: { type: "string", enum: ["+Z", "-Z", "+X", "-X", "+Y", "-Y"] },
              description:
                "Setup directions to test reach from. Overrides the ones the " +
                "process implies — pass the faces the part can actually be " +
                "clamped on.",
            },
            stock: {
              type: "string",
              description:
                "Object to use as the stock the part is cut out of. Omit for " +
                "the part's bounding box plus a margin.",
            },
            stockMargin: {
              type: "number",
              description:
                "Machining allowance on the bounding-box stock, mm. Default 0 " +
                "— the material to remove is what a rectangular billet has and " +
                "the part does not. An allowance on the underside is cut in " +
                "its own setup, so charging it to the first one reports it as " +
                "unreachable; pass one only when the billet is the question.",
            },
            checks: {
              type: "array",
              items: {
                type: "string",
                enum: ["corners", "reach", "residual", "voids", "holes"],
              },
              description:
                "Run a subset. The residual is the expensive one and the " +
                "conclusive one; dropping it makes the verdict weaker, and " +
                "the reply says so.",
            },
            timeoutMs: { type: "number", description: "Default 300000." },
          },
        },
      },
      {
        name: "freecad_cam",
        description:
          "Run the real CAM workbench on the design: build a machining Job " +
          "with stock on a solid, add operations to it, recompute, and read " +
          "the toolpaths that came out.\n\nThis is the proof freecad_dfm " +
          "cannot give. freecad_dfm reasons about the shape; this asks the " +
          "workbench to actually generate the cuts. An operation that " +
          "generates ZERO path commands recomputes clean, reports no error " +
          "and looks like nothing on screen — and it means the workbench " +
          "could not machine that feature with that tool. Read " +
          "`emptyOperations` and `machinable` over the state flags and over " +
          "any render.\n\nWrites a Job into the user's tree, inside the " +
          "transaction envelope, so one Ctrl+Z takes it back out. Slow: " +
          "toolpath generation runs in the geometry kernel, which no deadline " +
          "can preempt, and the human watches their window not respond for " +
          "the duration. Say so before starting a long one. The CAM API's " +
          "spelling moves between builds — check " +
          "freecad_call({fn:'capabilities'}) first, and the reply reports the " +
          "spelling it found under `api`.",
        displayMessage:
          "\u{1F6E0}\ufe0f FreeCAD CAM \u00b7 {{mode|default:job}}" +
          "{{#op}} \u00b7 {{op}}{{/op}}" +
          "{{#id}} \u2192 {{id}}{{/id}}",
        tier: "mutating",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["job", "op", "verify", "post", "clear"],
              description:
                "job creates the Job and its stock on `target`; op adds one " +
                "operation to `job`; verify recomputes and reads every " +
                "operation's path; post writes G-code into the export " +
                "directory; clear deletes the job. Default job.",
            },
            target: {
              type: "string",
              description: "The solid to machine. Required for mode 'job'.",
            },
            job: {
              type: "string",
              description:
                "The Job to act on, by the id mode 'job' registered. Required " +
                "for op, verify, post and clear.",
            },
            op: {
              type: "string",
              enum: ["profile", "pocket", "drilling", "adaptive", "face", "helix"],
              description: "Which operation to add. Default profile.",
            },
            base: {
              type: "array",
              items: { type: "string" },
              description:
                "Geometry the operation works on: ref ids from a user pick or " +
                "'object:Face3' pairs from query. Same rule as fillet — do " +
                "not author an index yourself. Omit to let the operation take " +
                "the whole model.",
            },
            toolDiameter: {
              type: "number",
              description:
                "Diameter in mm to set on the job's existing tool " +
                "controller. Nothing here CREATES a tool: a job with no " +
                "controller is refused rather than given an invented one, " +
                "because every feed, radius and cycle time after a default " +
                "tool is a number about a tool nobody chose.",
            },
            props: {
              type: "object",
              description:
                "Properties to set on the operation (StepOver, FinalDepth, " +
                "ClearanceHeight, ...). Spelled as this build spells them; a " +
                "name the operation does not have is refused rather than " +
                "silently dropped.",
            },
            id: {
              type: "string",
              description:
                "Handle for the Job or operation this creates, e.g. " +
                "'cam.plate'. Required for mode job and op.",
            },
            name: { type: "string", description: "Undo entry label." },
            savePath: {
              type: "string",
              description:
                "For mode 'post': a bare filename or a path inside the export " +
                "directory, ending .nc, .gcode, .ngc or .tap.",
            },
            dryRun: {
              type: "boolean",
              description:
                "Apply, measure, roll back. Useful for asking whether the " +
                "toolpaths generate at all without leaving a Job in the tree.",
            },
            detail: { type: "string", enum: ["delta", "full"] },
            timeoutMs: { type: "number", description: "Default 600000." },
          },
        },
      },
      {
        name: "freecad_fem",
        description:
          "Does it SURVIVE the load? A linear static structural solve " +
          "(CalculiX), through the same envelope as every other write.\n\n" +
          "freecad_dfm and freecad_cam answer whether the shape can be made. " +
          "This is the other question nobody can answer by looking, and the " +
          "one a language model is most likely to answer with a confident " +
          "sentence instead of a number. It refuses to produce a number it " +
          "cannot stand behind: a model with no restraint, no load or no " +
          "volume elements is rejected BEFORE the solver runs, because each " +
          "of those solves cleanly and returns something that looks like an " +
          "answer.\n\nRead `solved`, `factorOfSafety` and " +
          "`singularitySuspect` together. A peak stress on a sharp internal " +
          "corner is a SINGULARITY — it rises without bound as the mesh " +
          "refines — so when that is flagged no single factor of safety is " +
          "reported and the p99 field stress is what to quote. `converged` " +
          "is null until mode 'converge' has solved it twice: an unfinished " +
          "check, never a pass.\n\nLinear static only: no contact, no " +
          "plasticity, no buckling, no fatigue, no dynamics, no thermal. " +
          "Needs gmsh and CalculiX, which are separate PROGRAMS a FreeCAD " +
          "install often does not carry — the reply reports both under " +
          "`binaries`. Slow, single threaded, and it freezes the human's " +
          "window for the duration: say so before starting one.",
        displayMessage:
          "\u{1F9EE} FreeCAD FEM \u00b7 {{mode|default:study}}" +
          "{{#kind}} \u00b7 {{kind}}{{/kind}}" +
          "{{#id}} \u2192 {{id}}{{/id}}",
        tier: "mutating",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["materials", "study", "constrain", "mesh", "solve",
                     "converge", "result", "clear"],
              description:
                "materials returns the elastic table and writes nothing; " +
                "study creates the Analysis, solver and material on `target`; " +
                "constrain adds one restraint or load; mesh generates the " +
                "mesh; solve runs CalculiX and reads the field; converge " +
                "re-meshes finer, re-solves and reports whether the answer " +
                "moved; result re-reads the last solve without re-running it; " +
                "clear deletes the analysis. Default study.",
            },
            target: {
              type: "string",
              description: "The solid to analyse. Required for mode 'study'.",
            },
            analysis: {
              type: "string",
              description:
                "The analysis to act on, by the id mode 'study' registered. " +
                "Required for every mode after it.",
            },
            kind: {
              type: "string",
              enum: ["fixed", "force", "pressure", "displacement"],
              description:
                "For mode 'constrain'. A solve needs at least one restraint " +
                "(fixed or displacement) AND at least one load (force or " +
                "pressure); it is refused without both.",
            },
            refs: {
              type: "array",
              items: { type: "string" },
              description:
                "Faces the constraint acts on: ref ids from a user pick or " +
                "'object:Face3' pairs from query. Same rule as fillet — do " +
                "not author an index yourself. A load on a renumbered face " +
                "solves perfectly cleanly and is wrong.",
            },
            magnitude: {
              type: "number",
              description:
                "Newtons for kind 'force' (the TOTAL force spread over the " +
                "referenced faces), MPa for kind 'pressure'. MPa is N/mm2: " +
                "1 bar is 0.1, 1 psi is 0.0068948. Convert with fn 'param', " +
                "not in your head.",
            },
            direction: {
              type: "string",
              description:
                "Optional ref giving the direction of a force. Omitted, the " +
                "force acts along the loaded face's normal — which is a " +
                "different load if that is not the direction you meant.",
            },
            reversed: {
              type: "boolean",
              description: "Flip the force or pressure onto the other side.",
            },
            values: {
              type: "object",
              description:
                "For kind 'displacement': {x, y, z}, where a number is a " +
                "prescribed displacement in mm, 'fix' is held at zero, and " +
                "an axis left out is free. This is how a symmetry plane is " +
                "written.",
            },
            material: {
              type: "string",
              description:
                "Name from the elastic table ('aluminium-6061', " +
                "'steel-1018'), which is the same table fn 'material' uses " +
                "for density. Anything not in it needs E and nu explicitly: " +
                "every stress and displacement scales with them, so nothing " +
                "here defaults them.",
            },
            E: { type: "number", description: "Young's modulus, MPa." },
            nu: { type: "number", description: "Poisson's ratio, 0 to 0.5." },
            density: { type: "number", description: "g/cm3." },
            elementSize: {
              type: "number",
              description:
                "Characteristic element length in mm for mode 'mesh'. Omit " +
                "for gmsh's own default, which is usually too coarse to " +
                "resolve a fillet.",
            },
            factor: {
              type: "number",
              description:
                "For mode 'converge': how much finer the second mesh is, " +
                "0.2 to 1.0. Default 0.6. Halving the size is roughly eight " +
                "times the elements and the solve time goes with it.",
            },
            id: {
              type: "string",
              description:
                "Handle for what this creates, e.g. 'fea.bracket' or " +
                "'bc.mount_fixed'. Required for mode study and constrain.",
            },
            name: { type: "string", description: "Undo entry label." },
            dryRun: {
              type: "boolean",
              description:
                "Apply, measure, roll back. Useful for asking whether the " +
                "model even solves without leaving an Analysis in the tree.",
            },
            detail: { type: "string", enum: ["delta", "full"] },
            timeoutMs: {
              type: "number",
              description: "Default 1800000 for solve and converge.",
            },
          },
        },
      },
      {
        name: "freecad_export",
        description:
          "Write the document out to the user's filesystem: FCStd " +
          "(everything, reopenable), STEP (geometry for a manufacturer or " +
          "another CAD), BREP or STL. Returns the path it wrote, and a url " +
          "for pulling a copy into the browser. This is a handover and a " +
          "checkpoint, not the user's only copy — their File > Save is real " +
          "here — but it is still worth offering before a risky edit.",
        displayMessage:
          "\u{1F4BE} Exporting the FreeCAD document as " +
          "{{format|default:FCStd}}",
        tier: "mutating",
        inputSchema: {
          type: "object",
          properties: {
            format: {
              type: "string",
              enum: ["FCStd", "STEP", "BREP", "STL"],
              description: "FCStd keeps the feature tree; STEP is solids only.",
            },
            targets: {
              type: "array",
              items: { type: "string" },
              description:
                "Objects to export, for the geometry formats. Omit for all parts.",
            },
            timeoutMs: { type: "number", description: "Default 180000." },
          },
        },
      },
      {
        name: "freecad_resolve",
        description:
          "Check whether stored references to faces and edges still point at " +
          "what they pointed at. Call with no arguments to re-validate every " +
          "pick the user has made — do this whenever geometry changed, " +
          "because a recompute renumbers faces and Face6 is an index, not a " +
          "name.\n\nA reference comes back as: stored (the name still means " +
          "the same element), rederived (the name moved and it was found " +
          "again from what generated it — re-capture it), ambiguous or broken " +
          "(ask the user to pick it again; do not guess). Read-only.",
        displayMessage:
          "\u{1F9ED} Re-validating FreeCAD references" +
          "{{#selection}} and the user's selection{{/selection}}",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            ids: {
              type: "array",
              items: { type: "string" },
              description: "Stored reference ids to check. Omit to check all.",
            },
            refs: {
              type: "array",
              items: { type: "string" },
              description:
                "Fingerprint these instead, e.g. 'Pad:Face3'. Use to inspect " +
                "a reference before committing to it.",
            },
            selection: {
              type: "boolean",
              description:
                "Report what the user currently has selected in the GUI — " +
                "the only reference source that is not AI-authored.",
            },
            timeoutMs: { type: "number", description: "Default 120000." },
          },
        },
      },
      {
        name: "freecad_call",
        description:
          "The structured edit channel: dispatch one whitelisted koi_cad " +
          "call. Write calls run inside the transaction envelope (GUI gate, " +
          "seal, run, recompute, abort on a newly introduced error) and " +
          "return the diff, the lint and the undo cost; read calls do not " +
          "open a transaction at all. Every call that creates an object " +
          "needs an `id`, which is how a later turn edits that object " +
          "instead of rebuilding it. Prefer feature_edit over creating a " +
          "replacement.\n\nCalls:\n" + opCatalog(),
        // fn IS the operation as far as the human is concerned. Punctuated
        // as a LABEL rather than a sentence, because a whitelist of forty is
        // never going to be forty verbs: "FreeCAD pad" reads as English,
        // "FreeCAD bom" does not, and "FreeCAD - bom" reads as the name of
        // the step either way. The id is what the next turn will name, so
        // showing it is also how the human learns the handle; `name` is the
        // escape hatch for a step whose fn does not say enough on its own.
        displayMessage:
          "\u{1F4D0} FreeCAD \u00b7 {{fn}}" +
          "{{#id}} \u2192 {{id}}{{/id}}" +
          "{{#name}} \u00b7 {{name}}{{/name}}" +
          "{{#dryRun}} \u00b7 dry run{{/dryRun}}",
        tier: "mutating",
        inputSchema: {
          type: "object",
          properties: {
            fn: {
              type: "string",
              enum: Object.keys(OP_SPECS),
              description: "Which whitelisted call to dispatch.",
            },
            args: {
              type: "object",
              description:
                "Arguments for that call. Validated here before anything " +
                "reaches the page, so a bad argument costs a rejection " +
                "rather than a transaction that opens and aborts.",
            },
            id: {
              type: "string",
              description:
                "Stable handle for the object this creates, e.g. 'sk.plate', " +
                "'pad.base', 'bolt.mount'. Required for creating calls. " +
                "Resolvable in later turns and stored in the document.",
            },
            name: {
              type: "string",
              description:
                "Undo entry label the user will see, and an extra phrase on " +
                "this step in their activity list. The fn is already shown, " +
                "so pass one only when it does not say enough on its own — " +
                "'batch' and 'lookup' say nothing about WHAT; 'pocket' and " +
                "'chamfer' say plenty.",
            },
            dryRun: {
              type: "boolean",
              description:
                "Apply, measure, then roll back. Use to show the blast " +
                "radius of a parametric change before committing to it.",
            },
            detail: {
              type: "string",
              enum: ["delta", "full"],
              description:
                "'delta' (default) returns the diff, the report and lint — " +
                "what the turn needs. 'full' adds the whole projection; ask " +
                "for it deliberately, it is the size of the document.",
            },
            timeoutMs: { type: "number", description: "Default 120000." },
          },
          required: ["fn"],
        },
      },
      {
        name: "freecad_script",
        description:
          "Free Python inside the same transaction envelope, for loops, " +
          "computation, generated profiles and bulk edits that the " +
          "whitelist does not cover. `doc`, `App`, `Gui` and `koi` (the " +
          "koi_cad module) are in scope; assign to `result` to return " +
          "something. A trace-hook deadline preempts a runaway Python loop, " +
          "but it cannot interrupt work inside the geometry kernel — so " +
          "every loop still carries its own bound. A snippet that overruns " +
          "holds the GUI thread until it returns: recoverable, but the user " +
          "is watching a frozen window while it does. Reach for freecad_call " +
          "first: it is validated, cheaper, and its ids survive the turn.",
        displayMessage:
          "\u{1F40D} FreeCAD script \u00b7 {{name|default:free Python}}" +
          "{{#dryRun}} \u00b7 dry run{{/dryRun}}",
        tier: "mutating",
        inputSchema: {
          type: "object",
          properties: {
            python: {
              type: "string",
              description:
                "Statements to run. Every loop must be bounded. Set `result` " +
                "to return a value.",
            },
            name: {
              type: "string",
              description:
                "Undo entry label the user will see, and the ONLY thing that " +
                "distinguishes this step from the last one in their activity " +
                "list -- a script has no fn to show in its place. Always " +
                "pass one, and say what it does to the model ('flute the " +
                "web', 'lay out the bolt circle'), not that it is Python.",
            },
            dryRun: { type: "boolean", description: "Apply, measure, then roll back." },
            deadlineSeconds: {
              type: "number",
              description:
                "Trace-hook deadline, default 10, max 120. A script that " +
                "runs past it raises rather than holding the GUI thread.",
            },
            detail: {
              type: "string",
              enum: ["delta", "full"],
              description:
                "'delta' (default) returns the diff, the report and lint — " +
                "what the turn needs. 'full' adds the whole projection; ask " +
                "for it deliberately, it is the size of the document.",
            },
            timeoutMs: { type: "number", description: "Transport budget. Defaults to the deadline plus 60 s." },
          },
          required: ["python"],
        },
      },
    ];
    if (probeExecEnabled()) {
      // Probe-stage only; see probeExecEnabled(). Pushed rather than declared
      // inline so the LLM's tool list simply does not contain them when off.
      tools.push(
        {
          name: "freecad_edit",
          description:
            "PROBE STAGE ONLY. Apply a Python edit inside the transaction " +
            "envelope. Superseded by freecad_call and freecad_script.",
          displayMessage:
            "\u{270F} Editing the FreeCAD document \u00b7 " +
            "{{name|default:Koi edit}}" +
            "{{#dryRun}} \u00b7 dry run{{/dryRun}}",
          tier: "mutating",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Undo entry label." },
              python: { type: "string", description: "Edit body. doc, App, Gui in scope." },
              dryRun: { type: "boolean", description: "Apply, measure, roll back." },
              timeoutMs: { type: "number", description: "Default 120000." },
            },
            required: ["python"],
          },
        },
        {
          name: "freecad_exec",
          description:
            "PROBE STAGE ONLY. Run a Python snippet outside the envelope and " +
            "return whatever it returns as JSON. The snippet is wrapped in a " +
            "function, so it must `return` a dict. This is how the probe " +
            "suites set up conditions the envelope is meant to handle; it is " +
            "not a workflow channel.",
          displayMessage: "🐍 FreeCAD probe exec",
          tier: "mutating",
          inputSchema: {
            type: "object",
            properties: {
              python: { type: "string", description: "Snippet body. Must end in a `return {...}`." },
              timeoutMs: { type: "number", description: "Default 20000." },
            },
            required: ["python"],
          },
        }
      );
    }
    return tools;
  },

  async callTool(name, args) {
    try {
      let result;
      switch (name) {
        case "freecad_config":
          result = await toolConfig(args);
          break;
        case "freecad_probe":
          result = await toolProbe(args);
          break;
        case "freecad_attach":
          result = await toolAttach(args);
          break;
        case "freecad_version":
          result = await toolVersion(args);
          break;
        case "freecad_export":
          result = await toolExport(args);
          break;
        case "freecad_render": {
          // The one tool whose payload is not text. Everything else in this
          // switch falls through to JSON.stringify below, and a PNG that goes
          // out that way is a wall of base64: invisible to the model, useless
          // to the human, and ~100k tokens for the pair of them.
          const shot = await toolRender(args);
          if (shot && shot.ok && shot.imageData) {
            const { imageData, ...meta } = shot;
            return {
              content: [
                { type: "image", data: imageData, mimeType: shot.mimeType || "image/png" },
                { type: "text", text: JSON.stringify(meta) },
              ],
            };
          }
          result = shot;
          break;
        }
        case "freecad_resolve":
          result = await toolResolve(args);
          break;
        case "freecad_measure":
          result = await toolMeasure(args);
          break;
        case "freecad_dfm":
          result = await toolDfm(args);
          break;
        case "freecad_cam":
          result = await toolCam(args);
          break;
        case "freecad_fem":
          result = await toolFem(args);
          break;
        case "freecad_call":
          result = await toolCall(args);
          break;
        case "freecad_script":
          result = await toolScript(args);
          break;
        case "freecad_exec":
          result = probeExecEnabled() ? await toolExec(args) : probeExecRefusal(name);
          break;
        case "freecad_get":
          result = await toolGet(args);
          break;
        case "freecad_sync":
          result = await toolSync(args);
          break;
        case "freecad_edit":
          result = probeExecEnabled() ? await toolEdit(args) : probeExecRefusal(name);
          break;
        default:
          return { isError: true, content: [{ type: "text", text: "Unknown tool: " + name }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      runtime.console.error("freecad_mcp error in " + name + ":", e.message);
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e.message }) }],
      };
    }
  },
};
