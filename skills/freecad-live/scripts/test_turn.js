// scripts/test_turn.js — harness for the turn boundary, change reports,
// views and export (§5.2, §5.4, §6.3, §10).
//
//   /skill freecad-live/scripts/test_turn.js --full-auto
//
// The earlier suites measured what an edit does. This measures what happens
// BETWEEN edits: whether the skill notices that the human moved something,
// whether a dry run produces a review packet an engineer would accept, and
// whether the user can get their work out of a sandbox that does not survive
// its own tab.
//
// Requires `probe-exec: on` in SKILL.md.
//
// Scratch document TurnTest, closed at the end.

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

const DOC = "TurnTest";
const near = (a, b, tol) => typeof a === "number" && Math.abs(a - b) < (tol || 1e-3);
const PI = Math.PI;

async function run() {
  console.log("=== turn boundary / report / view / export tests ===");
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

  // ---- T1: the opener knows it has no baseline ----
  console.log("--- T1: the first look admits it is the first look ---");
  const s1 = await sync();
  assert("sync carries a userDiff", !!s1.userDiff, JSON.stringify(s1.userDiff));
  assert("and says there is nothing to compare against yet",
    s1.userDiff.baseline === false, JSON.stringify(s1.userDiff));
  assert("rather than reporting the document as a user edit",
    (s1.userDiff.added || []).length === 0, JSON.stringify(s1.userDiff.added));
  assert("it carries a health rollup",
    s1.health && Array.isArray(s1.health.errors), JSON.stringify(s1.health));
  assert("and a rev that moves", typeof s1.rev === "number", JSON.stringify(s1.rev));
  // This sync is also what unlocks editing: the dispatcher refuses to touch a
  // document the session has never read.
  const blind = guard(parseResult(await tools.freecad_call(
    { fn: "body", args: {}, id: "body.blind" })));
  assert("and having read it, editing is allowed",
    blind && blind.reason !== "no-sync", JSON.stringify(blind && blind.reason));
  if (blind && blind.applied) {
    await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
doc.removeObject("${(blind.result || {}).name}")
doc.recompute()
return {"ok": True}
`);
    await sync();
  }

  // ---- T2: what the human did between turns ----
  console.log("\n--- T2: the human moved something while we were away ---");
  await call("body", { label: "Plate" }, "body.plate");
  const sk = await call("sketch", {
    body: "body.plate", on: "XY", geometry: [{ type: "rect", w: 50, h: 40 }],
  }, "sk.plate");
  const pad = await call("pad", { sketch: "sk.plate", length: 10 }, "pad.plate");
  assert("we built a plate", pad && pad.applied === true,
    JSON.stringify(pad && pad.error));
  const s2 = await sync();
  assert("our own work does not come back as the user's",
    (s2.userDiff.added || []).length === 0,
    JSON.stringify(s2.userDiff));

  const userAdded = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
b = doc.addObject("Part::Box", "UserBox")
b.Length, b.Width, b.Height = 5, 5, 5
doc.recompute()
return {"ok": True}
`);
  assert("the user added a box behind our back", !userAdded.__fail, userAdded.__fail);
  const s3 = await sync();
  assert("the next turn opens by noticing it",
    (s3.userDiff.added || []).indexOf("UserBox") !== -1,
    JSON.stringify(s3.userDiff.added));
  assert("and the summary names it", String(s3.userDiff.summary).indexOf("UserBox") !== -1,
    s3.userDiff.summary);
  assert("a second sync does not report it twice",
    ((await sync()).userDiff.added || []).length === 0, "still reported");

  // ---- T3: deleting our work is a rejection ----
  console.log("\n--- T3: the user deletes something we made ---");
  const scratch = await call("body", { label: "Scratch" }, "body.scratch");
  await sync();
  const killed = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
doc.removeObject("${(scratch.result || {}).name}")
doc.recompute()
return {"ok": True}
`);
  assert("the user deleted it", !killed.__fail, killed.__fail);
  const s4 = await sync();
  assert("it comes back as a rejection, by the id we gave it",
    (s4.userDiff.revertedAiObjects || []).indexOf("body.scratch") !== -1,
    JSON.stringify(s4.userDiff.revertedAiObjects));
  assert("and the summary says REVERTED, not merely removed",
    String(s4.userDiff.summary).indexOf("REVERTED") !== -1, s4.userDiff.summary);

  // ---- T4: a sketch that lost its constraints ----
  console.log("\n--- T4: a sketch that came loose between turns ---");
  const loosened = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
sk = doc.getObject("${(sk.result || {}).name}")
before = bool(sk.FullyConstrained)
sk.delConstraint(sk.ConstraintCount - 1)
doc.recompute()
return {"ok": True, "before": before, "after": bool(sk.FullyConstrained)}
`);
  if (loosened.__fail || loosened.after === true) {
    note("could not loosen the sketch", loosened.__fail || "still fully constrained");
  } else {
    const s5 = await sync();
    const dof = (s5.userDiff.dofChanges || []);
    assert("a sketch losing its constraints is reported as a DoF change",
      dof.some((c) => c.object === (sk.result || {}).name && c.was === true &&
        c.now === false), JSON.stringify(dof));
    assert("and health lists it as underconstrained",
      ((s5.health || {}).underconstrained || []).indexOf((sk.result || {}).name) !== -1,
      JSON.stringify(s5.health));
  }

  // ---- T5: the dry run is a review packet ----
  console.log("\n--- T5: the blast radius, before committing to it ---");
  const dry = await call("feature_edit",
    { target: "pad.plate", props: { Length: 30 } }, null, { dryRun: true });
  assert("the dry run reports success", dry && dry.ok === true,
    JSON.stringify(dry && { ok: dry.ok, error: dry.error }));
  assert("and is not applied", dry.applied === false, "applied=" + dry.applied);
  const rep = dry.report || {};
  assert("it carries a change report", !!rep.summary, JSON.stringify(rep));
  console.log("   report: " + rep.summary);
  console.log("   diff after rollback: " + JSON.stringify(dry.diff));
  if (dry.abortOverreach) {
    // The abort shares an undo stack with the human. If rolling our edit back
    // moved anything else — above all, resurrecting something they deleted —
    // that is a platform finding worth more than this test passing.
    note("the rollback did not leave the document as it was",
      JSON.stringify(dry.abortOverreach));
    console.log("   " + dry.abortNote);
  }
  assert("naming which object's volume moved",
    (rep.volumeDeltas || []).some((d) => d.object === (pad.result || {}).name),
    JSON.stringify(rep.volumeDeltas));
  // 50 x 40 x 10 -> x 30. The report must carry the numbers, not "changed".
  const moved = (rep.volumeDeltas || []).find(
    (d) => d.object === (pad.result || {}).name) || {};
  assert("with both numbers, not a count",
    near(moved.from, 50 * 40 * 10, 1) && near(moved.to, 50 * 40 * 30, 1),
    JSON.stringify(moved));
  assert("and a summary that names the object",
    String(rep.summary).indexOf((pad.result || {}).name) !== -1, rep.summary);
  const back = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "length": float(doc.getObject("${(pad.result || {}).name}").Length)}
