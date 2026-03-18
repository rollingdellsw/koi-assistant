// skills/osd-controller/mcp/osd_mcp.js
// OpenSeadragon MCP Server

return {
  listTools() {
    return [
      {
        name: "osd_get_status",
        description: "Get viewer status including zoom level and viewport bounds",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      },
      {
        name: "osd_zoom",
        description: "Zoom the viewer to a specific level",
        inputSchema: {
          type: "object",
          properties: {
            level: {
              type: "number",
              description: "Zoom level (absolute) or multiplier (relative)"
            },
            relative: {
              type: "boolean",
              description: "If true, multiply current zoom by level"
            }
          },
          required: ["level"],
          additionalProperties: false
        }
      },
      {
        name: "osd_pan",
        description: "Pan the viewer viewport",
        inputSchema: {
          type: "object",
          properties: {
            dx: {
              type: "number",
              description: "Horizontal delta in viewport coordinates"
            },
            dy: {
              type: "number",
              description: "Vertical delta in viewport coordinates"
            }
          },
          required: ["dx", "dy"],
          additionalProperties: false
        }
      }
    ];
  },

  // Handle management
  _handle: null,

  async getViewer() {
    if (this._handle) return this._handle;

    const OSD_FINDER_SCRIPT = `() => {
      // Bootstrap handle registry if not yet injected by tool-executor
      if (!window.__deftHandles) {
        let nextId = 1;
        const registry = new Map();
        window.__deftHandles = {
          store: function(obj) { var id = "h_" + (nextId++); registry.set(id, obj); return id; },
          get: function(id) { return registry.get(id); },
          release: function(id) { return registry.delete(id); }
        };
      }

      function isViewer(obj) {
        return obj && typeof obj === 'object' && obj.viewport && obj.world && typeof obj.viewport.zoomTo === 'function';
      }
      function findViewer() {
        if (isViewer(window.viewer)) return window.viewer;
        if (isViewer(window.osd)) return window.osd;
        const selectors = ['.openseadragon-canvas', '#osd', '[data-testid="image-viewer"]', '.openseadragon-container'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (!el) continue;
          const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternal'));
          if (!key) continue;
          let fiber = el[key];
          let depth = 0;
          while (fiber && depth < 15) {
            const candidates = [
              fiber.stateNode,
              fiber.memoizedProps?.viewer,
              fiber.stateNode?.viewer,
              fiber.memoizedState?.memoizedState
            ];
            for (const item of candidates) {
              if (isViewer(item)) return item;
              if (item?.current && isViewer(item.current)) return item.current;
            }
            fiber = fiber.return;
            depth++;
          }
        }
        return null;
      }
      const viewer = findViewer();
      if (!viewer) return { error: "Viewer not found. Ensure the page has fully loaded." };
      return { handleId: window.__deftHandles.store(viewer) };
    }`;

    const res = await runtime.evaluateScript(OSD_FINDER_SCRIPT, {}, "MAIN");
    if (res.error) {
      throw new Error(`Viewer not found: ${res.error}`);
    }
    if (res.result && res.result.error) {
      throw new Error(`Viewer not found: ${res.result.error}`);
    }
    this._handle = res.result.handleId;
    return this._handle;
  },

  async callTool(name, args) {
    try {
      const handle = await this.getViewer();

      if (name === "osd_get_status") {
        const zoomVal = await runtime.invokeOnHandle(handle, "viewport.getZoom", []);
        const bounds = await runtime.invokeOnHandle(handle, "viewport.getBounds", []);
        return {
          content: [{ type: "text", text: JSON.stringify({ zoom: zoomVal.result, bounds: bounds.result }, null, 2) }]
        };
      } else if (name === "osd_zoom") {
        // Calculate target zoom
        const curZoom = await runtime.invokeOnHandle(handle, "viewport.getZoom", []);
        const target = args.relative ? (curZoom.result * args.level) : args.level;
        const res = await runtime.invokeOnHandle(handle, "viewport.zoomTo", [target]);
        return { content: [{ type: "text", text: JSON.stringify({ zoom: target }) }] };
      } else if (name === "osd_pan") {
        // PanBy takes {x,y}
        const res = await runtime.invokeOnHandle(handle, "viewport.panBy", [{ x: args.dx, y: args.dy }]);
        return { content: [{ type: "text", text: JSON.stringify({ panned: true }) }] };
      }

      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    } catch (e) {
      // If handle is stale, clear it for next time
      this._handle = null;
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  }
};
