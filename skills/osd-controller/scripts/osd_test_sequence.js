// skills/osd-controller/scripts/osd_test_sequence.js
// Exercises the focus-aware OSD tools end to end against whatever viewers the
// current page has open. Run with a page that already has at least one image
// open, e.g. a windowed gallery with two images.

function parse(res) {
  if (res && res.isError) {
    throw new Error(res.content && res.content[0] ? res.content[0].text : "tool error");
  }
  return JSON.parse(res.content[0].text);
}

async function runTest() {
  console.log("🧪 OSD focus-aware test starting...\n");

  console.log("--- Step 1: List viewers ---");
  const list = parse(await tools.osd_list_viewers({}));
  console.log(`  ${list.viewers.length} viewer(s) on the page:`);
  list.viewers.forEach((v) => {
    console.log(
      `    [${v.index}] ${v.title}${v.focused ? "  ← focused" : ""}` +
        `  selector=${v.selector ?? "(none)"} ready=${v.ready}`,
    );
  });
  if (!list.focused) {
    console.error("❌ No viewer is focused. Click an image, then re-run.");
    return { success: false, error: "no focused viewer" };
  }
  console.log(`  Focused: ${list.focused.title}`);

  console.log("\n--- Step 2: Status of the focused viewer ---");
  const status = parse(await tools.osd_get_status({}));
  console.log(`  Viewer: ${status.viewer.title}`);
  console.log(`  Zoom: ${status.zoom} (home ${status.homeZoom}, max ${status.maxZoom})`);
  console.log(`  Image size: ${status.imageSize ? `${status.imageSize.width}x${status.imageSize.height}` : "unknown"}`);
  if (status.viewer.index !== list.focused.index) {
    console.error("❌ osd_get_status answered for a different viewer than the focused one");
    return { success: false, error: "focus mismatch" };
  }

  console.log("\n--- Step 3: Zoom in 2x on the focused viewer ---");
  const zoom = parse(await tools.osd_zoom({ level: 2, relative: true }));
  console.log(`  ${zoom.previousZoom} → ${zoom.zoom}`);
  if (!(zoom.zoom > zoom.previousZoom)) {
    console.warn("  ⚠️ Zoom did not increase (may be clamped at maxZoom)");
  }

  console.log("\n--- Step 4: Pan ---");
  const pan = parse(await tools.osd_pan({ dx: 0.1, dy: 0.05 }));
  console.log(`  center ${JSON.stringify(pan.previousCenter)} → ${JSON.stringify(pan.center)}`);

  console.log("\n--- Step 5: Zoom to the top-left quadrant by image fraction ---");
  const region = parse(
    await tools.osd_zoom_to_region({ x: 0.0, y: 0.0, width: 0.25, height: 0.25 }),
  );
  console.log(`  bounds now ${JSON.stringify(region.bounds)}`);

  console.log("\n--- Step 6: Reset to home ---");
  const home = parse(await tools.osd_reset({}));
  console.log(`  zoom back to ${home.zoom} (home ${home.homeZoom})`);

  // Only meaningful with more than one viewer open.
  if (list.viewers.length > 1) {
    const other = list.viewers.find((v) => v.index !== list.focused.index);
    console.log(`\n--- Step 7: Move focus to "${other.title}" ---`);
    const moved = parse(await tools.osd_focus({ viewer: String(other.index) }));
    console.log(`  focused is now: ${moved.focused.title} (matched request: ${moved.matchedRequest})`);
    if (!moved.matchedRequest) {
      console.warn("  ⚠️ The app did not move focus to the requested viewer");
    }

    console.log("\n--- Step 8: Navigation follows the new focus ---");
    const afterFocus = parse(await tools.osd_zoom({ level: 1.5, relative: true }));
    console.log(`  zoomed viewer: ${afterFocus.viewer.title}`);
    if (afterFocus.viewer.index !== moved.focused.index) {
      console.error("❌ Zoom did not follow focus");
      return { success: false, error: "navigation did not follow focus" };
    }

    console.log("\n--- Step 9: Explicit viewer override reads a background viewer ---");
    const background = parse(
      await tools.osd_get_status({ viewer: String(list.focused.index) }),
    );
    console.log(`  read background viewer: ${background.viewer.title} at zoom ${background.zoom}`);
    if (background.viewer.index === moved.focused.index) {
      console.error("❌ The viewer override was ignored");
      return { success: false, error: "viewer override ignored" };
    }
  } else {
    console.log("\n  (Only one viewer open — skipping the focus-switch checks.)");
  }

  console.log("\n--- Step 10: Capture the focused viewer as a workspace ---");
  const focusedNow = parse(await tools.osd_get_status({}));
  const selector = focusedNow.viewer.selector;
  if (selector) {
    await tools.sleep(500); // captureVisibleTab rate limit
    const capture = await tools.createWorkspace({ selector });
    const parsed = typeof capture === "string" ? JSON.parse(capture) : capture;
    if (parsed.success) {
      console.log(`  ✅ Workspace ${parsed.image.id} from ${selector}`);
    } else {
      console.log(`  ⚠️ Capture failed: ${parsed.error}`);
    }
  } else {
    console.log("  ⚠️ The focused viewer has no stable selector; skipping capture.");
  }

  console.log("\n🎉 Test sequence complete.");
  return { success: true, viewers: list.viewers.length };
}

return runTest().catch((e) => {
  console.error("❌ Test failed:", e.message);
  return { success: false, error: e.message };
});
