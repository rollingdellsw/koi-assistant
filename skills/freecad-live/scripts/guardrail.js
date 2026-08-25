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
  // Both run through the same envelope as freecad_call -- they are writes
  // that happen to be spelled as their own tool -- so they carry `applied`,
  // guiSync and lint, and they carry the two verdicts most likely to be
  // skimmed past: an operation that generated no toolpath, and a solve whose
  // peak stress is a property of the mesh rather than of the part.
  "freecad_cam",
  "freecad_fem",
  // Probe-stage only (probe-exec: on). Still runs inside the envelope, so it
  // still reports guiSync and lint and is still worth hoisting.
  "freecad_edit",
  // freecad_exec is deliberately NOT here: it runs OUTSIDE the envelope, so
  // its result carries no `applied` and envelopeOf() could never match it.
]);

// Read-only tools whose reply is a REPORT rather than an envelope: no
// `applied`, no lint, no undo. They still carry a verdict that decides whether
// a part is fit to hand to anybody, so they are hoisted through the same
// single field -- just without the applied gate.
const REPORT_TOOLS = new Set(["freecad_dfm"]);

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
  /^(removed-nothing|removed-at-profile|split-stale|fem-stale|fem-target-gone|non-stock|thread-engagement|modelled-thread|added-nothing|empty-intersection)/;

// Where a finding actually sits.
//
// This is the bug that made half of the branches below dead code. The envelope
// puts the op's own return value under `result`, so guiSync, lint, refsBroken
// and undoEntries are top-level while bindingNote, constraintsLost, notDrawn
// and every cam or fem verdict are one or two levels down. Reading only the
// top level meant the loudest hoists in this file never fired once.
function roots(env) {
  const out = [env];
  const r = env && env.result;
  if (r && typeof r === "object" && !Array.isArray(r)) {
    out.push(r);
    // cam mode 'op' reports under `operation`; fem reports the stress field
    // under `field`. One more level, named rather than walked: a generic deep
    // scan would start matching the word "stale" inside prose.
    for (const k of ["operation", "field", "refined"]) {
      const v = r[k];
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v);
    }
  }
  return out;
}

function pick(env, key) {
  for (const r of roots(env)) {
    if (r && Object.prototype.hasOwnProperty.call(r, key)) return r[key];
  }
  return undefined;
}

