---
name: sandbox-shell
version: 2.3.0
description: >-
  A shell on the user's machine inside a safety sandbox — the bridge to the
  local filesystem and toolchain. Load this whenever a task touches the
  user's machine, not just for coding: reading or searching local files,
  logs, and directories (cat/tail/grep/rg/find over any path), checking
  installed tools and versions, running a script, test, or one-off command
  (python/node/jq/awk/...), and processing data too large to paste into
  chat. Produced files are delivered to the user via an outbox. Also the
  full coding workflow: LSP code navigation, overlay edits, build/test with
  the host toolchain, git-patch shipping, browser verification of dev
  servers. The host is read-only inside the sandbox (writes land in an
  overlay; nothing on the machine changes unless the user applies exported
  patches or takes files from the outbox), so it is safe to load and use
  liberally. Code navigation spans three tiers: LSP (semantic), tree-sitter
  (structural/boundary-aware, via the optional ast-grep CLI), and ripgrep
  (text). Not needed for purely in-browser/web tasks with no local-file
  or local-execution component.
mcp-servers:
  - name: sandbox
    type: remote
    gateway: default
    server: sandbox
allowed-tools:
  - runBrowserScript
  - navigatePage
  - newPage
  - selectPage
  - waitFor
  - getPageContext
  - takeScreenshot
  - takeSnapshot
  - listConsoleMessages
  - listPages
  - sandbox_exec
  - sandbox_open_project
  - sandbox_write_file
  - sandbox_apply_patch
  - sandbox_start_service
  - sandbox_restart_service
  - sandbox_service_logs
  - sandbox_stop_service
  - sandbox_reset
  - sandbox_info
  - search
  - search_ast
  - read_ast_node
  - get_references
  - get_hover
  - get_implementation
  - get_file_structure
  - get_lsp_diagnostics
guardrails: scripts/guardrail.js
reminders:
  - id: "sandbox:restart-services"
    trigger:
      type: "tool_result"
      toolName: "^(sandbox_apply_patch|sandbox_write_file)$"
    content: "You just edited a file. If there are running services (like a dev server), you MUST call sandbox_restart_service for them to see the changes."
    strategy: "one_shot"
  - id: "sandbox:outbox-delivery"
    trigger:
      type: "tool_result"
      toolName: "sandbox_exec"
      outputPattern: "git (format-patch|bundle create)"
    content: "Artifact generated! Tell the user the exact host path from sandbox_info.outbox AND the exact filename you just wrote (ls it). Remember: Files left in the overlay are invisible to the user."
    strategy: "one_shot"
  - id: "sandbox:creds-access"
    trigger:
      type: "tool_result"
      toolName: "sandbox_exec"
      # JS RegExp has no inline (?i) flag, and tool_result patterns are matched
      # case-SENSITIVELY (only user_message triggers get /is). The old pattern
      # threw "Invalid group" on every tool result, so this rule never fired.
      outputPattern: "([Pp]ermission denied|401 [Uu]nauthorized|[Aa]uth required|[Cc]redentials not found|[Cc]ould not read [Uu]sername)"
    content: "If a command failed due to missing credentials (e.g., pulling a private package), tell the user: 'I need access to your local credentials to pull this private package. Please restart my MCP server with the --allow-creds flag or set KOI_ALLOW_CREDS=1 in the environment, and I'll try again.'"
    strategy: "one_shot"
    priority: "high"
---

# Sandbox Shell

You have a **shell on the user's machine inside a sandbox**, plus **LSP code intelligence** for project work.

👑 **The Golden Rules:**

1. **Read-Only Host:** You cannot modify the host directly. All writes go to your local overlay.
2. **Delivery:** For an EXISTING project, the only way to send files to the user
   is `$KOI_OUTBOX`. For a GREENFIELD project the overlay tree is itself
   host-visible at `sandbox_info.overlayHostPath` and the user copies it out —
   delivery there is automatic and cannot fail. See "Shipping changes".
