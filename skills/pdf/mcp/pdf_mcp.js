// PDF MCP Server
// Provides tools for loading, reading, and searching PDF documents.
// Runs inside the sandbox-mcp.js environment.
//
// pdf.js loading: The server loads pdf.js on first use from the extension's lib/ directory.
// The extension must bundle a classic-script version of pdf.js at public/lib/pdf.js
// (see build-pdf-lib.sh for converting the .mjs build to a classic script).
//
// Design:
// - Handle-based: pdf_load loads once, returns a handle for subsequent calls
// - Smart read: pdf_read returns text always, plus base64 page images when visual content detected
// - Search-first: pdf_search enables targeted reading of large documents

// ── State ────────────────────────────────────────────────────

const PDF_HANDLES = new Map(); // handleId -> { doc, metadata, url }
let handleCounter = 0;
let pdfjs = null; // Loaded on first use

// ── pdf.js Bootstrap ─────────────────────────────────────────

/**
 * Ensure pdf.js is loaded and available.
 *
 * Loading strategy (in order):
 * 1. Check if pdfjsLib is already on globalThis (loaded via <script> tag)
 * 2. Fetch pdf.mjs from extension's lib/ directory, strip ES exports, eval it
 */
async function ensurePdfJs() {
  if (pdfjs) return pdfjs;

  // Check if already loaded globally
  if (typeof pdfjsLib !== "undefined") {
    pdfjs = pdfjsLib;
    configurePdfJs(pdfjs);
    return pdfjs;
  }

  // Determine the extension base URL for loading pdf.mjs
  let extId = null;
  try {
    extId = new URLSearchParams(window.location.hash.slice(1)).get("extensionId");
  } catch (_) {}
  if (!extId) {
    const m = window.location.href.match(/chrome-extension:\/\/([a-z]{32})/);
    if (m) extId = m[1];
  }
  if (!extId && window.location.origin && window.location.origin.startsWith("chrome-extension://")) {
    extId = window.location.origin.split("//")[1];
  }
  if (!extId) {
    throw new Error("pdf.js: cannot determine extension ID. Check sandbox URL configuration.");
  }

  const extBase = `chrome-extension://${extId}`;
  const possiblePaths = ["lib/pdf.mjs"];

  // Use dynamic import() — pdf.mjs is a proper ES module with export {},
  // import.meta, etc. Running it as a classic script (via new Function or
  // <script> tag) breaks webpack's lazy getter closures.
  // Dynamic import() handles all ES module features natively.
  for (const p of possiblePaths) {
    try {
      const url = `${extBase}/${p}`;
      runtime.console.log(`[PDF MCP] Trying dynamic import: ${url}`);
      const module = await import(url);
      if (module && typeof module.getDocument === "function") {
        pdfjs = module;
        configurePdfJs(pdfjs);
        runtime.console.log(`[PDF MCP] pdf.js ${pdfjs.version || ""} loaded via import()`);
        return pdfjs;
      }
      runtime.console.warn(`[PDF MCP] import(${p}) succeeded but no getDocument found`);
    } catch (e) {
      runtime.console.warn(`[PDF MCP] import(${p}) failed: ${e.message}`);
    }
  }

  throw new Error(
    "pdf.js not available. Copy build/pdf.mjs to public/lib/pdf.mjs in the extension and rebuild."
  );
}

// ── Sandbox rendering prerequisites ────────────────────────────────────
// The MCP sandbox iframe is never painted, and Chrome does not service
// requestAnimationFrame for a frame that is not being rendered. pdf.js drives
// its render loop through rAF for display intent, so page.render().promise
// starts, schedules its next chunk, and never settles — no error, no
// rejection. The task only dies when the document is destroyed, which is why
// releasing a handle produced a burst of "Rendering cancelled" rejections for
// every render that had been queued behind it.
//
// Routing rAF to a timer restores forward progress. Nothing in this sandbox
// paints, so there is no animation to stay in sync with.
let rafShimInstalled = false;

function installRafShim() {
  if (rafShimInstalled || typeof window === "undefined") return;
  rafShimInstalled = true;

  const native = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    return setTimeout(() => cb(typeof performance !== "undefined" ? performance.now() : Date.now()), 0);
  };
  window.cancelAnimationFrame = function (id) { clearTimeout(id); };

  if (!native) {
    runtime.console.log("[PDF MCP] requestAnimationFrame absent; installed timer-based shim");
  } else {
    runtime.console.log("[PDF MCP] requestAnimationFrame routed to timers (sandbox frame is never painted)");
  }
}

