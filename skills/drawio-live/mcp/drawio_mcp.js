// ============================================================
// drawio_mcp.js — Local MCP server for drawio-live skill
//
// Runs inside sandbox-mcp.html.
//
// Architecture: the tab is navigated to HOST_URL, which acts purely as a
// host document. The bridge (MAIN world — see the note above BRIDGE_INSTALL;
// ISOLATED inherits the extension's MV3 CSP and cannot eval) wipes that
// document and
// installs a single full-bleed <iframe> pointing at CANVAS_URL — the real
// draw.io editor the user interacts with. draw.io embed mode only speaks
// to a genuine parent/opener window: on a top-level tab window.parent ===
// window, so its own postMessage never reaches a listener and the protocol
// is silently dead. The iframe supplies that parent.
//
// The canvas is a cache. The authoritative artifact is the .drawio text in
// state.lastAppliedXml (and whatever the user has saved to disk); the
// canvas can be destroyed and rebuilt from it at any time.
// ============================================================

// --- Constants -----------------------------------------------

// Which draw.io deployment this session talks to. Nothing below is hardcoded
// to diagrams.net any more: the public editor, a local
// `python3 -m http.server 7080` over the draw.io webapp, and a corporate
// self-host are the same case with a different origin. Resolution order,
// highest priority first:
//
//   1. drawio_config({ canvasUrl }) — set at runtime. scripts/run.js passes
//      the skill's `canvasUrl` parameter through to it before the tab opens.
//   2. `canvas-url:` on this server's block in SKILL.md, surfaced as
//      runtime.config. This is the place to pin a deployment for everyone.
//   3. DEFAULT_CANVAS_ORIGIN below.
//
// A bare origin is enough — the embed query is appended. A full URL that
// already carries `embed=1` is taken verbatim, so an unusual deployment can
// override the whole query string.
const DEFAULT_CANVAS_ORIGIN = "https://embed.diagrams.net/";

// `embed=1&proto=json` is the protocol the bridge speaks and is not optional;
// the rest is chrome. Kept as one string so every entry point builds the same
// URL from the same rule.
const CANVAS_QUERY =
  "embed=1&proto=json&spin=1&modified=0&libraries=1&ui=kennedy&noExitBtn=1";

// Hostnames ensureBridge will attach to in addition to the configured one.
// A deployment that wants a tighter list sets `canvas-hosts:` in SKILL.md,
// which replaces these rather than adding to them.
const BUILTIN_CANVAS_HOSTS = [
  "embed.diagrams.net",
  "viewer.diagrams.net",
  "localhost",
  "127.0.0.1",
];

const FRAME_ID = "koi-drawio-canvas";

const EMPTY_DIAGRAM =
  '<mxfile><diagram name="Page-1" id="page-1">' +
  "<mxGraphModel><root>" +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  "</root></mxGraphModel></diagram></mxfile>";

const HISTORY_MAX = 10;

// Layout doctrine, enforced in code rather than left to the model's arithmetic.
// SKILL.md states these numbers; opAddNode/align/distribute/grid_layout and the
// layout lint are the things that actually hold the diagram to them.
// Both of these are the *default*; `layout-timeout-ms` / `layout-settle-ms` on
// the drawio_bridge server in SKILL.md raise them for a slow deployment or a
// very large diagram, where 5s can expire while the morph is still running.
const LAYOUT_TIMEOUT = 5000; // ELK runs async with a morph animation
const LAYOUT_SETTLE = 600; // let the morph finish before reading coordinates

const GRID = 10; // snap unit
const DEFAULT_W = 160;
const DEFAULT_H = 60;
const MIN_GAP = 40; // minimum clear space between vertices
const CHAR_W = 7.2; // px per char at the default 12px font — width estimator
const LABEL_PAD = 20; // 10px each side
// 50ms means ~20 evaluateScript round trips per second while waiting on an
// event. That is deliberate: the events land in single-digit milliseconds and
// the old 300ms floor was most of the latency in every tool call.
const POLL_INTERVAL = 50; // ms
const POLL_TIMEOUT = 5000; // ms
// Page switching is driven by {action:"invokeAction", actionName:"nextPage"},
// which draw.io answers with no event at all — the pause is what lets the
// SelectPage change land before the next one is sent.
const PAGE_STEP_DELAY = 120; // ms
const LOAD_TIMEOUT = 20000; // ms — iframe boot + document load
const EXPORT_TIMEOUT = 15000; // ms — png render on large diagrams
const SVG_CHAR_LIMIT = 60000; // ~15k tokens; past this, look instead of read

// --- Module-scope state --------------------------------------

let state = {
  base: null, // canonical XML adopted at latest sync
  baseXml: null, // raw XML at latest sync
  lastApplied: null, // canonical XML AI last pushed
  lastAppliedXml: null, // raw XML AI last pushed
  syncedRev: -1, // bridge rev at latest sync
  history: [], // ring buffer of { turn, summary, appliedXml, ts }
  turnCount: 0,
  docName: "untitled",
  initialized: false,
  turnSynced: false, // armed by drawio_begin_turn at each user-message boundary
  canvasUrl: null, // resolved deployment URL (see DEFAULT_CANVAS_ORIGIN)
  hostUrl: null, // document that frames the canvas; same origin by default
  canvasHosts: null, // hostnames ensureBridge will attach to
  canvasSource: null, // "argument" | "skill-config" | "default"
  layoutEngine: null, // "elk" | "mx"; null = whatever SKILL.md configured
  activePage: null, // { index, id, name } — the page the USER is looking at
};

// --- Deployment configuration --------------------------------

function serverConfig() {
  // runtime.config is the frozen `mcp-servers` block from SKILL.md. Absent in
  // older hosts and in the guardrail's dry run, so never assume it exists.
  try {
    return (typeof runtime !== "undefined" && runtime.config) || {};
  } catch (_) {
    return {};
  }
}

// How a SKILL.md key reaches here is not contractually fixed. The frontmatter
// spells it `canvas-url`; a parser may camelCase it, snake_case it, or nest the
// non-standard keys under `config:`/`options:` rather than leaving them on the
// server entry. Rather than guess which, look in all of them — the cost is a
// few property reads and the alternative is a setting that silently does
// nothing, which is what `canvas-url` did before the host started forwarding
// author keys.
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

/**
 * What SKILL.md actually handed this server, for diagnostics.
 * A configuration key that is read but never arrives is indistinguishable from
 * one that arrives and is ignored — both look like "the setting does nothing".
 */
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

/**
 * Turn whatever the user configured into a loadable embed URL.
 * Accepts "http://localhost:7080", "https://drawio.corp.example.com/",
 * or a complete "...?embed=1&proto=json&..." URL.
 */
function buildCanvasUrl(origin) {
  const base = String(origin == null ? "" : origin).trim() || DEFAULT_CANVAS_ORIGIN;
  let u;
  try {
    u = new URL(base);
  } catch (_) {
    throw new Error(
      "Invalid draw.io URL: " + base + ". Pass an absolute URL, e.g. " +
        "http://localhost:7080 or https://embed.diagrams.net/"
    );
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("draw.io URL must be http(s): " + base);
  }
  // Already an embed URL — the caller knows what they want, leave the query be.
  if (u.searchParams.get("embed") === "1") return u.href;
  const existing = u.search.replace(/^\?/, "");
  u.search = existing ? existing + "&" + CANVAS_QUERY : CANVAS_QUERY;
  return u.href;
}

/**
 * Host document URL — scaffolding the bridge wipes and frames the canvas into.
 *
 * MUST NOT carry the embed protocol (`embed=1&proto=json`). That protocol is
 * for the iframe only. Loading it as a top-level tab has two failure modes:
 *   1. draw.io's embed handshake has no parent (`window.parent === window`), so
 *      the postMessage protocol is silently dead (the reason the iframe exists).
 *   2. On a script-opened tab (`chrome.tabs.create` / `window.open`), draw.io
 *      can `window.close()` itself when the handshake has no parent. Browsers
 *      permit that for script-opened tabs, so the tab vanishes immediately —
 *      which is exactly the "canvas is open but tools point at unknown" failure
 *      `scripts/run.js` was observing (newPage returned a pageId that was gone
 *      by the next listPages).
 */
function buildHostUrl(origin) {
  const base = String(origin == null ? "" : origin).trim() || DEFAULT_CANVAS_ORIGIN;
  let u;
  try {
    u = new URL(base);
  } catch (_) {
    throw new Error(
      "Invalid draw.io host URL: " + base + ". Pass an absolute URL, e.g. " +
        "http://localhost:7080 or https://embed.diagrams.net/"
    );
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("draw.io host URL must be http(s): " + base);
  }
  // Origin + path only. Drop any embed/query the caller may have pasted in —
  // host-url is scaffolding, not the editor surface.
  const path = u.pathname && u.pathname !== "" ? u.pathname : "/";
  return u.origin + path;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return "";
  }
}

function toHostList(value) {
  if (!value) return null;
  const arr = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
  const out = arr.map((h) => String(h).trim()).filter(Boolean).map((h) => hostOf(h) || h);
  return out.length ? out : null;
}

/** Resolve (once) and return the deployment this session is bound to. */
function canvasConfig() {
  if (!state.canvasUrl) setCanvasConfig({});
  return {
    canvasUrl: state.canvasUrl,
    hostUrl: state.hostUrl,
    hosts: state.canvasHosts,
  };
}

function setCanvasConfig(args) {
  const cfg = serverConfig();
  const fromSkill = configValue(cfg, "canvasUrl");
  const url = args.canvasUrl || fromSkill;
  const canvasUrl = buildCanvasUrl(url);
  state.canvasSource = args.canvasUrl
    ? "argument"
    : fromSkill
      ? "skill-config"
      : "default";
  const hostSrc = args.hostUrl || configValue(cfg, "hostUrl") || url;
  const hosts =
    toHostList(args.hosts) ||
    toHostList(configValue(cfg, "canvasHosts")) ||
    BUILTIN_CANVAS_HOSTS;

  state.canvasUrl = canvasUrl;
  // The host document only has to be scriptable and permit framing the canvas.
  // Every draw.io deployment frames itself, so same-origin is the default and
  // the skill stays self-contained. NEVER put the embed query on the host —
  // see buildHostUrl. Falling back through canvasUrl used to re-introduce
  // ?proto=json and the tab self-closed on open.
  state.hostUrl = buildHostUrl(hostSrc || canvasUrl);
  state.canvasHosts = [hostOf(canvasUrl), hostOf(state.hostUrl)]
    .concat(hosts)
    .filter(Boolean)
    .filter((h, i, a) => a.indexOf(h) === i);

  return canvasConfig();
}

/**
 * Numeric knob with a config override. Self-hosted instances on slow hardware,
 * and mxGraph's morph animations, need more settle time than the public editor;
 * rather than raise every default for everyone, expose the dial.
 */
function tuning(name, fallback) {
  const v = configValue(serverConfig(), name);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// --- Bridge scripts (ISOLATED world) -------------------------
// Each is a function-expression string called with (document, __ctx, args).
//
// These run in the MAIN world. ISOLATED is NOT an option: runtime.evaluate-
// Script compiles the snippet with `new Function` on whichever side it runs,
// and in the isolated world that inherits the extension's own MV3 CSP, which
// forbids 'unsafe-eval' unconditionally — every call fails. The MAIN world is
// governed by the page's CSP instead, and embed.diagrams.net permits eval.
// The snippets only touch DOM and postMessage, so MAIN costs nothing here.

const BRIDGE_INSTALL = `(document, __ctx, args) => {
  var FRAME_ID = args.frameId;

  function bind(b, frame) {
    b.frame = frame;
    window.addEventListener("message", function(e) {
      if (!b.frame || !b.frame.contentWindow) return;
      if (e.source !== b.frame.contentWindow) return;
      var msg;
      if (typeof e.data === "string") {
        try { msg = JSON.parse(e.data); } catch (_) { return; }
      } else if (e.data && typeof e.data === "object") {
        msg = e.data;
      } else { return; }
      if (!msg || (typeof msg.event !== "string" && !msg.error)) return;

      b.lastEvent = msg;
      // Append-only log with a monotonic index. A one-shot "waiting" slot
      // cannot be used here: draw.io answers fast enough that the response
      // routinely lands before the caller has armed the slot, and the event
      // is then lost forever. Readers record an index and scan forward.
      b.evtSeq++;
      b.log.push({ idx: b.evtSeq, msg: msg, ts: Date.now() });
      if (b.log.length > 60) b.log.shift();

      if (msg.event === "init") b.ready = true;
      if (msg.event === "autosave" || msg.event === "save") b.rev++;
      if (msg.xml) b.liveXml = msg.xml;
    });
  }

  var b = window.__koiDrawio;

  // Fast path: bridge and iframe both alive.
  if (b && b.installed && b.frame && b.frame.isConnected) {
    return { alreadyInstalled: true, ready: b.ready, rev: b.rev };
  }

  // Recovery path: the iframe survived but the isolated-world globals did
  // not (world torn down between calls). Re-bind rather than reload — the
  // user's in-editor state is preserved.
  var existing = document.getElementById(FRAME_ID);
  if (existing && (!b || !b.installed)) {
    b = window.__koiDrawio = {
      installed: true, ready: true, rev: 0, liveXml: null, lastEvent: null,
      evtSeq: 0, log: [], frame: null
    };
    bind(b, existing);
    return { installed: true, rebound: true, ready: true };
  }

  b = window.__koiDrawio = {
    installed: true, ready: false, rev: 0, liveXml: null, lastEvent: null,
    evtSeq: 0, log: [], frame: null
  };

  // The host document is scaffolding only — replace it entirely.
  document.body.innerHTML = "";
  document.body.style.margin = "0";
  document.body.style.padding = "0";
  document.body.style.overflow = "hidden";
  document.documentElement.style.overflow = "hidden";

  var f = document.createElement("iframe");
  f.id = FRAME_ID;
  f.setAttribute("frameborder", "0");
  f.setAttribute("allow", "clipboard-read; clipboard-write");
  f.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;" +
    "border:0;margin:0;padding:0;z-index:2147483647;background:#fff;";
  document.body.appendChild(f);
  bind(b, f);
  f.src = args.url;

  return { installed: true, ready: false };
}`;

const BRIDGE_STATUS = `(document, __ctx, args) => {
  var b = window.__koiDrawio;
  if (!b) return { installed: false, framed: !!document.getElementById(args.frameId) };
  return {
    installed: true,
    ready: b.ready,
    rev: b.rev,
    hasXml: !!b.liveXml,
    framed: !!(b.frame && b.frame.isConnected),
    evtSeq: b.evtSeq,
    recent: b.log.slice(-12).map(function(e) {
      return { idx: e.idx, event: e.msg.event || ("error:" + e.msg.error), ts: e.ts };
    })
  };
}`;

// Post an action to the editor, returning the log index at the moment of
// sending. Every embed action has a matching response; nothing is ever
// fire-and-forget, so a dropped message surfaces as a timeout instead of
// being mistaken for success.
const BRIDGE_SEND = `(document, __ctx, args) => {
  var b = window.__koiDrawio;
  if (!b || !b.frame || !b.frame.contentWindow) return { error: "bridge not installed" };
  var since = b.evtSeq;
  b.frame.contentWindow.postMessage(JSON.stringify(args.msg), "*");
  return { since: since };
}`;

// Scan the log forward from \`since\` for the first matching response.
// \`since\` is captured before the postMessage, so a response that arrives
// during the same tick is still found.
const BRIDGE_POLL = `(document, __ctx, args) => {
  var b = window.__koiDrawio;
  if (!b) return { error: "bridge not installed" };
  var floor = args.since;
  if (args.anywhere) floor = -1;
  for (var i = 0; i < b.log.length; i++) {
    var e = b.log[i];
    if (e.idx <= floor) continue;
    var m = e.msg;
    if (m.error && !m.event) return { response: m };
    if (m.event !== args.expect) continue;
    if (args.format && m.format !== args.format) {
      // Fallback: if we asked for XML and the event carries an XML payload,
      // take it even though the deployment omitted the format property. Some
      // draw.io builds answer an export with the payload but no echo of the
      // format, and skipping those events strands every pull until timeout.
      var isXmlFallback = args.format === "xml" &&
        (m.xml || (typeof m.data === "string" && m.data.trim().charAt(0) === "<"));
      if (!isXmlFallback) {
        // Not an error — draw.io emits export events for other formats too. It
        // is logged because a silent skip here looks exactly like a dead
        // protocol channel from the MCP side, which cost a long debugging
        // session once.
        console.log(
          "[koi-drawio] skipping " + m.event + " event: expected format " +
            args.format + ", got " + m.format
        );
        continue;
      }
    }
    return { response: m };
  }
  return { pending: true };
}`;

const BRIDGE_READ_XML = `(document, __ctx, args) => {
  var b = window.__koiDrawio;
  if (!b) return { error: "bridge not installed" };
  return { xml: b.liveXml, rev: b.rev };
}`;

const BRIDGE_PAGE_CHECK = `(document, __ctx, args) => {
  return { hostname: window.location.hostname, href: window.location.href };
}`;

// --- Bridge communication helpers ----------------------------

async function ensureBridge(opts) {
  opts = opts || {};
  // Confirm we are on the host tab at all.
  let check;
  try {
    check = await evalBridge(BRIDGE_PAGE_CHECK, {});
  } catch (e) {
    throw new Error(
      "evaluateScript failed — the draw.io host tab may not be active. " +
        "Call selectPage with the canvas tabId first. Error: " + e.message
    );
  }

  if (!check || typeof check.hostname !== "string") {
    throw new Error(
      "evaluateScript returned unexpected result (tab might not be active or page not loaded). " +
        "Got: " + JSON.stringify(check)
    );
  }

  const deployment = canvasConfig();
  if (deployment.hosts.indexOf(check.hostname) === -1) {
    throw new Error(
      "Not on the draw.io host tab. " +
        "Call selectPage with the canvas tabId, or run the drawio-live skill " +
        "from the Skills panel to (re)open it. " +
        "Current page: " + (check.href || "unknown") + ". " +
        "Accepted hosts: " + deployment.hosts.join(", ") + ". " +
        "If this session should talk to a different draw.io deployment, set it " +
        "with drawio_config({canvasUrl}) or `canvas-url:` in SKILL.md."
    );
  }

  // Already live?
  const st = await evalBridge(BRIDGE_STATUS, { frameId: FRAME_ID });
  if (st && st.installed && st.framed) return st;

  // Build (or rebuild) the canvas.
  const res = await evalBridge(BRIDGE_INSTALL, {
    url: deployment.canvasUrl,
    frameId: FRAME_ID,
  });
  if (!res) throw new Error("Failed to inject bridge");
  if (res.alreadyInstalled || res.rebound) return res;

  await waitForReady(LOAD_TIMEOUT);

  // A freshly built iframe holds no document. The canvas is a cache, so
  // restore it from the authoritative text we still hold. Skipped for
  // toolInit, which is about to push its own document — two `load` actions
  // back to back yield only one `load` event.
  if (state.lastAppliedXml && !opts.skipRestore) {
    await bridgePushLoad(state.lastAppliedXml);
    return { installed: true, ready: true, status: "recovered" };
  }

  return res;
}

async function evalBridge(script, args) {
  let res;
  try {
    // MAIN, not ISOLATED — see the note on BRIDGE_INSTALL above.
    res = await runtime.evaluateScript(script, args || {}, "MAIN");
  } catch (e) {
    throw new Error("evaluateScript call failed: " + e.message);
  }
  // runtime.evaluateScript resolves (not rejects) with { result, error } when
  // the handler returns an error.  Detect both shapes:
  //   - { result: <value> }          ← success
  //   - { result: undefined, error } ← handler-level error (isError path)
  //   - direct value                 ← some code paths return unwrapped
  if (res && typeof res === "object") {
    if (typeof res.error === "string") {
      throw new Error("evaluateScript error: " + res.error);
    }
    if ("result" in res) return res.result;
  }
  return res;
}

/**
 * Send an action and block until draw.io answers with its response event.
 * This is the single choke point that makes a dead protocol channel
 * observable: no action is ever assumed to have landed.
 */
async function sendAndWait(msg, expect, opts) {
  opts = opts || {};
  const req = await evalBridge(BRIDGE_SEND, { msg });
  if (!req || req.error) {
    throw new Error("bridge send failed: " + ((req && req.error) || "no bridge"));
  }

  const query = {
    since: req.since,
    expect,
    format: opts.format || null,
    anywhere: false,
  };

  const deadline = Date.now() + (opts.timeout || POLL_TIMEOUT);
  while (Date.now() < deadline) {
    const poll = await evalBridge(BRIDGE_POLL, query);
    if (poll && poll.response) {
      const r = poll.response;
      if (r.error && !r.event) {
        throw new Error(
          "draw.io rejected action '" + msg.action + "': " + r.error
        );
      }
      return r;
    }
    if (poll && poll.error) throw new Error(poll.error);
    await sleep(POLL_INTERVAL);
  }

  // Last resort: draw.io coalesces repeated actions (a second `load` for an
  // already-open document produces no second event), so accept a matching
  // response from anywhere in the log rather than failing a push that in
  // fact landed. The caller still verifies against the canvas.
  const late = await evalBridge(BRIDGE_POLL, { ...query, anywhere: true });
  if (late && late.response && !(late.response.error && !late.response.event)) {
    runtime.console.warn(
      "action '" + msg.action + "': no fresh '" + expect +
        "' event; accepting an earlier one (coalesced response)"
    );
    return late.response;
  }

  const st = await bridgeStatus().catch(() => null);
  throw new Error(
    "Timed out waiting for '" + expect + "' after action '" + msg.action +
      "'. Bridge status: " + JSON.stringify(st)
  );
}

async function bridgeStatus() {
  return evalBridge(BRIDGE_STATUS, { frameId: FRAME_ID });
}

async function waitForReady(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || POLL_TIMEOUT);
  while (Date.now() < deadline) {
    const st = await bridgeStatus();
    if (st && st.ready) return st;
    await sleep(POLL_INTERVAL);
  }
  throw new Error("draw.io embed did not send 'init' within timeout");
}

