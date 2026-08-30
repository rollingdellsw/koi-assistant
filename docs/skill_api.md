# Koi™ Skill API Documentation

This guide provides technical instructions for developing Skills for the Koi™ Assistant. Skills allow you to extend the LLM's capabilities with deterministic scripts, complex sub-agent orchestration, proactive context reminders, programmable guardrails, and secure external system access via the Model Context Protocol (MCP). See also: [Full guardrail guide](./guardrails_api.md) · [System reminder guide](./system_reminder.md) · [Configuration guide](./configuration.md) · [Running the Gateway](../tools/gateway/README.md)

---

## 1. The Sandbox Interface

When a skill script is executed via `runBrowserScript`, it runs inside an isolated, secure iframe sandbox. The runtime injects three global variables into your script: `tools`, `args`, and `console`.

> **Skill folder structure:** A skill is a directory with the following layout:
>
> ```
> my-skill/
>   SKILL.md          # Required — frontmatter + documentation
>                     # Frontmatter: machine-readable config (YAML between --- delimiters)
>                     # Body (below frontmatter): LLM-facing instructions injected into the system prompt
>   scripts/           # Skill scripts executed via runBrowserScript
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

- **LLM invocation** (`runBrowserScript`): The LLM provides `args` as a string array via `runBrowserScript({ script_path: "skill:scripts/main.js", args: ["val1", "val2"], timeout: 120000 })`. Access as `args[0]`, `args[1]`, etc.
- **Direct invocation** (`/skill` command): Skill parameter values (from the UI prompt or `--param` flags) are passed as positional strings via `Object.values(params)`. Parameter order follows the order of the `parameters` list in `SKILL.md`.
- **Delegation from background**: When the background service worker delegates `executeIsolatedScript` to the sidepanel, args come from the caller (usually the LLM's `runBrowserScript` call).

Scripts that need named access to parameters should destructure from the positional array (e.g., `const [url, timeout] = args;`) rather than using property access on the array object.

### 1.2 `console`

A proxy that forwards `log`, `warn`, `error`, and `info` directly to the Koi side panel UI. Objects are safely stringified to prevent sandbox escapes.

### 1.3 `tools` (The Complete Browser API)

The `tools` object exposes asynchronous methods to interact with the browser.

> **Calling convention:** Built-in browser tools use **positional arguments** with camelCase names (e.g., `tools.click(selector)`, `tools.fill(selector, value)`). MCP tools (loaded via `readSkill`) use a **single object argument** (e.g., `tools.domGetProperty({ selector, property })`). While the LLM uses `snake_case` (e.g., `searchDom`), the script API uses standard JavaScript `camelCase` (e.g., `tools.searchDom`).

The signatures below show the actual script API. For tools that accept a single object, parameters are shown as `{ key: type }`. For tools that accept positional arguments, parameters are shown as `(arg1, arg2)`.

#### Skill Management & Utilities (Built-in)

These methods are built into the script runtime. No skill needs to be loaded first.

- `await tools.readSkill({ name: string })` — Load a skill and its MCP servers into the current script's `tools` object. After calling this, newly registered MCP tools may take a moment to appear; poll with a short `while` loop. Returns `{ success: true }`.

> **Important: `readSkill` in scripts shares tools with the LLM session.**
>
> When a script calls `tools.readSkill({ name: "google-workspace" })`, the skill's MCP servers are registered into a **shared MCP router**. This router is a singleton — the same instance used by both the script sandbox and the LLM's main tool executor. Once the script finishes, the MCP tools it loaded **remain registered** and become available to the LLM for direct tool calls in subsequent conversation turns.
>
> This means:
>
> - If a skill script loads `google-workspace` to call `calendar_get_events` internally, the LLM can call `docs_create` in a later turn **without** needing a separate `readSkill("google-workspace")` call — the tools are already registered from the script's `readSkill`.
> - This is by design: it enables the two-step pattern where a script does deterministic work (loading dependencies, querying data) and the LLM follows up with reasoning-dependent tool calls using the same loaded tools.
> - The tools persist for the remainder of the session. They are not unloaded when the script completes.

- `await tools.runSubtask({ goal: string, verification_command: string, timeoutMs?: number, context_files?: string[], image_data?: Array<{base64: string, mimeType: string, filename?: string}> })` — Spawn an independent LLM agent with its own context window. Returns an MCP-style result object `{ content: [{ type: "text", text: string }], isError: boolean }`. Parse the text field as JSON to access `.content` (the agent's final response) or `.history` (full message log, fallback if content is empty). See Section 4.
- `await tools.sleep(ms: number)` — Wait for `ms` milliseconds.

#### Inspection & Context (Safe)

These tools are always available without loading any skill:

- `await tools.takeScreenshot({ selector?: string, region?: object, resolution?: string, fullPage?: boolean, format?: string })`
- `await tools.takeSnapshot({ selector?: string, mode?: "readable" | "dom" | "full", maxDepth?: number, offset?: number, verbose?: boolean })`
- `await tools.searchDom(query)` — `query` is a text string or CSS selector (e.g., `tools.searchDom('button')`, `tools.searchDom('[data-testid="email"]')`)
- `await tools.inspectElement(selector)` — returns computed styles, attributes, and event listeners
- `await tools.getContext()`
- `await tools.listPages()`
- `await tools.getPageContext({ selector?: string, maxReadable?: number, offset?: number, maxLinks?: number, linkOffset?: number })` — Extract readable content, links, and resource URLs from the current page. See below.
- `await tools.listConsoleMessages({ types?: string[], limit?: number })`

##### `getPageContext` — Page Content Extraction for Semantic Analysis

`getPageContext` is the primary tool for reading page content. It extracts structured data that an LLM can reason over directly, eliminating the need for CSS selectors to extract text data.

**When to use:** Any time a script or the LLM needs to understand what's on a page — product details, search results, article content, table data, available links. Use `getPageContext` instead of writing `querySelector` chains to scrape text.

**When NOT to use:** When you need to interact with the page (click, fill, hover) — use the interaction tools with CSS selectors for that. Selectors are for actions; `getPageContext` is for reading.

```javascript
const ctx = await tools.getPageContext();

