// scripts/test_measure.js — harness for freecad_measure and lint (§6.4, §6.5).
//
//   /skill freecad-live/scripts/test_measure.js --full-auto
//
// The earlier suites measured the platform, the envelope and the dispatcher.
// This measures the thing the design sells as the flagship check: that we can
// say, in numbers, whether two parts can both exist, and how far apart they
// are. Everything here is asserted against geometry the harness builds with
// known dimensions, so an answer that merely looks plausible fails.
//
// Requires `probe-exec: on` in SKILL.md.
//
// Scratch document MeasureTest, closed at the end.

const results = [];
let pass = 0;
let fail = 0;
let warn = 0;

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
  const msg = "⚠️  " + label + (detail ? " — " + detail : "");
  results.push(msg);
  console.log(msg);
}

class TransportLost extends Error {}

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

async function measure(opts) {
  return guard(parseResult(await tools.freecad_measure(opts || {})));
}

async function probe(python, timeoutMs) {
  const r = guard(
    parseResult(await tools.freecad_exec({ python, timeoutMs: timeoutMs || 30000 }))
  );
  if (!r || r.ok !== true) return { __fail: (r && r.error) || "exec failed" };
  const d = r.result || {};
  if (d.ok === false) return { __fail: d.error || "returned ok:false" };
  return d;
}

async function sync() {
  return guard(parseResult(await tools.freecad_sync({})));
}

const DOC = "MeasureTest";
const near = (a, b, tol) => typeof a === "number" && Math.abs(a - b) < (tol || 1e-3);
const rowFor = (m, name) => (m.objects || []).find((r) => r.name === name) || {};
const pairFor = (list, a, b) =>
  (list || []).find(
    (r) => (r.a === a && r.b === b) || (r.a === b && r.b === a)
  ) || {};