function configurePdfJs(lib) {
  installRafShim();

  if (lib.GlobalWorkerOptions) {
    // Get extension ID from the sandbox URL or hash
    const m = window.location.href.match(/chrome-extension:\/\/([a-z]{32})/);
    const extId = m ? m[1] : new URLSearchParams(window.location.hash.slice(1)).get("extensionId");

    if (extId) {
      // Crucial: workerSrc must point to the worker module for the dispatcher to 'setup'
      lib.GlobalWorkerOptions.workerSrc = `chrome-extension://${extId}/lib/pdf.worker.mjs`;
    }
  }
}

// ── PDF Operations ───────────────────────────────────────────

/**
 * Resolve the URL of the PDF shown in the active tab.
 *
 * Two probes, cheapest and most robust first:
 *   1. findHandleByGlobal("window.location") + getFromHandle("href") — routed
 *      through chrome.scripting with a function reference, so it survives a
 *      strict CSP (skill_api 3.1 Path A).
 *   2. evaluateScript with an <embed> finder, for viewers that host the real
 *      document at a different URL than the page.
 *
 * Both are best-effort: on Chrome's native PDF viewer neither can run, and the
 * caller turns an empty result into an actionable message.
 */
async function detectActiveTabPdfUrl() {
  // Probe 1 — CSP-safe global read.
  try {
    const h = await runtime.findHandleByGlobal({ path: "window.location" });
    if (h?.handleId) {
      try {
        const href = await runtime.getFromHandle(h.handleId, "href");
        const url = typeof href === "string" ? href : href?.result;
        if (url) return url;
      } finally {
        runtime.releaseHandle(h.handleId);
      }
    }
  } catch (e) {
    runtime.console.warn(`[PDF MCP] location probe failed: ${e.message}`);
  }

  // Probe 2 — embed finder. evaluateScript takes a FUNCTION EXPRESSION called
  // with (document, __ctx, args) and resolves to { result } (skill_api 3.2);
  // the previous code passed a bare statement body and read .url off the
  // envelope, so this probe could never succeed even on a scriptable page.
  try {
    const res = await runtime.evaluateScript(`(document) => {
      const embed = document.querySelector('embed[type="application/pdf"]');
      return { url: (embed && embed.src) || document.location.href || null };
    }`, {}, "MAIN");
    const url = (res?.result !== undefined ? res.result : res)?.url;
    if (url) return url;
  } catch (e) {
    runtime.console.warn(`[PDF MCP] embed probe failed: ${e.message}`);
  }

  return null;
}

