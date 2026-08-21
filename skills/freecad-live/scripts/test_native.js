// scripts/test_native.js — the properties the bridge has that the wasm build
// could not, asserted rather than assumed.
//
//   /skill freecad-live/scripts/test_native.js --full-auto
//
// Everything else in scripts/ tests CAD, or tests the platform assumptions the
// CAD rests on. This one tests the *claims made when the transport changed*,
// because a migration justified by five properties and verified by none of them
// is a migration justified by a diagram.
//
//   N1 process    the AI and the human are in the SAME FreeCAD. One pid, one
//                 document, one undo stack. This is the whole reason the bridge
//                 is in-process rather than `docker exec`-ing a second
//                 interpreter, and it is the claim that, if false, makes every
//                 co-design rule in SKILL.md a lie.
//   N2 thread     jobs land on the thread that owns the document. FreeCAD's
//                 Python is not thread-safe; a job on the HTTP worker corrupts
//                 state and crashes somewhere else entirely.
//   N3 recovery   a snippet that overruns is survivable. The wasm build had no
//                 answer to this — no interrupt, no exit but a reload that cost
//                 the user their document. Here the process lives and the next
//                 call works. THIS is the headline difference; if it does not
//                 hold, the migration bought latency and nothing else.
//   N4 persistence a save is a real file on a real filesystem, and it is still
//                 there after the session forgets about it.
//   N5 concurrency a second call while one is running is refused with what is
//                 running, not queued invisibly behind it.
//   N6 census     which workbenches this install actually has. Not pass/fail:
//                 SKILL.md's "what is not in this skill" list was written
//                 against a stripped wasm build, and on a full install some of
//                 those refusals may now be lies. Printed so a human decides.
//
// Valid for one build. The last line says which.

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

async function probe(python, timeoutMs) {
  const r = parseResult(
    await tools.freecad_exec({ python, timeoutMs: timeoutMs || 30000 }),
  );
  if (!r || r.ok !== true) return { __fail: (r && r.error) || "exec failed" };
  const d = r.result || {};
  if (d.ok === false) return { __fail: d.error || "returned ok:false" };
  return d;
}

const DOC = "NativeProbe";

