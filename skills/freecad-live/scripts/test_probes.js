// scripts/test_probes.js — kill probes K1(rest), K6, K4, K3, K2.
//
//   /skill freecad-live/scripts/test_probes.js --full-auto
//   /skill freecad-live/scripts/test_probes.js --full-auto --param interactive=1
//
// THIS IS A THROWAWAY. It is not the skeleton of koi_cad.py and must not
// become one. Every probe here is free Python sent through freecad_exec
// precisely so that nothing is built before the answers are in: §11.1 says six
// probes can kill the design, K0 answered one, and four of the remaining five
// need no tool surface, no transaction envelope and no canonicaliser to
// answer. Building those first and probing after is how you find out that K6
// fails from inside the module that assumed it wouldn't.
//
// Order is cheapest-and-most-fatal-first:
//   K1  does the channel report failure, and how much can it carry
//   K6  can we detect the user's in-flight edit  — hard blocker
//   K4  does parametric propagation survive the bridge — "no reason to exist"
//   K3  does the transaction envelope hold — dry run depends on it
//   K2  is it fast enough to feel alive — sets the document-size ceiling
//
// SCRATCH DOCUMENT. Everything runs in a document called KoiProbe, created at
// the start and closed without saving at the end, and the previously active
// document is restored. Your own documents are never touched — but the *active
// document* and the viewport do change while this runs, so do not run it in
// the middle of your own work.

const results = [];
let pass = 0;
let fail = 0;
let warn = 0;
const timings = {};

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

// A bridge that has stopped answering produces one real failure and then a
// failure for every probe after it, each one indistinguishable in the log from
// a genuine result. That is worse than useless: one run reported 5 failures, of
// which 1 was real and 4 were the transport being gone. So transport loss is
// detected once and ends the run.
class TransportLost extends Error {}

function isTransportError(msg) {
  const s = String(msg || "");
  return (
    s.indexOf("BROWSER_BRIDGE_UNAVAILABLE") !== -1 ||
    s.indexOf("did not respond within") !== -1 ||
    s.indexOf("executeBrowserTool timeout") !== -1
  );
}

// Raw exec: returns the tool envelope, so a probe can inspect a *failure*.
async function raw(code, timeoutMs) {
  const r = parseResult(
    await tools.freecad_exec({ python: code, timeoutMs: timeoutMs || 30000 })
  );
  const msg = r && (r.error || (r.__error && r.error));
  if (isTransportError(msg)) throw new TransportLost(String(msg));
  return r;
}

// Happy-path exec: returns the snippet's dict, or { __fail } if anything went
// wrong at any level. Probes that expect success use this; probes that expect
// failure use raw().
async function py(code, timeoutMs) {
  const r = await raw(code, timeoutMs);
  if (!r || r.__error) return { __fail: (r && r.error) || "tool error" };
  if (r.ok !== true) return { __fail: r.error || "exec failed" };
  const d = r.result || {};
  if (d.ok === false) return { __fail: d.error || "probe returned ok:false" };
  return d;
}

const DOC = "KoiProbe";

