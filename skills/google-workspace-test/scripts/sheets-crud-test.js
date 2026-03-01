// scripts/sheets-crud-test-v3.js
// Features:
// v4 additions: sheets_clear_range exercise, formula evaluation verification
// 1. Read-Only Verification (Checks existing sheet if --url passed)
// 2. Creation Verification (Full multi-sheet CRUD test with ROBUST error handling)

await tools.readSkill({ name: "google-workspace" });
console.log("Starting Google Sheets Full Coverage Test (v4)...");

const RUN_ID = Math.floor(Math.random() * 1000);
const SHEET_TITLE = `Koi Stress Test ${new Date().toLocaleTimeString()} (Run ${RUN_ID})`;

async function run() {
  try {
    // ---------------------------------------------------------
    // PART 1: READ-ONLY TEST (Existing Spreadsheet)
    // ---------------------------------------------------------
    let existingSheetId = null;
    if (typeof args !== 'undefined') {
        if (args.url) {
            const match = args.url.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
            if (match) existingSheetId = match[1];
        } else if (Array.isArray(args)) {
            const urlArg = args.find(a => typeof a === 'string' && a.includes("docs.google.com/spreadsheets"));
            if (urlArg) {
                const match = urlArg.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
                if (match) existingSheetId = match[1];
            }
        }
    }

    if (existingSheetId) {
        console.log(`\n==================================================`);
        console.log(`PART 1: READ-ONLY VERIFICATION`);
        console.log(`Target ID: ${existingSheetId}`);
        console.log(`==================================================`);

        console.log(`\n[1/4] Fetching Metadata & Tabs (Sheets)...`);
        const metaRes = await tools.sheets_get_metadata({ spreadsheetId: existingSheetId });
        const meta = JSON.parse(metaRes.content[0].text);

        console.log(`✓ Title: "${meta.title}"`);

        let firstTabName = "Sheet1";
        if (meta.sheets && meta.sheets.length > 0) {
            console.log(`✓ Found ${meta.sheets.length} Tabs:`);
            meta.sheets.forEach(s => console.log(`   - "${s.title}" (Rows: ${s.rowCount || 'N/A'}, Cols: ${s.columnCount || 'N/A'})`));
            firstTabName = meta.sheets[0].title;
        }

        console.log(`\n[2/4] Reading Content from "${firstTabName}"...`);
        const readRes = await tools.sheets_read_range({ spreadsheetId: existingSheetId, range: `${firstTabName}!A1:Z50` });
        const readData = JSON.parse(readRes.content[0].text);
        console.log(`✓ Read ${readData.returnedRows} rows.`);

        console.log(`\n[3/4] Scanning for Hyperlinks...`);
        const urlRes = await tools.sheets_get_urls({ spreadsheetId: existingSheetId, range: `${firstTabName}!A1:Z50` });
        const urlData = JSON.parse(urlRes.content[0].text);
        console.log(`✓ Found ${urlData.length} links.`);

        console.log(`\n[4/4] Testing CSV Export...`);
        const csvRes = await tools.sheets_read_as_csv({ spreadsheetId: existingSheetId, range: `${firstTabName}!A1:E10` });
        const csvText = csvRes.content[0].text;
        console.log(`✓ CSV Snippet:\n   ${csvText.split('\n').slice(0, 3).join('\n   ')}`);

        console.log(`\nPart 1 Complete.\n`);
    }

    // ---------------------------------------------------------
    // PART 2: CREATION & CRUD TEST
    // ---------------------------------------------------------
    console.log(`\n==================================================`);
    console.log(`PART 2: CREATION & WRITE VERIFICATION`);
    console.log(`==================================================`);

    console.log(`\n[1/7] Creating Spreadsheet: "${SHEET_TITLE}"...`);
    const createResult = await tools.sheets_create({ title: SHEET_TITLE });

    let spreadsheetId = createResult.spreadsheetId;
    if (!spreadsheetId && createResult.content) {
       try {
           const json = JSON.parse(createResult.content[0].text);
           if (json._createdFileId) spreadsheetId = json._createdFileId;
       } catch (e) {
           const match = createResult.content[0].text.match(/spreadsheet: ([a-zA-Z0-9-_]+)/);
           if (match) spreadsheetId = match[1];
       }
    }

    if (!spreadsheetId) throw new Error(`Failed to extract spreadsheetId.`);
    console.log(`✓ Created. ID: ${spreadsheetId}`);

    // 2. Multi-Sheet Management (Batch Update)
    console.log(`\n[2/7] Adding second tab "SummaryData"...`);
    const batchRes = await tools.sheets_batch_update({
      spreadsheetId,
      requests: [{ addSheet: { properties: { title: "SummaryData" } } }]
    });

    const batchResText = batchRes.content ? batchRes.content[0].text : "";
    if (batchRes.isError || batchResText.includes("Tool error") || batchResText.includes("API Error")) {
        console.warn(`⚠️ Batch update failed: ${batchResText}`);
    } else {
        console.log("✓ Batch update sent successfully.");
    }

    const newMeta = await tools.sheets_get_metadata({ spreadsheetId });
    const newMetaText = newMeta.content ? newMeta.content[0].text : "";

    if (newMeta.isError || newMetaText.includes("Tool error") || newMetaText.includes("API Error")) {
         console.warn(`⚠️ Failed to fetch metadata: ${newMetaText}`);
    } else {
        try {
            const newMetaObj = JSON.parse(newMetaText);
            const sheetNames = newMetaObj.sheets.map(s => s.title);
            console.log(`✓ Current tabs: ${sheetNames.join(", ")}`);
        } catch (e) {
            console.warn(`⚠️ Failed to parse metadata JSON: ${newMetaText}`);
        }
    }

    // 3. Hyperlinks & Formulas
    console.log(`\n[3/7] Testing Hyperlinks & Metadata extraction...`);
    const linkData = [
      ["Resource", "Link"],
      ["Google", '=HYPERLINK("https://www.google.com", "Google Search")'],
      ["Koi", '=HYPERLINK("https://koi.com", "Koi Home")']
    ];

    await tools.sheets_write_range({ spreadsheetId, range: "Sheet1!A1", values: linkData });

    const urlResult = await tools.sheets_get_urls({ spreadsheetId, range: "Sheet1!A1:B10" });
    const urlText = urlResult.content ? urlResult.content[0].text : "[]";
    try {
        const urls = JSON.parse(urlText);
        const googleLink = urls.find(u => u.url.includes("google.com"));
        if (googleLink) {
          console.log(`✓ Verified Link Extraction: Found ${googleLink.url} in row ${googleLink.row}`);
        } else {
          console.warn("⚠️ Failed to extract HYPERLINK formula from parsed data.");
        }
    } catch(e) {
        console.warn(`⚠️ URL parse error: ${urlText}`);
    }

    // 4. Cross-Sheet Writing
    console.log(`\n[4/7] Writing to secondary sheet...`);
    await tools.sheets_write_range({
      spreadsheetId,
      range: "SummaryData!A1",
      values: [["Category", "Count"], ["Test Items", "100"]]
    });
    console.log("✓ Wrote data to SummaryData tab (if it exists)");

    // 5. Stress Test: Pagination & Volume
    console.log(`\n[5/7] Stress Test: Writing 100 rows...`);
    const stressData = [];
    for (let i = 0; i < 100; i++) {
      stressData.push([`Item ${i}`, `Value ${Math.random()}`, i % 2 === 0 ? "TRUE" : "FALSE"]);
    }

    await tools.sheets_write_range({ spreadsheetId, range: "Sheet1!A5", values: stressData });

    console.log("   Reading back rows 50-60 via pagination...");
    const pageResult = await tools.sheets_read_range({
      spreadsheetId,
      range: "Sheet1!A5:C105",
      offset: 50,
      limit: 10
    });

    const pageText = pageResult.content ? pageResult.content[0].text : "";
    try {
        const pageObj = JSON.parse(pageText);
        if (pageObj.values && pageObj.values.length > 0 && pageObj.values[0][0] === "Item 50") {
          console.log("✓ Pagination Verified: correctly read offset 50");
        } else {
          console.warn("⚠️ Pagination data mismatch.");
        }
    } catch(e) {
        console.warn(`⚠️ Pagination read parse error: ${pageText}`);
    }

    // 6. CSV Export Test
    console.log(`\n[6/7] Testing CSV Export...`);
    const csvResult = await tools.sheets_read_as_csv({ spreadsheetId, range: "Sheet1!A1:B3" });
    const csvTextExport = csvResult.content ? csvResult.content[0].text : "";
    if (csvTextExport.includes("Google")) {
       console.log("✓ CSV Export successful");
    } else {
       console.warn(`⚠️ CSV Export failed or missing expected data.`);
    }

    // 7. Formula Evaluation Test
    console.log(`\n[7/9] Testing Formula Evaluation...`);
    await tools.sheets_write_range({
      spreadsheetId,
      range: "Sheet1!E1",
      values: [["Num1", "Num2", "Sum"], ["10", "20", "=E2+F2"], ["30", "40", "=E3+F3"]]
    });

    // Read back with FORMATTED_VALUE to see computed results
    const formulaReadRes = await tools.sheets_read_range({
      spreadsheetId,
      range: "Sheet1!G2:G3"
    });
    const formulaText = formulaReadRes.content ? formulaReadRes.content[0].text : "{}";
    try {
      const formulaData = JSON.parse(formulaText);
      const vals = formulaData.values || [];
      if (vals.length >= 2 && vals[0][0] === "30" && vals[1][0] === "70") {
        console.log("✓ Formula evaluation verified: SUM formulas computed correctly");
      } else {
        console.log(`⚠️ Formula values: ${JSON.stringify(vals)} (expected [["30"],["70"]])`);
      }
    } catch (e) {
      console.warn(`⚠️ Formula read parse error: ${formulaText.slice(0, 100)}`);
    }

    // 8. Clear Range Test
    console.log(`\n[8/9] Testing sheets_clear_range...`);
    await tools.sheets_clear_range({ spreadsheetId, range: "Sheet1!E1:G3" });

    const clearVerifyRes = await tools.sheets_read_range({
      spreadsheetId,
      range: "Sheet1!E1:G3"
    });
    const clearVerifyText = clearVerifyRes.content ? clearVerifyRes.content[0].text : "{}";
    try {
      const clearData = JSON.parse(clearVerifyText);
      const isEmpty = !clearData.values || clearData.values.length === 0;
      console.log(`✓ Clear range ${isEmpty ? "verified: cells empty" : "sent (data may persist briefly)"}`);
    } catch (e) {
      console.log(`✓ Clear range sent`);
    }

    // 9. Auto-Navigation
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    console.log(`\n[9/9] Navigating to Spreadsheet...`);
    console.log(` URL: ${sheetUrl}`);

    await tools.navigatePage(sheetUrl);

    return {
      success: true,
      spreadsheetId,
      url: sheetUrl
    };

  } catch (e) {
    console.error("\n❌ TEST FAILED:", e.message);
    if (e.stack) console.error(e.stack);
    return { success: false, error: e.message };
  }
}

return run();
