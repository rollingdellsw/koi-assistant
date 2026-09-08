// mcp/microsoft_365_mcp.js
// Microsoft 365 MCP Server — uses Microsoft Graph API

const GRAPH = "https://graph.microsoft.com/v1.0";

// ── mammoth.js Bootstrap ──────────────────────────────────────
// mammoth.js converts .docx files to HTML/text in the browser.
// The extension must bundle mammoth.browser.min.js at public/lib/mammoth.browser.min.js
// (from https://www.npmjs.com/package/mammoth v1.11.0)

let mammothLib = null; // Loaded on first use

async function ensureMammoth() {
  if (mammothLib) return mammothLib;

  // Check if already loaded globally
  if (typeof mammoth !== "undefined") {
    mammothLib = mammoth;
    return mammothLib;
  }

  // Determine extension base URL (same approach as pdf_mcp.js)
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
    throw new Error("mammoth.js: cannot determine extension ID");
  }

  // mammoth.browser.min.js is a UMD bundle — fetch and eval it.
  // It sets window.mammoth when no module system is detected.
  const url = `chrome-extension://${extId}/lib/mammoth.browser.min.js`;
  runtime.console.log(`[M365 MCP] Loading mammoth.js from: ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `mammoth.js not available (${resp.status}). Copy mammoth.browser.min.js to public/lib/ in the extension and rebuild.`
    );
  }
  const code = await resp.text();
  new Function(code)();
  mammothLib = window.mammoth || self.mammoth;
  if (!mammothLib) throw new Error("mammoth.js loaded but global not found");
  runtime.console.log(`[M365 MCP] mammoth.js loaded successfully`);
  return mammothLib;
}

// ── Page Rendering (visual reads) ─────────────────────────────
// Office/Workspace text APIs are blind to anything that isn't a text run or an
// embedded raster: native charts, drawings, equations, and layout-carrying
// tables come back as disconnected strings or not at all. For those, export the
// file to PDF and rasterize the page — the same fallback pdf_goto_page provides
// for PDFs.
//
// The rendering happens here rather than by handing base64 to the pdf skill on
// purpose: a 1MB PDF is ~1.4M characters of base64, which would blow the
// context window before the model saw a single pixel. Only the JPEG leaves this
// module.

let pdfjsLibRef = null;
// ── Blank Office file seeds ────────────────────────────────────────
// The create tools used to PUT an empty body with an Office MIME type, which
// produces a 0-byte file carrying a .docx/.xlsx name but no OOXML package.
// Word Online papers over it, but nothing else does: Graph's PDF converter
// rejects such a file with "ErrorCode=WordInputFile", so every document this
// skill created was unrenderable, and a seeded workbook had no worksheets for
// excel_write_range to address.
//
// These are real, minimal, valid packages. The docx is one empty paragraph;
// the xlsx has a single worksheet named Sheet1, which is what
// excelWriteRange/excelClearRange fall back to when no worksheet is given.
const BLANK_DOCX_B64 =
  "UEsDBBQAAAAIAKgTJl15bjPX6AAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QyU7DMBD9FWuuKHHggBCK0wPLETiUDxjZk8SqN3nc0v49Tlt6QIXjzFv1+tXeO7GjzDYGBbdtB4KCjsaGScHn+rV5AMEFg0EXAyk4EMNq6NeHRCyqNrCCuZT0KCXrmTxyGxOFiowxeyz1zJNMqDc4kbzrunupYygUSlMWDxj6Zxpx64p42df3qUcmxyCeTsQlSwGm5KzGUnG5C+ZXSnNOaKvyyOHZJr6pBJBXExbk74Cz7r0Ok60h8YG5vKGvLPkVs5Em6q2vyvZ/mys94zhaTRf94pZy1MRcF/euvSAebfjpL49zD99QSwMEFAAAAAgAqBMmXZv9N+qtAAAAKQEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4KtE3mlaBoRQ0y4IqSsqB7ASN61oHkrCo7cnAwNFDIy2f3+W6/ZpZnanECdnBVRFCYysdGqyWsClP232wGJCq3B2lgQsFKFt6jPNmPJKHCcfWTZsFDCm5A+cRzmSwVg4TzZPBhcMplwGzT3KK2ri27Lc8fBpwNpknRIQOlUB6xdP/9huGCZJRydvhmz6ceIrkWUMmpKAhwuKq3e7yCzwpuarF5sXUEsDBBQAAAAIAKgTJl3jwvl8kQAAALkAAAARAAAAd29yZC9kb2N1bWVudC54bWxFjT0OwjAMha9SeacuDAhVTdmYGeAAITFtpcaO4kDp7UkHxPJ+9KTvdedPmKs3JZ2EDezrBipiJ37iwcD9dtmdoNJs2dtZmAyspHDuu6X14l6BOFcFwNouBsacY4uobqRgtZZIXLanpGBzqWnARZKPSRypFn6Y8dA0Rwx2YtiQD/Hr5hE3VXL5mkrE34L/1/4LUEsBAhQDFAAAAAgAqBMmXXluM9foAAAArQEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACACoEyZdm/036q0AAAApAQAACwAAAAAAAAAAAAAAgAEZAQAAX3JlbHMvLnJlbHNQSwECFAMUAAAACACoEyZd48L5fJEAAAC5AAAAEQAAAAAAAAAAAAAAgAHvAQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAArwIAAAAA";

const BLANK_XLSX_B64 =
  "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";

function b64ToBytes(b64) {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// ── Own-file-only write policy ──────────────────────────────────────
// Enforced HERE rather than in a guardrail script. Guardrails hook the
// ToolExecutor path, but a skill script reaches this server through
// ScriptRunner -> MCP router, which skips that layer entirely — so every
// script had unguarded write access to the user's files with the server's
// own OAuth token. A policy attached to a caller is bypassed by adding a new
// caller; attached to the resource, it holds for every caller there is.
//
// State lives as long as the server instance does, which is the same lifetime
// the guardrail's module-level Set had.
const createdFileIds = new Set();
let needsAuth = false;

const CREATE_TOOLS = new Set(["excel_create", "word_create", "ppt_create"]);

const MUTATE_ID_ARG = {
  excel_write_range: "itemId",
  excel_batch_update: "itemId",
  excel_clear_range: "itemId",
  word_batch_update: "itemId",
  ppt_batch_update: "itemId",
};
const MUTATE_TOOLS = new Set(Object.keys(MUTATE_ID_ARG));

const AUTH_ERROR_RE = /\b(401|InvalidAuthenticationToken|TokenExpired)\b/;
const CREATED_ID_RE = /(?:Created|Copied) (?:workbook|document|presentation): (\S+)/;

const REAUTH_MESSAGE =
  "\u26a0\ufe0f AUTHENTICATION REQUIRED: Your Microsoft session has expired. Please click " +
  "'Sign in' in the side panel to re-connect your account before continuing.";

// Item IDs are scoped to a drive, so two drives can legitimately hold the same
// ID. Key ownership on the pair, and record the bare ID too because create
// results do not always echo the drive back.
function ownershipKeys(itemId, driveId) {
  return driveId ? [`${driveId}:${itemId}`, itemId] : [itemId];
}

function isOwned(itemId, args) {
  return ownershipKeys(itemId, args?.driveId).some(k => createdFileIds.has(k));
}

function recordOwned(id, args) {
  for (const k of ownershipKeys(id, args?.driveId)) createdFileIds.add(k);
}

// Anything shaped like a mutation but not registered above fails closed rather
// than falling through to the read allowance. Verified against every tool name
// both servers expose: no read tool matches.
const LOOKS_LIKE_MUTATION_RE =
  /(^|_)(write|update|delete|clear|remove|append|insert|move|rename|share|send)(_|$)/i;

function deny(message) {
  return { content: [{ type: "text", text: `GUARDRAIL BLOCK: ${message}` }], isError: true };
}

/** Returns a denial result to short-circuit with, or null to proceed. */
function enforceWritePolicy(name, args) {
  if (needsAuth) {
    needsAuth = false;
    return { content: [{ type: "text", text: REAUTH_MESSAGE }], isError: true };
  }

  if (CREATE_TOOLS.has(name)) return null;

  if (MUTATE_TOOLS.has(name)) {
    const idKey = MUTATE_ID_ARG[name];
    const fileId = args?.[idKey];

    if (!fileId) {
      return deny(`${name} requires a file ID (${idKey}) but none was provided.`);
    }
    if (!isOwned(fileId, args)) {
      return deny(
        `${name} on ${idKey}="${fileId}" denied. Write operations are only allowed on ` +
        `files created by this agent. Created files: [${[...createdFileIds].join(", ") || "none"}]. ` +
        `Use the corresponding create tool first, or use read-only tools for existing files.`
      );
    }
    return null;
  }

  if (LOOKS_LIKE_MUTATION_RE.test(name)) {
    return deny(
      `${name} looks like a write operation but is not registered in MUTATE_ID_ARG, ` +
      `so its ownership check cannot be applied. Register it before use.`
    );
  }

  return null;
}

/** Records created file IDs and latches auth failures for the next call. */
function observeResult(name, args, result) {
  if (!result) return;

  if (result.isError) {
    const text = (result.content || []).map(b => b?.text || "").join("\n");
    if (AUTH_ERROR_RE.test(text)) needsAuth = true;
    return;
  }

  if (!CREATE_TOOLS.has(name)) return;

  const block = result.content?.[0];
  const text = block?.text || "";
  const id = block?._createdFileId || (text.match(CREATED_ID_RE) || [])[1];
  if (id) recordOwned(id, args);
}

const PDF_EXPORT_CACHE = new Map(); // cacheKey -> { bytes, at }
const PDF_EXPORT_TTL_MS = 5 * 60 * 1000;

// ── Sandbox rendering prerequisite ──────────────────────────────────────
// The MCP sandbox iframe is never painted, and Chrome does not service
// requestAnimationFrame for a frame that is not being rendered. pdf.js drives
// its render loop through rAF for display intent, so page.render().promise
// starts, schedules its next chunk, and never settles — no error, no
// rejection, just a tool call that never returns. Confirmed in the pdf skill:
// the stalled tasks only died when the document was destroyed, which surfaced
// as a burst of "Rendering cancelled" rejections.
//
// Routing rAF to a timer restores forward progress. Nothing here paints, so
// there is no animation to stay in sync with.
let rafShimInstalled = false;

function installRafShim() {
  if (rafShimInstalled || typeof window === "undefined") return;
  rafShimInstalled = true;

  window.requestAnimationFrame = function (cb) {
    return setTimeout(() => cb(typeof performance !== "undefined" ? performance.now() : Date.now()), 0);
  };
  window.cancelAnimationFrame = function (id) { clearTimeout(id); };

  runtime.console.log("[PDF render] requestAnimationFrame routed to timers (sandbox frame is never painted)");
}

// A page that has not rasterized in this long is stuck, not slow.
const RENDER_TIMEOUT_MS = 20000;

async function ensurePdfJs() {
  installRafShim();
  if (pdfjsLibRef) return pdfjsLibRef;

  if (typeof pdfjsLib !== "undefined") {
    pdfjsLibRef = pdfjsLib;
    return pdfjsLibRef;
  }

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
  if (!extId) throw new Error("pdf.js: cannot determine extension ID. Check sandbox URL configuration.");

  // Dynamic import — pdf.mjs is a real ES module; running it as a classic
  // script breaks webpack's lazy getter closures (see pdf_mcp.js).
  const module = await import(`chrome-extension://${extId}/lib/pdf.mjs`);
  if (!module || typeof module.getDocument !== "function") {
    throw new Error("pdf.js not available. Copy build/pdf.mjs to public/lib/pdf.mjs in the extension and rebuild.");
  }
  if (module.GlobalWorkerOptions) {
    module.GlobalWorkerOptions.workerSrc = `chrome-extension://${extId}/lib/pdf.worker.mjs`;
  }
  pdfjsLibRef = module;
  return pdfjsLibRef;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// Crop region in normalized 0..1 page coordinates, origin top-left.
function normalizeRegion(region) {
  if (!region) return null;
  const x = clamp01(Number(region.x) || 0);
  const y = clamp01(Number(region.y) || 0);
  const width = Math.min(region.width === undefined ? 1 - x : clamp01(Number(region.width)), 1 - x);
  const height = Math.min(region.height === undefined ? 1 - y : clamp01(Number(region.height)), 1 - y);
  if (!(width > 0) || !(height > 0)) {
    throw new Error("region width/height must be > 0 (normalized 0-1 page coordinates)");
  }
  return { x, y, width, height };
}

// runtime.fetch sometimes hands back base64 text in the ArrayBuffer rather than
// raw bytes. Detect via the format's magic number and decode if it is missing.
async function readBinaryResponse(response, magic) {
  const raw = new Uint8Array(await response.arrayBuffer());
  if (magic && raw.length > magic.length && magic.every((b, i) => raw[i] === b)) {
    return raw;
  }
  try {
    const decoded = atob(new TextDecoder().decode(raw));
    const out = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
    return out;
  } catch (_) {
    return raw;
  }
}

const MAGIC_PDF = [0x25, 0x50, 0x44, 0x46]; // %PDF
const MAGIC_PNG = [0x89, 0x50, 0x4E, 0x47]; // \x89PNG

async function readPdfBytes(response) {
  return await readBinaryResponse(response, MAGIC_PDF);
}

function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000; // avoid blowing the argument limit on large buffers
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Encoded size without doing the encoding: 4 chars per 3 bytes, padded. Lets a
// caller rule an oversized image out before materializing the string.
function base64LengthOf(bytes) {
  return Math.ceil(bytes.length / 3) * 4;
}

// One copy of the extension table. There were six, all identical, and any fix
// to the decodability rules below would have had to find all of them.
const OOXML_IMAGE_MIME_MAP = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  bmp: "image/bmp", tiff: "image/tiff", emf: "image/x-emf", wmf: "image/x-wmf",
  svg: "image/svg+xml",
};

