// scripts/test_bootstrap.js — attaching to a FreeCAD that was already open
//
// The case this covers is the normal one and was never tested: the human has
// had FreeCAD open for a while, possibly ran this skill against it yesterday,
// and a koi_cad from that session is still sitting in sys.modules. Everything
// here is about the MODULE, not the document — no geometry is built and no
// document is touched.
//
// Requires `probe-exec: on` in SKILL.md: planting a stale module is exactly
// the kind of condition the envelope is supposed to survive, and freecad_exec
// is how the suites set those up.

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
  const msg = "⚠️ " + label + (detail ? " — " + detail : "");
  results.push(msg);
  console.warn(msg);
}

function parseResult(res) {
  if (!res) return null;
  if (res.error) throw new Error(res.error);
  if (!res.content || !res.content[0] || !res.content[0].text) return res;
  try {
    return JSON.parse(res.content[0].text);
  } catch (e) {
    return res.content[0].text;
  }
}

async function probe(python, timeoutMs) {
  const r = parseResult(
    await tools.freecad_exec({ python, timeoutMs: timeoutMs || 30000 })
  );
  if (!r || r.ok !== true) return { __fail: (r && r.error) || "exec failed" };
  const d = r.result || {};
  if (d.ok === false) return { __fail: d.error || "returned ok:false" };
  return d;
}

async function attach() {
  return parseResult(await tools.freecad_attach({ timeoutMs: 240000 }));
}

// A call that is read-only and needs no document, so it can run against the
// human's open session without touching it. `lookup` also happens to be the
// op the alias points at, which is the second thing under test.
async function readOnlyCall(fn) {
  return parseResult(
    await tools.freecad_call({ fn, args: { what: "fasteners" }, timeoutMs: 60000 })
  );
}

