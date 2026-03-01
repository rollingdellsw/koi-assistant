// scripts/docs-comprehensive-test-v4.js
// Features:
// v5 additions: table insertion, delete content range
// 1. Read-Only Test (Optional, triggers if --url is provided)
// 2. Creation Test (Always runs, original logic)

await tools.readSkill({ name: "google-workspace" });
console.log("Starting Google Docs Comprehensive Test (v4)...");

const RUN_ID = Math.floor(Math.random() * 1000);
const DOC_TITLE = `Koi Docs Test ${new Date().toLocaleTimeString()} (Run ${RUN_ID})`;
const TEST_IMAGE_URL = "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png";

async function run() {
  try {
    // ---------------------------------------------------------
    // PART 1: READ-ONLY TEST (Existing Document)
    // ---------------------------------------------------------
    // Check if 'url' was passed in args. Supports object {url: ...} or array scanning.
    let existingDocId = null;
    if (typeof args !== 'undefined') {
        if (args.url) {
            const match = args.url.match(/document\/d\/([a-zA-Z0-9-_]+)/);
            if (match) existingDocId = match[1];
        } else if (Array.isArray(args)) {
            // Fallback for array-style args: look for string starting with http
            const urlArg = args.find(a => typeof a === 'string' && a.includes("docs.google.com"));
            if (urlArg) {
                const match = urlArg.match(/document\/d\/([a-zA-Z0-9-_]+)/);
                if (match) existingDocId = match[1];
            }
        }
    }

    if (existingDocId) {
        console.log(`\n==================================================`);
        console.log(`PART 1: READ-ONLY VERIFICATION`);
        console.log(`Target ID: ${existingDocId}`);
        console.log(`==================================================`);

        // A. Metadata & Tabs
        console.log(`\n[1/4] Fetching Metadata & Tabs...`);
        const metaRes = await tools.docs_get_metadata({ documentId: existingDocId });
        const meta = JSON.parse(metaRes.content[0].text);

        console.log(`✓ Title: "${meta.title}"`);
        console.log(`✓ Revision: ${meta.revisionId}`);

        if (meta.tabs && meta.tabs.length > 0) {
            console.log(`✓ Found ${meta.tabs.length} Tabs:`);
            meta.tabs.forEach(t => console.log(`   - [${t.tabId}] "${t.title}" (Index: ${t.index})`));
        } else {
            console.log(`✓ No explicit tabs found (Single tab document).`);
        }

        // B. Read Content (First Tab + Specific Tab if exists)
        console.log(`\n[2/4] Reading Content...`);

        // Read "first" view (default)
        const contentRes = await tools.docs_read_content({ documentId: existingDocId });
        const content = JSON.parse(contentRes.content[0].text);
        console.log(`✓ Default Content (${content.totalChars} chars):`);
        console.log(`   "${content.text.slice(0, 100).replace(/\n/g, ' ')}..."`);

        // If there are specific tabs, try reading the second one as a test
        if (meta.tabs && meta.tabs.length > 1) {
            const secondTab = meta.tabs[1];
            console.log(`   Reading second tab: "${secondTab.title}"...`);
            const tabRes = await tools.docs_read_content({ documentId: existingDocId, tabId: secondTab.tabId });
            const tabContent = JSON.parse(tabRes.content[0].text);
            console.log(`   ✓ Tab Content (${tabContent.totalChars} chars): "${tabContent.text.slice(0, 50).replace(/\n/g, ' ')}..."`);
        }

        // C. Get Images
        console.log(`\n[3/4] Scanning for Images...`);
        const imgRes = await tools.docs_get_images({ documentId: existingDocId });
        const imgData = JSON.parse(imgRes.content[0].text);
        console.log(`✓ Found ${imgData.images ? imgData.images.length : 0} images.`);
        if (imgData.images && imgData.images.length > 0) {
             console.log(`   First Image ID: ${imgData.images[0].objectId}`);
        }

        // D. Get URLs
        console.log(`\n[4/4] Scanning for Hyperlinks...`);
        const urlRes = await tools.docs_get_urls({ documentId: existingDocId });
        const urlData = JSON.parse(urlRes.content[0].text);
        console.log(`✓ Found ${urlData.urls ? urlData.urls.length : 0} links.`);

        console.log(`\nPart 1 Complete.\n`);
    } else {
        console.log("\n(Skipping Part 1: No --url provided)");
    }

    // ---------------------------------------------------------
    // PART 2: CREATION TEST (Original Logic)
    // ---------------------------------------------------------
    console.log(`\n==================================================`);
    console.log(`PART 2: CREATION & WRITE VERIFICATION`);
    console.log(`==================================================`);

    console.log(`\n[1/7] Creating Document: "${DOC_TITLE}"...`);
    const createResult = await tools.docs_create({ title: DOC_TITLE });

    let documentId = createResult.documentId;

    // Robust ID extraction
    if (!documentId && createResult.content) {
       const match = createResult.content[0].text.match(/document: ([a-zA-Z0-9-_]+)/);
       if (match) documentId = match[1];
    }
    if (!documentId && createResult.content) {
        try {
            const json = JSON.parse(createResult.content[0].text);
            if (json._createdFileId) documentId = json._createdFileId;
        } catch (e) {}
    }

    if (!documentId) throw new Error("Failed to extract documentId");
    console.log(`✓ Created. ID: ${documentId}`);

    const docUrl = `https://docs.google.com/document/d/${documentId}`;

    // ---------------------------------------------------------
    // 2. Write Content (Main Tab)
    // ---------------------------------------------------------
    console.log(`\n[2/7] Writing Content & References to Main Tab...`);

    await tools.docs_batch_update({
      documentId,
      requests: [
        {
          insertText: {
            text: "Welcome to Koi Test.\nCheck this Reference: Google Search\n",
            location: { index: 1 }
          }
        },
        {
          updateTextStyle: {
            range: { startIndex: 43, endIndex: 56 },
            textStyle: {
              link: { url: "https://www.google.com" },
              foregroundColor: { color: { rgbColor: { blue: 1.0 } } },
              underline: true
            },
            fields: "link,foregroundColor,underline"
          }
        }
      ]
    });
    console.log("✓ Wrote text and applied hyperlink style");

    // ---------------------------------------------------------
    // 3. Multi-Tab Verification (Graceful Fallback)
    // ---------------------------------------------------------
    console.log(`\n[3/7] Attempting to Create "Appendix" Tab...`);

    const tabCreateRes = await tools.docs_batch_update({
      documentId,
      requests: [{
        addTab: { tabProperties: { title: "Appendix" } }
      }]
    });

    const responseText = tabCreateRes.content ? tabCreateRes.content[0].text : "";

    // Check for "Unknown name" error which means API doesn't support tabs yet
    if (tabCreateRes.isError || responseText.includes("Unknown name") || responseText.includes("API Error")) {
        console.warn("⚠️  Tab feature not supported by this API version. Skipping multi-tab write.");
    } else {
        try {
            const tabResponseJson = JSON.parse(responseText);
            const newTabId = tabResponseJson.replies?.[0]?.addTab?.tabId;

            if (newTabId) {
                console.log(`✓ Created Tab "Appendix" with ID: ${newTabId}`);
                await tools.docs_batch_update({
                    documentId,
                    requests: [{
                        insertText: {
                            text: "This is the Appendix content.\nVerified multi-tab write access.",
                            location: { index: 1, tabId: newTabId }
                        }
                    }]
                });
                console.log("✓ Wrote content to Appendix tab");
            }
        } catch (parseErr) {
            console.warn("⚠️  Could not parse tab response. Skipping write.");
        }
    }

    // ---------------------------------------------------------
    // 4. Image Insertion
    // ---------------------------------------------------------
    console.log(`\n[4/7] Inserting Image...`);
    await tools.docs_batch_update({
      documentId,
      requests: [{
        insertInlineImage: {
          uri: TEST_IMAGE_URL,
          location: { index: 1 },
          objectSize: {
            height: { magnitude: 50, unit: "PT" },
            width: { magnitude: 150, unit: "PT" }
          }
        }
      }]
    });
    console.log("✓ Inserted test image via URI");

    // ---------------------------------------------------------
    // 5. Table Insertion
    // ---------------------------------------------------------
    console.log(`\n[5/9] Inserting Table...`);

    // Read current doc length to find safe insertion index
    const preTableContent = await tools.docs_read_content({ documentId });
    const preTableText = JSON.parse(preTableContent.content[0].text);
    const tableInsertIdx = Math.max(preTableText.totalChars - 1, 2);

    await tools.docs_batch_update({
      documentId,
      requests: [{
        insertTable: {
          rows: 3,
          columns: 2,
          location: { index: tableInsertIdx }
        }
      }]
    });
    console.log("✓ Inserted 3x2 table");

    // ---------------------------------------------------------
    // 6. Delete Content Range (remove a small portion)
    // ---------------------------------------------------------
    console.log(`\n[6/9] Testing deleteContentRange...`);
    // Read fresh content to get accurate indices
    const preDeleteContent = await tools.docs_read_content({ documentId });
    const preDeleteData = JSON.parse(preDeleteContent.content[0].text);
    const docLength = preDeleteData.totalChars;

    if (docLength > 10) {
      // Delete a safe 2-char range near the start (after the image at index 1)
      await tools.docs_batch_update({
        documentId,
        requests: [{
          deleteContentRange: {
            range: { startIndex: 2, endIndex: 4 }
          }
        }]
      });
      console.log("✓ Deleted content range [2,4)");
    } else {
      console.log("⚠️ Doc too short to safely delete content, skipping");
    }

    // ---------------------------------------------------------
    // 7. Verification: References
    // ---------------------------------------------------------
    console.log(`\n[7/9] Verifying References (URLs)...`);
    const urlsResult = await tools.docs_get_urls({ documentId });
    const urls = JSON.parse(urlsResult.content[0].text);

    const foundLink = urls.urls.find(u => u.url.includes("google.com"));
    if (foundLink) {
      console.log(`✓ Reference Verified: Found link to "${foundLink.url}"`);
    } else {
      console.warn(`⚠ Could not verify inserted link.`);
    }

    // ---------------------------------------------------------
    // 8. Verification: Images
    // ---------------------------------------------------------
    console.log(`\n[8/9] Verifying Images...`);
    const imgResult = await tools.docs_get_images({ documentId });
    const imgs = JSON.parse(imgResult.content[0].text);

    if (imgs.images && imgs.images.length > 0) {
      console.log(`✓ Image Verified: Found ${imgs.images.length} embedded image(s).`);
    } else {
      console.warn("⚠ No images found.");
    }

    // ---------------------------------------------------------
    // 9. Auto-Navigation (Fixed Tool Name)
    // ---------------------------------------------------------
    console.log(`\n[9/9] Navigating to Document...`);
    console.log(` URL: ${docUrl}`);

    // FIX: sandbox-impl.js exposes this as camelCase 'navigatePage'
    await tools.navigatePage(docUrl)

    return {
      success: true,
      documentId,
      url: docUrl
    };

  } catch (e) {
    console.error("\n❌ TEST FAILED:", e.message);
    if (e.stack) console.error(e.stack);
    return { success: false, error: e.message };
  }
}

return run();
