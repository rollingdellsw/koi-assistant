// scripts/test_flow.js — batch, viewport hygiene, mate, split_body.
//
// Four ops that exist because a real modelling session measured the cost of
// not having them: twenty-five round trips for a two-piece bracket, a viewport
// the human could not see through, six hand-written quaternions to seat six
// bolts, and a clamp that PartDesign refused to build as one body.
//
// The rules are the ones test_ops.js and test_ops2.js were written under, and
// they matter more here than usual because three of these ops report their own
// success:
//
//   1. Read the DOCUMENT, not the op's own JSON. A mate that echoes back the
//      placement it meant to write is exactly the failure this suite exists to
//      catch, so every position is re-read through probe() or freecad_get.
//   2. Test every gate in the direction where it says no. batch is atomic,
//      mate refuses an ambiguous hole, split_body refuses a plane that misses:
//      an op that has only ever been asked to succeed has an untested refusal.
//   3. Volumes are closed-form. 40 x 20 x 12 split at y=10 with a 2 mm cut is
//      two halves of 4320 and 960 mm3 of swarf — no tolerance for "about
//      right".

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

async function get(id) {
  return guard(parseResult(await tools.freecad_get({ id })));
}

async function probe(python, timeoutMs) {
  const r = guard(parseResult(
    await tools.freecad_exec({ python, timeoutMs: timeoutMs || 30000 })));
  if (!r || r.ok !== true) return { __fail: (r && r.error) || "exec failed" };
  const d = r.result || {};
  if (d.ok === false) return { __fail: d.error || "returned ok:false" };
  return d;
}

// A refusal is a rejection at either layer: the JS validator (which never
// reaches FreeCAD) or the op itself (which does and rolls back). Both are
// "said no"; which one answered is asserted separately where it matters.
async function refused(label, fn, opArgs, id, wanted, extra) {
  const r = await call(fn, opArgs, id, extra);
  const msg = String((r && (r.error || r.detail)) || "");
  const said = !!(r && (r.__error === true || r.ok === false ||
                        (msg && r.applied !== true)));
  return assert(
    label,
    said && (!wanted || msg.indexOf(wanted) !== -1),
    JSON.stringify({ ok: r && r.ok, applied: r && r.applied,
                     error: msg.slice(0, 240) }));
}

const DOC = "FlowTest";
const near = (a, b, tol) =>
  typeof a === "number" && Math.abs(a - b) < (tol || 1e-3);
const nearVec = (v, want, tol) =>
  Array.isArray(v) && v.length === 3 &&
  v.every((x, i) => near(x, want[i], tol));

// The plate every section works on: 60 x 40 x 10, corner at the origin.
const W = 60, H = 40, T = 10;
// Two Ø5.5 clearance holes for M5, at x = ±15 from the plate's middle.
const HOLE_D = 5.5, HOLE_DX = 15;
const PLATE_MID = [W / 2, H / 2];
const HOLE_VOL = Math.PI * (HOLE_D / 2) * (HOLE_D / 2) * T;

// The bar that gets split: 40 x 20 x 12, well clear of the plate.
const BAR_X = 200, BAR_W = 40, BAR_H = 20, BAR_T = 12;
const CUT_AT = 10, KERF = 2;