// ctx.readable — clean text with structure markers (# headings, - lists)
// ctx.links    — all <a> elements with { text, href, selector }
// ctx.resources — all media with { type, src, alt? }
// ctx.meta     — { title, url, totalLength, offset, hasMore }
```

**Response shape:**

```typescript
interface PageContext {
  readable: string;
  links: Array<{
    text: string; // Link text, truncated to 100 chars
    href: string; // Full resolved URL
    selector: string; // CSS selector (for clicking, not extraction)
  }>;
  resources: Array<{
    type: "image" | "video" | "audio" | "iframe";
    src: string; // Full resolved URL
    alt?: string; // Alt text for images
  }>;
  meta: {
    title: string;
    url: string;
    totalLength: number;
    offset: number;
    hasMore: boolean;
  };
}
```

**Pagination.** For large pages, `readable` is capped at `maxReadable` (default: 20,000 chars). If more content exists, `meta.hasMore` is `true`. Call again with `offset` to continue:

```javascript
let ctx = await tools.getPageContext();
let fullText = ctx.readable;
while (ctx.meta.hasMore) {
  ctx = await tools.getPageContext({
    offset: ctx.meta.offset + ctx.readable.length,
  });
  fullText += ctx.readable;
}
```

**Scoping.** Pass `selector` to extract from a subtree only:

```javascript
const results = await tools.getPageContext({ selector: "#search-results" });
```

**Auto-traversal.** Same-origin iframes are automatically walked — their content, links, and resources are included in the response. Cross-origin iframes appear in `resources` with `type: "iframe"` and their `src` URL. Open shadow DOM content is included; closed shadow DOM is inaccessible (browser security).

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

- `await tools.click(selector, delayMs?)`
- `await tools.fill(selector, value, delayMs?)`
- `await tools.hover(selector, delayMs?)`

> **Note on delayMs:** Modern JavaScript frameworks (React, Angular) often need time to hydrate elements or attach event listeners after a UI transition (like a modal opening). If you interact with an element too quickly, the site may ignore the event. Pass an optional delay in milliseconds (e.g., `await tools.fill('#origin', 'JFK', 800)`) to pause briefly before the action executes, giving the site time to ready its event listeners.

> **Note:** `pressKey` has a built-in CDP implementation (`tool-executor.ts` routes `pressKey` to `CDPManager.pressKey`) that is always available. The `chrome-developer-tools` skill also provides a `pressKey` MCP tool via JS event dispatch. When the skill is loaded, the MCP version is used. Without the skill, the built-in CDP version still works. This is different from `click`, `fill`, and `hover`, which have **no** built-in fallback and require the skill.

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

- `await tools.setTrap(name, trigger, filter?)` — e.g., `tools.setTrap('my-trap', 'error', {})`. The `setTrap` tool in `devtools.js` registers the trap both in `window.__deftTraps` on the page (for in-page detection) and via the extension's background trap infrastructure (for network monitoring).
  Note: The `setTrap` and `removeTrap` tools are provided by the `chrome-developer-tools` MCP server, not as built-in browser tools.
- `await tools.removeTrap(name)` — e.g., `tools.removeTrap('my-trap')`

---

## 2. DOM Interaction: The `dom-interactor` Skill

For reading DOM properties and calling methods on page elements or JavaScript globals, use the **`dom-interactor`** shared skill. This is the standard pattern used across all skills — do not re-implement handle discovery yourself.

```javascript
// Load the shared skill — this registers domGetProperty and domCallMethod
await tools.readSkill({ name: "dom-interactor" });

// Read a property from an element
const value = await tools.domGetProperty({
  selector: "#email-input",
  property: "value",
});

// Read a property from a global object
const title = await tools.domGetProperty({
  global: "document",
  property: "title",
});

// Call a method on an element
await tools.domCallMethod({ selector: "#my-form", method: "scrollIntoView" });

