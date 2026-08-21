// scripts/test_koi_call.js — harness for freecad_call and freecad_script (§6.2).
//
//   /skill freecad-live/scripts/test_koi_call.js --full-auto
//   /skill freecad-live/scripts/test_koi_call.js --full-auto --param deadline=1
//
// test_probes.js measured the PLATFORM. test_koi_cad.js measured the ENVELOPE.
// This measures the DISPATCHER: that the whitelist is a whitelist, that
// validation happens before anything reaches the page, that an id written in
// one call resolves in the next, and that read calls cost nothing.
//
// Requires `probe-exec: on` in SKILL.md — ground truth is read with
// freecad_exec, never from the tool's own report of itself.
//
// Scratch document KoiCallTest, closed at the end.
//
// --param deadline=1 adds the last test, which sends an unbounded loop on
// purpose to prove the trace-hook deadline preempts it. It is opt-in because
// if that deadline does NOT hold, the tab is gone and so is the run.

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
  return guard(
    parseResult(
      await tools.freecad_call(
        Object.assign({ fn, args: opArgs || {} }, id ? { id } : {}, extra || {})
      )
    )
  );
}

async function sync() {
  return guard(parseResult(await tools.freecad_sync({})));
}

async function script(python, extra) {
  return guard(
    parseResult(await tools.freecad_script(Object.assign({ python }, extra || {})))
  );
}

// Ground truth, and only ground truth. Never used to make an assertion pass —
// used to check that the dispatcher's report of itself is true.
async function probe(python, timeoutMs) {
  const r = guard(
    parseResult(await tools.freecad_exec({ python, timeoutMs: timeoutMs || 30000 }))
  );
  if (!r || r.ok !== true) return { __fail: (r && r.error) || "exec failed" };
  const d = r.result || {};
  if (d.ok === false) return { __fail: d.error || "returned ok:false" };
  return d;
}

const DOC = "KoiCallTest";
const near = (a, b, tol) => typeof a === "number" && Math.abs(a - b) < (tol || 1);

async function run() {
  const argstr =
    typeof args !== "undefined" && Array.isArray(args) ? args.join(" ") : "";
  const testDeadline = argstr.indexOf("deadline") !== -1;

  console.log("=== freecad_call / freecad_script tests ===");
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
  // The dispatcher refuses to edit a document this session has never read.
  // A harness that skipped this was editing blind exactly the way a model
  // would be.
  assert("the document was read before editing it",
    !!(await sync()).tree, "sync failed");

  // ---- C1: the whitelist is a whitelist ----
  console.log("--- C1: the dispatcher refuses what it does not implement ---");
  const bogus = await call("delete_everything", {}, null);
  assert("an unknown fn is refused", !!(bogus && bogus.error), JSON.stringify(bogus));
  assert("the refusal lists what does exist",
    (bogus.available || []).indexOf("feature_edit") !== -1,
    JSON.stringify(bogus.available));
  const untouched = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "objects": len(doc.Objects), "undo": len(doc.UndoNames)}
