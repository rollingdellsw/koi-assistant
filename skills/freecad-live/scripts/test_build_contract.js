// scripts/test_build_contract.js — the coupling surface, and nothing else.
//
// Run this FIRST after a build bump. Every other suite in this directory tests
// what the skill does; this one tests the handful of things the skill assumes
// about FreeCAD-web itself. That distinction is the whole point: a bump that
// breaks something here is a platform change and needs a code fix, while a
// bump that passes here and fails elsewhere is our bug and needs a code read.
// Without the split, every bump costs a full 290-assertion run and a log
// investigation to answer a question this file answers in about two minutes.
//
// The seven couplings, each with the failure it is standing in for:
//
//   C1 transport   a bridge answers, speaks our protocol, and is inside a
//                  FreeCAD that identifies itself. This is the layer that
//                  answers "is anything there" without needing the
//                  interpreter.
//   C2 exec        Python runs, and runs on the thread that owns the document.
//                  This is the single point everything else rides on — and the
//                  thread half is not a detail: FreeCAD's Python is not
//                  thread-safe, so a job on the HTTP worker corrupts state and
//                  crashes somewhere unrelated.
//   C3 payload     a payload survives the round trip at size, and an exception
//                  arrives typed. Structured output is the whole channel.
//   C4 identity    version and commit come out of the RUNNING interpreter and
//                  agree with the manifest, and two reads agree with each
//                  other. A field that wobbles is not identity, it is a false
//                  userDiff every turn.
//   C5 transaction setActiveTransaction / closeActiveTransaction(True) still
//                  rolls back, and the pending flag still behaves. This is the
//                  semantics that moved once already (§5.1).
//   C6 properties  the spellings the ops write through: AttachmentSupport vs
//                  Support, PartDesign::Hole's DepthType, Threaded. Half a
//                  spec silently lost is the §6.3 failure.
//   C7 toponaming  getElementHistory answers, or the fingerprint resolver is
//                  running on adjacency alone and §8.1's guarantees weaken.
//
// The pin is checked, not assumed: a green run here is a claim about one
// build, and the last line says which.

const results = [];
let pass = 0;
let fail = 0;
let warn = 0;

class TransportLost extends Error {}

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

async function probe(python, timeoutMs) {
  const r = guard(parseResult(
    await tools.freecad_exec({ python, timeoutMs: timeoutMs || 30000 })));
  if (!r || r.ok !== true) return { __fail: (r && r.error) || "exec failed" };
  const d = r.result || {};
  if (d.ok === false) return { __fail: d.error || "returned ok:false" };
  return d;
}

const DOC = "BuildContract";

// What a failure here means, printed next to it. A bump report that says
// "C5 failed" and nothing else sends the reader back into the design doc.
const IMPLICATION = {
  C1: "no FreeCAD bridge is answering, or it speaks a protocol this skill " +
      "does not. koi_bridge.py and freecad_mcp.js ship together",
  C2: "there is no way to run Python in this process, or it is being run on " +
      "the wrong thread. Nothing else in the skill is safe until this holds",
  C3: "structured output has no path back, so every tool above this one is " +
      "blind to what it just did",
  C4: "identity is unreadable or unstable, so the pin cannot mean anything " +
      "and neither can any probe result tied to it",
  C5: "the transaction envelope's rollback contract does not hold on this " +
      "build. dry run, abort-on-error and the co-editing story all rest on it",
  C6: "a property this build spells differently is being written to and " +
      "dropped. Expect ops that report success and change nothing (§6.3)",
  C7: "the element map is unavailable, so the fingerprint resolver falls back " +
      "to invariants and adjacency. References get weaker, not wrong (§8.1)",
};

function couple(id, label, condition, detail) {
  const ok = assert(id + ": " + label, condition, detail);
  if (!ok) console.error("   → " + IMPLICATION[id]);
  return ok;
}