// Call a method with arguments
await tools.domCallMethod({
  selector: "#my-form",
  method: "setAttribute",
  args: ["data-ready", "true"],
});
```

Both tools work transparently inside shadow DOMs and iframes — use `tools.enterShadow` / `tools.enterIframe` first to set the context, then call `domGetProperty` / `domCallMethod` as normal.

---

## 3. `runBrowserScript`: Combining Determinism with AI

`runBrowserScript` bridges the LLM's reasoning and traditional browser automation.

**Why use it?**
If a process is strictly deterministic (e.g., clicking 5 specific buttons to export a report), forcing the LLM to do it step-by-step wastes tokens, takes minutes, and risks hallucination. By bundling a script, the LLM simply calls `runBrowserScript({ script_path: "my-skill:scripts/export.js" })` to execute the macro instantly.

### 3.0. Parameters

| Parameter     | Type     | Required | Description                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `script_path` | string   | ✅       | Script path in format `skill-name:scripts/file.js`. The skill-name prefix is required.                                                                                                                                                                                                                                                                                         |
| `args`        | string[] |          | Arguments to pass to the script. Available as `args[0]`, `args[1]`, etc. inside the script.                                                                                                                                                                                                                                                                                    |
| `timeout`     | number   |          | Execution timeout in milliseconds. Default: `240000` (4 minutes). For long-running scripts (e.g. meeting capture), set this to match the expected duration plus a buffer. Example: for a 30-minute meeting, use `2100000` ((30 + 5) × 60 × 1000). The timeout propagates through the full execution chain: `browser-dependencies.ts` → `tool-executor.ts` → sidepanel sandbox. |

**Example — long-running script with custom timeout:**

```
runBrowserScript({
  script_path: "meet-notes:scripts/capture.js",
  args: ["30"],
  timeout: 2100000
})
```

### 3.1. Advanced Page Interaction: The Handle System

When interacting with complex, memory-heavy JavaScript objects on a webpage (like an OpenSeadragon viewer or a massive React state tree), serializing the entire object across the sandbox boundary will crash the browser.

Koi provides a **Handle System** to manage object references entirely on the target page. The workflow has two parts:

1. **Find & register** the object. Two acquisition paths exist, and choosing the right one matters on hardened sites — see the next two subsections.
2. **Operate on it by handle** using `runtime.invokeOnHandle()` and `runtime.getFromHandle()` — these call methods or read properties without ever serializing the object across the boundary.

> **Note:** The Handle System is for MCP server scripts (`mcp/*.js`) that need to interact with complex non-serializable JS objects (e.g., a WebGL viewer instance, a large React state tree). For ordinary DOM property reads and method calls, use the `dom-interactor` skill instead — it handles the handle machinery for you.

#### Object Discovery: Two Paths

Koi exposes **two** acquisition APIs. Pick the simplest one that fits.

**Path A — `runtime.findHandle` / `runtime.findHandleByGlobal` (preferred).** For acquiring a DOM element by CSS selector, or a global object by dotted path. Routes through a static page function injected via `chrome.scripting.executeScript` with a function reference, so it does **not** consume the page's CSP `unsafe-eval` budget. Works on hardened sites like claude.ai, github.com, and any page with a strict `script-src` policy. Context-aware: honors the current shadow/iframe path tracked by the background context manager.

```javascript
// Example: finding a DOM element or global object (from dom_interactor.js).
// This is the implementation pattern used by the dom-interactor skill itself.
async _getHandle(args) {
  const res = args.selector
    ? await runtime.findHandle({ selector: args.selector })
    : await runtime.findHandleByGlobal({ path: args.global || "window" });

  if (res && res.error) throw new Error(`Target not found: ${res.error}`);
  const handleId = res && (res.handleId || (res.result && res.result.handleId));
  if (!handleId) throw new Error("Target not found: finder returned no handleId");
  return handleId; // e.g., "h_1"
}
```

**Path B — `runtime.evaluateScript` with a finder script.** For acquisition that needs _domain-specific discovery logic_ — walking React Fiber internals, sniffing window properties for a viewer instance, traversing framework state. The finder script is passed as a **function expression** (not an IIFE) — the runtime calls it with `(document, __ctx, args)` where `__ctx` is the current shadow root or document context.

This path uses `new Function(code)` inside the page's MAIN world, which **fails on sites that disallow `unsafe-eval` in their CSP** (most modern apps with strict CSP). Use it only when Path A's selector/global lookup is insufficient — i.e., when the discovery logic itself is the skill's domain knowledge and cannot be expressed as a single CSS selector.

```javascript
// Example: domain-specific discovery — finding an OpenSeadragon viewer
// instance attached to a DOM element. Path A can't express this; the
// skill needs page-context JS to walk a private property.
async _getViewerHandle(elementSelector) {
  const FINDER_SCRIPT = `(document, __ctx) => {
    if (!window.__deftHandles) {
      // Bootstrap registry (only needed when going through evaluateScript;
      // findHandle initializes the registry on the background side)
      let nextId = 1;
      const registry = new Map();
      window.__deftHandles = {
        store: function(o) { var id = "h_" + (nextId++); registry.set(id, o); return id; },
        get:     function(id) { return registry.get(id); },
        release: function(id) { return registry.delete(id); }
      };
    }

    const el = (__ctx || document).querySelector("${elementSelector}");
    if (!el) return { error: "Host element not found" };
    // Domain-specific: OpenSeadragon stashes the viewer here
    const viewer = el.__osdViewer || (el.querySelector("[data-osd]") || {}).__osdViewer;
    if (!viewer) return { error: "No OpenSeadragon viewer attached" };
    return { handleId: window.__deftHandles.store(viewer) };
  }`;

  const res = await runtime.evaluateScript(FINDER_SCRIPT, {}, "MAIN");
  const result = res.result !== undefined ? res.result : res;
  if (result.error) throw new Error(result.error);
  return result.handleId;
}
```

> **Rule of thumb:** If your finder is just `querySelector(sel)` or `window.foo.bar`, use Path A. If it walks framework internals or sniffs page-script state, use Path B and accept that the skill won't work on sites with strict CSP.

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

> **Security note:** Both `findHandle` and `evaluateScript` are only available to signature-verified MCP server scripts running inside the MCP sandbox (`sandbox-mcp.html`). The LLM cannot call them directly — they are deliberately omitted from the browser tool set exposed to the agent. The handle acquisition primitives (`acquireHandle`) are likewise gated to the sandbox-runtime path and never appear in `BROWSER_TOOL_NAMES`. This two-layer isolation — LLM → signed sandbox → page — prevents prompt-injection from acquiring handles to arbitrary page state.

### 3.2 MCP Runtime API Reference

Inside `mcp/*.js` scripts, the `runtime` object provides the following APIs:

| Method                                               | Description                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.fetch(url, options?)`                       | Authenticated HTTP proxy. Attaches the OAuth token for the server's configured scopes. Supports `options.skipAuth = true` for public APIs. Returns a standard `Response` object. `options`: `responseFormat` (`"text"` or `"base64"` — use `"base64"` for binary downloads like PDFs/images), `method`, `headers`, `body`.                                 |
| `runtime.findHandle({ selector })`                   | Acquire a handle to a DOM element by CSS selector. Context-aware (honors current shadow/iframe). **Works on CSP-strict sites.** Returns `{ handleId }` or `{ error }`.                                                                                                                                                                                     |
| `runtime.findHandleByGlobal({ path })`               | Acquire a handle to a global object by dotted path (e.g. `"document"`, `"window.location"`). **Works on CSP-strict sites.** Returns `{ handleId }` or `{ error }`.                                                                                                                                                                                         |
| `runtime.evaluateScript(code, args?, worldId?)`      | Execute a function-expression string on the target page. `worldId` is `"MAIN"` (page context) or `"ISOLATED"` (default). Returns `{ result }`. **MAIN-world execution uses `new Function(code)` and is subject to the page's CSP — fails on sites without `unsafe-eval`.** For simple selector/global lookups, prefer `findHandle` / `findHandleByGlobal`. |
| `runtime.invokeOnHandle(handleId, methodPath, args)` | Call a method on a registered handle by dot-notation path (e.g. `"viewport.zoomTo"`).                                                                                                                                                                                                                                                                      |
| `runtime.getFromHandle(handleId, propertyPath)`      | Read a primitive property from a registered handle by dot-notation path (e.g. `"scrollTop"`). Do **not** use for method calls.                                                                                                                                                                                                                             |
| `runtime.releaseHandle(handleId)`                    | Release a handle to free memory on the target page. Fire-and-forget.                                                                                                                                                                                                                                                                                       |
| `runtime.getAuthToken(scopes?)`                      | Get a raw OAuth token for the server's configured provider. Low-level alternative to `runtime.fetch` for custom auth flows.                                                                                                                                                                                                                                |
| `runtime.getGoogleAuthToken(scopes?)`                | Get a raw Google OAuth token via `chrome.identity`. Low-level; prefer `runtime.fetch` for most cases.                                                                                                                                                                                                                                                      |
| `runtime.console.log/warn/error/info(...)`           | Forward log messages to the Koi side panel. Use `runtime.console` (not the global `console`) inside MCP scripts.                                                                                                                                                                                                                                           |
| `runtime.config`                                     | Frozen object containing the server's config block from `SKILL.md` (e.g. `runtime.config.database`, `runtime.config.name`).                                                                                                                                                                                                                                |

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
        tier: "safe",
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

#### Declaring a Security Tier on MCP Tools

Each tool entry in `listTools()` may declare an optional `tier` field that
tells Koi how cautiously to gate calls to that tool. The tier is a property
of the tool itself — not of which skill happens to expose it — so it
applies uniformly whether the tool is called by the LLM directly or from
inside a skill script.

| Tier             | Confirmation behaviour                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `safe`           | Never confirms. Use for read-only operations (fetching data, looking up metadata, parsing).                           |
| `navigation`     | First-use confirmation per script run. Use for context-changing reads.                                                |
| `mutating`       | Confirms on direct LLM calls; first-use per script run from skill scripts. Use for writes that change external state. |
| `dangerous`      | Confirms on **every** call, even in `--full-auto`. Use for arbitrary code execution.                                  |
| `skill-injected` | Default when `tier` is omitted. Equivalent to first-use confirmation.                                                 |

**The tier overrides `allowed-tools`.** Listing a tool in a skill's
`allowed-tools` is a _capability_ declaration ("this skill is permitted to
call this tool"); it does not weaken the security gate. A `mutating` or
`dangerous` tool always confirms regardless of whether the active skill
lists it.

Example: a Slack MCP server marks reads as `safe` and writes as `mutating`:

```javascript
listTools() {
  return [
    { name: "slack_conversations_history", tier: "safe", description: "Read messages.", inputSchema: { /* ... */ } },
    { name: "slack_users_info",            tier: "safe", description: "Look up a user.", inputSchema: { /* ... */ } },
    { name: "slack_chat_post_message",     tier: "mutating", description: "Post a message.", inputSchema: { /* ... */ } },
  ];
}
```

With this declaration, the read tools run silently while every post-message
call is gated by an Accept/Reject prompt — even though all three appear in
the same `allowed-tools` list.

---

## 4. Orchestrating Sub-Agents with `runSubtask`

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
  const subtaskRes = await tools.runSubtask({
    goal: `Analyze the current page at ${url}. Find the pricing table and summarize the tiers.`,
    verification_command: "Pricing summary is generated",
    timeoutMs: 120000,
  });

  if (subtaskRes && !subtaskRes.isError && subtaskRes.content) {
    // runSubtask returns an MCP-style result: { content: [{ type: "text", text: "..." }], isError: false }
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

| Concept        | Definition                                 | Purpose                                                                                                                                                |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Skill**      | The package/orchestrator (`SKILL.md`).     | Defines instructions, parameters, scripts, reminders, guardrails, and declares which tools/MCPs the LLM can use. It is the "brain."                    |
| **MCP Server** | The Model Context Protocol implementation. | Exposes generic tools (e.g., `postgres_query`, `onedrive_list`). It has no prompt instructions. It is the "hands." It can hold state across LLM calls. |

### 5.1 SKILL.md: Two Audiences, One File

`SKILL.md` serves two distinct audiences within a single file:

1. **Frontmatter (YAML between `---` delimiters)** — Machine-readable configuration consumed by the extension runtime. This declares metadata (`name`, `description`), infrastructure (`mcp-servers`, `allowed-tools`, `url-patterns`), behavior modifiers (`reminders`, `guardrails`), and the skill's callable interface (`runnable`, `parameters`). The extension parser reads this; the LLM does not see raw YAML.

2. **Body (Markdown below the closing `---`)** — LLM-facing instructions injected into the system prompt when the skill is loaded via `readSkill`. This is where you tell the LLM _how_ to use the skill: when to call which scripts, what arguments to pass, what workflow to follow, and what the expected outputs are.

**The body is written FOR the LLM, not for human developers.** Treat it like a system prompt fragment. Common mistakes:

- ❌ Writing human-oriented documentation (installation steps, prerequisites, architecture diagrams)
- ❌ Explaining how the MCP server works internally — the LLM doesn't need to know implementation details
- ❌ Assuming the LLM will remember to call back after a long-running operation — if a workflow takes minutes (e.g., monitoring a live meeting), the script itself must block/poll and handle the full lifecycle
- ✅ Telling the LLM which scripts to call via `runBrowserScript` and with what `args`
- ✅ Describing the expected return values so the LLM can interpret results
- ✅ Providing workflow sequences ("first call X, then use the result to call Y")
- ✅ Noting edge cases the LLM should handle ("if the result has `found: false`, retry with different parameters")

**Example — good SKILL.md body (for a long-running skill):**

```markdown
When the user wants to capture meeting notes, call:

runBrowserScript({ script_path: "meet-notes:scripts/capture.js", args: [] })

The script handles the entire lifecycle: starts capture, polls until the meeting
ends, enriches with calendar data, generates notes via subtask, and creates a
Google Doc. It blocks for the duration of the meeting.

Returns `{ success: true, docUrl: "...", meetingNotes: "..." }` on success.
If it returns `{ success: false }`, report the error to the user.
```

### 5.2 `runnable` and `parameters`: Skill as a Callable Unit

A Skill is more than a collection of MCP tools and scripts — `runnable` and `parameters` elevate it into a **callable unit** with a named interface. This is what distinguishes a Skill from a raw MCP server:

- **`parameters`** define the skill's input contract — named, typed arguments with descriptions and defaults. When the LLM invokes the skill via `runBrowserScript`, it fills these parameters as `args`. When a human invokes via `/skill`, the same parameters are prompted in the UI or passed as `--param` flags. Both paths feed into the same `args[]` array in the script.
- **`runnable: true`** marks the skill as directly executable. This enables two invocation paths:
  1. **LLM path**: The LLM reads the SKILL.md body, decides to call `runBrowserScript({ script_path: "my-skill:scripts/main.js", args: [...] })`, and passes parameter values as args.
  2. **Human path**: The user types `/skill my-skill/scripts/main.js --full-auto` in Koi's input box, bypassing the LLM entirely. Parameter values come from the UI prompt or `--param` flags.

The key insight: **MCP servers expose generic tools (the "hands"). Skills compose those tools into purposeful workflows with a named interface (the "brain").** A `postgres_query` MCP tool is generic; a `db-to-gsheet-report` skill with `parameters: [query, sheetTitle]` is a reusable action.

**Do not** put `/skill` command examples in the SKILL.md body — the LLM will see them and attempt to use `/skill` syntax instead of `runBrowserScript`. Document `/skill` usage for human developers in a separate `README.md` or in code comments.

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

### 7.2 Remote MCP (`type: "remote"`)

Browsers cannot establish direct TCP/UDP connections (required for databases like PostgreSQL, Redis, or native Git) and cannot run native binaries. Remote MCP solves this by routing requests through the **Koi Gateway**, a WebSocket-to-stdio bridge running on the user's workstation or a backend server.

- **Execution:** The Gateway spawns each MCP server as a child process (stdio transport) and bridges it to the extension over WebSocket (`ws://localhost:<port>/mcp/{serverName}`).
- **Auth:** Configurable per Gateway via `auth.mode`:
  - `none` (default) — for **local, single-user development**. The Gateway binds to `127.0.0.1` only and is never reachable from the network. Do not use `none` on a shared or multi-user host.
  - `sso` — intended for managed deployments (token validated against the corporate IdP). **Token verification is not yet implemented; do not deploy `sso` mode in production.**
