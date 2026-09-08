// scripts/workspace-render-test.js
// Render-contract test for the workspace skills' page-render tools.
//
// Usage:
//   /skill google-workspace-test/scripts/workspace-render-test.js --full-auto --target google
//   /skill microsoft-365-test/scripts/workspace-render-test.js --full-auto --target ms
//
// Runs through the human path, so no LLM is in the loop. Self-contained: it
// creates its own document rather than needing a pre-existing file ID, which
// also means every write it performs is one the guardrail permits.
//
// Every MCP call is raced against a timeout so a stalled render is reported as
// a FAIL instead of consuming the whole runBrowserScript budget. Rendering in
// the sandbox has hung indefinitely before (unpainted iframe, rAF never
// serviced), and that failure mode is silent without a deadline.

// ── Target configuration ────────────────────────────────────────
const TARGETS = {
  google: {
    skill: "google-workspace",
    label: "Google Workspace",
    createTool: "docs_create",
    createArgs: title => ({ title }),
    idField: "documentId",
    renderTool: "drive_render_page",
    renderArgs: (id, extra) => ({ fileId: id, ...extra }),
    idKeyInResponse: "fileId",
    // A write the guardrail must block: a file this session did not create.
    blockedTool: "sheets_write_range",
    blockedArgs: { spreadsheetId: "NOT_A_FILE_THIS_SESSION_CREATED", range: "A1", values: [["x"]] },
  },
  ms: {
    skill: "microsoft-365",
    label: "Microsoft 365",
    createTool: "word_create",
    createArgs: title => ({ title }),
    idField: "itemId",
    renderTool: "onedrive_render_page",
    renderArgs: (id, extra) => ({ itemId: id, ...extra }),
    idKeyInResponse: "itemId",
    blockedTool: "excel_write_range",
    blockedArgs: { itemId: "NOT_A_FILE_THIS_SESSION_CREATED", range: "A1", values: [["x"]] },
  },
};

// ── Assertion harness ───────────────────────────────────────────
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

function summaryOf(res) {
  try {
    return JSON.parse(res?.content?.[0]?.text || "{}");
  } catch (e) {
    return {};
  }
}

function textOf(res) {
  return (res?.content || [])
    .map(b => (typeof b?.text === "string" ? b.text : ""))
    .join("\n");
}

function isErr(res) {
  return !!res?.isError || /^Error:/.test(res?.content?.[0]?.text || "");
}

// The create tools do NOT return JSON. They return a text block shaped like
//   "Created document: <ID>\nURL: https://..."
// with the ID also hung off the block as a non-standard `_createdFileId`
// property. JSON.parse on that throws, so the ID has to be dug out of the
// text — which is exactly what the skill's own guardrail does to track
// ownership. Try every form rather than assuming one.
function extractCreatedId(res, idField) {
  const block = res?.content?.[0];
  if (block?._createdFileId) return block._createdFileId;

  const text = block?.text || "";

  // Some tools may return JSON; take it if it parses.
  try {
    const j = JSON.parse(text);
    const fromJson = j[idField] || j.id || j.fileId || j._createdFileId;
    if (fromJson) return fromJson;
  } catch (e) { /* not JSON — expected */ }

  const created = text.match(
    /(?:Created|Copied) (?:spreadsheet|document|presentation|workbook): (\S+)/
  );
  if (created) return created[1];

  // Last resort: pull it out of the URL line.
  const fromUrl = text.match(/\/(?:document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]+)/);
  if (fromUrl) return fromUrl[1];

  return null;
}

function errText(res) {
  return (res?.content || []).map(b => b?.text || "").join("\n");
}

// An image block may arrive in either MCP form ({data, mimeType}) or Anthropic
// form ({source: {data, media_type}}). Accept both so the test measures whether
// a render happened, not which serialization the server chose.
function imageBlock(res) {
  return (res?.content || []).find(b => b?.type === "image");
}

function imageBytes(block) {
  if (!block) return null;
  return block.data || block.source?.data || null;
}

function imageMime(block) {
  if (!block) return null;
  return block.mimeType || block.source?.media_type || null;
}

