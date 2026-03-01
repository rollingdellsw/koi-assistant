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

  // If we still have a URL or long hash (not a Graph API ID), resolve via browser tab + search
  // Message IDs start with "AAMk" or "AQMk" + "A...R" (containing "ARg" or "AAAI")
  // Conversation IDs start with "AQQk" — these are NOT valid for /me/messages/{id}
  const isConversationId = messageId.startsWith("AQQk");
  const isLikelyMessageId = (messageId.startsWith("AAMk") || messageId.startsWith("AQMk")) && !isConversationId;
  if (!isLikelyMessageId) {
    console.log("Could not extract Graph message ID from URL. Resolving via browser tab title...");
    let resolved = false;

    if (typeof tools.listPages === "function") {
      try {
        const pagesRes = await tools.listPages({});
        if (pagesRes && !pagesRes.isError) {
          const pagesData = JSON.parse(String(pagesRes.content[0].text));
          // Outlook tab titles are like "Subject - sender@email.com - Outlook"
          const currentTab = pagesData.find(
            p => typeof p.url === "string" && (p.url.includes("outlook.live.com") || p.url.includes("outlook.office.com"))
          );

          if (currentTab && typeof currentTab.title === "string") {
            const titleParts = currentTab.title.split(" - ");
            if (titleParts.length > 0) {
              const subject = String(titleParts[0]).trim();
              console.log(`Extracted subject from tab title: "${subject}". Searching Outlook API...`);
              const searchRes = await tools.outlook_search({ query: subject, maxResults: 1 });

              if (searchRes && !searchRes.isError) {
                const searchData = JSON.parse(String(searchRes.content[0].text));
                const messages = Array.isArray(searchData.messages) ? searchData.messages : [];
                if (messages.length > 0) {
                  messageId = String(messages[0].id);
                  console.log(`Resolved to API Message ID: ${messageId}`);
                  resolved = true;
                }
              }
            }
          }
        }
      } catch (e) {
        console.log(`Context resolution failed: ${String(e)}`);
      }
    }

    if (!resolved) {
      console.log("Could not resolve from tab. Falling back to most recent email with attachments...");
      const fallbackRes = await tools.outlook_search({ query: "hasAttachments:true", maxResults: 1 });
      if (fallbackRes && !fallbackRes.isError) {
        const searchData = JSON.parse(String(fallbackRes.content[0].text));
        const messages = Array.isArray(searchData.messages) ? searchData.messages : [];
        if (messages.length > 0) {
          messageId = String(messages[0].id);
          console.log(`Resolved to API Message ID (fallback): ${messageId}`);
        } else {
          return { success: false, error: "Could not resolve message ID and no recent attachments found." };
        }
      } else {
        return { success: false, error: "Could not resolve message ID via search." };
      }
    }
  }

  // ── Step 2: Fetch the email ─────────────────────────────────────
  console.log(`Fetching email: ${messageId}`);
  const msgRes = await tools.outlook_get_message({ messageId });
  if (msgRes.isError) {
    return { success: false, error: String(msgRes.content[0].text) };
  }

  const msg = JSON.parse(String(msgRes.content[0].text));
  const fromStr = msg.from ? `${msg.from.name || ""} <${msg.from.address || ""}>` : "Unknown";
  const toStr = Array.isArray(msg.to)
    ? msg.to.map(r => `${r.name || ""} <${r.address || ""}>`.trim()).join(", ")
    : "Unknown";

  let summaryText = `Subject: ${String(msg.subject || "(no subject)")}\n` +
    `From: ${fromStr}\n` +
    `To: ${toStr}\n` +
    `Date: ${String(msg.receivedDateTime || "")}\n\n` +
    `--- Email Body ---\n${String(msg.body || "")}\n\n` +
    `--- Attachments ---\n`;

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
    if (contentType === "application/pdf") {
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
        const subtaskRes = await tools.run_subtask({
          goal: `Read the PDF document with handle '${handle}' using the pdf_read tool. After reading, you MUST generate a final text response containing a comprehensive summary. Do NOT finish the task without writing the summary.`,
          verification_command: `pdf_read with handle '${handle}' returns content`,
          timeoutMs: 240000,
        });

        if (subtaskRes.isError) {
          summaryText += `Subtask failed to summarize PDF: ${String(subtaskRes.content[0].text)}\n`;
        } else {
          let pdfSummary = String(subtaskRes.content[0].text);
          try {
            const parsed = JSON.parse(pdfSummary);
            if (typeof parsed.content === "string") pdfSummary = parsed.content;
            if (pdfSummary === "" && Array.isArray(parsed.history)) {
              const lastMsg = parsed.history.slice().reverse().find(
                m => m.role === "assistant" && typeof m.content === "string" && m.content.trim() !== ""
              );
              if (lastMsg) pdfSummary = lastMsg.content;
            }
          } catch (_) {
            if (pdfSummary.includes("[... Output truncated")) {
              pdfSummary = "(Subtask output was too large and was truncated. It likely timed out.)";
            }
          }
          if (pdfSummary === "") pdfSummary = "(Subtask returned empty summary)";
          summaryText += `PDF Summary:\n${pdfSummary}\n`;
        }

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
          const subtaskRes = await tools.run_subtask({
            goal: `Describe the image "${filename}" in detail. The image is provided inline for your visual analysis.`,
            verification_command: "Image is described",
            image_data: [
              { base64: base64, mimeType: contentType, filename: filename },
            ],
            timeoutMs: 120000,
          });

          if (subtaskRes && !subtaskRes.isError) {
            let imgDesc = String(subtaskRes.content[0].text);
            try {
              const parsed = JSON.parse(imgDesc);
              if (typeof parsed.content === "string") imgDesc = parsed.content;
              if (imgDesc === "" && Array.isArray(parsed.history)) {
                const lastMsg = parsed.history.slice().reverse().find(
                  m => m.role === "assistant" && typeof m.content === "string" && m.content.trim() !== ""
                );
                if (lastMsg) imgDesc = lastMsg.content;
              }
            } catch (_) {}
            if (imgDesc === "") imgDesc = "(Subtask returned empty description)";
            summaryText += `Image Description:\n${imgDesc}\n`;
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

        const subtaskRes = await tools.run_subtask({
          goal: `Download the ${docType} attachment "${filename}" from Outlook message "${messageId}" (attachment ID: "${attachmentId}") using outlook_get_attachment with returnRawBase64: true. The file is already an email attachment — you do NOT need to search for it. ${readInstructions} After reading, generate a comprehensive summary of the content. Do NOT finish without writing the summary.`,
          verification_command: `${docType} content is returned and summarized`,
          timeoutMs: 240000,
        });

        if (subtaskRes && !subtaskRes.isError) {
          let docSummary = String(subtaskRes.content[0].text);
          try {
            const parsed = JSON.parse(docSummary);
            if (typeof parsed.content === "string") docSummary = parsed.content;
            if (docSummary === "" && Array.isArray(parsed.history)) {
              const lastMsg = parsed.history.slice().reverse().find(
                m => m.role === "assistant" && typeof m.content === "string" && m.content.trim() !== ""
              );
              if (lastMsg) docSummary = lastMsg.content;
            }
          } catch (_) {
            if (docSummary.includes("[... Output truncated")) {
              docSummary = "(Subtask output was too large and was truncated.)";
            }
          }
          if (docSummary === "") docSummary = "(Subtask returned empty summary)";
          summaryText += `${docType.charAt(0).toUpperCase() + docType.slice(1)} Summary:\n${docSummary}\n`;
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
        const subtaskRes = await tools.run_subtask({
          goal: `Access the external shared link: "${link}".
1. First, use 'onedrive_resolve_link' to convert this URL into an itemId and driveId.
2. If successful, use the appropriate API tool to read the content (e.g., 'word_read_content', 'excel_read_as_csv', 'ppt_read_content', or 'onedrive_download_text') using the returned itemId and driveId.
3. If the resolve fails or the API read fails (often due to external tenant permissions), fallback to the browser: use 'new_page' to open the URL.
4. Wait for the page or Office Online viewer to load.
5. Use 'take_snapshot' (mode: 'readable') to extract text.
6. If text extraction fails (e.g., canvas viewer), use 'take_screenshot' to analyze it visually.
7. Generate a comprehensive summary. Do NOT finish without writing the summary.`,
          verification_command: `Summary is generated from the shared link content`,
          timeoutMs: 300000,
        });

        if (subtaskRes && subtaskRes.isError === false) {
          let linkSummary = String(subtaskRes.content[0].text);
          try {
            const parsed = JSON.parse(linkSummary);
            if (typeof parsed.content === "string") linkSummary = parsed.content;
            if (linkSummary === "" && Array.isArray(parsed.history)) {
              const lastMsg = parsed.history.slice().reverse().find(
                m => m.role === "assistant" && typeof m.content === "string" && m.content.trim() !== ""
              );
              if (lastMsg) linkSummary = lastMsg.content;
            }
          } catch (_) {}
          if (linkSummary === "") linkSummary = "(Subtask returned empty summary)";
          summaryText += `Linked File Summary:\n${linkSummary}\n`;
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