async function bridgePullXml() {
  // Active pull: ask the canvas what it actually holds. Never trust cached
  // autosave XML as the sole source.
  //
  // `uncompressed: true` asks for readable <mxGraphModel> instead of the
  // deflate+base64 payload draw.io writes by default. Deployments honour it
  // inconsistently — some builds ignore it entirely — so the result still goes
  // through inflateDiagrams(), which is a no-op on already-plain XML.
  const r = await sendAndWait(
    { action: "export", format: "xml", uncompressed: true },
    "export",
    { format: "xml" }
  );
  const st = await bridgeStatus();
  const xml = await inflateDiagrams(r.xml || r.data);
  // Every export event is built by draw.io's createLoadMessage, which carries
  // `currentPage` — the index of the page the user is actually looking at.
  // It is the only read of the visible page the protocol offers, and it comes
  // free with a pull we were making anyway. Older builds omit it; null then.
  const currentPage = typeof r.currentPage === "number" ? r.currentPage : null;
  if (currentPage !== null) noteActivePage(xml, currentPage);
  return { xml, rev: st ? st.rev : -1, currentPage };
}

// --- Pages ---------------------------------------------------
//
// A .drawio file is a list of <diagram> elements; draw.io shows one of them at
// a time and the user picks which with the tabs at the bottom. Two separate
// things follow, and conflating them is what made multi-page editing not work:
//
//   THE DOCUMENT — which pages exist, in what order, under what names. Pure
//   XML, so it is edited by ops (add_page, rename_page, ...) and travels
//   through the same push/verify/history pipeline as any other edit.
//
//   THE VIEW — which page is on screen. Not in the document at all. It is read
//   from the export event's `currentPage` and changed with drawio_pages
//   ({select}), which steps the editor's own nextPage/previousPage actions.
//
// Ops target a page independently of the view: `drawio_ops({page})`, or
// `page` on an individual op. The default is the page the user is looking at,
// which is what "add a box" means when they are staring at page 3.

function pagesOfDoc(doc) {
  const out = [];
  const diagrams = doc.querySelectorAll("diagram");
  for (let i = 0; i < diagrams.length; i++) {
    const d = diagrams[i];
    let cells = 0;
    d.querySelectorAll("mxCell").forEach((c) => {
      const id = c.getAttribute("id");
      if (id !== "0" && id !== "1") cells++;
    });
    out.push({
      index: i,
      id: d.getAttribute("id") || String(i),
      name: d.getAttribute("name") || "",
      cells,
    });
  }
  return out;
}

function pagesOf(xmlStr) {
  try {
    return pagesOfDoc(parseXml(xmlStr));
  } catch (_) {
    return [];
  }
}

function noteActivePage(xmlStr, index) {
  const pages = pagesOf(xmlStr);
  state.activePage = pages[index] || null;
}

/**
 * Resolve a page reference to an index. Accepts an index (number or numeric
 * string), a page id, a page name, or "active".
 *
 * Throws with the full page list rather than a bare "not found": the model
 * usually guessed a name, and one message containing the real names is the
 * difference between a fix this turn and a fix three turns from now.
 */
function resolvePage(pages, ref) {
  if (!pages.length) throw new Error("The document has no pages.");
  if (ref === undefined || ref === null || ref === "") return 0;

  const known = () =>
    " Pages: " +
    pages.map((p) => "[" + p.index + "] " + (p.name || "(unnamed)") + " id=" + p.id).join(", ");

  if (typeof ref === "number") {
    if (!Number.isInteger(ref) || ref < 0 || ref >= pages.length) {
      throw new Error("No page at index " + ref + "." + known());
    }
    return ref;
  }

  const s = String(ref).trim();
  if (s === "active" || s === "current") {
    if (!state.activePage) return 0;
    const byId = pages.find((p) => p.id === state.activePage.id);
    return byId ? byId.index : Math.min(state.activePage.index, pages.length - 1);
  }
  // id before name: ids are unique, names are not.
  const byId = pages.find((p) => p.id === s);
  if (byId) return byId.index;
  const byName = pages.find((p) => p.name === s);
  if (byName) return byName.index;
  const byNameCi = pages.find((p) => p.name.toLowerCase() === s.toLowerCase());
  if (byNameCi) return byNameCi.index;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n >= 0 && n < pages.length) return n;
  }
  throw new Error("No page matching '" + s + "'." + known());
}

/** The page ops target when the caller does not say. */
function defaultPageRef() {
  return state.activePage ? state.activePage.id : 0;
}

async function bridgeInvokeAction(actionName) {
  // invokeAction produces no response event of any kind — draw.io returns
  // immediately after calling action.funct(). Nothing to wait on, so callers
  // verify by reading currentPage back.
  const req = await evalBridge(BRIDGE_SEND, {
    msg: { action: "invokeAction", actionName },
  });
  if (!req || req.error) {
    throw new Error("bridge send failed: " + ((req && req.error) || "no bridge"));
  }
}

/**
 * Bring a page on screen.
 *
 * The embed protocol has no "select page N". What it has is the editor's own
 * `nextPage` / `previousPage` actions, which wrap around, so any page is
 * reachable by stepping in the cheaper direction. Each step is unverifiable on
 * its own; the whole walk is verified once at the end, and retried once, since
 * an editor busy with a morph can drop a step.
 */
async function bridgeSelectPage(targetIndex) {
  const first = await bridgePullXml();
  const total = pagesOf(first.xml).length;
  if (targetIndex < 0 || targetIndex >= total) {
    return { ok: false, error: "No page at index " + targetIndex };
  }
  if (first.currentPage === null) {
    return {
      ok: false,
      error:
        "This draw.io build does not report the selected page (no currentPage " +
        "in its export event), so page switching cannot be verified. Ask the " +
        "user to click the page tab at the bottom of the canvas.",
    };
  }

  let current = first.currentPage;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (current === targetIndex) return { ok: true, index: current, attempts: attempt };
    const forward = (targetIndex - current + total) % total;
    const backward = total - forward;
    const action = forward <= backward ? "nextPage" : "previousPage";
    const steps = Math.min(forward, backward);
    for (let i = 0; i < steps; i++) {
      await bridgeInvokeAction(action);
      await sleep(PAGE_STEP_DELAY);
    }
    const after = await bridgePullXml();
    current = after.currentPage === null ? current : after.currentPage;
  }

  if (current === targetIndex) return { ok: true, index: current, attempts: 2 };
  return {
    ok: false,
    index: current,
    error:
      "Asked for page " + targetIndex + " but the canvas is showing " + current +
      ". The deployment may not support invokeAction; the user can click the " +
      "page tab directly.",
  };
}

async function bridgePushLoad(xml) {
  // `autosave: 1` is required for autosave events to fire at all; without it
  // the rev counter never moves and drift detection is inert.
  return sendAndWait({ action: "load", xml, autosave: 1 }, "load", {
    timeout: LOAD_TIMEOUT,
  });
}

async function bridgePushMerge(xml) {
  const r = await sendAndWait({ action: "merge", xml }, "merge");
  if (r.error) throw new Error("merge rejected: " + r.error);
  return r;
}

/**
 * Push a complete document to the canvas.
 *
 * `merge` is a whole-document reconcile, not an additive splice: cells present
 * in the payload are inserted or updated, cells absent from it are removed.
 * It therefore handles adds, updates AND deletions in one shot, and applies as
 * an undoable edit so the user's Ctrl+Z still works. `load` is the fallback
 * (it resets the undo stack) for page-set changes and for merge failures.
 *
 * The corollary is a hard invariant: NEVER hand `merge` a partial document.
 * A partial payload deletes everything omitted from it.
 */
async function pushDocument(xml, newCanonical) {
  lastPushVerify = null;
  const pageCount = (t) => ((t || "").match(/^P /gm) || []).length;
  if (pageCount(state.base) !== pageCount(newCanonical)) {
    await loadPreservingPage(xml);
    return "load";
  }
  try {
    await bridgePushMerge(xml);
    const v = await verifyCanvas(newCanonical);
    lastPushVerify = v;
    if (!v.match) {
      lastPushVerify = null;
      runtime.console.warn(
        "merge resulted in canvas mismatch (e.g. deleted or renamed cells); falling back to load"
      );
      await loadPreservingPage(xml);
      return "load";
    }
    return "merge";
  } catch (e) {
    runtime.console.warn(
      "merge failed (" + e.message + "); falling back to load"
    );
    await loadPreservingPage(xml);
    return "load";
  }
}

/**
 * `load` with the user's page kept on screen.
 *
 * setFileData selects `urlParams["page"] || 0` on every load, so a bare load
 * yanks a user working on page 3 back to page 1 — for an edit they made to
 * page 3. The page is followed by id, not index, so it survives pages being
 * inserted or reordered in the same push. Best effort throughout: a failed
 * re-select is a wrong tab, not a lost edit, and must never fail the push.
 */
async function loadPreservingPage(xml) {
  const keep = state.activePage;
  await bridgePushLoad(xml);
  if (!keep || !keep.id) return;

  const pages = pagesOf(xml);
  const target = pages.find((p) => p.id === keep.id);
  if (!target || target.index === 0) return;

  try {
    const res = await bridgeSelectPage(target.index);
    if (!res.ok) {
      runtime.console.warn(
        "could not restore the visible page after load: " + (res.error || "unknown")
      );
    }
  } catch (e) {
    runtime.console.warn("could not restore the visible page after load: " + e.message);
  }
}

// Verification result from the most recent successful merge inside
// pushDocument. Each verify is a full export round trip (>= one poll interval),
// and toolOps/toolApply used to run a second identical one immediately after.
let lastPushVerify = null;

/**
 * Read the canvas back and compare against what we intended to push.
 * Reported as a warning, not an error: draw.io normalizes some geometry and
 * style values, so a mismatch is a signal to inspect, not proof of failure.
 */
async function verifyCanvas(expectedCanonical) {
  try {
    const pulled = await bridgePullXml();
    const live = canonicalize(pulled.xml);
    return { match: live === expectedCanonical, rev: pulled.rev, live };
  } catch (e) {
    return { match: false, error: e.message, rev: -1 };
  }
}

/**
 * Distinguish "the user moved something" from "our own merge fired an autosave".
 *
 * rev is a change counter, not an authorship record: draw.io bumps it for the
 * AI's own pushes too, and that autosave can land after verifyCanvas has
 * already read rev back. A rev-only comparison therefore reports drift for the
 * skill's own second edit in a turn. Confirm against content before crying
 * drift, and re-baseline the rev when the canvas in fact still matches.
 */
async function checkDrift() {
  const st = await bridgeStatus();
  if (!st || st.rev === state.syncedRev) return null;

  let live;
  try {
    live = await bridgePullXml();
  } catch (e) {
    return null; // cannot read: fail open, verifyCanvas is the backstop
  }
  const liveCanonical = canonicalize(live.xml);
  if (liveCanonical === state.base) {
    state.syncedRev = live.rev; // our own autosave; adopt the new counter
    return null;
  }
  return {
    status: "drifted",
    message:
      "Canvas was edited during your turn. Call drawio_sync again to re-base, " +
      "review the returned userDiff, then re-issue your edits.",
    rev: live.rev,
  };
}

/**
 * Run draw.io's own layout engine on the live canvas.
 *
 * `{action:"layout", layouts:[{layout, config}, ...]}` is the same entry point
 * as Arrange ▸ Layout ▸ Custom. The catalogue behind it — ELK's layered, tree,
 * radial, organic and stress layouts, plus libavoid connector routing and the
 * parallel-edge router — is the calculator this skill kept trying to rebuild.
 *
 * Two things make this different from every other action here:
 *
 *  1. NO RESPONSE EVENT. The protocol documents no `layout` event, so there is
 *     nothing for sendAndWait to block on. ELK also runs asynchronously with a
 *     morph animation between steps. The completion signal is therefore the
 *     model change itself: wait for `rev` to move, then settle.
 *  2. IT MUTATES BEHIND OUR BACK. The layout writes to the canvas without
 *     passing through applyOps/pushDocument, so `state.base` is stale the
 *     instant it lands. Every caller must re-adopt (adoptLive) rather than
 *     assume its own XML is still authoritative.
 */
async function bridgeLayout(layouts, opts) {
  await ensureBridge();
  const before = await bridgeStatus();
  const startRev = (before && before.rev) || 0;

  const req = await evalBridge(BRIDGE_SEND, {
    msg: { action: "layout", layouts },
  });
  if (!req || req.error) {
    throw new Error("bridge send failed: " + ((req && req.error) || "no bridge"));
  }

  const deadline = Date.now() + tuning("layoutTimeoutMs", LAYOUT_TIMEOUT);
  let moved = false;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);
    const st = await bridgeStatus();
    if (st && st.rev !== startRev) {
      moved = true;
      break;
    }
  }
  // A layout that changes nothing is a legitimate outcome (already tidy), so a
  // quiet rev is not an error. Settle regardless: the layout morphs, and pulling
  // mid-animation reads coordinates that are still moving. Slower deployments
  // and mxGraph's longer morph both want more than the default — hence the
  // per-call override and the `layout-settle-ms` config key.
  await sleep((opts && opts.settle) || tuning("layoutSettleMs", LAYOUT_SETTLE));
  return { applied: moved };
}

/**
 * Re-adopt the canvas as the editing base after something outside the ops
 * pipeline changed it, and describe what moved.
 */
async function adoptLive(previousCanonical) {
  const pulled = await bridgePullXml();
  const canonical = canonicalize(pulled.xml);
  const changeset = buildChangeset(
    diffCanonical(previousCanonical || "", canonical),
    previousCanonical
  );

  state.baseXml = pulled.xml;
  state.base = canonical;
  state.lastAppliedXml = pulled.xml;
  state.lastApplied = canonical;
  state.syncedRev = pulled.rev;

  return { canonical, rev: pulled.rev, changeset };
}

async function bridgeExport(format, opts) {
  await ensureBridge();
  // No `xml` parameter: the export must reflect what is ON the canvas, not
  // what we hoped to put there. Passing our own XML here would make the
  // vision self-check confirm itself against a blank editor.
  opts = opts || {};
  const msg = { action: "export", format };
  // See bridgePullXml: readable XML where the deployment supports it.
  if (format === "xml") msg.uncompressed = true;
  // Scale survives for downloads (drawio_save). It no longer has anything to do
  // with context cost: nothing exported here is ever put in front of the model
  // as an image, because a tool result cannot carry one.
  if (opts.scale) msg.scale = opts.scale;
  const r = await sendAndWait(msg, "export", {
    format,
    timeout: EXPORT_TIMEOUT,
  });
  const raw = format === "xml" ? r.xml || r.data : r.data || r.xml;
  return format === "xml" ? await inflateDiagrams(raw) : raw;
}

/**
 * Inflate deflate+base64 <diagram> payloads back to plain XML.
 *
 * draw.io compresses diagram bodies by default and `uncompressed: true` is
 * advisory — self-hosted builds of different vintages disagree about whether to
 * honour it. Everything downstream (canonicalize, the differ, the ops engine)
 * reads mxCell elements, so a compressed payload is not a formatting detail: it
 * makes the document look empty. Returns the input untouched when there is
 * nothing to inflate, and on any failure — a diagram we cannot read is better
 * left in the caller's hands than replaced with a broken parse.
 */
async function inflateDiagrams(xmlStr) {
  if (!xmlStr || typeof xmlStr !== "string" || xmlStr.indexOf("<diagram") === -1) {
    return xmlStr;
  }
  if (typeof DecompressionStream === "undefined") return xmlStr;

  let doc;
  try {
    doc = new DOMParser().parseFromString(xmlStr, "text/xml");
    if (doc.querySelector("parsererror")) return xmlStr;
  } catch (_) {
    return xmlStr;
  }

  let changed = false;
  const diagrams = doc.querySelectorAll("diagram");
  for (const d of diagrams) {
    // A compressed body is a single text node of base64 with no markup.
    if (d.childNodes.length !== 1 || !d.firstChild || d.firstChild.nodeType !== 3) continue;
    const text = d.textContent.trim();
    if (!text || text.indexOf("<") !== -1 || !/^[A-Za-z0-9+/=\s]+$/.test(text)) continue;
    try {
      const bin = atob(text.replace(/\s+/g, ""));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const stream = new Blob([bytes]).stream().pipeThrough(
        new DecompressionStream("deflate-raw")
      );
      const inflated = await new Response(stream).text();
      const decoded = decodeURIComponent(inflated);
      const inner = new DOMParser().parseFromString(decoded, "text/xml");
      if (inner.querySelector("parsererror") || !inner.documentElement) continue;
      d.textContent = "";
      d.appendChild(doc.importNode(inner.documentElement, true));
      changed = true;
    } catch (e) {
      runtime.console.warn("drawio: could not inflate a compressed diagram: " + e.message);
    }
  }

  return changed ? serializeXml(doc) : xmlStr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- XML / Canonical utilities -------------------------------

function parseXml(xmlStr) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, "text/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("XML parse error: " + err.textContent.slice(0, 200));
  return doc;
}

function serializeXml(doc) {
  return new XMLSerializer().serializeToString(doc);
}

/**
 * Canonicalize: extract all mxCell elements, emit one line per cell
 * sorted by (page, id). Format: KIND ID PAGE PARENT "LABEL" STYLE GEOMETRY
 * This is for diffing — not for push (we push real XML).
 *
 * `pg=` is not decoration. Cells were previously collected with one flat
 * querySelectorAll across the whole file, so two pages holding a cell with the
 * same id produced two lines the differ keyed identically and collapsed into
 * one — the second page's cell was invisible to every diff, every drift check
 * and every verify. Page-scoped ids are common the moment anyone duplicates a
 * page or hand-writes a second one.
 */
