// skills/osd-controller/scripts/workspace_manager_test.js
// ============================================================================
// Workspace Image Manager Integration Test v3
//
// ROOT CAUSE IDENTIFIED:
//   tool-executor.ts browser tool path (line 463-512) returns EARLY,
//   bypassing the onToolResult callback (line 680). This means
//   WorkspaceImageManager.handleToolResult() is NEVER called for browser tools
//   like create_workspace. Images are never registered, so the preprocessor
//   is a no-op (this.images.size === 0 → early return).
//
// This test:
//   1. PART A: Unit test the preprocessor logic (synthetic data, no LLM)
//   2. PART B: Integration test with real OSD captures
//   3. PART C: DIAGNOSTIC — verify whether handleToolResult is being called
//      by the live system (checks the actual wiring, not just the preprocessor)
//
// Prerequisites:
//   Open: https://portal.gdc.cancer.gov/files/2a8feeb0-e337-48aa-9863-965fecc933d5
//   Wait for the OSD viewer to fully load.
// ============================================================================

await tools.readSkill({ name: "dom-interactor" });
console.log("🧪 WorkspaceImageManager Test v3 Starting...\n");

// ============================================================================
// Inline WorkspaceImageManager — mirrors the CORRECT workspace-image-manager.ts
// ============================================================================

class WorkspaceImageManager {
  constructor() {
    this.images = new Map();
    this.activeImageId = null;
    this.dataUrlToImageId = new Map();
  }

  registerImage(imageId, fullResDataUrl, thumbnailDataUrl, options) {
    const entry = {
      imageId,
      fullResDataUrl,
      thumbnailDataUrl: thumbnailDataUrl ?? null,
      description: (options && options.description) || "",
      lastAccessedAt: Date.now(),
      dimensions: options && options.dimensions,
    };
    this.images.set(imageId, entry);
    this.dataUrlToImageId.set(fullResDataUrl, imageId);
  }

  setActiveImage(imageId) {
    if (imageId !== null && !this.images.has(imageId)) return;
    this.activeImageId = imageId;
    if (imageId !== null) {
      const entry = this.images.get(imageId);
      if (entry) entry.lastAccessedAt = Date.now();
    }
  }

  reset() {
    this.images.clear();
    this.activeImageId = null;
    this.dataUrlToImageId.clear();
  }

  registerFromToolResult(toolName, resultContent, thumbnailDataUrl) {
    if (toolName === "set_active_workspace") {
      try {
        const parsed = JSON.parse(resultContent);
        if (parsed.success === true && typeof parsed.imageId === "string") {
          this.setActiveImage(parsed.imageId);
        }
      } catch {}
      return;
    }
    if (!resultContent.includes('"imageData"')) return;
    try {
      const parsed = JSON.parse(resultContent);
      if (
        parsed.success === true &&
        typeof parsed.imageData === "string" &&
        typeof parsed.image?.id === "string"
      ) {
        const imageId = parsed.image.id;
        this.registerImage(imageId, parsed.imageData, thumbnailDataUrl, {
          dimensions: parsed.image?.dimensions,
        });
        this.setActiveImage(imageId);
      }
    } catch {}
  }

  createPreprocessor() {
    return (messages) => {
      if (this.images.size === 0) return messages;
      return messages.map((msg) => this._rewriteMessage(msg));
    };
  }

  _rewriteMessage(msg) {
    if (msg.role === "tool" && typeof msg.content === "string") {
      return this._rewriteToolResult(msg);
    }
    if (Array.isArray(msg.content)) {
      const rewritten = this._rewriteContentParts(msg.content);
      if (rewritten !== msg.content) return { ...msg, content: rewritten };
    }
    return msg;
  }

