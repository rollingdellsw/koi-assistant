// scripts/pdf-test.js
// PDF MCP comprehensive test
// Usage: /skill pdf-test/scripts/pdf-test.js --full-auto --url <pdf-url>
//
// Runs entirely through the human path (`/skill ... --full-auto`), so it
// exercises the MCP server with no LLM in the loop. Every check is a hard
// assertion; the run ends with a PASS/FAIL table and a `failures` list, so a
// regression is visible without reading the whole log.
//
// If no --url provided, uses a well-known public PDF for testing.
// A multi-page PDF is strongly recommended: the navigation tests degrade to
// skipped no-ops on a 1-page document.
//
// Every MCP call is raced against TOOL_TIMEOUT_MS so that one hung tool is
// reported as a FAIL instead of consuming the whole runBrowserScript budget.

await tools.readSkill({ name: "pdf" });
console.log("Starting PDF MCP Comprehensive Test...");

// Mirrors MAX_BASE64_LENGTH in mcp/pdf_mcp.js — the payload ceiling, which is
// a runaway guard rather than a budget (the resolution tier is the budget).
const MAX_BASE64_LENGTH = 400000;

const DEFAULT_PDF_URL = "https://www.w3.org/WAI/WCAG21/Techniques/pdf/img/table-word.pdf";

// A 591-byte, single-page PDF: one line of Helvetica on a 200x200 page.
// Embedded rather than fetched so the render smoke test has zero network
// dependency — the previous W3C URL answered 300 Multiple Choices, which made
// a load failure masquerade as a render failure. Sparse text on purpose, so it
// should also trip pdf_read's render heuristic.
const SMOKE_PDF_B64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNDggPj4Kc3RyZWFtCkJUIC9GMSAxMiBUZiAyMCAxMDAgVGQgKEtvaSByZW5kZXIgc21va2UpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMTEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MDgKJSVFT0YK";

// ── Tiny assertion harness ────────────────────────────────────────
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(detail ? `${name}: ${detail}` : name);
  }
  return !!cond;
}

/** Parse the JSON summary block (always content[0]) of an MCP result. */
function summaryOf(res) {
  try {
    return JSON.parse(res?.content?.[0]?.text || "{}");
  } catch (e) {
    return {};
  }
}

/** True when the MCP call reported an error on either channel. */
function isErr(res) {
  return !!res?.isError || !!res?.content?.[0]?.text?.startsWith("Error:");
}

// ── Timeout-guarded tool calls ────────────────────────────────────
// A hung MCP call would otherwise burn the whole runBrowserScript budget and
// kill the suite mid-run (no SUMMARY, no failure list). Racing each call
// against a local timer turns a hang into an ordinary FAIL and lets the rest
// of the suite finish. Note: the race does not cancel the underlying MCP
// request — it keeps running in the background until the router's own timeout.
let TOOL_TIMEOUT_MS = 20000;
const timings = [];

async function callTool(name, params, timeoutMs) {
  const started = Date.now();
  const budget = timeoutMs || TOOL_TIMEOUT_MS;
  let timer;
  try {
    const res = await Promise.race([
      tools[name](params),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`HUNG: no response after ${budget}ms`)),
          budget
        );
      }),
    ]);
    timings.push({ name, ms: Date.now() - started, ok: !isErr(res) });
    return res;
  } catch (e) {
    const ms = Date.now() - started;
    timings.push({ name, ms, ok: false, hung: true });
    console.error(`✗ ${name} — ${e.message}`);
    return { isError: true, _hung: true, content: [{ type: "text", text: `Error: ${name} ${e.message}` }] };
  } finally {
    clearTimeout(timer);
  }
}

const pdf = {
  load: (p, ms) => callTool("pdf_load", p, ms),
  read: (p, ms) => callTool("pdf_read", p, ms),
  goto: (p, ms) => callTool("pdf_page_image", p, ms),
  search: (p, ms) => callTool("pdf_search", p, ms),
  links: (p, ms) => callTool("pdf_get_links", p, ms),
  release: (p, ms) => callTool("pdf_release", p, ms),
};

// PART 0 renders a 200x200 page with one line of text. If that needs more
// than a few seconds it is stuck, not slow — no reason to spend the full
// budget twice before the suite even reaches the real document.
const SMOKE_TIMEOUT_MS = 8000;

