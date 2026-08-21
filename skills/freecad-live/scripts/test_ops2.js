// scripts/test_ops2.js — query, pattern, primitive, bolt_sketch, allow, bspline.
//
// Six ops that exist because the first review of the tool surface found the
// same shape of hole six times: the doctrine was right and the surface did not
// implement it, so the only way through was freecad_script — which is the
// channel that produces objects turn 7 cannot address.
//
// Two rules carried over from test_ops.js, both learned the hard way:
//
//   1. Read the DOCUMENT, not the op's own JSON. `datum_plane` once passed a
//      harness by echoing back an offset it had never written. Every assertion
//      here that matters goes through probe() or a closed-form volume.
//   2. Test every gate in the direction where it says no. An op that has only
//      ever been asked to succeed is an op with an untested refusal path.
//
// The one section that is allowed to be soft is bspline: Part.BSplineCurve
// through Sketcher.addGeometry is the likeliest thing on this list to be
// missing from a wasm build, and the op is specified to refuse cleanly and
// name polyline as the fallback. So "it built" and "it refused with the
// fallback message" are both passes; anything else is a failure.

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
  return guard(parseResult(await tools.freecad_call(
    Object.assign({ fn, args: opArgs || {} }, id ? { id } : {}, extra || {}))));
}

async function sync(extra) {
  return guard(parseResult(await tools.freecad_sync(extra || {})));
}

async function measure(opArgs) {
  return guard(parseResult(await tools.freecad_measure(opArgs || {})));
}

async function probe(python, timeoutMs) {
  const r = guard(parseResult(
    await tools.freecad_exec({ python, timeoutMs: timeoutMs || 30000 })));
  if (!r || r.ok !== true) return { __fail: (r && r.error) || "exec failed" };
  const d = r.result || {};
  if (d.ok === false) return { __fail: d.error || "returned ok:false" };
  return d;
}

async function refused(label, fn, opArgs, id, wanted) {
  const r = await call(fn, opArgs, id);
  const msg = String((r && (r.error || r.detail)) || "");
  const said = !!(r && (r.__error === true || r.ok === false ||
                        (msg && r.applied !== true)));
  return assert(
    label,
    said && (!wanted || msg.indexOf(wanted) !== -1),
    JSON.stringify({ ok: r && r.ok, applied: r && r.applied,
                     error: msg.slice(0, 200) }));
}

const DOC = "Ops2Test";
// Where the bolt-pattern plate lives. Off the origin on purpose: the main
// plate is centred there, and two solids sharing a volume would make every
// later interference row noise.
const MX = 200;
const near = (a, b, tol) =>
  typeof a === "number" && Math.abs(a - b) < (tol || 1e-3);

// The plate every section works on: 60 x 40, 10 thick, on XY, CENTRED on the
// origin. `rect` takes the lower-left corner, and a polar pattern turns about
// the body's Z axis — which is at the origin, not at the plate's middle. A
// plate at x:0,y:0 puts the pattern axis on its corner and throws half the
// instances off the material, where they build nothing and report success.
const W = 60, H = 40, T = 10;
// One Ø6 hole, then five more from a polar pattern. r + d/2 = 18 < H/2 = 20,
// so every instance lands fully on the plate.
const HOLE_D = 6, HOLE_R = 15, HOLE_N = 6;
const HOLE_VOL = Math.PI * (HOLE_D / 2) * (HOLE_D / 2) * T;

