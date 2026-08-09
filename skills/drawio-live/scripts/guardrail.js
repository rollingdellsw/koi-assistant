// scripts/guardrail.js — Second line of defence for the sync/edit ordering.
//
// The sync-before-edit gate itself lives in the MCP server (`state.turnSynced`,
// armed by `drawio_begin_turn` from the pre-send hook). That is the enforceable
// place: it is the same module that performs the mutation, so it cannot be
// routed around. This guardrail deliberately does NOT mirror that flag — the
// previous version kept its own `syncedThisTurn` boolean that was set on the
// first drawio_sync and never reset, so from the second turn onwards it allowed
// everything and enforced nothing.
//
// What the guardrail can enforce with only local information is the drift
// recovery loop: once drawio_ops/drawio_apply reports `status: "drifted"`, the
// canvas moved under us and every further edit must wait for a fresh
// drawio_sync. That is a pure state machine over the tool stream, with no
// notion of turn boundaries, so it stays correct for the whole session.

// Guardrail scope, honestly bounded. It cannot see turn boundaries and it
// cannot see MCP module state, so it only enforces what is derivable from the
// tool stream itself:
//
//   1. drift recovery   — a pure state machine, correct for the whole session.
//   2. re-init          — SKILL.md says "never call drawio_init again"; the
//                         model does anyway, and a re-init wipes turn history.
//   3. screenshot budget— an image is ~1.2k tokens and permanent in context.
//                         Two per turn is the documented ceiling (one check +
//                         one fix round). This counts takeScreenshot, which is
//                         now the only vision channel — drawio_render returns
//                         SVG text, and a tool result cannot carry an image.
//
// Lint escalation USED to live here and no longer does. It now ships as a
// `lintDirective` field from the MCP itself, for two reasons. Overriding a
// successful result spent the engine's 3-retry allowance on a push that had
// worked; and this file can be a stale build — the loader reports "Script from
// 'drawio-live' already loaded, skipping" and keeps the previous session's
// copy — so the one message that decides whether the model reaches for the
// cheap fix or the expensive one was riding on the least reliable artifact in
// the system. The module that computes the warnings now writes the directive.
//
// drawio_sync is the only reliable turn marker available here: the MCP refuses
// every edit until it has been called, so exactly one sync opens each editing
// turn. Per-turn counters reset there.

let needsResync = false; // set on drift, cleared by a successful sync
let attached = false; // a canvas is bound to this session
let rendersThisTurn = 0;

const RENDER_BUDGET = 2;

function parseResult(ctx) {
  try {
    const raw = ctx.result && ctx.result.content;
    if (typeof raw === "string") return JSON.parse(raw);
    if (Array.isArray(raw) && raw[0] && raw[0].text) return JSON.parse(raw[0].text);
    return raw;
  } catch (_) {
    return null;
  }
}

module.exports = {
  input: async (ctx) => {
    // Note on drawio_arrange: it is NOT blocked here. Whether a re-layout is
    // wanted is a judgement about the user's intent, and a guardrail that
    // cannot see the conversation is the wrong place to make it. The tool
    // description carries the warning; the model and the user decide.
    // Defensive: the sandbox validates a guardrail by dry-running both hooks
    // against a dummy context. Throwing there means the script is rejected and
    // never activated at all, so nothing here may assume a field exists.
    const tool = (ctx && ctx.tool && ctx.tool.name) || "";
    const args = (ctx && ctx.tool && ctx.tool.args) || {};

    if (needsResync && (tool === "drawio_ops" || tool === "drawio_apply")) {
      return {
        allowed: false,
        message:
          "The canvas was edited by the user during your turn, so your editing " +
          "base is stale. Call drawio_sync() to re-base, review the returned " +
          "userDiff, then re-issue " + tool + " against the new state.",
      };
    }

    // Re-initializing an attached canvas resets base, history and the turn
    // counter for no benefit, and mode:"replace" can destroy the user's work.
    // Loading a specific document (xml supplied) stays allowed — that is the
    // one legitimate case SKILL.md carves out.
    // mode:"adopt" is exempt: that is exactly what scripts/run.js issues when
    // the user re-runs the skill after closing the tab, and blocking it would
    // break the documented recovery path.
    if (tool === "drawio_init" && attached && !args.xml && args.mode !== "adopt") {
      return {
        allowed: false,
        message:
          "A canvas is already attached to this session. drawio_init is not the " +
          "turn opener and re-initializing discards turn history.",
        suggestion:
          "Call drawio_sync() to pick up the current canvas state. Only call " +
          "drawio_init with an explicit xml argument, and only when the user " +
          "asked you to load a specific diagram.",
      };
    }

    // Screenshots are budgeted, but the budget must not be the thing that stops
    // the model from looking at its own work — vision is how it decides whether
    // a layout is good, and the failure mode this skill actually exhibits is
    // never looking, not looking too often. The budget exists only because an
    // image stays in context for the rest of the conversation.
    //
    // takeScreenshot is the only vision channel: drawio_render is SVG text now,
    // because a tool result cannot carry an image at all.
    if (tool === "takeScreenshot" && rendersThisTurn >= RENDER_BUDGET) {
      return {
        allowed: false,
        message:
          "Screenshot budget for this turn is spent (" + RENDER_BUDGET +
          "). Each image stays in context for the rest of the conversation.",
        suggestion:
          "drawio_render({format:'svg'}) is not budgeted and carries the exact " +
          "routed geometry — including where edge labels landed, which is what " +
          "you most likely wanted a second look at. The `lint` array reports " +
          "overlaps, crossings and edges-through-shapes for free.",
      };
    }
    if (tool === "takeScreenshot") rendersThisTurn++;

    return { allowed: true };
  },

  output: async (ctx) => {
    const tool = (ctx && ctx.tool && ctx.tool.name) || "";

    if (tool === "drawio_init") {
      const result = parseResult(ctx);
      if (result && result.success) attached = true;
      return { override: false };
    }

    // A successful sync re-bases us; drift is cleared. It is also the turn
    // marker — the MCP blocks every edit until it has been called, so exactly
    // one sync opens each editing turn.
    if (tool === "drawio_sync") {
      const result = parseResult(ctx);
      if (result && !result.error) {
        needsResync = false;
        attached = true;
        rendersThisTurn = 0;
      }
      return { override: false };
    }

    // Drift is reported by the *editing* tools, not by sync — the old code
    // looked for it on drawio_sync, where it can never appear.
    if (tool === "drawio_ops" || tool === "drawio_apply") {
      const result = parseResult(ctx);
      if (!result) return { override: false };

      if (result.status === "drifted") needsResync = true;
    }

    return { override: false };
  },
};
