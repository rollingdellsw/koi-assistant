#!/usr/bin/env bash
#
# run-gateway.sh — launch the Koi Gateway (by hand or under systemd/launchd).
#
# systemd/launchd starts services with a minimal PATH that does NOT include a
# user-managed Node (fnm/nvm/brew). The gateway both *is* Node and *spawns* `node`
# (the sandbox server) and `npm` (the lsp_search autoBuild), so we resolve a
# Node binary, put its directory on PATH, then exec the gateway from its own
# directory (the config uses relative paths like ./sandbox-shell-mcp.mjs).
#
# Override Node resolution by setting KOI_NODE_BIN=/abs/path/to/node.
#
# THE EGRESS PROXY STARTS HERE, NOT IN ITS OWN UNIT.
#
# In --net policy mode the sandbox server calls `koi-net-setup.sh preflight
# --running` at boot and exits 1 unless the proxy is already LISTENING. As two
# systemd units that was a race nobody could win: koi-egress is Type=simple, so
# systemd calls it "active" the instant squid forks — before squid has parsed
# its config, spawned the ACL helper and bound the port. After= orders starts,
# it does not wait for readiness, so the gateway raced ahead and the sandbox
# server died with "nothing is listening on 127.0.0.1:<port>". It looked like a
# broken gateway, sent you to the wrong log, and cleared up on a manual restart
# — the worst possible failure shape.
#
# One process tree fixes it by construction: we start the proxy, POLL until the
# port actually answers, and only then exec the gateway. If the proxy cannot
# come up we exit non-zero right here, with squid's own log on stderr, instead
# of handing systemd a healthy gateway wrapped around a dead sandbox.
#
# The cost is deliberate, and is the reason this used to be two units:
#   * restarting the gateway restarts the proxy, so approvals in flight are
#     dropped rather than surviving underneath;
#   * a proxy that dies mid-session is not independently resupervised — the
#     gateway's own Restart=on-failure brings the pair back together.
# Both are accepted in exchange for a startup that either works or says why.

set -euo pipefail

resolve_script_dir() {
  local target="$1"
  while [ -L "$target" ]; do
    local dir
    dir="$(cd -P "$(dirname "$target")" && pwd)"
    target="$(readlink "$target")"
    [ "${target#/}" = "$target" ] && target="$dir/$target"
  done
  cd -P "$(dirname "$target")" && pwd
}

cd "$(resolve_script_dir "$0")"

find_node() {
  # 1) explicit override
  if [ -n "${KOI_NODE_BIN:-}" ] && [ -x "${KOI_NODE_BIN}" ]; then
    printf '%s
' "${KOI_NODE_BIN}"; return 0
  fi
  # 2) already on PATH (e.g. launched from a login shell)
  if command -v node >/dev/null 2>&1; then
    command -v node; return 0
  fi
  # 3) fnm default alias
  local fnm_dir="${FNM_DIR:-$HOME/.local/share/fnm}"
  if [ -x "${fnm_dir}/aliases/default/bin/node" ]; then
    printf '%s
' "${fnm_dir}/aliases/default/bin/node"; return 0
  fi
  # 4) nvm — highest installed version
  local nvm_node
  nvm_node="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "${nvm_node}" ] && [ -x "${nvm_node}" ]; then
    printf '%s
' "${nvm_node}"; return 0
  fi
  # 5) system & package manager paths (Homebrew Apple Silicon + Intel/Linux)
  local c
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$c" ] && { printf '%s
' "$c"; return 0; }
  done
  return 1
}

NODE_BIN="$(find_node)" || {
  echo "run-gateway: could not locate a node binary." >&2
  echo "  Set KOI_NODE_BIN=/path/to/node in the environment or service definition." >&2
  exit 127
}

# Put node/npm on PATH so the gateway can spawn `node ./sandbox-shell-mcp.mjs`
# and run the lsp_search autoBuild (`npm install && npm run build`).
export PATH="$(dirname "$NODE_BIN"):$PATH"

export KOI_NODE_BIN="$NODE_BIN"

: "${KOI_PROXY_PORT:=3129}"
export KOI_PROXY_PORT

