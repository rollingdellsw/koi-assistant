// scripts/test_visible.js — can the human actually see it, and does the reply
// say so honestly?
//
//   /skill freecad-live/scripts/test_visible.js --full-auto
//
// Every assertion here comes from one session's report: the model was finished
// and correct, and the loop of "edit -> see it -> trust it" broke anyway. The
// reply said the full assembly was framed while the screen held six bolts on
// grey. Nothing in the skill's own output contradicted it, because nothing in
// the skill's own output was about the SHAPE:
//
//   - view_fit reported span 3.46e+100 whenever an App::Origin was visible
//   - isolate kept a Body's origin children and dropped nothing that mattered
//   - after split_body the solid is a FeatureBase, and hiding it leaves
//     Body.Visibility true over an empty viewport
//   - show answered already:true about the container
//   - fastener_pattern put the master AND a link on seat 0
//   - bom billed the hidden split source as a third part
//   - measure dumped origins, sketches and every intermediate pocket
//
// So this suite asserts the four things a caller needs before it is allowed to
// claim anything is on screen: label, volume, bbox, actuallyDrawn.
//
// Requires `probe-exec: on` in SKILL.md — several conditions here (a hidden
// tip, a visible origin plane) have to be planted, and freecad_exec is how the
// suites plant them.
//
// Scratch document VisibleTest, closed at the end.

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

async function probe(python, timeoutMs) {
  const r = guard(parseResult(
    await tools.freecad_exec({ python, timeoutMs: timeoutMs || 30000 })));
  if (!r || r.ok !== true) return { __fail: (r && r.error) || "exec failed" };
  const d = r.result || {};
  if (d.ok === false) return { __fail: d.error || "returned ok:false" };
  return d;
}

function near(a, b, rel) {
  if (typeof a !== "number" || typeof b !== "number") return false;
  return Math.abs(a - b) <= Math.max(Math.abs(b) * (rel || 1e-3), 1e-6);
}

function row(res, name) {
  return ((res || {}).targets || []).filter((t) => t.name === name)[0] || null;
}

const DOC = "VisibleTest";
const PLATE_W = 60;      // x
const PLATE_H = 40;      // y
const PLATE_T = 10;      // z

async function run() {
  console.log("=== visibility, and replies that can be trusted about it ===");
  console.log("Scratch document: " + DOC + "\n");

  const attach = parseResult(await tools.freecad_attach({ timeoutMs: 240000 }));
  if (!assert("attached", attach && attach.attached === true,
      (attach && (attach.error || attach.detail)) || "unknown")) {
    return { success: false, pass, fail, results, error: "could not attach" };
  }
  const buildInfo = parseResult(await tools.freecad_version({}));
  const build = buildInfo.build || (buildInfo.runtime || {});

  const doc = await call("new_document", { name: DOC, reuse: false }, null);
  if (!assert("scratch document", doc && doc.ok === true,
      JSON.stringify(doc && doc.error))) {
    return { success: false, pass, fail, results, error: "no document" };
  }

  const built = await call("batch", {
    ops: [
      { fn: "body", args: { label: "Plate" }, id: "body.plate" },
      { fn: "sketch",
        args: { on: "XY", body: "body.plate",
                // anchor matters: rect defaults to a bottom-left corner, and
                // every coordinate below -- the split offset, both bolt
                // circles, the tap -- is written about a plate centred on the
                // origin. Without this the plate sits at x 0..60 and the
                // x:-20 bolt hole is cut in mid-air.
                geometry: [{ type: "rect", x: 0, y: 0, anchor: "center",
                             w: PLATE_W, h: PLATE_H }] },
        id: "sk.plate" },
      { fn: "pad", args: { sketch: "sk.plate", length: PLATE_T,
                           body: "body.plate" }, id: "pad.plate" },
    ],
  }, "batch.plate");
  if (!assert("a plate to look at", built && built.ok === true,
      JSON.stringify((built || {}).error))) {
    return { success: false, pass, fail, results, error: "no plate" };
  }
  const plateVol = PLATE_W * PLATE_H * PLATE_T;

  // ====================================================================
  // 1. An infinite origin plane is not the model
  // ====================================================================
  console.log("\n--- 1. span, with an origin plane switched on ---");

  const origin = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
shown = []
for o in doc.Objects:
    if o.TypeId in ("App::Plane", "App::Line"):
        try:
            o.Visibility = True
            shown.append(o.Name)
        except Exception:
            pass
return {"ok": True, "shown": shown}
`);
  if (!origin.__fail && (origin.shown || []).length) {
    const vf = await call("view_fit", {}, null);
    const r = (vf || {}).result || {};
    assert("view_fit still reports a finite span",
      typeof r.span === "number" && isFinite(r.span) && r.span < 1e6,
      JSON.stringify({ span: r.span }));
    assert("and the span is the plate's diagonal, not a plane's",
      near(r.span, Math.sqrt(PLATE_W * PLATE_W + PLATE_H * PLATE_H +
                             PLATE_T * PLATE_T), 1e-3),
      JSON.stringify({ span: r.span }));
    assert("the infinite objects are named rather than silently averaged in",
      Array.isArray(r.ignored) && r.ignored.length > 0,
      JSON.stringify(r));
    await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
for n in ${JSON.stringify(origin.shown)}:
    o = doc.getObject(n)
    if o is not None:
        o.Visibility = False
return {"ok": True}
`);
  } else {
    note("no origin plane could be made visible",
      "this build exposes none, so the 3.46e100 regression cannot be staged");
  }

  // ====================================================================
  // 2. Visibility is a fact about a container. Drawn is not.
  // ====================================================================
  console.log("\n--- 2. a Body that reads visible over a hidden tip ---");

  const tip = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
