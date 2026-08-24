// scripts/guardrail.js — freecad-live policy hooks
//
// What a guardrail CANNOT do here, and why the version this replaces did not
// work: an output hook rewrites a tool result. It has no channel back into the
// bridge, so it cannot call Gui.updateGui(), cannot raise a window, and cannot
// refresh anything. The original file recorded the active document name into a
// module variable and returned {override:false} on every branch — the runtime
// log shows the hook firing on twenty-odd freecad_call results and doing
// nothing each time, which is exactly what it was written to do.
//
// The refresh belongs in the bridge, where the Gui object is, and is now
// _gui_sync() in the write envelope. What is left for a guardrail is the two
// jobs that genuinely are one:
//
//   OUTPUT — hoist. The envelope already reports guiSync, lint rows,
//   bindingNote, constraintsLost, notDrawn and the rest. All of them are
//   somewhere in a long JSON reply, and a model skimming it will happily
//   describe a viewport the human is not seeing, or report a pocket that
//   removed nothing as a clean edit. Lift them to one top-level field that
//   cannot be skimmed past, and keep count of the ones that mean the bridge
//   is broken rather than the edit.
//
//   INPUT — the one rule in SKILL.md that is checkable without the document:
//   an element reference (Object:Face6, Object:Edge3) that this side authored
//   is banned, because a recompute renumbers it. A ref that came back from
//   query, from fn 'ref', or from the user's own selection has been seen in a
//   tool RESULT; one the model typed from memory has not. That is a set
//   membership test, so it can be a gate rather than a paragraph of prose.
//
// Two engine constraints this file is written against:
//   * Skill-scoped output hooks time out at 5 s and always fail open. Nothing
//     here does I/O; every branch is a regex over a string already in memory.
//   * The engine ignores an override after 3 CONSECUTIVE overrides for the
//     same tool. So this returns at most ONE override per result — every
//     finding goes into a single koiReport field — and a clean result resets
//     that counter by returning {override:false}.

const STALE_NOTE =
  "STALE VIEWPORT: this edit is in the document, but FreeCAD's 3D view was " +
  "not refreshed, so the window the human is watching may still show the " +
  "model as it was BEFORE this change. Do not describe what is on screen. " +
  "Describe the change from this reply, and use freecad_render for a picture " +
  "that is definitely current.";

// Per-session, reset when the skill is re-injected. Two in a row is a bridge
// that has lost its GUI rather than one unlucky repaint, and that is worth
// saying once loudly instead of once per call.
let staleRun = 0;

// Element references this session has SEEN in a tool result — from query, from
// fn 'ref', from the user's selection in sync, from a measure or a get. Refs
// that merely appear in a call's own arguments are stripped before anything
// lands here, so a reference cannot be laundered into the set by passing it to
// a read call and reading it back out.
const seenRefs = new Set();

const WRITE_TOOLS = new Set([
  "freecad_call",
  "freecad_script",
  // Probe-stage only (probe-exec: on). Still runs inside the envelope, so it
  // still reports guiSync and lint and is still worth hoisting.
  "freecad_edit",
  // freecad_exec is deliberately NOT here: it runs OUTSIDE the envelope, so
  // its result carries no `applied` and envelopeOf() could never match it.
]);

// Results worth harvesting refs from. freecad_resolve is included only when
// the caller asked for the user's selection: its `refs` argument is documented
// as a way to INSPECT a fingerprint before committing to it, and harvesting
// that reply would turn the inspection path into the laundering path.
function harvestable(ctx) {
  const tool = ctx.tool && ctx.tool.name;
  if (tool === "freecad_resolve") {
    return !!(ctx.tool.args && ctx.tool.args.selection);
  }
  return (
    tool === "freecad_call" ||
    tool === "freecad_sync" ||
    tool === "freecad_get" ||
    tool === "freecad_measure"
  );
}

// Object:Face6, Pad001:Edge3, body.cover:Vertex2. The object half is
// deliberately permissive (koi ids carry dots) and the element half is not.
const ELEMENT_REF = /\b[A-Za-z_][A-Za-z0-9_.-]*:(?:Face|Edge|Vertex)\d+\b/g;

function refsIn(text) {
  const out = new Set();
  if (typeof text !== "string" || !text) return out;
  ELEMENT_REF.lastIndex = 0;
  let m;
  let guard = 0;
  while ((m = ELEMENT_REF.exec(text)) !== null && guard++ < 4096) out.add(m[0]);
  return out;
}