function findings(env) {
  const out = [];
  const push = (what) => {
    if (out.indexOf(what) === -1) out.push(what);
  };
  const at = (k) => pick(env, k);

  for (const code of lintCodes(env)) {
    if (LOUD_LINT.test(code)) {
      push(
        "lint:" + code + " — the document recomputes clean and the edit is " +
        "still wrong. Believe the lint over the state flags and over the " +
        "render, and fix it before building anything on top of it."
      );
    }
  }

  if (at("bindingNote")) {
    push(
      "bindingNote — at least one dimension stayed a LITERAL and will not " +
      "follow the parameter. Do not report this as parametric."
    );
  }
  if (at("bindingVerified") === false) {
    push(
      "bindingVerified:false — the positions are literals, so a swap will " +
      "not move them. Say so instead of reporting a parametric pattern."
    );
  }
  if (at("constraintsLost")) {
    push(
      "constraintsLost:" + at("constraintsLost") + " — deleting geometry also " +
      "deleted the constraints that used it. The sketch still solves, at the " +
      "wrong shape."
    );
  }
  if (at("rehealedExternal")) {
    push(
      "rehealedExternal — a projection's reference moved and was re-derived. " +
      "Compare the constraint count before and after; if constraints were " +
      "lost, the sketch is the wrong shape until somebody looks at it."
    );
  }
  if (at("rehealed")) {
    push(
      "rehealed — a stored query was re-run and the edges were RE-DERIVED, " +
      "not preserved. Check what the feature now touches before reporting it."
    );
  }
  if (Array.isArray(at("refsBroken")) && at("refsBroken").length) {
    push(
      "refsBroken:" + at("refsBroken").join(", ") + " — this edit broke a " +
      "reference the USER picked. Name it and ask them to re-pick. Do not " +
      "choose a replacement."
    );
  }
  if (Array.isArray(at("unregisteredObjects")) && at("unregisteredObjects").length) {
    push(
      "unregisteredObjects:" + at("unregisteredObjects").length + " — a script " +
      "created objects with no id. A later turn cannot address them and will " +
      "have to rebuild rather than edit. Register them: " +
      "koi.register(doc, '<id>', obj)."
    );
  }
  if (Array.isArray(at("notDrawn")) && at("notDrawn").length) {
    push(
      "notDrawn:" + at("notDrawn").join(", ") + " — these are NOT on screen, " +
      "whatever `already` or Visibility says. Do not describe what the model " +
      "looks like until they are drawn."
    );
  }
  if (at("singleUndo") === false) {
    push(
      "singleUndo:false — one Ctrl+Z will not put this back. Tell the user " +
      "the undo cost rather than letting them discover it."
    );
  }

  // ---- can it be made -----------------------------------------------------
  const mfg = at("manufacturable");
  if (mfg === false) {
    push(
      "manufacturable:false — this is a refusal, not a tolerance to " +
      "negotiate. Name the finding, say what it costs, and say what change " +
      "clears it before building anything else on the part."
    );
  } else if (mfg === null) {
    push(
      "manufacturable:null — a check did NOT run. Report it as unfinished. " +
      "A check that did not run is not a pass."
    );
  }
  const empties = at("emptyOperations");
  if (Array.isArray(empties) && empties.length) {
    push(
      "emptyOperations:" + empties.join(", ") + " — these generated ZERO " +
      "path commands. They recompute clean and show nothing on screen, and " +
      "they mean the workbench could not machine that feature with that " +
      "tool. Do not report the job as verified."
    );
  }
  if (at("machinable") === false) {
    push(
      "machinable:false — the CAM workbench could not cut this. Believe it " +
      "over the state flags and over any render."
    );
  }
  if (at("rapidsBelowClearance")) {
    push(
      "rapidsBelowClearance — a lateral G0 under the clearance height is a " +
      "rapid THROUGH stock. That G-code does not go to a machine."
    );
  }

  // ---- does it survive the load ------------------------------------------
  if (at("solved") === false) {
    push(
      "solved:false — the solver produced no readable field. Report a failed " +
      "solve; do not describe the part as passing."
    );
  }
  if (at("singularitySuspect") === true) {
    push(
      "singularitySuspect — the peak stress sits on a SHARP internal corner, " +
      "where the linear elastic stress is unbounded: refine the mesh and it " +
      "rises forever. That peak is a property of the mesh, not of the part. " +
      "Quote the p99 instead, say the peak was discarded and why, and offer " +
      "the fillet."
    );
  }
  if (at("solved") === true && at("converged") === null) {
    push(
      "converged:null — this was solved ONCE, so whether the answer depends " +
      "on the mesh is unknown. Report it as an unfinished check, the same " +
      "way manufacturable:null is reported, or run mode 'converge'."
    );
  }
  if (at("converged") === false) {
    push(
      "converged:false — the field moved between the two meshes, so the " +
      "number depends on the mesh. Quote it as an estimate or refine again."
    );
  }
  if (at("solved") === true && at("factorOfSafety") === null) {
    push(
      "factorOfSafety:null — this is a refusal with a reason attached, never " +
      "a pass. Say which reason: a singular peak, or a material whose yield " +
      "is not one number."
    );
  }
  if (at("yields") === true) {
    push(
      "yields — the peak von Mises stress EXCEEDS yield: the part yields " +
      "under the load as modelled. Say so plainly."
    );
  }
  if (at("displacementImplausible")) {
    push(
      "displacementImplausible — the deflection is a large fraction of the " +
      "part's own size, so this is outside the small-displacement assumption " +
      "the solve is built on. The usual cause is a MISSING RESTRAINT, not a " +
      "bendy part. Check the restraints before reading anything else."
    );
  }
  if (at("stale") === true) {
    push(
      "stale:true — the geometry changed after this was solved. These " +
      "numbers describe the OLD shape. Re-mesh and re-solve before " +
      "repeating any of them."
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

      const isKnown = (r) =>
        seenRefs.has(r) ||
        seenRefs.has(r.replace(/\./g, "_")) ||
        seenRefs.has(r.replace(/_/g, "."));

      const invented = [];
      for (const r of wanted) if (!isKnown(r)) invented.push(r);
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
        if (!echoed.has(r)) {
          seenRefs.add(r);
          if (r.includes("_")) seenRefs.add(r.replace(/_/g, "."));
          if (r.includes(".")) seenRefs.add(r.replace(/\./g, "_"));
        }
      }
    }

    if (ctx.result.isError) return { override: false };

    const tool = ctx.tool && ctx.tool.name;
    const isReport = REPORT_TOOLS.has(tool);
    if (!WRITE_TOOLS.has(tool) && !isReport) return { override: false };

    const res = parseResult(ctx);
    // A report tool has no envelope by design, so it is scanned as itself.
    const env = isReport
      ? (res && typeof res === "object" ? res : null)
      : envelopeOf(res);
    if (!env) return { override: false };

    // An aborted edit changed nothing, so a stale view is not a lie about it,
    // and its lint describes a document state that was rolled back.
    if (!isReport && env.applied !== true) return { override: false };

    const notes = findings(env);

    // guiSync is present ONLY when the refresh failed. Absent is healthy, and
    // a read-only report has no viewport claim to be stale about.
    if (!isReport && env.guiSync) {
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
    } else if (!isReport) {
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
