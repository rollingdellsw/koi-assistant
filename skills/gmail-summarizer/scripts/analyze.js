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
  if (input.includes("inbox/") === true || input.includes("#inbox/") === true) {
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

    // Primary: Extract from Gmail DOM attribute
    if (typeof tools.searchDom === "function") {
      console.log("Searching DOM for data-legacy-message-id attribute...");
      try {
        const domSearch = await tools.searchDom('[data-legacy-message-id]');
        if (domSearch && domSearch.count > 0) {
          const selector = domSearch.matches[0].selector;
          const details = await tools.inspectElement(selector);
          const legacyId = details.attributes?.['data-legacy-message-id'];
          if (legacyId) {
            messageId = String(legacyId);
            console.log(`Resolved via DOM data-legacy-message-id: ${messageId}`);
            resolved = true;
          }
        }
      } catch (e) {
        console.log(`DOM search failed: ${String(e)}`);
      }
    }

    // Fallback: Extract subject from tab title, search Gmail API
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

      try {
        const rawData = JSON.parse(String(attRes.content[1].text));
        const base64 = String(rawData.base64);

        console.log(`Loading PDF into memory...`);
        const loadRes = await tools.pdf_load({ base64 });
        if (loadRes.isError === true) throw new Error(String(loadRes.content[0].text));

        const handleData = JSON.parse(String(loadRes.content[0].text));
        const handle = String(handleData.handle);

        console.log(`PDF Loaded (${handle}). Delegating summary to subtask...`);
        const subtaskRes = await tools.run_subtask({
          goal: `Read the PDF document with handle '${handle}' using the pdf_read tool. After reading, you MUST generate a final text response containing a comprehensive summary. Do NOT finish the task without writing the summary.`,
          verification_command: `pdf_read with handle '${handle}' returns content`,
          timeoutMs: 240000,
        });

        if (subtaskRes.isError === true) {
          summaryText += `Subtask failed to summarize PDF: ${String(subtaskRes.content[0].text)}\n`;
        } else {
          // Extract just the content from the subtask result, not the full history
          let pdfSummary = String(subtaskRes.content[0].text);
          try {
            const parsed = JSON.parse(pdfSummary);
            if (typeof parsed.content === "string") pdfSummary = parsed.content;

            // Fallback: If content is empty, try to find the last assistant message in history
            if (pdfSummary === "" && Array.isArray(parsed.history)) {
              const lastMsg = parsed.history.slice().reverse().find(m => m.role === "assistant" && typeof m.content === "string" && m.content.trim() !== "");
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

        console.log(`Releasing PDF handle...`);
        await tools.pdf_release({ handle });
      } catch (e) {
        summaryText += `Error processing PDF: ${String(e.message)}\n`;
      }
    } else if (mimeType.includes("vnd.google-apps") === true) {
      console.log(`Processing Workspace document: ${filename}`);
      let instructions = "";
      if (mimeType.includes("document") === true) {
        instructions = `Use 'docs_read_content' with documentId '${attachmentId}'.`;
      } else if (mimeType.includes("spreadsheet") === true) {
        instructions = `Use 'sheets_get_metadata' to find sheet tabs, then 'sheets_read_as_csv' with spreadsheetId '${attachmentId}' and the appropriate range.`;
      } else if (mimeType.includes("presentation") === true) {
        instructions = `Use 'slides_read_content' with presentationId '${attachmentId}'.`;
      } else {
        instructions = `First use 'drive_get_file_metadata' on fileId '${attachmentId}' to find its exact mimeType, then use the corresponding tool (docs_read_content, sheets_read_as_csv, or slides_read_content).`;
      }

      const subtaskRes = await tools.run_subtask({
        goal: `${instructions} After reading, you MUST generate a final text response containing a comprehensive summary. Do NOT finish the task without writing the summary.`,
        verification_command: "Document content is returned and summarized",
        timeoutMs: 240000,
      });

      if (subtaskRes.isError === true) {
        summaryText += `Subtask failed to summarize Workspace doc: ${String(subtaskRes.content[0].text)}\n`;
      } else {
        let docSummary = String(subtaskRes.content[0].text);
        try {
          const parsed = JSON.parse(docSummary);
          if (typeof parsed.content === "string") docSummary = parsed.content;

          // Fallback: If content is empty, try to find the last assistant message in history
          if (docSummary === "" && Array.isArray(parsed.history)) {
            const lastMsg = parsed.history.slice().reverse().find(m => m.role === "assistant" && typeof m.content === "string" && m.content.trim() !== "");
            if (lastMsg) docSummary = lastMsg.content;
          }
        } catch (_) {
          if (docSummary.includes("[... Output truncated")) {
             docSummary = "(Subtask output was too large and was truncated. It likely timed out.)";
          }
        }
        if (docSummary === "") docSummary = "(Subtask returned empty summary)";
        summaryText += `Workspace Document Summary:\n${docSummary}\n`;
      }
    } else if (mimeType.startsWith("image/") === true) {
      console.log(`Processing image attachment: ${filename}`);
      try {
        const attRes = await tools.gmail_get_attachment({
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
              { base64: base64, mimeType: mimeType, filename: filename },
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
    } else {
       summaryText += `(File type ${mimeType} not automatically parsed. ID: ${attachmentId})\n`;
    }
  }

  return { success: true, analysis: summaryText };
}

return run();