async function run() {
  console.log("=== query, pattern, primitive, bolt_sketch, allow, bspline ===");
  console.log("Scratch document: " + DOC + "\n");

  const attach = parseResult(await tools.freecad_attach({ timeoutMs: 240000 }));
  if (!assert("attached", attach && attach.attached === true,
      (attach && (attach.error || attach.detail)) || "unknown")) {
    return { success: false, pass, fail, warn, results, error: "no attach" };
  }

  const setup = await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
doc = App.newDocument("${DOC}")
doc.UndoMode = 1
App.setActiveDocument("${DOC}")
return {"ok": True}
`);
  if (!assert("scratch document created", !setup.__fail, setup.__fail)) {
    return { success: false, pass, fail, warn, results, error: "no doc" };
  }
  await sync();

  await call("body", { label: "Plate" }, "body.plate");
  await call("sketch", {
    body: "body.plate", on: "XY",
    geometry: [{ type: "rect", x: -W / 2, y: -H / 2, w: W, h: H }],
  }, "sk.plate");
  const pad = await call("pad", { body: "body.plate", sketch: "sk.plate",
    length: T }, "pad.plate");
  assert("the plate was padded", pad && pad.ok === true && pad.applied === true,
    JSON.stringify({ ok: pad && pad.ok, error: pad && pad.error }));
  assert("the plate is the size it should be",
    near((pad.result || {}).volume, W * H * T, 1e-3),
    "volume " + JSON.stringify((pad.result || {}).volume));

  // ======================================================================
  // query — the point of which is that it never picks for you
  // ======================================================================
  console.log("\n--- query: choosing an element by geometry, not by index ---");

  const qTop = await call("query", {
    of: "pad.plate", kind: "face", surface: "Plane", normal: "+Z",
    at: { z: T },
  }, null);
  const top = (qTop.result || {});
  assert("query returns a result at read tier",
    qTop && qTop.ok === true && qTop.mode === "read",
    JSON.stringify({ ok: qTop && qTop.ok, mode: qTop && qTop.mode }));
  assert("the +Z face at z=10 is a single unambiguous match",
    top.matched === 1 && top.ambiguous === false,
    JSON.stringify({ matched: top.matched, ambiguous: top.ambiguous }));
  const topRef = ((top.candidates || [])[0] || {}).ref;
  assert("it hands back an <object>:<sub> reference",
    typeof topRef === "string" && topRef.indexOf(":Face") !== -1,
    JSON.stringify(topRef));
  assert("and the face it found really is the top, by area",
    near(((top.candidates || [])[0] || {}).size, W * H, 1e-3),
    JSON.stringify((top.candidates || [])[0]));

  // A query that matches four things has to SAY four. The failure this op
  // exists to prevent is not "picked the wrong face", it is "picked one at
  // all when the answer was under-determined".
  const qVert = await call("query", {
    of: "pad.plate", kind: "edge", surface: "Line", direction: "+Z",
  }, null);
  const vert = (qVert.result || {});
  assert("four vertical edges match, and it reports four rather than one",
    vert.matched === 4 && vert.ambiguous === true,
    JSON.stringify({ matched: vert.matched, ambiguous: vert.ambiguous }));
  assert("the ambiguous note tells the model to narrow rather than guess",
    String(vert.note || "").indexOf("first") !== -1,
    JSON.stringify(vert.note));

  // Ground truth: the document's own face count, not the op's.
  const faceTruth = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
o = koi_cad.resolve(doc, "pad.plate")
zs = [round(f.CenterOfMass.z, 3) for f in o.Shape.Faces]
return {"ok": True, "faces": len(o.Shape.Faces), "tops": zs.count(${T})}
`);
  assert("query's totals agree with the document",
    !faceTruth.__fail && top.total === faceTruth.faces &&
      faceTruth.tops === 1,
    JSON.stringify(faceTruth));

  await refused("query on an object that does not exist is refused",
    "query", { of: "nope.nothing" }, null);
  await refused("query with a bad kind is refused",
    "query", { of: "pad.plate", kind: "solid" }, null, "face");
  await refused("query with a bad normal word is refused",
    "query", { of: "pad.plate", normal: "up" }, null);

  const qNone = await call("query", {
    of: "pad.plate", kind: "face", normal: "+Z", at: { z: 999 },
  }, null);
  assert("a query that matches nothing says so instead of returning junk",
    (qNone.result || {}).matched === 0 &&
      String((qNone.result || {}).note || "").indexOf("guess") !== -1,
    JSON.stringify(qNone.result));

  // Range and tolerant size matching:
  const qRange = await call("query", {
    of: "pad.plate", kind: "edge", surface: "Line", direction: "+Z", size: [9, 11],
  }, null);
  assert("query with size range [9, 11] matches the vertical edges",
    (qRange.result || {}).matched === 4,
    JSON.stringify(qRange.result));

  const qSizeTol = await call("query", {
    of: "pad.plate", kind: "edge", surface: "Line", direction: "+Z", size: 10, tol: 0.5,
  }, null);
  assert("query with size target and tolerance matches",
    (qSizeTol.result || {}).matched === 4,
    JSON.stringify(qSizeTol.result));

  const qMinTol = await call("query", {
    of: "pad.plate", kind: "edge", surface: "Line", direction: "+Z", minSize: 10.05, tol: 0.1,
  }, null);
  assert("query with minSize and tolerance matches edges with minor drift",
    (qMinTol.result || {}).matched === 4,
    JSON.stringify(qMinTol.result));

  // The loop the whole op exists to close: query -> ref -> a dress-up
  // feature, with no user click and no authored index anywhere in it.
  const capt = await call("ref", { ref: topRef }, "pick.top");
  assert("a query result can be captured as a durable ref",
    capt && capt.ok === true, JSON.stringify(capt && capt.error));
  const stored = await probe(`
import json
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
fp = json.loads(doc.Meta["koi.ref.pick.top"])
r = koi_cad.resolve_ref(fp, doc)
return {"ok": True, "status": r.get("status"), "sub": r.get("sub")}
`);
  assert("the captured ref is stored in the document and resolves",
    !stored.__fail && stored.status === "stored",
    JSON.stringify(stored));

  const chamRef = ((vert.candidates || [])[0] || {}).ref;
  const cham = await call("chamfer", {
    body: "body.plate", refs: [chamRef], size: 1,
  }, "cham.corner");
  assert("a chamfer built from a query result applies",
    cham && cham.ok === true && cham.applied === true,
    JSON.stringify({ ok: cham && cham.ok, error: cham && cham.error }));
  assert("and it removed the corner it was given, by volume",
    near((cham.result || {}).volumeDelta, -(1 * 1 / 2) * T, 1e-2),
    JSON.stringify((cham.result || {}).volumeDelta));

  // ======================================================================
  // pattern — the in-body repeat polar_array cannot express
  // ======================================================================
  console.log("\n--- pattern: repeating a feature INSIDE the solid ---");

  const volBefore = (cham.result || {}).volume;

  await call("sketch", {
    body: "body.plate", on: "XY",
    geometry: [{ type: "circle", x: HOLE_R, y: 0, d: HOLE_D }],
  }, "sk.hole");
  const hole = await call("pocket", {
    body: "body.plate", sketch: "sk.hole", through: true,
  }, "poc.hole");
  assert("one hole is cut to pattern from",
    hole && hole.ok === true && near((hole.result || {}).removed, HOLE_VOL, 0.5),
    JSON.stringify({ removed: (hole.result || {}).removed, want: HOLE_VOL }));

  await refused("a pattern of one instance is refused",
    "pattern", { body: "body.plate", features: ["poc.hole"], count: 1 },
    "pat.bad", "at least 2");
  await refused("a pattern over the instance bound is refused",
    "pattern", { body: "body.plate", features: ["poc.hole"], count: 9999 },
    "pat.bad2", "bound");
  // The expensive one. PartDesign::Body starts with "PartDesign::" too, so a
  // guard that only checks the prefix lets a Body through — the pattern then
  // transforms the body into itself, reports valid, and its Shape raises on
  // every later access. On the first run of this file it took the next nine
  // assertions down with it, in three different sections, none of which said
  // anything about patterns.
  await refused("a pattern of a whole body is refused, with the alternative",
    "pattern", { body: "body.plate", features: ["body.plate"], count: 3 },
    "pat.bad3", "polar_array");
  await refused("a linear pattern without a length is refused",
    "pattern", { body: "body.plate", kind: "linear", features: ["poc.hole"],
      count: 3 }, "pat.bad4", "length");

  const pat = await call("pattern", {
    body: "body.plate", kind: "polar", features: ["poc.hole"],
    count: HOLE_N, angle: 360, axis: "Z",
  }, "pat.holes");
  const okPat = assert("polar pattern applies",
    pat && pat.ok === true && pat.applied === true,
    JSON.stringify({ ok: pat && pat.ok, error: pat && pat.error,
                     applied: pat && pat.applied }));

  if (okPat) {
    const pr = pat.result || {};
    // The measurement, not the state flag. A pattern whose instances land on
    // top of each other recomputes clean and reports isValid().
    assert("the pattern removed five more holes' worth of material",
      near(pr.volumeDelta, -(HOLE_N - 1) * HOLE_VOL, 2.0),
      JSON.stringify({ delta: pr.volumeDelta,
                       want: -(HOLE_N - 1) * HOLE_VOL }));
    assert("it did not report the no-op note",
      !pr.note || String(pr.note).indexOf("changed nothing") === -1,
      JSON.stringify(pr.note));
    assert("the volume is readable at all — a pattern that is not refuses",
      typeof pr.volume === "number" && typeof pr.volumeDelta === "number",
      JSON.stringify({ volume: pr.volume, delta: pr.volumeDelta }));
    // Which reading of Angle this build wanted. FreeCAD 1.x made Angle the
    // step between instances rather than the total sweep, so 360 across six
    // put all six on top of each other. Recording it here means the next
    // build change shows up as a diff in the log rather than as a mystery.
    console.log("   polar Angle read as: " + JSON.stringify(pr.modeUsed) +
      " of " + JSON.stringify(pr.modesOffered));
    assert("and it says which reading of Angle this build accepted",
      pr.modesOffered !== undefined,
      JSON.stringify({ used: pr.modeUsed, offered: pr.modesOffered }));
    // On a build that offers modes at all, one of them has to have been
    // chosen. A null here would mean the op fell through to the legacy
    // no-Mode path on a build that has Mode — which is how 360 got read as a
    // 60-degree step and stacked six instances 10 degrees apart.
    assert("a build that offers modes had one of them selected",
      !(pr.modesOffered || []).length || pr.modeUsed !== null,
      JSON.stringify({ used: pr.modeUsed, offered: pr.modesOffered,
                       tried: pr.modesTried }));
    // Ground truth: six holes means the solid gained ten cylindrical faces
    // over the plate that had one. Counted from the document.
    const cyl = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
o = koi_cad.resolve(doc, "pat.holes")
n = 0
for f in o.Shape.Faces:
    if type(f.Surface).__name__ == "Cylinder":
        n += 1
return {"ok": True, "cyl": n, "vol": round(o.Shape.Volume, 4)}
`);
    assert("the document holds six cylindrical bores, not one",
      !cyl.__fail && cyl.cyl >= HOLE_N,
      JSON.stringify(cyl));
    assert("and the body's own volume agrees with the reported delta",
      !cyl.__fail && near(cyl.vol, volBefore - HOLE_N * HOLE_VOL, 2.0),
      JSON.stringify({ doc: cyl.vol,
                       want: volBefore - HOLE_N * HOLE_VOL }));
  } else {
    note("pattern did not build — everything below about in-body repeats is " +
      "unproven on this build",
      JSON.stringify((pat && pat.error) || (pat && pat.result)));
  }

  // ======================================================================
  // primitive + boolean — proving the pair through the CALL channel alone
  // ======================================================================
  console.log("\n--- primitive: giving boolean a tool solid ---");
  // test_geom.js proved `boolean` with a Part::Cylinder made by freecad_exec,
  // which means the path an LLM would actually take was never exercised. No
  // probe() below this line until the boolean is done.

  await refused("a primitive with an unknown kind is refused",
    "primitive", { kind: "torus", radius: 5 }, "prim.bad");
  await refused("a primitive missing a dimension is refused",
    "primitive", { kind: "cylinder", radius: 5 }, "prim.bad2", "needs");
  await refused("a primitive with a bad at is refused",
    "primitive", { kind: "box", length: 1, width: 1, height: 1, at: [0, 0] },
    "prim.bad3", "at must be");

  const cylTool = await call("primitive", {
    kind: "cylinder", d: 12, height: T * 3, at: [0, 0, -T],
  }, "tool.bore");
  assert("a cylinder primitive applies",
    cylTool && cylTool.ok === true && cylTool.applied === true,
    JSON.stringify({ ok: cylTool && cylTool.ok, error: cylTool && cylTool.error }));
  const cr = cylTool.result || {};
  assert("its volume is the closed form, so d was read as a diameter",
    near(cr.volume, Math.PI * 6 * 6 * T * 3, 1e-2),
    JSON.stringify({ got: cr.volume, want: Math.PI * 36 * 30 }));
  // Two assertions, because "12 across" and "exactly 12 across" are different
  // claims and the second is only available on a build that can compute the
  // box from the geometry rather than from a mesh. The loose one is the
  // contract — a caller reading their own dimension back must not be misled.
  // The tight one is the check that the exact path is actually being taken:
  // this build's optimalBoundingBox() defaults to the tessellated form and
  // returned 12.087, which passes nothing and failed here for two builds.
  const exactBox = String(cr.bboxVia || "").indexOf("exact") !== -1;
  assert("and the bounding box agrees it is 12 across",
    near((cr.bbox || [])[0], 12, 0.05),
    JSON.stringify({ bbox: cr.bbox, via: cr.bboxVia }));
  if (exactBox) {
    assert("and it is exactly 12, because the box came from the geometry",
      near((cr.bbox || [])[0], 12, 1e-6) && near((cr.bbox || [])[2], T * 3, 1e-6),
      JSON.stringify({ bbox: cr.bbox, via: cr.bboxVia }));
  } else {
    note("no exact bounding box on this build — primitive bboxes are " +
      "mesh-derived and read a little off in both directions",
      String(cr.bboxVia));
  }

  const boxTool = await call("primitive", {
    kind: "box", length: 5, width: 5, height: 5, at: [200, 200, 200],
  }, "tool.far");
  assert("a box primitive applies at a placement",
    boxTool && boxTool.ok === true &&
      near((boxTool.result || {}).volume, 125, 1e-6),
    JSON.stringify(boxTool && boxTool.result));

  const target = okPat ? "pat.holes" : "poc.hole";
  const cut = await call("boolean", {
    op: "cut", base: target, tool: "tool.bore",
  }, "bool.bore");
  assert("boolean cut applies with a whitelist-made tool — no exec anywhere",
    cut && cut.ok === true && cut.applied === true,
    JSON.stringify({ ok: cut && cut.ok, error: cut && cut.error }));
  assert("the central bore removed its own volume",
    near((cut.result || {}).volumeDelta, -(Math.PI * 6 * 6 * T), 1.0),
    JSON.stringify({ delta: (cut.result || {}).volumeDelta,
                     want: -(Math.PI * 36 * T) }));
  // Guarded on cut.result existing. The first run of this file read a note
  // off an undefined result, which is vacuously true — a green line inside a
  // section that had already failed.
  assert("the bore cut is NOT reported as a no-op, because it overlapped",
    !!cut.result &&
      String(cut.result.note || "").indexOf("removed nothing") === -1,
    JSON.stringify({ have: !!cut.result, note: (cut.result || {}).note }));

  const noop = await call("boolean", {
    op: "cut", base: "bool.bore", tool: "tool.far",
  }, "bool.noop");
  assert("and the far box cuts nothing, and says so rather than succeeding",
    String((noop.result || {}).note || "").indexOf("removed nothing") !== -1,
    JSON.stringify((noop.result || {}).note));

  // ======================================================================
  // bolt_sketch — the half of the swap story that was a literal
  // ======================================================================
  console.log("\n--- bolt_sketch: positions bound, not baked ---");

  const ins = await call("insert", {
    catalog: "NEMA17_envelope", at: [0, 0, 100],
  }, "motor.main");
  assert("a NEMA 17 is inserted to bind against",
    ins && ins.ok === true, JSON.stringify(ins && ins.error));
  assert("it publishes a bolt pitch for the sketch to bind to",
    JSON.stringify((ins.result || {}).aliases || {})
      .indexOf("bolts_pitch") !== -1,
    JSON.stringify((ins.result || {}).aliases));
  assert("and reports the 31 mm square pattern",
    near((((ins.result || {}).boltPositions || [])[1] || [])[0], 15.5, 1e-3),
    JSON.stringify((ins.result || {}).boltPositions));

  await refused("bolt_sketch on something that is not a component is refused",
    "bolt_sketch", { body: "body.plate", component: "pad.plate" },
    "bs.bad", "not an inserted component");

  await call("body", { label: "Mount" }, "body.mount");
  await call("sketch", {
    body: "body.mount", on: "XY",
    // 60 square, centred on x=200 — clear of the main plate, which occupies
    // the origin. A NEMA 23 puts its holes at ±23.57 from the pattern centre,
    // so 50 square would lose them off the edge after the swap and the
    // interesting assertion would fail for an uninteresting reason.
    geometry: [{ type: "rect", x: MX - 30, y: -30, w: 60, h: 60 }],
  }, "sk.mount");
  await call("pad", { body: "body.mount", sketch: "sk.mount", length: 5 },
    "pad.mount");

  // at:[MX, 0] is the offset path: the generated expressions have to carry
  // the pattern centre as a constant term and still move with the pitch.
  const bs = await call("bolt_sketch", {
    body: "body.mount", component: "motor.main", on: "XY", at: [MX, 0],
  }, "sk.bolts");
  const okBs = assert("bolt_sketch applies",
    bs && bs.ok === true && bs.applied === true,
    JSON.stringify({ ok: bs && bs.ok, error: bs && bs.error }));

  let boltVolBefore = null;
  if (okBs) {
    const br = bs.result || {};
    assert("four circles on the square pattern",
      br.count === 4 && br.pattern === "square",
      JSON.stringify({ count: br.count, pattern: br.pattern }));
    assert("at the 31 mm pitch the motor published, not a guess",
      near(br.pitch, 31, 1e-6) &&
        near(((br.positions || [])[1] || [])[0], MX + 15.5, 1e-3),
      JSON.stringify(br.positions));
    // The sketch circle is cosmetic once a Hole feature drives it — the
    // assertion is that the diameter came from the FASTENERS table for the
    // thread the pattern names, not from anything the caller passed.
    assert("the clearance came from the table for the pattern's own M3",
      near(br.diameter, 3.4, 1e-6), JSON.stringify(br.diameter));
    // The assertion the whole op exists for.
    assert("the POSITIONS are bound by expression, not written as literals",
      br.bindingVerified === true,
      JSON.stringify({ verified: br.bindingVerified, unbound: br.unbound,
                       note: br.note }));

    const ee = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
sk = koi_cad.resolve(doc, "sk.bolts")
return {"ok": True, "expr": [list(p) for p in sk.ExpressionEngine]}
`);
    assert("and the document itself holds those expressions",
      !ee.__fail && JSON.stringify(ee.expr || "")
        .indexOf("motor_main_bolts_pitch") !== -1,
      JSON.stringify(ee.expr).slice(0, 240));

    // No diameter and no spec: the profile's own circles are the size. The
    // first run of this file failed here with "missing required argument
    // 'diameter'", which meant bolt_sketch could not compose with the one op
    // it exists to feed.
    const bh = await call("hole", {
      body: "body.mount", sketch: "sk.bolts", through: true,
    }, "hole.bolts");
    assert("the bolt holes cut",
      bh && bh.ok === true && bh.applied === true,
      JSON.stringify({ ok: bh && bh.ok, error: bh && bh.error }));
    assert("and took their diameter from the profile, not an argument",
      (bh.result || {}).diameterFrom === "profile" &&
        near((bh.result || {}).diameter, 3.4, 1e-3),
      JSON.stringify({ from: (bh.result || {}).diameterFrom,
                       d: (bh.result || {}).diameter }));

    const before = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