b = koi_cad.resolve(doc, "body.plate")
t = getattr(b, "Tip", None)
if t is None:
    return {"ok": False, "error": "the body has no Tip on this build"}
t.Visibility = False
b.Visibility = True
return {"ok": True, "body": b.Name, "tip": t.Name,
        "bodyVisible": bool(b.Visibility), "tipVisible": bool(t.Visibility)}
`);
  if (assert("a hidden tip under a visible Body could be staged",
      !tip.__fail, tip.__fail)) {
    const shown = await call("show", { targets: ["body.plate"], visible: true },
      null);
    const sr = (shown || {}).result || {};
    assert("show still reports the container as already visible",
      (sr.already || []).indexOf(tip.body) !== -1, JSON.stringify(sr.already));
    // The whole point. The old reply stopped at the line above and a session
    // read it as "the user can see the plate".
    const t0 = row(sr, tip.body);
    assert("but it reports the target as NOT drawn",
      t0 && t0.drawn === false, JSON.stringify(t0));
    assert("and names what is switching it off",
      t0 && (t0.hiddenBy || []).indexOf(tip.tip) !== -1, JSON.stringify(t0));
    assert("notDrawn lists it, so a caller cannot miss it",
      (sr.notDrawn || []).indexOf(tip.body) !== -1, JSON.stringify(sr.notDrawn));
    assert("the reply carries the volume a claim would need",
      t0 && near(t0.volume, plateVol, 1e-6), JSON.stringify(t0));
    assert("and the bbox, finite",
      t0 && Array.isArray(t0.bbox) && isFinite(t0.bbox[1][0]),
      JSON.stringify(t0 && t0.bbox));
    assert("and the label, so the reply can name it the way the user does",
      t0 && typeof t0.label === "string" && t0.label.length > 0,
      JSON.stringify(t0));

    console.log("\n--- 2b. isolate keeps its promise instead of reporting it ---");
    const iso = await call("isolate", { targets: ["body.plate"] }, null);
    const ir = (iso || {}).result || {};
    assert("isolate applied", iso && iso.ok === true,
      JSON.stringify((iso || {}).error));
    assert("it turned the hidden tip back on",
      (ir.revealed || []).indexOf(tip.tip) !== -1, JSON.stringify(ir.revealed));
    const t1 = row(ir, tip.body);
    assert("and now says the target is drawn",
      t1 && t1.drawn === true, JSON.stringify(t1));
    assert("with a finite span for the camera",
      typeof ir.span === "number" && ir.span < 1e6, JSON.stringify(ir.span));

    const back = await call("view_restore", {}, null);
    const br = (back || {}).result || {};
    assert("view_restore re-hides what isolate turned on",
      (br.rehidden || []).indexOf(tip.tip) !== -1,
      "isolate must not leave the document brighter than it found it: " +
      JSON.stringify(br));
    const tipNow = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "tipVisible": bool(doc.getObject("${tip.tip}").Visibility)}
`);
    assert("and the tip is hidden again, exactly as the user left it",
      !tipNow.__fail && tipNow.tipVisible === false, JSON.stringify(tipNow));

    await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
