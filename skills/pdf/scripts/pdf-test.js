// scripts/pdf-test.js
// PDF MCP comprehensive test
// Usage: /skill pdf-test/scripts/pdf-test.js --full-auto --url <pdf-url>
//
// If no --url provided, uses a well-known public PDF for testing.

await tools.readSkill({ name: "pdf" });
console.log("Starting PDF MCP Comprehensive Test...");

const DEFAULT_PDF_URL = "https://www.w3.org/WAI/WCAG21/Techniques/pdf/img/table-word.pdf";

async function run() {
  const results = {};

  try {
    // ── Resolve URL ──────────────────────────────────────────
    let pdfUrl = null;
    if (typeof args !== "undefined") {
      if (args.url) {
        pdfUrl = args.url;
      } else if (Array.isArray(args)) {
        pdfUrl = args.find(a => typeof a === "string" && (a.endsWith(".pdf") || a.includes(".pdf")));
      }
    }
    if (!pdfUrl) {
      pdfUrl = DEFAULT_PDF_URL;
      console.log(`(No --url provided, using default: ${pdfUrl})`);
    }

    // ==========================================================
    // PART 1: LOAD
    // ==========================================================
    console.log(`\n==================================================`);
    console.log(`PART 1: PDF LOAD`);
    console.log(`URL: ${pdfUrl}`);
    console.log(`==================================================`);

    console.log(`\n[1/1] Loading PDF...`);
    const loadRes = await tools.pdf_load({ url: pdfUrl });
    const loadText = loadRes?.content?.[0]?.text || "{}";

    let handle = null;
    let metadata = null;

    if (loadRes?.isError || loadText.includes("Error")) {
      console.error(`✗ pdf_load failed: ${loadText.slice(0, 200)}`);
      results.load = false;
      throw new Error("Cannot continue without a loaded PDF");
    }

    try {
      const loadData = JSON.parse(loadText);
      handle = loadData.handle;
      metadata = loadData.metadata;
    } catch (e) {
      console.error(`✗ Failed to parse load result: ${loadText.slice(0, 200)}`);
      results.load = false;
      throw new Error("Cannot continue without a loaded PDF");
    }

    if (!handle) {
      console.error(`✗ No handle returned`);
      results.load = false;
      throw new Error("Cannot continue without a loaded PDF");
    }

    console.log(`✓ Loaded. Handle: ${handle}`);
    console.log(`  Title: ${metadata.title || "(none)"}`);
    console.log(`  Author: ${metadata.author || "(none)"}`);
    console.log(`  Pages: ${metadata.pageCount}`);
    results.load = true;

    // ==========================================================
    // PART 2: READ (default pages)
    // ==========================================================
    console.log(`\n==================================================`);
    console.log(`PART 2: PDF READ (default pages)`);
    console.log(`==================================================`);

    console.log(`\n[1/2] Reading default pages...`);
    const readRes = await tools.pdf_read({ handle });
    const readBlocks = readRes?.content || [];

    if (readRes?.isError) {
      console.error(`✗ pdf_read failed: ${readBlocks[0]?.text?.slice(0, 200)}`);
      results.readDefault = false;
    } else {
      // First block is summary JSON
      const summaryText = readBlocks[0]?.text || "{}";
      try {
        const summary = JSON.parse(summaryText);
        console.log(`✓ Read ${summary.returnedPages} of ${summary.totalPages} pages`);

        let textBlocks = 0;
        let imageBlocks = 0;
        for (const block of readBlocks) {
          if (block.type === "text" && block.text?.startsWith("\n--- Page")) textBlocks++;
          if (block.type === "image") imageBlocks++;
        }
        console.log(`  Text blocks: ${textBlocks}, Image blocks: ${imageBlocks}`);

        // Show snippet of first page text
        const firstPageBlock = readBlocks.find(b => b.type === "text" && b.text?.includes("--- Page"));
        if (firstPageBlock) {
          const snippet = firstPageBlock.text.slice(0, 150).replace(/\n/g, " ");
          console.log(`  Page 1 snippet: "${snippet}..."`);
        }

        // Check image auto-detection
        for (const p of (summary.pages || [])) {
          if (p.imageIncluded) {
            console.log(`  ✓ Page ${p.page}: image auto-included (${p.imageCount} images detected)`);
          }
        }

        results.readDefault = true;
      } catch (e) {
        console.warn(`⚠️ Summary parse error: ${summaryText.slice(0, 100)}`);
        results.readDefault = false;
      }
    }

    // Read specific pages
    console.log(`\n[2/2] Reading specific page(s)...`);
    const lastPage = metadata.pageCount;
    const specificPages = lastPage > 1 ? [1, lastPage] : [1];
    const readSpecRes = await tools.pdf_read({ handle, pages: specificPages });

    if (readSpecRes?.isError) {
      console.error(`✗ pdf_read (specific) failed`);
      results.readSpecific = false;
    } else {
      const specSummary = JSON.parse(readSpecRes.content[0].text);
      console.log(`✓ Read pages ${specificPages.join(",")} → ${specSummary.returnedPages} pages returned`);
      results.readSpecific = true;
    }

    // ==========================================================
    // PART 3: SEARCH
    // ==========================================================
    console.log(`\n==================================================`);
    console.log(`PART 3: PDF SEARCH`);
    console.log(`==================================================`);

    // Search for a term we know exists (from the text we read above)
    const firstPageText = readBlocks.find(b => b.type === "text" && b.text?.includes("--- Page"))?.text || "";
    // Pick the first word longer than 4 chars as our search term
    const words = firstPageText.replace(/[^a-zA-Z\s]/g, "").split(/\s+/).filter(w => w.length > 4);
    const searchTerm = words.length > 0 ? words[0] : "the";

    console.log(`\n[1/2] Searching for "${searchTerm}"...`);
    const searchRes = await tools.pdf_search({ handle, query: searchTerm, maxResults: 5 });
    const searchText = searchRes?.content?.[0]?.text || "{}";

    if (searchRes?.isError || searchText.includes("Error")) {
      console.error(`✗ pdf_search failed: ${searchText.slice(0, 200)}`);
      results.search = false;
    } else {
      try {
        const searchData = JSON.parse(searchText);
        console.log(`✓ Found ${searchData.matchCount} matches for "${searchTerm}"`);
        (searchData.matches || []).slice(0, 3).forEach(m => {
          console.log(`  Page ${m.page}: "...${m.snippet.slice(0, 60)}..."`);
        });
        results.search = true;
      } catch (e) {
        console.warn(`⚠️ Search parse error`);
        results.search = false;
      }
    }

    // Search for something that shouldn't exist
    console.log(`\n[2/2] Searching for non-existent term...`);
    const bogusRes = await tools.pdf_search({ handle, query: "xyzzy_nonexistent_12345" });
    const bogusData = JSON.parse(bogusRes?.content?.[0]?.text || "{}");
    if (bogusData.matchCount === 0) {
      console.log(`✓ No-match search correctly returned 0 results`);
      results.searchNoMatch = true;
    } else {
      console.warn(`⚠️ Expected 0 matches, got ${bogusData.matchCount}`);
      results.searchNoMatch = false;
    }

    // ==========================================================
    // PART 4: LINKS
    // ==========================================================
    console.log(`\n==================================================`);
    console.log(`PART 4: PDF LINKS`);
    console.log(`==================================================`);

    console.log(`\n[1/1] Extracting hyperlinks...`);
    const linksRes = await tools.pdf_get_links({ handle });
    const linksText = linksRes?.content?.[0]?.text || "{}";

    if (linksRes?.isError) {
      console.error(`✗ pdf_get_links failed: ${linksText.slice(0, 200)}`);
      results.links = false;
    } else {
      try {
        const linksData = JSON.parse(linksText);
        console.log(`✓ Found ${linksData.links?.length || 0} links across ${linksData.totalPages} pages`);
        (linksData.links || []).slice(0, 3).forEach(l => {
          console.log(`  Page ${l.page}: ${l.url}`);
        });
        results.links = true;
      } catch (e) {
        console.warn(`⚠️ Links parse error`);
        results.links = false;
      }
    }

    // ==========================================================
    // PART 5: ERROR HANDLING
    // ==========================================================
    console.log(`\n==================================================`);
    console.log(`PART 5: ERROR HANDLING`);
    console.log(`==================================================`);

    // Bad handle
    console.log(`\n[1/2] Using invalid handle...`);
    const badRes = await tools.pdf_read({ handle: "INVALID_HANDLE" });
    if (badRes?.isError || badRes?.content?.[0]?.text?.includes("Error")) {
      console.log(`✓ Bad handle correctly errored`);
      results.errorBadHandle = true;
    } else {
      console.warn(`⚠️ Expected error for bad handle`);
      results.errorBadHandle = false;
    }

    // Bad URL
    console.log(`\n[2/2] Loading non-existent URL...`);
    const badUrlRes = await tools.pdf_load({ url: "https://httpstat.us/404" });
    if (badUrlRes?.isError || badUrlRes?.content?.[0]?.text?.includes("Error")) {
      console.log(`✓ Bad URL correctly errored`);
      results.errorBadUrl = true;
    } else {
      console.warn(`⚠️ Expected error for bad URL`);
      results.errorBadUrl = false;
    }

    // ==========================================================
    // PART 6: RELEASE
    // ==========================================================
    console.log(`\n==================================================`);
    console.log(`PART 6: PDF RELEASE`);
    console.log(`==================================================`);

    console.log(`\n[1/2] Releasing handle...`);
    const releaseRes = await tools.pdf_release({ handle });
    const releaseText = releaseRes?.content?.[0]?.text || "{}";

    if (releaseRes?.isError) {
      console.error(`✗ pdf_release failed`);
      results.release = false;
    } else {
      const releaseData = JSON.parse(releaseText);
      if (releaseData.released) {
        console.log(`✓ Handle released`);
        results.release = true;
      } else {
        console.warn(`⚠️ Release returned false`);
        results.release = false;
      }
    }

    // Verify released handle is invalid
    console.log(`\n[2/2] Using released handle...`);
    const postReleaseRes = await tools.pdf_read({ handle });
    if (postReleaseRes?.isError || postReleaseRes?.content?.[0]?.text?.includes("Error")) {
      console.log(`✓ Released handle correctly errored`);
      results.releaseVerified = true;
    } else {
      console.warn(`⚠️ Released handle should have errored`);
      results.releaseVerified = false;
    }

    // ==========================================================
    // SUMMARY
    // ==========================================================
    console.log(`\n==================================================`);
    console.log(`SUMMARY`);
    console.log(`==================================================`);
    console.log(JSON.stringify(results, null, 2));

    const allPassed = Object.values(results).every(v => v === true);
    return { success: allPassed, results };

  } catch (e) {
    console.error(`\n✗ TEST FAILED: ${e.message}`);
    if (e.stack) console.error(e.stack);
    return { success: false, error: e.message, results };
  }
}

return run();
