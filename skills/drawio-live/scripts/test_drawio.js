// scripts/test_drawio.js — Integration test for drawio-live skill.
//
// Run from Koi input box:
//   /skill drawio-live/scripts/test_drawio.js --full-auto
//
// Tests: open → init → sync → ops → validate → render → shape_search → history → save
// Each step logs pass/fail. No LLM session required.

const results = [];
let pass = 0;
let fail = 0;

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
}

function parseResult(res) {
  if (!res) return null;
  if (res.isError) {
    const text = res.content && res.content[0] && res.content[0].text;
    return { __error: true, message: text || "unknown error" };
  }
  try {
    const text = res.content ? res.content[0].text : JSON.stringify(res);
    return JSON.parse(text);
  } catch (_) {
    return res;
  }
}

async function run() {
// ---- Setup: ensure MCP tools are available ----
// Note: sandbox-impl.js uses a Proxy, so typeof always returns "function".
// The real test is whether the call succeeds (MCP server must be started).
// When running via `/skill drawio-live/scripts/test_drawio.js`, the skill
// is auto-loaded and its MCP servers started before the script runs.
// We verify with a lightweight probe — drawio_validate with known-good XML.

let mcpReady = false;
try {
  const probeXml = '<mxfile><diagram name="P" id="p"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
  const probeRes = await tools.drawio_validate({ xml: probeXml });
  // If we get here without "Unknown tool" error, MCP is working
  mcpReady = true;
} catch (e) {
  // MCP tools not available — try loading the skill
  console.log("MCP tools not available, attempting readSkill...");
  try {
    await tools.readSkill({ name: "drawio-live" });
    await tools.sleep(3000); // wait for MCP server to start
    mcpReady = true;
  } catch (e2) {
    console.error("readSkill also failed: " + e2.message);
  }
}
assert("MCP tools registered", mcpReady);
if (!mcpReady) {
  return { success: false, pass, fail, results, error: "MCP tools not available. Is drawio-live installed? Check that SKILL.md uses 'script:' (not 'file:') for mcp-servers." };
}

// Read what is actually ON the canvas. Every assertion about a drawing
// outcome must go through this: the previous suite passed 27/30 against a
// blank editor because it only ever checked the tool's own return value.
async function liveCanonical() {
  const r = parseResult(await tools.drawio_get({ what: "live" }));
  // drawio_get({what:"live"}) returns raw XML in `text` and canonical form in
  // `canonical`. Assertions must use the canonical form — matching against
  // raw mxfile XML silently never matches.
  return (r && r.canonical) || "";
}
function hasCell(canon, id) {
  return new RegExp("^[VE] " + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " ", "m").test(canon);
}
// Which page a cell lives on, from the canonical line's pg= field. Null only
// for a bare <mxGraphModel> with no <diagram> wrapper, which has no page.
function cellPage(canon, id) {
  const line = cellLine(canon, id);
  const m = line && line.match(/^[VE]\s+\S+\s+pg=(\S+)/);
  return m ? m[1] : null;
}
// Canonical vertex line: V <id> pg=<page> p=<parent> "<label>" s=<style> g=[x,y,w,h]
function cellLine(canon, id) {
  const re = new RegExp("^[VE] " + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " .*$", "m");
  const m = canon.match(re);
  return m ? m[0] : null;
}
function cellGeom(canon, id) {
  const line = cellLine(canon, id);
  const m = line && line.match(/g=\[(-?\d+),(-?\d+),(-?\d+),(-?\d+)\]/);
  if (!m) return null;
  return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
}
const cx = (g) => g.x + g.w / 2;

// A clean page to build on, so a test that cares about layout is not reading
// geometry left behind by an earlier test.
const BLANK_DOC =
  '<mxfile><diagram name="Page-1" id="page-1"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  "</root></mxGraphModel></diagram></mxfile>";
async function freshPage(name) {
  // xml is supplied deliberately: the skill guardrail refuses a bare
  // drawio_init once a canvas is attached, and rightly so.
  return parseResult(
    await tools.drawio_init({ name: name, xml: BLANK_DOC, mode: "replace", force: true })
  );
}

// ---- Test 1: Open canvas tab ----

console.log("\n--- Test 1: Open canvas tab ---");

// args[0] = canvasUrl. Empty runs against whatever the drawio_bridge server is
// configured for, so the same suite exercises the public editor, a localhost
// webapp checkout and a self-hosted instance without edits:
//   /skill drawio-live/scripts/test_drawio.js --full-auto --param canvasUrl=http://localhost:7080
let CANVAS_URL = null;
let CANVAS_HOSTS = ["embed.diagrams.net", "viewer.diagrams.net", "localhost", "127.0.0.1"];
try {
  const cfgRes = await tools.drawio_config(args[0] ? { canvasUrl: args[0] } : {});
  const cfg = parseResult(cfgRes);
  if (cfg && cfg.canvasUrl) {
    CANVAS_URL = cfg.canvasUrl;
    if (Array.isArray(cfg.hosts) && cfg.hosts.length) CANVAS_HOSTS = cfg.hosts;
  }
} catch (e) {
  console.error("drawio_config failed: " + (e.message || e));
}
if (!CANVAS_URL) {
  CANVAS_URL =
    "https://embed.diagrams.net/?embed=1&proto=json&spin=1&modified=0" +
    "&libraries=1&ui=kennedy&noExitBtn=1";
}
console.log("canvas: " + CANVAS_URL);

const isCanvasUrl = (url) =>
  typeof url === "string" &&
  (CANVAS_HOSTS.some((h) => url.includes(h)) || url.includes("embed=1"));

await tools.newPage(CANVAS_URL);
await tools.sleep(5000); // draw.io needs time to load

// Explicitly select the canvas tab — MCP tools' evaluateScript targets the
// "active tab" as resolved by the background. If the sidepanel has focus after
// newPage, the background may pick the wrong tab.
let canvasTabId = null;
try {
  const pagesRaw = await tools.listPages();
  const pageList = parseResult(pagesRaw);
  const arr = Array.isArray(pageList) ? pageList : (pageList.pages || []);
  const drawioTab = arr.find((p) => isCanvasUrl(p.url));
  if (drawioTab) {
    canvasTabId = drawioTab.id || drawioTab.pageId;
    await tools.selectPage(canvasTabId);
    await tools.sleep(500);
  }
} catch (e) {
  console.error("Tab selection failed: " + (e.message || e));
}
assert("Canvas tab opened", canvasTabId !== null, "Could not find a canvas tab for " + CANVAS_URL);

// ---- Test 2: Init bridge ----

console.log("\n--- Test 2: Init bridge ---");
// Explicit mode:"replace"+force. Default mode is "auto", which adopts a
// non-empty canvas — correct for users, fatal for a suite that re-runs against
// a warm MCP server and would then hit duplicate-ID errors in Test 4.
const initRes = parseResult(
  await tools.drawio_init({ name: "test-diagram", xml: BLANK_DOC, mode: "replace", force: true })
);
assert("drawio_init returns success", initRes && initRes.success === true, JSON.stringify(initRes));
assert("drawio_init returns rev", initRes && typeof initRes.rev === "number");
assert("drawio_init reports replace mode", initRes && initRes.mode === "replace");
assert("drawio_init verified against canvas", initRes && initRes.verified === true,
  "canvas did not read back as the document we loaded");

// ---- Test 3: Sync (no user changes yet) ----

console.log("\n--- Test 3: Sync (baseline) ---");
const syncRes = parseResult(await tools.drawio_sync());
assert("drawio_sync returns userDiff", syncRes && syncRes.userDiff !== undefined, JSON.stringify(syncRes));
assert("drawio_sync: no changes", syncRes && syncRes.userDiff && syncRes.userDiff.summary === "No changes");
assert("drawio_sync: canonical present", syncRes && typeof syncRes.canonical === "string");

// ---- Test 4: Ops — add nodes and edge ----

console.log("\n--- Test 4: Ops — add nodes + edge ---");
const opsRes = parseResult(
  await tools.drawio_ops({
    ops: [
      { op: "add_node", id: "n.web", label: "Web App", x: 200, y: 100, style: "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" },
      { op: "add_node", id: "n.api", label: "API Server", x: 200, y: 260, style: "rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" },
      { op: "add_node", id: "n.db", label: "PostgreSQL", x: 200, y: 420, style: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;fillColor=#ffe6cc;strokeColor=#d6b656;" },
      { op: "add_edge", source: "n.web", target: "n.api", label: "REST" },
      { op: "add_edge", source: "n.api", target: "n.db", label: "SQL" },
    ],
  })
);
assert("drawio_ops returns ok", opsRes && opsRes.ok === true, JSON.stringify(opsRes && opsRes.error));
assert("drawio_ops: 5 ops reported", opsRes && opsRes.report && opsRes.report.length === 5);
assert("drawio_ops: all ops ok", opsRes && opsRes.report && opsRes.report.every((r) => r.ok));
const liveAfterAdd = await liveCanonical();
assert("add: nodes present ON CANVAS", hasCell(liveAfterAdd, "n.web") && hasCell(liveAfterAdd, "n.api"),
  "canvas canonical: " + liveAfterAdd.slice(0, 300));
assert("add: verified flag set", opsRes && opsRes.verified === true);
// An ops result must NEVER carry base64. callTool JSON.stringify's everything
// into a text block, so an image payload here is pure token burn that the model
// cannot see. There is no longer a render flag to opt into.
assert("drawio_ops: never carries an image",
  opsRes && opsRes.data === undefined && opsRes.png === undefined &&
    opsRes.type !== "image",
  "ops leaked an image payload: " + Object.keys(opsRes || {}).join(","));

// And render:true is gone, not merely discouraged — passing it must not
// resurrect the payload.
const sync1b = parseResult(await tools.drawio_sync());
assert("sync before render:true ops", sync1b && sync1b.userDiff !== undefined);
const opsRender = parseResult(
  await tools.drawio_ops({ render: true, ops: [{ op: "set_label", id: "n.api", label: "API Server" }] })
);
assert("drawio_ops: render:true is inert", opsRender && opsRender.ok === true &&
  opsRender.data === undefined && opsRender.type !== "image",
  JSON.stringify(opsRender && opsRender.error));

// ---- Test 5: Ops — modify ----

console.log("\n--- Test 5: Ops — modify (label + style + move) ---");

// Need to sync first (guardrail)
const sync2 = parseResult(await tools.drawio_sync());
assert("sync before modify", sync2 && sync2.userDiff !== undefined);

const modRes = parseResult(
  await tools.drawio_ops({
    ops: [
      { op: "set_label", id: "n.web", label: "React Frontend" },
      { op: "set_style", id: "n.web", style: "rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;", merge: false },
      { op: "move_by", ids: ["n.db"], dx: 100, dy: 0 },
    ],
  })
);
assert("modify ops ok", modRes && modRes.ok === true, JSON.stringify(modRes && modRes.error));

// ---- Test 6: Ops — delete ----

console.log("\n--- Test 6: Ops — delete ---");
const sync3 = parseResult(await tools.drawio_sync());

const delRes = parseResult(
  await tools.drawio_ops({
    ops: [{ op: "delete", ids: ["n.db"] }],
  })
);
assert("delete ops ok", delRes && delRes.ok === true, JSON.stringify(delRes && delRes.error));
// merge is a whole-document reconcile: cells absent from the payload are
// removed, so deletions no longer need the undo-stack-destroying load path.
assert("delete used merge (reconcile handles removal)", delRes && delRes.pushMethod === "merge",
  "pushMethod was " + (delRes && delRes.pushMethod));
const liveAfterDel = await liveCanonical();
assert("delete: n.db gone FROM CANVAS", !hasCell(liveAfterDel, "n.db"));
assert("delete: siblings survived ON CANVAS", hasCell(liveAfterDel, "n.web") && hasCell(liveAfterDel, "n.api"),
  "a partial merge payload would have wiped these — canvas: " + liveAfterDel.slice(0, 300));

// ---- Test 7: Validate ----

console.log("\n--- Test 7: Validate ---");

const goodXml =
  '<mxfile><diagram name="P" id="p1"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="50" as="geometry"/></mxCell>' +
  "</root></mxGraphModel></diagram></mxfile>";
const valGood = parseResult(await tools.drawio_validate({ xml: goodXml }));
assert("validate good XML: no errors", valGood && valGood.errors && valGood.errors.length === 0);

const badXml = "<not-valid-drawio><foo/></not-valid-drawio>";
const valBad = parseResult(await tools.drawio_validate({ xml: badXml }));
assert("validate bad XML: has errors", valBad && valBad.errors && valBad.errors.length > 0);

const danglingEdgeXml =
  '<mxfile><diagram name="P" id="p1"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="e1" edge="1" source="missing" target="also_missing" parent="1"/>' +
  "</root></mxGraphModel></diagram></mxfile>";
const valDangle = parseResult(await tools.drawio_validate({ xml: danglingEdgeXml }));
assert("validate dangling edge: has errors", valDangle && valDangle.errors && valDangle.errors.length > 0);

// ---- Test 8: Render ----

console.log("\n--- Test 8: Render (SVG only) ---");
// The render must come from the canvas, not from our intended XML — passing
// `xml` to the export action would make this self-confirming.
const renderRes = parseResult(await tools.drawio_render({}));
assert("render defaults to svg", renderRes && renderRes.format === "svg",
  renderRes && renderRes.error);
assert("render returns svg text", renderRes && typeof renderRes.data === "string" &&
  renderRes.data.indexOf("<svg") !== -1,
  "expected SVG markup, got: " + String(renderRes && renderRes.data).slice(0, 120));
assert("render svg is decoded, not a data URI", renderRes &&
  typeof renderRes.data === "string" && renderRes.data.indexOf("data:") !== 0,
  "draw.io answers export with a data URI; toolRender must decode it or the " +
  "'SVG is readable text' contract is a lie");
assert("render never tags type:image", renderRes && renderRes.type !== "image",
  "a tool result is text-only; an image tag here means base64 is leaking as prose");

// PNG must fail loudly rather than silently costing a thousand tokens.
const renderPng = parseResult(await tools.drawio_render({ format: "png" }));
assert("render png is refused", renderPng && typeof renderPng.error === "string" &&
  renderPng.data === undefined,
  "png should be refused with a pointer to takeScreenshot");
assert("png refusal names takeScreenshot",
  renderPng && /takeScreenshot/.test(renderPng.error || ""));


// ---- Test 9: Get ----

console.log("\n--- Test 9: Get (canonical + xml) ---");
const getCanon = parseResult(await tools.drawio_get({ what: "canonical" }));
assert("get canonical returns text", getCanon && typeof getCanon.text === "string" && getCanon.text.length > 0);

const getXml = parseResult(await tools.drawio_get({ what: "xml" }));
assert("get xml returns text", getXml && typeof getXml.text === "string" && getXml.text.includes("mxfile"));

// ---- Test 10: Shape search ----

console.log("\n--- Test 10: Shape search ---");
const searchRes = parseResult(await tools.drawio_shape_search({ query: "aws lambda" }));
assert("shape search returns results", searchRes && searchRes.results && searchRes.results.length > 0);
assert("shape search result has style",
  searchRes && searchRes.results && searchRes.results[0] && searchRes.results[0].style &&
  searchRes.results[0].style.includes("lambda"));

const searchDb = parseResult(await tools.drawio_shape_search({ query: "database" }));
assert("shape search 'database' finds cylinder",
  searchDb && searchDb.results && searchDb.results.some((r) => r.name.toLowerCase().includes("cylinder") || r.style.includes("cylinder")));

// ---- Test 11: History ----

console.log("\n--- Test 11: History ---");
const histRes = parseResult(await tools.drawio_history());
assert("history returns turns", histRes && Array.isArray(histRes.turns));
assert("history has entries", histRes && histRes.turns && histRes.turns.length >= 2); // at least the ops + modify turns

// ---- Test 12: Ops error handling ----

console.log("\n--- Test 12: Error handling ---");
const sync4 = parseResult(await tools.drawio_sync());

const dupRes = parseResult(
  await tools.drawio_ops({
    ops: [{ op: "add_node", id: "n.web", label: "Duplicate", x: 0, y: 0 }],
  })
);
assert("duplicate add_node returns error",
  (dupRes && dupRes.error) || (dupRes && dupRes.__error),
  JSON.stringify(dupRes));

const badOpRes = parseResult(
  await tools.drawio_ops({
    ops: [{ op: "add_edge", source: "nonexistent", target: "also_nonexistent" }],
  })
);
assert("edge with missing source returns error",
  (badOpRes && badOpRes.error) || (badOpRes && badOpRes.__error));

// ---- Test 13: add_page ----

console.log("\n--- Test 13: add_page ---");
const sync5 = parseResult(await tools.drawio_sync());
const pageRes = parseResult(
  await tools.drawio_ops({
    ops: [{ op: "add_page", id: "page-2", name: "Details" }],
  })
);
assert("add_page ok", pageRes && pageRes.ok === true, JSON.stringify(pageRes && pageRes.error));
assert("add_page used load (page set changed)", pageRes && pageRes.pushMethod === "load",
  "pushMethod was " + (pageRes && pageRes.pushMethod));
const liveAfterPage = await liveCanonical();
assert("add_page: page-2 present ON CANVAS", /^P page-2 /m.test(liveAfterPage),
  liveAfterPage.slice(0, 300));

// ---- Test 14: Canvas rebuild (the canvas is a cache) ----

console.log("\n--- Test 14: Canvas rebuild from text ---");
const beforeReload = await liveCanonical();
await tools.newPage(CANVAS_URL);
await tools.sleep(5000);
try {
  const pagesRaw2 = await tools.listPages();
  const list2 = parseResult(pagesRaw2);
  const arr2 = Array.isArray(list2) ? list2 : (list2.pages || []);
  const tab2 = arr2.find((p) => isCanvasUrl(p.url));
  if (tab2) { await tools.selectPage(tab2.id || tab2.pageId); await tools.sleep(500); }
} catch (e) { console.error("rebuild tab select: " + (e.message || e)); }
const rebuilt = parseResult(await tools.drawio_sync());
assert("rebuild: sync succeeds on fresh tab", rebuilt && rebuilt.canonical !== undefined,
  JSON.stringify(rebuilt));
assert("rebuild: document restored from lastApplied",
  rebuilt && rebuilt.canonical && hasCell(rebuilt.canonical, "n.web"),
  "canvas after rebuild: " + JSON.stringify(rebuilt && rebuilt.canonical).slice(0, 300));

// ---- Test 15: init adopt mode (must not wipe an in-progress canvas) ----

console.log("\n--- Test 15: init adopts existing canvas ---");
const beforeAdopt = await liveCanonical();

// Explicit adopt: the mode scripts/run.js uses, and the one the guardrail
// exempts so re-running the skill can still recover a canvas.
const adoptRes = parseResult(await tools.drawio_init({ name: "adopt-test", mode: "adopt" }));
assert("drawio_init mode:adopt adopts, does not replace", adoptRes && adoptRes.mode === "adopt",
  "mode was " + (adoptRes && adoptRes.mode) + " — an adopt just blanked the user's canvas");
assert("adopt: canvas content untouched", (await liveCanonical()) === beforeAdopt,
  "canvas changed during adopt");

// A bare drawio_init is what the LLM reaches for out of habit. Two layers may
// stop it — the skill guardrail (blocks re-init once attached) or the MCP
// (adopts rather than replacing). Which one fires depends on whether guardrails
// wrap script-issued tool calls, which is not contractually fixed, so the
// assertion is on the invariant both layers exist to protect: the canvas is
// still there afterwards.
const bareRes = parseResult(await tools.drawio_init({ name: "bare-init" }));
const blockedByGuardrail = !!(bareRes && (bareRes.__error || /already attached/i.test(bareRes.message || "")));
console.log("bare init handled by: " + (blockedByGuardrail ? "guardrail" : "MCP (mode=" + (bareRes && bareRes.mode) + ")"));
assert("bare drawio_init never blanks the canvas", (await liveCanonical()) === beforeAdopt,
  "canvas content changed: " + JSON.stringify(bareRes));

const refuseRes = parseResult(await tools.drawio_init({ name: "x", mode: "replace" }));
assert("replace without xml/force is refused on a populated canvas",
  refuseRes && (refuseRes.__error || (refuseRes.success === false && /Refusing/.test(refuseRes.error || ""))),
  JSON.stringify(refuseRes));

// ---- Test 16: the sync gate actually gates ----
//
// The previous suite called drawio_sync before every edit because it was
// written to, so state.turnSynced was always satisfied and the gate was never
// exercised. A test that only walks the happy path cannot tell an enforced
// invariant from an inert one — which is exactly how the old once-per-session
// `syncedThisTurn` flag survived review.
//
// drawio_begin_turn is what scripts/pre_send.js calls at each user-message
// boundary. Calling it here simulates that boundary.

console.log("\n--- Test 16: sync-before-edit gate ---");
await tools.drawio_begin_turn();
const ungated = parseResult(
  await tools.drawio_ops({ ops: [{ op: "set_label", id: "n.web", label: "Should Not Apply" }] })
);
assert("ops without sync is refused",
  ungated && (ungated.__error || /drawio_sync/.test(ungated.error || "")),
  JSON.stringify(ungated));

const gateSync = parseResult(await tools.drawio_sync());
assert("sync re-opens the gate", gateSync && gateSync.userDiff !== undefined);
const gated = parseResult(
  await tools.drawio_ops({ ops: [{ op: "set_label", id: "n.web", label: "Gated Edit" }] })
);
assert("ops after sync succeeds", gated && gated.ok === true, JSON.stringify(gated && gated.error));

// ---- Test 17: drawio_route tidies connectors and moves NOTHING ----
//
// The whole point of separating route from arrange is that one is safe on a
// diagram a human composed and the other is not. If route ever moves a vertex,
// that distinction is a lie and the tool descriptions are misleading the model.

console.log("\n--- Test 17: drawio_route ---");
await freshPage("route-test");
const syncR = parseResult(await tools.drawio_sync());
assert("sync on fresh route page", syncR && syncR.canonical !== undefined);

// Deliberately awkward: n.mid sits directly between the two endpoints, so a
// straight n.left -> n.right edge has to pass through it.
const built = parseResult(
  await tools.drawio_ops({
    ops: [
      { op: "add_node", id: "n.left", label: "Left", x: 100, y: 300, w: 120, h: 60 },
      { op: "add_node", id: "n.mid", label: "Middle", x: 400, y: 300, w: 120, h: 60 },
      { op: "add_node", id: "n.right", label: "Right", x: 700, y: 300, w: 120, h: 60 },
      { op: "add_edge", id: "e.through", source: "n.left", target: "n.right", label: "Bypass" },
      { op: "add_edge", id: "e.a", source: "n.left", target: "n.mid" },
      { op: "add_edge", id: "e.b", source: "n.mid", target: "n.right" },
    ],
  })
);
assert("route setup ops ok", built && built.ok === true, JSON.stringify(built && built.error));
assert("lint sees the edge passing through a shape",
  built && built.lint && built.lint.some((w) => /pass through shapes/.test(w)),
  JSON.stringify(built && built.lint));
assert("lint names drawio_route as the fix",
  built && built.lint && built.lint.some((w) => /drawio_route/.test(w)),
  JSON.stringify(built && built.lint));

const geomBefore = {};
const canonBefore = await liveCanonical();
["n.left", "n.mid", "n.right"].forEach((id) => (geomBefore[id] = cellGeom(canonBefore, id)));

const syncR2 = parseResult(await tools.drawio_sync());
assert("sync before route", syncR2 && syncR2.userDiff !== undefined);
const routed = parseResult(await tools.drawio_route());
assert("drawio_route succeeds", routed && routed.ok === true,
  JSON.stringify(routed && routed.error));
assert("drawio_route reports its passes",
  routed && Array.isArray(routed.passes) &&
    routed.passes.indexOf("orthogonalEdge") !== -1 &&
    routed.passes.indexOf("mxParallelEdgeLayout") !== -1,
  JSON.stringify(routed && routed.passes));

const canonAfter = await liveCanonical();
["n.left", "n.mid", "n.right"].forEach((id) => {
  const a = geomBefore[id];
  const b = cellGeom(canonAfter, id);
  assert("route moved no shape: " + id,
    a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h,
    JSON.stringify({ before: a, after: b }));
});
assert("route re-adopted the canvas as the base",
  (parseResult(await tools.drawio_get({ what: "canonical" })).text || "") === canonAfter,
  "state.base is stale after a layout that bypassed the ops pipeline");

// libavoid should have bent the bypass edge around n.mid.
if (routed && routed.applied) {
  assert("route added waypoints to the obstructed edge",
    /^E e\.through .*pts=\[/m.test(canonAfter),
    cellLine(canonAfter, "e.through") || "e.through missing");
}

// ---- Test 18: drawio_arrange re-places shapes ----

console.log("\n--- Test 18: drawio_arrange ---");
await freshPage("arrange-test");
const syncA = parseResult(await tools.drawio_sync());
assert("sync on fresh arrange page", syncA && syncA.canonical !== undefined);

// Every node stacked at the same coordinates: nothing but a layout can
// untangle this, so any sane result proves ELK ran.
const stacked = parseResult(
  await tools.drawio_ops({
    ops: [
      { op: "add_node", id: "n.client", label: "Client", x: 0, y: 0 },
      { op: "add_node", id: "n.gw", label: "Gateway", x: 0, y: 0 },
      { op: "add_node", id: "n.auth", label: "Auth", x: 0, y: 0 },
      { op: "add_node", id: "n.api", label: "API", x: 0, y: 0 },
      { op: "add_node", id: "n.db", label: "Database", x: 0, y: 0 },
      { op: "add_edge", source: "n.client", target: "n.gw", label: "HTTPS" },
      { op: "add_edge", source: "n.gw", target: "n.auth", label: "Verify" },
      { op: "add_edge", source: "n.gw", target: "n.api", label: "Route" },
      { op: "add_edge", source: "n.api", target: "n.db", label: "Query" },
    ],
  })
);
assert("arrange setup ops ok", stacked && stacked.ok === true,
  JSON.stringify(stacked && stacked.error));
assert("stacked nodes lint as overlapping",
  stacked && stacked.lint && stacked.lint.some((w) => /^Overlap/.test(w)),
  JSON.stringify(stacked && stacked.lint));

const syncA2 = parseResult(await tools.drawio_sync());
assert("sync before arrange", syncA2 && syncA2.userDiff !== undefined);
const arranged = parseResult(
  await tools.drawio_arrange({ algorithm: "layered", direction: "DOWN" })
);
assert("drawio_arrange succeeds", arranged && arranged.ok === true,
  JSON.stringify(arranged && arranged.error));
assert("arrange reports the ELK algorithm used", arranged && arranged.algorithm === "elkLayered",
  JSON.stringify(arranged && arranged.algorithm));

const arrangedCanon = await liveCanonical();
const gA = {};
["n.client", "n.gw", "n.auth", "n.api", "n.db"].forEach((id) => (gA[id] = cellGeom(arrangedCanon, id)));
assert("arrange: every node has geometry", Object.values(gA).every(Boolean),
  arrangedCanon.slice(0, 400));

if (Object.values(gA).every(Boolean)) {
  assert("arrange: nodes are no longer stacked",
    new Set(Object.values(gA).map((g) => g.x + "," + g.y)).size === 5,
    JSON.stringify(gA));
  assert("arrange: DOWN direction puts the flow on the Y axis",
    gA["n.client"].y < gA["n.gw"].y && gA["n.gw"].y < gA["n.api"].y &&
      gA["n.api"].y < gA["n.db"].y,
    JSON.stringify({ client: gA["n.client"].y, gw: gA["n.gw"].y, api: gA["n.api"].y, db: gA["n.db"].y }));
  assert("arrange: preserveOrigin kept the diagram off the far corner",
    gA["n.client"].x > -200 && gA["n.client"].y > -200,
    "diagram drifted to ELK's near-(0,0) packing: " + JSON.stringify(gA["n.client"]));
}
assert("arrange: overlaps are gone",
  arranged && Array.isArray(arranged.lint) && !arranged.lint.some((w) => /^Overlap/.test(w)),
  JSON.stringify(arranged && arranged.lint));
assert("arrange: warns that it moved everything",
  arranged && /re-placed/.test(arranged.note || ""), JSON.stringify(arranged && arranged.note));

// ---- Test 19: both layout tools respect the sync gate ----
//
// They mutate the canvas outside the ops pipeline, so they need the same gate
// drawio_ops has. It would be easy to add a tool and forget it.

console.log("\n--- Test 19: layout tools are gated ---");
await tools.drawio_begin_turn();
const ungatedRoute = parseResult(await tools.drawio_route());
assert("drawio_route without sync is refused",
  ungatedRoute && (ungatedRoute.__error || /drawio_sync/.test(ungatedRoute.error || "")),
  JSON.stringify(ungatedRoute));
const ungatedArrange = parseResult(await tools.drawio_arrange({}));
assert("drawio_arrange without sync is refused",
  ungatedArrange && (ungatedArrange.__error || /drawio_sync/.test(ungatedArrange.error || "")),
  JSON.stringify(ungatedArrange));

const syncG = parseResult(await tools.drawio_sync());
assert("sync re-opens the gate for layout tools", syncG && syncG.userDiff !== undefined);
const badAlgo = parseResult(await tools.drawio_arrange({ algorithm: "banana" }));
assert("arrange: unknown algorithm is a hard error",
  badAlgo && (badAlgo.__error || /Unknown algorithm/.test(badAlgo.error || "")),
  JSON.stringify(badAlgo));

// ---- Test 20: layout lint catches what structure verification cannot ----

console.log("\n--- Test 20: layout lint ---");
await freshPage("lint-test");
const syncLint = parseResult(await tools.drawio_sync());
assert("sync before lint test", syncLint && syncLint.userDiff !== undefined);
const lintRes = parseResult(
  await tools.drawio_ops({
    ops: [
      // Explicit narrow width defeats add_node's auto-sizing, which is the only
      // way a clipped label reaches the canvas now.
      { op: "add_node", id: "n.clip", label: "A Deliberately Overlong Label", x: 1600, y: 100, w: 80, h: 60 },
      { op: "add_node", id: "n.ovl_a", label: "Overlap A", x: 1600, y: 400, w: 160, h: 60 },
      { op: "add_node", id: "n.ovl_b", label: "Overlap B", x: 1640, y: 420, w: 160, h: 60 },
    ],
  })
);
assert("lint ops succeed (warnings do not block)", lintRes && lintRes.ok === true,
  JSON.stringify(lintRes && lintRes.error));
assert("lint: clipped label reported",
  lintRes && lintRes.lint && lintRes.lint.some((w) => /Label may clip.*n\.clip/.test(w)),
  JSON.stringify(lintRes && lintRes.lint));
assert("lint: overlap reported",
  lintRes && lintRes.lint && lintRes.lint.some((w) => /^Overlap/.test(w)),
  JSON.stringify(lintRes && lintRes.lint));
assert("lint: verified is still true (structure was fine)", lintRes && lintRes.verified === true,
  "a clean structural push with an ugly layout must still report verified — that " +
  "gap is precisely why lint exists");

// ---- Test 21: semantic palette via `role` ----

console.log("\n--- Test 21: role palette ---");
const syncRole = parseResult(await tools.drawio_sync());
assert("sync before role test", syncRole && syncRole.userDiff !== undefined);
const roleRes = parseResult(
  await tools.drawio_ops({
    ops: [
      { op: "add_node", id: "n.role_c", label: "Compute", x: 2000, y: 100, role: "compute" },
      { op: "add_node", id: "n.role_s", label: "Storage", x: 2000, y: 300, role: "storage", preset: "aws s3" },
    ],
  })
);
assert("role ops ok", roleRes && roleRes.ok === true, JSON.stringify(roleRes && roleRes.error));
const roleCanon = await liveCanonical();
assert("role: compute resolves to the palette blue",
  /fillColor=#dae8fc/.test(cellLine(roleCanon, "n.role_c") || ""),
  cellLine(roleCanon, "n.role_c"));
assert("role: composes with preset (icon kept, colour applied)",
  /shape=mxgraph\.aws4\.bucket/.test(cellLine(roleCanon, "n.role_s") || "") &&
    /fillColor=#ffe6cc/.test(cellLine(roleCanon, "n.role_s") || ""),
  cellLine(roleCanon, "n.role_s"));
assert("role: preset echoed as resolvedShape",
  roleRes && roleRes.report && roleRes.report.some((r) => r.resolvedShape),
  JSON.stringify(roleRes && roleRes.report));

const syncRole2 = parseResult(await tools.drawio_sync());
const badRole = parseResult(
  await tools.drawio_ops({
    ops: [{ op: "add_node", id: "n.role_x", label: "Nope", x: 0, y: 0, role: "banana" }],
  })
);
assert("role: unknown role is a hard error, not a silent default",
  badRole && (badRole.__error || /Unknown role/.test(badRole.error || "")),
  JSON.stringify(badRole));

// ---- Test 22: set_style merges by default ----

console.log("\n--- Test 22: set_style merge semantics ---");
const syncStyle = parseResult(await tools.drawio_sync());
assert("sync before style test", syncStyle && syncStyle.userDiff !== undefined);
const styleRes = parseResult(
  await tools.drawio_ops({
    ops: [{ op: "set_style", id: "n.role_s", style: "fillColor=#f8cecc;" }],
  })
);
assert("set_style ok", styleRes && styleRes.ok === true, JSON.stringify(styleRes && styleRes.error));
const styleCanon = await liveCanonical();
assert("set_style: recolour keeps the shape",
  /shape=mxgraph\.aws4\.bucket/.test(cellLine(styleCanon, "n.role_s") || "") &&
    /fillColor=#f8cecc/.test(cellLine(styleCanon, "n.role_s") || ""),
  "a replace-by-default set_style silently turns a vendor icon into a plain box: " +
    cellLine(styleCanon, "n.role_s"));

// ---- Test 23: hand-routed edge waypoints ----

console.log("\n--- Test 23: add_edge points ---");
const syncPts = parseResult(await tools.drawio_sync());
assert("sync before points test", syncPts && syncPts.userDiff !== undefined);
const ptsRes = parseResult(
  await tools.drawio_ops({
    ops: [
      { op: "add_edge", id: "e.routed", source: "n.role_c", target: "n.role_s",
        label: "routed", points: [{ x: 2400, y: 200 }, { x: 2400, y: 260 }] },
    ],
  })
);
assert("add_edge with points ok", ptsRes && ptsRes.ok === true, JSON.stringify(ptsRes && ptsRes.error));
const ptsCanon = await liveCanonical();
assert("add_edge: waypoints survive the round trip",
  /^E e\.routed .*pts=\[2400,200;2400,260\]/m.test(ptsCanon),
  cellLine(ptsCanon, "e.routed") || "e.routed missing");

// ---- Test 23b: edge labels are movable, and the lint measures where they are ----
//
// The lint used to place an edge label at the midpoint between the two ENDPOINT
// CENTRES, which is only where it is for a straight two-point edge. Once an
// edge has waypoints the label moves to the midpoint of the routed PATH, so the
// check reported clean on exactly the labels that had been pushed onto a shape.
// This drags an edge's path over a third node and asserts the collision is seen.

console.log("\n--- Test 23b: edge label position and set_edge_label ---");
const syncLbl = parseResult(await tools.drawio_sync());
assert("sync before label test", syncLbl && syncLbl.userDiff !== undefined);
const lblRes = parseResult(
  await tools.drawio_ops({
    ops: [
      { op: "add_node", id: "n.lbl_a", label: "Top", x: 3000, y: 100 },
      { op: "add_node", id: "n.lbl_b", label: "Bottom", x: 3000, y: 900 },
      { op: "add_node", id: "n.lbl_c", label: "In The Way", x: 3400, y: 480 },
      // Waypoint drags the path over n.lbl_c; the label follows the path.
      { op: "add_edge", id: "e.lbl", source: "n.lbl_a", target: "n.lbl_b",
        label: "SQL Queries", points: [{ x: 3500, y: 510 }] },
    ],
  })
);
assert("label-collision ops ok", lblRes && lblRes.ok === true,
  JSON.stringify(lblRes && lblRes.error));
assert("lint: routed edge label on a third shape is reported",
  lblRes && lblRes.lint && lblRes.lint.some((w) => /Edge label "SQL Queries".*sits on .*n\.lbl_c/.test(w)),
  "the endpoint-centre midpoint is (3080, 530+) and misses n.lbl_c entirely — " +
  "if this does not fire, the lint is still measuring the wrong point: " +
  JSON.stringify(lblRes && lblRes.lint));

const syncLbl2 = parseResult(await tools.drawio_sync());
assert("sync before label fix", syncLbl2 && syncLbl2.userDiff !== undefined);
const lblFix = parseResult(
  await tools.drawio_ops({
    ops: [{ op: "set_edge_label", id: "e.lbl", dy: -120, background: true }],
  })
);
assert("set_edge_label ok", lblFix && lblFix.ok === true, JSON.stringify(lblFix && lblFix.error));
assert("set_edge_label clears the collision it was suggested for",
  lblFix && lblFix.lint && !lblFix.lint.some((w) => /Edge label "SQL Queries".*sits on/.test(w)),
  JSON.stringify(lblFix && lblFix.lint));
const lblCanon = await liveCanonical();
assert("set_edge_label: background merged, shape style intact",
  /labelBackgroundColor=#ffffff/.test(cellLine(lblCanon, "e.lbl") || ""),
  cellLine(lblCanon, "e.lbl"));

// set_edge_points must be able to re-route an edge that already exists —
// previously `points` was accepted only by add_edge, so the lint's own advice
// ("add waypoints") was impossible to follow without deleting the edge.
const syncPts2 = parseResult(await tools.drawio_sync());
assert("sync before set_edge_points", syncPts2 && syncPts2.userDiff !== undefined);
const reroute = parseResult(
  await tools.drawio_ops({
    ops: [{ op: "set_edge_points", id: "e.lbl", points: [{ x: 2900, y: 500 }] }],
  })
);
assert("set_edge_points ok", reroute && reroute.ok === true, JSON.stringify(reroute && reroute.error));
assert("set_edge_points: waypoints replaced on the live canvas",
  /^E e\.lbl .*pts=\[2900,500\]/m.test(await liveCanonical()),
  cellLine(await liveCanonical(), "e.lbl"));

const syncPts3 = parseResult(await tools.drawio_sync());
const cleared = parseResult(
  await tools.drawio_ops({ ops: [{ op: "set_edge_points", id: "e.lbl", points: [] }] })
);
assert("set_edge_points: empty array restores automatic routing",
  cleared && cleared.ok === true && !/pts=\[/.test(cellLine(await liveCanonical(), "e.lbl") || ""),
  cellLine(await liveCanonical(), "e.lbl"));

const syncPts4 = parseResult(await tools.drawio_sync());
const badTarget = parseResult(
  await tools.drawio_ops({ ops: [{ op: "set_edge_label", id: "n.lbl_a", dy: 10 }] })
);
assert("set_edge_label refuses a vertex",
  badTarget && (badTarget.__error || /not an edge/.test(badTarget.error || "")),
  JSON.stringify(badTarget));

// ---- Test 23c: connector anchors, resize_to_fit, and label occlusion ----
//
// Anchors were the last thing about a diagram the model could not express: it
// could say WHICH shapes an edge joins and WHERE the line bends, never which
// side of the box it leaves from. draw.io then picks a floating attachment per
// edge, which is how a symmetric pair of boxes ends up with asymmetric wiring.

console.log("\n--- Test 23c: set_edge_anchor / resize_to_fit / occlusion ---");
const syncAnc = parseResult(await tools.drawio_sync());
assert("sync before anchor test", syncAnc && syncAnc.userDiff !== undefined);
const ancRes = parseResult(
  await tools.drawio_ops({
    ops: [
      { op: "add_node", id: "n.anc_db", label: "Primary", x: 4000, y: 100 },
      { op: "add_node", id: "n.anc_r1", label: "Replica 1", x: 3800, y: 400 },
      { op: "add_node", id: "n.anc_r2", label: "Replica 2", x: 4300, y: 400 },
      { op: "add_edge", id: "e.anc_1", source: "n.anc_db", target: "n.anc_r1",
        exit: "bottom", exitAt: 0.25, entry: "top" },
      { op: "add_edge", id: "e.anc_2", source: "n.anc_db", target: "n.anc_r2",
        exit: "bottom", exitAt: 0.75, entry: "top" },
    ],
  })
);
assert("anchor ops ok", ancRes && ancRes.ok === true, JSON.stringify(ancRes && ancRes.error));
const ancCanon = await liveCanonical();
assert("add_edge: exit anchor slides along the named side",
  /exitX=0.25/.test(cellLine(ancCanon, "e.anc_1") || "") &&
    /exitX=0.75/.test(cellLine(ancCanon, "e.anc_2") || ""),
  cellLine(ancCanon, "e.anc_1") + " || " + cellLine(ancCanon, "e.anc_2"));
assert("add_edge: exitY pins to the bottom edge and Dx/Dy are zeroed",
  /exitY=1/.test(cellLine(ancCanon, "e.anc_1") || "") &&
    /exitDx=0/.test(cellLine(ancCanon, "e.anc_1") || ""),
  cellLine(ancCanon, "e.anc_1"));

const syncAnc2 = parseResult(await tools.drawio_sync());
const ancFix = parseResult(
  await tools.drawio_ops({
    ops: [{ op: "set_edge_anchor", id: "e.anc_1", exit: "left" }],
  })
);
assert("set_edge_anchor ok", ancFix && ancFix.ok === true, JSON.stringify(ancFix && ancFix.error));
const ancCanon2 = await liveCanonical();
assert("set_edge_anchor replaces rather than accumulating keys",
  /exitX=0;/.test(cellLine(ancCanon2, "e.anc_1") || "") &&
    !/exitX=0.25/.test(cellLine(ancCanon2, "e.anc_1") || ""),
  cellLine(ancCanon2, "e.anc_1"));

const syncAnc3 = parseResult(await tools.drawio_sync());
const ancAuto = parseResult(
  await tools.drawio_ops({ ops: [{ op: "set_edge_anchor", id: "e.anc_1", exit: "auto" }] })
);
assert("exit:auto releases the pin but leaves entry alone",
  ancAuto && ancAuto.ok === true &&
    !/exitX/.test(cellLine(await liveCanonical(), "e.anc_1") || "") &&
    /entryX=0.5/.test(cellLine(await liveCanonical(), "e.anc_1") || ""),
  cellLine(await liveCanonical(), "e.anc_1"));

// resize_to_fit: the sizing rule add_node already uses, exposed as an op.
const syncFit = parseResult(await tools.drawio_sync());
const fitRes = parseResult(
  await tools.drawio_ops({
    ops: [
      { op: "add_node", id: "n.fit", label: "Short", x: 4700, y: 100, w: 80, h: 60 },
      { op: "set_label", id: "n.fit", label: "A Considerably Longer Name" },
      { op: "resize_to_fit", id: "n.fit" },
    ],
  })
);
assert("resize_to_fit ok", fitRes && fitRes.ok === true, JSON.stringify(fitRes && fitRes.error));
assert("resize_to_fit: no clipped-label warning survives",
  fitRes && fitRes.lint && !fitRes.lint.some((w) => /Label may clip.*n\.fit/.test(w)),
  JSON.stringify(fitRes && fitRes.lint));
assert("resize_to_fit: reports the width it chose",
  fitRes && fitRes.report && fitRes.report.some((r) => r.op === "resize_to_fit" && r.w > 80),
  JSON.stringify(fitRes && fitRes.report));

// Occlusion: a label wider than the drawn connector, with a painted background,
// covers the arrow completely. This produced a diagram whose side connectors
// were entirely invisible while every structural check reported success.
const syncOcc = parseResult(await tools.drawio_sync());
const occRes = parseResult(
  await tools.drawio_ops({
    ops: [
      { op: "add_node", id: "n.occ_a", label: "Gateway", x: 5000, y: 100, w: 240, h: 60 },
      { op: "add_node", id: "n.occ_b", label: "Auth", x: 5300, y: 100, w: 180, h: 60 },
      { op: "add_edge", id: "e.occ", source: "n.occ_a", target: "n.occ_b",
        label: "Validate Token", style: "edgeStyle=orthogonalEdgeStyle;labelBackgroundColor=#ffffff;" },
    ],
  })
);
assert("occlusion ops ok", occRes && occRes.ok === true, JSON.stringify(occRes && occRes.error));
assert("lint: label wider than the visible connector is reported",
  occRes && occRes.lint && occRes.lint.some((w) => /of the connector is visible/.test(w)),
  JSON.stringify(occRes && occRes.lint));
assert("lint: a painted background over a hidden arrow is named as such",
  occRes && occRes.lint && occRes.lint.some((w) => /arrow is invisible/.test(w)),
  "background over a short edge hides the line entirely; the warning has to say " +
  "so or the model will keep reaching for it: " + JSON.stringify(occRes && occRes.lint));

// The directive now ships from the MCP, not the guardrail — a guardrail can be
// a stale build, and this is the message that decides which fix gets chosen.
assert("lint carries its directive from the MCP itself",
  occRes && typeof occRes.lintDirective === "string" &&
    /set_edge_anchor/.test(occRes.lintDirective),
  JSON.stringify(occRes && occRes.lintDirective));

// ---- Test 24: history is retrievable, and revert actually works ----
//
// drawio_history used to report hasXml:true on every entry with no tool
// anywhere that would return that XML, while SKILL.md told the model to revert
// by passing a previous turn's XML to drawio_apply. Nothing in the old suite
// noticed, because it only asserted that the list was an array.

console.log("\n--- Test 24: history + revert round trip ---");
const histList = parseResult(await tools.drawio_history());
assert("history: entries carry an index", histList && histList.turns && histList.turns.length > 0 &&
  typeof histList.turns[0].index === "number", JSON.stringify(histList && histList.turns));

// The entry recorded by Test 23c: n.anc_db exists, the later n.occ_a nodes do not.
const layoutEntry = histList && histList.turns && histList.turns.find((t) => /add_node n\.anc_db/.test(t.summary));
assert("history: an earlier turn is findable by summary", !!layoutEntry,
  JSON.stringify(histList && histList.turns && histList.turns.map((t) => t.summary)));

if (layoutEntry) {
  const snap = parseResult(await tools.drawio_history({ index: layoutEntry.index, xml: true }));
  assert("history: xml:true returns a document",
    snap && typeof snap.xml === "string" && snap.xml.includes("mxfile"),
    JSON.stringify(snap && (snap.error || Object.keys(snap))));

  if (snap && snap.xml) {
    const beforeRevert = await liveCanonical();
    assert("pre-revert: later cells are on the canvas", hasCell(beforeRevert, "n.occ_a"));

    const syncRev = parseResult(await tools.drawio_sync());
    assert("sync before revert", syncRev && syncRev.userDiff !== undefined);
    const revertRes = parseResult(await tools.drawio_apply({ xml: snap.xml }));
    assert("revert: apply succeeds", revertRes && revertRes.ok === true,
      JSON.stringify(revertRes && revertRes.error));

    const afterRevert = await liveCanonical();
    assert("revert: the old state is back ON CANVAS", hasCell(afterRevert, "n.anc_db"),
      afterRevert.slice(0, 300));
    assert("revert: cells added after that turn are gone", !hasCell(afterRevert, "n.occ_a"),
      "revert did not roll the document back");
  }
}

const histBad = parseResult(await tools.drawio_history({ index: 999, xml: true }));
assert("history: out-of-range index errors instead of returning nothing",
  histBad && (histBad.__error || /No history entry/.test(histBad.error || "")),
  JSON.stringify(histBad));

// ---- Test 25: drift detection ----
//
// Drift needs a canvas edit that does NOT go through the MCP — i.e. a real user
// action. A skill script has no tool that can mutate the canvas out-of-band, so
// this is attempted through evaluateScript and reported as SKIPPED when that is
// unavailable rather than quietly passing. A skipped test is not a passing one:
// until this runs, `checkDrift` is only covered by reasoning.

console.log("\n--- Test 25: drift detection ---");
let driftTested = false;
try {
  const syncD = parseResult(await tools.drawio_sync());
  if (syncD && syncD.userDiff !== undefined && typeof tools.evaluateScript === "function") {
    // Post a merge straight at the canvas iframe, behind the Operator's back.
    const userEdit =
      '(document, __ctx, args) => {' +
      '  var b = window.__koiDrawio;' +
      '  if (!b || !b.frame) return { ok: false, reason: "no bridge" };' +
      '  b.frame.contentWindow.postMessage(JSON.stringify({' +
      '    action: "merge",' +
      '    xml: args.xml' +
      '  }), "*");' +
      '  return { ok: true };' +
      '}';
    const liveNow = parseResult(await tools.drawio_get({ what: "live" }));
    const mutated = (liveNow.text || "").replace(
      "</root>",
      '<mxCell id="user.drag" value="User Added" vertex="1" parent="1">' +
        '<mxGeometry x="2800" y="80" width="120" height="60" as="geometry"/></mxCell></root>'
    );
    await tools.evaluateScript({ code: userEdit, args: { xml: mutated }, world: "MAIN" });
    await tools.sleep(1500); // let the autosave land and bump rev

    const drifted = parseResult(
      await tools.drawio_ops({ ops: [{ op: "set_label", id: "n.clip", label: "Should Be Blocked" }] })
    );
    driftTested = true;
    assert("drift: edit during the turn is refused",
      drifted && drifted.status === "drifted", JSON.stringify(drifted));
    assert("drift: the user's cell was not overwritten",
      hasCell(await liveCanonical(), "user.drag"),
      "the push went through and clobbered the user's edit");

    const resync = parseResult(await tools.drawio_sync());
    assert("drift: re-sync surfaces the user's cell in userDiff",
      resync && resync.userDiff && resync.userDiff.added &&
        resync.userDiff.added.some((a) => a.id === "user.drag"),
      JSON.stringify(resync && resync.userDiff));
    const afterResync = parseResult(
      await tools.drawio_ops({ ops: [{ op: "set_label", id: "n.clip", label: "Allowed After Resync" }] })
    );
    assert("drift: edits resume after re-sync", afterResync && afterResync.ok === true,
      JSON.stringify(afterResync && afterResync.error));
  }
} catch (e) {
  console.log("drift test error: " + (e.message || e));
}
if (!driftTested) {
  results.push("⏭️  SKIPPED: drift detection (no out-of-band canvas mutation available)");
  console.log("⏭️  SKIPPED: drift detection — needs evaluateScript to simulate a user edit. " +
    "checkDrift and the guardrail's needsResync latch are UNCOVERED.");
}

// ---- Test 26: pages — the document, and the view ----
//
// Two things that are easy to conflate: which pages exist (XML, edited by ops)
// and which one is on screen (not in the XML at all). The regression this
// block exists for is the third assertion group: editing a page you are not
// looking at, without being thrown back to page 1 by the load that a page-set
// change forces.

console.log("\n--- Test 26: pages ---");
let pageSwitchWorks = true;

// Seed a cell of our own on the first page. Nothing from the earlier tests can
// be assumed to still be there: freshPage() replaces the whole document, and
// the last one ran at Test 20. Asserting on a cell from Test 2 would report
// "the batch clobbered the first page" for a document that was legitimately
// reset five tests ago.
parseResult(await tools.drawio_sync());
const pgSeed = parseResult(
  await tools.drawio_ops({
    ops: [{ op: "add_node", id: "n.pg_seed", label: "Page One", x: 600, y: 600 }],
  })
);
assert("pages: seeded a cell on the first page", pgSeed && pgSeed.ok === true,
  JSON.stringify(pgSeed && pgSeed.error));

const pgAdd = parseResult(
  await tools.drawio_ops({
    ops: [
      { op: "add_page", id: "page-arch", name: "Architecture" },
      { op: "add_page", id: "page-data", name: "Data" },
    ],
  })
);
assert("pages: two pages added in one batch", pgAdd && pgAdd.ok === true,
  JSON.stringify(pgAdd && pgAdd.error));
assert("pages: add_page reports the created id", pgAdd && pgAdd.report &&
  pgAdd.report.some((r) => r.op === "add_page" && r.id === "page-arch"),
  JSON.stringify(pgAdd && pgAdd.report));

const pgList = parseResult(await tools.drawio_pages());
// The first page's id is whatever the last freshPage() left behind, so read it
// rather than assuming "page-1" — and read it now, before move_page reorders.
const pgFirstId = (pgList && pgList.pages && pgList.pages[0] && pgList.pages[0].id) || "";
assert("pages: drawio_pages lists them", pgList && Array.isArray(pgList.pages) &&
  pgList.pages.some((p) => p.id === "page-arch") &&
  pgList.pages.some((p) => p.id === "page-data"),
  JSON.stringify(pgList && pgList.pages));
assert("pages: names come back", pgList && pgList.pages &&
  (pgList.pages.find((p) => p.id === "page-arch") || {}).name === "Architecture",
  JSON.stringify(pgList && pgList.pages));

// --- Editing a page WITHOUT switching to it.
parseResult(await tools.drawio_sync());
const pgEdit = parseResult(
  await tools.drawio_ops({
    page: "Architecture",
    ops: [
      { op: "add_node", id: "n.arch_a", label: "Service A", x: 40, y: 40 },
      { op: "add_node", id: "n.arch_b", label: "Service B", x: 40, y: 200 },
      { op: "add_edge", id: "e.arch_ab", source: "n.arch_a", target: "n.arch_b" },
    ],
  })
);
assert("pages: ops scoped by page name succeed", pgEdit && pgEdit.ok === true,
  JSON.stringify(pgEdit && pgEdit.error));
const pgCanon1 = await liveCanonical();
assert("pages: the cells landed ON page-arch", cellPage(pgCanon1, "n.arch_a") === "page-arch",
  "n.arch_a is on " + cellPage(pgCanon1, "n.arch_a"));
assert("pages: the edge landed on page-arch too",
  cellPage(pgCanon1, "e.arch_ab") === "page-arch",
  "e.arch_ab is on " + cellPage(pgCanon1, "e.arch_ab"));
// The real check on the push path: a scoped edit reaches page-arch through
// `merge`, which reconciles the WHOLE document. Every other page has to come
// out of it untouched.
assert("pages: the first page's cells were not disturbed",
  cellPage(pgCanon1, "n.pg_seed") === pgFirstId,
  "n.pg_seed is on " + cellPage(pgCanon1, "n.pg_seed") + ", expected " + pgFirstId);

// --- A batch may cross pages.
parseResult(await tools.drawio_sync());
const pgCross = parseResult(
  await tools.drawio_ops({
    page: "page-arch",
    ops: [
      { op: "add_node", id: "n.arch_c", label: "Service C", x: 300, y: 40 },
      { op: "add_node", id: "n.data_a", label: "Orders", x: 40, y: 40, page: "Data" },
    ],
  })
);
assert("pages: cross-page batch succeeds", pgCross && pgCross.ok === true,
  JSON.stringify(pgCross && pgCross.error));
const pgCanon2 = await liveCanonical();
assert("pages: per-op page overrides the batch page",
  cellPage(pgCanon2, "n.arch_c") === "page-arch" &&
  cellPage(pgCanon2, "n.data_a") === "page-data",
  "n.arch_c=" + cellPage(pgCanon2, "n.arch_c") + " n.data_a=" + cellPage(pgCanon2, "n.data_a"));

// --- Switching the view.
const pgSelect = parseResult(await tools.drawio_pages({ select: "Data" }));
if (pgSelect && pgSelect.error && /does not report the selected page/.test(pgSelect.error)) {
  pageSwitchWorks = false;
  results.push("⏭️  SKIPPED: page switching (this draw.io build reports no currentPage)");
  console.log("⏭️  SKIPPED: page switching — build does not report currentPage.");
} else {
  assert("pages: select brings a page on screen", pgSelect && pgSelect.ok === true,
    JSON.stringify(pgSelect && pgSelect.error));
  assert("pages: the active page is the one selected",
    pgSelect && pgSelect.active && pgSelect.active.id === "page-data",
    JSON.stringify(pgSelect && pgSelect.active));
}

if (pageSwitchWorks) {
  // --- Unscoped ops follow the user's eyes, not page 1.
  parseResult(await tools.drawio_sync());
  const pgDefault = parseResult(
    await tools.drawio_ops({
      ops: [{ op: "add_node", id: "n.data_b", label: "Invoices", x: 300, y: 40 }],
    })
  );
  assert("pages: unscoped ops succeed", pgDefault && pgDefault.ok === true,
    JSON.stringify(pgDefault && pgDefault.error));
  assert("pages: unscoped ops land on the VISIBLE page",
    cellPage(await liveCanonical(), "n.data_b") === "page-data",
    "landed on " + cellPage(await liveCanonical(), "n.data_b"));

  // --- The regression: a page-set change forces `load`, and setFileData
  //     selects page 0 on every load. The user must stay where they were.
  parseResult(await tools.drawio_sync());
  const pgAdd2 = parseResult(
    await tools.drawio_ops({ ops: [{ op: "add_page", id: "page-notes", name: "Notes" }] })
  );
  assert("pages: add_page during a session succeeds", pgAdd2 && pgAdd2.ok === true,
    JSON.stringify(pgAdd2 && pgAdd2.error));
  assert("pages: add_page went through load", pgAdd2 && pgAdd2.pushMethod === "load",
    "pushMethod was " + (pgAdd2 && pgAdd2.pushMethod));
  const pgAfterLoad = parseResult(await tools.drawio_pages());
  assert("pages: the visible page SURVIVES the load a page-set change forces",
    pgAfterLoad && pgAfterLoad.active && pgAfterLoad.active.id === "page-data",
    "after the load the canvas is showing " +
      JSON.stringify(pgAfterLoad && pgAfterLoad.active));

  // --- Rendering a page brings it on screen.
  const pgRender = parseResult(await tools.drawio_render({ format: "svg", page: "Architecture" }));
  assert("pages: drawio_render({page}) renders and selects that page",
    pgRender && pgRender.page && pgRender.page.id === "page-arch",
    JSON.stringify(pgRender && (pgRender.error || pgRender.page)));
}

// --- Page CRUD: rename, duplicate (with id remapping), move, delete.
parseResult(await tools.drawio_sync());
const pgRename = parseResult(
  await tools.drawio_ops({ ops: [{ op: "rename_page", page: "page-notes", name: "Scratch" }] })
);
if (pgRename && pgRename.ok) {
  const renamed = parseResult(await tools.drawio_pages());
  assert("pages: rename_page renames", renamed && renamed.pages &&
    (renamed.pages.find((p) => p.id === "page-notes") || {}).name === "Scratch",
    JSON.stringify(renamed && renamed.pages));
} else {
  assert("pages: rename_page renames", false, JSON.stringify(pgRename && pgRename.error));
}

parseResult(await tools.drawio_sync());
const pgDup = parseResult(
  await tools.drawio_ops({
    ops: [{ op: "duplicate_page", page: "page-arch", newId: "page-arch2", name: "Architecture v2" }],
  })
);
assert("pages: duplicate_page succeeds", pgDup && pgDup.ok === true,
  JSON.stringify(pgDup && pgDup.error));
const pgCanon3 = await liveCanonical();
assert("pages: the copy's cells got fresh ids (no duplicates across pages)",
  hasCell(pgCanon3, "n.arch_a") && hasCell(pgCanon3, "n.arch_a-page-arch2"),
  "original or remapped copy missing");
assert("pages: the copy's cells are on the copy",
  cellPage(pgCanon3, "n.arch_a-page-arch2") === "page-arch2",
  "copy cell is on " + cellPage(pgCanon3, "n.arch_a-page-arch2"));

parseResult(await tools.drawio_sync());
const pgMove = parseResult(
  await tools.drawio_ops({ ops: [{ op: "move_page", page: "page-arch", to: 0 }] })
);
assert("pages: move_page reorders", pgMove && pgMove.ok === true,
  JSON.stringify(pgMove && pgMove.error));
const pgMoved = parseResult(await tools.drawio_pages());
assert("pages: the moved page is first now",
  pgMoved && pgMoved.pages && pgMoved.pages[0] && pgMoved.pages[0].id === "page-arch",
  JSON.stringify(pgMoved && pgMoved.pages));

parseResult(await tools.drawio_sync());
const pgDel = parseResult(
  await tools.drawio_ops({ ops: [{ op: "delete_page", page: "Architecture v2" }] })
);
assert("pages: delete_page succeeds", pgDel && pgDel.ok === true,
  JSON.stringify(pgDel && pgDel.error));
assert("pages: the deleted page is gone from the canvas",
  !/^P page-arch2 /m.test(await liveCanonical()), "page-arch2 is still there");

// --- Bad references fail loudly, and name the pages that do exist.
parseResult(await tools.drawio_sync());
const pgBad = parseResult(
  await tools.drawio_ops({ ops: [{ op: "add_node", id: "n.nowhere", label: "X", x: 0, y: 0 }], page: "No Such Page" })
);
assert("pages: an unknown page reference is an error",
  (pgBad && pgBad.error) || (pgBad && pgBad.__error), JSON.stringify(pgBad));
assert("pages: the error lists the pages that do exist",
  pgBad && String(pgBad.error || pgBad.message || "").indexOf("Pages:") !== -1,
  JSON.stringify(pgBad && (pgBad.error || pgBad.message)));

// --- The last page cannot be deleted.
const pgSingle = await freshPage("Single Page");
if (pgSingle && pgSingle.success) {
  parseResult(await tools.drawio_sync());
  const pgDelLast = parseResult(
    await tools.drawio_ops({ ops: [{ op: "delete_page", page: 0 }] })
  );
  assert("pages: deleting the only page is refused",
    (pgDelLast && pgDelLast.error) || (pgDelLast && pgDelLast.__error),
    JSON.stringify(pgDelLast));
} else {
  results.push("⏭️  SKIPPED: delete-the-only-page guard (could not reset the canvas)");
}

// ---- Summary ----

console.log("\n========================================");
const skipped = results.filter((r) => r.indexOf("SKIPPED") !== -1).length;
console.log("  RESULTS: " + pass + " passed, " + fail + " failed" +
  (skipped ? ", " + skipped + " skipped" : ""));
console.log("========================================\n");

return {
  success: fail === 0,
  pass,
  fail,
  skipped,
  total: pass + fail,
  results,
};
}
return run();