`);
  assert("a refused call reached the document not at all",
    !untouched.__fail && untouched.objects === 0 && untouched.undo === 0,
    untouched.__fail || JSON.stringify(untouched));

  // ---- C2: validation happens on this side of the bridge ----
  console.log("\n--- C2: bad arguments are rejected before the page sees them ---");
  const noLen = await call("pad", { sketch: "sk.nothing" }, "pad.x");
  assert("a missing required argument is refused",
    !!(noLen && noLen.error && String(noLen.error).indexOf("length") !== -1),
    JSON.stringify(noLen));
  const typo = await call("pad", { sketch: "sk.x", lenght: 10 }, "pad.x");
  assert("a misspelled argument is refused rather than ignored",
    !!(typo && typo.error && String(typo.error).indexOf("lenght") !== -1),
    JSON.stringify(typo));
  assert("the rejection says what the call does accept",
    !!(typo && typo.accepts && typo.accepts.length),
    JSON.stringify(typo && typo.accepts));
  const noId = await call("body", {}, null);
  assert("a creating call without an id is refused",
    !!(noId && noId.error && String(noId.error).indexOf("id") !== -1),
    JSON.stringify(noId));
  const stillEmpty = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "objects": len(doc.Objects)}
`);
  assert("none of the rejected calls opened a transaction",
    !stillEmpty.__fail && stillEmpty.objects === 0,
    stillEmpty.__fail || JSON.stringify(stillEmpty));

  // ---- C3: build the plate through the dispatcher ----
  console.log("\n--- C3: the same plate, built through freecad_call ---");
  const cBody = await call("body", { label: "Plate" }, "body.plate");
  assert("body applied", cBody && cBody.applied === true,
    JSON.stringify(cBody && { reason: cBody.reason, error: cBody.error }));

  const cSk = await call("sketch", {
    body: "body.plate",
    on: "XY",
    geometry: [{ type: "rect", w: 40, h: 30 }],
  }, "sk.plate");
  const sketched = assert("sketch applied", cSk && cSk.applied === true,
    JSON.stringify(cSk && { reason: cSk.reason, error: cSk.error }));
  if (sketched) {
    assert("the declarative rect comes out fully constrained",
      cSk.result && cSk.result.fullyConstrained === true,
      JSON.stringify(cSk.result && { fullyConstrained: cSk.result.fullyConstrained, dof: cSk.result.dof }));
    assert("no constraint conflicts or redundancies",
      (cSk.result.conflicts || []).length === 0 &&
        (cSk.result.redundancies || []).length === 0,
      JSON.stringify({ c: cSk.result.conflicts, r: cSk.result.redundancies }));
    assert("lint does not flag the sketch it just built",
      !(cSk.lint || []).some((w) => w.code === "dof"),
      JSON.stringify(cSk.lint));
  }

  const cPad = await call("pad", { sketch: "sk.plate", length: 10 }, "pad.base");
  const built = assert("pad applied", cPad && cPad.applied === true,
    JSON.stringify(cPad && { reason: cPad.reason, error: cPad.error }));
  if (built) {
    console.log("   undo entries booked: " + cPad.undoEntries +
      "  singleUndo=" + cPad.singleUndo);
    const truth = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
b = doc.getObject("${(cBody.result && cBody.result.name) || "Body"}")
return {"ok": True, "volume": b.Shape.Volume, "valid": b.isValid()}
`);
    assert("the solid really is 40 x 30 x 10",
      !truth.__fail && near(truth.volume, 40 * 30 * 10, 1),
      truth.__fail || JSON.stringify(truth));
  }

  if (!built) {
    console.log("\n(the plate did not build; the rest of the suite has no subject)");
  } else {
    // ---- C4: ids bind across calls ----
    console.log("\n--- C4: an id written in one call resolves in the next ---");
    const known = await call("ids", {}, null);
    assert("ids is a read call", known && known.mode === "read", JSON.stringify(known));
    const idList = ((known.result || {}).ids || []).map((r) => r.id).sort();
    assert("every created object registered its id",
      idList.join(",") === "body.plate,pad.base,sk.plate", idList.join(","));
    assert("the ids are stored in the document, not in this session",
      (known.result || {}).persisted === true,
      JSON.stringify((known.result || {}).persisted));

    const fe = await call("feature_edit", {
      target: "pad.base",
      props: { Length: 25 },
    }, null);
    assert("feature_edit resolved the id", fe && fe.applied === true,
      JSON.stringify(fe && { reason: fe.reason, error: fe.error }));
    assert("feature_edit reports the before and after",
      fe.result && fe.result.changed && fe.result.changed.length === 1,
      JSON.stringify(fe.result && fe.result.changed));
    const grew = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "volume": doc.getObject("${cBody.result.name}").Shape.Volume,
        "length": float(doc.getObject("${cPad.result.name}").Length)}
`);
    assert("the edit propagated to the solid",
      !grew.__fail && near(grew.volume, 40 * 30 * 25, 1) && near(grew.length, 25, 0.001),
      grew.__fail || JSON.stringify(grew));

    // ---- C5: a read costs nothing, and measurement is not a dispatcher op ----
    console.log("\n--- C5: reads do not book undo entries ---");
    const beforeUndo = await probe(`
import FreeCAD as App
return {"ok": True, "undo": len(App.getDocument("${DOC}").UndoNames)}
`);
    // measure moved out of freecad_call and into freecad_measure at `safe`
    // tier: it is the check the model runs constantly, and a check that costs
    // a confirmation is a check that does not get run.
    const gone = await call("measure", { targets: ["pad.base"] }, null);
    assert("measure is no longer a mutating-tier dispatcher op",
      !!(gone && gone.error), JSON.stringify(gone));
    const meas = guard(parseResult(
      await tools.freecad_measure({ refs: ["pad.base", "body.plate"] })));
    assert("freecad_measure returns numbers", Array.isArray(meas && meas.objects),
      JSON.stringify(meas && meas.error));
    const rows = meas.objects || [];
    assert("it resolves ids the same way writes do",
      rows.length === 2 && rows.every((r) => r.name), JSON.stringify(rows.map((r) => r.name)));
    assert("the measurement agrees with the document",
      rows.some((r) => near(r.volume, 40 * 30 * 25, 1)),
      JSON.stringify(rows.map((r) => [r.name, r.volume])));
    const afterUndo = await probe(`
import FreeCAD as App
return {"ok": True, "undo": len(App.getDocument("${DOC}").UndoNames)}
`);
    assert("looking at the model did not book an undo entry",
      !beforeUndo.__fail && !afterUndo.__fail && afterUndo.undo === beforeUndo.undo,
      JSON.stringify({ before: beforeUndo.undo, after: afterUndo.undo }));

    // ---- C6: dry run through the dispatcher ----
    console.log("\n--- C6: a dispatched dry run measures and rolls back ---");
    const dry = await call("feature_edit", {
      target: "pad.base",
      props: { Length: 60 },
    }, null, { dryRun: true });
    assert("a dry run reports success", dry && dry.ok === true,
      JSON.stringify(dry && { ok: dry.ok, reason: dry.reason, error: dry.error }));
    assert("a dry run is not applied", dry && dry.applied === false,
      "applied=" + (dry && dry.applied));
    const after = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "length": float(doc.getObject("${cPad.result.name}").Length)}