// A tool can return a perfectly well-formed image block whose payload is not an
// image at all — the OOXML download path used to re-encode and ship the raw
// entry whenever createImageBitmap threw, which for EMF/WMF/TIFF is always.
// Size checks pass on that; only the magic number catches it.
const IMAGE_MAGIC = {
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/gif": [0x47, 0x49, 0x46, 0x38],
  "image/bmp": [0x42, 0x4d],
};

function decodeHead(b64, n) {
  if (typeof b64 !== "string" || b64.length === 0) return null;
  try {
    // Decode only the leading bytes — a multi-megabyte atob just to read four
    // bytes is the kind of waste this whole section is about.
    const head = atob(b64.slice(0, Math.ceil(n / 3) * 4));
    const out = [];
    for (let i = 0; i < Math.min(n, head.length); i++) out.push(head.charCodeAt(i));
    return out;
  } catch (e) {
    return null;
  }
}

function decodesToRealImage(b64, declaredMime) {
  const head = decodeHead(b64, 8);
  if (!head) return false;
  const expected = IMAGE_MAGIC[declaredMime];
  if (expected) return expected.every((b, i) => head[i] === b);
  return Object.values(IMAGE_MAGIC).some(m => m.every((b, i) => head[i] === b));
}

// A 64x64 PNG checkerboard, inlined so the seed does not depend on Graph being
// able to reach an external host during the HTML-to-docx conversion.
const SEED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAaUlEQVR42u3XMQ0AIAxFwYpA" +
  "BP5V1BUYoFMXCJcwduCmlx9j5vGt4t12HwAAAAAALcArH63uAQAAAAB6ACUGAAAAsAeUGAAA" +
  "AMAeUGIAAAAAe0CJAQAAAOwBJQYAAACwB5QYAAAA4BvABqPwmVrWDWksAAAAAElFTkSuQmCC";

// ── Timeout-guarded calls ───────────────────────────────────────
let TOOL_TIMEOUT_MS = 30000;   // exports go over the network; be generous
const RENDER_TIMEOUT_MS = 30000;
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
    timings.push({ name, ms: Date.now() - started, ok: false, hung: true });
    console.error(`✗ ${name} — ${e.message}`);
    return { isError: true, _hung: true, content: [{ type: "text", text: `Error: ${name} ${e.message}` }] };
  } finally {
    clearTimeout(timer);
  }
}

function lastMs(name) {
  for (let i = timings.length - 1; i >= 0; i--) {
    if (timings[i].name === name) return timings[i].ms;
  }
  return null;
}

