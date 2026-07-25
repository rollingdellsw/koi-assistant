// Monaco Editor MCP Server
// Provides tools for reading and writing to Monaco editor instances on the active page.

const FINDER_SCRIPT = `() => {
  if (!window.__deftHandles) {
    let nextId = 1;
    const registry = new Map();
    window.__deftHandles = {
      store: function(obj) { var id = "h_" + (nextId++); registry.set(id, obj); return id; },
      get: function(id) { return registry.get(id); },
      release: function(id) { return registry.delete(id); }
    };
  }

  if (typeof monaco === 'undefined' || !monaco.editor) {
    return { error: "window.monaco is not exposed on this page. The editor might be heavily bundled or not present." };
  }

  const editors = monaco.editor.getEditors();
  if (!editors || editors.length === 0) {
    return { error: "No active Monaco editor instances found." };
  }

  const results = editors.map((ed, index) => {
    const model = ed.getModel();
    return {
      handle: window.__deftHandles.store(ed),
      index: index,
      language: model ? model.getLanguageId() : "unknown",
      uri: model ? model.uri.toString() : "unknown",
      lineCount: model ? model.getLineCount() : 0
    };
  });

  return { result: results };
}`;

return {
  listTools() {
    return [
      {
        name: "monaco_find",
        description: "Locate all Monaco editor instances on the page and return their handles.",
        displayMessage: "🔍 Finding Monaco editor instances",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      },
      {
        name: "monaco_read",
        description: "Read the full text content from a Monaco editor instance.",
        displayMessage: "📖 Reading code from Monaco editor",
        inputSchema: {
          type: "object",
          properties: { handle: { type: "string", description: "The handle ID returned by monaco_find" } },
          required: ["handle"],
          additionalProperties: false
        }
      },
      {
        name: "monaco_write",
        description: "Replace the entire text content of a Monaco editor instance.",
        displayMessage: "✏️ Writing code to Monaco editor",
        inputSchema: {
          type: "object",
          properties: {
            handle: { type: "string", description: "The handle ID returned by monaco_find" },
            text: { type: "string", description: "The new source code to insert" }
          },
          required: ["handle", "text"],
          additionalProperties: false
        }
      },
      {
        name: "monaco_edit_lines",
        description: "Replace specific lines of code in a Monaco editor instance.",
        displayMessage: "✏️ Editing lines {{startLine}} to {{endLine}} in Monaco editor",
        inputSchema: {
          type: "object",
          properties: {
            handle: { type: "string", description: "The handle ID returned by monaco_find" },
            startLine: { type: "number", description: "1-based starting line number" },
            endLine: { type: "number", description: "1-based ending line number (inclusive)" },
            text: { type: "string", description: "The new source code to insert in place of those lines" }
          },
          required: ["handle", "startLine", "endLine", "text"],
          additionalProperties: false
        }
      },
      {
        name: "monaco_release",
        description: "Release the editor handle from memory.",
        displayMessage: "🧹 Releasing Monaco handle",
        inputSchema: {
          type: "object",
          properties: { handle: { type: "string" } },
          required: ["handle"],
          additionalProperties: false
        }
      }
    ];
  },

  async callTool(name, args) {
    try {
      if (name === "monaco_find") {
        // Execute in MAIN world to access the global window.monaco object
        const res = await runtime.evaluateScript(FINDER_SCRIPT, {}, "MAIN");
        if (res.error) throw new Error(res.error);
        if (res.result && res.result.error) throw new Error(res.result.error);
        return { content: [{ type: "text", text: JSON.stringify(res.result.result, null, 2) }] };
      }

      if (name === "monaco_read") {
        const val = await runtime.invokeOnHandle(args.handle, "getValue", []);
        return { content: [{ type: "text", text: val.result || "" }] };
      }

      if (name === "monaco_edit_lines") {
        await runtime.invokeOnHandle(args.handle, "executeEdits", [
          "mcp",
          [{
            range: {
              startLineNumber: args.startLine,
              startColumn: 1,
              endLineNumber: args.endLine + 1,
              endColumn: 1
            },
            text: args.text + '\n'
          }]
        ]);
        return { content: [{ type: "text", text: JSON.stringify({ success: true, editedLines: `${args.startLine}-${args.endLine}` }) }] };
      }

      if (name === "monaco_write") {
        await runtime.invokeOnHandle(args.handle, "setValue", [args.text]);
        return { content: [{ type: "text", text: JSON.stringify({ success: true, writtenLength: args.text.length }) }] };
      }

      if (name === "monaco_release") {
        await runtime.releaseHandle(args.handle);
        return { content: [{ type: "text", text: JSON.stringify({ released: true, handle: args.handle }) }] };
      }

      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  }
};
