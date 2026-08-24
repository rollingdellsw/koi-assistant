// scripts/test_ops3.js — loft, subtractive_loft, pipe (sweep), subtractive_pipe, draft.
//
// Tests the 3D solid modeling extensions that complete the core CAD feature set:
//   1. loft (PartDesign::AdditiveLoft) — multi-section solid transitions
//   2. subtractive_loft (PartDesign::SubtractiveLoft) — multi-section cuts
//   3. pipe / sweep (PartDesign::AdditivePipe) — trajectory sweeps along 3D paths
//   4. subtractive_pipe / subtractive_sweep (PartDesign::SubtractivePipe) — path cuts
//   5. draft (PartDesign::Draft) — mold release taper angles on faces
//
// Follows the same two core rules as test_ops.js and test_ops2.js:
//   1. Ground truth in the document via probe() and exact closed-form math.
//   2. Refusal path verification for every gate.
//
// Two things this file deliberately does NOT do, because the first draft did
// and both were the test lying rather than the code failing:
//   - It does not slice the first four faces off a query. Face order is not a
//     fact about the part, and a slice that happens to include the bottom
//     face drafts the neutral plane. Each side face is resolved BY DIRECTION.
//   - It does not assume which way a draft pulls. The op reports taper, and
//     the expected frustum is chosen from what the document did.

const results = [];
let pass = 0;
let fail = 0;
let warn = 0;

class TransportLost extends Error {}

function assert(label, condition, detail) {
  if (condition) {
    pass++;
    results.push("✅ " + label);
    console.log("✅ " + label);
  } else {
    fail++;
    const msg = "❌ " + label + (detail ? " — " + detail : "");
    results.push(msg);
    console.error(msg);
  }
  return !!condition;
}

function note(label, detail) {
  warn++;
  const msg = "⚠️ " + label + (detail ? " — " + detail : "");
  results.push(msg);
  console.warn(msg);
}

function isTransportError(msg) {
  const s = String(msg || "");
  return (
    s.indexOf("BROWSER_BRIDGE_UNAVAILABLE") !== -1 ||
    s.indexOf("did not respond within") !== -1 ||
    s.indexOf("executeBrowserTool timeout") !== -1
  );
}

function parseResult(res) {
  if (!res) return null;
  if (res.isError) {
    const text = res.content && res.content[0] && res.content[0].text;
    try {
      return Object.assign({ __error: true }, JSON.parse(text));
    } catch (_) {
      return { __error: true, error: text || "unknown error" };
    }
  }
  try {
    const text = res.content ? res.content[0].text : JSON.stringify(res);
    return JSON.parse(text);
  } catch (_) {
    return res;
  }
}

function guard(r) {
  const msg = r && r.error;
  if (isTransportError(msg)) throw new TransportLost(String(msg));
  return r;
}

async function call(fn, opArgs, id, extra) {
  return guard(
    parseResult(
      await tools.freecad_call(
        Object.assign({ fn, args: opArgs || {} }, id ? { id } : {}, extra || {})
      )
    )
  );
}

async function sync(extra) {
  return guard(parseResult(await tools.freecad_sync(extra || {})));
}

// eslint-disable-next-line no-unused-vars -- kept so a bisecting run can drop
// a sync() in without re-deriving the parse/guard chain.
void sync;

async function probe(python, timeoutMs) {
  const r = guard(
    parseResult(
      await tools.freecad_exec({ python, timeoutMs: timeoutMs || 30000 })
    )
  );
  if (!r || r.ok !== true) return { __fail: (r && r.error) || "exec failed" };
  const d = r.result || {};
  if (d.ok === false) return { __fail: d.error || "returned ok:false" };
  return d;
}

async function refused(label, fn, opArgs, id, wanted) {
  const r = await call(fn, opArgs, id);
  const msg = String((r && (r.error || r.detail)) || "");
  const said = !!(
    r &&
    (r.__error === true || r.ok === false || (msg && r.applied !== true))
  );
  return assert(
    label,
    said && (!wanted || msg.indexOf(wanted) !== -1),
    JSON.stringify({
      ok: r && r.ok,
      applied: r && r.applied,
      error: msg.slice(0, 200),
    })
  );
}

const DOC = "Ops3CadTest";