async function run() {
  const interactive = (typeof args !== "undefined" && Array.isArray(args)
    ? args.join(" ")
    : ""
  ).indexOf("interactive") !== -1;

  console.log("=== FreeCAD kill probes — K1(rest), K6, K4, K3, K2 ===");
  console.log("Scratch document: " + DOC + ". Your documents are not touched,");
  console.log("but the active document and viewport change while this runs.\n");

  // ---- Attach ----
  const attach = parseResult(await tools.freecad_attach({ timeoutMs: 240000 }));
  if (
    !assert(
      "attached",
      attach && attach.attached === true,
      (attach && (attach.error || attach.detail)) || "unknown"
    )
  ) {
    return { success: false, pass, fail, results, error: "not attached" };
  }
  const build = attach.build || {};
  console.log("   build: " + build.exeVersion + " @ " + String(build.commit).slice(0, 12));
  console.log("   (probe results below are ONLY valid for this build)\n");

  // =======================================================================
  // K6 — can we refuse to break the user's in-flight edit?  HARD BLOCKER
  // Run first, before anything mutates: if a dialog is already open, every
  // probe below is unsafe, and the answer to K6 is the reason why.
  // =======================================================================
  console.log("--- K6: in-flight edit detection ---");

  const k6 = await py(`
import FreeCADGui as Gui
dlg = None
err_dlg = None
try:
    dlg = bool(Gui.Control.activeDialog())
except Exception as e:
    err_dlg = "%s: %s" % (type(e).__name__, e)
ined = None
err_ed = None
try:
    v = Gui.ActiveDocument.getInEdit() if Gui.ActiveDocument else None
    ined = None if v is None else str(getattr(v, "Object", v))
except Exception as e:
    err_ed = "%s: %s" % (type(e).__name__, e)
return {"ok": True, "activeDialog": dlg, "dialogErr": err_dlg,
        "inEdit": ined, "inEditErr": err_ed}
`);

  if (k6.__fail) {
    assert("K6: the gate primitives are callable", false, k6.__fail);
    note(
      "K6 is the hard blocker",
      "without activeDialog()/getInEdit() there is no way to refuse a mutation " +
        "while the user has a sketch open, and co-editing is not safe. Stop here."
    );
  } else {
    assert("K6: Gui.Control.activeDialog() is callable", k6.dialogErr == null, k6.dialogErr);
    assert("K6: getInEdit() is callable", k6.inEditErr == null, k6.inEditErr);
    console.log("   activeDialog=" + k6.activeDialog + "  inEdit=" + k6.inEdit);
    if (k6.activeDialog === true || k6.inEdit) {
      note(
        "a dialog or edit session is open right now",
        "close it before running the probes — the mutating probes below would " +
          "be doing exactly what K6 exists to prevent."
      );
      return { success: false, pass, fail, warn, results, error: "GUI busy" };
    }
    // The negative case is the whole point and no script can stage it: an
    // *actual* open sketch is a human action. Automating a setEdit() to fake
    // it would raise a task dialog, which §10 says never to do. The live check
    // therefore runs later, once this suite has built a sketch for you to open
    // — asking you to open one now would mean hunting for a sketch in a
    // document that does not exist yet.
    if (!interactive) {
      note(
        "K6 proven only in the idle direction",
        "the primitives answer, but no probe has seen them go true. Re-run with " +
          "--param interactive=1 and this suite will create a sketch and ask " +
          "you to open it."
      );
    }
  }

  // ---- Scratch document ----
  const setup = await py(`
import FreeCAD as App
prev = App.ActiveDocument.Name if App.ActiveDocument else None
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
doc = App.newDocument("${DOC}")
doc.UndoMode = 1
App.setActiveDocument("${DOC}")
return {"ok": True, "prev": prev, "undoMode": doc.UndoMode}
`);
  if (!assert("scratch document created", !setup.__fail, setup.__fail)) {
    return { success: false, pass, fail, warn, results, error: "no scratch doc" };
  }
  const PREV = setup.prev || "";
  assert("undo is enabled on the scratch document", setup.undoMode === 1,
    "UndoMode=" + setup.undoMode + " — K3's undo-count assertions are meaningless without it");

  // =======================================================================
  // K6 (live) — the gate must go TRUE and must REFUSE.
  //
  // Runs here, early, for two reasons. It needs an object you can actually
  // open, which is why it makes one instead of hoping your document has a
  // sketch in it. And the script runner caps a run at ~120 s, so the waiting
  // has to happen while there is still budget left rather than at the end.
  //
  // Polling beats a blocking wait: a blocking prompt spends the entire cap if
  // you step away, and detects an already-open sketch no faster.
  // =======================================================================
  if (interactive) {
    console.log("\n--- K6 (live): the gate goes true, and refuses ---");
    const mk = await py(`
import FreeCAD as App, Part
doc = App.getDocument("${DOC}")
sk = doc.addObject("Sketcher::SketchObject", "koi_gate_sketch")
sk.Label = "koi_gate_sketch"
sk.addGeometry(Part.LineSegment(App.Vector(0,0,0), App.Vector(20,0,0)), False)
doc.recompute()
return {"ok": True, "name": sk.Name}
`);
    if (mk.__fail) {
      note("K6 live check could not create a sketch to open", mk.__fail);
    } else {
      console.log("");
      console.log("   ┌───────────────────────────────────────────────────────┐");
      console.log("   │  In FreeCAD's Model tree (left panel), find            │");
      console.log("   │      KoiProbe ▸ koi_gate_sketch                        │");
      console.log("   │  and DOUBLE-CLICK it to open the sketch editor.        │");
      console.log("   │  Leave it open. Waiting up to 45 s…                    │");
      console.log("   └───────────────────────────────────────────────────────┘");
      console.log("");

      const GATE_READ = `
import FreeCAD as App, FreeCADGui as Gui
dlg = bool(Gui.Control.activeDialog())
v = Gui.ActiveDocument.getInEdit() if Gui.ActiveDocument else None
return {"ok": True, "busy": bool(dlg or v is not None), "dlg": dlg,
        "inEdit": (None if v is None else str(v))}
`;
      let live = null;
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        await tools.sleep(2500);
        const s = await py(GATE_READ);
        if (s.__fail) {
          note("K6 live poll failed", s.__fail);
          break;
        }
        if (s.busy === true) {
          live = s;
          break;
        }
      }

      if (!live) {
        note(
          "K6 live check timed out with no edit session detected",
          "if you did open the sketch, that is the blocker itself: the edit " +
            "state would be invisible to this channel and there is no safe way " +
            "to co-edit. Re-run before concluding that."
        );
      } else {
        assert("K6: an open edit session is visible from inside the exec", true);
        console.log("   activeDialog=" + live.dlg + "  inEdit=" + live.inEdit);

        // The claim §5.3 actually makes is not "we can see it" but "the
        // mutating exec refuses". So the gate and the mutation go in the SAME
        // exec, with the gate first, and the mutation is one that would be
        // visible if it slipped through.
        const guarded = await py(`
import FreeCAD as App, FreeCADGui as Gui
doc = App.getDocument("${DOC}")
dlg = bool(Gui.Control.activeDialog())
v = Gui.ActiveDocument.getInEdit() if Gui.ActiveDocument else None
if dlg or v is not None:
    return {"ok": True, "refused": True, "breach": False,
            "objects": len(doc.Objects)}
doc.addObject("Part::Box", "koi_gate_breach")
doc.recompute()
return {"ok": True, "refused": False,
        "breach": doc.getObject("koi_gate_breach") is not None,
        "objects": len(doc.Objects)}
`);
        if (guarded.__fail) {
          assert("K6: a mutating exec refuses while the user is editing", false,
            guarded.__fail);
        } else {
          assert("K6: a mutating exec refuses while the user is editing",
            guarded.refused === true, "the exec proceeded");
          assert("K6: nothing was written past the gate",
            guarded.breach === false, "koi_gate_breach was created");
        }
      }

      // Leave no edit session behind: the K3 probes below compare document
      // projections, and an open Sketcher dialog would be a live variable in
      // the middle of them. resetEdit is the same call §5.1 requires on abort.
      const clear = await py(`
import FreeCAD as App, FreeCADGui as Gui
err = None
try:
    if Gui.ActiveDocument:
        Gui.ActiveDocument.resetEdit()
except Exception as e:
    err = "resetEdit: %s" % e
try:
    if Gui.Control.activeDialog():
        Gui.Control.closeDialog()
except Exception as e:
    err = (err or "") + " closeDialog: %s" % e
doc = App.getDocument("${DOC}")
sk = doc.getObject("koi_gate_sketch")
if sk is not None:
    doc.removeObject(sk.Name)
doc.recompute()
still = bool(Gui.Control.activeDialog())
if Gui.ActiveDocument and Gui.ActiveDocument.getInEdit() is not None:
    still = True
return {"ok": True, "stillBusy": still, "err": err}
`);
      if (clear.__fail) {
        note("could not clear the edit session", clear.__fail);
      } else {
        assert("K6: resetEdit() closes the edit session from code",
          clear.stillBusy === false,
          "still busy — " + (clear.err || "no error reported"));
      }
    }
  }

  // =======================================================================
  // K1 (rest) — the channel's failure and capacity behaviour
  // =======================================================================
  console.log("\n--- K1: does the channel report failure honestly? ---");

  // Runtime exception: must arrive as a typed message, not as rc=1 and silence.
  const k1a = await raw(`
raise RuntimeError("koi-probe-boom")
`);
  const k1aMsg = (k1a && (k1a.ok === true ? JSON.stringify(k1a.result) : k1a.error)) || "";
  assert(
    "K1: a Python exception surfaces with its type and message",
    k1a && k1a.ok === true && k1a.result && k1a.result.ok === false &&
      String(k1a.result.error).indexOf("koi-probe-boom") !== -1,
    k1aMsg
  );

  // Syntax error: the wrapper cannot catch what never compiled, so this is the
  // one failure mode with no payload channel. It must still be distinguishable
  // from a hang.
  const k1b = await raw(`
this is not( python
`, 15000);
  const k1bErr = String((k1b && k1b.error) || "");
  assert(
    "K1: a syntax error fails fast and says so",
    k1b && k1b.ok === false && k1bErr.length > 0,
    JSON.stringify(k1b)
  );
  if (k1bErr.indexOf("wrote nothing") !== -1) {
    note(
      "compile-time errors have no structured payload",
      "they arrive as 'ran but wrote nothing', which is correct but coarse. " +
        "K1's fork should compile explicitly and return the SyntaxError."
    );
  }

  // Capacity: the canonical projection of a real document is tens of KB, and
  // it all has to come back through the channel every single turn. The wasm
  // build carried it through MEMFS or a tagged print because
  // freecad_run_python returns an int; the bridge returns it in the HTTP body.
  // Different mechanism, same question, and still worth asking every bump.
  const k1c = await py(`
blob = "x" * 100000
return {"ok": True, "blob": blob, "len": len(blob)}
`);
  assert(
    "K1: 100 KB round-trips through the channel intact",
    !k1c.__fail && k1c.len === 100000 && typeof k1c.blob === "string" &&
      k1c.blob.length === 100000,
    k1c.__fail || ("got " + (k1c.blob ? k1c.blob.length : "nothing"))
  );

  // =======================================================================
  // K4 — parametric propagation. If this fails the project has no reason
  // to exist, so it runs before anything is built on top of it.
  // =======================================================================
  console.log("\n--- K4: parametric propagation through the bridge ---");

  const k4a = await py(`
import FreeCAD as App, Part, Sketcher
V = App.Vector
doc = App.getDocument("${DOC}")

body = doc.addObject("PartDesign::Body", "Body")

plane = None
for o in body.Origin.OriginFeatures:
    if "XY_Plane" in o.Name:
        plane = o
if plane is None:
    return {"ok": False, "error": "no XY origin plane on the body"}

def attach(sk):
    try:
        sk.AttachmentSupport = [(plane, "")]
    except Exception:
        sk.Support = [(plane, "")]
    sk.MapMode = "FlatFace"

# --- base rectangle, fully constrained, driven by named dimensions -------
sk = doc.addObject("Sketcher::SketchObject", "sk_base")
body.addObject(sk)
attach(sk)
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
iL = sk.addConstraint(C("DistanceX", g[0],1, g[0],2, 40.0))
iW = sk.addConstraint(C("DistanceY", g[1],1, g[1],2, 30.0))
sk.renameConstraint(iL, "L")
sk.renameConstraint(iW, "W")
doc.recompute()
solved = sk.solve()
fully = bool(getattr(sk, "FullyConstrained", False))

pad = body.newObject("PartDesign::Pad", "Pad")
pad.Profile = sk
pad.Length = 10.0
sk.Visibility = False
doc.recompute()

# --- hole, on the same datum plane. Never on a face: a face reference is
# --- exactly what K5 is about, and K4 must not depend on it.
sk2 = doc.addObject("Sketcher::SketchObject", "sk_hole")
body.addObject(sk2)
attach(sk2)
c0 = sk2.addGeometry(Part.Circle(V(20,15,0), V(0,0,1), 5.0), False)
iR = sk2.addConstraint(C("Radius", c0, 5.0))
sk2.renameConstraint(iR, "R")
sk2.addConstraint(C("DistanceX", -1,1, c0,3, 20.0))
sk2.addConstraint(C("DistanceY", -1,1, c0,3, 15.0))
doc.recompute()

pocket = body.newObject("PartDesign::Pocket", "Pocket")
pocket.Profile = sk2
pocket.Type = "ThroughAll"
# A pocket cuts OPPOSITE the sketch normal by default. Both sketches sit on
# the same XY datum and the pad went +Z, so the default direction cuts into
# empty space and removes nothing — see the no-op probe below.
pocket.Reversed = True
sk2.Visibility = False
doc.recompute()

sh = body.Shape
bb = sh.BoundBox
errs = [o.Name for o in doc.Objects if not o.isValid()]
return {"ok": True,
        "solved": solved, "fullyConstrained": fully,
        "volume": sh.Volume, "faces": len(sh.Faces),
        "zLen": bb.ZLength, "xLen": bb.XLength,
        "invalid": errs}
`, 60000);

  let k4ok = false;
  if (k4a.__fail) {
    assert("K4: the feature chain builds", false, k4a.__fail);
    note(
      "K4 could not be built, so it is unanswered — not failed",
      "read the error before concluding anything about the design"
    );
  } else {
    k4ok = assert("K4: the feature chain builds", true);
    assert("K4: the base sketch solves", k4a.solved === 0, "solve() = " + k4a.solved);
    assert("K4: the base sketch is fully constrained", k4a.fullyConstrained === true,
      "DoF is not zero — §11.3's constraint assertion would fail here");
    assert("K4: every feature is valid", (k4a.invalid || []).length === 0,
      JSON.stringify(k4a.invalid));
    const expect = 40 * 30 * 10 - Math.PI * 25 * 10;
    const near = Math.abs(k4a.volume - expect) / expect < 0.001;
    assert("K4: volume matches the predicted solid (plate minus hole)", near,
      "expected ~" + expect.toFixed(1) + ", got " + Number(k4a.volume).toFixed(1));
    console.log("   volume " + Number(k4a.volume).toFixed(1) +
      "  faces " + k4a.faces + "  Z " + k4a.zLen);

    // Found by this suite failing: with the pocket pointing the wrong way it
    // removed nothing, every feature reported valid, and the shape was a plain
    // box. A feature that does nothing is indistinguishable from a feature
    // that worked, unless something measures. That is a lint requirement
    // (§6.5), so ask the platform directly rather than assuming.
    const k4noop = await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
body = doc.getObject("Body")
pocket = doc.getObject("Pocket")
before = body.Shape.Volume
pocket.Reversed = False          # now cuts into empty space
rc = doc.recompute()
after = body.Shape.Volume
state = list(pocket.State)
valid = pocket.isValid()
pocket.Reversed = True           # put it back
doc.recompute()
restored = body.Shape.Volume
return {"ok": True, "before": before, "after": after, "restored": restored,
        "removedNothing": abs(after - before) > 1.0, "state": state,
        "valid": valid, "recomputeRc": rc}
`, 60000);
    if (k4noop.__fail) {
      note("no-op feature probe did not run", k4noop.__fail);
    } else {
      const silent = k4noop.valid === true &&
        (k4noop.state || []).join(",").toLowerCase().indexOf("invalid") === -1 &&
        (k4noop.state || []).join(",").toLowerCase().indexOf("error") === -1;
      note(
        silent
          ? "a feature that removes nothing reports success"
          : "a feature that removes nothing is flagged by the platform",
        "Pocket.State=" + JSON.stringify(k4noop.state) + " valid=" + k4noop.valid +
          ". " + (silent
            ? "Nothing but a measurement catches this — lint must compare volume " +
              "before and after a subtractive feature, and a screenshot cannot."
            : "The state flag is usable as a cheap lint signal.")
      );
      assert("K4: the geometry is restored after the no-op experiment",
        Math.abs(k4noop.restored - k4a.volume) < 1.0,
        "was " + Number(k4a.volume).toFixed(1) + ", now " +
          Number(k4noop.restored).toFixed(1));
    }
  }

  if (k4ok) {
    // The actual K4 question: edit the pad and see whether the DOWNSTREAM
    // pocket follows. A direct modeler would give a 20 mm plate with a 10 mm
    // hole; only a recompute engine gives a 20 mm plate with a 20 mm hole.
    const k4b = await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
pad = doc.getObject("Pad")
body = doc.getObject("Body")
pad.Length = 20.0
doc.recompute()
sh = body.Shape
bb = sh.BoundBox
errs = [o.Name for o in doc.Objects if not o.isValid()]
return {"ok": True, "volume": sh.Volume, "zLen": bb.ZLength,
        "faces": len(sh.Faces), "invalid": errs}
`, 60000);
    if (k4b.__fail) {
      assert("K4: the pad edit applies", false, k4b.__fail);
    } else {
      assert("K4: the pad edit applies", k4b.zLen > 19.9 && k4b.zLen < 20.1,
        "ZLength = " + k4b.zLen);
      const through = 40 * 30 * 20 - Math.PI * 25 * 20; // hole followed
      const stale = 40 * 30 * 20 - Math.PI * 25 * 10; // hole did NOT follow
      const followed = Math.abs(k4b.volume - through) / through < 0.001;
      assert(
        "K4: the DOWNSTREAM pocket recomputed with the upstream change",
        followed,
        "expected ~" + through.toFixed(1) + " (hole follows), got " +
          Number(k4b.volume).toFixed(1) +
          (Math.abs(k4b.volume - stale) / stale < 0.001
            ? " — which is the stale-hole value: geometry was NOT recomputed"
            : "")
      );
      assert("K4: nothing broke in the edit", (k4b.invalid || []).length === 0,
        JSON.stringify(k4b.invalid));
    }

    // Second K4 bullet: a spreadsheet alias driving geometry through an
    // expression. This is the mechanism the whole skeleton/parameter story
    // in §8.3 rests on.
    const k4c = await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
