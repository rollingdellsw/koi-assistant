#!/usr/bin/env bash
#
# koi-net-setup.sh — network enforcement for `--net policy`.
#
# Three subcommands, all using tools that already exist. Nothing here
# implements networking or filtering itself:
#
#   preflight   report whether pasta/passt, nft and squid are usable
#   proxy       run the egress proxy (squid) in the foreground
#   confine     entrypoint INSIDE the sandbox namespace: install default-drop
#               nftables rules, then exec the real command
#
# Topology:
#
#   pasta --config-net -t auto -- bwrap ... koi-net-setup.sh confine -- <cmd>
#   └ creates the netns and gives it usermode networking, and forwards ports
#     the namespace binds back to host loopback (`-t auto`), which is what
#     makes dev servers visible to the browser again — the thing `--net host`
#     was buying at the cost of unrestricted egress.
#         └ bwrap does the filesystem sandbox as before (no --unshare-net now;
#           it inherits pasta's namespace)
#               └ confine drops everything outbound except the proxy, so a
#                 tool that ignores HTTPS_PROXY fails closed instead of
#                 reaching the internet directly — then drops CAP_NET_ADMIN so
#                 the command it execs cannot take that filter back down.
#
# DNS is deliberately NOT allowed out of the namespace: Squid resolves, so the
# policy is keyed on the name the user actually approved rather than on an IP
# that a CDN can move. Tools that insist on resolving locally fail; that is the
# fail-closed trade and the error message says so.

set -euo pipefail

SELF_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 3128 is the distro squid default. Squatting it means our user-level proxy
# races the system squid.service for the port AND for its POSIX shared-memory
# segments, which fails as:
#   FATAL: Ipc::Mem::Segment::create failed to shm_open(/squid-cf__metadata.shm)
# Use our own port and our own squid service name instead of asking the user
# to disable a system service they may want.
: "${KOI_PROXY_PORT:=3129}"
# ALPHANUMERIC ONLY. Squid validates this and rejects anything else with
#   FATAL: Garbage after alphanumeric service name in the -n option value
# so a hyphenated name (the obvious "koi-egress", matching the systemd unit)
# is refused, we fall back to the shared default namespace, and collide with
# the system squid again. Sanitised below in case someone overrides it.
: "${KOI_SQUID_SERVICE:=koiegress}"
KOI_SQUID_SERVICE="$(printf '%s' "${KOI_SQUID_SERVICE}" | tr -cd '[:alnum:]')"
[ -n "${KOI_SQUID_SERVICE}" ] || KOI_SQUID_SERVICE=koiegress
: "${KOI_PROXY_HOST:=}"           # set by `confine`, see below
: "${KOI_HOME:=${HOME}/.koi}"
: "${KOI_NETWORK_POLICY:=${KOI_HOME}/network-policy.json}"
: "${KOI_NETWORK_SOCK:=${KOI_HOME}/approval.sock}"
: "${KOI_SQUID_DIR:=${KOI_HOME}/squid}"

have() { command -v "$1" >/dev/null 2>&1; }

# Is something LISTENING on this port?
#
# `ss -ltn` is Linux-only and `netstat -ltn` is GNU-only: BSD/macOS netstat has
# no -l and no -t, so it exits non-zero, 2>/dev/null swallows the error, grep
# matches nothing and the function reports "free". That is the wrong answer in
# the dangerous direction — it made `free-port` hand back a port squid already
# held, and made `preflight --running` unable to see a live proxy.
#
# lsof sits in the middle: present by default on macOS, common on Linux, and
# the same invocation works on both. The netstat fallback uses only flags BSD
# and GNU agree on (-an -p tcp).
port_in_use() {
  local p="$1"
  if have ss; then
    ss -ltn "sport = :${p}" 2>/dev/null | grep -q LISTEN && return 0
  elif have lsof; then
    lsof -nP -iTCP:"${p}" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  elif have netstat; then
    netstat -an -p tcp 2>/dev/null | grep -qE "[:.]${p}[[:space:]]+.*LISTEN" && return 0
  fi
  return 1
}

