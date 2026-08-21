// scripts/test_recover.js — the ops that said ok and did something else.
//
//   /skill freecad-live/scripts/test_recover.js --full-auto
//
// Every assertion here comes from one field session's report. The model was
// finished and correct; what cost the turns was a green `ok: true` sitting on
// top of a document that held something else:
//
//   - hole(depth: 18) wrote DepthType ThroughAll and Depth 240 (the bbox
//     diagonal) and drilled the faceplate bolts through the whole stem
//   - a sketch with three closed outlines padded ONE of them
//   - a closed, fully constrained 5-segment polyline enclosed no area, so the
//     pocket built on it removed nothing and recomputed clean
//   - deleting a pocket in the MIDDLE of a body and recreating it at the tip
//     in one transaction took the body from 102009 mm3 to 1289 mm3 and moved
//     the placement of a feature nobody had touched
//   - lint kept warning about a suppressed pocket and about Edge66 on a
//     chamfer that already stores a query filter
//   - view_restore put 18 origin planes back over the finished part
//   - a rollback that did not roll back left the next turn reporting OUR
//     residue as the human's work, which is a false rejection signal
//
// So the shape of this file is: ask for the thing, then read the DOCUMENT for
// what actually happened -- never the op's own echo of its arguments.
//
// Requires `probe-exec: on` in SKILL.md: several conditions here (a visible
// origin plane, an abort whose rollback cannot succeed) have to be planted,
// and freecad_exec is how the suites plant them.
//
// Scratch document RecoverTest, closed at the end.

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

async function call(fn, opArgs, id, extra) {
  return guard(parseResult(await tools.freecad_call(
    Object.assign({ fn, args: opArgs || {} }, id ? { id } : {}, extra || {}))));
}

async function sync() {
  return guard(parseResult(await tools.freecad_sync({})));
}

async function measure(args) {
  return guard(parseResult(await tools.freecad_measure(args || {})));
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
  const said = !!(r && (r.__error === true || r.ok === false ||
                        (msg && r.applied !== true)));
  return assert(
    label,
    said && (!wanted || msg.indexOf(wanted) !== -1),
    JSON.stringify({ ok: r && r.ok, applied: r && r.applied,
                     error: msg.slice(0, 200) }));
}

const DOC = "RecoverTest";
const near = (a, b, rel) => {
  if (typeof a !== "number" || typeof b !== "number") return false;
  return Math.abs(a - b) <= Math.max(Math.abs(b) * (rel || 1e-3), 1e-6);
};

// The plate every section drills into.
const W = 60, H = 40, T = 10;
// The stack the delete/suppress section builds: a pad, a pocket in the middle
// of it, and a second pocket as the tip. Closed form, so "the body collapsed"
// is a number and not an impression.
const S_W = 30, S_H = 20, S_T = 10;
const S_VOL = S_W * S_H * S_T;
const MID_D = 8;
const MID_CUT = Math.PI * (MID_D / 2) * (MID_D / 2) * S_T;
const TIP_D = 6;
const TIP_CUT = Math.PI * (TIP_D / 2) * (TIP_D / 2) * S_T;
// The nested profile: a 20 x 20 square with a 6 mm hole in it, padded 5.
const N_SIDE = 20, N_D = 6, N_T = 5;
const N_VOL = (N_SIDE * N_SIDE - Math.PI * (N_D / 2) * (N_D / 2)) * N_T;

// A batch answers {steps:[{step, fn, id, result}]}, so a step's own reply is
// fetched by the id it was given rather than by position.
function step(batch, id) {
  return (((batch || {}).result || {}).steps || []).filter(
    (s) => s && s.id === id).map((s) => s.result || {})[0] || {};
}

