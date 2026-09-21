---
name: sandbox-shell
version: 2.5.0
description: >-
  A shell on the user's machine inside a safety sandbox — the bridge to the
  local filesystem and toolchain. Load this whenever a task touches the
  user's machine, not just for coding: reading or searching local files,
  logs, and directories (cat/tail/grep/rg/find over any path), checking
  installed tools and versions, running a script, test, or one-off command
  (python/node/jq/awk/...), and processing data too large to paste into
  chat. Produced files are delivered to the user via an outbox. Also the
  full coding workflow: code navigation, overlay edits, build/test with
  the host toolchain, git-patch shipping, browser verification of dev
  servers. The host is read-only inside the sandbox (writes land in an
  overlay; nothing on the machine changes unless the user applies exported
  patches or takes files from the outbox), so it is safe to load and use
  liberally. Code navigation is done with the host's own CLIs through the
  shell — a language server front-end (semantic), ast-grep (structural),
  ripgrep (text) — not with dedicated tools. Not needed for purely
  in-browser/web tasks with no local-file or local-execution component.
runnable: true
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
  - overlay_fs_sync
  - sandbox_open_project
  - sandbox_start_service
  - sandbox_restart_service
  - sandbox_service_logs
  - sandbox_stop_service
  - sandbox_reset
  - sandbox_info
  - sandbox_network_policy
guardrails: scripts/guardrail.js
reminders:
  - id: "sandbox:prefer-lsp"
    trigger:
      type: "file_pattern"
      pattern: '\.(ts|tsx|js|jsx|rs|py|go|cpp|c|h|hpp)$'
    content: "Code navigation is shell-based here — there are no navigation tools to call. For cross-file symbol lookups, callers, or implementations, run a language-server CLI or `ast-grep` through `sandbox_exec` (e.g. `ast-grep run -p '<pattern>' --lang ts`) before falling back to `rg`/`grep`, which matches comments, strings and unrelated same-named symbols."
    strategy: "sticky"
    priority: "medium"
  - id: "sandbox:outbox-delivery"
    trigger:
      type: "tool_result"
      toolName: "sandbox_exec"
      outputPattern: "git (format-patch|bundle create)"
    content: "Artifact generated! Tell the user the exact host path from sandbox_info.outbox AND the exact filename you just wrote (ls it). Remember: Files left in the overlay are invisible to the user."
    strategy: "one_shot"
  - id: "sandbox:truncation-recovery"
    trigger:
      type: "tool_result"
      toolName: "sandbox_exec"
      outputPattern: "Output truncated"
    content: "Output was truncated. It is safe to redirect chatty build/test logs to a file in the overlay (e.g. `cmd > test.log 2>&1; echo EXIT:$?`), then use `grep -C 5` or `tail -n 50` to inspect the exact failure without flooding context."
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

You have a **shell on the user's machine inside a sandbox**. Everything —
including code navigation — is a command you run in it.

👑 **The Golden Rules:**

1. **Read-Only Host:** You cannot modify the host directly. All writes go to your local overlay.
2. **Delivery:** For an EXISTING project, the only way to send files to the user
   is `$KOI_OUTBOX`. For a GREENFIELD project the overlay tree is itself
   host-visible at `sandbox_info.overlayHostPath` and the user copies it out —
   delivery there is automatic and cannot fail. See "Shipping changes".
3. **Edits Are Shell Writes:** All edits are made via `sandbox_exec` (e.g. atomic Python scripts or `cat << 'EOF' > file`). They land in the overlay, and every later command reads through the overlay — so a tool you run in the next turn already sees them. Nothing needs to be re-synced. If the **user** changes files on the host mid-session (e.g. applies your patches), every `sandbox_exec` pulls their versions in automatically before it runs, and reports it in `hostSync` — read that field when it appears (see "When the host changes under you").
4. **No Guessing:** Never guess the outbox path or context lines for a patch. Always read the file or call `sandbox_info` first.
5. **Masked Paths:** The host's `/tmp`, `/run`, and credential files (`~/.ssh`, `~/.aws`, etc.) are hidden for security. **Never** tell the user these files "do not exist". Explicitly state: _"This path is masked from the sandbox."_ If you need them for a build, ask the user to restart the MCP server with `--allow-creds`.

## Quick shell mode (no project needed)

For anything that is not sustained work on one codebase (e.g. "read this log", "find files matching X", "run this script"), just call `sandbox_exec`. The server boots projectless (cwd is `$HOME`) and the **whole host is readable**. Do not ask the user for a "project path" for tasks like these.

## Project mode: first actions

For sustained work on one codebase (editing, building, testing, shipping patches), you must open the project first.

1. Call `sandbox_open_project({ path })`. This sets the shell/overlay scope: the writable overlay location, the working directory, and the relative path root. Each new session starts from a **fresh overlay over the host tree**. Its response includes the `outbox` for that project.
2. Call `sandbox_info` for the full picture (backend, services, `gitWorkflow`).
3. **Note the `session` id** from the response. It is how you get your overlay back if the connection drops.

## Connection drops and session continuity

