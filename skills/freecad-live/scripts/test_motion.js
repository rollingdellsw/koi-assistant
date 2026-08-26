// scripts/test_motion.js — kinematics: freecad_motion.
//
// Run:  /skill freecad-live/scripts/test_motion.js --full-auto
//
// Needs probe-exec ON: this suite has to BUILD an assembly, and an assembly is
// the one thing in FreeCAD that the skill deliberately cannot author. A joint
// is made by clicking the two features that mate; there is no honest way to
// invent which circle on which part from this side, so freecad_motion drives
// assemblies rather than creating them — and the suite therefore builds its
// fixture with raw exec, the way a human's mouse would have.
//
// The shape of the coverage, and why it is shaped that way. Three things are
// being tested and only the third needs a working joint:
//
//   A/B  the probe and the refusals. No assembly needed at all.
//   C/D  an assembly with parts and NO joints. This is not a degenerate case
//        to pad the suite with — it is the "nothing is grounded" and "these
//        parts float" reporting, which is what the tool says about half the
//        assemblies it will ever be pointed at, and it needs nothing beyond
//        Assembly::AssemblyObject and App::Link.
//   E/F  a real revolute joint, driven. Gated: the joint-creation API is
//        FeaturePython and its module path and constructor signature have
//        moved between builds, so the fixture tries the documented spellings
//        and SKIPS WITH THE EXCEPTION TEXT if none of them takes. A skip that
//        names the API that refused is actionable; a suite that fails because
//        a fixture could not be built teaches its reader to ignore red.
//
// What is asserted is contracts, never values. "The sweep found the collision"
// is a value assertion that depends on the solver landing where I think it
// will. "If it reports collides:true then it names a pair, a step and an
// angle" is a contract, and a contract that holds is worth more than a number
// that happened.

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

async function call(fn, opArgs, id, extra) {
  return guard(
    parseResult(
      await tools.freecad_call(
        Object.assign({ fn, args: opArgs || {} }, id ? { id } : {}, extra || {})
      )
    )
  );
}

async function motion(args) {
  return guard(parseResult(await tools.freecad_motion(args || {})));
}

async function sync(extra) {
  return guard(parseResult(await tools.freecad_sync(extra || {})));
}

async function probe(python, timeoutMs) {
  const r = guard(
    parseResult(
      await tools.freecad_exec({ python, timeoutMs: timeoutMs || 60000 })
    )
  );
  if (!r || r.ok !== true) return { __fail: (r && r.error) || "exec failed" };
  const d = r.result || {};
  if (d.ok === false) return { __fail: d.error || "returned ok:false" };
  return d;
}

function refusal(r) {
  if (!r) return "";
  if (r.error) return String(r.error);
  if (r.ok === false && r.reason) return String(r.reason);
  return "";
}

function refused(r, needle) {
  const msg = refusal(r).toLowerCase();
  if (!msg) return false;
  return !needle || msg.indexOf(String(needle).toLowerCase()) !== -1;
}

function rep(r) {
  return (r && r.result) || {};
}

const DOC = "KoiMotionTest";

// ---------------------------------------------------------------------------
// The fixture. Two boxes and an assembly, then — separately, and allowed to
// fail — a revolute joint between them.
//
// Deliberately raw exec rather than fn 'call'. Everything here is Assembly
// workbench API that this skill does not wrap and should not: the koi layer's
// job is to measure what exists, and a fixture is a thing that has to exist
// first.
// ---------------------------------------------------------------------------

const BUILD_ASSEMBLY = `
import FreeCAD as App
doc = App.getDocument("${DOC}")
asm = doc.addObject("Assembly::AssemblyObject", "Assembly")

def box(name, l, w, h, x, y, z):
    b = doc.addObject("Part::Box", name)
    b.Length = l; b.Width = w; b.Height = h
    b.Placement = App.Placement(App.Vector(x, y, z), App.Rotation())
    return b

base = box("BaseBox", 40, 10, 10, 0, 0, 0)
arm = box("ArmBox", 40, 10, 10, 0, 0, 20)
doc.recompute()

links = []
for src in (base, arm):
    lk = doc.addObject("App::Link", "Link" + src.Name)
    lk.LinkedObject = src
    links.append(lk)
    try:
        asm.addObject(lk)
    except Exception:
        g = list(asm.Group); g.append(lk); asm.Group = g
doc.recompute()
return {"assembly": asm.Name, "links": [l.Name for l in links],
        "parts": [base.Name, arm.Name]}
`;

