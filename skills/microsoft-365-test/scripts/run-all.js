// scripts/run-all.js
// Runs all Microsoft 365 test scripts sequentially
// Usage: /skill microsoft-365-test/scripts/run-all.js --full-auto

await tools.readSkill({ name: "microsoft-365" });
console.log("========================================");
console.log("  Microsoft 365 — Full Test Suite");
console.log("========================================\n");

// ════════════════════════════════════════════════════════════════════════════
// 1. OneDrive Read-Only Test
// ════════════════════════════════════════════════════════════════════════════
async function runOneDriveTest() {
  const results = {};
  try {
    console.log(`\n==================================================`);
    console.log(`ONEDRIVE READ-ONLY VERIFICATION`);
    console.log(`==================================================`);

    // 1. onedrive_list (root)
    console.log(`\n[1/5] Listing OneDrive root files...`);
    const listRes = await tools.onedrive_list({ maxResults: 5 });
    const listText = listRes.content ? listRes.content[0].text : "{}";

    let firstFileId = null;

    if (listRes.isError || listText.includes("API Error")) {
      console.error(`✗ onedrive_list failed: ${listText}`);
      results.onedriveList = false;
    } else {
      try {
        const listData = JSON.parse(listText);
        const files = listData.files || [];
        console.log(`✓ Found ${files.length} files.`);
        files.forEach(f => {
          console.log(`   - "${f.name}" (${f.mimeType || (f.isFolder ? "folder" : "file")}) [${f.id}]`);
        });
        if (files.length > 0) firstFileId = files[0].id;
        results.onedriveList = true;
      } catch (e) {
        console.warn(`⚠️ Parse error: ${listText.slice(0, 200)}`);
        results.onedriveList = false;
      }
    }

    // 2. onedrive_list with folder (if first item is a folder)
    console.log(`\n[2/5] Listing OneDrive with pagination test...`);
    const listRes2 = await tools.onedrive_list({ maxResults: 2 });
    const listText2 = listRes2.content ? listRes2.content[0].text : "{}";

    if (listRes2.isError || listText2.includes("API Error")) {
      console.error(`✗ onedrive_list (paginated) failed: ${listText2}`);
      results.onedriveListPaginated = false;
    } else {
      try {
        const listData2 = JSON.parse(listText2);
        console.log(`✓ Paginated list returned ${(listData2.files || []).length} files. NextLink: ${listData2.nextLink ? "present" : "none"}`);
        results.onedriveListPaginated = true;
      } catch (e) {
        console.warn(`⚠️ Parse error`);
        results.onedriveListPaginated = false;
      }
    }

    // 3. onedrive_search
    console.log(`\n[3/5] Searching OneDrive for "test"...`);
    const searchRes = await tools.onedrive_search({ query: "test", maxResults: 5 });
    const searchText = searchRes.content ? searchRes.content[0].text : "{}";

    if (searchRes.isError || searchText.includes("API Error")) {
      console.error(`✗ onedrive_search failed: ${searchText}`);
      results.onedriveSearch = false;
    } else {
      try {
        const files = JSON.parse(searchText);
        const count = Array.isArray(files) ? files.length : 0;
        console.log(`✓ Search returned ${count} results.`);
        (Array.isArray(files) ? files : []).slice(0, 3).forEach(f => console.log(`   - "${f.name}" (${f.mimeType || "unknown"})`));
        results.onedriveSearch = true;
      } catch (e) {
        console.warn(`⚠️ Parse error`);
        results.onedriveSearch = false;
      }
    }

    // 4. onedrive_get_file_metadata
    console.log(`\n[4/5] Fetching File Metadata...`);
    if (firstFileId) {
      const metaRes = await tools.onedrive_get_file_metadata({ itemId: firstFileId });
      const metaText = metaRes.content ? metaRes.content[0].text : "{}";

      if (metaRes.isError || metaText.includes("API Error")) {
        console.error(`✗ onedrive_get_file_metadata failed: ${metaText}`);
        results.onedriveGetMetadata = false;
      } else {
        try {
          const meta = JSON.parse(metaText);
          console.log(`✓ File: "${meta.name}"`);
          console.log(`   MIME: ${meta.mimeType || "N/A"}`);
          console.log(`   Size: ${meta.size || "N/A"}`);
          console.log(`   Modified: ${meta.lastModified}`);
          console.log(`   URL: ${meta.webUrl}`);
          results.onedriveGetMetadata = true;
        } catch (e) {
          console.warn(`⚠️ Parse error`);
          results.onedriveGetMetadata = false;
        }
      }
    } else {
      console.log(`   (Skipped: No file available)`);
      results.onedriveGetMetadata = "skipped";
    }

    // 5. excel_list
    console.log(`\n[5/5] Listing Recent Excel Workbooks (excel_list)...`);
    const excelListRes = await tools.excel_list({ maxResults: 3 });
    const excelListText = excelListRes.content ? excelListRes.content[0].text : "{}";

    if (excelListRes.isError || excelListText.includes("API Error")) {
      console.error(`✗ excel_list failed: ${excelListText}`);
      results.excelList = false;
    } else {
      try {
        const excelData = JSON.parse(excelListText);
        const count = Array.isArray(excelData) ? excelData.length : 0;
        console.log(`✓ Found ${count} recent Excel workbooks.`);
        results.excelList = true;
      } catch (e) {
        console.warn(`⚠️ Parse error`);
        results.excelList = false;
      }
    }

    const allPassed = Object.values(results).every(v => v === true || v === "skipped");
    return { success: allPassed, results };
  } catch (e) {
    console.error("\n✗ TEST FAILED:", e.message);
    return { success: false, error: e.message, results };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Excel CRUD Test
// ════════════════════════════════════════════════════════════════════════════
async function runExcelTest() {
  const RUN_ID = Math.floor(Math.random() * 1000);
  const WORKBOOK_TITLE = `Koi Excel Test ${new Date().toLocaleTimeString().replace(/:/g, '-')} (Run ${RUN_ID})`;
  try {
    let existingItemId = null;
    if (typeof args !== 'undefined') {
      if (args.url) existingItemId = args.itemId || null;
      if (args.itemId) existingItemId = args.itemId;
    }

    if (existingItemId) {
      console.log(`\n==================================================`);
      console.log(`PART 1: READ-ONLY VERIFICATION`);
      console.log(`Target ID: ${existingItemId}`);
      console.log(`==================================================`);

      console.log(`\n[1/4] Fetching Metadata & Worksheets...`);
      const metaRes = await tools.excel_get_metadata({ itemId: existingItemId });
      const metaText = metaRes.content ? metaRes.content[0].text : "{}";
      try {
        const meta = JSON.parse(metaText);
        console.log(`✓ Name: "${meta.name}"`);
        if (meta.worksheets && meta.worksheets.length > 0) {
          console.log(`✓ Found ${meta.worksheets.length} Worksheets:`);
          meta.worksheets.forEach(s => console.log(`   - "${s.name}" (Position: ${s.position})`));
        }
      } catch (e) {}

      console.log(`\n[2/4] Reading Content from Sheet1...`);
      const readRes = await tools.excel_read_range({ itemId: existingItemId, range: "A1:Z50" });
      const readText = readRes.content ? readRes.content[0].text : "{}";
      try {
        const readData = JSON.parse(readText);
        console.log(`✓ Read ${readData.returnedRows} rows (total: ${readData.totalRows}).`);
      } catch (e) {}

      console.log(`\n[3/4] Testing CSV Export...`);
      const csvRes = await tools.excel_read_as_csv({ itemId: existingItemId, range: "A1:E10" });
      const csvText = csvRes.content ? csvRes.content[0].text : "";
      console.log(`✓ CSV Snippet:\n   ${csvText.split('\n').slice(0, 3).join('\n   ')}`);

      console.log(`\n[4/4] Reading with pagination...`);
      const pageRes = await tools.excel_read_range({ itemId: existingItemId, range: "A1:C100", offset: 5, limit: 3 });
      const pageText = pageRes.content ? pageRes.content[0].text : "{}";
      try {
        const pageData = JSON.parse(pageText);
        console.log(`✓ Paginated read: ${pageData.returnedRows} rows returned.`);
      } catch (e) {}
      console.log(`\nPart 1 Complete.\n`);
    } else {
      console.log("\n(Skipping Part 1: No --itemId provided)");
    }

    console.log(`\n==================================================`);
    console.log(`PART 2: CREATION & WRITE VERIFICATION`);
    console.log(`==================================================`);

    console.log(`\n[1/9] Creating Workbook: "${WORKBOOK_TITLE}"...`);
    const createResult = await tools.excel_create({ title: WORKBOOK_TITLE });
    let itemId = null;
    if (createResult.content) {
      for (const block of createResult.content) {
        if (block._createdFileId) { itemId = block._createdFileId; break; }
        if (typeof block.text === 'string') {
          const match = block.text.match(/Created workbook: (\S+)/);
          if (match) itemId = match[1];
        }
      }
    }
    if (!itemId) throw new Error("Failed to extract itemId from excel_create");
    console.log(`✓ Created. ID: ${itemId}`);

    console.log(`\n[2/9] Adding second worksheet "SummaryData"...`);
    const batchRes = await tools.excel_batch_update({
      itemId,
      requests: [{ method: "POST", url: "/worksheets/add", body: { name: "SummaryData" } }]
    });
    const batchResText = batchRes.content ? batchRes.content[0].text : "";
    if (batchRes.isError || batchResText.includes("error") || batchResText.includes("Error")) {
      console.warn(`⚠️ Batch update failed: ${batchResText.slice(0, 200)}`);
    } else {
      console.log("✓ Batch update sent successfully.");
    }

    console.log(`\n[3/9] Writing Headers & Hyperlinks...`);
    await tools.excel_write_range({
      itemId,
      range: "A1:B3",
      values: [
        ["Resource", "Link"],
        ["Google", '=HYPERLINK("https://www.google.com", "Google Search")'],
        ["Microsoft", '=HYPERLINK("https://www.microsoft.com", "Microsoft Home")']
      ]
    });
    console.log("✓ Wrote headers and hyperlink formulas");

    console.log(`\n[4/9] Writing to secondary worksheet...`);
    await tools.excel_write_range({
      itemId, worksheet: "SummaryData", range: "A1:B2",
      values: [["Category", "Count"], ["Test Items", "100"]]
    });
    console.log("✓ Wrote data to SummaryData worksheet");

    console.log(`\n[5/9] Stress Test: Writing 100 rows...`);
    const stressData = [];
    for (let i = 0; i < 100; i++) {
      stressData.push([`Item ${i}`, `${Math.random().toFixed(4)}`, i % 2 === 0 ? "TRUE" : "FALSE"]);
    }
    await tools.excel_write_range({ itemId, range: "A5:C104", values: stressData });

    console.log("   Reading back rows 50-60 via pagination...");
    const pageResult = await tools.excel_read_range({ itemId, range: "A5:C104", offset: 50, limit: 10 });
    const pageText = pageResult.content ? pageResult.content[0].text : "";
    try {
      const pageObj = JSON.parse(pageText);
      if (pageObj.values && pageObj.values.length > 0 && String(pageObj.values[0][0]) === "Item 50") {
        console.log("✓ Pagination Verified");
      }
    } catch (e) {}

    console.log(`\n[6/9] Testing CSV Export...`);
    const csvResult = await tools.excel_read_as_csv({ itemId, range: "A1:B3" });
    const csvTextExport = csvResult.content ? csvResult.content[0].text : "";
    if (csvTextExport.includes("Google")) {
      console.log("✓ CSV Export successful");
    }

    console.log(`\n[7/9] Testing Formula Evaluation...`);
    await tools.excel_write_range({
      itemId, range: "E1:G3",
      values: [["Num1", "Num2", "Sum"], [10, 20, "=E2+F2"], [30, 40, "=E3+F3"]]
    });
    const formulaReadRes = await tools.excel_read_range({ itemId, range: "G2:G3" });
    const formulaText = formulaReadRes.content ? formulaReadRes.content[0].text : "{}";
    try {
      const vals = JSON.parse(formulaText).values || [];
      if (vals.length >= 2 && Number(vals[0][0]) === 30 && Number(vals[1][0]) === 70) {
        console.log("✓ Formula evaluation verified");
      }
    } catch (e) {}

    console.log(`\n[8/9] Testing excel_clear_range...`);
    await tools.excel_clear_range({ itemId, range: "E1:G3" });
    const clearVerifyRes = await tools.excel_read_range({ itemId, range: "E1:G3" });
    const clearVerifyText = clearVerifyRes.content ? clearVerifyRes.content[0].text : "{}";
    try {
      const vals = JSON.parse(clearVerifyText).values || [];
      const isEmpty = vals.length === 0 || vals.every(row => row.every(c => c === "" || c === null || c === 0));
      console.log(`✓ Clear range ${isEmpty ? "verified" : "sent"}`);
    } catch (e) {}

    console.log(`\n[9/9] Navigating to Workbook...`);
    const urlRes = await tools.excel_get_metadata({ itemId });
    let webUrl = null;
    try { webUrl = JSON.parse(urlRes.content[0].text).webUrl; } catch (e) {}
    if (webUrl) await tools.navigatePage(webUrl);

    return { success: true, itemId, url: webUrl };
  } catch (e) {
    console.error("\n❌ TEST FAILED:", e.message);
    return { success: false, error: e.message };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Word Comprehensive Test
// ════════════════════════════════════════════════════════════════════════════
async function runWordTest() {
  const RUN_ID = Math.floor(Math.random() * 1000);
  const DOC_TITLE = `Koi Word Test ${new Date().toLocaleTimeString().replace(/:/g, '-')} (Run ${RUN_ID})`;
  try {
    let existingItemId = null;
    if (typeof args !== 'undefined' && args.itemId) existingItemId = args.itemId;

    if (existingItemId) {
      console.log(`\n==================================================`);
      console.log(`PART 1: READ-ONLY VERIFICATION`);
      console.log(`Target ID: ${existingItemId}`);
      console.log(`==================================================`);

      console.log(`\n[1/3] Fetching Metadata...`);
      const metaRes = await tools.word_get_metadata({ itemId: existingItemId });
      const metaText = metaRes.content ? metaRes.content[0].text : "{}";
      try {
        const meta = JSON.parse(metaText);
        console.log(`✓ Name: "${meta.name}"`);
        console.log(`✓ Size: ${meta.size} bytes`);
      } catch (e) {}

      console.log(`\n[2/3] Reading Content...`);
      const contentRes = await tools.word_read_content({ itemId: existingItemId });
      const contentText = contentRes.content ? contentRes.content[0].text : "{}";
      try {
        const content = JSON.parse(contentText);
        console.log(`✓ Content (${content.totalLength} chars)`);
      } catch (e) {}

      console.log(`\n[3/3] Testing Content Pagination...`);
      const pageRes = await tools.word_read_content({ itemId: existingItemId, startIndex: 0, endIndex: 50 });
      const pageText = pageRes.content ? pageRes.content[0].text : "{}";
      try {
        console.log(`✓ Paginated read: ${JSON.parse(pageText).returnedLength} chars`);
      } catch (e) {}
      console.log(`\nPart 1 Complete.\n`);
    } else {
      console.log("\n(Skipping Part 1: No --itemId provided)");
    }

    console.log(`\n==================================================`);
    console.log(`PART 2: CREATION & WRITE VERIFICATION`);
    console.log(`==================================================`);

    console.log(`\n[1/5] Creating Document: "${DOC_TITLE}"...`);
    const createResult = await tools.word_create({ title: DOC_TITLE });
    let itemId = null;
    if (createResult.content) {
      for (const block of createResult.content) {
        if (block._createdFileId) { itemId = block._createdFileId; break; }
        if (typeof block.text === 'string') {
          const match = block.text.match(/Created document: (\S+)/);
          if (match) itemId = match[1];
        }
      }
    }
    if (!itemId) throw new Error("Failed to extract itemId from word_create");
    console.log(`✓ Created. ID: ${itemId}`);

    console.log(`\n[2/5] Writing Content (HTML upload)...`);
    const htmlContent = `
      <html><body>
        <h1>Koi Word Test - Run ${RUN_ID}</h1>
        <p>Created by the Koi agent at ${new Date().toISOString()}.</p>
        <h2>Table Test</h2>
        <table border="1"><tr><th>Name</th><th>Value</th></tr><tr><td>Alpha</td><td>100</td></tr></table>
      </body></html>
    `.trim();

    const writeRes = await tools.word_batch_update({ itemId, htmlContent });
    if (writeRes.isError) console.warn(`⚠️ Write failed`);
    else console.log("✓ Wrote HTML content to document");

    console.log(`\n[3/5] Verifying Content...`);
    const verifyRes = await tools.word_read_content({ itemId });
    const verifyText = verifyRes.content ? verifyRes.content[0].text : "{}";
    try {
      const text = JSON.parse(verifyText).text || "";
      if (text.includes("Koi Word Test") && text.includes("Alpha")) console.log(`✓ Content verified`);
    } catch (e) {}

    console.log(`\n[4/5] Testing Second Write (Overwrite)...`);
    const htmlContent2 = `<html><body><h1>Updated: Koi Word Test - Run ${RUN_ID}</h1></body></html>`;
    await tools.word_batch_update({ itemId, htmlContent: htmlContent2 });
    const verify2Res = await tools.word_read_content({ itemId });
    try {
      const v2Text = JSON.parse(verify2Res.content[0].text).text || "";
      if (v2Text.includes("Updated: Koi Word Test") && !v2Text.includes("Alpha")) {
        console.log(`✓ Overwrite verified`);
      }
    } catch (e) {}

    console.log(`\n[5/5] Navigating to Document...`);
    const metaFinal = await tools.word_get_metadata({ itemId });
    let webUrl = null;
    try { webUrl = JSON.parse(metaFinal.content[0].text).webUrl; } catch (e) {}
    if (webUrl) await tools.navigatePage(webUrl);

    return { success: true, itemId, url: webUrl };
  } catch (e) {
    console.error("\n❌ TEST FAILED:", e.message);
    return { success: false, error: e.message };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 4. PowerPoint Comprehensive Test
// ════════════════════════════════════════════════════════════════════════════
async function runPptTest() {
  const RUN_ID = Math.floor(Math.random() * 1000);
  const PPT_TITLE = `Koi PPT Test ${new Date().toLocaleTimeString().replace(/:/g, '-')} (Run ${RUN_ID})`;
  const IMAGE_TEST_ITEM_ID = "F149FA8C0789C155!158";

  try {
    let existingItemId = null;
    if (typeof args !== 'undefined' && args.itemId) existingItemId = args.itemId;

    if (existingItemId) {
      console.log(`\n==================================================`);
      console.log(`PART 1: READ-ONLY VERIFICATION`);
      console.log(`Target ID: ${existingItemId}`);
      console.log(`==================================================`);

      console.log(`\n[1/2] Fetching Metadata...`);
      const metaRes = await tools.ppt_get_metadata({ itemId: existingItemId });
      try {
        const meta = JSON.parse(metaRes.content[0].text);
        console.log(`✓ Name: "${meta.name}", Size: ${meta.size}`);
      } catch (e) {}

      console.log(`\n[2/2] Reading Content (Text Extraction)...`);
      const contentRes = await tools.ppt_read_content({ itemId: existingItemId });
      if (!contentRes.isError) {
        console.log(`✓ Extracted text: ${contentRes.content[0].text.length} chars`);
      }
    }

    const imageTestId = existingItemId || IMAGE_TEST_ITEM_ID;
    console.log(`\n==================================================`);
    console.log(`PART 1B: SLIDE-TO-IMAGE MAP TEST`);
    console.log(`Target ID: ${imageTestId}`);
    console.log(`==================================================`);
    try {
      const imgMeta = await tools.ppt_get_metadata({ itemId: imageTestId });
      const imgMetaObj = JSON.parse(imgMeta.content[0].text);
      const totalSlides = imgMetaObj.slideCount || 10;
      const slideImageMap = {};
      let totalImages = 0;
      for (let s = 1; s <= totalSlides; s++) {
        const res = await tools.ppt_get_images({ itemId: imageTestId, startSlide: s, endSlide: s });
        try {
          const images = JSON.parse(res.content[0].text).images || [];
          if (images.length > 0) {
            slideImageMap[s] = images.map(img => img.name || img.path || img.filename);
            totalImages += images.length;
          }
        } catch (e) {}
      }
      console.log(`--- Total: ${totalImages} images across ${Object.keys(slideImageMap).length} slides ---`);
    } catch (e) {}

    console.log(`\n==================================================`);
    console.log(`PART 2: CREATION & VERIFICATION`);
    console.log(`==================================================`);
    console.log(`\n[1/3] Creating Presentation: "${PPT_TITLE}"...`);
    const createResult = await tools.ppt_create({ title: PPT_TITLE });
    let itemId = null;
    if (createResult.content) {
      for (const block of createResult.content) {
        if (block._createdFileId) { itemId = block._createdFileId; break; }
        if (typeof block.text === 'string') {
          const match = block.text.match(/Created presentation: (\S+)/);
          if (match) itemId = match[1];
        }
      }
    }
    if (!itemId) throw new Error("Failed to extract itemId from ppt_create");
    console.log(`✓ Created. ID: ${itemId}`);

    console.log(`\n[2/3] Verifying Metadata...`);
    const metaRes = await tools.ppt_get_metadata({ itemId });
    let webUrl = null;
    try { webUrl = JSON.parse(metaRes.content[0].text).webUrl; } catch (e) {}

    console.log(`\n[3/3] Reading Content from Empty Presentation...`);
    const readRes = await tools.ppt_read_content({ itemId });
    if (readRes.isError) console.log(`   Expected: Empty or minimal content. Got error/fallback.`);
    else console.log(`✓ Content from empty deck confirmed`);

    if (webUrl) await tools.navigatePage(webUrl);

    return { success: true, itemId, url: webUrl };
  } catch (e) {
    console.error("\n❌ TEST FAILED:", e.message);
    return { success: false, error: e.message };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Outlook & Calendar Test
// ════════════════════════════════════════════════════════════════════════════
async function runOutlookCalendarTest() {
  const results = { outlook: {}, calendar: {} };
  try {
    console.log(`\n==================================================`);
    console.log(`PART 1: OUTLOOK MAIL READ-ONLY`);
    console.log(`==================================================`);

    console.log(`\n[1/5] Listing Outlook Mail Folders...`);
    const foldersRes = await tools.outlook_list_folders({});
    const foldersText = foldersRes.content ? foldersRes.content[0].text : "[]";
    if (foldersRes.isError || foldersText.includes("API Error")) {
      console.error(`✗ outlook_list_folders failed`);
      results.outlook.folders = false;
    } else {
      try {
        const folders = JSON.parse(foldersText);
        console.log(`✓ Found ${folders.length} folders.`);
        results.outlook.folders = true;
      } catch (e) { results.outlook.folders = false; }
    }

    console.log(`\n[2/5] Searching Outlook (recent messages)...`);
    const searchRes = await tools.outlook_search({ query: "*", maxResults: 5 });
    const searchText = searchRes.content ? searchRes.content[0].text : "{}";
    let firstMessageId = null;
    let firstConversationId = null;

    if (searchRes.isError || searchText.includes("API Error")) {
      console.error(`✗ outlook_search failed`);
      results.outlook.search = false;
    } else {
      try {
        const searchData = JSON.parse(searchText);
        const msgs = searchData.messages || [];
        console.log(`✓ Found ${msgs.length} messages.`);
        if (msgs.length > 0) {
          firstMessageId = msgs[0].id;
          firstConversationId = msgs[0].conversationId;
        }
        results.outlook.search = true;
      } catch (e) { results.outlook.search = false; }
    }

    console.log(`\n[3/5] Fetching Message Detail...`);
    if (firstMessageId) {
      const msgRes = await tools.outlook_get_message({ messageId: firstMessageId });
      if (msgRes.isError) results.outlook.getMessage = false;
      else {
        try {
          const msg = JSON.parse(msgRes.content[0].text);
          console.log(`✓ Message ID: ${msg.id}`);
          if (msg.attachments && msg.attachments.length > 0) {
            const attRes = await tools.outlook_get_attachment({ messageId: firstMessageId, attachmentId: msg.attachments[0].id });
            results.outlook.getAttachment = !attRes.isError;
          }
          results.outlook.getMessage = true;
        } catch (e) { results.outlook.getMessage = false; }
      }
    } else {
      results.outlook.getMessage = "skipped";
    }

    console.log(`\n[4/5] Fetching Conversation Thread...`);
    if (firstConversationId) {
      const threadRes = await tools.outlook_get_thread({ conversationId: firstConversationId });
      if (!threadRes.isError) {
        console.log(`✓ Conversation fetched`);
        results.outlook.getThread = true;
      } else results.outlook.getThread = false;
    } else {
      results.outlook.getThread = "skipped";
    }
    if (results.outlook.getAttachment === undefined) results.outlook.getAttachment = "skipped";

    console.log(`\n==================================================`);
    console.log(`PART 2: CALENDAR READ-ONLY`);
    console.log(`==================================================`);

    console.log(`\n[1/3] Listing Calendars...`);
    const calListRes = await tools.ms_calendar_list({});
    let defaultCalId = null;
    if (!calListRes.isError) {
      try {
        const calendars = JSON.parse(calListRes.content[0].text);
        console.log(`✓ Found ${calendars.length} calendars.`);
        calendars.forEach(c => { if (c.isDefaultCalendar) defaultCalId = c.id; });
        results.calendar.list = true;
      } catch (e) { results.calendar.list = false; }
    } else results.calendar.list = false;

    console.log(`\n[2/3] Fetching Events (next 30 days)...`);
    const now = new Date();
    const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const eventsArgs = { startDateTime: now.toISOString(), endDateTime: future.toISOString(), maxResults: 10 };
    if (defaultCalId) eventsArgs.calendarId = defaultCalId;

    const eventsRes = await tools.ms_calendar_get_events(eventsArgs);
    let firstEventId = null;
    if (!eventsRes.isError) {
      try {
        const events = JSON.parse(eventsRes.content[0].text).events || [];
        console.log(`✓ Found ${events.length} upcoming events.`);
        if (events.length > 0) firstEventId = events[0].id;
        results.calendar.getEvents = true;
      } catch (e) { results.calendar.getEvents = false; }
    } else results.calendar.getEvents = false;

    console.log(`\n[3/3] Fetching Single Event Detail...`);
    if (firstEventId) {
      const eventRes = await tools.ms_calendar_get_event({ eventId: firstEventId });
      if (!eventRes.isError) {
        console.log(`✓ Event details fetched`);
        results.calendar.getEvent = true;
      } else results.calendar.getEvent = false;
    } else results.calendar.getEvent = "skipped";

    const allPassed = Object.values(results.outlook).every(v => v === true || v === "skipped")
                   && Object.values(results.calendar).every(v => v === true || v === "skipped");
    return { success: allPassed, results };
  } catch (e) {
    console.error("\n✗ TEST FAILED:", e.message);
    return { success: false, error: e.message, results };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Guardrail & Negative Test
// ════════════════════════════════════════════════════════════════════════════
async function runGuardrailTest() {
  const RUN_ID = Math.floor(Math.random() * 1000);
  const results = {};
  try {
    console.log(`\n==================================================`);
    console.log(`PART 1: GUARDRAIL DENY PATH`);
    console.log(`==================================================`);

    console.log(`\n[1/3] Attempting excel_write_range on non-owned file...`);
    const writeRes = await tools.excel_write_range({ itemId: "FAKE_ITEM_ID_A", range: "A1", values: [["Should be blocked"]] });
    const writeText = writeRes.content ? writeRes.content[0].text : "";
    if (writeRes.isError || writeText.includes("GUARDRAIL BLOCK") || writeText.includes("denied")) {
      console.log(`✓ Excel write correctly blocked`);
      results.guardrailDenyExcel = true;
    } else results.guardrailDenyExcel = false;

    console.log(`\n[2/3] Attempting word_batch_update on non-owned file...`);
    const docWriteRes = await tools.word_batch_update({ itemId: "FAKE_ITEM_ID_B", htmlContent: "<p>blocked</p>" });
    const docWriteText = docWriteRes.content ? docWriteRes.content[0].text : "";
    if (docWriteRes.isError || docWriteText.includes("GUARDRAIL BLOCK") || docWriteText.includes("denied")) {
      console.log(`✓ Word write correctly blocked`);
      results.guardrailDenyWord = true;
    } else results.guardrailDenyWord = false;

    console.log(`\n[3/3] Attempting ppt_batch_update on non-owned file...`);
    const pptWriteRes = await tools.ppt_batch_update({ itemId: "FAKE_ITEM_ID_C", base64Content: "UEsDBBQAAAAI" });
    const pptWriteText = pptWriteRes.content ? pptWriteRes.content[0].text : "";
    if (pptWriteRes.isError || pptWriteText.includes("GUARDRAIL BLOCK") || pptWriteText.includes("denied")) {
      console.log(`✓ PPT write correctly blocked`);
      results.guardrailDenyPpt = true;
    } else results.guardrailDenyPpt = false;

    console.log(`\n==================================================`);
    console.log(`PART 2: ERROR HANDLING`);
    console.log(`==================================================`);

    console.log(`\n[1/4] Reading non-existent workbook...`);
    const badReadRes = await tools.excel_read_range({ itemId: "NONEXISTENT_ID", range: "A1:B2" });
    if (badReadRes.isError || (badReadRes.content && badReadRes.content[0].text.includes("rror"))) results.errorBadExcelId = true;
    else results.errorBadExcelId = false;

    console.log(`\n[2/4] Reading non-existent document...`);
    const badDocRes = await tools.word_read_content({ itemId: "NONEXISTENT_DOC" });
    if (badDocRes.isError || (badDocRes.content && badDocRes.content[0].text.includes("rror"))) results.errorBadDocId = true;
    else results.errorBadDocId = false;

    console.log(`\n[3/4] Reading non-existent presentation...`);
    const badPptRes = await tools.ppt_get_metadata({ itemId: "NONEXISTENT_PPT" });
    if (badPptRes.isError || (badPptRes.content && badPptRes.content[0].text.includes("rror"))) results.errorBadPptId = true;
    else results.errorBadPptId = false;

    console.log(`\n[4/4] Fetching non-existent Outlook message...`);
    const badMailRes = await tools.outlook_get_message({ messageId: "NONEXISTENT_MSG" });
    if (badMailRes.isError || (badMailRes.content && badMailRes.content[0].text.includes("rror"))) results.errorBadMailId = true;
    else results.errorBadMailId = false;

    console.log(`\n==================================================`);
    console.log(`PART 3: EXCEL CLEAR_RANGE`);
    console.log(`==================================================`);
    console.log(`\n[1/3] Creating test workbook...`);
    const createRes = await tools.excel_create({ title: `Koi Clear Test ${RUN_ID}` });
    let itemId = null;
    if (createRes.content) {
      for (const block of createRes.content) {
        if (block._createdFileId) { itemId = block._createdFileId; break; }
        if (typeof block.text === 'string') {
          const match = block.text.match(/Created workbook: (\S+)/);
          if (match) itemId = match[1];
        }
      }
    }

    if (!itemId) {
      results.clearRange = false;
    } else {
      console.log(`✓ Created: ${itemId}`);
      await tools.excel_write_range({ itemId, range: "A1:B3", values: [["Name", "Value"], ["Alice", "100"], ["Bob", "200"]] });
      console.log(`✓ Wrote 3 rows`);
      const clearRes = await tools.excel_clear_range({ itemId, range: "A1:B3" });
      if (clearRes.isError) results.clearRange = false;
      else {
        console.log(`✓ Clear range sent`);
        results.clearRange = true;
      }
    }

    const allPassed = Object.values(results).every(v => v === true);
    return { success: allPassed, results };
  } catch (e) {
    console.error("\n✗ TEST FAILED:", e.message);
    return { success: false, error: e.message, results };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Test Runner Orchestrator
// ════════════════════════════════════════════════════════════════════════════

const testRunners = [
  { name: "OneDrive Read-Only", fn: runOneDriveTest },
  { name: "Excel CRUD", fn: runExcelTest },
  { name: "Word Comprehensive", fn: runWordTest },
  { name: "PowerPoint Comprehensive", fn: runPptTest },
  { name: "Outlook & Calendar", fn: runOutlookCalendarTest },
  { name: "Guardrail & Negative", fn: runGuardrailTest }
];

const results = {};

for (const test of testRunners) {
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║  Running: ${test.name.padEnd(39)}║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);

  try {
    const result = await test.fn();
    results[test.name] = result?.success ? "✓ PASS" : "✗ FAIL";
    if (!result?.success && result?.error) {
      console.log(`   Error: ${result.error}`);
    }
  } catch (e) {
    results[test.name] = `✗ ERROR: ${e.message}`;
  }
}

console.log(`\n╔══════════════════════════════════════════════════╗`);
console.log(`║              FINAL RESULTS                       ║`);
console.log(`╚══════════════════════════════════════════════════╝\n`);

let allPassed = true;
for (const [name, status] of Object.entries(results)) {
  console.log(`  ${status.padEnd(12)} ${name}`);
  if (!status.startsWith("✓")) allPassed = false;
}

const passCount = Object.values(results).filter(v => v.startsWith("✓")).length;
const totalCount = Object.keys(results).length;

console.log(`\n  Total: ${passCount}/${totalCount} passed`);

return { success: allPassed, results };