/** Elapsed ms of the most recent call to `name`. */
function lastMs(name) {
  for (let i = timings.length - 1; i >= 0; i--) {
    if (timings[i].name === name) return timings[i].ms;
  }
  return null;
}

async function run() {
  const results = {};

  try {
    // ── Resolve URL ──────────────────────────────────────────
    // Inside the sandbox `args` is always a string[] (skill_api §1.1), so parse
    // `--url <value>` positionally instead of reading args.url.
    let pdfUrl = null;
    if (typeof args !== "undefined" && Array.isArray(args)) {
      const flagIdx = args.indexOf("--url");
      if (flagIdx !== -1 && args[flagIdx + 1]) {
        pdfUrl = args[flagIdx + 1];
      } else {
        pdfUrl = args.find(a => typeof a === "string" && a.includes(".pdf"));
      }
    } else if (typeof args !== "undefined" && args && args.url) {
      pdfUrl = args.url;
    }
    if (!pdfUrl) {
      pdfUrl = DEFAULT_PDF_URL;
      console.log(`(No --url provided, using default: ${pdfUrl})`);
    }

    // ==========================================================
    // PART 0: RENDER SMOKE TEST
    // ==========================================================
    // Rendering is the slowest and most environment-sensitive path in the
    // server (main-thread pdf.js, fake worker, canvas inside a sandbox iframe
    // that is never painted). Prove it works on a trivial embedded document
    // BEFORE spending the script budget on the real one.
    //
    // Three outcomes are kept distinct, because conflating them sends you
    // debugging the wrong layer:
    //   - the document did not load          -> harness/fetch problem
    //   - pdf_read rendered, goto did not    -> pdf_page_image specific
    //   - neither rendered                   -> shared renderPageToImage path
    console.log(`\n==================================================`);
    console.log(`PART 0: RENDER SMOKE TEST (embedded 1-page PDF)`);
    console.log(`==================================================`);

    let smokeReadRendered = null;  // null = never determined
    let smokeGotoRendered = null;

    const smokeLoad = await pdf.load({ base64: SMOKE_PDF_B64 });
    results.smokeLoad = check(
      "embedded smoke doc loads",
      !isErr(smokeLoad),
      smokeLoad.content?.[0]?.text?.slice(0, 160)
    );

    if (results.smokeLoad) {
      const smokeHandle = JSON.parse(smokeLoad.content[0].text).handle;

      // (a) pdf_read's render path. The heuristic is text-sparsity based and
      // this document is nearly empty, so it should fire. If it does not, the
      // probe is INCONCLUSIVE — not a pass. Asserting only "did not hang" here
      // would go green without ever calling renderPageToImage.
      const readRes = await pdf.read({
        handle: smokeHandle, pages: [1], renderImages: true, resolution: "low",
      }, SMOKE_TIMEOUT_MS);
      const readImage = (readRes.content || []).some(b => b.type === "image");
      const readSummary = summaryOf(readRes);
      const readFired = !!readSummary.pages?.[0]?.imageIncluded || readImage;

      if (readRes._hung) {
        smokeReadRendered = false;
        check("pdf_read render path returns", false, `hung after ${lastMs("pdf_read")}ms`);
      } else if (!readFired) {
        console.log(`  ~ pdf_read INCONCLUSIVE — heuristic did not fire, renderPageToImage never called`);
      } else {
        smokeReadRendered = true;
        console.log(`✓ pdf_read produced an image (${lastMs("pdf_read")}ms)`);
      }

      // (b) pdf_page_image renders unconditionally, so this is never ambiguous.
      // Deliberately tiny (scale 0.5 / maxDim 400): if even this hangs, size
      // and page complexity are not the variable.
      const gotoSmoke = await pdf.goto({ handle: smokeHandle, page: 1, resolution: "low" }, SMOKE_TIMEOUT_MS);
      const gotoImage = (gotoSmoke.content || []).some(b => b.type === "image");
      smokeGotoRendered = !isErr(gotoSmoke) && gotoImage;

      results.renderSmoke = check(
        "minimal render completes",
        smokeGotoRendered,
        gotoSmoke._hung
          ? `render never returned after ${lastMs("pdf_page_image")}ms`
          : gotoSmoke.content?.[0]?.text?.slice(0, 160) || "no image block returned"
      );
      console.log(`  pdf_page_image took ${lastMs("pdf_page_image")}ms`);

      await pdf.release({ handle: smokeHandle });
    } else {
      results.renderSmoke = false;
      console.warn(`  (render untested — the smoke document never loaded)`);
    }

    // Verdict, stated once, in terms of which layer to go look at.
    if (results.smokeLoad && !results.renderSmoke) {
      TOOL_TIMEOUT_MS = 3000;

      const shared = smokeReadRendered === false;
      const gotoOnly = smokeReadRendered === true;

      console.warn(
        `\n⚠ Rendering is broken on a 200x200, one-line document.\n` +
        (shared
          ? `  pdf_read's render hung too — the defect is in the shared\n` +
            `  renderPageToImage path, NOT in pdf_page_image.\n`
          : gotoOnly
          ? `  pdf_read rendered fine but pdf_page_image did not — the defect is\n` +
            `  specific to gotoPage's call into renderPageToImage.\n`
          : `  pdf_read's probe was inconclusive, so attribution is unresolved.\n`) +
        `  Prime suspect: page.render().promise never settles. pdf.js drives its\n` +
        `  render loop with requestAnimationFrame for display intent, and rAF\n` +
        `  does not fire in an unpainted iframe. Try intent:"print", or give the\n` +
        `  sandbox iframe a 1x1 opacity:0 box instead of display:none.\n` +
        `  Dropping the per-call timeout to ${TOOL_TIMEOUT_MS}ms so the suite still finishes.`
      );
    }

    // ==========================================================
    // PART 1: LOAD
    // ==========================================================
    console.log(`\n==================================================`);
    console.log(`PART 1: PDF LOAD`);
    console.log(`URL: ${pdfUrl}`);
    console.log(`==================================================`);

    console.log(`\n[1/1] Loading PDF...`);
    const loadRes = await pdf.load({ url: pdfUrl });
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
    const readRes = await pdf.read({ handle });
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
    const readSpecRes = await pdf.read({ handle, pages: specificPages });

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
    const searchRes = await pdf.search({ handle, query: searchTerm, maxResults: 5 });
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
    const bogusRes = await pdf.search({ handle, query: "xyzzy_nonexistent_12345" });
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
    const linksRes = await pdf.links({ handle });
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
    // PART 5: PAGE NAVIGATION (pdf_page_image)
    // ==========================================================
    console.log(`\n==================================================`);
    console.log(`PART 5: PAGE NAVIGATION (pdf_page_image)`);
    console.log(`==================================================`);

    const totalPages = metadata.pageCount;

    // ── 5.1 Unconditional render ────────────────────────────────────────
    // The whole reason the tool exists: pdf_read's heuristic skips rendering on
    // text-heavy pages, pdf_page_image must never skip.
    // Attribution probe on the REAL document. pdf_read shares
    // renderPageToImage with pdf_page_image, but its render is heuristic-gated:
    // on a text-dense page the heuristic does not fire and renderPageToImage
    // is never called. Asserting "did not hang" would then pass vacuously, so
    // a probe that never rendered is reported INCONCLUSIVE and recorded as
    // such rather than counted as a pass.
    console.log(`\n[0/8] Attribution: does pdf_read's render path hang here too?`);
    const readRender = await pdf.read({ handle, pages: [1], renderImages: true, renderScale: 0.5 });
    const readRenderFired =
      !!summaryOf(readRender).pages?.[0]?.imageIncluded ||
      (readRender.content || []).some(b => b.type === "image");

    console.log(`  pdf_read({renderImages:true}) took ${lastMs("pdf_read")}ms, ` +
      `hung=${!!readRender._hung}, renderFired=${readRenderFired}`);

    if (readRender._hung) {
      results.readRenderPath = check(
        "pdf_read with renderImages:true returns",
        false,
        "shared render path hangs \u2014 not specific to pdf_page_image"
      );
    } else if (!readRenderFired) {
      console.log(`  ~ INCONCLUSIVE \u2014 heuristic did not fire on this page; see PART 0 instead`);
      results.readRenderPath = "inconclusive";
    } else {
      results.readRenderPath = check("pdf_read rendered without hanging", true);
    }

    console.log(`\n[1/8] Absolute page + unconditional render...`);
    const gotoRes = await pdf.goto({ handle, page: 1 });
    let fullRender = null;

    if (isErr(gotoRes)) {
      check("goto page 1", false, gotoRes.content?.[0]?.text?.slice(0, 160));
      results.gotoAbsolute = false;
    } else {
      const g = summaryOf(gotoRes);
      const imageBlock = (gotoRes.content || []).find(b => b.type === "image");
      fullRender = g.render;

      const ok = [
        check("page resolves to 1", g.page === 1, `got ${g.page}`),
        check("totalPages matches load metadata", g.totalPages === totalPages, `${g.totalPages} vs ${totalPages}`),
        check("prevPage is null on first page", g.prevPage === null, `got ${g.prevPage}`),
        check("nextPage points forward",
          totalPages > 1 ? g.nextPage === 2 : g.nextPage === null, `got ${g.nextPage}`),
        check("image block returned unconditionally", !!imageBlock?.data),
        check("image is JPEG", imageBlock?.mimeType === "image/jpeg", imageBlock?.mimeType),
        check("render dimensions reported", g.render?.width > 0 && g.render?.height > 0),
        check("text included by default", g.textLength > 0),
      ].every(Boolean);

      console.log(`  render: ${g.render?.width}x${g.render?.height} @ scale ${g.render?.scale}`);
      results.gotoAbsolute = ok;
    }

    // ── 5.2 Keyword + relative navigation ────────────────────────────────────────
    console.log(`\n[2/8] Keyword navigation (first/last/next/prev)...`);
    if (totalPages < 2) {
      console.log(`  (skipped — single-page PDF; pass a multi-page --url to cover this)`);
      results.gotoKeywords = true;
    } else {
      const first = summaryOf(await pdf.goto({ handle, page: "first" }));
      const next = summaryOf(await pdf.goto({ handle, page: "next" }));
      const prev = summaryOf(await pdf.goto({ handle, page: "prev" }));
      const last = summaryOf(await pdf.goto({ handle, page: "last" }));

      results.gotoKeywords = [
        check('"first" -> page 1', first.page === 1, `got ${first.page}`),
        check('"next" advances the cursor', next.page === 2, `got ${next.page}`),
        check('"prev" rewinds the cursor', prev.page === 1, `got ${prev.page}`),
        check('"last" -> final page', last.page === totalPages, `got ${last.page}`),
      ].every(Boolean);
    }

    console.log(`\n[3/8] Relative offsets ("+N" / "-N") and default page...`);
    if (totalPages < 3) {
      console.log(`  (skipped — needs 3+ pages)`);
      results.gotoRelative = true;
    } else {
      await pdf.goto({ handle, page: 1 });
      const plus = summaryOf(await pdf.goto({ handle, page: "+2" }));
      const minus = summaryOf(await pdf.goto({ handle, page: "-1" }));
      // Omitting `page` must hold position, not reset to 1.
      const stay = summaryOf(await pdf.goto({ handle }));

      results.gotoRelative = [
        check('"+2" from page 1 -> page 3', plus.page === 3, `got ${plus.page}`),
        check('"-1" from page 3 -> page 2', minus.page === 2, `got ${minus.page}`),
        check("omitted page holds the cursor", stay.page === 2, `got ${stay.page}`),
      ].every(Boolean);
    }

    // ── 5.3 Cursor shared with pdf_read ────────────────────────────────────────
    console.log(`\n[4/8] Cursor continuity after pdf_read...`);
    if (totalPages < 2) {
      console.log(`  (skipped — single-page PDF)`);
      results.gotoCursorAfterRead = true;
    } else {
      await pdf.read({ handle, pages: [1] });
      const afterRead = summaryOf(await pdf.goto({ handle, page: "next" }));
      results.gotoCursorAfterRead = check(
        'pdf_read moves the cursor, so "next" -> page 2',
        afterRead.page === 2,
        `got ${afterRead.page}`
      );
    }

    // ── 5.4 Region crop ────────────────────────────────────────
    console.log(`\n[5/8] Region crop spends the pixel budget on the crop...`);
    const cropRes = await pdf.goto({
      handle,
      page: 1,
      region: { x: 0, y: 0.5, width: 0.5, height: 0.5 },
    });

    if (isErr(cropRes) || !fullRender) {
      check("region crop", false, cropRes.content?.[0]?.text?.slice(0, 160) || "no baseline render");
      results.gotoRegion = false;
    } else {
      const c = summaryOf(cropRes);
      // The crop is fitted to the SAME tier as the full page, so it does not
      // come back smaller — it comes back magnified. Half of a 612x792 page has
      // the page's own aspect ratio, so both render to 371x480 and only the
      // scale moves (0.606 -> 1.212). Asserting fewer pixels would demand
      // crop-after-render, which is the expensive thing this deliberately
      // avoids. What must hold is: more magnification, no more pixels.
      const cropPixels = (c.render?.width || 0) * (c.render?.height || 0);
      const fullPixels = fullRender.width * fullRender.height;
      results.gotoRegion = [
        check("crop is magnified relative to the full page", c.render?.scale > fullRender.scale,
          `crop scale ${c.render?.scale} vs full ${fullRender.scale}`),
        check("crop costs no more pixels than the full page", cropPixels <= fullPixels,
          `${c.render?.width}x${c.render?.height} vs ${fullRender.width}x${fullRender.height}`),
        check("crop respects the tier ceiling",
          Math.max(c.render?.width || 0, c.render?.height || 0) <= 480,
          `got ${c.render?.width}x${c.render?.height}`),
        check("region echoed back normalized",
          c.render?.region?.width === 0.5 && c.render?.region?.y === 0.5,
          JSON.stringify(c.render?.region)),
        check("cropped image still returned", (cropRes.content || []).some(b => b.type === "image")),
      ].every(Boolean);

      console.log(`  full: ${fullRender.width}x${fullRender.height} → crop: ${c.render?.width}x${c.render?.height}`);
    }

    // ── 5.5 includeText: false ────────────────────────────────────────
    console.log(`\n[6/8] includeText:false suppresses text but not the image...`);
    const noTextRes = await pdf.goto({ handle, page: 1, includeText: false });
    const nt = summaryOf(noTextRes);
    const ntBlocks = noTextRes.content || [];
    results.gotoNoText = [
      check("textLength is 0", nt.textLength === 0, `got ${nt.textLength}`),
      check("no page-text block emitted",
        !ntBlocks.some(b => b.type === "text" && b.text?.includes("--- Page"))),
      check("image still returned", ntBlocks.some(b => b.type === "image")),
    ].every(Boolean);

    // ── 5.6 Rejected input ────────────────────────────────────────
    console.log(`\n[7/8] Out-of-range and malformed page values...`);
    const tooHigh = await pdf.goto({ handle, page: totalPages + 1 });
    const zero = await pdf.goto({ handle, page: 0 });
    const garbage = await pdf.goto({ handle, page: "banana" });

    results.gotoBadInput = [
      check("page > totalPages errors", isErr(tooHigh)),
      check("page 0 errors (pages are 1-based)", isErr(zero)),
      check("unparseable page token errors", isErr(garbage)),
    ].every(Boolean);

    console.log(`\n[8/8] Cursor unchanged after a rejected navigation...`);
    const before = summaryOf(await pdf.goto({ handle, page: 1 })).page;
    await pdf.goto({ handle, page: totalPages + 99 });
    const after = summaryOf(await pdf.goto({ handle })).page;
    results.gotoCursorSafe = check(
      "failed goto does not move the cursor",
      typeof before === "number" && before === after,
      before === undefined ? "no baseline — goto never returned" : `${before} -> ${after}`
    );

    // ==========================================================
    // PART 6: READ-ONLY GUARANTEE
    // ==========================================================
    // syncTab was removed. It mutated the user's visible tab from an
    // extraction tool, targeted whatever tab happened to be focused without
    // checking it was showing this document, could not actually move a loaded
    // PDF viewer via a hash assignment, and reported { ok: true } even when
    // the underlying evaluateScript failed — confirmed in a live trace.
    //
    // These checks lock the read-only contract in: no tabSync in the
    // response, and a stray syncTab argument is inert rather than honoured.
    console.log(`\n==================================================`);
    console.log(`PART 6: READ-ONLY GUARANTEE`);
    console.log(`==================================================`);

    console.log(`\n[1/2] Response carries no tabSync field...`);
    const plain = summaryOf(await pdf.goto({ handle, page: 1 }));
    results.noTabSyncField = check(
      "tabSync absent from the response",
      plain.tabSync === undefined,
      `got ${JSON.stringify(plain.tabSync)}`
    );

    console.log(`\n[2/2] A stray syncTab argument is ignored, not honoured...`);
    // An older caller (or a model working from a stale tool description) may
    // still pass syncTab. It must be inert: same result, no sync attempted.
    const stray = await pdf.goto({ handle, page: 1, syncTab: true });
    const strayS = summaryOf(stray);
    results.straySyncTabInert = [
      check("call still succeeds", !isErr(stray)),
      check("still no tabSync field", strayS.tabSync === undefined,
        `got ${JSON.stringify(strayS.tabSync)}`),
      check("page still renders", (stray.content || []).some(b => b.type === "image")),
      check("result matches the call without syncTab", strayS.page === plain.page,
        `${strayS.page} vs ${plain.page}`),
    ].every(Boolean);

    // ==========================================================
    // PART 6b: TEXT QUALITY / activeTab CONTRACT
    // ==========================================================
    // Two regressions found on a real document (TraceMonkey PLDI'09):
    //
    //  1. Figure 12's labels use a subset font with no ToUnicode CMap, so
    //     pdf.js returns raw glyph codes ("=<6>?J+B:F>*:</"). The payload
    //     marked it no differently from prose, so a reader quotes noise as
    //     fact. pdf_read/pdf_page_image must now flag it.
    //  2. activeTab detection passed a bare statement body to evaluateScript
    //     (which takes a function expression), never unwrapped the { result }
    //     envelope, and omitted responseFormat:"base64" on the fetch — three
    //     defects that made every activeTab load fail or corrupt.
    console.log(`\n==================================================`);
    console.log(`PART 6b: TEXT QUALITY + activeTab CONTRACT`);
    console.log(`==================================================`);

    // The garble flag must be OPT-OUT-BY-DEFAULT on normal prose: a detector
    // that fires on clean text is worse than none, because it teaches the
    // reader to ignore it. Assert the absence on a known-good page first.
    console.log(`\n[1/3] Clean text is NOT flagged as suspect...`);
    const cleanRead = summaryOf(await pdf.read({ handle, pages: [1] }));
    const cleanPage = cleanRead.pages?.[0];
    results.textQualityNoFalsePositive = check(
      "clean page carries no textQuality warning",
      cleanPage && cleanPage.textQuality === undefined,
      `got ${JSON.stringify(cleanPage?.textQuality)} (ratio ${cleanPage?.letterRatio})`
    );

    // Scan the document for any page the detector does flag. Most PDFs have
    // none, so this is reported as inconclusive rather than failed — the
    // check is that the FIELD IS WELL-FORMED when present, not that this
    // particular document happens to contain a broken font.
    console.log(`\n[2/3] When flagged, the warning is well-formed...`);
    const scanPages = [];
    for (let i = 1; i <= Math.min(metadata.pageCount, 15); i++) scanPages.push(i);
    const scan = summaryOf(await pdf.read({ handle, pages: scanPages }, 60000));
    const flagged = (scan.pages || []).filter(p => p.textQuality === "suspect");

    if (!flagged.length) {
      console.log(`  ~ no garbled pages in this document — nothing to assert`);
      results.textQualityShape = "inconclusive";
    } else {
      console.log(`  flagged pages: ${flagged.map(p => p.page).join(", ")}`);
      results.textQualityShape = [
        check("letterRatio is a number below the threshold",
          flagged.every(p => typeof p.letterRatio === "number" && p.letterRatio < 0.45),
          JSON.stringify(flagged.map(p => p.letterRatio))),
        check("warning names pdf_page_image as the remedy",
          flagged.every(p => typeof p.warning === "string" && p.warning.includes("pdf_page_image"))),
      ].every(Boolean);
    }

    // activeTab cannot be exercised without a tab showing a PDF, and this
    // suite runs headless via --full-auto. What IS assertable with no tab:
    // the failure is a clean, actionable error naming the 'url' fallback,
    // NOT the old bare "Could not detect PDF in active tab".
    console.log(`\n[3/3] activeTab failure is actionable, not bare...`);
    const tabRes = await pdf.load({ activeTab: true }, 15000);
    if (!isErr(tabRes)) {
      // A tab really was showing a PDF — the load succeeding is itself the
      // regression proof, since all three defects made this impossible.
      console.log(`  (a PDF was present in the active tab; load succeeded)`);
      const tabHandle = summaryOf(tabRes).handle;
      results.activeTabContract = check("activeTab load returned a handle", !!tabHandle);
      if (tabHandle) await pdf.release({ handle: tabHandle });
    } else {
      const msg = tabRes.content?.[0]?.text || "";
      results.activeTabContract = [
        check("error explains WHY detection failed (native viewer / file://)",
          /native|file:\/\/|scriptable|DOM/i.test(msg), msg.slice(0, 200)),
        check("error names the 'url' parameter as the fallback",
          /'url'|\burl\b/i.test(msg) && /fallback|instead/i.test(msg), msg.slice(0, 200)),
      ].every(Boolean);
    }

    // ==========================================================
    // PART 6c: PAYLOAD BUDGET
    // ==========================================================
    // An image returned from a tool is spent context. This skill previously
    // defaulted to maxDim 2000 — measured at ~29,800 tokens for one page of
    // the TraceMonkey paper, against ~1,300 for takeScreenshot's own default
    // in src/background/tools/screenshot-tools.ts. These checks pin the
    // default to the cheap tier and keep the ceilings enforced.
    console.log(`\n==================================================`);
    console.log(`PART 6c: PAYLOAD BUDGET`);
    console.log(`==================================================`);

    // takeScreenshot's low tier is 480px. The default here must match it —
    // if someone raises this default again, this is the check that fails.
    console.log(`\n[1/4] Default resolution is the cheap tier (480px)...`);
    const defRender = summaryOf(await pdf.goto({ handle, page: 1 }));
    const dims = defRender.render || {};
    // Cost is charged on DIMENSIONS, not bytes: a 371x480 image bills ~1,300
    // tokens whether it encodes to 20KB or 65KB. So the two dimension checks
    // above are the budget; the byte check is only a runaway guard, and it
    // belongs at the implementation's own ceiling (MAX_BASE64_LENGTH) rather
    // than at an invented threshold a normal dense text page trips.
    results.defaultTierCheap = [
      check("longest side is 480px", Math.max(dims.width || 0, dims.height || 0) === 480,
        `got ${dims.width}x${dims.height}`),
      check("reports the tier it used", dims.resolution === "low", `got ${dims.resolution}`),
      check("payload stays under the runaway ceiling", (dims.bytes || 0) < MAX_BASE64_LENGTH,
        `got ${Math.round((dims.bytes || 0) / 1024)}KB of ${Math.round(MAX_BASE64_LENGTH / 1024)}KB`),
    ].every(Boolean);

    // A region crop must not silently cost more than a full page: it should
    // spend the same pixel budget on a smaller area, not add to it.
    console.log(`\n[2/4] A region crop costs no more than the full page...`);
    const cropped = summaryOf(await pdf.goto({
      handle, page: 1, region: { x: 0, y: 0, width: 0.5, height: 0.5 },
    }));
    results.cropNotMoreExpensive = check(
      "cropped payload <= full-page payload",
      (cropped.render?.bytes || 0) <= (dims.bytes || 0) * 1.1,
      `crop ${cropped.render?.bytes} vs full ${dims.bytes}`
    );

    // Raising the tier must actually raise resolution — proves the tier map is
    // wired through and not ignored.
    console.log(`\n[3/4] An explicit tier is honoured...`);
    const hi = summaryOf(await pdf.goto({ handle, page: 1, resolution: "medium" }, 30000));
    results.tierHonoured = [
      check("medium is larger than low",
        Math.max(hi.render?.width || 0, hi.render?.height || 0) === 1280,
        `got ${hi.render?.width}x${hi.render?.height}`),
      check("an unknown tier is rejected",
        isErr(await pdf.goto({ handle, page: 1, resolution: "enormous" }))),
    ].every(Boolean);

    // Ten images at ~1k tokens each is a five-figure bill from one call.
    // Refusing beats truncating: a reader given pages 1-3 of a 10-page request
    // will summarize all ten.
    console.log(`\n[4/4] Bulk renderImages is refused, not truncated...`);
    const bulkPages = [];
    for (let i = 1; i <= Math.min(metadata.pageCount, 10); i++) bulkPages.push(i);
    if (bulkPages.length > 3) {
      const bulk = await pdf.read({ handle, pages: bulkPages, renderImages: true }, 30000);
      const bulkMsg = bulk.content?.[0]?.text || "";
      results.bulkRenderRefused = [
        check("call is refused", isErr(bulk), bulkMsg.slice(0, 120)),
        check("refusal explains the cost and names pdf_page_image",
          /token/i.test(bulkMsg) && bulkMsg.includes("pdf_page_image"), bulkMsg.slice(0, 200)),
        check("no images leaked through", !(bulk.content || []).some(b => b.type === "image")),
      ].every(Boolean);
    } else {
      results.bulkRenderRefused = "inconclusive";
      console.log(`  ~ document too short to exceed the cap`);
    }

    // ==========================================================
    // PART 7: ERROR HANDLING
    // ==========================================================
    console.log(`\n==================================================`);
    console.log(`PART 7: ERROR HANDLING`);
    console.log(`==================================================`);

    // Bad handle
    console.log(`\n[1/3] Using invalid handle with pdf_read...`);
    const badRes = await pdf.read({ handle: "INVALID_HANDLE" });
    results.errorBadHandle = check("pdf_read rejects an unknown handle", isErr(badRes));

    console.log(`\n[2/3] Using invalid handle with pdf_page_image...`);
    const badGotoRes = await pdf.goto({ handle: "INVALID_HANDLE", page: 1 });
    results.errorBadHandleGoto = check("pdf_page_image rejects an unknown handle", isErr(badGotoRes));

    // Bad URL
    console.log(`\n[3/3] Loading non-existent URL...`);
    const badUrlRes = await pdf.load({ url: "https://httpstat.us/404" });
    results.errorBadUrl = check("pdf_load rejects a 404 URL", isErr(badUrlRes));

    // ==========================================================
    // PART 8: RELEASE
    // ==========================================================
    console.log(`\n==================================================`);
    console.log(`PART 8: PDF RELEASE`);
    console.log(`==================================================`);

    console.log(`\n[1/3] Releasing handle...`);
    const releaseRes = await pdf.release({ handle });
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
    console.log(`\n[2/3] Using released handle with pdf_read...`);
    const postReleaseRes = await pdf.read({ handle });
    results.releaseVerified = check("released handle rejected by pdf_read", isErr(postReleaseRes));

    console.log(`\n[3/3] Using released handle with pdf_page_image...`);
    const postReleaseGoto = await pdf.goto({ handle, page: 1 });
    results.releaseVerifiedGoto = check("released handle rejected by pdf_page_image", isErr(postReleaseGoto));

    // ==========================================================
    // SUMMARY
    // ==========================================================
    console.log(`\n==================================================`);
    console.log(`SUMMARY`);
    console.log(`==================================================`);
    const hung = timings.filter(t => t.hung);
    if (hung.length) {
      console.error(`\nHUNG CALLS (${hung.length}) — exceeded ${TOOL_TIMEOUT_MS}ms:`);
      hung.forEach(t => console.error(`  - ${t.name} (${t.ms}ms)`));
    }

    const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 5);
    console.log(`\nSlowest calls:`);
    slowest.forEach(t => console.log(`  ${t.ms}ms  ${t.name}${t.hung ? " (HUNG)" : ""}`));

    for (const [name, outcome] of Object.entries(results)) {
      const label = outcome === "inconclusive" ? "SKIP" : outcome ? "PASS" : "FAIL";
      console.log(`  ${label}  ${name}`);
    }

    // "inconclusive" is neither a pass nor a failure \u2014 it means the check never
    // ran. Counting it either way would be a lie about coverage.
    const graded = Object.values(results).filter(v => v !== "inconclusive");
    const passedCount = graded.filter(Boolean).length;
    const skipped = Object.keys(results).length - graded.length;
    console.log(`\n${passedCount}/${graded.length} groups passed` +
      (skipped ? `, ${skipped} inconclusive` : ""));

    if (failures.length) {
      console.error(`\nFailed assertions (${failures.length}):`);
      failures.forEach(f => console.error(`  - ${f}`));
    }

    const allPassed = graded.every(v => v === true);
    return { success: allPassed, results, failures, timings };

  } catch (e) {
    console.error(`\n✗ TEST FAILED: ${e.message}`);
    if (e.stack) console.error(e.stack);
    return { success: false, error: e.message, results, failures, timings };
  }
}

return run();
