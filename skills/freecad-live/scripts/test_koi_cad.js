// scripts/test_koi_cad.js — harness for the koi_cad envelope (§5.1, §5.3, §6.5).
//
//   /skill freecad-live/scripts/test_koi_cad.js --full-auto
//   /skill freecad-live/scripts/test_koi_cad.js --full-auto --param interactive=1
//
// test_probes.js measured the PLATFORM. This measures OUR CODE, and the two
// must not be confused: every green here is only meaningful because the probes
// established what the platform does underneath it. If a probe result changes
// on a build bump, these tests are testing an envelope built on a false
// premise, however green they are.
//
// Scratch document KoiCadTest, closed at the end. Your documents are untouched,
// but the active document and viewport change while this runs.
//
// Rules inherited from the probes, and enforced here:
//   - assert against the live document, never against tool JSON alone
//   - a visual criterion is not a criterion: check volumes, not appearances
//   - every gate gets a test that makes it say NO
//   - every loop sent to the page carries a bound
//   - transport loss ends the run rather than producing derived failures

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

async function sync() {
  return guard(parseResult(await tools.freecad_sync({})));
}

async function edit(name, python, opts) {
  return guard(
    parseResult(
      await tools.freecad_edit(Object.assign({ name, python }, opts || {}))
    )
  );
}

// Raw exec, used only to set up conditions the envelope is supposed to handle
// (breaking the document on purpose) and to read ground truth back out. Never
// used to make an assertion pass.
async function probe(python, timeoutMs) {
  const r = guard(
    parseResult(await tools.freecad_exec({ python, timeoutMs: timeoutMs || 30000 }))
  );
  if (!r || r.ok !== true) return { __fail: (r && r.error) || "exec failed" };
  const d = r.result || {};
  if (d.ok === false) return { __fail: d.error || "returned ok:false" };
  return d;
}

const DOC = "KoiCadTest";

