# Koi™ Skill API Documentation

This guide provides technical instructions for developing Skills for the Koi™ Assistant. Skills allow you to extend the LLM's capabilities with deterministic scripts, complex sub-agent orchestration, proactive context reminders, programmable guardrails, and secure external system access via the Model Context Protocol (MCP).

---

## 1. The Sandbox Interface

When a skill script is executed via `run_browser_script`, it runs inside an isolated, secure iframe sandbox. The runtime injects three global variables into your script: `tools`, `args`, and `console`.

### 1.1 `args`

An array of string arguments passed to the script by the LLM (or a mapped object if invoked programmatically via the UI/CLI).

### 1.2 `console`

A proxy that forwards `log`, `warn`, `error`, and `info` directly to the Deft/Koi side panel UI. Objects are safely stringified to prevent sandbox escapes.

### 1.3 `tools` (The Complete Browser API)

The `tools` object exposes asynchronous methods to interact with the browser.
_Note: While the LLM uses `snake_case` (e.g., `search_dom`), the script API uses standard JavaScript `camelCase` (e.g., `tools.searchDom`)._

#### Inspection & Context (Safe)

These tools are always available without loading any skill:

- `await tools.takeScreenshot({ selector?: string, fullPage?: boolean })`
- `await tools.takeSnapshot()`
- `await tools.searchDom({ query: string })`
- `await tools.inspectElement({ selector: string })`
- `await tools.getContext()`
- `await tools.listPages()`
- `await tools.listConsoleMessages({ types?: string[], limit?: number })`

#### Navigation & Tab Management

- `await tools.navigatePage({ url: string })`
- `await tools.waitFor({ event: "load" | "networkidle", timeout?: number })`
- `await tools.scrollViewport({ direction: "down" | "up", amount?: number })`
- `await tools.enterShadow({ selector: string })`
- `await tools.enterIframe({ selector: string })`
- `await tools.exitContext()`
- `await tools.resetContext()`
- `await tools.newPage({ url: string })`
- `await tools.selectPage({ pageId: string })`
- `await tools.closePage({ pageId: string })`

#### Interaction & Mutation

The following safe guided action is always available:

- `await tools.requestAction({ action: "click" | "fill", selector: string, value?: string })` _(Highlights element and prompts user to act)_

The following tools require the **chrome-developer-tools** skill to be loaded (they are provided by its MCP server, not built into the base extension):

- `await tools.click({ selector: string })`
- `await tools.fill({ selector: string, value: string })`
- `await tools.hover({ selector: string })`
- `await tools.pressKey({ key: string })`
- `await tools.listNetworkRequests({ status?: number, urlPattern?: string })`
- `await tools.getNetworkRequest({ reqid: string })`

#### Visual Workspace

- `await tools.promptUserSelection({ prompt?: string })`
- `await tools.createWorkspace({ selector?: string, bounds?: object })`
- `await tools.addWorkspaceAnnotation({ imageId: string, type: string, geometry: object, style?: object, label?: string })`
- `await tools.showWorkspaceOverlay({ imageId: string })`
- `await tools.hideWorkspaceOverlay({ imageId?: string })`
- `await tools.highlightElement({ selector: string, description?: string })`
- `await tools.clearHighlight()`
- `await tools.waitForUserDone({ prompt: string })`

#### Advanced & Orchestration

The following tools also require the **chrome-developer-tools** skill:

- `await tools.setTrap({ name: string, trigger: "error" | "network", filter?: object })`
- `await tools.removeTrap({ name: string })`
- `await tools.readSkill({ name: string })`
- `await tools.run_subtask({ goal: string, timeoutMs?: number, ... })`
- `await tools.sleep(ms: number)`

---

## 2. `run_browser_script`: Combining Determinism with AI

`run_browser_script` bridges the LLM's reasoning and traditional browser automation.

**Why use it?**
If a process is strictly deterministic (e.g., clicking 5 specific buttons to export a report), forcing the LLM to do it step-by-step wastes tokens, takes minutes, and risks hallucination. By bundling a script, the LLM simply calls `run_browser_script({ script_path: "my-skill:scripts/export.js" })` to execute the macro instantly.

