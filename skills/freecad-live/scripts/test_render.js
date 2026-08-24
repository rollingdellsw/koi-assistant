// scripts/test_render.js — direct viewport snapshot test for freecad_render and render op.

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

function parseResult(res) {
  if (!res) return null;
  if (res.error) throw new Error(res.error);
  if (!Array.isArray(res.content)) return res;
  const text = res.content.find((c) => c && c.type === "text" && c.text);
  const image = res.content.find((c) => c && c.type === "image");
  let out = res;
  if (text) {
    try {
      out = JSON.parse(text.text);
    } catch (e) {
      out = text.text;
    }
  }
  // The image never travels as text any more, so the harness has to look at
  // the block it does travel in — otherwise this suite goes green on a reply
  // the model cannot see.
  if (image && out && typeof out === "object") {
    out.imageBlock = { mimeType: image.mimeType, data: image.data };
  }
  return out;
}

async function run() {
  console.log("=== freecad_render viewport snapshot test ===\n");

  // 1. Attach
  const attach = parseResult(await tools.freecad_attach({ timeoutMs: 60000 }));
  assert("attached to FreeCAD", attach && attach.attached === true, JSON.stringify(attach));
  if (!attach || !attach.gui) {
    console.log("Headless mode; skipping GUI viewport render test.");
    return { success: fail === 0, pass, fail, warn, results };
  }

  // 1b. Ensure default demo document AssemblyExample is open
  const docSetup = parseResult(await (tools.freecad_exec ? tools.freecad_exec({
    python: `
import FreeCAD as App, FreeCADGui as Gui, os

doc_name = "AssemblyExample"
if doc_name not in App.listDocuments():
    res_dir = App.getResourceDir() if hasattr(App, "getResourceDir") else "/opt/freecad/usr/share/"
    ex_path = os.path.join(res_dir, "examples", f"{doc_name}.FCStd")
    if not os.path.exists(ex_path):
        for root, dirs, files in os.walk("/opt/freecad"):
            if f"{doc_name}.FCStd" in files:
                ex_path = os.path.join(root, f"{doc_name}.FCStd")
                break
    if os.path.exists(ex_path):
        App.openDocument(ex_path)
    else:
        if doc_name not in App.listDocuments():
            doc = App.newDocument(doc_name)
            box = doc.addObject("Part::Box", "Box")
            box.Length, box.Width, box.Height = 100, 100, 100
            doc.recompute()

if doc_name in App.listDocuments():
    App.setActiveDocument(doc_name)
    if Gui:
        try:
            Gui.setActiveDocument(doc_name)
        except Exception:
            pass

doc = App.ActiveDocument
gdoc = Gui.getDocument(doc.Name) if Gui and doc else None
view = gdoc.ActiveView if gdoc else None

return {
    "ok": True,
    "document": doc.Name if doc else None,
    "has_view": view is not None
}
`
  }) : tools.freecad_script({
    name: "open AssemblyExample demo",
    python: `
import os
doc_name = "AssemblyExample"
if doc_name not in App.listDocuments():
    res_dir = App.getResourceDir() if hasattr(App, "getResourceDir") else "/opt/freecad/usr/share/"
    ex_path = os.path.join(res_dir, "examples", f"{doc_name}.FCStd")
    if not os.path.exists(ex_path):
        for root, dirs, files in os.walk("/opt/freecad"):
            if f"{doc_name}.FCStd" in files:
                ex_path = os.path.join(root, f"{doc_name}.FCStd")
                break
    if os.path.exists(ex_path):
        App.openDocument(ex_path)
if doc_name in App.listDocuments():
    App.setActiveDocument(doc_name)
    if Gui:
        try:
            Gui.setActiveDocument(doc_name)
        except Exception:
            pass
result = {"ok": True, "document": doc_name}
`
  })));
  assert("AssemblyExample document loaded",
    docSetup && (docSetup.ok === true || (docSetup.result && docSetup.result.ok === true)),
    JSON.stringify(docSetup));

  // 2. Direct freecad_render tool call
  console.log("\n--- testing freecad_render tool ---");
  const r1 = parseResult(await tools.freecad_render({
    width: 800,
    height: 600,
    view: "iso",
    fit: true,
  }));

  assert("freecad_render returned ok: true", r1 && r1.ok === true, JSON.stringify(r1));
  assert("freecad_render returned width 800", r1 && r1.width === 800, "width: " + (r1 && r1.width));
  assert("freecad_render returned height 600", r1 && r1.height === 600, "height: " + (r1 && r1.height));
  assert("freecad_render returned valid PNG mimeType", r1 && r1.mimeType === "image/png", "mimeType: " + (r1 && r1.mimeType));

  // The point of the tool: the bytes arrive in an image block, and NOT in the
  // text block. A base64 PNG stringified into text is invisible to the model
  // and costs six figures of tokens to be invisible.
  assert("the reply carries an image content block",
    r1 && r1.imageBlock && typeof r1.imageBlock.data === "string",
    "content blocks: " + JSON.stringify(r1 && r1.imageBlock ? "present" : "missing"));
  assert("the image block is declared image/png",
    r1 && r1.imageBlock && r1.imageBlock.mimeType === "image/png",
    "mimeType: " + (r1 && r1.imageBlock && r1.imageBlock.mimeType));
  assert("the image block is a real PNG (iVBORw0KGgo)",
    r1 && r1.imageBlock && typeof r1.imageBlock.data === "string" &&
      r1.imageBlock.data.startsWith("iVBORw0KGgo"),
    "header: " + (r1 && r1.imageBlock && r1.imageBlock.data ? r1.imageBlock.data.slice(0, 20) : "none"));
  assert("imageData is NOT echoed into the text block",
    r1 && r1.imageData === undefined,
    "text block carried " + (r1 && r1.imageData ? r1.imageData.length + " base64 chars" : "nothing"));

  // 3. Testing custom dimensions and white background
  console.log("\n--- testing freecad_render with custom dimensions and white background ---");
  const r2 = parseResult(await tools.freecad_render({
    width: 1024,
    height: 768,
    background: "White",
    view: "top",
    fit: true,
  }));
  assert("freecad_render with 1024x768 returned ok: true", r2 && r2.ok === true, JSON.stringify(r2));
  assert("returned width 1024", r2 && r2.width === 1024, "width: " + (r2 && r2.width));
  assert("returned height 768", r2 && r2.height === 768, "height: " + (r2 && r2.height));

  // 4. An unknown preset is refused rather than silently ignored: rendering
  //    the current camera and labelling it 'isometric' is a lying result.
  console.log("\n--- testing preset validation ---");
  const rBad = parseResult(await tools.freecad_render({ view: "isometric" }));
  assert("an unknown preset is refused",
    rBad && rBad.ok !== true && typeof rBad.error === "string",
    JSON.stringify(rBad));

  // 5. Transparent + JPEG has no meaning; it should be refused, not rendered
  //    onto whatever alpha collapses into.
  const rBg = parseResult(await tools.freecad_render({
    background: "Transparent", format: "jpeg",
  }));
  assert("transparent + jpeg is refused", rBg && rBg.ok !== true, JSON.stringify(rBg));

  // 6. Dimensions are clamped, and the reply reports the clamp rather than
  //    the request.
  const rBig = parseResult(await tools.freecad_render({ width: 99999, height: 99999 }));
  assert("width clamps to 3840", rBig && rBig.width === 3840, "width: " + (rBig && rBig.width));
  assert("height clamps to 2160", rBig && rBig.height === 2160, "height: " + (rBig && rBig.height));

  // 7. The camera is an observation, not an edit: a render that framed 'top'
  //    must leave the human's view where it found it. freecad_sync does not
  //    report a camera — the only field it carries about the view is viewFit —
  //    so the check reads render's own cameraRestored, which is set by
  //    comparing getCamera() after the restore against what was saved.
  console.log("\n--- testing camera restore ---");
  const rCam = parseResult(await tools.freecad_render({ view: "top", fit: true }));
  assert("a framed render reports the camera restored",
    rCam && rCam.cameraRestored === true,
    "cameraRestored: " + (rCam && rCam.cameraRestored) + " / " + JSON.stringify(rCam && rCam.error));
  const rNoFrame = parseResult(await tools.freecad_render({ fit: false }));
  assert("a render that framed nothing does not touch the camera",
    rNoFrame && rNoFrame.cameraRestored === null,
    "cameraRestored: " + (rNoFrame && rNoFrame.cameraRestored));

  // 8. Which tab is in front is reported, not assumed. A document with a
  //    TechDraw page open renders the 3D view where it sits and says so —
  //    describing that image as what the human sees would be the same failure
  //    the stream disconnect causes.
  assert("the reply says whether the render is the front tab",
    r1 && typeof r1.isFrontTab === "boolean",
    "isFrontTab: " + (r1 && r1.isFrontTab));
  if (r1 && r1.isFrontTab === false) {
    warn++;
    console.warn("⚠️  the front tab is not the 3D view — the human is looking at something else");
  }

  // 9. render op via freecad_call: metadata to disk, never pixels in the reply.
  console.log("\n--- testing render op via freecad_call ---");
  const rNoPath = parseResult(await tools.freecad_call({
    fn: "render",
    args: { width: 640, height: 480, view: "front" }
  }));
  assert("the render op without savePath is refused",
    rNoPath && rNoPath.ok !== true,
    JSON.stringify(rNoPath));

  const outPath = "koi_test_render.png";
  const r3 = parseResult(await tools.freecad_call({
    fn: "render",
    args: { width: 640, height: 480, view: "front", savePath: outPath }
  }));
  assert("freecad_call({fn: 'render', savePath}) succeeded", r3 && r3.ok === true, JSON.stringify(r3));
  const res3 = r3 && r3.result;
  assert("the render op reports the path it wrote",
    res3 && typeof res3.path === "string" && res3.path.endsWith(outPath), JSON.stringify(res3));
  assert("the render op carries NO base64 payload",
    res3 && res3.imageData === undefined,
    "op result carried " + (res3 && res3.imageData ? res3.imageData.length + " base64 chars" : "nothing"));
  assert("the render op reports a non-empty file",
    res3 && typeof res3.sizeBytes === "number" && res3.sizeBytes > 0,
    "sizeBytes: " + (res3 && res3.sizeBytes));

  console.log("\n=== test_render complete: " + pass + " passed, " + fail + " failed ===");
  return { success: fail === 0, pass, fail, warn, results };
}

return run().catch((e) => {
  console.error(e);
  results.push("❌ " + e.message);
  return { success: false, pass, fail, warn, results, error: e.message };
});