`);
  assert("the document is untouched after the preview",
    !back.__fail && near(back.length, 10, 0.001),
    back.__fail || JSON.stringify(back));

  // ---- T6: a real edit reports what it did ----
  console.log("\n--- T6: and the same packet for an edit that lands ---");
  const real = await call("feature_edit",
    { target: "pad.plate", props: { Length: 30 } }, null);
  assert("the edit applied", real && real.applied === true,
    JSON.stringify(real && real.error));
  assert("it reports the same volume delta the dry run promised",
    (real.report.volumeDeltas || []).some(
      (d) => d.object === (pad.result || {}).name && near(d.to, 50 * 40 * 30, 1)),
    JSON.stringify(real.report.volumeDeltas));
  // The plate is 50 x 40, going 10 -> 30, so the model gains 40000 mm^3 --
  // once. A Body and its tip Pad report the same solid, so a total that sums
  // every object would say 80000, which looks precise and means nothing.
  assert("the document total counts the model once, not once per feature",
    real.report.totalVolume && near(real.report.totalVolume.delta,
      50 * 40 * 20, 200),
    JSON.stringify(real.report.totalVolume));

  // ---- T6b: a rollback must not resurrect the user's deletions ----
  console.log("\n--- T6b: what a rollback is allowed to touch ---");
  const victim = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
doc.addObject("Part::Box", "DoomedBox")
doc.recompute()
return {"ok": True}
`);
  await sync();
  const deleted = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
doc.removeObject("DoomedBox")
doc.recompute()
return {"ok": True, "present": doc.getObject("DoomedBox") is not None}
`);
  assert("the user deleted an object of their own",
    !victim.__fail && !deleted.__fail && deleted.present === false,
    JSON.stringify(deleted));
  const dry2 = await call("feature_edit",
    { target: "pad.plate", props: { Length: 40 } }, null, { dryRun: true });
  const still = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "present": doc.getObject("DoomedBox") is not None}
`);
  assert("a dry run does not bring it back from the undo stack",
    !still.__fail && still.present === false,
    JSON.stringify({ present: still.present,
                     overreach: dry2.abortOverreach || null }));
  if (dry2.abortOverreach) {
    note("the rollback reached past our own edit", dry2.abortNote);
  }

  // ---- T6c: the case that actually failed ----
  //
  // T6b deletes a plain box and the rollback leaves it dead. T5 deleted a
  // PartDesign Body and the rollback brought it back, origin features and
  // all. So reproduce T5's exact shape deliberately rather than relying on
  // an earlier test's leftovers to expose it.
  console.log("\n--- T6c: a deleted BODY, then a dry run ---");
  const doomedBody = await call("body", { label: "Doomed" }, "body.doomed");
  await sync();
  const goneBody = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