sh = doc.addObject("Spreadsheet::Sheet", "Params")
sh.set("A1", "60")
sh.setAlias("A1", "plate_L")
doc.recompute()
sk = doc.getObject("sk_base")
sk.setExpression(".Constraints.L", "Params.plate_L")
doc.recompute()
body = doc.getObject("Body")
v60 = body.Shape.Volume
x60 = body.Shape.BoundBox.XLength
sh.set("A1", "70")
doc.recompute()
v70 = body.Shape.Volume
x70 = body.Shape.BoundBox.XLength
errs = [o.Name for o in doc.Objects if not o.isValid()]
return {"ok": True, "x60": x60, "x70": x70, "v60": v60, "v70": v70,
        "expr": sk.ExpressionEngine, "invalid": errs}
`, 60000);
    if (k4c.__fail) {
      assert("K4: a spreadsheet alias drives geometry", false, k4c.__fail);
    } else {
      assert("K4: the expression binds to the constraint",
        JSON.stringify(k4c.expr || "").indexOf("plate_L") !== -1,
        JSON.stringify(k4c.expr));
      assert("K4: the alias value reaches the geometry",
        k4c.x60 > 59.9 && k4c.x60 < 60.1, "XLength = " + k4c.x60);
      assert("K4: changing the alias propagates again",
        k4c.x70 > 69.9 && k4c.x70 < 70.1, "XLength = " + k4c.x70);
      console.log("   X 60→" + k4c.x60.toFixed(2) + ", 70→" + k4c.x70.toFixed(2));
    }
  }

  // =======================================================================
  // K5 — does a topological reference survive an edit?
  //
  // Not fatal the way K4 and K6 are. What it decides is SIZE: §14 lists the
  // fingerprint resolver as one of five new components, and how much that
  // resolver has to do is entirely this probe's answer. Three outcomes, and
  // the third is the dangerous one:
  //
  //   survives            — resolver is small, name-based references are usable
  //   breaks loudly       — resolver is bigger, but lint can see the damage
  //   resolves ELSEWHERE  — the name still works and points at different
  //                         geometry. Nothing reports anything. §8.3's
  //                         datum-anchored discipline stops being a preference.
  //
  // So the probe records WHERE the referenced edge is, not just whether the
  // reference resolves.
  // =======================================================================
  if (k4ok) {
    console.log("\n--- K5: reference survival ---");

    const k5a = await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
body = doc.getObject("Body")
base = body.Tip                      # the Pocket — a dressup must sit on the tip
sh = base.Shape

# Pick a vertical corner edge: same XY at both ends, different Z. Choosing by
# geometry rather than trusting "Edge1" means the probe is about reference
# survival, not about whether a guessed index happened to be filletable.
cands = []
for i, e in enumerate(sh.Edges, start=1):
    vs = e.Vertexes
    if len(vs) == 2:
        p, q = vs[0].Point, vs[1].Point
        if abs(p.x-q.x) < 1e-7 and abs(p.y-q.y) < 1e-7 and abs(p.z-q.z) > 1e-6:
            cands.append(i)
if not cands:
    return {"ok": False, "error": "no vertical edge to fillet"}

chosen = None
for idx in cands[:4]:
    fil = body.newObject("PartDesign::Fillet", "Fillet")
    fil.Base = (base, ["Edge%d" % idx])
    fil.Radius = 2.0
    doc.recompute()
    if fil.isValid():
        chosen = idx
        break
    doc.removeObject(fil.Name)
    doc.recompute()
if chosen is None:
    return {"ok": False, "error": "no candidate edge accepted a fillet"}

fil = doc.getObject("Fillet")
sub = fil.Base[1][0]
com = base.Shape.getElement(sub).CenterOfMass
return {"ok": True, "sub": sub, "candidates": cands,
        "mid": [com.x, com.y, com.z],
        "volume": body.Shape.Volume, "valid": fil.isValid()}
`, 60000);

    if (k5a.__fail) {
      note("K5 unanswered: no fillet could be built", k5a.__fail);
    } else {
      assert("K5: a fillet builds on a named edge", k5a.valid === true);
      console.log("   reference: " + k5a.sub + " at [" +
        k5a.mid.map((n) => n.toFixed(1)).join(", ") + "]");

      // Where the edge should be found after each edit. XY identifies WHICH
      // corner; Z moves legitimately when the plate gets taller, so it is not
      // part of the identity test.
      const RESOLVE = `
import FreeCAD as App
doc = App.getDocument("${DOC}")
fil = doc.getObject("Fillet")
if fil is None:
    return {"ok": True, "gone": True}
sub = fil.Base[1][0]
base = fil.Base[0]
mid = None
err = None
try:
    com = base.Shape.getElement(sub).CenterOfMass
    mid = [com.x, com.y, com.z]
except Exception as e:
    err = "%s: %s" % (type(e).__name__, e)
body = doc.getObject("Body")
return {"ok": True, "gone": False, "sub": sub, "mid": mid, "resolveErr": err,
        "valid": fil.isValid(), "state": list(fil.State),
        "volume": body.Shape.Volume}
`;

      // --- dimensional change: the cheap case, and the one that has to work
      const k5b = await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
doc.getObject("Pad").Length = 26.0
doc.recompute()
return {"ok": True}
`, 60000);
      const r5b = k5b.__fail ? { __fail: k5b.__fail } : await py(RESOLVE, 60000);
      if (r5b.__fail) {
        note("K5 dimensional check did not run", r5b.__fail);
      } else {
        assert("K5: the reference survives a dimensional change",
          r5b.valid === true && r5b.resolveErr == null,
          "state " + JSON.stringify(r5b.state) + " err " + r5b.resolveErr);
        const sameCorner = r5b.mid &&
          Math.abs(r5b.mid[0] - k5a.mid[0]) < 0.01 &&
          Math.abs(r5b.mid[1] - k5a.mid[1]) < 0.01;
        assert("K5: it still names the same corner after a dimensional change",
          !!sameCorner,
          "was [" + k5a.mid.slice(0,2) + "], now [" +
            (r5b.mid ? r5b.mid.slice(0,2) : "unresolved") + "]");
      }

      // --- topological change UPSTREAM of the reference: the real question.
      // A circle added to the base sketch turns the pad into a plate with an
      // extra bore, which renumbers everything downstream of it.
      const k5c = await py(`
import FreeCAD as App, Part
doc = App.getDocument("${DOC}")
sk = doc.getObject("sk_base")
gi = sk.addGeometry(Part.Circle(App.Vector(50, 8, 0), App.Vector(0,0,1), 3.0), False)
doc.recompute()
return {"ok": True, "geoIndex": gi}
`, 60000);
      if (k5c.__fail) {
        note("K5 topological check did not run", k5c.__fail);
      } else {
        const r5c = await py(RESOLVE, 60000);
        if (r5c.__fail) {
          note("K5 topological check could not be read", r5c.__fail);
        } else {
          // The assertion is about DETECTABILITY, not about survival. Whether
          // OCCT renames edges is a property of the platform, not a bug to
          // fail the build on; what would sink the design is not being able to
          // tell which of the three things happened.
          const resolved = r5c.mid != null && r5c.resolveErr == null;
          const sameCorner = resolved &&
            Math.abs(r5c.mid[0] - k5a.mid[0]) < 0.01 &&
            Math.abs(r5c.mid[1] - k5a.mid[1]) < 0.01;
          assert("K5: the outcome of a topological change is measurable",
            resolved || r5c.valid === false || r5c.resolveErr != null,
            "neither resolved nor reported broken — nothing to act on");

          if (resolved && sameCorner && r5c.valid === true) {
            note("K5: the reference SURVIVED a topological change upstream",
              "name-based references hold here, so the fingerprint resolver can " +
                "stay small. Confirm on a second shape before relying on it.");
          } else if (!resolved || r5c.valid === false) {
            note("K5: the reference BROKE LOUDLY on a topological change",
              "state " + JSON.stringify(r5c.state) + ", err " + r5c.resolveErr +
                ". Recoverable: lint sees it, and the resolver can re-derive " +
                "from the datum. This is the acceptable failure.");
          } else {
            note("K5: the reference SILENTLY MOVED — worst case",
              "same name '" + r5c.sub + "', different corner: was [" +
                k5a.mid.slice(0,2) + "], now [" + r5c.mid.slice(0,2) + "]. " +
                "Nothing flags it. §8.3's datum-anchored rule is now mandatory, " +
                "not preferred, and the resolver must fingerprint geometry " +
                "rather than trust sub-element names.");
          }
        }

        // Put the sketch back so the probes after this one see the shape they
        // were written against.
        await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
sk = doc.getObject("sk_base")
try:
    sk.delGeometry(${k5c.geoIndex})
except Exception:
    pass
doc.getObject("Pad").Length = 20.0
doc.recompute()
return {"ok": True}
`, 60000);

        // --- the decisive variant. The bore above went in at (50, 8) while
        // the reference lives at (0, 0): OCCT appends new edges, so Edge1 was
        // never in contention and "survived" only means "was not involved".
        // Cut the referenced corner itself and ask again.
        const k5d = await py(`
import FreeCAD as App, Part
doc = App.getDocument("${DOC}")
fil = doc.getObject("Fillet")
if fil is None:
    return {"ok": False, "error": "no fillet to test"}
com = fil.Base[0].Shape.getElement(fil.Base[1][0]).CenterOfMass
sk2 = doc.getObject("sk_hole")
# A bore centred on the referenced corner: this destroys and re-creates the
# geometry the name points at, which is the case toponaming is named for.
gi = sk2.addGeometry(Part.Circle(App.Vector(com.x, com.y, 0), App.Vector(0,0,1), 6.0), False)
doc.recompute()
return {"ok": True, "geoIndex": gi, "at": [com.x, com.y]}
`, 60000);
        if (k5d.__fail) {
          note("K5 corner-cut variant did not run", k5d.__fail);
        } else {
          const r5d = await py(RESOLVE, 60000);
          if (r5d.__fail) {
            note("K5 corner-cut variant could not be read", r5d.__fail);
          } else {
            const resolved = r5d.mid != null && r5d.resolveErr == null;
            const sameCorner = resolved &&
              Math.abs(r5d.mid[0] - k5a.mid[0]) < 0.01 &&
              Math.abs(r5d.mid[1] - k5a.mid[1]) < 0.01;
            assert("K5: cutting the referenced corner produces a measurable outcome",
              resolved || r5d.valid === false || r5d.resolveErr != null,
              "neither resolved nor reported broken");
            if (resolved && sameCorner && r5d.valid === true) {
              note("K5: the reference held even when its own corner was cut",
                "a strong result. Name-based references look usable on this " +
                  "build and the resolver can stay small.");
            } else if (!resolved || r5d.valid === false) {
              note("K5: the reference broke loudly when its corner was cut",
                "state " + JSON.stringify(r5d.state) + ", err " + r5d.resolveErr +
                  ". The acceptable failure: lint sees it and the resolver " +
                  "re-derives from the datum.");
            } else {
              note("K5: SILENT MOVE when the referenced corner was cut",
                "same name '" + r5d.sub + "', now at [" +
                  r5d.mid.slice(0,2).map((n) => n.toFixed(1)).join(", ") +
                  "] instead of [" +
                  k5a.mid.slice(0,2).map((n) => n.toFixed(1)).join(", ") +
                  "]. The fillet is now on different geometry and nothing " +
                  "reports it. §8.3's datum-anchored rule becomes mandatory and " +
                  "the resolver must fingerprint geometry, not trust names.");
            }
          }
          await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
try:
    doc.getObject("sk_hole").delGeometry(${k5d.geoIndex})
except Exception:
    pass
doc.recompute()
return {"ok": True}
`, 60000);
        }
      }
    }
  }

  // =======================================================================
  // K3 — the transaction envelope
  // =======================================================================
  console.log("\n--- K3: transaction envelope ---");

  // -----------------------------------------------------------------------
  // K3x — transaction INTERACTION with the GUI.
  //
  // Added because the one-undo-entry assertion passed in isolation and failed
  // straight after a real GUI edit session: delta 0, and the tail read
  // ["Delete","Sketch recompute"] — our transaction name never appeared. The
  // reading is that openTransaction() nested inside a transaction the GUI had
  // left open, so the commit popped a level instead of closing anything.
  //
  // The accounting is the small problem. §5.3's envelope calls
  // abortTransaction() on a failed edit, and if our transaction has merged
  // into the user's still-open one, that abort rolls back THEIR work. That is
  // the design's own worst case reached through the mechanism meant to prevent
  // it, so it gets probed before anything mutating is built.
  // -----------------------------------------------------------------------
  console.log("   (K3x: how transactions interact with the GUI)");

  const k3x1 = await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
docAttrs = sorted([a for a in dir(doc) if "ransact" in a.lower()])
appAttrs = sorted([a for a in dir(App) if "ransact" in a.lower()])
pending = None
for name in ("HasPendingTransaction", "hasPendingTransaction"):
    if hasattr(doc, name):
        try:
            v = getattr(doc, name)
            pending = bool(v() if callable(v) else v)
        except Exception as e:
            pending = "ERR: %s" % e
        break
active = None
if hasattr(App, "getActiveTransaction"):
    try:
        a = App.getActiveTransaction()
        active = list(a) if a is not None else "none"
    except Exception as e:
        active = "ERR: %s" % e
return {"ok": True, "docAttrs": docAttrs, "appAttrs": appAttrs,
        "pending": pending, "active": active,
        "undoCount": len(doc.UndoNames), "tail": list(doc.UndoNames)[-4:]}
`);
  if (k3x1.__fail) {
    note("K3x: could not read the transaction API surface", k3x1.__fail);
  } else {
    console.log("   Document: " + JSON.stringify(k3x1.docAttrs));
    console.log("   App:      " + JSON.stringify(k3x1.appAttrs));
    console.log("   pending=" + JSON.stringify(k3x1.pending) +
      "  active=" + JSON.stringify(k3x1.active) +
      "  undo tail=" + JSON.stringify(k3x1.tail));
    // Whether an open transaction is detectable decides whether the envelope
    // can have a precondition at all, or has to detect the merge after the
    // fact from the undo count.
    assert("K3x: a pending transaction is detectable before we open ours",
      k3x1.pending !== null || (k3x1.active != null && k3x1.active !== "null"),
      "no pending/active transaction accessor on this build — the envelope " +
        "cannot gate on entry and must fall back to the post-commit merge check");
  }

  // The safety question, and the ORDER is the whole test.
  //
  // The previous version opened and committed a transaction for the canary
  // first. That pair absorbed the leftover, so the abort ran second against
  // already-drained state and passed for the wrong reason — visible in the
  // same run as pending=true followed by "composing normally".
  //
  // So: nothing transactional happens before this. The canary is created with
  // NO transaction of ours, which means it lands inside whatever the GUI left
  // open — which is exactly what "the user's uncommitted work" is. Then the
  // first transaction we open is one we abort.
  const k3x2 = await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")