function mimeForImageName(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  return OOXML_IMAGE_MIME_MAP[ext] || `image/${ext}`;
}

// What createImageBitmap can actually decode in this sandbox, and what a vision
// model will actually accept. EMF and WMF are Windows metafiles and TIFF is not
// a web format: Chrome cannot rasterize any of them, so _resizeImageForLLM
// always throws on those and the old catch shipped the raw original — uncapped,
// and tagged with a media_type no provider accepts. This is not an edge case in
// OOXML: a pasted Excel chart, a Visio diagram or an equation is stored as EMF
// or WMF as a matter of course. Refuse them up front and say what to do instead.
const DECODABLE_IMAGE_MIMES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/bmp", "image/webp",
]);

// A single call may not return more images than this. ppt_download_image takes
// a comma-separated list with no cap, so one call could return N payloads of up
// to MAX_BASE64_LENGTH each.
const MAX_IMAGES_PER_CALL = 4;

/**
 * Rasterize one page of a PDF held in memory.
 * Returns { base64, width, height, page, totalPages, scale }.
 *
 * The pixel budget (maxDim) applies to the *output* canvas, so cropping to a
 * region buys resolution instead of throwing it away — that is what makes a
 * small axis label on a chart legible.
 */
// Resolution tiers, deliberately identical to ScreenshotTools.RESOLUTION_MAP in
// src/background/tools/screenshot-tools.ts and to the pdf skill. An image
// returned from a tool is spent context: rendering a page at maxDim 2000 costs
// ~29,800 tokens, against ~1,300 for takeScreenshot's own default. Same repo,
// 23x apart. One vocabulary, one default, so the cheap thing happens by default.
const RESOLUTION_MAP = { low: 480, medium: 1280, high: 1920, original: Infinity };
const DEFAULT_RESOLUTION = "low";

// Hard ceiling on the encoded payload, mirroring resizeForLLM's maxBase64Length.
// A runaway guard, not a budget: the tier is what keeps calls cheap.
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