function rawText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content[0] && typeof content[0].text === "string") {
    return content[0].text;
  }
  try {
    return JSON.stringify(content);
  } catch (_) {
    return "";
  }
}

function parseResult(ctx) {
  const raw = ctx && ctx.result && ctx.result.content;
  try {
    if (typeof raw === "string") return JSON.parse(raw);
    if (Array.isArray(raw) && raw[0] && typeof raw[0].text === "string") {
      return JSON.parse(raw[0].text);
    }
  } catch (_) {
    return null;
  }
  return raw && typeof raw === "object" ? raw : null;
}

// The envelope is the whole reply for freecad_call and is nested for the
// script paths. Look in both rather than assuming: guessing wrong here fails
// silently, which is the failure mode this file exists to stop repeating.
function envelopeOf(res) {
  if (!res || typeof res !== "object") return null;
  for (const cand of [res, res.envelope, res.result]) {
    if (cand && typeof cand === "object" && "applied" in cand) return cand;
  }
  return null;
}

function reserialize(ctx, res) {
  const raw = ctx.result.content;
  const text = JSON.stringify(res);
  if (typeof raw === "string") return { ...ctx.result, content: text };
  if (Array.isArray(raw) && raw[0]) {
    return { ...ctx.result, content: [{ ...raw[0], text }, ...raw.slice(1)] };
  }
  return { ...ctx.result, content: res };
}

// ---------------------------------------------------------------------------
// The silent failures: every one of these recomputes clean, reports
// Up-to-date and isValid(), and is invisible in a screenshot. They are the
// reason this skill measures instead of trusting, and they are also the rows
// most likely to be skimmed past in a 4 KB reply.

function lintCodes(env) {
  const rows = Array.isArray(env.lint) ? env.lint : [];
  const out = [];
  for (const r of rows.slice(0, 200)) {
    const code = r && (r.code || r.rule || r.id);
    if (typeof code === "string") out.push(code);
  }
  return out;
}

const LOUD_LINT =
  /^(removed-nothing|removed-at-profile|split-stale|non-stock|thread-engagement|modelled-thread|added-nothing|empty-intersection)/;

function findings(env) {
  const out = [];
  const push = (what) => {
    if (out.indexOf(what) === -1) out.push(what);
  };

  for (const code of lintCodes(env)) {
    if (LOUD_LINT.test(code)) {
      push(
        "lint:" + code + " — the document recomputes clean and the edit is " +
        "still wrong. Believe the lint over the state flags and over the " +
        "render, and fix it before building anything on top of it."
      );
    }
  }

  if (env.bindingNote) {
    push(
      "bindingNote — at least one dimension stayed a LITERAL and will not " +
      "follow the parameter. Do not report this as parametric."
    );
  }
  if (env.bindingVerified === false) {
    push(
      "bindingVerified:false — the positions are literals, so a swap will " +
      "not move them. Say so instead of reporting a parametric pattern."
    );
  }
  if (env.constraintsLost) {
    push(
      "constraintsLost:" + env.constraintsLost + " — deleting geometry also " +
      "deleted the constraints that used it. The sketch still solves, at the " +
      "wrong shape."
    );
  }
  if (env.rehealedExternal) {
    push(
      "rehealedExternal — a projection's reference moved and was re-derived. " +
      "Compare the constraint count before and after; if constraints were " +
      "lost, the sketch is the wrong shape until somebody looks at it."
    );
  }
  if (env.rehealed) {
    push(
      "rehealed — a stored query was re-run and the edges were RE-DERIVED, " +
      "not preserved. Check what the feature now touches before reporting it."
    );
  }
  if (Array.isArray(env.refsBroken) && env.refsBroken.length) {
    push(
      "refsBroken:" + env.refsBroken.join(", ") + " — this edit broke a " +
      "reference the USER picked. Name it and ask them to re-pick. Do not " +
      "choose a replacement."
    );
  }
  if (Array.isArray(env.unregisteredObjects) && env.unregisteredObjects.length) {
    push(
      "unregisteredObjects:" + env.unregisteredObjects.length + " — a script " +
      "created objects with no id. A later turn cannot address them and will " +
      "have to rebuild rather than edit. Register them: " +
      "koi.register(doc, '<id>', obj)."
    );
  }
  if (Array.isArray(env.notDrawn) && env.notDrawn.length) {
    push(
      "notDrawn:" + env.notDrawn.join(", ") + " — these are NOT on screen, " +
      "whatever `already` or Visibility says. Do not describe what the model " +
      "looks like until they are drawn."
    );
  }
  if (env.singleUndo === false) {
    push(
      "singleUndo:false — one Ctrl+Z will not put this back. Tell the user " +
      "the undo cost rather than letting them discover it."
    );
  }

  return out;
}

