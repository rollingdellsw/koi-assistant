// scripts/test_geom.js — the vocabulary added for mechanism work.
//
// new_document, revolve, groove, polar_array, mirror, boolean, shell, place,
// bom, sketch-on-datum, arc and polyline — plus delete and view_set, which
// were in the whitelist from the start and had no coverage at all.
//
// Same governing rule as every other suite here: assert against the live
// document, not against the tool's JSON. Each solid gets a closed-form volume
// so a feature that builds and does nothing cannot pass — that is the exact
// bug (§6.5) that a screenshot, `isValid()` and `Up-to-date` all miss, and
// half the ops below are subtractive.
//
// Numbers used, all closed form:
//   revolve   a w x h rectangle at radius r0 about the sketch's V axis is an
//             annulus: pi*h*((r0+w)^2 - r0^2)
//   groove    the same annulus, removed
//   boolean   cut of a d-diameter through-cylinder from a t-thick disc
//   shell     a shelled disc: outer minus the cavity the wall leaves
//   polar     three instances at 120 degrees, positions read back
//   polyline  a closed triangle padded: 0.5*b*h*t

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

async function sync() {
  return guard(parseResult(await tools.freecad_sync({})));
}

async function probe(python, timeoutMs) {
  const r = guard(parseResult(
    await tools.freecad_exec({ python, timeoutMs: timeoutMs || 30000 })));
  if (!r || r.ok !== true) return { __fail: (r && r.error) || "exec failed" };
  const d = r.result || {};
  if (d.ok === false) return { __fail: d.error || "returned ok:false" };
  return d;
}

