# Guardrails API Reference

Guardrails provide programmatic control over tool execution. Define JavaScript hooks that run **before** (input) and **after** (output) any tool executes.

Guardrails come in two scopes: **global** (applies to every tool call in every session) and **skill-scoped** (active only while a specific skill is loaded, chained after the global guardrail). Both use the same hook interface.

---

## Scope of Application

Guardrails apply to **all tool executions**, including:

| Context                        | Guardrails Applied | Notes                   |
| ------------------------------ | ------------------ | ----------------------- |
| Main conversation              | ✅ Yes             | Primary use case        |
| Sub-task agent (`run_subtask`) | ✅ Yes             | Uses same tool executor |
| Executor/agentic_search        | ✅ Yes             | Uses same tool executor |

This means security rules (like protecting `.env` files) are enforced consistently across all agent loops.

> **Exempt tools:** `read_skill` and `run_subtask` are hardcoded to bypass all guardrail hooks. They are orchestration primitives, not mutations, and blocking them would break skill loading and subtask delegation. Do not write guardrails that expect to intercept these two tools — the hooks will never fire for them.

### Comparison with Other Features

| Feature        | Main Loop | Sub-task | agentic_search/Executor |
| -------------- | --------- | -------- | ----------------------- |
| **Guardrails** | ✅        | ✅       | ✅                      |
| **Reminders**  | ✅        | ✅       | ✅                      |
| **Scratchpad** | ✅        | ❌       | ❌                      |

**Why the difference?**

- **Guardrails** are security/policy controls that must apply everywhere
- **Reminders** are context hints for the main conversation; sub-loops have focused, specialized prompts
- **Scratchpad** is for multi-turn memory; sub-loops are short-lived (max 10 iterations)

### Important: Shared vs. Isolated State

When writing custom guardrails, be aware of what state is shared across agent loops:

| State                                  | Shared?      | Notes                                     |
| -------------------------------------- | ------------ | ----------------------------------------- |
| `ctx.memory.snapshot` (file checksums) | ✅ Shared    | All `read_file` calls update the same map |
| `ctx.history.messages`                 | ❌ Main only | Sub-task has its own conversation history |
| `ctx.tool.args`                        | ✅ Per-call  | Always reflects current tool call         |

**Implications for custom guardrails:**

1. **Shared memory snapshot** — The `ctx.memory.snapshot` map tracks file reads globally across sub-tasks.

2. **`ctx.history.messages` reflects main conversation only** — If your guardrail parses message history to check "did the LLM read this file?", it will miss sub-task actions. Use `ctx.memory.snapshot` instead.

3. **Snapshot semantics after sub-task** — When a sub-task modifies a file:
   - The snapshot reflects what the sub-task read (before modification)
   - After sub-task patches a file, snapshot checksum ≠ disk checksum
   - Main LLM must `read_file` again before patching (guardrail enforces this correctly)

**Example of what NOT to do:**

```javascript
// ❌ BAD: Checking history for read_file calls
input: async (ctx) => {
  if (ctx.tool.name === "patch") {
    // This misses sub-task reads!
    const hasRead = ctx.history.messages.some((m) =>
      m.content?.includes("read_file"),
    );
    if (!hasRead) return { allowed: false, message: "Read first" };
  }
  return { allowed: true };
};

// ✅ GOOD: Use the snapshot map
input: async (ctx) => {
  if (ctx.tool.name === "patch") {
    // Check ctx.memory.snapshot for stale files before allowing patch
    const targetPath = ctx.tool.args.path;
    const entry = ctx.memory.snapshot?.get(targetPath);
    if (!entry) {
      return {
        allowed: false,
        message: `Re-read ${targetPath} before patching`,
      };
    }
  }
  return { allowed: true };
};
```

---

## Context Object (`ctx`)

The `ctx` object passed to your hooks contains:

| Property                          | Description                                                                 |
| --------------------------------- | --------------------------------------------------------------------------- |
| `ctx.tool.name`                   | Name of the tool being executed (e.g., `"patch"`, `"read_file"`)            |
| `ctx.tool.args`                   | Arguments passed to the tool                                                |
| `ctx.result`                      | **(output hook only)** `{ content: string, isError: boolean }`              |
| `ctx.history.messages`            | Full conversation history                                                   |
| `ctx.history.lastUserMessage`     | Last message from the user                                                  |
| `ctx.memory.snapshot`             | Map of files the LLM has read (path → `{ checksum, lastRead }`)             |
| `ctx.system.fs.readFile(path)`    | Read a file (CLI mode only — not available in browser sandbox)              |
| `ctx.system.fs.getChecksum(path)` | Get SHA256 of a file (CLI mode only)                                        |
| `ctx.system.cmd.exec(cmd)`        | Run a shell command (CLI mode only), returns `{ exitCode, stdout, stderr }` |
| `ctx.workingDirectory`            | Absolute path to project root                                               |

> **`ctx.result.content` shape:** In both CLI and browser mode, `content` is always a **string** (the JSON-serialized tool output). To extract structured data, parse it: `const data = JSON.parse(ctx.result.content)`. Do not assume `content` is an array — the MCP `content: [{ type: "text", text: "..." }]` array is serialized into a flat string before reaching the guardrail hook.

## Hook Return Types

### Input Hook

Return one of:

```javascript
// Allow the tool to execute
{ allowed: true }

// Block the tool with a message to the LLM
{
  allowed: false,
  message: "Reason for blocking",
  suggestion: "Optional hint for how to proceed"  // Optional
}
```

### Output Hook

Return one of:

```javascript
// Keep the original result
{ override: false }

// Replace the result sent to the LLM
{
  override: true,
  result: "New content to send to LLM",
  isError: true  // Optional: mark as error to trigger LLM fix loop
}
```

---

## Retry Limits (Preventing Infinite Loops)

⚠️ **Important**: Output hooks that mark successful operations as errors can cause infinite loops if the LLM keeps retrying.

The guardrail engine includes a built-in retry counter. After **3 consecutive overrides** for the same tool, subsequent overrides are ignored and a warning is logged.

### Hook Timeouts

To prevent guardrail scripts from hanging the agent:

| Hook                  | Timeout       | Rationale                                                 |
| --------------------- | ------------- | --------------------------------------------------------- |
| Input                 | 1 second      | Should be fast checks only (both global and skill-scoped) |
| Output (global)       | 10 minutes    | Allows build/test commands to complete                    |
| Output (skill-scoped) | **5 seconds** | Skills run in sandboxed context; no long-running commands |

If a hook exceeds its timeout, the engine treats it as an error. For the global guardrail, `failMode` applies. Skill-scoped guardrail timeouts always fail open regardless of `failMode`.

### Custom Retry Tracking

For custom retry logic, use module-level state. Note: the built-in retry counter (3 overrides) is shared across all output hooks for a given tool. If you need finer control, track state yourself:

```javascript
// Module-level state (persists across tool calls within a session)
const outputRetryCounters = new Map();
const MAX_RETRIES = 5;

module.exports = {
  output: async (ctx) => {
    const retryKey = `${ctx.tool.name}_output`;
    const currentRetries = outputRetryCounters.get(retryKey) ?? 0;

    if (currentRetries >= MAX_RETRIES) {
      outputRetryCounters.set(retryKey, 0); // Reset for next sequence
      return { override: false };
    }

    // Your verification logic
    if (ctx.tool.name === "patch" && !ctx.result.isError) {
      const { exitCode } = await ctx.system.cmd.exec("npm test");
      if (exitCode !== 0) {
        outputRetryCounters.set(retryKey, currentRetries + 1);
        return { override: true, isError: true, result: "Tests failed" };
      }
    }

    outputRetryCounters.set(retryKey, 0); // Reset on success
    return { override: false };
  },
};
```