3. **LSP Syncing:** Use `sandbox_apply_patch` or `sandbox_write_file` to edit code. Shell edits (`sed -i`) will **not** update the LSP's memory.
4. **No Guessing:** Never guess the outbox path or context lines for a patch. Always read the file or call `sandbox_info` first.
5. **Masked Paths:** The host's `/tmp`, `/run`, and credential files (`~/.ssh`, `~/.aws`, etc.) are hidden for security. **Never** tell the user these files "do not exist". Explicitly state: _"This path is masked from the sandbox."_ If you need them for a build, ask the user to restart the MCP server with `--allow-creds`.

## Quick shell mode (no project needed)

For anything that is not sustained work on one codebase (e.g. "read this log", "find files matching X", "run this script"), just call `sandbox_exec`. The server boots projectless (cwd is `$HOME`) and the **whole host is readable**. Do not ask the user for a "project path" for tasks like these.

## Project mode: first actions

For sustained work on one codebase (editing, building, testing, shipping patches), you must open the project first.

1. Call `sandbox_open_project({ path })`. This sets the shell/overlay scope **and** points code intelligence (LSP) at the same project. Each new session starts from a **fresh overlay over the host tree**. Its response includes the `outbox` for that project.
2. Call `sandbox_info` for the full picture (backend, services, `gitWorkflow`).

> **The outbox path changes with the project.** It is keyed by a hash of the
> project path, so a value you noted before `sandbox_open_project` is stale the
> moment you open a different project. Never quote an outbox path from memory
> or from earlier in the conversation — re-read it from the most recent
> `sandbox_open_project` / `sandbox_info` response immediately before you tell
> the user where their files are. A wrong path is indistinguishable from lost
> work.

## Mental model (critical)

| Layer        | What it is                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| Host tree    | Real project; **read-only** to you                                                                                |
| Overlay      | Your writes, including `.git` mutations — commits stay here, host untouched                                       |
| Outbox       | `$KOI_OUTBOX` in your shell; files written there appear on the host                                               |
| Overlay path | `sandbox_info.overlayHostPath` — the overlay's host-side location. On greenfield this is the whole project tree   |
| Services     | Long-running processes owned by the server (e.g. dev servers)                                                     |
| LSP          | Host-tree index **plus your synced edits** — write/patch tools mirror into it (shell-side edits are not mirrored) |

## Navigating code: LSP first, tree-sitter second, grep last

Prefer semantic tools over `grep`/`rg` for symbols. They use the language server (Rust, TS, C++, Go, Python).

- `search` (LSP-backed, text fallback)
- `search_ast` (tree-sitter structural patterns)
- `get_references` (file, line, column)
- `get_hover`
- `get_implementation`
- `get_file_structure`
- `get_lsp_diagnostics`

**Both upper tiers can be absent on a given machine.** The language server may
be down and the `ast-grep` CLI may not be installed, which takes out
`get_lsp_diagnostics`, `read_ast_node` and `search_ast` together and leaves you
on ripgrep plus `sed -n '<start>,<end>p'` for reading ranges. That is a
supported way to work — just notice it early rather than assuming the fancy
tools are available.

`get_lsp_diagnostics` now **throws** when no server analyzed the file, instead
of returning an empty list. Empty means clean; an error means unchecked. Never
treat "no diagnostics" from a degraded backend as a passing build — run the
project's own compiler (`tsc --noEmit`, `cargo check`) to confirm.
**LSP Tool Examples:**

- `search({ query: "ClassName" })`
- `get_references({ file_path: "src/main.ts", line: 10, column: 5 })`

### Tree-sitter: `search_ast` and `read_ast_node`

LSP is the **brain** — it knows `User` in one file is the same type as `User`
in another. Tree-sitter is the **eyes** — it knows exactly where the `User`
class starts and ends. You need both.

