// scripts/test_ops.js — datum_plane, attach, fillet, chamfer, link_array.
//
// Every assertion below reads the document, not the tool's own JSON. The first
// version of this harness passed while `datum_plane` was echoing back the
// offset it had been handed and attaching nothing: `_op_datum_plane` looked for
// body.Origin.XY_Plane, which is not an attribute, and wrote its offset through
// a Placement copy that FreeCAD discards. Both writes were silent, and a
// harness that reads `result.offset` cannot see either of them.
//
// So: `probe()` for ground truth, closed-form volumes for the dress-up
// features, and a refusal for every gate.

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

// A gate that is only ever tested in the direction where it says yes is not a
// tested gate.
async function refused(label, fn, opArgs, id, wanted) {
  const r = await call(fn, opArgs, id);
  const msg = String((r && (r.error || r.detail)) || "");
  // Three shapes of no: the JS validator's {error}, the dispatcher's
  // {ok:false}, and isError from the transport. The first one has no `ok` at
  // all, which is how "refused before it reaches the page" read as a pass
  // failure on the first run of this file.
  const said = !!(r && (r.__error === true || r.ok === false ||
                        (msg && r.applied !== true)));
  return assert(
    label,
    said && (!wanted || msg.indexOf(wanted) !== -1),
    JSON.stringify({ ok: r && r.ok, applied: r && r.applied,
                     error: msg.slice(0, 180) }));
}

const DOC = "OpsTest";
const near = (a, b, tol) =>
  typeof a === "number" && Math.abs(a - b) < (tol || 1e-3);

// The plate: a 30 x 20 rectangle padded 10, attached to a datum 15 above XY.
const W = 30, H = 20, T = 10, DZ = 15;
// A fillet of radius r on a vertical 90-degree corner removes the corner
// square minus the quarter disc, over the full height.
const FILLET_R = 2;
const FILLET_CUT = (FILLET_R * FILLET_R - Math.PI * FILLET_R * FILLET_R / 4) * T;
// A chamfer of size s on a 90-degree corner removes half the square.
const CHAMFER_S = 1;
const CHAMFER_CUT = (CHAMFER_S * CHAMFER_S / 2) * T;

// Vertical sharp corners of full plate height, by internal name. The harness
// stands in for the user's click here: it reads the edge off the document
// rather than letting the op pick one, which is the whole point — the op is no
// longer allowed to pick one.
//
// "Vertical straight edge of height 10" is not enough. A fillet leaves two
// tangent seam lines down the sides of its cylinder that match that
// description exactly, and a chamfer across a G1 seam does not build — which
// is how the first run of this file handed the chamfer an edge it could not
// use and then reported the resulting abort as `error: null`. Both adjacent
// faces have to be planar.
const SHARP_EDGES = (kid) => `
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
o = koi_cad.resolve(doc, "${kid}")
sh = o.Shape
out = []
for i, e in enumerate(sh.Edges):
    try:
        if "Line" not in type(e.Curve).__name__:
            continue
        d = e.Vertexes[1].Point.sub(e.Vertexes[0].Point)
        if abs(d.x) > 1e-6 or abs(d.y) > 1e-6:
            continue
        if abs(abs(d.z) - ${T}) > 1e-6:
            continue
        faces = [f for f in sh.Faces if any(e.isSame(fe) for fe in f.Edges)]
        if len(faces) != 2:
            continue
        if not all("Plane" in type(f.Surface).__name__ for f in faces):
            continue
        out.append("Edge%d" % (i + 1))
    except Exception:
        pass
return {"ok": True, "edges": out, "volume": round(sh.Volume, 6), "name": o.Name}
`;

// An abort carries its reason in newErrors when the feature simply would not
// build: `error` is null in that case, which says nothing on its own.
const why = (r) => JSON.stringify(r && {
  ok: r.ok, applied: r.applied, reason: r.reason, error: r.error,
  newErrors: r.newErrors,
  lint: (r.lint || []).map((l) => l.code),
});