def pend():
    try:
        v = doc.HasPendingTransaction
        return bool(v() if callable(v) else v)
    except Exception:
        return None

p_start = pend()
doc.addObject("Part::Box", "koi_canary")
doc.recompute()
p_afterCanary = pend()
before = doc.getObject("koi_canary") is not None
undo0 = len(doc.UndoNames)

doc.openTransaction("koi-our-edit")
doc.addObject("Part::Box", "koi_ours")
doc.recompute()
p_inside = pend()
doc.abortTransaction()
doc.recompute()
return {"ok": True,
        "canaryBefore": before,
        "canarySurvived": doc.getObject("koi_canary") is not None,
        "oursRolledBack": doc.getObject("koi_ours") is None,
        "pendingStart": p_start, "pendingAfterCanary": p_afterCanary,
        "pendingInside": p_inside, "pendingEnd": pend(),
        "undoBefore": undo0, "undoNow": len(doc.UndoNames),
        "tail": list(doc.UndoNames)[-4:]}
`, 60000);
  if (k3x2.__fail) {
    assert("K3x: an abort destroys only our own work", false, k3x2.__fail);
  } else {
    console.log("   pending: start=" + k3x2.pendingStart +
      " afterCanary=" + k3x2.pendingAfterCanary +
      " insideOurs=" + k3x2.pendingInside +
      " end=" + k3x2.pendingEnd);
    assert("K3x: the canary existed before the abort",
      k3x2.canaryBefore === true, "the probe is void without it");
    assert("K3x: ABORT DOES NOT DESTROY THE USER'S WORK",
      k3x2.canarySurvived === true,
      "the canary was rolled back with our edit — abort reaches past our own " +
        "transaction into work we do not own, and nothing mutating can ship " +
        "until it does not");
    if (k3x2.pendingStart === true) {
      // Established: nested inside a leftover, abortTransaction() is a silent
      // no-op. It spares the user's work AND ours. That is not a safe abort,
      // it is no abort — and an envelope that reports "rolled back" while the
      // document keeps the half-finished edit is lying to the user. The
      // rollback assertion therefore moves to the App-level pair below, which
      // is the API that has to earn it.
      note(
        k3x2.oursRolledBack
          ? "K3x: doc-level abort worked even while nested"
          : "K3x: doc-level abortTransaction() is a NO-OP while nested",
        k3x2.oursRolledBack
          ? "unexpected on this build — re-check before relying on it"
          : "koi_ours survived. pending stayed " + k3x2.pendingEnd +
            " throughout, so the leftover is never consumed by an abort. " +
            "openTransaction/abortTransaction cannot carry the envelope."
      );
    } else {
      assert("K3x: abort does roll back our own edit",
        k3x2.oursRolledBack === true,
        "koi_ours survived the abort with nothing pending — the envelope's " +
          "rollback is not rolling back even in the simple case");
    }
    if (k3x2.pendingStart !== true) {
      note("K3x: no transaction was pending when the abort ran",
        "so this run tested the easy case. The condition that matters is a " +
          "leftover from a GUI edit — re-run with --param interactive=1 and " +
          "open the sketch when prompted.");
    }
  }

  // -----------------------------------------------------------------------
  // K3x2b — the App-level pair against the REAL leftover.
  //
  // This has to run here, immediately, because k3x2 leaves the GUI's leftover
  // intact (pending stayed true through its abort) and everything after this
  // point drains it. The simulated leftover in k3x5 is NOT a substitute: a
  // second openTransaction() closes the first rather than nesting, so the
  // simulation reproduces the pending flag without reproducing the behaviour.
  // The real thing exists exactly once per run, right here.
  // -----------------------------------------------------------------------
  if (k3x2 && !k3x2.__fail && k3x2.pendingEnd === true) {
    const k3x2b = await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")

def pend():
    try:
        v = doc.HasPendingTransaction
        return bool(v() if callable(v) else v)
    except Exception:
        return None

p0 = pend()
doc.addObject("Part::Box", "koi_canary2")
doc.recompute()
before = doc.getObject("koi_canary2") is not None

if not hasattr(App, "setActiveTransaction"):
    return {"ok": True, "available": False, "pendingStart": p0}

App.setActiveTransaction("koi-app-abort")
doc.addObject("Part::Box", "koi_appours")
doc.recompute()
try:
    App.closeActiveTransaction(True)
except TypeError:
    App.closeActiveTransaction()
doc.recompute()
return {"ok": True, "available": True,
        "pendingStart": p0, "pendingEnd": pend(),
        "canaryBefore": before,
        "canarySurvived": doc.getObject("koi_canary2") is not None,
        "oursRolledBack": doc.getObject("koi_appours") is None,
        "tail": list(doc.UndoNames)[-3:]}
`, 60000);
    if (k3x2b.__fail) {
      note("K3x: App-level abort against the real leftover did not run", k3x2b.__fail);
    } else if (k3x2b.available === false) {
      note("K3x: no App-level API to test against the real leftover", "");
    } else {
      console.log("   App-level vs REAL leftover: rolledBack=" + k3x2b.oursRolledBack +
        " canary=" + k3x2b.canarySurvived + " pending " + k3x2b.pendingStart +
        "→" + k3x2b.pendingEnd);
      assert("K3x: App-level abort does not destroy the user's work",
        k3x2b.canarySurvived === true,
        "koi_canary2 was rolled back — this pair reaches into work we do not own");
      assert("K3x: App-level abort ROLLS BACK OUR OWN WORK inside a real GUI leftover",
        k3x2b.oursRolledBack === true,
        "koi_appours survived. Neither pair aborts under a real leftover, so " +
          "dryRun cannot be mutate-then-abort and every edit needs a checkpoint " +
          "and restore instead");
    }
  } else {
    note("K3x: no real leftover was available to test the App-level abort against",
      "run with --param interactive=1 and open the sketch — the simulated " +
        "leftover in K3x5 does not reproduce the nesting behaviour");
  }

  // -----------------------------------------------------------------------
  // K3x-nest — does openTransaction() actually nest?
  //
  // The last run answered this by accident: inside a SIMULATED leftover the
  // doc-level abort rolled back cleanly and left pending=false, while inside a
  // REAL GUI leftover the same call was a no-op and pending stayed true. Both
  // cannot be nesting. The likely explanation is that a second
  // openTransaction() closes the first, so the simulation never nested at all
  // — and if that is right it matters far beyond the probe: opening our own
  // transaction would silently COMMIT whatever the user has in flight.
  // Non-destructive, but it must be a decision rather than a surprise.
  // -----------------------------------------------------------------------
  const k3xn = await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")

