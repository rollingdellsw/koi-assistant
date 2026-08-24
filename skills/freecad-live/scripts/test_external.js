// scripts/test_external.js — external geometry (sketch external / query) and bind.
//
// The claim under test is not "addExternal was called". It is the one the
// feature exists for: a profile constrained to a projected model edge FOLLOWS
// that edge when the model changes, and a profile that merely copied the
// number does not. So every section here changes the source geometry after the
// fact and re-measures the dependent solid.
//
// Same two rules as test_ops.js, test_ops2.js and test_ops3.js:
//   1. Ground truth from the document via probe(), never the tool's own JSON.
//   2. A refusal for every gate.
//
// The third rule this file adds, because the failure mode is specific to it:
// when a projection's reference goes, FreeCAD does not error — it DELETES the
// constraints that referenced it and the sketch solves at whatever shape is
// left. So the constraint COUNT is an assertion here, not a diagnostic.
//
// The follower profile is a POLYLINE, not a rect, and that is not a style
// choice. rect comes out fully constrained and anchored — every dimension
// already written — so an Equal against a projection is redundant at best and
// conflicting at worst, and the sketch reports a conflict rather than
// following anything. polyline is joined but not dimensioned, which leaves
// exactly the freedom a projection is supposed to take up. That asymmetry is
// worth knowing before reaching for external geometry at all.

const results = [];
let pass = 0;
let fail = 0;
let warn = 0;

class TransportLost extends Error {}
// The stale gate is not a test failure, it is the harness having skipped a
// step -- and it fails EVERY write, so it arrives as twenty-odd red lines
// about features that were never reached. Treated like a lost transport for
// the same reason: once it fires, nothing after it proves anything.
class GateClosed extends Error {}

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
  if (String(msg || "").indexOf("has not been read this session") !== -1) {
    throw new GateClosed(
      "the router has not read this document, so every write is refused. " +
      "A scratch document made by probe() needs a sync() before the first " +
      "call: " + String(msg).slice(0, 120));
  }
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

const DOC = "ExternalTest";
const near = (a, b, tol) =>
  typeof a === "number" && Math.abs(a - b) < (tol || 1e-3);

// The housing: a W x D rectangle padded T, on XY. The cover plate is sketched
// to MATCH it — never told its width.
const W = 60, D = 40, T = 10, COVER_T = 3;
const W2 = 80;   // what the housing grows to, via the parameter sheet

// The sketch's own state, read from the document. Constraint count is load
// bearing: a re-projection that silently dropped constraints leaves a sketch
// that still solves.
const SK_STATE = (kid) => `
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
sk = koi_cad.resolve(doc, "${kid}")
ext = []
for pair in (sk.ExternalGeometry or []):
    obj, subs = pair
    for s in (subs or [""]):
        ext.append(obj.Name + ":" + s)
return {"ok": True, "name": sk.Name,
        "externals": ext,
        "constraints": len(sk.Constraints or []),
        "conflicts": [int(x) for x in (sk.ConflictingConstraints or [])],
        "fullyConstrained": bool(getattr(sk, "FullyConstrained", False)),
        "shapeXLen": round(sk.Shape.BoundBox.XLength, 6) if sk.Shape else None}
`;

const VOL = (kid) => `
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
o = koi_cad.resolve(doc, "${kid}")
return {"ok": True, "vol": round(o.Shape.Volume, 6),
        "xlen": round(o.Shape.BoundBox.XLength, 6),
        "valid": o.isValid()}
`;