async function run() {
  console.log("=== Promoted ops: datum_plane, attach, fillet, chamfer, link_array ===");
  console.log("Scratch document: " + DOC + "\n");

  const attached = parseResult(await tools.freecad_attach({ timeoutMs: 240000 }));
  if (!assert("attached", attached && attached.attached === true,
      (attached && (attached.error || attached.detail)) || "unknown")) {
    return { success: false, pass, fail, warn, results, error: "could not attach" };
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
    return { success: false, pass, fail, warn, results, error: "no scratch doc" };
  }
  await sync();

  // ---- O1: datum_plane ----
  console.log("\n--- O1: datum_plane attaches, and the offset lands ---");
  const body = await call("body", { label: "TestBody" }, "body.test");
  assert("body created", body && body.applied === true,
    JSON.stringify(body && body.error));

  await refused("datum_plane with neither on nor base is refused",
    "datum_plane", { body: "body.test", offset: 5 }, "dp.nowhere", "needs on=");
  await refused("datum_plane on a plane that does not exist is refused",
    "datum_plane", { body: "body.test", on: "QQ" }, "dp.bogus", "XY");

  const dp = await call("datum_plane",
    { body: "body.test", on: "XY", offset: DZ }, "dp.offset");
  assert("datum_plane created", dp && dp.applied === true,
    JSON.stringify(dp && dp.error));

  const dpTruth = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
dp = koi_cad.resolve(doc, "dp.offset")
sup = getattr(dp, "AttachmentSupport", None) or getattr(dp, "Support", None)
return {"ok": True,
        "support": sup[0][0].Name if sup else None,
        "mapMode": str(getattr(dp, "MapMode", "")),
        "offsetZ": round(dp.AttachmentOffset.Base.z, 6),
        "z": round(dp.Placement.Base.z, 6)}
`);
  assert("the datum is attached to the body's XY plane",
    !dpTruth.__fail && String(dpTruth.support || "").indexOf("XY_Plane") !== -1,
    JSON.stringify(dpTruth));
  assert("MapMode is FlatFace in the document",
    dpTruth.mapMode === "FlatFace", JSON.stringify(dpTruth.mapMode));
  assert("the AttachmentOffset the document holds is " + DZ,
    near(dpTruth.offsetZ, DZ), JSON.stringify(dpTruth.offsetZ));
  assert("the datum's own placement sits " + DZ + " above XY",
    near(dpTruth.z, DZ), JSON.stringify(dpTruth.z));
  assert("the op reports the offset it read back, not the one it was given",
    near((dp.result || {}).offset, DZ) &&
      (dp.result || {}).attachedTo === dpTruth.support,
    JSON.stringify(dp.result));

  // ---- O2: attach ----
  console.log("\n--- O2: attach moves the sketch, and the pad follows ---");
  const sk = await call("sketch",
    { body: "body.test", geometry: [{ type: "rect", w: W, h: H }] }, "sk.base");
  assert("sketch created on XY", sk && sk.applied === true,
    JSON.stringify(sk && sk.error));

  await refused("attach to a base that does not resolve is refused",
    "attach", { target: "sk.base", base: "dp.nosuch" }, null,
    "not a known ref id");

  const att = await call("attach", { target: "sk.base", base: "dp.offset" });
  assert("attach applied", att && att.applied === true,
    JSON.stringify(att && att.error));

  const skTruth = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
sk = koi_cad.resolve(doc, "sk.base")
dp = koi_cad.resolve(doc, "dp.offset")
sup = getattr(sk, "AttachmentSupport", None) or getattr(sk, "Support", None)
return {"ok": True,
        "support": sup[0][0].Name if sup else None,
        "datum": dp.Name,
        "z": round(sk.Placement.Base.z, 6)}
`);
  assert("the sketch is attached to the datum in the document",
    !skTruth.__fail && skTruth.support === skTruth.datum,
    JSON.stringify(skTruth));
  assert("the sketch moved to the datum's height",
    near(skTruth.z, DZ), JSON.stringify(skTruth.z));

  const pad = await call("pad",
    { body: "body.test", sketch: "sk.base", length: T }, "pad.base");
  assert("pad created", pad && pad.applied === true,
    JSON.stringify(pad && pad.error));

  const padTruth = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
p = koi_cad.resolve(doc, "pad.base")
bb = p.Shape.BoundBox
return {"ok": True, "zmin": round(bb.ZMin, 6), "zmax": round(bb.ZMax, 6),
        "volume": round(p.Shape.Volume, 6)}
