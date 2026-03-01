// scripts/slides-comprehensive-test-v2.js
// Features:
// v3 additions: text insertion, slide reorder/delete, slide content read verification
// 1. Read-Only Verification (Checks existing slide deck if --url passed)
// 2. Creation Verification (Full CRUD test for Slides)
// Fixes: Slides API payload mapping (url vs contentUri, and presentationId extraction)

await tools.readSkill({ name: "google-workspace" });
console.log("Starting Google Slides Comprehensive Test (v3)...");

const RUN_ID = Math.floor(Math.random() * 1000);
const SLIDES_TITLE = `Koi Slides Test ${new Date().toLocaleTimeString()} (Run ${RUN_ID})`;
const TEST_IMAGE_URL = "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png";

async function run() {
  try {
    // ---------------------------------------------------------
    // PART 1: READ-ONLY TEST (Existing Presentation)
    // ---------------------------------------------------------
    let existingId = null;
    if (typeof args !== 'undefined') {
        if (args.url) {
            const match = args.url.match(/presentation\/d\/([a-zA-Z0-9-_]+)/);
            if (match) existingId = match[1];
        } else if (Array.isArray(args)) {
            const urlArg = args.find(a => typeof a === 'string' && a.includes("docs.google.com/presentation"));
            if (urlArg) {
                const match = urlArg.match(/presentation\/d\/([a-zA-Z0-9-_]+)/);
                if (match) existingId = match[1];
            }
        }
    }

    if (existingId) {
        console.log(`\n==================================================`);
        console.log(`PART 1: READ-ONLY VERIFICATION`);
        console.log(`Target ID: ${existingId}`);
        console.log(`==================================================`);

        // A. Metadata
        console.log(`\n[1/5] Fetching Metadata...`);
        const metaRes = await tools.slides_get_metadata({ presentationId: existingId });
        const metaText = metaRes.content ? metaRes.content[0].text : "{}";

        try {
            const meta = JSON.parse(metaText);
            console.log(`✓ Title: "${meta.title}"`);
            if (meta.slides && meta.slides.length > 0) {
                console.log(`✓ Found ${meta.slides.length} Slides (Pages).`);
            } else {
                console.warn(`⚠ No slides array returned or empty presentation.`);
            }
        } catch (e) { console.warn(`⚠️ Meta Parse Error: ${metaText}`); }

        // B. Read Content
        console.log(`\n[2/5] Reading Content (Text)...`);
        const contentRes = await tools.slides_read_content({ presentationId: existingId });
        const contentText = contentRes.content ? contentRes.content[0].text : "{}";
        try {
            const content = JSON.parse(contentText);
            // slides_read_content returns { slides: [{ slideIndex, text }, ...] }, not a top-level text field
            const allText = (content.slides || []).map(s => s.text).filter(Boolean).join("\n");
            console.log(`✓ Extracted Text length: ${allText.length} chars across ${content.returnedSlides || 0} slides.`);
            if (allText) console.log(`   Sample: "${allText.slice(0, 80).replace(/\n/g, ' ')}..."`);
            else console.log(`   (No text elements found — slides may be image-only)`);
        } catch (e) { console.warn(`⚠️ Content Parse Error: ${contentText}`); }

        // C. Get URLs
        console.log(`\n[3/5] Scanning for Hyperlinks...`);
        const urlRes = await tools.slides_get_urls({ presentationId: existingId });
        const urlText = urlRes.content ? urlRes.content[0].text : "{}";
        try {
            const urlData = JSON.parse(urlText);
            console.log(`✓ Found ${urlData.urls ? urlData.urls.length : 0} links.`);
        } catch (e) { console.warn(`⚠️ URL Parse Error: ${urlText}`); }

        // D. Get Images
        console.log(`\n[4/5] Scanning for Images...`);
        let firstImageUrl = null;
        const imgRes = await tools.slides_get_images({ presentationId: existingId });
        const imgText = imgRes.content ? imgRes.content[0].text : "{}";
        try {
            const imgData = JSON.parse(imgText);
            console.log(`✓ Found ${imgData.images ? imgData.images.length : 0} images.`);
            if (imgData.images && imgData.images.length > 0) {
                // FIX: Slides uses 'url', Docs uses 'contentUri'
                firstImageUrl = imgData.images[0].contentUrl || imgData.images[0].contentUri;
                console.log(`   First Image ID: ${imgData.images[0].objectId}`);
            }
        } catch (e) { console.warn(`⚠️ Image Parse Error: ${imgText}`); }

        // E. Test the new Image Download API
        console.log(`\n[5/5] Testing Image Download API...`);
        if (firstImageUrl) {
            try {
                const downloadRes = await tools.gsuite_download_image({ contentUri: firstImageUrl });
                if (downloadRes.isError) {
                    console.warn(`⚠️ Download failed:`, downloadRes.content[0].text);
                } else {
                    const statusText = downloadRes.content.find(c => c.type === "text")?.text;
                    console.log(`✓ ${statusText || "Image downloaded successfully as base64!"}`);
                }
            } catch (e) {
                console.warn(`⚠️ Tool gsuite_download_image execution error: ${e.message}`);
            }
        } else {
            console.log(`   (Skipped: No valid image URLs found in presentation to download)`);
        }

        console.log(`\nPart 1 Complete.\n`);
    }

    // ---------------------------------------------------------
    // PART 2: CREATION & CRUD TEST
    // ---------------------------------------------------------
    console.log(`\n==================================================`);
    console.log(`PART 2: CREATION & WRITE VERIFICATION`);
    console.log(`==================================================`);

    const FIXED_TITLE = "Koi Automation Persistent Test Deck";
    let presentationId = null;

    console.log(`\n[1/4] Searching for existing test deck: "${FIXED_TITLE}"...`);
    const searchRes = await tools.drive_search({ searchTerm: FIXED_TITLE, mimeType: 'application/vnd.google-apps.presentation' });
    const searchData = JSON.parse(searchRes.content[0].text);

    if (searchData.files && searchData.files.length > 0) {
        presentationId = searchData.files[0].id;
        console.log(`✓ Found existing deck. ID: ${presentationId}`);
    } else {
        console.log(`   Not found. Creating new deck...`);
        const createResult = await tools.slides_create({ title: FIXED_TITLE });
        // Robust extraction for new creation
        if (createResult._createdFileId) {
            presentationId = createResult._createdFileId;
        } else {
            const match = createResult.content[0].text.match(/presentation: ([a-zA-Z0-9-_]+)/);
            if (match) presentationId = match[1];
        }
    }

    if (!presentationId) throw new Error("Failed to extract presentationId");
    console.log(`✓ Created. ID: ${presentationId}`);

    const slideUrl = `https://docs.google.com/presentation/d/${presentationId}`;

    // 2. Batch Update (Add Slide & Image)
    console.log(`\n[2/4] Modifying Presentation (Batch Update)...`);
    const customSlideId = "deft_test_slide_" + RUN_ID;

    const batchRes = await tools.slides_batch_update({
      presentationId,
      requests: [
        { createSlide: { objectId: customSlideId } },
        { createImage: {
            url: TEST_IMAGE_URL,
            elementProperties: { pageObjectId: customSlideId }
        }}
      ]
    });

    const batchResText = batchRes.content ? batchRes.content[0].text : "";
    if (batchRes.isError || batchResText.includes("Tool error") || batchResText.includes("API Error")) {
        console.warn(`⚠️ Batch update failed: \n${batchResText}`);
    } else {
    console.log("✓ Successfully added a new slide and inserted an image.");
    }

    // 3. Insert text into the new slide
    console.log(`\n[3/6] Inserting Text into Slide...`);
    const textBoxId = "deft_textbox_" + RUN_ID;
    const verifyImgRes = await tools.slides_get_images({ presentationId });
    const verifyImgText = verifyImgRes.content ? verifyImgRes.content[0].text : "{}";
    try {
        const vImgData = JSON.parse(verifyImgText);
        if (vImgData.images && vImgData.images.length > 0) {
            console.log(`✓ Verified: Found ${vImgData.images.length} image(s) in the new deck.`);
        } else {
            console.warn(`⚠️ Could not verify image insertion.`);
        }
    } catch (e) { console.warn(`⚠️ Parse Error during verification.`); }

    // Insert a text box shape, then insert text into it
    const textInsertRes = await tools.slides_batch_update({
      presentationId,
      requests: [
        {
          createShape: {
            objectId: textBoxId,
            shapeType: "TEXT_BOX",
            elementProperties: {
              pageObjectId: customSlideId,
              size: {
                width: { magnitude: 400, unit: "PT" },
                height: { magnitude: 50, unit: "PT" }
              },
              transform: {
                scaleX: 1, scaleY: 1,
                translateX: 50, translateY: 50,
                unit: "PT"
              }
            }
          }
        },
        {
          insertText: {
            objectId: textBoxId,
            text: `Koi Test Run ${RUN_ID} - Automated Slide Content`,
            insertionIndex: 0
          }
        }
      ]
    });

    const textInsertText = textInsertRes.content ? textInsertRes.content[0].text : "";
    if (textInsertRes.isError || textInsertText.includes("error")) {
      console.warn(`⚠️ Text insertion issue: ${textInsertText.slice(0, 120)}`);
    } else {
      console.log("✓ Created text box and inserted text on slide.");
    }

    // 4. Verify text content is readable
    console.log(`\n[4/6] Verifying Slide Text Content...`);
    const contentVerifyRes = await tools.slides_read_content({ presentationId });
    const contentVerifyText = contentVerifyRes.content ? contentVerifyRes.content[0].text : "{}";
    try {
      const cData = JSON.parse(contentVerifyText);
      const allText = (cData.slides || []).map(s => s.text).filter(Boolean).join("\n");
      if (allText.includes(`Koi Test Run ${RUN_ID}`)) {
        console.log(`✓ Text content verified: found test string in slide text.`);
      } else {
        console.log(`⚠️ Text content read back ${allText.length} chars across ${cData.returnedSlides || 0} slides, test string not found.`);
      }
    } catch (e) { console.warn(`⚠️ Content parse error.`); }

    // 5. Delete the slide we just created (cleanup + tests deleteObject)
    console.log(`\n[5/6] Deleting Test Slide...`);
    const deleteRes = await tools.slides_batch_update({
      presentationId,
      requests: [{ deleteObject: { objectId: customSlideId } }]
    });
    const deleteText = deleteRes.content ? deleteRes.content[0].text : "";
    if (deleteRes.isError || deleteText.includes("error")) {
      console.warn(`⚠️ Slide deletion issue: ${deleteText.slice(0, 120)}`);
    } else {
      console.log("✓ Test slide deleted successfully.");
    }

    // Verify slide count decreased
    const postDeleteMeta = await tools.slides_get_metadata({ presentationId });
    const postDeleteText = postDeleteMeta.content ? postDeleteMeta.content[0].text : "{}";
    try {
      const pdMeta = JSON.parse(postDeleteText);
      console.log(`   Slide count after delete: ${pdMeta.slides ? pdMeta.slides.length : "?"}`);
    } catch (e) {}

    // 6. Auto-Navigation
    console.log(`\n[6/6] Navigating to Presentation...`);
    console.log(` URL: ${slideUrl}`);

    await tools.navigatePage(slideUrl);

    return {
      success: true,
      presentationId,
      url: slideUrl
    };

  } catch (e) {
    console.error("\n❌ TEST FAILED:", e.message);
    if (e.stack) console.error(e.stack);
    return { success: false, error: e.message };
  }
}

return run();
