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

  // Helper to get a handle
  async _getHandle(args) {
    // 1. Try to find the object
    const findArgs = args.selector ? { selector: args.selector } : { global: args.global || "window" };
    const res = await runtime.acquireHandle("universal", findArgs);

    if (res.error) {
      throw new Error(`Target not found: ${res.error}`);
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
