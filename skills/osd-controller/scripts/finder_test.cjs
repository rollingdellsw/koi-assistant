
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
global.window = { OpenSeadragon: { _viewers: new Map(windows.map((w) => [w.host, w.viewer])) } };

const subject = ((document, __ctx, args) => {
  if (!window.__deftHandles) {
    let nextId = 1;
    const registry = new Map();
    window.__deftHandles = {
      store: function (o) { var id = "h_" + (nextId++); registry.set(id, o); return id; },
      get: function (id) { return registry.get(id); },
      release: function (id) { return registry.delete(id); }
    };
  }

  function isViewer(o) {
    return !!o && typeof o === "object" && o.viewport && o.world &&
      typeof o.viewport.zoomTo === "function";
  }

  // OSD appends its .openseadragon-container into viewer.element, so every
  // container's parent is a viewer host. Framework-independent, and it finds
  // every viewer rather than only the first.
  function viewerElements() {
    const els = [];
    const containers = document.querySelectorAll(".openseadragon-container");
    for (const c of containers) {
      const host = c.parentElement;
      if (host && els.indexOf(host) === -1) els.push(host);
    }
    return els;
  }

  // Walk the React hook list as well as props/stateNode: a viewer kept in a
  // useRef lives at fiber.memoizedState.<n>.memoizedState.current.
  function fromFiber(el) {
    let node = el;
    for (let up = 0; node && up < 4; up++, node = node.parentElement) {
      const key = Object.keys(node).find(
        (k) => k.startsWith("__reactFiber") || k.startsWith("__reactInternal")
      );
      if (!key) continue;
      let fiber = node[key];
      for (let depth = 0; fiber && depth < 15; depth++, fiber = fiber.return) {
        const seen = [fiber.stateNode, fiber.stateNode && fiber.stateNode.viewer];
        if (fiber.memoizedProps) seen.push(fiber.memoizedProps.viewer);
        let hook = fiber.memoizedState;
        for (let h = 0; hook && h < 20; h++, hook = hook.next) {
          seen.push(hook.memoizedState);
        }
        for (const item of seen) {
          if (isViewer(item)) return item;
          if (item && isViewer(item.current)) return item.current;
        }
      }
    }
    return null;
  }

  function viewerFor(el) {
    // OSD's own registry, when the library is reachable as a global.
    const osd = window.OpenSeadragon;
    if (osd && osd._viewers && typeof osd._viewers.get === "function") {
      const v = osd._viewers.get(el);
      if (isViewer(v)) return v;
    }
    for (const g of [window.viewer, window.osd, window.__deftOsdViewer]) {
      if (isViewer(g) && g.element === el) return g;
    }
    return fromFiber(el);
  }

  // A viewer is focused when it, or a near ancestor, carries a focus marker.
  // Deliberately explicit markers only: a false positive silently drives the
  // wrong image, which is worse than reporting no focus and asking.
  const FOCUS_SELECTOR = ".focused,.is-focused,[data-focused='true'],[data-osd-focus='true'],[aria-selected='true']";
  function isFocused(el) {
    let node = el;
    for (let up = 0; node && up < 6; up++, node = node.parentElement) {
      if (node.matches && node.matches(FOCUS_SELECTOR)) return true;
    }
    const active = document.activeElement;
    return !!active && active !== document.body && el.contains(active);
  }

  function labelFor(el) {
    let node = el;
    for (let up = 0; node && up < 6; up++, node = node.parentElement) {
      const t = node.querySelector && node.querySelector(".window-title, [data-window-title]");
      if (t && t.textContent && t.textContent.trim()) return t.textContent.trim();
    }
    return el.id || (typeof el.className === "string" ? el.className : "") || "viewer";
  }

  // A selector the capture tools can use for this viewer specifically.
  function selectorFor(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const container = el.querySelector(".openseadragon-container");
    if (container && container.id) return "#" + CSS.escape(container.id);
    return null;
  }

  const els = viewerElements();
  if (els.length === 0) {
    return { error: "No OpenSeadragon viewer on this page. Wait for a viewer to mount, or open an image first." };
  }

  const viewers = els.map(function (el, i) {
    return {
      index: i,
      id: el.id || null,
      title: labelFor(el),
      selector: selectorFor(el),
      focused: isFocused(el),
      ready: isViewer(viewerFor(el))
    };
  });

  let focusIndex = viewers.findIndex(function (v) { return v.focused; });
  if (focusIndex === -1 && viewers.length === 1) focusIndex = 0;

  if (args && args.listOnly) return { viewers: viewers, focusIndex: focusIndex };

  // An explicit target wins over focus.
  let index = focusIndex;
  const want = args ? args.viewer : null;
  if (want !== null && want !== undefined && want !== "") {
    if (typeof want === "number") {
      index = want;
    } else {
      index = viewers.findIndex(function (v) {
        return v.id === want || v.selector === want || v.title === want;
      });
      if (index === -1 && /^[0-9]+$/.test(String(want))) index = parseInt(want, 10);
    }
    if (index < 0 || index >= viewers.length) {
      return {
        viewers: viewers,
        focusIndex: focusIndex,
        error: "No viewer matches " + JSON.stringify(want) + "."
      };
    }
  }

  if (index === -1) {
    return {
      viewers: viewers,
      focusIndex: focusIndex,
      error: "No viewer is focused and the page has " + viewers.length +
        " viewers. Call osd_focus first, or pass an explicit viewer."
    };
  }

  const target = els[index];
  const instance = viewerFor(target);
  if (!isViewer(instance)) {
    return {
      viewers: viewers,
      focusIndex: focusIndex,
      error: "The viewer instance for '" + viewers[index].title + "' is not reachable yet; it may still be initializing."
    };
  }

  // Reuse the handle while the same viewer stays focused, so repeated calls do
  // not pile up entries in the page registry.
  const cache = window.__deftOsdHandle;
  if (cache && cache.instance === instance && window.__deftHandles.get(cache.handleId) === instance) {
    return { viewers: viewers, focusIndex: focusIndex, index: index, handleId: cache.handleId };
  }
  if (cache) window.__deftHandles.release(cache.handleId);
  const handleId = window.__deftHandles.store(instance);
  window.__deftOsdHandle = { instance: instance, handleId: handleId };
  return { viewers: viewers, focusIndex: focusIndex, index: index, handleId: handleId };
});
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