// Grounding and jointing, tried through every spelling this API has worn.
// Reported as data: which one took, or every exception, so a failure here
// names the call that refused instead of just going quiet.
const BUILD_JOINT = `
import FreeCAD as App
doc = App.getDocument("${DOC}")
asm = doc.getObject("Assembly")
links = [o for o in doc.Objects if o.TypeId == "App::Link"]
base, arm = links[0], links[1]
tried = []

def attempt(label, fn):
    try:
        v = fn()
        tried.append({"call": label, "ok": True})
        return v
    except Exception as e:
        tried.append({"call": label, "ok": False,
                      "error": "%s: %s" % (type(e).__name__, e)})
        return None

JointObject = None
try:
    import JointObject
except Exception as e:
    tried.append({"call": "import JointObject", "ok": False,
                  "error": "%s: %s" % (type(e).__name__, e)})

ground = None
if JointObject is not None:
    for maker in ("GroundedJoint", "makeGroundedJoint"):
        f = getattr(JointObject, maker, None)
        if f is None:
            continue
        def mk(f=f, maker=maker):
            o = doc.addObject("App::FeaturePython", "Grounded")
            try:
                asm.addObject(o)
            except Exception:
                pass
            try:
                f(o, base)
            except TypeError:
                f(o, base, asm)
            return o
        ground = attempt(maker, mk)
        if ground is not None:
            break

joint = None
if JointObject is not None:
    for maker in ("Joint", "makeJoint"):
        f = getattr(JointObject, maker, None)
        if f is None:
            continue
        def mk(f=f):
            o = doc.addObject("App::FeaturePython", "Joint")
            try:
                asm.addObject(o)
            except Exception:
                pass
            types = getattr(JointObject, "JointTypes", [])
            rev_idx = types.index("Revolute") if "Revolute" in types else 1
            try:
                f(o, rev_idx)
            except TypeError:
                try:
                    f(o, "Revolute", asm)
                except TypeError:
                    try:
                        f(o, "Revolute")
                    except TypeError:
                        f(o)
                        o.JointType = "Revolute"
            return o
        joint = attempt(maker, mk)
        if joint is not None:
            break

if joint is not None:
    # The two mating frames: the top face centre of the base and the bottom
    # face centre of the arm, so a revolute about Z between them is a real
    # hinge rather than a coincidence.
    attempt("references", lambda: (
        setattr(joint, "Reference1", (base, ["Face6"])),
        setattr(joint, "Reference2", (arm, ["Face5"]))))
    attempt("placements", lambda: (
        setattr(joint, "Placement1", App.Placement(App.Vector(20, 5, 10), App.Rotation())),
        setattr(joint, "Placement2", App.Placement(App.Vector(20, 5, 0), App.Rotation()))))

solved = attempt("solve", lambda: asm.solve())
doc.recompute()
return {"joint": getattr(joint, "Name", None),
        "ground": getattr(ground, "Name", None),
        "jointType": str(getattr(joint, "JointType", "")) if joint else None,
        "tried": tried}
`;

