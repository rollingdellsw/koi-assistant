#!/usr/bin/env bash
#
# container/koi-blender-up.sh — bring up the streamed Blender session.
#
# Same deployment shape as freecad-live: a LinuxServer image streaming a real
# desktop over WebRTC (Selkies) to a browser tab, rootless podman, /config and
# /workspace on bind mounts, credentials in a 0600 env-file that podman reads
# itself so the secret never lands in argv.
#
# One deliberate difference. freecad-live publishes its bridge on
# 127.0.0.1:8765 because that bridge authenticates with KOI_BRIDGE_TOKEN. The
# Blender addon's socket has no authentication of any kind — it is a JSON
# socket that runs arbitrary Python in the GUI process — so it is not published
# at all, and the Koi Gateway reaches it by running the MCP server *inside* the
# container with `podman exec -i`. The network namespace is the boundary. See
# `--publish-mcp` below for the remote case, which trades that away knowingly.
#
# Idempotent: safe to re-run after an image bump, a bad edit, or a reboot.

set -euo pipefail

NAME="${KOI_BLENDER_NAME:-koi-blender}"
ROOT="${KOI_BLENDER_ROOT:-$HOME/blender-stream}"
ENV_FILE="${ROOT}/stream.env"
# Pinning is two independent locks, as in freecad-live: this one fixes what
# starts, and PIN_VERSION/PIN_BUILD in scripts/connect.js fixes what is actually
# running. `latest` tracks the newest Blender release and WILL drift off
# whatever version the skill was verified against — resolve a digest with
# `podman image inspect --format '{{index .RepoDigests 0}}' <image>` after the
# first pull and put it in KOI_BLENDER_IMAGE.
IMAGE="${KOI_BLENDER_IMAGE:-docker.io/linuxserver/blender:latest}"
# freecad-live's container publishes 3000/3001 too, and the two skills are meant
# to be used in one session. Whichever comes up second loses the bind, so make
# the ports a knob rather than a fact. Change them here and in STREAM_URL at the
# top of scripts/connect.js, which is the only other place the number appears.
PORT_HTTP="${KOI_BLENDER_HTTP_PORT:-3000}"
PORT_HTTPS="${KOI_BLENDER_HTTPS_PORT:-3001}"
PORT_MCP="${KOI_BLENDER_MCP_PORT:-9876}"
PUBLISH_MCP=0
# Every claim this skill makes about operator context, the addon protocol and
# safe mode's allowlist was verified against Blender 4.5 LTS. The image tracks
# the newest release, so this is a warning, not a gate.
EXPECT_MAJOR="${KOI_BLENDER_EXPECT_MAJOR:-4}"

for arg in "$@"; do
  case "$arg" in
    --publish-mcp) PUBLISH_MCP=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

# bash's own /dev/tcp rather than lsof or ss: neither is installed everywhere,
# and rootlessport is a process of yours that lsof reports inconsistently once
# it is mid-teardown — which is precisely the moment this matters.
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }

# 9876 == 0x2694, and /proc/net/tcp is the one way to ask this that needs no
# package inside the image: ss, lsof and netstat are all absent from a minimal
# desktop base, and `podman logs` is not trustworthy here either (see
# --log-driver below).
mcp_listening() {
  podman exec "${NAME}" sh -c 'cat /proc/net/tcp 2>/dev/null' 2>/dev/null \
    | awk '{print $2}' | grep -qi ':2694$'
}

autostart_log() {
  # Through the container, not off the bind mount. Rootless podman maps the
  # container's UID 1000 to a subuid, so a file Blender creates there is owned
  # by an ID you are not, and reading it from the host can fail on permissions
  # in a way that looks exactly like the file not existing — which is how an
  # empty diagnostic block gets printed under a message saying to read it.
  podman exec "${NAME}" tail -n 40 /config/koi-autostart.log 2>/dev/null
}

who_has() {
  podman ps -a --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null \
    | grep ":$1->" || true
}

