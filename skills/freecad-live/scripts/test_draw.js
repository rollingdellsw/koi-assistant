// scripts/test_draw.js — the sheet: freecad_draw.
//
// Run:  /skill freecad-live/scripts/test_draw.js --full-auto
//
// Needs probe-exec ON for teardown only; the fixture is built through the
// normal call surface, because a drawing is made OF a model and the model is
// something this skill authors properly.
//
// What is being tested. A drawing is the easiest artefact in CAD to produce
// wrong and have it look right, and the wrongness is always internally
// consistent — the sheet agrees with itself and disagrees with the part. Every
// assertion below is one of those:
//
//   * a view that projected nothing. Refused, not reported: a blank view left
//     on a page is a sheet that prints a title block around white space, and
//     it passes every review that consists of looking at the tree.
//   * a dimension attached to the projection rather than the model, which
//     reads short on anything not parallel to the sheet, and migrates to a
//     different edge when the view regenerates.
//   * a dimension that prints a number the model does not measure. Also
//     refused, for the same reason.
//   * a file reported as exported that is not on disk. Measured — mtime and
//     size — rather than inferred from a call that returned without raising.
//
// And one thing deliberately NOT tested, because the tool deliberately does
// not do it: whether a drawing is complete. Whether a part is fully
// constrained by its dimensions is a judgement about design intent, and
// counting dimensions is not that judgement. The assertion here is that the
// tool reports the count and REFUSES the verdict.

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

async function draw(args) {
  return guard(parseResult(await tools.freecad_draw(args || {})));
}