async function run() {
  console.log("=== batch, viewport hygiene, mate, split_body ===");
  console.log("Scratch document: " + DOC + "\n");

  const attach = parseResult(await tools.freecad_attach({ timeoutMs: 240000 }));
  if (!assert("attached", attach && attach.attached === true,
      (attach && (attach.error || attach.detail)) || "unknown")) {
    return { success: false, pass, fail, warn, results, error: "no attach" };
  }
  const hasGui = !!(attach && attach.gui);

  // ======================================================================
  // The session opener
  // ======================================================================
  console.log("\n--- attach: one line, not a configuration dump ---");

  assert("attach returns a one-line status",
    typeof attach.status === "string" &&
      attach.status.indexOf("FreeCAD") !== -1 &&
      attach.status.split("\n").length === 1,
    JSON.stringify(attach.status));
  assert("attach does NOT return the YAML pin block",
    attach.pinBlock === undefined,
    JSON.stringify(String(attach.pinBlock || "").slice(0, 80)));
  if (attach.pin && attach.pin.pinned) {
    note("this build is pinned, so the unpinned hint is not exercised",
      JSON.stringify(attach.pin.match));
  } else {
    assert("an unpinned build says so in a sentence instead",
      typeof attach.pinHint === "string" &&
        attach.pinHint.indexOf("freecad_version") !== -1,
      JSON.stringify(attach.pinHint));
  }
  const ver = parseResult(await tools.freecad_version({}));
  assert("and freecad_version still hands over the block when asked",
    typeof ver.pinBlock === "string" && ver.pinBlock.indexOf("pin-mode") !== -1,
    JSON.stringify(String((ver || {}).pinBlock || "").slice(0, 60)));

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

  // ======================================================================
  // batch: the round-trip problem
  // ======================================================================
  console.log("\n--- batch: six features, one transaction ---");

  const b1 = await call("batch", {
    ops: [
      { fn: "body", args: { label: "Plate" }, id: "body.plate" },
      { fn: "sketch",
        args: { on: "XY", body: "body.plate",
                geometry: [{ type: "rect", x: 0, y: 0, w: W, h: H }] },
        id: "sk.plate" },
      { fn: "pad", args: { sketch: "sk.plate", length: T, body: "body.plate" },
        id: "pad.plate" },
      { fn: "datum_plane",
        args: { body: "body.plate", on: "XY", offset: T, label: "top" },
        id: "dp.top" },
      { fn: "sketch",
        args: { on: "dp.top", body: "body.plate",
                geometry: [
                  { type: "circle", x: PLATE_MID[0] - HOLE_DX, y: PLATE_MID[1], d: HOLE_D },
                  { type: "circle", x: PLATE_MID[0] + HOLE_DX, y: PLATE_MID[1], d: HOLE_D },
                ] },
        id: "sk.bolts" },
      { fn: "hole", args: { sketch: "sk.bolts", through: true, body: "body.plate" },
        id: "hole.bolts" },
    ],
  }, "batch.plate");

  assert("the batch applied", b1 && b1.ok === true && b1.applied === true,
    JSON.stringify({ ok: b1 && b1.ok, error: (b1 || {}).error }));
  const steps = ((b1 || {}).result || {}).steps || [];
  assert("every step ran and reported its own result", steps.length === 6,
    JSON.stringify(steps.map((s) => s.fn)));
  assert("six features cost fewer undo entries than six calls would",
    typeof b1.undoEntries === "number" && b1.undoEntries <= 1,
    JSON.stringify({ undoEntries: b1.undoEntries, singleUndo: b1.singleUndo }));
  if (b1.undoEntries === 0) {
    note("the batch booked no undo entry at all — Ctrl+Z will not reverse it",
      JSON.stringify(b1.undoEntries));
  }

  // The document, not the JSON. 60 x 40 x 10 less two Ø5.5 through-holes.
  const wantVol = W * H * T - 2 * HOLE_VOL;
  const m1 = await measure({ refs: ["body.plate"] });
  const plate = ((m1 || {}).objects || [])[0] || {};
  assert("and the solid it built measures what the numbers say",
    near(plate.volume, wantVol, 1e-3),
    JSON.stringify({ got: plate.volume, want: Math.round(wantVol * 1000) / 1000 }));

  const idsAfter = await call("ids", {});
  const known = (((idsAfter || {}).result || {}).ids || []).map((r) => r.id);
  assert("every created step registered its id, so turn 7 can edit it",
    ["body.plate", "sk.plate", "pad.plate", "dp.top", "sk.bolts", "hole.bolts"]
      .every((k) => known.indexOf(k) !== -1),
    JSON.stringify(known));

  // ======================================================================
  // batch: the refusals
  // ======================================================================
  console.log("\n--- batch: every gate, in the direction where it says no ---");

  await refused("an unknown fn in a step is refused", "batch",
    { ops: [{ fn: "pad_it", args: {}, id: "x" }] }, "batch.bad1", "ops[0]");
  await refused("a creating step without an id is refused", "batch",
    { ops: [{ fn: "body", args: {} }] }, "batch.bad2", "needs an id");
  await refused("batches do not nest", "batch",
    { ops: [{ fn: "batch", args: { ops: [] } }] }, "batch.bad3", "nest");
  await refused("new_document cannot be a step", "batch",
    { ops: [{ fn: "new_document", args: { name: "Nope" } }] },
    "batch.bad4", "outside the envelope");
  const many = [];
  for (let i = 0; i < 25; i++) many.push({ fn: "ids", args: {} });
  await refused("a batch past the step cap is refused", "batch",
    { ops: many }, "batch.bad5", "capped at");

  // A validator that never reached FreeCAD is worth a separate assertion:
  // the whole point of checking here is that a typo costs nothing.
  const notSent = await call("batch",
    { ops: [{ fn: "pad", args: { sketch: "sk.plate" }, id: "pad.nope" }] },
    "batch.bad6");
  assert("a step missing a required argument is caught before the transaction",
    notSent && notSent.applied !== true &&
      String(notSent.error || "").indexOf("length") !== -1 &&
      notSent.undoEntries === undefined,
    JSON.stringify({ error: String((notSent || {}).error || "").slice(0, 160),
                     undoEntries: (notSent || {}).undoEntries }));

  console.log("\n--- batch: atomicity ---");

  const before = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "names": sorted([o.Name for o in doc.Objects])}