---

## Skill-Scoped Guardrails

A skill can attach its own guardrail that is active only while that skill is loaded. Declare it in `SKILL.md`:

```yaml
guardrails: scripts/guardrail.js
```

The path is relative to the skill's `scripts/` directory. The file format is identical to the global guardrail: a CommonJS module exporting `input` and/or `output` hooks.

### Chaining Behaviour

When both a global guardrail and one or more skill guardrails are active, they are chained in this order:

**Input hooks:**

1. Global guardrail runs first.
2. If it allows, each skill guardrail runs in load order.
3. **First block wins** — the remaining skill guardrails are skipped.

**Output hooks:**

1. Global guardrail runs first.
2. All skill guardrails run regardless of whether the global overrode.
3. Each subsequent hook receives the (potentially already-overridden) `ctx.result`.
4. **Last override wins.**

### Key Constraints vs. Global Guardrails

| Behaviour                            | Global     | Skill-scoped                                    |
| ------------------------------------ | ---------- | ----------------------------------------------- |
| Output hook timeout                  | 10 minutes | **5 seconds**                                   |
| Respects `failMode: "closed"`        | ✅         | ❌ Always fails open                            |
| Module cache reset on session change | ✅         | ✅                                              |
| Deduplication                        | —          | Same skill loaded twice: second load is ignored |
| Multiple skills active               | —          | All their guardrails chain after the global     |

### Module-Level State Lifetime

Module-level variables (like `const createdFileIds = new Set()`) persist for the lifetime of the sandbox iframe — i.e., the current session. In browser mode, the sandbox resets when the user starts a new session. In CLI mode, the process restart resets state. Do not rely on state persisting across sessions.

### Example: Own-File-Only Write Policy

```javascript
// skills/my-skill/scripts/guardrail.js
// Only allow writes to files created by this agent in this session.
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
    // Track newly created spreadsheets so the input hook can allow writes to them
    if (ctx.tool.name === "sheets_create" && !ctx.result.isError) {
      const match = ctx.result.content.match(/Created spreadsheet: (\S+)/);
      if (match) createdFileIds.add(match[1]);
    }
    return { override: false };
  },
};
```

---

## Configuration

Guardrails are loaded from (in priority order):

**Browser mode (Koi Chrome Extension):**

1. Skill-scoped: `guardrails: scripts/guardrail.js` in SKILL.md (loaded when skill is read)
2. Global: `guardrails` field in the config profile (a JavaScript string stored in `chrome.storage.local`)

In browser mode, the global guardrail and any skill guardrails are all active simultaneously and chain as described in the Skill-Scoped Guardrails section above.

### Fail Mode

By default, if your guardrail script throws an error, the tool is **allowed** to proceed (fail-open). This prevents buggy guardrails from blocking all work.

For security-critical environments, you can configure fail-closed behavior in your config:

```json
{
  "guardrails": {
    "enabled": true,
    "failMode": "closed"
  }
}
```

## Common Patterns

### Block tools on specific file patterns

```javascript
if (/\.prod\.env$/.test(ctx.tool.args.path)) {
  return { allowed: false, message: "Cannot modify production env files" };
}
```

### Guardrail Validation

Before deploying a guardrail, you can validate it programmatically. The sandbox supports a `validate` phase that performs three checks:

1. **Parse** — Can the script compile without syntax errors?
2. **Shape** — Does `module.exports` have `input()` and/or `output()` functions?
3. **Dry-run** — Does `input()` return `{ allowed: boolean }` and `output()` return `{ override: boolean }` when called with a dummy context?

Validation is triggered internally by the extension when a guardrail is loaded. If validation fails, the guardrail is not activated and an error is logged. Write guardrails defensively — always handle `ctx.tool.name` values you don't recognize by returning `{ allowed: true }` (input) or `{ override: false }` (output).