- **Best For:** Databases, sandboxed shell access, LSP code intelligence, local file systems, native binaries.

**SKILL.md Declaration for Remote MCP:**

```yaml
mcp-servers:
  - name: postgres-prod
    type: remote
    gateway: default # Points to user's configured ws(s):// URL
    server: postgres # The name of the server configured on the Gateway
    database: analytics_db
```

The `database` field is an opaque parameter forwarded to the gateway-side MCP server process. Its interpretation depends on the server implementation (e.g., the PostgreSQL MCP server uses it to select the database to connect to).

### 7.3 Reusing MCP Servers Across Skills (`skill-ref`)

If multiple skills need the same MCP server (e.g., `google-workspace`), a skill can reference another skill's MCP server instead of bundling its own script:

```yaml
mcp-servers:
  - name: google_workspace
    skill-ref: google-workspace # Load MCP from the 'google-workspace' skill
```

When `skill-ref` is present, the router looks up the referenced skill and uses its MCP server script. The `script` field is ignored. This avoids duplicating MCP code across skills.

### 7.4 The Koi Gateway

The Gateway is a WebSocket-to-stdio bridge: it spawns each MCP server as a child process on the user's machine and exposes it at `ws://localhost:<port>/mcp/{serverName}`. It listens on `127.0.0.1` only.

