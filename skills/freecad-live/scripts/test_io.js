// scripts/test_io.js — the P0 surface: file in, file out, sketch edit.
//
// What this suite is actually for, in one sentence each:
//
//   * export FCStd used to call doc.saveAs(), which REBINDS the open
//     document. One "checkpoint" and every File > Save the human made
//     afterwards landed in the export directory instead of their project
//     file, silently. Test 2 is that regression and it should stay here
//     forever.
//   * save exists at all now. Before it, forty AI-authored transactions
//     lived only in RAM.
//   * open_document exists at all now, and the claim it makes is not "a file
//     opened" but "the koi ids came back with it" — doc.Meta rides inside the
//     FCStd, so turn 7 of a session next week can still edit what turn 3
//     built. Test 6 closes the document and reopens it from disk, because a
//     reused handle proves nothing.
//   * import_geometry brings in a shape and must SAY it is a shape. The
//     fixture is a STEP this suite exports from its own model, so the suite
//     needs nothing on disk that it did not put there.
//   * sketch_edit is the one that changes how the skill is used: adding a
//     circle to a pad's profile has to cut a hole through the pad that was
//     built from it. If the volume does not drop, the edit reached the
//     sketch and not the model, which is the failure that looks like success.
//
// Run:  /skill freecad-live/scripts/test_io.js --full-auto
//
// ---------------------------------------------------------------------------
// HARNESS. This is the one block that has to match the other suites in
// scripts/ — they were written against whatever `tools.*` shape the sandbox
// exposes. It tries the shapes in order and throws a legible error rather
// than a TypeError if none of them is there.
// ---------------------------------------------------------------------------

const TOOLS = (typeof tools !== "undefined" && tools) ||
  (typeof globalThis !== "undefined" && globalThis.tools) || null;

async function invoke(name, args) {
  if (!TOOLS) throw new Error("no tools object in scope — align the harness block with scripts/test_flow.js");
  if (typeof TOOLS[name] === "function") return TOOLS[name](args || {});
  if (typeof TOOLS.callTool === "function") return TOOLS.callTool(name, args || {});
  if (typeof TOOLS.call === "function") return TOOLS.call(name, args || {});
  throw new Error("cannot invoke " + name + " through this harness");
}

// Tool replies arrive either as the object or wrapped in MCP content blocks.
function unwrap(res) {
  if (res == null) return {};
  if (typeof res === "string") { try { return JSON.parse(res); } catch (_) { return { raw: res }; } }
  if (Array.isArray(res.content)) {
    const t = res.content.find((c) => c && c.type === "text");
    if (t) { try { return JSON.parse(t.text); } catch (_) { return { raw: t.text }; } }
  }
  return res;
}

const call = async (fn, args, id, extra) =>
  unwrap(await invoke("freecad_call", Object.assign({ fn, args: args || {} }, id ? { id } : {}, extra || {})));
const script = async (python) => unwrap(await invoke("freecad_script", { python, deadlineSeconds: 10 }));
const measure = async (args) => unwrap(await invoke("freecad_measure", args || {}));
const exportDoc = async (args) => unwrap(await invoke("freecad_export", args || {}));
const sync = async () => unwrap(await invoke("freecad_sync", {}));

// ---------------------------------------------------------------------------

const results = [];
let failed = 0;

const MARK_PASS = "\u2705";        // white heavy check mark
const MARK_FAIL = "\u274C \u274C";  // two cross marks: a failure should be findable by eye
const MARK_SKIP = "\u23ED";        // skipped, which is not passed

function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? "" : String(detail).slice(0, 400) });
  if (!ok) failed += 1;
  // eslint-disable-next-line no-console
  console.log((ok ? MARK_PASS + "  PASS  " : MARK_FAIL + "  FAIL  ") + name +
    (detail ? " — " + String(detail).slice(0, 220) : ""));
}

function skip(name, why) {
  results.push({ name, ok: true, skipped: true, detail: why });
  console.log(MARK_SKIP + "  SKIP  " + name + " — " + why);
}