async function run() {
  const interactive = (typeof args !== "undefined" && Array.isArray(args)
    ? args.join(" ")
    : ""
  ).indexOf("interactive") !== -1;

  console.log("=== koi_cad envelope tests ===");
  console.log("Scratch document: " + DOC + "\n");

  const attach = parseResult(await tools.freecad_attach({ timeoutMs: 240000 }));
  if (!assert("attached", attach && attach.attached === true,
      (attach && (attach.error || attach.detail)) || "unknown")) {
    return { success: false, pass, fail, results, error: "not attached" };
  }
  const build = attach.build || {};
  console.log("   build: " + build.exeVersion + " @ " + String(build.commit).slice(0, 12));
  console.log("   (valid only against the probe results for this build)\n");

  // ---- scratch document, outside the envelope on purpose ----
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

  // ---- T1: sync ----
  console.log("--- T1: freecad_sync ---");
  const s1 = await sync();
  assert("sync returns the document", s1 && s1.document === DOC,
    JSON.stringify(s1 && s1.document));
  assert("sync reports the GUI state", s1 && s1.gui && typeof s1.gui.busy === "boolean",
    JSON.stringify(s1 && s1.gui));
  assert("sync returns a lint array", Array.isArray(s1 && s1.lint),
    JSON.stringify(s1 && s1.lint));
  if (s1 && s1.gui && s1.gui.busy) {
    note("an edit session is already open", "close it — the mutating tests below " +
      "would be doing what the gate exists to prevent");
    return { success: false, pass, fail, warn, results, error: "GUI busy" };
  }

  // ---- T2: a real edit through the envelope ----
  console.log("\n--- T2: an edit applies, and is reported ---");
  const e2 = await edit("Build test plate", `
import Part, Sketcher
from FreeCAD import Vector as V
body = doc.addObject("PartDesign::Body", "Body")
plane = None
for o in body.Origin.OriginFeatures:
    if "XY_Plane" in o.Name:
        plane = o
sk = doc.addObject("Sketcher::SketchObject", "sk_base")
body.addObject(sk)
try:
    sk.AttachmentSupport = [(plane, "")]
except Exception:
    sk.Support = [(plane, "")]
sk.MapMode = "FlatFace"
C = Sketcher.Constraint
g = []
g.append(sk.addGeometry(Part.LineSegment(V(0,0,0),  V(40,0,0)),  False))
g.append(sk.addGeometry(Part.LineSegment(V(40,0,0), V(40,30,0)), False))
g.append(sk.addGeometry(Part.LineSegment(V(40,30,0),V(0,30,0)),  False))
g.append(sk.addGeometry(Part.LineSegment(V(0,30,0), V(0,0,0)),   False))
sk.addConstraint(C("Coincident", g[0],2, g[1],1))
sk.addConstraint(C("Coincident", g[1],2, g[2],1))
sk.addConstraint(C("Coincident", g[2],2, g[3],1))
sk.addConstraint(C("Coincident", g[3],2, g[0],1))
sk.addConstraint(C("Horizontal", g[0]))
sk.addConstraint(C("Horizontal", g[2]))
sk.addConstraint(C("Vertical",   g[1]))
sk.addConstraint(C("Vertical",   g[3]))
sk.addConstraint(C("Coincident", g[0],1, -1,1))
sk.addConstraint(C("DistanceX", g[0],1, g[0],2, 40.0))
sk.addConstraint(C("DistanceY", g[1],1, g[1],2, 30.0))
pad = body.newObject("PartDesign::Pad", "Pad")
pad.Profile = sk
pad.Length = 10.0
sk.Visibility = False
`, { timeoutMs: 120000 });

  const built = assert("the edit applied", e2 && e2.applied === true,
    JSON.stringify(e2 && { ok: e2.ok, reason: e2.reason, error: e2.error }));
  if (built) {
    assert("the edit is reported as correct", e2.ok === true,
      "newErrors " + JSON.stringify(e2.newErrors));
    assert("the diff names what was added",
      (e2.diff && e2.diff.added || []).indexOf("Pad") !== -1,
      JSON.stringify(e2.diff && e2.diff.added));
    console.log("   undo entries booked: " + e2.undoEntries +
      "  singleUndo=" + e2.singleUndo);
    if (e2.singleUndo === false) {
      assert("a multi-entry edit carries the undo warning", !!e2.undoNote,
        "the user would be told one Ctrl+Z is enough when it is not");
    }
    // Ground truth, not the tool's own word for it.
    const v = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
b = doc.getObject("Body")
return {"ok": True, "volume": b.Shape.Volume, "z": b.Shape.BoundBox.ZLength}
`);
    assert("the solid really exists at the expected size",
      !v.__fail && Math.abs(v.volume - 40 * 30 * 10) < 1,
      v.__fail || ("volume " + v.volume));
  }

  // ---- T3: the gate says NO ----
  if (interactive && built) {
    console.log("\n--- T3: the gate refuses while the user is editing ---");
    console.log("");
    console.log("   ┌───────────────────────────────────────────────────────┐");
    console.log("   │  In FreeCAD's Model tree, double-click                 │");
    console.log("   │      KoiCadTest ▸ sk_base                              │");
    console.log("   │  to open the sketch editor. Leave it open.             │");
    console.log("   │  Waiting up to 45 s…                                   │");
    console.log("   └───────────────────────────────────────────────────────┘");
    console.log("");
    let seen = false;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !seen) {
      await tools.sleep(2500);
      const s = await sync();
      if (s && s.gui && s.gui.busy) seen = true;
    }
    if (!seen) {
      note("no edit session appeared", "the gate was not exercised this run");
    } else {
      const e3 = await edit("Should be refused", `
doc.addObject("Part::Box", "koi_breach")
`);
      assert("the envelope refuses while an edit session is open",
        e3 && e3.reason === "gui-busy" && e3.applied !== true,
        JSON.stringify(e3 && { reason: e3.reason, applied: e3.applied }));
      const b = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "breach": doc.getObject("koi_breach") is not None}
`);
      assert("nothing was written past the gate", !b.__fail && b.breach === false,
        b.__fail || "koi_breach exists");
      await probe(`
import FreeCAD as App, FreeCADGui as Gui
try:
    if Gui.ActiveDocument:
        Gui.ActiveDocument.resetEdit()
except Exception:
    pass
try:
    if Gui.Control.activeDialog():
        Gui.Control.closeDialog()
except Exception:
    pass
return {"ok": True}
`);
    }
  } else if (built) {
    note("gate not exercised", "re-run with --param interactive=1 to make it say no");
  }

  // ---- T4: dry run changes nothing ----
  if (built) {
    console.log("\n--- T4: dryRun applies, measures, rolls back ---");
    const e4 = await edit("Preview thicker plate", `
doc.getObject("Pad").Length = 25.0
`, { dryRun: true, timeoutMs: 60000 });
    assert("a dry run reports success, not failure", e4 && e4.ok === true,
      JSON.stringify(e4 && { ok: e4.ok, reason: e4.reason, error: e4.error }));
    assert("a dry run is not applied", e4 && e4.applied === false,
      "applied=" + (e4 && e4.applied));
    assert("a dry run says why it rolled back", e4 && e4.reason === "dry-run",
      "reason=" + (e4 && e4.reason));
    const after4 = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
return {"ok": True, "length": float(doc.getObject("Pad").Length),
        "volume": doc.getObject("Body").Shape.Volume}
`);
    assert("the document is unchanged after a dry run",
      !after4.__fail && Math.abs(after4.length - 10) < 0.001,
      after4.__fail || ("Pad.Length is " + after4.length));
  }

  // ---- T5: a bad edit aborts and leaves nothing behind ----
  if (built) {
    console.log("\n--- T5: an edit that breaks the model is rolled back ---");
    const e5 = await edit("Break the profile", `
doc.getObject("sk_base").delGeometry(0)
`, { timeoutMs: 60000 });
    assert("an edit introducing a recompute error is aborted",
      e5 && e5.applied === false && e5.reason === "new-recompute-errors",
      JSON.stringify(e5 && { applied: e5.applied, reason: e5.reason,
        newErrors: e5.newErrors }));
    assert("the abort names what broke", (e5 && e5.newErrors || []).length > 0,
      JSON.stringify(e5 && e5.newErrors));
    const after5 = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
sk = doc.getObject("sk_base")
pad = doc.getObject("Pad")
return {"ok": True, "geoCount": sk.GeometryCount, "padValid": pad.isValid(),
        "volume": doc.getObject("Body").Shape.Volume}
`);
    assert("the model is intact after the abort",
      !after5.__fail && after5.padValid === true &&
        Math.abs(after5.volume - 40 * 30 * 10) < 1,
      after5.__fail || JSON.stringify(after5));
  }

  // ---- T6: an exception is reported, not swallowed ----
  if (built) {
    console.log("\n--- T6: an exception aborts and is reported ---");
    const e6 = await edit("Deliberate error", `
raise RuntimeError("koi-cad-test-boom")
`, { timeoutMs: 60000 });
    assert("an exception marks the edit not ok", e6 && e6.ok === false,
      JSON.stringify(e6 && { ok: e6.ok, reason: e6.reason }));
    assert("the exception message survives",
      String(e6 && e6.error).indexOf("koi-cad-test-boom") !== -1,
      String(e6 && e6.error));
    assert("nothing was applied", e6 && e6.applied === false,
      "applied=" + (e6 && e6.applied));
  }

  // ---- T7: lint measures rather than trusting state flags ----
  if (built) {
    console.log("\n--- T7: lint catches a feature that does nothing ---");
    const e7 = await edit("Add a pocket the wrong way round", `
import Part, Sketcher
from FreeCAD import Vector as V
body = doc.getObject("Body")
plane = None
for o in body.Origin.OriginFeatures:
    if "XY_Plane" in o.Name:
        plane = o
sk2 = doc.addObject("Sketcher::SketchObject", "sk_hole")
body.addObject(sk2)
try:
    sk2.AttachmentSupport = [(plane, "")]
except Exception:
    sk2.Support = [(plane, "")]
sk2.MapMode = "FlatFace"
sk2.addGeometry(Part.Circle(V(20,15,0), V(0,0,1), 5.0), False)
pocket = body.newObject("PartDesign::Pocket", "Pocket")
pocket.Profile = sk2
pocket.Type = "ThroughAll"
pocket.Reversed = False
sk2.Visibility = False
`, { timeoutMs: 120000 });

    if (!e7 || e7.applied !== true) {
      note("the no-op pocket edit did not apply", JSON.stringify(e7 && e7.reason));
    } else {
      // The point of the test: FreeCAD reports this feature as healthy.
      const flags = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
p = doc.getObject("Pocket")
return {"ok": True, "state": list(p.State), "valid": p.isValid(),
        "volume": doc.getObject("Body").Shape.Volume}
`);
      assert("FreeCAD itself reports the no-op feature as healthy",
        !flags.__fail && flags.valid === true,
        "if this fails the platform changed and §6.5 can be simplified");
      const hit = (e7.lint || []).filter((w) => w.code === "removed-nothing");
      assert("lint reports that the pocket removed nothing", hit.length > 0,
        "lint was " + JSON.stringify(e7.lint));
      if (hit.length) console.log("   " + hit[0].message);

      const e7b = await edit("Point the pocket at the material", `
doc.getObject("Pocket").Reversed = True
`, { timeoutMs: 60000 });
      const hit2 = ((e7b && e7b.lint) || []).filter((w) => w.code === "removed-nothing");
      assert("the warning clears once the pocket cuts", hit2.length === 0,
        JSON.stringify(hit2));
    }
  }

  // ---- T8: a pre-existing error must not block a good edit ----
  if (built) {
    console.log("\n--- T8: an already-broken document still accepts a good edit ---");
    // Break it OUTSIDE the envelope, so the damage is committed and pre-existing.
    const broke = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
doc.getObject("sk_base").delGeometry(0)
doc.recompute()
return {"ok": True, "padValid": doc.getObject("Pad").isValid()}
`, 60000);
    assert("the document is broken before the edit",
      !broke.__fail && broke.padValid === false,
      broke.__fail || "Pad still valid — the test condition was not created");

    const e8 = await edit("Unrelated good edit", `
b = doc.addObject("Part::Box", "koi_ok_box")
b.Length = 5
`, { timeoutMs: 60000 });
    assert("a pre-existing error does not abort an unrelated good edit",
      e8 && e8.applied === true,
      "reason " + (e8 && e8.reason) + ", newErrors " +
        JSON.stringify(e8 && e8.newErrors));
    assert("the pre-existing breakage is still reported by lint",
      ((e8 && e8.lint) || []).some((w) => w.level === "error"),
      "lint " + JSON.stringify(e8 && e8.lint));
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

  console.log("\n=== koi_cad: " + pass + " passed, " + fail + " failed, " +
    warn + " notes ===");
  console.log("Valid ONLY for build " + build.exeVersion + " @ " +
    String(build.commit).slice(0, 12) + ", and only while the probe results hold.");

  return { success: fail === 0, pass, fail, warn, results, interactive,
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
