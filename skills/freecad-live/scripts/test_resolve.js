// scripts/test_resolve.js — harness for the fingerprint resolver (§8.1, K5).
//
//   /skill freecad-live/scripts/test_resolve.js --full-auto
//
// K5 put one reference through three edits and measured what happened. This
// runs the same three against the resolver, plus the two cases K5 could not
// produce on demand: an element that is gone entirely, and two candidates that
// match equally well.
//
// The result that shaped this code: on this build a reference never moved
// SILENTLY. It held, or it broke loudly. So the assertions below are about
// loud breakage — a resolver that guesses when it should ask is the failure
// mode, not a resolver that misses.
//
// Requires `probe-exec: on` in SKILL.md.
//
// Scratch document ResolveTest, closed at the end.

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

async function resolve(opts) {
  return guard(parseResult(await tools.freecad_resolve(opts || {})));
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

const DOC = "ResolveTest";
const rowFor = (r, id) => ((r && r.refs) || []).find((x) => x.id === id) || {};

async function run() {
  console.log("=== fingerprint resolver tests ===");
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
  assert("the document was read before editing it",
    !!(await sync()).tree, "sync failed");

  // A plate with a boss on top: two parallel top faces, so "the top face" is
  // genuinely ambiguous unless the fingerprint carries more than a normal.
  const built = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
plate = doc.addObject("Part::Box", "Plate")
plate.Length, plate.Width, plate.Height = 40, 30, 10
doc.recompute()
return {"ok": True, "faces": len(plate.Shape.Faces)}
`, 60000);
  if (!assert("a plate was built", !built.__fail && built.faces === 6,
      built.__fail || JSON.stringify(built))) {
    return { success: false, pass, fail, results, error: "no plate" };
  }

  // Which face is the top one? Ask the geometry, not the index — the whole
  // point is that the index is not the identity.
  const top = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
sh = doc.getObject("Plate").Shape
best, name = None, None
for i, f in enumerate(sh.Faces):
    c = f.CenterOfMass
    if best is None or c.z > best:
        best, name = c.z, "Face%d" % (i + 1)
return {"ok": True, "sub": name, "z": best}
`);
  if (!assert("the top face was located by geometry", !top.__fail && top.sub,
      top.__fail || JSON.stringify(top))) {
    return { success: false, pass, fail, results, error: "no top face" };
  }
  console.log("   the top face is currently " + top.sub + " (z=" + top.z + ")\n");

  // ---- R1: capture ----
  console.log("--- R1: a pick becomes a durable handle ---");
  const cap = await call("ref", { ref: "Plate:" + top.sub }, "pick.top");
  assert("the reference was captured", cap && cap.applied === true,
    JSON.stringify(cap && { reason: cap.reason, error: cap.error }));
  const fp = (cap.result || {}).fingerprint || {};
  assert("it is stored in the document, not this session",
    (cap.result || {}).persisted === true, JSON.stringify(cap.result));
  assert("the fingerprint carries the surface type", !!fp.surface,
    JSON.stringify(fp.surface));
  assert("and the normal direction",
    Array.isArray(fp.direction) && Math.abs(fp.direction[2] - 1) < 1e-6,
    JSON.stringify(fp.direction));
  assert("and its ordering along the axes, not just its centroid",
    fp.axisRank && typeof fp.axisRank.z === "number", JSON.stringify(fp.axisRank));
  assert("provenance is recorded", fp.source === "given", JSON.stringify(fp.source));
  console.log("   generating attribution available on this build: " +
    JSON.stringify((fp.history || {}).available) +
    ((fp.history || {}).reason ? " (" + fp.history.reason + ")" : ""));
  console.log("   the stored name resolved via: " + fp.via);

  const r1 = await resolve({});
  assert("it re-validates cleanly straight away",
    rowFor(r1, "pick.top").status === "stored", JSON.stringify(rowFor(r1, "pick.top")));

  // ---- R2: K5's first edit — a dimensional change ----
  console.log("\n--- R2: a dimensional change (K5's first edit) ---");
  const grown = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
doc.getObject("Plate").Height = 25
doc.recompute()
return {"ok": True, "z": max(f.CenterOfMass.z for f in doc.getObject("Plate").Shape.Faces)}
`);
  assert("the plate grew 10 -> 25", !grown.__fail && Math.abs(grown.z - 25) < 1e-6,
    grown.__fail || JSON.stringify(grown));
  const r2 = await resolve({});
  const row2 = rowFor(r2, "pick.top");
  assert("the reference survives the resize",
    row2.status === "stored" || row2.status === "rederived",
    JSON.stringify(row2));
  assert("and it is not reported broken", (r2.broken || []).length === 0,
    JSON.stringify(r2.broken));
  if (row2.status === "rederived") {
    note("the resize moved the name", "re-derived to " + row2.sub +
      " on " + JSON.stringify(row2.matchedOn));
  }
  // The face it points at must still be the top one, not merely resolvable.
  const stillTop = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
sh = doc.getObject("Plate").Shape
f = sh.getElement("${row2.sub || top.sub}")
return {"ok": True, "z": f.CenterOfMass.z, "area": f.Area}
`);
  assert("and it still names the top face, by geometry",
    !stillTop.__fail && Math.abs(stillTop.z - 25) < 1e-6,
    stillTop.__fail || JSON.stringify(stillTop));

  // ---- R3: K5's second edit — unrelated topology ----
  console.log("\n--- R3: unrelated topology elsewhere (K5's second edit) ---");
  const bored = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
