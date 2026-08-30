# Running the Koi Gateway

The Gateway is the bridge between the Koi™ browser extension and the tools on your
machine. Browsers cannot open TCP sockets to a database or run a native binary; the
Gateway can, so it runs MCP servers as child processes on your host and bridges them to
the extension over a WebSocket on `127.0.0.1`.

This is the **operator's guide**: install it, configure it, verify it, maintain it, and
understand what it does and does not protect. If you only want to use the sandboxed
shell, read the [`sandbox-shell` skill README](../../skills/sandbox-shell/README.md)
instead — it covers the same sandbox from the user's side, in less detail.

For skill authors: how a skill _declares_ a Gateway server is in
[`docs/skill_api.md` §7.4](../../docs/skill_api.md).

---

## Install

```bash
cd tools/gateway
./koi-gateway-installer          # resolve paths + Node, write the service, enable + start
```

The installer resolves the gateway directory and a stable Node path (fnm/nvm/system)
itself, writes `~/.config/systemd/user/koi-gateway.service` with absolute paths, reloads
the user daemon, and enables lingering so the service survives logout.

It installs **a service and nothing else** — no packages, no changes to your global
npm/pip/cargo prefixes, no `apt`. The toolchains stay yours.

A **user** service, not a system one: the Gateway spawns the sandbox as _you_, with your
`$HOME`, your overlays under `~/.koi/sandbox`, and your Node. A root unit would use the
wrong home and the wrong toolchain.

```bash
systemctl --user status koi-gateway
systemctl --user restart koi-gateway   # clean slate: kills the sandbox child + its services
journalctl --user -u koi-gateway -f
./koi-gateway-installer uninstall      # stop, disable, remove the unit
./koi-gateway-installer render         # print the unit without installing (dry run)
```

The unit runs `run-gateway.sh`, which re-resolves Node at start time (systemd's PATH
omits fnm/nvm), so a Node upgrade will not break it. If Node is not detected, re-run with
`KOI_NODE_BIN=/abs/path/to/node ./koi-gateway-installer`.

**WSL2:** enable systemd once in `/etc/wsl.conf` (`[boot]` → `systemd=true`), then
`wsl --shutdown`. The installer detects a missing systemd user instance and says so.

To run it by hand instead:

```bash
node koi-gateway.js --config gateway-config.json   # [--port 8080]
```

---

## Verify it works

```bash
./koi-gateway-installer status
node test-network-approval.mjs
```

The test script needs no browser, no assistant session, and no API key. It exercises the
real server and prints a pass/fail line per check — including whether egress filtering is
actually _enforced_, not merely configured. Run it first when anything looks wrong; it
will tell you which layer is broken before you start reading logs.

---

## Configuration

Everything is in `gateway-config.json`:

```json
{
  "port": 8080,
  "auth": { "mode": "none" },
  "allowedOrigins": ["chrome-extension://aedfofodkbfgnjknkjpockkgajemkbng"],
  "servers": {
    "postgres": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-postgres",
        "postgresql://..."
      ]
    },
    "sandbox": {
      "command": "node",
      "args": [
        "./sandbox-shell-mcp.mjs",
        "--max-overlay-size",
        "10GB",
        "--net",
        "policy"
      ],
      "autoBuild": {
        "dir": "./lsp_search",
        "check": "dist/index.js",
        "srcDir": "src",
        "commands": ["npm install", "npm run build"]
      }
    }
  }
}
```

| Key              | Controls                                                              |
| ---------------- | --------------------------------------------------------------------- |
| `port`           | WebSocket port, bound to `127.0.0.1` only                             |
| `auth.mode`      | `none` (local single-user) or `sso` (**not implemented — see below**) |
| `allowedOrigins` | Which extension IDs may connect from a browser page                   |
| `servers`        | The MCP servers to spawn, by name (`/mcp/<name>`)                     |
| `autoBuild`      | Build commands run at startup when output is missing or stale         |

The `sandbox` server **embeds code intelligence**: it spawns the compiled `lsp_search`
bundle as its own child and re-exports the navigation tools through the single
`/mcp/sandbox` endpoint. That is why `autoBuild` for `lsp_search` sits under the
`sandbox` entry — the Gateway builds the bundle so the sandbox server finds it next to
itself. Do **not** declare a separate `lsp_search` server for the `sandbox-shell` skill.