Tree-sitter needs no index and no language server, works on a file with a
syntax error three lines above, and answers in milliseconds. `search` already
falls back to it automatically when the LSP is cold, missing, or the project
does not build; the two tools below are for when you want it deliberately.

**`read_ast_node` — read one declaration, not the file.**

This is your defence against burning the context window on a 3,000-line file.
LSP tells you `handleSubmit` is on line 450; tree-sitter tells you it spans
450-612 and hands you exactly those lines.

```
read_ast_node({ file_path: "src/app.ts", name: "handleSubmit" })
read_ast_node({ file_path: "src/user.rs", name: "User", node_type: "class" })
```

It reads through your overlay, so it reflects unshipped edits. **To replace a
declaration:** call it first, then use the returned `code` as patch context for
`sandbox_apply_patch` — `start_line`/`end_line` give you the exact span. Never
hand-count context lines (Golden Rule 4).

**`search_ast` — find a code shape.**

Use it when the thing you want is a shape, not a name: calls with a particular
argument, empty catch blocks, functions returning `Result`.

Pattern syntax: `$VAR` = one node (captured), `$$$ARGS` = zero or more nodes,
`$_` = one node, uncaptured. A pattern must be parseable code on its own —
`foo($$$)` works, `foo(` does not.

```
search_ast({ pattern: "console.log($$$ARGS)", lang: "ts" })
search_ast({ pattern: "fn $NAME($$$) -> Result<$OK, $ERR> { $$$ }", lang: "rust" })
search_ast({ pattern: "await $CALL", file_path: "src/tools/search-code.ts" })
```

Relational queries ("X inside Y") use `rule` with inline ast-grep YAML instead
of `pattern`.

**Choosing a tool:**

| You want                           | Tool                                          |
| ---------------------------------- | --------------------------------------------- |
| where is `UserService` defined     | `search`                                      |
| the body of `handleSubmit`, only   | `read_ast_node`                               |
| who actually calls this symbol     | `get_references` (semantic; resolves aliases) |
| every call with a literal password | `search_ast`                                  |
| any string containing TODO         | `search` (text tier)                          |

**Caveats:**

- Tree-sitter is **syntactic**. Same-named symbols in unrelated modules all
  match. For true call sites, `get_references` is still correct.
- A **directory** search reads the host tree and will not see edits you have
  not shipped. Pass `file_path` to go through your overlay.

If a tool reports that `ast-grep` is missing, tell the user how to install it
(`npm install -g @ast-grep/cli`, `brew install ast-grep`, or
`cargo install ast-grep --locked`) and that the Gateway needs a restart
afterwards. Do not retry until they confirm; `search` still works meanwhile.

Never run `ast-grep -U` / `--update-all` in `sandbox_exec` — it rewrites files
behind the LSP's back. Preview with `--rewrite`, apply with
`sandbox_apply_patch`.

## Build / test / services

- `sandbox_exec` for finite work: `make`, `cargo build`, `npm test`.
- `sandbox_start_service` for background dev servers. After edits, use `sandbox_restart_service` so the service sees your overlay changes.

**Shell is `/bin/sh`, not bash.** Commands run through `sh -c`, so bashisms
fail with `Bad substitution` / `Illegal number`: no `${PIPESTATUS[@]}`, no
`<(...)` process substitution, no `[[ ]]`. To capture the exit code of a
command whose output you also want to filter, redirect to a file and check
`$?` on its own line (`cmd > out.log 2>&1; echo "EXIT: $?"; grep ... out.log`)
rather than piping and reading `PIPESTATUS`.

**Timeout Reminder:**
The default timeout for `sandbox_exec` is 120,000ms (2 minutes). For heavy commands like `npm install`, `cargo build`, or downloading large dependencies, you **must** pass a higher `timeout_ms` (e.g., `300000` for 5 minutes) to prevent premature termination.

## Shipping changes (Git-native)