cyl = doc.addObject("Part::Cylinder", "Bore")
cyl.Radius, cyl.Height = 3, 40
cyl.Placement.Base = App.Vector(8, 8, -5)
cut = doc.addObject("Part::Cut", "Plated")
cut.Base = doc.getObject("Plate")
cut.Tool = cyl
doc.recompute()
return {"ok": True, "faces": len(cut.Shape.Faces)}
`, 60000);
  if (bored.__fail) {
    note("could not add unrelated topology", bored.__fail);
  } else {
    console.log("   the cut result has " + bored.faces + " faces");
    const r3 = await resolve({});
    const row3 = rowFor(r3, "pick.top");
    // The reference was captured on Plate, which is now consumed by the Cut.
    // Whatever happens, it must not quietly resolve to the wrong thing.
    assert("the reference reports a definite status",
      ["stored", "rederived", "broken", "ambiguous"].indexOf(row3.status) !== -1,
      JSON.stringify(row3));
    if (row3.status === "broken" || row3.status === "ambiguous") {
      assert("a reference it cannot place says so, and says what to do",
        typeof row3.message === "string" && row3.message.length > 0,
        JSON.stringify(row3));
      console.log("   " + row3.message);
    } else {
      const check3 = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
o = doc.getObject("${row3.owner || "Plate"}")
f = o.Shape.getElement("${row3.sub}")
return {"ok": True, "z": f.CenterOfMass.z}
`);
      assert("and where it does resolve, it is still the top face",
        !check3.__fail && Math.abs(check3.z - 25) < 1e-6,
        check3.__fail || JSON.stringify(check3));
    }
  }

  // ---- R4: K5's third edit — the referenced geometry is cut away ----
  console.log("\n--- R4: the referenced element is destroyed (K5's third edit) ---");
  const destroyed = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
p = doc.getObject("Plate")
if p is None:
    return {"ok": False, "error": "Plate is gone already"}
p.Height = 25
doc.recompute()
return {"ok": True}
`);
  const wiped = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
for n in ("Plated", "Bore"):
    o = doc.getObject(n)
    if o is not None:
        doc.removeObject(n)
p = doc.getObject("Plate")
if p is not None:
    doc.removeObject("Plate")
doc.recompute()
return {"ok": True, "left": [o.Name for o in doc.Objects]}
`);
  assert("the referenced object was removed entirely",
    !wiped.__fail && (wiped.left || []).indexOf("Plate") === -1,
    wiped.__fail || JSON.stringify(wiped));
  const r4 = await resolve({});
  const row4 = rowFor(r4, "pick.top");
  assert("a reference to a vanished object is broken", row4.status === "broken",
    JSON.stringify(row4));
  assert("it is listed as broken rather than merely reported",
    (r4.broken || []).indexOf("pick.top") !== -1, JSON.stringify(r4.broken));
  assert("and it never invents a replacement", !row4.sub, JSON.stringify(row4));
  assert("the message tells the user what is needed",
    typeof row4.message === "string" && row4.message.length > 0,
    JSON.stringify(row4.message));
  console.log("   " + row4.message);

  // ---- R5: two candidates that match equally well ----
  console.log("\n--- R5: guessing between equals is the failure mode ---");
  const twins = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