async function run() {
  console.log("=== test_external.js — projected geometry and bind ===");
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
  // Not optional, and the first run of this file is why it is called out. The
  // document was made by probe(), behind the router's back, so the stale gate
  // had never read it -- and refused all twenty-odd writes with "This document
  // has not been read this session", which the harness then reported as
  // twenty-odd feature failures. Every scratch document needs this.
  const seen = await sync();
  assert("the router has read the scratch document",
    !!seen && !seen.error, JSON.stringify(seen && seen.error));

  // ======================================================================
  console.log("\n--- Section 0: the housing, driven by a parameter ---");

  await call("param", { alias: "housing_w", value: W }, "p.w");
  await call("param", { alias: "housing_d", value: D }, "p.d");
  await call("body", { label: "Housing" }, "body.housing");
  await call("sketch", {
    body: "body.housing", on: "XY",
    geometry: [{ type: "rect", x: 0, y: 0,
                 w: "koi_params.housing_w", h: "koi_params.housing_d",
                 anchor: "center" }],
  }, "sk.housing");
  const padH = await call("pad", {
    body: "body.housing", sketch: "sk.housing", length: T,
  }, "pad.housing");
  assert("housing pad built", padH && padH.ok === true,
    JSON.stringify(padH && padH.error));
  assert("and is W x D x T", near((padH.result || {}).volume, W * D * T, 1e-3),
    String((padH.result || {}).volume));

  // ======================================================================
  console.log("\n--- Section 1: refusals ---");

  await refused("external naming an object rather than an element is refused",
    "sketch", {
      body: "body.housing", on: "XY", external: ["pad.housing"],
      geometry: [{ type: "circle", x: 0, y: 0, r: 2 }],
    }, "sk.bad0", "names an object, not an edge or face");

  await refused("external with an unresolvable ref is refused",
    "sketch", {
      body: "body.housing", on: "XY", external: ["nope.nothing:Edge1"],
      geometry: [{ type: "circle", x: 0, y: 0, r: 2 }],
    }, "sk.bad1", null);

  await refused("bind without of is refused",
    "bind", { body: "body.housing" }, "bind.bad0",
    "missing required argument 'of'");

  // ======================================================================
  console.log("\n--- Section 2: projection by QUERY, into a second body ---");

  // The cover is its own body, so addExternal cannot reach the housing.
  // bind is the documented way across that line — and testing it here rather
  // than in isolation is the point: the two ops only matter composed.
  await call("body", { label: "Cover" }, "body.cover");

  const bindRes = await call("bind", {
    body: "body.cover", of: "pad.housing", label: "HousingRef",
  }, "bind.housing");
  assert("bind created a SubShapeBinder in the cover body",
    bindRes && bindRes.ok === true, JSON.stringify(bindRes && bindRes.error));

  const bindProbe = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
b = koi_cad.resolve(doc, "bind.housing")
body = koi_cad.resolve(doc, "body.cover")
return {"ok": True, "type": b.TypeId, "label": b.Label,
        "inCover": b.Name in [o.Name for o in body.Group],
        "xlen": round(b.Shape.BoundBox.XLength, 6),
        "visible": bool(b.Visibility)}
`);
  assert("the binder is a SubShapeBinder inside the cover body",
    !bindProbe.__fail && bindProbe.type === "PartDesign::SubShapeBinder" &&
      bindProbe.inCover === true, JSON.stringify(bindProbe));
  assert("it carries the housing's geometry, at the housing's size",
    near(bindProbe.xlen, W, 1e-3), String(bindProbe.xlen));
  assert("and it is created invisible, like every other piece of scaffolding",
    bindProbe.visible === false, String(bindProbe.visible));

  // ONE edge, by filter — the housing's bottom edge running along X at
  // y = -D/2. Narrow on purpose: external GeoIds are handed out in the order
  // the refs arrive, so a query that matches two edges makes "which one is
  // -3" a fact about query ordering rather than about the model, and a
  // constraint written against it would be a coin flip. Not by index either:
  // an authored EdgeN renumbers under the parameter change in section 4,
  // which is the whole contract.
  const PROJ_Q = {
    of: "bind.housing", kind: "edge", surface: "Line",
    direction: "+X", at: { z: 0, y: -D / 2 }, expect: "one",
  };

  const qCheck = await call("query", PROJ_Q, null);
  assert("the projection filter matches exactly one edge",
    (qCheck.result || {}).matched === 1, JSON.stringify(qCheck.result));

  const cover = await call("sketch", {
    body: "body.cover", on: "XY", query: PROJ_Q,
    geometry: [{ type: "circle", x: 0, y: 0, r: 2 }],
  }, "sk.cover");
  const okCover = assert("sketch with a projection query applies",
    cover && cover.ok === true, JSON.stringify(cover && cover.error));

  if (!okCover) {
    note("projection did not apply", "sections 3 and 4 prove nothing");
  } else {
    const cr = cover.result || {};
    assert("the reply reports what it projected",
      Array.isArray(cr.external) && cr.external.length === 1,
      JSON.stringify(cr.external));
    assert("external geometry is addressed from -3 down",
      ((cr.external || [])[0] || {}).geoId === -3,
      JSON.stringify((cr.external || [])[0]));
    assert("the stored filter is reported, so the caller knows it is re-derived",
      !!cr.externalQuery && /re-resolved/.test(cr.externalDurability || ""),
      JSON.stringify({ q: cr.externalQuery, d: cr.externalDurability }));

    const st = await probe(SK_STATE("sk.cover"));
    assert("and the document itself holds the projection",
      !st.__fail && (st.externals || []).length === (cr.external || []).length,
      JSON.stringify(st));
  }

  // ======================================================================
  console.log("\n--- Section 3: a constraint AGAINST the projection ---");

  // The assertion the feature exists for. The cover's width is written
  // NOWHERE: the polyline starts at a deliberately wrong 20 mm and is pulled
  // to the housing by Equal against the projected edge.
  //
  // GeoIds are predictable without a round trip, which is why the constraints
  // can go in the same call that creates the projection: externals are added
  // BEFORE the primitives, so the single projection is -3, and the polyline's
  // four segments are 0..3 in the order of its own points.
  const WRONG = 20;
  const follow = await call("sketch", {
    body: "body.cover", on: "XY", query: PROJ_Q,
    geometry: [{
      type: "polyline", closed: true,
      points: [[-WRONG / 2, -D / 2], [WRONG / 2, -D / 2],
               [WRONG / 2, D / 2], [-WRONG / 2, D / 2]],
    }],
    constraints: [
      // Make it a rectangle: without these the solver is free to skew the
      // chain and "width" stops being a property of the shape at all.
      { type: "Horizontal", args: [0] },
      { type: "Vertical", args: [1] },
      { type: "Horizontal", args: [2] },
      { type: "Vertical", args: [3] },
      // And this is the whole point: the bottom segment is as long as the
      // housing's bottom edge. No number.
      { type: "Equal", args: [0, -3] },
    ],
  }, "sk.follow");
  const okFollow = assert("a constraint can be written against a projected GeoId",
    follow && follow.ok === true,
    JSON.stringify(follow && (follow.error || follow.newErrors)));

  const stFollow = await probe(SK_STATE("sk.follow"));
  assert("the sketch solves with no conflicts",
    !stFollow.__fail && (stFollow.conflicts || []).length === 0,
    JSON.stringify(stFollow));
  assert("and the profile took its width FROM the housing, not from the " +
         WRONG + " mm it was drawn at",
    !stFollow.__fail && near(stFollow.shapeXLen, W, 0.5),
    `sketch spans ${stFollow && stFollow.shapeXLen}, housing is ${W}, drawn at ${WRONG}`);

  if (!okFollow) {
    note("projection or constraint did not apply", "section 4 proves nothing");
  }

  // ======================================================================
  console.log("\n--- Section 4: the housing moves, and the cover follows ---");

  const before = await probe(SK_STATE("sk.follow"));
  const padC = await call("pad", {
    body: "body.cover", sketch: "sk.follow", length: COVER_T,
  }, "pad.cover");
  assert("the cover pads from the projected profile",
    padC && padC.ok === true, JSON.stringify(padC && padC.error));
  const coverBefore = await probe(VOL("pad.cover"));
  assert("cover starts at the housing's width",
    !coverBefore.__fail && near(coverBefore.xlen, W, 0.5),
    JSON.stringify(coverBefore));

  // One parameter change. Nothing in it addresses the cover.
  const grow = await call("param", { alias: "housing_w", value: W2 }, "p.w");
  assert("the housing parameter changed", grow && grow.ok === true,
    JSON.stringify(grow && (grow.error || grow.newErrors)));

  const housingAfter = await probe(VOL("pad.housing"));
  assert("the housing itself grew", !housingAfter.__fail &&
    near(housingAfter.xlen, W2, 1e-3), JSON.stringify(housingAfter));

  const coverAfter = await probe(VOL("pad.cover"));
  assert("THE COVER FOLLOWED — this is the whole feature",
    !coverAfter.__fail && near(coverAfter.xlen, W2, 0.5),
    `cover spans ${coverAfter && coverAfter.xlen}, housing is now ${W2}. ` +
    `${W2} means the projection is live; ${W} means it copied a number.`);

  // The specific way this fails silently. A re-projection that dropped the
  // Equal leaves a sketch that solves, pads, and is quietly 20 mm wide.
  const after = await probe(SK_STATE("sk.follow"));
  assert("and the change cost the sketch no constraints",
    !before.__fail && !after.__fail &&
      after.constraints === before.constraints,
    JSON.stringify({ before: before.constraints, after: after.constraints,
                     note: "FreeCAD deletes constraints that referenced a " +
                           "projection whose reference went; the sketch then " +
                           "solves at the wrong shape" }));
  if (grow && grow.rehealedExternal) {
    note("the projection was re-resolved by the envelope",
      JSON.stringify(grow.rehealedExternal));
  }

  // ======================================================================
  console.log("\n--- Section 5: ids and cleanup ---");

  const idRes = await call("ids", {});
  const known = ((idRes && idRes.result && idRes.result.ids) || [])
    .reduce((a, r) => { a[r.id] = r; return a; }, {});
  for (const kid of ["bind.housing", "sk.cover", "sk.follow", "pad.cover"]) {
    assert("id " + kid + " is registered and present",
      known[kid] && known[kid].present === true,
      JSON.stringify(known[kid] || null));
  }
  for (const kid of ["sk.bad0", "sk.bad1", "bind.bad0"]) {
    assert("refused call " + kid + " registered nothing",
      !known[kid], JSON.stringify(known[kid] || null));
  }

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
      : e instanceof GateClosed
        ? "stale gate closed — nothing below was reached: " + e.message
        : e.message;
  results.push("❌ " + label);
  return { success: false, pass, fail, warn, results, error: label };
});