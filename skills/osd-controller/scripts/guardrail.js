// skills/osd-controller/scripts/guardrail.js
//
// Three policies:
//   1. Capture OSD through createWorkspace, not takeScreenshot — the workspace
//      is what the annotation tools operate on.
//   2. Never annotate a workspace that was captured before focus last moved.
//      osd_focus swaps which image is on screen, so an older workspace shows a
//      different slide than the one the agent is now navigating.
//   3. Minimize the visual workspace before next zoom/pan navigation — an open
//      workspace overlay blocks the viewer and intercepts mouse/navigation events.
//
// STATE IS DERIVED FROM ctx.history, NOT CARRIED IN A CLOSURE.
//
// This module is compiled once and cached by the sidepanel sandbox
// (public/sandbox-impl.js `guardrailModuleCache`, keyed by a hash of this
// source), so any module-level `let`/closure survives across calls. The host
// only resets that cache when the SESSION switches — a brand-new CONVERSATION
// within the same session reuses the cached module. A closure that tracked
// "is a workspace open" therefore leaked: the last capture of the previous
// conversation left it "open", and the first osd_reset of the new one was
// blocked even though no overlay was actually on screen.
//
// ctx.history is rebuilt fresh from the real conversation on every guardrail
// call, so re-deriving state from it is authoritative per conversation. We
// keep the derived flags as module vars only for the (cheap) incremental
// recompute; they are re-synced from history whenever history changes, so a
// stale value from a prior conversation cannot survive.

const NAV_TOOLS = new Set([
  "osd_zoom",
  "osd_pan",
  "osd_zoom_to_region",
  "osd_reset",
]);

// ---- history helpers -------------------------------------------------------

function isErrorResult(result) {
  return Boolean(result && result.isError);
}
// A tool-call's result message may carry its error either as a structured
// `isError` flag (present on some backends) or as an error envelope in the
// message text (e.g. {"error": "..."}, which is what the MCP tools emit).
function toolResultIsError(r) {
  if (!r || r.role !== "tool") return false;
  if (r.isError === true) return true;
  const c = typeof r.content === "string" ? r.content : "";
  if (c.indexOf('"isError":true') !== -1 || c.indexOf('"isError": true') !== -1) return true;
  const t = c.trim();
  if (t.charAt(0) === "{") {
    try {
      const o = JSON.parse(t);
      if (o && (o.error || o.__error)) return true;
    } catch (e) {
      /* not JSON — not an error envelope */
    }
  }
  return false;
}
function parseArgs(a) {
  if (typeof a === "string") {
    try {
      return JSON.parse(a);
    } catch (e) {
      return {};
    }
  }
  return a || {};
}
function callName(call) {
  const c = (call && call.function && call.function.name) || "";
  if (c) return c;
  return call && call.name ? call.name : "";
}
function lastUserMessage(history) {
  const msgs = (history && history.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "user") {
      return typeof m.content === "string" ? m.content : "";
    }
  }
  return (history && history.lastUserMessage) || "";
}

// Reconstruct the current conversation's workspace/focus state by replaying
// the tool calls. Deterministic: only counts the last user message onward, so
// a stale conversation's tail can never bleed into the current one.
function deriveState(history) {
  const msgs = (history && history.messages) || [];
  const lastUserIdx = (() => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === "user") return i;
    }
    return -1;
  })();
  const start = Math.max(0, lastUserIdx + 1);

  let open = false;
  let stale = false;
  for (let i = start; i < msgs.length; i++) {
    const tcs = msgs[i].tool_calls;
    if (!tcs || !tcs.length) continue;
    for (const call of tcs) {
      const name = callName(call);
      const args = parseArgs(call.function ? call.function.arguments : undefined);
      const r = msgs[i + 1];
      const err = toolResultIsError(r);
      if (name === "osd_focus" && !err) {
        stale = true;
      } else if (name === "createWorkspace" && !err) {
        stale = false;
        open = args.show_overlay !== false;
      } else if (name === "hideWorkspaceOverlay" && !err) {
        open = false;
      } else if (name === "showWorkspaceOverlay" && !err) {
        open = true;
      }
    }
  }
  return { open, stale };
}

// Derived, authoritative flags — always re-synced from history in input().
let state = { open: false, stale: false };

module.exports = {
  input: async (ctx) => {
    const toolName = (ctx && ctx.tool && ctx.tool.name) || "";

    // Re-sync state from this conversation's history on every input check, so
    // the derived flags can never be left stale by a prior conversation.
    if (ctx && ctx.history) {
      const s = deriveState(ctx.history);
      if (s.open !== state.open || s.stale !== state.stale) state = s;
    }

    if (toolName === "takeScreenshot" || toolName === "takeSnapshot") {
      return {
        allowed: false,
        message:
          "Do NOT use takeScreenshot. Use createWorkspace instead to initialize the visual analysis environment for OSD.",
      };
    }

    if (toolName === "addWorkspaceAnnotation" && state.stale) {
      return {
        allowed: false,
        message:
          "Focus moved to a different viewer after this workspace was captured, so it shows the previous image. Call osd_get_status to get the focused viewer's selector, then createWorkspace with it before annotating.",
      };
    }

    if (state.open && NAV_TOOLS.has(toolName)) {
      return {
        allowed: false,
        message:
          "A Visual Workspace overlay is currently open over the viewer. Minimize the visual workspace first using `hideWorkspaceOverlay` before performing zoom or pan navigation.",
      };
    }

    return { allowed: true };
  },

  // output() is a lightweight incremental fast path: it only updates the
  // module-level `state` so the next input() check is fast and correct between
  // history rebuilds. Correctness does NOT depend on it — input() re-syncs
  // from history whenever the conversation changes.
  output: async (ctx) => {
    const toolName = (ctx && ctx.tool && ctx.tool.name) || "";
    const err = isErrorResult(ctx && ctx.result);
    const args = (ctx && ctx.tool && ctx.tool.args) || {};

    if (toolName === "osd_focus" && !err) {
      state.stale = true;
    } else if (toolName === "createWorkspace" && !err) {
      state.stale = false;
      state.open = args.show_overlay !== false;
    } else if (toolName === "hideWorkspaceOverlay" && !err) {
      state.open = false;
    } else if (toolName === "showWorkspaceOverlay" && !err) {
      state.open = true;
    }
    return { override: false };
  },
};
