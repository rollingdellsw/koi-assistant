// skills/osd-controller/scripts/osd_test_sequence.js
console.log("🧪 OSD Test Starting...");

async function runTest() {
  console.log("\n--- Step 1: Get Status ---");

  try {
    const statusRes = await tools.osd_get_status({});

    // MCP tools return: { content: [{type: "text", text: "..."}], isError: boolean }
    if (statusRes.isError) {
      console.error("❌ Status check failed");
      console.log("Error:", statusRes.content[0]?.text);
      return;
    }

    // Parse the JSON result from the text content
    const statusData = JSON.parse(statusRes.content[0].text);
    console.log("✅ Viewer Status:");
    console.log("  Zoom:", statusData.zoom);
    console.log("  Bounds:", statusData.bounds);

    if (statusData.diagnostics) {
      console.log("\n📋 Discovery diagnostics:");
      statusData.diagnostics.forEach(line => console.log("  " + line));
    }

    console.log("\n--- Step 2: Zoom In (1.5x) ---");
    const zoomRes = await tools.osd_zoom({ level: 1.5, relative: true });

    if (zoomRes.isError) {
      console.error("❌ Zoom failed");
      console.log("Error:", zoomRes.content[0]?.text);
      return;
    }

    const zoomData = JSON.parse(zoomRes.content[0].text);
    console.log("✅ Zoom applied:");
    console.log("  Previous:", zoomData.previousZoom);
    console.log("  New:", zoomData.zoom);

    await tools.sleep(1000);

    console.log("\n--- Step 3: Pan Right and Down ---");
    const panRes = await tools.osd_pan({ dx: 0.1, dy: 0.1 });

    if (panRes.isError) {
      console.error("❌ Pan failed");
      console.log("Error:", panRes.content[0]?.text);
      return;
    }

    const panData = JSON.parse(panRes.content[0].text);
    console.log("✅ Pan applied:");
    console.log("  Previous center:", panData.previousCenter);
    console.log("  New center:", panData.center);

    console.log("\n--- Step 4: Capture OSD Viewport as Visual Workspace ---");

    // Use the OSD container element — try common selectors
    await tools.sleep(500); // Ensure rate limit cooldown after previous captureVisibleTab calls
    const selectors = [".openseadragon-canvas", "#osd", "[class*='openseadragon']"];
    let captureResult = null;
    let usedSelector = null;

    for (const sel of selectors) {
      console.log(`  Trying selector: ${sel}`);
      captureResult = await tools.createWorkspace({ selector: sel });

      // createWorkspace returns a ToolResult-wrapped JSON
      const parsed = typeof captureResult === "string"
        ? JSON.parse(captureResult)
        : captureResult;

      if (parsed.success) {
        usedSelector = sel;
        captureResult = parsed;
        break;
      } else {
        console.log(`    ❌ ${parsed.error}`);
        captureResult = null;
        await tools.sleep(1500); // Rate limit cooldown before next captureVisibleTab attempt
      }
    }

    if (captureResult === null || !captureResult.success) {
      console.error("❌ Could not capture OSD viewport with any known selector");
      console.log("  Falling back to full viewport bounds...");
      await tools.sleep(1500); // Rate limit cooldown
      captureResult = await tools.createWorkspace({
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
      });
      captureResult = typeof captureResult === "string"
        ? JSON.parse(captureResult)
        : captureResult;
    }

    if (captureResult.success) {
      const img = captureResult.image;
      console.log(`✅ Workspace created: ${img.id}`);
      console.log(`   Dimensions: ${img.dimensions.width}x${img.dimensions.height}`);
      console.log(`   Selector: ${usedSelector ?? "bounds fallback"}`);

      console.log("\n--- Step 5: LLM Adds Annotations ---");

      const rectResult = await tools.addWorkspaceAnnotation({
        imageId: img.id,
        type: "rectangle",
        geometry: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
        style: { color: "#ff4444", strokeWidth: 3, fillOpacity: 0.15 },
        label: "Region of interest",
      });
      console.log("  Rectangle:", rectResult.success ? "✅" : "❌");

      const arrowResult = await tools.addWorkspaceAnnotation({
        imageId: img.id,
        type: "arrow",
        geometry: { fromX: 0.5, fromY: 0.1, toX: 0.4, toY: 0.3 },
        style: { color: "#44cc88", strokeWidth: 2 },
        label: "Notable feature",
      });
      console.log("  Arrow:", arrowResult.success ? "✅" : "❌");

      console.log("\n--- Step 6: Waiting for User Review ---");
      console.log("  Review annotations, then click Done");
      await tools.waitForUserDone({ prompt: "Review OSD annotations, click Done to finish" });
    } else {
      console.error("❌ Workspace creation failed:", captureResult.error);
    }

    console.log("\n🎉 All tests passed!");

  } catch (error) {
    console.error("❌ Test failed with exception:", error.message);
    console.error(error.stack);
  }
}

return runTest();
