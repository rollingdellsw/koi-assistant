# FreeCAD Live Skill For Koi™ Assistant

Based on 100% FreeCAD official release.

Human/AI co-design on **one** live FreeCAD document: you drive the GUI in a
browser tab, the agent drives the same document through a bridge, in the same
interpreter, on the same undo stack.

This skill provides a minimal yet complete toolset for AI to perform CAD work,
plus enough CAM to answer the question CAD cannot: **can this actually be
made?** A part can be dimensionally perfect, recompute clean, pass interference
and weigh exactly what the bill of materials says, and still be a shape no
cutter can produce — an internal corner with a zero radius is valid geometry
and does not exist in metal. So the skill measures manufacturability rather
than asserting it: corner radii against real cutter sizes, tool reach per setup
direction, undercuts, enclosed voids, and the volume of material no cutter can
reach. Where the FreeCAD CAM workbench is available it will also build a real
machining Job and generate the toolpaths, because an operation that produces
zero path commands is the workbench saying it could not cut that feature — and
that is a fact no language model can supply.

It answers the other question CAD cannot, on the same terms. Asked whether a
3 mm wall is strong enough, a language model will produce a confident sentence,
and the user cannot tell that apart from a number. So where gmsh and CalculiX
are installed the skill runs a real **linear static solve** and reports a
measured stress — or refuses. A model with no restraint, no load or no volume
elements is rejected before the solver runs, because each of those returns a
plausible number that means nothing. A peak stress sitting on a sharp internal
corner is reported as the singularity it is rather than as a stress, and no
factor of safety is divided out of it. Solved once, `converged` comes back
`null`: one mesh is one number with no error bar.

Most of CAM is still out of scope: no simulation of material removal, no work
holding or fixtures, no speeds, feeds or cycle time, and the G-code that comes
out is machine-specific and unverified. The FEM is linear static and nothing
else — no contact, plasticity, buckling, fatigue, dynamics or thermal — so what
it produces is evidence, never a certificate. See §12 of `SKILL.md` for the
full list of what is deliberately absent.