async function run() {
  console.log("=== Build Contract — the platform assumptions, only ===");
  console.log("Run this first after the FreeCAD install changes.\n");

  // ---- C1: the bridge answers, with no interpreter call required ---------
  console.log("--- C1 transport ---");
  const pre = guard(parseResult(await tools.freecad_version({
    layers: ["deploy", "transport"], refresh: true,
  })));
  const transport = (pre && pre.transport) || {};
  const deploy = (pre && pre.deploy) || {};
  if (!couple("C1", "a FreeCAD bridge is answering", transport.available === true,
      JSON.stringify(transport).slice(0, 200))) {
    return { success: false, pass, fail, warn, results,
             error: "no bridge — start FreeCAD with tools/koi_bridge.py" };
  }
  couple("C1", "it speaks the protocol this skill was built against",
    !!(pre.protocol && pre.protocol.ok),
    JSON.stringify(pre.protocol));
  couple("C1", "the install carries a fingerprint",
    !!(deploy.fingerprint || transport.fingerprint),
    "the bridge could not stat the FreeCAD binary");
  if (!transport.gui) {
    note("this FreeCAD is headless",
      "C5's GUI-owned-transaction case and everything about selection are " +
      "untestable here; run the suite against a GUI FreeCAD before pinning");
  }

  // ---- attach: needed for everything below -------------------------------
  const attach = guard(parseResult(await tools.freecad_attach({ timeoutMs: 120000 })));
  if (!assert("attached", attach && attach.attached === true,
      (attach && (attach.error || attach.detail)) || "unknown")) {
    const p = attach && attach.pin;
    if (p && p.pinned && p.match === false) {
      console.error("   → the pin refused this build: " + JSON.stringify(p.drift));
      console.error("   → that is the correct behaviour. Re-run this suite " +
        "with pin-mode: warn, fix what it reports, then re-pin.");
    }
    return { success: false, pass, fail, warn, results, error: "could not attach" };
  }
  couple("C2", "the attach names the process it is inside",
    typeof attach.pid === "number" && attach.pid > 0,
    JSON.stringify(attach).slice(0, 200));

  // ---- C2 / C3: the exec channel and the payload -------------------------
  console.log("\n--- C2 exec, C3 payload ---");
  const echo = await probe(`
return {"ok": True, "echo": 42}
`);
  couple("C2", "a snippet runs and returns a dict",
    !echo.__fail && echo.echo === 42, echo.__fail);

  // The thread rule, asserted rather than assumed. The bridge claims to
  // marshal onto the GUI thread; this is the snippet's own view of where it
  // woke up, and the two have to agree or the claim is decoration.
  const where = await probe(`
import threading, os
t = threading.current_thread()
return {"ok": True, "thread": t.name,
        "isMain": t is threading.main_thread(), "pid": os.getpid()}
`);
  couple("C2", "the snippet runs in the same process the bridge reported",
    !where.__fail && where.pid === attach.pid,
    JSON.stringify({ snippet: where.pid, bridge: attach.pid }));
  if (attach.gui) {
    couple("C2", "and on the main (document-owning) thread, not an HTTP worker",
      !where.__fail && where.isMain === true,
      "ran on thread '" + where.thread + "'");
  }

  // Size matters here and only here: the channel worked at 40 bytes in every
  // build so far and it is the 100 KB case that has ever been in doubt.
  const big = await probe(`
return {"ok": True, "blob": "x" * 100000}
`, 60000);
  couple("C3", "a 100 KB payload survives the round trip intact",
    !big.__fail && typeof big.blob === "string" && big.blob.length === 100000,
    big.__fail || ("length " + (big.blob || "").length));

  const chan = await probe(`
import sys
mods = {"FreeCAD": "FreeCAD" in sys.modules}
try:
    import FreeCADGui
    mods["Gui"] = True
except Exception:
    mods["Gui"] = False
return {"ok": True, "mods": mods, "py": sys.version.split()[0]}
`);
  couple("C3", "FreeCAD is importable",
    !chan.__fail && chan.mods && chan.mods.FreeCAD,
    JSON.stringify(chan.mods || chan.__fail));
  if (attach.gui) {
    couple("C3", "FreeCADGui is importable",
      !chan.__fail && chan.mods && chan.mods.Gui,
      JSON.stringify(chan.mods || chan.__fail));
  }

  // An exception must arrive typed rather than as the number 1.
  const boom = guard(parseResult(await tools.freecad_exec({
    python: "raise ValueError('deliberate')",
  })));
  const boomText = JSON.stringify(boom || {});
  couple("C3", "an exception comes back typed, not as a return code",
    boomText.indexOf("ValueError") !== -1 && boomText.indexOf("deliberate") !== -1,
    boomText.slice(0, 200));

  // ---- C4: identity, twice ------------------------------------------------
  console.log("\n--- C4 identity ---");
  const v1 = guard(parseResult(await tools.freecad_version({ refresh: true })));
  const v2 = guard(parseResult(await tools.freecad_version({ refresh: true })));
  const r1 = (v1 && (v1.runtime || v1.build)) || {};
  const r2 = (v2 && (v2.runtime || v2.build)) || {};
  couple("C4", "version comes out of the running interpreter", !!r1.exeVersion,
    JSON.stringify(r1).slice(0, 200));
  couple("C4", "two reads of the same process agree",
    r1.exeVersion === r2.exeVersion && r1.commit === r2.commit,
    JSON.stringify({ first: r1, second: r2 }).slice(0, 300));
  if (!r1.commit) {
    note("this build reports no BuildRevisionHash",
      "the commit layer of the pin is unavailable; pin-fingerprint carries " +
      "the weight on its own");
  }
  const manifestVersion = (deploy.app || {}).version;
  if (manifestVersion && r1.exeVersion) {
    couple("C4", "the manifest agrees with the running interpreter",
      String(manifestVersion).indexOf(String(r1.exeVersion)) !== -1 ||
      String(r1.exeVersion).indexOf(String(manifestVersion)) !== -1,
      "manifest " + manifestVersion + " vs runtime " + r1.exeVersion);
  }

  const pin = (v1 && v1.pin) || {};
  if (!pin.pinned) {
    note("this deploy is not pinned",
      "K0 is built and switched off. Paste the pinBlock from " +
      "freecad_version() into SKILL.md and set pin-mode: strict");
  } else {
    assert("the running build matches the pin", pin.match === true,
      JSON.stringify(pin.drift || pin));
    if (pin.unverifiable && pin.unverifiable.length) {
      note("pinned fields that could not be read: " + pin.unverifiable.join(", "),
        "an unverifiable field is an absence, not a match");
    }
  }

  // ---- scratch document ---------------------------------------------------
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
    return { success: false, pass, fail, warn, results, error: "no scratch doc" };
  }

  // ---- C5: the transaction pair ------------------------------------------
  console.log("\n--- C5 transactions ---");
  const tx = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
