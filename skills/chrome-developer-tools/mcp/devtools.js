// skills/chrome-developer-tools/mcp/devtools.js
// Virtual MCP server that implements Chrome DevTools capabilities
// Note: click/fill/hover are NOT implemented here - they are provided as
// built-in browser tools (CSP-safe via chrome.scripting.executeScript with
// function references). This MCP only provides tools that require custom logic.

return {
  listTools() {
    return [
      {
        name: "pressKey",
        description: "Press a key or key combination.",
        displayMessage: "⌨️ Pressing {{key}}",
        inputSchema: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "Key or combination (e.g., 'Enter', 'Control+A', 'Escape')"
            }
          },
          required: ["key"]
        }
      },
      {
        name: "setTrap",
        description: "Register a background listener for crashes or network failures.",
        displayMessage: "🪤 Setting {{trigger}} trap: {{name}}",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            trigger: { type: "string", enum: ["error", "network"] },
            filter: { type: "string" }
          },
          required: ["name", "trigger"]
        }
      },
      {
        name: "removeTrap",
        description: "Remove a previously set trap.",
        displayMessage: "🪤 Removing trap: {{name}}",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"]
        }
      }
    ];
  },

  async callTool(name, args) {
    // Note: click, fill, hover are NOT implemented here.
    // They are provided as built-in browser tools (tool-executor.ts → dom-tools.ts)
    // that use CSP-safe pageClick/pageFill/pageHover via chrome.scripting.executeScript.
    // This avoids the CSP violation that would occur with runtime.evaluateScript + new Function().

    if (name === "pressKey") {
      // Use evaluateScript for pressKey since it needs custom KeyboardEvent dispatch
      // This will fail on CSP-strict sites, but pressKey is less commonly used on payment forms
      const code = `(doc, ctx, args) => {
        const parts = args.key.split('+');
        const modifiers = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
        let key = parts[parts.length - 1];
        for (let i = 0; i < parts.length - 1; i++) {
          const mod = parts[i].toLowerCase();
          if (mod === 'control' || mod === 'ctrl') modifiers.ctrlKey = true;
          else if (mod === 'shift') modifiers.shiftKey = true;
          else if (mod === 'alt') modifiers.altKey = true;
          else if (mod === 'meta' || mod === 'cmd') modifiers.metaKey = true;
        }
        const evt = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, ...modifiers });
        document.activeElement.dispatchEvent(evt);
        return "Pressed: " + args.key;
      }`;
      const res = await runtime.evaluateScript(code, { key: args.key }, "MAIN");
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }

    if (name === "setTrap") {
      // Use evaluateScript for trap management (stateful, needs custom logic)
      const code = `(doc, ctx, args) => {
        window.__deftTraps = window.__deftTraps || {};
        window.__deftTraps[args.name] = { trigger: args.trigger, filter: args.filter || null };
        return "Trap set: " + args.name;
      }`;
      const res = await runtime.evaluateScript(code, args, "MAIN");
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }

    if (name === "removeTrap") {
      const code = `(doc, ctx, args) => {
        if (window.__deftTraps) delete window.__deftTraps[args.name];
        return "Trap removed: " + args.name;
      }`;
      const res = await runtime.evaluateScript(code, args, "MAIN");
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }

    // evaluateScript is also available but will fail on CSP-strict sites
    if (name === "evaluateScript") {
      const res = await runtime.evaluateScript(args.code, args.args || {}, "MAIN");
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }

    return {
      isError: true,
      content: [{
        type: "text",
        text: `Unknown tool: ${name}. Note: click/fill/hover are built-in browser tools (CSP-safe).`
      }]
    };
  }
};
