// scripts/test_parts.js — harness for purchased parts (§7, §8.2, §8.4).
//
//   /skill freecad-live/scripts/test_parts.js --full-auto
//
// This is the test the project exists for. §7.1: a component is not a solid,
// it is an interface plus an envelope plus metadata. If that is true, then
// swapping M5 for M6 must move the plate's holes and counterbores without
// anything touching the plate — and the proof is a volume, not a screenshot.
//
// Requires `probe-exec: on` in SKILL.md.
//
// Scratch document PartsTest, closed at the end.

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

async function probe(python, timeoutMs) {
  const r = guard(parseResult(
    await tools.freecad_exec({ python, timeoutMs: timeoutMs || 30000 })));
  if (!r || r.ok !== true) return { __fail: (r && r.error) || "exec failed" };
  const d = r.result || {};
  if (d.ok === false) return { __fail: d.error || "returned ok:false" };
  return d;
}

const DOC = "PartsTest";
const near = (a, b, tol) => typeof a === "number" && Math.abs(a - b) < (tol || 1e-3);
const PI = Math.PI;

// The plate P3 builds and P4 swaps, in closed form. Declared once at module
// scope because both sections need them: P3 checks the cut, P4 checks the
// delta, and a constant that exists in only one of the two blocks is a
// ReferenceError waiting for the run that gets that far.
const PLATE = 60 * 40 * 10;
const wantHole = PI * 2.75 * 2.75 * 10;             // M5 clearance, through 10
const wantCbore = PI * (5 * 5 - 2.75 * 2.75) * 5;   // its counterbore ring
const wantM6 = PI * 3.3 * 3.3 * 10 + PI * (5.5 * 5.5 - 3.3 * 3.3) * 5;