// ---------------------------------------------------------------------------

module.exports = {
  // The banned-reference gate. A face or edge index the model authored is the
  // one failure the skill cannot detect after the fact: it attaches the next
  // feature to the wrong element and recomputes perfectly.
  input: async (ctx) => {
    try {
      if (!ctx || !ctx.tool || ctx.tool.name !== "freecad_call") {
        return { allowed: true };
      }
      const args = ctx.tool.args || {};
      // fn 'ref' is the documented path for "the user named Face3". Capturing
      // it yields an id, and ids are not element references, so nothing
      // downstream needs the raw index again.
      if (String(args.fn || "") === "ref") return { allowed: true };

      let text = "";
      try {
        text = JSON.stringify(args);
      } catch (_) {
        return { allowed: true };
      }
      const wanted = refsIn(text);
      if (!wanted.size) return { allowed: true };

      const invented = [];
      for (const r of wanted) if (!seenRefs.has(r)) invented.push(r);
      if (!invented.length) return { allowed: true };

      return {
        allowed: false,
        message:
          "Blocked: " + invented.join(", ") + " " +
          (invented.length === 1 ? "was" : "were") + " not returned by " +
          "anything this session read. FaceN and EdgeN are INDICES, not " +
          "names — a recompute renumbers them, so an index authored on this " +
          "side attaches the next feature to the wrong element and then " +
          "recomputes clean.",
        suggestion:
          "Select it geometrically: freecad_call({fn:'query', args:{of:" +
          "'<object>', kind:'face'|'edge', surface:..., normal:..., " +
          "expect:'many' if the plural is deliberate}}) and hand the " +
          "returned `refs` array straight to fillet/chamfer/shell/draft/" +
          "bind/measure_between. Or ask the human to click it and capture " +
          "it with freecad_call({fn:'ref', args:{from:'selection'}, " +
          "id:'pick.x'}). To inspect a reference without committing to it, " +
          "freecad_resolve({refs:[...]}) is read-only and is not gated.",
      };
    } catch (_) {
      // Fail open. A buggy gate must never stand between the human and their
      // own document — and skill-scoped hooks fail open regardless.
      return { allowed: true };
    }
  },

  output: async (ctx) => {
    if (!ctx || !ctx.result) return { override: false };

    // Harvest first, and from successes only: an error message can echo the
    // very argument that was rejected, which would legitimise it.
    if (!ctx.result.isError && harvestable(ctx)) {
      let echoed = new Set();
      try {
        echoed = refsIn(JSON.stringify((ctx.tool && ctx.tool.args) || {}));
      } catch (_) {}
      for (const r of refsIn(rawText(ctx.result.content))) {
        if (!echoed.has(r)) seenRefs.add(r);
      }
    }

    if (ctx.result.isError) return { override: false };

    const tool = ctx.tool && ctx.tool.name;
    if (!WRITE_TOOLS.has(tool)) return { override: false };

    const res = parseResult(ctx);
    const env = envelopeOf(res);
    if (!env) return { override: false };

    // An aborted edit changed nothing, so a stale view is not a lie about it,
    // and its lint describes a document state that was rolled back.
    if (env.applied !== true) return { override: false };

    const notes = findings(env);

    // guiSync is present ONLY when the refresh failed. Absent is healthy.
    if (env.guiSync) {
      staleRun += 1;
      env.guiStale = true;
      env.guiStaleNote = STALE_NOTE;
      notes.unshift(STALE_NOTE);
      if (staleRun >= 2) {
        env.guiStaleRun = staleRun;
        env.guiStaleEscalation =
          staleRun +
          " writes in a row failed to refresh the viewport. That is the " +
          "bridge's GUI connection, not one unlucky repaint. Tell the user " +
          "their FreeCAD window is not tracking the model, and stop " +
          "referring to the stream at all until it recovers.";
        notes.unshift(env.guiStaleEscalation);
      }
    } else {
      staleRun = 0;
    }

    if (!notes.length) return { override: false };

    // One override per result: the engine drops the fourth consecutive one
    // for a given tool, so everything found goes into a single field rather
    // than spending that budget three findings at a time.
    env.koiReport = notes;
    env.koiReportNote =
      "MUST REPORT: " + notes.length + " finding(s) above. Each is a " +
      "condition that recomputes clean and is invisible in a render. Address " +
      "them, or say what they mean to the user, before continuing.";

    return { override: true, result: reserialize(ctx, res) };
  },
};