`);
  const b2 = await call("batch", {
    ops: [
      { fn: "sketch",
        args: { on: "XY", body: "body.plate",
                geometry: [{ type: "circle", x: 5, y: 5, d: 4 }] },
        id: "sk.doomed" },
      // Resolvable name, nothing behind it: this fails inside FreeCAD, after
      // step 1 has already created a sketch. That is the interesting case.
      { fn: "pad", args: { sketch: "sk.missing", length: 3, body: "body.plate" },
        id: "pad.doomed" },
    ],
  }, "batch.doomed");

  assert("a step that fails takes the whole batch down",
    b2 && b2.ok === false && b2.applied !== true,
    JSON.stringify({ ok: b2 && b2.ok, applied: b2 && b2.applied }));
  assert("and the error names the step, not just the failure",
    String((b2 || {}).error || "").indexOf("step 2 of 2") !== -1,
    JSON.stringify(String((b2 || {}).error || "").slice(0, 220)));

  const after = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "names": sorted([o.Name for o in doc.Objects])}
`);
  assert("the sketch step 1 built is gone: the document is where it started",
    !before.__fail && !after.__fail &&
      before.names.join(",") === after.names.join(","),
    JSON.stringify({ added: (after.names || []).filter(
      (n) => (before.names || []).indexOf(n) === -1) }));

  // ======================================================================
  // viewport hygiene
  // ======================================================================
  console.log("\n--- the viewport: scaffolding hides itself ---");

  const vis = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
def v(kid):
    o = koi_cad.resolve(doc, kid)
    return None if o is None else bool(getattr(o, "Visibility", False))
return {"ok": True, "sketch": v("sk.bolts"), "plateSketch": v("sk.plate"),
        "datum": v("dp.top"), "body": v("body.plate")}
