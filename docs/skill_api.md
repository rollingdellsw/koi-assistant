# Koi™ Skill API Documentation

This guide provides technical instructions for developing Skills for the Koi™ Assistant. Skills allow you to extend the LLM's capabilities with deterministic scripts, complex sub-agent orchestration, proactive context reminders, programmable guardrails, and secure external system access via the Model Context Protocol (MCP). See also: [Full guardrail guide](./guardrails_api.md) · [System reminder guide](./system_reminder.md) · [Configuration guide](./configuration.md)

---

## 1. The Sandbox Interface

When a skill script is executed via `run_browser_script`, it runs inside an isolated, secure iframe sandbox. The runtime injects three global variables into your script: `tools`, `args`, and `console`.

> **Skill folder structure:** A skill is a directory with the following layout:
>
> ```
> my-skill/
>   SKILL.md          # Required — frontmatter + documentation
>                     # Frontmatter: machine-readable config (YAML between --- delimiters)
>                     # Body (below frontmatter): LLM-facing instructions injected into the system prompt
>   scripts/           # Skill scripts executed via run_browser_script
>     main.js
>     helper.js
>   mcp/               # MCP server scripts (Local MCP)
>     my_service_mcp.js
>   resources/          # Optional binary/data files (base64-encoded in storage)
>     template.html
> ```
>
> When installed, the skill is stored in `chrome.storage.local` with scripts, MCP scripts, and resources as separate key-value maps (`scripts: Record<string, string>`, `mcpScripts: Record<string, string>`, `resources: Record<string, string>`).

### 1.1 `args`

An array of string arguments passed to the script by the LLM. Inside the sandbox, `args` is always a `string[]`. Arguments are populated differently depending on how the script is invoked:

- **LLM invocation** (`run_browser_script`): The LLM provides `args` as a string array via `run_browser_script({ script_path: "skill:scripts/main.js", args: ["val1", "val2"] })`. Access as `args[0]`, `args[1]`, etc.
- **LLM invocation** (`run_browser_script`): The LLM provides `args` as a string array via `run_browser_script({ script_path: "skill:scripts/main.js", args: ["val1", "val2"], timeout: 120000 })`. Access as `args[0]`, `args[1]`, etc.
- **Direct invocation** (`/skill` command): Skill parameter values (from the UI prompt or `--param` flags) are passed as positional strings via `Object.values(params)`. Parameter order follows the order of the `parameters` list in `SKILL.md`.
- **Delegation from background**: When the background service worker delegates `execute_isolated_script` to the sidepanel, args come from the caller (usually the LLM's `run_browser_script` call).

Scripts that need named access to parameters should destructure from the positional array (e.g., `const [url, timeout] = args;`) rather than using property access on the array object.

### 1.2 `console`

A proxy that forwards `log`, `warn`, `error`, and `info` directly to the Deft/Koi side panel UI. Objects are safely stringified to prevent sandbox escapes.

### 1.3 `tools` (The Complete Browser API)

The `tools` object exposes asynchronous methods to interact with the browser.

> **Calling convention:** Built-in browser tools use **positional arguments** with camelCase names (e.g., `tools.click(selector)`, `tools.fill(selector, value)`). MCP tools (loaded via `readSkill`) use a **single object argument** (e.g., `tools.dom_get_property({ selector, property })`). While the LLM uses `snake_case` (e.g., `search_dom`), the script API uses standard JavaScript `camelCase` (e.g., `tools.searchDom`).

The signatures below show the actual script API. For tools that accept a single object, parameters are shown as `{ key: type }`. For tools that accept positional arguments, parameters are shown as `(arg1, arg2)`.

#### Skill Management & Utilities (Built-in)

These methods are built into the script runtime. No skill needs to be loaded first.

- `await tools.readSkill({ name: string })` — Load a skill and its MCP servers into the current script's `tools` object. After calling this, newly registered MCP tools may take a moment to appear; poll with a short `while` loop. Returns `{ success: true }`.

> **Important: `readSkill` in scripts shares tools with the LLM session.**
>
> When a script calls `tools.readSkill({ name: "google-workspace" })`, the skill's MCP servers are registered into a **shared MCP router** (`getSharedMCPRouter()` in `script-runner.ts`). This router is a singleton — the same instance used by both the script sandbox and the LLM's main tool executor. Once the script finishes, the MCP tools it loaded **remain registered** and become available to the LLM for direct tool calls in subsequent conversation turns.
>
> This means:
>
> - If a skill script loads `google-workspace` to call `calendar_get_events` internally, the LLM can call `docs_create` in a later turn **without** needing a separate `read_skill("google-workspace")` call — the tools are already registered from the script's `readSkill`.
> - This is by design: it enables the two-step pattern where a script does deterministic work (loading dependencies, querying data) and the LLM follows up with reasoning-dependent tool calls using the same loaded tools.
> - The tools persist for the remainder of the session. They are not unloaded when the script completes.

- `await tools.run_subtask({ goal: string, verification_command: string, timeoutMs?: number, context_files?: string[], image_data?: Array<{base64: string, mimeType: string, filename?: string}> })` — Spawn an independent LLM agent with its own context window. Returns an MCP-style result object `{ content: [{ type: "text", text: string }], isError: boolean }`. Parse the text field as JSON to access `.content` (the agent's final response) or `.history` (full message log, fallback if content is empty). See Section 4.
- `await tools.sleep(ms: number)` — Wait for `ms` milliseconds.

#### Inspection & Context (Safe)

These tools are always available without loading any skill:

- `await tools.takeScreenshot({ selector?: string, region?: object, resolution?: string, fullPage?: boolean, format?: string })`
- `await tools.takeSnapshot({ selector?: string, mode?: "readable" | "dom" | "full", maxDepth?: number, offset?: number, verbose?: boolean })`
- `await tools.searchDom(query)` — `query` is a text string or CSS selector (e.g., `tools.searchDom('button')`, `tools.searchDom('[data-testid="email"]')`)
- `await tools.inspectElement(selector)` — returns computed styles, attributes, and event listeners
- `await tools.getContext()`
- `await tools.listPages()`
- `await tools.listConsoleMessages({ types?: string[], limit?: number })`

#### Navigation & Tab Management

- `await tools.navigatePage(url, options?)` — navigates the active tab to the given URL. The optional second argument is an object merged into the tool call (e.g., `{ waitUntil: "networkidle" }`).
- `await tools.waitFor({ event?: "load" | "networkidle", selector?: string, text?: string, timeout?: number })`
- `await tools.scrollViewport({ x?: number, y?: number, zoom?: number })` — scroll by pixel offsets (e.g., `{ y: 400 }` to scroll down 400px)
- `await tools.enterShadow(selector)` — enter a shadow DOM host
- `await tools.enterIframe(selector)` — enter an iframe (frameId is resolved automatically via marker injection + URL matching)
- `await tools.exitContext()`
- `await tools.resetContext()`
- `await tools.newPage(url)` — open a new tab with the given URL
- `await tools.selectPage(pageId)` — switch to a tab by ID (from `listPages`)
- `await tools.closePage(pageId)`

#### Interaction & Mutation

The following safe guided action is always available (no confirmation needed):

- `await tools.requestAction({ action: "click" | "fill", selector: string, value?: string, description?: string })` _(Highlights element and prompts user to act. `value` is shown as a tooltip hint; `description` provides a human-readable label for the action.)_

The following tools require the **chrome-developer-tools** skill to be loaded. Their implementation is provided by the `chrome-developer-tools` MCP server (`mcp/devtools.js`). Calling them without loading the skill will fail.

Load first: `await tools.readSkill({ name: "chrome-developer-tools" });`

- `await tools.click(selector)`
- `await tools.fill(selector, value)`
- `await tools.hover(selector)`

> **Note:** `pressKey` has a built-in CDP implementation (`tool-executor.ts` routes `press_key` to `CDPManager.pressKey`) that is always available. The `chrome-developer-tools` skill also provides a `press_key` MCP tool via JS event dispatch. When the skill is loaded, the MCP version is used. Without the skill, the built-in CDP version still works. This is different from `click`, `fill`, and `hover`, which have **no** built-in fallback and require the skill.

- `await tools.pressKey(key)` — e.g., `tools.pressKey('Enter')`, `tools.pressKey('Control+a')`. Works with or without `chrome-developer-tools` loaded (see note above).

#### Network Inspection (requires CDP debugger)

These tools are built into the extension and use Chrome's DevTools Protocol (CDP) via `chrome.debugger`. They are always available in skill scripts (wired in both the sandbox and `script-runner.ts`), but are classified as `ExtendedBrowserToolName` — meaning they are not part of the base Assistant Mode tool set exposed to the LLM for direct calls. Inside skill scripts, they work without loading any skill.

- `await tools.listNetworkRequests({ urlPattern?: string, offset?: number })`
- `await tools.getNetworkRequest(reqid)`

#### Visual Workspace

- `await tools.promptUserSelection({ prompt?: string })`
- `await tools.createWorkspace({ selector?: string, bounds?: object })`
- `await tools.setActiveWorkspace({ workspaceId: string })`
- `await tools.addWorkspaceAnnotation({ imageId: string, type: string, geometry: object, style?: object, label?: string })`
- `await tools.showWorkspaceOverlay({ imageId: string })`
- `await tools.hideWorkspaceOverlay({ imageId?: string })`
- `await tools.getImageStack()`
- `await tools.getWorkspaceState()`
- `await tools.highlightElement({ selector: string, description?: string })`
- `await tools.clearHighlight()`
- `await tools.waitForUserDone({ prompt: string })`

#### Traps (requires chrome-developer-tools skill)

- `await tools.setTrap(name, trigger, filter?)` — e.g., `tools.setTrap('my-trap', 'error', {})`. The `set_trap` tool in `devtools.js` registers the trap both in `window.__deftTraps` on the page (for in-page detection) and via the extension's background trap infrastructure (for network monitoring).
  Note: The `set_trap` and `remove_trap` tools are provided by the `chrome-developer-tools` MCP server, not as built-in browser tools.
- `await tools.removeTrap(name)` — e.g., `tools.removeTrap('my-trap')`

---

## 2. DOM Interaction: The `dom-interactor` Skill

For reading DOM properties and calling methods on page elements or JavaScript globals, use the **`dom-interactor`** shared skill. This is the standard pattern used across all skills — do not re-implement handle discovery yourself.

```javascript
// Load the shared skill — this registers dom_get_property and dom_call_method
await tools.readSkill({ name: "dom-interactor" });

// Read a property from an element
const value = await tools.dom_get_property({
  selector: "#email-input",
  property: "value",
});

// Read a property from a global object
const title = await tools.dom_get_property({
  global: "document",
  property: "title",
});

// Call a method on an element
await tools.dom_call_method({ selector: "#my-form", method: "scrollIntoView" });

// Call a method with arguments
await tools.dom_call_method({
  selector: "#my-form",
  method: "setAttribute",
  args: ["data-ready", "true"],
});
```

Both tools work transparently inside shadow DOMs and iframes — use `tools.enterShadow` / `tools.enterIframe` first to set the context, then call `dom_get_property` / `dom_call_method` as normal.

---

## 3. `run_browser_script`: Combining Determinism with AI

`run_browser_script` bridges the LLM's reasoning and traditional browser automation.

**Why use it?**
If a process is strictly deterministic (e.g., clicking 5 specific buttons to export a report), forcing the LLM to do it step-by-step wastes tokens, takes minutes, and risks hallucination. By bundling a script, the LLM simply calls `run_browser_script({ script_path: "my-skill:scripts/export.js" })` to execute the macro instantly.

### 3.0. Parameters

| Parameter     | Type     | Required | Description                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `script_path` | string   | ✅       | Script path in format `skill-name:scripts/file.js`. The skill-name prefix is required.                                                                                                                                                                                                                                                                                         |
| `args`        | string[] |          | Arguments to pass to the script. Available as `args[0]`, `args[1]`, etc. inside the script.                                                                                                                                                                                                                                                                                    |
| `timeout`     | number   |          | Execution timeout in milliseconds. Default: `240000` (4 minutes). For long-running scripts (e.g. meeting capture), set this to match the expected duration plus a buffer. Example: for a 30-minute meeting, use `2100000` ((30 + 5) × 60 × 1000). The timeout propagates through the full execution chain: `browser-dependencies.ts` → `tool-executor.ts` → sidepanel sandbox. |

**Example — long-running script with custom timeout:**

```
run_browser_script({
  script_path: "meet-notes:scripts/capture.js",
  args: ["30"],
  timeout: 2100000
})
```

### 3.1. Advanced Page Interaction: The Handle System

When interacting with complex, memory-heavy JavaScript objects on a webpage (like an OpenSeadragon viewer or a massive React state tree), serializing the entire object across the sandbox boundary will crash the browser.

Koi provides a **Handle System** to manage object references entirely on the target page. The workflow has two parts:

1. **Find & register** the object using `runtime.evaluateScript()` — your finder script runs in the page's `MAIN` world, locates the object, and stores it in `window.__deftHandles`.
2. **Operate on it by handle** using `runtime.invokeOnHandle()` and `runtime.getFromHandle()` — these call methods or read properties without ever serializing the object across the boundary.

> **Note:** The Handle System is for MCP server scripts (`mcp/*.js`) that need to interact with complex non-serializable JS objects (e.g., a WebGL viewer instance, a large React state tree). For ordinary DOM property reads and method calls, use the `dom-interactor` skill instead — it handles the handle machinery for you.

#### Object Discovery with `evaluateScript` (MCP scripts only)

The finder script is passed as a **function expression** (not an IIFE) — the runtime calls it with `(document, __ctx, args)` where `__ctx` is the current shadow root or document context. This is what makes handle-based lookups work correctly inside shadow DOMs.

```javascript
// Example: finding a DOM element or global object (from dom_interactor.js)
async _getHandle(args) {
  const selector = args.selector;

  const FINDER_SCRIPT = `(document, __ctx) => {
    // Bootstrap the handle registry if not yet injected
    if (!window.__deftHandles) {
      let nextId = 1;
      const registry = new Map();
      window.__deftHandles = {
        store: function(obj) { const id = "h_" + (nextId++); registry.set(id, obj); return id; },
        get:     function(id) { return registry.get(id); },
        release: function(id) { return registry.delete(id); }
      };
    }

    const sel = ${JSON.stringify(selector || "")};
    if (sel) {
      // Use __ctx (shadow root or document) so this works inside shadow DOMs
      const el = (__ctx || document).querySelector(sel);
      if (!el) return { error: "Element not found: " + sel };
      return { handleId: window.__deftHandles.store(el) };
    }

    // ... resolve global path, store in registry, return handleId ...
  }`;

  const res = await runtime.evaluateScript(FINDER_SCRIPT, {}, "MAIN");
  const result = res.result !== undefined ? res.result : res;
  if (result.error) throw new Error(result.error);
  return result.handleId; // e.g., "h_1"
}
```

#### Operating on Handles

Once you have a `handleId`, use the handle API methods. These operate by reference — the object is never serialized across the sandbox boundary:

```javascript
// Invoke a method on the handle (use for function calls)
await runtime.invokeOnHandle(handleId, "viewport.zoomTo", [1.5]);

// Read a primitive property (use for data access, not method calls)
const zoom = await runtime.getFromHandle(handleId, "viewport.zoom");

// Release when done
await runtime.releaseHandle(handleId);
```

> **Design principle — "Smart Skill, Dumb Pipe":** The extension core is a generic transport layer. All domain-specific logic (React Fiber traversal, OpenSeadragon detection, etc.) lives inside the skill's MCP script, not in the extension. This keeps the extension CWS-reviewable and makes skills independently evolvable.

> **Security note:** `evaluateScript` is only available to signature-verified MCP server scripts running inside the MCP sandbox (`sandbox-mcp.html`). The LLM cannot call `evaluateScript` directly — it is deliberately omitted from the browser tool set exposed to the agent.

### 3.2 MCP Runtime API Reference

Inside `mcp/*.js` scripts, the `runtime` object provides the following APIs:

| Method                                               | Description                                                                                                                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.fetch(url, options?)`                       | Authenticated HTTP proxy. Attaches the OAuth token for the server's configured scopes. Supports `options.skipAuth = true` for public APIs. Returns a standard `Response` object. |
|                                                      | Additional `options`: `responseFormat` (`"text"` or `"base64"` — use `"base64"` for binary downloads like PDFs/images), `method`, `headers`, `body`.                             |
| `runtime.evaluateScript(code, args?, worldId?)`      | Execute a function-expression string on the target page. `worldId` is `"MAIN"` (page context) or `"ISOLATED"` (default). Returns `{ result }`.                                   |
| `runtime.invokeOnHandle(handleId, methodPath, args)` | Call a method on a registered handle by dot-notation path (e.g. `"viewport.zoomTo"`).                                                                                            |
| `runtime.getFromHandle(handleId, propertyPath)`      | Read a primitive property from a registered handle by dot-notation path (e.g. `"scrollTop"`). Do **not** use for method calls.                                                   |
| `runtime.releaseHandle(handleId)`                    | Release a handle to free memory on the target page. Fire-and-forget.                                                                                                             |
| `runtime.getAuthToken(scopes?)`                      | Get a raw OAuth token for the server's configured provider. Low-level alternative to `runtime.fetch` for custom auth flows.                                                      |
| `runtime.getGoogleAuthToken(scopes?)`                | Get a raw Google OAuth token via `chrome.identity`. Low-level; prefer `runtime.fetch` for most cases.                                                                            |
| `runtime.console.log/warn/error/info(...)`           | Forward log messages to the Koi side panel. Use `runtime.console` (not the global `console`) inside MCP scripts.                                                                 |
| `runtime.config`                                     | Frozen object containing the server's config block from `SKILL.md` (e.g. `runtime.config.database`, `runtime.config.name`).                                                      |

#### MCP Server Contract

Every `mcp/*.js` script must return an object with two methods:

```javascript
// mcp/my_service_mcp.js
return {
  listTools() {
    return [
      {
        name: "my_tool",
        description: "Does something useful.",
        displayMessage: "⚙️ Doing something with {{arg}}",
        inputSchema: {
          type: "object",
          properties: { arg: { type: "string" } },
          required: ["arg"],
        },
      },
    ];
  },

  async callTool(name, args) {
    if (name === "my_tool") {
      const res = await runtime.fetch(
        `https://api.example.com/endpoint?q=${args.arg}`,
      );
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  },
};
```

`callTool` must return `{ content: Array<{ type: "text", text: string }> }` on success, or `{ isError: true, content: [...] }` on failure.

---

## 4. Orchestrating Sub-Agents with `run_subtask`

For long-running, repetitive tasks (like iterating over 100s of URLs), doing it in the main conversation thread will quickly overflow the LLM's context window.

Solve this by writing a JavaScript `for` loop in a skill script that spawns an independent **Subtask Agent** for each item.

#### Example: Iterating over multiple URLs

```javascript
// scripts/mass_analysis.js
const urlsToCheck = ["https://example.com/page1", "https://example.com/page2"];
const results = [];

for (const url of urlsToCheck) {
  await tools.navigatePage(url);
  await tools.sleep(2000);

  // Spawn an independent LLM agent with its own fresh context window
  const subtaskRes = await tools.run_subtask({
    goal: `Analyze the current page at ${url}. Find the pricing table and summarize the tiers.`,
    verification_command: "Pricing summary is generated",
    timeoutMs: 120000,
  });

  if (subtaskRes && !subtaskRes.isError && subtaskRes.content) {
    // run_subtask returns an MCP-style result: { content: [{ type: "text", text: "..." }], isError: false }
    // The text field is a JSON string — always parse it
    let summary = "";
    try {
      const parsed = JSON.parse(subtaskRes.content[0].text);
      summary = parsed.content ?? "";
      // Fallback: if content is empty, find the last non-empty assistant message
      if (!summary && Array.isArray(parsed.history)) {
        const last = parsed.history
          .slice()
          .reverse()
          .find((m) => m.role === "assistant" && m.content?.trim());
        if (last) summary = last.content;
      }
    } catch (_) {}
    results.push({ url, summary });
  }
}
return { success: true, all_results: results };
```

### Script Return Values

The final `return` statement of a skill script becomes the tool result returned to the LLM. Return a plain object — it will be JSON-serialized and presented as tool output.

```javascript
// Good: structured result the LLM can reason about
return { success: true, found: itemCount, data: results };

// Good: signal failure
return { success: false, error: "Login form not found" };
```

If a script throws an uncaught exception, the tool call returns an error result with the exception message.

### Loading Skill Dependencies in Scripts

Scripts can load other skills at runtime to access their MCP tools. After `readSkill` returns, MCP tool registration is async — poll until the tool appears:

```javascript
// Load google-workspace skill (registers gmail_*, sheets_*, etc.)
await tools.readSkill({ name: "google-workspace" });

// MCP tools register asynchronously — wait for them
let retries = 5;
while (typeof tools.gmail_get_message !== "function" && retries-- > 0) {
  await tools.sleep(500);
}
if (typeof tools.gmail_get_message !== "function") {
  return { success: false, error: "Required tools failed to register" };
}
```

---

## 5. Skills vs. MCP Servers

| Concept        | Definition                                 | Purpose                                                                                                                             |
| -------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Skill**      | The package/orchestrator (`SKILL.md`).     | Defines instructions, parameters, scripts, reminders, guardrails, and declares which tools/MCPs the LLM can use. It is the "brain." |
| **MCP Server** | The Model Context Protocol implementation. | Exposes generic tools (e.g., `postgres_query`, `onedrive_list`). It has no prompt instructions. It is the "hands."                  |

### 5.1 SKILL.md: Two Audiences, One File

`SKILL.md` serves two distinct audiences within a single file:

1. **Frontmatter (YAML between `---` delimiters)** — Machine-readable configuration consumed by the extension runtime. This declares metadata (`name`, `description`), infrastructure (`mcp-servers`, `allowed-tools`, `url-patterns`), behavior modifiers (`reminders`, `guardrails`), and the skill's callable interface (`runnable`, `parameters`). The extension parser reads this; the LLM does not see raw YAML.

2. **Body (Markdown below the closing `---`)** — LLM-facing instructions injected into the system prompt when the skill is loaded via `read_skill`. This is where you tell the LLM _how_ to use the skill: when to call which scripts, what arguments to pass, what workflow to follow, and what the expected outputs are.

**The body is written FOR the LLM, not for human developers.** Treat it like a system prompt fragment. Common mistakes:

- ❌ Writing human-oriented documentation (installation steps, prerequisites, architecture diagrams)
- ❌ Explaining how the MCP server works internally — the LLM doesn't need to know implementation details
- ❌ Assuming the LLM will remember to call back after a long-running operation — if a workflow takes minutes (e.g., monitoring a live meeting), the script itself must block/poll and handle the full lifecycle
- ✅ Telling the LLM which scripts to call via `run_browser_script` and with what `args`
- ✅ Describing the expected return values so the LLM can interpret results
- ✅ Providing workflow sequences ("first call X, then use the result to call Y")
- ✅ Noting edge cases the LLM should handle ("if the result has `found: false`, retry with different parameters")

**Example — good SKILL.md body (for a long-running skill):**

```markdown
When the user wants to capture meeting notes, call:

run_browser_script({ script_path: "meet-notes:scripts/capture.js", args: [] })

The script handles the entire lifecycle: starts capture, polls until the meeting
ends, enriches with calendar data, generates notes via subtask, and creates a
Google Doc. It blocks for the duration of the meeting.

Returns `{ success: true, docUrl: "...", meetingNotes: "..." }` on success.
If it returns `{ success: false }`, report the error to the user.
```

### 5.2 `runnable` and `parameters`: Skill as a Callable Unit

A Skill is more than a collection of MCP tools and scripts — `runnable` and `parameters` elevate it into a **callable unit** with a named interface. This is what distinguishes a Skill from a raw MCP server:

- **`parameters`** define the skill's input contract — named, typed arguments with descriptions and defaults. When the LLM invokes the skill via `run_browser_script`, it fills these parameters as `args`. When a human invokes via `/skill`, the same parameters are prompted in the UI or passed as `--param` flags. Both paths feed into the same `args[]` array in the script.
- **`runnable: true`** marks the skill as directly executable. This enables two invocation paths:
  1. **LLM path**: The LLM reads the SKILL.md body, decides to call `run_browser_script({ script_path: "my-skill:scripts/main.js", args: [...] })`, and passes parameter values as args.
  2. **Human path**: The user types `/skill my-skill/scripts/main.js --full-auto` in Koi's input box, bypassing the LLM entirely. Parameter values come from the UI prompt or `--param` flags.

The key insight: **MCP servers expose generic tools (the "hands"). Skills compose those tools into purposeful workflows with a named interface (the "brain").** A `postgres_query` MCP tool is generic; a `db-to-gsheet-report` skill with `parameters: [query, sheetTitle]` is a reusable action.

**Do not** put `/skill` command examples in the SKILL.md body — the LLM will see them and attempt to use `/skill` syntax instead of `run_browser_script`. Document `/skill` usage for human developers in a separate `README.md` or in code comments.

---

## 6. Handling OAuth in Skills (Microsoft 365 Example)

Koi handles authentication natively. Raw OAuth tokens never touch the sandboxed iframe or the LLM's context.

### 6.1 Declaring OAuth Configurations in `SKILL.md`

To use a generic OAuth provider (like Microsoft Azure AD), configure the `oauth` block in your `SKILL.md`:

```yaml
mcp-servers:
  - name: microsoft_365
    type: local
    script: mcp/microsoft_365_mcp.js
    scopes:
      - "https://graph.microsoft.com/Files.ReadWrite.All"
      - "https://graph.microsoft.com/Mail.Read"
    oauth:
      authority: "https://login.microsoftonline.com/common/oauth2/v2.0"
      client_id: "your-azure-app-client-id"
      response_type: "token"
      allowed_domains:
        - "graph.microsoft.com"
```

### 6.2 The `runtime.fetch` Proxy

Inside your `mcp/*.js` script, use `runtime.fetch()`. The extension automatically intercepts this, negotiates the OAuth token using `chrome.identity.launchWebAuthFlow`, attaches the `Authorization: Bearer <token>` header, and securely proxies the request. The `callTool` method must return the standard MCP result format.

```javascript
// mcp/microsoft_365_mcp.js
async callTool(name, args) {
  if (name === "onedrive_list") {
    // runtime.fetch automatically attaches the Microsoft OAuth token!
    const response = await runtime.fetch("https://graph.microsoft.com/v1.0/me/drive/root/children");
    const data = await response.json();
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
}

```

_Security Note:_ Tokens are strictly restricted via the `allowed_domains` array. An MCP script cannot successfully `runtime.fetch` to `malicious-domain.com` using the Microsoft token.

---

### 6.3 Bundling Libraries with MCP Scripts

Local MCP servers that depend on JavaScript libraries should bundle them as static assets shipped with the extension or included directly in the skill's scripts. For example, the built-in PDF skill uses `pdf.mjs` and the document skill uses `mammoth.browser.min.js`, both packaged in the extension's `lib/` directory.

This approach is required for Chrome Web Store compliance, which prohibits remote code loading. Libraries are loaded via `<script>` tags in the sandbox iframe before the MCP script executes.

> **For skill authors:** If your MCP script requires a third-party library, include it in your skill's `scripts/` or `resources/` directory. The sandbox will load it as a local asset. Do not rely on CDN or remote URLs — these will be blocked by the extension's Content Security Policy.

### 6.4 Tool Display Messages

MCP servers can provide a `displayMessage` template on each tool definition. When present, the UI renders a human-friendly status message instead of the raw tool name and arguments.

### Template Syntax

The template engine uses a lightweight Mustache-like syntax:

| Pattern                               | Description                                           |
| ------------------------------------- | ----------------------------------------------------- |
| `{{argName}}`                         | Insert arg value (truncated to 60 chars)              |
| `{{argName\|default:fallback}}`       | Use fallback if arg is missing or empty               |
| `{{#argName}}...{{/argName}}`         | Conditional block — rendered only if arg is truthy    |
| `{{#argName=val}}...{{/argName=val}}` | Conditional block — rendered only if arg equals `val` |

### Adding displayMessage to an MCP Tool

Add the `displayMessage` field alongside `name`, `description`, and `inputSchema` in your `listTools()` return value:

```javascript
listTools() {
  return [
    {
      name: "sheets_read_range",
      description: "Read a range of cells from a Google Sheet.",
      displayMessage: "📊 Reading cells {{range}} from spreadsheet",
      inputSchema: {
        type: "object",
        properties: {
          spreadsheetId: { type: "string" },
          range: { type: "string" },
        },
        required: ["spreadsheetId", "range"],
      },
    },
  ];
}
```

### Examples

```
// Static message (no args needed)
"📋 Listing open tabs"

// Simple interpolation
"📊 Reading cells {{range}} from spreadsheet"

// Conditional block
"📧 Searching Gmail: \"{{query}}\""
"📅 Fetching events{{#query}} matching \"{{query}}\"{{/query}}"

// Conditional equality
"{{#action=click}}👆 Please click: {{description}}{{/action=click}}"
"{{#action=fill}}✏️ Please type \"{{value}}\" into: {{description}}{{/action=fill}}"

// Default fallback
"👆 Please click: {{description|default:the element}}"
```

If `displayMessage` is omitted, the UI falls back to a generic `"Executing: Tool Name"` message derived from the tool name.

The `displayMessage` field is automatically stripped before tool definitions are sent to the LLM provider, so it has no effect on token usage or API compatibility.

---

## 7. Local vs. Remote MCP (Backend Communication)

Koi supports two transport types for MCP servers, declared via `type: "local" | "remote"` in `SKILL.md`.

### 7.1 Local MCP (`type: "local"`)

- **Execution:** Runs entirely inside the browser using a sandboxed `iframe`.
- **Auth:** Uses Chrome's built-in `chrome.identity` (OAuth2).
- **Best For:** HTTP/REST APIs, SaaS integrations (Google Workspace, Notion, Salesforce).

### 7.3 Reusing MCP Servers Across Skills (`skill-ref`)

If multiple skills need the same MCP server (e.g., `google-workspace`), a skill can reference another skill's MCP server instead of bundling its own script:

```yaml
mcp-servers:
  - name: google_workspace
    skill-ref: google-workspace # Load MCP from the 'google-workspace' skill
```

When `skill-ref` is present, the router looks up the referenced skill and uses its MCP server script. The `script` field is ignored. This avoids duplicating MCP code across skills.

### 7.2 Remote MCP (`type: "remote"`)

Browsers cannot establish direct TCP/UDP connections (required for databases like PostgreSQL, Redis, or native Git). Remote MCP solves this by routing requests through a WebSocket Gateway.

- **Execution:** Runs on a backend server/workstation via a Gateway.
- **Auth:** The browser sends the user's SSO token to the Gateway. The Gateway validates the identity, loads the actual database credentials from its environment, and spawns the MCP process.
- **Best For:** Databases, local file systems, native binaries.

**SKILL.md Declaration for Remote MCP:**

```yaml
mcp-servers:
  - name: postgres-prod
    type: remote
    gateway: default # Points to user's configured wss:// URL
    server: postgres # The name of the server configured on the Gateway
    database: analytics_db
```

The `database` field is an opaque parameter forwarded to the gateway-side MCP server process. Its interpretation depends on the server implementation (e.g., the PostgreSQL MCP server uses it to select the database to connect to).

## → [Full LLM Configuration guide](./configuration.md)

## 8. Tool Confirmation: LLM vs. Skill Scripts

Koi employs different confirmation lifecycles depending on _who_ is calling the tool.

### 8.1 Direct LLM Calls

When the LLM directly outputs a tool call (e.g., `navigate_page`), the execution is paused, and a UI dialog is immediately presented to the user to Accept or Reject the action.

### 8.2 Skill Script Execution (`run_browser_script`)

When a script runs, prompting the user 100 times in a `for` loop is bad UX. Instead, Koi uses an **Approval State** tied to the specific script run.

- **Tiered Security:** Tools are categorized into tiers (`safe`, `navigation`, `mutating`, `skill-injected`, `dangerous`).
- **First-Use Confirmation:** If a script attempts a `navigation` or `mutating` tool (e.g., `navigatePage`), the script pauses _once_ to ask for permission. Once the user approves that tool for the current script run, subsequent calls proceed automatically. MCP-provided tools (like `click`, `fill` from chrome-developer-tools) are classified as `skill-injected` and also use first-use confirmation.
- **Dangerous Exceptions:** Tools classified as `dangerous` _always_ require confirmation on every call, even in `--full-auto` mode. Currently no built-in tools occupy the `dangerous` tier (the `TOOL_TIERS.dangerous` array in `constants.ts` is empty) — it exists as a classification for future use or custom extensions. Direct page mutation tools like `click` and `fill` are only available through the `chrome-developer-tools` skill MCP server, not as built-in tools.

### 8.3 Debug Skill Script Without LLM Session

If a skill script does not need LLM session, you can directly run them from Koi's input box: the `/skill` will tell the extension to run the script directly (without sending it to LLM).

Here's some examples for test skills:

```
/skill google-workspace-test/scripts/gmail-calendar-test.js --full-auto
/skill google-workspace-test/scripts/drive-test.js --full-auto
/skill google-workspace-test/scripts/guardrail-negative-test.js --full-auto
/skill google-workspace-test/scripts/run-all.js --full-auto
```

---

## 9. Per-Skill Guardrails and Reminders

Skills can inject their own behavior modifiers into the main AgentSession.

### 9.1 System Reminders

Inject dynamic context hints into the LLM's system prompt based on specific triggers (e.g., when a specific tool is called, or context window is low). Define these in `SKILL.md`:

```yaml
reminders:
  - id: "test-tool-trigger"
    trigger:
      type: "tool_call"
      toolName: "run_browser_script"
    content: "SYSTEM OVERRIDE: You just called a tool. Output exactly this string: 'TOOL_TRIGGER_VERIFIED_OK'"
    strategy: "one_shot"
    priority: "high"
```

→ [Full system reminder guide](./system_reminder.md)

### 9.2 Guardrails

Enforce hard policies on tool inputs and outputs. Link a guardrail script in `SKILL.md` (`guardrails: scripts/guardrail.js`).

```javascript
// scripts/guardrail.js (Example: Prevent writing to files the agent didn't create)
const createdFileIds = new Set();

module.exports = {
  input: async (ctx) => {
    if (ctx.tool.name === "sheets_write_range") {
      const fileId = ctx.tool.args.spreadsheetId;
      if (!createdFileIds.has(fileId)) {
        return {
          allowed: false,
          message: `Write denied: ${fileId} was not created by this agent. Use sheets_create first.`,
        };
      }
    }
    return { allowed: true };
  },
  output: async (ctx) => {
    // In browser mode, ctx.result.content is a string (JSON-serialized tool output)
    if (ctx.tool.name === "sheets_create" && !ctx.result.isError) {
      const match = ctx.result.content.match(/Created spreadsheet: (\S+)/);
      if (match) createdFileIds.add(match[1]);
    }
    return { override: false };
  },
};
```

## → [Full guardrail guide](./guardrails_api.md)

## 10. Security Model & Enterprise Deployment

For corporate and enterprise usage, Koi enforces strict cryptographic and isolation boundaries.

1. **Signature Verification:** In managed environments, Skills (the entire folder contents) must be signed. The Extension verifies the SHA-256 content hashes against an IT-provisioned public key before loading the skill.
2. **Execution Isolation:** Skill scripts (`scripts/*.js`) run in `sandbox-impl.html` and local MCP servers (`mcp/*.js`) run in `sandbox-mcp.html` — two separate sandboxed iframes. Both have a `sandbox allow-scripts allow-forms allow-popups allow-modals` CSP policy. Neither has access to `chrome.*` extension APIs or the background DOM. MCP scripts receive the `runtime.*` API; skill scripts receive the `tools.*` API.
3. **Privilege Separation:** The LLM cannot call `evaluate_script` directly. Only signed MCP server scripts (running in `sandbox-mcp.html`) can call `runtime.evaluateScript()` to execute JavaScript on target webpages. This two-layer isolation — LLM → sandbox → page — prevents prompt-injection XSS attacks.

## Appendix: SKILL.md Frontmatter Reference

| Field           | Type    | Required | Description                                                                                                                                           |
| --------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | string  | ✅       | Skill identifier. Lowercase alphanumeric and hyphens only (e.g. `my-skill`).                                                                          |
| `description`   | string  | ✅       | One-line description shown in the Skills UI and injected into the LLM system prompt.                                                                  |
| `runnable`      | boolean |          | If `true`, the skill is directly executable — both by the LLM via `run_browser_script` and by humans via `/skill` in the input box. Default: `false`. |
| `parameters`    | list    |          | Parameters the LLM should fill when invoking the skill. Each entry: `name`, `description`, `required`, `default`.                                     |
| `allowed-tools` | list    |          | Tools the LLM may call when this skill is active. Also controls which tools are available to skill scripts.                                           |
| `url-patterns`  | list    |          | Glob patterns (e.g. `https://mail.google.com/*`). If the active tab matches, the skill is auto-loaded.                                                |
| `mcp-servers`   | list    |          | MCP server declarations. See Sections 5–6 for full syntax.                                                                                            |
| `reminders`     | list    |          | System prompt reminder rules. See [reminder guide](./system_reminder.md).                                                                             |
| `guardrails`    | string  |          | Path to a guardrail script (e.g. `scripts/guardrail.js`) or inline JS. See [guardrails guide](./guardrails_api.md).                                   |
| `prerequisites` | list    |          | User-facing checklist shown in the Run dialog before skill execution. Each entry is a plain-text instruction (e.g. `"Enable Closed Captions (CC)"`).  |

> **Note:** `version` and `license` fields can appear in frontmatter (see the `postgresql` skill example) and are stored in the skill data, but they are not extracted or validated by the YAML parser (`skill-parser.ts`). They are passed through only when the install pipeline stores them (e.g., bundled install in `background/index.ts`).