async function run() {
  console.log("=== test_ops3.js — CAD 3D extensions (loft, pipe, draft) ===");

  const attachRes = parseResult(await tools.freecad_attach({}));
  if (!attachRes || !attachRes.attached) {
    assert("attached to FreeCAD", false, JSON.stringify(attachRes));
    return { success: false, pass, fail, warn, results };
  }
  assert("attached to FreeCAD", true, attachRes.status);

  // Setup test document
  await call("new_document", { name: DOC }, "doc.test");

  // ======================================================================
  console.log("\n--- Section 1: loft and subtractive_loft ---");

  await call("body", {}, "body.loft");

  // Gate refusals
  await refused(
    "loft with no sketches is refused",
    "loft",
    { body: "body.loft" },
    "loft.bad0",
    "missing required argument 'sketches'"
  );

  await refused(
    "loft with 1 sketch is refused",
    "loft",
    { body: "body.loft", sketches: ["sk.one"] },
    "loft.bad1",
    "requires a list of at least 2 sketch ids"
  );

  // Base sketch: Circle R=20 on XY
  await call(
    "sketch",
    {
      body: "body.loft",
      on: "XY",
      geometry: [{ type: "circle", x: 0, y: 0, r: 20 }],
    },
    "sk.loft_base"
  );

  // Datum plane at Z=50
  await call(
    "datum_plane",
    { body: "body.loft", on: "XY", offset: 50 },
    "dp.loft_top"
  );

  // Top sketch: Circle R=10 on datum plane
  await call(
    "sketch",
    {
      body: "body.loft",
      on: "dp.loft_top",
      geometry: [{ type: "circle", x: 0, y: 0, r: 10 }],
    },
    "sk.loft_top"
  );

  // Build additive loft
  await refused(
    "loft with the same section twice is refused",
    "loft",
    { body: "body.loft", sketches: ["sk.loft_base", "sk.loft_base"] },
    "loft.bad2",
    "twice"
  );

  const loftRes = await call(
    "loft",
    {
      body: "body.loft",
      sketches: ["sk.loft_base", "sk.loft_top"],
      ruled: false,
      closed: false,
      label: "TransitionCone",
    },
    "loft.cone"
  );
  assert("additive loft created", loftRes && loftRes.ok === true);
  assert(
    "loft reports the shape flags it was given",
    loftRes.result &&
      loftRes.result.ruled === false &&
      loftRes.result.closed === false,
    JSON.stringify(loftRes.result)
  );

  const pLoftLabel = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
o = koi_cad.resolve(doc, "loft.cone")
return {"ok": True, "label": o.Label}
`);
  assert(
    "loft applied the label it advertises",
    pLoftLabel.ok && pLoftLabel.label === "TransitionCone",
    JSON.stringify(pLoftLabel)
  );

  // Math: Frustum of cone: V = 1/3 * pi * H * (R1^2 + R1*R2 + R2^2)
  // V = 1/3 * pi * 50 * (400 + 200 + 100) = 35000/3 * pi ≈ 36651.91429
  const expectedLoftVol = (1.0 / 3.0) * Math.PI * 50.0 * (400 + 200 + 100);
  const pLoft = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
o = koi_cad.resolve(doc, "loft.cone")
return {"ok": True, "vol": round(o.Shape.Volume, 4), "valid": o.isValid()}
`);
  assert(
    "loft volume matches frustum of cone mathematical formula",
    pLoft.ok && Math.abs(pLoft.vol - expectedLoftVol) < 1.0,
    `measured ${pLoft.vol}, expected ${expectedLoftVol.toFixed(4)}`
  );

  // Subtractive loft: inner bore from R=8 to R=4
  await call(
    "sketch",
    {
      body: "body.loft",
      on: "XY",
      geometry: [{ type: "circle", x: 0, y: 0, r: 8 }],
    },
    "sk.sub_base"
  );

  await call(
    "sketch",
    {
      body: "body.loft",
      on: "dp.loft_top",
      geometry: [{ type: "circle", x: 0, y: 0, r: 4 }],
    },
    "sk.sub_top"
  );

  const subLoftRes = await call(
    "subtractive_loft",
    { body: "body.loft", sketches: ["sk.sub_base", "sk.sub_top"] },
    "loft.sub_bore"
  );
  assert("subtractive loft created", subLoftRes && subLoftRes.ok === true);

  // Expected inner bore volume: 1/3 * pi * 50 * (64 + 32 + 16) = 5600/3 * pi ≈ 5864.306
  const expectedSubVol = (1.0 / 3.0) * Math.PI * 50.0 * (64 + 32 + 16);
  assert(
    "subtractive loft removed correct volume",
    subLoftRes &&
      subLoftRes.result &&
      Math.abs(subLoftRes.result.removed - expectedSubVol) < 1.0,
    `removed ${subLoftRes && subLoftRes.result && subLoftRes.result.removed}, expected ${expectedSubVol.toFixed(4)}`
  );

  // The same measurement pocket and groove carry. Without it a subtractive
  // feature that recomputes clean and removes nothing reports success.
  assert(
    "subtractive loft carries removedAtProfile, like pocket and groove",
    subLoftRes.result &&
      Object.prototype.hasOwnProperty.call(subLoftRes.result, "removedAtProfile"),
    JSON.stringify(Object.keys((subLoftRes && subLoftRes.result) || {}))
  );
  assert(
    "subtractive loft that cut correctly raises no note",
    !(subLoftRes.result && subLoftRes.result.note),
    (subLoftRes.result && subLoftRes.result.note) || ""
  );

  // ======================================================================
  console.log("\n--- Section 2: pipe / sweep and subtractive_pipe ---");

  await call("body", {}, "body.pipe");

  // Gate refusals
  await refused(
    "pipe without sketch is refused",
    "pipe",
    { body: "body.pipe", path: "sk.path" },
    "pipe.bad0",
    "missing required argument 'sketch'"
  );

  await refused(
    "pipe without path is refused",
    "pipe",
    { body: "body.pipe", sketch: "sk.prof" },
    "pipe.bad1",
    "missing required argument 'path'"
  );

  // Profile sketch: Circle R=5 on XY
  await call(
    "sketch",
    {
      body: "body.pipe",
      on: "XY",
      geometry: [{ type: "circle", x: 0, y: 0, r: 5 }],
    },
    "sk.pipe_prof"
  );

  // Path sketch: Vertical line of length 50 on XZ using from:[0,0], to:[0,50]
  await call(
    "sketch",
    {
      body: "body.pipe",
      on: "XZ",
      geometry: [{ type: "line", from: [0, 0], to: [0, 50] }],
    },
    "sk.pipe_path"
  );

  await refused(
    "pipe with an unrecognised mode is refused, not quietly defaulted",
    "pipe",
    {
      body: "body.pipe",
      sketch: "sk.pipe_prof",
      path: "sk.pipe_path",
      mode: "Wobble",
    },
    "pipe.badmode",
    "mode must be one of"
  );

  await refused(
    "pipe with an unrecognised transition is refused",
    "pipe",
    {
      body: "body.pipe",
      sketch: "sk.pipe_prof",
      path: "sk.pipe_path",
      transition: "SquareCorner",
    },
    "pipe.badtrans",
    "transition must be one of"
  );

  await refused(
    "pipe given one sketch as both profile and path is refused",
    "pipe",
    {
      body: "body.pipe",
      sketch: "sk.pipe_prof",
      path: "sk.pipe_prof",
    },
    "pipe.badself",
    "both profile and path"
  );

  // Build additive pipe via 'sweep' alias. mode is given in lower case on
  // purpose: an enum the caller has to capitalise correctly is an enum that
  // silently does the wrong thing the first time somebody types it.
  const sweepRes = await call(
    "sweep",
    {
      body: "body.pipe",
      sketch: "sk.pipe_prof",
      path: "sk.pipe_path",
      mode: "frenet",
      label: "MainTube",
    },
    "pipe.tube"
  );
  assert("additive pipe built via sweep alias", sweepRes && sweepRes.ok === true);
  assert(
    "pipe normalised a lower-case mode to Frenet",
    sweepRes.result && sweepRes.result.mode === "Frenet",
    JSON.stringify(sweepRes.result && sweepRes.result.mode)
  );

  // Math: Cylinder volume: pi * r^2 * h = pi * 25 * 50 = 1250 * pi ≈ 3926.9908
  const expectedPipeVol = Math.PI * 25.0 * 50.0;
  const pPipe = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