# What --net does gateway-config.json actually ask for? The proxy is only
# required for "policy"; starting it for host/loopback would burn a port and a
# process for nothing. Read the same file the gateway is about to read, so the
# two can never disagree.
net_mode() {
  [ -f gateway-config.json ] || { printf 'host'; return 0; }
  "$NODE_BIN" -e '
    const fs = require("fs");
    try {
      const cfg = JSON.parse(fs.readFileSync("gateway-config.json", "utf8"));
      const args = (cfg.servers && cfg.servers.sandbox && cfg.servers.sandbox.args) || [];
      const i = args.indexOf("--net");
      process.stdout.write(i >= 0 && args[i + 1] ? String(args[i + 1]) : "host");
    } catch { process.stdout.write("host"); }
  ' 2>/dev/null || printf 'host'
}

PROXY_PID=""
PROXY_LOG=""
GATEWAY_PID=""

# Take BOTH children down with us. Without this a `systemctl restart` (or a
# Ctrl-C of a hand-run gateway) leaves squid holding the port, and the next
# start cannot bind — the classic "it worked yesterday" that needs a manual
# pkill. The gateway needs the same treatment: before this script had a proxy
# to supervise it used `exec`, so signalling the wrapper *was* signalling the
# gateway. Now that it runs as a child, a TERM to the wrapper would leave an
# orphaned gateway holding port 8080.
cleanup() {
  local pid
  for pid in "$GATEWAY_PID" "$PROXY_PID"; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
  done
  for pid in "$GATEWAY_PID" "$PROXY_PID"; do
    [ -n "$pid" ] || continue
    wait "$pid" 2>/dev/null || true
  done
  GATEWAY_PID=""; PROXY_PID=""
  [ -n "$PROXY_LOG" ] && rm -f "$PROXY_LOG"
  return 0
}
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 130' INT
trap cleanup EXIT

start_proxy() {
  PROXY_LOG="$(mktemp -t koi-egress.XXXXXX.log)"
  /bin/bash ./koi-net-setup.sh proxy >"$PROXY_LOG" 2>&1 &
  PROXY_PID=$!

  # Poll for the port, do not sleep-and-hope: squid's startup time varies with
  # cache_dir state and machine load, which is exactly what made the fixed
  # ordering of two units unreliable. ~20s at 0.2s intervals.
  local i=0
  while [ "$i" -lt 100 ]; do
    if ! kill -0 "$PROXY_PID" 2>/dev/null; then
      echo "run-gateway: the egress proxy exited during startup. Its log:" >&2
      sed 's/^/  | /' "$PROXY_LOG" >&2
      wait "$PROXY_PID" 2>/dev/null || true
      PROXY_PID=""
      return 1
    fi
    if KOI_PROXY_PORT="$KOI_PROXY_PORT" /bin/bash ./koi-net-setup.sh preflight --running \
         >/dev/null 2>&1; then
      echo "run-gateway: egress proxy ready on 127.0.0.1:${KOI_PROXY_PORT}" >&2
      return 0
    fi
    sleep 0.2
    i=$((i + 1))
  done

  echo "run-gateway: the egress proxy did not start listening on 127.0.0.1:${KOI_PROXY_PORT}" >&2
  echo "  within 20s. Its log:" >&2
  sed 's/^/  | /' "$PROXY_LOG" >&2
  return 1
}

if [ "$(net_mode)" = "policy" ]; then
  start_proxy || {
    echo "run-gateway: refusing to start the gateway without the egress proxy it" >&2
    echo "  requires (--net policy). The sandbox server would exit at boot anyway." >&2
    echo "  Retry:    systemctl --user restart koi-gateway" >&2
    echo "  Diagnose: journalctl --user -u koi-gateway -n 50" >&2
    echo "  Or turn filtering off: ./koi-gateway-installer network off" >&2
    exit 1
  }
fi

# `exec` would replace this shell and orphan the proxy, losing the trap that
# stops it. Run the gateway as a child and forward its exit status, so the trap
# still fires and takes squid down with us.
"$NODE_BIN" koi-gateway.js --config gateway-config.json "$@" &
GATEWAY_PID=$!
# `wait` is interruptible, so a TERM arriving here runs the trap immediately
# instead of being queued until the gateway happens to exit.
#
# `|| STATUS=$?` is load-bearing under `set -e`: a bare `wait` that returns
# non-zero would exit the script right here, before the status could be read.
STATUS=0
wait "$GATEWAY_PID" || STATUS=$?
GATEWAY_PID=""
exit "$STATUS"