async function run() {
  const results = {};

  try {
    // ── Resolve target ────────────────────────────────────────
    // Inside the sandbox `args` is always a string[] (skill_api §1.1).
    let targetKey = "google";
    if (typeof args !== "undefined" && Array.isArray(args)) {
      const i = args.indexOf("--target");
      if (i !== -1 && args[i + 1]) targetKey = args[i + 1].toLowerCase();
      else if (args.some(a => /^(ms|microsoft)$/i.test(a))) targetKey = "ms";
    }
    if (targetKey === "microsoft") targetKey = "ms";

    const T = TARGETS[targetKey];
    if (!T) throw new Error(`Unknown --target "${targetKey}". Use "google" or "ms".`);

    await tools.readSkill({ name: T.skill });
    console.log(`Render-contract test — ${T.label}`);

    // ==========================================================
    // PART 1: CREATE A FILE WE OWN
    // ==========================================================
    console.log(`\n==================================================`);
    console.log(`PART 1: CREATE (${T.createTool})`);
    console.log(`==================================================`);

    const title = `koi-render-test-${Date.now()}`;
    const createRes = await callTool(T.createTool, T.createArgs(title));

    results.create = check(
      "create tool succeeds",
      !isErr(createRes),
      createRes.content?.[0]?.text?.slice(0, 200)
    );
    if (!results.create) throw new Error("Cannot continue without a file to render");

    const fileId = extractCreatedId(createRes, T.idField);

    results.createReturnsId = check(
      "create returns a usable file ID",
      !!fileId,
      `could not find an ID in: ${(createRes.content?.[0]?.text || "").slice(0, 200)}`
    );
    if (!fileId) throw new Error("Cannot continue without a file ID");
    console.log(`  ${T.idField}: ${fileId}`);

    // ==========================================================
    // PART 2: RENDER
    // ==========================================================
    console.log(`\n==================================================`);
    console.log(`PART 2: RENDER (${T.renderTool})`);
    console.log(`==================================================`);

    console.log(`\n[1/8] Render page 1...`);
    const renderRes = await callTool(
      T.renderTool,
      T.renderArgs(fileId, { page: 1 }),
      RENDER_TIMEOUT_MS
    );

    let fullRender = null;

    if (renderRes._hung) {
      results.renderPage1 = check(
        "render returns at all",
        false,
        `stalled for ${lastMs(T.renderTool)}ms — the render loop is not progressing, ` +
        `check the requestAnimationFrame shim in the MCP server`
      );
    } else if (isErr(renderRes)) {
      results.renderPage1 = check(
        "render page 1",
        false,
        renderRes.content?.[0]?.text?.slice(0, 200)
      );
    } else {
      const r = summaryOf(renderRes);
      const img = imageBlock(renderRes);
      fullRender = r.render;

      results.renderPage1 = [
        check("page resolves to 1", r.page === 1, `got ${r.page}`),
        check("totalPages reported", typeof r.totalPages === "number" && r.totalPages >= 1,
          `got ${r.totalPages}`),
        check("prevPage is null on the first page", r.prevPage === null, `got ${r.prevPage}`),
        check("echoes the file ID back", r[T.idKeyInResponse] === fileId,
          `got ${r[T.idKeyInResponse]}`),
        check("an image block is returned", !!img),
        check("image carries base64 data", !!imageBytes(img)),
        check("image is JPEG", imageMime(img) === "image/jpeg", String(imageMime(img))),
        check("render dimensions reported", r.render?.width > 0 && r.render?.height > 0,
          JSON.stringify(r.render)),
      ].every(Boolean);

      console.log(`  ${r.render?.width}x${r.render?.height} @ scale ${r.render?.scale}, ` +
        `${r.totalPages} page(s), ${lastMs(T.renderTool)}ms`);
    }

    // ── Region crop ──────────────────────────────────────────
    console.log(`\n[2/8] Region crop spends the pixel budget on the crop...`);
    const cropRes = await callTool(
      T.renderTool,
      T.renderArgs(fileId, { page: 1, region: { x: 0, y: 0.5, width: 0.5, height: 0.5 } }),
      RENDER_TIMEOUT_MS
    );

    if (isErr(cropRes) || !fullRender) {
      results.renderRegion = check("region crop", false,
        cropRes.content?.[0]?.text?.slice(0, 200) || "no baseline render to compare against");
    } else {
      const c = summaryOf(cropRes);
      // A crop does NOT come back with smaller dimensions. Tier-fitting scales
      // the page so the OUTPUT lands on the tier, so cropping to half the page
      // and rendering into the same budget means ~2x the scale — a quarter of
      // the area at twice the resolution. Asserting "crop is smaller" was a
      // leftover from the old fixed-scale behaviour, where a crop simply threw
      // pixels away; it failed here for the right reason.
      const cropLongest = Math.max(c.render?.width || 0, c.render?.height || 0);
      const fullLongest = Math.max(fullRender.width || 0, fullRender.height || 0);
      results.renderRegion = [
        // >= not >: a crop whose long edge already fills the tier (a full-width
        // band, a full-height sliver) has no headroom left and comes back at
        // the same scale. That is correct, not a regression.
        check("crop never loses resolution vs the full page",
          c.render?.scale >= fullRender.scale,
          `crop scale ${c.render?.scale} below full-page ${fullRender.scale}`),
        check("crop still respects the tier budget", cropLongest <= fullLongest,
          `crop longest side ${cropLongest} exceeds full-page ${fullLongest}`),
        check("region echoed back normalized",
          c.render?.region?.width === 0.5 && c.render?.region?.y === 0.5,
          JSON.stringify(c.render?.region)),
        check("cropped image still returned", !!imageBytes(imageBlock(cropRes))),
      ].every(Boolean);

      console.log(`  full: ${fullRender.width}x${fullRender.height} @ ${fullRender.scale} → ` +
        `crop: ${c.render?.width}x${c.render?.height} @ ${c.render?.scale} ` +
        `(${(c.render?.scale / fullRender.scale).toFixed(1)}x the resolution)`);
    }

    // ── Export cache ─────────────────────────────────────────
    // The second render of the same file should reuse the cached export
    // (5-minute TTL) rather than re-converting server-side.
    console.log(`\n[3/8] Second render reuses the cached export...`);
    const firstMs = lastMs(T.renderTool);
    const cachedRes = await callTool(T.renderTool, T.renderArgs(fileId, { page: 1 }), RENDER_TIMEOUT_MS);
    const cachedMs = lastMs(T.renderTool);

    console.log(`  first render ${firstMs}ms → repeat ${cachedMs}ms`);
    results.exportCache = check(
      "repeat render succeeds (cache hit is a bonus, not required)",
      !isErr(cachedRes),
      cachedRes.content?.[0]?.text?.slice(0, 200)
    );

    // ── Out-of-range page ────────────────────────────────────
    console.log(`\n[4/8] Out-of-range page errors instead of rendering something...`);
    const total = summaryOf(renderRes).totalPages || 1;
    const overRes = await callTool(
      T.renderTool,
      T.renderArgs(fileId, { page: total + 50 }),
      RENDER_TIMEOUT_MS
    );
    // "It errored" is not enough. An internal fault (a detached buffer, a
    // stalled render) also errors, and would let this check pass while the
    // page-range guard was never reached. Require the range message.
    const overText = errText(overRes);
    results.renderOutOfRange = check(
      "page beyond totalPages errors with a range message",
      isErr(overRes) && /out of range|page\(s\)/i.test(overText),
      `expected a page-range error, got ${overText.slice(0, 160)}`
    );

    // ── Unknown file ─────────────────────────────────────────
    console.log(`\n[5/8] Unknown file ID errors...`);
    const badRes = await callTool(
      T.renderTool,
      T.renderArgs("NOT_A_REAL_FILE_ID_12345", { page: 1 }),
      RENDER_TIMEOUT_MS
    );
    const badText = errText(badRes);
    results.renderBadFile = check(
      "unknown file ID errors for a lookup reason",
      isErr(badRes) && /not found|404|export failed|conversion failed/i.test(badText),
      `expected a lookup failure, got ${badText.slice(0, 160)}`
    );

    // ── Payload budget ───────────────────────────────────────
    // An image returned from a tool is spent context. These render tools
    // shipped with maxDim 2000 / scale 2.0 — measured at ~29,800 tokens for a
    // single page, against ~1,300 for takeScreenshot's default in
    // src/background/tools/screenshot-tools.ts. Same repo, 23x apart. The
    // tiers below are the shared vocabulary; these checks keep them enforced.
    console.log(`\n[6/8] Default resolution is the cheap tier (480px)...`);
    const budget = summaryOf(renderRes).render || {};
    results.defaultTierCheap = [
      check("longest side is 480px", Math.max(budget.width || 0, budget.height || 0) === 480,
        `got ${budget.width}x${budget.height}`),
      check("reports the tier it used", budget.resolution === "low", `got ${budget.resolution}`),
      check("payload is small (<40KB base64)", (budget.bytes || 0) < 40000,
        `got ${Math.round((budget.bytes || 0) / 1024)}KB`),
    ].every(Boolean);

    console.log(`\n[7/8] An explicit tier is honoured, an unknown one refused...`);
    const medRes = await callTool(
      T.renderTool, T.renderArgs(fileId, { page: 1, resolution: "medium" }), RENDER_TIMEOUT_MS);
    const med = summaryOf(medRes).render || {};
    const badTier = await callTool(
      T.renderTool, T.renderArgs(fileId, { page: 1, resolution: "enormous" }), RENDER_TIMEOUT_MS);
    results.tierHonoured = [
      check("medium is 1280px", Math.max(med.width || 0, med.height || 0) === 1280,
        `got ${med.width}x${med.height}`),
      check("medium costs more than low", (med.bytes || 0) > (budget.bytes || 0),
        `${med.bytes} vs ${budget.bytes}`),
      check("unknown tier is rejected", isErr(badTier) && /unknown resolution/i.test(errText(badTier)),
        errText(badTier).slice(0, 160)),
    ].every(Boolean);

    // A crop is NOT necessarily cheaper in bytes: it renders a quarter of the
    // page at twice the scale, and that extra detail compresses worse — a
    // 0.5x0.5 crop measured 54% MORE bytes than the whole page. That is the
    // trade being bought, not a leak. What must hold is that the tier bounds
    // the payload: no crop may exceed the ceiling, and none may exceed the
    // tier's pixel budget.
    console.log(`\n[8/8] A region crop stays inside the tier budget...`);
    const cropBudget = summaryOf(cropRes).render || {};
    const cropLongestSide = Math.max(cropBudget.width || 0, cropBudget.height || 0);
    results.cropWithinBudget = [
      check("crop respects the tier's pixel budget", cropLongestSide <= 480,
        `longest side ${cropLongestSide} > 480`),
      check("crop stays under the payload ceiling", (cropBudget.bytes || 0) < 400000,
        `${Math.round((cropBudget.bytes || 0) / 1024)}KB`),
      check("crop cost stays the same order as a full page",
        (cropBudget.bytes || 0) <= (budget.bytes || 0) * 3,
        `crop ${cropBudget.bytes} vs full ${budget.bytes} — more than 3x is a budget leak`),
    ].every(Boolean);

    // ==========================================================
    // PART 2B: EMBEDDED IMAGE DOWNLOAD (ms target only)
    // ==========================================================
    // word_download_image and ppt_download_image extract entries straight out
    // of the OOXML zip, so they never hit the transport bug that cost the
    // Google skill 1.5M tokens. What they did share was the fallback: three
    // copies of "resize failed, using raw", each re-encoding the original with
    // MAX_BASE64_LENGTH never consulted. For EMF/WMF/TIFF that path was not an
    // occasional miss — createImageBitmap cannot decode any of them, so it ran
    // every single time, returning an unbounded payload tagged with a
    // media_type no vision model accepts.
    //
    // The count and tier checks below are deterministic. The download checks
    // need a document that actually contains an image, and seeding one depends
    // on how Graph converts the uploaded HTML; when it produces no media entry
    // the section reports inconclusive rather than passing vacuously.
    if (targetKey === "ms") {
      console.log(`\n==================================================`);
      console.log(`PART 2B: EMBEDDED IMAGE DOWNLOAD`);
      console.log(`==================================================`);

      // ── Checks that need no seeded image ──────────────────────
      console.log(`\n[1/5] A batch larger than the cap is refused...`);
      // The count check runs before the container is downloaded, so a Word
      // itemId is enough to exercise it.
      const tooMany = await callTool("ppt_download_image", {
        itemId: fileId,
        imageName: "ppt/media/image1.png,ppt/media/image2.png,ppt/media/image3.png," +
          "ppt/media/image4.png,ppt/media/image5.png,ppt/media/image6.png",
      });
      results.imageBatchCapped = check(
        "an oversized image batch is rejected on count alone",
        isErr(tooMany) && /too many images/i.test(errText(tooMany)),
        errText(tooMany).slice(0, 160)
      );

      console.log(`\n[2/5] An unknown tier is refused before the download...`);
      const badTierDl = await callTool("word_download_image", {
        itemId: fileId,
        imageName: "word/media/image1.png",
        resolution: "enormous",
      });
      results.imageTierValidated = check(
        "unknown resolution is rejected as a tool error",
        isErr(badTierDl) && /unknown resolution/i.test(errText(badTierDl)),
        errText(badTierDl).slice(0, 160)
      );

      console.log(`\n[3/5] A missing image name errors cleanly...`);
      const missing = await callTool("word_download_image", {
        itemId: fileId,
        imageName: "word/media/definitely-not-here.png",
      });
      results.imageMissingName = check(
        "a name that is not in the container reports not-found",
        isErr(missing) && /not found/i.test(errText(missing)),
        errText(missing).slice(0, 160)
      );

      // ── Seeded checks ─────────────────────────────────────────
      console.log(`\n[4/5] Seed the document with an inline image...`);
      const seedRes = await callTool("word_batch_update", {
        itemId: fileId,
        htmlContent:
          `<html><body><p>render test</p>` +
          `<img src="data:image/png;base64,${SEED_PNG_B64}" width="64" height="64">` +
          `</body></html>`,
      });

      // word_get_images used to reference `allowedImageNames`, a `let` declared
      // inside pptGetImages and never at module scope. Reading it threw
      // ReferenceError on the first word/media entry found, so this call failed
      // on every Word document that had an image — and passed on every one that
      // did not, which is why it survived. Only the seeded run covers it.
      const inv = await callTool("word_get_images", { itemId: fileId });
      const invJson = summaryOf(inv);

      results.wordGetImages = check(
        "word_get_images returns an inventory instead of throwing",
        !isErr(inv) && typeof invJson.imageCount === "number",
        errText(inv).slice(0, 200)
      );

      const media = invJson.images || [];
      if (isErr(seedRes) || media.length === 0) {
        console.log(`  ~ INCONCLUSIVE — Graph produced no word/media entry from the ` +
          `uploaded HTML (${isErr(seedRes) ? errText(seedRes).slice(0, 120) : "0 images"})`);
        results.imageDownload = "inconclusive";
      } else {
        console.log(`  seeded ${media.length} image(s): ${media.map(m => m.name).join(", ")}`);

        console.log(`\n[5/5] The download returns decodable image bytes, capped...`);
        const dlRes = await callTool("word_download_image", {
          itemId: fileId,
          imageName: media[0].name,
        }, RENDER_TIMEOUT_MS);

        if (isErr(dlRes)) {
          results.imageDownload = check("word_download_image succeeds", false,
            errText(dlRes).slice(0, 200));
        } else {
          const block = imageBlock(dlRes);
          const b64 = imageBytes(block);
          const meta = summaryOf(dlRes);

          results.imageDownload = [
            check("an image block is returned", !!block),
            check("image carries base64 data", !!b64),
            check("base64 decodes to real image bytes",
              decodesToRealImage(b64, imageMime(block)),
              `declared ${imageMime(block)}, leading bytes ${JSON.stringify(decodeHead(b64, 4))}`),
            check("the returned media_type is one a vision model accepts",
              ["image/png", "image/jpeg", "image/gif", "image/bmp", "image/webp"]
                .includes(imageMime(block)),
              String(imageMime(block))),
            check("payload stays under the 400KB ceiling",
              (b64 || "").length < 400000,
              `${Math.round((b64 || "").length / 1024)}KB base64`),
            check("reports render metadata", typeof meta.render?.bytes === "number",
              JSON.stringify(meta).slice(0, 200)),
            check("metadata byte count matches the payload",
              meta.render?.bytes === (b64 || "").length,
              `${meta.render?.bytes} vs ${(b64 || "").length}`),
          ].every(Boolean);

          console.log(`  ${imageMime(block)}, ${Math.round((b64 || "").length / 1024)}KB base64, ` +
            `${meta.render?.width}x${meta.render?.height} @ ${meta.render?.resolution}`);
        }

        // Only real-world documents carry metafiles; a seeded doc will not. Run
        // the refusal check when one happens to be present rather than
        // pretending the coverage exists when it is not.
        const metafile = media.find(m => /\.(emf|wmf|tiff?)$/i.test(m.name));
        if (metafile) {
          console.log(`\n[+] An undecodable ${metafile.name} is refused, not shipped raw...`);
          const emfRes = await callTool("word_download_image", {
            itemId: fileId, imageName: metafile.name,
          }, RENDER_TIMEOUT_MS);
          results.undecodableRefused = check(
            "a metafile is refused with a pointer to the renderer",
            isErr(emfRes) && !imageBytes(imageBlock(emfRes)) &&
              /onedrive_render_page/.test(errText(emfRes)),
            errText(emfRes).slice(0, 160)
          );
        } else {
          console.log(`\n[+] No EMF/WMF/TIFF entry present — refusal path not exercised`);
          results.undecodableRefused = "inconclusive";
        }
      }
    }

    // ==========================================================
    // PART 3: GUARDRAIL BOUNDARY
    // ==========================================================
    console.log(`\n==================================================`);
    console.log(`PART 3: GUARDRAIL BOUNDARY`);
    console.log(`==================================================`);

    // Renders are reads. The guardrail must not treat them as mutations —
    // note that LOOKS_LIKE_MUTATION_RE in guardrail.js matches on word
    // boundaries, so a tool named *_render_page must not trip it.
    console.log(`\n[1/2] The render tool is not blocked as a mutation...`);
    const renderText = textOf(renderRes);
    results.renderNotGuarded = check(
      "render was not stopped by the guardrail",
      !/GUARDRAIL BLOCK/.test(renderText),
      renderText.slice(0, 200)
    );

    // A write to a file this session did not create must be stopped BEFORE it
    // reaches the API. Distinguish the outcomes, because "it errored" hides
    // the case that matters: the guardrail never fired and the API rejected
    // the write on its own. Note that reaching the API also costs a 404
    // account-mismatch retry and a re-auth round trip, so a slow result here
    // is itself a signal the call was not intercepted.
    console.log(`\n[2/2] A write to a file this session did not create is blocked...`);
    const blockedRes = await callTool(T.blockedTool, T.blockedArgs);
    const blockedText = textOf(blockedRes);

    if (/GUARDRAIL BLOCK/.test(blockedText)) {
      results.writeBlocked = check(`${T.blockedTool} on a foreign file is blocked`, true);
    } else if (/API Error|404|not found|NOT_FOUND/i.test(blockedText)) {
      results.writeBlocked = check(
        `${T.blockedTool} on a foreign file is blocked`,
        false,
        `the guardrail did not fire — the write reached the API and was rejected ` +
        `there (${lastMs(T.blockedTool)}ms). The own-file-only policy is not ` +
        `enforced on this call path.`
      );
    } else {
      console.log(`  ~ INCONCLUSIVE — neither a guardrail block nor an API rejection`);
      console.log(`    got: ${blockedText.slice(0, 200)}`);
      results.writeBlocked = "inconclusive";
    }

    // ==========================================================
    // SUMMARY
    // ==========================================================
    console.log(`\n==================================================`);
    console.log(`SUMMARY — ${T.label}`);
    console.log(`==================================================`);

    const hung = timings.filter(t => t.hung);
    if (hung.length) {
      console.error(`\nHUNG CALLS (${hung.length}):`);
      hung.forEach(t => console.error(`  - ${t.name} (${t.ms}ms)`));
    }

    const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 5);
    console.log(`\nSlowest calls:`);
    slowest.forEach(t => console.log(`  ${t.ms}ms  ${t.name}${t.hung ? " (HUNG)" : ""}`));

    for (const [name, outcome] of Object.entries(results)) {
      const label = outcome === "inconclusive" ? "SKIP" : outcome ? "PASS" : "FAIL";
      console.log(`  ${label}  ${name}`);
    }

    // "inconclusive" means the check never really ran; counting it either way
    // would misstate coverage.
    const graded = Object.values(results).filter(v => v !== "inconclusive");
    const passedCount = graded.filter(Boolean).length;
    const skipped = Object.keys(results).length - graded.length;
    console.log(`\n${passedCount}/${graded.length} groups passed` +
      (skipped ? `, ${skipped} inconclusive` : ""));

    if (failures.length) {
      console.error(`\nFailed assertions (${failures.length}):`);
      failures.forEach(f => console.error(`  - ${f}`));
    }

    console.log(`\nLeft behind: "${title}" (${fileId}) — delete it manually if you don't want it.`);

    const allPassed = graded.every(v => v === true);
    return { success: allPassed, target: targetKey, results, failures, timings };

  } catch (e) {
    console.error(`\n✗ TEST FAILED: ${e.message}`);
    if (e.stack) console.error(e.stack);
    return { success: false, error: e.message, results, failures, timings };
  }
}

return run();