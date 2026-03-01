// scripts/drive-test.js
// Drive read-only sanity test
// Covers: drive_list, drive_search, drive_get_file_metadata, sheets_list

await tools.readSkill({ name: "google-workspace" });
console.log("Starting Google Drive Read-Only Test...");

async function run() {
  const results = {};

  try {
    console.log(`\n==================================================`);
    console.log(`GOOGLE DRIVE READ-ONLY VERIFICATION`);
    console.log(`==================================================`);

    // 1. drive_list (no filter)
    console.log(`\n[1/5] Listing recent Drive files...`);
    const listRes = await tools.drive_list({ maxResults: 5 });
    const listText = listRes.content ? listRes.content[0].text : "{}";

    let firstFileId = null;

    if (listRes.isError || listText.includes("API Error")) {
      console.error(`✗ drive_list failed: ${listText}`);
      results.driveList = false;
    } else {
      try {
        const listData = JSON.parse(listText);
        const files = listData.files || [];
        console.log(`✓ Found ${files.length} files.`);
        files.forEach(f => {
          console.log(`   - "${f.name}" (${f.mimeType}) [${f.id}]`);
        });
        if (files.length > 0) firstFileId = files[0].id;
        results.driveList = true;
      } catch (e) {
        console.warn(`⚠️ Parse error: ${listText.slice(0, 200)}`);
        results.driveList = false;
      }
    }

    // 2. drive_list with MIME filter (Docs only)
    console.log(`\n[2/5] Listing Drive files filtered by MIME (Docs)...`);
    const docsListRes = await tools.drive_list({
      query: "mimeType='application/vnd.google-apps.document'",
      maxResults: 3
    });
    const docsListText = docsListRes.content ? docsListRes.content[0].text : "{}";

    if (docsListRes.isError || docsListText.includes("API Error")) {
      console.error(`✗ drive_list (filtered) failed: ${docsListText}`);
      results.driveListFiltered = false;
    } else {
      try {
        const docsData = JSON.parse(docsListText);
        const docs = docsData.files || [];
        console.log(`✓ Found ${docs.length} Google Docs.`);
        results.driveListFiltered = true;
      } catch (e) {
        console.warn(`⚠️ Parse error`);
        results.driveListFiltered = false;
      }
    }

    // 3. drive_search
    console.log(`\n[3/5] Searching Drive for "test"...`);
    const searchRes = await tools.drive_search({ searchTerm: "test", maxResults: 5 });
    const searchText = searchRes.content ? searchRes.content[0].text : "{}";

    if (searchRes.isError || searchText.includes("API Error")) {
      console.error(`✗ drive_search failed: ${searchText}`);
      results.driveSearch = false;
    } else {
      try {
        const searchData = JSON.parse(searchText);
        const files = searchData.files || [];
        console.log(`✓ Search returned ${files.length} results.`);
        files.slice(0, 3).forEach(f => console.log(`   - "${f.name}" (${f.mimeType})`));
        results.driveSearch = true;
      } catch (e) {
        console.warn(`⚠️ Parse error`);
        results.driveSearch = false;
      }
    }

    // 4. drive_get_file_metadata
    console.log(`\n[4/5] Fetching File Metadata...`);
    if (firstFileId) {
      const metaRes = await tools.drive_get_file_metadata({ fileId: firstFileId });
      const metaText = metaRes.content ? metaRes.content[0].text : "{}";

      if (metaRes.isError || metaText.includes("API Error")) {
        console.error(`✗ drive_get_file_metadata failed: ${metaText}`);
        results.driveGetMetadata = false;
      } else {
        try {
          const meta = JSON.parse(metaText);
          console.log(`✓ File: "${meta.name}"`);
          console.log(`   MIME: ${meta.mimeType}`);
          console.log(`   Size: ${meta.size || "N/A"}`);
          console.log(`   Modified: ${meta.modifiedTime}`);
          console.log(`   URL: ${meta.webViewLink}`);
          results.driveGetMetadata = true;
        } catch (e) {
          console.warn(`⚠️ Parse error`);
          results.driveGetMetadata = false;
        }
      }
    } else {
      console.log(`   (Skipped: No file available)`);
      results.driveGetMetadata = "skipped";
    }

    // 5. sheets_list
    console.log(`\n[5/5] Listing Recent Spreadsheets (sheets_list)...`);
    const sheetsListRes = await tools.sheets_list({ maxResults: 3 });
    const sheetsListText = sheetsListRes.content ? sheetsListRes.content[0].text : "{}";

    if (sheetsListRes.isError || sheetsListText.includes("API Error")) {
      console.error(`✗ sheets_list failed: ${sheetsListText}`);
      results.sheetsList = false;
    } else {
      try {
        const sheetsData = JSON.parse(sheetsListText);
        const sheets = sheetsData.files || sheetsData;
        const count = Array.isArray(sheets) ? sheets.length : 0;
        console.log(`✓ Found ${count} recent spreadsheets.`);
        results.sheetsList = true;
      } catch (e) {
        console.warn(`⚠️ Parse error`);
        results.sheetsList = false;
      }
    }

    // SUMMARY
    console.log(`\n==================================================`);
    console.log(`SUMMARY`);
    console.log(`==================================================`);
    console.log(JSON.stringify(results, null, 2));

    const allPassed = Object.values(results).every(v => v === true || v === "skipped");
    return { success: allPassed, results };

  } catch (e) {
    console.error("\n✗ TEST FAILED:", e.message);
    if (e.stack) console.error(e.stack);
    return { success: false, error: e.message, results };
  }
}

return run();