Two bundled servers matter to skill authors:

| Server     | Endpoint        | Provides                                                                                 |
| ---------- | --------------- | ---------------------------------------------------------------------------------------- |
| `sandbox`  | `/mcp/sandbox`  | Sandboxed shell, overlay filesystem, services, patch export — **plus** code intelligence |
| `postgres` | `/mcp/postgres` | Example database server                                                                  |

The `sandbox` server **embeds code intelligence**: it spawns the compiled `lsp_search` bundle as its own child and re-exports the navigation tools (`search`, `get_references`, `get_hover`, `get_implementation`, `get_file_structure`, `get_lsp_diagnostics`, `search_ast`, `read_ast_node`) through the same endpoint. A skill therefore declares **one** server and gets both. Do not declare a separate `lsp_search` server.

Two constraints that affect how a skill behaves at runtime:

- **One client at a time per stateful server.** The Gateway multiplexes all WebSocket clients of a server onto one child process. The `sandbox` server holds global session state (current project, overlay, session id), so two concurrent clients on `/mcp/sandbox` corrupt each other's view.
- **Process reuse.** Child processes survive extension disconnects and are reattached on reconnect. The sandbox rotates its overlay per client connection, so overlay state does not leak between sessions — but **background services started by a previous session keep running**. A skill that starts dev servers should check `sandbox_info.services` first.

> **Operators:** installation, `gateway-config.json`, the security model (loopback exposure, credential masking, network egress modes), disk retention, the `review` CLI, code-intelligence prerequisites, and troubleshooting are all in
> **[`tools/gateway/README.md`](../tools/gateway/README.md)**.
> End users of the sandboxed shell want the shorter
> **[`skills/sandbox-shell/README.md`](../skills/sandbox-shell/README.md)**.

### 7.5 Using the Gateway from a Skill: `sandbox-shell`

The bundled `sandbox-shell` skill declares the single merged server:

```yaml
mcp-servers:
  - name: sandbox
    type: remote
    gateway: default
    server: sandbox
```