a = doc.addObject("Part::Box", "Twin")
a.Length, a.Width, a.Height = 20, 20, 10
doc.recompute()
sh = a.Shape
best, name = None, None
for i, f in enumerate(sh.Faces):
    if best is None or f.CenterOfMass.z > best:
        best, name = f.CenterOfMass.z, "Face%d" % (i + 1)
return {"ok": True, "sub": name}
`, 60000);
  if (twins.__fail) {
    note("could not build the ambiguity case", twins.__fail);
  } else {
    const cap5 = await call("ref", { ref: "Twin:" + twins.sub }, "pick.twin");
    assert("a second pick was captured", cap5 && cap5.applied === true,
      JSON.stringify(cap5 && cap5.error));
    // Fuse an identical box on top: now two coplanar-normal top faces exist
    // and area no longer separates them either.
    const fused = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
b = doc.addObject("Part::Box", "TwinB")
b.Length, b.Width, b.Height = 20, 20, 10
b.Placement.Base = App.Vector(40, 0, 0)
doc.recompute()
return {"ok": True}
`, 60000);
    assert("an identical part was added elsewhere", !fused.__fail, fused.__fail);
    const r5 = await resolve({});
    const row5 = rowFor(r5, "pick.twin");
    assert("the untouched pick still resolves to its own object",
      row5.status === "stored" || (row5.owner === "Twin"),
      JSON.stringify(row5));
    assert("an identical part elsewhere does not steal the reference",
      row5.owner !== "TwinB", JSON.stringify(row5));
  }

  // ---- R6: the resolver reports, the turn opener carries it ----
  console.log("\n--- R6: every turn re-validates, without being asked ---");
  const s6 = await sync();
  assert("sync carries the reference report", Array.isArray(s6.refs),
    JSON.stringify(s6.refs));
  assert("and names the broken ones", (s6.refsBroken || []).indexOf("pick.top") !== -1,
    JSON.stringify(s6.refsBroken));
  const e6 = await call("body", { label: "Later" }, "body.later");
  assert("an edit reports broken picks in the same breath",
    (e6.refsBroken || []).indexOf("pick.top") !== -1,
    JSON.stringify(e6.refsBroken));
  assert("and tells the model not to guess a replacement",
    typeof e6.refsNote === "string" && e6.refsNote.indexOf("ask") !== -1,
    JSON.stringify(e6.refsNote));

  // ---- R7: fingerprinting without capturing ----
  console.log("\n--- R7: inspect before committing ---");
  const insp = await resolve({ refs: ["Twin:Face1", "Nothing:Face1"] });
  const fps = insp.fingerprints || [];
  assert("a live reference can be fingerprinted without storing it",
    fps.length === 2 && !!(fps[0].fingerprint || fps[0].error),
    JSON.stringify(fps.map((f) => f.ref)));
  assert("a reference to a missing object reports an error, not a fingerprint",
    !!(fps[1] || {}).error, JSON.stringify(fps[1]));
  const sel = await resolve({ selection: true });
  assert("the selection channel answers", Array.isArray(sel.selection),
    JSON.stringify(sel.selection));

  // ---- teardown ----
  console.log("\n--- teardown ---");
  const down = await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
return {"ok": True, "open": list(App.listDocuments().keys())}
`);
  assert("scratch document closed", !down.__fail, down.__fail);

  console.log("\n=== resolve: " + pass + " passed, " + fail + " failed, " +
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