# `podman restart` stops and starts in one step, and rootless publishing makes
# that a race: the rootlessport helper for the old instance can still hold the
# listening socket when the new one tries to bind, which fails the whole start
# with "address already in use" over a port that is free a second later. Stop,
# wait for the socket to actually go, then start.
restart_container() {
  podman stop -t 10 "${NAME}" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    port_busy "${PORT_HTTP}" || port_busy "${PORT_HTTPS}" || break
    sleep 1
  done
  for attempt in 1 2 3; do
    if podman start "${NAME}" >/dev/null 2>&1; then return 0; fi
    warn "start attempt ${attempt} failed; the port is still going down"
    sleep 3
  done
  podman start "${NAME}"   # once more, unredirected, so the real error shows
}

# --- 1. mounts --------------------------------------------------------------
# /config is HOME inside the image: preferences, the addon, the startup script,
# and the uv-installed MCP server all live here, which is why none of them
# needs a rebuild. /workspace is the only path that is a real directory on this
# machine; the guardrail refuses absolute writes outside it for that reason.
say "mounts under ${ROOT}"
mkdir -p "${ROOT}/config" "${ROOT}/workspace"
podman unshare mkdir -p "${ROOT}/workspace/koi_export"
podman unshare chown -R 1000:1000 "${ROOT}/config" "${ROOT}/workspace"

# --- 2. desktop credentials -------------------------------------------------
# Anyone who reaches the stream gets Blender with a Python console in it, i.e.
# code execution as the container user, without ever touching the MCP path. The
# first lock is that nothing here binds anything but loopback; this is the
# second. Generated once and left alone on re-runs.
if [ ! -f "${ENV_FILE}" ]; then
  say "generating desktop credentials in ${ENV_FILE}"
  install -m 600 /dev/null "${ENV_FILE}"
  {
    echo "CUSTOM_USER=koi"
    echo "PASSWORD=$(openssl rand -hex 24)"
  } > "${ENV_FILE}"
fi
say "stream login: $(grep -E 'CUSTOM_USER|PASSWORD' "${ENV_FILE}" | tr '\n' ' ')"

# --- 3. the container -------------------------------------------------------
say "starting ${NAME} from ${IMAGE}"
podman rm -f "${NAME}" >/dev/null 2>&1 || true

for port in "${PORT_HTTP}" "${PORT_HTTPS}"; do
  if port_busy "${port}"; then
    holder="$(who_has "${port}")"
    warn "something is already listening on 127.0.0.1:${port}"
    [ -n "${holder}" ] && warn "  it looks like: ${holder}"
    warn "  If that is freecad-live, give Blender its own pair:"
    warn "    KOI_BLENDER_HTTP_PORT=3002 KOI_BLENDER_HTTPS_PORT=3003 $0"
    warn "  and set STREAM_URL in scripts/connect.js to match."
    exit 3
  fi
done

publish=(-p "127.0.0.1:${PORT_HTTP}:3000" -p "127.0.0.1:${PORT_HTTPS}:3001")
if [ "${PUBLISH_MCP}" = "1" ]; then
  # For a Blender host that is not the machine running Chrome. Reachable only
  # over loopback and therefore only through `ssh -N -L 9876:127.0.0.1:9876`,
  # and the addon must be told to bind the container's external interface or
  # -p forwards to nothing. Everything on the far side of that tunnel can run
  # Python in the session with no credential at all — take it only if you need
  # it, and never on a shared host.
  publish+=(-p "127.0.0.1:${PORT_MCP}:9876")
  bind_host="0.0.0.0"
else
  bind_host="127.0.0.1"
fi

# No --userns=keep-id: LinuxServer images run s6-overlay, which needs the
# default rootless mapping (UID 0 -> your user) to set permissions internally.
# Not journald. Rootless podman defaults to it on most distros, and under WSL2
# the user journal is frequently not functional — `podman logs` then dies with
# "initial journal cursor: failed to get cursor: cannot assign requested
# address" and takes away the one diagnostic everything else tells you to run.
# k8s-file writes a plain file podman reads back itself.
podman run -d \
  --name "${NAME}" \
  --log-driver=k8s-file \
  --security-opt seccomp=unconfined \
  --shm-size=2gb \
  -e PUID=1000 -e PGID=1000 -e TZ="${TZ:-Etc/UTC}" \
  --env-file "${ENV_FILE}" \
  -e HARDEN_DESKTOP=true \
  -e KOI_BLENDER_HOST="${bind_host}" \
  -e KOI_BLENDER_PORT=9876 \
  "${publish[@]}" \
  -v "${ROOT}/config:/config:Z" \
  -v "${ROOT}/workspace:/workspace:Z" \
  ${KOI_BLENDER_GPU:-} \
  --restart unless-stopped \
  "${IMAGE}" >/dev/null