doc.getObject("${tip.tip}").Visibility = True
return {"ok": True}
`);
  }

  // ====================================================================
  // 3. isolate does not keep a Body's origin
  // ====================================================================
  console.log("\n--- 3. isolate keeps the solid, not the origin ---");
  const iso2 = await call("isolate", { targets: ["body.plate"] }, null);
  const ir2 = (iso2 || {}).result || {};
  const kept = ir2.kept || [];
  const originKept = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
kept = set(${JSON.stringify(kept)})
bad = [o.Name for o in doc.Objects
       if o.Name in kept and o.TypeId in ("App::Origin", "App::Plane", "App::Line")]
return {"ok": True, "bad": bad}
`);
  assert("no origin, plane or axis is in the keep set",
    !originKept.__fail && (originKept.bad || []).length === 0,
    "isolate-then-fit explodes because these are infinite: " +
    JSON.stringify(originKept.bad));
  assert("the span after isolate is still the model's",
    typeof ir2.span === "number" && ir2.span < 1e6, JSON.stringify(ir2.span));
  await call("view_restore", {}, null);

  // ====================================================================
  // 4. split_body says which half is which
  // ====================================================================
  console.log("\n--- 4. split: sides by name, offset by expression ---");
  await call("param", { alias: "CutAt", value: 5 }, null);
  const sp = await call("split_body", {
    target: "body.plate", plane: "XZ", offset: "koi_params.CutAt",
    ids: ["half.pos", "half.neg"], labels: ["Upper", "Lower"],
  }, "split.plate");
  const spr = (sp || {}).result || {};
  assert("split_body took an expression for the offset",
    sp && sp.ok === true && spr.offsetExpression === "koi_params.CutAt",
    JSON.stringify({ ok: (sp || {}).ok, error: (sp || {}).error,
                     expr: spr.offsetExpression }));
  assert("and evaluated it to the number the sheet holds",
    near(spr.offset, 5, 1e-9), JSON.stringify(spr.offset));
  const sides = spr.sides || {};
  assert("the halves are reported by side of the normal, not just a and b",
    !!sides.positive && !!sides.negative, JSON.stringify(Object.keys(sides)));
  assert("ids[0] is the positive side, and the reply says so",
    (sides.positive || {}).id === "half.pos",
    "this is the guess that only came out right last session from memory: " +
    JSON.stringify(sides));
  // XZ's normal is +Y, so the positive half is the y > 5 material.
  assert("and the boxes prove it rather than asserting it",
    (sides.positive || {}).bbox &&
      sides.positive.bbox[0][1] >= 5 - 1e-6 &&
      (sides.negative || {}).bbox &&
      sides.negative.bbox[1][1] <= 5 + 1e-6,
    JSON.stringify({ pos: (sides.positive || {}).bbox,
                     neg: (sides.negative || {}).bbox }));
  const posVol = PLATE_W * (PLATE_H / 2 - 5) * PLATE_T;
  assert("the positive half measures what the plane implies",
    near((sides.positive || {}).volume, posVol, 1e-3),
    JSON.stringify({ got: (sides.positive || {}).volume, want: posVol }));
  assert("and the two halves still add up to the plate",
    near((sides.positive || {}).volume + (sides.negative || {}).volume,
         plateVol, 1e-3),
    JSON.stringify({ pos: (sides.positive || {}).volume,
                     neg: (sides.negative || {}).volume, plate: plateVol }));
  assert("the note names the ordering instead of leaving it to be remembered",
    typeof spr.note === "string" && spr.note.indexOf("POSITIVE") !== -1,
    JSON.stringify(String(spr.note || "").slice(0, 160)));

  // The split half's solid is a FeatureBase. This is the object the last
  // session hid as a "duplicate", which is how the assembly left the screen.
  console.log("\n--- 4b. isolate frames a split half, FeatureBase and all ---");
  const isoHalf = await call("isolate", { targets: ["half.pos"] }, null);
  const ihr = (isoHalf || {}).result || {};
  const th = ((ihr.targets || [])[0]) || {};
  assert("the half is drawn after isolating it",
    th.drawn === true, JSON.stringify(th));
  assert("and the reply carries its volume, not just its name",
    near(th.volume, posVol, 1e-3), JSON.stringify(th));
  const baseKept = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