doc.removeObject("${(doomedBody.result || {}).name}")
doc.recompute()
return {"ok": True, "objects": len(doc.Objects)}
`);
  assert("the user deleted a whole body", !goneBody.__fail, goneBody.__fail);
  const dry3 = await call("feature_edit",
    { target: "pad.plate", props: { Length: 35 } }, null, { dryRun: true });
  const resurrect = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True,
        "back": doc.getObject("${(doomedBody.result || {}).name}") is not None,
        "objects": len(doc.Objects)}
`);
  assert("rolling back our edit does not resurrect their deleted body",
    !resurrect.__fail && resurrect.back === false,
    JSON.stringify({ back: resurrect.back,
                     repaired: dry3.abortRepaired || null,
                     overreach: dry3.abortOverreach || null }));
  assert("and the object count is where they left it",
    !resurrect.__fail && resurrect.objects === goneBody.objects,
    JSON.stringify({ afterDelete: goneBody.objects, afterDryRun: resurrect.objects }));
  // The platform brings them back; the envelope takes them out again. Whether
  // the rollback behaved or was made to behave is a different fact from
  // whether the document is correct, and both belong in the log.
  if (dry3.abortRepaired) {
    note("the rollback re-created objects and the envelope removed them again",
      JSON.stringify(dry3.abortRepaired));
  }
  if (dry3.abortOverreach) {
    note("and something was still left over", dry3.abortNote);
  }
  console.log("   seal: " + JSON.stringify(dry3.sealed));
  assert("the seal reports honestly whether it drained",
    dry3.sealed && typeof dry3.sealed.stillPending === "boolean",
    JSON.stringify(dry3.sealed));
  if (dry3.sealed && dry3.sealed.drainStalled) {
    note("commitTransaction does not clear HasPendingTransaction on this build",
      JSON.stringify(dry3.sealed));
  }

  // The repair deletes objects, so prove it deletes only what the rollback
  // invented — the user's own work must survive a dry run untouched.
  const survived = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "userBox": doc.getObject("UserBox") is not None,
        "plate": doc.getObject("${(pad.result || {}).name}") is not None,
        "length": float(doc.getObject("${(pad.result || {}).name}").Length)}
`);
  assert("the user's own objects are untouched by the repair",
    !survived.__fail && survived.userBox === true && survived.plate === true,
    JSON.stringify(survived));
  assert("and the edit really was rolled back, not left applied",
    !survived.__fail && near(survived.length, 30, 0.001),
    JSON.stringify(survived.length));


  // ---- T7: isolate, and put it back ----
  console.log("\n--- T7: isolate is only honest if it restores ---");
  const before = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "visible": sorted([o.Name for o in doc.Objects
                                       if getattr(o, "Visibility", False)])}
`);
  const iso = await call("isolate", { targets: ["body.plate"] }, null);
  assert("isolate applied", iso && iso.applied === true,
    JSON.stringify(iso && iso.error));
  const during = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "visible": sorted([o.Name for o in doc.Objects
                                       if getattr(o, "Visibility", False)])}
`);
  assert("something was actually hidden",
    !during.__fail && during.visible.length < before.visible.length,
    JSON.stringify({ before: before.visible, during: during.visible }));
  assert("and what we asked to keep is still visible",
    during.visible.indexOf("UserBox") === -1,
    JSON.stringify(during.visible));
  // The contract here changed on purpose, and this is the assertion that
  // used to encode the old one.
  //
  // "Exactly as they left it" is the right rule for the model and the wrong
  // rule for the scaffolding. A session that framed two finished parts and
  // then restored honestly got eighteen translucent infinite planes back on
  // top of them -- the restore was correct and the screen was worse than if
  // it had never run. So origins are left off, NAMED in the reply so nothing
  // is dropped silently, and includeOrigins:true is there for the caller who
  // really does want the document byte for byte.
  const restore = await call("view_restore", {}, null);
  assert("view_restore applied", restore && restore.applied === true,
    JSON.stringify(restore && restore.error));
  const after = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
ORIGIN = ("App::Origin", "App::Plane", "App::Line", "App::Point")
return {"ok": True,
        "visible": sorted([o.Name for o in doc.Objects
                           if getattr(o, "Visibility", False)]),
        "origins": sorted([o.Name for o in doc.Objects
                           if o.TypeId in ORIGIN])}
`);
  const scaffold = (n) => (after.origins || []).indexOf(n) !== -1;
  const model = (list) => (list || []).filter((n) => !scaffold(n));
  assert("everything that is not scaffolding is exactly as they left it",
    !after.__fail &&
      model(after.visible).join(",") === model(before.visible).join(","),
    JSON.stringify({ before: model(before.visible),
                     after: model(after.visible) }));
  const leftOff = before.visible.filter(
    (n) => scaffold(n) && after.visible.indexOf(n) === -1);
  assert("the origin planes it turned off are the ones it left off",
    leftOff.length > 0 &&
      ((restore.result || {}).originsLeftHidden || []).slice().sort().join(",")
        === leftOff.slice().sort().join(","),
    JSON.stringify({ reported: (restore.result || {}).originsLeftHidden,
                     measured: leftOff }));
  assert("and it says so rather than leaving them quietly off",
    String((restore.result || {}).note || "").indexOf("includeOrigins") !== -1,
    JSON.stringify((restore.result || {}).note));

  // The opt-out, measured against the same before-picture: this is where
  // "exactly as they left it" still has to hold, in full.
  await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