async function run() {
  console.log("=== purchased parts / propagation tests ===");
  console.log("Scratch document: " + DOC + "\n");

  const attach = parseResult(await tools.freecad_attach({ timeoutMs: 240000 }));
  if (!assert("attached", attach && attach.attached === true,
      (attach && (attach.error || attach.detail)) || "unknown")) {
    return { success: false, pass, fail, results, error: "not attached" };
  }
  const build = attach.build || {};
  console.log("   build: " + build.exeVersion + " @ " + String(build.commit).slice(0, 12));
  console.log("   (valid only against the probe results for this build)\n");

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
    return { success: false, pass, fail, results, error: "no scratch doc" };
  }
  assert("the document was read before editing it",
    !!(await sync()).tree, "sync failed");

  // ---- P1: the table is quotable ----
  console.log("--- P1: the table, not recollection ---");
  const lib = await call("library", { what: "fasteners" }, null);
  const F = ((lib.result || {}).fasteners) || {};
  assert("the fastener table is readable", !!F.M5, JSON.stringify(Object.keys(F)));
  assert("M5 normal clearance is 5.5", near(F.M5.clearance.normal, 5.5),
    JSON.stringify(F.M5 && F.M5.clearance));
  assert("M5 head is 8.5 across", near(F.M5.head_d, 8.5), JSON.stringify(F.M5.head_d));
  assert("M6 clearance is 6.6", near(F.M6.clearance.normal, 6.6),
    JSON.stringify(F.M6.clearance));
  assert("reading the table books no undo entry", lib.mode === "read",
    JSON.stringify(lib.mode));

  // ---- P2: an envelope is generated from data ----
  console.log("\n--- P2: envelope-from-JSON ---");
  const motor = await call("insert", { catalog: "NEMA17_envelope" }, "motor");
  const built = assert("the NEMA 17 envelope was inserted",
    motor && motor.applied === true,
    JSON.stringify(motor && { reason: motor.reason, error: motor.error }));
  if (built) {
    const m = motor.result || {};
    assert("it carries its manufacturer part number",
      (m.meta || {}).mpn === "17HS4401", JSON.stringify(m.meta));
    assert("and its mass, because the design is measured against it",
      (m.meta || {}).mass_g === 280, JSON.stringify(m.meta));
    assert("its bolt pattern is four holes on a 31 mm square",
      (m.boltPositions || []).length === 4 &&
        near(Math.abs(m.boltPositions[0][0]), 15.5),
      JSON.stringify(m.boltPositions));
    // Body 34 tall, then a 2 mm pilot boss and a 24 mm shaft BOTH rising from
    // the mounting face at z=34 — the shaft length is measured from the face
    // and the boss is concentric around it, so the envelope is 34 + 24, not
    // 34 + 2 + 24. Getting this wrong is exactly the mistake a clearance
    // check would inherit.
    const bb = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
b = doc.getObject("${m.name}").Shape.BoundBox
return {"ok": True, "x": b.XLength, "y": b.YLength, "z": b.ZLength}
`);
    assert("the envelope is the size the data file says",
      !bb.__fail && near(bb.x, 42.3, 0.01) && near(bb.y, 42.3, 0.01) &&
        near(bb.z, 34 + 24, 0.01),
      bb.__fail || JSON.stringify(bb));
    assert("the interface was published into the parameter sheet",
      Object.keys(m.aliases || {}).length > 0, JSON.stringify(m.aliases));
  }

  const brg = await call("insert", { catalog: "6805_bearing", at: [80, 0, 0] }, "bearing");
  if (assert("the bearing envelope was inserted", brg && brg.applied === true,
      JSON.stringify(brg && brg.error))) {
    // OD 37, bore 25, width 7 — a ring, so the volume is the difference.
    const v = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "volume": doc.getObject("${(brg.result || {}).name}").Shape.Volume}
`);
    assert("the bore is really a bore, by volume",
      !v.__fail && near(v.volume, PI * (18.5 * 18.5 - 12.5 * 12.5) * 7, 1),
      v.__fail || JSON.stringify(v));
  }

  // ---- P3: a plate that references the fastener ----
  console.log("\n--- P3: a plate whose holes are the fastener's numbers ---");
  const bolt = await call("insert", { fastener: "M5", length: 16, at: [0, 0, 60] },
    "bolt.mount");
  assert("an M5 socket head cap screw was inserted",
    bolt && bolt.applied === true, JSON.stringify(bolt && bolt.error));
  assert("its published interface includes the clearance",
    Object.keys((bolt.result || {}).aliases || {}).some((k) => k.indexOf("clearance") !== -1),
    JSON.stringify((bolt.result || {}).aliases));

  const plateBody = await call("body", { label: "Plate" }, "body.plate");
  assert("the plate body was created", plateBody && plateBody.applied === true,
    JSON.stringify(plateBody && plateBody.error));
  const sk = await call("sketch", {
    body: "body.plate", on: "XY",
    geometry: [{ type: "rect", w: 60, h: 40 }],
  }, "sk.plate");
  assert("the plate sketch applied", sk && sk.applied === true,
    JSON.stringify(sk && sk.error));
  const pad = await call("pad", { sketch: "sk.plate", length: 10 }, "pad.plate");
  assert("the plate was padded", pad && pad.applied === true,
    JSON.stringify(pad && pad.error));

  const skh = await call("sketch", {
    body: "body.plate", on: "XY",
    geometry: [{ type: "circle", x: 15, y: 10, d: 5 }],
  }, "sk.hole");
  assert("the hole sketch applied", skh && skh.applied === true,
    JSON.stringify(skh && skh.error));

  const hole = await call("hole", {
    sketch: "sk.hole",
    spec: { from: "bolt.mount.clearance" },
    counterbore: { from: "bolt.mount.cbore", depth: 5 },
    through: true,
  }, "h.mount");
  const drilled = assert("the hole was cut", hole && hole.applied === true,
    JSON.stringify(hole && { reason: hole.reason, error: hole.error,
      applied: (hole.result || {}).applied }));
  if (drilled) {
    const h = hole.result || {};
    console.log("   properties this build accepted: " + JSON.stringify(h.applied));
    assert("its diameter is the fastener's clearance, not a guess",
      near(h.diameter, 5.5, 0.01), JSON.stringify(h.diameter));
    assert("and it is bound by expression, not copied",
      typeof h.boundTo === "string" && h.boundTo.indexOf("koi_params") === 0,
      JSON.stringify(h.boundTo));
    assert("the hole removed material", h.removed > 0,
      JSON.stringify({ removed: h.removed, flipped: h.flipped, note: h.note }));
    if (h.flipped === true) {
      assert("a flipped hole says so rather than doing it silently",
        typeof h.note === "string" && h.note.indexOf("flip") !== -1,
        JSON.stringify(h.note));
      console.log("   " + h.note);
    }
    // Ø5.5 through 10 mm, PLUS the Ø10 x 5 counterbore that was asked for in
    // the same call — the counterbore removes another ring, and forgetting it
    // is how a "the hole is too big" bug report gets filed against geometry
    // that is correct.
    assert("the removal is the hole plus its counterbore, to the millimetre",
      near(h.removed, wantHole + wantCbore, 0.5),
      JSON.stringify({ removed: h.removed, expected: wantHole + wantCbore }));
    assert("no thread was modelled", h.modeledThread === false,
      JSON.stringify(h.modeledThread));
  }

  // ---- P4: the swap. This is the argument. ----
  if (drilled) {
    console.log("\n--- P4: M5 -> M6, without touching the plate ---");
    // Measure the BODY, not the Pad. A Pad is an intermediate feature and its
    // shape is the solid as it stood before the hole was cut, so it would
    // read 24000 for ever no matter what the hole did — a measurement that
    // can never move is not evidence.
    const BODY = (plateBody.result || {}).name;
    const before = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
h = doc.getObject("${(hole.result || {}).name}")
return {"ok": True, "d": float(h.Diameter),
        "volume": doc.getObject("${BODY}").Shape.Volume}
`);
    assert("the plate is measured before the swap", !before.__fail,
      before.__fail || "");
    assert("and the measurement already reflects the hole",
      near(before.volume, PLATE - (wantHole + wantCbore), 1),
      JSON.stringify({ volume: before.volume,
                       expected: PLATE - (wantHole + wantCbore) }));

    const swap = await call("swap", { target: "bolt.mount", fastener: "M6", length: 16 },
      null);
    assert("the swap applied", swap && swap.applied === true,
      JSON.stringify(swap && { reason: swap.reason, error: swap.error }));
    const changed = (swap.result || {}).changed || [];
    assert("the swap says which published values moved", changed.length > 0,
      JSON.stringify(changed));
    console.log("   " + changed.map((c) => c.alias + " " + c.from + "->" + c.to).join(", "));

    const after = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
h = doc.getObject("${(hole.result || {}).name}")
return {"ok": True, "d": float(h.Diameter),
        "volume": doc.getObject("${BODY}").Shape.Volume}
`);
    // The whole design in one assertion: nothing addressed the plate, and the
    // plate changed, because an expression pointed at the cell that moved.
    assert("the hole followed the fastener to 6.6 mm",
      !after.__fail && near(after.d, 6.6, 0.01),
      after.__fail || JSON.stringify({ before: before.d, after: after.d }));
    // The counterbore is bound too, so both grow: Ø6.6 through 10 and a Ø11
    // counterbore 5 deep. Asserting the exact delta rather than "smaller"
    // is what distinguishes propagation from coincidence.
    assert("and the solid lost exactly the extra material an M6 takes",
      !after.__fail &&
        near(before.volume - after.volume, wantM6 - (wantHole + wantCbore), 1),
      JSON.stringify({ before: before.volume, after: after.volume,
                       delta: before.volume - after.volume,
                       expected: wantM6 - (wantHole + wantCbore) }));
    assert("nothing on the plate was edited to make that happen",
      ((swap.diff || {}).changed || []).every((c) => c.name !== (pad.result || {}).name),
      JSON.stringify((swap.diff || {}).changed));

    const back = await call("swap", { target: "bolt.mount", fastener: "M5", length: 16 },
      null);
    const restored = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "d": float(doc.getObject("${(hole.result || {}).name}").Diameter)}