function canonicalize(xmlStr) {
  const doc = parseXml(xmlStr);
  const lines = [];

  // Pages
  const diagrams = doc.querySelectorAll("diagram");
  const pageIds = [];
  diagrams.forEach((d, i) => {
    const id = d.getAttribute("id") || d.getAttribute("name") || "page-" + (i + 1);
    const name = d.getAttribute("name") || "";
    pageIds.push(id);
    lines.push("P " + id + ' "' + escLabel(name) + '"');
  });

  // Cells, page by page: document order for pages, id order within a page.
  const cellArr = [];
  diagrams.forEach((d, i) => {
    const own = [];
    d.querySelectorAll("mxCell").forEach((c) => own.push(c));
    own.sort((a, b) => {
      const ai = a.getAttribute("id") || "";
      const bi = b.getAttribute("id") || "";
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    });
    own.forEach((c) => cellArr.push({ cell: c, page: pageIds[i] }));
  });
  // A document with no <diagram> wrapper at all (a bare mxGraphModel) still
  // has to canonicalize — drawio_validate is called on hand-written XML.
  if (!diagrams.length) {
    const own = [];
    doc.querySelectorAll("mxCell").forEach((c) => own.push(c));
    own.sort((a, b) => {
      const ai = a.getAttribute("id") || "";
      const bi = b.getAttribute("id") || "";
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    });
    own.forEach((c) => cellArr.push({ cell: c, page: "" }));
  }

  for (const entry of cellArr) {
    const c = entry.cell;
    const pg = entry.page ? " pg=" + entry.page : "";
    const id = c.getAttribute("id") || "";
    // Skip root cells
    if (id === "0" || id === "1") continue;

    const parent = c.getAttribute("parent") || "";
    const value = c.getAttribute("value") || "";
    const style = normalizeStyle(c.getAttribute("style") || "");
    const source = c.getAttribute("source") || "";
    const target = c.getAttribute("target") || "";
    const edge = c.getAttribute("edge") === "1";
    const vertex = c.getAttribute("vertex") === "1";

    // Geometry
    let geo = "";
    const geoEl = c.querySelector("mxGeometry");
    if (geoEl) {
      const x = Math.round(parseFloat(geoEl.getAttribute("x") || "0"));
      const y = Math.round(parseFloat(geoEl.getAttribute("y") || "0"));
      const w = Math.round(parseFloat(geoEl.getAttribute("width") || "0"));
      const h = Math.round(parseFloat(geoEl.getAttribute("height") || "0"));
      geo = x + "," + y + "," + w + "," + h;
    }

    if (edge) {
      // Waypoints belong in the canonical form. Routing is now something both
      // sides change — the layout engine writes it, and a user dragging an edge
      // is expressing intent about it — so leaving it out made those edits
      // invisible to the differ and to verifyCanvas.
      let pts = "";
      if (geoEl) {
        const arr = geoEl.querySelector('Array[as="points"]');
        if (arr) {
          const list = [];
          arr.querySelectorAll("mxPoint").forEach((pt) => {
            list.push(
              Math.round(parseFloat(pt.getAttribute("x") || "0")) + "," +
              Math.round(parseFloat(pt.getAttribute("y") || "0"))
            );
          });
          if (list.length) pts = " pts=[" + list.join(";") + "]";
        }
      }
      lines.push(
        'E ' + id + pg + ' p=' + parent + ' ' + source + '->' + target +
        ' "' + escLabel(value) + '" s=' + style + ' g=[' + geo + ']' + pts
      );
    } else if (vertex) {
      lines.push(
        'V ' + id + pg + ' p=' + parent +
        ' "' + escLabel(value) + '" s=' + style + ' g=[' + geo + ']'
      );
    }
  }

  return lines.join("\n");
}

function escLabel(s) {
  return (s || "").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function normalizeStyle(s) {
  if (!s) return "";
  const parts = s.split(";").filter(Boolean);
  parts.sort();
  return parts.join(";") + ";";
}

// --- Line Differ (LCS-based) --------------------------------

function diffCanonical(oldText, newText) {
  const oldLines = (oldText || "").split("\n").filter(Boolean);
  const newLines = (newText || "").split("\n").filter(Boolean);

  // Keyed by page+id, reported by id. Two pages may hold the same cell id, and
  // keying on id alone silently dropped one of them from every diff.
  const oldMap = {};
  oldLines.forEach((l) => {
    const k = extractKey(l);
    if (k) oldMap[k] = l;
  });

  const newMap = {};
  newLines.forEach((l) => {
    const k = extractKey(l);
    if (k) newMap[k] = l;
  });

  const added = [];
  const removed = [];
  const changed = [];
  const entry = (key, line, rest) =>
    Object.assign({ id: extractId(line), key }, extractPage(line) ? { page: extractPage(line) } : {}, rest);

  // Find removed and changed
  for (const key in oldMap) {
    if (!(key in newMap)) {
      removed.push(entry(key, oldMap[key], { line: oldMap[key] }));
    } else if (oldMap[key] !== newMap[key]) {
      changed.push(entry(key, newMap[key], { from: oldMap[key], to: newMap[key] }));
    }
  }

  // Find added
  for (const key in newMap) {
    if (!(key in oldMap)) {
      added.push(entry(key, newMap[key], { line: newMap[key] }));
    }
  }

  return { added, removed, changed };
}

function extractId(line) {
  // Lines: "V id pg=... p=..." or "E id pg=... p=..." or "P id ..."
  const m = line.match(/^[VEP]\s+(\S+)/);
  return m ? m[1] : null;
}

function extractPage(line) {
  const m = line.match(/^[VE]\s+\S+\s+pg=(\S+)/);
  return m ? m[1] : null;
}

/** Diff identity: page-scoped for cells, plain id for page lines. */
function extractKey(line) {
  const id = extractId(line);
  if (!id) return null;
  const page = extractPage(line);
  return page ? page + "/" + id : id;
}

/**
 * Build a structured changeset from a raw diff, suitable for LLM consumption.
 */
function buildChangeset(rawDiff, lastAppliedCanonical) {
  const lastAppliedIds = new Set();
  if (lastAppliedCanonical) {
    lastAppliedCanonical.split("\n").forEach((l) => {
      const k = extractKey(l);
      if (k) lastAppliedIds.add(k);
    });
  }

  const result = {
    added: rawDiff.added.map((a) => parseCanonLine(a.line)),
    removed: rawDiff.removed.map((r) => (r.page ? { id: r.id, page: r.page } : { id: r.id })),
    changed: rawDiff.changed.map((c) => describeDelta(c)),
    revertedAiCells: [],
    summary: "",
  };

  // Detect reverted AI cells
  for (const r of rawDiff.removed) {
    if (lastAppliedIds.has(r.key || r.id)) {
      result.revertedAiCells.push(r.id);
    }
  }
  for (const c of rawDiff.changed) {
    if (lastAppliedIds.has(c.id)) {
      // Style or geometry changes to AI cells = user tweaked them
      // Only flag complete reversions (not tweaks) — but for simplicity,
      // we don't distinguish; the summary text is enough.
    }
  }

  // Build summary
  const parts = [];
  if (result.added.length) parts.push("added " + result.added.length + " cell(s)");
  if (result.removed.length) parts.push("removed " + result.removed.length + " cell(s)");
  if (result.changed.length) parts.push("changed " + result.changed.length + " cell(s)");
  if (result.revertedAiCells.length) parts.push("reverted AI cells: " + result.revertedAiCells.join(", "));
  result.summary = parts.length ? "User " + parts.join(", ") : "No changes";

  return result;
}

function parseCanonLine(line) {
  const kind = line.startsWith("V") ? "vertex" : line.startsWith("E") ? "edge" : "page";
  const idM = line.match(/^[VEP]\s+(\S+)/);
  const id = idM ? idM[1] : "";
  const page = extractPage(line);
  const labelM = line.match(/"([^"]*)"/);
  const label = labelM ? labelM[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : "";
  const geoM = line.match(/g=\[([^\]]*)\]/);
  const at = geoM ? geoM[1].split(",").map(Number) : [];
  return page ? { id, kind, label, at, page } : { id, kind, label, at };
}

function describeDelta(change) {
  const oldParsed = parseCanonLine(change.from);
  const newParsed = parseCanonLine(change.to);
  const delta = { id: change.id };

  if (oldParsed.label !== newParsed.label) {
    delta.label = { from: oldParsed.label, to: newParsed.label };
  }
  const og = (change.from.match(/g=\[([^\]]*)\]/) || [])[1] || "";
  const ng = (change.to.match(/g=\[([^\]]*)\]/) || [])[1] || "";
  if (og !== ng) {
    delta.geometry = { from: og.split(",").map(Number), to: ng.split(",").map(Number) };
  }
  const os = (change.from.match(/s=(.*)$/) || [])[1] || "";
  const ns = (change.to.match(/s=(.*)$/) || [])[1] || "";
  if (os !== ns) delta.styleChanged = true;

  return delta;
}

// --- Validator -----------------------------------------------

function validate(xmlStr) {
  const errors = [];
  const warnings = [];

  // 1. XML well-formedness
  let doc;
  try {
    doc = parseXml(xmlStr);
  } catch (e) {
    errors.push("XML parse error: " + e.message);
    return { errors, warnings };
  }

  // 2. Structure: mxfile > diagram > mxGraphModel > root
  const mxfile = doc.querySelector("mxfile");
  if (!mxfile) {
    errors.push('Missing <mxfile> root element');
    return { errors, warnings };
  }
  const diagram = mxfile.querySelector("diagram");
  if (!diagram) {
    errors.push('Missing <diagram> element');
    return { errors, warnings };
  }
  const model = diagram.querySelector("mxGraphModel");
  if (!model) {
    errors.push('Missing <mxGraphModel> element');
    return { errors, warnings };
  }
  const root = model.querySelector("root");
  if (!root) {
    errors.push('Missing <root> element');
    return { errors, warnings };
  }

  // 3. Root cells 0 and 1
  const cells = root.querySelectorAll("mxCell");
  const idSet = new Set();
  const cellMap = {};
  const dupIds = [];

  cells.forEach((c) => {
    const id = c.getAttribute("id");
    if (!id) {
      warnings.push("Cell without id attribute");
      return;
    }
    if (idSet.has(id)) {
      dupIds.push(id);
    }
    idSet.add(id);
    cellMap[id] = c;
  });

  if (!idSet.has("0")) errors.push('Missing root cell id="0"');
  if (!idSet.has("1")) errors.push('Missing root cell id="1"');
  if (dupIds.length) errors.push("Duplicate cell IDs: " + dupIds.join(", "));

  // 4. Edge reference integrity
  cells.forEach((c) => {
    const id = c.getAttribute("id");
    if (c.getAttribute("edge") === "1") {
      const src = c.getAttribute("source");
      const tgt = c.getAttribute("target");
      if (src && !idSet.has(src)) {
        errors.push('Edge "' + id + '" references missing source "' + src + '"');
      }
      if (tgt && !idSet.has(tgt)) {
        errors.push('Edge "' + id + '" references missing target "' + tgt + '"');
      }
    }
    const parent = c.getAttribute("parent");
    if (parent && !idSet.has(parent) && id !== "0") {
      errors.push('Cell "' + id + '" references missing parent "' + parent + '"');
    }
  });

  // 5. Layout lint (warnings only)
  const vertices = [];
  cells.forEach((c) => {
    if (c.getAttribute("vertex") !== "1") return;
    const geo = c.querySelector("mxGeometry");
    if (!geo) return;
    const x = parseFloat(geo.getAttribute("x") || "0");
    const y = parseFloat(geo.getAttribute("y") || "0");
    const w = parseFloat(geo.getAttribute("width") || "0");
    const h = parseFloat(geo.getAttribute("height") || "0");
    vertices.push({ id: c.getAttribute("id"), x, y, w, h, label: c.getAttribute("value") || "" });
  });

  const byId = {};
  vertices.forEach((v) => (byId[v.id] = v));
  const hits = (box, skip) =>
    vertices.filter(
      (v) =>
        skip.indexOf(v.id) === -1 &&
        box.x < v.x + v.w &&
        box.x + box.w > v.x &&
        box.y < v.y + v.h &&
        box.y + box.h > v.y
    );

  // Overlap detection (simple O(n^2), fine for reasonable diagram sizes)
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      const a = vertices[i];
      const b = vertices[j];
      if (
        a.x < b.x + b.w &&
        a.x + a.w > b.x &&
        a.y < b.y + b.h &&
        a.y + a.h > b.y
      ) {
        warnings.push('Overlap: "' + a.id + '" and "' + b.id + '"');
      }
    }
  }

  // Clipped labels. draw.io wraps rather than truncating, but a label wider
  // than its box either wraps into the border or spills — either way the model
  // cannot see it in the canonical text, so it has to be told.
  vertices.forEach((v) => {
    if (!v.label) return;
    const need = labelWidth(v.label);
    if (v.w && need > v.w + 1) {
      warnings.push(
        'Label may clip: "' + v.id + '" needs ~' + Math.ceil(need) +
          "px, box is " + v.w + "px. Widen it or shorten the label."
      );
    }
  });

  // Off-grid geometry. Cheap to detect, invisible in prose, and the reason
  // diagrams look subtly crooked.
  vertices.forEach((v) => {
    if (v.x % GRID || v.y % GRID) {
      warnings.push('Off-grid: "' + v.id + '" at ' + v.x + "," + v.y);
    }
  });

  // The routed polyline for every edge: source endpoint, any waypoints (either
  // authored via add_edge/set_edge_points or written back by drawio_route),
  // target endpoint. Built once; all three checks below read it.
  //
  // The endpoint is a shape CENTRE only when the edge floats. set_edge_anchor
  // pins it, and it writes exitX/exitY (entryX/entryY) into the cell's STYLE,
  // which this function used not to read at all — so every anchored edge was
  // scored against a path it does not take. That is not a rounding error: an
  // edge pinned to the bottom of a box at exitAt 0.25 starts half a box-width
  // from where the centre model puts it, which moves the computed label
  // position, changes which shapes the segments appear to cross, and inflates
  // the crossings count. It is why anchored edges always needed a screenshot
  // to confirm.
  const styleNum = (style, key) => {
    const m = String(style || "").match(
      new RegExp("(?:^|;)\\s*" + key + "=(-?[0-9.]+)")
    );
    return m ? parseFloat(m[1]) : NaN;
  };
  /** Fixed connection point as absolute coords, or null when the edge floats. */
  const anchorAt = (style, prefix, v) => {
    const fx = styleNum(style, prefix + "X");
    const fy = styleNum(style, prefix + "Y");
    if (isNaN(fx) || isNaN(fy)) return null;
    // exitDx/exitDy are pixel nudges on top of the relative point. applyAnchor
    // always writes them as 0, but the draw.io GUI does not.
    const ddx = styleNum(style, prefix + "Dx");
    const ddy = styleNum(style, prefix + "Dy");
    return {
      x: v.x + fx * v.w + (isNaN(ddx) ? 0 : ddx),
      y: v.y + fy * v.h + (isNaN(ddy) ? 0 : ddy),
    };
  };
  const polyline = (c) => {
    const a = byId[c.getAttribute("source")];
    const b = byId[c.getAttribute("target")];
    if (!a || !b) return null;
    const style = c.getAttribute("style") || "";
    const aAt = anchorAt(style, "exit", a);
    const bAt = anchorAt(style, "entry", b);
    const pts = [aAt || { x: a.x + a.w / 2, y: a.y + a.h / 2 }];
    const geoEl = c.querySelector("mxGeometry");
    const arr = geoEl && geoEl.querySelector('Array[as="points"]');
    if (arr) {
      arr.querySelectorAll("mxPoint").forEach((pt) => {
        pts.push({
          x: parseFloat(pt.getAttribute("x") || "0"),
          y: parseFloat(pt.getAttribute("y") || "0"),
        });
      });
    }
    pts.push(bAt || { x: b.x + b.w / 2, y: b.y + b.h / 2 });
    // Which ends sit ON the boundary rather than at the centre. visibleLength
    // needs this: nothing is buried inside the shape at a pinned end.
    return {
      pts,
      ends: [a.id, b.id],
      anchored: [!!aAt, !!bAt],
      id: c.getAttribute("id"),
    };
  };

  const routes = [];
  const routeById = {};
  cells.forEach((c) => {
    if (c.getAttribute("edge") !== "1") return;
    const r = polyline(c);
    if (r) {
      routes.push(r);
      routeById[r.id] = r;
    }
  });

  /** Point at fraction t of the polyline's arc length. */
  const pointAlong = (pts, t) => {
    const seg = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = Math.sqrt(
        Math.pow(pts[i + 1].x - pts[i].x, 2) + Math.pow(pts[i + 1].y - pts[i].y, 2)
      );
      seg.push(d);
      total += d;
    }
    if (!total) return { x: pts[0].x, y: pts[0].y };
    let want = Math.max(0, Math.min(1, t)) * total;
    for (let i = 0; i < seg.length; i++) {
      if (want <= seg[i] || i === seg.length - 1) {
        const f = seg[i] ? want / seg[i] : 0;
        return {
          x: pts[i].x + (pts[i + 1].x - pts[i].x) * f,
          y: pts[i].y + (pts[i + 1].y - pts[i].y) * f,
        };
      }
      want -= seg[i];
    }
    return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
  };

  // Where draw.io ACTUALLY draws each edge label.
  //
  // The previous version used the midpoint between the two endpoint CENTRES.
  // That is only correct for a straight two-point edge: the moment drawio_route
  // inserts waypoints, the label moves to the midpoint of the routed PATH, a
  // different place entirely. So the check reported clean on exactly the labels
  // that had been pushed on top of a shape — the single defect this lint most
  // needs to catch, missed because it was measuring a position the label had
  // already left. mxGeometry.x (a -1..1 position along the path) and
  // <mxPoint as="offset"> are both honoured, so a label the model has already
  // nudged with set_edge_label is scored where it now sits.
  /**
   * Length of the polyline that is actually drawn: total arc length minus the
   * runs buried inside the source and target shapes. A floating end starts at
   * the shape CENTRE, so roughly half a box is hidden there; an end pinned by
   * set_edge_anchor already starts on the boundary and hides nothing.
   */
  const visibleLength = (L) => {
    const pts = L.pts;
    const anchored = L.anchored || [false, false];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      total += Math.sqrt(
        Math.pow(pts[i + 1].x - pts[i].x, 2) + Math.pow(pts[i + 1].y - pts[i].y, 2)
      );
    }
    const inset = (v, p, q, pinned) => {
      if (!v || pinned) return 0;
      // Which way does the segment leave the shape? Whichever axis dominates
      // decides which half-extent is hidden.
      return Math.abs(q.x - p.x) >= Math.abs(q.y - p.y) ? v.w / 2 : v.h / 2;
    };
    const a = byId[L.ends[0]];
    const b = byId[L.ends[1]];
    return (
      total -
      inset(a, pts[0], pts[1], anchored[0]) -
      inset(b, pts[pts.length - 1], pts[pts.length - 2], anchored[1])
    );
  };

  const labelBoxes = [];
  cells.forEach((c) => {
    if (c.getAttribute("edge") !== "1") return;
    const label = c.getAttribute("value") || "";
    if (!label) return;
    const r = routeById[c.getAttribute("id")];
    if (!r) return;
    const geoEl = c.querySelector("mxGeometry");
    const relAttr = geoEl && geoEl.getAttribute("x");
    const rel = relAttr === null || relAttr === undefined ? 0 : parseFloat(relAttr);
    const off = geoEl && geoEl.querySelector('mxPoint[as="offset"]');
    const dx = off ? parseFloat(off.getAttribute("x") || "0") : 0;
    const dy = off ? parseFloat(off.getAttribute("y") || "0") : 0;
    const at = pointAlong(
      r.pts,
      ((isNaN(rel) ? 0 : Math.max(-1, Math.min(1, rel))) + 1) / 2
    );
    const w = labelWidth(label);
    labelBoxes.push({
      id: r.id,
      label,
      ends: r.ends,
      pts: r.pts,
      anchored: r.anchored,
      style: c.getAttribute("style") || "",
      routed: r.pts.length > 2,
      box: { x: at.x + dx - w / 2, y: at.y + dy - 10, w, h: 20 },
    });
  });

  labelBoxes.forEach((L) => {
    const collides = hits(L.box, L.ends);
    if (collides.length) {
      warnings.push(
        'Edge label "' + L.label + '" (' + L.id + ') sits on ' +
          collides.map((v) => v.id).join(", ") +
          ". Cheapest fix: {op:'set_edge_label', id:'" + L.id +
          "', dy:-24} to nudge it clear, or background:true to keep it legible " +
          "where it is. {op:'set_edge_points'} re-routes the edge itself. " +
          "Moving the shapes is the last resort, not the first."
      );
      return;
    }
    // Does the label BURY the connector you can actually see?
    //
    // Narrowed to the painted case, which is the only one that is a defect.
    //
    // The unpainted version fired on every label that overhangs its connector,
    // and overhang alone is harmless: the collision check above has already
    // returned for any label touching a shape, so what is left is text
    // extending into empty canvas, which draw.io renders as intended. It was
    // also unsatisfiable in practice. The threshold demands
    // labelWidth <= 0.8 * visible, while MIN_GAP — the floor this same module
    // hands to grid_layout, distribute and the hgap/vgap defaults — is 40px.
    // At a 40px gap a two-character label already trips it, so the library's
    // own layout ops produced diagrams its own lint was guaranteed to complain
    // about, on every edge, forever. A warning that cannot be satisfied by
    // following the API's defaults is noise, and noise is what gets the real
    // entries in this array skimmed.
    //
    // Painted is different and stays: labelBackgroundColor over a stretch
    // longer than the visible run paints the arrow out of existence. That
    // produced a diagram with no visible connectors at all, and it cannot be
    // seen in the canonical text.
    const vis = visibleLength(L);
    const painted = /labelBackgroundColor=(?!none)/.test(L.style || "");
    if (painted && vis > 0 && L.box.w > vis * 0.8) {
      warnings.push(
        'Edge label "' + L.label + '" (' + L.id + ') is ~' + Math.ceil(L.box.w) +
          "px wide but only ~" + Math.round(vis) +
          "px of the connector is visible between the shapes, and its " +
          "background is painted over that stretch — the arrow is invisible on " +
          "the canvas. Set labelBackgroundColor=none, or offset the label with " +
          "{op:'set_edge_label', id:'" + L.id + "', dy:-24}, or move the shapes " +
          "at least " + Math.ceil(L.box.w + MIN_GAP) + "px apart."
      );
    }
  });

  // Labels stacked on each other. Two edges running parallel after routing put
  // their labels at the same fraction of near-identical paths, which lands both
  // in the same few pixels. Neither is legible, and a vertex-only check cannot
  // see it because no shape is involved.
  for (let i = 0; i < labelBoxes.length; i++) {
    for (let j = i + 1; j < labelBoxes.length; j++) {
      const A = labelBoxes[i].box;
      const B = labelBoxes[j].box;
      if (A.x < B.x + B.w && A.x + A.w > B.x && A.y < B.y + B.h && A.y + A.h > B.y) {
        warnings.push(
          'Edge labels "' + labelBoxes[i].label + '" (' + labelBoxes[i].id +
            ') and "' + labelBoxes[j].label + '" (' + labelBoxes[j].id +
            ") overlap each other. Offset one: {op:'set_edge_label', id:'" +
            labelBoxes[j].id + "', dy:20}."
        );
      }
    }
  }

  // Readability: edges cutting through shapes, and edges crossing each other.
  //
  // This replaces the old "you added nodes without running a layout" nag. That
  // warning fired on intent rather than on outcome, so it flagged tidy diagrams
  // and pushed the model toward a full re-layout when the actual problem — if
  // there was one — was routing. These two are observable facts about the
  // document, and their fix is drawio_route, which moves nothing.

  const throughHits = [];
  for (const r of routes) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      for (const v of vertices) {
        if (r.ends.indexOf(v.id) !== -1) continue;
        if (segIntersectsRect(r.pts[i], r.pts[i + 1], v)) {
          throughHits.push(r.id + " through " + v.id);
          break;
        }
      }
    }
  }
  if (throughHits.length) {
    warnings.push(
      "Edges pass through shapes: " + [...new Set(throughHits)].slice(0, 6).join(", ") +
        (throughHits.length > 6 ? " (+" + (throughHits.length - 6) + " more)" : "") +
        ". drawio_route() re-routes them around the obstacles without moving anything."
    );
  }

  let crossings = 0;
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const A = routes[i], B = routes[j];
      if (A.ends.some((id) => B.ends.indexOf(id) !== -1)) continue; // meeting, not crossing
      for (let a = 0; a < A.pts.length - 1; a++) {
        for (let b = 0; b < B.pts.length - 1; b++) {
          if (segsCross(A.pts[a], A.pts[a + 1], B.pts[b], B.pts[b + 1])) crossings++;
        }
      }
    }
  }
  if (crossings >= 3) {
    warnings.push(
      crossings + " edge crossings. drawio_route() will thin these out; if the " +
        "structure itself is tangled, drawio_arrange() re-places the shapes — " +
        "ask the user first if they arranged the diagram themselves."
    );
  }

  return { errors, warnings, stats: { cells: idSet.size, pages: doc.querySelectorAll("diagram").length } };
}