def pend():
    try:
        v = doc.HasPendingTransaction
        return bool(v() if callable(v) else v)
    except Exception:
        return None

n = 0
while pend() and n < 8:
    doc.commitTransaction()
    n += 1

doc.openTransaction("koi-nest-outer")
doc.addObject("Part::Box", "koi_n1")
doc.recompute()
u0 = len(doc.UndoNames)

doc.openTransaction("koi-nest-inner")
u1 = len(doc.UndoNames)
doc.addObject("Part::Box", "koi_n2")
doc.recompute()
doc.abortTransaction()
doc.recompute()

out = {"ok": True, "drained": n,
       "undoAfterOuterWork": u0, "undoAfterInnerOpen": u1,
       "outerWorkSurvived": doc.getObject("koi_n1") is not None,
       "innerWorkRolledBack": doc.getObject("koi_n2") is None,
       "pendingEnd": pend(), "tail": list(doc.UndoNames)[-3:]}
for nm in ("koi_n1", "koi_n2"):
    o = doc.getObject(nm)
    if o is not None:
        doc.removeObject(nm)
doc.recompute()
# BOUNDED. commitTransaction() does not always clear the pending flag — that
# is the finding this very probe exists to chase — so a bare "while pend()" can
# spin forever. Nothing on the far side can interrupt a running snippet, and
# this one runs on the thread that owns the document: an unbounded loop here
# holds the GUI thread and the user watches their window stop responding until
# it returns. Recoverable now, where it used to be terminal, and still not
# something to inflict. Every loop sent through this channel gets a bound.
m = 0
while pend() and m < 8:
    doc.commitTransaction()
    m += 1
