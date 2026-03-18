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
        description: "Download a single embedded image from a Word document by its name. Returns the image as base64 for visual analysis. Get image names from word_get_images.",
        displayMessage: "🖼️ Downloading image: {{imageName}}",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "The item ID" },
            driveId: { type: "string", description: "Optional drive ID for shared files" },
            imageName: { type: "string", description: "Image name from word_get_images (e.g. 'word/media/image1.png')" },
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
        description: "Download embedded image(s) from a PowerPoint presentation. Returns base64 image(s) for visual analysis. Get image names from ppt_read_content output. Pass a single name or comma-separated names.",
        displayMessage: "🖼️ Downloading image: {{imageName}}",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "The item ID" },
            driveId: { type: "string", description: "Optional drive ID for shared files" },
            imageName: { type: "string", description: "Image name(s) from ppt_read_content (e.g. 'ppt/media/image1.png' or 'ppt/media/image1.png,ppt/media/image2.jpg')" },
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
    try {
      switch (name) {
        // OneDrive
        case "onedrive_list": return await this.onedriveList(args);
        case "onedrive_search": return await this.onedriveSearch(args);
        case "onedrive_get_file_metadata": return await this.onedriveGetMetadata(args);
        case "onedrive_download_text": return await this.onedriveDownloadText(args);
        case "onedrive_resolve_link": return await this.onedriveResolveLink(args);
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
  async _resizeImageForLLM(rawBytes, originalMimeType, maxBase64Bytes = 400000) {
    const blob = new Blob([rawBytes], { type: originalMimeType });
    const base64Check = btoa(Array.from(new Uint8Array(rawBytes)).map(b => String.fromCharCode(b)).join(''));

    // If already small enough, return as-is
    if (base64Check.length <= maxBase64Bytes) {
      return { base64: base64Check, mimeType: originalMimeType };
    }

    runtime.console.log(`[_resizeImageForLLM] Image too large (${Math.round(base64Check.length / 1024)}KB base64), resizing...`);

    // Decode image to bitmap
    const bitmap = await createImageBitmap(blob);
    let { width, height } = bitmap;

    // Scale down to fit. Target: sqrt(maxRawBytes / 3) pixels per side as rough heuristic.
    // For 400KB base64 ≈ 300KB raw, sqrt(150000/3) ≈ 223px per side at full quality.
    // We use JPEG at 0.8 quality so we can be more generous: target ~1980px max dimension.
    const maxDim = 1980;
    if (width > maxDim || height > maxDim) {
      const scale = maxDim / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    // Draw to OffscreenCanvas and export as JPEG
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.80 });
    const arrBuf = await outBlob.arrayBuffer();
    const outBytes = new Uint8Array(arrBuf);
    const outBase64 = btoa(Array.from(outBytes).map(b => String.fromCharCode(b)).join(''));

    runtime.console.log(`[_resizeImageForLLM] Resized ${bitmap.width || '?'}x${bitmap.height || '?'} -> ${width}x${height}, ${Math.round(outBase64.length / 1024)}KB base64 JPEG`);
    return { base64: outBase64, mimeType: "image/jpeg" };
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
    // Create empty .xlsx by uploading minimal content
    const data = await this._request("PUT",
      `/me/drive/root:/${filename}:/content`,
      "", // Empty file — Graph creates a valid xlsx
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

  async excelWriteRange({ itemId, worksheet, range, values }) {
    const resolved = await this._resolveWorksheet(itemId, worksheet);
    const wsPath = resolved ? `/worksheets/${encodeURIComponent(resolved)}` : `/worksheets/Sheet1`;
    const path = `/me/drive/items/${itemId}/workbook${wsPath}/range(address='${encodeURIComponent(range)}')`;
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

  async excelClearRange({ itemId, worksheet, range }) {
    const resolved = await this._resolveWorksheet(itemId, worksheet);
    const wsPath = resolved ? `/worksheets/${encodeURIComponent(resolved)}` : `/worksheets/Sheet1`;
    const path = `/me/drive/items/${itemId}/workbook${wsPath}/range(address='${encodeURIComponent(range)}')/clear`;
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
      "",
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
          const ext = name.split('.').pop().toLowerCase();
          const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", tiff: "image/tiff", emf: "image/x-emf", wmf: "image/x-wmf", svg: "image/svg+xml" };
          if (allowedImageNames && !allowedImageNames.has(name)) continue;
          images.push({
            index: images.length,
            name,
            contentType: mimeMap[ext] || `image/${ext}`,
            sizeBytes: uncompSize || 0,
          });
        }
      }
    }

    return { content: [{ type: "text", text: JSON.stringify({ imageCount: images.length, images }, null, 2) }] };
  },

  async wordDownloadImage({ itemId, driveId, imageName }) {
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

    const ext = targetName.split('.').pop().toLowerCase();
    const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", tiff: "image/tiff", emf: "image/x-emf", wmf: "image/x-wmf", svg: "image/svg+xml" };
    const origMimeType = mimeMap[ext] || `image/${ext}`;

    // Resize/compress for LLM context. Raw screenshots can be 2-5MB base64
    // which exceeds most LLM context limits (1M tokens for Gemini, etc.)
    let base64Data, mimeType;
    try {
      const resized = await this._resizeImageForLLM(entry.data, origMimeType);
      base64Data = resized.base64;
      mimeType = resized.mimeType;
    } catch (e) {
      runtime.console.log(`[wordDownloadImage] Resize failed, using raw: ${e.message}`);
      const binary = Array.from(entry.data).map(b => String.fromCharCode(b)).join('');
      base64Data = btoa(binary);
      mimeType = origMimeType;
    }

    return {
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: mimeType, data: base64Data },
        },
        { type: "text", text: `Image '${targetName}' (${mimeType}, ~${Math.round(base64Data.length * 3 / 4 / 1024)} KB)` },
      ]
    };
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
            const ext = t.split('.').pop().toLowerCase();
            const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", tiff: "image/tiff", emf: "image/x-emf", wmf: "image/x-wmf", svg: "image/svg+xml" };
            if (!slideImageMap[slideNum]) slideImageMap[slideNum] = [];
            slideImageMap[slideNum].push({ name: t, sizeBytes: imageSizeMap[t] || 0, contentType: mimeMap[ext] || `image/${ext}` });
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
          const ext = name.split('.').pop().toLowerCase();
          const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", tiff: "image/tiff", emf: "image/x-emf", wmf: "image/x-wmf", svg: "image/svg+xml" };
          images.push({
            index: images.length,
            name,
            contentType: mimeMap[ext] || `image/${ext}`,
            sizeBytes: uncompSize || 0,
          });
        }
      }
    }

    return { content: [{ type: "text", text: JSON.stringify({ imageCount: images.length, images }, null, 2) }] };
  },

  async pptDownloadImage({ itemId, driveId, imageName }) {
    // Support comma-separated image names for batch download
    const names = imageName.includes(',') ? imageName.split(',').map(n => n.trim()).filter(Boolean) : [imageName];
    if (names.length > 1) {
      return await this._pptDownloadMultipleImages(itemId, driveId, names);
    }
    return await this._pptDownloadSingleImage(itemId, driveId, imageName);
  },

  async _pptDownloadMultipleImages(itemId, driveId, names) {
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
      const ext = targetName.split('.').pop().toLowerCase();
      const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", tiff: "image/tiff", emf: "image/x-emf", wmf: "image/x-wmf", svg: "image/svg+xml" };
      const origMimeType = mimeMap[ext] || `image/${ext}`;
      let base64Data, mimeType;
      try {
        const resized = await this._resizeImageForLLM(entry.data, origMimeType);
        base64Data = resized.base64;
        mimeType = resized.mimeType;
      } catch (e) {
        runtime.console.log(`[pptDownloadImage] Resize failed for ${targetName}, using raw: ${e.message}`);
        const binary = Array.from(entry.data).map(b => String.fromCharCode(b)).join('');
        base64Data = btoa(binary);
        mimeType = origMimeType;
      }
      contentBlocks.push({ type: "image", source: { type: "base64", media_type: mimeType, data: base64Data } });
      contentBlocks.push({ type: "text", text: `Image '${targetName}' (${mimeType}, ~${Math.round(base64Data.length * 3 / 4 / 1024)} KB)` });
    }
    return { content: contentBlocks };
  },

  async _pptDownloadSingleImage(itemId, driveId, imageName) {
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

    const ext = targetName.split('.').pop().toLowerCase();
    const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", tiff: "image/tiff", emf: "image/x-emf", wmf: "image/x-wmf", svg: "image/svg+xml" };
    const origMimeType = mimeMap[ext] || `image/${ext}`;

    let base64Data, mimeType;
    try {
      const resized = await this._resizeImageForLLM(entry.data, origMimeType);
      base64Data = resized.base64;
      mimeType = resized.mimeType;
    } catch (e) {
      runtime.console.log(`[pptDownloadImage] Resize failed, using raw: ${e.message}`);
      const binary = Array.from(entry.data).map(b => String.fromCharCode(b)).join('');
      base64Data = btoa(binary);
      mimeType = origMimeType;
    }

    return {
      content: [
        { type: "image", source: { type: "base64", media_type: mimeType, data: base64Data } },
        { type: "text", text: `Image '${targetName}' (${mimeType}, ~${Math.round(base64Data.length * 3 / 4 / 1024)} KB)` },
      ]
    };
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
