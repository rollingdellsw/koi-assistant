// scripts/test_inspect.js — the P1 surface: measuring, weighing, seeing in,
// rebuilding, and asking the build what it can do.
//
// Runs against a fixture with numbers chosen so every assertion is arithmetic
// a human can check without opening FreeCAD:
//
//     plate  60 x 40 x 10, centred on the origin, padded +Z
//     two Ø8 bores, through, at x = -20 and x = +20
//
// So: axis distance between the bores is 40.000 and nothing else; the
// material between them is 40 - 4 - 4 = 32.000; the top and bottom faces are
// parallel at 10.000; the plate weighs 60*40*10 mm3 minus two bores of
// 8 mm diameter, in 6061 at 2.70 g/cm3, which the suite computes rather than
// hard-codes so a fillet added to the fixture later does not read as a bug.
//
// What each test is actually defending:
//
//   THE BUG THIS SUITE FOUND IN ITSELF: every measurement below used to be
//   taken against pad.plate, which is the PAD feature. In PartDesign a
//   feature's shape is the solid as it was at THAT point in the tree, so the
//   pad of a plate that is bored two features later reports 24000 mm3 for a
//   part that is 22994.8 — correctly, and indistinguishably from the pocket
//   having silently failed, which is what the first run was read as. The
//   fixture now measures body.plate, the finished solid, and freecad_measure
//   and query both carry a notTip note so the next person does not spend an
//   afternoon on it.
//
//   4-7   measure_between exists because a screenshot cannot tell 40.0 from
//         40.4, and freecad_measure's clearance walk only ever compared whole
//         objects — the bore-to-bore dimension, which is the one an engineer
//         asks for all day, was not askable at all.
//   8-10  a BOM that reports mass for every bought washer and nothing for the
//         part the design is made of is a BOM with a hole in the one column
//         somebody wanted. Test 10 is that the hole is now either filled or
//         NAMED, never silently zero.
//   11-12 refine changes topology and must not change material. If the volume
//         moves, something other than a cleanup happened.
//   13-14 a clip plane belongs to the view. Test 14 is that view_restore
//         takes it away again — a session that leaves the human's model half
//         gone has done the same thing as leaving it isolated.
//
// Run:  /skill freecad-live/scripts/test_inspect.js --full-auto
//
// HARNESS: same block as scripts/test_io.js. If that one needed adjusting to
// match the sandbox, this one needs the identical change.

const TOOLS = (typeof tools !== "undefined" && tools) ||
  (typeof globalThis !== "undefined" && globalThis.tools) || null;

async function invoke(name, args) {
  if (!TOOLS) throw new Error("no tools object in scope — align the harness block with scripts/test_flow.js");
  if (typeof TOOLS[name] === "function") return TOOLS[name](args || {});
  if (typeof TOOLS.callTool === "function") return TOOLS.callTool(name, args || {});
  if (typeof TOOLS.call === "function") return TOOLS.call(name, args || {});
  throw new Error("cannot invoke " + name + " through this harness");
}

function unwrap(res) {
  if (res == null) return {};
  if (typeof res === "string") { try { return JSON.parse(res); } catch (_) { return { raw: res }; } }
  if (Array.isArray(res.content)) {
    const t = res.content.find((c) => c && c.type === "text");
    if (t) { try { return JSON.parse(t.text); } catch (_) { return { raw: t.text }; } }
  }
  return res;
}

const call = async (fn, args, id) =>
  unwrap(await invoke("freecad_call", Object.assign({ fn, args: args || {} }, id ? { id } : {})));
const measure = async (args) => unwrap(await invoke("freecad_measure", args || {}));
const sync = async () => unwrap(await invoke("freecad_sync", {}));

const results = [];
let failed = 0;
const envelope = (r) => (r && r.result && typeof r.result === "object" ? r.result : r) || {};
const near = (a, b, tol) => a != null && Math.abs(Number(a) - Number(b)) <= (tol == null ? 1e-3 : tol);
const errorOf = (r) => String((r && (r.error || (r.result || {}).error)) || "");

const MARK_PASS = "\u2705";        // white heavy check mark
const MARK_FAIL = "\u274C \u274C";  // two cross marks: a failure should be findable by eye
const MARK_SKIP = "\u23ED";        // skipped, which is not passed

function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? "" : String(detail).slice(0, 400) });
  if (!ok) failed += 1;
  console.log((ok ? MARK_PASS + "  PASS  " : MARK_FAIL + "  FAIL  ") + name +
    (detail ? " — " + String(detail).slice(0, 220) : ""));
}

