#!/usr/bin/env bash
#
# run-gateway.sh — launch the Koi Gateway (by hand or under systemd).
#
# systemd starts services with a minimal PATH that does NOT include a
# user-managed Node (fnm/nvm). The gateway both *is* Node and *spawns* `node`
# (the sandbox server) and `npm` (the lsp_search autoBuild), so we resolve a
# Node binary, put its directory on PATH, then exec the gateway from its own
# directory (the config uses relative paths like ./sandbox-shell-mcp.mjs).
#
# Override Node resolution by setting KOI_NODE_BIN=/abs/path/to/node.

set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

find_node() {
  # 1) explicit override
  if [ -n "${KOI_NODE_BIN:-}" ] && [ -x "${KOI_NODE_BIN}" ]; then
    printf '%s\n' "${KOI_NODE_BIN}"; return 0
  fi
  # 2) already on PATH (e.g. launched from a login shell)
  if command -v node >/dev/null 2>&1; then
    command -v node; return 0
  fi
  # 3) fnm default alias
  local fnm_dir="${FNM_DIR:-$HOME/.local/share/fnm}"
  if [ -x "${fnm_dir}/aliases/default/bin/node" ]; then
    printf '%s\n' "${fnm_dir}/aliases/default/bin/node"; return 0
  fi
  # 4) nvm — highest installed version
  local nvm_node
  nvm_node="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "${nvm_node}" ] && [ -x "${nvm_node}" ]; then
    printf '%s\n' "${nvm_node}"; return 0
  fi
  # 5) system
  local c
  for c in /usr/local/bin/node /usr/bin/node; do
    [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

NODE_BIN="$(find_node)" || {
  echo "run-gateway: could not locate a node binary." >&2
  echo "  Set KOI_NODE_BIN=\$(readlink -f \"\$(which node)\") in the systemd unit." >&2
  exit 127
}

# Put node/npm on PATH so the gateway can spawn `node ./sandbox-shell-mcp.mjs`
# and run the lsp_search autoBuild (`npm install && npm run build`).
export PATH="$(dirname "$NODE_BIN"):$PATH"

exec "$NODE_BIN" koi-gateway.js --config gateway-config.json "$@"