has_pair = (hasattr(App, "setActiveTransaction") and
            hasattr(App, "closeActiveTransaction"))
before = len(doc.Objects)
App.setActiveTransaction("contract-abort")
b = doc.addObject("Part::Box", "AbortMe")
b.Length, b.Width, b.Height = 5, 5, 5
doc.recompute()
during = len(doc.Objects)
App.closeActiveTransaction(True)
doc.recompute()
after = len(doc.Objects)
pending = None
try:
    pending = bool(doc.HasPendingTransaction)
except Exception:
    pass
return {"ok": True, "hasPair": has_pair, "before": before,
        "during": during, "after": after, "pending": pending,
        "survivor": doc.getObject("AbortMe") is not None}
`, 60000);
  couple("C5", "the App-level transaction pair exists",
    !tx.__fail && tx.hasPair === true, tx.__fail || JSON.stringify(tx));
  couple("C5", "an object is created inside the transaction",
    !tx.__fail && tx.during === tx.before + 1, JSON.stringify(tx));
  couple("C5", "closeActiveTransaction(True) rolls it back",
    !tx.__fail && tx.after === tx.before && tx.survivor === false,
    JSON.stringify(tx));
  if (!tx.__fail && tx.pending === true) {
    note("HasPendingTransaction is still set after a close",
      "seal() drains rather than trusting it; this is the measured behaviour " +
      "on the pinned build, not a new failure");
  }

  // The abort-overreach finding (§5.4) is build behaviour, so it belongs
  // here: an abort must not resurrect what the user deleted before it.
  const over = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
victim = doc.addObject("Part::Box", "UserDeleted")
doc.recompute()
doc.removeObject("UserDeleted")
doc.recompute()
gone_before = doc.getObject("UserDeleted") is None
names_before = set(o.Name for o in doc.Objects)
App.setActiveTransaction("contract-overreach")
t = doc.addObject("Part::Box", "Temp")
doc.recompute()
App.closeActiveTransaction(True)
doc.recompute()
names_after = set(o.Name for o in doc.Objects)
return {"ok": True, "goneBefore": gone_before,
        "resurrected": sorted(names_after - names_before)}
`, 60000);
  if (!over.__fail && (over.resurrected || []).length) {
    note("this build's abort reaches past its own transaction: it re-created " +
      (over.resurrected || []).join(", "),
      "known on the pinned build; envelope() repairs it (abortRepaired) and " +
      "reports what it could not (abortOverreach). If this note DISAPPEARS " +
      "on a bump the upstream bug is fixed and _repair_abort becomes dead " +
      "code worth removing");
  } else if (!over.__fail) {
    note("this probe did not reproduce the abort overreach of §5.4",
      "NOT evidence the platform bug is gone: this deletes outside a " +
      "transaction, and §5.4 measured it under conditions this probe does " +
      "not recreate. _repair_abort stays. test_koi_cad.js is the suite that " +
      "actually exercises it");
  }

  // ---- C6: property spellings the ops write through ----------------------
  console.log("\n--- C6 property spellings ---");
  const props = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
