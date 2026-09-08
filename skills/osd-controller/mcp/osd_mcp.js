// skills/osd-controller/mcp/osd_mcp.js
// OpenSeadragon MCP Server — focus-aware.
//
// A page may host several OSD viewers at once (a windowed gallery, a
// comparison view). Every navigation tool here operates on the FOCUSED viewer
// unless the caller names one explicitly, so the LLM never has to track which
// handle belongs to which window.

/**
 * Page-side finder. Enumerates OSD viewers, resolves which one is focused, and
 * registers a handle for it. Runs in the MAIN world because the discovery
 * logic is domain knowledge (OSD internals plus framework state), not
 * something a CSS selector can express.
 *
 * Invoked as fn(document, __ctx, args) with
 *   args = { viewer: string|number|null, listOnly: boolean }
 * Returns { viewers, focusIndex, index?, handleId?, error? }.
 */
const OSD_FINDER = `(document, __ctx, args) => {
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

  // Ensure viewport methods accept plain bounds objects from bridge calls
  if (instance.viewport && !instance.viewport.__deftPatched) {
    const vp = instance.viewport;
    const origFit = vp.fitBoundsWithConstraints;
    if (typeof origFit === "function") {
      vp.fitBoundsWithConstraints = function (bounds, immediately) {
        if (bounds && typeof bounds === "object" && typeof bounds.getCenter !== "function") {
          const OSD = window.OpenSeadragon;
          if (OSD && typeof OSD.Rect === "function") {
            bounds = new OSD.Rect(bounds.x, bounds.y, bounds.width, bounds.height, bounds.degrees || 0);
          } else {
            bounds = Object.assign({
              getAspectRatio: function () { return this.width / this.height; },
              getCenter: function () {
                const pt = { x: this.x + this.width / 2, y: this.y + this.height / 2 };
                if (OSD && typeof OSD.Point === "function") return new OSD.Point(pt.x, pt.y);
                return Object.assign(pt, {
                  plus: function (p) { return { x: this.x + p.x, y: this.y + p.y }; },
                  minus: function (p) { return { x: this.x - p.x, y: this.y - p.y }; },
                  times: function (f) { return { x: this.x * f, y: this.y * f }; },
                  divide: function (f) { return { x: this.x / f, y: this.y / f }; }
                });
              },
              clone: function () { return Object.assign({}, this); }
            }, bounds);
          }
        }
        return origFit.call(this, bounds, immediately);
      };
    }
    vp.__deftPatched = true;
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
}`;

/**
 * Dispatch a real mousedown on a viewer element so the host app's own focus
 * handling runs. We never write focus state ourselves — the app owns it.
 */
const OSD_FOCUS_CLICK = `(document, __ctx, args) => {
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
}`;

function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(message, extra) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(Object.assign({ error: message }, extra || {}), null, 2)
      }
    ]
  };
}

