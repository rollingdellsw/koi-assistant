const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../mcp/osd_mcp.js", "utf8");

let failures = 0;
const check = (c, m) => { if (!c) { failures++; console.log("FAIL:", m); } };

// --- fake page state: two viewers, index 1 focused ---
const state = {
  viewers: [
    { index: 0, id: "w1", title: "slide-a.svs", selector: "#w1", focused: false, ready: true },
    { index: 1, id: "w2", title: "slide-b.svs", selector: "#w2", focused: true, ready: true },
  ],
  zoom: [1, 1],
  center: [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }],
  calls: [],
};
const focusIndex = () => state.viewers.findIndex((v) => v.focused);
const handleToIndex = { h_0: 0, h_1: 1 };

const runtime = {
  console,
  async evaluateScript(code, args) {
    // Distinguish the two page scripts by a substring unique to each.
    if (code.includes("listOnly")) {
      const fi = focusIndex();
      if (args.listOnly) return { result: { viewers: state.viewers, focusIndex: fi } };
      let index = fi;
      const want = args.viewer;
      if (want !== null && want !== undefined && want !== "") {
        index = state.viewers.findIndex(
          (v) => v.id === want || v.selector === want || v.title === want,
        );
        if (index === -1 && /^[0-9]+$/.test(String(want))) index = parseInt(want, 10);
        if (index < 0 || index >= state.viewers.length)
          return { result: { viewers: state.viewers, focusIndex: fi, error: "No viewer matches " + JSON.stringify(want) + "." } };
      }
      if (index === -1)
        return { result: { viewers: state.viewers, focusIndex: fi, error: "No viewer is focused and the page has 2 viewers." } };
      return { result: { viewers: state.viewers, focusIndex: fi, index, handleId: "h_" + index } };
    }
    // focus click
    const want = String(args.viewer);
    let index = state.viewers.findIndex((v) => v.id === want || v.title === want);
    if (index === -1 && /^[0-9]+$/.test(want)) index = parseInt(want, 10);
    if (index < 0 || index >= state.viewers.length) return { result: { error: "No viewer matches " + JSON.stringify(args.viewer) + "." } };
    state.viewers.forEach((v, i) => { v.focused = i === index; });
    return { result: { index, id: state.viewers[index].id } };
  },
  async invokeOnHandle(handle, method, args) {
    const i = handleToIndex[handle];
    state.calls.push({ handle, method, args });
    switch (method) {
      case "viewport.getZoom": return { result: state.zoom[i] };
      case "viewport.zoomTo": state.zoom[i] = args[0]; return { result: {} };
      case "viewport.getCenter": return { result: state.center[i] };
      case "viewport.panBy":
        state.center[i] = { x: state.center[i].x + args[0].x, y: state.center[i].y + args[0].y };
        return { result: {} };
      case "viewport.applyConstraints": return { result: {} };
      case "viewport.goHome": state.zoom[i] = 1; return { result: {} };
      case "viewport.getBounds": return { result: { x: 0, y: 0, width: 1 / state.zoom[i], height: 1 / state.zoom[i] } };
      case "viewport.getHomeZoom": return { result: 1 };
      case "viewport.getMinZoom": return { result: 0.9 };
      case "viewport.getMaxZoom": return { result: 10 };
      case "viewport.imageToViewportRectangle":
        return { result: { x: args[0] / 1000, y: args[1] / 1000, width: args[2] / 1000, height: args[3] / 1000 } };
      case "viewport.fitBoundsWithConstraints":
        state.zoom[i] = 1 / args[0].width;
        return { result: {} };
      default: return { error: "unexpected method " + method };
    }
  },
  async getFromHandle(handle, path) {
    if (path === "world._items.0.source.dimensions") return { result: { x: 1000, y: 800 } };
    return { error: "unexpected path " + path };
  },
  async releaseHandle() {},
};

const server = new Function("runtime", src)(runtime);
const out = (r) => JSON.parse(r.content[0].text);