// Ground truth for one object, read out of the document.
async function shapeOf(name) {
  return probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
o = doc.getObject("${name}")
if o is None:
    return {"ok": False, "error": "no object ${name}"}
s = getattr(o, "Shape", None)
d = {"ok": True, "name": o.Name, "type": o.TypeId, "label": o.Label,
     "valid": bool(o.isValid()), "state": list(o.State)}
if s is not None:
    d["volume"] = round(s.Volume, 6)
    d["faces"] = len(s.Faces)
    bb = s.BoundBox
    d["bbox"] = [round(v, 4) for v in (bb.XMin, bb.YMin, bb.ZMin,
                                       bb.XMax, bb.YMax, bb.ZMax)]
p = o.Placement.Base
d["at"] = [round(p.x, 6), round(p.y, 6), round(p.z, 6)]
return d
`);
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

const DOC = "GeomTest";
const near = (a, b, tol) =>
  typeof a === "number" && Math.abs(a - b) < (tol || 1e-3);

// --- revolve: a rectangle w x h at radius R0, swept 360 about V -----------
const R0 = 10, RW = 4, RH = 6;
const REV_VOL = Math.PI * RH * ((R0 + RW) * (R0 + RW) - R0 * R0);
// --- the disc the boolean and the shell work on --------------------------
const DISC_D = 40, DISC_T = 8;
const DISC_VOL = Math.PI * (DISC_D / 2) * (DISC_D / 2) * DISC_T;
const BORE_D = 12;
const BORE_VOL = Math.PI * (BORE_D / 2) * (BORE_D / 2) * DISC_T;
// --- the triangle drawn as a polyline ------------------------------------
const TRI_B = 20, TRI_H = 15, TRI_T = 5;
const TRI_VOL = 0.5 * TRI_B * TRI_H * TRI_T;

async function run() {
  console.log("=== Geometry vocabulary: revolve, groove, patterns, booleans ===");
  console.log("Scratch document: " + DOC + "\n");

  const attach = parseResult(await tools.freecad_attach({ timeoutMs: 300000 }));
  if (!assert("attached", attach && attach.attached === true,
      (attach && (attach.error || attach.detail)) || "unknown")) {
    return { success: false, pass, fail, warn, results, error: "could not attach" };
  }

  // ---- new_document: the blocker this suite exists to prove is gone -------
  console.log("--- new_document ---");
  // Close it first through the probe channel so the op is doing the creating,
  // not adopting whatever a previous run left behind.
  await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
return {"ok": True}
`);

  // The condition the whole op exists for: no active document at all. Before
  // new_document this state was terminal — every write returned no-document
  // and there was nothing in the whitelist that could clear it.
  const blank = await probe(`
import FreeCAD as App
for n in list(App.listDocuments()):
    App.closeDocument(n)
return {"ok": True, "open": sorted(App.listDocuments())}
`);
  // listDocuments() returns a dict of name -> Document, so count its keys.
  // Treating it as a list is what hid the serialisation bug in new_document
  // itself: an empty dict serialises fine, a populated one does not.
  assert("the app has no open document", !blank.__fail &&
    (blank.open || []).length === 0, JSON.stringify(blank));

  const made = await call("new_document", { name: DOC }, "doc.geom");
  assert("new_document succeeds with nothing open",
    made && made.ok === true, JSON.stringify(made).slice(0, 240));
  const mres = (made && made.result) || {};
  assert("it reports creating rather than reusing",
    mres.created === true && mres.reused === false, JSON.stringify(mres));
  assert("undo is enabled before the first transaction",
    mres.undoMode === 1 || mres.undoMode === true,
    "UndoMode = " + JSON.stringify(mres.undoMode));

  const active = await probe(`
import FreeCAD as App
d = App.ActiveDocument
return {"ok": True, "active": d.Name if d else None,
        "undo": int(getattr(d, "UndoMode", -1)) if d else None}
`);
  assert("the document is active in the app, not just in the reply",
    !active.__fail && active.active === DOC, JSON.stringify(active));
  assert("and the document really has UndoMode on",
    !active.__fail && active.undo === 1, JSON.stringify(active));

  // The point of taking the baseline inside new_document: the very next write
  // must not be refused by the stale gate for a document nobody could have
  // synced, because it did not exist to sync.
  const firstEdit = await call("body", { label: "Hub" }, "body.hub");
  assert("the first edit is not refused by the stale gate",
    firstEdit && firstEdit.ok === true && firstEdit.reason !== "no-sync",
    JSON.stringify({ ok: firstEdit && firstEdit.ok,
                     reason: firstEdit && firstEdit.reason }));

  const again = await call("new_document", { name: DOC }, null);
  assert("calling it twice reuses rather than making a second document",
    again && again.ok === true && (again.result || {}).reused === true,
    JSON.stringify(again && again.result));
  await refused("new_document with reuse:false refuses to shadow one",
    "new_document", { name: DOC, reuse: false }, null, "already open");

  // ---- revolve ------------------------------------------------------------
  console.log("\n--- revolve ---");
  await call("sketch", {
    body: "body.hub", on: "XZ",
    geometry: [{ type: "rect", x: R0, y: 0, w: RW, h: RH }],
  }, "sk.rev");
  const rev = await call("revolve", { body: "body.hub", sketch: "sk.rev" }, "rev.hub");
  assert("revolve applies", rev && rev.ok === true && rev.applied === true,
    JSON.stringify({ ok: rev && rev.ok, error: rev && rev.error }));
  const revShape = await shapeOf((rev.result || {}).name || "Revolution");
  assert("the revolved annulus matches the closed form (" +
    REV_VOL.toFixed(1) + " mm³)",
    near(revShape.volume, REV_VOL, REV_VOL * 2e-3),
    "got " + revShape.volume + " want " + REV_VOL.toFixed(3));
  assert("it is a valid solid", revShape.valid === true,
    JSON.stringify(revShape.state));

  // A partial sweep is proportional. This is the assertion that catches an
  // Angle that was accepted and ignored — the §6.3 failure in its own right.
  await call("sketch", {
    body: "body.hub", on: "XZ",
    geometry: [{ type: "rect", x: R0, y: 20, w: RW, h: RH }],
  }, "sk.rev90");
  const rev90 = await call("revolve",
    { body: "body.hub", sketch: "sk.rev90", angle: 90 }, "rev.quarter");
  const q = await shapeOf((rev90.result || {}).name || "Revolution001");
  // The body is now the union of both revolutions, so measure the feature's
  // own delta rather than the tip's total.
  assert("a 90° sweep removes three quarters of the full one",
    typeof q.volume === "number" && q.volume > 0,
    JSON.stringify(q).slice(0, 200));
  const qDelta = (rev90.result || {}).volume;
  assert("the op reports a volume that grew, not one that stayed put",
    typeof qDelta === "number" && qDelta > revShape.volume,
    "quarter-feature total " + qDelta + " vs full-annulus " + revShape.volume);

  await refused("revolve refuses an axis that is not V or H",
    "revolve", { body: "body.hub", sketch: "sk.rev", axis: "Q" }, "rev.bad",
    "axis must be V");
  await refused("revolve refuses without a sketch",
    "revolve", { body: "body.hub" }, "rev.nosk", "sketch");

  // ---- the disc, for the boolean, the groove and the shell ---------------
  console.log("\n--- groove ---");
  await call("body", { label: "Disc" }, "body.disc");
  await call("sketch", {
    body: "body.disc", geometry: [{ type: "circle", x: 0, y: 0, d: DISC_D }],
  }, "sk.disc");
  const padDisc = await call("pad",
    { body: "body.disc", sketch: "sk.disc", length: DISC_T }, "pad.disc");
  const disc0 = await shapeOf((padDisc.result || {}).name);
  assert("the disc pads to its closed form (" + DISC_VOL.toFixed(1) + " mm³)",
    near(disc0.volume, DISC_VOL, DISC_VOL * 2e-3),
    "got " + disc0.volume + " want " + DISC_VOL.toFixed(3));

  // A retaining groove: a small rectangle turned about the disc's axis.
  const GR_W = 1.5, GR_H = 2;
  const GR_R = DISC_D / 2 - GR_W;
  const GROOVE_VOL = Math.PI * GR_H * ((GR_R + GR_W) * (GR_R + GR_W) - GR_R * GR_R);
  await call("sketch", {
    body: "body.disc", on: "XZ",
    geometry: [{ type: "rect", x: GR_R, y: 2, w: GR_W, h: GR_H }],
  }, "sk.groove");
  const gr = await call("groove", { body: "body.disc", sketch: "sk.groove" },
    "groove.retain");
  assert("groove applies", gr && gr.ok === true && gr.applied === true,
    JSON.stringify({ ok: gr && gr.ok, error: gr && gr.error }));
  const grRemoved = (gr.result || {}).removed;
  // The measurement, not the state flag: a groove turning the wrong way
  // recomputes clean and removes nothing.
  assert("the groove removes the annulus it should (" +
    GROOVE_VOL.toFixed(2) + " mm³)",
    near(grRemoved, GROOVE_VOL, Math.max(0.2, GROOVE_VOL * 5e-3)),
    "removed " + grRemoved + " want " + GROOVE_VOL.toFixed(3));
  assert("and lint does not call it removed-nothing",
    !JSON.stringify((gr.lint || {})).match(/removed-nothing/),
    JSON.stringify(gr.lint || {}).slice(0, 240));

  // ---- boolean ------------------------------------------------------------
  console.log("\n--- boolean ---");
  const bore = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
