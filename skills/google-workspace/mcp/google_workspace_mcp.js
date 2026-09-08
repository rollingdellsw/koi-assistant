// Google Workspace MCP Server
// Provides tools for Google Drive, Sheets, Docs, Slides, Gmail, and Calendar
// All read operations include URLs pointing back to original sources
// Write operations on Docs/Slides/Sheets are guarded by guardrail.js (own-file-only policy)
// Pagination supported via offset/limit or pageToken patterns

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

const CREATE_TOOLS = new Set(["sheets_create", "docs_create", "slides_create"]);

const MUTATE_ID_ARG = {
  sheets_write_range: "spreadsheetId",
  sheets_batch_update: "spreadsheetId",
  sheets_clear_range: "spreadsheetId",
  docs_batch_update: "documentId",
  slides_batch_update: "presentationId",
};
const MUTATE_TOOLS = new Set(Object.keys(MUTATE_ID_ARG));

const AUTH_ERROR_RE = /\b(401|UNAUTHENTICATED)\b/;
const CREATED_ID_RE = /(?:Created|Copied) (?:spreadsheet|document|presentation): (\S+)/;

const REAUTH_MESSAGE =
  "\u26a0\ufe0f AUTHENTICATION REQUIRED: Your Google session has expired. Please click " +
  "'Sign in' in the side panel to re-connect your account before continuing.";

function isOwned(fileId) {
  return createdFileIds.has(fileId);
}