kept = set(${JSON.stringify(ihr.kept || [])})
bases = [o.Name for o in doc.Objects
         if "FeatureBase" in o.TypeId or "Base" in o.TypeId]
return {"ok": True, "bases": bases,
        "keptBases": [b for b in bases if b in kept]}
`);
  if (!baseKept.__fail && (baseKept.bases || []).length) {
    assert("the FeatureBase holding the solid is kept, not hidden as a copy",
      (baseKept.keptBases || []).length > 0, JSON.stringify(baseKept));
  } else {
    note("this build made no FeatureBase", "the halves are plain solids");
  }
  await call("view_restore", {}, null);

  // ====================================================================
  // 5. hole: counterbore and thread size from the table
  // ====================================================================
  console.log("\n--- 5. hole takes one spec, not three numbers ---");
  await call("sketch", {
    body: "half.pos", on: "XY",
    geometry: [{ type: "circle", x: -20, y: 12, d: 5.5 },
               { type: "circle", x: 20, y: 12, d: 5.5 }],
  }, "sk.bolts");
  const holed = await call("hole", {
    sketch: "sk.bolts", spec: { clearance: "M5" }, counterbore: true,
    through: true, body: "half.pos",
  }, "h.bolts");
  const hr = (holed || {}).result || {};
  if (assert("a counterbored M5 clearance hole from one spec",
      holed && holed.ok === true, JSON.stringify((holed || {}).error))) {
    assert("the counterbore diameter came from the table, not from memory",
      near((hr.counterbore || {}).diameter, 10.0, 1e-6),
      "M5 cbore_d is 10.0: " + JSON.stringify(hr.counterbore));
    assert("and its depth is the head height, so the head sits flush",
      near((hr.counterbore || {}).depth, 5.0, 1e-6),
      "M5 head_h is 5.0: " + JSON.stringify(hr.counterbore));
    assert("the reply says where the counterbore came from",
      hr.counterboreFrom === "M5", JSON.stringify(hr.counterboreFrom));
    assert("the hole removed material",
      typeof hr.removed === "number" && hr.removed > 0,
      JSON.stringify(hr.removed));
    // Both instances, not one of two. A circle outside the material cuts
    // nothing, the feature still recomputes clean, and `removed > 0` from the
    // other instance covers for it -- which is the exact shape of the bug
    // this file is about.
    const bothCut = 2 * (Math.PI / 4) * (5.5 * 5.5 * (PLATE_T - 5) +
                                         10.0 * 10.0 * 5);
    assert("and both instances cut, not just the one over the material",
      near(hr.removed, bothCut, 5e-3),
      JSON.stringify({ got: hr.removed, want: bothCut }));
    assert("and the reply says how far the removal is from its own profile",
      typeof hr.removedAtProfile === "number" || hr.removedAtProfile === null,
      "volume alone cannot tell a hole from a wrong-way hole: " +
      JSON.stringify(hr.removedAtProfile));
  }

  console.log("\n--- 5b. a thread size that is not in the enumeration ---");
  await call("sketch", {
    body: "half.neg", on: "XY",
    geometry: [{ type: "circle", x: 0, y: -12, d: 4.2 }],
  }, "sk.tap");
  const tapped = await call("hole", {
    sketch: "sk.tap", spec: { tap: "M5" }, through: false, depth: 8,
    threaded: true, threadSize: "M5", body: "half.neg",
  }, "h.tap");
  const tr = (tapped || {}).result || {};
  if (tapped && tapped.ok === true) {
    assert("'M5' resolved to this build's own spelling of it",
      typeof tr.threadSize === "string" &&
        tr.threadSize.toUpperCase().indexOf("M5") === 0,
      "an M5 that silently became an M4 is the bug this replaces: " +
      JSON.stringify(tr.threadSize));
    const readback = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
h = doc.getObject("${tr.name}")
return {"ok": True, "size": str(getattr(h, "ThreadSize", "")),
        "threaded": bool(getattr(h, "Threaded", False)),
        "diameter": float(getattr(h, "Diameter", 0))}
`);
    assert("the document agrees with the reply about the size",
      !readback.__fail && readback.size === tr.threadSize,
      JSON.stringify({ said: tr.threadSize, doc: readback.size }));
    assert("and the diameter is an M5 tap drill, not an M4's 3.3",
      !readback.__fail && readback.diameter > 3.6,
      "this is the number that caught it last session: " +
      JSON.stringify(readback.diameter));
    assert("ThreadSize and ThreadedVerified cannot disagree any more",
      !((tr.applied || {}).ThreadSize === false &&
        (tr.applied || {}).ThreadedVerified === true),
      JSON.stringify(tr.applied));
  } else {
    note("the tapped hole did not apply", JSON.stringify((tapped || {}).error));
  }

  const bogus = await call("hole", {
    sketch: "sk.tap", spec: { tap: "M5" }, through: false, depth: 8,
    threaded: true, threadSize: "M5x9.9", body: "half.neg",
  }, "h.bogus");
  assert("a thread size the build does not have is REFUSED, not written",
    bogus && bogus.ok !== true &&
      String((bogus || {}).error || "").indexOf("thread") !== -1,
    "silently falling back is what produced an M4: " +
    JSON.stringify({ ok: (bogus || {}).ok, error: (bogus || {}).error }));

  // ====================================================================
  // 6. fastener_pattern: one master, hidden
  // ====================================================================
  console.log("\n--- 6. seat 0 holds one bolt ---");
  const fp = await call("fastener_pattern", {
    hole: "h.bolts", fastener: "M5", length: 16,
  }, "bolt.face");
  const fr = (fp || {}).result || {};
  if (assert("the pattern applied", fp && fp.ok === true,
      JSON.stringify((fp || {}).error))) {
    assert("the master is hidden, so seat 0 is one bolt and not two",
      fr.masterHidden === true, JSON.stringify(fr.masterHidden));
    assert("and there is a link for every hole",
      (fr.links || []).length === fr.count && fr.count === 2,
      JSON.stringify({ links: (fr.links || []).length, count: fr.count }));
    const atSeat = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
want = ${JSON.stringify((fr.at || [])[0] || [0, 0, 0])}
n = 0
for o in doc.Objects:
    if not bool(getattr(o, "Visibility", False)):
        continue
    if getattr(o, "Shape", None) is None:
        continue
    try:
        b = o.Placement.Base
    except Exception:
        continue
    if max(abs(b.x - want[0]), abs(b.y - want[1]), abs(b.z - want[2])) < 1e-6:
        n += 1
return {"ok": True, "visibleAtSeat0": n}
`);
    assert("exactly one visible object sits at seat 0",
      !atSeat.__fail && atSeat.visibleAtSeat0 === 1,
      "master visible = doubled bolt, which is what toggling the part in the " +
      "tree used to reveal: " + JSON.stringify(atSeat));
    assert("the head drops into the counterbore by default",
      fr.offsetFrom === "counterbore" && near(fr.offset, -5, 1e-6),
      "heads sitting on the face is not a default anybody wants: " +
      JSON.stringify({ offset: fr.offset, from: fr.offsetFrom }));

    const isoSet = await call("isolate", { targets: ["bolt.face.set"] }, null);
    const isr = (isoSet || {}).result || {};
    const masterVis = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True,
        "master": bool(doc.getObject("${fr.name}").Visibility)}
`);
    assert("isolating the set does not bring the master back",
      !masterVis.__fail && masterVis.master === false,
      JSON.stringify(masterVis));
    assert("and the isolate reply is still finite",
      typeof isr.span === "number" && isr.span < 1e6, JSON.stringify(isr.span));
    await call("view_restore", {}, null);
  }

  // ====================================================================
  // 7. bom and measure: a list a human can read
  // ====================================================================
  console.log("\n--- 7. the source of a split is not a third part ---");
  const bom = await call("bom", {}, null);
  const br2 = (bom || {}).result || {};
  const fab = br2.fabricated || [];
  const srcRow = fab.filter((r) => r.role === "split-source")[0];
  assert("the solid the halves were cut from is marked, not billed",
    !!srcRow, JSON.stringify(fab.map((r) => [r.name, r.role])));
  assert("and it is left out of the fabricated volume",
    typeof br2.fabricatedVolumeMm3 === "number" &&
      br2.fabricatedVolumeMm3 < plateVol,
    JSON.stringify({ total: br2.fabricatedVolumeMm3, plate: plateVol }));
  assert("every purchased line says whether it is seated or catalog-only",
    (br2.purchased || []).length > 0 &&
      (br2.purchased || []).every((p) =>
        p.role === "seated" || p.role === "catalog-only"),
    JSON.stringify((br2.purchased || []).map((p) => [p.id, p.role])));
  assert("the hardware quantity is the number of links",
    (br2.purchased || []).some((p) => p.qty === 2),
    JSON.stringify((br2.purchased || []).map((p) => [p.id, p.qty])));

  console.log("\n--- 7b. measure, without the universe ---");
  const mAll = parseResult(await tools.freecad_measure({}));
  const mParts = parseResult(await tools.freecad_measure({ partsOnly: true }));
  assert("partsOnly measures fewer objects than everything with a shape",
    (mParts.objects || []).length > 0 &&
      (mParts.objects || []).length < (mAll.objects || []).length,
    JSON.stringify({ all: (mAll.objects || []).length,
                     parts: (mParts.objects || []).length }));
  const measured = mParts.measured || [];
  assert("no sketch is in it",
    measured.every((n) => n.toLowerCase().indexOf("sketch") === -1),
    JSON.stringify(measured));
  const hiddenOnes = await probe(`
import FreeCAD as App, koi_cad
doc = App.getDocument("${DOC}")
src = koi_cad.resolve(doc, "body.plate")
return {"ok": True, "source": None if src is None else src.Name,
        "sourceVisible": None if src is None else bool(src.Visibility)}
`);
  if (!hiddenOnes.__fail && hiddenOnes.source) {
    assert("the hidden split source is not measured against its own halves",
      measured.indexOf(hiddenOnes.source) === -1,
      "source-vs-snapshot hits are noise, not interference: " +
      JSON.stringify(measured));
  }
  if ((fr || {}).name) {
    assert("nor is the hidden pattern master against its own links",
      measured.indexOf(fr.name) === -1, JSON.stringify(measured));
  }
  const mi = parseResult(await tools.freecad_measure(
    { partsOnly: true, interference: true }));
  const hits = ((mi.interference || {}).hits || []);
  assert("and the interference hits are about real parts",
    hits.every((h) => h.a !== hiddenOnes.source && h.b !== hiddenOnes.source),
    JSON.stringify(hits));

  // ====================================================================
  // 8. a chamfer that survives the parameter it depends on
  // ====================================================================
  console.log("\n--- 8. chamfer by filter, not by Edge124 ---");
  const chBad = await call("chamfer", { body: "half.neg", size: 1 }, "ch.none");
  assert("a chamfer with neither refs nor query is still refused",
    chBad && chBad.ok !== true,
    "the ban on authoring an edge index has not been loosened: " +
    JSON.stringify({ ok: (chBad || {}).ok }));

  const ch = await call("chamfer", {
    body: "half.neg", size: 1,
    query: { kind: "edge", direction: "+Z", expect: "many" },
  }, "ch.verticals");
  const chr = (ch || {}).result || {};
  if (assert("a chamfer placed from a query applies",
      ch && ch.ok === true, JSON.stringify((ch || {}).error))) {
    assert("and it kept the filter, not only the indices",
      !!chr.query && typeof chr.durability === "string" &&
        chr.durability.indexOf("re-resolved") !== -1,
      JSON.stringify({ query: chr.query, durability: chr.durability }));
    assert("it removed material",
      typeof chr.volumeDelta === "number" && chr.volumeDelta < 0,
      JSON.stringify(chr.volumeDelta));

    const stored = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
m = dict(doc.Meta or {})
keys = [k for k in m if k.startswith("koi.dress.")]
return {"ok": True, "keys": keys}
`);
    assert("the filter is stored with the document, not with the turn",
      !stored.__fail && (stored.keys || []).length > 0,
      JSON.stringify(stored));

    // The regression. Last session growing SplitOffset by 6 mm aborted the
    // whole parametric write with new-recompute-errors: chamfer_outer, and
    // recovery was thirteen manual steps.
    console.log("\n--- 8b. moving the parameter the chamfer stands on ---");
    const grew = await call("param", { alias: "CutAt", value: 8 }, null);
    assert("the parameter change was NOT aborted by the chamfer",
      grew && grew.ok === true && grew.aborted !== true,
      "this is the abort that cost the session thirteen steps: " +
      JSON.stringify({ reason: (grew || {}).reason,
                       newErrors: (grew || {}).newErrors }));
    if ((grew || {}).rehealed) {
      assert("and when the edges renumbered it said it re-resolved them",
        (grew.rehealed || []).some((r) => r.feature === chr.name),
        JSON.stringify(grew.rehealed));
      console.log("   rehealed: " + JSON.stringify(grew.rehealed));
    } else {
      note("the edges did not renumber on this build",
        "the reheal path was not exercised; the storage assertion above still " +
        "holds and the abort did not happen");
    }
    const chOk = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
c = doc.getObject("${chr.name}")
return {"ok": True, "valid": None if c is None else bool(c.isValid()),
        "state": [] if c is None else list(c.State)}
`);
    assert("the chamfer is still a valid feature afterwards",
      !chOk.__fail && chOk.valid === true, JSON.stringify(chOk));
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

  console.log("\n=== visible: " + pass + " passed, " + fail + " failed, " +
    warn + " notes ===");
  console.log("Valid ONLY for build " + (build.exeVersion || build.version) +
    " @ " + String(build.commit).slice(0, 12));

  return { success: fail === 0, pass, fail, warn, results,
    build: { version: build.exeVersion, commit: build.commit } };
}

return run().catch((e) => {
  if (e instanceof TransportLost) {
    const msg =
      "TRANSPORT LOST after " + pass + " passed / " + fail + " failed. The tab " +
      "stopped answering. Reload the FreeCAD tab and re-run. Everything above " +
      "this line already happened and stands.\n\ndetail: " + e.message;
    console.error(msg);
    results.push("❌ transport lost — run aborted");
    return { success: false, pass, fail, warn, results, transportLost: true, error: msg };
  }
  console.error(e);
  results.push("❌ " + e.message);
  return { success: false, pass, fail, warn, results, error: e.message };
});