`autoBuild` commands run with your shell and your privileges. Set `KOI_REBUILD=1` to
force a rebuild. Only use config files you trust.

**Do not inline secrets here.** Prefer the per-server `env` block. The whole host
filesystem — including this file — is _readable inside the sandbox_, so a password
written here is visible to the LLM session. (`~/.koi` itself is masked; this directory is
not.)

---

## Security model

### The Gateway is loopback-only, and that is not the same as "only my browser"

The Gateway listens on `127.0.0.1` exclusively, and because it fronts arbitrary code
execution it must never be exposed to the LAN. If you need remote access, tunnel it over
SSH rather than changing the bind address.

But with `auth.mode: "none"`, **any process that can reach `127.0.0.1:<port>` can drive
it**. Browser pages are filtered by `allowedOrigins` (WebSocket upgrades carry an
`Origin` header); non-browser clients send no `Origin` and are accepted — which is what
lets the test harness connect. On **WSL2 this includes Windows-side processes**, since
Windows forwards `localhost` into the WSL2 VM.

Run with `auth.mode: "none"` only where every local process is trusted. On a shared or
multi-user host, do not run it until token auth exists.

> ⚠️ **`auth.mode: "sso"` is a stub.** Token verification is not implemented. Do not
> deploy `sso` mode in production and do not treat it as a control.

### What the sandbox guarantees (Linux `bwrap-overlay` backend)