# Does this squid accept -n with our (already sanitised) service name? Probed
# with -k parse against a throwaway minimal config so the answer does not
# depend on the generated one being valid yet.
squid_supports_n() {
  local tmp; tmp="$(mktemp)" || return 1
  printf 'http_port 127.0.0.1:%s\n' "${KOI_PROXY_PORT}" > "$tmp"
  local out; out="$(squid -n "${KOI_SQUID_SERVICE}" -k parse -f "$tmp" 2>&1)"; local st=$?
  rm -f "$tmp"
  [ $st -eq 0 ] && ! printf '%s' "$out" | grep -qi 'service name'
}

# First free port in a small range, so the user never has to pick one after a
# collision with a distro squid (or a second checkout of this repo).
cmd_free_port() {
  local p
  for p in $(seq "${KOI_PROXY_PORT}" $((KOI_PROXY_PORT + 40))); do
    port_in_use "$p" || { printf '%s\n' "$p"; return 0; }
  done
  return 1
}

find_pasta() {
  for c in pasta passt-pasta /usr/bin/pasta /usr/local/bin/pasta; do
    have "$c" && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

# -----------------------------------------------------------------------------
# preflight            "can this host be set up?"  -> the proxy port must be FREE
# preflight --running   "is the setup live?"        -> the proxy must be LISTENING
#
# The distinction is not cosmetic. The sandbox server runs this at boot, AFTER
# the proxy is up, and the free-port check inverted its meaning: a correctly
# running proxy made the server refuse to start with
#   "MISSING port 3129 is already in use"
# which reads like a conflict and is actually success.
# Exit codes are meaningful, because the caller reacts differently to each:
#   0  ready
#   1  a required tool is missing        -> offer to install packages
#   3  tools are fine, the PORT is busy  -> just pick another port
# Conflating these is why a busy port produced "Missing dependencies. This will
# run: apt-get install ..." for someone who already had everything installed.
cmd_preflight() {
  local rc=0 port_rc=0 expect_proxy=0
  case "${1:-}" in
    --running|--expect-proxy) expect_proxy=1 ;;
  esac

  # macOS confines with seatbelt, which filters egress in place — there is no
  # namespace to build, so pasta and nft are Linux-only requirements.
  if [ "$(uname -s)" = "Darwin" ]; then
    if have squid; then echo "ok       squid:  $(command -v squid)"
    else echo "MISSING  squid — install squid (brew install squid)"; rc=1; fi
    [ -f "${KOI_NETWORK_POLICY}" ] &&
      echo "ok       policy: ${KOI_NETWORK_POLICY}" ||
      echo "note     policy: ${KOI_NETWORK_POLICY} not created yet (seeded on first run)"
    # The liveness check is NOT Linux-only. The sandbox server runs
    # `preflight --running` at boot to refuse starting a "policy" sandbox whose
    # proxy is down; returning before this made that check a no-op on macOS, so
    # a Mac with squid installed but not running booted believing it was
    # filtered. Same question, same answer, both platforms.
    if [ "${expect_proxy}" = "1" ]; then
      if port_in_use "${KOI_PROXY_PORT}"; then
        echo "ok       proxy:  listening on 127.0.0.1:${KOI_PROXY_PORT}"
      else
        echo "MISSING  nothing is listening on 127.0.0.1:${KOI_PROXY_PORT} — the egress proxy"
        echo "         is not running. Start it with: koi-gateway-installer network on"
        rc=1
      fi
    fi
    return $rc
  fi

  if pasta_bin="$(find_pasta)"; then
    echo "ok       pasta:  ${pasta_bin}"
  else
    # slirp4netns is NOT a substitute. Nothing in this codebase drives it, and
    # `-t auto` (republishing sandbox dev-server ports onto host loopback) is
    # pasta-only — without it, enabling policy mode would silently make every
    # dev server invisible to the browser. Reporting it as "ok" was a bug: the
    # preflight passed and then every sandbox_exec died on `pasta: not found`.
    echo "MISSING  pasta — install passt:  sudo apt install passt   (or: brew install passt)"
    have slirp4netns &&
      echo "         (slirp4netns is installed but is not used; pasta is required)"
    rc=1
  fi

  if have nft; then echo "ok       nft:    $(command -v nft)"
  else echo "MISSING  nft — install nftables (apt install nftables)"; rc=1; fi

  if have squid; then echo "ok       squid:  $(command -v squid)"
  else echo "MISSING  squid — install squid (apt install squid)"; rc=1; fi

  # confine REFUSES to exec without one of these: they are what drops
  # CAP_NET_ADMIN, and without the drop the sandboxed command can delete the
  # egress filter with `nft flush ruleset`. Missing here means every
  # sandbox_exec fails closed, so report it as a missing dependency.
  if have setpriv; then echo "ok       setpriv: $(command -v setpriv)"
  elif have capsh; then echo "ok       capsh:  $(command -v capsh) (setpriv preferred)"
  else
    echo "MISSING  setpriv or capsh — needed to drop CAP_NET_ADMIN after the egress"
    echo "         filter is installed, so the sandbox cannot remove it."
    echo "         install: sudo apt install util-linux   (or libcap2-bin)"
    rc=1
  fi

  if [ -f "${KOI_NETWORK_POLICY}" ]; then
    echo "ok       policy: ${KOI_NETWORK_POLICY}"
  else
    echo "note     policy: ${KOI_NETWORK_POLICY} not created yet (seeded on first run)"
  fi

  if [ "${expect_proxy}" = "1" ]; then
    if port_in_use "${KOI_PROXY_PORT}"; then
      echo "ok       proxy:  listening on 127.0.0.1:${KOI_PROXY_PORT}"
    else
      echo "MISSING  nothing is listening on 127.0.0.1:${KOI_PROXY_PORT} — the egress proxy"
      echo "         is not running. Start it with: koi-gateway-installer network on"
      rc=1
    fi
  elif port_in_use "${KOI_PROXY_PORT}"; then
    # Our own proxy already sitting there is not a conflict; it is about to be
    # restarted onto the same port.
    if systemctl --user is-active --quiet koi-egress.service 2>/dev/null; then
      echo "ok       port:   ${KOI_PROXY_PORT} held by our own koi-egress (will be restarted)"
    else
      echo "BUSY     port ${KOI_PROXY_PORT} is in use by something else — another port will be chosen"
      port_rc=3
    fi
  else
    echo "ok       port:   ${KOI_PROXY_PORT} is free"
  fi

  # A distro squid on 3128 is fine and can keep running; we only need to not
  # collide with it — same port, same shared-memory namespace, either is fatal.
  if pgrep -x squid >/dev/null 2>&1; then
    echo "note     another squid is already running (that is fine; ours uses"
    echo "         port ${KOI_PROXY_PORT} and service name '${KOI_SQUID_SERVICE}')"
    if have squid && squid_supports_n; then
      echo "ok       squid -n: supported (own shm namespace /${KOI_SQUID_SERVICE}-*.shm)"
    elif have squid; then
      echo "MISSING  this squid rejects -n, so it can only use the default shm"
      echo "         namespace, which the running squid already owns. Either stop it"
      echo "         (sudo systemctl stop squid) or upgrade squid."
      rc=1
    fi
  fi

  # Unprivileged userns must work or bwrap cannot create the sandbox at all.
  if [ -r /proc/sys/kernel/unprivileged_userns_clone ] &&
     [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" = "0" ]; then
    echo "MISSING  unprivileged user namespaces are disabled"; rc=1
  fi
  # A missing tool outranks a busy port: it is the one the caller must act on.
  [ "$rc" -ne 0 ] && return "$rc"
  return "$port_rc"
}

# -----------------------------------------------------------------------------
cmd_proxy() {
  have squid || { echo "koi-net-setup: squid not installed" >&2; exit 127; }
  mkdir -p "${KOI_SQUID_DIR}"
  local node_bin conf
  node_bin="${KOI_NODE_BIN:-$(command -v node)}"
  conf="${KOI_SQUID_DIR}/koi-squid.conf"
  sed -e "s#@PORT@#${KOI_PROXY_PORT}#g" \
      -e "s#@HELPER@#${SELF_DIR}/koi-net-acl.mjs#g" \
      -e "s#@NODE@#${node_bin}#g" \
      -e "s#@POLICY@#${KOI_NETWORK_POLICY}#g" \
      -e "s#@SOCK@#${KOI_NETWORK_SOCK}#g" \
      -e "s#@CACHEDIR@#${KOI_SQUID_DIR}#g" \
      "${SELF_DIR}/koi-squid.conf.template" > "${conf}"

  # Squid names its POSIX shared-memory segments /<service-name>-<id>.shm. The
  # default service name is "squid", so a user-level squid collides head-on
  # with a distro squid.service running as another user — it cannot create the
  # segment and it cannot unlink one it does not own:
  #   FATAL: ... shm_open(/squid-cf__metadata.shm): (17) File exists
  # `-n` moves us into our own namespace. It is documented as a Windows service
  # option on older squids, so probe it rather than assume; the probe doubles
  # as config validation, which turns a fatal start into a readable message.
  # Validate the generated config first, so a bad directive is a readable
  # message here rather than a FATAL from a service that then restart-loops.
  if ! squid -k parse -f "${conf}" >/dev/null 2>&1; then
    echo "koi-net-setup: squid rejected ${conf}:" >&2
    squid -k parse -f "${conf}" >&2 || true
    exit 1
  fi

  local nflag=()
  if squid_supports_n; then
    nflag=(-n "${KOI_SQUID_SERVICE}")
  elif pgrep -x squid >/dev/null 2>&1; then
    # Without -n we can only use /squid-*.shm, which the running squid owns and
    # we (as an ordinary user) can neither create over nor unlink. Starting
    # anyway just produces a FATAL every RestartSec forever, which is how this
    # reached "restart counter is at 40" while saying nothing useful.
    echo "koi-net-setup: this squid does not accept -n, and another squid is already" >&2
    echo "  running and owns the default shared-memory namespace (/squid-*.shm)." >&2
    echo "  Refusing to start into a crash loop. Either:" >&2
    echo "    sudo systemctl disable --now squid   # free the namespace" >&2
    echo "  or upgrade squid to a version that supports -n." >&2
    exit 1
  else
    echo "koi-net-setup: this squid does not accept -n; using the default shm namespace." >&2
  fi

  # Our own stale segments, from a crash or a SIGKILL. Scoped to our service
  # name so this can never delete a running squid's memory.
  rm -f "/dev/shm/${KOI_SQUID_SERVICE}-"*.shm 2>/dev/null || true

  exec squid -N "${nflag[@]}" -f "${conf}"
}

# -----------------------------------------------------------------------------
# Runs INSIDE the namespace, as the first thing bwrap execs.
cmd_confine() {
  # Strip the leading `--`
  [ "${1:-}" = "--" ] && shift

  # pasta maps the host at the namespace's default gateway. Resolve it rather
  # than hardcoding 10.0.2.2 (pasta and slirp4netns disagree, and --no-map-gw
  # changes it again).
  local gw
  gw="${KOI_PROXY_HOST:-$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')}"

  if [ -z "${gw}" ]; then
    echo "koi-sandbox: no route out of the network namespace; egress is closed." >&2
  elif command -v nft >/dev/null 2>&1; then
    # CAP_NET_ADMIN inside the user namespace is enough for this — no host root.
    # If it fails we do NOT continue: a sandbox that believes it is filtered but
    # is not is worse than one that refuses to run.
    nft -f - <<NFT || { echo "koi-sandbox: could not install egress filter; refusing to run unfiltered." >&2; exit 78; }
table inet koi {
  chain output {
    type filter hook output priority 0; policy drop;
    ct state established,related accept
    oif "lo" accept
    ip daddr ${gw} tcp dport ${KOI_PROXY_PORT} accept
    reject with icmpx type admin-prohibited
  }
}
NFT
    export HTTP_PROXY="http://${gw}:${KOI_PROXY_PORT}"
    export HTTPS_PROXY="${HTTP_PROXY}"
    export http_proxy="${HTTP_PROXY}"
    export https_proxy="${HTTP_PROXY}"
    export NO_PROXY="127.0.0.1,localhost"
    export no_proxy="${NO_PROXY}"
  else
    echo "koi-sandbox: nft missing; refusing to run unfiltered." >&2
    exit 78
  fi

  # DROP CAP_NET_ADMIN BEFORE THE PAYLOAD RUNS.
  #
  # Everything above is undone by `nft flush ruleset` if the confined command
  # keeps the capability that installed it. Inside the user namespace it has
  # the full set (CapEff 000001ffffffffff), so this was one command from
  # unfiltered egress:
  #     nft flush ruleset && exec 3<>/dev/tcp/1.1.1.1/443
  # The allowlist, the approval dialog and the metadata denials all sit on top
  # of a filter the payload owned. The rules must outlive the privilege that
  # created them.
  #
  # NET_RAW goes too: it is what makes raw sockets (ping, hand-rolled packets)
  # possible, and nothing in a build needs it.
  #
  # Both the bounding set AND the inheritable set are cleared, so the drop
  # survives exec of a file with capabilities set on it. This costs nothing —
  # the proxy path is unaffected, since talking to it is an ordinary TCP
  # connection.
  drop_caps_exec() {
    if command -v setpriv >/dev/null 2>&1; then
      exec setpriv --bounding-set -net_admin,-net_raw --inh-caps -net_admin,-net_raw "$@"
    elif command -v capsh >/dev/null 2>&1; then
      # capsh takes a shell command string, not an argv, so the payload is
      # re-quoted. "$@" here is always: <shell> -c <script>
      local quoted
      quoted="$(printf '%q ' "$@")"
      exec capsh --drop=cap_net_admin,cap_net_raw -- -c "exec ${quoted}"
    fi
    # Same posture as a failed filter install: a sandbox that believes it is
    # confined but is not is worse than one that refuses to run.
    echo "koi-sandbox: neither setpriv (util-linux) nor capsh (libcap2-bin) is" >&2
    echo "  available, so CAP_NET_ADMIN cannot be dropped and the egress filter" >&2
    echo "  would be removable by the sandboxed command itself. Refusing to run." >&2
    echo "  Install one of them:  sudo apt install util-linux   # or libcap2-bin" >&2
    exit 78
  }

  drop_caps_exec "$@"
}

# -----------------------------------------------------------------------------
case "${1:-}" in
  preflight) shift; cmd_preflight "$@" ;;
  free-port) shift; cmd_free_port "$@" ;;
  proxy)     shift; cmd_proxy "$@" ;;
  confine)   shift; cmd_confine "$@" ;;
  *)
    cat >&2 <<USAGE
usage: koi-net-setup.sh <preflight|proxy|confine -- <cmd>>
  preflight   check pasta/nft/squid availability (--running: proxy must be up)
  free-port   print the first free port at or above KOI_PROXY_PORT
  proxy       run the egress proxy in the foreground
  confine     in-namespace entrypoint: install nft egress filter, exec <cmd>
USAGE
    exit 2 ;;
esac