out["finalDrain"] = m
out["finalPending"] = pend()
return out
`, 60000);
  if (k3xn.__fail) {
    note("K3x: nesting-semantics probe did not run", k3xn.__fail);
  } else {
    const closedTheFirst =
      k3xn.undoAfterInnerOpen > k3xn.undoAfterOuterWork &&
      k3xn.outerWorkSurvived === true;
    console.log("   nesting: undo " + k3xn.undoAfterOuterWork + "→" +
      k3xn.undoAfterInnerOpen + " on inner open, outerSurvived=" +
      k3xn.outerWorkSurvived + " innerRolledBack=" + k3xn.innerWorkRolledBack);
    assert("K3x: the nesting behaviour of openTransaction is determined",
      closedTheFirst || k3xn.innerWorkRolledBack != null,
      JSON.stringify(k3xn));
    if (closedTheFirst) {
      note("K3x: openTransaction() CLOSES the previous transaction, it does not nest",
        "so opening ours seals the user's in-flight work into its own undo " +
          "entry. That is the seal behaviour from K3x5 happening implicitly — " +
          "the envelope should do it deliberately after checking " +
          "HasPendingTransaction, not as a side effect.");
    } else {
      note("K3x: openTransaction() appears to nest",
        "which contradicts the simulated-leftover result — investigate before " +
          "the envelope relies on either.");
    }
  }

  // Two transaction APIs exist; only one is GUI-aware. If the App-level pair
  // composes where the Document-level pair merges, the envelope changes one
  // line instead of growing a nesting-depth tracker.
  const k3x3 = await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
if not hasattr(App, "setActiveTransaction"):
    return {"ok": True, "available": False}
before = len(doc.UndoNames)
App.setActiveTransaction("koi-active-tx")
for n in ("koi_at1", "koi_at2", "koi_at3"):
    doc.addObject("Part::Box", n)
doc.recompute()
try:
    App.closeActiveTransaction(False)
except TypeError:
    App.closeActiveTransaction()
after = len(doc.UndoNames)
return {"ok": True, "available": True, "before": before, "after": after,
        "delta": after - before, "tail": list(doc.UndoNames)[-3:]}
`, 60000);
  if (k3x3.__fail) {
    note("K3x: setActiveTransaction comparison did not run", k3x3.__fail);
  } else if (k3x3.available === false) {
    note("K3x: no App-level transaction API on this build",
      "the Document-level pair is the only option, so the envelope has to " +
        "handle nesting itself");
  } else {
    // Also demoted: this returned delta 1 in one run and delta 0 in the next
    // with nothing changed but what ran before it. The API's abort behaviour
    // is what earned it the envelope; its bookkeeping is not measurable here.
    note("K3x: setActiveTransaction booked " + k3x3.delta + " undo entrie(s)",
      "tail " + JSON.stringify(k3x3.tail) + ". Reported only — see K3u for the " +
        "assertion that replaced this one.");
  }

  // -----------------------------------------------------------------------
  // K3x5 — WHICH API can carry the envelope?
  //
  // The leftover is simulated here with an openTransaction() that is never
  // closed, so this no longer needs a human to open a sketch: the failing
  // condition becomes reproducible in --full-auto, which is the difference
  // between a finding and a regression test.
  //
  // Both pairs are put through the same sequence, and the one that matters is
  // ABORT — k3x3 only ever tested commit, so "setActiveTransaction collapses
  // three mutations into one entry" says nothing about rollback, which is what
  // §5.3's envelope and the whole dryRun story actually rest on.
  // -----------------------------------------------------------------------
  const k3x5 = await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")

def pend():
    try:
        v = doc.HasPendingTransaction
        return bool(v() if callable(v) else v)
    except Exception:
        return None

def drain(limit=8):
    n = 0
    while pend() and n < limit:
        try:
            App.closeActiveTransaction(False)
        except Exception:
            pass
        doc.commitTransaction()
        n += 1
    return n

def clear(*names):
    for n in names:
        o = doc.getObject(n)
        if o is not None:
            doc.removeObject(n)
    doc.recompute()

pre = drain()
clean = pend()

out = {"ok": True, "drainCalls": pre, "cleanAfterDrain": clean}

# --- simulate the GUI's leftover: opened, never closed, with work inside it
doc.openTransaction("koi-sim-user")
doc.addObject("Part::Box", "koi_sim_canary")
doc.recompute()
out["simPending"] = pend()

# --- Case A: the Document-level pair, nested inside the leftover
doc.openTransaction("koi-caseA")
doc.addObject("Part::Box", "koi_A")
doc.recompute()
doc.abortTransaction()
doc.recompute()
out["A_oursRolledBack"] = doc.getObject("koi_A") is None
out["A_canarySurvived"] = doc.getObject("koi_sim_canary") is not None
out["A_pending"] = pend()

# --- Case B: the App-level pair, same nesting, abort=True
if hasattr(App, "setActiveTransaction"):
    App.setActiveTransaction("koi-caseB")
    doc.addObject("Part::Box", "koi_B")
    doc.recompute()
    try:
        App.closeActiveTransaction(True)
    except TypeError:
        App.closeActiveTransaction()
    doc.recompute()
    out["B_available"] = True
    out["B_oursRolledBack"] = doc.getObject("koi_B") is None
    out["B_canarySurvived"] = doc.getObject("koi_sim_canary") is not None
    out["B_pending"] = pend()
else:
    out["B_available"] = False

# --- Case C: can the leftover be SEALED without destroying it? Committing the
# user's open transaction turns their work into an undo entry they still own,
# which is non-destructive and leaves us composing normally afterwards.
sealed = drain()
out["sealCalls"] = sealed
out["C_pendingAfterSeal"] = pend()
out["C_canarySurvived"] = doc.getObject("koi_sim_canary") is not None

# --- and does a normal transaction behave once sealed?
b = len(doc.UndoNames)
doc.openTransaction("koi-post-seal")
doc.addObject("Part::Box", "koi_postseal")
doc.recompute()
doc.commitTransaction()
out["C_deltaAfterSeal"] = len(doc.UndoNames) - b

