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

function configurePdfJs(lib) {
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
    let result;
    try {
      result = await runtime.evaluateScript(`
        const embed = document.querySelector('embed[type="application/pdf"]');
        if (embed) return { url: embed.src || window.location.href };
        return { url: window.location.href };
      `, {}, "MAIN");
    } catch (err) {
      throw new Error(
        "Could not access the active tab's DOM. This usually happens because the tab is a native Chrome PDF viewer or a file:// URL where scripts are blocked. " +
        "Fallback: Use the 'url' parameter instead and provide the document's explicit URL (you can find it in your context stack)."
      );
    }

    if (!result?.url) throw new Error("Could not detect PDF in active tab");

    const response = await runtime.fetch(result.url, { skipAuth: true });
    if (!response.ok) throw new Error(`Failed to fetch tab PDF: ${response.status}`);
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
  PDF_HANDLES.set(handleId, { doc, metadata, url: source.url || null });

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

async function renderPageToImage(doc, pageNum, scale) {
  const page = await doc.getPage(pageNum);
  // Reduce default scale to 1.0 to massively speed up rendering and reduce payload size
  let viewport = page.getViewport({ scale: scale || 1.0 });

  // Cap max dimension to 1200px to keep base64 output within LLM context limits.
  // A 1200px JPEG at 0.85 quality is typically 50-150KB base64 — well within bounds.
  const maxDim = 1980;
  if (viewport.width > maxDim || viewport.height > maxDim) {
    const capScale = (scale || 1.0) * maxDim / Math.max(viewport.width, viewport.height);
    viewport = page.getViewport({ scale: capScale });
  }

  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");

  // Fill white background for JPEG (otherwise transparent pixels turn black)
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  // JPEG encoding is hardware-accelerated and substantially faster than PNG
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  const base64 = dataUrl.split(",")[1];

  canvas.width = 0;
  canvas.height = 0;

  return base64;
}

async function readPages(handleId, pages, renderScale, renderImages = false) {
  const { doc, metadata } = getHandle(handleId);
  const totalPages = metadata.pageCount;

  if (!pages || pages.length === 0) {
    pages = [1];
  }
  pages = pages.filter(p => p >= 1 && p <= totalPages);

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

        if (renderImages) {
          const visual = await pageHasVisualContent(doc, pageNum, text);
          pageResult.hasImages = visual.hasImages;
          pageResult.imageCount = visual.imageCount;

          if (visual.shouldRenderImage) {
            pageResult.image = await renderPageToImage(doc, pageNum, renderScale);
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

  return { totalPages, returnedPages: results.length, pages: results };
}

async function searchPdf(handleId, query, maxResults) {
  const { doc, metadata } = getHandle(handleId);
  const totalPages = metadata.pageCount;
  const limit = maxResults || 20;
  const queryLower = query.toLowerCase();

  const matches = [];

  for (let pageNum = 1; pageNum <= totalPages && matches.length < limit; pageNum++) {
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

  return { query, totalPages, matchCount: matches.length, matches };
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
        description: "Read pages from a loaded PDF. Returns text for every page. Can optionally return base64 JPEG images for pages with visual content if renderImages is true (warning: slow). Defaults to page 1. Use pdf_search on large docs to find relevant pages first.",
        displayMessage: "📖 Reading PDF pages {{pages|default:1}}",
        inputSchema: {
          type: "object",
          properties: {
            handle: { type: "string", description: "PDF handle from pdf_load" },
            pages: { type: "array", items: { type: "number" }, description: "1-based page numbers (default: [1])" },
            renderScale: { type: "number", description: "Image scale factor (default: 1.0)" },
            renderImages: { type: "boolean", description: "If true, extracts and renders images to base64. CPU-intensive and slow on main thread. (default: false)" },
          },
          required: ["handle"],
        },
      },
      {
        name: "pdf_search",
        description: "Full-text search across all pages. Returns page numbers and text snippets. Use on large docs before pdf_read.",
        displayMessage: '🔍 Searching PDF for "{{query}}"',
        inputSchema: {
          type: "object",
          properties: {
            handle: { type: "string", description: "PDF handle from pdf_load" },
            query: { type: "string", description: "Search text (case-insensitive)" },
            maxResults: { type: "number", description: "Max matches (default: 20)" },
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
          const result = await readPages(args.handle, args.pages, args.renderScale, args.renderImages);
          const content = [];

          content.push({ type: "text", text: JSON.stringify({
            totalPages: result.totalPages,
            returnedPages: result.returnedPages,
            pages: result.pages.map(p => ({
              page: p.page, textLength: (p.text || "").length,
              hasImages: p.hasImages || false, imageCount: p.imageCount || 0, imageIncluded: !!p.image,
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

        case "pdf_search": {
          const result = await searchPdf(args.handle, args.query, args.maxResults);
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
