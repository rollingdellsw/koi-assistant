---
name: monaco-editor
description: Interact with Monaco code editors (VS Code Web, GitHub, CodeSandbox) to accurately read, write, and manipulate code. Bypasses standard DOM limitations for virtualized editors.
mcp-servers:
  - name: monaco-editor
    script: mcp/monaco_mcp.js
---

# Monaco Editor Integrator

Read and write code inside Monaco editor instances. Monaco powers VS Code Web, GitHub pull requests, LeetCode, and many other developer tools. Standard browser tools do not work on Monaco because it virtualizes the DOM.

## Tools

| Tool                | Purpose                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `monaco_find`       | Locates all Monaco editor instances on the current page and returns their handles and metadata (language, URI, line count). |
| `monaco_read`       | Reads the full source code from a specific editor handle.                                                                   |
| `monaco_write`      | Replaces the entire content of a specific editor handle with new code.                                                      |
| `monaco_edit_lines` | Replaces selected code with new code.                                                                                       |
| `monaco_release`    | Frees the handle memory when finished.                                                                                      |

## Workflow

1. Call `monaco_find` to get a list of active editors on the page.
2. Identify the correct editor from the returned list (often there is only one).
3. Use `monaco_read` with the `handle` to get the code.
4. Use `monaco_write` to insert modified code back into the editor.
5. Use `monaco_edit_lines` to do targeted editing.
6. Call `monaco_release` when done.

## Notes

- The skill relies on `window.monaco` being exposed in the global page scope.
