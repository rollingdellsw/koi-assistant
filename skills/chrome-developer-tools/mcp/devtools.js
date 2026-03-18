// skills/chrome-developer-tools/mcp/devtools.js
// Virtual MCP server that implements Chrome DevTools capabilities via JS injection

return {
  listTools() {
    return [
      {
        name: "click",
        description: "Directly click an element via JS.",
        displayMessage: "👆 Clicking `{{selector}}`",
        inputSchema: {
          type: "object",
          properties: { selector: { type: "string" } },
          required: ["selector"]
        }
      },
      {
        name: "fill",
        description: "Directly set value of an input.",
        displayMessage: '✏️ Filling `{{selector}}` with "{{value}}"',
        inputSchema: {
          type: "object",
          properties: {
            selector: { type: "string" },
            value: { type: "string" }
          },
          required: ["selector", "value"]
        }
      },
      {
        name: "hover",
        description: "Simulate hover event.",
        displayMessage: "🖱️ Hovering `{{selector}}`",
        inputSchema: {
          type: "object",
          properties: { selector: { type: "string" } },
          required: ["selector"]
        }
      },
      {
        name: "press_key",
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
        name: "set_trap",
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
        name: "remove_trap",
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
    // Helper to run code in MAIN world
    const run = async (code, toolArgs = {}) => {
      return await runtime.evaluateScript(code, toolArgs, "MAIN");
    };

    if (name === "evaluate_script") {
      const res = await run(args.code, args.args || {});
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }

    if (name === "click") {
      const code = `(doc, ctx, args) => {
        const el = doc.querySelector(args.selector);
        if (!el) throw new Error("Element not found: " + args.selector);
        el.click();
        return "Clicked " + args.selector;
      }`;
      const res = await run(code, { selector: args.selector });
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }

    if (name === "fill") {
      const code = `(doc, ctx, args) => {
        const el = doc.querySelector(args.selector);
        if (!el) throw new Error("Element not found: " + args.selector);
        el.value = args.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return "Filled " + args.selector;
      }`;
      const res = await run(code, { selector: args.selector, value: args.value });
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }

    if (name === "hover") {
      const code = `(doc, ctx, args) => {
        const el = doc.querySelector(args.selector);
        if (!el) throw new Error("Element not found");
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        return "Hovered " + args.selector;
      }`;
      const res = await run(code, { selector: args.selector });
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }

    if (name === "press_key") {
      const code = `(doc, ctx, args) => {
        // Parse key combination (e.g., "Control+A", "Shift+Enter")
        const parts = args.key.split('+');
        const modifiers = {
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          metaKey: false
        };
        let key = parts[parts.length - 1];

        // Parse modifiers
        for (let i = 0; i < parts.length - 1; i++) {
          const mod = parts[i].toLowerCase();
          if (mod === 'control' || mod === 'ctrl') modifiers.ctrlKey = true;
          else if (mod === 'shift') modifiers.shiftKey = true;
          else if (mod === 'alt') modifiers.altKey = true;
          else if (mod === 'meta' || mod === 'cmd') modifiers.metaKey = true;
        }

        // Dispatch keydown and keyup events
        const keydownEvent = new KeyboardEvent('keydown', {
          key: key,
          code: key,
          bubbles: true,
          cancelable: true,
          ...modifiers
        });
        const keyupEvent = new KeyboardEvent('keyup', {
          key: key,
          code: key,
          bubbles: true,
          cancelable: true,
          ...modifiers
        });

        document.activeElement.dispatchEvent(keydownEvent);
        document.activeElement.dispatchEvent(keyupEvent);

        return "Pressed key: " + args.key;
      }`;
      const res = await run(code, { key: args.key });
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }

    if (name === "set_trap") {
      const code = `(doc, ctx, args) => {
        window.__deftTraps = window.__deftTraps || {};
        window.__deftTraps[args.name] = {
          trigger: args.trigger,
          filter: args.filter || null
        };
        // If trigger is 'error', ensure we have a listener (basic implementation)
        if (args.trigger === 'error' && !window.__deftErrorListenerAttached) {
           window.addEventListener('error', (e) => {
             // Logic to capture error would go here, but real implementation
             // relies on background polling or extension hooks.
             // Since we are in MCP, we set the state and rely on the
             // extension's existing content script or polling to pick it up if active.
           });
           window.__deftErrorListenerAttached = true;
        }
        return "Trap set: " + args.name;
      }`;
      const res = await run(code, args);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }

    if (name === "remove_trap") {
      const code = `(doc, ctx, args) => {
        if (window.__deftTraps) delete window.__deftTraps[args.name];
        return "Trap removed: " + args.name;
      }`;
      const res = await run(code, args);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    }

    return { isError: true, content: [{ type: "text", text: "Unknown tool: " + name }] };
  }
};