out = {}
body = doc.addObject("PartDesign::Body", "ContractBody")
sk = doc.addObject("Sketcher::SketchObject", "ContractSketch")
body.addObject(sk)
out["attachProps"] = [p for p in ("AttachmentSupport", "Support")
                      if p in sk.PropertiesList]
out["hasMapMode"] = "MapMode" in sk.PropertiesList
out["hasAttachmentOffset"] = "AttachmentOffset" in sk.PropertiesList
h = body.newObject("PartDesign::Hole", "ContractHole")
out["holeProps"] = [p for p in ("Diameter", "DepthType", "Depth", "Threaded",
                                "ThreadSize", "HoleCutType", "Profile")
                    if p in h.PropertiesList]
# ASK the enumeration; do not try to set it.
#
# Twice now, setting DepthType on a Hole raised for a reason that has nothing
# to do with the property: "No object linked" on a Hole with no Profile, then
# "No base set, sketch support is not Part::Feature" once it had one -- a Hole
# validates that it has solid material to cut on every property write, so
# configuring one takes a body, a base solid, and a sketch on a face of it.
# That is three more things this probe would have to build correctly, each of
# which can fail for its own reasons and each of which would be reported as a
# renamed property.
#
# The coupling C6 actually cares about is narrower: does the property exist
# and does its enumeration still carry the value the ops write. Both answer
# on an unconfigured object, so ask.
try:
    enums = [str(x) for x in h.getEnumerationsOfProperty("DepthType")]
    out["depthTypeEnums"] = enums
    out["depthTypeTakes"] = "ThroughAll" in enums
