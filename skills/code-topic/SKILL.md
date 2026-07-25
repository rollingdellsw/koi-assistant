---
name: code-topic
description: Run a long-lived, multi-session, autonomous CODING task in the host sandbox from a single natural-language goal. Ships results as a reviewable git artifact — a patch series against an existing tree, or the whole overlay tree for a new project — and never touches the host tree directly.
runnable: true
allowed-tools:
  - startCodeTopic
guardrails: scripts/guardrail.js
reminders:
  - id: "code-topic:handoff"
    trigger:
      type: "tool_call"
      toolName: "^(readSkill|sandbox_.*)$"
    content: "STOP. This session's only job is to hand the goal to startCodeTopic. Do not load sandbox-shell and do not touch the sandbox yourself — call startCodeTopic({ goal }) with the user's goal text now."
    strategy: "one_shot"
    priority: "high"
prerequisites:
  - "*Start Koi Gateway Service First*: follow instruction in https://github.com/rollingdellsw/koi-assistant/blob/main/docs/skill_api.md#74-the-koi-gateway"
parameters:
  - name: goal
    description: The engineering task, in plain language. Say what "done" looks like — build/tests green, which pages or behaviors must work. The directory goes in `project_path`, not here. The planner will ask about anything genuinely ambiguous (scope, fidelity bar, data source) before work starts.
    required: true
  - name: budget_cap
    description: Maximum total tokens to spend across all worker/judge/curator sessions before pausing to ask whether to continue. Plain integer (e.g. 10000000 for 10M). Defaults to 10000000.
    required: false
    default: "10000000"
  - name: stream_tools
    description: Stream the worker's sandbox tool calls into the panel as live progress. A code topic otherwise runs silently for minutes to hours. Set to "false" for a quiet run. Named to match the startCodeTopic tool parameter and the scripts/run.js third argument; do not rename one without the others.
    required: false
    default: "true"
  - name: session_context
    description: Per-session context window in tokens for each worker session (the topic rotates to a fresh session when one fills, carrying its memory forward). Plain integer. Defaults to 160000. Raise it when one unit of work does not fit in a single session — a refactor that must hold many modules at once — or lower it to force shorter sessions that commit more often. Must not exceed the context window the configured model actually accepts; the value is clamped to [32000, 2000000]. Named to match the startCodeTopic tool parameter and the scripts/run.js fourth argument; do not rename one without the others.
    required: false
    default: "160000"
  - name: project_path
    description: >-
      The host directory the project lives in. **It must already exist** — for a brand-new project, create it empty first (`mkdir -p ~/my-app`). A path that does not exist ABORTS the run before anything is built. Type it exactly as you would in a shell — a leading `~` is fine and preferred.
    required: true
---

# Code Topic

**Call `startCodeTopic` now. That call IS this skill.** It hands the goal to a
long-lived planner → worker → judge → curator loop that runs the engineering
work across as many sessions as it needs, inside the sandbox, and returns the
accumulated result. You are the caller, not the engineer.

## The only action

```
startCodeTopic({ goal: "<the user's goal text>", project_path: "<the directory, verbatim>", budget_cap: <integer>, stream_tools: true, session_context: <integer> })
```

- `goal` — pass the user's goal through essentially verbatim. Add the
  definition of done **only if the user already said it**; never invent it.
  Everything genuinely ambiguous is the planner's job to ask about, not yours.
- `project_path` — **required**, and the directory must already exist. Copy
  what the user named character for character. Keep a leading `~` as a `~`:
  the harness expands it against the real `$HOME`, and you cannot. Never
  substitute a username, never write `/home/<guess>`. If the user did not say
  which directory, **ask** — do not infer one. A path that does not exist
  stops the run before any work starts; for a brand-new project the user
  creates the directory empty first, and that empty directory is what requests
  a greenfield build.
- `budget_cap` — include only if the user gave a number; otherwise omit it.
- `stream_tools` — pass `true` unless the user asked for a quiet run. It shows
  the sandbox tool calls live, so a long run is not a blank panel.
- `session_context` — include only if the user gave a number; otherwise omit it
  and every worker session gets the 160k default. It caps ONE session, not the
  run: `budget_cap` is what limits the whole topic.
- The call **blocks** for a long time (minutes to hours) and drives its own UI.
  That is expected. Do not poll, do not retry it, do not call it twice.

## Do not do the work in this session

The topic runs in its own worker sessions with their own tools, memory, and
guardrails. Anything you do here instead is a strictly worse, single-session,
memoryless version of it, and it will be blocked by this skill's guardrail:

- Do **not** `readSkill({ name: "sandbox-shell" })` here. Workers load it
  themselves; loading it in this session just tempts you to hand-code.
- Do **not** call `sandbox_*`, LSP, or browser-verification tools here.
- Do **not** plan, scope, split into steps, or ask the user clarifying
  questions first. The topic's planner is the only role that questions the
  user, and it runs after the call.
- Do **not** substitute `runSubtask` or `startRunTopic` (`startRunTopic` is
  read-only research; it cannot edit code).

## When this is the wrong tool

- A single-file edit or a one-off command → load `sandbox-shell` and do it
  interactively instead of starting a topic.
- Research or collection with no code changes → `topic-runner` / `startRunTopic`.

## Reporting the result

`startCodeTopic` returns `status` (`"done" | "stopped" | "exhausted"`) plus the
accumulated findings: the continuity ledger, the ordered patch list, the final
build/test status, and the work summary.

A `stopped` status whose findings begin with `## Run not started` means
pre-flight refused before any session ran — a missing directory, a project the
sandbox would not open, or a path that never arrived. Nothing was built and
nothing was shipped: present that block verbatim and stop. Do not re-run with
a guessed path, and do not treat it as a partial result.

Present the findings to the user **leading with the `## Deliverable` block the
topic returns, verbatim**. It already resolves the two cases: an existing tree
ships patches with a `git am` command, a greenfield project ships the overlay
tree with a `cp -r` command and no patches at all. Do not translate it into
patch filenames — on a greenfield run there are none.