`);
    assert("and it swaps back", back && back.applied === true && !restored.__fail &&
      near(restored.d, 5.5, 0.01), JSON.stringify(restored));
  }

  // ---- P5: NEMA 17 -> NEMA 23 ----
  if (built) {
    console.log("\n--- P5: NEMA 17 -> NEMA 23 ---");
    const before = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
b = doc.getObject("${(motor.result || {}).name}").Shape.BoundBox
return {"ok": True, "x": b.XLength}
`);
    const swap = await call("swap",
      { target: "motor", catalog: "NEMA23_envelope" }, null);
    assert("the motor swap applied", swap && swap.applied === true,
      JSON.stringify(swap && { reason: swap.reason, error: swap.error }));
    const after = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
b = doc.getObject("${(motor.result || {}).name}").Shape.BoundBox
return {"ok": True, "x": b.XLength}
`);
    assert("the envelope grew to the NEMA 23 frame",
      !after.__fail && near(after.x, 56.4, 0.01),
      JSON.stringify({ before: before.x, after: after.x }));
    assert("and its bolt pattern moved with it",
      near(Math.abs(((swap.result || {}).boltPositions || [[0]])[0][0]), 47.14 / 2, 0.01),
      JSON.stringify((swap.result || {}).boltPositions));
    const meas = guard(parseResult(await tools.freecad_measure({ interference: true })));
    assert("a bigger motor is checked for clash without being asked twice",
      Array.isArray(((meas.interference || {}).pairs)),
      JSON.stringify(meas.error));
    console.log("   interference hits after the swap: " +
      JSON.stringify(((meas.interference || {}).hits || []).map((h) => h.a + "/" + h.b)));
  }

  // ---- P6: the professional rules ----
  console.log("\n--- P6: dimensions that cannot be bought ---");
  const odd = await call("sketch", {
    body: "body.plate", on: "XY",
    geometry: [{ type: "circle", x: 45, y: 30, d: 5 }],
  }, "sk.odd");
  const oddHole = await call("hole",
    { sketch: "sk.odd", diameter: 9.3, through: true }, "h.odd");
  if (oddHole && oddHole.applied === true) {
    const s6 = await sync();
    const codes = (s6.lint || [])
      .filter((w) => w.object === (oddHole.result || {}).name)
      .map((w) => w.code);
    assert("a 9.3 mm hole is flagged as undrillable",
      codes.indexOf("non-stock") !== -1, JSON.stringify(codes));
    const good = (s6.lint || []).filter(
      (w) => w.object === (hole.result || {}).name && w.code === "non-stock");
    assert("while a clearance hole from the table is not", good.length === 0,
      JSON.stringify(good));
  } else {
    note("the odd hole did not apply", JSON.stringify(oddHole && oddHole.reason));
  }

  const shallow = await call("sketch", {
    body: "body.plate", on: "XY",
    geometry: [{ type: "circle", x: 45, y: 10, d: 4 }],
  }, "sk.tap");
  const tapped = await call("hole", {
    sketch: "sk.tap", spec: { tap: "M5" }, through: false, depth: 4,
    threaded: true, threadSize: "M5",
  }, "h.tap");
  if (tapped && tapped.applied === true) {
    console.log("   tapped hole properties accepted: " +
      JSON.stringify((tapped.result || {}).applied));
    if ((tapped.result || {}).threadNote) {
      note("this build refused the thread specification",
        (tapped.result || {}).threadNote);
    }
    // 'M5' is not necessarily how this build spells M5. It answered the write
    // with a refusal, kept Threaded:true, and the hole quietly became an M4 at
    // Ø3.3 — with the reply saying ThreadSize:false and ThreadedVerified:true
    // about the same object. The size now resolves against the build's own
    // enumeration and is read back.
    assert("the thread size resolved to a spelling this build has",
      typeof (tapped.result || {}).threadSize === "string" &&
        (tapped.result || {}).threadSize.toUpperCase().indexOf("M5") === 0,
      JSON.stringify((tapped.result || {}).threadSize));
    assert("so ThreadSize and ThreadedVerified cannot contradict each other",
      !(((tapped.result || {}).applied || {}).ThreadSize === false &&
        ((tapped.result || {}).applied || {}).ThreadedVerified === true),
      JSON.stringify((tapped.result || {}).applied));
    const tapDia = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
h = doc.getObject("${(tapped.result || {}).name}")
return {"ok": True, "size": str(getattr(h, "ThreadSize", "")),
        "diameter": float(getattr(h, "Diameter", 0))}
`);
    assert("and the drilled diameter is an M5 tap drill, not an M4's 3.3",
      !tapDia.__fail && tapDia.diameter > 3.6,
      "reading Diameter is how the silent downgrade was caught: " +
      JSON.stringify(tapDia));
    const s6b = await sync();
    const codes = (s6b.lint || [])
      .filter((w) => w.object === (tapped.result || {}).name)
      .map((w) => w.code);
    if ((tapped.result || {}).applied &&
        (tapped.result || {}).applied.ThreadedVerified === false) {
      note("the engagement rule has nothing to fire on",
        "the hole is drilled, not tapped, because the build refused Threaded");
    } else {
      assert("an M5 tapped only 4 mm deep is flagged as stripping",
        codes.indexOf("thread-engagement") !== -1, JSON.stringify(codes));
    }
    assert("and the tapped hole actually cut into the plate",
      (tapped.result || {}).removed > 0,
      JSON.stringify({ removed: (tapped.result || {}).removed,
                       flipped: (tapped.result || {}).flipped }));
    assert("and no helix was cut for it",
      (tapped.result || {}).modeledThread === false,
      JSON.stringify(tapped.result));
    const helix = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
h = doc.getObject("${(tapped.result || {}).name}")
return {"ok": True,
        "modelled": bool(getattr(h, "ModelThread", False)) or
                    bool(getattr(h, "ModelActualThread", False)),
        "threaded": bool(getattr(h, "Threaded", False))}
`);
    assert("the document agrees: specified, not modelled",
      !helix.__fail && helix.modelled === false,
      helix.__fail || JSON.stringify(helix));
  } else {
    note("the tapped hole did not apply", JSON.stringify(tapped && tapped.reason));
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

  console.log("\n=== parts: " + pass + " passed, " + fail + " failed, " +
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
