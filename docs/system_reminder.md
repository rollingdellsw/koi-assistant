# Reminder System

> Dynamic context injection for precision LLM control.

The Reminder System injects guidance into the LLM's context based on events — tool calls, user messages, iteration counts, and agent state. Instead of bloating your system prompt with rules that may not apply, reminders fire only when relevant, keeping context focused and improving model adherence.

Reminders come in two scopes:

- **Global** — always active, loaded from JSON files (CLI) or the config profile (browser). Documented below.
- **Skill-scoped** — active only while a specific skill is loaded. Declared inline in `SKILL.md`. See [Skill-Scoped Reminders](#skill-scoped-reminders).

Both scopes use the same rule format, trigger system, and engine.

---

## Scope of Application

Reminders apply to **all agent loops**:

| Context                        | Reminders Applied | Notes                                    |
| ------------------------------ | ----------------- | ---------------------------------------- |
| Main conversation              | ✅ Yes            | Primary use case                         |
| Sub-task agent (`run_subtask`) | ✅ Yes            | Inherits reminder engine from main       |
| Executor/agentic_search        | ✅ Yes            | Uses shared tool executor with reminders |

### Comparison with Other Features

| Feature        | Main Loop | Sub-task | agentic_search/Executor |
| -------------- | --------- | -------- | ----------------------- |
| **Reminders**  | ✅        | ✅       | ✅                      |
| **Guardrails** | ✅        | ✅       | ✅                      |
| **Scratchpad** | ✅        | ❌       | ❌                      |

**Key insight**: Reminders and Guardrails are applied consistently across all agent loops via the shared tool executor. Scratchpad is for multi-turn memory in the main conversation only.

### Side Effects: Sub-task Actions Affect Main Session

**Example scenario:**

1. Main session is working on JavaScript files
2. You delegate: "Fix the Python script in `scripts/deploy.py`"
3. Sub-task calls `write_file("scripts/deploy.py", ...)`
4. This triggers `tool_result` event with `file_pattern: "\\.py$"`
5. If you have a sticky "Python Rules" reminder, it **activates**
6. When sub-task completes, main session now has "Python Rules" active

**This is by design.** Sub-tasks mutate your codebase on behalf of the main session. The main session should be aware of what languages/files were touched, even if it didn't perform the actions directly.

**If this is undesirable for your use case**, you can:

1. Use `one_shot` strategy instead of `sticky` for language rules
2. Reset the session or start a new conversation
3. Design rules that only trigger on `user_message` patterns, not `tool_result`

```json
{
  "id": "python-rules",
  "trigger": { "type": "user_message", "pattern": "\\.py|python" },
  "content": "Python: Use type hints, PEP 8 style.",
  "strategy": "sticky"
}
```

**Key insight**: Guardrails are security controls and apply everywhere. Reminders and Scratchpad are context enhancements for the main conversation only.

### If You Need Language Rules in Sub-tasks

Include them directly in the sub-task goal:

```
Use run_subtask with goal: "Fix TypeScript errors in src/api/.
Rules: No 'any' types, use Zod for validation."
```

The sub-task agent will follow these instructions as part of its primary goal.

---

## Deduplication and State

- **Per-turn dedup:** A reminder never fires more than once per user-assistant exchange, regardless of how many tool calls match its trigger during that turn. The engine clears per-turn state after each exchange.
- **`one_shot` lifetime:** Fires exactly once per session. State resets on session reset.
- **`sticky` lifetime:** Once triggered, re-injects on every subsequent turn automatically — you don't need to re-trigger it. State resets on session reset.
- **Session reset:** Starting a new session re-arms all `one_shot` rules and clears all `sticky` state.

---

## Why Reminders?

### The Problem with Static Prompts

Traditional system prompts suffer from:

- **Token bloat** - Language rules for 5 languages when you're only editing Python
- **Attention dilution** - Important rules buried in walls of text
- **One-size-fits-none** - Same rules for debugging, refactoring, and greenfield work

### The Reminder Solution

Reminders inject guidance **at the right moment**:

```
User: "Fix the TypeScript compilation errors"
       ↓
[Reminder triggers: file_pattern matches *.ts]
       ↓
<system-reminder>
TypeScript Rules: No 'any', use Zod schemas, strict null checks.
</system-reminder>
       ↓
LLM receives focused, relevant guidance
```

---

## Quick Start

Create `~/.config/deft/reminders.json`:

```json
[
  {
    "id": "typescript-strict",
    "trigger": { "type": "file_pattern", "pattern": "\\.(ts|tsx)$" },
    "content": "TypeScript: No 'any'. Use Zod for validation. Handle all null cases.",
    "strategy": "sticky",
    "priority": "high"
  }
]
```

That's it. Next time you work with TypeScript files, the reminder activates automatically.

---

## Skill-Scoped Reminders

Declare reminders inline in `SKILL.md` frontmatter. They are registered when the skill is loaded via `read_skill` and merged into the same engine as global reminders.

```yaml
---
name: osd-controller
reminders:
  - id: "osd:saccadic-memory"
    trigger:
      type: "tool_result"
      toolName: "create_workspace"
    content: |
      Focus Shifted: You have created a new active Visual Workspace.
      Previous workspaces are now low-res thumbnails.
      Before moving on, use <scratchpad_update>...</scratchpad_update> to record findings.
    strategy: "sticky"
    priority: "high"
---
```

**Scoping rules:**

- Skill reminder IDs should be namespaced (e.g. `"skillname:reminder-id"`) to avoid colliding with global rules.
- If a skill reminder has the same `id` as a global rule, the skill version overrides it.
- Skill reminders are **not** removed when a skill is unloaded mid-session — once registered, they remain active for the session.
- Multiple skills can be loaded simultaneously; all their reminders are merged and active.

---

## Configuration

### File Locations

| Location                        | Scope                 | Priority         |
| ------------------------------- | --------------------- | ---------------- |
| `~/.config/deft/reminders.json` | Global (all projects) | Base             |
| `.deft/reminders.json`          | Project-specific      | Overrides global |

Project rules with the same `id` override global rules.

### Rule Structure

```json
{
  "id": "unique-identifier",
  "description": "Optional human-readable description",
  "trigger": { "type": "..." },
  "content": "The guidance text injected into context",
  "strategy": "one_shot | sticky | persistent",
  "priority": "low | medium | high"
}
```

---

## Triggers

### `always`

Fires on every user message. Use for universal preferences.

```json
{
  "id": "concise-style",
  "trigger": { "type": "always" },
  "content": "Be concise. No explanations unless asked. Just code.",
  "strategy": "persistent"
}
```

### `file_pattern`

Fires when working with files matching a regex pattern.

```json
{
  "id": "rust-rules",
  "trigger": { "type": "file_pattern", "pattern": "\\.rs$" },
  "content": "Rust: Prefer Result<T,E> over panic. Use clippy lints.",
  "strategy": "sticky"
}
```

**Pattern examples:**

- `\\.(ts|tsx)$` - TypeScript files
- `\\.py$` - Python files
- `src/db/.*` - Database layer files
- `.*\\.test\\.(ts|js)$` - Test files

### `user_message`

Fires when user message matches a pattern. Patterns are matched with **case-insensitive** and **dotAll** flags (`/pattern/is`), unlike other triggers which use default (case-sensitive) matching.

```json
{
  "id": "debugging-mode",
  "trigger": { "type": "user_message", "pattern": "(fix|debug|error|bug)" },
  "content": "Debugging: Find root cause first. Minimal changes. Add logging if needed.",
  "strategy": "sticky"
}
```

### `tool_call`

Fires when a tool is about to execute (pre-execution). The reminder is **queued** and injected into the LLM's context in the **next iteration**, after the tool result arrives — so the LLM sees both the result and the reminder together. Best used sparingly for redirecting toward better tool choices. For post-execution reactions, prefer `tool_result` or `tool_error`.

```json
{
  "id": "prefer-lsp-tools",
  "trigger": {
    "type": "tool_call",
    "toolName": "^(read_file|search|agentic_search)$"
  },
  "content": "PREFER LSP TOOLS: Unless LSP is unavailable, prefer get_references, get_file_structure for code navigation.",
  "strategy": "one_shot"
}
```

**With file pattern (use sparingly):**

```json
{
  "id": "careful-config-edit",
  "trigger": {
    "type": "tool_call",
    "toolName": "write_file",
    "filePattern": "config.*\\.json$"
  },
  "content": "Config file edit: Validate JSON structure. Preserve existing keys.",
  "strategy": "one_shot"
}
```

### `tool_result`

Fires after a tool completes. Can filter by output pattern or success status.

```json
{
  "id": "run-tests-after-write",
  "trigger": {
    "type": "tool_result",
    "toolName": "write_file",
    "outputPattern": "\\.test\\.(ts|js)$"
  },
  "content": "Test file written. Run 'npm test' to verify.",
  "strategy": "one_shot"
}
```

**Filter by success/failure:**

```json
{
  "id": "build-failure-hint",
  "trigger": {
    "type": "tool_result",
    "toolName": "run_cmd",
    "success": false
  },
  "content": "Build failed. Use get_lsp_diagnostics for precise error locations.",
  "strategy": "one_shot"
}
```

**Match all tools:**

```json
{
  "id": "truncation-warning",
  "trigger": {
    "type": "tool_result",
    "toolName": ".*",
    "outputPattern": "Output truncated"
  },
  "content": "Output was truncated. Use pagination or more specific queries.",
  "strategy": "one_shot"
}
```

### `tool_error`

Fires when a tool fails.

```json
{
  "id": "patch-recovery",
  "trigger": { "type": "tool_error", "toolName": "patch" },
  "content": "Patch failed. Do NOT retry patch. Use write_file to replace entire file.",
  "strategy": "one_shot"
}
```

### `iteration`

Fires every N agent loop iterations.

```json
{
  "id": "long-session-warning",
  "trigger": { "type": "iteration", "every": 15 },
  "content": "Long session detected. Consider: commit changes, break into subtasks, or ask user.",
  "strategy": "one_shot"
}
```

**Remaining iterations threshold:**

```json
{
  "id": "approaching-limit",
  "trigger": { "type": "iteration", "remainingBelow": 3 },
  "content": "Less than 3 iterations remaining. Wrap up current task immediately.",
  "strategy": "sticky",
  "priority": "high"
}
```

### `context`

Fires based on agent state conditions.

**Loop detected:**

```json
{
  "id": "break-loop",
  "trigger": {
    "type": "context",
    "condition": { "type": "loop_detected" }
  },
  "content": "Tool loop detected. STOP. Explain the problem and ask for guidance.",
  "strategy": "one_shot"
}
```

**Repeated failures:**

```json
{
  "id": "patch-give-up",
  "trigger": {
    "type": "context",
    "condition": {
      "type": "repeated_failures",
      "toolName": "patch",
      "count": 2
    }
  },
  "content": "Multiple patch failures. Switch to write_file immediately.",
  "strategy": "one_shot"
}
```

**Tool not used:**

```json
{
  "id": "todo-nudge",
  "trigger": {
    "type": "context",
    "condition": {
      "type": "tool_not_used",
      "toolName": "todo_write",
      "turns": 5
    }
  },
  "content": "Complex task detected. Consider using todo list to track progress.",
  "strategy": "one_shot"
}
```

**Manual tag:**

```json
{
  "id": "database-context",
  "trigger": {
    "type": "context",
    "condition": { "type": "tag_active", "tag": "database" }
  },
  "content": "Database context: Use transactions. Handle connection errors. No raw SQL.",
  "strategy": "sticky"
}
```

Activate with `/tag database` command, deactivate with `/untag database`.

**Low context window:**

```json
{
  "id": "context-warning",
  "trigger": {
    "type": "context",
    "condition": {
      "type": "low_context_window",
      "threshold": 10000
    }
  },
  "content": "Context window is running low. Consider: commit changes, start new session, or summarize progress.",
  "strategy": "sticky",
  "priority": "high"
}
```

> **Note:** `low_context_window` requires `contextWindow` to be configured in your LLM settings. The `threshold` defaults to 10000 tokens if not specified.

**`session_needs_title`** only fires for the main assistant role — sub-agents (subtask, agentic_search) never trigger it.

**Session needs title:**

```json
{
  "id": "auto-title",
  "trigger": {
    "type": "context",
    "condition": { "type": "session_needs_title" }
  },
  "content": "Generate a title using <set_title>Your Title</set_title>.",
  "strategy": "persistent",
  "priority": "low"
}
```

This condition fires when the session has no title. Typically used internally.

---

## Browser Mode (Koi Extension)

In browser mode, global reminders are stored as a JSON array in the active config profile (`chrome.storage.local`) and loaded via `addRules()` at session start — the same merge/override logic applies (same `id` overwrites).

Skill-scoped reminders work identically to CLI mode: declared in `SKILL.md`, registered when the skill loads, merged into the shared engine.

### Trigger Availability in Browser Mode

Not all trigger types are equally useful in browser mode since there is no filesystem or shell:

| Trigger                  | Browser Mode                                                              |
| ------------------------ | ------------------------------------------------------------------------- |
| `always`                 | ✅ Works                                                                  |
| `user_message`           | ✅ Works                                                                  |
| `tool_call`              | ✅ Works (browser tool names like `navigate_page`, `take_screenshot`)     |
| `tool_result`            | ✅ Works                                                                  |
| `tool_error`             | ✅ Works                                                                  |
| `iteration`              | ✅ Works                                                                  |
| `context`                | ✅ Works (`loop_detected`, `low_context_window`, `session_needs_title`)   |
| `file_pattern`           | ⚠️ No filesystem — never fires in browser mode                            |
| `context: tag_active`    | ⚠️ The `/tag` command is CLI-specific; not available in the Koi extension |
| `context: tool_not_used` | ✅ Works (tracks browser tool usage)                                      |
| `tool_call: filePattern` | ⚠️ Matches file paths in tool args — not meaningful for browser tools     |

---

## Strategies

### `one_shot`

Fire once, then never again (until session reset).

**Use for:**

- Post-action reminders ("run tests after writing test file")
- Error recovery suggestions
- One-time warnings

### `sticky`

Once triggered, stays active for the entire session.

**Use for:**

- Language-specific rules (activate when first `.ts` file touched)
- Mode switches (debugging mode persists after "fix this bug")
- Project context that shouldn't repeat

### `persistent`

Always evaluates its trigger on every event — never suppressed by one_shot/sticky gating. Typically paired with `always` trigger for universal rules, but can use any trigger type (e.g., a `persistent` + `file_pattern` rule fires on every turn where a matching file is active).

**Use for:**

- User preferences ("be concise")
- Universal style rules
- Safety reminders

---

## Priority

Controls injection order:

| Priority | Position               |
| -------- | ---------------------- |
| `high`   | First (most prominent) |
| `medium` | Middle (default)       |
| `low`    | Last                   |

---

## Schema Reference

> **Note:** The `toolName` and `pattern` fields support JavaScript regex syntax.

```typescript
type ReminderStrategy = "one_shot" | "sticky" | "persistent";
type ReminderPriority = "low" | "medium" | "high";

type ReminderTrigger =
  | { type: "always" }
  | { type: "file_pattern"; pattern: string }
  | { type: "user_message"; pattern: string }
  | { type: "tool_call"; toolName: string; filePattern?: string } // pre-execution, queued for next iteration
  | {
      type: "tool_result";
      toolName: string;
      outputPattern?: string;
      success?: boolean;
    }
  | { type: "tool_error"; toolName: string }
  | { type: "iteration"; every?: number; remainingBelow?: number }
  | { type: "context"; condition: ContextCondition };

type ContextCondition =
  | { type: "tool_not_used"; toolName: string; turns: number }
  | { type: "repeated_failures"; toolName: string; count: number }
  | { type: "loop_detected" }
  | { type: "tag_active"; tag: string }
  | { type: "low_context_window"; threshold?: number } // default: 10000
  | { type: "session_needs_title" }; // main assistant role only

interface ReminderRule {
  id: string;
  description?: string; // not injected into LLM — author notes only
  trigger: ReminderTrigger;
  content: string;
  strategy: ReminderStrategy;
  priority?: ReminderPriority; // default: "medium"
}
```

---

## Examples

### Language-Specific Rules

```json
[
  {
    "id": "lang-typescript",
    "trigger": { "type": "file_pattern", "pattern": "\\.(ts|tsx)$" },
    "content": "TypeScript:\n- No 'any' type\n- Use Zod for runtime validation\n- Strict null checks\n- Explicit return types",
    "strategy": "sticky",
    "priority": "high"
  },
  {
    "id": "lang-python",
    "trigger": { "type": "file_pattern", "pattern": "\\.py$" },
    "content": "Python:\n- Type hints (PEP 484)\n- PEP 8 style\n- Use pathlib over os.path\n- Context managers for resources",
    "strategy": "sticky",
    "priority": "high"
  },
  {
    "id": "lang-rust",
    "trigger": { "type": "file_pattern", "pattern": "\\.rs$" },
    "content": "Rust:\n- Result<T,E> over panic!\n- cargo clippy clean\n- Minimize unsafe\n- Document public API",
    "strategy": "sticky",
    "priority": "high"
  }
]
```

### Tool Guidance

```json
[
  {
    "id": "prefer-lsp-tools",
    "trigger": {
      "type": "tool_call",
      "toolName": "^(read_file|search|agentic_search)$"
    },
    "content": "PREFER LSP TOOLS: Unless LSP is unavailable, prefer get_references, get_file_structure for code navigation.",
    "strategy": "one_shot",
    "priority": "high"
  },
  {
    "id": "patch-error",
    "trigger": { "type": "tool_error", "toolName": "patch" },
    "content": "Patch failed. Use write_file to replace entire file. Do NOT retry patch.",
    "comment": "add this only when autoHeal is enabled",
    "strategy": "one_shot",
    "priority": "high"
  },
  {
    "id": "test-after-write",
    "trigger": {
      "type": "tool_result",
      "toolName": "write_file",
      "outputPattern": "\\.(test|spec)\\."
    },
    "content": "Test file written. Run tests to verify.",
    "strategy": "one_shot",
    "priority": "medium"
  }
]
```

### Session Management

```json
[
  {
    "id": "checkpoint",
    "trigger": { "type": "iteration", "every": 10 },
    "content": "Session checkpoint: Consider committing changes or breaking into subtasks.",
    "strategy": "one_shot",
    "priority": "medium"
  },
  {
    "id": "anti-loop",
    "trigger": {
      "type": "context",
      "condition": { "type": "loop_detected" }
    },
    "content": "Loop detected. Stop current approach. Explain blockers to user.",
    "strategy": "one_shot",
    "priority": "high"
  }
]
```

### Project-Specific Overrides

Global `~/.config/deft/reminders.json`:

```json
[
  {
    "id": "style",
    "trigger": { "type": "always" },
    "content": "Be verbose.",
    "strategy": "persistent"
  }
]
```

Project `.deft/reminders.json`:

```json
[
  {
    "id": "style",
    "trigger": { "type": "always" },
    "content": "Be concise.",
    "strategy": "persistent"
  }
]
```

Result: Project rule wins (same `id`).

---

---

## Debugging

Enable verbose logging to see reminder activity:

```bash
deft --verbose
```

Output:

```
[ReminderEngine] Loaded 12 rules (8 global, 4 project)
[ReminderEngine] Triggered: lang-typescript (sticky)
[ReminderEngine] Injecting 2 user message reminders
[ReminderEngine] Triggered: patch-pre (one_shot)
```

---

## Best Practices

1. **Start minimal** — Add rules as you notice patterns, not preemptively
2. **Use sticky for languages** — Activates once, stays relevant
3. **Use one_shot for actions** — Prevents repetitive guidance
4. **Keep content brief** — Models respond better to concise rules
5. **Test with verbose** — Verify triggers fire when expected
6. **Project overrides** — Don't fight global rules, override by `id`