except Exception as e:
    # No getEnumerationsOfProperty on this build: fall back to the write, and
    # accept a validation complaint as a pass -- the property took the value
    # and then the feature objected to its own state.
    try:
        h.DepthType = "ThroughAll"
        out["depthTypeTakes"] = str(h.DepthType) == "ThroughAll"
    except Exception as e2:
        msg = str(e2)
        out["depthTypeTakes"] = ("No base set" in msg or "No object linked" in msg)
        out["depthTypeNote"] = "%s: %s" % (type(e2).__name__, msg)
try:
    h.Threaded = True
    out["threadedTakes"] = bool(h.Threaded) is True
except Exception as e:
    out["threadedTakes"] = "%s: %s" % (type(e).__name__, e)
# Which property a Transformed feature uses for the features it repeats.
# Both spellings have shipped. Getting this wrong does not raise: the pattern
# builds, reports valid, and its Shape raises on every later access — which
# reads as a CAD failure about overlapping instances and is not one. It cost
# test_ops2.js a dozen assertions across two builds before it was asked here,
# where the answer is one line.
pat = {}
try:
    pp = doc.addObject("PartDesign::PolarPattern", "ContractPat")
    props = list(pp.PropertiesList)
    pat["originals"] = [x for x in ("Transformed", "Originals") if x in props]
    pat["hasTransformMode"] = "TransformMode" in props
    if pat["hasTransformMode"]:
        pat["transformModes"] = [
            str(x) for x in pp.getEnumerationsOfProperty("TransformMode")]
    pat["hasOccurrences"] = "Occurrences" in props
    pat["hasAngle"] = "Angle" in props
    pat["hasMode"] = "Mode" in props
    if pat["hasMode"]:
        pat["modes"] = [str(x) for x in pp.getEnumerationsOfProperty("Mode")]
    doc.removeObject(pp.Name)
except Exception as e:
    pat["error"] = "%s: %s" % (type(e).__name__, e)
out["pattern"] = pat
# The types every op in the whitelist instantiates. A rename here is the one
# breakage that would actually be a refactor.
types_ok = {}
for tid in ("PartDesign::Pad", "PartDesign::Pocket", "PartDesign::Plane",
            "PartDesign::Fillet", "PartDesign::Chamfer",
            "PartDesign::Revolution", "PartDesign::Groove",
            "PartDesign::Thickness", "Part::Cut", "Part::Fuse",
            "Part::Common", "Part::Mirroring", "App::Link",
            "Spreadsheet::Sheet"):
    try:
        o = doc.addObject(tid, "T")
        types_ok[tid] = o is not None
        doc.removeObject(o.Name)
    except Exception:
        types_ok[tid] = False