async function shapeOf(name) {
  return probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
o = doc.getObject("${name}")
if o is None:
    return {"ok": False, "error": "no object ${name}"}
sh = getattr(o, "Shape", None)
return {"ok": True, "volume": None if sh is None else round(sh.Volume, 6),
        "visible": bool(getattr(o, "Visibility", False))}
`);
}

async function run() {
  console.log("=== ok:true, and whether the document agrees ===");
  console.log("Scratch document: " + DOC + "\n");

  const attach = parseResult(await tools.freecad_attach({ timeoutMs: 240000 }));
  if (!assert("attached", attach && attach.attached === true,
      (attach && (attach.error || attach.detail)) || "unknown")) {
    return { success: false, pass, fail, warn, results, error: "could not attach" };
  }

  const doc = await call("new_document", { name: DOC, reuse: false }, null);
  if (!assert("scratch document", doc && doc.ok === true,
      JSON.stringify(doc && doc.error))) {
    return { success: false, pass, fail, warn, results, error: "no document" };
  }

  const plate = await call("batch", {
    ops: [
      { fn: "body", args: { label: "Plate" }, id: "body.plate" },
      { fn: "sketch",
        args: { on: "XY", body: "body.plate",
                geometry: [{ type: "rect", x: 0, y: 0, anchor: "center",
                             w: W, h: H }] },
        id: "sk.plate" },
      { fn: "pad", args: { sketch: "sk.plate", length: T, body: "body.plate" },
        id: "pad.plate" },
    ],
  }, "batch.plate");
  if (!assert("a plate to drill", plate && plate.ok === true,
      JSON.stringify((plate || {}).error))) {
    return { success: false, pass, fail, warn, results, error: "no plate" };
  }

  // ====================================================================
  // 1. depth means depth
  // ====================================================================
  //
  // The one that would have shipped. `through` defaulted to true, so a depth
  // was accepted, ignored, and answered with ok:true -- and the readback that
  // would have caught it (DepthType: ThroughAll, Depth: 240) was nobody's job
  // to go and get.
  console.log("\n--- 1. a depth that is not quietly ThroughAll ---");

  await call("sketch", {
    body: "body.plate", on: "XY",
    geometry: [{ type: "circle", x: -20, y: 0, d: 5.5 }],
  }, "sk.blind");
  const blind = await call("hole", {
    body: "body.plate", sketch: "sk.blind", diameter: 5.5, depth: 4,
  }, "h.blind");
  const br = (blind || {}).result || {};
  if (assert("a hole with a depth and no through flag applies",
      blind && blind.ok === true, JSON.stringify((blind || {}).error))) {
    // THE regression. Everything else in this section is a guard rail.
    const bd = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
h = doc.getObject("${br.name}")
return {"ok": True, "depthType": str(getattr(h, "DepthType", "")),
        "depth": round(float(getattr(h, "Depth", 0)), 6),
        "drillPoint": str(getattr(h, "DrillPoint", "")),
        "pointAngle": float(getattr(h, "DrillPointAngle", 0) or 0),
        "forDepth": bool(getattr(h, "DrillForDepth", False))}
`);
    assert("the DOCUMENT reads DepthType Dimension, not ThroughAll",
      !bd.__fail && bd.depthType === "Dimension",
      "a depth that is accepted and ignored drills the bbox diagonal: " +
      JSON.stringify(bd));
    assert("and the depth in the document is the depth that was asked for",
      !bd.__fail && near(bd.depth, 4, 1e-6),
      "asked 4, document holds " + JSON.stringify(bd.depth));
    assert("the reply carries the depth type so a caller need not probe for it",
      br.depthType === "Dimension" && near(br.depth, 4, 1e-6) &&
        br.through === false,
      JSON.stringify({ depthType: br.depthType, depth: br.depth,
                       through: br.through }));
    assert("and it removed material",
      typeof br.removed === "number" && br.removed > 0,
      JSON.stringify(br.removed));
    // A blind 4 mm hole in a 10 mm plate is not a through hole, and the
    // volume is the discriminator: ThroughAll would have taken 2.5x this.
    //
    // A drilled hole does not end flat. The 118-degree point takes it
    // r/tan(59) = 1.652 mm deeper than the 4 that was asked for, which is a
    // cone of 13.09 mm3 on top of the 95.03 cylinder. That is the document
    // being right and the closed form being naive -- so the closed form now
    // includes the point, read from the document rather than assumed.
    const r = 2.75;
    const angled = String(bd.drillPoint || "").toLowerCase().indexOf("angle") === 0;
    const tip = angled && bd.pointAngle
      ? r / Math.tan((bd.pointAngle / 2) * Math.PI / 180) : 0;
    const cyl = Math.PI * r * r * (bd.forDepth ? 4 - tip : 4);
    const cone = Math.PI * r * r * tip / 3;
    assert("it removed a 4 mm hole's worth, point and all, not a 10 mm one's",
      near(br.removed, cyl + cone, 5e-3),
      JSON.stringify({ got: br.removed, want: cyl + cone,
                       drillPoint: bd.drillPoint, tip: tip }));
    // And the reply has to SAY where the bottom is. `depth` is the shoulder,
    // not the bottom, and a wall sized against it is 1.65 mm thinner than
    // whoever sized it believes.
    if (angled) {
      const dp = br.drillPoint || {};
      assert("the reply says how far past the asked depth the point goes",
        near(dp.tipLength, tip, 1e-3) && near(dp.bottomAt, 4 + tip, 1e-3),
        JSON.stringify(dp));
      assert("and warns that depth is the shoulder, not the bottom",
        String(br.depthNote || "").indexOf("bottomAt") !== -1,
        JSON.stringify(br.depthNote));
    } else {
      note("this build drills a flat-bottomed hole",
        "the point-angle case is not exercised: " +
        JSON.stringify(bd.drillPoint));
    }
  }

  await refused("through:true AND a depth is refused rather than resolved",
    "hole", { body: "body.plate", sketch: "sk.blind", diameter: 5.5,
              through: true, depth: 4 }, "h.both", "cannot both hold");
  await refused("through:false with no depth is refused",
    "hole", { body: "body.plate", sketch: "sk.blind", diameter: 5.5,
              through: false }, "h.nodepth", "needs a depth");

  // Its own profile: a second feature on a sketch another feature already
  // consumed is a separate argument, and this section is not about that.
  await call("sketch", {
    body: "body.plate", on: "XY",
    geometry: [{ type: "circle", x: -8, y: 0, d: 5.5 }],
  }, "sk.thru");
  const thru = await call("hole", {
    body: "body.plate", sketch: "sk.thru", diameter: 5.5, through: true,
  }, "h.thru");
  assert("through:true still goes all the way, and says which it did",
    thru && thru.ok === true &&
      ((thru.result || {}).depthType === "ThroughAll") &&
      (thru.result || {}).through === true,
    JSON.stringify((thru.result || {})));

  // ====================================================================
  // 2. a profile that cannot make a solid
  // ====================================================================
  console.log("\n--- 2. profiles: closed, overlapping, nested ---");

  // 2a. The polyline trap. Closed:false and the ends do not meet, so the wire
  // encloses nothing -- and the sketch itself is perfectly valid, which is why
  // this only ever showed up as a pocket that removed 0.
  const openSk = await call("sketch", {
    body: "body.plate", on: "XY",
    geometry: [{ type: "polyline", fix: true,
                 points: [[0, 0], [10, 0], [10, 8]] }],
  }, "sk.open");
  const op = ((openSk || {}).result || {}).profile || {};
  if (assert("an open polyline still builds as a sketch",
      openSk && openSk.ok === true, JSON.stringify((openSk || {}).error))) {
    assert("and the sketch reply says it encloses nothing",
      op.closed === 0 && op.area === 0,
      "wires/closed/area: " + JSON.stringify(op));
    assert("with a note, rather than leaving it to be discovered by a pocket",
      typeof ((openSk.result || {}).profileNote) === "string",
      JSON.stringify((openSk.result || {}).profileNote));
  }
  await refused("pad REFUSES a profile that encloses no area",
    "pad", { body: "body.plate", sketch: "sk.open", length: 5 },
    "pad.open", "encloses no area");
  await refused("and so does pocket -- this is the cut that removed nothing",
    "pocket", { body: "body.plate", sketch: "sk.open", through: true },
    "pk.open", "encloses no area");

  // 2b. Two outlines that overlap. PartDesign does not union them; it builds
  // one and reports success, which is how a stem body came back as its pinch
  // boss alone.
  await call("sketch", {
    body: "body.plate", on: "XY",
    geometry: [{ type: "rect", x: -25, y: -8, w: 20, h: 16 },
               { type: "rect", x: -15, y: -8, w: 20, h: 16 }],
  }, "sk.overlap");
  await refused("pad REFUSES two outlines that overlap without nesting",
    "pad", { body: "body.plate", sketch: "sk.overlap", length: 5 },
    "pad.overlap", "does not union overlapping wires");

  // 2c. Nesting is the legitimate case and must still work: an outline inside
  // another is a hole, not a second profile.
  const nested = await call("batch", {
    ops: [
      { fn: "body", args: { label: "Nested" }, id: "body.nest" },
      { fn: "sketch",
        args: { on: "XY", body: "body.nest",
                geometry: [{ type: "rect", x: 0, y: 0, anchor: "center",
                             w: N_SIDE, h: N_SIDE },
                           { type: "circle", x: 0, y: 0, d: N_D }] },
        id: "sk.nest" },
      { fn: "pad", args: { sketch: "sk.nest", length: N_T, body: "body.nest" },
        id: "pad.nest" },
    ],
  }, "batch.nest");
  if (assert("a nested outline is a hole and still pads",
      nested && nested.ok === true, JSON.stringify((nested || {}).error))) {
    const padRes = step(nested, "pad.nest");
    const shaped = await shapeOf(padRes.name);
    assert("and the solid is the square MINUS the hole",
      near(shaped.volume, N_VOL, 2e-3),
      JSON.stringify({ got: shaped.volume, want: N_VOL }));
    const prof = padRes.profile || {};
    assert("the reply names the nesting instead of billing the hole as area",
      (prof.nested || []).length === 1 && typeof prof.areaNote === "string",
      JSON.stringify(prof));
  }

  // 2d. Disjoint outlines are not the trap and must not be caught by it: two
  // bolt holes in one sketch is the single most common sketch in the skill.
  await call("sketch", {
    body: "body.plate", on: "XY",
    geometry: [{ type: "circle", x: 20, y: 12, d: 5 },
               { type: "circle", x: 20, y: -12, d: 5 }],
  }, "sk.pair");
  const pair = await call("pocket", {
    body: "body.plate", sketch: "sk.pair", through: true,
  }, "pk.pair");
  const pp = ((pair || {}).result || {}).profile || {};
  assert("two disjoint outlines in one sketch still cut, both of them",
    pair && pair.ok === true && pp.closed === 2 && !pp.overlaps &&
      near((pair.result || {}).removed, 2 * Math.PI * 2.5 * 2.5 * T, 5e-3),
    JSON.stringify({ error: (pair || {}).error, profile: pp,
                     removed: (pair.result || {}).removed }));

  // ====================================================================
  // 3. the delete that collapsed a body
  // ====================================================================
  console.log("\n--- 3. mid-tree delete, and the suppress that replaces it ---");

  const stack = await call("batch", {
    ops: [
      { fn: "body", args: { label: "Stack" }, id: "body.stack" },
      { fn: "sketch",
        args: { on: "XY", body: "body.stack",
                geometry: [{ type: "rect", x: 0, y: 0, anchor: "center",
                             w: S_W, h: S_H }] },
        id: "sk.stack" },
      { fn: "pad", args: { sketch: "sk.stack", length: S_T,
                           body: "body.stack" }, id: "pad.stack" },
      { fn: "sketch",
        args: { on: "XY", body: "body.stack",
                geometry: [{ type: "circle", x: 0, y: 0, d: MID_D }] },
        id: "sk.mid" },
      { fn: "pocket", args: { sketch: "sk.mid", through: true,
                              body: "body.stack" }, id: "pk.mid" },
      { fn: "sketch",
        args: { on: "XY", body: "body.stack",
                geometry: [{ type: "circle", x: 10, y: 0, d: TIP_D }] },
        id: "sk.tip" },
      { fn: "pocket", args: { sketch: "sk.tip", through: true,
                              body: "body.stack" }, id: "pk.tip" },
    ],
  }, "batch.stack");
  const stackOk = assert("a body with a feature in the middle of its tree",
    stack && stack.ok === true, JSON.stringify((stack || {}).error));

  const names = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