return {
  listTools() {
    const viewerArg = {
      type: "string",
      description:
        "Optional viewer to act on: element id, window title, or index as a string. Omit to act on the FOCUSED viewer."
    };

    return [
      {
        name: "osd_list_viewers",
        description:
          "List every OpenSeadragon viewer on the page with its index, id, title, capture selector, and which one has focus. Call this first when the page may hold more than one image.",
        displayMessage: "🔍 Listing OpenSeadragon viewers",
        tier: "safe",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      },
      {
        name: "osd_get_status",
        description:
          "Read the focused viewer's zoom, viewport bounds, home/min/max zoom, and image pixel size. Reports which viewer answered.",
        displayMessage: "📐 Reading viewer status",
        tier: "safe",
        inputSchema: {
          type: "object",
          properties: { viewer: viewerArg },
          additionalProperties: false
        }
      },
      {
        name: "osd_focus",
        description:
          "Move focus to a viewer by dispatching a real click on it, so the host app's own focus handling runs. Use before operating on a background image.",
        displayMessage: "🎯 Focusing viewer {{viewer}}",
        tier: "navigation",
        inputSchema: {
          type: "object",
          properties: {
            viewer: {
              type: "string",
              description: "Viewer element id, window title, or index as a string."
            }
          },
          required: ["viewer"],
          additionalProperties: false
        }
      },
      {
        name: "osd_zoom",
        description:
          "Zoom the focused viewer. Absolute by default; pass relative:true to multiply the current zoom (level 2 zooms in 2x, 0.5 zooms out). On large whole-slide images at high zoom the zoom still succeeds even if the return value is too big to transport back; re-read with osd_get_status if you need to confirm the new state.",
        displayMessage: "🔬 Zooming to {{level}}",
        tier: "navigation",
        inputSchema: {
          type: "object",
          properties: {
            level: {
              type: "number",
              description: "Absolute zoom, or a multiplier when relative is true."
            },
            relative: { type: "boolean", description: "Multiply the current zoom by level." },
            viewer: viewerArg
          },
          required: ["level"],
          additionalProperties: false
        }
      },
      {
        name: "osd_pan",
        description:
          "Pan the focused viewer by a delta in viewport coordinates, where 1.0 is the full width of the image at home zoom.",
        displayMessage: "🧭 Panning by ({{dx}}, {{dy}})",
        tier: "navigation",
        inputSchema: {
          type: "object",
          properties: {
            dx: { type: "number", description: "Horizontal delta in viewport coordinates." },
            dy: { type: "number", description: "Vertical delta in viewport coordinates." },
            viewer: viewerArg
          },
          required: ["dx", "dy"],
          additionalProperties: false
        }
      },
      {
        name: "osd_zoom_to_region",
        description:
          "Fit a region of the focused image into the viewport. Coordinates are 0-1 fractions of the image, the same normalized space workspace annotations use, so a region you annotated can be passed straight here. On large whole-slide images at high zoom the fit still succeeds even if the return value is too big to transport back; re-read with osd_get_status if you need to confirm the new state.",
        displayMessage: "🔎 Zooming into region",
        tier: "navigation",
        inputSchema: {
          type: "object",
          properties: {
            x: { type: "number", description: "Left edge, 0-1 fraction of image width." },
            y: { type: "number", description: "Top edge, 0-1 fraction of image height." },
            width: { type: "number", description: "Width, 0-1 fraction of image width." },
            height: { type: "number", description: "Height, 0-1 fraction of image height." },
            viewer: viewerArg
          },
          required: ["x", "y", "width", "height"],
          additionalProperties: false
        }
      },
      {
        name: "osd_reset",
        description: "Return the focused viewer to its home view, showing the whole image.",
        displayMessage: "↩️ Resetting viewer to home view",
        tier: "navigation",
        inputSchema: {
          type: "object",
          properties: { viewer: viewerArg },
          additionalProperties: false
        }
      }
    ];
  },

  /**
   * Resolve the viewer to act on. Deliberately re-run on every call: focus can
   * move between calls, and a cached handle would silently drive the wrong
   * image.
   */
  async _resolve(target) {
    const res = await runtime.evaluateScript(
      OSD_FINDER,
      { viewer: target === undefined ? null : target, listOnly: false },
      "MAIN"
    );
    const out = res && res.result !== undefined ? res.result : res;
    if (!out) throw new Error("Viewer discovery returned nothing.");
    if (out.error) {
      const err = new Error(out.error);
      err.viewers = out.viewers;
      throw err;
    }
    return { handle: out.handleId, viewer: out.viewers[out.index], viewers: out.viewers };
  },

  async _invoke(handle, method, args) {
    const res = await runtime.invokeOnHandle(handle, method, args || []);
    if (res && res.error) throw new Error(`${method} failed: ${res.error}`);
    return res ? res.result : undefined;
  },

  async _readState(handle) {
    const zoom = await this._invoke(handle, "viewport.getZoom", []);
    const bounds = await this._invoke(handle, "viewport.getBounds", []);
    const homeZoom = await this._invoke(handle, "viewport.getHomeZoom", []);
    const minZoom = await this._invoke(handle, "viewport.getMinZoom", []);
    const maxZoom = await this._invoke(handle, "viewport.getMaxZoom", []);
    return {
      zoom,
      homeZoom,
      minZoom,
      maxZoom,
      bounds: bounds
        ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
        : null
    };
  },

  /**
   * Call a mutating viewport method, swallowing the one failure mode that is
   * NOT a real failure.
   *
   * OSD's mutating viewport methods (zoomTo, panBy, goHome,
   * fitBoundsWithConstraints, applyConstraints) return `this` — the whole
   * viewport. Returning that across the sandbox boundary structured-clones
   * every attached tile canvas, which blows past Chrome's 64 MiB postMessage
   * limit on high-zoom whole-slide captures. The method has already run and
   * mutated the viewer in-page; only the (huge) return value failed to cross
   * the boundary. So we post back a tiny acknowledgement instead of `this`,
   * and treat a size-overflow as success. Callers read the resulting state via
   * _readState / osd_get_status.
   */
  async _mutate(handle, method, args) {
    try {
      await this._invoke(handle, method, args || []);
    } catch (e) {
      const m = String((e && e.message) || e);
      if (/exceeded maximum allowed size|message exceeded|64\s*mib|structured clone/i.test(m)) {
        return; // mutation applied; only the return value was too large to carry
      }
      throw e;
    }
  },

  async _imageSize(handle) {
    const res = await runtime.getFromHandle(handle, "world._items.0.source.dimensions");
    if (!res || res.error || !res.result) return null;
    const d = res.result;
    return typeof d.x === "number" && typeof d.y === "number" ? { width: d.x, height: d.y } : null;
  },

  async callTool(name, args) {
    args = args || {};
    try {
      if (name === "osd_list_viewers") {
        const res = await runtime.evaluateScript(
          OSD_FINDER,
          { viewer: null, listOnly: true },
          "MAIN"
        );
        const out = res && res.result !== undefined ? res.result : res;
        if (!out) return fail("Viewer discovery returned nothing.");
        if (out.error) return fail(out.error);
        return ok({
          viewers: out.viewers,
          focused: out.focusIndex === -1 ? null : out.viewers[out.focusIndex]
        });
      }

      if (name === "osd_focus") {
        const res = await runtime.evaluateScript(
          OSD_FOCUS_CLICK,
          { viewer: args.viewer },
          "MAIN"
        );
        const out = res && res.result !== undefined ? res.result : res;
        if (!out) return fail("Focus click returned nothing.");
        if (out.error) return fail(out.error);
        // Confirm the app actually moved focus rather than assuming it did.
        const resolved = await this._resolve(undefined);
        return ok({
          focused: resolved.viewer,
          matchedRequest: resolved.viewer.index === out.index,
          viewers: resolved.viewers
        });
      }

      const resolved = await this._resolve(args.viewer);
      const handle = resolved.handle;
      const viewer = resolved.viewer;

      if (name === "osd_get_status") {
        const state = await this._readState(handle);
        const imageSize = await this._imageSize(handle);
        return ok(Object.assign({ viewer }, state, { imageSize }));
      }

      if (name === "osd_zoom") {
        const previousZoom = await this._invoke(handle, "viewport.getZoom", []);
        const target = args.relative ? previousZoom * args.level : args.level;
        await this._mutate(handle, "viewport.zoomTo", [target]);
        await this._mutate(handle, "viewport.applyConstraints", []);
        const state = await this._readState(handle);
        return ok(Object.assign({ viewer, previousZoom }, state));
      }

      if (name === "osd_pan") {
        const before = await this._invoke(handle, "viewport.getCenter", []);
        await this._mutate(handle, "viewport.panBy", [{ x: args.dx, y: args.dy }]);
        await this._mutate(handle, "viewport.applyConstraints", []);
        const center = await this._invoke(handle, "viewport.getCenter", []);
        const state = await this._readState(handle);
        return ok(
          Object.assign(
            {
              viewer,
              previousCenter: before ? { x: before.x, y: before.y } : null,
              center: center ? { x: center.x, y: center.y } : null
            },
            state
          )
        );
      }

      if (name === "osd_zoom_to_region") {
        const size = await this._imageSize(handle);
        if (!size) {
          return fail("Image dimensions are unavailable; the image may not be open yet.", { viewer });
        }
        // Image pixels -> viewport coordinates, so callers stay in normalized
        // image space and never have to reason about OSD's coordinate system.
        const rect = await this._invoke(handle, "viewport.imageToViewportRectangle", [
          args.x * size.width,
          args.y * size.height,
          args.width * size.width,
          args.height * size.height
        ]);
        if (!rect) return fail("Could not convert that region to viewport coordinates.", { viewer });
        await this._mutate(handle, "viewport.fitBoundsWithConstraints", [rect, false]);
        const state = await this._readState(handle);
        return ok(
          Object.assign(
            {
              viewer,
              region: { x: args.x, y: args.y, width: args.width, height: args.height },
              imageSize: size
            },
            state
          )
        );
      }

      if (name === "osd_reset") {
        await this._mutate(handle, "viewport.goHome", [true]);
        const state = await this._readState(handle);
        return ok(Object.assign({ viewer }, state));
      }

      return fail(`Unknown tool: ${name}`);
    } catch (e) {
      return fail(e.message, e.viewers ? { viewers: e.viewers } : undefined);
    }
  }
};