A dropped connection ("Connection closed", a failed tool call, the side panel
reconnecting while the user was away) does **not** lose your overlay — but
re-opening the project the wrong way can detach you from it.

1. **Do not call `sandbox_open_project` as a reflex.** Call `sandbox_info` first.
   If `project` and `session` are what you had, just continue: your edits and
   commits are all there.
2. If the session differs (the server restarted, or it was switched), call
   `sandbox_open_project({ path, resume: "<your session id>" })`.
3. If any `sandbox_open_project` response contains **`detachedSession`** or
   **`resumeHint`**, and you are continuing the same task, make the `resume`
   call it names **immediately**, before any edit. A `WARNING:` at the start of
   `note` means the overlay you just got does not contain your earlier work.
   Detached overlays are pinned for 24h, so this is always recoverable if you
   act on it.

Never report work as lost without checking `priorSessions` first.

> **The outbox path changes with the project.** It is keyed by a hash of the
> project path, so a value you noted before `sandbox_open_project` is stale the
> moment you open a different project. Never quote an outbox path from memory
> or from earlier in the conversation — re-read it from the most recent
> `sandbox_open_project` / `sandbox_info` response immediately before you tell
> the user where their files are. A wrong path is indistinguishable from lost
> work.

## Mental model (critical)

| Layer        | What it is                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| Host tree    | Real project; **read-only** to you                                                                              |
| Overlay      | Your writes, including `.git` mutations — commits stay here, host untouched                                     |
| Outbox       | `$KOI_OUTBOX` in your shell; files written there appear on the host                                             |
| Overlay path | `sandbox_info.overlayHostPath` — the overlay's host-side location. On greenfield this is the whole project tree |
| Services     | Long-running processes owned by the server (e.g. dev servers)                                                   |

## Navigating code (all through `sandbox_exec`)

There are **no navigation tools on this endpoint**. Every command below runs in
the shell, reads **through your overlay** (so it sees edits you have not
shipped), and depends on the binary existing on the host.

**Check what you have, once, at the start of project work:**

```bash
command -v rg ast-grep tsc cargo gopls clangd 2>/dev/null; echo "---"
```

Any tier can be missing. Notice that early instead of assuming, and say so in
your report rather than silently degrading.

| Tier       | Command                                                           | Good for                                       |
| ---------- | ----------------------------------------------------------------- | ---------------------------------------------- |
| Semantic   | the project's own type-checker/compiler, or a language-server CLI | real diagnostics, resolving aliased re-exports |
| Structural | `ast-grep run -p '<pattern>' --lang <lang>`                       | code _shapes_, boundary-accurate matches       |
| Text       | `rg -n 'Foo' --glob '!node_modules'`                              | strings, TODOs, config keys, last resort       |

**Ground truth for "is it broken" is the project's own build**, not a search:
`tsc --noEmit`, `cargo check`, `go build ./...`, `pytest -q`. A clean grep is
not a passing build.

### `ast-grep` — structure, not text

Prefer the `ast-grep` binary name over its `sg` alias: on Linux `sg` is also
shadow-utils' setgid shell.

Pattern syntax: `$VAR` = one node (captured), `$$$ARGS` = zero or more nodes,
`$_` = one node, uncaptured. A pattern must be parseable code on its own —
`foo($$$)` works, `foo(` does not.

```bash
ast-grep run -p 'console.log($$$ARGS)' --lang ts src/
ast-grep run -p 'fn $NAME($$$) -> Result<$OK, $ERR> { $$$ }' --lang rust src/
ast-grep run -p 'await $CALL' src/tools/search-code.ts
```

**Read one declaration instead of a 3,000-line file.** This is your main
defence against burning the context window:

```bash
ast-grep run -p 'function handleSubmit($$$) { $$$ }' --lang ts src/app.ts
ast-grep run -p 'class User { $$$ }' --lang rust src/user.rs
```

Relational queries ("X inside Y") take a rule file: `ast-grep scan -r rule.yml`.

**Rewrites:** preview with `--rewrite '<replacement>'`, then apply with `-U`
(or with an atomic Python script if the edit is delicate). Always read the
preview before applying — an ast-grep pattern that matches more than you meant
rewrites all of it in one pass.

If `ast-grep` is missing, tell the user how to install it
(`npm install -g @ast-grep/cli`, `brew install ast-grep`, or
`cargo install ast-grep --locked`) and carry on with `rg` plus
`sed -n '<start>,<end>p'` for reading ranges. That is a supported way to work.

**Caveat that matters:** text and structural search are both **syntactic**.
Same-named symbols in unrelated modules all match, and a re-exported or aliased
symbol will not. When a rename has to be exhaustive, confirm with the
compiler after the edit, not with the search before it.

## Build / test / services

- `sandbox_exec` for finite work: `make`, `cargo build`, `npm test`.
- `sandbox_start_service` for background dev servers. After edits, use `sandbox_restart_service` so the service sees your overlay changes.

### Atomic multi-edit & in-memory verification (`sandbox_exec`)