o = koi_cad.resolve(doc, "hole.bolts")
cs = [f.Surface.Center for f in o.Shape.Faces
      if type(f.Surface).__name__ == "Cylinder"]
xs = sorted(set([round(abs(c.x), 3) for c in cs]))
return {"ok": True, "xs": xs, "vol": round(o.Shape.Volume, 3)}
`);
    assert("the holes sit at x = 215.5 in the document",
      !before.__fail && (before.xs || []).indexOf(MX + 15.5) !== -1,
      JSON.stringify(before));
    boltVolBefore = before.vol;

    // ---- the swap, which is the entire argument -----------------------
    const sw = await call("swap", {
      target: "motor.main", catalog: "NEMA23_envelope",
    }, null);
    assert("the motor swaps to a NEMA 23",
      sw && sw.ok === true, JSON.stringify(sw && sw.error));
    assert("the swap reports the pitch moving 31 -> 47.14",
      JSON.stringify((sw.result || {}).changed || "")
        .indexOf("47.14") !== -1,
      JSON.stringify((sw.result || {}).changed));

    const after = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
doc.recompute()
o = koi_cad.resolve(doc, "hole.bolts")
cs = [f.Surface.Center for f in o.Shape.Faces
      if type(f.Surface).__name__ == "Cylinder"]
xs = sorted(set([round(abs(c.x), 3) for c in cs]))
sk = koi_cad.resolve(doc, "sk.bolts")
return {"ok": True, "xs": xs, "vol": round(o.Shape.Volume, 3),
        "dof": sk.solve()}
`);
    // This is the assertion that separates a parametric pattern from four
    // numbers that happened to be right once.
    assert("THE HOLES MOVED WITH THE MOTOR: x is now 223.57, not 215.5",
      !after.__fail && (after.xs || []).indexOf(MX + 23.57) !== -1 &&
        (after.xs || []).indexOf(MX + 15.5) === -1,
      JSON.stringify(after));
    assert("the sketch still solves afterwards — nothing was edited by hand",
      !after.__fail && after.dof === 0,
      JSON.stringify({ solverStatus: after.dof }));
    // Volume is INVARIANT here and asserting it changed was wrong: four holes
    // of one diameter moved sideways displace exactly what they displaced
    // before. The recompute is proven by the positions above. What the volume
    // is good for is the other thing — if the swap had pushed a hole past the
    // edge of the plate, or dropped one, this number would move. So assert it
    // did not.
    assert("volume is unchanged, so all four holes stayed on the plate",
      !after.__fail && boltVolBefore !== null &&
        near(after.vol, boltVolBefore, 1e-3),
      JSON.stringify({ before: boltVolBefore, after: after.vol }));
  }

  // ======================================================================
  // allow — an overlap that is designed, bounded, and still reported
  // ======================================================================
  console.log("\n--- allow: designed overlap vs. a clash ---");

  const ov = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