async function loadPdf(source) {
  const lib = await ensurePdfJs();

  let data;

  if (source.base64) {
    const raw = atob(source.base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    data = bytes;
  } else if (source.url) {
    const response = await runtime.fetch(source.url, { skipAuth: true, responseFormat: "base64" });
    if (!response.ok) {
      throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    data = new Uint8Array(arrayBuffer);
  } else if (source.activeTab) {
    const tabUrl = await detectActiveTabPdfUrl();

    // Chrome's native PDF viewer exposes no scriptable DOM, so on a file://
    // or plugin-rendered PDF every probe legitimately comes back empty. That
    // is not "no PDF" — it is "cannot see the DOM". Say which one it is, and
    // name the parameter that does work.
    if (!tabUrl) {
      throw new Error(
        "Could not determine the active tab's PDF URL. Chrome's native PDF viewer " +
        "(and any file:// page) exposes no scriptable DOM, so activeTab detection " +
        "cannot see it. Fallback: call pdf_load with the 'url' parameter instead, " +
        "passing the document's explicit URL (it is shown in the tab context)."
      );
    }

    // responseFormat:"base64" is required for binary payloads (skill_api 3.2).
    // Without it the response is decoded as text and the PDF bytes are
    // corrupted — the url branch above already does this.
    const response = await runtime.fetch(tabUrl, { skipAuth: true, responseFormat: "base64" });
    if (!response.ok) throw new Error(`Failed to fetch tab PDF: ${response.status} ${response.statusText}`);
    const arrayBuffer = await response.arrayBuffer();
    data = new Uint8Array(arrayBuffer);
  } else {
    throw new Error("pdf_load requires one of: url, base64, or activeTab:true");
  }

  // Yield helper to prevent freezing the main thread
  const yieldEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

  await yieldEventLoop();

  const loadingTask = lib.getDocument({
    data,
    useWorkerFetch: false,
    useSystemFonts: true,
    // Explicitly disable worker to force main-thread execution
    disableWorker: true,
    // Stop existing worker if one was pre-allocated
    stopWorker: true,
  });

  // Defensive initialization for large docs on main thread
  if (loadingTask._transport && !loadingTask._transport.workerPort) {
    loadingTask._transport.workerPort = {
      postMessage: () => {},
      addEventListener: () => {},
      removeEventListener: () => {}
    };
  }

  const doc = await loadingTask.promise;

  const metaRaw = await doc.getMetadata().catch(() => null);
  const info = metaRaw?.info || {};
  const metadata = {
    title: info.Title || null,
    author: info.Author || null,
    subject: info.Subject || null,
    creator: info.Creator || null,
    producer: info.Producer || null,
    creationDate: info.CreationDate || null,
    pageCount: doc.numPages,
  };

  const handleId = `pdf_${++handleCounter}`;
  PDF_HANDLES.set(handleId, { doc, metadata, url: source.url || null, currentPage: 1 });

  return { handle: handleId, metadata };
}

function getHandle(handleId) {
  const h = PDF_HANDLES.get(handleId);
  if (!h) throw new Error(`Invalid PDF handle: ${handleId}. Call pdf_load first.`);
  return h;
}

async function extractPageText(doc, pageNum) {
  const page = await doc.getPage(pageNum);
  const textContent = await page.getTextContent();
  const items = textContent.items || [];

  if (items.length === 0) return "";

  // PDF coordinates have origin at bottom-left, so higher Y means higher on page
  const Y_TOLERANCE = 4; // Tolerance to group items on the same visual line

  // Sort items top-to-bottom (descending Y), then left-to-right (ascending X)
  items.sort((a, b) => {
    const yA = a.transform[5];
    const yB = b.transform[5];
    if (Math.abs(yA - yB) > Y_TOLERANCE) {
      return yB - yA; // Top to bottom
    }
    const xA = a.transform[4];
    const xB = b.transform[4];
    return xA - xB; // Left to right
  });

  let text = "";
  let lastY = null;
  let lastX = null;
  let lastWidth = 0;

  for (const item of items) {
    if (item.str === undefined) continue;
    if (item.str.trim() === "" && item.str.length === 0) continue;

    const x = item.transform[4];
    const y = item.transform[5];
    const width = item.width || 0;

    if (lastY !== null && Math.abs(lastY - y) > Y_TOLERANCE) {
      text += "\n";
      lastX = null;
    } else if (lastX !== null) {
      // Measure horizontal gap to detect columns/tables
      const gap = x - (lastX + lastWidth);
      if (gap > 15) {
        text += " \t "; // Large visual gap -> represent as tabular data
      } else if (gap > 2) {
        text += " ";
      }
    }

    text += item.str;
    lastY = y;
    lastX = x;
    lastWidth = width;
  }
  return text;
}

/**
 * Detect text that decoded into mojibake rather than words.
 *
 * A subset font with no ToUnicode CMap makes pdf.js hand back raw glyph codes:
 * Figure 12 of the TraceMonkey paper extracts as "=<6>?J+B:F>*:</+>?7-<" while
 * the body text on the same page is perfect. Nothing in the payload marked
 * that as suspect, so a reader would summarize the noise as fact.
 *
 * Heuristic, deliberately conservative — it flags, it never rewrites or drops
 * text. Latin prose runs ~70-85% letters/spaces; broken CMap output collapses
 * to punctuation and digits. Only fires with enough characters to be
 * meaningful, so short labels and CJK pages (few ASCII letters by nature, and
 * legitimately so) are left alone.
 */
const GARBLE_MIN_CHARS = 200;
const GARBLE_LETTER_RATIO = 0.45;

function assessTextQuality(text) {
  const t = (text || "").trim();
  if (t.length < GARBLE_MIN_CHARS) return null;

  let letters = 0, spaces = 0, cjk = 0;
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters++;
    else if (ch === " " || ch === "\n" || ch === "\t") spaces++;
    else if (c >= 0x3000 && c <= 0x9fff) cjk++;
  }
  // A script this tool cannot reason about ratio-wise: assume it is fine.
  if (cjk > letters) return null;

  const ratio = (letters + spaces) / t.length;
  if (ratio >= GARBLE_LETTER_RATIO) return null;

  return {
    textQuality: "suspect",
    letterRatio: Number(ratio.toFixed(2)),
    warning:
      "Extracted text on this page looks like mojibake, not words — most likely a " +
      "subset font with no ToUnicode CMap. Do not quote these characters as content. " +
      "Call pdf_page_image on this page and read the image instead.",
  };
}

async function pageHasVisualContent(doc, pageNum, preExtractedText) {
  const lib = await ensurePdfJs();
  const page = await doc.getPage(pageNum);

  const ops = await page.getOperatorList();
  const OPS = lib.OPS;
  let imageCount = 0;

  if (OPS) {
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] === OPS.paintImageXObject ||
          ops.fnArray[i] === OPS.paintJpegXObject ||
          ops.fnArray[i] === OPS.paintImageMaskXObject) {
        imageCount++;
      }
    }
  }

  const isSparseText = preExtractedText.trim().length < 50 && imageCount === 0;

  return {
    hasImages: imageCount > 0,
    imageCount,
    isSparseText,
    shouldRenderImage: imageCount > 0 || isSparseText,
  };
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * Normalize a crop region expressed in 0..1 page coordinates (origin top-left).
 * Lets a caller zoom into one figure instead of paying for the whole page.
 */
