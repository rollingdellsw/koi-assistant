"""Regenerate the page-script harnesses by inlining the template literals from
mcp/osd_mcp.js, so the tests always exercise the shipped source."""
import re, pathlib

root = pathlib.Path(__file__).resolve().parent
src = (root.parent / "mcp/osd_mcp.js").read_text()
finder = re.search(r'const OSD_FINDER = `(.*?)`;', src, re.S).group(1)
click  = re.search(r'const OSD_FOCUS_CLICK = `(.*?)`;', src, re.S).group(1)

DOM = r'''
// --- minimal fake DOM shared by both harnesses ---
function El(opts) {
  Object.assign(this, { id: "", className: "", children: [], parentElement: null, _classes: [], textContent: "" }, opts);
}
El.prototype.matches = function (sel) {
  return sel.split(",").some((s) => {
    s = s.trim();
    if (s.startsWith(".")) return this._classes.includes(s.slice(1));
    const m = s.match(/^\[([^=]+)='([^']*)'\]$/);
    return m ? this[m[1]] === m[2] : false;
  });
};
El.prototype.querySelector = function (sel) {
  const want = sel.split(",")[0].trim().replace(/^\./, "");
  const walk = (n) => {
    for (const c of n.children) {
      if (c._classes.includes(want)) return c;
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  return walk(this);
};
El.prototype.contains = function (n) { return n === this; };
El.prototype.getBoundingClientRect = function () { return { left: 10, top: 20, width: 100, height: 50 }; };
El.prototype.dispatchEvent = function (e) { (this._events = this._events || []).push(e.type); return true; };

// Mirrors the real app's DOM: .image-window[.focused] > .window-titlebar > .window-title
//                             .image-window > .window-body > #viewer-x > .openseadragon-container
function makeViewerWindow(id, title, focused) {
  const win = new El({ _classes: focused ? ["image-window", "focused"] : ["image-window"] });
  const host = new El({ id });
  const container = new El({ _classes: ["openseadragon-container"] });
  const titleEl = new El({ _classes: ["window-title"], textContent: title });
  container.parentElement = host;
  host.parentElement = win;
  titleEl.parentElement = win;
  win.children = [titleEl, host];
  host.children = [container];
  const viewer = { element: host, viewport: { zoomTo() {} }, world: {} };
  return { win, host, container, viewer };
}
global.CSS = { escape: (s) => s };
global.MouseEvent = function (type, init) { Object.assign(this, init); this.type = type; };
global.PointerEvent = function (type, init) { Object.assign(this, init); this.type = type; };

let failures = 0;
const check = (c, m) => { if (!c) { failures++; console.log("FAIL:", m); } };
'''

FINDER_TEST = r'''
const windows = [
  makeViewerWindow("w1", "slide-a.svs", false),
  makeViewerWindow("w2", "slide-b.svs", true),
];
global.document = { activeElement: null, body: {}, querySelectorAll: () => windows.map((w) => w.container) };
global.window = { OpenSeadragon: { _viewers: new Map(windows.map((w) => [w.host, w.viewer])) } };

const subject = (__SRC__);
const run = (args) => subject(global.document, global.document, args);

const list = run({ listOnly: true });
check(list.viewers.length === 2, "finds both viewers");
check(list.focusIndex === 1, "focusIndex is the .focused window");
check(list.viewers[0].title === "slide-a.svs", "title comes from .window-title");
check(list.viewers[1].selector === "#w2", "selector comes from host id");
check(list.viewers.every((v) => v.ready), "both viewer instances resolvable");

const focused = run({ viewer: null, listOnly: false });
check(focused.index === 1, "defaults to the focused viewer");
check(!!focused.handleId, "registers a handle");

check(run({ viewer: "w1", listOnly: false }).index === 0, "explicit id overrides focus");
check(run({ viewer: "slide-a.svs", listOnly: false }).index === 0, "explicit title overrides focus");
check(run({ viewer: "0", listOnly: false }).index === 0, "numeric string index works");
const bad = run({ viewer: "nope", listOnly: false });
check(!!bad.error && Array.isArray(bad.viewers), "unknown target errors and still lists viewers");

const a = run({ viewer: "w2", listOnly: false });
const b = run({ viewer: "w2", listOnly: false });
check(a.handleId === b.handleId, "handle reused across calls on the same viewer");
check(run({ viewer: "w1", listOnly: false }).handleId !== b.handleId, "different viewer gets a new handle");

// a generic .active class must NOT be read as focus
windows[1].win._classes = ["image-window", "active"];
check(run({ listOnly: true }).focusIndex === -1, "generic .active is not treated as a focus marker");

windows[1].win._classes = ["image-window"];
const none = run({ viewer: null, listOnly: false });
check(!!none.error && /No viewer is focused/.test(none.error), "ambiguous focus is an error, not a guess");

// explicit data marker is honoured
windows[0].win["data-focused"] = "true";
check(run({ listOnly: true }).focusIndex === 0, "[data-focused=true] marks focus");
delete windows[0].win["data-focused"];

global.document.querySelectorAll = () => [windows[0].container];
check(run({ viewer: null, listOnly: false }).index === 0, "a lone viewer is implicitly focused");

global.document.querySelectorAll = () => [];
check(!!run({ listOnly: true }).error, "no viewers on page is an error");

console.log(failures === 0 ? "FINDER: all assertions passed" : "FINDER: " + failures + " failure(s)");
process.exitCode = failures ? 1 : 0;
'''

CLICK_TEST = r'''
const windows = [
  makeViewerWindow("w1", "slide-a.svs", false),
  makeViewerWindow("w2", "slide-b.svs", true),
];
global.document = { activeElement: null, body: {}, querySelectorAll: () => windows.map((w) => w.container) };
global.window = {};

const subject = (__SRC__);
const run = (args) => subject(global.document, global.document, args);

const byId = run({ viewer: "w1" });
check(byId.index === 0, "focus click resolves by id");
check(windows[0].host._events.includes("mousedown"), "dispatches a real mousedown on the host element");
check(windows[0].host._events.includes("pointerdown"), "dispatches pointerdown too");

check(run({ viewer: "slide-b.svs" }).index === 1, "resolves by window title");
check(run({ viewer: "1" }).index === 1, "resolves by numeric index");
check(!!run({ viewer: "ghost" }).error, "unknown target errors");

console.log(failures === 0 ? "FOCUS CLICK: all assertions passed" : "FOCUS CLICK: " + failures + " failure(s)");
process.exitCode = failures ? 1 : 0;
'''

(root / "finder_test.cjs").write_text(DOM + FINDER_TEST.replace("__SRC__", finder))
(root / "click_test.cjs").write_text(DOM + CLICK_TEST.replace("__SRC__", click))
print("regenerated finder_test.cjs and click_test.cjs")
