
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

const windows = [
  makeViewerWindow("w1", "slide-a.svs", false),
  makeViewerWindow("w2", "slide-b.svs", true),
];
global.document = { activeElement: null, body: {}, querySelectorAll: () => windows.map((w) => w.container) };
global.window = {};

const subject = ((document, __ctx, args) => {
  const els = [];
  const containers = document.querySelectorAll(".openseadragon-container");
  for (const c of containers) {
    const host = c.parentElement;
    if (host && els.indexOf(host) === -1) els.push(host);
  }

  function titleOf(el) {
    let node = el;
    for (let up = 0; node && up < 6; up++, node = node.parentElement) {
      const t = node.querySelector && node.querySelector(".window-title, [data-window-title]");
      if (t && t.textContent && t.textContent.trim()) return t.textContent.trim();
    }
    return null;
  }

  const want = String(args.viewer);
  let index = els.findIndex(function (el) {
    return el.id === want || (el.id && "#" + el.id === want) || titleOf(el) === want;
  });
  if (index === -1 && /^[0-9]+$/.test(want)) index = parseInt(want, 10);
  if (index < 0 || index >= els.length) {
    return { error: "No viewer matches " + JSON.stringify(args.viewer) + "." };
  }

  const el = els[index];
  const rect = el.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: Math.round(rect.left + rect.width / 2),
    clientY: Math.round(rect.top + rect.height / 2)
  };
  try { el.dispatchEvent(new PointerEvent("pointerdown", init)); } catch (e) { /* older browsers */ }
  el.dispatchEvent(new MouseEvent("mousedown", init));
  el.dispatchEvent(new MouseEvent("mouseup", init));
  return { index: index, id: el.id || null };
});
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