// --- Ops engine ----------------------------------------------

const SUPPORTED_OPS = [
  "add_node",
  "add_edge",
  "set_label",
  "set_edge_label",
  "set_edge_points",
  "set_edge_anchor",
  "resize_to_fit",
  "set_style",
  "set_geometry",
  "move_by",
  "delete",
  "adopt",
  "add_page",
  "rename_page",
  "delete_page",
  "duplicate_page",
  "move_page",
  "align",
  "distribute",
  "grid_layout",
];

// The five ops that take a LIST of ids. The other eleven take a scalar `id`,
// the spelling is not guessable from the op name, and applyOps is atomic — so
// one wrong key discards an entire batch that was otherwise valid, costing a
// full model round trip to retype it. Cheaper to accept both spellings.
const LIST_ID_OPS = ["move_by", "delete", "align", "distribute", "grid_layout"];

// Ops that rearrange the page list itself rather than cells on a page. They
// take no `root`, and `page` on them names the page being operated ON, not the
// page they are scoped to.
const PAGE_OPS = ["add_page", "rename_page", "delete_page", "duplicate_page", "move_page"];

/**
 * Apply a batch of operations to an XML document string.
 * Returns { xml, report } where report lists per-op results.
 *
 * Page scope: every cell op resolves its own <root>, from `op.page` if it has
 * one and from `defaultPage` otherwise. `defaultPage` is normally the page the
 * user is looking at. One batch may therefore touch several pages, and the
 * page list may itself change mid-batch (add_page then add_node on it), so the
 * resolution is redone per op rather than hoisted.
 */
function applyOps(xmlStr, ops, defaultPage) {
  const doc = parseXml(xmlStr);
  if (!doc.querySelector("diagram")) throw new Error("Cannot find <diagram> in XML");
  const report = [];

  const rootFor = (ref) => {
    const pages = pagesOfDoc(doc);
    const idx = resolvePage(pages, ref === undefined || ref === null ? defaultPage : ref);
    const diagram = doc.querySelectorAll("diagram")[idx];
    const root = diagram && diagram.querySelector("mxGraphModel > root");
    if (!root) {
      throw new Error(
        "Page '" + pages[idx].id + "' has no <mxGraphModel><root>. If its body is " +
          "still compressed, call drawio_sync to re-read the canvas."
      );
    }
    return { root, page: pages[idx] };
  };

  for (const op of ops) {
    try {
      // `id` as an alias for a single-element `ids`, and vice versa. Purely a
      // spelling fix: each op still validates its own arguments below.
      if (LIST_ID_OPS.indexOf(op.op) !== -1) {
        if (!op.ids && op.id) op.ids = [op.id];
      } else if (!op.id && Array.isArray(op.ids) && op.ids.length === 1) {
        op.id = op.ids[0];
      }
      // Cell ops get a page-scoped root; page ops rearrange the page list and
      // resolve their own target inside the op.
      const scope = PAGE_OPS.indexOf(op.op) === -1 ? rootFor(op.page) : null;
      const root = scope ? scope.root : null;
      const reportFrom = report.length;
      switch (op.op) {
        case "add_node":
          opAddNode(doc, root, op);
          report.push({
            op: op.op,
            id: op.id,
            ok: true,
            ...(op.resolvedShape ? { preset: op.preset, resolvedShape: op.resolvedShape } : {}),
          });
          break;
        case "add_edge":
          opAddEdge(doc, root, op);
          report.push({ op: op.op, id: op.id || "auto", ok: true });
          break;
        case "set_label":
          opSetLabel(root, op);
          report.push({ op: op.op, id: op.id, ok: true });
          break;
        case "set_edge_label":
          opSetEdgeLabel(doc, root, op);
          report.push({ op: op.op, id: op.id, ok: true });
          break;
        case "set_edge_points":
          opSetEdgePoints(doc, root, op);
          report.push({
            op: op.op,
            id: op.id,
            points: Array.isArray(op.points) ? op.points.length : 0,
            ok: true,
          });
          break;
        case "set_edge_anchor":
          opSetEdgeAnchor(doc, root, op);
          report.push({
            op: op.op,
            id: op.id,
            exit: op.exit,
            entry: op.entry,
            ok: true,
          });
          break;
        case "resize_to_fit":
          opResizeToFit(root, op);
          report.push({ op: op.op, id: op.id, w: op.w, ok: true });
          break;
        case "set_style":
          opSetStyle(root, op);
          report.push({ op: op.op, id: op.id, ok: true });
          break;
        case "set_geometry":
          opSetGeometry(root, op);
          report.push({ op: op.op, id: op.id, ok: true });
          break;
        case "move_by":
          opMoveBy(root, op);
          report.push({ op: op.op, ids: op.ids, ok: true });
          break;
        case "delete":
          opDelete(root, op);
          report.push({ op: op.op, ids: op.ids, ok: true });
          break;
        case "adopt":
          opAdopt(root, op);
          report.push({ op: op.op, id: op.id, newId: op.newId, ok: true });
          break;
        case "add_page": {
          const added = opAddPage(doc, op);
          report.push({ op: op.op, id: added.id, name: added.name, index: added.index, ok: true });
          break;
        }
        case "rename_page": {
          const renamed = opRenamePage(doc, op);
          report.push({ op: op.op, id: renamed.id, name: renamed.name, ok: true });
          break;
        }
        case "delete_page": {
          const removed = opDeletePage(doc, op);
          report.push({ op: op.op, id: removed.id, name: removed.name, ok: true });
          break;
        }
        case "duplicate_page": {
          const copy = opDuplicatePage(doc, op);
          report.push({ op: op.op, id: copy.id, name: copy.name, from: copy.from, ok: true });
          break;
        }
        case "move_page": {
          const moved = opMovePage(doc, op);
          report.push({ op: op.op, id: moved.id, from: moved.from, to: moved.to, ok: true });
          break;
        }
        case "align":
          opAlign(root, op);
          report.push({ op: op.op, ids: op.ids, axis: op.axis || "left", ok: true });
          break;
        case "distribute":
          opDistribute(root, op);
          report.push({ op: op.op, ids: op.ids, axis: op.axis || "horizontal", ok: true });
          break;
        case "grid_layout":
          opGridLayout(root, op);
          report.push({ op: op.op, ids: op.ids, cols: op.cols, ok: true });
          break;
        default:
          report.push({
            op: op.op,
            ok: false,
            error:
              "Unknown op: " + op.op + ". Supported: " + SUPPORTED_OPS.join(", "),
          });
      }
      // Say which page each cell op landed on. On a single-page document this
      // is noise, so it is omitted there.
      if (scope && pagesOfDoc(doc).length > 1) {
        for (let i = reportFrom; i < report.length; i++) report[i].page = scope.page.id;
      }
    } catch (e) {
      report.push({ op: op.op, id: op.id, ok: false, error: e.message });
    }
  }

  const hasErrors = report.some((r) => !r.ok);
  if (hasErrors) {
    // Atomic: reject the whole batch on any error
    throw new Error(
      "Ops batch has errors — no changes applied:\n" +
      report.filter((r) => !r.ok).map((r) => r.op + " " + (r.id || "") + ": " + r.error).join("\n")
    );
  }

  return { xml: serializeXml(doc), report };
}

function findCell(root, id) {
  const cells = root.querySelectorAll("mxCell");
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].getAttribute("id") === id) return cells[i];
  }
  return null;
}

const snap = (v) => Math.round(Number(v || 0) / GRID) * GRID;

/**
 * The semantic palette, as data rather than as five hex codes recited in
 * SKILL.md prose. A colour system the model has to remember is a lookup table
 * living in the context window, and it drifts: the same "compute" node comes
 * out a different blue three turns later. `role` resolves here instead.
 */
const ROLE_PALETTE = {
  compute: { fillColor: "#dae8fc", strokeColor: "#6c8ebf" },
  service: { fillColor: "#d5e8d4", strokeColor: "#82b366" },
  storage: { fillColor: "#ffe6cc", strokeColor: "#d79b00" },
  security: { fillColor: "#f8cecc", strokeColor: "#b85450" },
  external: { fillColor: "#e1d5e7", strokeColor: "#9673a6" },
  process: { fillColor: "#fff2cc", strokeColor: "#d6b656" },
  neutral: { fillColor: "#f5f5f5", strokeColor: "#666666" },
};

const ROLE_NAMES = Object.keys(ROLE_PALETTE);

/** Merge k=v pairs into a style string; later keys win. */
function mergeStyle(base, extra) {
  const map = {};
  const eat = (str) => {
    (str || "").split(";").filter(Boolean).forEach((kv) => {
      const eq = kv.indexOf("=");
      if (eq > 0) map[kv.slice(0, eq)] = kv.slice(eq + 1);
      else map[kv] = "";
    });
  };
  eat(base);
  eat(extra);
  return Object.entries(map).map(([k, v]) => (v ? k + "=" + v : k)).join(";") + ";";
}

function roleStyle(role) {
  const key = String(role || "").toLowerCase();
  const pal = ROLE_PALETTE[key];
  if (!pal) {
    throw new Error(
      "Unknown role '" + role + "'. Use one of: " + ROLE_NAMES.join(", ")
    );
  }
  return "fillColor=" + pal.fillColor + ";strokeColor=" + pal.strokeColor + ";";
}

/**
 * Resolve a `preset:` shorthand ("aws.lambda", "db postgres", "flow.decision")
 * against the bundled shape catalog. Documented since v1 but never implemented;
 * without it every vendor icon required the model to recall an exact
 * `shape=mxgraph.*` string, which is the "Vendor Icon Defaults" complaint.
 * Returns null when nothing matches, so the caller can fail loudly.
 */
function resolvePreset(name) {
  const hits = searchShapes(String(name || "").replace(/[._/-]+/g, " "));
  return hits.length ? hits[0] : null;
}

/** Estimated on-screen width of a single-line label at the default font. */
function labelWidth(label) {
  const longest = String(label || "")
    .split(/\n|<br\s*\/?>/)
    .reduce((m, l) => Math.max(m, l.length), 0);
  return longest * CHAR_W + LABEL_PAD;
}

function geomOf(cell) {
  const g = cell.querySelector("mxGeometry");
  if (!g) return null;
  return {
    x: parseFloat(g.getAttribute("x") || "0"),
    y: parseFloat(g.getAttribute("y") || "0"),
    w: parseFloat(g.getAttribute("width") || "0"),
    h: parseFloat(g.getAttribute("height") || "0"),
    el: g,
  };
}

function opAddNode(doc, root, op) {
  if (!op.id) throw new Error("add_node requires id");
  if (findCell(root, op.id)) throw new Error("Cell already exists: " + op.id);

  let style = op.style;
  let w = op.w;
  let h = op.h;

  if (op.role) style = mergeStyle(style || "rounded=1;whiteSpace=wrap;html=1;", roleStyle(op.role));

  if (op.preset) {
    const shape = resolvePreset(op.preset);
    if (!shape) {
      throw new Error(
        "Unknown preset '" + op.preset + "'. Call drawio_shape_search to find one, " +
          "or pass an explicit style string."
      );
    }
    // A role is a colour, a preset is a shape; a node may want both, and the
    // role must survive the preset rather than be overwritten by it.
    style = op.role ? mergeStyle(shape.style, roleStyle(op.role)) : style || shape.style;
    if (w === undefined) w = shape.w;
    if (h === undefined) h = shape.h;
    // Report what the fuzzy match actually resolved to: a preset that lands on
    // the wrong vendor icon is otherwise invisible until the render.
    op.resolvedShape = shape.name;
  }

  // Size to the label when the caller did not ask for a size. A 160px box under
  // a 24-character label is the single most common source of clipped text.
  if (w === undefined) w = Math.max(DEFAULT_W, snap(labelWidth(op.label)));
  if (h === undefined) h = DEFAULT_H;

  const cell = doc.createElement("mxCell");
  cell.setAttribute("id", op.id);
  cell.setAttribute("value", op.label || "");
  cell.setAttribute("style", style || "rounded=1;whiteSpace=wrap;html=1;");
  cell.setAttribute("vertex", "1");
  cell.setAttribute("parent", op.parent || "1");

  const geo = doc.createElement("mxGeometry");
  // Snap here rather than asking the model to round: off-grid coordinates are
  // invisible in text and obvious on the canvas.
  geo.setAttribute("x", String(snap(op.x)));
  geo.setAttribute("y", String(snap(op.y)));
  geo.setAttribute("width", String(snap(w)));
  geo.setAttribute("height", String(snap(h)));
  geo.setAttribute("as", "geometry");
  cell.appendChild(geo);

  root.appendChild(cell);
}

function opAddEdge(doc, root, op) {
  if (!op.source) throw new Error("add_edge requires source");
  if (!op.target) throw new Error("add_edge requires target");
  if (!findCell(root, op.source)) throw new Error("Source not found: " + op.source);
  if (!findCell(root, op.target)) throw new Error("Target not found: " + op.target);

  const id = op.id || "e." + op.source.replace(/^n\./, "") + "__" + op.target.replace(/^n\./, "");
  if (findCell(root, id)) throw new Error("Edge already exists: " + id);

  const cell = doc.createElement("mxCell");
  cell.setAttribute("id", id);
  cell.setAttribute("value", op.label || "");
  cell.setAttribute("style", op.style || "edgeStyle=orthogonalEdgeStyle;rounded=1;");
  cell.setAttribute("edge", "1");
  cell.setAttribute("source", op.source);
  cell.setAttribute("target", op.target);
  cell.setAttribute("parent", op.parent || "1");

  // Anchors at creation time, so a symmetric pair of edges out of one shape can
  // be built in the same call that creates them rather than corrected after.
  applyAnchor(cell, "exit", op);
  applyAnchor(cell, "entry", op);

  const geo = doc.createElement("mxGeometry");
  geo.setAttribute("relative", "1");
  geo.setAttribute("as", "geometry");
  // Waypoints. Documented since v1, never implemented, and the only way to
  // route an edge around a node rather than past it.
  if (Array.isArray(op.points) && op.points.length) {
    const arr = doc.createElement("Array");
    arr.setAttribute("as", "points");
    for (const p of op.points) {
      const pt = doc.createElement("mxPoint");
      pt.setAttribute("x", String(Math.round(p.x !== undefined ? p.x : p[0])));
      pt.setAttribute("y", String(Math.round(p.y !== undefined ? p.y : p[1])));
      arr.appendChild(pt);
    }
    geo.appendChild(arr);
  }
  cell.appendChild(geo);

  root.appendChild(cell);
  op.id = id; // backfill for report
}

function opSetLabel(root, op) {
  const cell = findCell(root, op.id);
  if (!cell) throw new Error("Cell not found: " + op.id);
  cell.setAttribute("value", op.label);
}

/** The edge's own mxGeometry, created (relative) if the edge has none. */
function edgeGeometry(doc, root, op, opName) {
  if (!op.id) throw new Error(opName + " requires id");
  const cell = findCell(root, op.id);
  if (!cell) throw new Error("Cell not found: " + op.id);
  if (cell.getAttribute("edge") !== "1") {
    throw new Error(op.id + " is not an edge; " + opName + " only applies to edges");
  }
  let geo = cell.querySelector("mxGeometry");
  if (!geo) {
    geo = doc.createElement("mxGeometry");
    geo.setAttribute("relative", "1");
    geo.setAttribute("as", "geometry");
    cell.appendChild(geo);
  }
  geo.setAttribute("relative", "1");
  return { cell, geo };
}