b = koi_cad.resolve(doc, "body.stack")
mid = koi_cad.resolve(doc, "pk.mid")
tip = koi_cad.resolve(doc, "pk.tip")
return {"ok": True, "body": b.Name, "mid": mid.Name, "tip": tip.Name,
        "bodyTip": getattr(b, "Tip", None) and b.Tip.Name,
        "volume": round(b.Shape.Volume, 6)}
`);

  if (stackOk && assert("the fixture resolves", !names.__fail, names.__fail)) {
    assert("the middle pocket is NOT the tip",
      names.bodyTip === names.tip && names.mid !== names.tip,
      JSON.stringify(names));
    assert("and the body measures the pad minus both cuts",
      near(names.volume, S_VOL - MID_CUT - TIP_CUT, 2e-3),
      JSON.stringify({ got: names.volume,
                       want: S_VOL - MID_CUT - TIP_CUT }));

    // The refusal. This is the call that, in the field, returned
    // {"removed": "Pocket002"} and ok:true and took the body to 1289 mm3.
    const del = await call("delete", { target: "pk.mid" }, null);
    const dmsg = String((del && (del.error || del.detail)) || "");
    assert("deleting a feature in the MIDDLE of a body is refused",
      del && del.applied !== true,
      JSON.stringify({ ok: del && del.ok, applied: del && del.applied }));
    assert("and the refusal names the tip, so the caller knows where it is",
      dmsg.indexOf(names.tip) !== -1, dmsg.slice(0, 200));
    assert("and it names suppress rather than leaving it to be thought of",
      dmsg.indexOf("suppress") !== -1, dmsg.slice(0, 200));
    const survived = await shapeOf(names.body);
    assert("the body is untouched by the refusal",
      near(survived.volume, names.volume, 1e-6),
      JSON.stringify({ before: names.volume, after: survived.volume }));

    // The replacement.
    const sup = await call("suppress", { target: "pk.mid" }, null);
    const sr = (sup || {}).result || {};
    if (assert("suppress applies", sup && sup.ok === true,
        JSON.stringify((sup || {}).error))) {
      assert("the feature reads suppressed in the document",
        (await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "s": bool(getattr(doc.getObject("${names.mid}"),
                                      "Suppressed", False))}
`)).s === true, "the document does not agree that it is off");
      assert("the material it removed comes back",
        near(sr.volumeDelta, MID_CUT, 5e-3),
        JSON.stringify({ delta: sr.volumeDelta, want: MID_CUT }));
      assert("and the reply measures the TIP, not the feature's own shape",
        near(sr.volume, S_VOL - TIP_CUT, 2e-3),
        JSON.stringify({ got: sr.volume, want: S_VOL - TIP_CUT }));
      assert("the tree still holds it -- this is not a delete in disguise",
        sr.name === names.mid && sr.tip === names.tip,
        JSON.stringify(sr));

      // The lint half. A pocket that is off ON PURPOSE removed no material by
      // definition, and warning about that every turn is what made the whole
      // lint section skippable.
      const s2 = await sync();
      const about = (s2.lint || []).filter((w) => w.object === names.mid);
      assert("a suppressed feature does not lint",
        about.length === 0,
        "still warning about something the user switched off: " +
        JSON.stringify(about));

      const back = await call("suppress",
        { target: "pk.mid", suppressed: false }, null);
      assert("suppressed:false puts the cut back",
        back && back.ok === true &&
          near((back.result || {}).volume, S_VOL - MID_CUT - TIP_CUT, 2e-3),
        JSON.stringify((back.result || {})));
    }

    // force is the deliberate way past. Last in this section, because it is
    // the call that breaks the fixture.
    //
    // What is asserted is that it gets PAST THE GATE -- not that FreeCAD then
    // succeeds. Removing a feature from the middle of a tree may leave the
    // features after it in error, in which case the envelope aborts on
    // new-recompute-errors and that is the correct outcome too. A test that
    // demanded ok:true here would be asserting that the damage went through.
    const forced = await call("delete", { target: "pk.mid", force: true }, null);
    const fmsg = String((forced && (forced.error || forced.detail)) || "");
    const fr = (forced || {}).result || {};
    assert("force:true is not answered with the refusal",
      fmsg.indexOf("Pass force:true") === -1 &&
        fmsg.indexOf("in the MIDDLE") === -1,
      fmsg.slice(0, 200));
    if (forced && forced.ok === true) {
      assert("and the reply says it was forced past one",
        fr.forced === true && String(fr.note || "").indexOf("FORCED") !== -1,
        JSON.stringify(fr));
      assert("and hands back the tip to check the damage with",
        typeof fr.tip === "string" || fr.tip === null, JSON.stringify(fr));
    } else {
      note("the forced delete was rolled back by the errors it caused",
        "which is the envelope doing its job — reason: " +
        JSON.stringify((forced || {}).reason) + ", newErrors: " +
        JSON.stringify((forced || {}).newErrors) +
        (fmsg ? ", " + fmsg.slice(0, 120) : ""));
    }
  }

  // A document-level object something else is built from.
  console.log("\n--- 3b. deleting the thing another object is made of ---");
  await call("primitive", { kind: "box", length: 20, width: 20, height: 20 },
    "prim.base");
  await call("primitive", { kind: "cylinder", d: 8, height: 40,
                            at: [10, 10, -10] }, "prim.tool");
  const cut = await call("boolean",
    { op: "cut", base: "prim.base", tool: "prim.tool" }, "bool.cut");
  if (assert("a cut to depend on", cut && cut.ok === true,
      JSON.stringify((cut || {}).error))) {
    await refused("deleting an object another one is built from is refused",
      "delete", { target: "prim.base" }, null, "is the input of");
    const delCut = await call("delete", { target: "bool.cut" }, null);
    assert("deleting the thing that depends on them is allowed",
      delCut && delCut.ok === true, JSON.stringify((delCut || {}).error));
  }

  // ====================================================================
  // 4. lint stops shouting about a solved problem
  // ====================================================================
  console.log("\n--- 4. topo-ref on a chamfer that stores its filter ---");
  const dress = await call("batch", {
    ops: [
      { fn: "body", args: { label: "Dress" }, id: "body.dress" },
      { fn: "sketch",
        args: { on: "XY", body: "body.dress",
                geometry: [{ type: "rect", x: 0, y: 0, anchor: "center",
                             w: 30, h: 20 }] },
        id: "sk.dress" },
      { fn: "pad", args: { sketch: "sk.dress", length: 10,
                           body: "body.dress" }, id: "pad.dress" },
    ],
  }, "batch.dress");
  if (assert("a block to chamfer", dress && dress.ok === true,
      JSON.stringify((dress || {}).error))) {
    const ch = await call("chamfer", {
      body: "body.dress", size: 1,
      query: { kind: "edge", direction: "+Z", expect: "many" },
    }, "ch.corners");
    if (assert("a chamfer placed from a query applies",
        ch && ch.ok === true, JSON.stringify((ch || {}).error))) {
      const chName = (ch.result || {}).name;
      const s4 = await sync();
      const topo = (s4.lint || []).filter(
        (w) => w.code === "topo-ref" && w.object === chName);
      assert("a query-backed chamfer produces no topo-ref warning",
        topo.length === 0,
        "the filter is stored, so Edge66 is a cache and not the authority: " +
        JSON.stringify(topo));
      // And the rule is still alive for the reference that IS a bare index:
      // this is the pair, not a licence to stop reporting picks.
      // On a plain Part solid, like test_measure does it: a Part::Fillet that
      // will actually build, so the reference under test is the only thing
      // this proves anything about.
      const picked = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
b = doc.addObject("Part::Box", "LintBox")
b.Length = b.Width = b.Height = 10
doc.recompute()
f = doc.addObject("Part::Fillet", "PickedFillet")
f.Base = b
f.Edges = [(1, 1.0, 1.0)]
doc.recompute()
return {"ok": True, "valid": bool(f.isValid())}
`);
      if (picked.__fail) {
        note("no bare sub-element reference could be planted", picked.__fail);
      } else {
        const s5 = await sync();
        assert("but a reference with no filter behind it is still reported",
          (s5.lint || []).some((w) => w.code === "topo-ref"),
          "silencing the query-backed case must not silence the rule: " +
          JSON.stringify((s5.lint || []).map((w) => w.code)));
        await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
for n in ("PickedFillet", "LintBox"):
    if doc.getObject(n) is not None:
        doc.removeObject(n)
return {"ok": True}
`);
      }
    }
  }

  // ====================================================================
  // 5. restore that does not undo the presentation
  // ====================================================================
  console.log("\n--- 5. view_restore and the 18 origin planes ---");
  const shown = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