The workflow the skill teaches the LLM: `sandbox_info` → `sandbox_open_project` (one call — sets the shell/overlay scope _and_ the code-intelligence workspace) → navigate with `search` / `get_references` / `get_hover`, reading individual declarations with `read_ast_node` rather than whole files → edit via `sandbox_exec` → build/test with `sandbox_exec` → checkpoint with in-overlay `git commit` → ship with `git format-patch -o "$KOI_OUTBOX"` → **the user reviews** the patches in the outbox and applies them with `git am`.

The three properties a skill author should design around:

1. **The host tree is read-only.** Every write lands in a per-session overlay. The host changes only when the user applies an exported patch.
2. **The outbox is the only channel out.** Files left in the overlay are invisible to the user.
3. **Every session starts fresh from the host tree.** A previous session's unshipped edits are never silently inherited.

The user can watch the overlay's commits and diffs live from a host terminal with the `review` CLI while the session runs ([gateway README](../tools/gateway/README.md#watching-a-session-live-the-review-cli)).

## → [Full LLM Configuration guide](./configuration.md)

## 8. Tool Confirmation: LLM vs. Skill Scripts

Koi employs different confirmation lifecycles depending on _who_ is calling the tool.

### 8.1 Direct LLM Calls

When the LLM directly outputs a tool call, Koi gates execution based on the
tool's tier (see §3.2 for declaring tiers on MCP tools):

- `safe` tools execute immediately with no prompt.
- `mutating` and `dangerous` tools always present an Accept/Reject dialog,
  even if the active skill lists the tool in its `allowed-tools`. The tier
  is authoritative — `allowed-tools` is a capability gate, not a trust
  bypass.
- Tools without a declared tier (e.g. unannotated MCP tools) fall back to
  the legacy whitelist behaviour: `allowed-tools` membership grants
  pass-through, otherwise the user is prompted.

### 8.2 Skill Script Execution (`runBrowserScript`)

When a script runs, prompting the user 100 times in a `for` loop is bad UX. Instead, Koi uses an **Approval State** tied to the specific script run.

- **Tiered Security:** Tools are categorised into tiers (`safe`, `navigation`, `mutating`, `skill-injected`, `dangerous`). Built-in browser tools have fixed tiers; MCP tools declare their own tier in `listTools()` (see §3.2).
- **`safe` Tools:** Read-only tools marked `tier: "safe"` execute without prompting. A typical pattern is to mark every read tool an MCP server exposes as `safe` and reserve confirmation for writes.
- **First-Use Confirmation:** When a script first invokes a `navigation`, `mutating`, or `skill-injected` tool, it pauses once to ask for permission. Subsequent calls of the same tool in the same script run proceed automatically.
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
      toolName: "runBrowserScript"
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

### 9.3 Pre-Send Hooks

A pre-send hook is a deterministic, agent-side check that runs **before** the user's message is dispatched to the LLM. Unlike reminders and guardrails, **the LLM never sees pre-send hooks** — they are pure UX guards that live entirely on the client side.

**Use case:** the Slack co-pilot binds a session to a specific channel. If the user navigates to a different channel and clicks Send, the pre-send hook detects the mismatch and blocks the send with a user-facing message ("This conversation is about #design. Switch back, or start a new session."). The user's draft is preserved; nothing reaches the LLM. This prevents cross-channel context bleed without requiring the model to reason about staleness.

**Declaration.** Add `pre-send-hook: scripts/pre_send.js` to `SKILL.md` frontmatter (sibling to `guardrails`). The path is relative to the skill root.

```yaml
pre-send-hook: scripts/pre_send.js
```

**Hook signature.** The hook is a sandboxed script — same execution environment as `analyze.js` and other `runBrowserScript` scripts. It receives the user's draft text as `args[0]` and can call any tool the skill has access to (including its own MCP tools, so it can read module-scope state set by other scripts).

It returns either:

```javascript
{ block: false }                              // allow send
{ block: true, message: "Reason for block" }  // block send, show message
```

**Example** — block send when the active Slack tab no longer matches the channel the session was bound to:

```javascript
// scripts/pre_send.js
async function run() {
  const pagesRes = await tools.listPages({});
  if (!pagesRes || pagesRes.isError) return { block: false }; // fail open

  const pages = Array.isArray(pagesRes.content)
    ? JSON.parse(String(pagesRes.content[0].text))
    : pagesRes;
  const tabList = Array.isArray(pages) ? pages : pages.pages || [];
  const slackTab = tabList.find(
    (p) => typeof p.url === "string" && p.url.includes("app.slack.com/client/"),
  );
  if (!slackTab) return { block: false };

  const parseRes = await tools.slack_parse_channel_url({ url: slackTab.url });
  if (parseRes.isError) return { block: false };
  const parsed = JSON.parse(String(parseRes.content[0].text));
  if (!parsed.matched || !parsed.hasChannel) return { block: false };

  // Compare against state set by analyze.js (module scope in slack_mcp.js)
  const stateRes = await tools.slack_get_fetch_state({
    channel: parsed.channelId,
  });
  if (stateRes.isError) return { block: false };
  const { lastActiveChannel } = JSON.parse(String(stateRes.content[0].text));
  if (lastActiveChannel === null) return { block: false }; // first send

  if (lastActiveChannel !== parsed.channelId) {
    return {
      block: true,
      message:
        "This conversation is about a different Slack channel. Switch back to that channel, or start a new session.",
    };
  }
  return { block: false };
}
return run();
```