/**
 * Move an edge's label without moving anything else.
 *
 * This is the op the lint kept asking for and the API did not have. A label
 * landing on a shape used to leave only two remedies — move the endpoints, or
 * delete and re-add the edge with waypoints — both of which disturb a layout
 * to fix a piece of text. `position` slides the label along the path (-1..1,
 * 0 = middle), `dx`/`dy` nudge it in pixels, and `background` puts a fill
 * behind it for the cases where the honest answer is "it is fine there, it
 * just needs to be readable".
 */
function opSetEdgeLabel(doc, root, op) {
  const { cell, geo } = edgeGeometry(doc, root, op, "set_edge_label");

  if (op.label !== undefined) cell.setAttribute("value", String(op.label));

  if (op.position !== undefined) {
    const p = Number(op.position);
    if (isNaN(p)) throw new Error("set_edge_label position must be a number in -1..1");
    geo.setAttribute("x", String(Math.max(-1, Math.min(1, p))));
  }

  if (op.dx !== undefined || op.dy !== undefined) {
    let off = geo.querySelector('mxPoint[as="offset"]');
    if (!off) {
      off = doc.createElement("mxPoint");
      off.setAttribute("as", "offset");
      off.setAttribute("x", "0");
      off.setAttribute("y", "0");
      geo.appendChild(off);
    }
    if (op.dx !== undefined) off.setAttribute("x", String(Math.round(Number(op.dx) || 0)));
    if (op.dy !== undefined) off.setAttribute("y", String(Math.round(Number(op.dy) || 0)));
  }

  if (op.background !== undefined) {
    const value =
      op.background === false
        ? "none"
        : op.background === true
          ? "#ffffff"
          : String(op.background);
    cell.setAttribute(
      "style",
      mergeStyle(cell.getAttribute("style") || "", "labelBackgroundColor=" + value + ";")
    );
  }
}

/**
 * Replace an existing edge's waypoints. `points: []` clears them, handing the
 * edge back to draw.io's automatic routing (and to drawio_route).
 *
 * `add_edge` has always accepted `points`, but only at creation time, so the
 * documented advice "add waypoints" was impossible to follow on an edge that
 * already existed without deleting and re-creating it — which loses the id,
 * the style, and the user's undo stack.
 */
function opSetEdgePoints(doc, root, op) {
  const { geo } = edgeGeometry(doc, root, op, "set_edge_points");

  const existing = geo.querySelector('Array[as="points"]');
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  const pts = Array.isArray(op.points) ? op.points : [];
  if (!pts.length) return; // cleared — back to automatic routing

  const arr = doc.createElement("Array");
  arr.setAttribute("as", "points");
  for (const p of pts) {
    const x = p && p.x !== undefined ? p.x : Array.isArray(p) ? p[0] : undefined;
    const y = p && p.y !== undefined ? p.y : Array.isArray(p) ? p[1] : undefined;
    if (x === undefined || y === undefined) {
      throw new Error("set_edge_points: each point needs x and y");
    }
    const pt = doc.createElement("mxPoint");
    pt.setAttribute("x", String(Math.round(Number(x))));
    pt.setAttribute("y", String(Math.round(Number(y))));
    arr.appendChild(pt);
  }
  geo.appendChild(arr);
}

/**
 * Where a connector attaches to a shape.
 *
 * This was the last thing about a diagram the model could not say. It could
 * choose which shapes an edge joins and which waypoints the line passes
 * through, but never which side of the box it leaves from — draw.io picks a
 * floating connection point from its own perimeter logic, per edge, based on
 * relative position. That is why two replication edges out of one database can
 * leave from two different sides while the boxes underneath are perfectly
 * symmetric: the shapes were aligned and the connectors never could be.
 *
 * `side` is the readable form ("bottom") and `at` slides along that side
 * (0 = left/top end, 1 = right/bottom end), so "both leave the bottom, at 0.25
 * and 0.75" is one call each. Raw x/y stay available for anything else, and
 * "auto" hands the edge back to draw.io's floating behaviour.
 */
const ANCHOR_SIDES = {
  top: [0.5, 0],
  bottom: [0.5, 1],
  left: [0, 0.5],
  right: [1, 0.5],
};

function anchorPoint(side, at) {
  const base = ANCHOR_SIDES[String(side || "").toLowerCase()];
  if (!base) {
    throw new Error(
      "Unknown side '" + side + "'. Use top, bottom, left, right, or auto."
    );
  }
  if (at === undefined) return base;
  const f = Math.max(0, Math.min(1, Number(at)));
  if (isNaN(f)) throw new Error("Anchor `at` must be a number in 0..1");
  // Slide along the side that is free to vary; the other stays pinned to the edge.
  return base[1] === 0 || base[1] === 1 ? [f, base[1]] : [base[0], f];
}

/** Remove style keys entirely — mergeStyle can only add or overwrite. */
function stripStyleKeys(style, keys) {
  return (style || "")
    .split(";")
    .filter(Boolean)
    .filter((kv) => keys.indexOf(kv.split("=")[0]) === -1)
    .join(";") + ";";
}

const EXIT_KEYS = ["exitX", "exitY", "exitDx", "exitDy", "exitPerimeter"];
const ENTRY_KEYS = ["entryX", "entryY", "entryDx", "entryDy", "entryPerimeter"];

function applyAnchor(cell, which, op) {
  const isExit = which === "exit";
  const keys = isExit ? EXIT_KEYS : ENTRY_KEYS;
  const side = op[which];
  const rawX = op[which + "X"];
  const rawY = op[which + "Y"];
  if (side === undefined && rawX === undefined && rawY === undefined) return false;

  let style = cell.getAttribute("style") || "";

  if (side === "auto" || side === null) {
    cell.setAttribute("style", stripStyleKeys(style, keys));
    return true;
  }

  let x;
  let y;
  if (rawX !== undefined || rawY !== undefined) {
    x = Number(rawX);
    y = Number(rawY);
    if (isNaN(x) || isNaN(y)) {
      throw new Error(which + "X and " + which + "Y must both be numbers in 0..1");
    }
  } else {
    [x, y] = anchorPoint(side, op[which + "At"]);
  }

  // exitDx/exitDy are pixel nudges on top of the relative point. Always write
  // them as 0: draw.io leaves stale values in place otherwise, and an edge that
  // silently starts 12px off its stated anchor is worse than no anchor at all.
  cell.setAttribute(
    "style",
    mergeStyle(stripStyleKeys(style, keys), [
      which + "X=" + Math.max(0, Math.min(1, x)),
      which + "Y=" + Math.max(0, Math.min(1, y)),
      which + "Dx=0",
      which + "Dy=0",
    ].join(";") + ";")
  );
  return true;
}

function opSetEdgeAnchor(doc, root, op) {
  const { cell } = edgeGeometry(doc, root, op, "set_edge_anchor");
  const a = applyAnchor(cell, "exit", op);
  const b = applyAnchor(cell, "entry", op);
  if (!a && !b) {
    throw new Error(
      "set_edge_anchor needs at least one of exit/entry (side name or 'auto'), " +
        "or exitX+exitY / entryX+entryY."
    );
  }
}

/**
 * Re-size a node to its own label, using the same rule add_node applies at
 * creation. Renaming a node used to mean hand-computing a width, or nudging
 * with set_geometry until the text stopped clipping.
 */
function opResizeToFit(root, op) {
  if (!op.id) throw new Error("resize_to_fit requires id");
  const cell = findCell(root, op.id);
  if (!cell) throw new Error("Cell not found: " + op.id);
  if (cell.getAttribute("vertex") !== "1") {
    throw new Error(op.id + " is not a vertex; resize_to_fit only applies to nodes");
  }
  const geo = cell.querySelector("mxGeometry");
  if (!geo) throw new Error("No geometry on " + op.id);

  const label = cell.getAttribute("value") || "";
  const pad = op.padding === undefined ? 0 : Number(op.padding) || 0;
  const minW = op.minW === undefined ? DEFAULT_W : Number(op.minW);
  const w = Math.max(minW, snap(labelWidth(label) + pad));
  geo.setAttribute("width", String(w));

  // Height only grows, and only for wrapped multi-line labels: shrinking a box
  // the user deliberately made tall is not "fitting".
  const lines = String(label).split(/\n|<br\s*\/?>/).length;
  if (lines > 1) {
    const need = snap(DEFAULT_H + (lines - 1) * 20);
    if (need > parseFloat(geo.getAttribute("height") || "0")) {
      geo.setAttribute("height", String(need));
    }
  }
  op.w = w;
}

function opSetStyle(root, op) {
  const cell = findCell(root, op.id);
  if (!cell) throw new Error("Cell not found: " + op.id);
  if (op.role) op = { ...op, style: mergeStyle(op.style || "", roleStyle(op.role)) };
  // Merge is the default. Replace-by-default made the documented one-liner
  // `{op:"set_style", id:"n.auth", style:"fillColor=#f8cecc;"}` silently strip
  // rounded/whiteSpace/html and every vendor `shape=` key off the cell — a
  // recolour that reshapes the node. Pass merge:false to deliberately replace.
  if (op.merge !== false) {
    // Merge style key-value pairs into existing style
    const existing = (cell.getAttribute("style") || "").split(";").filter(Boolean);
    const map = {};
    existing.forEach((kv) => {
      const eq = kv.indexOf("=");
      if (eq > 0) map[kv.slice(0, eq)] = kv.slice(eq + 1);
      else map[kv] = "";
    });
    const additions = (op.style || "").split(";").filter(Boolean);
    additions.forEach((kv) => {
      const eq = kv.indexOf("=");
      if (eq > 0) {
        const k = kv.slice(0, eq);
        const v = kv.slice(eq + 1);
        if (v === "null" || v === "") delete map[k];
        else map[k] = v;
      }
    });
    const merged = Object.entries(map).map(([k, v]) => (v ? k + "=" + v : k)).join(";") + ";";
    cell.setAttribute("style", merged);
  } else {
    cell.setAttribute("style", op.style || "");
  }
}

function opSetGeometry(root, op) {
  const cell = findCell(root, op.id);
  if (!cell) throw new Error("Cell not found: " + op.id);
  let geo = cell.querySelector("mxGeometry");
  if (!geo) {
    geo = cell.ownerDocument.createElement("mxGeometry");
    geo.setAttribute("as", "geometry");
    cell.appendChild(geo);
  }
  if (op.x !== undefined) geo.setAttribute("x", String(op.x));
  if (op.y !== undefined) geo.setAttribute("y", String(op.y));
  if (op.w !== undefined) geo.setAttribute("width", String(op.w));
  if (op.h !== undefined) geo.setAttribute("height", String(op.h));
}

function opMoveBy(root, op) {
  if (!op.ids || !op.ids.length) throw new Error("move_by requires ids");
  const dx = op.dx || 0;
  const dy = op.dy || 0;
  for (const id of op.ids) {
    const cell = findCell(root, id);
    if (!cell) throw new Error("Cell not found: " + id);
    const geo = cell.querySelector("mxGeometry");
    if (!geo) continue;
    const x = parseFloat(geo.getAttribute("x") || "0");
    const y = parseFloat(geo.getAttribute("y") || "0");
    geo.setAttribute("x", String(Math.round(x + dx)));
    geo.setAttribute("y", String(Math.round(y + dy)));
  }
}

function opDelete(root, op) {
  if (!op.ids || !op.ids.length) throw new Error("delete requires ids");
  const toDelete = new Set(op.ids);

  // Also delete edges that reference deleted nodes
  const cells = root.querySelectorAll("mxCell");
  cells.forEach((c) => {
    if (c.getAttribute("edge") === "1") {
      const src = c.getAttribute("source");
      const tgt = c.getAttribute("target");
      if (toDelete.has(src) || toDelete.has(tgt)) {
        toDelete.add(c.getAttribute("id"));
      }
    }
  });

  toDelete.forEach((id) => {
    const cell = findCell(root, id);
    if (cell && cell.parentNode) cell.parentNode.removeChild(cell);
  });
}

function opAdopt(root, op) {
  const cell = findCell(root, op.id);
  if (!cell) throw new Error("Cell not found: " + op.id);
  if (op.newId) {
    if (findCell(root, op.newId)) throw new Error("Target ID already exists: " + op.newId);
    // Update all references to old ID
    const allCells = root.querySelectorAll("mxCell");
    allCells.forEach((c) => {
      if (c.getAttribute("source") === op.id) c.setAttribute("source", op.newId);
      if (c.getAttribute("target") === op.id) c.setAttribute("target", op.newId);
      if (c.getAttribute("parent") === op.id) c.setAttribute("parent", op.newId);
    });
    cell.setAttribute("id", op.newId);
  }
  if (op.label !== undefined) cell.setAttribute("value", op.label);
  if (op.style !== undefined) cell.setAttribute("style", op.style);
}

/**
 * align — snap a group to a shared edge or centre line.
 * `axis`: "left" | "right" | "hcenter" | "top" | "bottom" | "vcenter".
 * Documented in the design doc and SKILL.md since v1; previously fell through
 * to "Unknown op", which rejects the whole batch atomically.
 */
function opAlign(root, op) {
  if (!op.ids || op.ids.length < 2) throw new Error("align requires at least 2 ids");
  const axis = op.axis || "left";
  const items = op.ids.map((id) => {
    const cell = findCell(root, id);
    if (!cell) throw new Error("Cell not found: " + id);
    const g = geomOf(cell);
    if (!g) throw new Error("Cell has no geometry: " + id);
    return g;
  });

  const set = (g, k, v) => g.el.setAttribute(k, String(snap(v)));

  switch (axis) {
    case "left": {
      const x = Math.min(...items.map((g) => g.x));
      items.forEach((g) => set(g, "x", x));
      break;
    }
    case "right": {
      const r = Math.max(...items.map((g) => g.x + g.w));
      items.forEach((g) => set(g, "x", r - g.w));
      break;
    }
    case "hcenter": {
      const c = items.reduce((a, g) => a + g.x + g.w / 2, 0) / items.length;
      items.forEach((g) => set(g, "x", c - g.w / 2));
      break;
    }
    case "top": {
      const y = Math.min(...items.map((g) => g.y));
      items.forEach((g) => set(g, "y", y));
      break;
    }
    case "bottom": {
      const b = Math.max(...items.map((g) => g.y + g.h));
      items.forEach((g) => set(g, "y", b - g.h));
      break;
    }
    case "vcenter": {
      const c = items.reduce((a, g) => a + g.y + g.h / 2, 0) / items.length;
      items.forEach((g) => set(g, "y", c - g.h / 2));
      break;
    }
    default:
      throw new Error(
        "align: axis must be left|right|hcenter|top|bottom|vcenter, got " + axis
      );
  }
}

/**
 * distribute — even gaps along one axis, preserving order and the outer bounds.
 * `gap` forces a fixed clear gap instead (never below MIN_GAP), which is what
 * you want when adding siblings rather than tidying an existing row.
 */
function opDistribute(root, op) {
  if (!op.ids || op.ids.length < 2) throw new Error("distribute requires at least 2 ids");
  const axis = op.axis === "vertical" ? "vertical" : "horizontal";
  const items = op.ids
    .map((id) => {
      const cell = findCell(root, id);
      if (!cell) throw new Error("Cell not found: " + id);
      const g = geomOf(cell);
      if (!g) throw new Error("Cell has no geometry: " + id);
      return g;
    })
    .sort((a, b) => (axis === "horizontal" ? a.x - b.x : a.y - b.y));

  const pos = (g) => (axis === "horizontal" ? g.x : g.y);
  const size = (g) => (axis === "horizontal" ? g.w : g.h);
  const key = axis === "horizontal" ? "x" : "y";

  let gap;
  if (op.gap !== undefined) {
    gap = Math.max(MIN_GAP, Number(op.gap));
  } else {
    const first = items[0];
    const last = items[items.length - 1];
    const span = pos(last) + size(last) - pos(first);
    const occupied = items.reduce((a, g) => a + size(g), 0);
    gap = Math.max(MIN_GAP, (span - occupied) / (items.length - 1));
  }

  let cursor = pos(items[0]);
  for (const g of items) {
    g.el.setAttribute(key, String(snap(cursor)));
    cursor += size(g) + gap;
  }
}

/**
 * grid_layout — place a set of cells into rows/cols on the grid. The cheap
 * answer to "add four replicas": one op instead of four hand-computed
 * coordinates, which is where per-node arithmetic errors come from.
 */
function opGridLayout(root, op) {
  if (!op.ids || !op.ids.length) throw new Error("grid_layout requires ids");
  const cols = Math.max(1, Number(op.cols || op.ids.length));
  const items = op.ids.map((id) => {
    const cell = findCell(root, id);
    if (!cell) throw new Error("Cell not found: " + id);
    const g = geomOf(cell);
    if (!g) throw new Error("Cell has no geometry: " + id);
    return g;
  });

  const colW = Math.max(...items.map((g) => g.w)) + Math.max(MIN_GAP, Number(op.hgap || MIN_GAP));
  const rowH = Math.max(...items.map((g) => g.h)) + Math.max(MIN_GAP, Number(op.vgap || MIN_GAP));
  const x0 = op.x !== undefined ? Number(op.x) : Math.min(...items.map((g) => g.x));
  const y0 = op.y !== undefined ? Number(op.y) : Math.min(...items.map((g) => g.y));

  items.forEach((g, i) => {
    g.el.setAttribute("x", String(snap(x0 + (i % cols) * colW)));
    g.el.setAttribute("y", String(snap(y0 + Math.floor(i / cols) * rowH)));
  });
}

// --- Page ops ------------------------------------------------
//
// These edit the page LIST. They go through the same pipeline as any other op,
// which matters: a page-set change forces `load` rather than `merge`, and
// loadPreservingPage puts the user back on the page they were watching.

function diagramsOf(doc) {
  const out = [];
  doc.querySelectorAll("diagram").forEach((d) => out.push(d));
  return out;
}

function uniquePageId(doc, wanted) {
  const taken = new Set(diagramsOf(doc).map((d) => d.getAttribute("id")));
  if (wanted) {
    // An explicit id that collides is an error, not something to paper over:
    // draw.io refuses to load a file with duplicate page IDs, so silently
    // renaming it would move the failure to the push, where it reads as a
    // canvas problem.
    if (taken.has(wanted)) throw new Error("A page with id '" + wanted + "' already exists");
    return wanted;
  }
  let n = taken.size + 1;
  let id = "page-" + n;
  while (taken.has(id)) id = "page-" + ++n;
  return id;
}

/** Insert `diagram` at `index` (clamped); appends when index is not given. */
function insertDiagramAt(doc, mxfile, diagram, index) {
  const existing = diagramsOf(doc);
  if (index === undefined || index === null || index >= existing.length) {
    mxfile.appendChild(diagram);
    return existing.length;
  }
  const at = Math.max(0, Number(index));
  mxfile.insertBefore(diagram, existing[at]);
  return at;
}

function newPageNode(doc, id, name) {
  const diagram = doc.createElement("diagram");
  diagram.setAttribute("id", id);
  diagram.setAttribute("name", name);

  const model = doc.createElement("mxGraphModel");
  const root = doc.createElement("root");
  const c0 = doc.createElement("mxCell");
  c0.setAttribute("id", "0");
  const c1 = doc.createElement("mxCell");
  c1.setAttribute("id", "1");
  c1.setAttribute("parent", "0");
  root.appendChild(c0);
  root.appendChild(c1);
  model.appendChild(root);
  diagram.appendChild(model);
  return diagram;
}

function opAddPage(doc, op) {
  const mxfile = doc.querySelector("mxfile");
  if (!mxfile) throw new Error("Missing <mxfile>");
  const id = uniquePageId(doc, op.id);
  const name = op.name || id;
  const diagram = newPageNode(doc, id, name);
  const index = insertDiagramAt(doc, mxfile, diagram, op.index);
  return { id, name, index };
}

function opRenamePage(doc, op) {
  if (!op.name) throw new Error("rename_page requires `name`");
  const pages = pagesOfDoc(doc);
  const idx = resolvePage(pages, op.page !== undefined ? op.page : op.id);
  const diagram = diagramsOf(doc)[idx];
  diagram.setAttribute("name", op.name);
  return { id: pages[idx].id, name: op.name };
}