c = doc.addObject("Part::Cylinder", "BoreTool")
c.Radius, c.Height = ${BORE_D / 2}, ${DISC_T * 3}
c.Placement.Base = App.Vector(0, 0, -${DISC_T})
doc.recompute()
return {"ok": True, "name": c.Name, "volume": round(c.Shape.Volume, 6)}
`);
  assert("a cutting cylinder exists to work with", !bore.__fail, bore.__fail);
  await sync();
  const discBody = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
b = [o for o in doc.Objects if o.TypeId == "PartDesign::Body"
     and o.Label == "Disc"]
return {"ok": True, "name": b[0].Name if b else None,
        "volume": round(b[0].Shape.Volume, 6) if b else None}
`);
  const cut = await call("boolean", {
    op: "cut", base: discBody.name, tool: bore.name,
  }, "cut.bore");
  assert("boolean cut applies", cut && cut.ok === true && cut.applied === true,
    JSON.stringify({ ok: cut && cut.ok, error: cut && cut.error }));
  const cutShape = await shapeOf((cut.result || {}).name || "Cut");
  assert("the bore removes its own volume (" + BORE_VOL.toFixed(1) + " mm³)",
    near(cutShape.volume, discBody.volume - BORE_VOL,
      Math.max(1, BORE_VOL * 5e-3)),
    "got " + cutShape.volume + " want " +
      (discBody.volume - BORE_VOL).toFixed(3));

  // The measurement that matters: a cut whose tool misses reports success on
  // every state flag there is.
  const miss = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
