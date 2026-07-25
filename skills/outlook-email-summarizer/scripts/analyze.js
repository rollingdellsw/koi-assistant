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
  const extractSubtaskText = (subtask) => {
    if (!subtask || subtask.isError) {
      const err =
        subtask && subtask.content && subtask.content[0]
          ? String(subtask.content[0].text)
          : "unknown error";
      return `(Subtask failed: ${err})`;
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
    } catch (_) {
      if (text.includes("[... Output truncated")) {
        text = "(Subtask output was too large and was truncated. It likely timed out.)";
      }
    }
    return text === "" ? "(Subtask returned empty output)" : text;
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

        const rawData = JSON.parse(String(attRes.content[1].text));
        const base64 = String(rawData.base64);

        console.log("Loading PDF into memory...");
        const loadRes = await tools.pdf_load({ base64 });
        if (loadRes.isError) throw new Error(String(loadRes.content[0].text));

        const handleData = JSON.parse(String(loadRes.content[0].text));
        const handle = String(handleData.handle);

        console.log(`PDF loaded (${handle}). Delegating summary to subtask...`);
        const subtaskRes = await tools.runSubtask({
          goal: `Read the PDF document with handle '${handle}' using the pdf_read tool. After reading, you MUST generate a final text response containing a comprehensive summary. Do NOT finish the task without writing the summary.`,
          verification_command: `pdf_read with handle '${handle}' returns content`,
          timeoutMs: 240000,
        });

        summaryText += `PDF Summary:\n${extractSubtaskText(subtaskRes)}\n`;

        console.log("Releasing PDF handle...");
        await tools.pdf_release({ handle });
      } catch (e) {
        summaryText += `Error processing PDF: ${String(e.message)}\n`;
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

        if (attRes && !attRes.isError && attRes.content && attRes.content[1]) {
          const rawData = JSON.parse(String(attRes.content[1].text));
          const base64 = String(rawData.base64);

          console.log(`Delegating image "${filename}" to subtask for visual analysis (using vision)...`);
          const subtaskRes = await tools.runSubtask({
            goal: `Describe the image "${filename}" in detail. The image is provided inline for your visual analysis.`,
            verification_command: "Image is described",
            image_data: [
              { base64: base64, mimeType: contentType, filename: filename },
            ],
            timeoutMs: 120000,
          });

          if (subtaskRes && !subtaskRes.isError) {
            summaryText += `Image Description:\n${extractSubtaskText(subtaskRes)}\n`;
          } else {
            summaryText += `(Subtask failed to describe image "${filename}")\n`;
          }
        } else {
          summaryText += `(Could not download image "${filename}")\n`;
        }
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
          summaryText += `${docType.charAt(0).toUpperCase() + docType.slice(1)} Summary:\n${extractSubtaskText(subtaskRes)}\n`;
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
          summaryText += `Linked File Summary:\n${extractSubtaskText(subtaskRes)}\n`;
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