function normalizeRegion(region) {
  if (!region) return null;
  const x = clamp01(Number(region.x) || 0);
  const y = clamp01(Number(region.y) || 0);
  const width = Math.min(
    region.width === undefined ? 1 - x : clamp01(Number(region.width)),
    1 - x
  );
  const height = Math.min(
    region.height === undefined ? 1 - y : clamp01(Number(region.height)),
    1 - y
  );
  if (!(width > 0) || !(height > 0)) {
    throw new Error("region width/height must be > 0 (normalized 0-1 page coordinates)");
  }
  return { x, y, width, height };
}

/**
 * Render a page to a base64 JPEG.
 * Returns { base64, width, height, scale } — callers that only want the bytes
 * should read `.base64`.
 *
 * opts:
 *   region  {x,y,width,height} normalized crop, origin top-left
 *   resolution  tier name — low (default) / medium / high / original
 *   quality     JPEG quality (default 0.85), backed off if the payload is large
 */
// A page that has not rasterized in this long is stuck, not slow.
const RENDER_TIMEOUT_MS = 20000;

// Resolution tiers, deliberately identical to ScreenshotTools.RESOLUTION_MAP in
// src/background/tools/screenshot-tools.ts. An image returned from a tool costs
// the reader context, and this skill previously defaulted to maxDim 2000 —
// ~29,800 tokens for one page of the TraceMonkey paper, against ~1,300 for
// takeScreenshot's own default. Same codebase, 23x apart, for no stated reason.
// One vocabulary, one default, so the cheap thing is what happens by default.
const RESOLUTION_MAP = { low: 480, medium: 1280, high: 1920, original: Infinity };
const DEFAULT_RESOLUTION = "low";

// Hard ceiling on the encoded payload, mirroring resizeForLLM's maxBase64Length.
// This is a runaway guard, not a budget: the tier is what keeps calls cheap.
const MAX_BASE64_LENGTH = 400000;

function resolveMaxDim(resolution) {
  if (resolution === undefined || resolution === null || resolution === "") {
    return RESOLUTION_MAP[DEFAULT_RESOLUTION];
  }
  const dim = RESOLUTION_MAP[String(resolution).toLowerCase()];
  if (dim === undefined) {
    throw new Error(
      `Unknown resolution "${resolution}". Use one of: ${Object.keys(RESOLUTION_MAP).join(", ")}.`
    );
  }
  return dim;
}