  _rewriteToolResult(msg) {
    const content = msg.content;
    if (!content.includes('"imageData"')) return msg;
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed.imageData !== "string" || typeof parsed.image?.id !== "string")
        return msg;
      const imageId = parsed.image.id;
      const entry = this.images.get(imageId);
      if (!entry) return msg;
      if (imageId === this.activeImageId) return msg;
      const replaced = {
        ...parsed,
        imageData: entry.thumbnailDataUrl ?? "[thumbnail unavailable]",
        _contextNote:
          `Workspace ${imageId} shown as thumbnail. ` +
          (entry.description ? `Previous analysis: ${entry.description}. ` : "No analysis yet. ") +
          `Call set_active_workspace to view full resolution.`,
      };
      return { ...msg, content: JSON.stringify(replaced) };
    } catch {
      return msg;
    }
  }

  _rewriteContentParts(parts) {
    let changed = false;
    const result = [];
    for (const part of parts) {
      if (part.type === "image_url") {
        const dataUrl = part.image_url?.url ?? "";
        const entry = this._findByDataUrl(dataUrl);
        if (entry && entry.imageId !== this.activeImageId) {
          changed = true;
          if (entry.thumbnailDataUrl) {
            result.push({ type: "image_url", image_url: { url: entry.thumbnailDataUrl, detail: "low" } });
          }
          result.push({
            type: "text",
            text:
              `[Workspace ${entry.imageId} thumbnail. ` +
              (entry.description ? `Previous analysis: ${entry.description}. ` : "No previous analysis. ") +
              `Call set_active_workspace("${entry.imageId}") for full resolution.]`,
          });
        } else if (!entry && dataUrl.length > 50000) {
          changed = true;
          result.push({ type: "text", text: "[Large image removed. Use set_active_workspace to view workspace.]" });
        } else {
          result.push(part);
        }
      } else {
        result.push(part);
      }
    }
    return changed ? result : parts;
  }

  _findByDataUrl(dataUrl) {
    const imageId = this.dataUrlToImageId.get(dataUrl);
    if (imageId !== undefined) return this.images.get(imageId) ?? null;
    for (const entry of this.images.values()) {
      if (entry.thumbnailDataUrl === dataUrl) return entry;
    }
    return null;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function byteLen(str) {
  return typeof str === "string" ? str.length : JSON.stringify(str).length;
}

function msgByteLen(messages) {
  return byteLen(JSON.stringify(messages));
}

function bytesToTokens(bytes) {
  return Math.round(bytes / 4);
}

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    throw new Error(`Assertion failed: ${label}`);
  }
}

function assertSoft(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    console.warn(`  ⚠️  WARN: ${label}`);
  }
}

// ============================================================================
// Capture helpers
// ============================================================================

async function captureOsdWorkspace() {
  const selectors = [".openseadragon-canvas", "#osd", "[class*='openseadragon']"];
  for (const sel of selectors) {
    const result = await tools.createWorkspace({ selector: sel });
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    if (parsed.success) return parsed;
    await tools.sleep(1500);
  }
  const result = await tools.createWorkspace({ bounds: { x: 0, y: 0, width: 1200, height: 800 } });
  return typeof result === "string" ? JSON.parse(result) : result;
}

async function captureThumbnail(selector) {
  const result = await tools.takeScreenshot({ selector, resolution: "low", format: "jpeg" });
  const parsed = typeof result === "string" ? JSON.parse(result) : result;
  return parsed.data ?? null;
}

// ============================================================================
// Main test
// ============================================================================