on = []
for o in doc.Objects:
    if o.TypeId in ("App::Plane", "App::Line") and len(on) < 6:
        try:
            o.Visibility = True
            on.append(o.Name)
        except Exception:
            pass
return {"ok": True, "on": on}
`);
  if (!shown.__fail && (shown.on || []).length) {
    await call("isolate", { targets: ["body.plate"] }, null);
    const rest = await call("view_restore", {}, null);
    const rr = (rest || {}).result || {};
    assert("view_restore leaves the origin planes it found hidden",
      (rr.originsLeftHidden || []).length > 0, JSON.stringify(rr).slice(0, 240));
    const still = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "visible": [n for n in ${JSON.stringify(shown.on)}
                                if bool(doc.getObject(n).Visibility)]}
`);
    assert("and the document agrees they are still off",
      !still.__fail && (still.visible || []).length === 0,
      "restoring these is what put 18 translucent planes over the part: " +
      JSON.stringify(still.visible));
    assert("the restore still says what it did NOT put back",
      String(rr.note || "").indexOf("includeOrigins") !== -1,
      JSON.stringify(rr.note));

    // And the opt-out is real: a caller who wants the document byte-for-byte
    // as they found it can have that.
    //
    // The planes have to be switched back ON first. isolate records what it
    // HID, and it does not hide what is already hidden -- so a second isolate
    // over the state the first restore left behind records no origins at all,
    // and includeOrigins would have nothing to put back. That is correct
    // behaviour and it made the first version of this assertion meaningless.
    await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