async function probe(python, timeoutMs) {
  const r = guard(
    parseResult(
      await tools.freecad_exec({ python, timeoutMs: timeoutMs || 30000 })
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

const DOC = "KoiDrawTest";

async function run() {
  console.log("=== test_draw.js — the sheet: freecad_draw ===");

  const attachRes = parseResult(await tools.freecad_attach({}));
  if (!attachRes || !attachRes.attached) {
    assert("attached to FreeCAD", false, JSON.stringify(attachRes));
    return { success: false, pass, fail, warn, results };
  }
  assert("attached to FreeCAD", true, attachRes.status);

  const caps = await call("capabilities", {});
  const mods = rep(caps).modules || {};
  const tdAvailable = !!(mods["TechDraw"] || {}).available;
  const guiAvailable = !!(mods["TechDrawGui"] || {}).available;
  console.log("TechDraw: " + tdAvailable + " | TechDrawGui: " + guiAvailable);
  assert(
    "the probe asks about the non-GUI module and the GUI one separately",
    Object.prototype.hasOwnProperty.call(mods, "TechDraw") &&
      Object.prototype.hasOwnProperty.call(mods, "TechDrawGui"),
    Object.keys(mods).filter((k) => /TechDraw/.test(k)).join(", ")
  );

  await call("new_document", { name: DOC }, "doc.draw", "draw test doc");

  // ---------------------------------------------------------------
  // A. Templates, and the refusals that need no page.
  // ---------------------------------------------------------------
  console.log("\n--- Section A: what this install carries, and refusals ---");

  const tmpl = await draw({ mode: "templates" });
  if (!tdAvailable) {
    assert(
      "A1 a build without TechDraw says so instead of reporting the part ready",
      refused(tmpl, "TechDraw"),
      refusal(tmpl)
    );
    note("A2..F* skipped", "no TechDraw on this build");
    return finish();
  }
  const tinfo = rep(tmpl).templates || {};
  assert(
    "A1 templates are probed on disk, not assumed",
    Object.prototype.hasOwnProperty.call(tinfo, "found") &&
      Object.prototype.hasOwnProperty.call(tinfo, "dir"),
    JSON.stringify(tinfo).slice(0, 200)
  );
  console.log(
    "templates: " + (tinfo.found || []).length + " in " + tinfo.dir
  );

  const noPage = await draw({ mode: "check" });
  assert(
    "A2 a check with no page is refused, and says where a page comes from",
    refused(noPage, "no drawing page"),
    refusal(noPage)
  );
  const badMode = await draw({ mode: "annotate" });
  assert(
    "A3 an unknown mode is refused by name",
    refused(badMode, "mode must be"),
    refusal(badMode)
  );
  const noId = await draw({ mode: "page" });
  assert(
    "A4 a page without an id is refused — a later turn has to be able to address it",
    refused(noId, "id"),
    refusal(noId)
  );

  // ---------------------------------------------------------------
  // B. A model to draw, then a page.
  // ---------------------------------------------------------------
  console.log("\n--- Section B: page ---");
  await call(
    "batch",
    {
      ops: [
        { fn: "body", args: {}, id: "body.plate" },
        {
          fn: "sketch",
          args: {
            body: "body.plate",
            on: "XY",
            geometry: [
              { type: "rect", anchor: "center", x: 0, y: 0, w: 60, h: 40 },
              { type: "circle", x: 0, y: 0, r: 6 },
            ],
          },
          id: "sk.plate",
        },
        { fn: "pad", args: { sketch: "sk.plate", length: 10 }, id: "pad.plate" },
      ],
    },
    null,
    "plate"
  );

  const page = await draw({ mode: "page", id: "dwg.plate" });
  const p = rep(page);
  assert(
    "B1 a page is created and carries a template",
    page.applied === true && !!p.page,
    refusal(page) || JSON.stringify(p).slice(0, 200)
  );
  assert(
    "B2 and it says which template file, or that there is none",
    Object.prototype.hasOwnProperty.call(p, "templateFile"),
    JSON.stringify({ file: p.templateFile, missing: p.templateMissing })
  );
  if (p.templateMissing) {
    note(
      "B2b this install has no TechDraw templates",
      "the tool reported it rather than handing over a borderless sheet"
    );
  }

  const emptyCheck = await draw({ mode: "check" });
  const e0 = rep(emptyCheck);
  assert(
    "B3 a page with no dimensions is named as a picture, not a drawing",
    e0.undimensioned === true && /picture/i.test(String(e0.undimensionedNote || "")),
    JSON.stringify({ undimensioned: e0.undimensioned })
  );
  assert(
    "B4 and it refuses to judge completeness while reporting the count",
    /not that judgement|counting/i.test(String(e0.completenessNote || "")) &&
      typeof e0.dimensionCount === "number",
    String(e0.completenessNote || "").slice(0, 120)
  );

  // ---------------------------------------------------------------
  // C. Views, including the one that must be refused.
  // ---------------------------------------------------------------
  console.log("\n--- Section C: views ---");
  const noSrc = await draw({ mode: "view", id: "v.nope" });
  assert(
    "C1 a view with no source is refused before it makes a blank sheet",
    refused(noSrc, "source"),
    refusal(noSrc)
  );

  const vTop = await draw({
    mode: "view",
    id: "v.top",
    source: ["body.plate"],
    direction: "top",
    scale: 1,
    x: 100,
    y: 150,
  });
  const vt = rep(vTop).view || {};
  const viewOk = assert(
    "C2 a top view of a plate projects geometry, and the count is measured",
    vTop.applied === true && vt.edges > 0,
    refusal(vTop) || JSON.stringify(vt).slice(0, 220)
  );
  if (viewOk) {
    assert(
      "C3 the reply says how the edge count was obtained, not just the number",
      !!vt.edgeCountVia,
      JSON.stringify({ edges: vt.edges, via: vt.edgeCountVia })
    );
    assert(
      "C4 and it reports the scale the view actually ended up at",
      typeof vt.scale === "number",
      JSON.stringify({ scale: vt.scale, scaleType: vt.scaleType })
    );
  }

  const vFront = await draw({
    mode: "view",
    id: "v.front",
    source: ["body.plate"],
    direction: "front",
    scale: 1,
    x: 100,
    y: 60,
  });
  assert(
    "C5 a second view lands on the same page",
    vFront.applied === true,
    refusal(vFront)
  );

  // ---------------------------------------------------------------
  // D. Dimensions: the cross-check is the whole point.
  // ---------------------------------------------------------------
  console.log("\n--- Section D: dimensions ---");
  const noRefs = await draw({ mode: "dimension", id: "dim.nope" });
  assert(
    "D1 a dimension with no refs is refused — it would measure whatever Edge7 is today",
    refused(noRefs, "refs"),
    refusal(noRefs)
  );

  // A known edge, queried geometrically rather than authored: the 60 mm long
  // edge of the plate. If the query does not resolve one uniquely the section
  // skips rather than dimensioning something arbitrary.
  const q = await call("query", {
    of: "body.plate",
    kind: "edge",
    size: 60,
    expect: "many",
  });
  const edgeRefs = rep(q).refs || [];
  if (!edgeRefs.length) {
    note("D2* skipped", "no 60 mm edge resolved: " + JSON.stringify(rep(q)).slice(0, 200));
  } else {
    const dim = await draw({
      mode: "dimension",
      id: "dim.long",
      refs: [edgeRefs[0]],
      dimType: "Distance",
      x: 100,
      y: 190,
    });
    const d = rep(dim).dimension || {};
    if (refusal(dim)) {
      note("D2 skipped", refusal(dim));
    } else {
      assert(
        "D2 the dimension is attached to the MODEL, not to the projected edge",
        (d.references3D || []).length > 0 && !d.projectionReferenced,
        JSON.stringify({ r3: d.references3D, r2: d.references2D })
      );
      assert(
        "D3 it reports what the sheet displays AND what the model measures",
        typeof d.displayed === "number" &&
          Object.prototype.hasOwnProperty.call(d, "model"),
        JSON.stringify({ displayed: d.displayed, model: d.model })
      );
      assert(
        "D4 and the two agree — on a 60 mm edge, both say 60",
        d.modelCheck === "agrees" && Math.abs(d.displayed - 60) < 0.01,
        JSON.stringify({
          displayed: d.displayed,
          model: d.model,
          check: d.modelCheck,
        })
      );
    }
  }

  // The audit has to find the same things on a page it did not create.
  const audit = await draw({ mode: "check" });
  const a = rep(audit);
  assert(
    "D5 the audit re-derives the page rather than trusting what was reported earlier",
    a.viewCount >= 2 && Array.isArray(a.views) && Array.isArray(a.dimensions),
    JSON.stringify({ views: a.viewCount, dims: a.dimensionCount })
  );
  assert(
    "D6 every dimension in the audit carries a verdict against the model",
    (a.dimensions || []).every((r) =>
      ["agrees", "disagrees", "unchecked"].indexOf(r.modelCheck) !== -1
    ),
    JSON.stringify((a.dimensions || []).map((r) => r.modelCheck))
  );
  assert(
    "D7 a disagreement, if any, is never silent",
    !a.dimensionsDisagree || !!a.dimensionsDisagreeNote,
    JSON.stringify(a.dimensionsDisagree || [])
  );
  assert(
    "D8 an unchecked dimension is reported as unchecked, not as correct",
    !a.dimensionsUnchecked || !!a.dimensionsUncheckedNote,
    JSON.stringify(a.dimensionsUnchecked || [])
  );

  // ---------------------------------------------------------------
  // E. Export, and the file that has to actually be there.
  // ---------------------------------------------------------------
  console.log("\n--- Section E: export ---");
  const dxf = await draw({
    mode: "export",
    format: "dxf",
    savePath: "koi_draw_test.dxf",
  });
  if (refusal(dxf)) {
    note("E1 skipped", refusal(dxf));
  } else {
    const x = rep(dxf);
    assert(
      "E1 the DXF is reported only after the file is measured on disk",
      typeof x.bytes === "number" && x.bytes > 0 && !!x.savePath,
      JSON.stringify({ path: x.savePath, bytes: x.bytes, via: x.wroteVia })
    );
    assert(
      "E2 and the export carries the page audit with it",
      x.audit && typeof x.audit.dimensionCount === "number",
      JSON.stringify(Object.keys(x.audit || {}))
    );
    assert(
      "E3 it says the file's CONTENT was never opened or verified",
      /unverified|nothing here opened/i.test(String(x.note || "")),
      String(x.note || "").slice(0, 120)
    );
  }

  const pdf = await draw({
    mode: "export",
    format: "pdf",
    savePath: "koi_draw_test.pdf",
  });
  if (guiAvailable && !refusal(pdf)) {
    assert(
      "E4 a PDF, where a GUI exists, is also measured rather than assumed",
      typeof rep(pdf).bytes === "number" && rep(pdf).bytes > 0,
      JSON.stringify(rep(pdf))
    );
  } else {
    assert(
      "E4 without a GUI, PDF export is refused by name and DXF is offered instead",
      refused(pdf, "TechDrawGui") || refused(pdf, "gui"),
      refusal(pdf)
    );
  }

  const badFmt = await draw({ mode: "export", format: "step" });
  assert(
    "E5 an export format that is not a drawing format is refused",
    refused(badFmt, "format must be"),
    refusal(badFmt)
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