**Execution rules:**

- **Timeout: 2 seconds per hook.** Pre-send hooks run on every Send click and must be fast. Cheap state comparisons only — no network calls, no LLM calls, no waiting on user input. When multiple skills with hooks are loaded, hooks run sequentially, so worst-case latency before send is `2s × number_of_hooks`.
- **Fail-open on error or timeout.** A buggy hook must never lock the user out of their own UI. If the hook throws, times out, or its script can't be loaded, the send proceeds and a warning is logged. This matches the `failMode: "open"` philosophy of guardrails.
- **`fullAuto` mode.** Tool calls inside a pre-send hook do **not** trigger the user-confirmation modal — the user already trusted the skill at load time. This makes hooks usable for tools like `listPages` that would otherwise prompt.
- **Chaining.** When multiple skills with pre-send hooks are loaded simultaneously, hooks run sequentially in load order. The **first** hook to return `{block: true}` wins; remaining hooks are skipped. This matches the input-hook chaining behavior in [the guardrails API](./guardrails_api.md).
- **Dedup.** Re-loading the same skill is idempotent — the hook is keyed by skill name, not registered twice.
- **Session lifetime.** Hooks are cleared when the agent session is reset (new session, load saved session). Skills are re-registered automatically as they auto-load for the new session.
- **The LLM never sees the hook or its result.** Blocked sends do not appear in conversation history. The user just sees a banner above the input area and clicks Send again after fixing the situation.

## 10. Security Model & Enterprise Deployment

For corporate and enterprise usage, Koi enforces strict cryptographic and isolation boundaries.

1. **Signature Verification:** In managed environments, Skills (the entire folder contents) must be signed. The Extension verifies the SHA-256 content hashes against an IT-provisioned public key before loading the skill.
2. **Execution Isolation:** Skill scripts (`scripts/*.js`) run in `sandbox-impl.html` and local MCP servers (`mcp/*.js`) run in `sandbox-mcp.html` — two separate sandboxed iframes. Both have a `sandbox allow-scripts allow-forms allow-popups allow-modals` CSP policy. Neither has access to `chrome.*` extension APIs or the background DOM. MCP scripts receive the `runtime.*` API; skill scripts receive the `tools.*` API.
3. **Privilege Separation:** The LLM cannot call `evaluateScript` directly. Only signed MCP server scripts (running in `sandbox-mcp.html`) can call `runtime.evaluateScript()` to execute JavaScript on target webpages. This two-layer isolation — LLM → sandbox → page — prevents prompt-injection XSS attacks.

The above covers the **in-browser** boundaries. The host-side model — read-only host filesystem, credential masking, network egress policy, and patch-only delivery — belongs to the Gateway and is documented in [`tools/gateway/README.md`](../tools/gateway/README.md#security-model).

## Appendix: SKILL.md Frontmatter Reference

| Field           | Type    | Required | Description                                                                                                                                          |
| --------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | string  | ✅       | Skill identifier. Lowercase alphanumeric and hyphens only (e.g. `my-skill`).                                                                         |
| `description`   | string  | ✅       | One-line description shown in the Skills UI and injected into the LLM system prompt.                                                                 |
| `runnable`      | boolean |          | If `true`, the skill is directly executable — both by the LLM via `runBrowserScript` and by humans via `/skill` in the input box. Default: `false`.  |
| `parameters`    | list    |          | Parameters the LLM should fill when invoking the skill. Each entry: `name`, `description`, `required`, `default`.                                    |
| `allowed-tools` | list    |          | Tools the LLM may call when this skill is active. Also controls which tools are available to skill scripts.                                          |
| `url-patterns`  | list    |          | Glob patterns (e.g. `https://mail.google.com/*`). If the active tab matches, the skill is auto-loaded.                                               |
| `mcp-servers`   | list    |          | MCP server declarations. See Sections 5–6 for full syntax.                                                                                           |
| `reminders`     | list    |          | System prompt reminder rules. See [reminder guide](./system_reminder.md).                                                                            |
| `guardrails`    | string  |          | Path to a guardrail script (e.g. `scripts/guardrail.js`) or inline JS. See [guardrails guide](./guardrails_api.md).                                  |
| `pre-send-hook` | string  |          | Path to a script (e.g. `scripts/pre_send.js`) that runs before each user-message send. Can block the send with a user-facing message. See §9.3.      |
| `prerequisites` | list    |          | User-facing checklist shown in the Run dialog before skill execution. Each entry is a plain-text instruction (e.g. `"Enable Closed Captions (CC)"`). |

> **Note:** `version` and `license` fields can appear in frontmatter (see the `postgresql` skill example) and are stored in the skill data, but they are not extracted or validated by the YAML parser (`skill-parser.ts`). They are passed through only when the install pipeline stores them (e.g., bundled install in `background/index.ts`).