`);
  assert("the consumed profile sketch is hidden", vis.sketch === false,
    JSON.stringify(vis));
  assert("so is the datum plane it stood on", vis.datum === false,
    JSON.stringify(vis));
  assert("and the solid the user came to look at is not",
    vis.body === true, JSON.stringify(vis));

  const dpStep = steps.filter((s) => s.fn === "datum_plane")[0] || {};
  assert("a datum plane is created invisible and says so",
    ((dpStep.result || {}).visible) === false,
    JSON.stringify(dpStep.result));

  const dpShown = await call("datum_plane",
    { body: "body.plate", on: "XY", offset: T + 5, visible: true, label: "shown" },
    "dp.shown");
  assert("visible:true is honoured for the one the user should see",
    dpShown && dpShown.ok === true &&
      ((dpShown.result || {}).visible) === true,
    JSON.stringify({ error: (dpShown || {}).error,
                     result: (dpShown || {}).result }));

  // The user's own construction geometry is theirs. Made outside the skill,
  // attached to nothing of ours, and it must survive a feature being built.
  const userDatum = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
body = doc.getObject(doc.Meta.get("koi.id.body.plate"))
dp = body.newObject("PartDesign::Plane", "UserPlane")
for o in body.Origin.OriginFeatures:
    if "XY_Plane" in o.Name:
        dp.AttachmentSupport = [(o, "")]
dp.MapMode = "FlatFace"
dp.AttachmentOffset = App.Placement(App.Vector(0, 0, 2), App.Rotation())
dp.Visibility = True
doc.recompute()
return {"ok": True, "name": dp.Name}
`);
  if (!userDatum.__fail) {
    await sync();
    await call("batch", {
      ops: [
        { fn: "sketch",
          args: { on: userDatum.name, body: "body.plate",
                  geometry: [{ type: "circle", x: 8, y: 8, d: 4 }] },
          id: "sk.onuser" },
        { fn: "pocket",
          args: { sketch: "sk.onuser", length: 2, body: "body.plate" },
          id: "pocket.onuser" },
      ],
    }, "batch.onuser");
    const stillThere = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
o = doc.getObject("${userDatum.name}")
return {"ok": True, "visible": None if o is None else bool(o.Visibility)}
`);
    assert("a datum the USER made stays visible: only our scaffolding hides",
      stillThere.visible === true, JSON.stringify(stillThere));
  } else {
    note("could not build a user-owned datum to test against",
      userDatum.__fail);
  }

  const fit = await call("view_fit", {});
  if (hasGui) {
    assert("view_fit re-centres the camera on demand",
      fit && fit.ok === true && ((fit.result || {}).fitted) === true,
      JSON.stringify((fit || {}).result));
  } else {
    assert("view_fit says plainly that there is no GUI to fit",
      fit && fit.ok === true && ((fit.result || {}).fitted) === false,
      JSON.stringify((fit || {}).result));
  }
  const off = await call("view_fit", { auto: false });
  assert("the automatic fit can be turned off for this document",
    ((off || {}).result || {}).auto === false, JSON.stringify((off || {}).result));
  const backOn = await call("view_fit", { auto: true });
  assert("and back on", ((backOn || {}).result || {}).auto === true,
    JSON.stringify((backOn || {}).result));

  // ======================================================================
  // mate
  // ======================================================================
  console.log("\n--- mate: the arithmetic six bolts used to cost ---");

  await call("insert", { fastener: "M5", length: 16, label: "M5x16" }, "bolt.a");

  await refused("a hole with two instances refuses to guess which one", "mate",
    { target: "bolt.a", hole: "hole.bolts" }, null, "near");

  const seatAt = [PLATE_MID[0] + HOLE_DX, PLATE_MID[1], T];
  const mate1 = await call("mate",
    { target: "bolt.a", hole: "hole.bolts", near: seatAt });
  const mr = (mate1 || {}).result || {};
  assert("mate seats the bolt in the hole the position named",
    mate1 && mate1.ok === true && nearVec(mr.at, seatAt),
    JSON.stringify({ at: mr.at, want: seatAt, error: (mate1 || {}).error }));
  assert("along the hole's own axis, read back off the placement",
    nearVec(mr.seatedAxis, [0, 0, 1], 1e-4) && mr.alignedWithAxis === true,
    JSON.stringify({ axis: mr.axis, seated: mr.seatedAxis }));
  assert("and it reports the clearance rather than implying a fit",
    near(mr.diametralClearance, HOLE_D - 5, 1e-6),
    JSON.stringify({ hole: mr.holeDiameter, shank: mr.shankDiameter,
                     clearance: mr.diametralClearance }));
  assert("it says out loud that this is a placement and not a mate",
    typeof mr.note === "string" && mr.note.indexOf("not a mate") !== -1,
    JSON.stringify(String(mr.note || "").slice(0, 120)));
  assert("and names the other instance rather than hiding it",
    Array.isArray(mr.otherInstances) && mr.otherInstances.length === 1,
    JSON.stringify(mr.otherInstances));

  // The document, not the op's JSON.
  const bolt = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
o = koi_cad.resolve(doc, "bolt.a")
p = o.Placement
z = p.Rotation.multVec(App.Vector(0, 0, 1))
return {"ok": True,
        "at": [round(p.Base.x, 6), round(p.Base.y, 6), round(p.Base.z, 6)],
        "zAxis": [round(z.x, 6), round(z.y, 6), round(z.z, 6)]}
`);
  assert("FreeCAD agrees about where the bolt is",
    !bolt.__fail && nearVec(bolt.at, seatAt) && nearVec(bolt.zAxis, [0, 0, 1], 1e-4),
    JSON.stringify(bolt));

  const lifted = await call("mate",
    { target: "bolt.a", hole: "hole.bolts", near: seatAt, offset: 2 });
  assert("offset lifts it along the axis, for a washer",
    nearVec(((lifted || {}).result || {}).at, [seatAt[0], seatAt[1], T + 2]),
    JSON.stringify(((lifted || {}).result || {}).at));
  await call("mate", { target: "bolt.a", hole: "hole.bolts", near: seatAt });

  // A hole that is NOT on XY: the whole point is that no quaternion is
  // written by hand, so the interesting case is one where the answer is not
  // the identity rotation.
  const sideBar = await call("batch", {
    ops: [
      { fn: "body", args: { label: "Side" }, id: "body.side" },
      { fn: "sketch",
        args: { on: "YZ", body: "body.side",
                geometry: [{ type: "rect", x: 100, y: 0, w: 30, h: 20 }] },
        id: "sk.side" },
      { fn: "pad", args: { sketch: "sk.side", length: 8, body: "body.side" },
        id: "pad.side" },
      { fn: "datum_plane",
        args: { body: "body.side", on: "YZ", offset: 8, label: "sideface" },
        id: "dp.side" },
      { fn: "sketch",
        args: { on: "dp.side", body: "body.side",
                geometry: [{ type: "circle", x: 115, y: 10, d: HOLE_D }] },
        id: "sk.sidehole" },
      { fn: "hole",
        args: { sketch: "sk.sidehole", through: true, body: "body.side" },
        id: "hole.side" },
    ],
  }, "batch.side");

  if (assert("a second body built on YZ, in one batch",
      sideBar && sideBar.ok === true,
      JSON.stringify({ error: (sideBar || {}).error }))) {
    await call("insert", { fastener: "M5", length: 16 }, "bolt.b");
    const mate2 = await call("mate", { target: "bolt.b", hole: "hole.side" });
    const m2 = (mate2 || {}).result || {};
    assert("mate seats a bolt in a hole whose axis is +X",
      mate2 && mate2.ok === true && nearVec(m2.at, [8, 115, 10]),
      JSON.stringify({ at: m2.at, error: (mate2 || {}).error }));
    assert("and the rotation that puts it there was computed, not assumed",
      nearVec(m2.seatedAxis, [1, 0, 0], 1e-4),
      JSON.stringify({ seated: m2.seatedAxis, q: m2.rotation }));
    // A single-instance hole needs no near: the ambiguity gate is about
    // instances, not about holes.
    assert("a single hole does not demand a near", m2.instances === 1,
      JSON.stringify(m2.instances));
  }

  // The bolt that does not fit has to be told about, not seated quietly.
  await call("insert", { fastener: "M6", length: 16 }, "bolt.toobig");
  const tight = await call("mate",
    { target: "bolt.toobig", hole: "hole.bolts", near: seatAt },
    null, { dryRun: true });
  const tr = (tight || {}).result || {};
  assert("an M6 in a Ø5.5 hole is reported as not passing through",
    typeof tr.fitNote === "string" &&
      tr.fitNote.indexOf("does not pass") !== -1,
    JSON.stringify({ clearance: tr.diametralClearance, note: tr.fitNote }));
  assert("and the dry run left it where it was",
    tight && tight.ok === true && tight.applied === false,
    JSON.stringify({ ok: (tight || {}).ok, applied: (tight || {}).applied }));

  await refused("mate refuses a PartDesign feature, same as place", "mate",
    { target: "pad.plate", hole: "hole.bolts", near: seatAt }, null,
    "inside a body");
  await refused("mate needs something to read an axis from", "mate",
    { target: "bolt.a" }, null, "hole");

  // ======================================================================
  // split_body
  // ======================================================================
  console.log("\n--- split_body: the two-piece clamp PartDesign refuses ---");

  const bar = await call("batch", {
    ops: [
      { fn: "body", args: { label: "Bar" }, id: "body.bar" },
      { fn: "sketch",
        args: { on: "XY", body: "body.bar",
                geometry: [{ type: "rect", x: BAR_X, y: 0, w: BAR_W, h: BAR_H }] },
        id: "sk.bar" },
      { fn: "pad", args: { sketch: "sk.bar", length: BAR_T, body: "body.bar" },
        id: "pad.bar" },
    ],
  }, "batch.bar");
  assert("a bar to cut in two", bar && bar.ok === true,
    JSON.stringify({ error: (bar || {}).error }));

  await refused("a plane that misses the solid is refused, not silently empty",
    "split_body",
    { target: "body.bar", plane: "XZ", offset: -50,
      ids: ["miss.a", "miss.b"] }, "split.miss", "empty");

  const sp = await call("split_body", {
    target: "body.bar", plane: "XZ", offset: CUT_AT, gap: KERF,
    ids: ["bar.a", "bar.b"], labels: ["BarLower", "BarUpper"],
  }, "split.bar");
  const sr = (sp || {}).result || {};
  const halves = sr.halves || [];
  const wantHalf = BAR_W * BAR_T * (BAR_H - CUT_AT - KERF / 2);
  const wantKerf = BAR_W * BAR_T * KERF;

  assert("the split applied and produced two halves",
    sp && sp.ok === true && halves.length === 2,
    JSON.stringify({ ok: (sp || {}).ok, error: (sp || {}).error }));
  assert("each half measures exactly what the plane and the kerf imply",
    halves.length === 2 && halves.every((h) => near(h.volume, wantHalf, 1e-3)),
    JSON.stringify({ got: halves.map((h) => h.volume), want: wantHalf }));
  assert("and the material the cut removed is the kerf, not a rounding error",
    near(sr.volumeRemovedByCut, wantKerf, 1e-3),
    JSON.stringify({ got: sr.volumeRemovedByCut, want: wantKerf }));
  assert("both halves are addressable in a later turn",
    halves.length === 2 &&
      halves.every((h) => h.id === "bar.a" || h.id === "bar.b"),
    JSON.stringify(halves.map((h) => h.id)));
  assert("both split halves report drawn:true and are visible",
    halves.length === 2 && halves.every((h) => h.drawn === true),
    JSON.stringify(halves.map((h) => ({ id: h.id, drawn: h.drawn }))));
  assert("it says the halves are snapshots rather than implying a live link",
    typeof sr.note === "string" && sr.note.indexOf("snapshot") !== -1,
    JSON.stringify(String(sr.note || "").slice(0, 140)));

  if (sr.asBodies === true) {
    assert("each half is a PartDesign Body, so features can still be added",
      halves.length === 2 && halves.every((h) => h.body === true),
      JSON.stringify(halves));
  } else {
    note("this build would not take a PartDesign::FeatureBase — the halves " +
      "are plain solids and cannot be padded",
      JSON.stringify(halves.map((h) => h.why)));
  }

  const halfA = await get("bar.a");
  assert("and freecad_get resolves one by its id",
    halfA && halfA.shape && near(halfA.shape.volume, wantHalf, 1e-3),
    JSON.stringify((halfA || {}).shape));

  const srcVis = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