function skip(name, why) {
  results.push({ name, ok: true, skipped: true, detail: why });
  console.log(MARK_SKIP + "  SKIP  " + name + " — " + why);
}

// Deliberately does NOT judge the returned value: several tests assert that
// an op refuses, record() their own verdict and then return the refusal.
async function step(name, fn) {
  try { return await fn(); }
  catch (e) { record(name, false, e && e.message); return null; }
}

const DOC = "KoiInspectTest";

async function main() {
  const st = {};

  await step("0. fixture", async () => {
    await call("new_document", { name: DOC }, "doc.insp");
    await sync();
    const r = await call("batch", {
      ops: [
        { fn: "body", args: { label: "Plate" }, id: "body.plate" },
        { fn: "sketch", args: {
            body: "body.plate", on: "XY",
            geometry: [{ type: "rect", anchor: "center", x: 0, y: 0, w: 60, h: 40 }],
          }, id: "sk.plate" },
        { fn: "pad", args: { sketch: "sk.plate", length: 10 }, id: "pad.plate" },
        { fn: "sketch", args: {
            body: "body.plate", on: "XY",
            geometry: [
              { type: "circle", x: -20, y: 0, d: 8 },
              { type: "circle", x: 20, y: 0, d: 8 },
            ],
          }, id: "sk.bores" },
        { fn: "pocket", args: { sketch: "sk.bores", through: true }, id: "cut.bores" },
      ],
    });
    if (r.ok === false) return record("0. fixture: plate with two Ø8 bores", false, errorOf(r));
    // body.plate, NOT pad.plate. The body's shape is its tip's shape, which
    // is the pocket — the finished part. The pad's shape is the plate before
    // the bores, and asking it is how this suite convinced itself the pocket
    // was broken.
    const m = await measure({ refs: ["body.plate"] });
    const row = (m.objects || [])[0] || {};
    st.volume = row.volume;
    const want = 60 * 40 * 10 - 2 * Math.PI * 16 * 10;
    record("0. fixture: plate with two Ø8 bores",
      near(st.volume, want, 2) && !row.notTip,
      "volume " + st.volume + " (want " + want.toFixed(1) + ")");
    return r;
  });

  // -- 0b. and the trap itself, asserted rather than avoided. -------------
  await step("0b. a mid-tree feature is flagged, not silently stale", async () => {
    const m = await measure({ refs: ["pad.plate"] });
    const row = (m.objects || [])[0] || {};
    const q = envelope(await call("query", {
      of: "pad.plate", kind: "face", surface: "Cylinder", radius: 4, expect: "many",
    }));
    const ok = near(row.volume, 24000, 1) && !!row.notTip &&
      q.matched === 0 && !!q.notTip;
    record("0b. a mid-tree feature is flagged, not silently stale", ok,
      "pad reads " + row.volume + " (the plate before the bores) and says so: " +
      String((row.notTip || {}).note || "NO NOTE").slice(0, 90));
    if (!ok && !row.notTip) {
      // The note firing depends on finding the Body a feature belongs to,
      // and the first version of that trusted one API. If it goes quiet
      // again, print what the interpreter actually returns rather than
      // guessing across a bridge a second time.
      const d = envelope(await script(
        "import FreeCAD as App\n" +
        "o = App.ActiveDocument.getObject('pad_plate')\n" +
        "g = None\n" +
        "try:\n" +
        "    p = o.getParentGeoFeatureGroup()\n" +
        "    g = None if p is None else (p.Name, p.TypeId)\n" +
        "except Exception as e:\n" +
        "    g = 'raised: %s' % type(e).__name__\n" +
        "bodies = [(b.Name, [m.Name for m in (b.Group or [])], \n" +
        "           getattr(getattr(b, 'Tip', None), 'Name', None))\n" +
        "          for b in App.ActiveDocument.Objects\n" +
        "          if b.TypeId == 'PartDesign::Body']\n" +
        "return {'typeId': o.TypeId, 'parentGeoGroup': g, 'bodies': bodies}\n"
      ));
      console.log("        diagnostic: " + JSON.stringify(d).slice(0, 400));
    }
    return m;
  });

  // -- find the entities by geometry. Never by index, same rule as fillet. --
  await step("1. query finds the two bore walls", async () => {
    const q = envelope(await call("query", {
      of: "body.plate", kind: "face", surface: "Cylinder", radius: 4, expect: "many",
    }));
    st.bores = (q.refs || []).slice(0, 2);
    record("1. query finds the two bore walls",
      st.bores.length === 2, JSON.stringify(q.refs || q));
    return q;
  });

  await step("2. query finds the top and bottom faces", async () => {
    // By position, not by direction. A solid's bottom face has an outward
    // normal of -Z and an underlying Plane whose axis is +Z, and which of
    // those a filter means is a detail worth not depending on: at:{z} is
    // unambiguous, and it is what a human would say out loud.
    const top = envelope(await call("query", {
      of: "body.plate", kind: "face", surface: "Plane", at: { z: 10 }, expect: 1,
    }));
    const bot = envelope(await call("query", {
      of: "body.plate", kind: "face", surface: "Plane", at: { z: 0 }, expect: 1,
    }));
    st.top = (top.refs || [])[0];
    st.bottom = (bot.refs || [])[0];
    record("2. query finds the top and bottom faces",
      !!st.top && !!st.bottom,
      st.top + " / " + st.bottom + "  (matched " + top.matched + "/" + bot.matched + ")");
    return top;
  });

  // -- 3. one entity, exactly. The question a render cannot answer. --------
  await step("3. measure_between reports one bore's diameter", async () => {
    if (!st.bores || !st.bores.length) return record("3. measure_between reports one bore's diameter", false, "no bore ref");
    const r = envelope(await call("measure_between", { a: st.bores[0] }));
    // {a: {ref, object, element, geometry}} — one entity still comes back
    // under 'a', because a reply whose shape changes with the arity is a
    // reply every caller has to branch on. The first version of this test
    // read r.geometry and reported Øundefined against a working op.
    const g = (r.a || {}).geometry || {};
    record("3. measure_between reports one bore's diameter",
      near(g.diameter, 8, 0.01) && g.surface === "Cylinder",
      "Ø" + g.diameter + " axis " + JSON.stringify(g.axis));
    return r;
  });

  // -- 4. THE dimension. Bore centres, 40.000 and nothing else. -----------
  await step("4. bore-to-bore axis distance is exact", async () => {
    if (!st.bores || st.bores.length < 2) return record("4. bore-to-bore axis distance is exact", false, "no bore refs");
    const r = envelope(await call("measure_between", { a: st.bores[0], b: st.bores[1] }));
    st.pair = r;
    record("4. bore-to-bore axis distance is exact",
      near(r.axisDistance, 40, 0.001) && r.axesParallel === true && r.coaxial === false,
      "axisDistance " + r.axisDistance + " parallel=" + r.axesParallel);
    return r;
  });

  // -- 5. the number that is NOT the centre distance, and gets confused
  // with it: material left between the two bores.
  await step("5. wall between the bores is axis distance minus both radii", async () => {
    const r = st.pair || {};
    record("5. wall between the bores is axis distance minus both radii",
      near(r.wallBetween, 32, 0.01) && near(r.minDistance, 32, 0.01),
      "wallBetween " + r.wallBetween + " minDistance " + r.minDistance + " (want 32)");
    return r;
  });

  // -- 6. parallel faces, and the offset that is the plate thickness ------
  await step("6. top and bottom are parallel at the plate thickness", async () => {
    if (!st.top || !st.bottom) return record("6. top and bottom are parallel at the plate thickness", false, "no face refs");
    const r = envelope(await call("measure_between", { a: st.top, b: st.bottom }));
    // Normals point apart, so the raw angle is 180 and the useful one is 0.
    record("6. top and bottom are parallel at the plate thickness",
      r.parallel === true && near(r.angleBetweenDeg, 0, 0.01) &&
      near(r.minDistance, 10, 0.001) && near(r.offset, 10, 0.001),
      "angle " + r.angleDeg + " -> " + r.angleBetweenDeg + ", offset " + r.offset);
    return r;
  });

  // -- 7. perpendicular, and the fact that this all works INSIDE one part.
  await step("7. a bore is perpendicular to the face it goes through", async () => {
    const r = envelope(await call("measure_between", { a: st.top, b: st.bores[0] }));
    record("7. a bore is perpendicular to the face it goes through",
      r.sameObject === true && r.parallel === true,
      "sameObject=" + r.sameObject + " angleBetween=" + r.angleBetweenDeg +
      " (a bore axis is PARALLEL to the face normal it passes through)");
    return r;
  });

  await step("8. measure_between refuses an authored index", async () => {
    const r = await call("measure_between", { a: "pad.plate:Face9999" });
    record("8. measure_between refuses an authored index",
      r.ok === false && /no element|renumber/i.test(errorOf(r)), errorOf(r).slice(0, 140));
    return r;
  });

  // -- 9. the table, without spending a transaction on it -----------------
  await step("9. material with no target returns the table", async () => {
    const r = envelope(await call("material", {}));
    const al = (r.materials || {})["aluminium-6061"] || {};
    record("9. material with no target returns the table",
      near(al.density, 2.7, 1e-9) && r.count > 20, r.count + " materials, 6061 at " + al.density);
    return r;
  });

  await step("10. material gives the plate a mass", async () => {
    const r = envelope(await call("material", { target: "body.plate", name: "aluminium-6061" }));
    const row = (r.assigned || [])[0] || {};
    st.mass = row.massG;
    // From the measured volume of the BODY, so a fillet added to the fixture
    // later moves both sides of this and stays a real assertion.
    const want = (st.volume / 1000) * 2.7;
    record("10. material gives the plate a mass",
      near(row.massG, want, 0.05) && row.material === "aluminium-6061",
      row.massG + " g (want " + want.toFixed(2) + ")");
    return r;
  });

  await step("11. an unknown material is refused, with the near misses", async () => {
    const r = await call("material", { target: "body.plate", name: "aluminum-6061" });
    record("11. an unknown material is refused, with the near misses",
      r.ok === false && /no material/i.test(errorOf(r)), errorOf(r).slice(0, 160));
    return r;
  });

  // -- 12. the BOM hole. Either the mass is there or the part is NAMED. ---
  await step("12. the BOM carries the fabricated mass", async () => {
    const r = envelope(await call("bom", {}));
    const line = (r.fabricated || []).find((f) => /Plate|body\.plate/i.test(f.label + " " + f.id));
    record("12. the BOM carries the fabricated mass",
      line && near(line.massEachG, st.mass, 0.01) &&
      near(r.fabricatedMassG, st.mass, 0.01) && !(r.noMaterialFor || []).length,
      "fabricatedMassG " + r.fabricatedMassG + " totalMassG " + r.totalMassG);
    return r;
  });

  await step("13. a body with no material is named, not silently zero", async () => {
    const made = await call("batch", {
      ops: [
        { fn: "body", args: { label: "Spacer" }, id: "body.spacer" },
        { fn: "sketch", args: { body: "body.spacer", on: "XY",
            geometry: [{ type: "circle", x: 100, y: 0, d: 20 }] }, id: "sk.spacer" },
        { fn: "pad", args: { sketch: "sk.spacer", length: 5, body: "body.spacer" },
          id: "pad.spacer" },
      ],
    });
    // Checked, because the first run reported noMaterialFor=[] and there was
    // no way to tell whether the BOM had missed the spacer or the spacer had
    // never been built.
    if (made.ok === false) {
      return record("13. a body with no material is named, not silently zero",
        false, "the second body was not created: " + errorOf(made));
    }
    const r = envelope(await call("bom", {}));
    const named = (r.noMaterialFor || []).some((n) => /spacer/i.test(String(n)));
    record("13. a body with no material is named, not silently zero",
      named && /NOTHING to the mass total/i.test(String(r.note || "")),
      "noMaterialFor=" + JSON.stringify(r.noMaterialFor || []) +
      " fabricated=" + JSON.stringify((r.fabricated || []).map(
        (f) => (f.id || f.name) + ":" + f.massEachG)));
    return r;
  });

  // -- 13b. the second body used to break every pad after it: a sketch
  // lives in exactly one body, and being asked which body to pad into when
  // the sketch has already said is a refusal the caller can only answer by
  // repeating itself.
  await step("13b. pad infers the body from its sketch", async () => {
    const r = await call("batch", {
      ops: [
        { fn: "body", args: { label: "Shim" }, id: "body.shim" },
        { fn: "sketch", args: { body: "body.shim", on: "XY",
            geometry: [{ type: "circle", x: 160, y: 0, d: 10 }] }, id: "sk.shim" },
        // No body argument, in a document that now has three of them.
        { fn: "pad", args: { sketch: "sk.shim", length: 4 }, id: "pad.shim" },
      ],
    });
    if (r.ok === false) {
      return record("13b. pad infers the body from its sketch", false, errorOf(r));
    }
    const m = await measure({ refs: ["body.shim"] });
    const vol = ((m.objects || [])[0] || {}).volume;
    record("13b. pad infers the body from its sketch",
      near(vol, Math.PI * 25 * 4, 0.5), "volume " + vol +
      " (want " + (Math.PI * 25 * 4).toFixed(1) + ")");
    return r;
  });

  // -- 14. refine: topology may move, material may not -------------------
  await step("14. recompute refine keeps the volume it started with", async () => {
    const r = envelope(await call("recompute", { targets: ["body.plate"], refine: true, force: true }));
    const m = await measure({ refs: ["body.plate"] });
    const after = ((m.objects || [])[0] || {}).volume;
    record("14. recompute refine keeps the volume it started with",
      !r.volumeChanged && near(after, st.volume, 0.01),
      "refined " + (r.refinedCount || 0) + " feature(s), facesRemoved " +
      (r.facesRemoved == null ? "n/a" : r.facesRemoved) + ", volume " + after);
    return r;
  });

  await step("15. a forced recompute reports the error state either side", async () => {
    const r = envelope(await call("recompute", { force: true }));
    record("15. a forced recompute reports the error state either side",
      Array.isArray(r.errorsBefore) && Array.isArray(r.errorsAfter) &&
      r.errorsAfter.length === 0 && !r.errorsIntroduced,
      "errors " + r.errorsBefore.length + " -> " + r.errorsAfter.length +
      ", touched " + r.touchedBefore + " -> " + r.touchedAfter);
    return r;
  });

  // -- 16/17. the clip plane, and putting it back ------------------------
  await step("16. view_section clips the view without touching the model", async () => {
    const before = ((await measure({ refs: ["body.plate"] })).objects || [])[0] || {};
    const r = await call("view_section", { plane: "XZ", offset: 0 });
    const e = envelope(r);
    if (r.ok === false && /headless|pivy|coin/i.test(errorOf(r))) {
      return skip("16. view_section clips the view without touching the model", errorOf(r).slice(0, 120));
    }
    const after = ((await measure({ refs: ["body.plate"] })).objects || [])[0] || {};
    record("16. view_section clips the view without touching the model",
      e.enabled === true && near(after.volume, before.volume, 1e-6) &&
      /clips the VIEW/i.test(String(e.note || "")),
      "enabled=" + e.enabled + " volume unchanged at " + after.volume);
    return r;
  });

  await step("17. view_restore takes the clip away again", async () => {
    const r = envelope(await call("view_restore", {}));
    if (r.sectionRemoved === undefined) {
      return skip("17. view_restore takes the clip away again", "no GUI in this session");
    }
    const again = envelope(await call("view_section", { off: true }));
    record("17. view_restore takes the clip away again",
      r.sectionRemoved === true && again.removed === false,
      "restore removed it=" + r.sectionRemoved + ", second removal is a no-op=" + (again.removed === false));
    return r;
  });

  // -- 18. the probe. Asked, not assumed. --------------------------------
  await step("18. capabilities answers about THIS build", async () => {
    const r = envelope(await call("capabilities", {}));
    const mods = r.modules || {};
    const asm = (mods.Assembly || {}).available;
    record("18. capabilities answers about THIS build",
      (mods.Part || {}).available === true && (mods.Sketcher || {}).available === true &&
      typeof r.gui === "boolean" && /NOT wired|not wired/i.test(String(r.note || "")),
      "Assembly=" + asm + " TechDraw=" + (mods.TechDraw || {}).available +
      " importDXF=" + (mods.importDXF || {}).available + " gui=" + r.gui);
    if (asm) {
      console.log("        Assembly API on this build: " +
        JSON.stringify((r.assemblyApi || []).slice(0, 24)));
      console.log("        helpers: " + JSON.stringify(r.assemblyHelpers || {}).slice(0, 600));
      console.log("        document types: " + JSON.stringify(r.documentTypes || []));
      console.log("        ^ paste these three lines back — the joint op gets");
      console.log("          written against them rather than against a guess.");
    }
    return r;
  });

  const passed = results.filter((r) => r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  console.log("\n" + MARK_PASS + " " + passed + " passed   " +
    " " + failed + " failed   " + MARK_SKIP + " " + skipped + " skipped");
  console.log("The test document " + DOC + " is still open. Close it from FreeCAD when you are done.");
  return { success: failed === 0, passed, failed, skipped, total: results.length, results };
}

return main();
