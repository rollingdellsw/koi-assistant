# Guardrails API Reference

Guardrails provide programmatic control over tool execution. Define JavaScript hooks that run **before** (input) and **after** (output) any tool executes.

---

> **Browser Mode Note:** In the Koi Chrome Extension (standalone browser mode), guardrails run in a sandboxed iframe. The `ctx.system.fs` and `ctx.system.cmd` helpers are **not available** — there is no filesystem or shell access. Guardrails in browser mode have access to `ctx.tool`, `ctx.history`, `ctx.memory`, and `ctx.result`. The `ctx.std` helpers that depend on filesystem access (`checkStaleContext`, `isFileStale`, `isGitClean`) are also unavailable. All other guardrail features (input/output hooks, retry limits, fail mode, module-level state) work identically.

---

## Scope of Application

Guardrails apply to **all tool executions**, including:

| Context                        | Guardrails Applied | Notes                   |
| ------------------------------ | ------------------ | ----------------------- |
| Main conversation              | ✅ Yes             | Primary use case        |
| Sub-task agent (`run_subtask`) | ✅ Yes             | Uses same tool executor |
| Executor/agentic_search        | ✅ Yes             | Uses same tool executor |

This means security rules (like protecting `.env` files) are enforced consistently across all agent loops.

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

1. **`ctx.std.checkStaleContext()` works correctly** — It uses the shared snapshot map, so sub-task file reads are tracked globally.

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
    const staleFiles = await ctx.std.checkStaleContext(
      ctx.tool.args.unified_diff,
    );
    if (staleFiles.length > 0) {
      return { allowed: false, message: `Re-read: ${staleFiles.join(", ")}` };
    }
  }
  return { allowed: true };
};
```

---

## Context Object (`ctx`)

The `ctx` object passed to your hooks contains:

| Property                          | Description                                                      |
| --------------------------------- | ---------------------------------------------------------------- |
| `ctx.tool.name`                   | Name of the tool being executed (e.g., `"patch"`, `"read_file"`) |
| `ctx.tool.args`                   | Arguments passed to the tool                                     |
| `ctx.result`                      | **(output hook only)** `{ content: string, isError: boolean }`   |
| `ctx.history.messages`            | Full conversation history                                        |
| `ctx.history.lastUserMessage`     | Last message from the user                                       |
| `ctx.memory.snapshot`             | Map of files the LLM has read (path → checksum)                  |
| `ctx.system.fs.readFile(path)`    | Read a file (sandboxed to working directory)                     |
| `ctx.system.fs.getChecksum(path)` | Get SHA256 of a file                                             |
| `ctx.system.cmd.exec(cmd)`        | Run a shell command, returns `{ exitCode, stdout, stderr }`      |
| `ctx.workingDirectory`            | Absolute path to project root                                    |
| `ctx.std`                         | Standard library helpers (see below)                             |

**Standard Library (`ctx.std`)**

High-level helpers to avoid boilerplate:

| Method                         | Description                                                     |
| ------------------------------ | --------------------------------------------------------------- |
| `checkStaleContext(diff)`      | Returns files in the diff that have changed since LLM read them |
| `parseUnifiedDiff(diff)`       | Extract file paths from a unified diff string                   |
| `isGitClean(ctx.system.cmd)`   | Check if git working directory is clean                         |
| `computeChecksum(content)`     | Compute SHA256 hash of a string                                 |
| `argMatches(args, key, regex)` | Test if an argument matches a pattern                           |
| `isFileStale(filepath)`        | Check if a single file has changed since LLM read it            |

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

| Hook   | Timeout    | Rationale                              |
| ------ | ---------- | -------------------------------------- |
| Input  | 1 second   | Should be fast checks only             |
| Output | 10 minutes | Allows build/test commands to complete |

If a hook exceeds its timeout, the engine treats it as an error and applies the configured `failMode` behavior.

### Custom Retry Tracking

For custom retry logic, use module-level state in your guardrails.js file:

```javascript
// Module-level state (persists across tool calls within a session)
const outputRetryCounters = new Map();
const MAX_RETRIES = 5;

export default {
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

## Configuration

Guardrails are loaded from (in priority order):

**CLI mode:**

1. `.deft/guardrails.js` (project-local, relative to working directory)
2. `~/.config/deft/guardrails.js` (global)

**Browser mode (Koi Chrome Extension):**

1. Skill-scoped: `guardrails: scripts/guardrail.js` in SKILL.md (loaded when skill is read)
2. Global: `guardrails` field in the config profile (a JavaScript string stored in `chrome.storage.local`)

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
if (ctx.std.argMatches(ctx.tool.args, "path", /\.prod\.env$/)) {
  return { allowed: false, message: "Cannot modify production env files" };
}
```

### Run verification after changes

See the commented example in `~/.config/deft/guardrails.js` for running tests after patches.
