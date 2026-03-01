// scripts/onedrive-test.js
// OneDrive read-only sanity test
// Covers: onedrive_list, onedrive_search, onedrive_get_file_metadata, excel_list

await tools.readSkill({ name: "microsoft-365" });
console.log("Starting OneDrive Read-Only Test...");

async function run() {
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