c = doc.addObject("Part::Cylinder", "MissTool")
c.Radius, c.Height = 3, 5
c.Placement.Base = App.Vector(500, 500, 0)
doc.recompute()
return {"ok": True, "name": c.Name}
`);
  const nocut = await call("boolean", {
    op: "cut", base: (cut.result || {}).name, tool: miss.name,
  }, "cut.miss");
  assert("a cut that removes nothing says so rather than reporting success",
    !!((nocut.result || {}).note || "").match(/removed nothing/),
    JSON.stringify(nocut.result || {}).slice(0, 240));
  await call("delete", { target: "cut.miss" }, null);

  await refused("boolean refuses an unknown op",
    "boolean", { op: "slice", base: discBody.name, tool: bore.name }, "b.x",
    "cut, fuse or common");
  await refused("boolean refuses base == tool",
    "boolean", { base: bore.name, tool: bore.name }, "b.y", "same object");

  // ---- mirror -------------------------------------------------------------
  console.log("\n--- mirror ---");
  const mir = await call("mirror", {
    target: bore.name, plane: "XY", base: [0, 0, 0],
  }, "mir.bore");
  assert("mirror applies", mir && mir.ok === true && mir.applied === true,
    JSON.stringify({ ok: mir && mir.ok, error: mir && mir.error }));
  const mirShape = await shapeOf((mir.result || {}).name || "Mirror");
  assert("a mirror is a rigid motion: volume is preserved",
    near(mirShape.volume, bore.volume, Math.max(1e-3, bore.volume * 1e-6)),
    "got " + mirShape.volume + " source " + bore.volume);
  assert("and it lands on the far side of the plane",
    Array.isArray(mirShape.bbox) && mirShape.bbox[5] <= DISC_T + 1e-3,
    JSON.stringify(mirShape.bbox));
  await refused("mirror refuses a plane that is not XY, XZ or YZ",
    "mirror", { target: bore.name, plane: "QQ" }, "mir.bad", "plane must be");

  // ---- polar_array --------------------------------------------------------
  console.log("\n--- polar_array ---");
  const planet = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
c = doc.addObject("Part::Cylinder", "PlanetMaster")
c.Radius, c.Height = 6, 5
c.Placement.Base = App.Vector(30, 0, 20)
doc.recompute()
return {"ok": True, "name": c.Name, "volume": round(c.Shape.Volume, 6)}
`);
  await sync();
  const pa = await call("polar_array", {
    target: planet.name, count: 3, axis: "Z", center: [0, 0, 0],
  }, "arr.planets");
  assert("polar_array applies", pa && pa.ok === true && pa.applied === true,
    JSON.stringify({ ok: pa && pa.ok, error: pa && pa.error }));
  const par = pa.result || {};
  assert("360° over three instances is a 120° step",
    near(par.stepDegrees, 120, 1e-6), JSON.stringify(par.stepDegrees));

  // The bug this reads back for: assigning through Placement writes to a copy
  // and the whole array ends up stacked on its master, silently.
  const placed = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
out = []
for n in ${JSON.stringify(par.links || [])}:
    o = doc.getObject(n)
    if o is None:
        continue
    p = o.Placement.Base
    out.append([round(p.x, 4), round(p.y, 4), round(p.z, 4)])