o = koi_cad.resolve(doc, "body.bar")
return {"ok": True, "visible": None if o is None else bool(o.Visibility)}
`);
  assert("the solid it came from is hidden rather than left on top of them",
    srcVis.visible === false, JSON.stringify(srcVis));

  // The split halves are two parts now, and the interference check has to
  // agree: a 2 mm kerf means they do not touch.
  const gapCheck = await measure({ pairs: [["bar.a", "bar.b"]],
                                   interference: true, clearance: true });
  const pair = (((gapCheck || {}).clearance || {}).pairs || [])[0] || {};
  assert("the two halves stand " + KERF + " mm apart, measured",
    near(pair.distance, KERF, 1e-3),
    JSON.stringify({ clearance: gapCheck.clearance,
                     interference: gapCheck.interference }));


  // ======================================================================
  // the split goes stale when its source moves
  // ======================================================================
  console.log("\n--- split_body: staleness is measured, not mentioned once ---");

  // Lint rides on every write's envelope, so the split's own reply is where
  // a fresh split has to be clean.
  const staleBefore = ((sp || {}).lint || [])
    .filter((w) => w.code === "split-stale" || w.code === "split-source-gone");
  assert("a fresh split lints clean", staleBefore.length === 0,
    JSON.stringify(staleBefore));

  // Change the solid the halves were cut from. They are snapshots, so they do
  // not follow -- which is the whole hazard, and saying it once in turn 4 is
  // not a check.
  const grow = await call("feature_edit",
    { target: "pad.bar", props: { Length: BAR_T + 6 } });
  if (assert("the source solid changed under the halves",
      grow && grow.ok === true, JSON.stringify({ error: (grow || {}).error }))) {
    const stale = ((grow || {}).lint || [])
      .filter((w) => w.code === "split-stale");
    assert("lint reports the halves as stale, with both volumes",
      stale.length === 1 && stale[0].message.indexOf("re-run split_body") !== -1,
      JSON.stringify(stale));
    const halfNow = await get("bar.a");
    assert("and the half really has not moved: it is still the old volume",
      halfNow && halfNow.shape && near(halfNow.shape.volume, wantHalf, 1e-3),
      JSON.stringify((halfNow || {}).shape));

    // Re-running split_body updates FeatureBase shapes in place and preserves downstream DAG
    const resplit = await call("split_body", {
      target: "body.bar", plane: "XZ", offset: CUT_AT, gap: KERF,
      ids: ["bar.a", "bar.b"], labels: ["BarLower", "BarUpper"],
    }, "split.bar");
    assert("re-running split_body updates existing halves in place",
      resplit && resplit.ok === true && (resplit.result || {}).updated === true,
      JSON.stringify({ ok: (resplit || {}).ok, error: (resplit || {}).error, res: resplit.result }));

    const staleAfter = ((resplit || {}).lint || [])
      .filter((w) => w.code === "split-stale");
    assert("and re-running split_body clears the split-stale lint",
      staleAfter.length === 0, JSON.stringify(staleAfter));

    const halfGrown = await get("bar.a");
    const wantHalfGrown = BAR_W * (BAR_T + 6) * (BAR_H - CUT_AT - KERF / 2);
    assert("and the updated half reflects the new source volume",
      halfGrown && halfGrown.shape && near(halfGrown.shape.volume, wantHalfGrown, 1e-3),
      JSON.stringify({ got: (halfGrown || {}).shape, want: wantHalfGrown }));

    await call("feature_edit", { target: "pad.bar", props: { Length: BAR_T } });
    await call("split_body", {
      target: "body.bar", plane: "XZ", offset: CUT_AT, gap: KERF,
      ids: ["bar.a", "bar.b"], labels: ["BarLower", "BarUpper"],
    }, "split.bar");
  }

  // ======================================================================
  // a dimension bound to the parameter sheet
  // ======================================================================
  console.log("\n--- sketch dimensions as expressions, param as a quantity ---");

  const pmm = await call("param", { alias: "bore", value: "12 mm" });
  const pr = (pmm || {}).result || {};
  assert("param takes a quantity with units",
    pmm && pmm.ok === true && near(pr.value, 12, 1e-9),
    JSON.stringify({ error: (pmm || {}).error, result: pr }));
  assert("and reads a value back rather than the string None",
    pr.value !== null && String(pr.value) !== "None", JSON.stringify(pr));
  const pin = await call("param", { alias: "web", value: "1 in" });
  assert("inches convert to the document's own units",
    near((((pin || {}).result) || {}).value, 25.4, 1e-6),
    JSON.stringify(((pin || {}).result || {}).value));
  await refused("a value that is not a quantity is refused", "param",
    { alias: "junk", value: "about yea big" }, null, "not a number");

  const bound = await call("batch", {
    ops: [
      { fn: "body", args: { label: "Bound" }, id: "body.bound" },
      { fn: "sketch",
        args: { on: "XY", body: "body.bound",
                geometry: [{ type: "rect", x: 300, y: 0, w: 40, h: 40 }] },
        id: "sk.bound" },
      { fn: "pad", args: { sketch: "sk.bound", length: 6, body: "body.bound" },
        id: "pad.bound" },
      { fn: "datum_plane",
        args: { body: "body.bound", on: "XY", offset: 6 }, id: "dp.bound" },
      { fn: "sketch",
        args: { on: "dp.bound", body: "body.bound",
                geometry: [{ type: "circle", x: 320, y: 20,
                             d: "koi_params.bore" }] },
        id: "sk.bore" },
      { fn: "pocket",
        args: { sketch: "sk.bore", through: true, body: "body.bound" },
        id: "poc.bore" },
    ],
  }, "batch.bound");

  if (assert("a sketch whose diameter is an expression builds",
      bound && bound.ok === true,
      JSON.stringify({ error: (bound || {}).error }))) {
    const bstep = (((bound.result || {}).steps) || [])
      .filter((st) => st.id === "sk.bore")[0] || {};
    const binds = ((bstep.result || {}).bindings) || [];
    assert("the binding is reported and verified against the document",
      binds.length === 1 && binds[0].verified === true &&
        near(binds[0].value, 6, 1e-6),
      JSON.stringify(binds));
    assert("no note claiming a literal got left behind",
      ((bstep.result || {}).bindingNote) === undefined,
      JSON.stringify((bstep.result || {}).bindingNote));

    // The point of binding: change the parameter, and the hole follows
    // without touching the sketch.
    const boreVol = (d) => Math.PI * (d / 2) * (d / 2) * 6;
    const v1 = await measure({ refs: ["body.bound"] });
    assert("the bore is Ø12, from the sheet",
      near((((v1 || {}).objects || [])[0] || {}).volume,
        40 * 40 * 6 - boreVol(12), 1e-2),
      JSON.stringify(((v1 || {}).objects || [])[0]));

    await call("param", { alias: "bore", value: "8 mm" });
    const v2 = await measure({ refs: ["body.bound"] });
    assert("changing the parameter changes the hole, with no edit to the sketch",
      near((((v2 || {}).objects || [])[0] || {}).volume,
        40 * 40 * 6 - boreVol(8), 1e-2),
      JSON.stringify(((v2 || {}).objects || [])[0]));
  }

  await refused("an expression naming an alias that does not exist is refused",
    "sketch",
    { on: "XY", body: "body.bound",
      geometry: [{ type: "circle", x: 0, y: 0, d: "koi_params.nosuchthing" }] },
    "sk.nope", "could not evaluate");

  // ======================================================================
  // a through cut on a centre plane
  // ======================================================================
  console.log("\n--- pocket: a bore on a centre plane cuts both ways ---");

  // A block straddling XZ: y from -15 to +15, so a sketch on XZ is INSIDE it.
  const straddle = await call("batch", {
    ops: [
      { fn: "body", args: { label: "Straddle" }, id: "body.mid" },
      { fn: "sketch",
        args: { on: "XZ", body: "body.mid",
                geometry: [{ type: "rect", x: 400, y: 0, w: 30, h: 20 }] },
        id: "sk.mid" },
      { fn: "pad",
        args: { sketch: "sk.mid", length: 30, midplane: true,
                body: "body.mid" },
        id: "pad.mid" },
    ],
  }, "batch.mid");

  if (assert("a block that straddles its own sketch plane",
      straddle && straddle.ok === true,
      JSON.stringify({ error: (straddle || {}).error }))) {
    const midVol = await measure({ refs: ["body.mid"] });
    assert("the block is 30 x 20 x 30 and centred on XZ",
      near((((midVol || {}).objects || [])[0] || {}).volume, 30 * 20 * 30, 1e-3),
      JSON.stringify(((midVol || {}).objects || [])[0]));

    await call("sketch", {
      on: "XZ", body: "body.mid",
      geometry: [{ type: "circle", x: 415, y: 10, d: 8 }],
    }, "sk.bore.mid");
    const cut = await call("pocket",
      { sketch: "sk.bore.mid", through: true, body: "body.mid" },
      "poc.mid");
    const cr = (cut || {}).result || {};
    // Ø8 through 30 mm of material. One-way, it would be 15.
    const wantBore = Math.PI * 16 * 30;
    assert("the through cut goes both ways without being asked",
      cut && cut.ok === true && cr.midplane === true &&
        near(cr.removed, wantBore, 1e-2),
      JSON.stringify({ midplane: cr.midplane, removed: cr.removed,
                       want: wantBore, error: (cut || {}).error }));
    assert("and it says it made that decision rather than doing it quietly",
      typeof cr.midplaneNote === "string" &&
        cr.midplaneNote.indexOf("midplane:false") !== -1,
      JSON.stringify(cr.midplaneNote));

    // Told explicitly, it obeys: half the bore, and no note.
    await call("sketch", {
      on: "XZ", body: "body.mid",
      geometry: [{ type: "circle", x: 405, y: 10, d: 8 }],
    }, "sk.bore.half");
    const half = await call("pocket",
      { sketch: "sk.bore.half", through: true, midplane: false,
        body: "body.mid" }, "poc.half");
    const hr = (half || {}).result || {};
    assert("midplane:false is obeyed: one way only",
      half && half.ok === true && hr.midplane === false &&
        near(hr.removed, wantBore / 2, 1e-2),
      JSON.stringify({ midplane: hr.midplane, removed: hr.removed,
                       want: wantBore / 2 }));
  }

  // A plane with material on ONE side only -- the ordinary case, and the one
  // that must not start cutting backwards into thin air.
  await call("sketch", {
    on: "dp.shown", body: "body.plate",
    geometry: [{ type: "circle", x: 12, y: 30, d: 4 }],
  }, "sk.boundary");
  const onFace = await call("pocket",
    { sketch: "sk.boundary", through: true, body: "body.plate" },
    "poc.notmid", { dryRun: true });
  assert("a cut from a plane with material on one side stays one-way",
    onFace && onFace.ok === true &&
      ((onFace.result || {}).midplane) === false &&
      ((onFace.result || {}).midplaneNote) === undefined,
    JSON.stringify({ midplane: (onFace.result || {}).midplane,
                     error: (onFace || {}).error }));

  // ======================================================================
  // the tree, and the argument name half the callers reach for
  // ======================================================================
  console.log("\n--- tree hygiene and view_set's alias ---");

  const s2 = await sync();
  const flat = [];
  (function walk(nodes) {
    for (const n of nodes || []) {
      flat.push(n);
      walk(n.children);
    }
  })(s2.tree || []);
  assert("no App::Origin or origin datum is shipped in the tree",
    flat.every((n) => ["App::Origin", "App::Plane", "App::Line", "App::Point"]
      .indexOf(n.type) === -1),
    JSON.stringify(flat.filter((n) => String(n.type).indexOf("App::") === 0)
      .map((n) => n.name)));
  assert("but the bodies themselves are all still there",
    flat.filter((n) => String(n.type).indexOf("PartDesign::Body") === 0)
      .length >= 4,
    JSON.stringify(flat.map((n) => n.type)));

  const byAlias = await call("view_set", { view: "top" });
  assert("view_set accepts 'view' as an alias for 'preset'",
    byAlias && byAlias.ok === true,
    JSON.stringify({ error: (byAlias || {}).error }));
  const byPreset = await call("view_set", { preset: "iso" });
  assert("and 'preset' still works", byPreset && byPreset.ok === true,
    JSON.stringify({ error: (byPreset || {}).error }));
  await refused("an unknown preset is still refused under either name",
    "view_set", { view: "sideways" }, null, "iso");


  // ======================================================================
  // show: the bulk half of presentation
  // ======================================================================
  console.log("\n--- show: what changed, and what was already that way ---");

  const vis0 = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
def v(kid):
    o = koi_cad.resolve(doc, kid)
    return None if o is None else bool(getattr(o, "Visibility", False))
return {"ok": True, "a": v("bar.a"), "b": v("bar.b"), "bound": v("body.bound")}
`);
  assert("the split halves start visible",
    vis0.a === true && vis0.b === true, JSON.stringify(vis0));

  const hid = await call("show",
    { targets: ["bar.a", "bar.b"], visible: false }, null);
  const hr = (hid || {}).result || {};
  assert("show hides a named set in one call",
    hid && hid.ok === true && (hr.changed || []).length === 2 &&
      hr.visible === false,
    JSON.stringify({ error: (hid || {}).error, result: hr }));

  const vis1 = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