(async () => {
  const tools = server.listTools();
  check(tools.length === 7, "exposes 7 tools, got " + tools.length);
  check(tools.every((t) => t.tier && t.description && t.inputSchema), "every tool has tier/description/schema");
  check(tools.filter((t) => t.tier === "safe").map((t) => t.name).sort().join(",") === "osd_get_status,osd_list_viewers", "read-only tools are safe tier");
  const navTools = tools.filter((t) => t.tier === "navigation").map((t) => t.name);
  check(navTools.includes("osd_zoom") && navTools.includes("osd_focus"), "mutating navigation is navigation tier");
  check(tools.filter((t) => t.name !== "osd_focus" && t.name !== "osd_list_viewers")
    .every((t) => t.inputSchema.properties.viewer), "every navigation tool accepts an optional viewer override");
  check(tools.filter((t) => t.name !== "osd_focus")
    .every((t) => !(t.inputSchema.required || []).includes("viewer")), "viewer is never required except on osd_focus");

  const list = out(await server.callTool("osd_list_viewers", {}));
  check(list.focused.id === "w2", "lists the focused viewer");

  const status = out(await server.callTool("osd_get_status", {}));
  check(status.viewer.id === "w2", "status defaults to the focused viewer");
  check(status.imageSize.width === 1000 && status.imageSize.height === 800, "reports image pixel size");
  check(status.homeZoom === 1 && status.maxZoom === 10, "reports zoom limits");

  const zoom = out(await server.callTool("osd_zoom", { level: 2, relative: true }));
  check(zoom.previousZoom === 1 && zoom.zoom === 2, "relative zoom multiplies current zoom");
  check(zoom.viewer.id === "w2", "zoom acted on the focused viewer");
  check(state.zoom[0] === 1, "the unfocused viewer was untouched");
  check(state.calls.some((c) => c.method === "viewport.applyConstraints"), "applies OSD constraints after zooming");

  const abs = out(await server.callTool("osd_zoom", { level: 4 }));
  check(abs.zoom === 4, "absolute zoom sets the level directly");

  const pan = out(await server.callTool("osd_pan", { dx: 0.1, dy: -0.2 }));
  check(Math.abs(pan.center.x - 0.6) < 1e-9 && Math.abs(pan.center.y - 0.3) < 1e-9, "pan applies the delta");
  check(pan.previousCenter.x === 0.5, "pan reports the previous center");

  const region = out(await server.callTool("osd_zoom_to_region", { x: 0.1, y: 0.2, width: 0.25, height: 0.25 }));
  const rectCall = state.calls.filter((c) => c.method === "viewport.imageToViewportRectangle").pop();
  check(rectCall.args[0] === 100 && rectCall.args[1] === 160 && rectCall.args[2] === 250,
    "region fractions are converted to image pixels: " + JSON.stringify(rectCall.args));
  check(region.region.width === 0.25, "echoes the requested region");

  const reset = out(await server.callTool("osd_reset", {}));
  check(reset.zoom === 1, "reset returns to home zoom");

  // read a background viewer without moving focus
  const bg = out(await server.callTool("osd_get_status", { viewer: "w1" }));
  check(bg.viewer.id === "w1", "explicit viewer override reads a background viewer");
  check(state.viewers[1].focused === true, "the override did not move focus");

  // move focus for real
  const moved = out(await server.callTool("osd_focus", { viewer: "slide-a.svs" }));
  check(moved.focused.id === "w1", "osd_focus moves focus by title");
  check(moved.matchedRequest === true, "reports that focus matched the request");
  const afterFocus = out(await server.callTool("osd_zoom", { level: 3 }));
  check(afterFocus.viewer.id === "w1", "navigation follows the new focus");

  // error paths
  const badFocus = await server.callTool("osd_focus", { viewer: "ghost" });
  check(badFocus.isError === true, "unknown focus target is an error");
  const badViewer = await server.callTool("osd_zoom", { level: 2, viewer: "ghost" });
  check(badViewer.isError === true, "unknown viewer override is an error");
  check(JSON.parse(badViewer.content[0].text).viewers.length === 2, "the error carries the viewer list for recovery");
  const unknown = await server.callTool("osd_nope", {});
  check(unknown.isError === true, "unknown tool name is an error");

  // ambiguous focus
  state.viewers.forEach((v) => { v.focused = false; });
  const ambiguous = await server.callTool("osd_zoom", { level: 2 });
  check(ambiguous.isError === true, "no focus with multiple viewers is an error, not a guess");

  console.log(failures === 0 ? "MCP: all assertions passed" : "MCP: " + failures + " failure(s)");
  process.exitCode = failures ? 1 : 0;
})();