for n in ${JSON.stringify(before.visible)}:
    o = doc.getObject(n)
    if o is not None:
        o.Visibility = True
return {"ok": True}
`);
  await call("isolate", { targets: ["body.plate"] }, null);
  const restore2 = await call("view_restore", { includeOrigins: true }, null);
  assert("view_restore takes includeOrigins", restore2 && restore2.applied === true,
    JSON.stringify(restore2 && restore2.error));
  const after2 = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "visible": sorted([o.Name for o in doc.Objects
                                       if getattr(o, "Visibility", False)])}
`);
  assert("with it, the user's view is exactly as they left it",
    !after2.__fail && after2.visible.join(",") === before.visible.join(","),
    JSON.stringify({ before: before.visible, after: after2.visible }));

  // ---- T8: export is a handover, and now a real file ----
  // This used to be the only persistence in the product: MEMFS died with the
  // tab, so a file that was not pushed into the browser's downloads in the same
  // breath was gone. It lands on the user's filesystem now, so the assertion
  // moved with it — from "did the browser take it" to "is it on disk where the
  // reply says it is".
  console.log("\n--- T8: getting the work out ---");
  const fcstd = guard(parseResult(await tools.freecad_export({ format: "FCStd" })));
  if (assert("an FCStd export was written", !!(fcstd && fcstd.bytes > 0),
      JSON.stringify(fcstd))) {
    console.log("   " + fcstd.name + ", " + fcstd.bytes + " bytes, at " + fcstd.path);
    assert("it is a real file, not an empty one", fcstd.bytes > 1000,
      JSON.stringify(fcstd.bytes));
    assert("the reply says it persisted to disk", fcstd.persisted === "disk",
      JSON.stringify(fcstd.persisted));
    const onDisk = await probe(`
import os
p = ${JSON.stringify(fcstd.path || "")}
return {"ok": True, "exists": os.path.isfile(p), "bytes": os.path.getsize(p) if os.path.isfile(p) else 0}
`);
    assert("and the file is actually there, at the path it reported",
      !onDisk.__fail && onDisk.exists === true && onDisk.bytes === fcstd.bytes,
      JSON.stringify(onDisk));
    assert("with a url the user can pull it through",
      typeof fcstd.url === "string" && fcstd.url.indexOf("/file?path=") !== -1,
      JSON.stringify(fcstd.url));
    assert("the bytes did not come back through the conversation",
      !fcstd.data && !fcstd.base64 && !fcstd.content,
      "an export put the file contents in the tool result");
  }
  const step = guard(parseResult(await tools.freecad_export({ format: "STEP" })));
  if (assert("a STEP export was written", !!(step && step.bytes > 0),
      JSON.stringify(step))) {
    const head = await probe(`
return {"ok": True, "head": open("${step.path}").read(64)}
`);
    assert("and it really is a STEP file",
      !head.__fail && String(head.head).indexOf("ISO-10303") !== -1,
      head.__fail || JSON.stringify(head.head));
  }
  const bad = guard(parseResult(await tools.freecad_export({ format: "DWG" })));
  assert("an unsupported format is refused with the list",
    !!(bad && bad.error && String(bad.error).indexOf("STEP") !== -1),
    JSON.stringify(bad));

  // ---- teardown ----
  console.log("\n--- teardown ---");
  const down = await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
return {"ok": True, "open": list(App.listDocuments().keys())}
`);
  assert("scratch document closed", !down.__fail, down.__fail);

  console.log("\n=== turn: " + pass + " passed, " + fail + " failed, " +
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