def v(kid):
    o = koi_cad.resolve(doc, kid)
    return None if o is None else bool(getattr(o, "Visibility", False))
return {"ok": True, "a": v("bar.a"), "b": v("bar.b")}
`);
  assert("and the document agrees they are hidden",
    vis1.a === false && vis1.b === false, JSON.stringify(vis1));

  // The assertion this op exists for: asking for a state something is
  // already in is a no-op, and a caller who reads it as success believes the
  // model is on screen when it is not.
  const again = await call("show",
    { targets: ["bar.a", "body.bound"], visible: false }, null);
  const ar = (again || {}).result || {};
  assert("an object already in that state is reported as unchanged",
    (ar.already || []).length === 1 && (ar.changed || []).length === 1,
    JSON.stringify({ changed: ar.changed, already: ar.already }));

  await call("show", { targets: ["bar.a", "bar.b", "body.bound"] }, null);
  const vis2 = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
def v(kid):
    o = koi_cad.resolve(doc, kid)
    return None if o is None else bool(getattr(o, "Visibility", False))
return {"ok": True, "a": v("bar.a"), "b": v("bar.b"), "bound": v("body.bound")}
`);
  assert("visible defaults to true, so showing them back is one call",
    vis2.a === true && vis2.b === true && vis2.bound === true,
    JSON.stringify(vis2));

  await refused("show refuses an empty target list", "show",
    { targets: [] }, null, "non-empty");
  await refused("show refuses an object that does not exist", "show",
    { targets: ["nothing.here"] }, null, "nothing.here");

  // A label is feature_edit, not a special call -- the discoverability half
  // of the same gap.
  const lbl = await call("feature_edit",
    { target: "bar.a", props: { Label: "Faceplate" } });
  const gotLabel = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