clear("koi_A", "koi_B", "koi_postseal", "koi_sim_canary")
drain()
return out
`, 60000);

  if (k3x5.__fail) {
    assert("K3x5: an envelope API can be chosen", false, k3x5.__fail);
  } else {
    assert("K3x5: a leftover transaction can be simulated",
      k3x5.simPending === true,
      "an unclosed openTransaction did not register as pending — the " +
        "simulation is not even reproducing the flag");
    // Fidelity check. The real leftover made doc-level abort a no-op; if the
    // simulated one does not, the simulation reproduces the flag and not the
    // behaviour, and must not be sold as the regression test.
    if (k3x5.A_oursRolledBack === true) {
      note("K3x5: the simulation is NOT equivalent to a real GUI leftover",
        "doc-level abort rolled back here but no-ops inside the real one. A " +
          "second openTransaction() closes the first instead of nesting, so " +
          "this cannot replace --param interactive=1 for the transaction " +
          "probes. Treat K3x5 as an API survey, not as a regression test.");
    }
    console.log("   Case A (doc-level) : rolledBack=" + k3x5.A_oursRolledBack +
      " canary=" + k3x5.A_canarySurvived + " pending=" + k3x5.A_pending);
    if (k3x5.B_available) {
      console.log("   Case B (App-level) : rolledBack=" + k3x5.B_oursRolledBack +
        " canary=" + k3x5.B_canarySurvived + " pending=" + k3x5.B_pending);
    }

    // Neither API may harm the canary. This is the non-negotiable one.
    assert("K3x5: no abort path destroys the simulated user's work",
      k3x5.A_canarySurvived === true &&
        (!k3x5.B_available || k3x5.B_canarySurvived === true),
      "A=" + k3x5.A_canarySurvived + " B=" + k3x5.B_canarySurvived);

    if (!k3x5.B_available) {
      note("K3x5: no App-level transaction API on this build",
        "with doc-level abort a no-op while nested, the envelope has to seal " +
          "the leftover first (Case C) and cannot rely on rollback at all");
    } else if (k3x5.B_oursRolledBack === true && k3x5.A_oursRolledBack !== true) {
      assert("K3x5: the App-level pair aborts correctly where the doc-level pair no-ops",
        true);
      note("K3x5: the envelope should use setActiveTransaction/closeActiveTransaction",
        "it is the only pair that rolls back our own work while the GUI has a " +
          "transaction open, which is the normal condition in co-editing");
    } else if (k3x5.B_oursRolledBack === true) {
      note("K3x5: both pairs abort correctly here",
        "prefer the App-level pair anyway — it is the one the GUI itself drives");
    } else {
      // The bad branch: nothing rolls back while nested.
      assert("K3x5: some API rolls back our own work while nested", false,
        "neither pair aborts under nesting. dryRun cannot be implemented as " +
          "mutate-then-abort, and the envelope must checkpoint before every " +
          "edit and restore instead");
    }

    // Sealing is the fallback strategy, and it is also the entry gate: if
    // HasPendingTransaction is true, close it into the user's own undo entry
    // before starting, rather than nesting inside it.
    assert("K3x5: a leftover transaction can be sealed non-destructively",
      k3x5.C_pendingAfterSeal === false && k3x5.C_canarySurvived === true,
      "pending=" + k3x5.C_pendingAfterSeal + " canary=" + k3x5.C_canarySurvived);
    assert("K3x5: transactions compose normally once the leftover is sealed",
      k3x5.C_deltaAfterSeal === 1,
      "delta " + k3x5.C_deltaAfterSeal + " after sealing in " +
        k3x5.sealCalls + " calls");
  }

  // If the envelope can recover from a merged state, it can self-heal instead
  // of refusing. Worth knowing which.
  const k3x4 = await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")

def probe_delta(tag):
    b = len(doc.UndoNames)
    doc.openTransaction("koi-delta-%s" % tag)
    doc.addObject("Part::Box", "koi_dp_%s" % tag)
    doc.recompute()
    doc.commitTransaction()
    return len(doc.UndoNames) - b

first = probe_delta("a")
drained = 0
d = first
while d == 0 and drained < 6:
    doc.commitTransaction()
    drained += 1
    d = probe_delta("d%d" % drained)
return {"ok": True, "first": first, "afterDrain": d, "drainCalls": drained}
`, 60000);
  if (k3x4.__fail) {
    note("K3x: drain/recovery probe did not run", k3x4.__fail);
  } else if (k3x4.first === 1) {
    note("K3x: transactions are composing normally in this run",
      "no merged state to recover from — re-run with --param interactive=1 and " +
        "open a sketch first to reproduce the failing condition");
  } else {
    assert("K3x: a merged transaction state can be drained and recovered",
      k3x4.afterDrain === 1,
      "still merged after " + k3x4.drainCalls + " commit calls — the envelope " +
        "would have to refuse rather than self-heal");
    console.log("   recovered after " + k3x4.drainCalls + " commitTransaction() calls");
  }

  // -----------------------------------------------------------------------
  // K3u — the promise, not the proxy.
  //
  // Three runs have now disagreed about undo-entry counts using identical
  // calls: setActiveTransaction returned delta 1 once and delta 0 later, with
  // only the preceding history different, and getBookedTransactionID in the
  // API surface says identity is booked lazily and shared. Counting entries
  // from outside is not a reliable instrument, so it stops being an assertion.
  //
  // §5.3 promises "one edit, one undo entry" — but what the user experiences
  // is "one Ctrl+Z puts it back". That is testable in exactly those terms and
  // does not care how many entries FreeCAD booked internally.
  // -----------------------------------------------------------------------
  const k3u = await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")

def proj(d):
    rows = []
    for o in d.Objects:
        vals = []
        for p in sorted(o.PropertiesList):
            try:
                v = o.getPropertyByName(p)
            except Exception:
                continue
            if isinstance(v, (int, float, bool, str)):
                vals.append("%s=%s" % (p, v))
        rows.append("%s|%s|%s" % (o.Name, o.TypeId, ";".join(vals)))
    return "\\n".join(sorted(rows))

before = proj(doc)
h0 = len(doc.UndoNames)

# One edit through the envelope the probes selected: the App-level pair.
App.setActiveTransaction("koi-undo-test")
b1 = doc.addObject("Part::Box", "koi_u1")
b1.Length = 11.0
b2 = doc.addObject("Part::Box", "koi_u2")
b2.Length = 12.0
pad = doc.getObject("Pad")
if pad is not None:
    pad.Length = 33.0
doc.recompute()
try:
    App.closeActiveTransaction(False)
except TypeError:
    App.closeActiveTransaction()
doc.recompute()

mid = proj(doc)
h1 = len(doc.UndoNames)

doc.undo()
doc.recompute()
after = proj(doc)
undos = 1
while after != before and undos < 5:
    doc.undo()
    doc.recompute()
    after = proj(doc)
    undos += 1

return {"ok": True,
        "editChangedIt": mid != before,
        "restored": after == before,
        "undosNeeded": undos if after == before else None,
        "entriesBooked": h1 - h0,
        "leftovers": [n for n in ("koi_u1", "koi_u2")
                      if doc.getObject(n) is not None]}
`, 60000);

  if (k3u.__fail) {
    assert("K3: one undo restores the pre-edit state", false, k3u.__fail);
  } else {
    assert("K3: the edit actually changed the document",
      k3u.editChangedIt === true,
      "the projection did not move — there is nothing to undo and the probe is void");
    assert("K3: undo restores the pre-edit projection exactly",
      k3u.restored === true,
      "still different after 5 undos; leftovers " + JSON.stringify(k3u.leftovers));
    if (k3u.restored === true) {
      assert("K3: ONE undo is enough",
        k3u.undosNeeded === 1,
        "took " + k3u.undosNeeded + " undo presses. Correct but not the promise " +
          "in §5.3 — the envelope must report this rather than claim single-step " +
          "undo it cannot guarantee.");
    }
    // Reported, never asserted. This is the number the last three runs proved
    // unreliable; it is useful as a hint in a tool result and nothing more.
    note("K3: entries booked by one envelope edit = " + k3u.entriesBooked,
      "recorded, not asserted. koi_cad.py should measure this around each edit " +
        "and say 'this may take more than one undo' when it is not 1, instead of " +
        "promising a granularity the platform does not consistently give.");
  }

  const k3a = await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
before = len(doc.UndoNames)
doc.openTransaction("koi-probe-batch")
b1 = doc.addObject("Part::Box", "koi_t1")
b2 = doc.addObject("Part::Box", "koi_t2")
b1.Length = 5
b2.Length = 7
doc.recompute()
doc.commitTransaction()
after = len(doc.UndoNames)
return {"ok": True, "before": before, "after": after,
        "delta": after - before, "tail": doc.UndoNames[-2:]}
`);
  if (k3a.__fail) {
    note("K3: doc-level entry count not read", k3a.__fail);
  } else {
    // Demoted from an assertion. Same call, same document, delta 1 in one run
    // and delta 0 in the next — the variable is preceding history, not this
    // code. K3u above tests what this was standing in for.
    note("K3: doc-level openTransaction booked " + k3a.delta + " undo entrie(s)",
      "tail " + JSON.stringify(k3a.tail) + ". Reported only — entry counts are " +
        "not a stable signal from outside.");
  }

  const k3b = await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")

def proj(d):
    rows = []
    for o in d.Objects:
        rows.append("%s|%s|%s" % (o.Name, o.TypeId, o.Label))
    return "\\n".join(sorted(rows))

before = proj(doc)
doc.openTransaction("koi-probe-abort")
ghost = doc.addObject("Part::Box", "koi_ghost")
ghost.Length = 123
doc.recompute()
mid = proj(doc)
doc.abortTransaction()
reset_err = None
try:
    import FreeCADGui as Gui
    if Gui.ActiveDocument:
        Gui.ActiveDocument.resetEdit()
except Exception as e:
    reset_err = "%s: %s" % (type(e).__name__, e)
doc.recompute()
after = proj(doc)
return {"ok": True,
        "mutationWasReal": "koi_ghost" in mid,
        "identical": before == after,
        "ghostSurvived": "koi_ghost" in after,
        "resetErr": reset_err}
`);
  if (k3b.__fail) {
    assert("K3: abort restores the document exactly", false, k3b.__fail);
  } else {
    // Both halves matter: an abort that "works" because the mutation never
    // landed proves nothing at all.
    assert("K3: the mutation was really applied before the abort",
      k3b.mutationWasReal === true, "nothing to roll back — the probe is void");
    assert("K3: abort restores the projection exactly", k3b.identical === true,
      "ghost survived: " + k3b.ghostSurvived);
    assert("K3: resetEdit() is callable alongside the abort", k3b.resetErr == null,
      k3b.resetErr);
  }

  // Checkpoint: §5.5 wants FCStd bytes out of the sandbox and into extension
  // storage. Probe the two halves that can fail: the save, and reading the
  // bytes back out through the FS.
  const k3c = await py(`
import FreeCAD as App, os, base64, time
doc = App.getDocument("${DOC}")
p = "/tmp/koi_ck.FCStd"
t0 = time.time()
doc.saveAs(p)
t_save = time.time() - t0
sz = os.path.getsize(p)
t0 = time.time()
with open(p, "rb") as f:
    head = f.read(4)
    f.seek(0)
    b64 = base64.b64encode(f.read()).decode("ascii")