o = koi_cad.resolve(doc, "pipe.tube")
return {"ok": True, "vol": round(o.Shape.Volume, 4), "valid": o.isValid()}
`);
  assert(
    "pipe volume matches cylindrical sweep formula",
    pPipe.ok && Math.abs(pPipe.vol - expectedPipeVol) < 1.0,
    `measured ${pPipe.vol}, expected ${expectedPipeVol.toFixed(4)}`
  );

  // Subtractive pipe along the same path with R=3
  await call(
    "sketch",
    {
      body: "body.pipe",
      on: "XY",
      geometry: [{ type: "circle", x: 0, y: 0, r: 3 }],
    },
    "sk.pipe_sub_prof"
  );

  const subPipeRes = await call(
    "subtractive_sweep",
    {
      body: "body.pipe",
      sketch: "sk.pipe_sub_prof",
      path: "sk.pipe_path",
    },
    "pipe.inner_cut"
  );
  assert("subtractive pipe built via subtractive_sweep alias", subPipeRes && subPipeRes.ok === true);

  const expectedSubPipeVol = Math.PI * 9.0 * 50.0; // 450*pi ≈ 1413.7167
  assert(
    "subtractive pipe removed correct volume",
    subPipeRes &&
      subPipeRes.result &&
      Math.abs(subPipeRes.result.removed - expectedSubPipeVol) < 1.0,
    `removed ${subPipeRes && subPipeRes.result && subPipeRes.result.removed}, expected ${expectedSubPipeVol.toFixed(4)}`
  );
  assert(
    "subtractive pipe carries removedAtProfile",
    subPipeRes.result &&
      Object.prototype.hasOwnProperty.call(subPipeRes.result, "removedAtProfile"),
    JSON.stringify(Object.keys((subPipeRes && subPipeRes.result) || {}))
  );

  // ======================================================================
  console.log("\n--- Section 3: draft ---");

  await call("body", {}, "body.draft");

  // Base pad: 20x20 square padded 20 mm
  await call(
    "sketch",
    {
      body: "body.draft",
      on: "XY",
      geometry: [{ type: "rect", x: 0, y: 0, w: 20, h: 20, anchor: "center" }],
    },
    "sk.draft_box"
  );

  const padDraft = await call(
    "pad",
    { body: "body.draft", sketch: "sk.draft_box", length: 20 },
    "pad.draft_base"
  );
  assert("draft base pad created", padDraft && padDraft.ok === true);
  assert(
    "draft base pad is 8000 mm3",
    padDraft.result && Math.abs(padDraft.result.volume - 8000) < 1e-3,
    String(padDraft.result && padDraft.result.volume)
  );

  // Refusal: missing angle
  await refused(
    "draft without angle is refused",
    "draft",
    { body: "body.draft", refs: ["pad.draft_base:Face1"] },
    "draft.bad0",
    "missing required argument 'angle'"
  );

  // The four vertical faces, resolved BY DIRECTION. Slicing the first four
  // off a plain "all planar faces" query is the bug this replaces: face order
  // is not a fact about the part, and a slice that catches the bottom face
  // drafts the neutral plane itself.
  const sideFaceRefs = [];
  for (const dir of ["+X", "-X", "+Y", "-Y"]) {
    const q = await call("query", {
      of: "pad.draft_base",
      kind: "face",
      surface: "Plane",
      direction: dir,
      expect: "one",
    });
    const refs = (q && q.result && q.result.refs) || [];
    if (refs.length === 1) sideFaceRefs.push(refs[0]);
    else note("no single " + dir + " face", JSON.stringify(refs));
  }
  assert(
    "four side faces resolved by direction, not by index",
    sideFaceRefs.length === 4,
    JSON.stringify(sideFaceRefs)
  );

  // Apply draft angle of 5 degrees relative to bottom plane (XY)
  const draftRes = await call(
    "draft",
    {
      body: "body.draft",
      angle: 5.0,
      neutralPlane: "XY",
      refs: sideFaceRefs,
    },
    "draft.taper"
  );
  assert("draft applied", draftRes && draftRes.ok === true);

  // Frustum of a rectangular pyramid, 20 mm tall, 20x20 at the neutral plane:
  //   W_top = 20 -/+ 2 * 20 * tan(5 deg)   ->   16.50045 or 23.49955 mm
  //   V     = h/3 * (A1 + A2 + sqrt(A1*A2)) = 20/3 * (400 + W^2 + 20*W)
  // Which of the two it is, is a fact about the document, so read it off the
  // op's own taper report rather than assuming the platform's pull direction.
  const tan5 = Math.tan((5 * Math.PI) / 180);
  const frustum = (wTop) => (20.0 / 3.0) * (400.0 + wTop * wTop + 20.0 * wTop);
  const inwardVol = frustum(20 - 40 * tan5); // ≈ 6681.83
  const outwardVol = frustum(20 + 40 * tan5); // ≈ 9481.53

  const taper = draftRes.result && draftRes.result.taper;
  assert(
    "draft reports which way it pulled",
    taper === "inward" || taper === "outward",
    JSON.stringify(draftRes.result)
  );
  const expectedDraftVol = taper === "outward" ? outwardVol : inwardVol;

  const pDraft = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
o = koi_cad.resolve(doc, "draft.taper")
return {"ok": True, "vol": round(o.Shape.Volume, 4), "valid": o.isValid()}
`);
  assert(
    "drafted solid is valid and matches the " + taper + " taper formula",
    pDraft.ok && pDraft.valid && Math.abs(pDraft.vol - expectedDraftVol) < 1.0,
    `measured ${pDraft.vol}, expected ${expectedDraftVol.toFixed(4)} (${taper})`
  );
  assert(
    "draft volumeDelta agrees with the document",
    draftRes.result &&
      pDraft.ok &&
      Math.abs(8000 + draftRes.result.volumeDelta - pDraft.vol) < 1.0,
    JSON.stringify({
      delta: draftRes.result && draftRes.result.volumeDelta,
      measured: pDraft.vol,
    })
  );

  // ---- draft placed by QUERY, not by refs ----
  // The regression test for _dress_query defaulting to kind 'edge': a draft
  // asked for by filter used to be handed a list of EDGES, and failed inside
  // BRep with a message about the base instead of about the filter.
  await call("body", {}, "body.draft2");
  await call(
    "sketch",
    {
      body: "body.draft2",
      on: "XY",
      geometry: [{ type: "rect", x: 0, y: 0, w: 20, h: 20, anchor: "center" }],
    },
    "sk.draft2_box"
  );
  await call(
    "pad",
    { body: "body.draft2", sketch: "sk.draft2_box", length: 20 },
    "pad.draft2_base"
  );
  const draftQ = await call(
    "draft",
    {
      body: "body.draft2",
      angle: 3.0,
      neutralPlane: "XY",
      query: { direction: "+X", surface: "Plane", expect: "one" },
    },
    "draft.byquery"
  );
  assert(
    "draft by query resolves FACES, not edges",
    draftQ && draftQ.ok === true,
    JSON.stringify(draftQ && (draftQ.error || draftQ.result))
  );
  assert(
    "draft by query kept its filter for re-resolution",
    draftQ.result && draftQ.result.query && draftQ.result.query.kind === "face",
    JSON.stringify(draftQ.result && draftQ.result.query)
  );
  assert(
    "draft by query actually moved material",
    draftQ.result &&
      draftQ.result.taper !== "none" &&
      Math.abs(draftQ.result.volumeDelta || 0) > 1e-6,
    JSON.stringify(draftQ.result && {
      taper: draftQ.result.taper,
      delta: draftQ.result.volumeDelta,
    })
  );

  // ======================================================================
  console.log("\n--- Section 4: ids survive, and the aliases resolve ---");

  // A feature the router built but never registered is a feature the next
  // turn cannot edit, which is the whole point of the id table.
  const idRes = await call("ids", {});
  const known = ((idRes && idRes.result && idRes.result.ids) || []).reduce(
    (acc, r) => {
      acc[r.id] = r;
      return acc;
    },
    {}
  );
  for (const kid of [
    "loft.cone",
    "loft.sub_bore",
    "pipe.tube",
    "pipe.inner_cut",
    "draft.taper",
    "draft.byquery",
  ]) {
    assert(
      "id " + kid + " is registered and present",
      known[kid] && known[kid].present === true,
      JSON.stringify(known[kid] || null)
    );
  }

  // The refusals above must NOT have left half-built features behind.
  for (const kid of ["loft.bad1", "loft.bad2", "pipe.badmode", "pipe.badself"]) {
    assert(
      "refused call " + kid + " registered nothing",
      !known[kid],
      JSON.stringify(known[kid] || null)
    );
  }

  // ======================================================================
  console.log("\n--- Cleaning up ---");
  try {
    await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
`);
    assert("scratch document closed cleanly", true, "");
  } catch (e) {
    note("cleanup failed", e.message);
  }

  const buildInfo = parseResult(await tools.freecad_version({}));
  const build = (buildInfo && (buildInfo.build || buildInfo.runtime)) || {};
  console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings.`);
  console.log(`Valid for build ${build.exeVersion || build.version || "?"} @ ${build.commit || "?"}`);

  return { success: fail === 0, pass, fail, warn, results };
}

return run().catch((e) => {
  console.error(e);
  const label =
    e instanceof TransportLost
      ? "transport lost — the rest of this run proves nothing: " + e.message
      : e.message;
  results.push("❌ " + label);
  return { success: false, pass, fail, warn, results, error: label };
});