async function renderPdfPage(bytes, pageNum, opts = {}) {
  const lib = await ensurePdfJs();
  const doc = await lib.getDocument({
    // pdf.js takes ownership of `data` and transfers the underlying
    // ArrayBuffer, which detaches it. These bytes come from PDF_EXPORT_CACHE
    // and are reused for the 5-minute TTL, so handing the cached array over
    // directly poisons the cache: the first render succeeds and every
    // subsequent render of the same file dies inside the fake worker's
    // LoopbackPort with "structuredClone ... ArrayBuffer is detached".
    // Paging through a document is the main use case, so this hit constantly.
    // Give pdf.js a copy and keep the cached original intact.
    data: bytes.slice(),
    useWorkerFetch: false,
    useSystemFonts: true,
    disableWorker: true,
    stopWorker: true,
  }).promise;

  try {
    const totalPages = doc.numPages;
    const target = Math.round(Number(pageNum) || 1);
    if (!Number.isFinite(target) || target < 1 || target > totalPages) {
      throw new Error(`Page ${pageNum} is out of range — the rendered file has ${totalPages} page(s).`);
    }

    const region = normalizeRegion(opts.region);
    const maxDim = resolveMaxDim(opts.resolution);
    const page = await doc.getPage(target);

    // Fit the page to the tier rather than starting from an arbitrary scale.
    // Cropping to a region spends the pixel budget on the crop instead of on
    // pixels that get thrown away, so a small region comes back sharper for
    // the same cost — a 480px crop of one chart reads better than a whole
    // page at 1920.
    let scale = 1.0;
    let viewport = page.getViewport({ scale });
    const outSpan = () => Math.max(
      viewport.width * (region ? region.width : 1),
      viewport.height * (region ? region.height : 1)
    );
    if (maxDim !== Infinity && outSpan() !== 0) {
      scale = maxDim / outSpan();
      viewport = page.getViewport({ scale });
    }

    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(viewport.width * (region ? region.width : 1))),
      Math.max(1, Math.round(viewport.height * (region ? region.height : 1)))
    );
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white"; // JPEG has no alpha — transparent pixels turn black
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Shift the page under a smaller canvas instead of cropping afterwards.
    const transform = region
      ? [1, 0, 0, 1, -Math.round(viewport.width * region.x), -Math.round(viewport.height * region.y)]
      : undefined;

    // Never await a render unbounded. If the shim above ever stops working — a
    // pdf.js change, a different sandbox host — the failure must surface as an
    // error the caller can report, not as a tool call that hangs until the
    // whole script budget is gone.
    const renderTask = page.render({ canvasContext: ctx, viewport, transform });
    let watchdog;
    try {
      await Promise.race([
        renderTask.promise,
        new Promise((_, reject) => {
          watchdog = setTimeout(() => {
            renderTask.cancel();
            reject(new Error(
              `Render of page ${target} did not complete within ${RENDER_TIMEOUT_MS}ms. ` +
              `The render loop is stalled, not slow — check that requestAnimationFrame ` +
              `is being serviced in the MCP sandbox frame.`
            ));
          }, RENDER_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(watchdog);
    }
    page.cleanup();

    // Back off quality, then dimensions, until the payload fits — the same
    // strategy resizeForLLM uses in screenshot-tools.ts. A dense scanned page
    // can exceed the ceiling even at a modest tier, and silently shipping
    // 100k tokens of base64 is the failure this guard exists to prevent.
    let quality = opts.quality == null ? 0.85 : opts.quality;
    let outCanvas = canvas;
    let blob = await outCanvas.convertToBlob({ type: "image/jpeg", quality });
    let base64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    while (base64.length > MAX_BASE64_LENGTH && quality > 0.2) {
      quality -= 0.1;
      if (quality < 0.5) {
        const w = Math.max(1, Math.round(outCanvas.width * 0.75));
        const h = Math.max(1, Math.round(outCanvas.height * 0.75));
        const shrunk = new OffscreenCanvas(w, h);
        const sctx = shrunk.getContext("2d");
        sctx.fillStyle = "white";
        sctx.fillRect(0, 0, w, h);
        sctx.drawImage(outCanvas, 0, 0, w, h);
        outCanvas = shrunk;
        quality = 0.7;
      }
      blob = await outCanvas.convertToBlob({ type: "image/jpeg", quality });
      base64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    }

    return {
      base64,
      width: outCanvas.width,
      height: outCanvas.height,
      page: target,
      totalPages,
      scale: Number(scale.toFixed(3)),
      resolution: opts.resolution || DEFAULT_RESOLUTION,
      quality: Number(quality.toFixed(2)),
      bytes: base64.length,
    };
  } finally {
    doc.destroy().catch(() => {});
  }
}

return {
  _worksheetCache: {},

  listTools() {
    return [
      // ── OneDrive ──
      {
        name: "onedrive_list",
        description: "List files from OneDrive root or a folder, or list recently accessed files. Each result includes a webUrl. Use recent=true for recently accessed files across all folders.",
        displayMessage: "📁 Listing OneDrive files",
        inputSchema: {
          type: "object",
          properties: {
            folderId: { type: "string", description: "Folder ID (omit for root)" },
            maxResults: { type: "number", description: "Max files (default 20, max 100)" },
            skipToken: { type: "string", description: "Pagination token" },
            recent: { type: "boolean", description: "If true, list recently accessed files across all folders (ignores folderId)" },
            orderBy: { type: "string", description: "Sort order for folder listing (e.g. 'lastModifiedDateTime desc', 'name asc'). Not supported with recent=true." },
          },
        },
      },
      {
        name: "onedrive_search",
        description: "Search OneDrive files by name/content.",
        displayMessage: "🔍 Searching OneDrive for \"{{query}}\"",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search text" },
            maxResults: { type: "number", description: "Max results (default 20)" },
          },
          required: ["query"],
        },
      },
      {
        name: "onedrive_get_file_metadata",
        description: "Get metadata for a OneDrive file.",
        displayMessage: "📄 Reading file metadata for {{itemId}}",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "The item ID" },
            driveId: { type: "string", description: "Optional drive ID for shared files" },
          },
          required: ["itemId"],
        },
      },
      {
        name: "onedrive_render_page",
        description: "Render one page of a OneDrive/SharePoint file as an image. Graph converts Word, Excel, and PowerPoint files to PDF with Office's own renderer, then the page is rasterized. Use this when the text APIs cannot express what matters: charts, SmartArt, drawings, equations, layout-carrying tables, or any question about how a page actually looks. word_read_content and excel_read_range remain the source of truth for prose and numbers — this is for what they cannot see. Page numbers come from Office's pagination and match what the user sees; the response reports totalPages so you can page through.",
        displayMessage: "🖼️ Rendering page {{page|default:1}} of file",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "The OneDrive item ID" },
            driveId: { type: "string", description: "Optional drive ID for shared files" },
            page: { type: "number", description: "1-based page number of the converted PDF (default: 1)" },
            resolution: { type: "string", enum: ["low", "medium", "high", "original"], description: "Resolution tier, matching takeScreenshot: low=480px (default, ~1k tokens), medium=1280px, high=1920px, original=uncapped. Prefer a region crop over a higher tier — cropping spends the pixels where they matter and costs less." },
            region: {
              type: "object",
              description: "Optional crop in normalized 0-1 page coordinates, origin top-left. A smaller region comes back sharper, since the pixel budget is spent on the crop. Example: bottom-left quadrant = { x: 0, y: 0.5, width: 0.5, height: 0.5 }.",
              properties: {
                x: { type: "number", description: "Left edge, 0-1 (default: 0)" },
                y: { type: "number", description: "Top edge, 0-1 (default: 0)" },
                width: { type: "number", description: "Width, 0-1 (default: to right edge)" },
                height: { type: "number", description: "Height, 0-1 (default: to bottom edge)" },
              },
            },
          },
          required: ["itemId"],
        },
      },
      {
        name: "word_get_images",
        description: "List all embedded images in a Word document. Returns metadata (name, size, content type) for each image. Use word_download_image to fetch individual images.",
        displayMessage: "🖼️ Listing images in Word document",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "The item ID" },
            driveId: { type: "string", description: "Optional drive ID for shared files" },
          },
          required: ["itemId"],
        },
      },
      {
        name: "word_download_image",
        description: "Download a single embedded image from a Word document by its name. Returns the image as base64 for visual analysis. Get image names from word_get_images. EMF/WMF/TIFF entries cannot be returned — those are Windows metafiles (pasted charts, diagrams, equations) that no vision model accepts; use onedrive_render_page on the containing page instead.",
        displayMessage: "🖼️ Downloading image: {{imageName}}",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "The item ID" },
            driveId: { type: "string", description: "Optional drive ID for shared files" },
            imageName: { type: "string", description: "Image name from word_get_images (e.g. 'word/media/image1.png')" },
            resolution: {
              type: "string",
              enum: ["low", "medium", "high", "original"],
              description: "Resolution tier: low=480px, medium=1280px (default), high=1920px, original=uncapped. Higher tiers cost proportionally more context.",
            },
          },
          required: ["itemId", "imageName"],
        },
      },
      {
        name: "onedrive_download_text",
        description: "Download a file's text content (for text/csv/html files).",
        displayMessage: "📄 Downloading file content",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "The item ID" },
            driveId: { type: "string", description: "Optional drive ID for shared files" },
          },
          required: ["itemId"],
        },
      },
      {
        name: "onedrive_resolve_link",
        description: "Convert a raw OneDrive or SharePoint sharing URL into an itemId and driveId so it can be used with other API tools (like word_read_content).",
        displayMessage: "🔗 Resolving sharing link",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The raw sharing URL (e.g., https://tenant.sharepoint.com/:w:/s/...)" },
          },
          required: ["url"],
        },
      },

      // ── Excel Online ──
      {
        name: "excel_list",
        description: "List recent Excel workbooks from OneDrive.",
        displayMessage: "📋 Listing Excel workbooks",
        inputSchema: {
          type: "object",
          properties: {
            maxResults: { type: "number", description: "Max results (default 10)" },
          },
        },
      },
      {
        name: "excel_create",
        description: "Create a new Excel workbook in OneDrive root, or copy an existing one. Returns itemId and webUrl. Use copyFromId to duplicate an existing workbook (preserves all sheets, formulas, formatting, and data).",
        displayMessage: "📊 Creating workbook \"{{title}}\"",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Filename (without .xlsx extension)" },
            copyFromId: { type: "string", description: "OneDrive item ID of workbook to copy. If provided, creates a full copy instead of a blank workbook." },
          },
          required: ["title"],
        },
      },
      {
        name: "excel_get_metadata",
        description: "Get workbook metadata: worksheets, named ranges.",
        displayMessage: "📊 Reading workbook metadata for {{itemId}}",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "OneDrive item ID of the workbook" },
            driveId: { type: "string", description: "Optional drive ID for shared files" },
          },
          required: ["itemId"],
        },
      },
      {
        name: "excel_read_range",
        description: "Read a range of cells from an Excel workbook.",
        displayMessage: "📊 Reading cells {{range}}",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            driveId: { type: "string", description: "Optional drive ID for shared files" },
            worksheet: { type: "string", description: "Worksheet name (default: first sheet)" },
            range: { type: "string", description: "A1 notation range (e.g. 'A1:B10')" },
            offset: { type: "number", description: "Row offset for pagination" },
            limit: { type: "number", description: "Max rows to return" },
          },
          required: ["itemId", "range"],
        },
      },
      {
        name: "excel_read_as_csv",
        description: "Read an Excel range and return as CSV text.",
        displayMessage: "📊 Reading {{range}} as CSV",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            driveId: { type: "string", description: "Optional drive ID for shared files" },
            worksheet: { type: "string" },
            range: { type: "string" },
            offset: { type: "number" },
            limit: { type: "number" },
          },
          required: ["itemId", "range"],
        },
      },
      {
        name: "excel_write_range",
        description: "Write data to a range in an Excel workbook (own files only).",
        displayMessage: "📝 Writing to {{range}} in workbook",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            worksheet: { type: "string" },
            range: { type: "string" },
            values: {
              type: "array",
              description: "2D array of values",
              items: { type: "array", items: {} }
            },
          },
          required: ["itemId", "range", "values"],
        },
      },
      {
        name: "excel_batch_update",
        description: "Batch operations on Excel: add/delete/rename worksheets, format cells. Uses the Excel REST API batch endpoint. Own files only.",
        displayMessage: "📊 Updating workbook",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            requests: {
              type: "array",
              description: "Array of Graph API batch request objects",
              items: { type: "object" }
            },
          },
          required: ["itemId", "requests"],
        },
      },
      {
        name: "excel_clear_range",
        description: "Clear values from a range (keeps formatting). Own files only.",
        displayMessage: "🧹 Clearing {{range}} in workbook",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            worksheet: { type: "string" },
            range: { type: "string" },
          },
          required: ["itemId", "range"],
        },
      },

      // ── Word Online ──
      {
        name: "word_create",
        description: "Create a new Word document in OneDrive root, or copy an existing one. Returns itemId and webUrl. Use copyFromId to duplicate an existing document (preserves all content, formatting, and images).",
        displayMessage: "📝 Creating document \"{{title}}\"",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Filename (without .docx extension)" },
            copyFromId: { type: "string", description: "OneDrive item ID of document to copy. If provided, creates a full copy instead of a blank document." },
          },
          required: ["title"],
        },
      },
      {
        name: "word_get_metadata",
        description: "Get Word document metadata: name, size, timestamps, webUrl.",
        displayMessage: "📝 Reading document metadata",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            driveId: { type: "string", description: "Optional drive ID for shared files" },
          },
          required: ["itemId"],
        },
      },
      {
        name: "word_read_content",
        description: "Read Word document content as HTML. Supports pagination via startIndex/endIndex character offsets.",
        displayMessage: "📖 Reading document content",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            driveId: { type: "string", description: "Optional drive ID for shared files" },
            startIndex: { type: "number", description: "Character start for pagination" },
            endIndex: { type: "number", description: "Character end for pagination" },
          },
          required: ["itemId"],
        },
      },
      {
        name: "word_batch_update",
        description: "Replace the content of a Word document by uploading new OOXML/HTML content. Own files only. NOTE: This replaces the entire file, not incremental edits.",
        displayMessage: "📝 Updating document",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            htmlContent: { type: "string", description: "HTML content to write as the document body" },
          },
          required: ["itemId", "htmlContent"],
        },
      },

      // ── PowerPoint Online ──
      {
        name: "ppt_create",
        description: "Create a new PowerPoint presentation in OneDrive root, or copy an existing one. Returns itemId and webUrl. Use copyFromId to duplicate an existing presentation (preserves all slides, layouts, and media).",
        displayMessage: "📽️ Creating presentation \"{{title}}\"",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Filename (without .pptx extension)" },
            copyFromId: { type: "string", description: "OneDrive item ID of presentation to copy. If provided, creates a full copy instead of a blank presentation." },
          },
          required: ["title"],
        },
      },
      {
        name: "ppt_get_metadata",
        description: "Get presentation metadata: name, size, timestamps, webUrl, and per-slide metadata (index, objectId, title). Returns slideCount and slides array.",
        displayMessage: "📽️ Reading presentation metadata",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            driveId: { type: "string", description: "Optional drive ID for shared files" },
          },
          required: ["itemId"],
        },
      },
      {
        name: "ppt_read_content",
        description: "Read presentation slide content including text and image inventory. Each slide shows its text and lists any embedded images with name and size. Use ppt_download_image to fetch specific images for visual analysis. Supports pagination by slide range.",
        displayMessage: "📖 Reading slides {{startSlide|default:1}} to {{endSlide|default:end}}",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            driveId: { type: "string", description: "Optional drive ID for shared files" },
            startSlide: { type: "number", description: "1-based start slide index (default 1)" },
            endSlide: { type: "number", description: "1-based end slide index (default: last slide). Use for pagination over large decks." },
          },
          required: ["itemId"],
        },
      },
      {
        name: "ppt_download_image",
        description: "Download embedded image(s) from a PowerPoint presentation. Returns base64 image(s) for visual analysis. Get image names from ppt_read_content output. Pass a single name or up to 4 comma-separated names. EMF/WMF/TIFF entries cannot be returned — those are Windows metafiles (pasted charts, diagrams, equations) that no vision model accepts; use onedrive_render_page on the containing slide instead.",
        displayMessage: "🖼️ Downloading image: {{imageName}}",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "The item ID" },
            driveId: { type: "string", description: "Optional drive ID for shared files" },
            imageName: { type: "string", description: "Image name(s) from ppt_read_content (e.g. 'ppt/media/image1.png' or 'ppt/media/image1.png,ppt/media/image2.jpg'). At most 4 per call." },
            resolution: {
              type: "string",
              enum: ["low", "medium", "high", "original"],
              description: "Resolution tier: low=480px, medium=1280px (default), high=1920px, original=uncapped. Higher tiers cost proportionally more context.",
            },
          },
          required: ["itemId", "imageName"],
        },
      },
      {
        name: "ppt_batch_update",
        description: "Replace PowerPoint content by uploading new file. Own files only. NOTE: This replaces the entire file.",
        displayMessage: "📽️ Updating presentation",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            base64Content: { type: "string", description: "Base64-encoded .pptx file content" },
          },
          required: ["itemId", "base64Content"],
        },
      },

      // ── Outlook Mail ──
      {
        name: "outlook_search",
        description: "Search Outlook messages. Returns message IDs, subject, from, receivedDateTime, preview.",
        displayMessage: "📧 Searching Outlook: \"{{query}}\"",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query (KQL syntax, e.g., 'from:alice subject:report')" },
            maxResults: { type: "number", description: "Max results (default 10, max 100)" },
            skipToken: { type: "string", description: "Pagination token" },
          },
          required: ["query"],
        },
      },
      {
        name: "outlook_get_message",
        description: "Get full content of an Outlook message by ID.",
        displayMessage: "📧 Reading message {{messageId}}",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message ID" },
          },
          required: ["messageId"],
        },
      },
      {
        name: "outlook_list_folders",
        description: "List all mail folders (Inbox, Sent, Drafts, etc.).",
        displayMessage: "📁 Listing mail folders",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "outlook_get_thread",
        description: "Get all messages in a conversation thread.",
        displayMessage: "📧 Reading email thread {{conversationId}}",
        inputSchema: {
          type: "object",
          properties: {
            conversationId: { type: "string", description: "The conversation ID" },
          },
          required: ["conversationId"],
        },
      },
      {
        name: "outlook_get_attachment",
        description: "Get an attachment from an Outlook message. By default returns metadata only.",
        displayMessage: "📎 Fetching attachment {{attachmentId}}",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string" },
            attachmentId: { type: "string" },
            returnRawBase64: { type: "boolean", description: "Only use from scripts, not direct chat." },
          },
          required: ["messageId", "attachmentId"],
        },
      },

      // ── Calendar ──
      {
        name: "ms_calendar_list",
        description: "List calendars accessible to the user.",
        displayMessage: "📅 Listing calendars",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "ms_calendar_get_events",
        description: "Get calendar events within a time range.",
        displayMessage: "📅 Fetching events{{#search}} matching \"{{search}}\"{{/search}}",
        inputSchema: {
          type: "object",
          properties: {
            calendarId: { type: "string", description: "Calendar ID (omit for default)" },
            startDateTime: { type: "string", description: "ISO 8601 start (e.g. '2025-01-01T00:00:00Z')" },
            endDateTime: { type: "string", description: "ISO 8601 end" },
            maxResults: { type: "number", description: "Max events (default 25)" },
            skipToken: { type: "string" },
            search: { type: "string", description: "Free text search" },
          },
        },
      },
      {
        name: "ms_calendar_get_event",
        description: "Get a single calendar event by ID.",
        displayMessage: "📅 Reading event details for {{eventId}}",
        inputSchema: {
          type: "object",
          properties: {
            eventId: { type: "string" },
          },
          required: ["eventId"],
        },
      },
    ];
  },

  async callTool(name, args) {
    const denial = enforceWritePolicy(name, args);
    if (denial) return denial;

    const result = await this._dispatch(name, args);
    observeResult(name, args, result);
    return result;
  },

  async _dispatch(name, args) {
    try {
      switch (name) {
        // OneDrive
        case "onedrive_list": return await this.onedriveList(args);
        case "onedrive_search": return await this.onedriveSearch(args);
        case "onedrive_get_file_metadata": return await this.onedriveGetMetadata(args);
        case "onedrive_download_text": return await this.onedriveDownloadText(args);
        case "onedrive_resolve_link": return await this.onedriveResolveLink(args);
        case "onedrive_render_page": return await this.onedriveRenderPage(args);
        // Excel
        case "excel_list": return await this.excelList(args);
        case "excel_create": return await this.excelCreate(args);
        case "excel_get_metadata": return await this.excelGetMetadata(args);
        case "excel_read_range": return await this.excelReadRange(args);
        case "excel_read_as_csv": return await this.excelReadAsCsv(args);
        case "excel_write_range": return await this.excelWriteRange(args);
        case "excel_batch_update": return await this.excelBatchUpdate(args);
        case "excel_clear_range": return await this.excelClearRange(args);
        // Word
        case "word_create": return await this.wordCreate(args);
        case "word_get_metadata": return await this.wordGetMetadata(args);
        case "word_read_content": return await this.wordReadContent(args);
        case "word_batch_update": return await this.wordBatchUpdate(args);
        case "word_get_images": return await this.wordGetImages(args);
        case "word_download_image": return await this.wordDownloadImage(args);
        // PowerPoint
        case "ppt_create": return await this.pptCreate(args);
        case "ppt_get_metadata": return await this.pptGetMetadata(args);
        case "ppt_read_content": return await this.pptReadContent(args);
        case "ppt_batch_update": return await this.pptBatchUpdate(args);
        case "ppt_download_image": return await this.pptDownloadImage(args);
        // Outlook
        case "outlook_search": return await this.outlookSearch(args);
        case "outlook_get_message": return await this.outlookGetMessage(args);
        case "outlook_list_folders": return await this.outlookListFolders(args);
        case "outlook_get_thread": return await this.outlookGetThread(args);
        case "outlook_get_attachment": return await this.outlookGetAttachment(args);
        // Calendar
        case "ms_calendar_list": return await this.msCalendarList(args);
        case "ms_calendar_get_events": return await this.msCalendarGetEvents(args);
        case "ms_calendar_get_event": return await this.msCalendarGetEvent(args);
        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  },

  // ── Helper: resize/compress an image to fit within LLM context limits ──
  // Returns { base64, mimeType } with the image resized to fit within maxBytes.
  // Uses OffscreenCanvas (available in service workers and sandbox iframes).
  // Targets ~400KB base64 output (~300KB raw) which is ~100K tokens — reasonable
  // for vision analysis without blowing context limits.
  // Defaults to the medium tier rather than low: these are embedded document
  // images — screenshots, photos, scanned figures — where 480px often makes
  // text unreadable, unlike a rendered page the caller can re-crop. Callers
  // that need detail can ask for high/original explicitly.
  async _resizeImageForLLM(rawBytes, originalMimeType, resolution, maxBase64Bytes = MAX_BASE64_LENGTH) {
    const srcBytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
    const blob = new Blob([srcBytes], { type: originalMimeType });
    const maxDim = resolveMaxDim(resolution || "medium");

    // Measure, don't encode. The old line ran
    //   btoa(Array.from(new Uint8Array(rawBytes)).map(...).join(''))
    // unconditionally, before any size or tier check — for a 5MB image that is
    // a 5-million-element array plus a 5-million-element string join, thrown
    // away moments later. bytesToBase64 already exists in this file and is
    // chunked; use it, and only when the bytes are actually being returned.
    const estimated = base64LengthOf(srcBytes);

    if (estimated <= maxBase64Bytes && maxDim === Infinity) {
      return { base64: bytesToBase64(srcBytes), mimeType: originalMimeType, width: null, height: null, resized: false };
    }

    const bitmap = await createImageBitmap(blob);
    const srcW = bitmap.width;
    const srcH = bitmap.height;

    // Small enough AND already within the tier — hand back the original bytes.
    if (estimated <= maxBase64Bytes && srcW <= maxDim && srcH <= maxDim) {
      bitmap.close();
      return { base64: bytesToBase64(srcBytes), mimeType: originalMimeType, width: srcW, height: srcH, resized: false };
    }

    runtime.console.log(`[_resizeImageForLLM] Resizing ${srcW}x${srcH} (~${Math.round(estimated / 1024)}KB base64) to the ${resolution || "medium"} tier...`);

    let width = srcW;
    let height = srcH;
    if (maxDim !== Infinity && (width > maxDim || height > maxDim)) {
      const fit = maxDim / Math.max(width, height);
      width = Math.max(1, Math.round(width * fit));
      height = Math.max(1, Math.round(height * fit));
    }

    // Back off quality, then dimensions, until the payload fits — the same
    // strategy as renderPdfPage and screenshot-tools.ts. The old single pass
    // could still return well over the ceiling for a large photograph.
    let quality = 0.8;
    let outBase64;
    for (;;) {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality });
      const outBytes = new Uint8Array(await outBlob.arrayBuffer());
      outBase64 = bytesToBase64(outBytes);
      if (outBase64.length <= maxBase64Bytes || quality <= 0.2) break;
      quality -= 0.1;
      if (quality < 0.5) {
        width = Math.max(1, Math.round(width * 0.75));
        height = Math.max(1, Math.round(height * 0.75));
        quality = 0.7;
      }
    }
    bitmap.close();

    // Read the source dimensions before close(), not after: the previous log
    // read bitmap.width on a closed bitmap and always printed "?".
    runtime.console.log(`[_resizeImageForLLM] Resized ${srcW}x${srcH} -> ${width}x${height}, ${Math.round(outBase64.length / 1024)}KB base64 JPEG`);
    return { base64: outBase64, mimeType: "image/jpeg", width, height, resized: true };
  },

  // Turn one ZIP media entry into MCP content blocks, bounded.
  //
  // wordDownloadImage and both ppt_download_image paths each carried their own
  // copy of this, and all three ended in the same catch: log, re-encode the
  // original, ship it. Downscaling is the ONLY thing keeping the payload under
  // MAX_BASE64_LENGTH, so "resize failed, using raw" meant "return an unbounded
  // payload" — the same defect that cost 1.5M tokens on the Google side. Worse
  // here, because for EMF/WMF/TIFF the resize does not fail occasionally, it
  // fails every time.
  //
  // Returns { blocks, ok }. ok:false lets a single-image caller set isError
  // while a batch caller keeps going with the remaining images.
  async _imageBlocksFor(entry, targetName, resolution) {
    const origMimeType = mimeForImageName(targetName);

    if (!DECODABLE_IMAGE_MIMES.has(origMimeType)) {
      return {
        ok: false,
        blocks: [{
          type: "text",
          text: `Image '${targetName}' is ${origMimeType}, which cannot be rasterized ` +
            `here and which vision models do not accept. Office stores pasted charts, ` +
            `diagrams and equations in this format. Render the page that contains it ` +
            `with onedrive_render_page instead — that goes through the PDF export and ` +
            `returns real pixels.`,
        }],
      };
    }

    let out;
    try {
      out = await this._resizeImageForLLM(entry.data, origMimeType, resolution);
    } catch (e) {
      const estimated = base64LengthOf(entry.data);
      if (estimated > MAX_BASE64_LENGTH) {
        return {
          ok: false,
          blocks: [{
            type: "text",
            text: `Could not downscale '${targetName}' (${e.message}). The original is ` +
              `${Math.round(entry.data.length / 1024)}KB — about ${Math.round(estimated / 1024)}KB ` +
              `of base64, past the ${Math.round(MAX_BASE64_LENGTH / 1024)}KB ceiling — so returning ` +
              `it as-is would exhaust the context window. Render the containing page with ` +
              `onedrive_render_page instead.`,
          }],
        };
      }
      // Under the ceiling even unresized: safe to pass through.
      out = {
        base64: bytesToBase64(entry.data),
        mimeType: origMimeType,
        width: null,
        height: null,
        resized: false,
        note: `resize skipped: ${e.message}`,
      };
    }

    return {
      ok: true,
      blocks: [
        { type: "text", text: JSON.stringify({
          name: targetName,
          mimeType: out.mimeType,
          sourceMimeType: origMimeType,
          sourceBytes: entry.data.length,
          render: {
            width: out.width,
            height: out.height,
            resolution: String(resolution || "medium").toLowerCase(),
            resized: out.resized,
            bytes: out.base64.length,
          },
          note: out.note,
        }, null, 2) },
        { type: "image", source: { type: "base64", media_type: out.mimeType, data: out.base64 } },
      ],
    };
  },

  // ═══════════════════════════════════════════════════════════════
  // OOXML ZIP Extractor (for native reading in sandbox)
  // ═══════════════════════════════════════════════════════════════

  async _readZipEntries(bytes) {
    const entries = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // 1. Scan for all Local File Header signatures (PK\x03\x04)
    const headerOffsets = [];
    for (let i = 0; i < bytes.length - 4; i++) {
      if (bytes[i] === 0x50 && bytes[i+1] === 0x4B && bytes[i+2] === 0x03 && bytes[i+3] === 0x04) {
        headerOffsets.push(i);
      }
    }

    // 2. Extract each file
    for (let i = 0; i < headerOffsets.length; i++) {
      const pos = headerOffsets[i];
      const compMethod = view.getUint16(pos + 8, true);
      let compSize = view.getUint32(pos + 18, true);
      const nameLen = view.getUint16(pos + 26, true);
      const extraLen = view.getUint16(pos + 28, true);

      const name = new TextDecoder().decode(bytes.slice(pos + 30, pos + 30 + nameLen));
      const dataStart = pos + 30 + nameLen + extraLen;

      // MS Office files use Data Descriptors (compSize = 0 in header).
      // We estimate the chunk size by taking all bytes until the NEXT file header.
      if (compSize === 0) {
        const nextPos = i + 1 < headerOffsets.length ? headerOffsets[i+1] : bytes.length;
        compSize = nextPos - dataStart;
      }

      if (dataStart + compSize > bytes.length) continue;
      const compressedData = bytes.slice(dataStart, dataStart + compSize);

      let data = null;
      if (compMethod === 0) {
        data = compressedData; // Uncompressed (STORE)
      } else if (compMethod === 8) {
        const chunks = [];
        let total = 0;
        try {
          // Native Web API to decompress DEFLATE data
          const ds = new DecompressionStream("deflate-raw");
          const writer = ds.writable.getWriter();
          // Fire and forget write to avoid deadlocking the reader
          writer.write(compressedData).then(() => writer.close()).catch(() => {});

          const reader = ds.readable.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            chunks.push(value);
            total += value.length;
          }
        } catch (e) {
          // DecompressionStream intentionally throws when it hits the Data Descriptor
          // garbage bytes at the end of our estimated chunk. We ignore it and keep the valid chunks!
        }

        if (total > 0) {
          data = new Uint8Array(total);
          let offset = 0;
          for (const c of chunks) { data.set(c, offset); offset += c.length; }
        }
      }

      if (data) entries.push({ name, data });
    }
    return entries;
  },

  // Helper: Graph API GET
  async _get(path, params = {}) {
    let url = `${GRAPH}${path}`;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const qsStr = qs.toString();
    if (qsStr) url += (url.includes('?') ? '&' : '?') + qsStr;

    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { _error: true, content: [{ type: "text", text: `API Error (${response.status}): ${error}` }], isError: true };
    }
    return await response.json();
  },

  // Helper: Graph API POST/PUT/PATCH
  async _request(method, path, body, contentType = "application/json") {
    const url = `${GRAPH}${path}`;
    const options = {
      method,
      headers: { "Content-Type": contentType },
    };
    if (body !== undefined) {
      options.body = contentType === "application/json" ? JSON.stringify(body) : body;
    }
    const response = await runtime.fetch(url, options);
    if (!response.ok) {
      const error = await response.text();
      return { _error: true, content: [{ type: "text", text: `API Error (${response.status}): ${error}` }], isError: true };
    }
    // 204 No Content
    if (response.status === 204) return {};
    return await response.json();
  },

  // ═══════════════════════════════════════════════════════════════
  // OneDrive
  // ═══════════════════════════════════════════════════════════════

  async onedriveList({ folderId, maxResults, skipToken, recent, orderBy }) {
    const limit = Math.min(maxResults || 20, 100);

    let path, params;
    if (recent) {
      // /me/drive/recent returns files across all folders sorted by access time
      path = `/me/drive/recent`;
      params = { '$top': limit, '$select': 'id,name,size,lastModifiedDateTime,webUrl,file,folder,remoteItem' };
      if (skipToken) params['$skiptoken'] = skipToken;
    } else {
      path = folderId
        ? `/me/drive/items/${folderId}/children`
        : `/me/drive/root/children`;
      params = { '$top': limit, '$select': 'id,name,size,lastModifiedDateTime,webUrl,file,folder' };
      if (skipToken) params['$skiptoken'] = skipToken;
      if (orderBy) params['$orderby'] = orderBy;
    }

    const data = await this._get(path, params);
    if (data._error) return data;

    // Fallback: if /me/drive/recent returned empty (common on personal accounts),
    // retry with root children sorted by lastModifiedDateTime desc
    if (recent && (!data.value || data.value.length === 0)) {
      return this.onedriveList({
        maxResults: limit, orderBy: 'lastModifiedDateTime desc'
      });
    }

    const files = (data.value || []).map(f => {
      // /me/drive/recent may return remoteItem wrappers
      const item = f.remoteItem || f;
      return {
      id: item.id || f.id,
      driveId: item.parentReference?.driveId || f.parentReference?.driveId,
      name: item.name || f.name,
      size: item.size || f.size,
      lastModified: item.lastModifiedDateTime || f.lastModifiedDateTime,
      webUrl: item.webUrl || f.webUrl,
      isFolder: !!(item.folder || f.folder),
      mimeType: (item.file || f.file)?.mimeType,
      };
    });
    return {
      content: [{ type: "text", text: JSON.stringify({
        files,
        nextLink: data['@odata.nextLink'] || null,
      }, null, 2) }],
    };
  },

  async onedriveSearch({ query, maxResults }) {
    const limit = Math.min(maxResults || 20, 100);
    const data = await this._get(`/me/drive/root/search(q='${encodeURIComponent(query)}')`, { '$top': limit });
    if (data._error) return data;

    const files = (data.value || []).map(f => ({
      id: f.id,
      name: f.name,
      size: f.size,
      lastModified: f.lastModifiedDateTime,
      webUrl: f.webUrl,
      mimeType: f.file?.mimeType,
    }));
    return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
  },

  async onedriveGetMetadata({ itemId, driveId }) {
    const basePath = driveId ? `/drives/${driveId}/items/${itemId}` : `/me/drive/items/${itemId}`;
    const data = await this._get(basePath);
    if (data._error) return data;
    return { content: [{ type: "text", text: JSON.stringify({
      id: data.id,
      name: data.name,
      size: data.size,
      mimeType: data.file?.mimeType,
      webUrl: data.webUrl,
      createdBy: data.createdBy?.user?.displayName,
      lastModifiedBy: data.lastModifiedBy?.user?.displayName,
      lastModified: data.lastModifiedDateTime,
      created: data.createdDateTime,
    }, null, 2) }] };
  },

  async onedriveDownloadText({ itemId, driveId }) {
    const basePath = driveId ? `/drives/${driveId}/items/${itemId}` : `/me/drive/items/${itemId}`;
    const response = await runtime.fetch(`${GRAPH}${basePath}/content`);
    if (!response.ok) {
      return { content: [{ type: "text", text: `Download error: ${response.status}` }], isError: true };
    }
    const text = await response.text();
    return { content: [{ type: "text", text }] };
  },

  async onedriveResolveLink({ url }) {
    // Microsoft Graph requires the sharing URL to be base64url encoded and prefixed with 'u!'
    const base64Value = btoa(unescape(encodeURIComponent(url)));
    const encodedUrl = "u!" + base64Value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const data = await this._get(`/shares/${encodedUrl}/driveItem`);
    if (data._error) return data;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          id: data.id,
          driveId: data.parentReference?.driveId,
          name: data.name,
          webUrl: data.webUrl,
          mimeType: data.file?.mimeType,
        }, null, 2)
      }]
    };
  },

  /**
   * Copy a OneDrive file. Graph copy is async (202 + monitor URL).
   * Polls until complete, returns the new item metadata.
   */
  async _driveCopy(sourceItemId, newName) {
    const url = `${GRAPH}/me/drive/items/${sourceItemId}/copy`;
    const response = await runtime.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newName,
        parentReference: { path: "/drive/root:/" },
      }),
    });

    // 202 Accepted — async operation
    if (response.status === 202) {
      const monitorUrl = response.headers.get("Location");
      if (!monitorUrl) {
        return { _error: true, content: [{ type: "text", text: "Copy started but no monitor URL returned" }], isError: true };
      }
      // Poll for completion (max ~30s)
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const poll = await runtime.fetch(monitorUrl, { skipAuth: true });
        if (poll.status === 200 || poll.status === 303) {
          const result = await poll.json();
          if (result.status === "completed" && result.resourceId) {
            // Fetch the new item metadata
            const item = await this._get(`/me/drive/items/${result.resourceId}`);
            if (item._error) return item;
            return item;
          } else if (result.status === "failed") {
            return { _error: true, content: [{ type: "text", text: `Copy failed: ${JSON.stringify(result.error || result)}` }], isError: true };
          }
          // Still in progress, continue polling
        }
      }
      return { _error: true, content: [{ type: "text", text: "Copy timed out after 30 seconds" }], isError: true };
    }

    if (!response.ok) {
      const error = await response.text();
      return { _error: true, content: [{ type: "text", text: `Copy API Error (${response.status}): ${error}` }], isError: true };
    }
    return await response.json();
  },


  // ═══════════════════════════════════════════════════════════════
  // Excel Online
  // ═══════════════════════════════════════════════════════════════

  async excelList({ maxResults }) {
    const limit = Math.min(maxResults || 10, 100);
    const data = await this._get(`/me/drive/root/search(q='.xlsx')`, { '$top': limit });
    if (data._error) return data;

    const files = (data.value || []).filter(f =>
      f.file?.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ).map(f => ({
      id: f.id,
      name: f.name,
      lastModified: f.lastModifiedDateTime,
      webUrl: f.webUrl,
    }));
    return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
  },

  async excelCreate({ title, copyFromId }) {
    if (copyFromId) {
      const data = await this._driveCopy(copyFromId, `${title}.xlsx`);
      if (data._error) return data;
      return {
        content: [{
          type: "text",
          text: `Copied workbook: ${data.id}\nURL: ${data.webUrl}`,
          _createdFileId: data.id,
        }],
      };
    }

    const filename = encodeURIComponent(`${title}.xlsx`);
    // Upload a real, minimal workbook. The old comment claimed Graph would
    // turn an empty body into a valid xlsx; it does not — it stores a 0-byte
    // file, which then has no worksheets for excel_write_range to address.
    const data = await this._request("PUT",
      `/me/drive/root:/${filename}:/content`,
      b64ToBytes(BLANK_XLSX_B64),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    if (data._error) return data;

    return {
      content: [{
        type: "text",
        text: `Created workbook: ${data.id}\nURL: ${data.webUrl}`,
        _createdFileId: data.id,
      }],
    };
  },

  async excelGetMetadata({ itemId, driveId }) {
    const basePath = driveId ? `/drives/${driveId}/items/${itemId}` : `/me/drive/items/${itemId}`;
    const data = await this._get(`${basePath}/workbook/worksheets`);
    if (data._error) return data;

    const meta = await this._get(basePath, { '$select': 'id,name,webUrl' });

    return { content: [{ type: "text", text: JSON.stringify({
      itemId,
      name: meta.name,
      webUrl: meta.webUrl,
      worksheets: (data.value || []).map(ws => ({
        id: ws.id,
        name: ws.name,
        position: ws.position,
        visibility: ws.visibility,
      })),
    }, null, 2) }] };
  },

  async excelReadRange({ itemId, driveId, worksheet, range, offset, limit }) {
    const basePath = driveId ? `/drives/${driveId}/items/${itemId}` : `/me/drive/items/${itemId}`;
    let resolvedWorksheet = worksheet;

    // Normalize worksheet name — LLMs sometimes corrupt trailing spaces or
    // inject garbled Unicode characters. Try exact match first, fall back to
    // trimmed / stripped match against actual worksheet names.
    if (worksheet) {
      const trimmed = worksheet.trim();
      const wsListData = await this._get(`${basePath}/workbook/worksheets`);
      if (!wsListData._error && wsListData.value) {
        const names = wsListData.value.map(ws => ws.name);
        // Exact match first
        if (!names.includes(worksheet)) {
          // Try trimmed match
          const match = names.find(n => n.trim() === trimmed);
          if (match) {
            resolvedWorksheet = match;
          } else {
            // Try stripping all non-ASCII from both sides for garbled chars
            const stripped = worksheet.replace(/[^\x20-\x7E]/g, '').trim();
            const fuzzyMatch = names.find(n => n.replace(/[^\x20-\x7E]/g, '').trim() === stripped);
            if (fuzzyMatch) {
              resolvedWorksheet = fuzzyMatch;
            }
          }
        }
      }
    }

    const wsPath = resolvedWorksheet ? `/worksheets/${encodeURIComponent(resolvedWorksheet)}` : `/worksheets/Sheet1`;
    const path = `${basePath}/workbook${wsPath}/range(address='${encodeURIComponent(range)}')`;
    const data = await this._get(path);
    if (data._error) return data;

    let rows = data.values || [];
    const totalRows = rows.length;
    if (offset != null && offset > 0) rows = rows.slice(offset);
    if (limit != null && limit > 0) rows = rows.slice(0, limit);

    return { content: [{ type: "text", text: JSON.stringify({
      values: rows,
      totalRows,
      returnedRows: rows.length,
      address: data.address,
    }, null, 2) }] };
  },

  async excelReadAsCsv({ itemId, worksheet, range, offset, limit }) {
    const result = await this.excelReadRange({ itemId, worksheet, range, offset, limit });
    if (result.isError) return result;

    const parsed = JSON.parse(result.content[0].text);
    const csv = (parsed.values || []).map(row =>
      row.map(cell => {
        const s = String(cell ?? "");
        return s.includes(",") || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(",")
    ).join("\n");

    return { content: [{ type: "text", text: csv }] };
  },

  // Worksheet names arrive corrupted often enough (trailing spaces, garbled
  // Unicode from a model) that every worksheet-addressed call needs the same
  // normalization. This used to exist only inline inside excelReadRange, while
  // excelWriteRange and excelClearRange called a `this._resolveWorksheet` that
  // was never defined — so both threw "this._resolveWorksheet is not a
  // function" on every invocation, before reaching Graph.
  async _resolveWorksheet(itemId, worksheet, driveId) {
    if (!worksheet) return null;

    const basePath = driveId ? `/drives/${driveId}/items/${itemId}` : `/me/drive/items/${itemId}`;
    const wsListData = await this._get(`${basePath}/workbook/worksheets`);
    if (wsListData._error || !wsListData.value) return worksheet;

    const names = wsListData.value.map(ws => ws.name);
    if (names.includes(worksheet)) return worksheet;

    const trimmed = worksheet.trim();
    const match = names.find(n => n.trim() === trimmed);
    if (match) return match;

    const strip = v => v.replace(/[^\x20-\x7E]/g, "").trim();
    const fuzzy = names.find(n => strip(n) === strip(worksheet));
    return fuzzy || worksheet;
  },

  async excelWriteRange({ itemId, driveId, worksheet, range, values }) {
    const resolved = await this._resolveWorksheet(itemId, worksheet, driveId);
    const basePath = driveId ? `/drives/${driveId}/items/${itemId}` : `/me/drive/items/${itemId}`;
    const wsPath = resolved ? `/worksheets/${encodeURIComponent(resolved)}` : `/worksheets/Sheet1`;
    const path = `${basePath}/workbook${wsPath}/range(address='${encodeURIComponent(range)}')`;
    const data = await this._request("PATCH", path, { values });
    if (data._error) return data;
    return { content: [{ type: "text", text: `Updated range: ${data.address}` }] };
  },

  async excelBatchUpdate({ itemId, requests }) {
    // Use Graph $batch endpoint
    const batchRequests = requests.map((req, i) => ({
      id: String(i + 1),
      method: req.method || "POST",
      url: `/me/drive/items/${itemId}/workbook${req.url}`,
      body: req.body,
      headers: { "Content-Type": "application/json" },
    }));

    const data = await this._request("POST", "/$batch", { requests: batchRequests });
    if (data._error) return data;
    return { content: [{ type: "text", text: JSON.stringify(data.responses || data, null, 2) }] };
  },

  async excelClearRange({ itemId, driveId, worksheet, range }) {
    const resolved = await this._resolveWorksheet(itemId, worksheet, driveId);
    const basePath = driveId ? `/drives/${driveId}/items/${itemId}` : `/me/drive/items/${itemId}`;
    const wsPath = resolved ? `/worksheets/${encodeURIComponent(resolved)}` : `/worksheets/Sheet1`;
    const path = `${basePath}/workbook${wsPath}/range(address='${encodeURIComponent(range)}')/clear`;
    const data = await this._request("POST", path, { applyTo: "Contents" });
    if (data._error) return data;
    return { content: [{ type: "text", text: `Cleared range: ${range}` }] };
  },

  // ═══════════════════════════════════════════════════════════════
  // Word Online
  // ═══════════════════════════════════════════════════════════════

  async wordCreate({ title, copyFromId }) {
    if (copyFromId) {
      const data = await this._driveCopy(copyFromId, `${title}.docx`);
      if (data._error) return data;
      return {
        content: [{
          type: "text",
          text: `Copied document: ${data.id}\nURL: ${data.webUrl}`,
          _createdFileId: data.id,
        }],
      };
    }

    const filename = encodeURIComponent(`${title}.docx`);
    const data = await this._request("PUT",
      `/me/drive/root:/${filename}:/content`,
      b64ToBytes(BLANK_DOCX_B64),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    if (data._error) return data;
    return {
      content: [{
        type: "text",
        text: `Created document: ${data.id}\nURL: ${data.webUrl}`,
        _createdFileId: data.id,
      }],
    };
  },

  async wordGetMetadata({ itemId, driveId }) {
    const basePath = driveId ? `/drives/${driveId}/items/${itemId}` : `/me/drive/items/${itemId}`;
    const data = await this._get(basePath, {
      '$select': 'id,name,size,webUrl,createdDateTime,lastModifiedDateTime,createdBy,lastModifiedBy'
    });
    if (data._error) return data;
    return { content: [{ type: "text", text: JSON.stringify({
      id: data.id,
      name: data.name,
      size: data.size,
      webUrl: data.webUrl,
      created: data.createdDateTime,
      lastModified: data.lastModifiedDateTime,
    }, null, 2) }] };
  },

  async wordReadContent({ itemId, driveId, startIndex, endIndex }) {
    // Step 1: Get the pre-authenticated download URL from item metadata.
    // The /content endpoint returns a 302 redirect which can cause issues
    // with binary data in the sandbox fetch (CORS, auth headers on redirect,
    // and text-mode decoding corrupting binary). Using @microsoft.graph.downloadUrl
    // avoids all these problems — it's a direct, pre-authenticated binary URL.
    // NOTE: Do NOT use $select here — @microsoft.graph.downloadUrl is an OData
    // annotation that gets stripped when $select is present.
    const basePath = driveId ? `/drives/${driveId}/items/${itemId}` : `/me/drive/items/${itemId}`;
    const meta = await this._get(basePath);
    if (meta._error) return meta;

    const downloadUrl = meta['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) {
      return { content: [{ type: "text", text: `No download URL available for item ${itemId}` }], isError: true };
    }

    // Step 2: Fetch the raw .docx binary from the pre-authenticated URL.
    // skipAuth: true because the URL is already authenticated.
    // responseFormat: "base64" to ensure binary-safe transport through the sandbox.
    const response = await runtime.fetch(downloadUrl, { skipAuth: true, responseFormat: "base64" });
    if (!response.ok) {
      return { content: [{ type: "text", text: `Error reading document: ${response.status}` }], isError: true };
    }

    const arrayBuffer = await response.arrayBuffer();

    // Use mammoth.js for proper docx parsing
    let text;
    try {
      const mam = await ensureMammoth();
      const result = await mam.extractRawText({ arrayBuffer });
      text = result.value || "";
    } catch (e) {
      return { content: [{ type: "text", text: `Error parsing docx: ${e.message}` }], isError: true };
    }

    const totalLength = text.length;
    if (startIndex != null) text = text.slice(startIndex);
    if (endIndex != null) text = text.slice(0, endIndex - (startIndex || 0));

    return { content: [{ type: "text", text: JSON.stringify({ text, totalLength, returnedLength: text.length }, null, 2) }] };
  },

  // ── Helper: download raw docx bytes ──
  // ═══════════════════════════════════════════════════════════════
  // VISUAL RENDERING
  // ═══════════════════════════════════════════════════════════════

  // Graph converts docx/xlsx/pptx to PDF server-side via ?format=pdf. The
  // endpoint answers 302 to a pre-authenticated download host
  // (*.sharepoint.com / *.files.1drv.com / *.microsoftpersonalcontent.com),
  // all of which are already in the skill's allowed_domains.
  async _downloadPdfBytes(itemId, driveId) {
    const cacheKey = `${driveId || "me"}:${itemId}`;
    const cached = PDF_EXPORT_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.at < PDF_EXPORT_TTL_MS) return cached.bytes;

    const basePath = driveId ? `/drives/${driveId}/items/${itemId}` : `/me/drive/items/${itemId}`;
    const response = await runtime.fetch(`${GRAPH}${basePath}/content?format=pdf`, { responseFormat: "base64" });
    if (!response.ok) {
      const error = await response.text().catch(() => "");
      // The format hint is only meaningful for a conversion rejection. Pinning
      // it to a 404 sent readers looking at file types when the item simply
      // did not exist.
      const hint = response.status === 404
        ? ""
        : " Graph converts Office formats only — an unsupported type will fail here.";
      throw new Error(`PDF conversion failed (${response.status}): ${error.slice(0, 200)}.${hint}`);
    }

    const bytes = await readPdfBytes(response);
    PDF_EXPORT_CACHE.set(cacheKey, { bytes, at: Date.now() });
    return bytes;
  },

  async onedriveRenderPage({ itemId, driveId, page, resolution, region }) {
    const bytes = await this._downloadPdfBytes(itemId, driveId);
    const r = await renderPdfPage(bytes, page || 1, { resolution, region });

    return {
      content: [
        { type: "text", text: JSON.stringify({
          itemId,
          driveId: driveId || null,
          page: r.page,
          totalPages: r.totalPages,
          prevPage: r.page > 1 ? r.page - 1 : null,
          nextPage: r.page < r.totalPages ? r.page + 1 : null,
          render: { width: r.width, height: r.height, scale: r.scale, resolution: r.resolution, bytes: r.bytes, region: normalizeRegion(region) },
        }, null, 2) },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: r.base64 } },
      ],
    };
  },

  async _downloadDocxBytes(itemId, driveId) {
    const basePath = driveId ? `/drives/${driveId}/items/${itemId}` : `/me/drive/items/${itemId}`;
    const meta = await this._get(basePath);
    if (meta._error) return meta;
    const downloadUrl = meta['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) {
      return { _error: true, content: [{ type: "text", text: `No download URL for ${itemId}` }], isError: true };
    }
    const response = await runtime.fetch(downloadUrl, { skipAuth: true, responseFormat: "base64" });
    if (!response.ok) {
      return { _error: true, content: [{ type: "text", text: `Download failed: ${response.status}` }], isError: true };
    }

    // Try arrayBuffer first; if the sandbox returns base64 text, decode manually
    const raw = await response.arrayBuffer();
    const probe = new Uint8Array(raw);
    runtime.console.log(`[_downloadDocxBytes] raw type=${typeof raw}, byteLength=${raw.byteLength}, first4=[${probe[0]},${probe[1]},${probe[2]},${probe[3]}]`);

    // Valid ZIP starts with PK\x03\x04 = [80,75,3,4]
    if (probe.length > 4 && probe[0] === 0x50 && probe[1] === 0x4B) {
      return raw; // Already proper binary
    }

    // Likely got base64-encoded text as raw bytes — decode it
    runtime.console.log(`[_downloadDocxBytes] Not a ZIP — attempting base64 decode`);
    const base64Str = new TextDecoder().decode(probe);
    const binaryStr = atob(base64Str);
    const decoded = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) decoded[i] = binaryStr.charCodeAt(i);
    runtime.console.log(`[_downloadDocxBytes] After b64 decode: ${decoded.length} bytes, first4=[${decoded[0]},${decoded[1]},${decoded[2]},${decoded[3]}]`);
    return decoded.buffer;
  },

  async wordGetImages({ itemId, driveId }) {
    const result = await this._downloadDocxBytes(itemId, driveId);
    if (result._error) return result;
    const bytes = new Uint8Array(result);
    runtime.console.log(`[wordGetImages] ${bytes.length} bytes, first4=[${bytes[0]},${bytes[1]},${bytes[2]},${bytes[3]}]`);

    // Scan ZIP local file headers for word/media/* entries.
    // Only reads filenames and sizes from headers — no decompression needed.
    const images = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    for (let i = 0; i < bytes.length - 4; i++) {
      if (bytes[i] === 0x50 && bytes[i+1] === 0x4B && bytes[i+2] === 0x03 && bytes[i+3] === 0x04) {
        const nameLen = view.getUint16(i + 26, true);
        const name = new TextDecoder().decode(bytes.slice(i + 30, i + 30 + nameLen));
        runtime.console.log(`[wordGetImages] ZIP entry: ${name}`);
        if (name.startsWith("word/media/") || name.startsWith("media/")) {
          const uncompSize = view.getUint32(i + 22, true);
          // `allowedImageNames` used to be referenced here. It is declared
          // `let` inside pptGetImages and never at module scope, so reading it
          // threw ReferenceError on the first word/media entry found — meaning
          // word_get_images failed on every Word document that has an image.
          // wordGetImages has no slide range to filter by; there is nothing to
          // narrow the list to, so the filter simply does not belong here.
          images.push({
            index: images.length,
            name,
            contentType: mimeForImageName(name),
            sizeBytes: uncompSize || 0,
          });
        }
      }
    }

    return { content: [{ type: "text", text: JSON.stringify({ imageCount: images.length, images }, null, 2) }] };
  },

  async wordDownloadImage({ itemId, driveId, imageName, resolution }) {
    // Validate the tier before downloading the whole container, and surface it
    // as a tool error rather than an uncaught throw from resolveMaxDim.
    try {
      resolveMaxDim(resolution || "medium");
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
    const result = await this._downloadDocxBytes(itemId, driveId);
    if (result._error) return result;
    const bytes = new Uint8Array(result);

    // If imageName is a bare number, resolve it to a word/media/ path
    let targetName = imageName;
    if (/^\d+$/.test(imageName)) {
      // Scan for the Nth image entry
      let idx = 0;
      const targetIdx = parseInt(imageName, 10);
      for (const entry of await this._readZipEntries(bytes)) {
        if (entry.name.startsWith("word/media/") || entry.name.startsWith("media/")) {
          if (idx === targetIdx) { targetName = entry.name; break; }
          idx++;
        }
      }
    }

    // Extract the specific entry
    const entries = await this._readZipEntries(bytes);
    const entry = entries.find(e => e.name === targetName);
    if (!entry) {
      return { content: [{ type: "text", text: `Image '${targetName}' not found in document` }], isError: true };
    }

    const { blocks, ok } = await this._imageBlocksFor(entry, targetName, resolution);
    return ok ? { content: blocks } : { content: blocks, isError: true };
  },

  async wordBatchUpdate({ itemId, htmlContent }) {
    // Convert HTML to a simple docx content upload
    // Note: This REPLACES the entire document content
    const data = await this._request("PUT",
      `/me/drive/items/${itemId}/content`,
      htmlContent,
      "text/html"
    );
    if (data._error) return data;
    return { content: [{ type: "text", text: `Document updated: ${data.id}` }] };
  },

  // ═══════════════════════════════════════════════════════════════
  // PowerPoint Online
  // ═══════════════════════════════════════════════════════════════

  async pptCreate({ title, copyFromId }) {
    if (copyFromId) {
      const data = await this._driveCopy(copyFromId, `${title}.pptx`);
      if (data._error) return data;
      return {
        content: [{
          type: "text",
          text: `Copied presentation: ${data.id}\nURL: ${data.webUrl}`,
          _createdFileId: data.id,
        }],
      };
    }

    const filename = encodeURIComponent(`${title}.pptx`);
    const data = await this._request("PUT",
      `/me/drive/root:/${filename}:/content`,
      "",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    if (data._error) return data;
    return {
      content: [{
        type: "text",
        text: `Created presentation: ${data.id}\nURL: ${data.webUrl}`,
        _createdFileId: data.id,
      }],
    };
  },

  async pptGetMetadata({ itemId, driveId }) {
    const basePath = driveId ? `/drives/${driveId}/items/${itemId}` : `/me/drive/items/${itemId}`;
    const data = await this._get(basePath, {
      '$select': 'id,name,size,webUrl,createdDateTime,lastModifiedDateTime'
    });
    if (data._error) return data;

    // Also extract per-slide metadata from the .pptx ZIP
    let slideMeta = [];
    try {
      const dlMeta = await this._get(basePath);
      const downloadUrl = dlMeta['@microsoft.graph.downloadUrl'];
      if (downloadUrl) {
        const response = await runtime.fetch(downloadUrl, { skipAuth: true, responseFormat: "base64" });
        if (response.ok) {
          const buf = await response.arrayBuffer();
          const bytes = new Uint8Array(buf);
          if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4B) {
            const entries = await this._readZipEntries(bytes);
            const slideEntries = entries.filter(e => /^ppt\/slides\/slide\d+\.xml$/i.test(e.name))
              .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
            slideMeta = slideEntries.map((e, i) => {
              const xml = new TextDecoder().decode(e.data);
              // Extract title from first <a:ph type="title"> or <a:ph type="ctrTitle"> text
              const titleMatch = xml.match(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<a:ph[^>]*type="(?:title|ctrTitle)"[\s\S]*?<a:t>([^<]+)<\/a:t>/i);
              return {
                slideIndex: i + 1,
                name: e.name,
                title: titleMatch ? titleMatch[1].trim() : null,
              };
            });
          }
        }
      }
    } catch (e) {
      runtime.console.log(`[pptGetMetadata] Slide metadata extraction failed: ${e.message}`);
    }

    return { content: [{ type: "text", text: JSON.stringify({
      ...data,
      slideCount: slideMeta.length || null,
      slides: slideMeta.length ? slideMeta : undefined,
    }, null, 2) }] };
  },

  async pptReadContent({ itemId, driveId, startSlide, endSlide }) {
    // Get the pre-authenticated download URL (same approach as wordReadContent).
    // Do NOT use $select — @microsoft.graph.downloadUrl is an OData annotation.
    const basePath = driveId ? `/drives/${driveId}/items/${itemId}` : `/me/drive/items/${itemId}`;
    const meta = await this._get(basePath);
    if (meta._error) return meta;

    const downloadUrl = meta['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) {
      // Fallback: get preview URL
      const preview = await this._request("POST", `${basePath}/preview`, {});
      if (preview._error) return preview;
      return { content: [{ type: "text", text: JSON.stringify({
        note: "PowerPoint download URL not available. Use preview URL to view.",
        previewUrl: preview.getUrl,
      }, null, 2) }] };
    }

    // Fetch raw .pptx binary
    const response = await runtime.fetch(downloadUrl, { skipAuth: true, responseFormat: "base64" });
    if (!response.ok) {
      return { content: [{ type: "text", text: `Error downloading presentation: ${response.status}` }], isError: true };
    }

    const buf = await response.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let text = "";

    // Check for ZIP magic number (PK\x03\x04)
    if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4B) {
      const entries = await this._readZipEntries(bytes);
      const slideEntries = entries.filter(e => /^ppt\/slides\/slide\d+\.xml$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const totalSlides = slideEntries.length;
      const start = (startSlide || 1) - 1;
      const end = endSlide || totalSlides;
      const slicedEntries = slideEntries.slice(start, end);

      // Build slide-to-image map from .rels files
      const slideImageMap = {}; // slideIndex -> [{name, sizeBytes, contentType}]
      const imageSizeMap = {}; // imageName -> sizeBytes (from ZIP headers)

      // Pre-scan ZIP for image sizes
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let zi = 0; zi < bytes.length - 4; zi++) {
        if (bytes[zi] === 0x50 && bytes[zi+1] === 0x4B && bytes[zi+2] === 0x03 && bytes[zi+3] === 0x04) {
          const nameLen = dv.getUint16(zi + 26, true);
          const name = new TextDecoder().decode(bytes.slice(zi + 30, zi + 30 + nameLen));
          if (name.startsWith("ppt/media/") || name.startsWith("media/")) {
            imageSizeMap[name] = dv.getUint32(zi + 22, true);
          }
        }
      }

      for (let si = 0; si < slicedEntries.length; si++) {
        const se = slicedEntries[si];
        const slideNum = start + si + 1;
        const relsName = se.name.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
        const relsEntry = entries.find(e => e.name === relsName);
        if (relsEntry) {
          const relsXml = new TextDecoder().decode(relsEntry.data);
          const rels = [...relsXml.matchAll(/<Relationship[^>]+Target="([^"]+)"[^>]*>/g)];
          for (const m of rels) {
            let t = m[1];
            if (!t.includes('/media/') && !t.startsWith('media/')) continue;
            if (t.startsWith('../media/')) t = 'ppt/media/' + t.substring(9);
            else if (t.startsWith('/ppt/media/')) t = t.substring(1);
            else if (t.startsWith('media/')) t = 'ppt/' + t;
            if (!slideImageMap[slideNum]) slideImageMap[slideNum] = [];
            slideImageMap[slideNum].push({ name: t, sizeBytes: imageSizeMap[t] || 0, contentType: mimeForImageName(t) });
          }
        }
      }

      const slides = slicedEntries.map((e, i) => {
        const xml = new TextDecoder().decode(e.data);
        const t = xml.replace(/<a:p[^>]*>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        const slideNum = start + i + 1;
        let result = t ? `[Slide ${slideNum}] ${t}` : `[Slide ${slideNum}] (no text)`;
        const imgs = slideImageMap[slideNum];
        if (imgs && imgs.length > 0) {
          const imgList = imgs.map(im => `${im.name} (${Math.round(im.sizeBytes/1024)}KB, ${im.contentType})`).join(', ');
          result += `\n[Slide ${slideNum} Images: ${imgList}]`;
        }
        return result;
      }).filter(Boolean);
      text = slides.join('\n');
      // Prepend pagination info
      if (startSlide || endSlide) {
        text = `[Slides ${start + 1}-${Math.min(end, totalSlides)} of ${totalSlides}]\n${text}`;
      }
    } else {
      const html = new TextDecoder().decode(bytes);
      text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return { content: [{ type: "text", text: text || "(Empty presentation)" }] };
  },

  async pptGetImages({ itemId, driveId, startSlide, endSlide }) {
    const result = await this._downloadDocxBytes(itemId, driveId);
    if (result._error) return result;
    const bytes = new Uint8Array(result);

    // Scan ZIP local file headers for ppt/media/* entries.
    // PPTX stores images in ppt/media/ (parallel to word/media/ in DOCX).
    // Word Online / personal OneDrive may also use bare media/ path.

    // If slide range is specified, find which images are referenced by those slides
    let allowedImageNames = null;
    if (startSlide || endSlide) {
      try {
        const entries = await this._readZipEntries(bytes);
        const slideEntries = entries.filter(e => /^ppt\/slides\/slide\d+\.xml$/i.test(e.name))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        const start = (startSlide || 1) - 1;
        const end = endSlide || slideEntries.length;
        const slicedSlides = slideEntries.slice(start, end);
        allowedImageNames = new Set();

        for (const se of slicedSlides) {
          // Read the slide's .rels file to find image relationships
          // e.g., ppt/slides/slide6.xml -> ppt/slides/_rels/slide6.xml.rels
          const relsName = se.name.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
          const relsEntry = entries.find(e => e.name === relsName);
          if (relsEntry) {
            const relsXml = new TextDecoder().decode(relsEntry.data);
            // Only pick up relationships whose Target points to media files
            const rels = [...relsXml.matchAll(/<Relationship[^>]+Target="([^"]+)"[^>]*>/g)];
            for (const m of rels) {
              let t = m[1];
              // Only include media file references (skip slideLayout, notesSlide, etc.)
              if (!t.includes('/media/') && !t.startsWith('media/')) continue;
              // Normalize path to match ZIP entry names
              if (t.startsWith('../media/')) t = 'ppt/media/' + t.substring(9);
              else if (t.startsWith('/ppt/media/')) t = t.substring(1);
              else if (t.startsWith('media/')) t = 'ppt/' + t;
              allowedImageNames.add(t);
            }
          }
        }
      } catch (e) {
        runtime.console.log(`[pptGetImages] Slide range filtering failed, returning all: ${e.message}`);
        allowedImageNames = null;
      }
    }

    const images = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    for (let i = 0; i < bytes.length - 4; i++) {
      if (bytes[i] === 0x50 && bytes[i+1] === 0x4B && bytes[i+2] === 0x03 && bytes[i+3] === 0x04) {
        const nameLen = view.getUint16(i + 26, true);
        const name = new TextDecoder().decode(bytes.slice(i + 30, i + 30 + nameLen));
        if (name.startsWith("ppt/media/") || name.startsWith("media/")) {
          const normalizedName = name.startsWith("media/") ? "ppt/" + name : name;
          if (allowedImageNames && !allowedImageNames.has(normalizedName)) continue;
          const uncompSize = view.getUint32(i + 22, true);
          images.push({
            index: images.length,
            name,
            contentType: mimeForImageName(name),
            sizeBytes: uncompSize || 0,
          });
        }
      }
    }

    return { content: [{ type: "text", text: JSON.stringify({ imageCount: images.length, images }, null, 2) }] };
  },

  async pptDownloadImage({ itemId, driveId, imageName, resolution }) {
    // Validate the tier before downloading the whole container, and surface it
    // as a tool error rather than an uncaught throw from resolveMaxDim.
    try {
      resolveMaxDim(resolution || "medium");
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
    // Support comma-separated image names for batch download
    const names = imageName.includes(',') ? imageName.split(',').map(n => n.trim()).filter(Boolean) : [imageName];
    // Each image costs up to MAX_BASE64_LENGTH. An uncapped list multiplies
    // that by however many names the caller happened to paste in.
    if (names.length > MAX_IMAGES_PER_CALL) {
      return {
        content: [{
          type: "text",
          text: `Too many images in one call (${names.length}). Each image costs up to ` +
            `${Math.round(MAX_BASE64_LENGTH / 1024)}KB of base64, so at most ${MAX_IMAGES_PER_CALL} ` +
            `may be requested at a time. Split the list across several calls.`,
        }],
        isError: true,
      };
    }
    if (names.length > 1) {
      return await this._pptDownloadMultipleImages(itemId, driveId, names, resolution);
    }
    return await this._pptDownloadSingleImage(itemId, driveId, imageName, resolution);
  },

  async _pptDownloadMultipleImages(itemId, driveId, names, resolution) {
    const result = await this._downloadDocxBytes(itemId, driveId);
    if (result._error) return result;
    const bytes = new Uint8Array(result);
    const entries = await this._readZipEntries(bytes);
    const contentBlocks = [];
    for (const name of names) {
      let targetName = name;
      if (/^\d+$/.test(name)) {
        let idx = 0;
        const targetIdx = parseInt(name, 10);
        for (const entry of entries) {
          if (entry.name.startsWith("ppt/media/") || entry.name.startsWith("media/")) {
            if (idx === targetIdx) { targetName = entry.name; break; }
            idx++;
          }
        }
      }
      const entry = entries.find(e => e.name === targetName);
      if (!entry) {
        contentBlocks.push({ type: "text", text: `Image '${targetName}' not found` });
        continue;
      }
      const { blocks } = await this._imageBlocksFor(entry, targetName, resolution);
      for (const block of blocks) contentBlocks.push(block);
    }
    return { content: contentBlocks };
  },

  async _pptDownloadSingleImage(itemId, driveId, imageName, resolution) {
    const result = await this._downloadDocxBytes(itemId, driveId);
    if (result._error) return result;
    const bytes = new Uint8Array(result);

    // If imageName is a bare number, resolve it to the Nth image entry
    let targetName = imageName;
    if (/^\d+$/.test(imageName)) {
      let idx = 0;
      const targetIdx = parseInt(imageName, 10);
      for (const entry of await this._readZipEntries(bytes)) {
        if (entry.name.startsWith("ppt/media/") || entry.name.startsWith("media/")) {
          if (idx === targetIdx) { targetName = entry.name; break; }
          idx++;
        }
      }
    }

    const entries = await this._readZipEntries(bytes);
    const entry = entries.find(e => e.name === targetName);
    if (!entry) {
      return { content: [{ type: "text", text: `Image '${targetName}' not found in presentation` }], isError: true };
    }

    const { blocks, ok } = await this._imageBlocksFor(entry, targetName, resolution);
    return ok ? { content: blocks } : { content: blocks, isError: true };
  },

  async pptBatchUpdate({ itemId, base64Content }) {
    // Upload replacement content
    const raw = atob(base64Content);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    const response = await runtime.fetch(
      `${GRAPH}/me/drive/items/${itemId}/content`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
        body: bytes,
        responseFormat: "base64",
      }
    );
    if (!response.ok) {
      return { content: [{ type: "text", text: `Upload error: ${response.status}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Presentation updated` }] };
  },

  // ═══════════════════════════════════════════════════════════════
  // Outlook Mail
  // ═══════════════════════════════════════════════════════════════

  async outlookSearch({ query, maxResults, skipToken }) {
    const limit = Math.min(maxResults || 10, 100);
    // Strip surrounding quotes — Graph $search wraps in quotes automatically
    const cleanQuery = query.replace(/^["']|["']$/g, '');
    const params = {
      '$search': `"${cleanQuery}"`,
      '$top': limit,
      '$select': 'id,subject,from,receivedDateTime,bodyPreview,conversationId,hasAttachments,webLink',
    };
    if (skipToken) params['$skiptoken'] = skipToken;

    const data = await this._get(`/me/messages`, params);
    if (data._error) return data;

    const messages = (data.value || []).map(m => ({
      id: m.id,
      subject: m.subject,
      from: m.from?.emailAddress,
      receivedDateTime: m.receivedDateTime,
      preview: m.bodyPreview,
      conversationId: m.conversationId,
      hasAttachments: m.hasAttachments,
      webLink: m.webLink,
    }));

    return { content: [{ type: "text", text: JSON.stringify({
      messages,
      nextLink: data['@odata.nextLink'] || null,
    }, null, 2) }] };
  },

  async outlookGetMessage({ messageId }) {
    const data = await this._get(`/me/messages/${messageId}`, {
      '$select': 'id,subject,from,toRecipients,receivedDateTime,body,attachments,conversationId,webLink',
      '$expand': 'attachments($select=id,name,contentType,size,isInline)',
    });
    if (data._error) return data;

    // Extract text from HTML body
    let bodyText = data.body?.content || "";
    if (data.body?.contentType === "html") {
      // Preserve href URLs: convert <a href="URL">text</a> to "text ( URL )" before stripping tags
      bodyText = bodyText.replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '$2 ( $1 )');
      bodyText = bodyText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    return { content: [{ type: "text", text: JSON.stringify({
      id: data.id,
      subject: data.subject,
      from: data.from?.emailAddress,
      to: (data.toRecipients || []).map(r => r.emailAddress),
      receivedDateTime: data.receivedDateTime,
      body: bodyText,
      attachments: (data.attachments || []).map(a => ({
        id: a.id,
        name: a.name,
        contentType: a.contentType,
        size: a.size,
        isInline: a.isInline || false,
      })),
      conversationId: data.conversationId,
      webLink: data.webLink,
    }, null, 2) }] };
  },

  async outlookListFolders() {
    const data = await this._get(`/me/mailFolders`, {
      '$select': 'id,displayName,totalItemCount,unreadItemCount',
      '$top': 50,
    });
    if (data._error) return data;
    return { content: [{ type: "text", text: JSON.stringify(data.value || [], null, 2) }] };
  },

  async outlookGetThread({ conversationId }) {
    const data = await this._get(`/me/messages`, {
      '$filter': `conversationId eq '${conversationId}'`,
      '$select': 'id,subject,from,receivedDateTime,bodyPreview',
      '$orderby': 'receivedDateTime asc',
      '$top': 50,
    });
    if (data._error) return data;

    return { content: [{ type: "text", text: JSON.stringify({
      conversationId,
      messages: (data.value || []).map(m => ({
        id: m.id,
        subject: m.subject,
        from: m.from?.emailAddress,
        receivedDateTime: m.receivedDateTime,
        preview: m.bodyPreview,
      })),
    }, null, 2) }] };
  },

  async outlookGetAttachment({ messageId, attachmentId, returnRawBase64 }) {
    const data = await this._get(`/me/messages/${messageId}/attachments/${attachmentId}`);
    if (data._error) return data;

    if (returnRawBase64 !== true) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "Attachment metadata retrieved. Raw base64 omitted to prevent context overflow.",
          name: data.name,
          contentType: data.contentType,
          size: data.size,
          hint: "To process this file, write a script that calls outlook_get_attachment with returnRawBase64: true."
        }, null, 2) }]
      };
    }

    return {
      content: [
        { type: "text", text: `Attachment data retrieved (${data.size} bytes).` },
        { type: "text", text: JSON.stringify({
          base64: data.contentBytes,
          size: data.size,
          contentType: data.contentType,
          name: data.name,
        }, null, 2) }
      ]
    };
  },

  // ═══════════════════════════════════════════════════════════════
  // Calendar
  // ═══════════════════════════════════════════════════════════════

  async msCalendarList() {
    const data = await this._get(`/me/calendars`, {
      '$select': 'id,name,color,isDefaultCalendar,canEdit',
    });
    if (data._error) return data;
    return { content: [{ type: "text", text: JSON.stringify(data.value || [], null, 2) }] };
  },

  async msCalendarGetEvents({ calendarId, startDateTime, endDateTime, maxResults, skipToken, search }) {
    const limit = Math.min(maxResults || 25, 250);
    const path = calendarId
      ? `/me/calendars/${calendarId}/calendarView`
      : `/me/calendarView`;

    const params = {
      '$top': limit,
      '$select': 'id,subject,body,start,end,location,organizer,attendees,webLink,isOnlineMeeting,onlineMeetingUrl',
      '$orderby': 'start/dateTime',
    };
    if (startDateTime) params.startDateTime = startDateTime;
    if (endDateTime) params.endDateTime = endDateTime;
    if (search) params['$search'] = `"${search}"`;
    if (skipToken) params['$skiptoken'] = skipToken;

    const data = await this._get(path, params);
    if (data._error) return data;

    const events = (data.value || []).map(e => ({
      id: e.id,
      subject: e.subject,
      start: e.start,
      end: e.end,
      location: e.location?.displayName,
      organizer: e.organizer?.emailAddress,
      attendees: (e.attendees || []).map(a => ({
        email: a.emailAddress?.address,
        name: a.emailAddress?.name,
        status: a.status?.response,
      })),
      webLink: e.webLink,
      isOnlineMeeting: e.isOnlineMeeting,
      onlineMeetingUrl: e.onlineMeetingUrl,
    }));

    return { content: [{ type: "text", text: JSON.stringify({
      events,
      nextLink: data['@odata.nextLink'] || null,
    }, null, 2) }] };
  },

  async msCalendarGetEvent({ eventId }) {
    const data = await this._get(`/me/events/${eventId}`);
    if (data._error) return data;
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
};