t_read = time.time() - t0
return {"ok": True, "bytes": sz, "zip": head[:2] == b"PK",
        "b64len": len(b64), "saveMs": int(t_save*1000), "readMs": int(t_read*1000)}
`, 60000);
  if (k3c.__fail) {
    assert("K3: a checkpoint can be written and read back", false, k3c.__fail);
    note("checkpoints may not be able to leave the sandbox",
      "§5.5's recovery story depends on this; if saveAs works but the read does " +
        "not, the checkpoint has to move some other way");
  } else {
    assert("K3: saveAs produces a real FCStd (zip magic)", k3c.zip === true);
    assert("K3: the bytes can be read back out for extension-side storage",
      k3c.b64len > 0, "b64 length " + k3c.b64len);
    console.log("   checkpoint " + k3c.bytes + " bytes, save " + k3c.saveMs +
      "ms, read+b64 " + k3c.readMs + "ms");
    timings.checkpointSaveMs = k3c.saveMs;
    timings.checkpointReadMs = k3c.readMs;
    note("checkpoint RESTORE is not probed here",
      "restore reloads the document and discards the user's undo history, so it " +
        "is a deliberate destructive step — probe it on its own");
  }

  // =======================================================================
  // K2 — is it fast enough to feel alive?
  // Measured, not asserted: there is no agreed budget yet, and inventing one
  // here would turn a measurement into an arbitrary failure.
  // =======================================================================
  console.log("\n--- K2: interaction budget ---");

  const k2 = await py(`
import FreeCAD as App, Part, time
doc = App.getDocument("${DOC}")

t0 = time.time()
i = 0
while len(doc.Objects) < 40:
    b = doc.addObject("Part::Box", "koi_bulk%d" % i)
    b.Length = 10 + i
    i += 1
doc.recompute()
t_build = time.time() - t0

# Proto-projection: every object, every property. This is the shape of the
# work sync() does on the UI thread every turn, without the canonicalising.
t0 = time.time()
n = 0
for o in doc.Objects:
    for p in o.PropertiesList:
        try:
            o.getPropertyByName(p)
            n += 1
        except Exception:
            pass
t_walk = time.time() - t0

t0 = time.time()
a = Part.makeTorus(30, 10)
b = Part.makeTorus(30, 10)
b.Placement.Base = App.Vector(8, 0, 0)
c = a.cut(b)
vol = c.Volume
t_bool = time.time() - t0

return {"ok": True, "objects": len(doc.Objects), "props": n,
        "buildMs": int(t_build*1000), "walkMs": int(t_walk*1000),
        "boolMs": int(t_bool*1000), "boolVol": vol}
`, 120000);
  if (k2.__fail) {
    note("K2 not measured", k2.__fail);
  } else {
    timings.walkMs = k2.walkMs;
    timings.boolMs = k2.boolMs;
    console.log("   " + k2.objects + " objects, " + k2.props + " properties");
    console.log("   full property walk : " + k2.walkMs + " ms");
    console.log("   heavy boolean      : " + k2.boolMs + " ms");
    console.log("   bulk build         : " + k2.buildMs + " ms");
    // 1500 ms is the design's own framing of "feels alive" for a mandatory
    // per-turn operation. Stated as a note so the number can be argued with
    // rather than silently enforced.
    if (k2.walkMs > 1500) {
      note("a full walk exceeds 1.5 s on a 40-object document",
        k2.walkMs + " ms — §4.2's incremental projection is not optional, it is " +
          "the only thing that makes sync() viable");
    } else {
      assert("K2: a full walk of 40 objects is under 1.5 s", true);
      // 40 objects at native speed says almost nothing. It is far below the
      // knee of any curve this could have, so a fast result here is not
      // evidence the full walk scales — only that it is not already broken.
      // The honest reading is "not yet a problem at a size that was never
      // going to be one".
      note("a full walk is affordable at this size, which is a weak claim",
        k2.walkMs + " ms across " + k2.objects + " objects / " + k2.props +
          " properties. Too small to locate the knee: measure at ~400 objects " +
          "before writing any number into SKILL.md. Incremental projection is " +
          "still the design, and the full walk stays useful as this harness's " +
          "correctness oracle");
    }
    if (k2.boolMs > 3000) {
      note("a single heavy boolean blows the interaction budget",
        k2.boolMs + " ms with the viewport unresponsive. §11.1: if a heavy " +
          "boolean alone does this, the ceiling drops below a subassembly and " +
          "the product changes");
    } else {
      note("the heavy boolean is inside the budget on this machine",
        k2.boolMs + " ms. Recorded, not generalised: this is one boolean on " +
          "one host, and the ceiling belongs to the slowest machine the skill " +
          "runs on, not this one");
    }
  }

  // =======================================================================
  // K4 (destructive tail) — deleting an upstream feature must be LOUD.
  // Runs last because it wrecks the document on purpose.
  // =======================================================================
  console.log("\n--- K4: a broken upstream must not fail silently ---");

  const k4d = await py(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
sk = doc.getObject("sk_base")
removed = False
err = None
if sk is not None:
    try:
        doc.removeObject(sk.Name)
        removed = True
    except Exception as e:
        err = "%s: %s" % (type(e).__name__, e)
doc.recompute()
rows = []
for o in doc.Objects:
    rows.append({"name": o.Name, "state": list(o.State), "valid": o.isValid()})
pad = doc.getObject("Pad")
return {"ok": True, "removed": removed, "removeErr": err,
        "padState": (list(pad.State) if pad else None),
        "padValid": (pad.isValid() if pad else None),
        "objects": rows[:8]}
`, 60000);
  if (k4d.__fail) {
    note("upstream-deletion probe did not run", k4d.__fail);
  } else if (!k4d.removed) {
    note("the upstream sketch could not be removed", k4d.removeErr ||
      "FreeCAD refused the delete — which is itself a safe outcome");
  } else {
    const loud =
      k4d.padValid === false ||
      (Array.isArray(k4d.padState) &&
        k4d.padState.join(",").toLowerCase().indexOf("invalid") !== -1) ||
      (Array.isArray(k4d.padState) &&
        k4d.padState.join(",").toLowerCase().indexOf("error") !== -1) ||
      (Array.isArray(k4d.padState) &&
        k4d.padState.join(",").toLowerCase().indexOf("touched") !== -1);
    assert(
      "K4: deleting an upstream sketch makes the downstream feature report it",
      loud,
      "Pad.State=" + JSON.stringify(k4d.padState) + " valid=" + k4d.padValid +
        " — a silent success here means the lint has nothing to read"
    );
    console.log("   Pad.State = " + JSON.stringify(k4d.padState) +
      "  isValid = " + k4d.padValid);
  }

  // ---- Teardown ----
  console.log("\n--- teardown ---");
  const down = await py(`
import FreeCAD as App
closed = False
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
    closed = True
prev = "${PREV}"
restored = None
if prev and prev in App.listDocuments():
    App.setActiveDocument(prev)
    restored = prev
return {"ok": True, "closed": closed, "restored": restored,
        "open": list(App.listDocuments().keys())}
`);
  assert("scratch document closed without saving into the user's work",
    !down.__fail && down.closed === true, down.__fail || "not closed");
  if (!down.__fail) {
    console.log("   documents still open: " + JSON.stringify(down.open));
    if (PREV && down.restored !== PREV) {
      note("the previously active document was not restored",
        "was '" + PREV + "', now " + JSON.stringify(down.open));
    }
  }

  console.log("\n=== probes: " + pass + " passed, " + fail + " failed, " +
    warn + " notes ===");
  console.log("Valid ONLY for build " + build.exeVersion + " @ " +
    String(build.commit).slice(0, 12) + ". Re-run on any bump.");

  return {
    success: fail === 0,
    pass,
    fail,
    warn,
    results,
    build: { version: build.exeVersion, commit: build.commit, branch: build.branch },
    timings,
    interactive,
  };
}

return run().catch((e) => {
  if (e instanceof TransportLost) {
    // Not a probe result. The bridge stopped answering, which means either a
    // snippet is still running on the thread that owns the document, or that
    // FreeCAD is gone.
    const msg =
      "TRANSPORT LOST — the FreeCAD bridge stopped answering after " + pass +
      " passed / " + fail + " failed.\n\n" +
      "This is not a FreeCAD result and the probes after it did not run. The " +
      "usual cause is a snippet that never returned: nothing here can " +
      "interrupt work inside the geometry kernel, so calls are refused until " +
      "it finishes.\n\n" +
      "Recover: wait for it (check http://127.0.0.1:8765/hello — `running` " +
      "says what is on the thread), and if FreeCAD itself died, restart it " +
      "with the macro and re-run. The document is on disk either way.\n\n" +
      "Everything reported above this line already happened and stands.\n\n" +
      "detail: " + e.message;
    console.error(msg);
    results.push("❌ transport lost — run aborted");
    return {
      success: false,
      pass,
      fail,
      warn,
      results,
      transportLost: true,
      error: msg,
    };
  }
  throw e;
});