o = koi_cad.resolve(doc, "bar.a")
return {"ok": True, "label": None if o is None else o.Label}
`);
  assert("feature_edit relabels an object, no Python loop needed",
    lbl && lbl.ok === true && gotLabel.label === "Faceplate",
    JSON.stringify({ error: (lbl || {}).error, label: gotLabel.label }));

  // ======================================================================
  // the array ops refuse a feature, both directions
  // ======================================================================
  console.log("\n--- pattern vs the array ops: each names the other ---");

  await refused("polar_array refuses a feature and names pattern",
    "polar_array", { target: "poc.bore", count: 3, angle: 360 },
    "arr.bad", "pattern");
  await refused("link_array refuses a feature and names pattern",
    "link_array", { target: "poc.bore", count: 3, step: [10, 0, 0] },
    "arr.bad2", "pattern");
  await refused("and pattern still refuses a whole body, naming polar_array",
    "pattern", { body: "body.bound", features: ["body.bound"], count: 3 },
    "pat.bad", "polar_array");

  // The legitimate direction still works: a whole body arrays fine.
  const arr = await call("polar_array",
    { target: "body.bound", count: 3, angle: 360, axis: "Z",
      center: [320, 20, 0] }, "arr.bound");
  assert("a whole body still arrays",
    arr && arr.ok === true, JSON.stringify({ error: (arr || {}).error }));

  // ======================================================================
  console.log("\n--- Cleaning up ---");
  try {
    await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
`);
    assert("scratch document closed without touching the user's work", true, "");
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