async function run() {
  console.log("=== freecad_measure / lint tests ===");
  console.log("Scratch document: " + DOC + "\n");

  const attach = parseResult(await tools.freecad_attach({ timeoutMs: 240000 }));
  if (!assert("attached", attach && attach.attached === true,
      (attach && (attach.error || attach.detail)) || "unknown")) {
    return { success: false, pass, fail, results, error: "not attached" };
  }
  const build = attach.build || {};
  console.log("   build: " + build.exeVersion + " @ " + String(build.commit).slice(0, 12));
  console.log("   (valid only against the probe results for this build)\n");

  // Three boxes with dimensions chosen so every number below is arithmetic,
  // not a reading. A: 10 cube at origin. B: 10 cube 10 mm clear of A on X.
  // Overlap: 10 cube sunk 4 mm into A on X.
  const setup = await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
doc = App.newDocument("${DOC}")
doc.UndoMode = 1
App.setActiveDocument("${DOC}")
def box(name, x, l=10, w=10, h=10):
    b = doc.addObject("Part::Box", name)
    b.Length, b.Width, b.Height = l, w, h
    b.Placement.Base = App.Vector(x, 0, 0)
    return b
box("A", 0)
box("B", 20)
box("Over", 6)
doc.recompute()
return {"ok": True, "objects": [o.Name for o in doc.Objects]}
`);
  if (!assert("scratch geometry built", !setup.__fail, setup.__fail)) {
    return { success: false, pass, fail, results, error: "no scratch doc" };
  }

  // ---- M1: the numbers are the numbers ----
  console.log("--- M1: measurement agrees with arithmetic ---");
  const m1 = await measure({ refs: ["A"] });
  const a = rowFor(m1, "A");
  assert("volume is exact", near(a.volume, 1000, 0.001), JSON.stringify(a.volume));
  assert("surface area is exact", near(a.area, 600, 0.001), JSON.stringify(a.area));
  assert("centre of mass is where it must be",
    a.cog && near(a.cog[0], 5) && near(a.cog[1], 5) && near(a.cog[2], 5),
    JSON.stringify(a.cog));
  assert("the bounding box carries extents, not just lengths",
    a.bboxMin && a.bboxMax && near(a.bboxMin[0], 0) && near(a.bboxMax[0], 10),
    JSON.stringify({ min: a.bboxMin, max: a.bboxMax }));
  assert("face and edge counts are right",
    a.faces === 6 && a.edges === 12, JSON.stringify({ f: a.faces, e: a.edges }));
  assert("the solid is reported closed", a.closed === true, JSON.stringify(a.closed));

  // ---- M2: interference, and what the prefilter does ----
  console.log("\n--- M2: interference is a number, not an impression ---");
  const m2 = await measure({ refs: ["A", "B", "Over"], interference: true });
  const inter = m2.interference || {};
  const ab = pairFor(inter.pairs, "A", "B");
  const ao = pairFor(inter.pairs, "A", "Over");
  assert("every pair is accounted for", (inter.pairs || []).length === 3,
    JSON.stringify((inter.pairs || []).length));
  assert("parts 10 mm apart report zero interference", ab.volume === 0,
    JSON.stringify(ab));
  assert("and cost no boolean to say so", ab.method === "bbox", JSON.stringify(ab));
  assert("the overlap is measured with a real boolean", ao.method === "boolean",
    JSON.stringify(ao));
  // A spans x 0..10, Over spans 6..16 — 4 mm of overlap across a 10x10 face.
  assert("the common volume is exactly the overlap",
    near(ao.volume, 4 * 10 * 10, 0.01), JSON.stringify(ao.volume));
  assert("only the pairs that survived the filter cost a boolean",
    inter.booleansRun === 1, JSON.stringify(inter.booleansRun));
  assert("hits name the pair that cannot both exist",
    (inter.hits || []).length === 1 &&
      pairFor(inter.hits, "A", "Over").volume > 0,
    JSON.stringify(inter.hits));

  // ---- M3: touching is not interfering ----
  console.log("\n--- M3: parts that touch are not parts that clash ---");
  const touch = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
doc.getObject("Over").Placement.Base = App.Vector(10, 0, 0)
doc.recompute()
return {"ok": True}
`);
  assert("the overlap was moved flush against A", !touch.__fail, touch.__fail);
  const m3 = await measure({ pairs: [["A", "Over"]], interference: true, clearance: true });
  const t = pairFor((m3.interference || {}).pairs, "A", "Over");
  assert("a flush pair reports zero common volume",
    t.volume === 0 || near(t.volume, 0, 1e-6), JSON.stringify(t));
  assert("mating parts produce no interference hit",
    ((m3.interference || {}).hits || []).length === 0,
    JSON.stringify((m3.interference || {}).hits));
  const tc = pairFor((m3.clearance || {}).pairs, "A", "Over");
  assert("and the clearance between them is zero", near(tc.distance, 0, 1e-6),
    JSON.stringify(tc));

  // ---- M4: clearance measures a designed gap ----
  console.log("\n--- M4: a designed gap measures as designed ---");
  const m4 = await measure({ pairs: [["A", "B"]], clearance: true });
  const gap = pairFor((m4.clearance || {}).pairs, "A", "B");
  assert("the 10 mm gap measures 10 mm", near(gap.distance, 10, 1e-6),
    JSON.stringify(gap));
  assert("and it says where", Array.isArray(gap.at) && gap.at.length === 2,
    JSON.stringify(gap.at));
  const moved = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
doc.getObject("B").Placement.Base = App.Vector(12, 0, 0)
doc.recompute()
return {"ok": True}
`);
  assert("B was moved to leave a 2 mm gap", !moved.__fail, moved.__fail);
  const m4b = await measure({ pairs: [["A", "B"]], clearance: true });
  assert("a 2 mm service gap measures 2 mm",
    near(pairFor((m4b.clearance || {}).pairs, "A", "B").distance, 2, 1e-6),
    JSON.stringify(pairFor((m4b.clearance || {}).pairs, "A", "B")));

  // ---- M5: measuring costs the document nothing ----
  console.log("\n--- M5: measuring changes nothing ---");
  const before = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "undo": len(doc.UndoNames), "objects": len(doc.Objects),
        "touched": [o.Name for o in doc.Objects if "Touched" in o.State]}
`);
  await measure({ interference: true, clearance: true, deepLint: true });
  const after = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "undo": len(doc.UndoNames), "objects": len(doc.Objects),
        "touched": [o.Name for o in doc.Objects if "Touched" in o.State]}