say "waiting for the desktop session"
for _ in $(seq 1 60); do
  podman exec "${NAME}" test -x /usr/bin/blender 2>/dev/null && break
  sleep 1
done

# --- 4. the MCP server, installed into /config ------------------------------
# Into the bind mount rather than the image, for the same reason freecad-live
# drops koi_bridge.py into the macro directory: it survives an image bump and
# can be fixed without a build. This is the binary gateway-config.json points
# `podman exec` at.
if ! podman exec "${NAME}" test -x /config/.local/bin/blender-mcp; then
  say "installing blender-mcp into /config (one-time, needs network)"
  podman exec -u 1000:1000 -e HOME=/config "${NAME}" sh -lc '
    command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="/config/.local/bin:$PATH"
    uv tool install --python 3.11 --force blender-mcp'
fi

# --- 5. the addon and the startup script ------------------------------------
# user_resource("SCRIPTS") rather than a hardcoded 4.5: this image tracks the
# newest Blender release, so the version directory moves under you and a
# wrong guess fails silently as "the MCP panel is missing".
SCRIPTS="$(podman exec -u 1000:1000 -e HOME=/config "${NAME}" \
  blender --background --factory-startup \
  --python-expr 'import bpy;print("KOI_SCRIPTS="+bpy.utils.user_resource("SCRIPTS"))' \
  2>/dev/null | sed -n 's/^KOI_SCRIPTS=//p' | tail -1)"
[ -n "${SCRIPTS}" ] || { echo "could not resolve Blender's user scripts dir" >&2; exit 1; }
say "blender user scripts: ${SCRIPTS}"

# The version is in that path, and it is the single most useful thing to say out
# loud: a 5.x image installs, streams and connects perfectly well, then diverges
# from the skill somewhere specific and much later.
BVER="$(basename "$(dirname "${SCRIPTS}")")"
case "${BVER}" in
  "${EXPECT_MAJOR}".*) say "blender ${BVER} — matches the verified line" ;;
  *)
    warn "this image ships Blender ${BVER}; the skill is verified on ${EXPECT_MAJOR}.5 LTS."
    warn "  Legacy add-ons still load on 5.x, so this will probably work — but"
    warn "  nothing here has been checked against it, and a 5.x API change shows"
    warn "  up as one tool failing oddly, not as a refusal to start."
    warn "  To stay on the verified line:"
    warn "    podman search --list-tags docker.io/linuxserver/blender | grep '4\.5'"
    warn "    export KOI_BLENDER_IMAGE=docker.io/linuxserver/blender:<that tag>"
    warn "  Or keep 5.x deliberately: KOI_BLENDER_EXPECT_MAJOR=5 silences this,"
    warn "  and step 8 of the README is where you re-pin what you verified."
    ;;
esac

podman exec -u 1000:1000 -e HOME=/config "${NAME}" mkdir -p "${SCRIPTS}/addons" "${SCRIPTS}/startup"
if ! podman exec "${NAME}" sh -c "ls ${SCRIPTS}/addons/*.py >/dev/null 2>&1"; then
  say "installing the MCP addon"
  podman exec -u 1000:1000 -e HOME=/config -e BLENDERMCP_ADDONS_DIR="${SCRIPTS}/addons" \
    "${NAME}" sh -lc 'PATH=/config/.local/bin:$PATH blender-mcp install-addon'
fi

# A standalone version of what the startup script does, minus the timer, so a
# failure prints its traceback on a terminal instead of into a GUI console
# nobody is attached to. Written every run so it cannot go stale.
podman exec -u 1000:1000 -e HOME=/config -i "${NAME}" sh -c 'cat > /config/koi-probe.py' <<'PROBE'
import addon_utils, bpy, traceback
print("blender:", bpy.app.version_string)
print("scripts:", bpy.utils.user_resource("SCRIPTS"))
found = []
for m in addon_utils.modules(refresh=True):
    info = getattr(m, "bl_info", {}) or {}
    print("module:", m.__name__, "|", info.get("name"), "|", getattr(m, "__file__", "?"))
    label = "%s %s" % (m.__name__, info.get("name", ""))
    if "mcp" in label.lower() and "blender" in label.lower():
        found.append(m.__name__)
