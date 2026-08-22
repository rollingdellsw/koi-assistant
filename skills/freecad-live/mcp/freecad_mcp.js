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
  try {
    res = await runtime.fetch(url, opts);
  } catch (e) {
    if (!payload) throw e;
    // The POST could not be issued at all. Same request, urlencoded, so a
    // failure after this is attributable to the bridge and not to the proxy.
    const q =
      "?payload=" + encodeURIComponent(JSON.stringify(payload)) +
      (state.bridgeToken ? "&token=" + encodeURIComponent(state.bridgeToken) : "");
    res = await runtime.fetch(url + q, { skipAuth: true, timeoutMs: opts.timeoutMs });
  }
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
async function execPython(body, timeoutMs) {
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
        "The bridge rejected the token. Set `bridge-token:` under the " +
          "freecad_bridge server in SKILL.md to the value koi_bridge.py printed " +
          "when it started, or pass it to freecad_config({bridgeToken})."
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
  return hello;
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
VERSION = "0.5.0"

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


def _resolve_body(doc, ref):
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
    raise KoiOpError(
        "several bodies (%s); pass body=<id>"
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
        if Gui.ActiveDocument is None:
            return False
        Gui.SendMsgToActiveView("ViewFit")
        return True
    except Exception:
        return False


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
    out["auto"] = _auto_view(doc)
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
    return out


def _op_body(doc, args, kid):
    b = doc.addObject(
        "PartDesign::Body", _safe_name(kid or args.get("label"), "Body"))
    if args.get("label"):
        b.Label = str(args["label"])
    register(doc, kid, b, args.get("turn"))
    return {"name": b.Name, "label": b.Label}


def _op_sketch(doc, args, kid):
    import Part
    import Sketcher
    from FreeCAD import Vector as V

    body = _resolve_body(doc, args.get("body"))
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
    on = args.get("on", "XY")
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

    C = Sketcher.Constraint
    made = []
    builders = {"rect": _sk_rect, "circle": _sk_circle, "slot": _sk_slot,
                "line": _sk_line, "arc": _sk_arc, "polyline": _sk_polyline,
                "bspline": _sk_bspline}
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
    body = _resolve_body(doc, args.get("body"))
    sk = _resolve_or_die(doc, _need(args, "sketch"), "sketch")
    # Before the feature exists, so a refusal leaves no half-built pad behind.
    profile = _profile_gate(sk, "pad")
    pad = body.newObject("PartDesign::Pad", _safe_name(kid, "Pad"))
    pad.Profile = sk
    dim = _set_dim(pad, "Length", args, "length")
    if args.get("reversed"):
        pad.Reversed = True
    if args.get("midplane"):
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
    body = _resolve_body(doc, args.get("body"))
    sk = _resolve_or_die(doc, _need(args, "sketch"), "sketch")
    profile = _profile_gate(sk, "cut")
    pk = body.newObject("PartDesign::Pocket", _safe_name(kid, "Pocket"))
    pk.Profile = sk
    dim = None
    if args.get("through"):
        pk.Type = "ThroughAll"
    else:
        dim = _set_dim(pk, "Length", args, "length")
    told = "reversed" in args
    if told:
        pk.Reversed = bool(args["reversed"])
    told_mid = "midplane" in args
    if told_mid:
        _set_if(pk, "Midplane", bool(args["midplane"]))
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


def _tip_owner(doc, o):
    """(body, tip) when this object is a feature inside a PartDesign Body."""
    tid = str(getattr(o, "TypeId", ""))
    if not tid.startswith("PartDesign::") or "Body" in tid:
        return None, None
    try:
        body = o.getParentGeoFeatureGroup()
    except Exception:
        body = None
    if body is None or "Body" not in str(getattr(body, "TypeId", "")):
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


def _op_view_set(doc, args, kid):
    # 'view' is the word half the callers reach for first, and refusing it
    # costs a turn to learn a synonym rather than to design anything.
    preset = str(args.get("preset") or args.get("view") or "iso").lower()
    fn = VIEW_PRESETS.get(preset)
    if fn is None:
        raise KoiOpError(
            "preset must be one of %s" % ", ".join(sorted(VIEW_PRESETS)))
    if Gui is None or Gui.ActiveDocument is None:
        return {"preset": preset, "applied": False,
                "error": "no GUI document to point"}
    view = getattr(Gui.ActiveDocument, "ActiveView", None)
    if view is None or not hasattr(view, fn):
        return {"preset": preset, "applied": False,
                "error": "this build's view has no %s" % fn}
    getattr(view, fn)()
    if args.get("fit", True):
        try:
            Gui.SendMsgToActiveView("ViewFit")
        except Exception:
            pass
    return {"preset": preset, "applied": True}


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
        if want_surface and want_surface not in str(inv.get("surface", "")).lower():
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
    out = {"of": owner.Name, "kind": kind, "total": len(items),
           "matched": matched, "returned": len(kept),
           "candidates": kept,
           # Ready to hand to fillet, chamfer or shell without rebuilding the
           # list by hand -- which is where a transcription error goes in.
           "refs": [r["ref"] for r in kept],
           "expected": want if want is not None else "one",
           "ambiguous": ambiguous}
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
    body = _resolve_body(doc, args.get("body"))
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

    told = "reversed" in args
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
    body = _resolve_body(doc, args.get("body"))
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


def _op_view_restore(doc, args, kid):
    raw = _meta(doc).get(ISOLATE_KEY)
    if not raw:
        return {"restored": [], "note": "nothing was isolated"}
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

    if fmt == "FCSTD":
        doc.saveAs(path)
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
    return {"path": path, "name": name, "format": fmt, "bytes": size,
            "objects": [o.Name for o in (objs if fmt != "FCSTD" else doc.Objects)][:64]}



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
    body = _resolve_body(doc, args.get("body"))
    base = args.get("base")
    if not base and not args.get("on"):
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
        owner, sub, mode = _origin_plane(body, args.get("on")), "", "FlatFace"

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


def _dress_query(doc, body, args, what):
    """Run a caller's edge FILTER and return (refs, the filter as stored).

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
    q.setdefault("kind", "edge")
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


def _dress_target(doc, body, args, what):
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
        refs, qspec = _dress_query(doc, body, args, what)
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
    body = _resolve_body(doc, args.get("body"))
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
    body = _resolve_body(doc, args.get("body"))
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
    body = _resolve_body(doc, args.get("body"))
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
    body = _resolve_body(doc, args.get("body"))
    sk = _resolve_or_die(doc, _need(args, "sketch"), "sketch")
    gr = body.newObject("PartDesign::Groove", _safe_name(kid, "Groove"))
    gr.Profile = sk
    gr.ReferenceAxis = _rev_axis(sk, args.get("axis"))
    dim = _set_dim(gr, "Angle", args, "angle", 360.0)
    told = "reversed" in args
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
    body = _resolve_body(doc, args.get("body"))
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
    body = _resolve_body(doc, args.get("body"))
    owner, subs, _q = _dress_target(doc, body, args, "shell")
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
    fab_total = 0.0
    for o in doc.Objects[:2000]:
        if o.TypeId != "PartDesign::Body":
            continue
        if component(_id_of(doc, o.Name) or "", doc):
            continue
        row = {"name": o.Name, "label": o.Label,
               "id": _id_of(doc, o.Name),
               "qty": inst.get(o.Name, 0) or 1,
               "role": "part", "volumeMm3": _vol(o)}
        if o.Name in sources:
            # The solid the halves were cut out of. Still needed to re-split,
            # never made, and the same material as both halves: listing it as
            # a third part is how a two-part assembly billed for three.
            row["role"] = "split-source"
            row["madeAs"] = "split into halves; not fabricated as one piece"
            omitted.append(o.Name)
        else:
            fab_total += (row["volumeMm3"] or 0.0) * (row["qty"] or 1)
        fabricated.append(row)

    out = {"purchased": purchased, "fabricated": fabricated,
           "fabricatedVolumeMm3": round(fab_total, 3),
           "totalMassG": round(total, 3) if purchased else 0.0}
    notes = []
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
    """(point, unit normal, name, offset, expression) for the cutting plane.

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
        return _scaled(n, offset), n, word, offset, offset_expr
    owner, _sub = _resolve_ref_sub(doc, plane)
    if owner is None:
        raise KoiOpError(
            "plane must be XY, XZ, YZ or the id of a datum plane, not %r"
            % (plane,))
    pl = _global_placement(owner)
    n = pl.Rotation.multVec(App.Vector(0, 0, 1))
    b = pl.Base
    return (App.Vector(b.x + n.x * offset, b.y + n.y * offset,
                       b.z + n.z * offset), n, owner.Name, offset, offset_expr)


def _half_space(shape, point, normal, sign, gap):
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

    The halves are snapshots. Nothing binds them to the solid they came from,
    so an upstream change means splitting again; that is said in the result
    rather than left to be discovered.
    """
    src = _resolve_or_die(doc, _need(args, "target"), "solid")
    shape = getattr(src, "Shape", None)
    if shape is None or shape.isNull() or shape.Volume <= 1e-9:
        raise KoiOpError("%s has no solid shape to split" % src.Name)
    point, normal, plane_name, offset, offset_expr = _split_plane(doc, args)
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
    carrying = [(o.Name, _split_half_work(o)) for o in prior]
    carrying = [(n, w) for n, w in carrying if w]
    forced = bool(args.get("force"))
    if carrying and not forced:
        raise KoiOpError(
            "this split has already been run and its halves carry work: %s. "
            "Re-splitting REPLACES them, and those features were built on the "
            "old shape -- they are not re-derived onto the new halves and "
            "nothing here can move them. Suppress or delete them first, or "
            "pass force:true to drop them along with the halves. If the "
            "halves are what you are still editing, edit the SOURCE and split "
            "last: a split is a snapshot, and everything downstream of one "
            "has to be rebuilt by hand."
            % "; ".join("%s (%s)" % (n, ", ".join(w[:6])) for n, w in carrying))
    replaced = []
    for o in prior:
        _remove_subtree(doc, o, replaced)
    if replaced:
        doc.recompute()

    v0 = round(shape.Volume, 6)
    pieces = []
    for sign, side in ((1.0, "a"), (-1.0, "b")):
        piece = shape.common(_half_space(shape, point, normal, sign, gap))
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
        pieces.append((side, piece))

    out = {"plane": plane_name, "gap": gap, "offset": offset,
           "source": src.Name, "normal": _vec3(normal),
           "sourceVolume": v0, "asBodies": True, "halves": [], "sides": {}}
    if offset_expr:
        out["offsetExpression"] = offset_expr
    if gap_expr:
        out["gapExpression"] = gap_expr
    total = 0.0
    for (side, piece), skid, lbl in zip(pieces, kids, labels):
        obj, is_body, why = _body_from_shape(doc, skid, piece, lbl)
        register(doc, skid, obj, args.get("turn"))
        v = _vol(obj)
        total += v or 0.0
        # "a" and "b" say nothing. Which half is which was guessed from
        # memory of the last session and there was no way to check it in the
        # reply, so the halves are also reported by the side of the plane
        # they are on, with the box that proves it.
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
        if forced and carrying:
            out["droppedWork"] = sorted(
                set(n for _, w in carrying for n in w))
    notes = ["ids[0] (%s) is the half on the POSITIVE side of the plane "
             "normal %s; ids[1] (%s) is the negative side -- read sides.* "
             "rather than assuming an order"
             % (kids[0], _vec3(normal), kids[1]),
             "these halves are snapshots of %s, not features of it: an "
             "upstream edit does not reach them and the split has to be "
             "made again -- so split LAST, and treat anything you build on a "
             "half as frozen" % src.Name]
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
CREATING_OPS = frozenset((
    "body", "sketch", "pad", "pocket", "hole", "bolt_sketch", "datum_plane",
    "fillet", "chamfer", "shell", "revolve", "groove", "mirror", "boolean",
    "primitive", "pattern", "polar_array", "link_array", "insert", "ref",
    "split_body", "fastener_pattern",
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


OPS = {
    "new_document": {"fn": _op_new_document, "mode": "document"},
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
    "isolate": {"fn": _op_isolate, "mode": "write"},
    "show": {"fn": _op_show, "mode": "write"},
    "view_restore": {"fn": _op_view_restore, "mode": "write"},
    "ids": {"fn": _op_ids, "mode": "read"},
    "revolve": {"fn": _op_revolve, "mode": "write"},
    "groove": {"fn": _op_groove, "mode": "write"},
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
    "bom": {"fn": _op_bom, "mode": "read"},
}

OP_NAMES = sorted(OPS)

# Reads that are about the TABLES rather than about the model. The fastener
# sizes, the catalog and the stock list are compiled into this module and are
# the same whether or not anything is open -- but every non-document op went
# through the same ActiveDocument gate, so attaching to a FreeCAD with no
# document made "what size is an M5 clearance hole" answer "No active
# document. Call new_document". That is the one question a session asks BEFORE
# it has decided what to build.
DOCLESS_OPS = frozenset(("lookup", "library"))


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
            if rehealed:
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
    if rehealed:
        res["rehealed"] = rehealed
        res["rehealedNote"] = (
            "%s errored after this edit and %s edges were re-resolved from "
            "the filter stored with them. The edit was NOT aborted. These may "
            "not be the same edges -- check the result before reporting it"
            % (", ".join(r["feature"] for r in rehealed),
               "its" if len(rehealed) == 1 else "their"))
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
    props: { body: "string", base: "string", on: "string", mode: "string",
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
    props: { label: "string" },
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
      "than computed polyline points that can never follow a parameter.",
    required: ["geometry"],
    props: {
      on: "string",
      mode: "string",
      offset: "number",
      body: "string",
      geometry: "array",
      constraints: "array",
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
      "(asBodies says), so features can still be added. The halves are " +
      "snapshots: an upstream edit does not reach them, and lint reports " +
      "split-stale on every turn after the source changes until it is re-run.",
    props: { target: "string", plane: "string", offset: "number|string",
             gap: "number|string", ids: "array", labels: "array",
             keep: "string" },
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
      "is driving the camera themselves, auto:true to put it back.",
    props: { auto: "boolean" },
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
const OP_ALIASES = { library: "lookup" };

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
    if (key === "turn") continue;
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

async function toolCall(args) {
  args = args || {};
  if (!state.attached) return { error: "Not attached. Call freecad_attach first." };

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
  if (!state.attached) return { error: "Not attached. Call freecad_attach first." };
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
  if (!state.attached) return { error: "Not attached. Call freecad_attach first." };
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
 * freecad_resolve — is that pick still the thing it was?
 *
 * Read-only and `safe`, so re-validating costs nothing and therefore actually
 * happens. Capture is the other direction and lives in freecad_call, because
 * capture writes to the document and hands back an id.
 */
async function toolResolve(args) {
  args = args || {};
  if (!state.attached) return { error: "Not attached. Call freecad_attach first." };
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
async function toolExport(args) {
  args = args || {};
  if (!state.attached) return { error: "Not attached. Call freecad_attach first." };

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
  d.url =
    cfg.bridgeUrl + "/file?path=" + encodeURIComponent(d.path) +
    (state.bridgeToken ? "&token=" + encodeURIComponent(state.bridgeToken) : "");
  d.note =
    "Written to the user's filesystem at " + d.path + ". It is a real file and " +
    "it stays there; open the url to pull a copy into the browser's downloads.";
  return d;
}

async function toolGet(args) {
  args = args || {};
  if (!state.attached) return { error: "Not attached. Call freecad_attach first." };
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
  if (!state.attached) return { error: "Not attached. Call freecad_attach first." };
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
  if (!state.attached) return { error: "Not attached. Call freecad_attach first." };
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
  if (!state.attached) {
    return {
      error: "Not attached. Call freecad_attach first — exec needs the bridge " +
        "and the interpreter, and attach is what proves both are up.",
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
        case "freecad_resolve":
          result = await toolResolve(args);
          break;
        case "freecad_measure":
          result = await toolMeasure(args);
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