`);
  assert("no undo entry was booked",
    !before.__fail && !after.__fail && after.undo === before.undo,
    JSON.stringify({ before: before.undo, after: after.undo }));
  assert("nothing was added or removed", after.objects === before.objects,
    JSON.stringify({ before: before.objects, after: after.objects }));
  assert("and nothing was left touched",
    (after.touched || []).length === (before.touched || []).length,
    JSON.stringify(after.touched));

  // ---- M6: the parts list is parts, not features ----
  console.log("\n--- M6: a body is one part, not one per feature ---");
  const body = await probe(`
import FreeCAD as App, Part, Sketcher
from FreeCAD import Vector as V
doc = App.getDocument("${DOC}")
body = doc.addObject("PartDesign::Body", "Plate")
plane = None
for o in body.Origin.OriginFeatures:
    if "XY_Plane" in o.Name:
        plane = o
sk = doc.addObject("Sketcher::SketchObject", "sk_plate")
body.addObject(sk)
try:
    sk.AttachmentSupport = [(plane, "")]
except Exception:
    sk.Support = [(plane, "")]
sk.MapMode = "FlatFace"
sk.addGeometry(Part.Circle(V(0, 40, 0), V(0, 0, 1), 5.0), False)
pad = body.newObject("PartDesign::Pad", "PlatePad")
pad.Profile = sk
pad.Length = 10.0
sk.Visibility = False
doc.recompute()
return {"ok": True, "valid": pad.isValid()}
`, 60000);
  if (!assert("a PartDesign body was built", !body.__fail && body.valid === true,
      body.__fail || JSON.stringify(body))) {
    note("no body", "M6 has no subject");
  } else {
    const m6 = await measure({});
    const parts = m6.parts || [];
    assert("the body counts as a part", parts.indexOf("Plate") !== -1,
      JSON.stringify(parts));
    assert("its pad does not count as a second part",
      parts.indexOf("PlatePad") === -1, JSON.stringify(parts));
    assert("its sketch does not either", parts.indexOf("sk_plate") === -1,
      JSON.stringify(parts));
    const m6i = await measure({ interference: true });
    assert("so a body never interferes with its own feature",
      ((m6i.interference || {}).hits || [])
        .every((h) => h.a !== "PlatePad" && h.b !== "PlatePad"),
      JSON.stringify((m6i.interference || {}).hits));
  }

  // ---- M7: the lint rules that were promises ----
  console.log("\n--- M7: lint catches what the tree calls healthy ---");
  const loose = await probe(`
import FreeCAD as App, Part
from FreeCAD import Vector as V
doc = App.getDocument("${DOC}")
sk = doc.addObject("Sketcher::SketchObject", "sk_loose")
sk.addGeometry(Part.LineSegment(V(0, 0, 0), V(10, 0, 0)), False)
doc.recompute()
return {"ok": True, "valid": sk.isValid(), "state": list(sk.State)}
`);
  assert("an unconstrained sketch is created and reports healthy",
    !loose.__fail && loose.valid === true, loose.__fail || JSON.stringify(loose));
  const s7 = await sync();
  const codesFor = (name) =>
    (s7.lint || []).filter((w) => w.object === name).map((w) => w.code);
  assert("lint flags the free sketch that FreeCAD calls valid",
    codesFor("sk_loose").indexOf("dof") !== -1,
    JSON.stringify(s7.lint));

  const conflict = await probe(`
import FreeCAD as App, Sketcher
doc = App.getDocument("${DOC}")
sk = doc.getObject("sk_loose")
C = Sketcher.Constraint
sk.addConstraint(C("DistanceX", 0, 1, 0, 2, 10.0))
try:
    sk.addConstraint(C("DistanceX", 0, 1, 0, 2, 25.0))
except Exception as e:
    return {"ok": True, "rejected": str(e)}
doc.recompute()
return {"ok": True, "rejected": None,
        "conflicts": [int(x) for x in (sk.ConflictingConstraints or [])],
        "redundant": [int(x) for x in (sk.RedundantConstraints or [])]}