`);
    assert("the document is unchanged after the dry run",
      !after.__fail && near(after.length, 25, 0.001),
      after.__fail || JSON.stringify(after));

    // ---- C7: a pocket, and the lint that measures ----
    console.log("\n--- C7: a through-pocket removes material and lint agrees ---");
    const cSk2 = await call("sketch", {
      body: "body.plate",
      on: "XY",
      geometry: [{ type: "circle", x: 20, y: 15, d: 10 }],
    }, "sk.hole");
    assert("the hole sketch applied", cSk2 && cSk2.applied === true,
      JSON.stringify(cSk2 && { reason: cSk2.reason, error: cSk2.error }));
    const cPk = await call("pocket", { sketch: "sk.hole", through: true }, "pocket.hole");
    if (!assert("the pocket applied", cPk && cPk.applied === true,
        JSON.stringify(cPk && { reason: cPk.reason, error: cPk.error }))) {
      note("no pocket", "C7's measurement has no subject");
    } else {
      const cut = await probe(`
import FreeCAD as App
import math
doc = App.getDocument("${DOC}")
return {"ok": True, "volume": doc.getObject("${cBody.result.name}").Shape.Volume,
        "expected": 40 * 30 * 25 - math.pi * 25 * 25}
`);
      assert("the hole is really there, by volume",
        !cut.__fail && near(cut.volume, cut.expected, 1),
        cut.__fail || JSON.stringify(cut));
      assert("lint does not claim the pocket removed nothing",
        !(cPk.lint || []).some((w) => w.code === "removed-nothing"),
        JSON.stringify(cPk.lint));
      // On this build the default direction cuts away from the material, so
      // the op should have measured that and flipped. If this ever reports
      // false while the volume above is right, the platform's default changed
      // and the flip has stopped being exercised — which is worth knowing.
      const r = cPk.result || {};
      if (r.flipped === true) {
        assert("the flip is reported rather than done silently",
          typeof r.note === "string" && r.note.indexOf("flip") !== -1,
          JSON.stringify(r));
        assert("the reported removal matches the measured one",
          near(r.removed, Math.PI * 25 * 25, 1), JSON.stringify(r));
      } else {
        note("the default pocket direction already cut",
          "the flip path was not exercised this run: " + JSON.stringify(r));
      }
    }

    // An explicit direction is an instruction, not a hint. This is the test
    // that keeps the inference from becoming an override.
    console.log("\n--- C7b: an explicit direction is not overruled ---");
    const cSk3 = await call("sketch", {
      body: "body.plate",
      on: "XY",
      geometry: [{ type: "circle", x: 8, y: 8, d: 6 }],
    }, "sk.hole2");
    assert("the second hole sketch applied", cSk3 && cSk3.applied === true,
      JSON.stringify(cSk3 && { reason: cSk3.reason, error: cSk3.error }));
    const cPk2 = await call("pocket",
      { sketch: "sk.hole2", through: true, reversed: false }, "pocket.told");
    if (cPk2 && cPk2.applied === true) {
      const r2 = cPk2.result || {};
      assert("the direction asked for is kept", r2.flipped === false,
        JSON.stringify(r2));
      assert("and the no-op outcome is still reported",
        (cPk2.lint || []).some((w) => w.code === "removed-nothing") ||
          (r2.removed != null && r2.removed > 1e-6),
        JSON.stringify({ note: r2.note, lint: cPk2.lint }));
    } else {
      note("the explicit-direction pocket did not apply",
        JSON.stringify(cPk2 && cPk2.reason));
    }

    // ---- C8: deleting an AI object is a rejection signal ----
    console.log("\n--- C8: a user-deleted object shows up as reverted ---");
    await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
doc.removeObject(doc.getObject("${cPk.result ? cPk.result.name : "Pocket"}").Name)
doc.recompute()
return {"ok": True}
`);
    const post = await call("ids", {}, null);
    assert("the deleted id is reported as reverted",
      ((post.result || {}).revertedAiObjects || []).indexOf("pocket.hole") !== -1,
      JSON.stringify((post.result || {}).revertedAiObjects));
    assert("the surviving ids are still resolvable",
      ((post.result || {}).ids || []).filter((r) => r.present).length >= 3,
      JSON.stringify((post.result || {}).ids));

    // ---- C9: the script channel ----
    console.log("\n--- C9: freecad_script runs in the same envelope ---");
    const s1 = await script("result = len(doc.Objects)");
    assert("a script returns its result", s1 && s1.applied === true &&
      typeof (s1.result || {}).returned === "number",
      JSON.stringify(s1 && { applied: s1.applied, error: s1.error, result: s1.result }));
    const s2 = await script("result = koi.VERSION");
    assert("koi_cad is in scope for a script",
      !!(s2.result && String(s2.result.returned).length),
      JSON.stringify(s2.result));
    const s3 = await script("raise RuntimeError('koi-script-boom')");
    assert("a script exception aborts rather than half-applying",
      s3 && s3.applied === false && String(s3.error).indexOf("koi-script-boom") !== -1,
      JSON.stringify(s3 && { applied: s3.applied, error: s3.error }));
    const s4 = await script(
      "for i in range(3):\n    doc.addObject('Part::Box', 'koi_bulk_%d' % i)",
      { name: "Bulk add" }
    );
    assert("a bounded bulk edit applies as one entry",
      s4 && s4.applied === true, JSON.stringify(s4 && { reason: s4.reason, error: s4.error }));
    const bulk = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "boxes": len([o for o in doc.Objects if o.TypeId == "Part::Box"])}
`);
    assert("all three objects are really there",
      !bulk.__fail && bulk.boxes === 3, bulk.__fail || JSON.stringify(bulk));
  }

  // ---- C10: the deadline, opt-in ----
  if (testDeadline) {
    console.log("\n--- C10: an unbounded loop is preempted, not fatal ---");
    const t0 = Date.now();
    const runaway = await script("while True:\n    pass", {
      deadlineSeconds: 2,
      timeoutMs: 60000,
    });
    const elapsed = Date.now() - t0;
    assert("the runaway script did not apply", runaway && runaway.applied === false,
      JSON.stringify(runaway && { applied: runaway.applied, error: runaway.error }));
    assert("it was stopped by the deadline, not by the transport timeout",
      String(runaway && runaway.error).indexOf("KoiTimeout") !== -1,
      String(runaway && runaway.error));
    assert("and the tab still answers afterwards",
      !!(await probe(`return {"ok": True}`)).ok !== false, "the page stopped responding");
    console.log("   preempted after " + elapsed + " ms");
  } else {
    note("deadline test skipped",
      "re-run with --param deadline=1 to prove the trace hook preempts a runaway loop");
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

  console.log("\n=== koi_call: " + pass + " passed, " + fail + " failed, " +
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