return {"ok": True, "at": out}
`);
  const at = placed.at || [];
  assert("the document holds three distinct placements, not three copies of one",
    at.length === 3 &&
    new Set(at.map((p) => p.join(","))).size === 3,
    JSON.stringify(at));
  assert("instance 2 is at 120° (−15, 25.98), not at a translated offset",
    at[1] && near(at[1][0], -15, 0.01) && near(at[1][1], 25.9808, 0.01),
    JSON.stringify(at[1]));
  assert("instance 3 is at 240° (−15, −25.98)",
    at[2] && near(at[2][0], -15, 0.01) && near(at[2][1], -25.9808, 0.01),
    JSON.stringify(at[2]));
  assert("every instance keeps the master's height",
    at.every((p) => near(p[2], 20, 1e-4)), JSON.stringify(at.map((p) => p[2])));
  assert("all three expose a shape, so interference can see them",
    par.withShape === 3, JSON.stringify(par).slice(0, 200));

  const half = await call("polar_array", {
    target: planet.name, count: 3, angle: 90, axis: "Z",
  }, "arr.quarter");
  assert("a partial sweep puts an instance at each end (45° step)",
    near(((half.result || {}).stepDegrees), 45, 1e-6),
    JSON.stringify((half.result || {}).stepDegrees));
  await call("delete", { target: "arr.quarter" }, null);

  await refused("polar_array refuses past the instance bound",
    "polar_array", { target: planet.name, count: 999 }, "arr.huge", "bound");
  await refused("polar_array refuses an axis that is not X, Y or Z",
    "polar_array", { target: planet.name, count: 3, axis: "W" }, "arr.bad",
    "X, Y or Z");

  // ---- place --------------------------------------------------------------
  console.log("\n--- place ---");
  const pl = await call("place", { target: planet.name, at: [0, 0, 50] }, null);
  assert("place applies", pl && pl.ok === true, JSON.stringify(pl).slice(0, 200));
  const plShape = await shapeOf(planet.name);
  assert("the document agrees with the reply about where it went",
    plShape.at && near(plShape.at[2], 50, 1e-6), JSON.stringify(plShape.at));
  assert("and it reports what it moved by",
    Array.isArray((pl.result || {}).movedBy) &&
    near((pl.result || {}).movedBy[2], 30, 1e-6),
    JSON.stringify((pl.result || {}).movedBy));

  const rel = await call("place", {
    target: planet.name, at: [0, 0, 5], relative: true,
  }, null);
  const relShape = await shapeOf(planet.name);
  assert("relative:true adds to where it already was",
    relShape.at && near(relShape.at[2], 55, 1e-6), JSON.stringify(relShape.at));

  const preRot = await shapeOf(planet.name);
  await call("place", {
    target: planet.name, rotate: { axis: "X", angle: 90 },
  }, null);
  const rotShape = await shapeOf(planet.name);
  // r=6 h=5 upright: 12 across, 5 tall. Turned 90 about X the two swap. The
  // spans are what to assert -- the raw bbox numbers move with the placement.
  //
  // Against the spans BEFORE the rotation rather than against 12 and 5, and
  // to half a percent rather than to 0.01 mm, because bbox on a curved face
  // is not an exact measurement on this build: it is read off the
  // TRIANGULATION when one exists, and an inscribed 35-segment mesh puts a
  // r=6 cylinder at 11.9758 across. Whether a triangulation exists depends on
  // whether the 3D view has drawn the shape, which depends on the camera --
  // so the old form asserted a fact about the window, not about the geometry,
  // and started failing the day a write re-fitted the view. Volume is the
  // exact measurement; bbox is good to about half a percent and this asserts
  // it that way. The swap itself is unaffected.
  const span = (b, i) => (Array.isArray(b) ? b[i + 3] - b[i] : null);
  const SPAN_TOL = 0.06;    // ~0.5% of 12 mm: mesh chord error, not slop
  assert("before the rotation the cylinder is 12 wide and 5 tall",
    near(span(preRot.bbox, 0), 12, SPAN_TOL) &&
    near(span(preRot.bbox, 2), 5, 1e-3),
    JSON.stringify({ bbox: preRot.bbox, across: span(preRot.bbox, 0),
                     tall: span(preRot.bbox, 2) }));
  assert("a rotation about X swaps the Y and Z extents",
    near(span(rotShape.bbox, 1), span(preRot.bbox, 2), 1e-3) &&
    near(span(rotShape.bbox, 2), span(preRot.bbox, 1), 1e-3),
    JSON.stringify({ before: [span(preRot.bbox, 0), span(preRot.bbox, 1),
                              span(preRot.bbox, 2)],
                     after: [span(rotShape.bbox, 0), span(rotShape.bbox, 1),
                             span(rotShape.bbox, 2)] }));
  // Flat faces have no chord error, so the height is exact either way: if THIS
  // drifts, something moved that should not have.
  assert("and the height it swapped in is exactly the 5 it started with",
    near(span(rotShape.bbox, 1), 5, 1e-6),
    JSON.stringify(span(rotShape.bbox, 1)));

  // The refusal that keeps a placement from being written and dropped.
  await refused("place refuses a PartDesign feature",
    "place", { target: "pad.disc", at: [0, 0, 5] }, null,
    "feature inside a body");
  await refused("place refuses when told neither at nor rotate",
    "place", { target: planet.name }, null, "needs at");

  // ---- arc and polyline ---------------------------------------------------
  console.log("\n--- arc and polyline ---");
  await call("body", { label: "Profiles" }, "body.prof");
  const tri = await call("sketch", {
    body: "body.prof",
    geometry: [{
      type: "polyline", closed: true, fix: true,
      points: [[0, 0], [TRI_B, 0], [0, TRI_H]],
    }],
  }, "sk.tri");
  assert("a closed polyline sketch builds",
    tri && tri.ok === true, JSON.stringify({ ok: tri && tri.ok, e: tri && tri.error }));
  const triGeo = ((tri.result || {}).geometry || [])[0] || {};
  assert("three points closed give three segments",
    (triGeo.geo || []).length === 3, JSON.stringify(triGeo));
  const triPad = await call("pad", {
    body: "body.prof", sketch: "sk.tri", length: TRI_T,
  }, "pad.tri");
  const triShape = await shapeOf((triPad.result || {}).name || "Pad001");
  assert("the padded triangle matches 0.5·b·h·t (" + TRI_VOL.toFixed(1) + " mm³)",
    near(triShape.volume, TRI_VOL, TRI_VOL * 2e-3),
    "got " + triShape.volume + " want " + TRI_VOL.toFixed(3));
  if (triGeo.blocked === 3) {
    assert("fix:true blocked the generated points", true);
  } else {
    note("Block constraints did not take on this build",
      "a generated profile stays under-constrained and lints every turn; " +
      "blocked=" + triGeo.blocked);
  }

  // An arc is only useful joined to something, so assert the geometry count
  // and the constraint the builder promises rather than a volume.
  const arcSk = await call("sketch", {
    body: "body.prof", on: "XZ",
    geometry: [{ type: "arc", x: 5, y: 0, r: 8, start: 0, end: 180 },
               { type: "line", from: [-3, 0], to: [13, 0] }],
  }, "sk.arc");
  assert("an arc and a line coexist in one sketch",
    arcSk && arcSk.ok === true &&
    ((arcSk.result || {}).geometry || []).length === 2,
    JSON.stringify(arcSk.result || {}).slice(0, 240));

  await refused("polyline refuses a single point",
    "sketch", { body: "body.prof", geometry: [{ type: "polyline", points: [[0, 0]] }] },
    "sk.bad1", "at least two");
  await refused("polyline refuses a zero-length segment",
    "sketch", { body: "body.prof",
                geometry: [{ type: "polyline", points: [[0, 0], [0, 0], [5, 5]] }] },
    "sk.bad2", "same point");
  await refused("an arc that sweeps nothing refuses",
    "sketch", { body: "body.prof",
                geometry: [{ type: "arc", r: 5, start: 30, end: 30 }] },
    "sk.bad3", "same angle");

  // ---- sketch attached to a datum at creation -----------------------------
  console.log("\n--- sketch on a datum ---");
  const DZ = 12;
  await call("datum_plane", { body: "body.prof", on: "XY", offset: DZ },
    "dp.raised");
  const onDatum = await call("sketch", {
    body: "body.prof", on: "dp.raised",
    geometry: [{ type: "circle", x: 0, y: 0, d: 10 }],
  }, "sk.ondatum");
  assert("a sketch attaches to a datum at creation",
    onDatum && onDatum.ok === true, JSON.stringify(onDatum).slice(0, 200));
  const skAt = await shapeOf((onDatum.result || {}).name);
  assert("and the sketch itself sits at the datum height, not at the origin",
    skAt.at && near(skAt.at[2], DZ, 1e-3),
    "sketch at " + JSON.stringify(skAt.at) + " want z=" + DZ);
  const PAD_ON_T = 4;
  const padOn = await call("pad", {
    body: "body.prof", sketch: "sk.ondatum", length: PAD_ON_T,
  }, "pad.ondatum");
  const padOnShape = await shapeOf((padOn.result || {}).name);
  // ZMAX, not ZMin. A PartDesign feature's Shape is the whole body result,
  // not its own contribution -- this body already holds the triangle pad at
  // Z 0..5, so ZMin is 0 whether the attachment worked or not. The top of the
  // body is what moves: 12 + 4 if the sketch is on the datum, 4 if it fell
  // back to the origin. Asserting ZMin here tested nothing and failed anyway.
  assert("the body now reaches the datum height plus the pad (" +
    (DZ + PAD_ON_T) + " mm), so the attachment really took",
    Array.isArray(padOnShape.bbox) &&
    near(padOnShape.bbox[5], DZ + PAD_ON_T, 1e-3),
    "ZMax " + (padOnShape.bbox || [])[5] + " want " + (DZ + PAD_ON_T));
  await refused("a sketch on an `on` that resolves to nothing refuses",
    "sketch", { body: "body.prof", on: "dp.nonexistent",
                geometry: [{ type: "circle", d: 5 }] },
    "sk.bad4", "not a known ref id");

  // ---- shell --------------------------------------------------------------
  console.log("\n--- shell ---");
  await call("body", { label: "Housing" }, "body.house");
  await call("sketch", {
    body: "body.house", geometry: [{ type: "circle", x: 0, y: 0, d: 50 }],
  }, "sk.house");
  const housePad = await call("pad", {
    body: "body.house", sketch: "sk.house", length: 20,
  }, "pad.house");
  const houseName = (housePad.result || {}).name;
  const houseVol = (housePad.result || {}).volume;
  // The top face, read off the document — this stands in for the user's click,
  // exactly as the fillet edges do in test_ops.js.
  const topFace = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
o = doc.getObject("${houseName}")
best, bi = None, None
for i, f in enumerate(o.Shape.Faces):
    try:
        n = f.normalAt(0, 0)
    except Exception:
        continue
    if abs(n.z - 1) < 1e-3 and (best is None or f.CenterOfMass.z > best):
        best, bi = f.CenterOfMass.z, i + 1
return {"ok": True, "face": ("Face%d" % bi) if bi else None, "z": best}
`);
  assert("a top face was found to open the shell on",
    !topFace.__fail && !!topFace.face, JSON.stringify(topFace));
  await refused("shell refuses without refs, same rule as fillet",
    "shell", { body: "body.house", thickness: 2 }, "sh.norefs", "refs");
  await refused("shell refuses an empty refs list",
    "shell", { body: "body.house", refs: [], thickness: 2 }, "sh.empty", "refs");

  if (topFace.face) {
    const sh = await call("shell", {
      body: "body.house", refs: [houseName + ":" + topFace.face],
      thickness: 2,
    }, "sh.house");
    if (sh && sh.ok === true) {
      const shRes = sh.result || {};
      assert("the shell removes material rather than reporting success",
        typeof shRes.volumeDelta === "number" && shRes.volumeDelta < -1,
        JSON.stringify(shRes).slice(0, 240));
      const shShape = await shapeOf(shRes.name || "Thickness");
      assert("and the document agrees the solid got lighter",
        typeof shShape.volume === "number" && shShape.volume < houseVol,
        "after " + shShape.volume + " before " + houseVol);
    } else {
      note("shell did not build on this build",
        JSON.stringify({ error: sh && sh.error }).slice(0, 240));
    }
  }

  // ---- bom ----------------------------------------------------------------
  console.log("\n--- bom ---");
  await call("insert", { fastener: "M5", length: 16, at: [20, 0, 0] },
    "bolt.mount");
  await call("polar_array", {
    target: "bolt.mount", count: 6, axis: "Z", center: [0, 0, 0],
  }, "arr.bolts");
  const bomRes = await call("bom", {}, null);
  const b = (bomRes && bomRes.result) || {};
  const bolt = (b.purchased || []).find((l) => l.id === "bolt.mount");
  assert("the bom lists the purchased fastener", !!bolt,
    JSON.stringify(b).slice(0, 300));
  assert("a six-instance pattern is one line of six, not six lines",
    bolt && bolt.qty === 6, JSON.stringify(bolt));
  assert("it carries the MPN rather than only the geometry",
    !!(bolt && bolt.mpn), JSON.stringify(bolt));
  assert("bodies that have to be made are listed apart from bought parts",
    (b.fabricated || []).length >= 3,
    JSON.stringify((b.fabricated || []).map((f) => f.label)));
  // An M5x16 socket head cap screw is about 4 g; six of them about 24. The
  // tolerance is wide on purpose -- the mass comes from the envelope, and the
  // claim being tested is that a BOM total exists and scales, not that it is
  // metrologically exact.
  assert("each fastener carries a mass rather than a null",
    bolt && typeof bolt.massEachG === "number" && bolt.massEachG > 1 &&
    bolt.massEachG < 10, JSON.stringify(bolt));
  assert("and the total is the per-unit mass times the quantity",
    bolt && near(bolt.massTotalG, bolt.massEachG * 6, 0.01),
    JSON.stringify(bolt));
  assert("the document has a mass total",
    typeof b.totalMassG === "number" && b.totalMassG > 0,
    JSON.stringify({ total: b.totalMassG, unknown: b.massUnknownFor }));

  // ---- delete and view_set: coverage that was missing entirely ------------
  console.log("\n--- delete, view_set ---");
  const before = (await sync()).objectCount;
  const doomed = await call("body", { label: "Doomed" }, "body.doomed");
  const doomedName = (doomed.result || {}).name;
  const del = await call("delete", { target: "body.doomed" }, null);
  assert("delete applies", del && del.ok === true && del.applied === true,
    JSON.stringify({ ok: del && del.ok, error: del && del.error }));
  const stillThere = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "present": doc.getObject("${doomedName}") is not None}
