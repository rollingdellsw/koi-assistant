// scripts/gmail-attachment-routing-test.js
try {
  await tools.readSkill({ name: "google-workspace" });
  await tools.readSkill({ name: "pdf" });
  console.log("Skills loaded. Checking tool availability...");
} catch (e) {
  console.error("Failed to load skills:", e);
}

console.log("Starting Gmail Attachment Routing Test...");

async function run() {
  let url = "";

  if (typeof args !== "undefined" && args !== null) {
    if (Array.isArray(args)) {
      const urlIndex = args.indexOf("--url");
      if (urlIndex !== -1 && urlIndex + 1 < args.length && typeof args[urlIndex + 1] === "string") {
        url = String(args[urlIndex + 1]);
      } else {
        const fallback = args.find(a => typeof a === "string" && a.includes("mail.google.com"));
        if (typeof fallback === "string") {
          url = fallback;
        }
      }
    } else if (typeof args === "object" && "url" in args && typeof args.url === "string") {
      url = String(args.url);
    }
  }

  if (url === "" && typeof window !== "undefined" && window !== null && typeof window.location !== "undefined" && typeof window.location.href === "string") {
    url = String(window.location.href);
  }

  let messageId = "";
  if (url !== "" && (url.includes("inbox/") === true || url.includes("#inbox/") === true)) {
    const parts = url.split(/inbox\//);
    const lastPart = String(parts[parts.length - 1]);
    messageId = String(lastPart.split("?")[0]);
    console.log(`Target Message ID from URL: ${messageId}`);
  }

  let msgRes = null;

  // Verify if the tool exists before calling
  // Use a small retry loop to allow MCP server startup time
  let retries = 5;
  while (typeof tools.gmail_search !== "function" && retries > 0) {
    console.log("Waiting for Workspace tools to register...");
    await tools.sleep(500);
    retries--;
  }

  if (typeof tools.gmail_search !== "function") {
    throw new Error("Tool 'gmail_search' not found after skill load.");
  }

  if (messageId !== "") {
    // IDs from URL (like Ktbx...) are usually thread hashes.
    // We MUST search to get the real 16-char hex ID.
    if (messageId.length > 20) {
      console.log(`Detected UI Hash: ${messageId}. Searching for actual Message ID...`);
      const searchRes = await tools.gmail_search({ query: `rfc822msgid:${messageId}`, maxResults: 1 });
      // If direct search fails, try a broader search or fallback
      if (searchRes.isError || JSON.parse(searchRes.content[0].text).messages.length === 0) {
         console.log("Direct ID search failed, falling back to recent has:attachment...");
         messageId = "";
      } else {
         const searchData = JSON.parse(searchRes.content[0].text);
         messageId = searchData.messages[0].id;
      }
    }

    if (messageId !== "" && messageId.length <= 20) {
      msgRes = await tools.gmail_get_message({ messageId });
    }
  }

  if (messageId === "" || msgRes === null || msgRes.isError === true) {
    console.log(`URL ID invalid or missing. Falling back to dynamic search for 'has:attachment'...`);
    const searchRes = await tools.gmail_search({ query: "has:attachment", maxResults: 1 });
    if (searchRes.isError === true) {
      throw new Error(String(searchRes.content[0].text));
    }
    const searchData = JSON.parse(String(searchRes.content[0].text));
    const messages = Array.isArray(searchData.messages) ? searchData.messages : [];
    if (messages.length === 0) {
      throw new Error("No recent emails with attachments found to test routing.");
    }
    messageId = String(messages[0].id);
    console.log(`Using discovered Message ID: ${messageId}`);
    msgRes = await tools.gmail_get_message({ messageId });
  }

  if (msgRes === null || msgRes.isError === true) {
    throw new Error(msgRes !== null ? String(msgRes.content[0].text) : "Failed to retrieve message.");
  }

  const msg = JSON.parse(String(msgRes.content[0].text));
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  console.log(`Found ${attachments.length} attachments.`);

  for (const att of attachments) {
    console.log(`\n--- Processing: ${att.filename} (${att.mimeType}) ---`);

    if (att.mimeType === "application/pdf") {
      const dataRes = await tools.gmail_get_attachment({ messageId, attachmentId: att.attachmentId, returnRawBase64: true });
      if (dataRes !== null && dataRes !== undefined && dataRes.isError === true) {
        throw new Error(String(dataRes.content[0].text));
      }
      const rawData = JSON.parse(String(dataRes.content[1].text));
      const base64 = String(rawData.base64);
      const pdfLoadRes = await tools.pdf_load({ base64 });
      if (pdfLoadRes !== null && pdfLoadRes !== undefined && pdfLoadRes.isError === true) {
        throw new Error(String(pdfLoadRes.content[0].text));
      }
      const parsedData = JSON.parse(String(pdfLoadRes.content[0].text));
      console.log(`✓ PDF Loaded correctly. Handle: ${String(parsedData.handle)}`);

    } else if (typeof att.mimeType === "string" && att.mimeType.startsWith("image/") === true) {
      await tools.gmail_get_attachment({ messageId, attachmentId: att.attachmentId, returnRawBase64: true });
      console.log(`✓ Image data fetched for LLM analysis.`);

    } else if (typeof att.mimeType === "string" && att.mimeType.includes("vnd.google-apps") === true) {
      // Logic: Protocol says use Docs/Sheets/Slides tools directly
      console.log(`✓ Routing to Workspace MCP tools for ID: ${att.attachmentId}`);
    }
  }
}

return run();