`);
  if (loose.__fail || conflict.__fail) {
    note("could not set up the constraint case", conflict.__fail);
  } else if (conflict.rejected) {
    note("the solver refused the contradictory constraint outright",
      "nothing lands in the document to lint — the platform caught it first");
  } else {
    const s7b = await sync();
    const cc = (s7b.lint || []).filter((w) => w.object === "sk_loose");
    assert("a conflicting or redundant constraint is reported",
      cc.some((w) => w.code === "conflicting-constraints" ||
        w.code === "redundant-constraints"),
      JSON.stringify({ lint: cc, probe: conflict }));
    assert("a conflict is an error, not a warning",
      !cc.some((w) => w.code === "conflicting-constraints") ||
        cc.find((w) => w.code === "conflicting-constraints").level === "error",
      JSON.stringify(cc));
  }

  // A dress-up feature has no datum alternative: it references an edge, which
  // is exactly the reference §8.1 wants reported rather than trusted.
  const picked = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
f = doc.addObject("Part::Fillet", "PickedFillet")
f.Base = doc.getObject("A")
f.Edges = [(1, 1.0, 1.0)]
doc.recompute()
return {"ok": True, "valid": f.isValid()}
`, 60000);
  const s7c = await sync();
  const topo = (s7c.lint || []).filter((w) => w.code === "topo-ref");
  if (picked.__fail) {
    note("no topological reference to lint", picked.__fail);
  } else {
    assert("a sub-element reference is reported", topo.length > 0,
      "no topo-ref in " + JSON.stringify((s7c.lint || []).map((w) => w.code)));
    if (topo.length) {
      console.log("   " + topo[0].message);
    }
  }

  const helix = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
h = doc.addObject("Part::Helix", "ModeledThread")
doc.recompute()
return {"ok": True}
`);
  if (!helix.__fail) {
    const s7d = await sync();
    assert("modeled thread geometry is flagged",
      (s7d.lint || []).some((w) => w.code === "modeled-thread"),
      JSON.stringify((s7d.lint || []).map((w) => w.code)));
  } else {
    note("this build has no Part::Helix", helix.__fail);
  }

  // ---- M8: deep rules stay out of the turn opener ----
  console.log("\n--- M8: the deep rules are opt-in ---");
  const shallow = await sync();
  const deep = await measure({ deepLint: true });
  const codes = (l) => (l || []).map((w) => w.code);
  assert("sync's lint does not walk face lists",
    codes(shallow.lint).indexOf("sliver-face") === -1 &&
      codes(shallow.lint).indexOf("open-shape") === -1,
    JSON.stringify(codes(shallow.lint)));
  assert("measure with deepLint returns a lint array",
    Array.isArray(deep.lint), JSON.stringify(deep.lint));
  assert("the deep lint is a superset of the cheap one",
    codes(shallow.lint).every((c) => codes(deep.lint).indexOf(c) !== -1),
    JSON.stringify({ shallow: codes(shallow.lint), deep: codes(deep.lint) }));
  const clean = (deep.lint || []).filter(
    (w) => w.object === "A" && (w.code === "sliver-face" || w.code === "open-shape"));
  assert("a clean box trips neither deep rule", clean.length === 0,
    JSON.stringify(clean));

  // ---- teardown ----
  console.log("\n--- teardown ---");
  const down = await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
return {"ok": True, "open": list(App.listDocuments().keys())}
`);
  assert("scratch document closed", !down.__fail, down.__fail);

  console.log("\n=== measure: " + pass + " passed, " + fail + " failed, " +
    warn + " notes ===");
  console.log("Valid ONLY for build " + build.exeVersion + " @ " +
    String(build.commit).slice(0, 12) + ", and only while the probe results hold.");

  return { success: fail === 0, pass, fail, warn, results,
    build: { version: build.exeVersion, commit: build.commit } };
}

return run().catch((e) => {
  if (e instanceof TransportLost) {
    const msg =
      "TRANSPORT LOST after " + pass + " passed / " + fail + " failed. The tab " +
      "stopped answering, most likely a snippet that never returned — the wasm " +
      "main thread cannot be interrupted. Reload the FreeCAD tab and re-run. " +
      "Everything above this line already happened and stands.\n\ndetail: " + e.message;
    console.error(msg);
    results.push("❌ transport lost — run aborted");
    return { success: false, pass, fail, warn, results, transportLost: true, error: msg };
  }
  throw e;
});