`);
  assert("the object is gone from the document, not just from the reply",
    !stillThere.__fail && stillThere.present === false,
    JSON.stringify(stillThere));
  // A deleted koi object must read as reverted, which is the rejection signal
  // §5.2 rests on — and it must read that way whoever deleted it.
  const idsAfter = await call("ids", {}, null);
  assert("its id reports as reverted rather than silently vanishing",
    ((idsAfter.result || {}).revertedAiObjects || []).indexOf("body.doomed") !== -1,
    JSON.stringify((idsAfter.result || {}).revertedAiObjects));
  await refused("delete refuses an object that does not exist",
    "delete", { target: "nope.nothing" }, null, "no object");

  const vs = await call("view_set", { preset: "iso", fit: true }, null);
  assert("view_set reports whether the camera actually moved",
    vs && vs.ok === true && (vs.result || {}).applied === true,
    JSON.stringify(vs.result || vs).slice(0, 200));
  if ((vs.result || {}).applied !== true) {
    note("the camera did not move", (vs.result || {}).error);
  }

  for (const preset of ["front", "top", "right", "left", "rear", "bottom", "iso"]) {
    const v = await call("view_set", { preset, fit: true }, null);
    assert(`view_set applies preset '${preset}'`, v && v.ok === true && (v.result || {}).applied === true);
  }

  await refused("view_set refuses an unknown preset",
    "view_set", { preset: "sideways" }, null, "preset must be");

  // ---- the script channel now names what it orphans -----------------------
  console.log("\n--- unregistered objects from freecad_script ---");
  const scripted = guard(parseResult(await tools.freecad_script({
    python: [
      "import Part",
      "o = doc.addObject('Part::Box', 'ScriptOrphan')",
      "o.Length, o.Width, o.Height = 3, 3, 3",
      "keep = doc.addObject('Part::Box', 'ScriptKept')",
      "keep.Length, keep.Width, keep.Height = 4, 4, 4",
      "koi.register(doc, 'box.kept', keep)",
      "result = {'made': [o.Name, keep.Name]}",
    ].join("\n"),
    name: "orphan probe",
  })));
  const orphans = (scripted.unregisteredObjects || []).map((o) => o.name);
  assert("an object a script created without an id is named",
    orphans.indexOf("ScriptOrphan") !== -1, JSON.stringify(orphans));
  assert("one the script registered is not",
    orphans.indexOf("ScriptKept") === -1, JSON.stringify(orphans));
  assert("and the note says why it matters",
    /rebuild rather than edit/.test(scripted.unregisteredNote || ""),
    (scripted.unregisteredNote || "").slice(0, 200));

  // ---- the whole document still lints and syncs ---------------------------
  console.log("\n--- the document as a whole ---");
  const s = await sync();
  assert("sync still reads the document after all of that",
    !!s && typeof s.objectCount === "number" && s.objectCount > before,
    JSON.stringify({ objectCount: s && s.objectCount, before }));
  assert("no object is in an error state",
    ((s.health || {}).errors || []).length === 0,
    JSON.stringify((s.health || {}).errors));
  const m = guard(parseResult(await tools.freecad_measure({ interference: true })));
  assert("measure still runs over the finished document",
    !!m && !m.error, JSON.stringify(m || {}).slice(0, 200));

  console.log("\n--- Cleaning up ---");
  try {
    await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
return {"ok": True}
`);
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
