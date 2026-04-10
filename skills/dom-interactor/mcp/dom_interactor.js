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
  //
  // Uses runtime.findHandle / runtime.findHandleByGlobal, which route to
  // the background's acquire_handle tool. That tool uses
  // chrome.scripting.executeScript with a static page function — it does
  // NOT consume the page's CSP `unsafe-eval` budget, so this works on
  // hardened sites like claude.ai where the previous evaluateScript-based
  // finder failed with "Evaluating a string as JavaScript violates...".
  //
  // Both APIs are context-aware: they honor the current shadow/iframe
  // path tracked by contextManager, so callers inside enterShadow /
  // enterIframe resolve against the right root automatically.
  async _getHandle(args) {
    // sandbox-mcp resolves findHandle / findHandleByGlobal with the
    // unwrapped tool result (i.e. `{ handleId }` or `{ error }`) and
    // rejects the promise if the background reported an error, so
    // there is no `res.result` wrapping layer and no `res.error`
    // success-path to check — we only need to add the "Target not
    // found:" prefix on the rejection path.
    let res;
    try {
      res = args.selector
        ? await runtime.findHandle({ selector: args.selector })
        : await runtime.findHandleByGlobal({ path: args.global || "window" });
    } catch (e) {
      throw new Error(`Target not found: ${e.message}`);
    }
    if (!res || !res.handleId) {
      throw new Error("Target not found: finder returned no handleId");
    }
    return res.handleId;
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