function opDeletePage(doc, op) {
  const pages = pagesOfDoc(doc);
  if (pages.length < 2) {
    throw new Error("Cannot delete the only page — a document must keep one.");
  }
  const idx = resolvePage(pages, op.page !== undefined ? op.page : op.id);
  const diagram = diagramsOf(doc)[idx];
  diagram.parentNode.removeChild(diagram);
  return { id: pages[idx].id, name: pages[idx].name };
}

/**
 * Copy a page, cells and all.
 *
 * Cell ids are rewritten. Two pages may legally hold the same id, but nothing
 * good comes of it: `delete`, `set_label` and every other op takes a bare id,
 * and with a duplicate in the file the op would hit whichever page it resolved
 * first. References (parent/source/target) are remapped along with the ids.
 */
function opDuplicatePage(doc, op) {
  const mxfile = doc.querySelector("mxfile");
  if (!mxfile) throw new Error("Missing <mxfile>");
  const pages = pagesOfDoc(doc);
  const idx = resolvePage(pages, op.page !== undefined ? op.page : op.id);
  const source = diagramsOf(doc)[idx];

  const id = uniquePageId(doc, op.newId);
  const copy = source.cloneNode(true);
  copy.setAttribute("id", id);
  const name = op.name || (pages[idx].name || pages[idx].id) + " copy";
  copy.setAttribute("name", name);

  const suffix = "-" + id;
  const map = {};
  const cells = [];
  copy.querySelectorAll("mxCell").forEach((c) => cells.push(c));
  for (const c of cells) {
    const old = c.getAttribute("id");
    if (old === null || old === "0" || old === "1") continue;
    map[old] = old + suffix;
  }
  for (const c of cells) {
    const old = c.getAttribute("id");
    if (map[old]) c.setAttribute("id", map[old]);
    for (const attr of ["parent", "source", "target"]) {
      const ref = c.getAttribute(attr);
      if (ref && map[ref]) c.setAttribute(attr, map[ref]);
    }
  }

  const index = insertDiagramAt(doc, mxfile, copy, op.index !== undefined ? op.index : idx + 1);
  return { id, name, from: pages[idx].id, index };
}

function opMovePage(doc, op) {
  const mxfile = doc.querySelector("mxfile");
  if (!mxfile) throw new Error("Missing <mxfile>");
  const pages = pagesOfDoc(doc);
  const from = resolvePage(pages, op.page !== undefined ? op.page : op.id);
  if (op.to === undefined || op.to === null) throw new Error("move_page requires `to` (target index)");
  const to = Math.max(0, Math.min(pages.length - 1, Number(op.to)));

  const diagram = diagramsOf(doc)[from];
  diagram.parentNode.removeChild(diagram);
  const rest = diagramsOf(doc);
  if (to >= rest.length) mxfile.appendChild(diagram);
  else mxfile.insertBefore(diagram, rest[to]);

  return { id: pages[from].id, from, to };
}

// --- Geometry helpers for the readability lint ----------------
//
// What remains of a 300-line layered layout engine. The engine ranked nodes,
// inserted dummy chains, ran barycenter sweeps and emitted its own waypoints —
// a worse reimplementation of something the canvas already has. draw.io's
// embed protocol exposes `{action:"layout"}`, backed by ELK (`elkLayered` is
// Sugiyama with NETWORK_SIMPLEX layering and orthogonal edge routing) plus two
// passes that move no shapes at all: `orthogonalEdge`/libavoid for
// obstacle-avoiding connector routing and `mxParallelEdgeLayout` for spreading
// overlapping connectors. See bridgeLayout / toolRoute / toolArrange.
//
// These two predicates survive because the *lint* still needs them: reporting
// that an edge passes through a node is a local geometric question, and the
// answer is what tells the model to call drawio_route.

/**
 * Liang-Barsky segment/rect clip.
 *
 * The previous implementation had the `den` sign convention inverted, so it
 * took the "leaving" branch for an entering edge and returned false for every
 * segment. Nothing caught it: it was only ever consumed by the auto-layout
 * scorer, where "no edge passes through any shape" reads as a good result. A
 * scorer that cannot fail is not a scorer, which is its own argument for
 * deleting that engine in favour of ELK.
 */