### 2.1. Advanced Page Interaction: The Handle System (`acquireHandle`)

When interacting with complex, memory-heavy JavaScript objects on a webpage (like an OpenSeadragon viewer or a massive React state tree), serializing the object across the sandbox boundary via `evaluateScript` will crash the browser.

Koi provides a Handle API to manage object references entirely on the target page:

```javascript
// 1. Acquire a handle to the object on the target page
const res = await runtime.acquireHandle("openseadragon_viewer", {});
const handleId = res.handleId; // e.g., "h_1"

// 2. Invoke methods on that handle without transferring the object
await runtime.invokeOnHandle(handleId, "viewport.zoomTo", [1.5]);
await runtime.invokeOnHandle(handleId, "viewport.panBy", [{ x: 0.1, y: 0.1 }]);

// 3. Extract specific primitive values
const zoomLevel = await runtime.getFromHandle(handleId, "viewport.getZoom");

// 4. Release memory
await runtime.releaseHandle(handleId);
```

---

## 3. Orchestrating Sub-Agents with `run_subtask`

For long-running, repetitive tasks (like iterating over 100s of URLs), doing it in the main conversation thread will quickly overflow the LLM's context window.

Solve this by writing a JavaScript `for` loop in a skill script that spawns an independent **Subtask Agent** for each item.

#### Example: Iterating over multiple URLs

```javascript
// scripts/mass_analysis.js
const urlsToCheck = ["https://example.com/page1", "https://example.com/page2"];
const results = [];

for (const url of urlsToCheck) {
  await tools.navigatePage({ url });
  await tools.sleep(2000);

  // Spawn an independent LLM agent with its own fresh context window
  const subtaskRes = await tools.run_subtask({
    goal: `Analyze the current page at ${url}. Find the pricing table and summarize the tiers.`,
    verification_command: "Pricing summary is generated",
    timeoutMs: 120000,
  });

  if (!subtaskRes.isError) {
    const subtaskData =
      typeof subtaskRes === "string" ? JSON.parse(subtaskRes) : subtaskRes;
    results.push({ url, summary: subtaskData.content });
  }
}
return { success: true, all_results: results };
```

---

## 4. Skills vs. MCP Servers

| Concept        | Definition                                 | Purpose                                                                                                                             |
| -------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Skill**      | The package/orchestrator (`SKILL.md`).     | Defines instructions, parameters, scripts, reminders, guardrails, and declares which tools/MCPs the LLM can use. It is the "brain." |
| **MCP Server** | The Model Context Protocol implementation. | Exposes generic tools (e.g., `postgres_query`, `onedrive_list`). It has no prompt instructions. It is the "hands."                  |

---

## 5. Handling OAuth in Skills (Microsoft 365 Example)

Koi handles authentication natively. Raw OAuth tokens never touch the sandboxed iframe or the LLM's context.

### 5.1 Declaring OAuth Configurations in `SKILL.md`

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

### 5.2 The `runtime.fetch` Proxy

Inside your `mcp/*.js` script, use `runtime.fetch()`. The extension automatically intercepts this, negotiates the OAuth token using `chrome.identity.launchWebAuthFlow`, attaches the `Authorization: Bearer <token>` header, and securely proxies the request.

```javascript
// mcp/microsoft_365_mcp.js
async callTool(name, args) {
  if (name === "onedrive_list") {
    // runtime.fetch automatically attaches the Microsoft OAuth token!
    const response = await runtime.fetch("https://graph.microsoft.com/v1.0/me/drive/root/children");
    return await response.json();
  }
}

```

_Security Note:_ Tokens are strictly restricted via the `allowed_domains` array. An MCP script cannot successfully `runtime.fetch` to `malicious-domain.com` using the Microsoft token.

---

## 6. Local vs. Remote MCP (Backend Communication)

Koi supports two transport types for MCP servers, declared via `type: "local" | "remote"` in `SKILL.md`.