0. **Ignore first:** before the FIRST `git add -A` in a new repo, write `.gitignore` (`node_modules/`, `dist/`, `build/`, `target/`, `.venv/`, `__pycache__/`, `.next/`, `coverage/`, `*.log`, `.env`). You ship **source and config only** — keep the manifest and the lockfile so the user can rebuild. An artifact carrying installed dependencies or build output is a defect; the git wrapper will refuse to export one.
1. **Checkpoint:** `git add -A && git commit -m "feat: your changes"` (Host is untouched; this lives in your overlay).
2. **Export — one form only, whichever `sandbox_info.gitWorkflow` names:**
   - existing host tree: `git format-patch -o "$KOI_OUTBOX" <base>..HEAD` (use `git rev-parse HEAD` at session start to get `<base>`)
   - **greenfield** (the host path did not exist): **nothing here is
     load-bearing.** Everything you write already lives on the host at
     `sandbox_info.overlayHostPath`, and the user materializes the project with:

     ```sh
     mkdir -p <project-dir>
     cp -r <overlayHostPath>/. <project-dir>/
     ```

     That works even if the session dies mid-edit, so the work is never at
     risk and you must not spend the session defending it. Still `git init` +
     commit: one command, and it is what turns a directory the user has to
     excavate into a result they can read.

     Optionally add a bundle for a clean-history clone. Use a **real branch**
     under a **sha-stamped** name — a fixed `project.bundle` silently
     overwrites, so a stale one is indistinguishable from a fresh one, and a
     bundle carrying only `HEAD` clones into a detached HEAD:

     ```sh
     SHA=$(git rev-parse --short HEAD)
     BR=$(git symbolic-ref --quiet --short HEAD) || { git checkout -B main; BR=main; }
     rm -f "$KOI_OUTBOX"/project-*.bundle
     git bundle create "$KOI_OUTBOX/project-$SHA.bundle" "$BR" HEAD
     ```

     The `rm` keeps exactly one bundle in the outbox, and its name carries the
     commit it was cut from — compare it against `git rev-parse --short HEAD`
     before you report. That `rm` is the **only** deletion permitted inside
     `$KOI_OUTBOX`: it matches a sanctioned exemption in the guardrail, exactly
     as written above. Any other `rm`/`mv` there — a `*.patch` sweep, a
     wildcard clear — is blocked, and rightly so; if you think the outbox holds
     something wrong, say so in your report instead. There is no host base, so
     `format-patch`/`git am` never
     apply to a greenfield project: **never** hand the user a
     `cd <dir> && git am` command for a directory that does not exist.

3. **Verify:** `git ls-files | wc -l` (tens, not thousands) and `du -h` on the artifact. A surprising size means `.gitignore` came too late — `git rm -r --cached <dir>`, commit, re-export.
4. **Report — state exactly what exists; never make the user guess.** Give the
   real host path (from `sandbox_info`, **never** from memory — both the outbox
   and the overlay path are keyed by a hash of the project path) and the exact
   command: greenfield → the `cp -r` above, plus `git clone <bundle>` if you
   made one; existing tree → `git am <outbox-path>/0001-....patch`. Read real
   filenames off `ls "$KOI_OUTBOX"` — quote those, never a `<sha>` placeholder.
   Say plainly what is _intermediate_ or _uncommitted_, and call out anything
   already in the outbox that your session did **not** write, so a leftover
   from an earlier run is never mistaken for today's output.

## Typical session

1. `sandbox_info`; `sandbox_open_project`; `git rev-parse HEAD` as `<base>`.
2. Explore with `search` / `get_references`.
3. Edit with `sandbox_apply_patch`.
4. Build/test with `sandbox_exec`.
5. `git commit` per verified milestone.
6. Export per `gitWorkflow` (`git format-patch -o "$KOI_OUTBOX" <base>..HEAD`; on greenfield the `cp -r` from `overlayHostPath` is the delivery and a sha-stamped `git bundle create` is optional) → tell the user the real host path, the exact artifact filenames, and the matching `cp -r` / `git am` / `git clone` command.