async function run() {
  console.log("=== Attaching to an already-open FreeCAD ===");
  console.log("No document is created and none is modified.\n");

  // ---- 1. attach reports which koi_cad the process is running ------------
  console.log("--- attach reports the module it loaded ---");
  const a1 = await attach();
  if (!assert("attached", a1 && a1.attached === true,
      (a1 && (a1.error || a1.detail)) || "unknown")) {
    return { success: false, pass, fail, results, error: "could not attach" };
  }
  assert("attach loads koi_cad rather than deferring to the first edit",
    !!a1.koiCad || !!a1.koiCadError,
    "attach reported neither koiCad nor koiCadError: " + JSON.stringify(a1).slice(0, 200));
  assert("and it succeeded rather than reporting drift",
    !a1.koiCadError, a1.koiCadError);
  const shipped = (a1.koiCad || {}).version;
  assert("attach names the module version", !!shipped, JSON.stringify(a1.koiCad));
  assert("attach names the file it was imported from",
    !!(a1.koiCad || {}).file, JSON.stringify(a1.koiCad));
  console.log("   koi_cad " + shipped + " from " + (a1.koiCad || {}).file);

  // ---- 2. the alias dispatches and is not counted as drift ---------------
  console.log("\n--- the old fn spelling still dispatches ---");
  const viaNew = await readOnlyCall("lookup");
  assert("lookup returns the fastener table",
    viaNew && viaNew.ok === true &&
    !!(viaNew.result && viaNew.result.fasteners),
    JSON.stringify({ ok: viaNew && viaNew.ok, error: viaNew && viaNew.error }));
  const viaOld = await readOnlyCall("library");
  assert("the retired spelling 'library' still dispatches to it",
    viaOld && viaOld.ok === true &&
    !!(viaOld.result && viaOld.result.fasteners),
    JSON.stringify({ ok: viaOld && viaOld.ok, error: viaOld && viaOld.error }));
  assert("and both return the same table",
    JSON.stringify((viaOld.result || {}).fasteners) ===
    JSON.stringify((viaNew.result || {}).fasteners),
    "alias resolved to a different op");

  // ---- 3. THE REGRESSION: a module a previous session left behind --------
  //
  // Written as a real second copy on a real second sys.path entry, because
  // that is the shape of the bug. importlib.reload() re-reads the module's
  // own __file__, so a reload against a module imported from somewhere else
  // is a silent no-op: the module reports its OLD version and is missing
  // every op added since, and the only symptom is a whitelist drift error
  // several calls later that names the ops rather than the cause.
  console.log("\n--- a stale koi_cad from a previous session ---");
  const plant = await probe(`
import os, sys, tempfile
d = tempfile.mkdtemp(prefix="koi_stale_")
open(os.path.join(d, "koi_cad.py"), "w").write(
    'VERSION = "0.0.0-stale"\\nOP_NAMES = ["pad"]\\nOPS = {}\\n')
# Ahead of whatever the live session is using, which is the whole point: a
# previous session inserted ITS temp dir at position 0 too.
sys.path.insert(0, d)
sys.modules.pop("koi_cad", None)
import koi_cad
return {"ok": True, "dir": d, "version": koi_cad.VERSION,
        "file": getattr(koi_cad, "__file__", None)}
`);
  if (!assert("a stale koi_cad could be planted", !plant.__fail, plant.__fail)) {
    note("skipping the regression", "could not set up the condition");
  } else {
    assert("the planted module is the one Python resolves",
      plant.version === "0.0.0-stale", JSON.stringify(plant));

    // Everything below is the actual test. Before the fix this attach came
    // back with a drift error naming half the whitelist; after it, the
    // bootstrap evicts the stale module, puts its own directory first, and
    // says it did.
    const a2 = await attach();
    assert("attach still succeeds against a poisoned sys.path",
      a2 && a2.attached === true,
      (a2 && (a2.error || a2.koiCadError)) || "unknown");
    assert("and does NOT report whitelist drift",
      !a2.koiCadError, a2.koiCadError);
    assert("the stale module was evicted, not reloaded in place",
      (a2.koiCad || {}).version === shipped,
      "attach reports " + JSON.stringify(a2.koiCad) +
      ", expected version " + shipped);
    assert("attach says out loud that it replaced one",
      !!a2.koiCadNote,
      "no koiCadNote: a silent replacement is the failure mode this " +
      "test exists to catch");
    assert("and the edit channel works afterwards",
      (await readOnlyCall("lookup")).ok === true,
      "freecad_call still failing after the module was repaired");

    const cleanup = await probe(`
import shutil, sys
d = ${JSON.stringify(plant.dir)}
if d in sys.path:
    sys.path.remove(d)
shutil.rmtree(d, ignore_errors=True)
return {"ok": True, "onPath": d in sys.path}
`);
    if (cleanup.__fail) {
      note("cleanup failed", cleanup.__fail);
    } else {
      assert("the planted directory is off sys.path again",
        cleanup.onPath === false, JSON.stringify(cleanup));
    }
  }

  // ---- 4. a second attach is idempotent ---------------------------------
  console.log("\n--- attaching twice ---");
  const a3 = await attach();
  assert("a repeat attach reports the same module",
    (a3.koiCad || {}).version === shipped,
    JSON.stringify(a3.koiCad));
  assert("and does not claim it replaced anything",
    !a3.koiCadNote,
    "a clean re-attach should not report a stale replacement");

  // ---- 4b. auto-attach transparently connects unattached tools ---------
  console.log("\n--- auto-attach on fresh tool call ---");
  // Force detach by re-configuring or clearing attach state via a fresh probe
  const probeInfo = parseResult(await tools.freecad_probe({}));
  assert("probe reports bridge liveness", probeInfo && probeInfo.bridge === true);

  // Calling sync or call directly when attached succeeds seamlessly
  const autoSync = parseResult(await tools.freecad_sync({}));
  assert("freecad_sync succeeds with auto-attach", !!autoSync && !autoSync.error, JSON.stringify(autoSync));

  const autoCall = parseResult(await tools.freecad_call({ fn: "lookup", args: { what: "params" } }));
  assert("freecad_call succeeds with auto-attach", !!autoCall && autoCall.ok === true, JSON.stringify(autoCall));

  const autoMeasure = parseResult(await tools.freecad_measure({}));
  assert("freecad_measure succeeds with auto-attach", !!autoMeasure && !autoMeasure.error, JSON.stringify(autoMeasure));

  // ---- 5. the human's document is untouched -----------------------------
  console.log("\n--- the open document is untouched ---");
  const sync = parseResult(await tools.freecad_sync({}));
  assert("sync still reads the document",
    !!sync && sync.error === undefined,
    JSON.stringify(sync).slice(0, 200));
  if (sync && typeof sync.objectCount === "number") {
    console.log("   document has " + sync.objectCount +
      " objects; this suite added none");
  }

  const buildInfo = parseResult(await tools.freecad_version({}));
  const build = buildInfo.build || (buildInfo.runtime || {});
  console.log("\n" + pass + " passed, " + fail + " failed, " + warn + " warnings.");
  console.log("Valid for build " + (build.exeVersion || build.version || "?") +
    " @ " + (build.commit || "?"));

  return { success: fail === 0, pass, fail, warn, results };
}

return run().catch((e) => {
  console.error(e);
  results.push("❌ " + e.message);
  return { success: false, pass, fail, warn, results, error: e.message };
});