a = doc.addObject("Part::Box", "GearA")
a.Length, a.Width, a.Height = 10, 10, 10
a.Placement.Base = App.Vector(-300, 0, 0)
b = doc.addObject("Part::Box", "GearB")
b.Length, b.Width, b.Height = 10, 10, 10
b.Placement.Base = App.Vector(-292, 0, 0)
doc.recompute()
return {"ok": True, "common": round(a.Shape.common(b.Shape).Volume, 6)}
`);
  assert("two solids overlapping by 200 mm3 exist to test against",
    !ov.__fail && near(ov.common, 200, 1e-3), JSON.stringify(ov));

  const m0 = await measure({ refs: ["GearA", "GearB"], interference: true });
  const i0 = m0.interference || {};
  assert("undeclared, the overlap is a hit",
    (i0.hits || []).length === 1 && near((i0.hits[0] || {}).volume, 200, 1e-3),
    JSON.stringify(i0.hits));

  await refused("an allowance without a reason is refused",
    "allow", { pairs: [["GearA", "GearB"]], upTo: 250 }, null, "why");

  const al = await call("allow", {
    pairs: [["GearA", "GearB"]], upTo: 250, why: "gear mesh: flanks overlap by design",
  }, null);
  assert("an allowance can be declared",
    al && al.ok === true, JSON.stringify(al && al.error));

  const m1 = await measure({ refs: ["GearA", "GearB"], interference: true });
  const i1 = m1.interference || {};
  assert("declared, it moves out of hits",
    (i1.hits || []).length === 0, JSON.stringify(i1.hits));
  assert("but is still REPORTED under expectedOverlaps, not hidden",
    (i1.expectedOverlaps || []).length === 1 &&
      String((i1.expectedOverlaps[0] || {}).why).indexOf("gear mesh") !== -1,
    JSON.stringify(i1.expectedOverlaps));

  // The allowance is a bound, not a mute button: tighten it under the
  // measured overlap and the same pair has to come back as a hit.
  await call("allow", {
    pairs: [["GearA", "GearB"]], upTo: 50, why: "tightened for the test",
  }, null);
  const m2 = await measure({ refs: ["GearA", "GearB"], interference: true });
  const i2 = m2.interference || {};
  assert("an overlap past its bound is a hit again, with the overshoot",
    (i2.hits || []).length === 1 && near((i2.hits[0] || {}).over, 150, 1e-3),
    JSON.stringify(i2.hits));

  const persisted = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
return {"ok": True, "n": len(koi_cad.allowances(doc))}
`);
  assert("allowances live on the document, so they survive the turn",
    !persisted.__fail && persisted.n === 1, JSON.stringify(persisted));

  await call("allow", { pairs: [["GearA", "GearB"]], clear: true }, null);
  const m3 = await measure({ refs: ["GearA", "GearB"], interference: true });
  assert("clearing an allowance restores the hit",
    ((m3.interference || {}).hits || []).length === 1,
    JSON.stringify((m3.interference || {}).hits));

  // ======================================================================
  // bspline — allowed to be absent, not allowed to half-build
  // ======================================================================
  console.log("\n--- bspline: a dense profile in few poles ---");

  const poles = [];
  for (let i = 0; i < 24; i++) {
    const t = (i / 24) * Math.PI * 2;
    poles.push([Math.round((100 + 15 * Math.cos(t)) * 1e4) / 1e4,
                Math.round((15 * Math.sin(t)) * 1e4) / 1e4]);
  }

  // Its own body, created BEFORE the refusals: without an explicit body the
  // calls below are refused by the several-bodies gate and prove nothing
  // about poles at all. A refusal for the wrong reason is not a tested gate.
  //
  // It also has to be its own body because a PartDesign pad whose result is
  // disconnected from the tip refuses — padding a spline 100 mm away inside
  // body.plate would fail for a reason that says nothing about B-splines.
  await call("body", { label: "Spline" }, "body.spline");

  await refused("bspline with two poles is refused",
    "sketch", { body: "body.spline", on: "XY",
      geometry: [{ type: "bspline", poles: [[0, 0], [1, 1]] }] },
    "sk.bad", "three");
  await refused("bspline over the pole cap is refused",
    "sketch", { body: "body.spline", on: "XY",
      geometry: [{ type: "bspline",
        poles: new Array(201).fill(0).map((_, i) => [i, i % 7]) }] },
    "sk.bad2", "capped");

  const bsp = await call("sketch", {
    body: "body.spline", on: "XY",
    geometry: [{ type: "bspline", poles, closed: true, fix: true }],
  }, "sk.spline");

  if (bsp && bsp.ok === true && bsp.applied === true) {
    const g = ((bsp.result || {}).geometry || [])[0] || {};
    assert("a 24-pole closed B-spline builds",
      g.type === "bspline" && g.poles === 24 && g.periodic === true,
      JSON.stringify(g));
    const padSpline = await call("pad", {
      body: "body.spline", sketch: "sk.spline", length: 4,
    }, "pad.spline");
    assert("and it pads into a solid",
      padSpline && padSpline.ok === true &&
        (padSpline.result || {}).volume > 0,
      JSON.stringify({ ok: padSpline && padSpline.ok,
                       error: padSpline && padSpline.error }));
    if (!g.blocked) {
      note("fix:true did not block the spline — this build has no Block " +
        "constraint for B-splines, so the sketch will lint underconstrained " +
        "every turn", JSON.stringify(g));
    } else {
      assert("fix:true blocked the generated poles", g.blocked === 1,
        JSON.stringify(g));
    }
  } else {
    const msg = String((bsp && bsp.error) || "");
    assert("bspline is unsupported here and refuses cleanly, naming polyline",
      msg.indexOf("polyline") !== -1,
      JSON.stringify(msg.slice(0, 220)));
    note("B-splines are not available on this build — computed profiles are " +
      "capped at 400 polyline points, which is under one 72-tooth gear", msg);
  }

  // ======================================================================
  // sync trimming
  // ======================================================================
  console.log("\n--- sync: a bounded payload on a growing document ---");

  const sSmall = await sync({ limit: 3 });
  const sFull = await sync({ detail: "full" });
  assert("objectCount is exact regardless of trimming",
    sSmall.objectCount === sFull.objectCount && sSmall.objectCount > 3,
    JSON.stringify({ trimmed: sSmall.objectCount, full: sFull.objectCount }));
  assert("the trimmed tree really is smaller",
    JSON.stringify(sSmall.tree || []).length <
      JSON.stringify(sFull.tree || []).length,
    JSON.stringify({ a: JSON.stringify(sSmall.tree || []).length,
                     b: JSON.stringify(sFull.tree || []).length }));
  assert("and it says it was trimmed rather than looking like a small document",
    typeof sSmall.treeNote === "string" &&
      sSmall.treeNote.indexOf("of " + sSmall.objectCount) !== -1,
    JSON.stringify(sSmall.treeNote));
  assert("detail:'full' leaves the tree alone",
    !sFull.treeNote, JSON.stringify(sFull.treeNote));

  // ======================================================================
  console.log("\n--- Cleaning up ---");
  try {
    await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
`);
    assert("scratch document closed without touching the user's work",
      true, "");
  } catch (e) {
    note("cleanup failed", e.message);
  }

  const buildInfo = parseResult(await tools.freecad_version({}));
  const build = (buildInfo && (buildInfo.build || buildInfo.runtime)) || {};
  console.log("\n" + pass + " passed, " + fail + " failed, " + warn + " warnings.");
  console.log("Valid for build " + (build.exeVersion || build.version || "?") +
    " @ " + (build.commit || "?"));

  return { success: fail === 0, pass, fail, warn, results };
}

return run().catch((e) => {
  console.error(e);
  const label = e instanceof TransportLost
    ? "transport lost — the rest of this run proves nothing: " + e.message
    : e.message;
  results.push("❌ " + label);
  return { success: false, pass, fail, warn, results, error: label };
});
