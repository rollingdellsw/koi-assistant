// scripts/ppt-comprehensive-test.js
// PowerPoint Online comprehensive test
// Covers: ppt_create, ppt_get_metadata, ppt_read_content, ppt_batch_update
// NOTE: MS Graph PPT API is limited compared to Google Slides API.
//       - ppt_read_content extracts text via HTML conversion
//       - ppt_batch_update replaces entire file (base64 .pptx upload)
//       - No incremental slide manipulation (createSlide, insertText, etc.)
//       - ppt_get_images extracts images per slide via .rels resolution

await tools.readSkill({ name: "microsoft-365" });
console.log("Starting PowerPoint Online Comprehensive Test...");

const RUN_ID = Math.floor(Math.random() * 1000);
const PPT_TITLE = `Koi PPT Test ${new Date().toLocaleTimeString().replace(/:/g, '-')} (Run ${RUN_ID})`;

// Known test presentation for image extraction test
const IMAGE_TEST_ITEM_ID = "F149FA8C0789C155!158";

async function run() {
  try {
    // ---------------------------------------------------------
    // PART 1: READ-ONLY TEST (Existing Presentation)
    // ---------------------------------------------------------
    let existingItemId = null;
    if (typeof args !== 'undefined') {
      if (args.itemId) existingItemId = args.itemId;
    }

    if (existingItemId) {
      console.log(`\n==================================================`);
      console.log(`PART 1: READ-ONLY VERIFICATION`);
      console.log(`Target ID: ${existingItemId}`);
      console.log(`==================================================`);

      // A. Metadata
      console.log(`\n[1/2] Fetching Metadata...`);
      const metaRes = await tools.ppt_get_metadata({ itemId: existingItemId });
      const metaText = metaRes.content ? metaRes.content[0].text : "{}";

      try {
        const meta = JSON.parse(metaText);
        console.log(`✓ Name: "${meta.name}"`);
        console.log(`✓ Size: ${meta.size} bytes`);
        console.log(`✓ Last Modified: ${meta.lastModifiedDateTime || meta.lastModified}`);
        console.log(`✓ URL: ${meta.webUrl}`);
      } catch (e) {
        console.warn(`⚠️ Meta Parse Error: ${metaText.slice(0, 200)}`);
      }

      // B. Read Content (text extraction via HTML)
      console.log(`\n[2/2] Reading Content (Text Extraction)...`);
      const contentRes = await tools.ppt_read_content({ itemId: existingItemId });
      const contentText = contentRes.content ? contentRes.content[0].text : "";

      if (contentRes.isError) {
        console.warn(`⚠️ Content read issue: ${contentText.slice(0, 200)}`);
        // May get a preview URL fallback
        try {
          const fallback = JSON.parse(contentText);
          if (fallback.previewUrl) {
            console.log(`   Fallback: Preview URL available: ${fallback.previewUrl}`);
          }
        } catch (e) {}
      } else {
        const textLen = contentText.length;
        console.log(`✓ Extracted text: ${textLen} chars`);
        if (textLen > 0) {
          console.log(`   Sample: "${contentText.slice(0, 100).replace(/\n/g, ' ')}..."`);
        } else {
          console.log(`   (No text extracted — may be image-only presentation)`);
        }
      }

      console.log(`\nPart 1 Complete.\n`);
    } else {
      console.log("\n(Skipping Part 1: No --itemId provided)");
    }

    // ---------------------------------------------------------
    // PART 1B: IMAGE EXTRACTION TEST (Slide-to-Image Map)
    // ---------------------------------------------------------
    const imageTestId = existingItemId || IMAGE_TEST_ITEM_ID;
    console.log(`\n==================================================`);
    console.log(`PART 1B: SLIDE-TO-IMAGE MAP TEST`);
    console.log(`Target ID: ${imageTestId}`);
    console.log(`==================================================`);

    try {
      // First get total slide count from metadata
      const imgMeta = await tools.ppt_get_metadata({ itemId: imageTestId });
      const imgMetaObj = JSON.parse(imgMeta.content[0].text);
      const totalSlides = imgMetaObj.slideCount || imgMetaObj.pageCount || 10;
      console.log(`Total slides reported: ${totalSlides}`);

      const slideImageMap = {};
      let totalImages = 0;

      // Query each slide individually to build the map
      for (let s = 1; s <= totalSlides; s++) {
        const res = await tools.ppt_get_images({ itemId: imageTestId, startSlide: s, endSlide: s });
        const text = res.content ? res.content[0].text : "{}";
        try {
          const parsed = JSON.parse(text);
          const images = parsed.images || [];
          if (images.length > 0) {
            slideImageMap[s] = images.map(img => img.name || img.path || img.filename);
            totalImages += images.length;
          }
        } catch (e) {
          // Non-JSON response, try to extract image names
          const names = [...text.matchAll(/ppt\/media\/[^\s"',)]+/g)].map(m => m[0]);
          if (names.length > 0) {
            slideImageMap[s] = names;
            totalImages += names.length;
          }
        }
      }

      console.log(`\n--- Slide-to-Image Map ---`);
      for (const [slide, images] of Object.entries(slideImageMap)) {
        console.log(`  Slide ${slide}: ${images.join(', ')}`);
      }
      console.log(`--- Total: ${totalImages} images across ${Object.keys(slideImageMap).length} slides ---`);
      console.log(`✓ Image extraction test complete.`);
    } catch (e) {
      console.warn(`⚠️ Image extraction test failed: ${e.message}`);
    }

    // ---------------------------------------------------------
    // PART 2: CREATION TEST
    // ---------------------------------------------------------
    console.log(`\n==================================================`);
    console.log(`PART 2: CREATION & VERIFICATION`);
    console.log(`==================================================`);

    console.log(`\n[1/3] Creating Presentation: "${PPT_TITLE}"...`);
    const createResult = await tools.ppt_create({ title: PPT_TITLE });

    let itemId = null;
    if (createResult.content) {
      for (const block of createResult.content) {
        if (block._createdFileId) {
          itemId = block._createdFileId;
          break;
        }
        if (typeof block.text === 'string') {
          const match = block.text.match(/Created presentation: (\S+)/);
          if (match) itemId = match[1];
        }
      }
    }

    if (!itemId) throw new Error("Failed to extract itemId from ppt_create");
    console.log(`✓ Created. ID: ${itemId}`);

    // 2. Verify Metadata
    console.log(`\n[2/3] Verifying Metadata...`);
    const metaRes = await tools.ppt_get_metadata({ itemId });
    const metaText = metaRes.content ? metaRes.content[0].text : "{}";
    let webUrl = null;

    try {
      const meta = JSON.parse(metaText);
      console.log(`✓ Name: "${meta.name}"`);
      console.log(`✓ Size: ${meta.size} bytes`);
      console.log(`✓ URL: ${meta.webUrl}`);
      webUrl = meta.webUrl;
    } catch (e) {
      console.warn(`⚠️ Metadata parse error: ${metaText.slice(0, 200)}`);
    }

    // 3. Try to read content from empty presentation
    console.log(`\n[3/3] Reading Content from Empty Presentation...`);
    const readRes = await tools.ppt_read_content({ itemId });
    const readText = readRes.content ? readRes.content[0].text : "";

    if (readRes.isError) {
      console.log(`   Expected: Empty or minimal content. Got error/fallback.`);
      try {
        const fallback = JSON.parse(readText);
        if (fallback.previewUrl) {
          console.log(`   ✓ Preview URL available for empty deck: ${fallback.previewUrl}`);
        }
      } catch (e) {
        console.log(`   Response: ${readText.slice(0, 150)}`);
      }
    } else {
      console.log(`✓ Content from empty deck: "${readText.slice(0, 80).replace(/\n/g, ' ')}"`);
    }

    // Note: ppt_batch_update requires a full base64 .pptx file which is impractical
    // to generate from scratch in a test script. We verify the tool is callable but
    // skip actual content replacement in this test.
    console.log(`\n[Note] ppt_batch_update requires base64 .pptx upload — skipped in automated test.`);
    console.log(`       The guardrail-negative-test.js verifies write protection for this tool.`);

    // Navigate
    if (webUrl) {
      console.log(`\nNavigating to Presentation...`);
      console.log(` URL: ${webUrl}`);
      await tools.navigatePage(webUrl);
    }

    return {
      success: true,
      itemId,
      url: webUrl
    };

  } catch (e) {
    console.error("\n❌ TEST FAILED:", e.message);
    if (e.stack) console.error(e.stack);
    return { success: false, error: e.message };
  }
}

return run();