Click to watch a 30s demo:
[![Watch a 30s demo](./docs/demo.png)](https://www.youtube.com/watch?v=4SxjvQZKdXU)

This guide gets you from nothing to a working session. Follow Part I in order.
Part II explains what you just built — security model, maintenance, GPU,
troubleshooting — and is worth reading once you are up.

---

## 1. Architecture

Three pieces, each with one job.

<div align="center">
  <img src="./docs/freecad-skill-system-diagram.png" width="100%" alt="FreeCAD skill system diagram">
  <br>
</div>

**FreeCAD WebRTC server.** A container running a full desktop FreeCAD
(`linuxserver/freecad`) whose window is streamed to a browser over WebRTC
(Selkies/KasmVNC). This is where FreeCAD actually runs and where _you_ click.
CPU rendering by default (Mesa llvmpipe); GPU optional. Ports **3000**
(plaintext) and **3001** (TLS).

**The koi bridge (`koi_bridge.py`).** A small HTTP endpoint opened _inside that
same GUI process_ by a FreeCAD macro. It accepts requests on port **8765** and
marshals the work onto the Qt thread that owns the document. That in-process
detail is the whole point: the agent is not running a second headless FreeCAD
with its own document — it edits the document you are looking at, and you see
each change land and can take the mouse mid-session. It also writes exports to
a directory bind-mounted onto the host.

**The freecad-live skill.** The Koi side. It speaks to the bridge, reads the
document every turn, edits through a validated call whitelist inside a
transaction envelope, measures results instead of trusting them, checks that
the result can be manufactured before it leaves the session, and pins the exact
FreeCAD build it is talking to.

**Ports.** All three published on host loopback only. The scheme follows the
port: `https://` works on 3001 and nowhere else; the bridge on 8765 is plain
HTTP by design.

| Port | What                      | Scheme         |
| :--- | :------------------------ | :------------- |
| 3000 | stream, plaintext         | `http://`      |
| 3001 | stream, TLS (self-signed) | `https://`     |
| 8765 | koi bridge                | `http://` only |

**Verified on:** Windows 11 + WSL2 Ubuntu 22.04 (server on the same machine as
Chrome) **and** a standalone Ubuntu 24.04 server reached over SSH. Both work;
the only difference is Step 5.

---

# Part I — Setup

Everything below runs **on the Linux host** unless a step says otherwise.
Requirements: a 64-bit CPU, Podman 4.9.3+ rootless (or Docker). No GPU needed.

### Prerequisites

- Podman 4.9.3+ rootless (or Docker)
- Configured subuids/subgids for rootless namespace:

```bash
# Check if subuids/subgids exist for your user:
grep $USER /etc/subuid /etc/subgid

# If missing, add them and migrate (requires sudo):
sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER
podman system migrate
```

## Step 1: Directories and credentials

```bash
mkdir -p ~/freecad-stream/config
mkdir -p ~/freecad-stream/workspace
# Make the mounts writable by the container's user
podman unshare chown -R 1000:1000 ~/freecad-stream/workspace
podman unshare chown -R 1000:1000 ~/freecad-stream/config

# Where the bridge writes exports (STEP/FCStd handovers). It lives under the
# workspace bind mount on purpose: files the AI writes appear on the host
# immediately, with no download and no copy out of the container.
podman unshare mkdir -p ~/freecad-stream/workspace/koi_export

# The FreeCAD macro directory, bind-mounted through /config. This is how
# koi_bridge.py gets into the container without rebuilding the image.
podman unshare mkdir -p ~/freecad-stream/config/.local/share/FreeCAD/v1-1/Macro
```

### Your two credentials

**These are generated per install. There is no default and nothing to look up —
you create them now and read them back later.**

| Credential                 | Guards                            | Used at                        |
| :------------------------- | :-------------------------------- | :----------------------------- |
| `CUSTOM_USER` / `PASSWORD` | the streamed desktop on 3000/3001 | browser login, Step 4          |
| `KOI_BRIDGE_TOKEN`         | the bridge on 8765                | the skill's Run dialog, Step 7 |

Generate both into one file that only you can read:

```bash
install -m 600 /dev/null ~/freecad-stream/bridge.env
{
  echo "KOI_BRIDGE_TOKEN=$(openssl rand -hex 32)"
  echo "CUSTOM_USER=koi"
  echo "PASSWORD=$(openssl rand -hex 24)"
} > ~/freecad-stream/bridge.env
```

Read them back whenever you need them:

```bash
grep -E 'CUSTOM_USER|PASSWORD' ~/freecad-stream/bridge.env   # browser login
grep KOI_BRIDGE_TOKEN ~/freecad-stream/bridge.env            # skill token
```

Every `podman run` below reads this file with `--env-file`. Do **not** pass
these with `-e NAME=value`: that puts the secret in the container's argv, where
any local account reads it out of `ps aux` and `podman inspect`.

## Step 2: Start the server

```bash
podman run -d \
  --name freecad-stream \
  --security-opt seccomp=unconfined \
  --shm-size=2gb \
  -e PUID=1000 \
  -e PGID=1000 \
  -e TZ=Etc/UTC \
  -p 127.0.0.1:3000:3000 \
  -p 127.0.0.1:3001:3001 \
  -p 127.0.0.1:8765:8765 \
  --env-file ~/freecad-stream/bridge.env \
  -e HARDEN_DESKTOP=true \
  -e DISABLE_SUDO=true \
  -e KOI_BRIDGE_HOST=0.0.0.0 \
  -e KOI_BRIDGE_PORT=8765 \
  -e KOI_EXPORT_DIR=/workspace/koi_export \
  -v ~/freecad-stream/config:/config:Z \
  -v ~/freecad-stream/workspace:/workspace:Z \
  --restart unless-stopped \
  docker.io/linuxserver/freecad@sha256:13907f44a4425a5847a191eebd492e5ed85001044949b012c7ee70ce91c1aa50
```

Two flags that look wrong and are not:

- **`KOI_BRIDGE_HOST=0.0.0.0`** binds the bridge to all interfaces _inside the
  container_. The isolation boundary here is the network namespace, not
  loopback — a process bound to the container's `127.0.0.1` is not reachable
  through `-p` at all. Exposure is controlled by the publish flag, which is
  `127.0.0.1:8765:8765`, host loopback only.
- **No `--userns=keep-id`.** LinuxServer images use `s6-overlay`, which needs
  the default rootless mapping (UID 0 → host user) to set internal permissions.

**Verify:** `podman logs -f freecad-stream` should settle without errors, then
continue to Step 4 (if the server is on this machine) or Step 5 first (if it is
remote).

## Step 3: Open the stream and verify FreeCAD

Get the login, then open the page:

```bash
grep -E 'CUSTOM_USER|PASSWORD' ~/freecad-stream/bridge.env
```

```bash
CUSTOM_USER=koi
PASSWORD=ca83a64e1feee09622b2858966289d4edc57c5e5c4c81b2c
```

Browse to **`https://localhost:3001`** and log in with those. (Remote host: set
up the tunnel in Step 5 first — the URL stays `localhost:3001`.)

The certificate is self-signed, so the browser warns. Over a loopback tunnel
that is expected and the traffic is already inside SSH. Do not make a habit of
clicking through it against a remote address — that is the case where the
warning means something.

**Working means:** you see the FreeCAD desktop and can click menus in it.

### Fix blurry text

WebRTC applies automatic UI scaling by default. For a crisp 1:1 display:

1. Open the **Selkies sidebar** (pull handle, top-left edge of the screen).
2. Expand **Screen Settings**.
3. Set **UI Scaling** to **100%**.
4. Under **Preset**, pick a resolution matching your display (e.g.
   `1920 x 1200`), or **Reset to Window** to fit the browser viewport.

<div align="center">
  <img src="./docs/adjust-freecad-webrtc-display.png" width="100%" alt="Selkies screen settings">
  <br>
</div>

## Step 4: Install and start the bridge

### 4.1 Copy `koi_bridge.py` into FreeCAD's macro directory

```bash
podman unshare mkdir -p ~/freecad-stream/config/.local/share/FreeCAD/v1-1/Macro
```

Copy it out of the skill:

```bash
# Local host (from repo root):
podman unshare cp skills/freecad-live/tools/koi_bridge.py ~/freecad-stream/config/.local/share/FreeCAD/v1-1/Macro/

# Remote host:
rsync -av skills/freecad-live/tools/koi_bridge.py \
  $USER@192.168.68.113:~/freecad-stream/config/.local/share/FreeCAD/v1-1/Macro/
```

### 4.2 Start it manually first

Create a wrapper macro on the server:

```bash
cat << 'EOF' | podman unshare tee ~/freecad-stream/config/.local/share/FreeCAD/v1-1/Macro/koi_start.FCMacro > /dev/null
import os
os.environ.setdefault("KOI_BRIDGE_HOST", "0.0.0.0")
os.environ.setdefault("KOI_EXPORT_DIR", "/workspace/koi_export")
# No token line: --env-file already put KOI_BRIDGE_TOKEN in this process's
# environment, and setdefault leaves it alone. Hardcoding it here would write
# the secret into /config, which is world-readable and lives in your home
# directory. If your setup really does not forward the environment, paste it
# in and then `chmod 600` this file — and know that it is now a secret at rest
# on a bind mount.
exec(open("/config/.local/share/FreeCAD/v1-1/Macro/koi_bridge.py").read())
EOF
```

In the streamed FreeCAD GUI: **Macro → Macros… → `koi_start` → Execute**.

> **Tip for debugging in FreeCAD**:
> If nothing happens or the curl test fails, enable the output panels in FreeCAD to see macro errors:
> **View** -> **Panels** -> check **Report view** and **Python console**.

**Verify from the server:**

```bash
set -a; . ~/freecad-stream/bridge.env; set +a   # keeps the token out of argv
curl -s -H "X-Koi-Token: $KOI_BRIDGE_TOKEN" http://127.0.0.1:8765/hello | jq
```

```json
{
  "ok": true,
  "protocol": 1,
  "pid": 367,
  "gui": true,
  "mode": "gui",
  "dispatch": "qtimer/15ms",
  "started": "2026-08-18T04:50:54Z",
  "exportDir": "/workspace/koi_export",
  "tokenRequired": true,
  "running": null,
  "app": {
    "version": "1.1.3",
    "commit": "145529fe741292ff0b3977a01195bf0247425794",
    "branch": "grafted,grafted",
    "buildDate": "2026/07/25 04:52:02",
    "occt": "7.8.1",
    "python": "3.11.14",
    "exe": "/opt/freecad/usr/bin/freecad",
    "resourceDir": "/opt/freecad/usr/"
  },
  "fingerprint": "exe:159624@1784962801",
  "exeBytes": 159624,
  "exeModified": "2026-07-25T07:00:01Z"
}
```

`"gui": true` is the field that matters: the bridge is inside the process you
are watching, not a headless second one.

### 4.3 Start it automatically (once 5.2 works)

```bash
MODDIR=~/freecad-stream/config/.local/share/FreeCAD/v1-1/Mod/koi_bridge
podman unshare mkdir -p "$MODDIR"

cat << 'EOF' | podman unshare tee "$MODDIR/InitGui.py" > /dev/null
import os

os.environ.setdefault("KOI_BRIDGE_HOST", "0.0.0.0")
os.environ.setdefault("KOI_EXPORT_DIR", "/workspace/koi_export")
# The token comes from --env-file. Pasting it here writes a secret into a
# world-readable file on a bind mount; if you have no alternative, chmod 600
# this file afterwards.

def _start_koi_bridge():
    import os
    import FreeCAD

    # Check v1-1 macro directory first, then fallback
    macro_path = "/config/.local/share/FreeCAD/v1-1/Macro/koi_bridge.py"
    if not os.path.exists(macro_path):
        macro_path = "/config/.local/share/FreeCAD/Macro/koi_bridge.py"

    try:
        with open(macro_path, "r") as f:
            code = compile(f.read(), macro_path, "exec")
            exec(code, {"__name__": "__koi_bridge__", "__file__": macro_path})
    except Exception as e:
        FreeCAD.Console.PrintError("koi_bridge autostart failed: %s\n" % e)

try:
    from PySide import QtCore
except ImportError:
    from PySide6 import QtCore

QtCore.QTimer.singleShot(4000, _start_koi_bridge)
EOF

# Ensure correct ownership and permissions for container user 1000
podman unshare chown -R 1000:1000 ~/freecad-stream/config ~/freecad-stream/workspace
podman unshare chmod -R u+rwX,go+rX ~/freecad-stream/config
```

Restart the container (or the systemd service from Step 8). Watch the streamed
GUI; after ~4 seconds:

```
koi_bridge: listening on http://0.0.0.0:8765 (protocol 1, gui, dispatch qtimer/15ms)
koi_bridge: FreeCAD 1.1.x ..., exports to /workspace/koi_export
```

## Step 5: Reach the server from your workstation

**Skip this entirely if the server runs on the same machine as Chrome** — e.g.
Windows 11 workstation with the server in WSL2. Loopback already reaches it.

Otherwise, nothing is published off the FreeCAD host, so both the stream and
the bridge come to you through one tunnel:

```bash
ssh -N -L 3001:127.0.0.1:3001 -L 8765:127.0.0.1:8765 $USER@192.168.68.113
```

The stream is then `https://localhost:3001` and the bridge is
`http://localhost:8765`. The bridge speaks plain HTTP: over the tunnel that is
fine, because the bytes never touch the wire unencrypted. Pointed straight at
`http://192.168.68.113:8765` it is not fine — the token and every document
cross the network in the clear, and the skill will say so on attach.

**Verify from the workstation before touching the skill:**

```bash
# Read the token from a file rather than typing it: a token on the command
# line is a token in ~/.bash_history.
KOI_BRIDGE_TOKEN=$(ssh $USER@192.168.68.113 'grep -h KOI_BRIDGE_TOKEN ~/freecad-stream/bridge.env | cut -d= -f2')
curl -s -H "X-Koi-Token: $KOI_BRIDGE_TOKEN" http://127.0.0.1:8765/hello | jq
```

You should see the same JSON as in 5.2.

## Step 6: Point the skill at it

Open **Skills → freecad-live → Run**, fill in three fields, press **Run Skill**.

| Field         | Value                    | Notes                                                                                                                           |
| :------------ | :----------------------- | :------------------------------------------------------------------------------------------------------------------------------ |
| `bridgeUrl`   | `http://localhost:8765`  | Plain HTTP. `https://` fails at the TLS handshake before it can authenticate. Safe here: loopback, or inside the Step 5 tunnel. |
| `bridgeToken` | from `bridge.env`        | `grep KOI_BRIDGE_TOKEN ~/freecad-stream/bridge.env` on the FreeCAD host.                                                        |
| `streamUrl`   | `https://localhost:3001` | Optional. 3001 is TLS, 3000 is plaintext. Nothing in the skill fetches this; it is the link you open to watch.                  |

Use the Run dialog rather than pasting the token into the chat: it goes from
the form to the bridge client without entering the transcript. The binding
lasts for the session; a new session needs the dialog again.

**Verify:** Run test script `/skill freecad-live/scripts/test_connect.js --full-auto` from Koi user message box, a successful attach reports `Script finished. Success: true `.
If not, review the Koi extension's console log:

| Symptom                                    | Cause                                                                   |
| :----------------------------------------- | :---------------------------------------------------------------------- |
| `401 Unauthorized` on `/exec`              | Token missing or stale. This is the guard working — the bridge is up.   |
| Connection refused / TLS error on 8765     | `https://` in `bridgeUrl`, or the tunnel is down.                       |
| `No FreeCAD bridge is answering`           | The macro was never run — Step 5.2, or check the autostart in 5.3.      |
| Warning that the transport is in the clear | `bridgeUrl` points at a remote host over `http://`. Tunnel it (Step 5). |

At this point you have a working environment. Everything below is optional or
explanatory.

## Step 7: Run it as a service (recommended)

So FreeCAD comes back on boot and after a crash.

```bash
loginctl enable-linger $USER      # user services run without an SSH session
```

```bash
mkdir -p ~/.config/systemd/user/
cat << 'EOF' > ~/.config/systemd/user/freecad.service
[Unit]
Description=FreeCAD KasmVNC WebRTC Streaming Container
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
Restart=always
RestartSec=5s
ExecStartPre=-/usr/bin/podman stop -t 10 freecad-stream
ExecStartPre=-/usr/bin/podman rm freecad-stream
ExecStart=/usr/bin/podman run \
  --name freecad-stream \
  --security-opt seccomp=unconfined \
  --shm-size=2gb \
  -e PUID=1000 \
  -e PGID=1000 \
  -e TZ=Etc/UTC \
  -p 127.0.0.1:3000:3000 \
  -p 127.0.0.1:3001:3001 \
  -p 127.0.0.1:8765:8765 \
  --env-file %h/freecad-stream/bridge.env \
  -e HARDEN_DESKTOP=true \
  -e DISABLE_SUDO=true \
  -e KOI_BRIDGE_HOST=0.0.0.0 \
  -e KOI_BRIDGE_PORT=8765 \
  -e KOI_EXPORT_DIR=/workspace/koi_export \
  -v %h/freecad-stream/config:/config:Z \
  -v %h/freecad-stream/workspace:/workspace:Z \
  docker.io/linuxserver/freecad@sha256:13907f44a4425a5847a191eebd492e5ed85001044949b012c7ee70ce91c1aa50

ExecStop=/usr/bin/podman stop -t 10 freecad-stream

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user start freecad.service
systemctl --user status freecad.service
```

There is deliberately no `EnvironmentFile=` line: podman reads the file itself
with `--env-file`, so only the _path_ lands in the unit and in the process
table. `EnvironmentFile=` plus `-e KOI_BRIDGE_TOKEN=${KOI_BRIDGE_TOKEN}` would
expand the secret into `ExecStart`, where `ps aux` shows it to every local
account.

---

# Part II — Reference

## Security

What each boundary does, and what it does not.

| Boundary                      | Protects against                                | Does **not** protect against                                                |
| :---------------------------- | :---------------------------------------------- | :-------------------------------------------------------------------------- |
| Loopback publish + SSH tunnel | Everyone not on this host or holding an SSH key | Anything already running on the host                                        |
| `KOI_BRIDGE_TOKEN`            | A local process guessing its way into 8765      | Whoever reaches the stream on 3000/3001                                     |
| `CUSTOM_USER` / `PASSWORD`    | Casual access to the desktop                    | A determined attacker; it is HTTP basic auth                                |
| Rootless podman + userns      | Container root becoming host root               | Anything reaching `/config` and `/workspace`, which are your home directory |
| Digest pin + `pin-mode`       | The build changing under the agent              | A compromised image at that digest                                          |

**Why the desktop needs its own password.** The bridge token guards 8765. It
does not guard 3000/3001, and what is behind those is FreeCAD with a Python
console and a macro editor in it. Anyone who reaches the stream executes code
as the container user without ever seeing the token. LinuxServer ships HTTP
basic auth for exactly this, off by default, and upstream's own description is
that it keeps the kids out rather than the internet — so it is the second lock.
**The first is that nothing here publishes on an interface other than
loopback.**

The bridge runs arbitrary Python as the FreeCAD user by design, so assume
anything with bridge access has the mounts. Two consequences worth designing
around:

- **`/config` is executed, not just read.** `Macro/` and `Mod/*/InitGui.py` run
  on every FreeCAD start. Anything that can write there survives restarts,
  container recreation and token rotation. The skill confines its own
  caller-supplied write paths to `KOI_EXPORT_DIR` for this reason; if you mount
  `/config` read-only after setup, the autostart still works and that class of
  persistence goes away.
- **The agent's input is not trusted input.** Object labels, imported STEP
  metadata and any web page the agent read can carry instructions, and the
  bridge is an interpreter. Guardrails are steering, not containment — they
  fail open and they do not see calls made from inside a running script. The
  network boundary is the control.

### `parameters:` is not `mcp-servers:`

`SKILL.md` has a `parameters:` section listing `bridgeUrl` and `streamUrl`.
Those are **prompt** parameters — the runnable dispatcher seeds them into the
conversation as a user message — and the bridge client never reads them.
Filling them in does not change where the skill connects, and a token put there
would be pasted into the chat and still get a 401. Bridge configuration lives
in `mcp-servers:` (or comes from the Run dialog); nowhere else.

## Build pinning

Two independent pins, because the image tag and the binary drift separately:

1. **The image digest** (Step 2) — fixes what the container starts.
2. **`pin-commit` / `pin-version` in `SKILL.md`** — read from inside the running
   process by the skill. In `pin-mode: strict` it refuses to attach to a build
   that is not the pinned one.

Run the skill once and paste back the `pinBlock` that `freecad_version()`
returns. Note that `pin-fingerprint` (`exe:<size>@<mtime>`) is worth setting
only on a build with no revision hash: on this image the bridge resolves a
launcher shim rather than the real ELF, so a fingerprint pin reports drift on
every attach for a binary that never changed — which is how a gate stops being
read.

## Maintenance and diagnostics

| Task                            | Command                                                                                                         |
| :------------------------------ | :-------------------------------------------------------------------------------------------------------------- |
| **Check logs**                  | `podman logs -f freecad-stream`                                                                                 |
| **Restart service**             | `systemctl --user restart freecad.service`                                                                      |
| **Stop service**                | `systemctl --user stop freecad.service`                                                                         |
| **Container shell**             | `podman exec -it freecad-stream bash`                                                                           |
| **Verify renderer (CPU / GPU)** | `podman exec -it freecad-stream bash -c "glxinfo -B 2>/dev/null \| grep -E 'Device\|Vendor\|OpenGL\|renderer'"` |
| **Bridge alive?**               | `curl -s -H "X-Koi-Token: $KOI_BRIDGE_TOKEN" http://127.0.0.1:8765/hello` (header only — never `?token=`)       |
| **What is the bridge doing?**   | same call — the `running` field names the job on the GUI thread and how long it has held it                     |
| **Bridge port from inside**     | `podman exec -it freecad-stream bash -c "ss -ltnp \| grep 8765"`                                                |
| **Exports the agent wrote**     | `ls -la ~/freecad-stream/workspace/koi_export`                                                                  |
| **Can the agent write them?**   | `curl -s -H "X-Koi-Token: $KOI_BRIDGE_TOKEN" http://127.0.0.1:8765/hello \| jq '.exportWritable, .exportError'` |
| **Fix mount ownership**         | `podman unshare chown -R 1000:1000 ~/freecad-stream/workspace`                                                  |
| **Read the bridge token**       | `grep KOI_BRIDGE_TOKEN ~/freecad-stream/bridge.env`                                                             |
| **Read stream credentials**     | `grep -E 'CUSTOM_USER\|PASSWORD' ~/freecad-stream/bridge.env`                                                   |
| **Rotate the token**            | rewrite the line in `bridge.env`, `systemctl --user restart freecad.service`, update the skill                  |

**Upgrading the image:** resolve a new digest (Step 2), update `ExecStart`,
restart — then re-run the skill's probe suites and re-pin, because every claim
the skill makes about toponaming, threads or workbench availability is a claim
about one build.

**Upgrading the bridge:** `koi_bridge.py` and `mcp/freecad_mcp.js` ship
together. A protocol-mismatch error on attach means version skew — copy the
macro out of the current skill and reload it.

## Optional: GPU acceleration

Only if you have a dedicated GPU and want hardware OpenGL plus zero-copy video
encoding. Both device nodes are kernel attack surface reachable by anything in
the container, which here includes agent-supplied Python — take them only if
you need the acceleration.

### Host permissions (AMD / Intel)

```bash
sudo usermod -aG render,video $USER
newgrp render

ls -la /dev/dri
ls -la /dev/kfd
```

### Run with passthrough

Add to the `podman run` from Step 3 (or to `ExecStart` in Step 8):

```
  --device /dev/dri:/dev/dri \
  --device /dev/kfd:/dev/kfd \
  --group-add keep-groups \
```

## Optional: gmsh and CalculiX for FEM

`freecad_fem` needs two **separate programs**. They are not part of FreeCAD's
Python, and an image that carries the FEM workbench menu very often carries
neither — which is why the skill probes for them and reports what it found
under `binaries` rather than assuming. Everything else in the skill works
without them.

```bash
# Inside the FreeCAD container (or on the host, for a native install):
apt-get update && apt-get install -y gmsh calculix-ccx
```

FreeCAD finds them on `PATH`. If yours are somewhere else, set the paths in
Edit → Preferences → FEM → Gmsh / CalculiX; the skill reads those preferences
first and falls back to `PATH`.

Two things worth knowing before the first solve. CalculiX is **single
threaded** and runs on the thread that owns the document, so the FreeCAD window
in your browser tab stops responding for the whole solve — a fine mesh is
minutes of that, and nothing can preempt it. And a solve is only as good as its
load case: the skill will not invent a modulus, a load or a restraint, and it
refuses rather than defaulting one.

## Verified environment

| Component            | Tested spec                                                                |
| :------------------- | :------------------------------------------------------------------------- |
| **OS**               | Windows 11 + WSL2 Ubuntu 22.04 LTS, and Ubuntu 24.04 LTS standalone server |
| **CPU**              | 64-bit (AVX2 for Wayland mode)                                             |
| **GPU**              | _None required_ — CPU rendering default                                    |
| **Container engine** | Podman v4.9.3+ (rootless) or Docker                                        |
| **Image**            | `docker.io/linuxserver/freecad:latest` → FreeCAD 1.1.3                     |

## Evolving the skill

The skill is maintained with a full test suite, you can run them in batch from Koi Assistant's user input message box:

```
/skill freecad-live/scripts/test_native.js --full-auto
/skill freecad-live/scripts/test_build_contract.js --full-auto
/skill freecad-live/scripts/test_probes.js --full-auto
/skill freecad-live/scripts/test_koi_cad.js --full-auto
/skill freecad-live/scripts/test_koi_call.js --full-auto
/skill freecad-live/scripts/test_parts.js    --full-auto
/skill freecad-live/scripts/test_resolve.js  --full-auto
/skill freecad-live/scripts/test_turn.js     --full-auto
/skill freecad-live/scripts/test_measure.js  --full-auto
/skill freecad-live/scripts/test_tree.js --full-auto
/skill freecad-live/scripts/test_ops.js --full-auto
/skill freecad-live/scripts/test_geom.js --full-auto
/skill freecad-live/scripts/test_ops2.js --full-auto
/skill freecad-live/scripts/test_ops3.js --full-auto
/skill freecad-live/scripts/test_flow.js --full-auto
/skill freecad-live/scripts/test_bootstrap.js --full-auto
/skill freecad-live/scripts/test_visible.js --full-auto
/skill freecad-live/scripts/test_recover.js --full-auto
/skill freecad-live/scripts/test_connect.js --full-auto
/skill freecad-live/scripts/test_external.js --full-auto
/skill freecad-live/scripts/test_render.js --full-auto
/skill freecad-live/scripts/test_io.js --full-auto
/skill freecad-live/scripts/test_inspect.js --full-auto
/skill freecad-live/scripts/test_cam.js --full-auto
/skill freecad-live/scripts/test_fem.js --full-auto
```

`test_fem.js` is the one suite that is mostly about **refusals**, because that
is where the value is: an analysis with no restraint, one with no load, a mesh
with zero volume elements, a material with no `E`/`nu`, a boundary condition on
something other than the meshed solid, a peak stress planted on a sharp corner
(which must come back with a null factor of safety and a reason), and a solve
followed by a geometry edit (which must raise `fem-stale` on the next lint). Its
first two sections need neither gmsh nor CalculiX and run everywhere; the solve
sections skip with a warning where the binaries are absent. A suite that only
proves a bracket solves proves the part of this that was never in doubt.

You need to turn on the `probe-exec` switch, and reinstall the freecad-live skill, so it can run these scripts.

```
--- a/skills/freecad-live/SKILL.md
+++ b/skills/freecad-live/SKILL.md
@@ -125,7 +125,7 @@ mcp-servers:
     # !! freecad_script, which is exactly the surface the call/script split
     # !! exists to keep away from it. Turn it on to run the suites in
     # !! scripts/, turn it off before handing the session to a model.
-    probe-exec: off
+    probe-exec: on
 guardrails: scripts/guardrail.js
 allowed-tools:
   - freecad_config
```

Make sure your change does not break the existing test suites.

### Sample end to end test prompt

#### Prompt 1 — MTB Stem

To make the mountain bike stem in the demo video, just copy this prompt to the freecad-live skill's "Additional Instructions (Optional)" input box and run:

```markdown
Design a 2-piece CNC MTB stem (Atomlab direct/threadless style) in FreeCAD.

### Parameters — create these FIRST, bind everything to them

Reach=45mm, StackHeight=40mm, HandlebarDia=31.8mm, SteererDia=28.6mm,
BodyWidth=48mm, PinchGap=2mm, FluteDepth=3.5mm.
Set each with `fn:"param"` and quote the value the sheet reads BACK.

### Build sequence

A. `new_document` (id `doc.stem`), `body` (id `body.stem`).
Sketch `sk.base_profile` on XY: use `rect` with `anchor:"center"`. Bind w/h
to the parameters as expression strings. `pad.base` length
`"koi_params.StackHeight"`, symmetric.
B. `sk.steerer_bore` (circle d `"koi_params.SteererDia"` at origin) →
`pocket.steerer_bore` `through:true`. Report whether the reply says it was
made symmetric and why.
`sk.handlebar_bore` (circle d `"koi_params.HandlebarDia"` at
x `"koi_params.Reach"`) on the appropriate plane → `pocket.handlebar_bore`
`through:true`.
C. Underside relief: `sk.bottom_cut` → `pocket.bottom_cut`. If the reply's
`removed` is 0, log it and fix the profile — do not accept a clean recompute.
D. Lightening flutes: `sk.side_flutes` using the `slot` primitive (NOT a
computed polyline), TWO slots in ONE sketch, both bound to parameters.
`pocket.side_flutes` depth `"koi_params.FluteDepth"`.
NOTE: `fn:"mirror"` mirrors a whole solid, not a feature. If you believe you
need a mirrored feature, log that as a capability gap rather than substituting
`mirror` or `pattern` blindly.
E. Chamfers: `chamfer` with a `query` (`{kind:"edge", direction:"+Z",
   expect:"many"}`), size 3. Use query, NOT refs — the model is still moving and
the stored filter is the point.
F. Faceplate separation: `split_body` on `body.stem`, plane through the
handlebar clamp, `gap:"koi_params.PinchGap"`, `ids:["part.body","part.face"]`.
Read `sides.positive` / `sides.negative` — do not assume `ids[0]`.
Report `asBodies`.
G. Steerer pinch slot: rear cut of width `"koi_params.PinchGap"` into the
steerer bore.
H. Fasteners:

- `sk.face_holes` — 4 circles, 32x32 pitch, bound to parameters.
- `hole` id `hole.face_bolts`, `counterbore:"M5"`, `spec:{clearance:"M5"}`.
  Quote the readback diameter and the counterbore depth.
- `fastener_pattern({hole:"hole.face_bolts", fastener:"M5", length:16})` —
  ONE call for all four. Do not use four `insert`+`mate` pairs.
- Same for the 2 steerer pinch bolts (M5x18).
  I. `material` — assign `aluminium-6061` to both bodies. (If you cannot find a
  call for this, that is a defect; log it.)

### Acceptance — all of these must be measured, not asserted

1. `measure_between` between the STEERER BORE AXIS and the HANDLEBAR BORE AXIS.
   Get those refs from `fn:"query"` (`{kind:"face", surface:"Cylinder", radius:...}`)
   — do NOT pass the pocket feature ids, which resolve to the whole body shape.
   Expect 45.000 mm.
2. `freecad_measure({interference:true, clearance:true, partsOnly:true})`.
   Expect 0 mm³ interference and the faceplate/pinch gaps at 2.0 mm.
3. `freecad_measure({deepLint:true})`. If sliver faces are reported, try
   `recompute({refine:true})` and report the volume before/after.
4. `bom` — expect TWO fastener LINES (one of 4, one of 2), not six line items,
   plus two fabricated bodies WITH mass. A body reporting no mass is a defect.
5. `view_section({plane:"XZ", offset:0})` then `freecad_render({view:"iso"})`
   and one section render. Then turn the clip OFF and `view_restore`.
   Confirm `drawn` per target; if anything is in `notDrawn`, say so instead of
   describing the model.
6. `freecad_dfm({targets:["part.body","part.face"], process:"mill3axis",
tool:6})`. This is a CNC part and the design has to survive a cutter, not
   just a recompute. You should be able to predict two of the findings before
   you read the reply: `PinchGap` is 2 mm, and a 2 mm slot admits a 2 mm
   cutter and nothing wider; `FluteDepth` is 3.5 mm. Quote `manufacturable`,
   the residual `method`, and `maxToolDiameter` per body.
   If it comes back `obstructed`, name the FEATURE and say what dimension
   would clear it. Do not quietly shrink the `tool` argument until the check
   passes — that is fitting the test to the answer. Then re-run at `tool:2`
   and report what changed and what it costs (a 2 mm cutter in aluminium is a
   different machining plan, not a smaller number).
7. `freecad_cam({mode:"job", target:"part.face", id:"cam.face"})`, then
   `{mode:"op", job:"cam.face", op:"profile", id:"camop.face_profile"}`, then
   `{mode:"verify", job:"cam.face"}`. Quote `api` — which spelling of the CAM
   modules this build actually has — and the command count. An operation that
   generated ZERO commands recomputes clean and looks like nothing on screen;
   it is the workbench saying it could not cut that feature with that tool, so
   report it as that rather than as a tool error. Finish with
   `{mode:"clear", job:"cam.face"}` and leave the tree the way you found it.
```

---

#### Prompt 2 — NEMA housing + associative cover: Multi-Body Parametric Motor Drive & Associative Enclosure

**Focus**: _Catalog components, parametric swap propagation, cross-body SubShapeBinder (`bind`), multi-body assembly BOM, manufacturability across a parametric change._

```markdown
Design a modular NEMA stepper reducer housing with an associatively-bound cover
plate. The real test here is PARAMETRIC SWAP PROPAGATION.

### Build

1. `new_document` (`doc.geardrive`). `insert({catalog:"NEMA17_envelope"})` as
   `motor.nema`. Then `lookup({what:"params"})` and QUOTE exactly which aliases
   the motor published. You will need this in step 3.
2. `body.housing`: `sk.housing_profile` (80x80 rect, `anchor:"center"`) →
   `pad.housing` 50 mm. Pocket the gearbox cavity (`cut.cavity`, 40 mm).
   `material` = `aluminium-6061`.
3. `bolt_sketch({component:"motor.nema", on:"XY", id:"sk.motor_mount"})` — this
   is the call that binds hole POSITIONS to the motor's published pitch by
   expression. Check `bindingVerified` in the reply. If it is false, the
   positions are literals, the swap in step 5 will not move them, and you must
   say so rather than reporting a parametric pattern.
   Then `hole({sketch:"sk.motor_mount", id:"hole.motor_mount"})` with NO
   `spec` and NO `diameter` — the size comes from the profile circles
   (`diameterFrom` in the reply). Quote it.
4. Cover plate, associative:
   - `query({of:"pad.housing", kind:"face", normal:"+Z"})` to find the mating
     face. Report how many matched. Do not author `Face2` yourself.
   - `body.cover`, then `bind({body:"body.cover", of:"<the queried ref>",
id:"bind.housing_rim"})`.
   - `sketch({on:"bind.housing_rim", query:{...}})` projecting the rim edges,
     then constrain to the PROJECTION — a literal `w:80` here defeats the test.
     Report the `geoId` per projection and the constraint count.
   - `pad.cover` 6 mm. `fastener_pattern` for 4x M4x16.
5. **THE TEST — swap and verify propagation:**
   - First `dryRun:true`: `swap({target:"motor.nema", catalog:"NEMA23_envelope"})`
     with `dryRun`. Report the full blast radius from `report` — which objects
     moved and by how much. "N objects changed" is not an answer.
   - Then apply it for real.
   - `measure_between` on two diagonal mounting holes' cylindrical faces
     (via `query`), BEFORE and AFTER. Expected pitch 31.0 mm -> 47.14 mm.
     If the pitch did not move, the binding was a literal — log it as the
     primary defect of this test.
   - Check `rehealedExternal` on the cover sketch. If constraints were lost,
     the cover is now the wrong shape even though it recomputed clean.
     Say so explicitly.
6. `freecad_measure({interference:true, partsOnly:true})` — motor envelope vs
   housing must be 0 mm³, or `allow` it with a stated reason.
7. `bom` with masses for both bodies plus the motor's catalog mass.
8. `freecad_dfm({targets:["body.housing","body.cover"], tool:6})`, run BOTH
   before and after the swap in step 5.
   - Before: the gearbox cavity as specified is a rectangle, so expect
     `dfm-sharp-corner`. A rotating cutter leaves its own radius; a square
     internal corner is not a case for a smaller tool, it is a corner relief,
     EDM, or a radius. Fix it the way the rest of this test is built — a new
     `CornerR` parameter and `sketch_edit` on the cavity sketch to add fillets
     bound to it. Do not delete and rebuild the sketch, and do not "fix" it by
     changing `process`.
   - After: say whether the swap changed the verdict. A NEMA23 bolt circle is
     47.14 mm against 31.0 mm, so a mount hole may now sit close enough to a
     cavity wall to matter. If it does, that is precisely the failure this
     whole design exists to catch, and it has to be caught by the number
     rather than by looking at the render — the render will look fine either
     way.
```

---

#### Prompt 3 — Drone arm: loft / sweep / draft / shell (Lofts, Sweeps, Shell & Draft)

**Focus**: _Advanced 3D modeling (`loft`, `pipe`, `shell`, `draft`), mold release verification, sliver face linting, and knowing when a manufacturability check is the wrong question._

```markdown
Design a lightweight drone motor arm with an internal wire conduit and mould
release drafts. This test targets the 3D ops: loft, subtractive_pipe, draft,
shell, and deepLint.

### Build

1. `doc.drone_arm`, `body.arm`. `material` = `nylon-pa12`.
2. Root section `sk.root` on XY: an elliptical-ish airfoil 36 x 18 mm.
   NOTE: the sketch primitives are rect, circle, slot, line, arc, polyline and
   bspline. There is NO ellipse. Use `bspline` with poles and `closed:true` —
   NOT a hundred-segment polyline. Report the pole count.
   If you conclude no primitive can express this section, log it as a
   capability gap and state what you substituted.
3. `datum_plane` `dp.tip` on XY, offset 120. `sk.tip` on `dp.tip`: circle d24.
4. `loft({body:"body.arm", sketches:["sk.root","sk.tip"], id:"loft.arm"})`.
   Both sections are profile-checked before the build; report if either is
   refused and why.
5. Conduit: `sk.path` on XZ — a `bspline` spine from the root to the tip with a
   deliberate curve. `sk.conduit_prof` — circle d6.
   `subtractive_pipe({sketch:"sk.conduit_prof", path:"sk.path", mode:"Frenet"})`.
   Read `removed` and `removedAtProfile`. A sweep that cut nothing recomputes
   perfectly clean — do not report it as success.
   Then deliberately re-run once with `mode:"Frenett"` (typo) and confirm it is
   REFUSED rather than silently defaulted. Log the exact error text.
6. `draft({body:"body.arm", angle:3, neutralPlane:"XY",
query:{kind:"face", normal:"+Y"}})`. Report `taper` and `volumeDelta` —
   which way it pulled must be measured, not assumed. If `taper:"none"`,
   that is a failure.
7. `shell` the motor pod to 2.5 mm. `refs` is REQUIRED and must come from
   `query` (`{kind:"face", surface:"Plane", normal:"+Z"}` on the tip) — a name
   like "FaceTop" does not exist. Report how many faces matched before you
   commit.

### Acceptance

1. `freecad_measure({deepLint:true})` — zero sliver faces and no unclosed
   solids. If slivers appear, run `recompute({refine:true})` and report the
   volume before/after (refine must not change volume; if it does, that is a
   defect).
2. `measure_between` to verify the minimum wall between the conduit and the
   outer surface is >= 2.5 mm. `view_section` shows whether it breaks through;
   it cannot tell you the thickness.
3. `view_section({plane:"YZ", offset:0})` + `freecad_render` from two angles,
   then clip OFF and `view_restore`.
4. `freecad_dfm({targets:["body.arm"], process:"mill_any", tool:4})`.
   Expect this to FAIL, and expect the swept conduit to be why: an internal
   channel that opens only at its two ends is not reachable by a cutter from
   any direction, and `residual.obstructed` should say so with a volume.
   **That finding is correct.** The right response is that this part is
   moulded or printed and a milling check is the wrong question — NOT to
   change the geometry until the check goes green. Say which, in those terms.
   Every other prompt in this set rewards fixing the model when a measurement
   complains; this one is here to see whether that reflex has a brake on it.
   If instead it comes back manufacturable, the check is not measuring what it
   claims and THAT is the defect to report.
   The `draft` in step 6 is the mould-release half of the same question, and
   nothing in this skill verifies a mould — no parting line, no slide, no
   ejection. Say that too.
```

---

#### Prompt 4 — Kinematic clearance sweep

**Focus**: _Multi-position clash detection (`freecad_measure`), collision allowances (`allow`), dry-run validation._

```markdown
Verify kinematic clearance for a flange-mounted crank-rocker. This test targets
`allow`, repeated `place` + `freecad_measure`, and dry-run discipline.

NOTE UP FRONT: this skill has no continuous motion/sweep interference. You are
sampling discrete positions. State that limitation in your final report, and
state that the true minimum clearance may fall between samples.

### Build

1. `body.base` (flange + pivot tower at origin), `body.crank` (60 mm),
   `body.link` (140 mm), as three independent bodies. `material` on all three.
2. Two Ø8 dowel pins — `primitive({kind:"cylinder", d:8, ...})` or `insert`
   with an inline spec. Press fit in the crank, clearance fit in the link.
3. Position everything at theta = 0 degrees.

### Tolerance declaration

`allow({pairs:[["body.crank","pin.pivot"]], upTo:0.05,
       why:"m6/h7 press fit dowel pin"})`
Confirm the reply and confirm this persists across turns. Then run
interference ONCE and confirm the press fit shows under `expectedOverlaps`
rather than as a hit — and that anything past 0.05 mm³ would still be a hit.

### Sweep

Step the crank through theta = 0, 30, 60, 90, 120, 150, 180, 210, 240, 270,
300, 330 (twelve samples, not four — a crank-rocker's minimum rarely lands on
a quadrant).
At each step:

- `place({target:"body.crank", rotate:{axis:"Z", angle:30}, relative:true})`
- `freecad_measure({interference:true, clearance:true, partsOnly:true})`
  Record a table: theta | min clearance (mm) | interference volume (mm³) | which pair.

### Acceptance

1. Interference outside the allowed press fit must be exactly 0.000 mm³ at
   every sample.
2. Minimum link-flank-to-base clearance >= 3.0 mm at every sample. Report the
   worst theta and its value.
3. Coaxial check: `measure_between` the pin's CYLINDRICAL FACE and the crank
   bore's CYLINDRICAL FACE, both obtained via `query`. Do NOT pass the `hole.*`
   feature id — a PartDesign feature's shape is the whole body and the answer
   will be a meaningless 0.
4. Before the sweep, `dryRun` one crank rotation and show the report.
5. Return the crank to theta = 0 when finished.
```

---

#### Prompt 5 — I/O roundtrip and ID durability

**Focus**: _`open_document`, `save`, `import_geometry`, `freecad_export`, metadata ID persistence across sessions, and which checks survive the loss of the feature tree._

```markdown
Verify file interchange and koi-id durability across a save/reopen boundary.

IMPORTANT PATH RULE (verify this yourself first): `open_document` and
`import_geometry` only accept paths under the bridge's export directory,
anything KOI_OPEN_DIRS names, or the folder of a document the human already has
open. Establish what those roots are before you plan any path — and if you had
to discover this from an error rather than from documentation, log that.

### Phase 1 — Build and save

Build a bored bracket in `doc.roundtrip` with at least four features
(`sk.base`, `pad.base`, `sk.bore`, `pocket.bore`) plus a `chamfer` driven by a
stored `query`, and a `param` the pad length is bound to. `material` it.
Then `save({path:"BracketMaster.FCStd", overwrite:true})`.
The reply distinguishes save-in-place from Save-As, and Save-As REBINDS the
document. Quote which one happened, in those words.
State clearly how `fn:"save"` differs from `freecad_export({format:"FCStd"})`
and confirm you picked the right one.

### Phase 2 — ID durability

1. `freecad_call({fn:"ids"})` — capture the full id list and
   `revertedAiObjects`.
2. Reopen from disk with `open_document`.
3. `ids` again. Every id must be restored from `doc.Meta`. Diff the two lists
   and report any loss.
4. `feature_edit({target:"pad.base", props:{Length:25}})` — by HANDLE, not by
   internal name. Confirm the DAG recomputed cleanly and, critically, that the
   stored chamfer `query` re-resolved. If the reply carries `rehealed`, the
   edges were re-derived rather than preserved — check them before reporting.
5. Confirm the parameter binding survived the roundtrip: change the param and
   confirm the pad follows.

### Phase 3 — Export

Before either export, run `freecad_dfm({targets:["body.bracket"]})` and quote
the verdict alongside the paths. Export is the moment the question stops being
"is the model what I meant" and becomes "can this be made", because whoever
receives the STEP cannot ask the model anything. Note whether the skill
prompted you to do this or whether you remembered on your own.

`freecad_export({format:"STEP", targets:["body.bracket"]})` and
`freecad_export({format:"STL", targets:["body.bracket"]})`.
Quote both paths and confirm they are inside the export directory.

### Phase 4 — Import and boolean

1. `import_geometry({path:"<the STEP path>", at:[100,0,0]})`.
   The reply should say plainly that what arrived is a SHAPE — no features, no
   sketches, nothing to bind an expression to. Confirm it does.
   Note whether multiple solids arrived under a single `App::Part`.
2. Cut a clearance pocket from the imported shape with
   `boolean({op:"cut", base:..., tool:...})`.
   If `base` is an `App::Part` container rather than a solid and the boolean
   refuses or misbehaves, LOG IT — do not work around it by unpacking the
   container with `freecad_script`.
   Read `removed`: a cut that removed nothing must be reported as such.
3. `freecad_measure({deepLint:true})` on the result.
4. `freecad_dfm({targets:["<the imported shape>"]})`. This is the one check in
   the skill that does not degrade on imported geometry. `ids`, `sketch_get`,
   `feature_edit`, every expression binding and every stored `query` have
   nothing to work with once the tree is gone — but a corner radius, a tool
   reach and a residual are facts about a SHAPE, and the importer brought a
   shape. Confirm it answers, and set that against what step 1 said about the
   import being non-parametric: those two statements are both true and it is
   worth being precise about why.

### Acceptance

- Zero id loss across the save/reopen boundary.
- The `query`-driven chamfer survived a dimensional change.
- The imported shape is correctly described as non-parametric.
- The boolean's `removed` is non-zero and stated.
- The DFM verdict on the imported shape MATCHES the verdict on the body it was
  exported from. A roundtrip through STEP does not change what a cutter can
  reach, so if the two disagree, either the export dropped geometry or the
  check is reading something other than the shape. Either one is a defect and
  the two are distinguishable — say which.
```

## References

- [LinuxServer.io FreeCAD Image Documentation](https://docs.linuxserver.io/images/docker-freecad/)
- [LinuxServer.io Hardware Acceleration & Wayland Guide](https://docs.linuxserver.io/images/docker-freecad/#hardware-acceleration-wayland)
- [LinuxServer.io Selkies GPU Acceleration Guide (Intel, AMD & Nvidia)](https://docs.linuxserver.io/selkies/user-guide/gpu/)
- [LinuxServer.io Selkies Open-Source Drivers Guide (Intel & AMD DRI)](https://docs.linuxserver.io/selkies/user-guide/gpu/#intel-and-amd-open-source-drivers)
- [LinuxServer.io Baseimage Selkies Repository](https://github.com/linuxserver/docker-baseimage-selkies)
- [KasmVNC WebRTC Streaming Project](https://kasmweb.com/docs/latest/index.html)
- [Podman Quadlet Systemd Documentation](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