| Property        | Behavior                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host filesystem | Visible **read-only** throughout the sandbox                                                                                                               |
| Writes          | Land in a per-project, per-session overlay; the real project tree is never mutated                                                                         |
| Session base    | Every client connection starts each project from a **fresh overlay over the host tree**. A previous session's unshipped edits are never silently inherited |
| Delivery        | `git format-patch -o "$KOI_OUTBOX"` exports to a host-visible outbox that **you** apply with `git am`. This is the only channel out                        |
| Credentials     | Masked paths come **entirely from `--exclude`** — the server has no built-in list. The environment is cleared regardless                                   |
| `git push`      | Blocked by a git wrapper (guidance; the real protection is credential masking)                                                                             |
| Network         | `host` / `loopback` / `policy` — see [Network egress](#network-egress)                                                                                     |
| Services        | Long-running dev servers are owned by the server (`sandbox_start_service` and friends)                                                                     |
| Reset           | `sandbox_reset` wipes the current session's overlay; exported patches survive                                                                              |

**Backends by platform:**

- **linux** → bubblewrap + overlayfs. Needs `sudo apt install bubblewrap`. On Ubuntu
  24.04 the AppArmor unprivileged-userns restriction may need the bwrap profile, or
  `kernel.apparmor_restrict_unprivileged_userns=0`.
- **darwin** → `sandbox-exec` (seatbelt) + an APFS copy-on-write clone. Host writes are
  denied and credentials are masked with deny-read rules, but the guarantees differ in
  kind from the Linux ones — see [Platform parity](#platform-parity-linux-vs-macos).
  Prefer Linux/WSL2 for untrusted work.
- **exec** → **no isolation whatsoever**. Dev/test only, opt-in via
  `KOI_SANDBOX_BACKEND=exec`.

### Credential masking is configuration, not code

The server ships with **no built-in credential list**. What counts as a secret varies per
host, so the whole mask set is passed in and the server applies exactly what it is given:

```bash
node sandbox-shell-mcp.mjs --exclude "~/.ssh, ~/.aws, ~/vault/keys.txt"
node sandbox-shell-mcp.mjs --exclude "~/.ssh" --exclude "~/.aws"   # repeatable
```

`~` and `$HOME` expand; bare names resolve against `$HOME`. Each path is classified by
what it is on disk — directories masked with a tmpfs, files with a `/dev/null` bind — so
you pass paths without caring which applies. Paths absent from this host are skipped,
which is expected for a shared list. The effective list is always visible at runtime in
`sandbox_info.maskedCredentials`.

> ⚠️ **With no `--exclude`, nothing is masked.** The server prints a loud warning at
> startup. The list is not optional in a real deployment; it just lives in the deployment
> layer rather than in the source.

The standard set ships as **`sandbox-exclude.default`** — one path per line, `#` comments
allowed. Edit it to match your host; `./koi-gateway-installer excludes` shows exactly
what would be masked without installing anything. The installer flattens it into the
unit:

```ini
[Service]
Environment=KOI_SANDBOX_EXCLUDE=~/.ssh,~/.aws,~/.config/gh,~/.gnupg,…
```

`KOI_SANDBOX_EXCLUDE` is the env equivalent of `--exclude`. After editing, re-run
`./koi-gateway-installer` and `systemctl --user restart koi-gateway`.

### Network egress

Three modes, set in `gateway-config.json` or by the installer:

| Mode       | The sandbox can reach               | When                                                      |
| ---------- | ----------------------------------- | --------------------------------------------------------- |
| `host`     | everything, unfiltered              | simplest, least protected                                 |
| `loopback` | nothing at all                      | offline work; dev servers become invisible to the browser |
| `policy`   | an allowlist, plus what you approve | **recommended**                                           |

```bash
./koi-gateway-installer network on       # install + start the filtering proxy
./koi-gateway-installer network status
./koi-gateway-installer network off
```

Hosts are matched by the name (or address) in the proxy's `CONNECT` line. **A raw IP is
just another host string:** it is matched exactly, never inherits an allowlisted name's
grant — allowing `github.com` does not allow the address behind it — and must be approved
or listed on its own. **CIDR ranges are not supported**; `10.0.0.0/8` matches nothing, so
list addresses individually.

In `policy` mode the sandbox gets its own network namespace with no route out except a
filtering proxy. Common development hosts are allowed automatically; anything else pauses
the request and asks you in the side panel, with `once` / `session` / `always` scopes.
"Always" answers persist to `~/.koi/network-policy.json`. Cloud metadata endpoints are
denied outright and cannot be approved.

The filter is installed before your command starts, and the capability that installed it
(`CAP_NET_ADMIN`) is dropped immediately afterwards — so the sandbox cannot take its own
filter down. If that drop is impossible, no command runs.

> ⚠️ **`--net host` is a real exposure.** Host networking is what lets the browser open
> dev servers started inside the sandbox — but it also means the session can reach
> **every service listening on your machine** (databases, Docker APIs, internal
> dashboards) using any credentials it can read from the host tree. Prefer `policy`; use
> `loopback` if you do not need browser verification.

Full detail — the allowlist format, the approval dialog, and what the proxy can and
cannot see over TLS — is in the
[skill README's security model](../../skills/sandbox-shell/README.md#security-model).

### Platform parity: Linux vs macOS

Both platforms deny host writes and route work out through the outbox. They are
**not** equivalent beyond that, and the difference matters if you are running
untrusted work.

| Property                       | Linux (`bwrap-overlay`)                | macOS (`seatbelt-clone`)                     |
| ------------------------------ | -------------------------------------- | -------------------------------------------- |
| Host writes blocked            | ✅ overlay; host tree is a lower layer | ✅ `(deny file-write*)`                      |
| Credential masking             | ✅ paths are **absent** (tmpfs)        | ⚠️ paths are **unreadable**, but still exist |
| Egress filtering               | ✅ nftables default-drop + proxy       | ⚠️ seatbelt `network-outbound` + proxy       |
| Sandbox cannot undo the filter | ✅ `CAP_NET_ADMIN` dropped             | ✅ kernel-enforced; no equivalent capability |
| Enforcement covered by tests   | ✅ suite 6                             | ❌ none — suites 1–4 only                    |
| Isolation of the project tree  | overlayfs (copy-on-write)              | APFS clone (copy-on-write)                   |

Two consequences worth stating plainly:

- **macOS masking is weaker in kind, not just degree.** Linux removes the path
  from the filesystem the sandbox sees; macOS leaves it there and refuses the
  read. A tool that stats `~/.ssh` gets "exists but permission denied" rather
  than "not found", and any gap in the deny list is a readable secret. The
  Linux backend fails safe here; the macOS one fails to whatever the list omits.
- **The macOS enforcement path is not covered by automated tests.** Suite 6
  proves the Linux filter cannot be removed by the process it confines. There is
  no macOS equivalent, so seatbelt egress filtering is verified by reading the
  profile, not by running it. Treat `--net policy` on macOS as "believed
  correct", not "demonstrated correct".

`sandbox_info.credentialMasking` states which of the two mechanisms is live, so
a session can tell you the truth about its own boundary rather than assuming
Linux semantics.

If you are running genuinely untrusted work, prefer Linux (or WSL2).

### Trust boundaries you should know about

- **Opening a project means trusting that repository.** `sandbox_open_project` also
  points code intelligence at it, and language servers run _unsandboxed on the host_;
  some execute project code while indexing (rust-analyzer runs build scripts and proc
  macros).
- **Secrets inside the project tree are visible.** The whole host stays readable; the
  project path only chooses the overlay location. Do not point it at a tree holding
  production credentials.
- **Exported patches are untrusted input.** They are inert until you apply them. Review
  them before `git am`, exactly like a pull request.

---

## Maintenance

### Process reuse and concurrency

MCP child processes are kept alive after the extension disconnects and are reattached on
reconnect. For the `sandbox` server this does **not** leak overlay state between sessions
— the overlay rotates per client connection — but **background services started by a
previous session keep running**, and keep their ports. Check `sandbox_info.services` at
the start of a session and stop anything stale. Restart the Gateway for a guaranteed
clean slate.

**One client at a time per stateful server.** The Gateway multiplexes all WebSocket
clients of a server onto one child process and broadcasts responses to all of them. The
`sandbox` server holds global session state, so two concurrent clients on `/mcp/sandbox`
will corrupt each other's view. Do not open the sandbox skill from two extension windows
at once.

### Disk retention

Prior-session overlays are kept on disk — that is what makes `resume` possible — and are
**never garbage-collected automatically**. Overlays holding build artifacts
(`node_modules/`, `target/`) get large.

Prune them with `rm -rf ~/.koi/sandbox/<project-hash>/sessions/<session-id>/`. Because the
outbox is **project-level**, pruning a session overlay does **not** destroy its exported
patches. Deleting the whole `<project-hash>` directory forgets the project _including its
outbox_ — export or apply anything you care about first.

The state base also holds a tiny `current.json` pointer (which project/session the live
server is attached to, consumed by the `review` CLI below). It is rewritten on every
`sandbox_open_project` and is safe to delete.

### Session model

The unit of isolation is the client connection: each MCP `initialize` rotates the session
id, so every session starts every project from the host tree, never from a previous
session's invisible overlay. Within one session, switching projects and back reuses the
same overlay, so in-progress work is not lost.

- `sandbox_open_project({ path })` — fresh overlay for this session.
- `{ path, resume: "<session-id-or-label>" }` (or `resume: true` for the most recent) —
  deliberately reattach a previous overlay. Prior sessions are listed in
  `sandbox_info.priorSessions`.
- `{ path, label: "<tag>" }` — pin a human-readable tag, resumable later by that tag.
- `{ path, fresh: true }` — force a brand-new overlay mid-session.
- `KOI_SANDBOX_PERSIST=1` restores the legacy always-resume behavior.

### Watching a session live (the `review` CLI)

Everything a session writes lands in its overlay — invisible in your real tree until you
apply patches. `review` opens a **read-only window onto that overlay while the session is
still running**: `git log` / `show` / `diff` / `status` over the merged view, from any
host terminal.

```bash
node sandbox-shell-mcp.mjs review              # snapshot: log, status, diff --stat
node sandbox-shell-mcp.mjs review --watch      # live; -n <sec> to change the 3s refresh
node sandbox-shell-mcp.mjs review log -p -1    # any git args pass through
node sandbox-shell-mcp.mjs review outbox       # patches so far + a ready `git am` line
node sandbox-shell-mcp.mjs review --help
```

By default it follows the live server's current project/session via the `current.json`
pointer, re-resolving on every watch tick so it tracks a mid-run session rotation. `--session <id-or-label>` pins one
overlay; `--project <dir>` inspects a project's leftover overlays cold with no server
running, which is how you audit an old session before pruning it. `sandbox_info` and
`sandbox_open_project` include the exact command as `reviewCommand`.

**It is safe against a running worker.** Each invocation builds its own read-only overlay
(`bwrap --ro-overlay`) using the session's upperdir purely as a lower layer, and runs git
with `--no-optional-locks`, so even `status` writes nothing. The worst race is a
momentarily inconsistent view that corrects itself on the next refresh.

---

## Code intelligence prerequisites

The `sandbox` server re-exports code navigation over three tiers. Each is **optional and
degrades independently**: no language server skips the semantic tier, no `ast-grep` skips
the structural tier, no `rg` skips text search. Startup logs what it could not find, and
`sandbox_open_project` reports `codeIntelligence.available`.

**You install these yourself** — the installer does not add packages.

```bash
# Text tier
sudo apt install ripgrep                 # or: brew install ripgrep

# Structural tier (tree-sitter)
npm install -g @ast-grep/cli             # or: brew install ast-grep

# Semantic tier — only the languages you use
pip install python-lsp-server[all]                    # Python
npm install -g typescript-language-server typescript  # JS/TS
rustup component add rust-analyzer                    # Rust
go install golang.org/x/tools/gopls@latest            # Go
sudo apt install clangd                               # C/C++
```

Restart the Gateway after installing anything — capability detection runs at startup.
Prefer the `ast-grep` binary name over its `sg` alias: on Linux `sg` is also
shadow-utils' setgid shell.

### Why a language server that works in your terminal is invisible to the service

A systemd **user service** does not read your shell profile. It inherits the user
manager's PATH, which on a stock Ubuntu is:

```
/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
```

Every per-user toolchain directory is missing from that list — `rustup` installs to
`~/.cargo/bin`, `go install` to `~/go/bin`, `pip --user` to `~/.local/bin`, and nvm/fnm
put npm globals beside the versioned node binary. That is why a server that works
perfectly in your terminal can be invisible to the service, surfacing as
`Could not start LSP for <language>` with no other explanation.

So `lsp_search` does not trust the inherited PATH: it also searches the standard per-user
toolchain directories, and passes the widened PATH to the servers it spawns — necessary
because rust-analyzer shells out to `cargo` and gopls to `go`. Startup logs every tool it
resolved and the absolute path it found:

```
[Search MCP] Host tools:
[Search MCP]   ✓ rg: /usr/bin/rg
[Search MCP]   ✓ rust-analyzer: /home/you/.cargo/bin/rust-analyzer
[Search MCP]   ✗ gopls
```

| Variable                   | Effect                                            |
| -------------------------- | ------------------------------------------------- |
| `KOI_TOOL_PATH=/opt/x/bin` | Prepended to the search path; wins over the rest  |
| `KOI_TOOL_PATH_AUGMENT=0`  | Disable augmentation; use only the inherited PATH |

This widens where the Gateway looks. It does not modify your environment, install
anything, or affect other services.

The child runs with `SEARCH_MCP_READONLY=1`, so no code-intelligence tool can write to
the real host tree; all mutations flow through the overlay and leave only as patches.
`lsp_search` can also be deployed as a standalone Gateway server for skills that want
navigation without the sandbox — keep `SEARCH_MCP_READONLY=1` set there too.

---

## Troubleshooting

`systemctl --user status koi-gateway` and `journalctl --user -u koi-gateway -f` answer
most questions. `node test-network-approval.mjs` answers most of the rest.

| Symptom                                   | Cause                            | Fix                                                                                                                |
| ----------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Assistant says the sandbox is unavailable | gateway not running              | `./koi-gateway-installer`                                                                                          |
| `Could not start LSP for <language>`      | server not on the service's PATH | see [PATH](#why-a-language-server-that-works-in-your-terminal-is-invisible-to-the-service), or set `KOI_TOOL_PATH` |
| Dev server unreachable from the browser   | `--net loopback`                 | use `--net policy` (or `host`)                                                                                     |
| Stale dev server holding a port           | process reuse across sessions    | check `sandbox_info.services`, stop it, or restart the gateway                                                     |
| Two windows fighting over the sandbox     | one child process, shared state  | use a single extension window                                                                                      |
| Overlays eating disk                      | never GC'd, by design            | prune `sessions/<id>/`; the outbox survives                                                                        |

Network-filtering symptoms (403/500/503 from the proxy, dialogs never appearing, missing
`passt`) are tabulated in the
[skill README's troubleshooting](../../skills/sandbox-shell/README.md#troubleshooting).

---

## Uninstall

```bash
./koi-gateway-installer uninstall   # removes the gateway and egress services
rm -rf ~/.koi                          # overlays, policy, outboxes
```

Your repositories are untouched, because they always were.