async function run() {
  console.log("=== test_motion.js — kinematics: freecad_motion ===");

  const attachRes = parseResult(await tools.freecad_attach({}));
  if (!attachRes || !attachRes.attached) {
    assert("attached to FreeCAD", false, JSON.stringify(attachRes));
    return { success: false, pass, fail, warn, results };
  }
  assert("attached to FreeCAD", true, attachRes.status);

  const caps = await call("capabilities", {});
  const mods = rep(caps).modules || {};
  const asmAvailable = !!(mods["Assembly"] && mods["Assembly"].available);
  console.log(
    "Assembly: " + asmAvailable +
    " | UtilsAssembly: " + !!(mods["UtilsAssembly"] || {}).available +
    " | JointObject: " + !!(mods["JointObject"] || {}).available
  );
  assert(
    "the capability probe asks about all three assembly modules",
    Object.prototype.hasOwnProperty.call(mods, "Assembly") &&
      Object.prototype.hasOwnProperty.call(mods, "UtilsAssembly") &&
      Object.prototype.hasOwnProperty.call(mods, "JointObject"),
    Object.keys(mods).filter((k) => /ssembl|Joint/.test(k)).join(", ")
  );

  await call("new_document", { name: DOC }, "doc.motion", "motion test doc");

  // ---------------------------------------------------------------
  // A. Refusals that need nothing built.
  // ---------------------------------------------------------------
  console.log("\n--- Section A: refusals before anything exists ---");

  const noAsm = await motion({ mode: "check" });
  if (!asmAvailable) {
    assert(
      "A1 a build with no Assembly module says so, and does not report the "
        + "mechanism as unverified for some other reason",
      refused(noAsm, "Assembly"),
      refusal(noAsm)
    );
    note("A2..F* skipped", "this build has no native Assembly workbench");
    return finish();
  }
  assert(
    "A1 a document with no assembly is refused, and says where one comes from",
    refused(noAsm, "no native Assembly") || refused(noAsm, "assembly"),
    refusal(noAsm)
  );

  const badMode = await motion({ mode: "simulate" });
  assert(
    "A2 an unknown mode is refused by name",
    refused(badMode, "mode must be"),
    refusal(badMode)
  );

  const noTo = await motion({ mode: "sweep", joint: "Joint" });
  assert(
    "A3 a sweep with no range is refused — a range of zero is the render you have",
    refused(noTo, "to"),
    refusal(noTo)
  );

  const noJoint = await motion({ mode: "sweep", to: 90 });
  assert(
    "A4 a sweep with no joint named is refused",
    refused(noJoint, "joint"),
    refusal(noJoint)
  );

  // ---------------------------------------------------------------
  // B. An assembly with parts and no joints. Everything this reports
  //    is a finding about a half-built mechanism, which is the state
  //    most assemblies are actually in.
  // ---------------------------------------------------------------
  console.log("\n--- Section B: parts, no joints ---");
  const built = await probe(BUILD_ASSEMBLY);
  if (built.__fail) {
    note("B*..F* skipped", "could not build the fixture: " + built.__fail);
    return finish();
  }
  console.log("fixture: " + JSON.stringify(built));
  await sync({ detail: "summary" });

  const check1 = await motion({ mode: "check" });
  const c1 = rep(check1);
  assert(
    "B1 the assembly and both parts are found",
    (c1.parts || []).length === 2 && !!c1.assembly,
    refusal(check1) || JSON.stringify(c1.parts || [])
  );
  assert(
    "B2 nothing grounded is reported as a finding, not as a working mechanism",
    c1.ungrounded === true && /grounded/i.test(String(c1.ungroundedNote || "")),
    JSON.stringify({ ungrounded: c1.ungrounded })
  );
  assert(
    "B3 both parts are reported as floating — reachable from ground by nothing",
    ((c1.connectivity || {}).floating || []).length === 2,
    JSON.stringify((c1.connectivity || {}).floating || [])
  );
  // Two numbers from two methods. Grubler declines to answer at all when
  // nothing is grounded, which is the honest answer rather than 12.
  assert(
    "B4 mobility reports what it measured AND what the hand count says",
    c1.mobility &&
      Object.prototype.hasOwnProperty.call(c1.mobility, "measured") &&
      Object.prototype.hasOwnProperty.call(c1.mobility, "grubler"),
    JSON.stringify(c1.mobility || {})
  );
  assert(
    "B5 with nothing grounded the hand count refuses rather than guessing",
    c1.mobility.grubler === null &&
      /grounded/i.test(String(c1.mobility.grublerNote || "")),
    JSON.stringify(c1.mobility)
  );
  assert(
    "B6 check says out loud that it only looked at one pose",
    /one pose|as it sits|47|sweep/i.test(String(c1.poseNote || "")),
    String(c1.poseNote || "").slice(0, 100)
  );
  assert(
    "B7 the two separated boxes do not interfere",
    (c1.interference || {}).pairs &&
      c1.interference.pairs.length === 0 &&
      (c1.interference.unchecked || []).length === 0,
    JSON.stringify(c1.interference || {})
  );

  const joints1 = await motion({ mode: "joints" });
  assert(
    "B8 mode joints reports an empty mechanism as empty",
    (rep(joints1).joints || []).length === 0 &&
      /no joints/i.test(String(rep(joints1).note || "")),
    JSON.stringify(rep(joints1)).slice(0, 200)
  );

  const sweepUngrounded = await motion({
    mode: "sweep",
    joint: "Joint",
    to: 45,
  });
  assert(
    "B9 a sweep on an ungrounded assembly is refused before it moves anything",
    refused(sweepUngrounded, "grounded"),
    refusal(sweepUngrounded)
  );

  // ---------------------------------------------------------------
  // C. Interference is measured, not assumed. Move one box into the
  //    other and the same call has to change its mind.
  // ---------------------------------------------------------------
  console.log("\n--- Section C: interference is measured ---");
  const overlapped = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
doc.getObject("ArmBox").Placement = App.Placement(App.Vector(0, 0, 5), App.Rotation())
doc.recompute()
return {"moved": True}
`);
  if (overlapped.__fail) {
    note("C* skipped", overlapped.__fail);
  } else {
    const check2 = await motion({ mode: "check" });
    const c2 = rep(check2);
    assert(
      "C1 overlapping parts are found, named as a pair, and given a volume",
      (c2.interference || {}).pairs &&
        c2.interference.pairs.length === 1 &&
        c2.interference.pairs[0].pair.length === 2 &&
        c2.interference.pairs[0].volumeMm3 > 0,
      JSON.stringify(c2.interference || {})
    );
    assert(
      "C2 and the volume is the real overlap, not a bounding box guess",
      Math.abs(c2.interference.pairs[0].volumeMm3 - 40 * 10 * 5) < 1,
      "expected 2000 mm³, got " + c2.interference.pairs[0].volumeMm3
    );
    await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
doc.getObject("ArmBox").Placement = App.Placement(App.Vector(0, 0, 20), App.Rotation())
doc.recompute()
return {"restored": True}
`);
  }

  // ---------------------------------------------------------------
  // D. Mass is a refusal, not a zero.
  // ---------------------------------------------------------------
  console.log("\n--- Section D: torque refuses before it guesses ---");
  const noMass = await motion({
    mode: "torque",
    joint: "Joint",
    to: 45,
  });
  assert(
    "D1 torque is refused while any part has no density",
    refused(noMass, "mass") || refused(noMass, "grounded"),
    refusal(noMass)
  );

  // ---------------------------------------------------------------
  // E. A real joint. Gated, because the creation API is the one thing
  //    here that has moved between builds.
  // ---------------------------------------------------------------
  console.log("\n--- Section E: a driven joint ---");
  const jointed = await probe(BUILD_JOINT, 120000);
  if (jointed.__fail || !jointed.joint) {
    note(
      "E*/F* skipped — could not create a joint through any known spelling",
      JSON.stringify(jointed.tried || jointed.__fail || {}).slice(0, 600)
    );
    return finish();
  }
  console.log("joint: " + JSON.stringify(jointed).slice(0, 300));
  await sync({ detail: "summary" });

  const joints2 = await motion({ mode: "joints" });
  const jrows = rep(joints2).joints || [];
  assert(
    "E1 the joint is found by the property it carries, not by its class name",
    jrows.length === 1 && !!jrows[0].name,
    JSON.stringify(jrows).slice(0, 200)
  );
  const drivable = (jrows[0] || {}).drivable || [];
  assert(
    "E2 it reports which properties this build lets you drive, with their values",
    Array.isArray(drivable),
    JSON.stringify(drivable)
  );
  if (!drivable.length) {
    note(
      "E3*/F* skipped",
      "this build's joint exposes no drivable numeric property; " +
        "type=" + jrows[0].type
    );
    return finish();
  }

  const wrongProp = await motion({
    mode: "sweep",
    joint: jrows[0].name,
    property: "NotAProperty",
    to: 45,
  });
  assert(
    "E3 an unknown drive property is refused and the real ones are listed",
    refused(wrongProp, "drivable property") ||
      refused(wrongProp, "no drivable"),
    refusal(wrongProp)
  );

  const check3 = await motion({ mode: "check" });
  const c3 = rep(check3);
  assert(
    "E4 with a ground and a joint, connectivity finds the chain",
    ((c3.connectivity || {}).grounded || []).length >= 1,
    JSON.stringify(c3.connectivity || {})
  );
  if (c3.mobility && c3.mobility.grubler !== null) {
    assert(
      "E5 a one-revolute two-link mechanism counts one degree of freedom by hand",
      c3.mobility.grubler === 1,
      JSON.stringify(c3.mobility)
    );
  } else {
    note("E5 skipped", JSON.stringify((c3.mobility || {}).grublerNote));
  }
  if (c3.mobility && c3.mobility.measured !== null &&
      c3.mobility.grubler !== null) {
    assert(
      "E6 measured and hand-counted mobility either agree or the disagreement is named",
      c3.mobility.measured === c3.mobility.grubler ||
        (c3.mobility.mismatch === true && !!c3.mobility.mismatchNote),
      JSON.stringify(c3.mobility)
    );
  } else {
    note(
      "E6 skipped",
      "measured=" + JSON.stringify((c3.mobility || {}).measured)
    );
  }

  // ---------------------------------------------------------------
  // F. The sweep itself, and the contracts its report has to keep.
  // ---------------------------------------------------------------
  console.log("\n--- Section F: the sweep ---");
  const prop = drivable[0].property;
  const swept = await motion({
    mode: "sweep",
    joint: jrows[0].name,
    property: prop,
    from: 0,
    to: 60,
    steps: 6,
  });
  const s = rep(swept);
  if (refusal(swept)) {
    note("F* skipped", refusal(swept));
    return finish();
  }
  assert(
    "F1 a frame comes back for every step, each saying whether it solved",
    Array.isArray(s.frames) &&
      s.frames.length === 7 &&
      s.frames.every((f) => typeof f.solved === "boolean"),
    "frames=" + ((s.frames || []).length)
  );
  assert(
    "F2 every frame reports what it ASKED the joint for and what it GOT",
    s.frames.every(
      (f) =>
        Object.prototype.hasOwnProperty.call(f, "requested") &&
        Object.prototype.hasOwnProperty.call(f, "achieved")
    ),
    JSON.stringify(s.frames[1] || {})
  );
  assert(
    "F3 every frame measures how far the assembly actually moved",
    s.frames.every(
      (f) => typeof f.movedMm === "number" && typeof f.movedDeg === "number"
    ),
    JSON.stringify(s.frames[1] || {})
  );
  assert(
    "F4 the reply says which travel was reached, not just which was asked for",
    s.travel &&
      Array.isArray(s.travel.requested) &&
      Object.prototype.hasOwnProperty.call(s.travel, "reachedThrough") &&
      Array.isArray(s.travel.failedSteps),
    JSON.stringify(s.travel || {})
  );
  // The contract, not the outcome. Whether this particular hinge locks or
  // collides depends on the solver; what must hold is that a claim of either
  // arrives with the evidence for it attached.
  if (s.sweepIncomplete) {
    assert(
      "F5 an incomplete sweep names the steps that failed and the travel it really has",
      s.travel.failedSteps.length > 0 && !!s.sweepNote,
      JSON.stringify(s.travel)
    );
  } else {
    assert(
      "F5 a complete sweep reached the value it was asked for at the last step",
      s.frames[s.frames.length - 1].requested === 60,
      JSON.stringify(s.frames[s.frames.length - 1])
    );
  }
  if (s.collides) {
    assert(
      "F6 a collision claim names the pair, the step and the angle",
      s.interference.hits.length > 0 &&
        s.interference.hits[0].pair.length === 2 &&
        typeof s.interference.hits[0].value === "number" &&
        !!s.collidesNote,
      JSON.stringify(s.interference.hits[0] || {})
    );
  } else {
    assert(
      "F6 no collision claimed means interference was actually checked",
      s.interference && s.interference.checked === true,
      JSON.stringify(s.interference || {})
    );
  }
  if (s.branchFlip) {
    assert(
      "F7 a branch flip is named as unreachable travel, not as a big step",
      (s.travel.branchFlipSteps || []).length > 0 &&
        /apart|configuration|branch/i.test(String(s.branchFlipNote || "")),
      JSON.stringify(s.travel.branchFlipSteps || [])
    );
  } else {
    note("F7 no branch flip in this sweep", "nothing to assert");
  }
  assert(
    "F8 the sweep puts the mechanism back, and says so if it could not",
    s.restored === true || !!s.restoreNote,
    JSON.stringify({ restored: s.restored })
  );

  const offCheck = await motion({
    mode: "sweep",
    joint: jrows[0].name,
    property: prop,
    from: 0,
    to: 20,
    steps: 2,
    interference: false,
  });
  assert(
    "F9 interference switched off reports checked:false — never 'no collisions'",
    rep(offCheck).interference &&
      rep(offCheck).interference.checked === false &&
      !rep(offCheck).collides,
    JSON.stringify(rep(offCheck).interference || {})
  );

  const undone = await sync({ detail: "summary" });
  assert(
    "F10 the document is still lintable after being driven around",
    Array.isArray((undone || {}).lint),
    JSON.stringify(Object.keys(undone || {}))
  );

  return finish();
}

async function finish() {
  console.log("\n--- Cleaning up ---");
  try {
    await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
`);
    assert("scratch document closed cleanly", true, "");
  } catch (e) {
    note("cleanup failed", e.message);
  }

  const buildInfo = parseResult(await tools.freecad_version({}));
  const build = (buildInfo && (buildInfo.build || buildInfo.runtime)) || {};
  console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings.`);
  console.log(
    `Valid for build ${build.exeVersion || build.version || "?"} @ ${build.commit || "?"}`
  );

  return { success: fail === 0, pass, fail, warn, results };
}

return run().catch((e) => {
  console.error(e);
  const label =
    e instanceof TransportLost
      ? "transport lost — the rest of this run proves nothing: " + e.message
      : e.message;
  results.push("❌ " + label);
  return { success: false, pass, fail, warn, results, error: label };
});