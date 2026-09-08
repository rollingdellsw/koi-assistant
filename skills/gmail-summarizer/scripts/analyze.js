// scripts/analyze.js
async function run() {
  if (typeof args === "undefined" || args === null || Array.isArray(args) === false || args.length === 0) {
    return { success: false, error: "URL or messageId is required as the first argument." };
  }

  let input = String(args[0]);
  if (input === "") {
    return { success: false, error: "Input argument is empty." };
  }

  let messageId = input;

  // Extract ID if a full URL was passed
  if (input.includes("mail.google.com") && input.includes("#")) {
    const parts = input.split("/");
    messageId = String(parts[parts.length - 1].split("?")[0]);
    console.log(`Extracted ID from URL: ${messageId}`);
  } else if (input.includes("inbox/") === true || input.includes("#inbox/") === true) {
    const parts = input.split(/inbox\//);
    const lastPart = String(parts[parts.length - 1]);
    messageId = String(lastPart.split("?")[0]);
    console.log(`Extracted ID from URL: ${messageId}`);
  }

  console.log("Loading required skills (google-workspace, pdf)...");
  try {
    await tools.readSkill({ name: "google-workspace" });
    await tools.readSkill({ name: "pdf" });
  } catch (e) {
    console.error("Failed to load skills:", e);
  }

  // Wait for dynamic MCP servers to register
  let retries = 5;
  while (typeof tools.gmail_get_message !== "function" && retries > 0) {
    await tools.sleep(500);
    retries--;
  }

  if (typeof tools.gmail_get_message !== "function") {
    return { success: false, error: "Required Workspace tools failed to register." };
  }

  // Resolve Gmail UI Hash to actual API Message ID
  // URL hashes are NOT Gmail API IDs - must resolve via DOM or subject search
  if (messageId.length > 20) {
    console.log(`URL hash detected (not a Gmail API ID): ${messageId}. Resolving...`);
    let resolved = false;

    // Helper to search DOM for legacy ID
    const findLegacyId = async () => {
      if (typeof tools.searchDom === "function") {
        try {
          const domSearch = await tools.searchDom('[data-legacy-message-id]');
          if (domSearch && domSearch.count > 0) {
            const selector = domSearch.matches[0].selector;
            const details = await tools.inspectElement(selector);
            const legacyId = details.attributes?.['data-legacy-message-id'];
            if (legacyId) {
              return String(legacyId);
            }
          }
        } catch (e) {
          console.log(`DOM search failed: ${String(e)}`);
        }
      }
      return null;
    };

    // 1. Try on current active tab
    console.log("Searching DOM for data-legacy-message-id attribute on active tab...");
    const legacyId1 = await findLegacyId();
    if (legacyId1) {
      messageId = legacyId1;
      console.log(`Resolved via DOM data-legacy-message-id: ${messageId}`);
      resolved = true;
    }

    // 2. If not found, look for a tab whose URL contains the hash and switch to it
    if (resolved === false && typeof tools.listPages === "function") {
      console.log("Not found in current tab. Searching other tabs...");
      try {
        const pagesRes = await tools.listPages({});
        if (pagesRes !== null && pagesRes !== undefined && pagesRes.isError === false) {
          const pagesData = JSON.parse(String(pagesRes.content[0].text));
          const targetTab = pagesData.find(p => typeof p.url === "string" && p.url.includes(messageId));
          
          if (targetTab !== undefined && targetTab.id) {
            console.log(`Found tab ${targetTab.id} with URL containing hash. Switching to it...`);
            const selectRes = await tools.selectPage({ pageId: targetTab.id });
            
            if (selectRes && !selectRes.isError) {
              await tools.sleep(500); // Wait for context to settle
              console.log("Searching DOM again on the newly selected tab...");
              const legacyId2 = await findLegacyId();
              if (legacyId2) {
                messageId = legacyId2;
                console.log(`Resolved via DOM data-legacy-message-id after tab switch: ${messageId}`);
                resolved = true;
              }
            }
          }
        }
      } catch (e) {
        console.log(`Tab search/switch failed: ${String(e)}`);
      }
    }

    // 3. Fallback: Extract subject from tab title, search Gmail API
    if (resolved === false && typeof tools.listPages === "function") {
      console.log("DOM attribute not found. Falling back to tab title search...");
      try {
        const pagesRes = await tools.listPages({});
        if (pagesRes !== null && pagesRes !== undefined && pagesRes.isError === false) {
          const pagesData = JSON.parse(String(pagesRes.content[0].text));
          const currentTab = pagesData.find(p => typeof p.url === "string" && p.url.includes(messageId));
          if (currentTab !== undefined && typeof currentTab.title === "string") {
            const titleParts = currentTab.title.split(" - ");
            if (titleParts.length > 0) {
              const subject = String(titleParts[0]).trim();
              console.log(`Extracted subject: "${subject}". Searching Gmail API...`);
              const searchRes = await tools.gmail_search({ query: `subject:"${subject}" in:anywhere`, maxResults: 1 });
              if (searchRes !== null && searchRes !== undefined && searchRes.isError === false) {
                const searchData = JSON.parse(String(searchRes.content[0].text));
                const messages = Array.isArray(searchData.messages) ? searchData.messages : [];
                if (messages.length > 0) {
                  messageId = String(messages[0].id);
                  console.log(`Resolved via subject search: ${messageId}`);
                  resolved = true;
                }
              }
            }
          }
        }
      } catch (e) {
        console.log(`Tab title resolution failed: ${String(e)}`);
      }
    }

    if (resolved === false) {
      return { success: false, error: "Could not resolve Gmail URL hash to API Message ID. Try passing the email subject instead." };
    }
  }

  console.log(`Fetching email: ${messageId}`);
  const msgRes = await tools.gmail_get_message({ messageId, format: "full" });
  if (msgRes.isError === true) {
    return { success: false, error: String(msgRes.content[0].text) };
  }

  const msg = JSON.parse(String(msgRes.content[0].text));
  let summaryText = `Subject: ${String(msg.subject)}\nFrom: ${String(msg.from)}\nDate: ${String(msg.date)}\n\n--- Email Body ---\n${String(msg.body)}\n\n--- Attachments ---\n`;

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

  // Extract the finished text from a runSubtask result. content[0].text is a
  // JSON string ({content, history}), not the summary itself, so parse it out;
  // fall back to the last non-empty assistant turn. There were three inline
  // copies of this; the Outlook summarizer already factored it out.
  const extractSubtaskText = (subtask) => {
    if (!subtask || subtask.isError) {
      const err = subtask && subtask.content && subtask.content[0]
        ? String(subtask.content[0].text) : "unknown error";
      return { ok: false, reason: err };
    }
    let text = String(subtask.content[0].text);
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.content === "string") text = parsed.content;
      if (text === "" && Array.isArray(parsed.history)) {
        const last = parsed.history.slice().reverse().find(
          (m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim() !== ""
        );
        if (last) text = last.content;
      }
    } catch (_) { /* not JSON: use the raw text and let the screen catch it */ }
    return screenSubtaskText(text);
  };

  // ── Detect Google Drive / Docs links in the body ────────────────
  // Files "attached" from Drive are not MIME attachments — Gmail rewrites them
  // as links, so the attachment loop below never sees them. The Outlook
  // summarizer has had this pass for OneDrive/SharePoint; Gmail had nothing,
  // which is why Drive links were silently dropped from every summary.
  const driveLinkRegex = /https:\/\/(?:drive\.google\.com\/(?:file\/d\/[A-Za-z0-9_-]+|open\?id=[A-Za-z0-9_-]+|drive\/folders\/[A-Za-z0-9_-]+)|docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/[A-Za-z0-9_-]+)[^\s"'<>)]*/gi;
  const bodyForLinks = String(msg.body || "");
  const driveLinks = [];
  let linkMatch;
  while ((linkMatch = driveLinkRegex.exec(bodyForLinks)) !== null) {
    const url = String(linkMatch[0]);
    if (driveLinks.indexOf(url) === -1) driveLinks.push(url);
  }
  if (driveLinks.length > 0) {
    console.log(`Found ${driveLinks.length} Google Drive/Docs link(s) in the body.`);
  }

  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  if (attachments.length === 0) {
    summaryText += "No attachments found.\n";
  }

  for (const att of attachments) {
    const filename = String(att.filename);
    const mimeType = String(att.mimeType);
    const attachmentId = String(att.attachmentId);
    summaryText += `\n[Attachment: ${filename} (${mimeType})]\n`;

    if (mimeType === "application/pdf") {
      console.log(`Processing PDF: ${filename}`);
      const attRes = await tools.gmail_get_attachment({
        messageId,
        attachmentId,
        returnRawBase64: true
      });

      if (attRes.isError === true) {
        summaryText += `Error fetching PDF: ${String(attRes.content[0].text)}\n`;
        continue;
      }

      let handle = null;
      try {
        const base64 = readAttachmentBase64(attRes);
        if (base64 === null) {
          summaryText += `Error processing PDF: the attachment tool returned no base64 payload.\n`;
          continue;
        }

        console.log(`Loading PDF into memory...`);
        const loadRes = await tools.pdf_load({ base64 });
        if (loadRes.isError === true) throw new Error(String(loadRes.content[0].text));

        const handleData = JSON.parse(String(loadRes.content[0].text));
        handle = String(handleData.handle);

        console.log(`PDF Loaded (${handle}). Delegating summary to subtask...`);
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
          console.log(`Releasing PDF handle...`);
          try { await tools.pdf_release({ handle }); } catch (_) { /* best effort */ }
        }
      }
    // The vnd.google-apps branch that used to sit here passed `attachmentId`
    // to docs_read_content as a Drive fileId. Gmail attachment IDs are opaque
    // handles for users.messages.attachments.get and are not Drive file IDs,
    // and Drive files shared through Gmail do not arrive as attachments at all
    // — they arrive as links in the body. The branch could never fire, and
    // would have fed a bogus ID to the API if it had. The work it was reaching
    // for is now done properly in the link pass below.
    } else if (mimeType.startsWith("image/") === true) {
      console.log(`Processing image attachment: ${filename}`);
      try {
        const attRes = await tools.gmail_get_attachment({
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
        // cannot read it. Sending the declared type is what produced
        // "Loop terminated: Failed to load image" for a .png that was AVIF.
        const prepared = await prepareImageForVision(rawBase64, mimeType, filename);
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
    } else {
       summaryText += `(File type ${mimeType} not automatically parsed. ID: ${attachmentId})\n`;
    }
  }

  // ── Process Google Drive / Docs links found in the body ─────────
  if (driveLinks.length > 0) {
    summaryText += `\n--- Linked Drive Files ---\n`;
    for (const link of driveLinks) {
      summaryText += `\nLink: ${link}\n`;
      console.log(`Delegating linked Drive file "${link}" to subtask...`);
      try {
        const subtaskRes = await tools.runSubtask({
          goal: `Read and summarize the Google Drive file at: "${link}".\n` +
            `1. Extract the file ID from the URL (the segment after /d/ or the id= parameter).\n` +
            `2. Use 'drive_get_file_metadata' on that fileId to learn its exact mimeType. Do NOT assume the type from the URL.\n` +
            `3. Read it with the matching tool: 'docs_read_content' for a Google Doc, 'sheets_get_metadata' then 'sheets_read_as_csv' for a Sheet, 'slides_read_content' for Slides.\n` +
            `4. If the API read fails (commonly a permissions error on a file owned by another account), fall back to the browser: 'newPage' on the URL, wait for it to load, then 'takeSnapshot' (mode: 'readable') to extract text, and 'takeScreenshot' if the text extraction returns nothing usable.\n` +
            `5. Generate a comprehensive summary. Do NOT finish without writing the summary.`,
          verification_command: "Summary is generated from the linked Drive file",
          timeoutMs: 240000,
        });

        const linkSummary = extractSubtaskText(subtaskRes);
        summaryText += linkSummary.ok
          ? `Linked File Summary:\n${linkSummary.text}\n`
          : `Linked file NOT summarized — the subtask reported: ${linkSummary.reason}\n`;
      } catch (e) {
        summaryText += `(Error processing link "${link}": ${String(e.message)})\n`;
      }
    }
  }

  return { success: true, analysis: summaryText };
}

return run();