`);
  // The assertion the old harness was missing entirely: if attach had silently
  // done nothing, this pad would start at z=0 and every other test would still
  // have passed.
  assert("the solid starts at the datum, not at the origin",
    near(padTruth.zmin, DZ), JSON.stringify(padTruth));
  assert("the solid is " + T + " thick above it",
    near(padTruth.zmax, DZ + T), JSON.stringify(padTruth));
  assert("the pad volume is " + W * H * T,
    near(padTruth.volume, W * H * T, 1e-2), JSON.stringify(padTruth.volume));

  // ---- O3: fillet ----
  console.log("\n--- O3: fillet refuses to invent an edge, and bites where told ---");
  await refused("fillet with no refs is refused before it reaches the page",
    "fillet", { body: "body.test", radius: FILLET_R }, "fil.norefs", "refs");
  await refused("fillet with an empty ref list is refused in the op",
    "fillet", { body: "body.test", radius: FILLET_R, refs: [] }, "fil.empty",
    "needs refs");
  await refused("fillet on a raw edge index is refused",
    "fillet", { body: "body.test", radius: FILLET_R, refs: ["Edge3"] },
    "fil.raw", "renumber");
  await refused("fillet on an unknown ref id is refused",
    "fillet", { body: "body.test", radius: FILLET_R, refs: ["pick.nothing"] },
    "fil.unknown", "not a known ref id");

  const padEdges = await probe(SHARP_EDGES("pad.base"));
  if (!assert("the plate has four sharp vertical corners",
      !padEdges.__fail && (padEdges.edges || []).length === 4,
      JSON.stringify(padEdges))) {
    return { success: false, pass, fail, warn, results, error: "no edges" };
  }

  const fil = await call("fillet", {
    body: "body.test", radius: FILLET_R,
    refs: ["pad.base:" + padEdges.edges[0]],
  }, "fil.corner");
  assert("fillet applied", fil && fil.applied === true, why(fil));
  assert("the fillet reports the edge it was given, not one it chose",
    ((fil.result || {}).edges || [])[0] === padEdges.edges[0],
    JSON.stringify(fil.result));
  assert("the fillet removed the corner: " + FILLET_CUT.toFixed(4) + " mm3",
    near((fil.result || {}).volumeDelta, -FILLET_CUT, 1e-2),
    JSON.stringify(fil.result && {
      before: fil.result.volumeBefore, after: fil.result.volume,
      delta: fil.result.volumeDelta }));

  // ---- O4: chamfer ----
  console.log("\n--- O4: chamfer, on the new tip ---");
  // Three, not five: the blend replaced one corner with a cylinder whose two
  // tangent seams are also vertical lines of height 10.
  const filEdges = await probe(SHARP_EDGES("fil.corner"));
  assert("the filleted solid still has three sharp corners",
    !filEdges.__fail && (filEdges.edges || []).length === 3,
    JSON.stringify(filEdges.edges));

  const ch = await call("chamfer", {
    body: "body.test", size: CHAMFER_S,
    refs: ["fil.corner:" + (filEdges.edges || [])[0]],
  }, "ch.corner");
  assert("chamfer applied", ch && ch.applied === true, why(ch));
  assert("the chamfer removed " + CHAMFER_CUT.toFixed(4) + " mm3",
    near((ch.result || {}).volumeDelta, -CHAMFER_CUT, 1e-2),
    JSON.stringify(ch.result && {
      before: ch.result.volumeBefore, after: ch.result.volume,
      delta: ch.result.volumeDelta }));

  // A dress-up feature that changes no volume is the fillet version of a
  // pocket into thin air: Up-to-date, isValid(), and wrong.
  const chEdges = await probe(SHARP_EDGES("ch.corner"));
  assert("sharp corners remain to test against",
    !chEdges.__fail && (chEdges.edges || []).length >= 1,
    JSON.stringify(chEdges.edges));
  const tiny = await call("chamfer", {
    body: "body.test", size: 1e-6,
    refs: ["ch.corner:" + ((chEdges.edges || [])[0] || "Edge1")],
  }, "ch.nothing", { dryRun: true });
  // Either outcome is the right one — the kernel refusing to build it, or the
  // lint rule catching a feature that built and bit nothing. What must not
  // happen is ok:true with no volume change and nothing said.
  const linted = (tiny.lint || []).some((l) => l.code === "changed-nothing");
  const rejected = !(tiny && tiny.ok === true);
  assert("a chamfer too small to bite does not quietly succeed",
    linted || rejected, why(tiny));
  if (rejected && !linted) {
    note("changed-nothing was not exercised",
      "the kernel refused the degenerate chamfer before it could build, so " +
      "the lint rule is still only covered by inspection");
  }

  // ---- O5: link_array ----
  console.log("\n--- O5: link_array places its instances ---");
  await refused("an array over the instance bound is refused",
    "link_array", { target: "body.test", count: 100000, step: [1, 0, 0] },
    "arr.toobig", "bound");

  const arr = await call("link_array",
    { target: "body.test", count: 3, step: [40, 0, 0] }, "arr.plates");
  assert("link_array applied", arr && arr.applied === true,
    JSON.stringify(arr && arr.error));
  assert("three links", ((arr.result || {}).links || []).length === 3,
    JSON.stringify(arr.result));

  const arrTruth = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
out = []
for n in ${JSON.stringify((arr.result || {}).links || [])}:
    o = doc.getObject(n)
    if o is None:
        out.append(None)
        continue
    b = o.Placement.Base
    out.append([round(b.x, 6), round(b.y, 6), round(b.z, 6)])
return {"ok": True, "at": out}
`);
  // The step is applied through a Placement copy unless the whole placement
  // goes back, and a stacked array looks identical in every field the tool
  // reports about itself.
  assert("the links are stepped 40 apart in the document",
    !arrTruth.__fail && JSON.stringify(arrTruth.at) ===
      JSON.stringify([[0, 0, 0], [40, 0, 0], [80, 0, 0]]),
    JSON.stringify(arrTruth.at));

  // ---- O6: the result payload ----
  console.log("\n--- O6: edits ship the delta, not the document ---");
  assert("an edit result carries no full projection by default",
    arr && arr.projection === undefined && typeof arr.objectCount === "number",
    JSON.stringify({ hasProjection: !!(arr && arr.projection),
                     objectCount: arr && arr.objectCount }));
  const full = await call("param",
    { alias: "koi_ops_probe", value: 1 }, null, { detail: "full" });
  if (full && full.ok) {
    assert("detail:'full' still returns it",
      !!(full.projection && (full.projection.objects || []).length),
      JSON.stringify({ hasProjection: !!(full && full.projection) }));
  } else {
    note("could not exercise detail:'full'", JSON.stringify(full && full.error));
  }

  const s = await sync();
  assert("sync counts nodes, not roots",
    typeof s.objectCount === "number" && s.objectCount > (s.tree || []).length,
    JSON.stringify({ objectCount: s.objectCount, roots: (s.tree || []).length }));

  // ---- O7: freecad_get ----
  console.log("\n--- O7: freecad_get ---");
  const one = guard(parseResult(await tools.freecad_get({ id: "pad.base" })));
  assert("freecad_get resolves a koi id",
    one && one.name && one.shape && near(one.shape.volume, W * H * T, 1e-2),
    JSON.stringify(one && { name: one.name, error: one.error }));
  const many = guard(parseResult(
    await tools.freecad_get({ ids: ["pad.base", "sk.base", "nope.nope"] })));
  assert("freecad_get reads several in one round trip",
    many && (many.nodes || []).length === 3 && !!many.nodes[0].name &&
      !!many.nodes[2].error,
    JSON.stringify(many && (many.nodes || []).map((n) => n.name || n.error)));

  // The id used to be pasted into the snippet between two apostrophes.
  const injected = guard(parseResult(await tools.freecad_get({
    id: "x'); import os; os.environ['KOI_PWNED']='1'; koi_cad.get_node('y",
  })));
  const pwned = await probe(`
import os
return {"ok": True, "pwned": os.environ.get("KOI_PWNED")}
`);
  assert("an id cannot break out of the snippet",
    !!(injected && injected.error) && !pwned.__fail && !pwned.pwned,
    JSON.stringify({ got: injected && injected.error, env: pwned.pwned }));

  console.log("\n--- Cleaning up ---");
  try {
    await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
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