async function run() {
  console.log("=== the native bridge: what changed, and whether it is true ===\n");

  const cfg = parseResult(await tools.freecad_config({}));
  if (!assert("MCP tools registered", !!cfg && !cfg.__error, cfg && cfg.error)) {
    return { success: false, pass, fail, warn, results, error: "no MCP" };
  }
  console.log("bridge: " + cfg.bridgeUrl + " (source: " + cfg.source + ")\n");

  const attach = parseResult(await tools.freecad_attach({ timeoutMs: 120000 }));
  if (!assert("attached", attach && attach.attached === true,
      (attach && (attach.error || attach.detail)) || "unknown")) {
    return { success: false, pass, fail, warn, results, error: "could not attach" };
  }
  const gui = !!attach.gui;

  // ---- N1: one process, one document ------------------------------------
  console.log("--- N1: the AI and the human are in the same FreeCAD ---");
  const who = await probe(`
import os, FreeCAD as App
return {"ok": True, "pid": os.getpid(),
        "docs": list(App.listDocuments().keys())}
`);
  assert("the snippet runs in the process the bridge reported",
    !who.__fail && who.pid === attach.pid,
    JSON.stringify({ snippet: who.pid, bridge: attach.pid }));

  // The GUI half of N1 needs a document to exist before it can ask who can see
  // it, so it runs after the scratch document below rather than here. An
  // earlier version asked on an empty session, compared [] against null and
  // called that a failure — it was measuring nothing, in the wrong order,
  // through an API (Gui.listDocuments) that is not on every build.

  // ---- N2: the thread that owns the document ----------------------------
  console.log("\n--- N2: jobs land on the document-owning thread ---");
  const thread = await probe(`
import threading
t = threading.current_thread()
return {"ok": True, "name": t.name, "isMain": t is threading.main_thread(),
        "count": threading.active_count()}
`);
  if (gui) {
    assert("the snippet runs on the main thread, not an HTTP worker",
      !thread.__fail && thread.isMain === true,
      "ran on '" + thread.name + "'");
    assert("the bridge says so too",
      typeof attach.dispatch === "string" && attach.dispatch.indexOf("qtimer") === 0,
      "dispatch is '" + attach.dispatch + "'");
  } else {
    assert("headless dispatch is inline on the serving thread",
      attach.dispatch === "inline", "dispatch is '" + attach.dispatch + "'");
  }

  // ---- scratch document --------------------------------------------------
  const setup = await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
doc = App.newDocument("${DOC}")
doc.UndoMode = 1
App.setActiveDocument("${DOC}")
b = doc.addObject("Part::Box", "Anchor")
b.Length, b.Width, b.Height = 10, 10, 10
doc.recompute()
return {"ok": True}
`);
  if (!assert("scratch document created", !setup.__fail, setup.__fail)) {
    return { success: false, pass, fail, warn, results, error: "no scratch doc" };
  }

  if (gui) {
    // The document the AI just made must be a document the GUI is showing. Two
    // interpreters would each have their own, and every rule about the human
    // clicking a face the AI built would be describing a window nobody has.
    //
    // Asked through Gui.getDocument(name).Document.Name rather than by
    // comparing document lists: that walks the ViewProvider document back to
    // the App document object, so it proves the GUI is showing THIS object and
    // not merely a document with the same name.
    const seen = await probe(`
import FreeCADGui as Gui
try:
    gd = Gui.getDocument("${DOC}")
except Exception as e:
    return {"ok": True, "linked": None, "err": str(e)}
return {"ok": True, "linked": gd.Document.Name,
        "active": (Gui.ActiveDocument.Document.Name if Gui.ActiveDocument else None)}
`);
    assert("the GUI is showing the document the AI just created",
      !seen.__fail && seen.linked === DOC,
      JSON.stringify(seen));
  } else {
    note("headless", "N1's GUI half and everything about selection are untestable");
  }

  // ---- N3: an overrun is survivable --------------------------------------
  // The claim being tested is the one the whole migration was worth: on the
  // wasm build this exact sequence ended the session AND the document. If the
  // recovery half of this fails, the transport is faster and no safer, and
  // SKILL.md should go back to saying so.
  console.log("\n--- N3: a snippet that overruns does not end the session ---");
  const t0 = Date.now();
  const over = parseResult(await tools.freecad_exec({
    python: "import time\ntime.sleep(6)\nreturn {'ok': True}",
    timeoutMs: 1500,
  }));
  const overMs = Date.now() - t0;
  assert("the call comes back at its deadline rather than hanging",
    over && over.ok === false && overMs < 12000,
    JSON.stringify({ ms: overMs, res: over }).slice(0, 200));
  assert("and says the job is still running rather than blaming the user",
    !!(over && /still running|busy/i.test(String(over.error))),
    JSON.stringify(over && over.error));

  // A call during the overrun must be refused, not queued: N5, tested here
  // because this is the only moment the condition exists.
  console.log("\n--- N5: one job at a time, and it says so ---");
  const during = parseResult(await tools.freecad_exec({
    python: "return {'ok': True}", timeoutMs: 3000,
  }));
  assert("a second call during a running job is refused",
    during && during.ok === false, JSON.stringify(during).slice(0, 160));
  assert("and the refusal names what is running",
    !!(during && (during.busy || /busy|running/i.test(String(during.error)))),
    JSON.stringify(during && (during.error || during.busy)));

  // Now wait it out. The point is not that the timeout fired; it is that the
  // session is still here afterwards.
  //
  // Recovery has to be measured, not assumed, and specifically it has to be
  // measured against the *bridge* rather than against anything cached here. A
  // client that refuses on its own record of being busy can never observe the
  // moment it stops being true — which is how the first version of this
  // deadlocked itself for the rest of the session on a six-second sleep.
  console.log("   waiting for the overrun to finish…");
  let recovered = null;
  // Wall clock, not a sum of nominal sleeps. The first version added 1000 per
  // iteration and ignored the round trip, so it reported ~3000 ms for a
  // six-second snippet — undercounting by half. A suite whose entire purpose
  // is to check that measured claims are true has no business estimating its
  // own numbers.
  const started = Date.now();
  const deadline = started + 30000;
  while (Date.now() < deadline) {
    await tools.sleep(500);
    const r = await probe(`return {"ok": True, "alive": True}`, 5000);
    if (!r.__fail) { recovered = r; break; }
  }
  const waited = Date.now() - started;
  assert("the session recovers on its own once the job returns", !!recovered,
    "still refusing 30 s after a 6 s snippet — check that nothing on the " +
    "client side is refusing on a cached busy flag");
  if (recovered) {
    console.log("   recovered " + waited + " ms after the deadline fired " +
      "(the snippet sleeps 6000 ms from its own start)");
    // Generous on purpose: the useful signal is "it came back when the job
    // finished" rather than a tight bound on a sleeping thread. Anything
    // beyond this is something holding the session shut after FreeCAD freed
    // it, which is the defect this test exists for.
    assert("and it recovered on the job's own timescale, not a session reset",
      waited <= 15000, waited + " ms for a 6 s snippet");
  }

  const survived = await probe(`
import FreeCAD as App
d = App.getDocument("${DOC}")
return {"ok": True, "objects": [o.Name for o in d.Objects],
        "undo": len(list(d.UndoNames))}
`);
  assert("and the document survived the overrun intact",
    !survived.__fail && (survived.objects || []).indexOf("Anchor") !== -1,
    JSON.stringify(survived));

  // ---- N4: a save is a save ----------------------------------------------
  //
  // Checked in two steps on purpose. Whether the directory is writable is a
  // deployment fact the bridge already knows; whether the export works is a
  // CAD fact. Rolling them together produces the least useful possible
  // failure — an export error that is really a chown — which is exactly what
  // the first run of this suite produced against a rootless Podman bind mount.
  console.log("\n--- N4: export lands on a real filesystem ---");
  const pf = parseResult(await tools.freecad_probe({}));
  const writable = !pf || pf.exportWritable !== false;
  if (!writable) {
    note("the export directory is not writable",
      (pf.exportDir || "?") + " — " + (pf.exportError || "no detail") +
      ". Geometry works; handover does not. On rootless Podman: " +
      "podman unshare chown -R 1000:1000 <host path>, or set KOI_EXPORT_DIR " +
      "to a path the container owns such as /config/koi_export.");
  }
  const exp = parseResult(await tools.freecad_export({ format: "FCStd" }));
  if (!writable) {
    assert("and export says so before touching the document, with the fix",
      !!(exp && exp.error && exp.detail && /chown|KOI_EXPORT_DIR/.test(exp.detail)),
      JSON.stringify(exp).slice(0, 200));
  } else if (assert("an FCStd export was written", !!(exp && exp.bytes > 0),
      JSON.stringify(exp).slice(0, 200))) {
    assert("it reports persistence to disk, not a browser download",
      exp.persisted === "disk", JSON.stringify(exp.persisted));
    const still = await probe(`
import os
p = ${JSON.stringify(exp.path || "")}
return {"ok": True, "exists": os.path.isfile(p),
        "bytes": (os.path.getsize(p) if os.path.isfile(p) else 0),
        "abs": os.path.isabs(p)}
`);
    assert("the file exists at the path it reported",
      !still.__fail && still.exists === true && still.bytes === exp.bytes,
      JSON.stringify(still));
    assert("on a real absolute path, not a sandbox one",
      !still.__fail && still.abs === true, JSON.stringify(exp.path));
    console.log("   " + exp.path + " (" + exp.bytes + " bytes)");
  }

  // ---- N6: what this install can actually do -----------------------------
  // Notes, never failures. The wasm build shipped a subset of workbenches and
  // SKILL.md's refusal list was written to match it. On a full install some of
  // those refusals describe nothing, and a skill that refuses work the engine
  // can do is as wrong as one that promises work it cannot.
  console.log("\n--- N6: capability census (informational) ---");
  const census = await probe(`
import importlib, sys
def has(name):
    try:
        importlib.import_module(name)
        return True
    except Exception:
        return False
wb = {}
for m in ("Assembly", "TechDraw", "SheetMetal", "Fem", "Draft",
          "PartDesign", "Part", "Sketcher", "Mesh", "Import", "Spreadsheet"):
    wb[m] = has(m)
thread_geom = False
try:
    import Part
    thread_geom = hasattr(Part, "makeLongHelix") or hasattr(Part, "makeHelix")
except Exception:
    pass
try:
    import multiprocessing
    cpus = multiprocessing.cpu_count()
except Exception:
    cpus = None
return {"ok": True, "wb": wb, "helix": thread_geom, "cpus": cpus,
        "platform": sys.platform}
`, 60000);
  if (census.__fail) {
    note("the census did not run", census.__fail);
  } else {
    const wb = census.wb || {};
    console.log("   workbenches: " +
      Object.keys(wb).filter((k) => wb[k]).join(", "));
    console.log("   " + census.platform + ", " + census.cpus + " cpus");
    if (wb.Assembly) {
      note("Assembly is importable on this install",
        "SKILL.md still says assembly constraints and mates are not in this " +
        "skill. That was true of the wasm build. It is now a scope decision " +
        "rather than a platform limit — and until an op exists for it, the " +
        "refusal must stay, because a mate faked with a placement is still " +
        "not a mate.");
    }
    if (wb.TechDraw) {
      note("TechDraw is importable on this install",
        "same as above: drawings are out of scope, not out of reach");
    }
    if (wb.SheetMetal) note("SheetMetal is importable", "out of scope, not unavailable");
    if (census.helix) {
      note("Part can build helices on this install",
        "this does NOT change the rule. Threads are a specification; cut " +
        "geometry is still a lint error, and being able to do it is why the " +
        "rule needs stating rather than why it should relax.");
    }
  }

  // ---- teardown ----------------------------------------------------------
  console.log("\n--- teardown ---");
  const down = await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
return {"ok": True, "open": list(App.listDocuments().keys())}
`);
  assert("scratch document closed", !down.__fail, down.__fail);

  const ver = parseResult(await tools.freecad_version({}));
  const build = (ver && (ver.build || ver.runtime)) || {};
  console.log("\n" + pass + " passed, " + fail + " failed, " + warn + " notes.");
  console.log("Valid for FreeCAD " + (build.exeVersion || "?") + " @ " +
    (build.commit || "?") + (gui ? " (gui)" : " (headless)"));

  return { success: fail === 0, pass, fail, warn, results, build, gui };
}

return run().catch((e) => {
  console.error(e);
  results.push("❌ " + e.message);
  return { success: false, pass, fail, warn, results, error: e.message };
});