function segIntersectsRect(p, q, r) {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  let t0 = 0;
  let t1 = 1;
  const edges = [
    [-dx, p.x - r.x],
    [dx, r.x + r.w - p.x],
    [-dy, p.y - r.y],
    [dy, r.y + r.h - p.y],
  ];
  for (const [pk, qk] of edges) {
    if (pk === 0) {
      if (qk < 0) return false; // parallel and outside this slab
      continue;
    }
    const t = qk / pk;
    if (pk < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t0 <= t1;
}

function segsCross(a1, a2, b1, b2) {
  // Strict crossing only. Sign-0 means an endpoint lies on the other segment —
  // two connectors meeting or touching, not crossing. Treating that as a
  // crossing made every fan-out at a shared node read as a tangle.
  const d = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const s = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  return (
    s(d(a1, a2, b1)) * s(d(a1, a2, b2)) < 0 &&
    s(d(b1, b2, a1)) * s(d(b1, b2, a2)) < 0
  );
}

// --- Shape catalog (curated subset) --------------------------

const SHAPE_CATALOG = [
  // AWS
  { name: "AWS Lambda", keywords: ["aws", "lambda", "function", "serverless"], style: "outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#ED7100;strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.lambda;", w: 78, h: 78 },
  { name: "AWS S3", keywords: ["aws", "s3", "storage", "bucket"], style: "outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#3F8624;strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.bucket;", w: 75, h: 78 },
  { name: "AWS EC2", keywords: ["aws", "ec2", "instance", "compute", "server"], style: "outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#ED7100;strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.instance2;", w: 78, h: 78 },
  { name: "AWS API Gateway", keywords: ["aws", "api", "gateway"], style: "outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#E7157B;strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.api_gateway;", w: 78, h: 78 },
  { name: "AWS RDS", keywords: ["aws", "rds", "database", "relational"], style: "outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#C925D1;strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.rds;", w: 78, h: 78 },
  { name: "AWS DynamoDB", keywords: ["aws", "dynamodb", "nosql", "database"], style: "outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#C925D1;strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.dynamodb;", w: 78, h: 78 },
  { name: "AWS SQS", keywords: ["aws", "sqs", "queue", "message"], style: "outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#E7157B;strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.sqs;", w: 78, h: 78 },
  { name: "AWS SNS", keywords: ["aws", "sns", "notification", "topic"], style: "outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#E7157B;strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.sns;", w: 78, h: 78 },
  { name: "AWS CloudFront", keywords: ["aws", "cloudfront", "cdn"], style: "outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#8C4FFF;strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.cloudfront;", w: 78, h: 78 },
  { name: "AWS ECS", keywords: ["aws", "ecs", "container"], style: "outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#ED7100;strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.ecs;", w: 78, h: 78 },
  // GCP
  { name: "GCP Cloud Functions", keywords: ["gcp", "google", "cloud", "function", "serverless"], style: "shape=mxgraph.gcp2.cloud_functions;html=1;whiteSpace=wrap;fillColor=#5184F3;strokeColor=none;verticalLabelPosition=bottom;verticalAlign=top;fontSize=12;", w: 60, h: 60 },
  { name: "GCP Cloud Storage", keywords: ["gcp", "google", "storage", "bucket"], style: "shape=mxgraph.gcp2.cloud_storage;html=1;whiteSpace=wrap;fillColor=#5184F3;strokeColor=none;verticalLabelPosition=bottom;verticalAlign=top;fontSize=12;", w: 60, h: 60 },
  { name: "GCP Compute Engine", keywords: ["gcp", "google", "compute", "vm", "server"], style: "shape=mxgraph.gcp2.compute_engine;html=1;whiteSpace=wrap;fillColor=#5184F3;strokeColor=none;verticalLabelPosition=bottom;verticalAlign=top;fontSize=12;", w: 60, h: 60 },
  // Azure
  { name: "Azure Functions", keywords: ["azure", "function", "serverless"], style: "aspect=fixed;html=1;align=center;shadow=0;dashed=0;image;fontSize=12;image=img/lib/mscae/Azure_Functions.svg;verticalLabelPosition=bottom;verticalAlign=top;", w: 50, h: 50 },
  { name: "Azure VM", keywords: ["azure", "vm", "virtual machine", "compute"], style: "aspect=fixed;html=1;align=center;shadow=0;dashed=0;image;fontSize=12;image=img/lib/mscae/Virtual_Machine.svg;verticalLabelPosition=bottom;verticalAlign=top;", w: 50, h: 50 },
  // Kubernetes
  { name: "Kubernetes Pod", keywords: ["k8s", "kubernetes", "pod"], style: "shape=mxgraph.kubernetes.pod;html=1;whiteSpace=wrap;shadow=0;fontSize=12;verticalLabelPosition=bottom;verticalAlign=top;", w: 50, h: 48 },
  { name: "Kubernetes Service", keywords: ["k8s", "kubernetes", "service", "svc"], style: "shape=mxgraph.kubernetes.svc;html=1;whiteSpace=wrap;shadow=0;fontSize=12;verticalLabelPosition=bottom;verticalAlign=top;", w: 50, h: 48 },
  { name: "Kubernetes Deployment", keywords: ["k8s", "kubernetes", "deployment", "deploy"], style: "shape=mxgraph.kubernetes.deploy;html=1;whiteSpace=wrap;shadow=0;fontSize=12;verticalLabelPosition=bottom;verticalAlign=top;", w: 50, h: 48 },
  { name: "Kubernetes Ingress", keywords: ["k8s", "kubernetes", "ingress"], style: "shape=mxgraph.kubernetes.ing;html=1;whiteSpace=wrap;shadow=0;fontSize=12;verticalLabelPosition=bottom;verticalAlign=top;", w: 50, h: 48 },
  // Generic / flowchart
  { name: "Rectangle (rounded)", keywords: ["box", "rectangle", "rounded", "service", "node"], style: "rounded=1;whiteSpace=wrap;html=1;", w: 160, h: 60 },
  { name: "Diamond (decision)", keywords: ["diamond", "decision", "branch", "if", "condition"], style: "rhombus;whiteSpace=wrap;html=1;", w: 80, h: 80 },
  { name: "Cylinder (database)", keywords: ["cylinder", "database", "db", "storage", "data store"], style: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;", w: 80, h: 100 },
  { name: "Parallelogram (I/O)", keywords: ["parallelogram", "io", "input", "output"], style: "shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;", w: 160, h: 60 },
  { name: "Cloud", keywords: ["cloud", "internet", "network", "external"], style: "ellipse;shape=cloud;whiteSpace=wrap;html=1;", w: 160, h: 100 },
  { name: "Person", keywords: ["person", "user", "actor", "human"], style: "shape=mxgraph.basic.person;html=1;whiteSpace=wrap;fillColor=#dae8fc;strokeColor=#6c8ebf;", w: 50, h: 60 },
  { name: "Container (group)", keywords: ["container", "group", "box", "swimlane", "pool"], style: "rounded=1;whiteSpace=wrap;html=1;fillColor=none;dashed=1;dashPattern=8 4;strokeWidth=2;fontSize=14;verticalAlign=top;", w: 300, h: 200 },
  // UML
  { name: "UML Class", keywords: ["uml", "class", "object"], style: "swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=26;fillColor=none;horizontalStack=0;resizeParent=1;resizeParentMax=0;collapsible=1;marginBottom=0;whiteSpace=wrap;html=1;", w: 200, h: 120 },
  // Network
  { name: "Server", keywords: ["server", "host", "machine", "rack"], style: "shape=mxgraph.networks.server;html=1;whiteSpace=wrap;verticalLabelPosition=bottom;verticalAlign=top;", w: 50, h: 75 },
  { name: "Firewall", keywords: ["firewall", "security", "wall"], style: "shape=mxgraph.networks.firewall;html=1;whiteSpace=wrap;verticalLabelPosition=bottom;verticalAlign=top;", w: 50, h: 65 },
  { name: "Router", keywords: ["router", "network", "routing"], style: "shape=mxgraph.networks.router;html=1;whiteSpace=wrap;verticalLabelPosition=bottom;verticalAlign=top;", w: 55, h: 35 },
  { name: "Switch", keywords: ["switch", "network", "ethernet"], style: "shape=mxgraph.networks.switch;html=1;whiteSpace=wrap;verticalLabelPosition=bottom;verticalAlign=top;", w: 55, h: 25 },
  { name: "Load Balancer", keywords: ["load balancer", "lb", "balancer"], style: "shape=mxgraph.networks.load_balancer;html=1;whiteSpace=wrap;verticalLabelPosition=bottom;verticalAlign=top;", w: 50, h: 50 },
];

function searchShapes(query) {
  const q = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!q.length) return [];

  const scored = SHAPE_CATALOG.map((s) => {
    let score = 0;
    for (const term of q) {
      if (s.name.toLowerCase().includes(term)) score += 3;
      for (const kw of s.keywords) {
        if (kw.includes(term)) score += 2;
        if (kw === term) score += 3;
      }
    }
    return { ...s, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  return scored.map((s) => ({ name: s.name, style: s.style, w: s.w, h: s.h }));
}

// --- Tool implementations -----------------------------------

async function toolInit(args) {
  await ensureBridge({ skipRestore: true });

  state.docName = args.name || "untitled";

  // How to treat whatever is already on the canvas:
  //   "adopt"   — take the live document as the editing base, push nothing.
  //   "replace" — load args.xml (or a blank diagram) over the canvas.
  //   "auto"    — default. Replace only when the caller supplied xml or the
  //               canvas is empty; otherwise adopt.
  //
  // The old unconditional push made a bare drawio_init() destructive: it blanked
  // whatever the user had drawn. The canvas is a cache, but it is also the thing
  // the human is looking at and working in — clearing it is never the safe default.
  const mode = args.mode || "auto";
  if (mode !== "adopt" && mode !== "replace" && mode !== "auto") {
    return { success: false, error: "mode must be 'adopt', 'replace' or 'auto'" };
  }

  // Always read the canvas first: every branch below needs to know whether it
  // is about to destroy user work.
  let live = null;
  try {
    live = await bridgePullXml();
  } catch (_) {
    /* fresh or unreadable canvas — treat as empty */
  }
  const liveCanonical = live ? canonicalize(live.xml) : "";
  const liveCells = (liveCanonical.match(/^[VE]/gm) || []).length;
  const livePages = (liveCanonical.match(/^P/gm) || []).length;

  const adoptState = (xml, canonical, rev, resultMode, note) => {
    state.baseXml = xml;
    state.base = canonical;
    state.lastAppliedXml = xml;
    state.lastApplied = canonical;
    state.syncedRev = rev;
    state.initialized = true;
    state.turnSynced = false;
    state.history = [];
    state.turnCount = 0;
    // A fresh load selects the first page (setFileData: urlParams["page"] || 0).
    // An adopt of what is already on screen keeps whatever bridgePullXml read.
    if (!state.activePage || resultMode !== "adopt") {
      state.activePage = pagesOf(xml)[0] || null;
    }
    return {
      success: true,
      mode: resultMode,
      rev: state.syncedRev,
      stats: {
        cells: (canonical.match(/^[VE]/gm) || []).length,
        pages: (canonical.match(/^P/gm) || []).length,
      },
      name: state.docName,
      verified: true,
      note,
    };
  };

  // 1. Adopt an existing document.
  if (mode === "adopt" || (mode === "auto" && !args.xml && liveCells > 0)) {
    if (!live) {
      return { success: false, error: "Cannot adopt: the canvas could not be read." };
    }
    if (liveCells === 0) {
      // On an empty canvas, we must push a load action so embed.diagrams.net
      // transitions out of 'waiting for load' state and unlocks its File menu and UI.
      await bridgePushLoad(EMPTY_DIAGRAM);
      const canonical = canonicalize(EMPTY_DIAGRAM);
      const verified = await verifyCanvas(canonical);
      return adoptState(
        EMPTY_DIAGRAM,
        canonical,
        verified.rev,
        "adopt",
        "Initialized blank canvas. File UI unlocked.",
      );
    }
    return adoptState(
      live.xml,
      liveCanonical,
      live.rev,
      "adopt",
      "Adopted the document already on the canvas (" + liveCells + " cells, " +
        livePages + " page(s)). Nothing was overwritten.",
    );
  }

  // 2. Canvas is blank but we still hold the document — a tab reload or an
  //    iframe rebuild. Restore instead of blanking. ensureBridge skipped this
  //    because init historically pushed its own document.
  if (mode === "auto" && !args.xml && liveCells === 0 && state.lastAppliedXml) {
    await bridgePushLoad(state.lastAppliedXml);
    const restored = canonicalize(state.lastAppliedXml);
    const verifiedRestore = await verifyCanvas(restored);
    return adoptState(
      state.lastAppliedXml,
      restored,
      verifiedRestore.rev,
      "restore",
      "Canvas was empty; restored the document from session state.",
    );
  }

  // 3. Replace. Refuse to silently blank a populated canvas.
  if (!args.xml && liveCells > 0 && args.force !== true) {
    return {
      success: false,
      error:
        "Refusing to blank a canvas that already holds " + liveCells + " cells. " +
        "Use mode:'adopt' to edit it, pass xml to load a different diagram, " +
        "or force:true to deliberately start from blank.",
      cells: liveCells,
    };
  }

  const xml = args.xml || EMPTY_DIAGRAM;
  const validation = validate(xml);
  if (validation.errors.length) {
    return { success: false, error: "Invalid XML: " + validation.errors.join("; ") };
  }

  await bridgePushLoad(xml);

  state.baseXml = xml;
  state.base = canonicalize(xml);
  state.lastAppliedXml = xml;
  state.lastApplied = state.base;
  state.syncedRev = -1;
  state.initialized = true;
  state.turnSynced = false;
  state.history = [];
  state.turnCount = 0;

  // Confirm the canvas really holds what we sent.
  const verified = await verifyCanvas(state.base);
  state.syncedRev = verified.rev;

  return {
    success: true,
    mode: "replace",
    rev: state.syncedRev,
    stats: validation.stats,
    name: state.docName,
    verified: verified.match,
  };
}

async function toolSync() {
  await ensureBridge();

  if (!state.initialized) {
    return {
      error:
        "Not initialized. Run the drawio-live skill from the Skills panel to " +
        "attach a canvas — do not try to recover it with drawio_init.",
    };
  }

  // Active pull
  const pulled = await bridgePullXml();
  const liveXml = pulled.xml;
  const liveCanonical = canonicalize(liveXml);

  // Diff against what AI last pushed
  const rawDiff = diffCanonical(state.lastApplied || "", liveCanonical);
  const userDiff = buildChangeset(rawDiff, state.lastApplied);

  // Adopt: this is now the editing base
  state.baseXml = liveXml;
  state.base = liveCanonical;
  state.syncedRev = pulled.rev;
  state.turnSynced = true;
  state.turnCount++;

  const pages = pagesOf(liveXml);
  const result = {
    userDiff,
    canonical: liveCanonical,
    stats: { cells: (liveCanonical.match(/^[VE]/gm) || []).length, pages: pages.length },
    rev: pulled.rev,
  };

  // On a multi-page document, which page the user is watching is as much a
  // part of "what changed since your last turn" as the cells are: it is where
  // unscoped ops will land.
  if (pages.length > 1) {
    result.pages = pages;
    result.activePage = state.activePage || null;
    if (pulled.currentPage === null) {
      result.pageNote =
        "This draw.io build does not report the selected page, so ops default " +
        "to page 1. Pass `page` on drawio_ops to be certain.";
    }
  }

  // Renders are opt-in. A full-resolution canvas export is 100k+ tokens of
  // base64 once it lands in conversation history, and it lands there on every
  // turn thereafter. Call drawio_render explicitly when pixels are needed.
  if (userDiff.added.length || userDiff.removed.length || userDiff.changed.length) {
    result.renderAvailable = true;
  }

  return result;
}

// Turn boundary. `state.turnSynced` is what makes "sync before every edit" a
// mechanical rule rather than a convention, but nothing inside the MCP can see
// where a user turn ends. `scripts/pre_send.js` runs at exactly that boundary
// and calls this, so the gate is armed once per turn instead of once per
// session — which is all the old code did, leaving every turn after the first
// free to edit against a stale base.
async function toolBeginTurn() {
  const wasSynced = state.turnSynced;
  state.turnSynced = false;
  return { ok: true, initialized: state.initialized, wasSynced };
}

/**
 * Attach the "act on this" instruction to any result that carries lint.
 *
 * This used to live in scripts/guardrail.js, which was the wrong module for it
 * in two ways. It spent the engine's output-override retry allowance on pushes
 * that had actually succeeded, and — more seriously — a guardrail can be a
 * stale build (the loader reports "already loaded, skipping" and keeps the
 * previous session's script), so the one message that decides whether the model
 * reaches for the cheap fix or the expensive one was riding on the least
 * reliable artifact in the system. Here it is generated by the same module that
 * computed the warnings, so it cannot drift away from them.
 *
 * Applies to route and arrange too. Those return lint as well and the guardrail
 * never escalated them, which mattered because route is the last call of most
 * turns.
 */
function withLint(result, warnings) {
  if (!Array.isArray(warnings) || !warnings.length) return result;
  return {
    ...result,
    lintDirective:
      "LAYOUT LINT — " + warnings.length + " issue(s) on the canvas you just " +
      "pushed. Address them before you reply to the user, cheapest fix first. " +
      "A label on a shape or over its own connector is set_edge_label (dx/dy, " +
      "or position) — it moves text, not structure. A connector attaching to " +
      "the wrong side of a box is set_edge_anchor. An edge through a shape is " +
      "drawio_route, which moves nothing. Only a clipped label or a genuine " +
      "vertex overlap justifies moving a shape, and drawio_arrange only when " +
      "the structure itself is tangled — ask the user first if they arranged " +
      "the diagram. If a warning is a deliberate choice, say so in your reply " +
      "instead of silently leaving it.",
  };
}

async function toolOps(args) {
  await ensureBridge();

  if (!state.initialized) return { error: "Not initialized" };
  if (!state.turnSynced) return { error: "Must call drawio_sync before drawio_ops" };

  const ops = args.ops;
  if (!Array.isArray(ops) || !ops.length) return { error: "ops must be a non-empty array" };

  // Apply ops to current base. Unscoped ops land on the page the user is
  // looking at — "add a box" means this page when they are staring at page 3.
  const defaultPage = args.page !== undefined && args.page !== null && args.page !== ""
    ? args.page
    : defaultPageRef();
  let result;
  try {
    result = applyOps(state.baseXml, ops, defaultPage);
  } catch (e) {
    return { error: e.message };
  }
  const newXml = result.xml;

  // Validate
  const validation = validate(newXml);
  if (validation.errors.length) {
    return { error: "Validation failed after ops: " + validation.errors.join("; "), report: result.report };
  }

  // No "you did not run a layout" warning here. Nagging about a call the model
  // might not need is how the previous design ended up applying a full
  // re-layout to diagrams that only had a routing problem. The lint reports
  // what it can actually SEE — edges through nodes, crossings, collisions —
  // and names the cheapest fix.

  // Drift guard: check if the user edited during our turn (content-confirmed).
  const drift = await checkDrift();
  if (drift) return drift;

  // Push the complete document (see pushDocument: merge is a reconcile,
  // so a partial payload would delete everything omitted from it).
  const newCanonical = canonicalize(newXml);
  let pushMethod;
  try {
    pushMethod = await pushDocument(newXml, newCanonical);
  } catch (e) {
    return { error: "Push to canvas failed: " + e.message, report: result.report };
  }

  // Update state
  state.lastAppliedXml = newXml;
  state.lastApplied = newCanonical;
  state.baseXml = newXml;
  state.base = newCanonical;

  const verified = lastPushVerify || (await verifyCanvas(newCanonical));
  state.syncedRev = verified.rev;

  // Record history
  state.history.push({
    turn: state.turnCount,
    summary: "ops: " + ops.map((o) => o.op + " " + (o.id || o.ids || "")).join(", "),
    appliedXml: newXml,
    ts: Date.now(),
  });
  if (state.history.length > HISTORY_MAX) state.history.shift();

  // No image here, and no `render` flag. MCP callTool results are text-only
  // (skill_api.md: `content: Array<{type:"text", text}>`), so a base64 PNG
  // returned from this tool is JSON.stringify'd into prose — full token price,
  // zero pixels reaching the model. That is the exact leak §6.5 of the design
  // doc warned about, one layer further up than where it was fixed. Vision goes
  // through takeScreenshot, which is a core browser tool and arrives as a real
  // image; geometry goes through drawio_render({format:"svg"}), which is text
  // and meant to be read rather than seen.
  return withLint(
    {
      ok: true,
      report: result.report,
      lint: validation.warnings,
      rev: state.syncedRev,
      pushMethod,
      verified: verified.match,
      ...(validation.warnings.length
        ? {
            look:
              "verified is structural only. takeScreenshot() shows you the canvas; " +
              "drawio_render({format:'svg'}) gives the routed geometry as text.",
          }
        : {}),
    },
    validation.warnings
  );
}

async function toolApply(args) {
  await ensureBridge();

  if (!state.initialized) return { error: "Not initialized" };
  if (!state.turnSynced) return { error: "Must call drawio_sync before drawio_apply" };

  const xml = args.xml;
  if (!xml) return { error: "xml is required" };

  // Validate
  const validation = validate(xml);
  if (validation.errors.length) {
    return { error: "Validation failed: " + validation.errors.join("; ") };
  }

  // Drift guard (content-confirmed — see checkDrift)
  const driftApply = await checkDrift();
  if (driftApply) return driftApply;

  const newCanonical = canonicalize(xml);
  let pushMethod;
  try {
    pushMethod = await pushDocument(xml, newCanonical);
  } catch (e) {
    return { error: "Push to canvas failed: " + e.message };
  }

  state.lastAppliedXml = xml;
  state.lastApplied = newCanonical;
  state.baseXml = xml;
  state.base = newCanonical;

  const verified = lastPushVerify || (await verifyCanvas(newCanonical));
  state.syncedRev = verified.rev;

  state.history.push({
    turn: state.turnCount,
    summary: "full rewrite",
    appliedXml: xml,
    ts: Date.now(),
  });
  if (state.history.length > HISTORY_MAX) state.history.shift();

  // See toolOps: no image can survive the text-only callTool contract.
  return withLint(
    {
      ok: true,
      lint: validation.warnings,
      stats: validation.stats,
      rev: state.syncedRev,
      pushMethod,
      verified: verified.match,
      ...(validation.warnings.length
        ? {
            look:
              "verified is structural only. takeScreenshot() shows you the canvas; " +
              "drawio_render({format:'svg'}) gives the routed geometry as text.",
          }
        : {}),
    },
    validation.warnings
  );
}

// The two layout tools are deliberately separate rather than one tool with a
// mode flag, because the distinction the model needs to make is exactly
// "does this move the user's shapes or not", and a flag buries it.

/**
 * drawio_route — clean up the connectors, move nothing.
 *
 * libavoid treats every vertex as an obstacle and re-routes connectors around
 * them; mxParallelEdgeLayout spreads connectors that draw on top of each other.
 * Neither touches a shape's position, so this is safe to run over a diagram
 * the user arranged by hand — which is most of them.
 */
async function toolRoute(args) {
  await ensureBridge();
  if (!state.initialized) return { error: "Not initialized" };
  if (!state.turnSynced) return { error: "Must call drawio_sync before drawio_route" };

  const before = state.base;
  const layouts = [];
  if (args.parallels !== false) {
    layouts.push({
      layout: "mxParallelEdgeLayout",
      config: { spacing: Number(args.spacing) || 20, checkOverlap: true },
    });
  }
  if (args.route !== false) {
    layouts.push({
      layout: "orthogonalEdge",
      config: {
        shapeBufferDistance: Number(args.buffer) || 16,
        idealNudgingDistance: Number(args.nudge) || 14,
      },
    });
  }
  if (!layouts.length) return { error: "Nothing to do: both route and parallels are false" };

  let applied;
  try {
    // mxParallelEdgeLayout is an mxGraph layout, not an ELK one: it morphs for
    // longer than the shortened default settle allows, and reading coordinates
    // mid-morph yields waypoints that are still moving.
    applied = await bridgeLayout(layouts, { settle: 2500 });
  } catch (e) {
    return { error: "Routing failed: " + e.message };
  }

  const adopted = await adoptLive(before);
  const lint = validate(state.baseXml);

  state.history.push({
    turn: state.turnCount,
    summary: "route: " + layouts.map((l) => l.layout).join(" + "),
    appliedXml: state.baseXml,
    ts: Date.now(),
  });
  if (state.history.length > HISTORY_MAX) state.history.shift();

  // route is the last call of most turns, so a warning surfaced here is the
  // last chance to catch it before the model writes its reply.
  return withLint(
    {
      ok: true,
      applied: applied.applied,
      passes: layouts.map((l) => l.layout),
      changed: adopted.changeset.summary,
      lint: lint.warnings,
      rev: adopted.rev,
      note: "Connectors re-routed. No shape was moved.",
    },
    lint.warnings
  );
}

// Two layout engines, because ELK is a plugin: the public editor ships it, many
// self-hosted builds of draw.io do not, and there is no way to feature-detect
// it from outside the iframe — an unavailable layout is silently a no-op. The
// mxGraph layouts are part of the core and are always present. Deployments that
// lack ELK set `layout-engine: mx` in SKILL.md once; a caller can also override
// per call with drawio_arrange({engine}).
const ARRANGE_ALGORITHMS = {
  elk: {
    layered: "elkLayered",
    tree: "elkTree",
    radial: "elkRadial",
    organic: "elkOrganic",
    stress: "elkStress",
  },
  mx: {
    layered: "mxHierarchicalLayout",
    tree: "mxCompactTreeLayout",
    radial: "mxCircleLayout",
    organic: "mxFastOrganicLayout",
    stress: "mxFastOrganicLayout",
  },
};

function layoutEngine(requested) {
  const want = String(
    requested || state.layoutEngine || configValue(serverConfig(), "layoutEngine") || "elk"
  ).toLowerCase();
  return ARRANGE_ALGORITHMS[want] ? want : "elk";
}

/** Engine-specific knobs for one named algorithm. */
function buildLayoutConfig(engine, algo, args) {
  const config = {
    // preserveOrigin defaults to false, which drops the laid-out cluster near
    // (0,0) and slides the whole diagram out from under the user's viewport.
    preserveOrigin: true,
    edgeStyle: "auto",
    corners: "rounded",
  };
  const nodeSep = Number(args.nodeSep || 40);
  const rankSep = Number(args.rankSep || 80);
  const direction = String(args.direction || "DOWN").toUpperCase();

  if (engine === "elk") {
    if (algo === "elkLayered" || algo === "elkTree" || algo === "elkRadial") {
      config["elk.direction"] = direction;
    }
    if (algo === "elkLayered") {
      config["elk.edgeRouting"] = "ORTHOGONAL";
      config["elk.layered.spacing.nodeNodeBetweenLayers"] = String(rankSep);
    }
    config["elk.spacing.nodeNode"] = String(nodeSep);
  } else {
    // mxGraph layouts take plain instance properties, not namespaced keys.
    if (algo === "mxHierarchicalLayout") {
      // orientation names the edge the roots sit on: DOWN flows from the north.
      config.orientation =
        direction === "DOWN" ? "north"
        : direction === "UP" ? "south"
        : direction === "RIGHT" ? "west"
        : "east";
      config.intraCellSpacing = nodeSep;
      config.interRankCellSpacing = rankSep;
    } else if (algo === "mxCompactTreeLayout") {
      config.horizontal = direction === "RIGHT" || direction === "LEFT";
      config.levelDistance = rankSep;
      config.nodeDistance = nodeSep;
    } else if (algo === "mxCircleLayout") {
      config.disableEdgeStyle = false;
    } else if (algo === "mxFastOrganicLayout") {
      config.forceConstant = Math.max(nodeSep * 2, 50);
    }
  }

  if (args.resizeNodes) config.resizeNodes = true;
  if (Array.isArray(args.rootIds) && args.rootIds.length) config.rootCellIds = args.rootIds;
  return config;
}

/**
 * drawio_arrange — re-place every shape. Destructive to the user's composition,
 * so it is never automatic and never a side effect of an edit.
 */
async function toolArrange(args) {
  await ensureBridge();
  if (!state.initialized) return { error: "Not initialized" };
  if (!state.turnSynced) return { error: "Must call drawio_sync before drawio_arrange" };

  const engine = layoutEngine(args.engine);
  const name = String(args.algorithm || "layered").toLowerCase();
  const algo = ARRANGE_ALGORITHMS[engine][name];
  if (!algo) {
    return {
      error:
        "Unknown algorithm '" + args.algorithm + "'. Use one of: " +
        Object.keys(ARRANGE_ALGORITHMS[engine]).join(", "),
    };
  }

  const config = buildLayoutConfig(engine, algo, args);

  const layouts = [{ layout: algo, config }];
  // Spreading overlapping connectors afterwards is the standard composition and
  // costs nothing; a node layout positions shapes, it does not de-duplicate
  // parallel runs.
  if (args.parallels !== false) {
    layouts.push({ layout: "mxParallelEdgeLayout", config: { spacing: 20, checkOverlap: true } });
  }

  const before = state.base;
  let applied;
  try {
    // mxGraph morphs for longer than ELK does; reading coordinates too early
    // yields mid-animation geometry.
    applied = await bridgeLayout(layouts, { settle: engine === "mx" ? 2500 : undefined });
  } catch (e) {
    return { error: "Arrange failed: " + e.message };
  }

  const adopted = await adoptLive(before);
  const lint = validate(state.baseXml);

  state.history.push({
    turn: state.turnCount,
    summary: "arrange: " + algo + " " + (config["elk.direction"] || config.orientation || ""),
    appliedXml: state.baseXml,
    ts: Date.now(),
  });
  if (state.history.length > HISTORY_MAX) state.history.shift();

  return withLint(
    {
      ok: true,
      algorithm: algo,
      engine,
      applied: applied.applied,
      changed: adopted.changeset.summary,
      lint: lint.warnings,
      rev: adopted.rev,
      note:
        "Every shape was re-placed. If the user had arranged things deliberately, " +
        "drawio_history({index, xml:true}) + drawio_apply restores the previous state.",
      // An unavailable layout is a silent no-op inside draw.io, and ELK is a
      // plugin this deployment may simply not have. Say so rather than leaving
      // the caller to conclude the diagram was already perfect.
      hint:
        !applied.applied && engine === "elk"
          ? "Nothing moved. If this draw.io deployment ships without the ELK " +
            "plugin, retry with drawio_arrange({engine:'mx'}), or set " +
            "`layout-engine: mx` on the drawio_bridge server in SKILL.md."
          : undefined,
    },
    lint.warnings
  );
}

async function toolValidate(args) {
  const xml = args.xml;
  if (!xml) return { error: "xml is required" };
  return validate(xml);
}

/**
 * draw.io's `export` event answers with a data URI for every format, SVG
 * included — `data:image/svg+xml;base64,PHN2Zy...`. Handing that back as-is
 * makes the "SVG is text you can read" claim false: the model gets base64 at
 * full token price and cannot read a byte of it, which is precisely the failure
 * the PNG path was deleted for. Decode it here, once.
 */
function svgFromExport(data) {
  const s = String(data || "");
  if (s.slice(0, 200).indexOf("<svg") !== -1) return s; // already markup
  const m = /^data:image\/svg\+xml([^,]*),([\s\S]*)$/i.exec(s);
  if (!m) return null;
  const isB64 = /;base64/i.test(m[1]);
  if (!isB64) return decodeURIComponent(m[2]);
  // atob yields a binary string, one char per byte. Diagram labels are often
  // non-ASCII, so re-decode the bytes as UTF-8 rather than trusting that.
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * drawio_render — SVG only, and deliberately so.
 *
 * An MCP tool result is `content: [{type:"text", text}]` and nothing else, so
 * every value returned from here is JSON.stringify'd. A PNG therefore arrives
 * at the model as ~1,200 tokens of escaped base64 that it cannot see: the
 * worst possible trade. Pixels come from takeScreenshot(), which is a core
 * browser tool and lands in context as an actual image.
 *
 * SVG survives the text channel intact, and is not a consolation prize: it
 * carries the *routed* geometry — waypoints, and where an edge label actually
 * ended up after drawio_route — which the canonical form does not.
 */
async function toolRender(args) {
  await ensureBridge();
  if (!state.initialized) return { error: "Not initialized" };

  const format = String((args && args.format) || "svg").toLowerCase();
  if (format !== "svg") {
    return {
      error:
        "drawio_render produces SVG only. A PNG cannot reach you through a tool " +
        "result — it would arrive as base64 text, at full token cost, unreadable. " +
        "Call takeScreenshot() to look at the canvas, or drawio_save({target:" +
        "'download', format:'png'}) to hand the user a file.",
    };
  }

  // SVG export renders whatever page is on screen — draw.io builds it from the
  // live graph, not from the file — so rendering another page means bringing it
  // on screen first. It stays selected afterwards: the caller asked to look at
  // that page, and switching back would put the user somewhere they did not ask
  // to be a second time.
  let renderedPage = null;
  if (args && args.page !== undefined && args.page !== null && args.page !== "") {
    const pulled = await bridgePullXml();
    const pages = pagesOf(pulled.xml);
    let idx;
    try {
      idx = resolvePage(pages, args.page);
    } catch (e) {
      return { error: e.message, pages };
    }
    const res = await bridgeSelectPage(idx);
    if (!res.ok) return { error: res.error, pages };
    renderedPage = pages[idx];
  }

  const svg = svgFromExport(await bridgeExport("svg"));
  if (svg === null) {
    return {
      error:
        "draw.io returned an SVG payload in an unrecognized encoding. Use " +
        "takeScreenshot() to look at the canvas.",
    };
  }

  // A big diagram's SVG is tens of thousands of characters of path data, and
  // unlike an image it cannot be downscaled. Truncating it is worse than
  // useless — half an SVG answers nothing — so refuse and name the two tools
  // that still work at that size.
  if (svg.length > SVG_CHAR_LIMIT) {
    return {
      error:
        "SVG is " + svg.length + " characters, over the " + SVG_CHAR_LIMIT +
        " limit — mostly path data you do not need. Call takeScreenshot() to " +
        "judge the layout, or drawio_get({what:'xml'}) to read exact geometry " +
        "including the waypoints drawio_route wrote back.",
      chars: svg.length,
    };
  }

  return {
    format: "svg",
    chars: svg.length,
    data: svg,
    ...(renderedPage ? { page: renderedPage } : {}),
    ...(state.activePage && !renderedPage ? { page: state.activePage } : {}),
  };
}

/**
 * drawio_pages — list the pages, and switch which one is on screen.
 *
 * Read-only about the document: creating, renaming, deleting and reordering
 * pages are ops, because they change the file and belong in the same
 * push/verify/history pipeline as every other edit. What only this tool can do
 * is move the VIEW, which is not in the file at all.
 */
async function toolPages(args) {
  args = args || {};
  await ensureBridge();
  if (!state.initialized) return { error: "Not initialized" };

  const pulled = await bridgePullXml();
  let pages = pagesOf(pulled.xml);
  let selected = null;

  if (args.select !== undefined && args.select !== null && args.select !== "") {
    let idx;
    try {
      idx = resolvePage(pages, args.select);
    } catch (e) {
      return { error: e.message, pages };
    }
    let res;
    try {
      res = await bridgeSelectPage(idx);
    } catch (e) {
      return { error: "Page switch failed: " + e.message, pages };
    }
    if (!res.ok) return { error: res.error, pages, active: state.activePage };
    selected = pages[idx];
  }

  const active = state.activePage;
  return {
    ok: true,
    pages,
    active,
    ...(selected ? { selected } : {}),
    ...(pulled.currentPage === null
      ? {
          note:
            "This draw.io build does not report the selected page. Listing is " +
            "accurate; switching cannot be verified and is refused.",
        }
      : {}),
    hint:
      pages.length > 1
        ? "drawio_ops({page, ops}) edits a page without switching to it. " +
          "Switching is only needed for what the user (or a screenshot) sees."
        : undefined,
  };
}

/**
 * drawio_config — read, or set, which draw.io deployment this session uses.
 *
 * Setting it does not touch an open canvas: the tab is navigated by the skill
 * scripts, not from here. Change the URL first, then open the tab (which is the
 * order scripts/run.js uses), or reload an existing one.
 */
async function toolConfig(args) {
  args = args || {};
  const changing =
    args.canvasUrl !== undefined ||
    args.hostUrl !== undefined ||
    args.hosts !== undefined;

  let cfg;
  try {
    cfg = changing ? setCanvasConfig(args) : canvasConfig();
  } catch (e) {
    return { error: e.message };
  }

  if (args.layoutEngine !== undefined) {
    const want = String(args.layoutEngine).toLowerCase();
    if (!ARRANGE_ALGORITHMS[want]) {
      return { error: "layoutEngine must be 'elk' or 'mx'" };
    }
    state.layoutEngine = want;
  }

  const keys = serverConfigKeys();
  const out = {
    canvasUrl: cfg.canvasUrl,
    hostUrl: cfg.hostUrl,
    hosts: cfg.hosts,
    layoutEngine: layoutEngine(),
    attached: state.initialized,
    // Where the URL came from, and what SKILL.md actually delivered. Without
    // these, "canvas-url has no effect" cannot be told apart from "canvas-url
    // never arrived", and the two have different fixes.
    source: state.canvasSource,
    skillConfigKeys: keys,
    note:
      changing && state.initialized
        ? "Canvas URL changed while a canvas is attached. The open tab still " +
          "points at the old deployment — reopen it to use the new one."
        : undefined,
  };

  if (state.canvasSource === "default" && !configValue(serverConfig(), "canvasUrl")) {
    out.hint =
      keys.length
        ? "SKILL.md sent this server " + keys.join(", ") + " — no canvas-url among " +
          "them, so the built-in default is in use. Some builds forward only the " +
          "keys they know onto a server entry. Pass canvasUrl to this tool (the " +
          "skill's canvasUrl parameter does exactly that), or set " +
          "DEFAULT_CANVAS_ORIGIN in mcp/drawio_mcp.js to pin it."
        : "This server received no configuration from SKILL.md at all, so " +
          "canvas-url there cannot take effect. Pass canvasUrl to this tool (the " +
          "skill's canvasUrl parameter does exactly that), or set " +
          "DEFAULT_CANVAS_ORIGIN in mcp/drawio_mcp.js to pin it.";
  }

  return out;
}

async function toolGet(args) {
  if (!state.initialized) return { error: "Not initialized" };

  const what = args.what || "canonical";
  if (what === "canonical") return { text: state.base };
  if (what === "xml") return { text: state.baseXml };
  if (what === "live") {
    // Pull fresh from canvas. Return canonical alongside the raw XML: callers
    // comparing "what is on the canvas" against a diff or a base need the same
    // form the differ uses, and re-canonicalizing at every call site invites
    // exactly the mismatch this once caused in the test suite.
    await ensureBridge();
    const pulled = await bridgePullXml();
    return {
      text: pulled.xml,
      canonical: canonicalize(pulled.xml),
      rev: pulled.rev,
    };
  }
  return { error: 'Unknown what: use "canonical", "xml", or "live"' };
}

async function toolShapeSearch(args) {
  const results = searchShapes(args.query);
  if (!results.length) return { results: [], hint: "No matches. Try broader terms (e.g. 'aws', 'database', 'server')." };
  return { results };
}

/**
 * History. Previously advertised `hasXml: true` on every entry with no tool
 * anywhere that would return that XML, while SKILL.md and the design doc both
 * told the model "to revert, use drawio_apply with a previous turn's XML" — a
 * documented capability that could not be performed. Pass `xml: true` with an
 * `index` (or `turn`) to get it.
 */
async function toolHistory(args) {
  args = args || {};
  const list = state.history.map((h, i) => ({
    index: i,
    turn: h.turn,
    summary: h.summary,
    ts: h.ts,
    cells: (canonicalize(h.appliedXml).match(/^[VE]/gm) || []).length,
  }));

  if (args.xml === true) {
    let entry;
    if (args.index !== undefined) entry = state.history[Number(args.index)];
    else if (args.turn !== undefined) {
      // Several entries can share a turn number (one per ops call); the last
      // one is the state that turn actually left behind.
      for (const h of state.history) if (h.turn === Number(args.turn)) entry = h;
    } else entry = state.history[state.history.length - 1];

    if (!entry) {
      return {
        error:
          "No history entry for " +
          (args.index !== undefined ? "index " + args.index : "turn " + args.turn) +
          ". Available: " + JSON.stringify(list.map((t) => ({ index: t.index, turn: t.turn }))),
        turns: list,
      };
    }
    return {
      turn: entry.turn,
      summary: entry.summary,
      xml: entry.appliedXml,
      hint: "Revert by passing this xml to drawio_apply (drawio_sync first).",
    };
  }

  return {
    turns: list,
    currentTurn: state.turnCount,
    hint: "drawio_history({index, xml:true}) returns that turn's full XML for drawio_apply.",
  };
}

async function toolSave(args) {
  await ensureBridge();
  if (!state.initialized) return { error: "Not initialized" };

  const target = args.target || "download";
  const format = args.format || "drawio";

  if (target === "download") {
    if (format === "drawio" || format === "xml") {
      // Trigger download by injecting a download link in the canvas tab
      const xml = state.lastAppliedXml || state.baseXml || EMPTY_DIAGRAM;
      const filename = (state.docName || "diagram") + ".drawio";
      const downloadScript = `(document, __ctx, args) => {
        var blob = new Blob([args.xml], { type: "application/xml" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = args.filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
        return { ok: true };
      }`;
      await runtime.evaluateScript(downloadScript, { xml, filename }, "MAIN");
      return { ok: true, format: "drawio", filename };
    } else {
      // Export as png/svg, then download
      const data = await bridgeExport(format);
      const filename = (state.docName || "diagram") + "." + format;
      const downloadExportScript = `(document, __ctx, args) => {
        var dataStr = args.data;
        if (dataStr.startsWith("data:")) {
          dataStr = dataStr.split(",")[1];
        }
        var byteStr = atob(dataStr);
        var ab = new ArrayBuffer(byteStr.length);
        var ia = new Uint8Array(ab);
        for (var i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
        var mime = args.format === "svg" ? "image/svg+xml" : "image/png";
        var blob = new Blob([ab], { type: mime });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = args.filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
        return { ok: true };
      }`;
      await runtime.evaluateScript(downloadExportScript, { data, format, filename }, "MAIN");
      return { ok: true, format, filename };
    }
  }

  return { error: 'Unknown target: use "download"' };
}

// --- MCP contract --------------------------------------------

return {
  listTools() {
    return [
      {
        name: "drawio_init",
        description: "Attach to the draw.io canvas on the current tab. Non-destructive by default: adopts the existing diagram. Only pass xml or mode:'replace' when you intend to overwrite the canvas. If the bridge is already initialized, call drawio_sync instead.",
        displayMessage: "🎨 Initializing draw.io canvas: {{name}}",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Diagram name" },
            xml: { type: "string", description: "Diagram XML to load. Omit to keep whatever is on the canvas." },
            mode: {
              type: "string",
              enum: ["auto", "adopt", "replace"],
              description:
                "auto (default): adopt an existing non-empty canvas, otherwise load. " +
                "adopt: never write to the canvas — take what is there as the base. " +
                "replace: load xml (or blank) over whatever is there.",
            },
            force: { type: "boolean", description: "Allow mode:'replace' to blank a populated canvas." },
          },
        },
      },
      {
        name: "drawio_sync",
        description: "MANDATORY first call every AI turn. Pull current canvas state, adopt as base, return diff of user changes.",
        displayMessage: "🔄 Syncing canvas state",
        tier: "safe",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "drawio_begin_turn",
        description:
          "INTERNAL — invoked by the skill's pre-send hook at each user-message " +
          "boundary to arm the sync-before-edit gate. Never call this yourself.",
        displayMessage: "Starting a new editing turn",
        tier: "safe",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "drawio_ops",
        description:
          "Apply a batch of operations (add_node, add_edge, set_label, " +
          "set_edge_label, set_edge_points, set_edge_anchor, resize_to_fit, " +
          "set_style, set_geometry, move_by, delete, adopt, align, " +
          "distribute, grid_layout), plus the page ops add_page{name, id?, " +
          "index?}, rename_page{page, name}, delete_page{page}, " +
          "duplicate_page{page, name?, newId?} and move_page{page, to}. Cell " +
          "ops land " +
          "on the page the user is looking at unless you say otherwise: pass " +
          "`page` on the call to scope the whole batch, or `page` on a single " +
          "op to target one page — a batch may touch several. `page` accepts a " +
          "page id, a page name or a 0-based index. You do NOT need to switch " +
          "pages to edit one. Three ops fix a connector without " +
          "touching the layout: set_edge_label{id, position?, dx?, dy?, " +
          "background?} moves an edge's TEXT; set_edge_points{id, points} " +
          "re-routes one edge by hand (points:[] restores automatic routing); " +
          "set_edge_anchor{id, exit?, exitAt?, entry?, entryAt?} pins WHICH " +
          "SIDE of a shape the line attaches to (exit/entry are 'top'|'bottom'|" +
          "'left'|'right'|'auto', exitAt/entryAt slide 0..1 along that side). " +
          "add_edge accepts the same anchor fields at creation. Without an " +
          "anchor draw.io picks a floating attachment point per edge, so two " +
          "edges out of one shape can leave from different sides even when the " +
          "shapes are aligned — anchors are how a symmetric fan-out is made " +
          "symmetric. resize_to_fit{id} re-sizes a node to its own label. " +
          "add_node takes role:'compute'|'service'|'storage'|" +
          "'security'|'external'|'process'|'neutral' for the semantic palette " +
          "instead of hand-typed hex, snaps to the 10px grid, and sizes itself to " +
          "its label. Placement is yours to choose: place shapes where they belong, " +
          "then call drawio_route to tidy the connectors (it moves nothing), or " +
          "drawio_arrange for a full re-layout. Send every edit for the turn in one " +
          "call — the batch is " +
          "atomic, and each extra call costs a full LLM round trip. add_node accepts " +
          "preset:'aws.lambda' instead of a raw style string, snaps to the 10px grid, " +
          "and sizes itself to its label. set_style merges by default (merge:false to " +
          "replace). Validates and pushes to canvas; the returned `lint` array reports " +
          "overlaps, clipped labels and colliding edge labels — fix those before " +
          "replying. This tool cannot return an image: to look at the canvas call " +
          "takeScreenshot().",
        displayMessage: "✏️ Editing diagram ",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            ops: {
              type: "array",
              description:
                "Array of operation objects. Each has an 'op' field. Layout helpers: " +
                "{op:'align', ids:[...], axis:'left|right|hcenter|top|bottom|vcenter'}, " +
                "{op:'distribute', ids:[...], axis:'horizontal|vertical', gap?}, " +
                "{op:'grid_layout', ids:[...], cols, x?, y?, hgap?, vgap?}. Any " +
                "cell op may carry page:'<id|name|index>' to override the batch's page.",
              items: { type: "object" },
            },
            page: {
              type: ["string", "number"],
              description:
                "Page every op in this batch targets, as a page id, page name or " +
                "0-based index. Defaults to the page currently on screen.",
            },
          },
          required: ["ops"],
        },
      },
      {
        name: "drawio_apply",
        description: "Full-document XML rewrite. Use for structural overhauls. Resets undo stack.",
        displayMessage: "📄 Replacing diagram XML",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            xml: { type: "string", description: "Complete .drawio XML" },
          },
          required: ["xml"],
        },
      },
      {
        name: "drawio_route",
        description:
          "Tidy the connectors WITHOUT MOVING ANY SHAPE. Runs draw.io's own " +
          "libavoid obstacle-avoiding orthogonal router plus the parallel-edge " +
          "router, so edges stop cutting through shapes and stop drawing on top " +
          "of each other. Safe on a diagram the user arranged by hand — this is " +
          "the right response to a crossings or edges-through-shapes lint " +
          "warning. Call drawio_sync first.",
        displayMessage: "🧵 Routing connectors",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            buffer: { type: "number", description: "Clearance in px kept between a connector and the shapes it passes. Default 16." },
            nudge: { type: "number", description: "Separation in px between parallel segments of different connectors. Default 14." },
            spacing: { type: "number", description: "Distance in px between adjacent parallel connectors. Default 20." },
            route: { type: "boolean", description: "Run the obstacle-avoiding router. Default true." },
            parallels: { type: "boolean", description: "Spread overlapping parallel connectors. Default true." },
          },
        },
      },
      {
        name: "drawio_arrange",
        description:
          "RE-PLACES EVERY SHAPE using draw.io's layout engine. Destructive " +
          "to any arrangement the user made by hand — ask before running it on a " +
          "diagram you did not build. Use it when you created the shapes yourself " +
          "and want them positioned, or when the user asks for a re-layout. For a " +
          "diagram that only looks messy because of its connectors, use " +
          "drawio_route instead. Call drawio_sync first.",
        displayMessage: "🪄 Arranging diagram ({{algorithm}})",
        tier: "cautious",
        inputSchema: {
          type: "object",
          properties: {
            algorithm: {
              type: "string",
              enum: ["layered", "tree", "radial", "organic", "stress"],
              description:
                "layered (Sugiyama — flows, architectures, DAGs; the usual choice), " +
                "tree (org charts, hierarchies), radial, organic (force-directed; " +
                "mind maps, networks), stress. Default layered.",
            },
            direction: { type: "string", enum: ["DOWN", "UP", "RIGHT", "LEFT"], description: "Flow direction for layered/tree/radial. Default DOWN." },
            nodeSep: { type: "number", description: "Spacing between shapes in the same rank. Default 40." },
            rankSep: { type: "number", description: "Spacing between ranks (layered only). Default 80." },
            rootIds: { type: "array", items: { type: "string" }, description: "Force these cells to be roots and limit the run to their connected components." },
            resizeNodes: { type: "boolean", description: "Let the layout resize shapes to fit their labels." },
            parallels: { type: "boolean", description: "Spread overlapping parallel connectors afterwards. Default true." },
            engine: {
              type: "string",
              enum: ["elk", "mx"],
              description:
                "Layout engine. Defaults to the deployment's configured engine (elk). " +
                "Use mx on a self-hosted draw.io built without the ELK plugin, where " +
                "an elk layout silently does nothing.",
            },
          },
        },
      },
      {
        name: "drawio_validate",
        description: "Validate .drawio XML without pushing. Returns errors and warnings.",
        displayMessage: "✅ Validating diagram XML",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            xml: { type: "string", description: ".drawio XML to validate" },
          },
          required: ["xml"],
        },
      },
      {
        name: "drawio_render",
        description:
          "Export the live canvas as SVG TEXT. This is geometry to read, not a " +
          "picture to look at: it is the only way to see where an edge label or " +
          "waypoint actually landed after drawio_route, which the XML does not " +
          "record. To LOOK at the diagram, call takeScreenshot() instead — a tool " +
          "result cannot carry an image, so no PNG is available here. Renders " +
          "the page on screen; pass `page` to render another one, which brings " +
          "it on screen and leaves it there.",
        displayMessage: "🧾 Exporting diagram as SVG",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            format: { type: "string", enum: ["svg"], description: "SVG only." },
            page: {
              type: ["string", "number"],
              description:
                "Page to render, as a page id, page name or 0-based index. " +
                "Omit to render the page currently on screen.",
            },
          },
        },
      },
      {
        name: "drawio_pages",
        description:
          "List the document's pages and, optionally, bring one on screen. " +
          "Pages are created, renamed, deleted, duplicated and reordered with " +
          "drawio_ops (add_page, rename_page, delete_page, duplicate_page, " +
          "move_page) — this tool only reads them and moves the view. You do " +
          "NOT need to switch pages to edit one: drawio_ops({page}) targets any " +
          "page directly. Switch when the user asked to be shown a page, or " +
          "before a screenshot of it.",
        displayMessage: "📑 Pages",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            select: {
              type: ["string", "number"],
              description:
                "Page to bring on screen: page id, page name, or 0-based index. " +
                "Omit to only list.",
            },
          },
        },
      },
      {
        name: "drawio_config",
        description:
          "Read or set the draw.io deployment this session talks to: canvas URL, " +
          "accepted hostnames, layout engine. Called with no arguments it only " +
          "reports. The skill's scripts set it from the canvasUrl parameter before " +
          "opening the tab; you rarely need to call it yourself.",
        displayMessage: "⚙️ draw.io deployment config",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            canvasUrl: {
              type: "string",
              description:
                "Origin or full embed URL of the draw.io instance, e.g. " +
                "https://embed.diagrams.net/, http://localhost:7080, or a self-hosted " +
                "origin. The embed query is appended unless the URL already has embed=1.",
            },
            hostUrl: { type: "string", description: "Page that frames the canvas. Defaults to the canvas origin." },
            hosts: { type: "array", items: { type: "string" }, description: "Hostnames the bridge may attach to." },
            layoutEngine: { type: "string", enum: ["elk", "mx"], description: "Default engine for drawio_arrange." },
          },
        },
      },
      {
        name: "drawio_get",
        description: "Read the current diagram state as canonical text, raw XML, or live XML from canvas.",
        displayMessage: "📋 Reading diagram state",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            what: { type: "string", enum: ["canonical", "xml", "live"], description: "Which form to return" },
          },
        },
      },
      {
        name: "drawio_shape_search",
        description: "Search the shape catalog for official draw.io styles (AWS, GCP, Azure, K8s, UML, network, flowchart). The same catalog backs add_node's `preset` shorthand.",
        displayMessage: "🔍 Searching shapes: {{query}}",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search terms (e.g., 'aws lambda', 'database', 'firewall')" },
          },
          required: ["query"],
        },
      },
      {
        name: "drawio_history",
        description:
          "List past editing turns (last 10). Pass {index, xml:true} to retrieve " +
          "that turn's full document, which is the revert path: feed it to " +
          "drawio_apply.",
        displayMessage: "📜 Listing edit history",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: {
            index: { type: "number", description: "History entry index from the list." },
            turn: { type: "number", description: "Turn number; the last entry for that turn is used." },
            xml: { type: "boolean", description: "Return the entry's full XML instead of the list." },
          },
        },
      },
      {
        name: "drawio_save",
        description:
          "Save/download the diagram as .drawio, .png, or .svg. The .drawio file " +
          "holds every page; png and svg capture only the page on screen — use " +
          "drawio_pages({select}) first to choose which.",
        displayMessage: "💾 Saving diagram as {{format}}",
        tier: "mutating",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["download"], description: "Where to save" },
            format: { type: "string", enum: ["drawio", "xml", "png", "svg"], description: "File format" },
          },
        },
      },
    ];
  },

  async callTool(name, args) {
    try {
      let result;
      switch (name) {
        case "drawio_init":
          result = await toolInit(args);
          break;
        case "drawio_sync":
          result = await toolSync();
          break;
        case "drawio_begin_turn":
          result = await toolBeginTurn();
          break;
        case "drawio_ops":
          result = await toolOps(args);
          break;
        case "drawio_apply":
          result = await toolApply(args);
          break;
        case "drawio_route":
          result = await toolRoute(args);
          break;
        case "drawio_arrange":
          result = await toolArrange(args);
          break;
        case "drawio_validate":
          result = await toolValidate(args);
          break;
        case "drawio_render":
          result = await toolRender(args);
          break;
        case "drawio_pages":
          result = await toolPages(args);
          break;
        case "drawio_config":
          result = await toolConfig(args);
          break;
        case "drawio_get":
          result = await toolGet(args);
          break;
        case "drawio_shape_search":
          result = await toolShapeSearch(args);
          break;
        case "drawio_history":
          result = await toolHistory(args);
          break;
        case "drawio_save":
          result = await toolSave(args);
          break;
        default:
          return { isError: true, content: [{ type: "text", text: "Unknown tool: " + name }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      runtime.console.error("drawio_mcp error in " + name + ":", e.message);
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e.message }) }],
      };
    }
  },
};