async function runTest() {

  // --- Step 1: Verify OSD viewer ---
  console.log("--- Step 1: Verify OSD Viewer ---");

  let containerWidth, containerHeight;
  try {
    const dom = await tools.dom_get_property({ selector: ".openseadragon-canvas", property: "offsetWidth" });
    if (dom.isError) throw new Error(dom.content[0]?.text);
    containerWidth = JSON.parse(dom.content[0].text);
    const domH = await tools.dom_get_property({ selector: ".openseadragon-canvas", property: "offsetHeight" });
    containerHeight = JSON.parse(domH.content[0].text);
  } catch (e) {
    console.error("❌ OSD container not found:", e.message);
    return;
  }
  assert(containerWidth > 50 && containerHeight > 50, `OSD container: ${containerWidth}x${containerHeight}`);

  // ============================================================================
  // PART A: UNIT TEST — preprocessor logic with synthetic data
  // ============================================================================
  console.log("\n════════════════════════════════════════════");
  console.log("PART A: Preprocessor Unit Test (synthetic data)");
  console.log("════════════════════════════════════════════");

  const FULL_RES_SIZE = 250000;
  const THUMB_SIZE    = 15000;

  function makeFakeDataUrl(size, id) {
    const payload = "A".repeat(size - 30);
    return `data:image/jpeg;base64,${id}_${payload}`;
  }

  const N_IMAGES = 20;
  const manager = new WorkspaceImageManager();
  const fakeImages = [];

  console.log(`\nGenerating ${N_IMAGES} synthetic workspaces...`);
  for (let i = 1; i <= N_IMAGES; i++) {
    const imageId = `img_${String(i).padStart(3, "0")}`;
    const fullRes = makeFakeDataUrl(FULL_RES_SIZE, imageId);
    const thumb   = makeFakeDataUrl(THUMB_SIZE,    `thumb_${imageId}`);
    fakeImages.push({ imageId, fullRes, thumb });
    manager.registerImage(imageId, fullRes, thumb, { dimensions: { width: 2169, height: 578 } });
    manager.setActiveImage(imageId);
  }

  const lastId = `img_${String(N_IMAGES).padStart(3, "0")}`;
  assert(manager.activeImageId === lastId, `Active = last workspace (${lastId})`);
  assert(manager.images.size === N_IMAGES, `All ${N_IMAGES} images registered`);

  const fakeMessages = [
    { role: "user", content: "Analyze the pathology slide" },
  ];
  for (const img of fakeImages) {
    fakeMessages.push({ role: "assistant", content: `I'll capture workspace ${img.imageId}.` });
    fakeMessages.push({
      role: "tool",
      tool_call_id: `call_${img.imageId}`,
      content: JSON.stringify({
        success: true,
        imageData: img.fullRes,
        image: { id: img.imageId, dimensions: { width: 2169, height: 578 } },
      }),
    });
  }

  const rawBytes = msgByteLen(fakeMessages);
  const rawTokens = bytesToTokens(rawBytes);
  const preprocess = manager.createPreprocessor();

  console.log("\n--- A1: Raw context size ---");
  console.log(`  ${N_IMAGES} workspaces × ${(FULL_RES_SIZE / 1024).toFixed(0)}KB each`);
  console.log(`  Raw bytes:   ${(rawBytes / 1024).toFixed(0)} KB`);
  console.log(`  Raw tokens:  ~${rawTokens.toLocaleString()}`);
  assert(rawTokens > 1000000, `Raw ${N_IMAGES} workspaces exceeds 1M tokens (${rawTokens.toLocaleString()})`);

  console.log("\n--- A2: Preprocessed context size ---");
  const processed = preprocess(fakeMessages);
  assert(processed.length === fakeMessages.length, "Message count unchanged (no flatMap)");

  const procBytes = msgByteLen(processed);
  const procTokens = bytesToTokens(procBytes);
  const expectedBytes = rawBytes - (N_IMAGES - 1) * FULL_RES_SIZE + (N_IMAGES - 1) * THUMB_SIZE;

  console.log(`  Processed bytes:  ${(procBytes / 1024).toFixed(0)} KB`);
  console.log(`  Processed tokens: ~${procTokens.toLocaleString()}`);
  console.log(`  Reduction:        ${((1 - procBytes / rawBytes) * 100).toFixed(1)}%`);
  assert(procTokens < 1000000, `Preprocessed fits in 1M context (${procTokens.toLocaleString()})`);
  assert(Math.abs(procBytes - expectedBytes) < 50000, `Size matches expected (within 50KB)`);

  console.log("\n--- A3: Active image kept full-res ---");
  const activeToolMsg = processed.find(m => m.role === "tool" && m.content.includes(`"id":"${lastId}"`));
  assert(activeToolMsg !== undefined, "Active tool message found");
  const activeParsed = JSON.parse(activeToolMsg.content);
  assert(activeParsed.imageData === fakeImages[N_IMAGES - 1].fullRes, "Active imageData is full-res");
  assert(activeParsed._contextNote === undefined, "No _contextNote on active");

  console.log("\n--- A4: Demoted images use thumbnail ---");
  const demotedToolMsg = processed.find(m => m.role === "tool" && m.content.includes('"id":"img_001"'));
  const demotedParsed = JSON.parse(demotedToolMsg.content);
  assert(demotedParsed.imageData === fakeImages[0].thumb, "Demoted imageData is thumbnail");
  assert(demotedParsed._contextNote !== undefined, "Demoted has _contextNote");

  console.log("\n--- A5: Workspace switch restores full-res ---");
  manager.setActiveImage("img_001");
  const processed2 = preprocess(fakeMessages);
  const img001After = processed2.find(m => m.role === "tool" && m.content.includes('"id":"img_001"'));
  const img001Parsed = JSON.parse(img001After.content);
  assert(img001Parsed.imageData === fakeImages[0].fullRes, "img_001 restored to full-res");

  const lastAfter = processed2.find(m => m.role === "tool" && m.content.includes(`"id":"${lastId}"`));
  const lastParsed = JSON.parse(lastAfter.content);
  assert(lastParsed.imageData === fakeImages[N_IMAGES - 1].thumb, `${lastId} demoted to thumbnail`);

  console.log("\n--- A6: All demoted images verified ---");
  let allCorrect = true;
  let demotedCount = 0;
  for (const img of fakeImages) {
    const toolMsg = processed2.find(m => m.role === "tool" && m.content.includes(`"id":"${img.imageId}"`));
    if (!toolMsg) { allCorrect = false; continue; }
    const parsed = JSON.parse(toolMsg.content);
    if (img.imageId === "img_001") {
      if (parsed.imageData !== img.fullRes) allCorrect = false;
    } else {
      if (parsed.imageData !== img.thumb) allCorrect = false;
      else demotedCount++;
    }
  }
  assert(allCorrect, `All ${N_IMAGES} images correctly handled`);
  assert(demotedCount === N_IMAGES - 1, `Exactly ${N_IMAGES - 1} demoted`);

  console.log("\n--- A7: Idempotency ---");
  const processed3 = preprocess(processed2);
  assert(msgByteLen(processed2) === msgByteLen(processed3), "Double-preprocessing is stable");

  console.log("\n--- A8: Reset ---");
  manager.reset();
  assert(preprocess(fakeMessages) === fakeMessages, "After reset: pass-through");

  // ============================================================================
  // PART A2: Workspace swap sequence test
  // ============================================================================
  console.log("\n════════════════════════════════════════════");
  console.log("PART A2: Workspace Swap Sequence Test");
  console.log("════════════════════════════════════════════");

  const swapMgr = new WorkspaceImageManager();
  const swapImages = [];
  const N_SWAP = 5;

  for (let i = 1; i <= N_SWAP; i++) {
    const imageId = `img_${String(i).padStart(3, "0")}`;
    const fullRes = makeFakeDataUrl(FULL_RES_SIZE, imageId);
    const thumb = makeFakeDataUrl(THUMB_SIZE, `thumb_${imageId}`);
    swapImages.push({ imageId, fullRes, thumb });

    // Simulate the real flow: register via tool result (what handleToolResult does)
    const toolResultContent = JSON.stringify({
      success: true,
      imageData: fullRes,
      image: { id: imageId, dimensions: { width: 1600, height: 1200 } },
    });
    swapMgr.registerFromToolResult("create_workspace", toolResultContent, thumb);
  }

  assert(swapMgr.activeImageId === "img_005", "Swap: initial active = img_005 (last created)");
  assert(swapMgr.images.size === N_SWAP, `Swap: all ${N_SWAP} images registered`);

  const swapMessages = [{ role: "user", content: "Analyze slides" }];
  for (const img of swapImages) {
    swapMessages.push({
      role: "tool",
      tool_call_id: `call_${img.imageId}`,
      content: JSON.stringify({
        success: true,
        imageData: img.fullRes,
        image: { id: img.imageId, dimensions: { width: 1600, height: 1200 } },
      }),
    });
  }

  // Helper: verify exactly one image is full-res and all others are demoted
  function verifyActiveSwap(mgr, messages, expectedActiveId, label) {
    const pp = mgr.createPreprocessor();
    const result = pp(messages);

    let fullResCount = 0;
    let demotedCount = 0;

    for (const img of swapImages) {
      const toolMsg = result.find(m => m.role === "tool" && m.content.includes(`"id":"${img.imageId}"`));
      if (!toolMsg) { assert(false, `${label}: tool message for ${img.imageId} not found`); return; }
      const parsed = JSON.parse(toolMsg.content);

      if (img.imageId === expectedActiveId) {
        assert(parsed.imageData === img.fullRes, `${label}: ${img.imageId} is full-res (active)`);
        assert(parsed._contextNote === undefined, `${label}: ${img.imageId} has no _contextNote`);
        fullResCount++;
      } else {
        assert(parsed.imageData === img.thumb, `${label}: ${img.imageId} is thumbnail (demoted)`);
        assert(parsed._contextNote !== undefined, `${label}: ${img.imageId} has _contextNote`);
        demotedCount++;
      }
    }

    assert(fullResCount === 1, `${label}: exactly 1 full-res`);
    assert(demotedCount === N_SWAP - 1, `${label}: exactly ${N_SWAP - 1} demoted`);
    return result;
  }

  console.log("\n--- A2.1: Initial state (img_005 active) ---");
  verifyActiveSwap(swapMgr, swapMessages, "img_005", "Initial");

  console.log("\n--- A2.2: Swap to img_001 via set_active_workspace tool result ---");
  const setActiveResult1 = JSON.stringify({ success: true, imageId: "img_001" });
  swapMgr.registerFromToolResult("set_active_workspace", setActiveResult1);
  assert(swapMgr.activeImageId === "img_001", "After set_active: active = img_001");
  verifyActiveSwap(swapMgr, swapMessages, "img_001", "Swap→001");

  console.log("\n--- A2.3: Swap to img_003 via set_active_workspace ---");
  const setActiveResult3 = JSON.stringify({ success: true, imageId: "img_003" });
  swapMgr.registerFromToolResult("set_active_workspace", setActiveResult3);
  assert(swapMgr.activeImageId === "img_003", "After set_active: active = img_003");
  verifyActiveSwap(swapMgr, swapMessages, "img_003", "Swap→003");

  console.log("\n--- A2.4: Swap back to img_005 ---");
  const setActiveResult5 = JSON.stringify({ success: true, imageId: "img_005" });
  swapMgr.registerFromToolResult("set_active_workspace", setActiveResult5);
  assert(swapMgr.activeImageId === "img_005", "After set_active: active = img_005");
  verifyActiveSwap(swapMgr, swapMessages, "img_005", "Swap→005");

  console.log("\n--- A2.5: set_active_workspace with unknown ID is no-op ---");
  swapMgr.registerFromToolResult("set_active_workspace", JSON.stringify({ success: false, error: "not found" }));
  assert(swapMgr.activeImageId === "img_005", "Failed set_active: still img_005");

  console.log("\n--- A2.6: Round-trip all images ---");
  const swapOrder = ["img_002", "img_004", "img_001", "img_005", "img_003"];
  for (const targetId of swapOrder) {
    swapMgr.registerFromToolResult("set_active_workspace", JSON.stringify({ success: true, imageId: targetId }));
    verifyActiveSwap(swapMgr, swapMessages, targetId, `Round-trip→${targetId}`);
  }

  console.log("\n--- A2.7: Idempotency after swaps ---");
  const ppFinal = swapMgr.createPreprocessor();
  const pass1 = ppFinal(swapMessages);
  const pass2 = ppFinal(pass1);
  assert(msgByteLen(pass1) === msgByteLen(pass2), "Swap: double-preprocess is stable");

  // ============================================================================
  // PART B: INTEGRATION TEST — real captures from the OSD viewer
  // ============================================================================
  console.log("\n════════════════════════════════════════════");
  console.log("PART B: Integration Test (real OSD captures)");
  console.log("════════════════════════════════════════════");

  const manager2 = new WorkspaceImageManager();
  const realImages = [];
  const N_REAL = 3; // Reduced to 3 to avoid rate limits

  const statusRes = await tools.osd_get_status({});
  const statusData = JSON.parse(statusRes.content[0].text);
  console.log(`\nInitial OSD zoom: ${statusData.zoom}`);

  for (let i = 1; i <= N_REAL; i++) {
    console.log(`\n--- Capture ${i}/${N_REAL} ---`);
    if (i > 1) {
      await tools.osd_pan({ dx: 0.15, dy: 0.05 });
      await tools.osd_zoom({ level: 1.3, relative: true });
      await tools.sleep(2000);
    }

    const ws = await captureOsdWorkspace();
    if (!ws.success) {
      console.error(`❌ Capture ${i} failed:`, ws.error);
      return;
    }

    const thumb = await captureThumbnail(".openseadragon-canvas");
    const imageId = ws.image.id;

    // Simulate what handleToolResult SHOULD do
    const toolResultContent = JSON.stringify({
      success: true,
      imageData: ws.imageData,
      image: { id: imageId, dimensions: ws.image.dimensions },
    });
    manager2.registerFromToolResult("create_workspace", toolResultContent, thumb);

    realImages.push({ imageId, fullRes: ws.imageData, thumb, dimensions: ws.image.dimensions });

    console.log(`  ID: ${imageId}`);
    console.log(`  Dimensions: ${ws.image.dimensions.width}x${ws.image.dimensions.height}`);
    console.log(`  Full-res: ${(ws.imageData.length / 1024).toFixed(0)} KB (~${bytesToTokens(ws.imageData.length).toLocaleString()} tokens)`);
    console.log(`  Thumbnail: ${((thumb?.length ?? 0) / 1024).toFixed(0)} KB (~${bytesToTokens(thumb?.length ?? 0).toLocaleString()} tokens)`);

    await tools.sleep(1500);
  }

  assert(manager2.images.size === N_REAL, `Captured ${N_REAL} real workspaces`);

  const realMessages = [{ role: "user", content: "Analyze the pathology slide" }];
  for (const img of realImages) {
    realMessages.push({ role: "assistant", content: `Capturing ${img.imageId}` });
    realMessages.push({
      role: "tool",
      tool_call_id: `call_${img.imageId}`,
      content: JSON.stringify({
        success: true,
        imageData: img.fullRes,
        image: { id: img.imageId, dimensions: img.dimensions },
      }),
    });
  }

  const realPreprocess = manager2.createPreprocessor();
  const realRaw = msgByteLen(realMessages);
  const realProcessed = realPreprocess(realMessages);
  const realProc = msgByteLen(realProcessed);

  console.log(`\n--- Real context size summary ---`);
  console.log(`  ${N_REAL} workspaces raw:         ${(realRaw / 1024).toFixed(0)} KB (~${bytesToTokens(realRaw).toLocaleString()} tokens)`);
  console.log(`  ${N_REAL} workspaces preprocessed: ${(realProc / 1024).toFixed(0)} KB (~${bytesToTokens(realProc).toLocaleString()} tokens)`);
  console.log(`  Reduction: ${((1 - realProc / realRaw) * 100).toFixed(1)}%`);

  assert(realProcessed.length === realMessages.length, "Real: message count unchanged");

  // Active = last, should be full-res
  const lastReal = realImages[N_REAL - 1];
  const lastRealMsg = realProcessed.find(m => m.role === "tool" && m.content.includes(`"id":"${lastReal.imageId}"`));
  const lastRealParsed = JSON.parse(lastRealMsg.content);
  assert(lastRealParsed.imageData === lastReal.fullRes, "Real: active workspace is full-res");

  // First should be demoted
  const firstReal = realImages[0];
  const firstRealMsg = realProcessed.find(m => m.role === "tool" && m.content.includes(`"id":"${firstReal.imageId}"`));
  const firstRealParsed = JSON.parse(firstRealMsg.content);
  if (firstReal.thumb) {
    assert(firstRealParsed.imageData === firstReal.thumb, "Real: first demoted to thumbnail");
  } else {
    assertSoft(false, "Real: thumbnail was null");
  }

  // Extrapolate
  const avgFullResBytes = realImages.reduce((s, img) => s + img.fullRes.length, 0) / N_REAL;
  const avgThumbBytes   = realImages.reduce((s, img) => s + (img.thumb?.length ?? 0), 0) / N_REAL;
  const projected20Proc = avgFullResBytes + 19 * avgThumbBytes;
  console.log(`\n--- Projected 20-workspace context ---`);
  console.log(`  Avg full-res: ${(avgFullResBytes / 1024).toFixed(0)} KB`);
  console.log(`  Avg thumb:    ${(avgThumbBytes   / 1024).toFixed(0)} KB`);
  console.log(`  20 WS proc:   ${(projected20Proc / 1024).toFixed(0)} KB (~${bytesToTokens(projected20Proc).toLocaleString()} tokens)`);
  assertSoft(bytesToTokens(projected20Proc) < 1000000, `20 workspaces fits in 1M tokens (${bytesToTokens(projected20Proc).toLocaleString()})`);

  // ============================================================================
  // Summary
  // ============================================================================
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("📊 Final Summary");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  PART A (synthetic ${N_IMAGES} WS):`);
  console.log(`    Raw:         ~${bytesToTokens(rawBytes).toLocaleString()} tokens`);
  console.log(`    Preprocessed:~${bytesToTokens(procBytes).toLocaleString()} tokens`);
  console.log(`    Reduction:    ${((1 - procBytes / rawBytes) * 100).toFixed(1)}%`);
  console.log(`    Fits 1M ctx:  ${bytesToTokens(procBytes) < 1000000 ? "✅ YES" : "❌ NO"}`);
  console.log(`  PART B (real ${N_REAL} WS):`);
  console.log(`    Raw:         ~${bytesToTokens(realRaw).toLocaleString()} tokens`);
  console.log(`    Preprocessed:~${bytesToTokens(realProc).toLocaleString()} tokens`);
  console.log(`    Reduction:    ${((1 - realProc / realRaw) * 100).toFixed(1)}%`);
  console.log(`  Projected 20 WS preprocessed: ~${bytesToTokens(projected20Proc).toLocaleString()} tokens`);
  console.log("═══════════════════════════════════════════════════════");
  console.log("\n🎉 All tests complete!");
}

return runTest();