function recordOwned(id) {
  createdFileIds.add(id);
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
const MAGIC_JPEG = [0xFF, 0xD8, 0xFF];      // SOI + marker
const MAGIC_GIF = [0x47, 0x49, 0x46, 0x38]; // GIF8
const MAGIC_BMP = [0x42, 0x4D];             // BM
const MAGIC_RIFF = [0x52, 0x49, 0x46, 0x46]; // RIFF (WebP container)

const IMAGE_SIGNATURES = [
  { mime: "image/png", magic: MAGIC_PNG },
  { mime: "image/jpeg", magic: MAGIC_JPEG },
  { mime: "image/gif", magic: MAGIC_GIF },
  { mime: "image/bmp", magic: MAGIC_BMP },
];

function startsWithMagic(bytes, magic) {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

// Identify an image from its bytes rather than from a Content-Type header or a
// caller-supplied hint. Both lie here: the proxy reports text/plain for a
// base64-encoded body, and callers pass whatever mimeType they guessed.
function sniffImageMime(bytes) {
  for (const sig of IMAGE_SIGNATURES) {
    if (startsWithMagic(bytes, sig.magic)) return sig.mime;
  }
  if (
    bytes.length > 12 &&
    startsWithMagic(bytes, MAGIC_RIFF) &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

// The same defect readBinaryResponse() guards against, generalized over every
// image format we might be handed: runtime.fetch returns the body as *text* by
// default, so the ArrayBuffer holds ASCII base64 rather than image bytes.
// Blindly wrapping that in a Blob produces something createImageBitmap cannot
// decode and bytesToBase64 happily re-encodes, doubling an already oversized
// payload. Sniff first, decode once, and report failure rather than handing
// undecodable bytes to the model as an image.
async function readImageResponse(response) {
  const raw = new Uint8Array(await response.arrayBuffer());
  const directMime = sniffImageMime(raw);
  if (directMime) return { bytes: raw, mime: directMime };

  try {
    const text = new TextDecoder()
      .decode(raw)
      .trim()
      .replace(/^data:[^;,]*;base64,/, "");
    const decoded = atob(text);
    const out = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
    const decodedMime = sniffImageMime(out);
    if (decodedMime) return { bytes: out, mime: decodedMime };
  } catch (_) { /* not base64 text either — fall through */ }

  return { bytes: raw, mime: null };
}

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

// Encoded size without doing the encoding: 4 chars per 3 bytes, padded.
function base64LengthOf(bytes) {
  return Math.ceil(bytes.length / 3) * 4;
}

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
  listTools() {
    return [
      {
        name: "sheets_read_range",
        description: "Read a range of cells from a Google Sheet. Returns data as 2D array. Use offset/limit for pagination on large ranges.",
        displayMessage: "📊 Reading cells {{range}} from spreadsheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: {
              type: "string",
              description: "The ID of the spreadsheet (from the URL)"
            },
            range: {
              type: "string",
              description: "The A1 notation range (e.g., 'Sheet1!A1:B10')"
            },
            offset: {
              type: "number",
              description: "Row offset for pagination (0-based, skips first N rows of result). Optional."
            },
            limit: {
              type: "number",
              description: "Max number of rows to return. Optional."
            },
          },
          required: ["spreadsheetId", "range"],
        },
      },
      {
        name: "sheets_write_range",
        description: "Write data to a range in a Google Sheet. Use for creating/updating cells.",
        displayMessage: "📝 Writing to {{range}} in spreadsheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string" },
            range: { type: "string" },
            values: {
              type: "array",
              description: "2D array of values to write",
              items: { type: "array", items: { type: "string" } }
            },
          },
          required: ["spreadsheetId", "range", "values"],
        },
      },
      {
        name: "sheets_create",
        description: "Create a new Google Sheet, or copy an existing one. Returns spreadsheetId and URL. Use copyFromId to duplicate an existing spreadsheet (preserves all sheets, formulas, formatting, and data).",
        displayMessage: "📊 Creating spreadsheet \"{{title}}\"",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the new spreadsheet" },
            copyFromId: { type: "string", description: "Source spreadsheet ID to copy from. If provided, creates a full copy instead of a blank sheet." },
          },
          required: ["title"],
        },
      },
      {
        name: "sheets_list",
        description: "List recent Google Sheets from Drive. Each result includes a direct URL.",
        displayMessage: "📋 Listing recent spreadsheets",
        inputSchema: {
          type: "object",
          properties: {
            maxResults: { type: "number", description: "Max results (default 10)" },
          },
        },
      },
      {
        name: "sheets_get_metadata",
        description: "Get spreadsheet metadata: title, sheets/tabs list with IDs, row/column counts. Includes URL to each sheet tab.",
        displayMessage: "📊 Reading spreadsheet metadata",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string", description: "The spreadsheet ID" },
          },
          required: ["spreadsheetId"],
        },
      },
      {
        name: "sheets_batch_update",
        description: "Apply batch updates to a spreadsheet (add/delete/rename sheets, merge cells, format ranges, etc). Uses the spreadsheets.batchUpdate API.",
        displayMessage: "📊 Updating spreadsheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string" },
            requests: {
              type: "array",
              description: "Array of Sheets API batchUpdate request objects (e.g. addSheet, deleteSheet, mergeCells, repeatCell, updateSheetProperties, etc.)",
              items: { type: "object" }
            },
          },
          required: ["spreadsheetId", "requests"],
        },
      },
      {
        name: "sheets_clear_range",
        description: "Clear values from a range in a Google Sheet (keeps formatting).",
        displayMessage: "🧹 Clearing {{range}} in spreadsheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string" },
            range: { type: "string", description: "A1 notation range to clear" },
          },
          required: ["spreadsheetId", "range"],
        },
      },
      {
        name: "sheets_get_urls",
        description: "Extract all hyperlink URLs from a Google Sheet range. Returns URL, cell location, and link text.",
        displayMessage: "🔗 Extracting URLs from spreadsheet",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string" },
            range: { type: "string", description: "A1 notation range to scan for URLs (e.g., 'Sheet1!A1:Z100')" },
          },
          required: ["spreadsheetId", "range"],
        },
      },
      {
        name: "sheets_read_as_csv",
        description: "Read a sheet range and return as CSV text. Useful for large data exports. Supports pagination via offset/limit.",
        displayMessage: "📊 Reading {{range}} as CSV",
        inputSchema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string" },
            range: { type: "string" },
            offset: { type: "number", description: "Row offset for pagination (0-based)" },
            limit: { type: "number", description: "Max rows to return" },
          },
          required: ["spreadsheetId", "range"],
        },
      },

      // ── Google Docs (create) ─────────────────────────────────────
      {
        name: "docs_create",
        description: "Create a new Google Doc, or copy an existing one. Returns documentId and URL. Use copyFromId to duplicate an existing document (preserves all content, formatting, and images).",
        displayMessage: "📝 Creating document \"{{title}}\"",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the new document" },
            copyFromId: { type: "string", description: "Source document ID to copy from. If provided, creates a full copy instead of a blank doc." },
          },
          required: ["title"],
        },
      },
      // ── Google Drive (read-only) ─────────────────────────────────
      {
        name: "drive_list",
        description: "List files from Google Drive. Supports filtering by MIME type, folder, and query. Each result includes a webViewLink URL.",
        displayMessage: "📁 Listing Drive files{{#query}} matching \"{{query}}\"{{/query}}",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Drive search query (e.g., \"name contains 'report'\" or \"mimeType='application/vnd.google-apps.document'\"). Optional." },
            folderId: { type: "string", description: "List files in a specific folder by ID. Optional." },
            maxResults: { type: "number", description: "Max files to return (default 20, max 100)" },
            pageToken: { type: "string", description: "Token for next page of results. Optional." },
          },
        },
      },
      {
        name: "drive_search",
        description: "Full-text search across Google Drive files. Returns file name, ID, MIME type, URL, and last modified time.",
        displayMessage: "🔍 Searching Drive for \"{{searchTerm}}\"",
        inputSchema: {
          type: "object",
          properties: {
            searchTerm: { type: "string", description: "Text to search for across file names and content" },
            mimeType: { type: "string", description: "Filter by MIME type (e.g., 'application/vnd.google-apps.spreadsheet'). Optional." },
            maxResults: { type: "number", description: "Max results (default 20)" },
            pageToken: { type: "string", description: "Token for next page. Optional." },
          },
          required: ["searchTerm"],
        },
      },
      {
        name: "drive_get_file_metadata",
        description: "Get metadata for a Drive file: name, MIME type, size, owners, permissions, timestamps, URL.",
        displayMessage: "📄 Reading file metadata for {{fileId}}",
        inputSchema: {
          type: "object",
          properties: {
            fileId: { type: "string", description: "The file ID" },
          },
          required: ["fileId"],
        },
      },
      {
        name: "drive_render_page",
        description: "Render one page of a Drive file as an image. Exports Docs, Sheets, and Slides to PDF via Google's own renderer, then rasterizes the requested page. Use this when the text APIs cannot express what matters: native charts, drawings, equations, layout-carrying tables, or any question about how a page actually looks. Text APIs (docs_read_content, sheets_read_range) remain the source of truth for prose and numbers — this is for what they cannot see. Page numbers come from Google's pagination and match what the user sees on screen; the response reports totalPages so you can page through.",
        displayMessage: "🖼️ Rendering page {{page|default:1}} of Drive file",
        inputSchema: {
          type: "object",
          properties: {
            fileId: { type: "string", description: "The file ID (Doc, Sheet, Slides, or an uploaded PDF)" },
            page: { type: "number", description: "1-based page number of the exported PDF (default: 1)" },
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
          required: ["fileId"],
        },
      },

      // ── Google Docs ──────────────────────────────────────────────
      {
        name: "docs_get_metadata",
        description: "Get Google Doc metadata: title, tabs list, revision info. Includes URL to the document.",
        displayMessage: "📝 Reading document metadata",
        inputSchema: {
          type: "object",
          properties: {
            documentId: { type: "string", description: "The document ID (from URL)" },
          },
          required: ["documentId"],
        },
      },
      {
        name: "docs_read_content",
        description: "Read the text content of a Google Doc tab. Extracts text from structural elements, preserving basic structure. Supports pagination via startIndex/endIndex character offsets.",
        displayMessage: "📖 Reading document content",
        inputSchema: {
          type: "object",
          properties: {
            documentId: { type: "string" },
            tabId: { type: "string", description: "Tab ID to read (omit for first tab). Get IDs from docs_get_metadata." },
            startIndex: { type: "number", description: "Character start index for pagination. Optional." },
            endIndex: { type: "number", description: "Character end index for pagination. Optional." },
          },
          required: ["documentId"],
        },
      },
      {
        name: "docs_get_images",
        description: "Extract all inline images from a Google Doc. Returns image content URIs (which can be fetched with an OAuth token) and their positions.",
        displayMessage: "🖼️ Extracting images from document",
        inputSchema: {
          type: "object",
          properties: {
            documentId: { type: "string" },
            tabId: { type: "string", description: "Tab ID (omit for first tab). Optional." },
          },
          required: ["documentId"],
        },
      },
      {
        name: "docs_batch_update",
        description: "Apply batch updates to a Google Doc (insert text, delete content, update styles, insert tables/images, etc). Uses documents.batchUpdate API. Only works on docs created by this agent.",
        displayMessage: "📝 Updating document",
        inputSchema: {
          type: "object",
          properties: {
            documentId: { type: "string" },
            requests: {
              type: "array",
              description: "Array of Docs API batchUpdate request objects (insertText, deleteContentRange, updateTextStyle, insertTable, insertInlineImage, etc.)",
              items: { type: "object" }
            },
          },
          required: ["documentId", "requests"],
        },
      },
      {
        name: "docs_get_urls",
        description: "Extract all hyperlink URLs from a Google Doc. Returns the URL, anchor text, and position for each link.",
        displayMessage: "🔗 Extracting URLs from document",
        inputSchema: {
          type: "object",
          properties: {
            documentId: { type: "string" },
            tabId: { type: "string", description: "Tab ID (omit for first tab). Optional." },
          },
          required: ["documentId"],
        },
      },

      // ── Google Slides ────────────────────────────────────────────
      {
        name: "slides_create",
        description: "Create a new Google Slides presentation, or copy an existing one. Returns presentationId and URL. Use copyFromId to duplicate an existing presentation (preserves all slides, layouts, and media).",
        displayMessage: "📽️ Creating presentation \"{{title}}\"",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the new presentation" },
            copyFromId: { type: "string", description: "Source presentation ID to copy from. If provided, creates a full copy instead of a blank presentation." },
          },
          required: ["title"],
        },
      },
      {
        name: "slides_batch_update",
        description: "Apply batch updates to a Google Slides presentation (create slides, insert text/images, update layouts, etc). Uses presentations.batchUpdate API. Only works on presentations created by this agent.",
        displayMessage: "📽️ Updating presentation",
        inputSchema: {
          type: "object",
          properties: {
            presentationId: { type: "string" },
            requests: {
              type: "array",
              description: "Array of Slides API batchUpdate request objects (createSlide, insertText, createImage, updatePageProperties, etc.)",
              items: { type: "object" }
            },
          },
          required: ["presentationId", "requests"],
        },
      },
      {
        name: "slides_get_metadata",
        description: "Get presentation metadata: title, slide count, slide IDs, dimensions. Includes URL.",
        displayMessage: "📽️ Reading presentation metadata",
        inputSchema: {
          type: "object",
          properties: {
            presentationId: { type: "string", description: "The presentation ID (from URL)" },
          },
          required: ["presentationId"],
        },
      },
      {
        name: "slides_read_content",
        description: "Read slide content including text and image inventory. Each slide returns its text and lists any embedded images with contentUrl for downloading via gsuite_download_image. Supports pagination by slide range.",
        displayMessage: "📖 Reading slides {{startSlide|default:1}} to {{endSlide|default:end}}",
        inputSchema: {
          type: "object",
          properties: {
            presentationId: { type: "string" },
            startSlide: { type: "number", description: "1-based start slide index (default 1)" },
            endSlide: { type: "number", description: "1-based end slide index (default: last slide). Use for pagination over large decks." },
          },
          required: ["presentationId"],
        },
      },
      {
        name: "slides_get_images",
        description: "Extract all inline images from a Google Slides presentation. Returns image content URIs (which can be fetched with an OAuth token) and their positions. Supports pagination by slide range.",
        displayMessage: "🖼️ Extracting images from slides {{startSlide|default:1}} to {{endSlide|default:end}}",
        inputSchema: {
          type: "object",
          properties: {
            presentationId: { type: "string" },
            startSlide: { type: "number", description: "1-based start slide index (default 1)" },
            endSlide: { type: "number", description: "1-based end slide index (default: last slide). Use for pagination over large decks." },
          },
          required: ["presentationId"],
        },
      },
      {
        name: "slides_get_thumbnail",
        description: "Render a slide as an image using the Slides API thumbnail endpoint. Prefer this over drive_render_page for Google Slides — it is one call, needs no PDF export, and returns exactly what the slide looks like. Use it whenever a slide's meaning is carried by layout rather than text: diagrams built from shapes and arrows, charts, positioning, or anything slides_read_content returns as disconnected strings.",
        displayMessage: "🖼️ Rendering slide {{slideIndex|default:1}}",
        inputSchema: {
          type: "object",
          properties: {
            presentationId: { type: "string" },
            slideIndex: { type: "number", description: "1-based slide index (default: 1). Ignored if objectId is given." },
            objectId: { type: "string", description: "Slide objectId from slides_get_metadata. Takes precedence over slideIndex." },
            resolution: {
              type: "string",
              enum: ["low", "medium", "high", "original"],
              description: "Resolution tier, matching takeScreenshot: low=480px (default, ~1k tokens), medium=1280px, high=1920px, original=uncapped. Prefer a region crop over a higher tier — cropping spends the pixels where they matter and costs less.",
            },
            region: {
              type: "object",
              description: "Optional crop in normalized 0-1 page coordinates, origin top-left. A smaller region comes back sharper, since the pixel budget is spent on the crop. Example: bottom-left quadrant = { x: 0, y: 0.5, width: 0.5, height: 0.5 }.",
              properties: {
                x: { type: "number", description: "Left edge, 0-1 (default: 0)" },
                y: { type: "number", description: "Top edge, 0-1 (default: 0)" },
                width: { type: "number", description: "Width, 0-1 (default: to right edge)" },
                height: { type: "number", description: "Height, 0-1 (default: to bottom edge)" },
              },
              required: ["x", "y", "width", "height"],
            },
          },
          required: ["presentationId"],
        },
      },
      {
        name: "slides_get_urls",
        description: "Extract all hyperlink URLs from presentation slides. Returns URL, anchor text, and slide number.",
        displayMessage: "🔗 Extracting URLs from slides",
        inputSchema: {
          type: "object",
          properties: {
            presentationId: { type: "string" },
          },
          required: ["presentationId"],
        },
      },
      {
        name: "gsuite_download_image",
        description: "Download an image from Google Docs or Slides using its contentUri from docs_get_images or slides_read_content. Returns base64 image for visual analysis. Valid ~30 mins. Defaults to the medium resolution tier — raise it only if fine detail or small text is genuinely unreadable.",
        displayMessage: "🖼️ Downloading image",
        inputSchema: {
          type: "object",
          properties: {
            contentUri: {
              type: "string",
              description: "The temporary contentUri from docs_get_images (valid for ~30 mins)"
            },
            mimeType: {
              type: "string",
              description: "Optional mime type (default: image/png)"
            },
            resolution: {
              type: "string",
              enum: ["low", "medium", "high", "original"],
              description: "Resolution tier: low=480px, medium=1280px (default), high=1920px, original=uncapped. Higher tiers cost proportionally more context."
            }
          },
          required: ["contentUri"],
        },
      },

      // ── Gmail (read-only) ────────────────────────────────────────
      {
        name: "gmail_search",
        description: "Search Gmail messages using Gmail search syntax. Returns message IDs, snippet, subject, from, date. Each includes a URL to the message.",
        displayMessage: "📧 Searching Gmail: \"{{query}}\"",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Gmail search query (e.g., 'from:alice subject:report is:unread')" },
            maxResults: { type: "number", description: "Max results (default 10, max 100)" },
            pageToken: { type: "string", description: "Token for next page. Optional." },
          },
          required: ["query"],
        },
      },
      {
        name: "gmail_get_message",
        description: "Get full content of a Gmail message by API ID. Do NOT use the internal UI hash from the Gmail browser URL (e.g. Ktbx...). You MUST use gmail_search to find the correct 16-character hex messageId first.",
        displayMessage: "📧 Reading message {{messageId}}",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message ID (from gmail_search results)" },
            format: { type: "string", description: "'full' (default), 'metadata', or 'minimal'" },
          },
          required: ["messageId"],
        },
      },
      {
        name: "gmail_list_labels",
        description: "List all Gmail labels for the authenticated user.",
        displayMessage: "🏷️ Listing Gmail labels",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "gmail_get_thread",
        description: "Get all messages in a Gmail thread by API ID. Do NOT use the random hash from the Gmail browser URL. Use gmail_search first.",
        displayMessage: "📧 Reading email thread {{threadId}}",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string", description: "The thread ID" },
          },
          required: ["threadId"],
        },
      },
      {
        name: "gmail_get_attachment",
        description: "Fetch the content of a Gmail attachment. By default, returns metadata to prevent context overflow. WARNING: If you are an LLM agent, NEVER set returnRawBase64 to true. It will crash your context window. This parameter is STRICTLY for internal JavaScript execution via runBrowserScript (e.g., when piping to pdf_load).",
        displayMessage: "📎 Fetching attachment {{attachmentId}}",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message ID" },
            attachmentId: { type: "string", description: "The attachment ID from message metadata" },
            returnRawBase64: { type: "boolean", description: "Set to true ONLY when calling from a script. Do not use in direct chat." }
          },
          required: ["messageId", "attachmentId"],
        },
      },

      // ── Google Calendar (read-only) ──────────────────────────────
      {
        name: "calendar_list",
        description: "List all calendars accessible to the authenticated user.",
        displayMessage: "📅 Listing calendars",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "calendar_get_events",
        description: "Get events from a calendar within a time range. Each event includes an htmlLink URL.",
        displayMessage: "📅 Fetching events{{#query}} matching \"{{query}}\"{{/query}}",
        inputSchema: {
          type: "object",
          properties: {
            calendarId: { type: "string", description: "Calendar ID ('primary' for main calendar)" },
            timeMin: { type: "string", description: "Start of time range (RFC3339, e.g., '2025-01-01T00:00:00Z')" },
            timeMax: { type: "string", description: "End of time range (RFC3339). Optional." },
            maxResults: { type: "number", description: "Max events (default 25, max 250)" },
            pageToken: { type: "string", description: "Token for next page. Optional." },
            query: { type: "string", description: "Free text search within events. Optional." },
          },
          required: ["calendarId"],
        },
      },
      {
        name: "calendar_get_event",
        description: "Get a single calendar event by ID. Returns full details including attendees, location, description, and htmlLink URL.",
        displayMessage: "📅 Reading event details for {{eventId}}",
        inputSchema: {
          type: "object",
          properties: {
            calendarId: { type: "string", description: "Calendar ID ('primary' for main)" },
            eventId: { type: "string", description: "The event ID" },
          },
          required: ["calendarId", "eventId"],
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
        case "sheets_read_range":
          return await this.readRange(args.spreadsheetId, args.range, args.offset, args.limit);
        case "sheets_write_range":
          return await this.writeRange(args.spreadsheetId, args.range, args.values);
        case "sheets_create":
          return await this.createSheet(args.title, args.copyFromId);
        case "sheets_list":
          return await this.listSheets(args.maxResults || 10);
        case "sheets_get_metadata":
          return await this.sheetsGetMetadata(args.spreadsheetId);
        case "sheets_batch_update":
          return await this.sheetsBatchUpdate(args.spreadsheetId, args.requests);
        case "sheets_clear_range":
          return await this.sheetsClearRange(args.spreadsheetId, args.range);
        case "sheets_get_urls":
          return await this.sheetsGetUrls(args.spreadsheetId, args.range);
        case "sheets_read_as_csv":
          return await this.sheetsReadAsCsv(args.spreadsheetId, args.range, args.offset, args.limit);
        case "drive_list":
          return await this.driveList(args.query, args.folderId, args.maxResults, args.pageToken);
        case "drive_search":
          return await this.driveSearch(args.searchTerm, args.mimeType, args.maxResults, args.pageToken);
        case "drive_get_file_metadata":
          return await this.driveGetFileMetadata(args.fileId);
        case "drive_render_page":
          return await this.driveRenderPage(args.fileId, args.page, args.resolution, args.region);
        case "docs_get_metadata":
          return await this.docsGetMetadata(args.documentId);
        case "docs_read_content":
          return await this.docsReadContent(args.documentId, args.tabId, args.startIndex, args.endIndex);
        case "docs_create":
          return await this.docsCreate(args.title, args.copyFromId);
        case "docs_batch_update":
          return await this.docsBatchUpdate(args.documentId, args.requests);
        case "docs_get_images":
          return await this.docsGetImages(args.documentId, args.tabId);
        case "docs_get_urls":
          return await this.docsGetUrls(args.documentId, args.tabId);
        case "slides_get_metadata":
          return await this.slidesGetMetadata(args.presentationId);
        case "slides_read_content":
          return await this.slidesReadContent(args.presentationId, args.startSlide, args.endSlide);
        case "slides_get_images":
          return await this.slidesGetImages(args.presentationId, args.startSlide, args.endSlide);
        case "slides_create":
          return await this.slidesCreate(args.title, args.copyFromId);
        case "slides_batch_update":
          return await this.slidesBatchUpdate(args.presentationId, args.requests);
        case "slides_get_urls":
          return await this.slidesGetUrls(args.presentationId);
        case "slides_get_thumbnail":
          return await this.slidesGetThumbnail(args.presentationId, args.slideIndex, args.objectId, args.resolution || args.size, args.region);
        case "gsuite_download_image":
          return await this.gsuiteDownloadImage(args.contentUri, args.mimeType, args.resolution);
        case "gmail_search":
          return await this.gmailSearch(args.query, args.maxResults, args.pageToken);
        case "gmail_get_message":
          return await this.gmailGetMessage(args.messageId, args.format);
        case "gmail_list_labels":
          return await this.gmailListLabels();
        case "gmail_get_thread":
          return await this.gmailGetThread(args.threadId);
        case "gmail_get_attachment":
          return await this.gmailGetAttachment(args.messageId, args.attachmentId, args.returnRawBase64);
        case "calendar_list":
          return await this.calendarList();
        case "calendar_get_events":
          return await this.calendarGetEvents(args.calendarId, args.timeMin, args.timeMax, args.maxResults, args.pageToken, args.query);
        case "calendar_get_event":
          return await this.calendarGetEvent(args.calendarId, args.eventId);
        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true
          };
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // SHEETS
  // ═══════════════════════════════════════════════════════════════

  _sheetTitleCache: {},

  /**
   * Resolve sheet tab name inside a Sheets A1 range string.
   * Handles LLM-garbled names (trailing spaces, Unicode artifacts).
   * Range formats: "A1:B10", "Sheet1!A1:B10", "'My Sheet'!A1:B10"
   */
  async _resolveSheetRange(spreadsheetId, range) {
    if (!range || !range.includes('!')) return range;

    const bangIdx = range.indexOf('!');
    let sheetName = range.substring(0, bangIdx);
    const cellRange = range.substring(bangIdx + 1);

    // Strip surrounding single quotes if present
    if (sheetName.startsWith("'") && sheetName.endsWith("'")) {
      sheetName = sheetName.slice(1, -1).replace(/''/g, "'");
    }

    // Fetch actual sheet names (cached per spreadsheet)
    let titles = this._sheetTitleCache[spreadsheetId];
    if (!titles) {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`;
      const response = await runtime.fetch(url);
      if (!response.ok) return range;
      const data = await response.json();
      titles = (data.sheets || []).map(s => s.properties.title);
      this._sheetTitleCache[spreadsheetId] = titles;
    }

    // Exact match — no fix needed
    if (titles.includes(sheetName)) return range;

    // Trimmed match
    const trimmed = sheetName.trim();
    let match = titles.find(t => t.trim() === trimmed);
    if (!match) {
      // Strip non-ASCII and compare
      const stripped = sheetName.replace(/[^\x20-\x7E]/g, '').trim();
      match = titles.find(t => t.replace(/[^\x20-\x7E]/g, '').trim() === stripped);
    }
    if (!match) return range;

    const needsQuote = match.includes(' ') || match.includes("'") || /[^a-zA-Z0-9_]/.test(match);
    const quoted = needsQuote ? `'${match.replace(/'/g, "''")}'` : match;
    return `${quoted}!${cellRange}`;
  },

  async readRange(spreadsheetId, range, offset, limit) {
    const resolvedRange = await this._resolveSheetRange(spreadsheetId, range);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(resolvedRange)}`;

    const response = await runtime.fetch(url);

    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }

    const data = await response.json();
    let rows = data.values || [];

    // Apply pagination
    const totalRows = rows.length;
    if (offset != null && offset > 0) rows = rows.slice(offset);
    if (limit != null && limit > 0) rows = rows.slice(0, limit);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          values: rows,
          totalRows,
          returnedRows: rows.length,
          url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
        }, null, 2)
      }],
    };
  },

  async writeRange(spreadsheetId, range, values) {
    const resolvedRange = await this._resolveSheetRange(spreadsheetId, range);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(resolvedRange)}?valueInputOption=USER_ENTERED`;

    const response = await runtime.fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    });

    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }

    const data = await response.json();
    return {
      content: [{ type: "text", text: `Updated ${data.updatedCells} cells` }],
    };
  },

  /**
   * Copy a Google Drive file (works for Sheets, Docs, Slides).
   * Returns { id, name, mimeType, webViewLink }.
   */
  async _driveCopy(sourceId, title) {
    const url = `https://www.googleapis.com/drive/v3/files/${sourceId}/copy?supportsAllDrives=true&fields=id,name,mimeType,webViewLink`;
    const response = await runtime.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: title }),
    });
    if (!response.ok) {
      const error = await response.text();
      return { _error: true, content: [{ type: "text", text: `Copy API Error: ${error}` }], isError: true };
    }
    return await response.json();
  },

  async createSheet(title, copyFromId) {
    if (copyFromId) {
      const data = await this._driveCopy(copyFromId, title);
      if (data._error) return data;
      return {
        content: [{
          type: "text",
          text: `Copied spreadsheet: ${data.id}\nURL: ${data.webViewLink || `https://docs.google.com/spreadsheets/d/${data.id}`}`,
          _createdFileId: data.id,
        }],
      };
    }

    const url = "https://sheets.googleapis.com/v4/spreadsheets";

    const response = await runtime.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { title } }),
    });

    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }

    const data = await response.json();
    return {
      content: [{
        type: "text",
        text: `Created spreadsheet: ${data.spreadsheetId}\nURL: ${data.spreadsheetUrl}`,
        _createdFileId: data.spreadsheetId,
      }],
    };
  },

  async listSheets(maxResults) {
    const url = `https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.spreadsheet'&pageSize=${maxResults}&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,modifiedTime)`;

    const response = await runtime.fetch(url);

    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }

    const data = await response.json();
    const files = (data.files || []).map(f => ({
      name: f.name,
      id: f.id,
      modifiedTime: f.modifiedTime,
      url: `https://docs.google.com/spreadsheets/d/${f.id}`
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(files, null, 2) }],
    };
  },

  async sheetsGetMetadata(spreadsheetId) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId,properties.title,sheets.properties`;
    const response = await runtime.fetch(url);

    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }

    const data = await response.json();
    const result = {
      spreadsheetId: data.spreadsheetId,
      title: data.properties?.title,
      url: `https://docs.google.com/spreadsheets/d/${data.spreadsheetId}`,
      sheets: (data.sheets || []).map(s => ({
        sheetId: s.properties.sheetId,
        title: s.properties.title,
        index: s.properties.index,
        rowCount: s.properties.gridProperties?.rowCount,
        columnCount: s.properties.gridProperties?.columnCount,
        url: `https://docs.google.com/spreadsheets/d/${data.spreadsheetId}/edit#gid=${s.properties.sheetId}`
      }))
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },

  async sheetsBatchUpdate(spreadsheetId, requests) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
    const response = await runtime.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    });
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  },

  async sheetsClearRange(spreadsheetId, range) {
    const resolvedRange = await this._resolveSheetRange(spreadsheetId, range);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(resolvedRange)}:clear`;
    const response = await runtime.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    return {
      content: [{ type: "text", text: `Cleared range: ${data.clearedRange}` }],
    };
  },

  async sheetsGetUrls(spreadsheetId, range) {
    // Use spreadsheets.get with data to get hyperlink info via FORMATTED_VALUE + formulas
    const resolvedRange = await this._resolveSheetRange(spreadsheetId, range);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?ranges=${encodeURIComponent(resolvedRange)}&fields=sheets.data.rowData.values(hyperlink,formattedValue,userEnteredValue)`;

    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    const urls = [];
    (data.sheets || []).forEach(sheet => {
      (sheet.data || []).forEach(gridData => {
        (gridData.rowData || []).forEach((row, rowIdx) => {
          (row.values || []).forEach((cell, colIdx) => {
            if (cell.hyperlink) {
              urls.push({
                row: rowIdx,
                col: colIdx,
                url: cell.hyperlink,
                text: cell.formattedValue || "",
              });
            }
            // Also check for HYPERLINK() formula
            const formula = cell.userEnteredValue?.formulaValue;
            if (formula && formula.toUpperCase().startsWith("=HYPERLINK(")) {
              const match = formula.match(/=HYPERLINK\(\s*"([^"]+)"/i);
              if (match && !cell.hyperlink) {
                urls.push({ row: rowIdx, col: colIdx, url: match[1], text: cell.formattedValue || "" });
              }
            }
          });
        });
      });
    });
    return {
      content: [{ type: "text", text: JSON.stringify(urls, null, 2) }],
    };
  },

  async sheetsReadAsCsv(spreadsheetId, range, offset, limit) {
    const resolvedRange = await this._resolveSheetRange(spreadsheetId, range);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(resolvedRange)}`;
    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    let rows = data.values || [];
    const totalRows = rows.length;
    if (offset != null && offset > 0) rows = rows.slice(offset);
    if (limit != null && limit > 0) rows = rows.slice(0, limit);

    // Convert to CSV
    const csvEscape = (val) => {
      const s = String(val ?? "");
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };
    const csv = rows.map(row => row.map(csvEscape).join(",")).join("\n");
    return {
      content: [{ type: "text", text: `totalRows: ${totalRows}\nreturnedRows: ${rows.length}\n---\n${csv}` }],
    };
  },

  // ═══════════════════════════════════════════════════════════════
  // DRIVE (read-only)
  // ═══════════════════════════════════════════════════════════════

  async driveList(query, folderId, maxResults, pageToken) {
    const parts = [];
    if (query) parts.push(query);
    if (folderId) parts.push(`'${folderId}' in parents`);
    parts.push("trashed=false");
    const q = parts.join(" and ");
    const limit = Math.min(maxResults || 20, 100);
    let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${limit}&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,owners)&orderBy=modifiedTime desc`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    const files = (data.files || []).map(f => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      size: f.size,
      url: f.webViewLink || this._driveUrl(f.id, f.mimeType),
      owners: (f.owners || []).map(o => o.emailAddress),
    }));
    const result = { files, nextPageToken: data.nextPageToken || null };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },

  async driveSearch(searchTerm, mimeType, maxResults, pageToken) {
    const parts = [`fullText contains '${searchTerm.replace(/'/g, "\\'")}'`];
    if (mimeType) parts.push(`mimeType='${mimeType}'`);
    parts.push("trashed=false");
    return await this.driveList(parts.join(" and "), null, maxResults || 20, pageToken);
  },

  async driveGetFileMetadata(fileId) {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true&fields=id,name,mimeType,modifiedTime,createdTime,size,webViewLink,owners,permissions,description`;
    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    data.url = data.webViewLink || this._driveUrl(data.id, data.mimeType);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },

  _driveUrl(fileId, mimeType) {
    if (mimeType === "application/vnd.google-apps.spreadsheet") return `https://docs.google.com/spreadsheets/d/${fileId}`;
    if (mimeType === "application/vnd.google-apps.document") return `https://docs.google.com/document/d/${fileId}`;
    if (mimeType === "application/vnd.google-apps.presentation") return `https://docs.google.com/presentation/d/${fileId}`;
    return `https://drive.google.com/file/d/${fileId}/view`;
  },

  // ═══════════════════════════════════════════════════════════════
  // DOCS
  // ═══════════════════════════════════════════════════════════════

  async docsGetMetadata(documentId) {
    // Excluding 'title' and 'revisionId' to avoid field mask conflict with 'tabs'
    const url = `https://docs.googleapis.com/v1/documents/${documentId}?includeTabsContent=true&fields=documentId,tabs(tabProperties)`;
    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    const result = {
      documentId: data.documentId,
      title: data.title || "Unknown (Title excluded)",
      revisionId: data.revisionId || "Unknown",
      url: `https://docs.google.com/document/d/${data.documentId}`,
      tabs: (data.tabs || []).map(t => ({
        tabId: t.tabProperties?.tabId,
        title: t.tabProperties?.title,
        index: t.tabProperties?.index,
      }))
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },

  async docsCreate(title, copyFromId) {
    if (copyFromId) {
      const data = await this._driveCopy(copyFromId, title);
      if (data._error) return data;
      const docUrl = data.webViewLink || `https://docs.google.com/document/d/${data.id}`;
      return {
        content: [{
          type: "text",
          text: `Copied document: ${data.id}\nURL: ${docUrl}`,
          _createdFileId: data.id,
        }],
      };
    }

    const url = "https://docs.googleapis.com/v1/documents";
    const response = await runtime.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    const docUrl = `https://docs.google.com/document/d/${data.documentId}`;
    return {
      content: [{
        type: "text",
        text: `Created document: ${data.documentId}\nURL: ${docUrl}`,
        _createdFileId: data.documentId,
      }],
    };
  },

  async docsBatchUpdate(documentId, requests) {
    const url = `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`;
    const response = await runtime.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    });
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  },

  async docsReadContent(documentId, tabId, startIndex, endIndex) {
    // TODO(non-native-files): Google Drive serves uploaded .docx files under
    // /document/d/<id>/edit URLs, identical to native Google Docs URLs. The
    // autoloader matches both and routes the model here, but the Docs API
    // (docs.googleapis.com/v1/documents) only accepts native Google Docs and
    // returns an opaque 400 for .docx (or any other non-native MIME type).
    // That 400 currently triggers the OAuth account-mismatch circuit breaker
    // in browser-mcp-manager.ts and produces a spurious account picker
    // followed by tool failure, after which the model falls back to
    // takeSnapshot/takeScreenshot — bad UX for a common case.
    //
    // Real fix is at the routing layer, not here: either (a) the autoloader
    // does a Drive metadata pre-check before binding /document/d/ URLs to
    // the google-workspace skill, or (b) a new tool (e.g. drive_read_file)
    // dispatches by mimeType — native Doc -> existing Docs API path,
    // .docx -> drive alt=media + a docx_load parser tool (mirroring how
    // pdf_load handles PDFs from Drive today via /file/d/ URLs).
    //
    // Patching this function to silently branch on mimeType would muddy
    // its contract ("read a Google Doc") and is not the right layer.
    const url = `https://docs.googleapis.com/v1/documents/${documentId}?includeTabsContent=true`;
    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const doc = await response.json();

    // Find the right tab body
    let body = null;
    if (doc.tabs && doc.tabs.length > 0) {
      const tab = tabId
        ? doc.tabs.find(t => t.tabProperties?.tabId === tabId)
        : doc.tabs[0];
      body = tab?.documentTab?.body;
    }
    if (!body) body = doc.body;
    if (!body) return { content: [{ type: "text", text: "No content found" }] };

    const text = this._extractDocText(body.content, startIndex, endIndex);
    const totalChars = this._extractDocText(body.content).length;

    return {
      content: [{ type: "text", text: JSON.stringify({
        text,
        totalChars,
        returnedChars: text.length,
        url: `https://docs.google.com/document/d/${documentId}`
      }, null, 2) }]
    };
  },

  _extractDocText(elements, startIndex, endIndex) {
    let text = "";
    for (const el of (elements || [])) {
      if (el.paragraph) {
        for (const pe of (el.paragraph.elements || [])) {
          if (pe.textRun) text += pe.textRun.content || "";
        }
      } else if (el.table) {
        for (const row of (el.table.tableRows || [])) {
          const cells = [];
          for (const cell of (row.tableCells || [])) {
            cells.push(this._extractDocText(cell.content));
          }
          text += cells.join("\t") + "\n";
        }
      } else if (el.sectionBreak) {
        text += "\n---\n";
      }
    }
    if (startIndex != null || endIndex != null) {
      const s = startIndex || 0;
      const e = endIndex || text.length;
      text = text.slice(s, e);
    }
    return text;
  },

  async docsGetImages(documentId, tabId) {
    const url = `https://docs.googleapis.com/v1/documents/${documentId}?includeTabsContent=true`;
    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const doc = await response.json();
    let body = null;
    if (doc.tabs && doc.tabs.length > 0) {
      const tab = tabId ? doc.tabs.find(t => t.tabProperties?.tabId === tabId) : doc.tabs[0];
      body = tab?.documentTab?.body;
    }
    if (!body) body = doc.body;

    const images = [];
    this._walkDocElements(body?.content, (el, idx) => {
      if (el.inlineObjectElement) {
        const objId = el.inlineObjectElement.inlineObjectId;
        const inlineObjects = doc.tabs?.[0]?.documentTab?.inlineObjects || doc.inlineObjects || {};
        const obj = inlineObjects[objId];
        if (obj) {
          const embedded = obj.inlineObjectProperties?.embeddedObject;
          images.push({
            objectId: objId,
            contentUri: embedded?.imageProperties?.contentUri || embedded?.imageProperties?.sourceUri || null,
            title: embedded?.title || null,
            description: embedded?.description || null,
            size: embedded?.size || null,
          });
        }
      }
    });
    return { content: [{ type: "text", text: JSON.stringify({ images, docUrl: `https://docs.google.com/document/d/${documentId}` }, null, 2) }] };
  },

  async docsGetUrls(documentId, tabId) {
    const url = `https://docs.googleapis.com/v1/documents/${documentId}?includeTabsContent=true`;
    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const doc = await response.json();
    let body = null;
    if (doc.tabs && doc.tabs.length > 0) {
      const tab = tabId ? doc.tabs.find(t => t.tabProperties?.tabId === tabId) : doc.tabs[0];
      body = tab?.documentTab?.body;
    }
    if (!body) body = doc.body;

    const urls = [];
    this._walkDocElements(body?.content, (el) => {
      if (el.textRun && el.textRun.textStyle?.link?.url) {
        urls.push({
          url: el.textRun.textStyle.link.url,
          text: (el.textRun.content || "").trim(),
        });
      }
    });
    return { content: [{ type: "text", text: JSON.stringify({ urls, docUrl: `https://docs.google.com/document/d/${documentId}` }, null, 2) }] };
  },

  _walkDocElements(elements, visitor) {
    for (const el of (elements || [])) {
      if (el.paragraph) {
        for (const pe of (el.paragraph.elements || [])) {
          visitor(pe);
        }
      } else if (el.table) {
        for (const row of (el.table.tableRows || [])) {
          for (const cell of (row.tableCells || [])) {
            this._walkDocElements(cell.content, visitor);
          }
        }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // SLIDES
  // ═══════════════════════════════════════════════════════════════

  async slidesCreate(title, copyFromId) {
    if (copyFromId) {
      const data = await this._driveCopy(copyFromId, title);
      if (data._error) return data;
      const presUrl = data.webViewLink || `https://docs.google.com/presentation/d/${data.id}`;
      return {
        content: [{
          type: "text",
          text: `Copied presentation: ${data.id}\nURL: ${presUrl}`,
          _createdFileId: data.id,
        }],
      };
    }

    const url = "https://slides.googleapis.com/v1/presentations";
    const response = await runtime.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    const presUrl = `https://docs.google.com/presentation/d/${data.presentationId}`;
    return {
      content: [{
        type: "text",
        text: `Created presentation: ${data.presentationId}\nURL: ${presUrl}`,
        _createdFileId: data.presentationId,
      }],
    };
  },

  async slidesBatchUpdate(presentationId, requests) {
    const url = `https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`;
    const response = await runtime.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    });
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  },

  async slidesGetMetadata(presentationId) {
    const url = `https://slides.googleapis.com/v1/presentations/${presentationId}?fields=presentationId,title,pageSize,slides(objectId,slideProperties)`;
    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    return { content: [{ type: "text", text: JSON.stringify({
      presentationId: data.presentationId,
      title: data.title,
      url: `https://docs.google.com/presentation/d/${data.presentationId}`,
      pageSize: data.pageSize,
      slideCount: (data.slides || []).length,
      slides: (data.slides || []).map((s, i) => ({
        slideIndex: i + 1,
        objectId: s.objectId,
        layoutId: s.slideProperties?.layoutObjectId,
      }))
    }, null, 2) }] };
  },

  async slidesReadContent(presentationId, startSlide, endSlide) {
    const url = `https://slides.googleapis.com/v1/presentations/${presentationId}`;
    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    let slides = data.slides || [];
    const totalSlides = slides.length;
    const start = (startSlide || 1) - 1;
    const end = endSlide || totalSlides;
    slides = slides.slice(start, end);

    const slideContents = slides.map((slide, idx) => {
      const texts = [];
      const images = [];
      this._walkSlideElements(slide.pageElements, (shape) => {
        if (shape.shape?.text) {
          const t = shape.shape.text.textElements
            ?.map(te => te.textRun?.content || "")
            .join("") || "";
          if (t.trim()) texts.push(t.trim());
        }
        if (shape.table) {
          for (const row of (shape.table.tableRows || [])) {
            const cells = (row.tableCells || []).map(cell => {
              return (cell.text?.textElements || []).map(te => te.textRun?.content || "").join("").trim();
            });
            texts.push(cells.join("\t"));
          }
        }
        if (shape.image) {
          images.push({
            objectId: shape.objectId,
            contentUrl: shape.image.contentUrl || null,
            sourceUrl: shape.image.sourceUrl || null,
            title: shape.title || null,
            description: shape.description || null,
          });
        }
      });
      const entry = { slideIndex: start + idx + 1, objectId: slide.objectId, text: texts.join("\n") };
      if (images.length > 0) entry.images = images;
      return entry;
    });

    return { content: [{ type: "text", text: JSON.stringify({
      totalSlides,
      returnedSlides: slideContents.length,
      url: `https://docs.google.com/presentation/d/${presentationId}`,
      slides: slideContents,
    }, null, 2) }] };
  },

  async slidesGetImages(presentationId, startSlide, endSlide) {
    const url = `https://slides.googleapis.com/v1/presentations/${presentationId}`;
    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    let slides = data.slides || [];
    const start = (startSlide || 1) - 1;
    const end = endSlide || slides.length;
    slides = slides.slice(start, end);

    const images = [];
    slides.forEach((slide, idx) => {
      this._walkSlideElements(slide.pageElements, (el) => {
        if (el.image) {
          images.push({
            slideIndex: start + idx + 1,
            objectId: el.objectId,
            contentUrl: el.image.contentUrl || null,
            sourceUrl: el.image.sourceUrl || null,
            title: el.title || null,
            description: el.description || null,
          });
        }
      });
    });
    return { content: [{ type: "text", text: JSON.stringify({
      images,
      presentationUrl: `https://docs.google.com/presentation/d/${presentationId}`
    }, null, 2) }] };
  },

  async slidesGetUrls(presentationId) {
    const url = `https://slides.googleapis.com/v1/presentations/${presentationId}`;
    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    const urls = [];
    (data.slides || []).forEach((slide, slideIdx) => {
      this._walkSlideElements(slide.pageElements, (el) => {
        // Shape text links
        if (el.shape?.text) {
          for (const te of (el.shape.text.textElements || [])) {
            const link = te.textRun?.style?.link;
            if (link?.url) {
              urls.push({ slideIndex: slideIdx + 1, url: link.url, text: (te.textRun.content || "").trim() });
            }
          }
        }
        // Shape-level link
        if (el.shape?.shapeProperties?.contentAlignment !== undefined && el.shape?.link?.url) {
          urls.push({ slideIndex: slideIdx + 1, url: el.shape.link.url, text: "" });
        }
      });
    });
    return { content: [{ type: "text", text: JSON.stringify({
      urls,
      presentationUrl: `https://docs.google.com/presentation/d/${presentationId}`
    }, null, 2) }] };
  },

  // ═══════════════════════════════════════════════════════════════
  // VISUAL RENDERING
  // ═══════════════════════════════════════════════════════════════

  // Export a Drive file to PDF bytes. Google-native types go through the
  // export endpoint; anything already binary (an uploaded PDF) is downloaded
  // with alt=media instead, since export rejects it as non-exportable.
  async _exportFileAsPdf(fileId) {
    const cached = PDF_EXPORT_CACHE.get(fileId);
    if (cached && Date.now() - cached.at < PDF_EXPORT_TTL_MS) return cached.bytes;

    const exportUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application%2Fpdf`;
    let response = await runtime.fetch(exportUrl, { responseFormat: "base64" });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (/fileNotExportable|not exportable/i.test(body)) {
        // Already a binary file — fetch it directly.
        response = await runtime.fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
          { responseFormat: "base64" }
        );
        if (!response.ok) {
          const body2 = await response.text().catch(() => "");
          throw new Error(`Download failed (${response.status}): ${body2.slice(0, 200)}`);
        }
      } else if (/exportSizeLimitExceeded/i.test(body)) {
        throw new Error(
          "Drive refused the PDF export: the file exceeds the ~10MB export limit. " +
          "Read it with the text tools instead, or ask the user to export it manually."
        );
      } else {
        throw new Error(`PDF export failed (${response.status}): ${body.slice(0, 200)}`);
      }
    }

    const bytes = await readPdfBytes(response);
    PDF_EXPORT_CACHE.set(fileId, { bytes, at: Date.now() });
    return bytes;
  },

  async driveRenderPage(fileId, page, resolution, region) {
    const bytes = await this._exportFileAsPdf(fileId);
    const r = await renderPdfPage(bytes, page || 1, { resolution, region });

    return {
      content: [
        { type: "text", text: JSON.stringify({
          fileId,
          page: r.page,
          totalPages: r.totalPages,
          prevPage: r.page > 1 ? r.page - 1 : null,
          nextPage: r.page < r.totalPages ? r.page + 1 : null,
          render: { width: r.width, height: r.height, scale: r.scale, resolution: r.resolution, bytes: r.bytes, region: normalizeRegion(region) },
          url: `https://drive.google.com/file/d/${fileId}/view`,
        }, null, 2) },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: r.base64 } },
      ],
    };
  },

  async slidesGetThumbnail(presentationId, slideIndex, objectId, resolution, region) {
    let targetId = objectId;
    let index = slideIndex || 1;
    let slideCount = null;

    if (!targetId || !slideCount) {
      const metaUrl = `https://slides.googleapis.com/v1/presentations/${presentationId}?fields=slides(objectId)`;
      const metaResp = await runtime.fetch(metaUrl);
      if (!metaResp.ok) {
        const error = await metaResp.text();
        return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
      }
      const slides = (await metaResp.json()).slides || [];
      slideCount = slides.length;
      if (targetId) {
        const found = slides.findIndex(s => s.objectId === targetId);
        if (found !== -1) {
          index = found + 1;
        } else {
          return { content: [{ type: "text", text: `Slide objectId "${targetId}" not found in presentation.` }], isError: true };
        }
      } else {
        if (index < 1 || index > slideCount) {
          return { content: [{ type: "text", text: `Slide ${index} is out of range — this presentation has ${slideCount} slide(s).` }], isError: true };
        }
        targetId = slides[index - 1].objectId;
      }
    }

    const LEGACY_SIZE_MAP = { small: "low", medium: "medium", large: "high" };
    const resKey = (resolution && LEGACY_SIZE_MAP[String(resolution).toLowerCase()]) || resolution;
    const maxDim = resolveMaxDim(resKey);
    const resTier = (resKey && String(resKey).toLowerCase() in RESOLUTION_MAP) ? String(resKey).toLowerCase() : DEFAULT_RESOLUTION;

    const normRegion = normalizeRegion(region);

    // If uncropped and low tier, MEDIUM (800px) is plenty and saves network transfer;
    // otherwise fetch LARGE (1600px) for maximum source detail.
    const apiSize = (!normRegion && maxDim <= 480) ? "MEDIUM" : "LARGE";
    const thumbUrl = `https://slides.googleapis.com/v1/presentations/${presentationId}/pages/${targetId}/thumbnail` +
      `?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=${apiSize}`;
    const thumbResp = await runtime.fetch(thumbUrl);
    if (!thumbResp.ok) {
      const error = await thumbResp.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const thumb = await thumbResp.json();

    // contentUrl is a short-lived signed googleusercontent URL — no auth header.
    const imgResp = await runtime.fetch(thumb.contentUrl, { skipAuth: true, responseFormat: "base64" });
    if (!imgResp.ok) {
      return { content: [{ type: "text", text: `Failed to fetch slide thumbnail: ${imgResp.status}` }], isError: true };
    }
    const rawBytes = await readBinaryResponse(imgResp, MAGIC_PNG);

    const blob = new Blob([rawBytes], { type: "image/png" });
    const probe = await createImageBitmap(blob);

    let srcX = 0;
    let srcY = 0;
    let srcW = probe.width;
    let srcH = probe.height;
    if (normRegion) {
      srcX = Math.round(probe.width * normRegion.x);
      srcY = Math.round(probe.height * normRegion.y);
      srcW = Math.max(1, Math.round(probe.width * normRegion.width));
      srcH = Math.max(1, Math.round(probe.height * normRegion.height));
    }

    let width = srcW;
    let height = srcH;
    if (maxDim !== Infinity && (srcW > 0 || srcH > 0)) {
      const maxSrcDim = Math.max(srcW, srcH);
      const fit = maxDim / maxSrcDim;
      width = Math.max(1, Math.round(srcW * fit));
      height = Math.max(1, Math.round(srcH * fit));
    }

    const scale = srcW > 0 ? Number((width / srcW).toFixed(3)) : 1.0;

    // Back off quality, then dimensions, until the payload fits — the same
    // strategy as renderPdfPage and screenshot-tools.ts.
    let quality = 0.85;
    let outCanvas = new OffscreenCanvas(width, height);
    let ctx = outCanvas.getContext("2d");
    ctx.fillStyle = "white"; // JPEG has no alpha — transparent pixels turn black
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(probe, srcX, srcY, srcW, srcH, 0, 0, width, height);
    probe.close();

    let outBlob = await outCanvas.convertToBlob({ type: "image/jpeg", quality });
    let base64 = bytesToBase64(new Uint8Array(await outBlob.arrayBuffer()));
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
      outBlob = await outCanvas.convertToBlob({ type: "image/jpeg", quality });
      base64 = bytesToBase64(new Uint8Array(await outBlob.arrayBuffer()));
    }

    return {
      content: [
        { type: "text", text: JSON.stringify({
          presentationId,
          fileId: presentationId,
          slideIndex: index,
          page: index,
          objectId: targetId,
          slideCount,
          totalPages: slideCount,
          prevPage: index > 1 ? index - 1 : null,
          nextPage: index < slideCount ? index + 1 : null,
          width: outCanvas.width,
          height: outCanvas.height,
          render: {
            width: outCanvas.width,
            height: outCanvas.height,
            scale,
            resolution: resTier,
            quality: Number(quality.toFixed(2)),
            bytes: base64.length,
            region: normRegion,
          },
          url: `https://docs.google.com/presentation/d/${presentationId}`,
        }, null, 2) },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
      ],
    };
  },

  // ═══════════════════════════════════════════════════════════════
  // IMAGES
  // ═══════════════════════════════════════════════════════════════
  // Optimized gsuiteDownloadImage replacement
  async gsuiteDownloadImage(contentUri, mimeType, resolution) {
    // Validate the tier before the network round trip, and surface it as a tool
    // error rather than an uncaught throw — matching drive_render_page.
    try {
      resolveMaxDim(resolution || "medium");
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }

    // ── Helper: resize image to fit LLM context limits ──
    // Defaults to the medium tier rather than low: these are user-supplied
    // images — screenshots, photos of documents — where 480px often makes text
    // unreadable, unlike a rendered page the caller can re-crop. Callers that
    // need detail can ask for high/original explicitly.
    const resizeForLLM = async (bytes, mime, resolution, maxBase64 = MAX_BASE64_LENGTH) => {
      const maxDim = resolveMaxDim(resolution || "medium");

      // Estimate before encoding. base64 is 4/3 of the byte length, so a 12MB
      // original can be ruled out without materializing a 16MB string first —
      // which the old code did unconditionally, twice on the failure path.
      const estimated = base64LengthOf(bytes);

      // Already small enough AND within the tier: hand back the original bytes.
      if (estimated <= maxBase64 && maxDim === Infinity) {
        return { base64: bytesToBase64(bytes), mime, width: null, height: null, resized: false };
      }
      const blob = new Blob([bytes], { type: mime });
      const probe = await createImageBitmap(blob);
      const withinTier = probe.width <= maxDim && probe.height <= maxDim;
      if (estimated <= maxBase64 && withinTier) {
        const srcW = probe.width;
        const srcH = probe.height;
        probe.close();
        return { base64: bytesToBase64(bytes), mime, width: srcW, height: srcH, resized: false };
      }

      runtime.console.log(`[gsuiteDownloadImage] Resizing ${probe.width}x${probe.height} (~${Math.round(estimated / 1024)}KB base64) to the ${resolution || "medium"} tier...`);
      let width = probe.width;
      let height = probe.height;
      if (maxDim !== Infinity && (width > maxDim || height > maxDim)) {
        const fit = maxDim / Math.max(width, height);
        width = Math.max(1, Math.round(width * fit));
        height = Math.max(1, Math.round(height * fit));
      }

      // Back off quality, then dimensions, until the payload fits — the same
      // strategy as renderPdfPage and screenshot-tools.ts. The old single pass
      // could still return well over the ceiling for a large photograph.
      let quality = 0.8;
      let outB64;
      for (;;) {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(probe, 0, 0, width, height);
        const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality });
        outB64 = bytesToBase64(new Uint8Array(await outBlob.arrayBuffer()));
        if (outB64.length <= maxBase64 || quality <= 0.2) break;
        quality -= 0.1;
        if (quality < 0.5) {
          width = Math.max(1, Math.round(width * 0.75));
          height = Math.max(1, Math.round(height * 0.75));
          quality = 0.7;
        }
      }
      probe.close();
      runtime.console.log(`[gsuiteDownloadImage] Resized to ${width}x${height}, ${Math.round(outB64.length / 1024)}KB JPEG`);
      return { base64: outB64, mime: "image/jpeg", width, height, resized: true };
    };

      // responseFormat:"base64" is not optional for a binary body. Without it
      // the proxy returns the payload as text, so response.blob() yields ASCII
      // base64 instead of image bytes — every other binary fetch in this file
      // already passes it (drive export, slide thumbnails).
      const FETCH_OPTS = { responseFormat: "base64" };
      let response;
      try {
        // Try fetching. If it's a known CDN domain, skip auth immediately to prevent sandbox blocks.
        const skipAuth = contentUri.includes("googleusercontent.com");
        response = await runtime.fetch(contentUri, skipAuth ? { ...FETCH_OPTS, skipAuth: true } : { ...FETCH_OPTS });
      } catch (e) {
        // Fallback if sandbox blocks the request due to domain scope restrictions
        if (e.message && e.message.includes("not authorized for scopes")) {
          response = await runtime.fetch(contentUri, { ...FETCH_OPTS, skipAuth: true });
        } else {
          throw e;
        }
      }

      // Attempt 2: If 400/403, try without Auth (assuming signed URL conflict)
      if (response && (response.status === 400 || response.status === 403)) {
        response = await runtime.fetch(contentUri, { ...FETCH_OPTS, skipAuth: true });
      }

      if (!response || !response.ok) {
        return { content: [{ type: "text", text: `Failed: ${response ? response.status : 'Unknown error'}` }], isError: true };
      }

      // Trust the bytes, not the header or the caller's hint. `mimeType` is a
      // guess the model made and blob.type is whatever the proxy labelled the
      // transport with; neither survives contact with a base64-wrapped body.
      const { bytes, mime: sniffedMime } = await readImageResponse(response);
      if (sniffedMime === null) {
        return {
          content: [{
            type: "text",
            text: `Failed: the body at that contentUri is not a decodable image ` +
              `(${Math.round(bytes.length / 1024)}KB, no PNG/JPEG/GIF/WebP/BMP signature). ` +
              `contentUri values expire after ~30 minutes — re-run docs_get_images or ` +
              `slides_read_content for a fresh one. If it keeps failing, render the ` +
              `containing page with drive_render_page or slides_get_thumbnail instead.`,
          }],
          isError: true,
        };
      }
      const mime = sniffedMime;
      const sourceBytes = bytes.length;

      // Resize for LLM context limits, then return
      let out;
      try {
        out = await resizeForLLM(bytes, mime, resolution);
      } catch (e) {
        // Downscaling is the ONLY thing bounding this payload. The old fallback
        // re-encoded the original and shipped it anyway: a multi-megabyte doc
        // image came back as ~1.5M tokens of base64 and the request died with
        // "prompt is too long" before the model saw anything. An error the
        // caller can act on beats a response that kills the conversation.
        const estimated = base64LengthOf(bytes);
        if (estimated > MAX_BASE64_LENGTH) {
          return {
            content: [{
              type: "text",
              text: `Failed to downscale this image (${e.message}). The original is ` +
                `${Math.round(sourceBytes / 1024)}KB — about ${Math.round(estimated / 1024)}KB ` +
                `of base64, past the ${Math.round(MAX_BASE64_LENGTH / 1024)}KB ceiling — so ` +
                `returning it as-is would exhaust the context window. Render the containing ` +
                `page with drive_render_page or slides_get_thumbnail instead.`,
            }],
            isError: true,
          };
        }
        // Small enough to pass through unmodified even though the decoder failed.
        out = { base64: bytesToBase64(bytes), mime, width: null, height: null, resized: false, note: `resize skipped: ${e.message}` };
      }

      const resTier = String(resolution || "medium").toLowerCase();
      return {
        content: [
          { type: "text", text: JSON.stringify({
            mimeType: out.mime,
            sourceMimeType: mime,
            sourceBytes,
            render: {
              width: out.width,
              height: out.height,
              resolution: resTier,
              resized: out.resized,
              bytes: out.base64.length,
            },
            note: out.note,
          }, null, 2) },
          {
            type: "image",
            source: { type: "base64", media_type: out.mime, data: out.base64 },
          },
        ],
      };
  },

  _walkSlideElements(elements, visitor) {
    for (const el of (elements || [])) {
      visitor(el);
      if (el.group?.children) {
        this._walkSlideElements(el.group.children, visitor);
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // GMAIL (read-only)
  // ═══════════════════════════════════════════════════════════════

  async gmailSearch(query, maxResults, pageToken) {
    const limit = Math.min(maxResults || 10, 100);
    let url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${limit}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    const messageIds = (data.messages || []).map(m => m.id);

    // Fetch metadata for each message (batch-friendly: get snippet/headers)
    const messages = [];
    for (const msgId of messageIds) {
      const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=To`;
      const msgResp = await runtime.fetch(msgUrl);
      if (msgResp.ok) {
        const msg = await msgResp.json();
        const headers = {};
        for (const h of (msg.payload?.headers || [])) {
          headers[h.name.toLowerCase()] = h.value;
        }
        messages.push({
          id: msg.id,
          threadId: msg.threadId,
          snippet: msg.snippet,
          subject: headers.subject || "",
          from: headers.from || "",
          to: headers.to || "",
          date: headers.date || "",
          labelIds: msg.labelIds,
          url: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
        });
      }
    }

    return { content: [{ type: "text", text: JSON.stringify({
      resultSizeEstimate: data.resultSizeEstimate,
      nextPageToken: data.nextPageToken || null,
      messages,
    }, null, 2) }] };
  },

  async gmailGetMessage(messageId, format) {
    if (typeof messageId === "string" && messageId.length > 20) {
      return { content: [{ type: "text", text: "Error: Invalid messageId. The ID from the browser URL (e.g., Ktbx...) is an internal UI hash, not an API ID. Please use the gmail_search tool to find the correct 16-character hex ID by searching for the email subject or sender." }], isError: true };
    }
    const fmt = (typeof format === "string" && format !== "") ? format : "full";
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=${fmt}`;
    const response = await runtime.fetch(url);
    if (response.ok === false) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const msg = await response.json();

    // Extract readable body
    const bodyText = this._extractGmailBody(msg.payload);
    const headers = {};
    for (const h of (msg.payload?.headers || [])) {
      headers[h.name.toLowerCase()] = h.value;
    }
    const attachments = [];
    this._walkGmailParts(msg.payload, (part) => {
      if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
        attachments.push({ filename: part.filename, mimeType: part.mimeType, size: part.body.size, attachmentId: part.body.attachmentId });
      }
    });

    // Extract HTML body specifically to find hidden Drive chip links
    let htmlText = "";
    this._walkGmailParts(msg.payload, (part) => {
      if (part !== null && part.mimeType === "text/html" && part.body !== undefined && typeof part.body.data === "string") {
        htmlText += String(this._decodeBase64Url(part.body.data)) + " ";
      }
    });
    if (msg.payload !== null && msg.payload.mimeType === "text/html" && msg.payload.body !== undefined && typeof msg.payload.body.data === "string") {
      htmlText += String(this._decodeBase64Url(msg.payload.body.data));
    }

    // Synthesize Workspace Attachments from Drive links in the body
    const workspaceRegex = /https:\/\/(?:docs\.google\.com\/(document|spreadsheets|presentation)\/d\/|drive\.google\.com\/(?:open\?id=|file\/d\/))([a-zA-Z0-9-_]+)/g;
    let match = null;
    const seenIds = new Set();
    while ((match = workspaceRegex.exec(bodyText + " " + htmlText)) !== null) {
      const appType = match[1] ? String(match[1]) : "drive-file";
      const fileId = String(match[2]);
      if (seenIds.has(fileId) === false) {
        seenIds.add(fileId);
        let mimeType = "application/vnd.google-apps.file"; // fallback
        if (appType === "document") { mimeType = "application/vnd.google-apps.document"; }
        else if (appType === "spreadsheets") { mimeType = "application/vnd.google-apps.spreadsheet"; }
        else if (appType === "presentation") { mimeType = "application/vnd.google-apps.presentation"; }

        attachments.push({
          filename: `Linked Google ${appType}`,
          mimeType: mimeType,
          size: 0,
          attachmentId: fileId
        });
      }
    }

    return { content: [{ type: "text", text: JSON.stringify({
      id: msg.id,
      threadId: msg.threadId,
      subject: headers.subject || "",
      from: headers.from || "",
      to: headers.to || "",
      date: headers.date || "",
      body: bodyText,
      attachments,
      labelIds: msg.labelIds,
      url: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
    }, null, 2) }] };
  },

  _extractGmailBody(payload) {
    if (!payload) return "";
    // Try to find text/plain or text/html part
    if (payload.mimeType === "text/plain" && payload.body?.data) {
      return this._decodeBase64Url(payload.body.data);
    }
    if (payload.parts) {
      // Prefer text/plain
      for (const part of payload.parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          return this._decodeBase64Url(part.body.data);
        }
      }
      // Fallback to text/html
      for (const part of payload.parts) {
        if (part.mimeType === "text/html" && part.body?.data) {
          return this._decodeBase64Url(part.body.data);
        }
      }
      // Recurse into multipart
      for (const part of payload.parts) {
        const result = this._extractGmailBody(part);
        if (result) return result;
      }
    }
    if (payload.body?.data) {
      return this._decodeBase64Url(payload.body.data);
    }
    return "";
  },

  _decodeBase64Url(data) {
    try {
      let base64 = data.replace(/-/g, "+").replace(/_/g, "/");
      while (base64.length % 4 !== 0) {
        base64 += "=";
      }
      return atob(base64);
    } catch (e) {
      return "[base64 decode error]";
    }
  },

  _walkGmailParts(part, visitor) {
    if (!part) return;
    visitor(part);
    if (part.parts) {
      for (const p of part.parts) this._walkGmailParts(p, visitor);
    }
  },

  async gmailListLabels() {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/labels`;
    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    return { content: [{ type: "text", text: JSON.stringify(data.labels || [], null, 2) }] };
  },

  async gmailGetThread(threadId) {
    if (typeof threadId === "string" && threadId.length > 20) {
      return { content: [{ type: "text", text: "Error: Invalid threadId. The ID from the browser URL is an internal UI hash. Use gmail_search to find the correct ID." }], isError: true };
    }
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=To`;
    const response = await runtime.fetch(url);
    if (response.ok === false) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const thread = await response.json();
    const messages = (thread.messages || []).map(msg => {
      const headers = {};
      for (const h of (msg.payload?.headers || [])) {
        headers[h.name.toLowerCase()] = h.value;
      }
      return {
        id: msg.id,
        snippet: msg.snippet,
        subject: headers.subject || "",
        from: headers.from || "",
        date: headers.date || "",
        labelIds: msg.labelIds,
      };
    });
    return { content: [{ type: "text", text: JSON.stringify({
      threadId: thread.id,
      url: `https://mail.google.com/mail/u/0/#inbox/${thread.id}`,
      messages,
    }, null, 2) }] };
  },

  async gmailGetAttachment(messageId, attachmentId, returnRawBase64) {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`;
    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    let normalizedBase64 = typeof data.data === "string" ? data.data.replace(/-/g, "+").replace(/_/g, "/") : "";
    while (normalizedBase64.length % 4 !== 0) {
      normalizedBase64 += "=";
    }

    if (returnRawBase64 !== true) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "Attachment metadata retrieved. Raw base64 omitted to prevent context overflow.",
          size: data.size,
          hint: "To process this file, write a script that calls gmail_get_attachment with returnRawBase64: true, then passes the base64 output to the appropriate tool (e.g., pdf_load)."
        }, null, 2) }]
      };
    }

    return {
      content: [
        { type: "text", text: `Attachment data retrieved (${data.size} bytes). Use the appropriate tool to process this base64 data.` },
        { type: "text", text: JSON.stringify({ base64: normalizedBase64, size: data.size }, null, 2) }
      ]
    };
  },

  // ═══════════════════════════════════════════════════════════════
  // CALENDAR (read-only)
  // ═══════════════════════════════════════════════════════════════

  async calendarList() {
    const url = `https://www.googleapis.com/calendar/v3/users/me/calendarList`;
    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    const calendars = (data.items || []).map(c => ({
      id: c.id,
      summary: c.summary,
      description: c.description,
      primary: c.primary || false,
      accessRole: c.accessRole,
      backgroundColor: c.backgroundColor,
    }));
    return { content: [{ type: "text", text: JSON.stringify(calendars, null, 2) }] };
  },

  async calendarGetEvents(calendarId, timeMin, timeMax, maxResults, pageToken, query) {
    const limit = Math.min(maxResults || 25, 250);
    let url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?maxResults=${limit}&singleEvents=true&orderBy=startTime`;
    if (timeMin) url += `&timeMin=${encodeURIComponent(timeMin)}`;
    if (timeMax) url += `&timeMax=${encodeURIComponent(timeMax)}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    if (query) url += `&q=${encodeURIComponent(query)}`;

    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const data = await response.json();
    const events = (data.items || []).map(e => ({
      id: e.id,
      summary: e.summary,
      description: e.description,
      start: e.start,
      end: e.end,
      location: e.location,
      status: e.status,
      creator: e.creator,
      organizer: e.organizer,
      attendees: (e.attendees || []).map(a => ({ email: a.email, responseStatus: a.responseStatus, displayName: a.displayName })),
      htmlLink: e.htmlLink,
      hangoutLink: e.hangoutLink,
    }));
    return { content: [{ type: "text", text: JSON.stringify({
      nextPageToken: data.nextPageToken || null,
      events,
    }, null, 2) }] };
  },

  async calendarGetEvent(calendarId, eventId) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const response = await runtime.fetch(url);
    if (!response.ok) {
      const error = await response.text();
      return { content: [{ type: "text", text: `API Error: ${error}` }], isError: true };
    }
    const event = await response.json();
    return { content: [{ type: "text", text: JSON.stringify(event, null, 2) }] };
  },
};

