// skills/*/mcp/dom_interactor.js
// Replaces page_eval_mcp.js with CWS-compliant handle operations

return {
  listTools() {
    return [
      {
        name: "dom_get_property",
        description: "Get a property from a DOM element or global object.",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector (optional)" },
            global: { type: "string", description: "Global path like 'document.title' (optional)" },
            property: { type: "string", description: "Property to read (e.g. 'innerText', 'value')" }
          },
          required: ["property"]
        }
      },
      {
        name: "dom_call_method",
        description: "Call a method on a DOM element or global object.",
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string" },
            global: { type: "string" },
            method: { type: "string", description: "Method name (e.g. 'focus', 'click')" },
            args: {
              type: "array",
              description: "Method arguments",
              items: { type: "string" }
            }
          },
          required: ["method"]
        }
      }
    ];
  },

  // Helper to get a handle to a DOM element or global object.
  // Uses evaluateScript to find the target in the page's MAIN world
  // and store it in window.__deftHandles. The subsequent getFromHandle /
  // invokeOnHandle calls are context-aware (they resolve the correct
  // iframe frame and shadow path from the context manager stack).
  async _getHandle(args) {
    const selector = args.selector;
    const global = args.global || "window";

    // Use a function expression (not IIFE) so pageEvaluateScript calls it
    // with (document, __ctx, args). __ctx is the traversed shadow root when
    // inside a shadow DOM, or the document when at frame level.
    const FINDER_SCRIPT = `(document, __ctx) => {
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

      const sel = ${JSON.stringify(selector || "")};
      const globalPath = ${JSON.stringify(global)};

      // Use __ctx (shadow root or document) for element lookup — this is
      // what makes the finder work inside shadow DOMs.
      if (sel) {
        const el = (__ctx || document).querySelector(sel);
        if (!el) return { error: "Element not found: " + sel };
        return { handleId: window.__deftHandles.store(el) };
      }

      const parts = globalPath.split(".");
      let obj = window;
      for (let i = 0; i < parts.length; i++) {
        obj = obj[parts[i]];
        if (obj === undefined || obj === null) {
          return { error: "Global path not found: " + globalPath };
        }
      }
      return { handleId: window.__deftHandles.store(obj) };
    }`;

    const res = await runtime.evaluateScript(FINDER_SCRIPT, {}, "MAIN");
    if (res.error) throw new Error(`Target not found: ${res.error}`);
    const result = res.result !== undefined ? res.result : res;
    if (result.error) throw new Error(`Target not found: ${result.error}`);
    if (!result.handleId) throw new Error("Target not found: finder returned no handleId");
    return result.handleId;
  },

  async callTool(name, args) {
    try {
      const handle = await this._getHandle(args);

      if (name === "dom_get_property") {
        const res = await runtime.getFromHandle(handle, args.property);
        return { content: [{ type: "text", text: JSON.stringify(res.result ?? null) }] };
      }

      if (name === "dom_call_method") {
        const res = await runtime.invokeOnHandle(handle, args.method, args.args || []);
        return { content: [{ type: "text", text: JSON.stringify(res.result ?? null) }] };
      }

      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  }
};