out["types"] = types_ok
out["ok"] = True
return out
`, 90000);
  couple("C6", "a sketch exposes AttachmentSupport or Support",
    !props.__fail && (props.attachProps || []).length > 0,
    props.__fail || JSON.stringify(props.attachProps));
  couple("C6", "MapMode and AttachmentOffset both exist",
    !props.__fail && props.hasMapMode && props.hasAttachmentOffset,
    JSON.stringify(props).slice(0, 200));
  couple("C6", "PartDesign::Hole still offers DepthType ThroughAll",
    !props.__fail && props.depthTypeTakes === true,
    JSON.stringify({ takes: props.depthTypeTakes,
                     enums: props.depthTypeEnums,
                     note: props.depthTypeNote }));
  couple("C6", "PartDesign::Hole accepts Threaded",
    !props.__fail && props.threadedTakes === true,
    JSON.stringify(props.threadedTakes));
  const pat = (props && props.pattern) || {};
  couple("C6", "a Transformed feature names its originals in a spelling we know",
    !props.__fail && (pat.originals || []).length > 0,
    JSON.stringify(pat));
  couple("C6", "PartDesign::PolarPattern still has Occurrences and Angle",
    !props.__fail && pat.hasOccurrences === true && pat.hasAngle === true,
    JSON.stringify(pat));
  if ((pat.originals || []).length) {
    console.log("   pattern originals: " + pat.originals.join(", ") +
      "   Mode: " + JSON.stringify(pat.modes || null) +
      "   TransformMode: " + JSON.stringify(pat.transformModes || null));
  }
  if (pat.hasTransformMode) {
    note("this build's Transformed features have TransformMode",
      JSON.stringify(pat.transformModes) + " — koi_cad leaves it at the " +
      "default and reports it. If a pattern repeats the wrong thing, this is " +
      "the property to look at first");
  }

  const missingTypes = Object.keys((props.types) || {})
    .filter((k) => !props.types[k]);
  couple("C6", "every type the whitelist instantiates exists",
    !props.__fail && missingTypes.length === 0,
    "missing: " + missingTypes.join(", "));
  if (!props.__fail && (props.holeProps || []).indexOf("ThreadSize") === -1) {
    note("PartDesign::Hole has no ThreadSize on this build",
      "_set_if reports it rather than raising; thread specs record Threaded " +
      "only. Same as the pinned build");
  }

  // ---- C7: the element map ------------------------------------------------
  console.log("\n--- C7 toponaming ---");
  const topo = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
box = doc.addObject("Part::Box", "ContractBox")
box.Length, box.Width, box.Height = 10, 10, 10
doc.recompute()
out = {"ok": True, "hasHistory": hasattr(box, "getElementHistory"),
       "faces": len(box.Shape.Faces)}
if out["hasHistory"]:
    try:
        h = box.getElementHistory("Face1")
        out["historyAnswers"] = h is not None
        out["historyShape"] = str(type(h).__name__)
    except Exception as e:
        out["historyAnswers"] = False
        out["historyError"] = "%s: %s" % (type(e).__name__, e)
try:
    m = box.Shape.ElementMapSize
    out["elementMapSize"] = int(m)
except Exception:
    out["elementMapSize"] = None
return out
`, 60000);
  couple("C7", "a box reports six faces",
    !topo.__fail && topo.faces === 6, JSON.stringify(topo).slice(0, 200));
  if (!topo.__fail && topo.hasHistory && topo.historyAnswers) {
    assert("C7: getElementHistory answers", true);
  } else {
    note("getElementHistory is unavailable or refuses on this build",
      "the fingerprint resolver falls back to invariants and adjacency. " +
      "That is the pinned build's behaviour too — resolve() is written for " +
      "it — but re-run test_resolve.js before trusting any reference");
  }

  // ---- the two whitelists still agree ------------------------------------
  console.log("\n--- dispatcher integrity ---");
  const ids = guard(parseResult(await tools.freecad_call({ fn: "ids" })));
  assert("koi_cad bootstraps and its op table matches OP_SPECS",
    !!(ids && ids.ok !== false && !ids.error),
    JSON.stringify(ids || {}).slice(0, 240));

  console.log("\n--- Cleaning up ---");
  try {
    await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
return {"ok": True}
`);
  } catch (e) {
    note("cleanup failed", e.message);
  }

  const build = r1;
  console.log("\n" + pass + " passed, " + fail + " failed, " + warn + " warnings.");
  console.log("Valid for build " + (build.exeVersion || "?") +
    " @ " + (build.commit || "?"));
  if (fail === 0) {
    console.log(
      "\nThe platform assumptions hold. If another suite now fails, it is our " +
      "bug and not the bump's.");
  } else {
    console.log(
      "\nA coupling broke. Fix these before running any other suite — every " +
      "failure downstream of one of these is derived and proves nothing.");
  }

  return { success: fail === 0, pass, fail, warn, results, build };
}

return run().catch((e) => {
  console.error(e);
  const label = e instanceof TransportLost
    ? "transport lost — the rest of this run proves nothing: " + e.message
    : e.message;
  results.push("❌ " + label);
  return { success: false, pass, fail, warn, results, error: label };
});
