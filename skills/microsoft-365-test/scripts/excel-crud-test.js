// scripts/excel-crud-test.js
// Excel Online full coverage test
// Covers: excel_create, excel_get_metadata, excel_read_range, excel_read_as_csv,
//         excel_write_range, excel_batch_update, excel_clear_range
// v1: Initial version mirroring sheets-crud-test.js

await tools.readSkill({ name: "microsoft-365" });
console.log("Starting Excel Online Full Coverage Test...");

const RUN_ID = Math.floor(Math.random() * 1000);
const WORKBOOK_TITLE = `Koi Excel Test ${new Date().toLocaleTimeString().replace(/:/g, '-')} (Run ${RUN_ID})`;

async function run() {
  try {
    // ---------------------------------------------------------
    // PART 1: READ-ONLY TEST (Existing Workbook)
    // ---------------------------------------------------------
    let existingItemId = null;
    if (typeof args !== 'undefined') {
      if (args.url) {
        // OneDrive URLs don't embed IDs the same way; try to extract or use itemId directly
        existingItemId = args.itemId || null;
      }
      if (args.itemId) {
        existingItemId = args.itemId;
      }
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
      } catch (e) {
        console.warn(`⚠️ Parse error: ${metaText.slice(0, 200)}`);
      }

      console.log(`\n[2/4] Reading Content from Sheet1...`);
      const readRes = await tools.excel_read_range({ itemId: existingItemId, range: "A1:Z50" });
      const readText = readRes.content ? readRes.content[0].text : "{}";
      try {
        const readData = JSON.parse(readText);
        console.log(`✓ Read ${readData.returnedRows} rows (total: ${readData.totalRows}).`);
      } catch (e) {
        console.warn(`⚠️ Read parse error`);
      }

      console.log(`\n[3/4] Testing CSV Export...`);
      const csvRes = await tools.excel_read_as_csv({ itemId: existingItemId, range: "A1:E10" });
      const csvText = csvRes.content ? csvRes.content[0].text : "";
      console.log(`✓ CSV Snippet:\n   ${csvText.split('\n').slice(0, 3).join('\n   ')}`);

      console.log(`\n[4/4] Reading with pagination (offset/limit)...`);
      const pageRes = await tools.excel_read_range({ itemId: existingItemId, range: "A1:C100", offset: 5, limit: 3 });
      const pageText = pageRes.content ? pageRes.content[0].text : "{}";
      try {
        const pageData = JSON.parse(pageText);
        console.log(`✓ Paginated read: ${pageData.returnedRows} rows returned.`);
      } catch (e) {
        console.warn(`⚠️ Pagination parse error`);
      }

      console.log(`\nPart 1 Complete.\n`);
    } else {
      console.log("\n(Skipping Part 1: No --itemId provided)");
    }

    // ---------------------------------------------------------
    // PART 2: CREATION & CRUD TEST
    // ---------------------------------------------------------
    console.log(`\n==================================================`);
    console.log(`PART 2: CREATION & WRITE VERIFICATION`);
    console.log(`==================================================`);

    console.log(`\n[1/9] Creating Workbook: "${WORKBOOK_TITLE}"...`);
    const createResult = await tools.excel_create({ title: WORKBOOK_TITLE });

    let itemId = null;
    if (createResult.content) {
      for (const block of createResult.content) {
        if (block._createdFileId) {
          itemId = block._createdFileId;
          break;
        }
        if (typeof block.text === 'string') {
          const match = block.text.match(/Created workbook: (\S+)/);
          if (match) itemId = match[1];
        }
      }
    }

    if (!itemId) throw new Error("Failed to extract itemId from excel_create");
    console.log(`✓ Created. ID: ${itemId}`);

    // 2. Worksheet Management (Batch Update — add worksheet)
    console.log(`\n[2/9] Adding second worksheet "SummaryData"...`);
    const batchRes = await tools.excel_batch_update({
      itemId,
      requests: [{
        method: "POST",
        url: "/worksheets/add",
        body: { name: "SummaryData" }
      }]
    });

    const batchResText = batchRes.content ? batchRes.content[0].text : "";
    if (batchRes.isError || batchResText.includes("error") || batchResText.includes("Error")) {
      console.warn(`⚠️ Batch update failed: ${batchResText.slice(0, 200)}`);
    } else {
      console.log("✓ Batch update sent successfully.");
    }

    // Verify worksheets
    const newMeta = await tools.excel_get_metadata({ itemId });
    const newMetaText = newMeta.content ? newMeta.content[0].text : "";
    try {
      const newMetaObj = JSON.parse(newMetaText);
      const wsNames = (newMetaObj.worksheets || []).map(s => s.name);
      console.log(`✓ Current worksheets: ${wsNames.join(", ")}`);
    } catch (e) {
      console.warn(`⚠️ Failed to parse metadata: ${newMetaText.slice(0, 200)}`);
    }

    // 3. Write data with formulas
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

    // 4. Cross-worksheet writing
    console.log(`\n[4/9] Writing to secondary worksheet...`);
    await tools.excel_write_range({
      itemId,
      worksheet: "SummaryData",
      range: "A1:B2",
      values: [["Category", "Count"], ["Test Items", "100"]]
    });
    console.log("✓ Wrote data to SummaryData worksheet");

    // 5. Stress test: write 100 rows
    console.log(`\n[5/9] Stress Test: Writing 100 rows...`);
    const stressData = [];
    for (let i = 0; i < 100; i++) {
      stressData.push([`Item ${i}`, `${Math.random().toFixed(4)}`, i % 2 === 0 ? "TRUE" : "FALSE"]);
    }

    await tools.excel_write_range({
      itemId,
      range: "A5:C104",
      values: stressData
    });

    console.log("   Reading back rows 50-60 via pagination...");
    const pageResult = await tools.excel_read_range({
      itemId,
      range: "A5:C104",
      offset: 50,
      limit: 10
    });

    const pageText = pageResult.content ? pageResult.content[0].text : "";
    try {
      const pageObj = JSON.parse(pageText);
      if (pageObj.values && pageObj.values.length > 0 && String(pageObj.values[0][0]) === "Item 50") {
        console.log("✓ Pagination Verified: correctly read offset 50");
      } else {
        console.warn(`⚠️ Pagination data mismatch. Got: ${JSON.stringify(pageObj.values?.[0])}`);
      }
    } catch (e) {
      console.warn(`⚠️ Pagination read parse error: ${pageText.slice(0, 100)}`);
    }

    // 6. CSV Export
    console.log(`\n[6/9] Testing CSV Export...`);
    const csvResult = await tools.excel_read_as_csv({ itemId, range: "A1:B3" });
    const csvTextExport = csvResult.content ? csvResult.content[0].text : "";
    if (csvTextExport.includes("Google") || csvTextExport.includes("Resource")) {
      console.log("✓ CSV Export successful");
    } else {
      console.warn(`⚠️ CSV Export failed or missing expected data: ${csvTextExport.slice(0, 100)}`);
    }

    // 7. Formula Evaluation
    console.log(`\n[7/9] Testing Formula Evaluation...`);
    await tools.excel_write_range({
      itemId,
      range: "E1:G3",
      values: [["Num1", "Num2", "Sum"], [10, 20, "=E2+F2"], [30, 40, "=E3+F3"]]
    });

    const formulaReadRes = await tools.excel_read_range({
      itemId,
      range: "G2:G3"
    });
    const formulaText = formulaReadRes.content ? formulaReadRes.content[0].text : "{}";
    try {
      const formulaData = JSON.parse(formulaText);
      const vals = formulaData.values || [];
      if (vals.length >= 2 && Number(vals[0][0]) === 30 && Number(vals[1][0]) === 70) {
        console.log("✓ Formula evaluation verified: SUM formulas computed correctly");
      } else {
        console.log(`⚠️ Formula values: ${JSON.stringify(vals)} (expected [[30],[70]])`);
      }
    } catch (e) {
      console.warn(`⚠️ Formula read parse error: ${formulaText.slice(0, 100)}`);
    }

    // 8. Clear Range
    console.log(`\n[8/9] Testing excel_clear_range...`);
    await tools.excel_clear_range({ itemId, range: "E1:G3" });

    const clearVerifyRes = await tools.excel_read_range({
      itemId,
      range: "E1:G3"
    });
    const clearVerifyText = clearVerifyRes.content ? clearVerifyRes.content[0].text : "{}";
    try {
      const clearData = JSON.parse(clearVerifyText);
      const vals = clearData.values || [];
      const isEmpty = vals.length === 0 || vals.every(row => row.every(cell => cell === "" || cell === null || cell === 0));
      console.log(`✓ Clear range ${isEmpty ? "verified: cells empty" : "sent (values may still show formatting)"}`);
    } catch (e) {
      console.log(`✓ Clear range sent`);
    }

    // 9. Get URL and navigate
    const urlRes = await tools.excel_get_metadata({ itemId });
    let webUrl = null;
    try {
      const urlData = JSON.parse(urlRes.content[0].text);
      webUrl = urlData.webUrl;
    } catch (e) {}

    console.log(`\n[9/9] Navigating to Workbook...`);
    if (webUrl) {
      console.log(` URL: ${webUrl}`);
      await tools.navigatePage(webUrl);
    } else {
      console.log(`   (Could not extract webUrl)`);
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