// An op that raised is a failed test, not a thrown suite: the rest of the
// tests still carry information and a suite that dies on test 3 reports
// nothing about tests 4..9.
// What it must NOT do is judge the returned value. Half these tests assert
// that an op REFUSES, so they call record() themselves and then return the
// refusal -- and the first version of this wrapper saw ok===false on the way
// past and recorded a second, failing result for a test that had just
// passed. Four tests reported twice, the totals read 20 of 16, and the suite
// was lying in the one direction a suite must never lie.
async function step(name, fn) {
  try {
    return await fn();
  } catch (e) {
    record(name, false, e && e.message);
    return null;
  }
}

const DOC = "KoiIoTest";
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= (tol == null ? 1e-6 : tol);
const envelope = (r) => (r && r.result && typeof r.result === "object" ? r.result : r) || {};

async function main() {
  const state = {};

  // -- 0. a document of our own. Never the human's. --------------------------
  await step("0. new_document", async () => {
    const r = await call("new_document", { name: DOC }, "doc.io");
    record("0. new_document", r.ok !== false && envelope(r).name === DOC, envelope(r).name);
    return r;
  });
  await sync();

  // -- 1. a model with a known volume ---------------------------------------
  // 40 x 30 x 10 = 12000 mm^3, sketched centred so the numbers stay readable.
  await step("1. build the fixture", async () => {
    const r = await call("batch", {
      ops: [
        { fn: "body", args: { label: "Plate" }, id: "body.plate" },
        { fn: "sketch", args: {
            body: "body.plate", on: "XY",
            geometry: [{ type: "rect", anchor: "center", x: 0, y: 0, w: 40, h: 30 }],
          }, id: "sk.plate" },
        { fn: "pad", args: { sketch: "sk.plate", length: 10 }, id: "pad.plate" },
      ],
    });
    const m = await measure({ refs: ["pad.plate"] });
    const vol = ((m.objects || [])[0] || {}).volume;
    state.baseVolume = vol;
    record("1. build the fixture", near(vol, 12000, 1), "volume " + vol);
    return r;
  });

  // -- 2. THE REGRESSION. export FCStd must not rebind the document. --------
  await step("2. export FCStd leaves FileName alone", async () => {
    const s0 = await sync();
    const fileBefore = (s0.document && s0.document.fileName) || null;
    const r = await exportDoc({ format: "FCStd" });
    state.fcstdCopy = r.path;
    const ok = r.rebound === false && !r.reboundNote;
    record("2. export FCStd leaves FileName alone",
      ok, "rebound=" + r.rebound + " path=" + r.path + " fileBefore=" + fileBefore);
    return r;
  });

  // -- 3. save refuses an unsaved document rather than guessing a path ------
  await step("3. save with no file and no path refuses", async () => {
    const r = await call("save", {});
    const said = String((r && (r.error || (r.result || {}).error)) || "");
    record("3. save with no file and no path refuses",
      r.ok === false && /never been saved/i.test(said), said.slice(0, 120));
    return r;
  });

  // -- 4. save as, into a directory this session may write ------------------
  await step("4. save writes the document and says it rebound", async () => {
    const r = await call("save", { path: DOC + ".FCStd", overwrite: true });
    const e = envelope(r);
    state.savedPath = e.path;
    record("4. save writes the document and says it rebound",
      r.ok !== false && e.bytes > 0 && e.action === "saveAs" && e.rebound === true && !!e.reboundNote,
      e.path + " " + e.bytes + "B rebound=" + e.rebound);
    return r;
  });

  // -- 5. path policy. A read that escapes the roots is refused. ------------
  await step("5. open_document refuses a path outside the roots", async () => {
    const r = await call("open_document", { path: "/etc/hosts" });
    const said = String((r && (r.error || (r.result || {}).error)) || "");
    // Two ways to be right: the extension gate or the root gate. Either is a
    // refusal; what would be wrong is a read.
    record("5. open_document refuses a path outside the roots",
      r.ok === false && /(not under any directory|must end in)/i.test(said), said.slice(0, 140));
    return r;
  });

  // -- 6. the round trip, and the claim that matters: ids survive it. -------
  // Closing is legitimate here and only here: this document is one this
  // suite created, by a name it chose. Nothing of the human's is touched.
  await step("6. reopen from disk and keep the koi ids", async () => {
    const idsBefore = envelope(await call("ids", {})).ids || [];
    state.idsBefore = idsBefore.length;
    // The close has to be PROVEN, not attempted. The first run fired this
    // script, ignored what it returned, and then reported opened=false as a
    // failure of open_document -- when what had happened was that the close
    // never took and the op correctly reused the handle it found. A test that
    // cannot tell those two apart is not testing open_document.
    const closed = envelope(await script(
      "import FreeCAD as App\n" +
      "name = '" + DOC + "'\n" +
      "if not name.startswith('KoiIoTest'):\n" +
      "    raise ValueError('refusing to close a document this suite did not make')\n" +
      "was = name in App.listDocuments()\n" +
      "if was:\n" +
      "    App.closeDocument(name)\n" +
      "return {'was': was, 'stillOpen': name in App.listDocuments()}\n"
    ));
    if (!closed || closed.stillOpen !== false) {
      skip("6. reopen from disk and keep the koi ids",
        "could not close " + DOC + " from the script path (" +
        JSON.stringify(closed).slice(0, 160) + ") -- the from-disk round trip " +
        "was not exercised. Close it by hand in FreeCAD and re-run.");
      return null;
    }
    const r = await call("open_document", { path: state.savedPath });
    const e = envelope(r);
    const ok = r.ok !== false && e.opened === true && e.reused === false &&
      e.idCount === state.idsBefore && e.idCount > 0;
    record("6. reopen from disk and keep the koi ids",
      ok, "opened=" + e.opened + " ids " + state.idsBefore + " -> " + e.idCount);
    return r;
  });

  await sync();

  // -- 7. an id that came off disk is still editable, not just listed ------
  await step("7. an id from the reopened file still edits", async () => {
    const r = await call("feature_edit", { target: "pad.plate", props: { Length: 12 } });
    const m = await measure({ refs: ["pad.plate"] });
    const vol = ((m.objects || [])[0] || {}).volume;
    record("7. an id from the reopened file still edits",
      near(vol, 40 * 30 * 12, 1), "volume " + vol + " (want 14400)");
    return r;
  });

  // -- 8. import: the fixture is a STEP we export ourselves ----------------
  await step("8. import_geometry lands a shape and says it is one", async () => {
    const step1 = await exportDoc({ format: "STEP" });
    state.stepPath = step1.path;
    const r = await call("import_geometry", { path: step1.path, at: [200, 0, 0] }, "imp.plate");
    const e = envelope(r);
    const ok = r.ok !== false && e.solids >= 1 && near(e.volume, 14400, 50) &&
      /no sketches|shape, not a feature tree/i.test(String(e.note || ""));
    record("8. import_geometry lands a shape and says it is one",
      ok, "solids=" + e.solids + " volume=" + e.volume);
    return r;
  });

  await step("9. the import is measurable and does not interfere", async () => {
    const m = await measure({ partsOnly: true, interference: true });
    // interference() returns {pairs, hits}, not a list. Reading it as an
    // array threw a TypeError that read like an op failure, from a test that
    // had never looked at the shape of the thing it asserts on.
    const hits = ((m.interference || {}).hits || [])
      .filter((p) => Number(p.volume || 0) > 1e-6);
    record("9. the import is measurable and does not interfere",
      hits.length === 0, hits.length + " overlapping pair(s)");
    return m;
  });

  // -- 10. sketch_get: the addresses sketch_edit needs --------------------
  await step("10. sketch_get returns geoIds and constraints", async () => {
    const r = await call("sketch_get", { target: "sk.plate" });
    const e = envelope(r);
    state.geoCount = (e.geometry || []).length;
    const ok = r.ok !== false && state.geoCount >= 4 &&
      (e.constraints || []).length > 0 &&
      (e.usedBy || []).some((n) => /Pad/i.test(n));
    record("10. sketch_get returns geoIds and constraints",
      ok, state.geoCount + " geo, " + (e.constraints || []).length +
          " constraints, usedBy=" + JSON.stringify(e.usedBy || []));
    return r;
  });

  // -- 11. THE ONE THAT MATTERS. An edit to the sketch has to reach the
  // solid that was built from it: an inner circle in a pad profile is a hole
  // through the pad. If the volume does not move, sketch_edit changed a
  // sketch nobody is looking at.
  await step("11. sketch_edit cuts a hole in the pad built from it", async () => {
    const r = await call("sketch_edit", {
      target: "sk.plate",
      add: [{ type: "circle", x: 0, y: 0, d: 10 }],
    });
    const m = await measure({ refs: ["pad.plate"] });
    const vol = ((m.objects || [])[0] || {}).volume;
    const want = 40 * 30 * 12 - Math.PI * 25 * 12;
    record("11. sketch_edit cuts a hole in the pad built from it",
      near(vol, want, 5), "volume " + vol + " (want " + want.toFixed(1) + ")");
    return r;
  });

  // -- 12. a dimension bound to the sheet, on a sketch that already existed
  await step("12. sketch_edit binds a dimension to the parameter sheet", async () => {
    await call("param", { alias: "bore", value: "14 mm" });
    const g = envelope(await call("sketch_get", { target: "sk.plate" }));
    const dia = (g.constraints || []).find(
      (c) => /Diameter|Radius/i.test(c.type) && c.value != null);
    if (!dia) return record("12. sketch_edit binds a dimension to the parameter sheet",
      false, "no diameter constraint to bind — constraints: " +
      JSON.stringify((g.constraints || []).map((c) => c.type)));
    const isRadius = /Radius/i.test(dia.type);
    const r = await call("sketch_edit", {
      target: "sk.plate",
      expressions: (() => {
        const o = {};
        o[String(dia.index)] = isRadius ? "koi_params.bore / 2" : "koi_params.bore";
        return o;
      })(),
    });
    const e = envelope(r);
    const bound = (e.bindings || [])[0] || {};
    const m = await measure({ refs: ["pad.plate"] });
    const vol = ((m.objects || [])[0] || {}).volume;
    const want = 40 * 30 * 12 - Math.PI * 49 * 12;
    record("12. sketch_edit binds a dimension to the parameter sheet",
      bound.verified === true && near(vol, want, 8) && !e.bindingNote,
      "verified=" + bound.verified + " volume " + vol + " (want " + want.toFixed(1) + ")");
    return r;
  });

  // -- 13. removing geometry takes constraints with it, and says so -------
  await step("13. removing geometry reports the constraints it cost", async () => {
    const g = envelope(await call("sketch_get", { target: "sk.plate" }));
    const circle = (g.geometry || []).find((x) => x.type === "Circle");
    if (!circle) return record("13. removing geometry reports the constraints it cost",
      false, "no circle to remove");
    const r = await call("sketch_edit", { target: "sk.plate", remove: [circle.geoId] });
    const e = envelope(r);
    const m = await measure({ refs: ["pad.plate"] });
    const vol = ((m.objects || [])[0] || {}).volume;
    record("13. removing geometry reports the constraints it cost",
      e.constraintCount && e.constraintCount.after < e.constraintCount.before &&
      near(vol, 40 * 30 * 12, 1),
      "constraints " + JSON.stringify(e.constraintCount) +
      " lost=" + (e.constraintsLost || 0) + " volume back to " + vol);
    return r;
  });

  // -- 14. a stale geoId is refused, not applied to whatever moved into it -
  await step("14. an out-of-range geoId is refused", async () => {
    const r = await call("sketch_edit", { target: "sk.plate", remove: [999] });
    const said = String((r && (r.error || (r.result || {}).error)) || "");
    record("14. an out-of-range geoId is refused",
      r.ok === false && /does not exist/i.test(said), said.slice(0, 120));
    return r;
  });

  // -- 15. sketch_edit on something that is not a sketch -------------------
  await step("15. sketch_edit refuses a non-sketch", async () => {
    const r = await call("sketch_edit", { target: "pad.plate", add: [] });
    const said = String((r && (r.error || (r.result || {}).error)) || "");
    record("15. sketch_edit refuses a non-sketch",
      r.ok === false && /not a sketch/i.test(said), said.slice(0, 120));
    return r;
  });

  const passed = results.filter((r) => r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  // eslint-disable-next-line no-console
  console.log("\n" + MARK_PASS + " " + passed + " passed   " +
    " " + failed + " failed   " + MARK_SKIP + " " + skipped + " skipped");
  console.log("artifacts: " + [state.fcstdCopy, state.savedPath, state.stepPath].filter(Boolean).join(", "));
  console.log("The test document " + DOC + " is still open. Close it from FreeCAD when you are done with it.");

  return { success: failed === 0, passed, failed, skipped, total: results.length, results };
}

return main();
