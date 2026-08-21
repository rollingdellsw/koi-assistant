// scripts/test_tree.js — harness for hierarchical tree and get_node

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

function guard(res) {
  if (!res || res.error) {
    throw new Error(res ? res.error : "empty result");
  }
  return res;
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

async function sync() {
  return guard(parseResult(await tools.freecad_sync({})));
}

async function probe(python, timeoutMs) {
  const r = guard(
    parseResult(await tools.freecad_exec({ python, timeoutMs: timeoutMs || 30000 }))
  );
  if (!r || r.ok !== true) return { __fail: (r && r.error) || "exec failed" };
  const d = r.result || {};
  if (d.ok === false) return { __fail: d.error || "returned ok:false" };
  return d;
}

const DOC = "TreeTest";

async function run() {
  console.log("=== Hierarchical Tree and Delta-Driven Context Tests ===");
  console.log("Scratch document: " + DOC + "\n");

  const attach = parseResult(await tools.freecad_attach({ timeoutMs: 240000 }));
  if (!assert("attached", attach && attach.attached === true,
      (attach && (attach.error || attach.detail)) || "unknown")) {
    return { success: false, pass, fail, results, error: "could not attach" };
  }

  // Create scratch doc outside envelope
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

  console.log("\n--- Building a Part, Body, and Box ---");
  const setupBuild = await probe(`
import FreeCAD as App
doc = App.getDocument("${DOC}")
p = doc.addObject('App::Part', 'MyPart')
grp = doc.addObject('App::DocumentObjectGroup', 'MyGroup')
p.addObject(grp)
box = doc.addObject('Part::Box', 'MyBox')
box.Length, box.Width, box.Height = 10, 10, 10
grp.addObject(box)
doc.recompute()
return {"ok": True}
`);
  assert("structure built via probe", !setupBuild.__fail, setupBuild.__fail);

  console.log("\n--- Verifying Tree Structure in sync() ---");
  const s1 = await sync();
  assert("tree is present in sync()", !!s1.tree, "no tree returned");
  
  const roots = s1.tree || [];
  assert("one root object (MyPart)", roots.length === 1 && roots[0].name === "MyPart", JSON.stringify(roots));
  
  const part = roots[0] || {};
  assert("MyPart has children", !!part.children && part.children.length === 1, JSON.stringify(part));
  
  const grp = (part.children || [])[0] || {};
  assert("MyGroup is child of MyPart", grp.name === "MyGroup", JSON.stringify(grp));
  assert("MyGroup has children", !!grp.children && grp.children.length === 1, JSON.stringify(grp));
  
  const box = (grp.children || [])[0] || {};
  assert("MyBox is child of MyGroup", box.name === "MyBox", JSON.stringify(box));

  console.log("\n--- Verifying freecad_get for node details ---");
  const getRes = guard(parseResult(await tools.freecad_get({ id: "MyBox" })));
  assert("freecad_get returns full properties", !!getRes.props && getRes.props.Length === 10, JSON.stringify(getRes.props));
  assert("freecad_get returns shape metrics", !!getRes.shape && getRes.shape.volume === 1000, JSON.stringify(getRes.shape));
  assert("freecad_get returns validity", getRes.valid === true, JSON.stringify(getRes));

  console.log("\n--- Cleaning up ---");
  try {
    await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
`);
  } catch (e) {
    note("cleanup failed", e.message);
  }

  const buildInfo = parseResult(await tools.freecad_version({}));
  const build = buildInfo.build || (buildInfo.runtime || {});
  console.log("\n" + pass + " passed, " + fail + " failed, " + warn + " warnings.");
  console.log("Valid for build " + (build.exeVersion || build.version || "?") + " @ " + (build.commit || "?"));

  return { success: fail === 0, pass, fail, warn, results };
}

return run().catch((e) => {
  console.error(e);
  results.push("❌ " + e.message);
  return { success: false, pass, fail, warn, results, error: e.message };
});