print("candidates:", found or "NONE")
for name in found:
    try:
        mod = addon_utils.enable(name, default_set=False, persistent=False)
        print("enabled:", name, "-> BlenderMCPServer:", hasattr(mod, "BlenderMCPServer"))
    except Exception:
        traceback.print_exc()
PROBE

SRC="$(dirname "$0")/koi_blender_autostart.py"
DST="${SCRIPTS}/startup/koi_blender_autostart.py"
want="$(sha256sum "${SRC}" | cut -d' ' -f1)"
have="$(podman exec "${NAME}" sha256sum "${DST}" 2>/dev/null | cut -d' ' -f1 || true)"

# Two reasons to restart, and the checksum is only one of them. Blender imports
# startup scripts once, at launch, and this container was launched a few lines
# above — before the copy below. So an unchanged checksum proves the file on
# disk is current; it proves nothing about the Blender that is already running.
# The socket is the fact that matters, so ask about that too.
if [ "${want}" = "${have}" ] && mcp_listening; then
  say "startup script current and the addon is listening — not restarting"
else
  if [ "${want}" != "${have}" ]; then
    say "installing the startup script"
    podman cp "${SRC}" "${NAME}:${DST}"
    podman exec "${NAME}" chown 1000:1000 "${DST}"
  else
    say "startup script current, but nothing is listening on 9876"
  fi
  # The startup script only runs at startup, and Blender started before it
  # existed. Restart the whole container rather than the app: s6 owns the
  # process and restarting it any other way leaves the stream pointed at a
  # window that is gone.
  say "restarting so the startup script runs"
  restart_container
  sleep 8
fi

# --- 6. did the addon actually come up --------------------------------------
# Asking the container directly rather than grepping logs: this is the single
# fact the whole chain depends on, and it is true or false, not "no lines yet".
say "waiting for the addon's socket"
for _ in $(seq 1 30); do
  mcp_listening && break
  sleep 1
done

if mcp_listening; then
  say "addon is listening on 9876 inside the container"
else
  warn "the addon is NOT listening on 9876. The gateway will register its 28"
  warn "tools anyway — that is the MCP server, not Blender — and every call"
  warn "will fail with Errno 111 until this is fixed."
  warn ""
  warn "What the startup script says:"
  autostart_log | sed 's/^/    /' >&2 || true
  warn ""
  warn "And what Blender itself said (upstream prints bind failures here with"
  warn "no 'BlenderMCP' prefix, so do not grep for that):"
  podman logs "${NAME}" 2>/dev/null | grep -iE 'blendermcp|failed to start server' \
    | tail -n 15 | sed 's/^/    /' >&2 || true
  warn ""
  warn "If that file is empty or missing, the script never ran: check that"
  warn "Blender itself is alive with"
  warn "    podman exec ${NAME} sh -c 'ps ax | grep [b]lender'"
  warn "and reproduce the enable step with its traceback using"
  warn "    podman exec -u 1000:1000 -e HOME=/config ${NAME} \\"
  warn "      blender --background --python /config/koi-probe.py"
  warn "(the setup script wrote that probe for you)."
fi
# (The old grep over `podman logs` lived here. It contradicted the check above
# on every run and, on a journald default, printed its own error into the grep.)

cat <<EOF

$(say "up")

  stream      https://localhost:${PORT_HTTPS}   (self-signed cert; Advanced -> Proceed)
  login       $(grep -E 'CUSTOM_USER|PASSWORD' "${ENV_FILE}" | tr '\n' ' ')
  workspace   ${ROOT}/workspace        (the only path that is real on this host)

Next, in order — the gateway spawns its child once, at startup, so a gateway
restarted before the container finds nothing and registers no tools:

  systemctl --user restart koi-gateway
  node tools/gateway/koi-blender-smoke.mjs
EOF