for n in ${JSON.stringify(shown.on)}:
    o = doc.getObject(n)
    if o is not None:
        o.Visibility = True
return {"ok": True}
`);
    await call("isolate", { targets: ["body.plate"] }, null);
    await call("view_restore", { includeOrigins: true }, null);
    const again = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "visible": [n for n in ${JSON.stringify(shown.on)}
                                if bool(doc.getObject(n).Visibility)]}
`);
    assert("includeOrigins:true restores them after all",
      !again.__fail && (again.visible || []).length > 0,
      JSON.stringify(again));
    await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
for n in ${JSON.stringify(shown.on)}:
    o = doc.getObject(n)
    if o is not None:
        o.Visibility = False
return {"ok": True}
`);
  } else {
    note("no origin plane could be made visible",
      "this build exposes none, so the restore-the-scaffolding case " +
      "cannot be staged");
  }

  // ====================================================================
  // 6. an instance standing on its own definition
  // ====================================================================
  console.log("\n--- 6. interference: a link is not clashing with its master ---");
  //
  // The seat matters and is not the obvious one. An App::Link does not
  // compose its master's placement: the link's own Placement REPLACES it, so
  // a link left at the identity shows the box at the ORIGIN while the master
  // sits at x=200, the bbox prefilter separates them for six comparisons, and
  // the pair this section is about never gets measured at all. Seat the link
  // ON the master, then assert.
  await call("primitive", { kind: "box", length: 10, width: 10, height: 10,
                            at: [200, 0, 0] }, "prim.master");
  const arr = await call("link_array",
    { target: "prim.master", count: 1, step: [0, 0, 0] }, "arr.one");
  const link = (((arr || {}).result || {}).links || [])[0];
  if (assert("a link on its master", arr && arr.ok === true && !!link,
      JSON.stringify((arr || {}).error))) {
    const master = (arr.result || {}).linkedTo;
    const seated = await call("place", { target: link, at: [200, 0, 0] }, null);
    assert("the link can be seated where its master is",
      seated && seated.ok === true, JSON.stringify((seated || {}).error));
    const m = await measure({ refs: [master, link], interference: true });
    const inf = m.interference || {};
    const overlapping = (inf.pairs || []).some((p) => (p.volume || 0) > 1e-6);
    if (assert("the pair overlaps -- the measurement itself is not in doubt",
        overlapping,
        "if this reads bbox/0 the link is not on the master and nothing " +
        "below means anything: " + JSON.stringify(inf.pairs))) {
      assert("but it is NOT reported as a hit",
        (inf.hits || []).length === 0,
        "a bolt standing on the definition it is a copy of is not a clash a " +
        "caller can act on: " + JSON.stringify(inf.hits));
      assert("it is reported as structural, not silently dropped",
        (inf.expectedOverlaps || []).some(
          (e) => String(e.why || "").indexOf("link") !== -1),
        JSON.stringify(inf.expectedOverlaps));
      // The old exclusion was "the master is hidden", which is a fact about
      // presentation standing in for a fact about structure. Turn it on and
      // the answer must not change.
      const lit = await call("show", { targets: [master], visible: true }, null);
      const m2 = await measure({ refs: [master, link], interference: true });
      assert("and this holds with the master visible, not just hidden",
        lit && lit.ok === true &&
          ((m2.interference || {}).hits || []).length === 0,
        "the exclusion has to come from the link, not from visibility: " +
        JSON.stringify((m2.interference || {}).hits));
    }
  }

  // ====================================================================
  // 7. a rollback that did not roll back
  // ====================================================================
  //
  // The abort that leaves the document changed is rare and was survivable.
  // What was not survivable is what came next: the baseline still described
  // the document as it had been, so the following turn reported OUR residue
  // as the human's edit -- and §5.2 treats a user edit as a rejection signal.
  console.log("\n--- 7. the baseline after an abort that could not undo ---");
  const planted = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
v = doc.addObject("Part::Box", "Victim")
v.Length = v.Width = v.Height = 5
doc.recompute()
koi_cad.observe(doc)          # the baseline the next turn compares against

def _apply(d):
    d.removeObject("Victim")
    # Commit OUR transaction before failing, so the envelope's rollback has
    # nothing left to undo. This is the shape of the field failure: the
    # document moved and the abort could not put it back.
    App.closeActiveTransaction(False)
    raise koi_cad.KoiOpError("planted: an abort that cannot be rolled back")

res = koi_cad.envelope("planted overreach", _apply)
after = koi_cad.user_diff(doc)
return {"ok": True,
        "aborted": bool(res.get("aborted")),
        "overreach": res.get("abortOverreach"),
        "rebaselined": bool(res.get("rebaselined")),
        "note": res.get("rebaselineNote"),
        "victimGone": doc.getObject("Victim") is None,
        "userRemoved": after.get("removed"),
        "userSummary": after.get("summary")}
`, 60000);
  if (assert("the un-rollback-able abort could be staged",
      !planted.__fail, planted.__fail)) {
    assert("the edit aborted", planted.aborted === true,
      JSON.stringify(planted));
    if (planted.victimGone !== true) {
      note("the rollback succeeded on this build",
        "the abort put the object back, so the overreach path was not " +
        "exercised; nothing below can be concluded from that");
    } else {
      assert("the envelope reports the rollback as incomplete",
        !!planted.overreach, JSON.stringify(planted.overreach));
      assert("and it retakes the baseline rather than keeping a false one",
        planted.rebaselined === true,
        "without this, the next turn reads our own residue as the human's " +
        "work: " + JSON.stringify(planted));
      assert("so the next turn does NOT bill the human for our residue",
        (planted.userRemoved || []).indexOf("Victim") === -1,
        "a false rejection signal on the one check that decides whether we " +
        "may touch those objects: " + JSON.stringify(planted.userSummary));
      assert("and it says so, because a silent re-baseline hides a real abort",
        String(planted.note || "").indexOf("OURS") !== -1,
        JSON.stringify(planted.note));
    }
  }

  // ---- teardown ----
  console.log("\n--- teardown ---");
  const down = await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
return {"ok": True, "open": list(App.listDocuments().keys())}
`);
  assert("scratch document closed", !down.__fail, down.__fail);

  const buildInfo = parseResult(await tools.freecad_version({}));
  const build = (buildInfo && (buildInfo.build || buildInfo.runtime)) || {};
  console.log("\n=== recover: " + pass + " passed, " + fail + " failed, " +
    warn + " notes ===");
  console.log("Valid ONLY for build " +
    (build.exeVersion || build.version || "?") + " @ " + (build.commit || "?"));

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
