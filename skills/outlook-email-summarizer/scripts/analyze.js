// scripts/analyze.js — Outlook Email Summarizer
// Parallels the Gmail email-summarizer skill but targets Microsoft 365 Outlook.
async function run() {

  if (typeof args === "undefined" || args === null || !Array.isArray(args) || args.length === 0) {
    return { success: false, error: "URL or messageId is required as the first argument." };
  }

  let input = String(args[0]);
  if (input === "") {
    return { success: false, error: "Input argument is empty." };
  }

  let messageId = input;

  // ── Step 1: Extract/resolve Message ID ──────────────────────────
  // Outlook Web URLs look like:
  //   https://outlook.live.com/mail/0/inbox/id/AQMkAD...
  //   https://outlook.office.com/mail/inbox/id/AAMkAG...
  //   https://outlook.live.com/mail/0/id/AQMkAD...
  // The API message ID is the path segment after /id/
  const idMatch = input.match(/\/id\/([A-Za-z0-9%+\-_=]+)/);
  if (idMatch) {
    messageId = decodeURIComponent(String(idMatch[1]));
    console.log(`Extracted message ID from URL: ${messageId}`);
  }

  console.log("Loading required skills (microsoft-365, pdf)...");
  try {
    await tools.readSkill({ name: "microsoft-365" });
    await tools.readSkill({ name: "pdf" });
  } catch (e) {
    console.error("Failed to load skills:", e);
  }

  // Wait for dynamic MCP servers to register
  let retries = 5;
  while (typeof tools.outlook_get_message !== "function" && retries > 0) {
    await tools.sleep(500);
    retries--;
  }

  if (typeof tools.outlook_get_message !== "function") {
    return { success: false, error: "Required Microsoft 365 tools failed to register." };
  }

  // The Outlook Web URL /id/ segment is NOT a Graph /me/messages/{id} value:
  //   - Graph message IDs start with "AAMk" or "AQMk".
  //   - "AQQk" is a conversation/OWA id — invalid for /me/messages/{id}.
  // The OWA tab title is the generic mailbox name ("Mail - <user> - Outlook"),
  // not the subject, so it can't be used to resolve the message either.
  // Instead, resolve from the message that is actually open in the reading pane:
  // read its subject + sender off the page, search Graph, and ONLY accept a result
  // whose subject is literally visible on the page. Never guess "most recent".
  const isConversationId = messageId.startsWith("AQQk");
  const isLikelyMessageId = (messageId.startsWith("AAMk") || messageId.startsWith("AQMk")) && !isConversationId;
  if (!isLikelyMessageId) {
    console.log("URL exposes a conversation/OWA id, not a Graph message id. Resolving from the open reading pane...");
    let resolved = false;

    // ── Extract subject + sender candidates from the currently open message ──
    let pageText = "";
    let candidateSubject = "";
    const pageEmails = [];
    if (typeof tools.getPageContext === "function") {
      try {
        const ctxRes = await tools.getPageContext({});
        // getPageContext may return {readable,...} directly or wrapped as MCP {content:[{text}]}.
        let ctx = ctxRes;
        if (ctxRes && Array.isArray(ctxRes.content) && ctxRes.content[0] && typeof ctxRes.content[0].text === "string") {
          try { ctx = JSON.parse(String(ctxRes.content[0].text)); } catch (_) { ctx = ctxRes; }
        }
        pageText = String((ctx && ctx.readable) || "");

        // All email addresses on the page (unique, in order) — used as from: candidates.
        const emailRe = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
        let em;
        while ((em = emailRe.exec(pageText)) !== null) {
          if (!pageEmails.includes(em[0])) pageEmails.push(em[0]);
        }

        // Subject candidate: first non-trivial heading line ("# ...") in the readable text.
        const heading = pageText.split("\n").map(l => l.trim())
          .find(l => l.startsWith("#") && l.replace(/^#+\s*/, "").length > 2);
        if (heading) candidateSubject = heading.replace(/^#+\s*/, "").trim();

        // If readable text didn't give a heading, try searching the DOM directly
        if (!candidateSubject && typeof tools.searchDom === "function") {
          try {
            const domRes = await tools.searchDom('[id$="_SUBJECT"][role="heading"]');
            if (domRes && domRes.matches && domRes.matches.length > 0) {
              const validMatch = domRes.matches.find(m => m.text && m.text.trim().length > 0);
              if (validMatch) candidateSubject = validMatch.text.trim();
            }
          } catch (e) {
            console.log(`DOM subject extraction failed: ${String(e)}`);
          }
        }

        console.log(`Reading pane → subject candidate: "${candidateSubject}", emails: [${pageEmails.join(", ")}]`);
      } catch (e) {
        console.log(`Reading-pane extraction failed: ${String(e)}`);
      }
    }

    // Normalizer + validator: a result is only acceptable if its subject appears on the page.
    const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const pageNorm = norm(pageText);
    const pickValidated = (messages) => {
      const list = Array.isArray(messages) ? messages : [];
      const confirmed = list.filter(m => m.subject && pageNorm.includes(norm(m.subject)));
      if (confirmed.length > 0) {
        // Most recent among page-confirmed matches (handles same-subject threads).
        return confirmed.slice().sort(
          (a, b) => String(b.receivedDateTime || "").localeCompare(String(a.receivedDateTime || ""))
        )[0];
      }
      // Only trust an unvalidated result when the search was unambiguous.
      return list.length === 1 ? list[0] : null;
    };

    const runSearch = async (query) => {
      const res = await tools.outlook_search({ query, maxResults: 25 });
      if (!res || res.isError) return [];
      try {
        const data = JSON.parse(String(res.content[0].text));
        return Array.isArray(data.messages) ? data.messages : [];
      } catch (_) { return []; }
    };

    // Build queries in priority order. Subject is the strongest identifier (and we
    // validate it against the page); sender addresses are the fallback filter.
    const queries = [];
    if (candidateSubject && pageEmails[0]) queries.push(`subject:"${candidateSubject}" from:${pageEmails[0]}`);
    if (candidateSubject) queries.push(`subject:"${candidateSubject}"`);
    for (const addr of pageEmails.slice(0, 3)) queries.push(`from:${addr}`);

    // Only accept a search result whose subject actually corresponds to the
    // subject read off the page. Never fall back to "the single result" — a
    // lone unrelated hit would silently summarize the wrong email. Also require
    // a non-empty candidate subject, otherwise norm("").includes-style matching
    // would treat every result as a match. If nothing validates, we fail below.
    const cand = norm(candidateSubject);
    for (const q of queries) {
      console.log(`Searching Outlook: ${q}`);
      const results = await runSearch(q);
      const picked =
        cand === ""
          ? null
          : results.find((m) => {
              const s = norm(m.subject);
              return s !== "" && (s.includes(cand) || cand.includes(s));
            }) || null;

      if (picked) {
        messageId = String(picked.id);
        console.log(`Resolved to message ID: ${messageId} (subject: "${picked.subject}")`);
        resolved = true;
        break;
      }
    }

    if (!resolved) {
      return {
        success: false,
        error: "Could not resolve the Graph message id for the open email. The Outlook URL only " +
          "carries a conversation id, and no search result matched the message shown in the reading pane" +
          (candidateSubject || pageEmails.length
            ? ` (tried subject: "${candidateSubject}", from: [${pageEmails.slice(0, 3).join(", ")}]).`
            : " (no subject or sender could be read from the page).") +
          " Open the specific message in its own view and retry, or pass an explicit Graph message id " +
          "(AAMk…/AQMk…) as the argument.",
      };
    }
  }

  // ── Step 2: Fetch the email ─────────────────────────────────────
  console.log(`Fetching email: ${messageId}`);
  const msgRes = await tools.outlook_get_message({ messageId });
  if (msgRes.isError) {
    return { success: false, error: String(msgRes.content[0].text) };
  }

  const msg = JSON.parse(String(msgRes.content[0].text));
  const fromStr = msg.from
    ? `${msg.from.name || ""} <${msg.from.address || ""}>`.trim()
    : "Unknown";
  const toStr = Array.isArray(msg.to)
    ? msg.to.map(r => `${r.name || ""} <${r.address || ""}>`.trim()).join(", ")
    : "Unknown";
  let summaryText = `Subject: ${String(msg.subject || "(no subject)")}\nFrom: ${fromStr}\nTo: ${toStr}\nDate: ${String(msg.receivedDateTime || "")}\n\n--- Body ---\n${String(msg.body || "")}\n\n--- Attachments ---\n`;

  // Extract the finished text from a runSubtask result. content[0].text is a
  // JSON string ({content, history}), not the summary itself, so parse it out;
  // fall back to the last non-empty assistant turn, and handle truncation.
  // ── Attachment / image helpers ──────────────────────────────────
  // Kept inline rather than imported: skill scripts run standalone in the
  // sandbox, so a shared module would have to be resolvable at run time.
  // If that becomes possible, this block and the identical one in the other
  // summarizer script should move out together.

  // What the vision endpoint will actually accept. Anything else has to be
  // transcoded before it is sent, however the attachment was labelled.
  const VISION_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  const MAX_IMAGE_BASE64 = 400000; // ~300KB of bytes, ~100K tokens
  const MAX_IMAGE_DIM = 1280;

  const b64ToBytes = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  const bytesToB64 = (bytes) => {
    let bin = "";
    const CHUNK = 0x8000; // avoid blowing the argument limit on large buffers
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  };

  // Identify an image from its bytes, never from the filename or the sender's
  // Content-Type header. A .png that is really an AVIF is not a rare accident:
  // phones and screenshot tools re-encode, and mail clients keep the old
  // extension. Believing the label is what makes the loader fail with an
  // unrelated-sounding error.
  const sniffImageMime = (bytes) => {
    const at = (i, sig) => sig.every((b, k) => bytes[i + k] === b);
    if (bytes.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
    if (bytes.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
    if (bytes.length >= 6 && at(0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
    if (bytes.length >= 2 && at(0, [0x42, 0x4d])) return "image/bmp";
    if (bytes.length >= 4 && (at(0, [0x49, 0x49, 0x2a, 0x00]) || at(0, [0x4d, 0x4d, 0x00, 0x2a]))) {
      return "image/tiff";
    }
    if (bytes.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) {
      return "image/webp";
    }
    // ISO base media format: the brand lives at offset 8, after 'ftyp'.
    if (bytes.length >= 12 && at(4, [0x66, 0x74, 0x79, 0x70])) {
      const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
      if (brand === "avif" || brand === "avis") return "image/avif";
      if (brand === "heic" || brand === "heix" || brand === "hevc" || brand === "mif1" || brand === "msf1") {
        return "image/heic";
      }
    }
    return null;
  };

  // Return an image the vision endpoint can actually read, or an explanation of
  // why it cannot. Three things happen here that did not before: the bytes
  // decide the type, unsupported formats are transcoded rather than sent to
  // fail, and the payload is bounded so one phone photo cannot swallow the
  // subtask's context.
  const prepareImageForVision = async (base64, declaredMime, filename) => {
    let bytes;
    try {
      bytes = b64ToBytes(base64);
    } catch (e) {
      return { error: `attachment data was not valid base64 (${String(e.message)})` };
    }

    const sniffed = sniffImageMime(bytes);
    const actual = sniffed || String(declaredMime || "").toLowerCase();
    const notes = [];
    if (sniffed && declaredMime && sniffed !== String(declaredMime).toLowerCase()) {
      notes.push(`declared ${declaredMime}, actually ${sniffed}`);
    }
    if (!sniffed) {
      notes.push(`format not recognized from bytes, trusting declared ${declaredMime}`);
    }

    const supported = VISION_MIMES.indexOf(actual) !== -1;
    if (supported && base64.length <= MAX_IMAGE_BASE64) {
      return { base64, mimeType: actual, note: notes.join("; ") };
    }

    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
      if (supported) return { base64, mimeType: actual, note: notes.join("; ") };
      return {
        error: `"${filename}" is ${actual}, which the vision endpoint does not accept, ` +
          `and no image decoder is available in this context to convert it`,
      };
    }

    try {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: actual }));
      let width = bitmap.width;
      let height = bitmap.height;
      if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
        const fit = MAX_IMAGE_DIM / Math.max(width, height);
        width = Math.max(1, Math.round(width * fit));
        height = Math.max(1, Math.round(height * fit));
      }

      // Back off quality, then dimensions, until the payload fits.
      let quality = 0.8;
      let outB64;
      for (;;) {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(bitmap, 0, 0, width, height);
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
        outB64 = bytesToB64(new Uint8Array(await blob.arrayBuffer()));
        if (outB64.length <= MAX_IMAGE_BASE64 || quality <= 0.2) break;
        quality -= 0.1;
        if (quality < 0.5) {
          width = Math.max(1, Math.round(width * 0.75));
          height = Math.max(1, Math.round(height * 0.75));
          quality = 0.7;
        }
      }
      bitmap.close();
      notes.push(`transcoded to JPEG at ${width}x${height}`);
      return { base64: outB64, mimeType: "image/jpeg", note: notes.join("; ") };
    } catch (e) {
      return {
        error: `"${filename}" is ${actual} and could not be decoded for vision ` +
          `(${String(e.message)}). ${sniffed && sniffed !== declaredMime
            ? `Note the file is named for ${declaredMime} but its bytes are ${sniffed}.`
            : ""}`.trim(),
      };
    }
  };

  // Find the block carrying the raw payload instead of indexing content[1].
  // Tools are free to reorder blocks or return only one; a positional read
  // turns that into a confusing "could not download" further down.
  const readAttachmentBase64 = (attRes) => {
    const blocks = attRes && Array.isArray(attRes.content) ? attRes.content : [];
    for (const block of blocks) {
      if (!block || typeof block.text !== "string") continue;
      try {
        const parsed = JSON.parse(block.text);
        if (typeof parsed.base64 === "string" && parsed.base64 !== "") return parsed.base64;
      } catch (_) { /* not the JSON block */ }
    }
    return null;
  };

  // A subtask can report isError:false while its text is an error message —
  // "Loop terminated: Failed to load image or audio file" was written into a
  // summary under an "Image Description:" heading, where the reading model had
  // no way to tell it from a finding. Screen for that before presenting it.
  const SUBTASK_FAILURE_MARKERS = [
    "loop terminated",
    "failed to load image",
    "failed to load audio",
    "max iterations",
    "maximum iterations",
    "timed out",
    "timeout exceeded",
    "[... output truncated",
    "(subtask returned empty",
  ];

  const screenSubtaskText = (text) => {
    const t = String(text || "").trim();
    if (t === "") return { ok: false, reason: "subtask returned no text" };
    const low = t.toLowerCase();
    for (const marker of SUBTASK_FAILURE_MARKERS) {
      if (low.indexOf(marker) !== -1) {
        return { ok: false, reason: t.slice(0, 200) };
      }
    }
    return { ok: true, text: t };
  };

  const extractSubtaskText = (subtask) => {
    if (!subtask || subtask.isError) {
      const err =
        subtask && subtask.content && subtask.content[0]
          ? String(subtask.content[0].text)
          : "unknown error";
      return { ok: false, reason: err };
    }
    let text = String(subtask.content[0].text);
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.content === "string") text = parsed.content;
      if (text === "" && Array.isArray(parsed.history)) {
        const last = parsed.history
          .slice()
          .reverse()
          .find(
            (m) =>
              m.role === "assistant" &&
              typeof m.content === "string" &&
              m.content.trim() !== "",
          );
        if (last) text = last.content;
      }
    } catch (_) { /* not JSON: use the raw text and let the screen catch it */ }
    // Returning a bare string meant a failure message was written into the
    // summary under a "Description:" heading, where the reading model had no
    // way to tell it from a finding. Screen it and report the difference.
    return screenSubtaskText(text);
  };


  // ── Step 3: Detect OneDrive/SharePoint links in body ────────────
  const oneDriveLinks = [];
  const linkRegex = /https:\/\/(?:1drv\.ms\/[a-z]\/[^\s"<>]+|onedrive\.live\.com\/[^\s"<>]+|[a-z0-9-]+(?:-my)?\.sharepoint\.com\/[^\s"<>]+|(?:[a-z0-9-]+\.)?(?:microsoft365\.com|cloud\.microsoft)\/[^\s"<>]+)/gi;
  let linkMatch;
  const bodyForLinks = String(msg.body || "");
  const seenUrls = new Set();
  while ((linkMatch = linkRegex.exec(bodyForLinks)) !== null) {
    const url = String(linkMatch[0]);
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      oneDriveLinks.push(url);
    }
  }

  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  if (attachments.length === 0 && oneDriveLinks.length === 0) {
    summaryText += "No attachments found.\n";
  }

  // ── Step 4: Process file attachments ────────────────────────────
  for (const att of attachments) {
    // Skip inline images (embedded in HTML body, e.g. signatures, tracking pixels)
    if (att.isInline === true) {
      console.log(`Skipping inline attachment: ${att.name || "unnamed"}`);
      continue;
    }

    const filename = String(att.name || "unnamed");
    const contentType = String(att.contentType || "");
    const attachmentId = String(att.id);
    summaryText += `\n[Attachment: ${filename} (${contentType}, ${att.size} bytes)]\n`;

    // ── PDF ──
    if (contentType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
      console.log(`Processing PDF: ${filename}`);
      let handle = null;
      try {
        const attRes = await tools.outlook_get_attachment({
          messageId,
          attachmentId,
          returnRawBase64: true,
        });

        if (attRes.isError) {
          summaryText += `Error fetching PDF: ${String(attRes.content[0].text)}\n`;
          continue;
        }

        const base64 = readAttachmentBase64(attRes);
        if (base64 === null) {
          summaryText += `Error processing PDF: the attachment tool returned no base64 payload.\n`;
          continue;
        }

        console.log("Loading PDF into memory...");
        const loadRes = await tools.pdf_load({ base64 });
        if (loadRes.isError) throw new Error(String(loadRes.content[0].text));

        const handleData = JSON.parse(String(loadRes.content[0].text));
        handle = String(handleData.handle);

        console.log(`PDF loaded (${handle}). Delegating summary to subtask...`);
        const subtaskRes = await tools.runSubtask({
          goal: `Read the PDF document with handle '${handle}' using the pdf_read tool. After reading, you MUST generate a final text response containing a comprehensive summary. Do NOT finish the task without writing the summary.`,
          verification_command: `pdf_read with handle '${handle}' returns content`,
          timeoutMs: 240000,
        });

        const pdfSummary = extractSubtaskText(subtaskRes);
        summaryText += pdfSummary.ok
          ? `PDF Summary:\n${pdfSummary.text}\n`
          : `PDF Summary UNAVAILABLE — the subtask did not produce one: ${pdfSummary.reason}\n`;
      } catch (e) {
        summaryText += `Error processing PDF: ${String(e.message)}\n`;
      } finally {
        // Release in finally: a throw anywhere above used to leak the handle.
        if (handle !== null) {
          console.log("Releasing PDF handle...");
          try { await tools.pdf_release({ handle }); } catch (_) { /* best effort */ }
        }
      }

    // ── Image ──
    } else if (contentType.startsWith("image/")) {
      console.log(`Processing image attachment: ${filename}`);
      try {
        const attRes = await tools.outlook_get_attachment({
          messageId,
          attachmentId,
          returnRawBase64: true,
        });

        const rawBase64 = attRes && !attRes.isError ? readAttachmentBase64(attRes) : null;
        if (rawBase64 === null) {
          summaryText += `(Could not download image "${filename}")\n`;
          continue;
        }

        // Decide the format from the bytes and convert if the vision endpoint
        // cannot read it. Sending the declared contentType is what produced
        // "Loop terminated: Failed to load image" for a .png that was AVIF.
        const prepared = await prepareImageForVision(rawBase64, contentType, filename);
        if (prepared.error) {
          summaryText += `Image NOT analyzed — ${prepared.error}\n`;
          continue;
        }
        if (prepared.note) {
          console.log(`Image "${filename}": ${prepared.note}`);
          summaryText += `(Image note: ${prepared.note})\n`;
        }

        console.log(`Delegating image "${filename}" to subtask for visual analysis (using vision)...`);
        const subtaskRes = await tools.runSubtask({
          goal: `Describe the image "${filename}" in detail. The image is provided inline for your visual analysis.`,
          verification_command: "Image is described",
          image_data: [
            { base64: prepared.base64, mimeType: prepared.mimeType, filename: filename },
          ],
          timeoutMs: 120000,
        });

        const imgDesc = extractSubtaskText(subtaskRes);
        summaryText += imgDesc.ok
          ? `Image Description:\n${imgDesc.text}\n`
          : `Image NOT described — the subtask reported: ${imgDesc.reason}\n`;
      } catch (e) {
        summaryText += `(Error downloading image "${filename}": ${String(e.message)})\n`;
      }

    // ── Office documents (Word, Excel, PowerPoint) ──
    } else if (
      contentType.includes("wordprocessingml") ||
      contentType.includes("spreadsheetml") ||
      contentType.includes("presentationml")
    ) {
      console.log(`Processing Office attachment: ${filename}`);
      // Office attachments need to be saved to OneDrive first, then read via the API.
      // Delegate to a subtask that can orchestrate the multi-step process.
      try {
        console.log(`Delegating Office document "${filename}" to subtask...`);
        let docType = "document";
        let readInstructions = "";
        if (contentType.includes("wordprocessingml")) {
          readInstructions = `This is a Word document. After saving, use word_read_content with the new itemId to read its text.`;
        } else if (contentType.includes("spreadsheetml")) {
          docType = "spreadsheet";
          readInstructions = `This is an Excel spreadsheet. After saving, use excel_get_metadata to find sheets, then excel_read_as_csv to read the data.`;
        } else if (contentType.includes("presentationml")) {
          docType = "presentation";
          readInstructions = `This is a PowerPoint presentation. After saving, use ppt_read_content to read slide text.`;
        }

        const subtaskRes = await tools.runSubtask({
          goal: `Download the ${docType} attachment "${filename}" from Outlook message "${messageId}" (attachment ID: "${attachmentId}") using outlook_get_attachment with returnRawBase64: true. The file is already an email attachment — you do NOT need to search for it. ${readInstructions} After reading, generate a comprehensive summary of the content. Do NOT finish without writing the summary.`,
          verification_command: `${docType} content is returned and summarized`,
          timeoutMs: 240000,
        });

        if (subtaskRes && !subtaskRes.isError) {
          const docSummary = extractSubtaskText(subtaskRes);
          const docLabel = docType.charAt(0).toUpperCase() + docType.slice(1);
          summaryText += docSummary.ok
            ? `${docLabel} Summary:\n${docSummary.text}\n`
            : `${docLabel} NOT summarized — the subtask reported: ${docSummary.reason}\n`;
        } else {
          summaryText += `(Subtask failed to process ${docType} "${filename}")\n`;
        }
      } catch (e) {
        summaryText += `(Error processing Office document "${filename}": ${String(e.message)})\n`;
      }

    // ── Other files ──
    } else {
      summaryText += `(File type ${contentType} not automatically parsed. Attachment ID: ${attachmentId})\n`;
    }
  }

  // ── Step 5: Process OneDrive/SharePoint links in body ───────────
  if (oneDriveLinks.length > 0) {
    summaryText += `\n--- Linked OneDrive/SharePoint Files ---\n`;
    for (const link of oneDriveLinks) {
      summaryText += `Link: ${link}\n`;
      console.log(`Delegating linked file "${link}" to subtask...`);
      try {
        const subtaskRes = await tools.runSubtask({
          goal: `Access the external shared link: "${link}".\n1. First, use 'onedrive_resolve_link' to convert this URL into an itemId and driveId.\n2. If successful, use the appropriate API tool to read the content (e.g., 'word_read_content', 'excel_read_as_csv', 'ppt_read_content', or 'onedrive_download_text') using the returned itemId and driveId.\n3. If the resolve fails or the API read fails (often due to external tenant permissions), fallback to the browser: use 'newPage' to open the URL.\n4. Wait for the page or Office Online viewer to load.\n5. Use 'takeSnapshot' (mode: 'readable') to extract text.\n6. If text extraction fails (e.g., canvas viewer), use 'takeScreenshot' to analyze it visually.\n7. Generate a comprehensive summary. Do NOT finish without writing the summary.`,
          verification_command: `Summary is generated from the shared link content`,
          timeoutMs: 300000,
        });

        if (subtaskRes && subtaskRes.isError === false) {
          const linkSummary = extractSubtaskText(subtaskRes);
          summaryText += linkSummary.ok
            ? `Linked File Summary:\n${linkSummary.text}\n`
            : `Linked file NOT summarized — the subtask reported: ${linkSummary.reason}\n`;
        } else {
          summaryText += `(Subtask failed to process link "${link}")\n`;
        }
      } catch (e) {
        summaryText += `(Error processing link "${link}": ${String(e.message)})\n`;
      }
    }
  }

  // ── Build result ────────────────────────────────────────────────
  return { success: true, analysis: summaryText };
}

return run();