### 6.1 Local MCP (`type: "local"`)

- **Execution:** Runs entirely inside the browser using a sandboxed `iframe`.
- **Auth:** Uses Chrome's built-in `chrome.identity` (OAuth2).
- **Best For:** HTTP/REST APIs, SaaS integrations (Google Workspace, Notion, Salesforce).

### 6.2 Remote MCP (`type: "remote"`)

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

## → [Full LLM Configuration guide](./configuration.md)

## 7. Tool Confirmation: LLM vs. Skill Scripts

Koi employs different confirmation lifecycles depending on _who_ is calling the tool.

### 7.1 Direct LLM Calls

When the LLM directly outputs a tool call (e.g., `navigate_page`), the execution is paused, and a UI dialog is immediately presented to the user to Accept or Reject the action.

### 7.2 Skill Script Execution (`run_browser_script`)

When a script runs, prompting the user 100 times in a `for` loop is bad UX. Instead, Koi uses an **Approval State** tied to the specific script run.

- **Tiered Security:** Tools are categorized into tiers (`safe`, `navigation`, `mutating`, `skill-injected`, `dangerous`).
- **First-Use Confirmation:** If a script attempts a `mutating` tool (e.g., `click`), the script pauses _once_ to ask for permission. Once the user approves "click" for that script run, subsequent `click` calls in the loop proceed automatically.
- **Dangerous Exceptions:** Tools classified as `dangerous` _always_ require confirmation, regardless of loops. In the base extension, direct page mutation tools like `click` and `fill` are only available through the `chrome-developer-tools` skill MCP server, not as built-in tools.

### 7.3 Debug Skill Script Without LLM Session

If a skill script does not need LLM session, you can directly run them from Koi's input box: the `/skill` will tell the extension to run the script directly (without sending it to LLM).

Here's some example for a test skill 'google-workspace-test':

```
/skill google-workspace-test/scripts/gmail-calendar-test.js --full-auto
/skill google-workspace-test/scripts/drive-test.js --full-auto
/skill google-workspace-test/scripts/guardrail-negative-test.js --full-auto
/skill google-workspace-test/scripts/run-all.js --full-auto
```

---

## 8. Per-Skill Guardrails and Reminders

Skills can inject their own behavior modifiers into the main AgentSession.

### 8.1 System Reminders

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

### 8.2 Guardrails

Enforce hard policies on tool inputs and outputs. Link a guardrail script in `SKILL.md` (`guardrails: scripts/guardrail.js`).

```javascript
// scripts/guardrail.js (Example: Prevent writing to files the agent didn't create)
const createdFileIds = new Set();

module.exports = {
  input: async (ctx) => {
    if (ctx.tool.name === "excel_write_range") {
      if (!createdFileIds.has(ctx.tool.args.itemId)) {
        return {
          allowed: false,
          message: "Write denied: Agent did not create this file.",
        };
      }
    }
    return { allowed: true };
  },
  output: async (ctx) => {
    if (ctx.tool.name === "excel_create" && !ctx.result.isError) {
      createdFileIds.add(ctx.result.content[0]._createdFileId);
    }
    return { override: false };
  },
};
```

## → [Full guardrail guide](./guardrails_api.md)

## 9. Security Model & Enterprise Deployment

For corporate and enterprise usage, Koi enforces strict cryptographic and isolation boundaries.

1. **Signature Verification:** In managed environments, Skills (the entire folder contents) must be signed. The Extension verifies the SHA-256 content hashes against an IT-provisioned public key before loading the skill.
2. **Execution Isolation:** All user-provided scripts (`scripts/*.js`) and local MCP servers (`mcp/*.js`) are executed in `sandbox.html` with a strict `sandbox="allow-scripts"` CSP. They have no access to the `chrome.*` extension APIs or the background DOM.
3. **Privilege Separation:** The LLM cannot call `evaluate_script` directly. Only signed, deterministic Skill scripts can execute arbitrary JavaScript on target webpages, preventing prompt-injection XSS attacks.