async function renderPageToImage(doc, pageNum, resolution, opts = {}) {
  const page = await doc.getPage(pageNum);
  const region = normalizeRegion(opts.region);
  const maxDim = resolveMaxDim(resolution);
  let quality = opts.quality == null ? 0.85 : opts.quality;

  // Fit the page to the tier rather than starting from an arbitrary scale.
  // Cropping to a region spends the pixel budget on the crop instead of on
  // pixels that get thrown away, so a small region comes back sharper for the
  // same cost — a 480px crop of one figure reads better than a 1920px page.
  let effScale = 1.0;
  let viewport = page.getViewport({ scale: effScale });

  const outSpan = () => Math.max(
    viewport.width * (region ? region.width : 1),
    viewport.height * (region ? region.height : 1)
  );
  if (maxDim !== Infinity && outSpan() !== 0) {
    effScale = maxDim / outSpan();
    viewport = page.getViewport({ scale: effScale });
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width * (region ? region.width : 1)));
  canvas.height = Math.max(1, Math.round(viewport.height * (region ? region.height : 1)));
  const ctx = canvas.getContext("2d");

  // Fill white background for JPEG (otherwise transparent pixels turn black)
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Shift the page under the smaller canvas rather than rendering full size and
  // cropping afterwards — avoids allocating a second full-page bitmap.
  const transform = region
    ? [1, 0, 0, 1, -Math.round(viewport.width * region.x), -Math.round(viewport.height * region.y)]
    : undefined;

  // Never await a render unbounded. If the shim above ever stops working — a
  // pdf.js change, a different sandbox host — the failure must surface as an
  // error the caller can report, not as a tool call that never returns and
  // takes the whole script budget with it.
  const renderTask = page.render({ canvasContext: ctx, viewport, transform });
  const timeoutMs = opts.timeoutMs || RENDER_TIMEOUT_MS;
  let watchdog;

  try {
    await Promise.race([
      renderTask.promise,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => {
          renderTask.cancel();
          reject(new Error(
            `Render of page ${pageNum} did not complete within ${timeoutMs}ms. ` +
            `The render loop is stalled, not slow — check that requestAnimationFrame ` +
            `is being serviced in the MCP sandbox frame.`
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
  }

  // JPEG encoding is hardware-accelerated and substantially faster than PNG.
  // Back off quality, then dimensions, until the payload fits — the same
  // strategy resizeForLLM uses in screenshot-tools.ts. A page of dense scanned
  // text can exceed the ceiling even at a modest tier, and silently shipping
  // 100k tokens of base64 is the failure this guard exists to prevent.
  let base64 = canvas.toDataURL("image/jpeg", quality).split(",")[1];
  while (base64.length > MAX_BASE64_LENGTH && quality > 0.2) {
    quality -= 0.1;
    if (quality < 0.5) {
      const w = Math.max(1, Math.round(canvas.width * 0.75));
      const h = Math.max(1, Math.round(canvas.height * 0.75));
      const shrunk = document.createElement("canvas");
      shrunk.width = w; shrunk.height = h;
      const sctx = shrunk.getContext("2d");
      sctx.fillStyle = "white"; sctx.fillRect(0, 0, w, h);
      sctx.drawImage(canvas, 0, 0, w, h);
      canvas.width = w; canvas.height = h;
      ctx.drawImage(shrunk, 0, 0);
      shrunk.width = 0; shrunk.height = 0;
      quality = 0.7;
    }
    base64 = canvas.toDataURL("image/jpeg", quality).split(",")[1];
  }

  const width = canvas.width;
  const height = canvas.height;
  canvas.width = 0;
  canvas.height = 0;
  page.cleanup();

  return { base64, width, height, scale: effScale, quality, bytes: base64.length };
}

// Even at the cheap tier an image is ~1,300 tokens, so ten of them is a
// five-figure context bill from a single call. Refuse rather than truncate:
// silently returning images for the first N pages of a larger request is how a
// reader ends up summarizing pages it never saw.
const MAX_RENDERED_PAGES = 3;

async function readPages(handleId, pages, resolution, renderImages = false) {
  const entry = getHandle(handleId);
  const { doc, metadata } = entry;
  const totalPages = metadata.pageCount;

  if (!pages || pages.length === 0) {
    pages = [1];
  }
  pages = pages.filter(p => p >= 1 && p <= totalPages);

  if (renderImages && pages.length > MAX_RENDERED_PAGES) {
    throw new Error(
      `renderImages was requested for ${pages.length} pages, over the ${MAX_RENDERED_PAGES}-page limit. ` +
      `Each image costs roughly a thousand tokens even at the default resolution, so this would ` +
      `consume the context before you could read the result. Either drop renderImages to get text ` +
      `for all ${pages.length} pages, or call pdf_page_image on the specific pages you need to look at.`
    );
  }

  // Aggressively free memory between pages to prevent OOM in sandbox
  // pdf.js page objects hold references to parsed operator lists, fonts, images
  const MAX_CONCURRENT_PAGES = 5;

  const results = [];
  // Process in chunks to prevent memory exhaustion in sandbox iframe
  for (let chunkStart = 0; chunkStart < pages.length; chunkStart += MAX_CONCURRENT_PAGES) {
    const chunk = pages.slice(chunkStart, chunkStart + MAX_CONCURRENT_PAGES);

    for (const pageNum of chunk) {
      await new Promise(r => setTimeout(r, 0));

      try {
        const page = await doc.getPage(pageNum);
        const text = await extractPageText(doc, pageNum);

        const pageResult = {
          page: pageNum,
          text,
          hasImages: false,
          imageCount: 0,
        };

        const quality = assessTextQuality(text);
        if (quality) Object.assign(pageResult, quality);

        if (renderImages) {
          const visual = await pageHasVisualContent(doc, pageNum, text);
          pageResult.hasImages = visual.hasImages;
          pageResult.imageCount = visual.imageCount;

          if (visual.shouldRenderImage) {
            // Text extraction already succeeded. A failed render costs the
            // image, not the page — previously the outer catch replaced good
            // text with "Error reading page: ...", so a rendering problem was
            // indistinguishable from an unreadable document.
            try {
              pageResult.image = (await renderPageToImage(doc, pageNum, resolution)).base64;
            } catch (renderErr) {
              pageResult.renderError = renderErr.message;
            }
          }
        }

        page.cleanup();
        results.push(pageResult);
      } catch (e) {
        results.push({
          page: pageNum,
          text: `Error reading page: ${e.message}`,
          hasImages: false,
          imageCount: 0,
        });
      }
    }

    // Force GC opportunity between chunks
    if (chunkStart + MAX_CONCURRENT_PAGES < pages.length) {
      await new Promise(r => setTimeout(r, 10));
    }
  }

  // Keep the cursor in sync so pdf_page_image({ page: "next" }) continues from
  // wherever the last read stopped.
  if (pages.length > 0) entry.currentPage = pages[pages.length - 1];

  return { totalPages, returnedPages: results.length, pages: results };
}

// ── Page Navigation ──────────────────────────────────────────

/**
 * Resolve a page argument to an absolute 1-based page number.
 * Accepts a number, a numeric string, a relative "+3" / "-2", or one of
 * next / prev / first / last, relative to the handle's current page.
 */
function resolveTargetPage(entry, page) {
  const total = entry.metadata.pageCount;
  const current = entry.currentPage || 1;
  let target;

  if (page === undefined || page === null || page === "") {
    target = current;
  } else if (typeof page === "string") {
    const token = page.trim().toLowerCase();
    if (token === "next") target = current + 1;
    else if (token === "prev" || token === "previous") target = current - 1;
    else if (token === "first") target = 1;
    else if (token === "last") target = total;
    else if (/^[+-]\d+$/.test(token)) target = current + parseInt(token, 10);
    else if (/^\d+$/.test(token)) target = parseInt(token, 10);
    else throw new Error(`Invalid page "${page}". Use a page number, a relative offset like "+3", or next/prev/first/last.`);
  } else {
    target = Math.round(Number(page));
  }

  if (!Number.isFinite(target)) {
    throw new Error(`Invalid page value: ${JSON.stringify(page)}`);
  }
  if (target < 1 || target > total) {
    throw new Error(`Page ${target} is out of range — this PDF has ${total} page(s) (current page: ${current}).`);
  }
  return target;
}

/**
 * Jump to a page and render it, unconditionally.
 *
 * pdf_read only renders when its heuristic fires (image XObjects present or
 * sparse text), so vector-drawn charts on a text-heavy page never produce an
 * image. This is the escape hatch: when extracted text can't be trusted —
 * graphs, diagrams, scanned pages, dense tables, formulas — look at the page.
 *
 * Read-only by design. An earlier `syncTab` option also scrolled the user's
 * visible tab via `window.location.hash`, which was wrong on three counts: it
 * mutated user-visible browser state from an extraction tool; it targeted
 * whatever tab happened to be focused, with no check that the tab was even
 * showing this document; and a hash assignment does not move an
 * already-loaded PDF viewer anyway. It also reported `{ ok: true }` whether
 * or not the underlying evaluateScript succeeded. Moving the user's tab is a
 * navigation concern and belongs in a tool the user opts into deliberately.
 */
async function renderPage(handleId, args = {}) {
  const entry = getHandle(handleId);
  const { doc, metadata } = entry;
  const pageNum = resolveTargetPage(entry, args.page);

  const text = args.includeText === false ? null : await extractPageText(doc, pageNum);

  const rendered = await renderPageToImage(doc, pageNum, args.resolution, {
    region: args.region,
    quality: args.quality,
  });

  entry.currentPage = pageNum;

  const quality = text ? assessTextQuality(text) : null;

  return {
    page: pageNum,
    totalPages: metadata.pageCount,
    ...(quality ? quality : {}),
    prevPage: pageNum > 1 ? pageNum - 1 : null,
    nextPage: pageNum < metadata.pageCount ? pageNum + 1 : null,
    render: {
      width: rendered.width,
      height: rendered.height,
      scale: Number(rendered.scale.toFixed(3)),
      resolution: (args.resolution || DEFAULT_RESOLUTION),
      bytes: rendered.bytes,
      region: normalizeRegion(args.region),
    },
    text,
    image: rendered.base64,
  };
}

async function searchPdf(handleId, query, maxResults, pageStart, pageEnd) {
  const { doc, metadata } = getHandle(handleId);
  const totalPages = metadata.pageCount;
  const limit = maxResults || 20;
  const queryLower = query.toLowerCase();

  // Clamp page range — default to a 100-page window from pageStart
  const MAX_SEARCH_PAGES = 100;
  const effectiveStart = Math.max(1, Math.min(pageStart || 1, totalPages));
  const effectiveEnd = Math.min(
    totalPages,
    pageEnd || (effectiveStart + MAX_SEARCH_PAGES - 1)
  );

  const matches = [];

  for (let pageNum = effectiveStart; pageNum <= effectiveEnd && matches.length < limit; pageNum++) {
    // Yield periodically during long searches
    if (pageNum % 5 === 0) await new Promise(r => setTimeout(r, 0));

    const text = await extractPageText(doc, pageNum);
    const textLower = text.toLowerCase();

    let searchFrom = 0;
    while (searchFrom < textLower.length && matches.length < limit) {
      const idx = textLower.indexOf(queryLower, searchFrom);
      if (idx === -1) break;

      const contextStart = Math.max(0, idx - 100);
      const contextEnd = Math.min(text.length, idx + query.length + 100);
      const snippet = text.slice(contextStart, contextEnd);

      matches.push({
        page: pageNum,
        index: idx,
        snippet: (contextStart > 0 ? "..." : "") + snippet + (contextEnd < text.length ? "..." : ""),
      });

      searchFrom = idx + query.length;
    }
  }

  return {
    query,
    totalPages,
    searchedRange: { from: effectiveStart, to: effectiveEnd },
    hasMore: effectiveEnd < totalPages,
    nextPageStart: effectiveEnd < totalPages ? effectiveEnd + 1 : null,
    matchCount: matches.length,
    matches,
  };
}

async function getLinks(handleId, pages) {
  const { doc, metadata } = getHandle(handleId);
  const totalPages = metadata.pageCount;

  if (!pages || pages.length === 0) {
    pages = [];
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  }
  pages = pages.filter(p => p >= 1 && p <= totalPages);

  const links = [];
  for (const pageNum of pages) {
    // Yield to keep the event loop responsive
    if (pageNum % 10 === 0) await new Promise(r => setTimeout(r, 0));

    const page = await doc.getPage(pageNum);
    const annotations = await page.getAnnotations();

    for (const annot of annotations) {
      if (annot.subtype === "Link" && annot.url) {
        links.push({ page: pageNum, url: annot.url });
      }
    }
  }

  return { totalPages, links };
}

function releasePdf(handleId) {
  const h = PDF_HANDLES.get(handleId);
  if (h) {
    h.doc.destroy().catch(() => {});
    PDF_HANDLES.delete(handleId);
    return { released: true, handle: handleId };
  }
  return { released: false, handle: handleId, error: "Handle not found" };
}


// ── MCP Server Interface ─────────────────────────────────────

return {
  listTools() {
    return [
      {
        name: "pdf_load",
        description: "Load a PDF into memory for reading/searching. Supports URL, base64 data, or active browser tab. Returns handle + metadata (title, author, page count).",
        displayMessage: "📄 Loading PDF{{#activeTab}} from active tab{{/activeTab}}{{#url}} from URL{{/url}}",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL of the PDF to load" },
            base64: { type: "string", description: "Base64-encoded PDF data" },
            activeTab: { type: "boolean", description: "Load PDF from active tab. Fails on native viewers/local files. Fall back to passing the 'url' parameter if this throws an error." },
          },
        },
      },
      {
        name: "pdf_read",
        description: "Read pages from a loaded PDF. Returns text for every page. Can optionally return base64 JPEG images for pages with visual content if renderImages is true (warning: slow, and only fires when embedded images or sparse text are detected). Defaults to page 1. Use pdf_search on large docs to find relevant pages first. To always get an image of one page — charts, diagrams, scans, dense tables — use pdf_page_image instead.",
        displayMessage: "📖 Reading PDF pages {{pages|default:1}}",
        inputSchema: {
          type: "object",
          properties: {
            handle: { type: "string", description: "PDF handle from pdf_load" },
            pages: { type: "array", items: { type: "number" }, description: "1-based page numbers (default: [1])" },
            resolution: { type: "string", enum: ["low", "medium", "high", "original"], description: "Image resolution tier when renderImages is on (default: low, ~1k tokens/page)." },
            renderImages: { type: "boolean", description: `If true, renders pages with visual content to base64 images. Costs roughly a thousand tokens per page, so it is limited to ${MAX_RENDERED_PAGES} pages per call. (default: false)` },
          },
          required: ["handle"],
        },
      },
      {
        name: "pdf_page_image",
        description: "Render one page of a loaded PDF to an image, plus its text. Use whenever extracted text can't be trusted on its own — charts, diagrams, scanned pages, multi-column layouts, dense tables, formulas — or when a page is flagged textQuality:'suspect'. Unlike pdf_read this never skips rendering. Renders offscreen from the loaded document: it does NOT navigate or scroll the user's tab, and works on PDFs that were never open in one. 'page' takes an absolute number, a relative offset ('+3'), or next/prev/first/last. Prefer a 'region' crop over a higher resolution — cropping spends the pixels where they matter and costs less.",
        displayMessage: "🖼️ Rendering PDF page {{page|default:current}}",
        inputSchema: {
          type: "object",
          properties: {
            handle: { type: "string", description: "PDF handle from pdf_load" },
            page: {
              description: "Target page: a 1-based number, a relative offset like \"+3\" or \"-1\", or one of \"next\", \"prev\", \"first\", \"last\". Defaults to the current page.",
              anyOf: [{ type: "number" }, { type: "string" }],
            },
            resolution: { type: "string", enum: ["low", "medium", "high", "original"], description: "Resolution tier, matching takeScreenshot: low=480px (default, ~1k tokens), medium=1280px, high=1920px, original=uncapped. Raise only when a crop at low is genuinely illegible." },
            quality: { type: "number", description: "JPEG quality 0-1 (default: 0.85)" },
            region: {
              type: "object",
              description: "Optional crop in normalized 0-1 page coordinates, origin top-left. Zooming in spends the pixel budget on the crop, so a small region comes back sharper. Example: bottom-left quadrant = { x: 0, y: 0.5, width: 0.5, height: 0.5 }.",
              properties: {
                x: { type: "number", description: "Left edge, 0-1 (default: 0)" },
                y: { type: "number", description: "Top edge, 0-1 (default: 0)" },
                width: { type: "number", description: "Width, 0-1 (default: to right edge)" },
                height: { type: "number", description: "Height, 0-1 (default: to bottom edge)" },
              },
            },
            includeText: { type: "boolean", description: "Also return the page's extracted text (default: true)" },
          },
          required: ["handle"],
        },
      },
      {
        name: "pdf_search",
        description: "Full-text search across a page range. Returns page numbers, snippets, and progress info. Searches up to 100 pages per call starting from pageStart (default 1). For large docs, search in successive ranges using nextPageStart from the response.",
        displayMessage: '🔍 Searching PDF for "{{query}}" from page {{pageStart|default:1}}',
        inputSchema: {
          type: "object",
          properties: {
            handle: { type: "string", description: "PDF handle from pdf_load" },
            query: { type: "string", description: "Search text (case-insensitive)" },
            maxResults: { type: "number", description: "Max matches (default: 20)" },
            pageStart: { type: "number", description: "First page to search (default: 1)" },
            pageEnd: { type: "number", description: "Last page to search (default: pageStart + 99). Max window is 100 pages per call." },
          },
          required: ["handle", "query"],
        },
      },
      {
        name: "pdf_get_links",
        description: "Extract hyperlink URLs from PDF pages.",
        displayMessage: "🔗 Extracting links from PDF",
        inputSchema: {
          type: "object",
          properties: {
            handle: { type: "string", description: "PDF handle from pdf_load" },
            pages: { type: "array", items: { type: "number" }, description: "Pages to scan (default: all)" },
          },
          required: ["handle"],
        },
      },
      {
        name: "pdf_release",
        description: "Release a loaded PDF to free memory.",
        displayMessage: "🗑️ Releasing PDF from memory",
        inputSchema: {
          type: "object",
          properties: {
            handle: { type: "string", description: "PDF handle to release" },
          },
          required: ["handle"],
        },
      },
    ];
  },

  async callTool(name, args) {
    try {
      switch (name) {
        case "pdf_load": {
          const result = await loadPdf({ url: args.url, base64: args.base64, activeTab: args.activeTab });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "pdf_read": {
          const result = await readPages(args.handle, args.pages, args.resolution, args.renderImages);
          const content = [];

          content.push({ type: "text", text: JSON.stringify({
            totalPages: result.totalPages,
            returnedPages: result.returnedPages,
            pages: result.pages.map(p => ({
              page: p.page, textLength: (p.text || "").length,
              hasImages: p.hasImages || false, imageCount: p.imageCount || 0, imageIncluded: !!p.image,
              ...(p.textQuality ? { textQuality: p.textQuality, letterRatio: p.letterRatio, warning: p.warning } : {}),
              ...(p.renderError ? { renderError: p.renderError } : {}),
            })),
          }, null, 2) });

          for (const p of result.pages) {
            content.push({ type: "text", text: `\n--- Page ${p.page} ---\n${p.text}` });
            if (p.image) {
              content.push({ type: "image", data: p.image, mimeType: "image/jpeg" });
            }
          }
          return { content };
        }

        case "pdf_page_image": {
          const result = await renderPage(args.handle, args);
          const content = [{ type: "text", text: JSON.stringify({
            page: result.page,
            totalPages: result.totalPages,
            prevPage: result.prevPage,
            nextPage: result.nextPage,
            render: result.render,
            textLength: result.text ? result.text.length : 0,
            ...(result.textQuality ? { textQuality: result.textQuality, letterRatio: result.letterRatio, warning: result.warning } : {}),
          }, null, 2) }];

          if (result.text) {
            content.push({ type: "text", text: `\n--- Page ${result.page} ---\n${result.text}` });
          }
          content.push({ type: "image", data: result.image, mimeType: "image/jpeg" });
          return { content };
        }

        case "pdf_search": {
          const result = await searchPdf(args.handle, args.query, args.maxResults, args.pageStart, args.pageEnd);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "pdf_get_links": {
          const result = await getLinks(args.handle, args.pages);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        case "pdf_release": {
          const result = releasePdf(args.handle);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }

        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  },
};