For delicate multi-location edits, polyglot/embedded scripts, or when recovering from failed patches, prefer executing an **atomic edit-and-verify pipeline** in a single `sandbox_exec` turn:

```bash
cp file.ext file.ext.bak && python3 - <<'PY'
s = open('file.ext').read()

old1 = '''...'''
new1 = '''...'''
assert old1 in s, "old1 not found"
s = s.replace(old1, new1, 1)

old2 = '''...'''
new2 = '''...'''
assert old2 in s, "old2 not found"
s = s.replace(old2, new2, 1)

open('file.ext', 'w').write(s)
print("Edits applied successfully")
PY
npm test && python3 -m pyflakes ...
```

**Why this works best for complex edits:**

- **Transactional safety:** If any `assert` fails, the file is never written to disk.
- **1-turn turnaround:** Edit, build, lint, and test occur in a single round trip.
- **No diff context failures:** Raw multiline strings bypass patch fuzzing and line-number mismatches.
- **Visibility:** Shell writes land in the overlay, and every later command reads through it — the next `ast-grep`/`rg`/`tsc` run already sees them. Host-side changes flow the other way automatically at the start of each `sandbox_exec`; `overlay_fs_sync` only produces the same report without running a command.

### When the host changes under you

If a `sandbox_exec` result contains `hostSync`, the user changed files on their
side (usually by applying your patches) and the sandbox now shows **their**
versions of the listed paths:

- `refreshedFromHost` — re-read these before editing them again; your mental copy is stale.
- `preservedOverlayVersions` — your overlay copy held content git did not have (uncommitted work). It was saved to `savedTo` before the host version replaced it. `diff` it against the file and re-apply whatever is still needed; do not assume the edit is present.
- `preservedOverlayRefs` — overlay commits the host does not have stay reachable at `ref` (`git log <ref>`). After the user applied your patches this is normally just the pre-apply copy of the same work.
- `removedBecauseDeletedOnHost` — the host deleted these; your untouched overlay copy followed.

Then run `git rev-parse HEAD` for a new `<base>` before the next export. A
`syncWarning` means some paths could not be checked or refreshed and may be stale.

**Shell is `bash` (`/bin/bash`).** Commands run through `bash -c`, so standard
bash syntax (such as `[[ ... ]]`, process substitution `<(...)`, and `${PIPESTATUS[@]}`)
is fully supported. Environment defaults include `CI=1`, `DEBIAN_FRONTEND=noninteractive`,
and `TERM=dumb` to prevent interactive CLI prompts and spinners from hanging.

**Managing verbose test & build logs (Log-to-file pattern):**
Heavy test suites (`npm test`, `cargo test`, `pytest`) can emit tens of kilobytes of output, exceeding token caps and truncating root assertion failures. Since the overlay filesystem is safe and isolated:

1. Redirect output to a log file: `npm test > test.log 2>&1; echo "EXIT: $?"`
2. Search for the root failure: `grep -C 5 -E "(FAIL|Error|AssertionError|panic)" test.log | head -n 40` (or `tail -n 30 test.log`)

**Timeout Reminder:**
The default timeout for `sandbox_exec` is 120,000ms (2 minutes). For heavy commands like `npm install`, `cargo build`, or downloading large dependencies, you **must** pass a higher `timeout_ms` (e.g., `300000` for 5 minutes) to prevent premature termination.

## Shipping changes (Git-native)

0. **Ignore first:** before the FIRST `git add -A` in a new repo, write `.gitignore` (`node_modules/`, `dist/`, `build/`, `target/`, `.venv/`, `__pycache__/`, `.next/`, `coverage/`, `*.log`, `.env`). You ship **source and config only** — keep the manifest and the lockfile so the user can rebuild. An artifact carrying installed dependencies or build output is a defect; the git wrapper will refuse to export one.
1. **Checkpoint & Rollback (Native Git in Overlay):**
   The `.git` directory in the overlay is fully writable and isolated from the host. Use standard Git for micro-checkpoints, experimental branches, and instant rollbacks:
   - **Checkpoint milestone:** `git add -A && git commit -m "feat: step 1 passes tests"`
   - **Roll back bad changes:** `git reset --hard HEAD` (or jump to a prior commit: `git checkout <commit>`)
   - **Scratch experiment:** `git checkout -b try-idea` -> discard with `git checkout main && git branch -D try-idea` if it fails.
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
   _(If the user applies your patches mid-session, the next `sandbox_exec` reports it in `hostSync`; run `git rev-parse HEAD` again to get the new `<base>` before making further edits, or you will export duplicate patches)._
2. Explore with `rg` / `ast-grep` via `sandbox_exec`.
3. Edit with atomic in-memory Python script via `sandbox_exec`.
4. Build/test with `sandbox_exec`.
5. `git commit` per verified milestone.
6. Export per `gitWorkflow` (`git format-patch -o "$KOI_OUTBOX" <base>..HEAD`; on greenfield the `cp -r` from `overlayHostPath` is the delivery and a sha-stamped `git bundle create` is optional) → tell the user the real host path, the exact artifact filenames, and the matching `cp -r` / `git am` / `git clone` command.
