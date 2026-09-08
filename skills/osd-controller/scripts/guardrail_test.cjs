// Load the guardrail the way the extension does: as CommonJS source text.
const fs = require("fs");
const src = fs.readFileSync(
  __dirname + "/../scripts/guardrail.js",
  "utf8",
);
const mod = { exports: {} };
new Function("module", "exports", src)(mod, mod.exports);
const g = mod.exports;
let failures = 0;
const check = (c, m) => { if (!c) { failures++; console.log("FAIL:", m); } };
const okResult = { isError: false, content: "{}" };

(async () => {
  check((await g.input({ tool: { name: "takeScreenshot", args: {} } })).allowed === false, "blocks takeScreenshot");
  check((await g.input({ tool: { name: "osd_zoom", args: {} } })).allowed === true, "allows osd tools initially");

  // capture, then annotate: fine
  await g.output({ tool: { name: "createWorkspace", args: {} }, result: okResult });
  check((await g.input({ tool: { name: "addWorkspaceAnnotation", args: {} } })).allowed === true, "annotation allowed on a fresh workspace");

  // with workspace open, next zoom/pan is blocked until minimized
  const blockedZoom = await g.input({ tool: { name: "osd_zoom", args: { level: 2 } } });
  check(blockedZoom.allowed === false, "blocks zoom while workspace is open");
  check(/hideWorkspaceOverlay/.test(blockedZoom.message), "message tells agent to hideWorkspaceOverlay");

  const blockedPan = await g.input({ tool: { name: "osd_pan", args: { dx: 0.1, dy: 0 } } });
  check(blockedPan.allowed === false, "blocks pan while workspace is open");

  // minimize/hide workspace overlay -> zoom/pan allowed
  await g.output({ tool: { name: "hideWorkspaceOverlay", args: {} }, result: okResult });
  check((await g.input({ tool: { name: "osd_zoom", args: { level: 2 } } })).allowed === true, "zoom allowed after hideWorkspaceOverlay");
  check((await g.input({ tool: { name: "osd_pan", args: { dx: 0.1, dy: 0 } } })).allowed === true, "pan allowed after hideWorkspaceOverlay");

  // showWorkspaceOverlay -> blocks zoom again
  await g.output({ tool: { name: "showWorkspaceOverlay", args: {} }, result: okResult });
  check((await g.input({ tool: { name: "osd_zoom", args: { level: 2 } } })).allowed === false, "zoom blocked after showWorkspaceOverlay");
  await g.output({ tool: { name: "hideWorkspaceOverlay", args: {} }, result: okResult });

  // focus moves: the existing workspace is now stale
  await g.output({ tool: { name: "osd_focus", args: {} }, result: okResult });
  const blocked = await g.input({ tool: { name: "addWorkspaceAnnotation", args: {} } });
  check(blocked.allowed === false, "annotation blocked after focus moved");
  check(/createWorkspace/.test(blocked.message), "the block explains how to recover");

  // re-capture clears stale flag
  await g.output({ tool: { name: "createWorkspace", args: { show_overlay: false } }, result: okResult });
  check((await g.input({ tool: { name: "addWorkspaceAnnotation", args: {} } })).allowed === true, "re-capture clears the stale flag");
  check((await g.input({ tool: { name: "osd_zoom", args: {} } })).allowed === true, "zoom allowed when created with show_overlay: false");

  // a failed focus call must not mark anything stale
  await g.output({ tool: { name: "osd_focus", args: {} }, result: { isError: true, content: "{}" } });
  check((await g.input({ tool: { name: "addWorkspaceAnnotation", args: {} } })).allowed === true, "a failed osd_focus does not stale the workspace");

  // ── Regression: state is derived from THIS conversation's history, not ──
  // ── leaked across conversations (the guardrail module is cached by the   ──
  // ── sidepanel sandbox and only reset on SESSION switch, not conversation).
  const hist = (user, tail = []) => ({
    messages: [{ role: "user", content: user }, ...tail],
    lastUserMessage: user,
  });
  const call = (name, args) => ({ id: "x", type: "function", function: { name, arguments: JSON.stringify(args || {}) } });
  const toolMsg = (content, isError) =>
    isError ? { role: "tool", tool_call_id: "x", isError: true, content: JSON.stringify({ error: "boom" }) }
            : { role: "tool", tool_call_id: "x", content: content || "{}" };

  // Conversation A ends with a workspace left open (overlay on screen).
  await g.output({ tool: { name: "createWorkspace", args: {} }, result: okResult });

  // Conversation B: a fresh user message whose history contains NO capture.
  // The leaked closure state (open from A) must not block B's first action.
  const bReset = await g.input({ tool: { name: "osd_reset", args: {} }, history: hist("analyze slide B") });
  check(bReset.allowed === true, "cross-conversation: osd_reset not blocked by a prior conversation's open workspace");
  const bAnnot = await g.input({ tool: { name: "addWorkspaceAnnotation", args: {} }, history: hist("analyze slide B") });
  check(bAnnot.allowed === true, "cross-conversation: annotation not blocked by a prior conversation's focus");

  // Within one conversation, state derived from history still blocks correctly.
  const histC = hist("capture then reset", [
    { role: "assistant", content: "", tool_calls: [call("createWorkspace")] },
    toolMsg(),
  ]);
  const cReset = await g.input({ tool: { name: "osd_reset", args: {} }, history: histC });
  check(cReset.allowed === false, "within-conversation: osd_reset blocked after createWorkspace (from history)");
  check(/hideWorkspaceOverlay/.test(cReset.message), "within-conversation block names hideWorkspaceOverlay");

  // ...and unblocks once the overlay is minimized, per the same history.
  const histD = hist("capture, hide, reset", [
    { role: "assistant", content: "", tool_calls: [call("createWorkspace")] },
    toolMsg(),
    { role: "assistant", content: "", tool_calls: [call("hideWorkspaceOverlay", { imageId: "img_004" })] },
    toolMsg(),
  ]);
  check((await g.input({ tool: { name: "osd_reset", args: {} }, history: histD })).allowed === true, "within-conversation: reset allowed after hideWorkspaceOverlay (from history)");

  // show_overlay:false never counts as an open overlay.
  const histE = hist("capture headless", [
    { role: "assistant", content: "", tool_calls: [call("createWorkspace", { show_overlay: false })] },
    toolMsg(),
  ]);
  check((await g.input({ tool: { name: "osd_zoom", args: { level: 2 } }, history: histE })).allowed === true, "createWorkspace with show_overlay:false does not block zoom (from history)");

  // A FAILED createWorkspace does not open an overlay.
  const histF = hist("capture failed", [
    { role: "assistant", content: "", tool_calls: [call("createWorkspace")] },
    toolMsg(null, true),
  ]);
  check((await g.input({ tool: { name: "osd_reset", args: {} }, history: histF })).allowed === true, "a failed createWorkspace does not block navigation (from history)");

  console.log(failures === 0 ? "GUARDRAIL: all assertions passed" : "GUARDRAIL: " + failures + " failure(s)");
  process.exitCode = failures ? 1 : 0;
})();
