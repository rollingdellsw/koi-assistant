// scripts/run-all.js
// Google Workspace MCP — Full Test Suite Runner
// Runs all test suites sequentially within a single sandbox execution.
// Each suite is a self-contained async function.
//
// Usage: /skill google-workspace-test/scripts/run-all.js --full-auto

await tools.readSkill({ name: "google-workspace" });
console.log("=== Google Workspace MCP — Full Test Suite ===");

// Verify tool availability with retry loop to allow MCP server startup time
let retries = 5;
while (typeof tools.gmail_search !== "function" && retries > 0) {
  console.log("Waiting for Workspace tools to register...");
  await tools.sleep(500);
  retries--;
}
if (typeof tools.gmail_search !== "function") {
  throw new Error("Tool 'gmail_search' not found after skill load.");
}
console.log(`Started: ${new Date().toLocaleTimeString()}\n`);

// Fixed test URLs for read-only verification
const TEST_DOC_URL = "https://docs.google.com/document/d/1X0zJau_lxgHQJHg4gPn9RiwA1LHA7-2R4cAovv9reg0/edit?tab=t.0";
const TEST_SHEET_URL = "https://docs.google.com/spreadsheets/d/1wmdRFpt2S4AciDcX0UpflQ-RtfK09EHVfB0GdruO-yo";
const TEST_SLIDES_URL = "https://docs.google.com/presentation/d/1aRhgbzqCBrHbmqnUdS9IeeICuLxWSbOj5_pxCtQHG64/";

const RUN_ID = Math.floor(Math.random() * 10000);

// ── Helpers ──────────────────────────────────────────────────
function extractId(url, pattern) {
  const m = url.match(pattern);
  return m ? m[1] : null;
}
function safeParseJson(res) {
  const text = res?.content?.[0]?.text || "{}";
  try { return JSON.parse(text); } catch { return null; }
}

// ── Suite Definitions ────────────────────────────────────────

async function suiteDocs() {
  const existingDocId = extractId(TEST_DOC_URL, /document\/d\/([a-zA-Z0-9-_]+)/);

  // Part 1: Read-only
  if (existingDocId) {
    const meta = safeParseJson(await tools.docs_get_metadata({ documentId: existingDocId }));
    if (!meta?.title) throw new Error("docs_get_metadata failed");
    console.log(`  ✓ Metadata: "${meta.title}", ${meta.tabs?.length || 1} tab(s)`);

    const content = safeParseJson(await tools.docs_read_content({ documentId: existingDocId }));
    if (!content?.totalChars && content?.totalChars !== 0) throw new Error("docs_read_content failed");
    console.log(`  ✓ Content: ${content.totalChars} chars`);

    if (meta.tabs?.length > 1) {
      const tab2 = safeParseJson(await tools.docs_read_content({ documentId: existingDocId, tabId: meta.tabs[1].tabId }));
      console.log(`  ✓ Tab 2: ${tab2?.totalChars || 0} chars`);
    }

    const imgs = safeParseJson(await tools.docs_get_images({ documentId: existingDocId }));
    console.log(`  ✓ Images: ${imgs?.images?.length || 0}`);

    const urls = safeParseJson(await tools.docs_get_urls({ documentId: existingDocId }));
    console.log(`  ✓ URLs: ${urls?.urls?.length || 0}`);
  }

  // Part 2: Create + write
  const title = `RunAll Docs ${RUN_ID}`;
  const createRes = await tools.docs_create({ title });
  let docId = null;
  const cText = createRes?.content?.[0]?.text || "";
  try { const j = JSON.parse(cText); docId = j._createdFileId; } catch {}
  if (!docId) { const m = cText.match(/document: ([a-zA-Z0-9-_]+)/); if (m) docId = m[1]; }
  if (!docId) throw new Error("docs_create failed");
  console.log(`  ✓ Created doc: ${docId}`);

  await tools.docs_batch_update({ documentId: docId, requests: [
    { insertText: { text: "Hello from run-all test.\nLink: Google\n", location: { index: 1 } } },
    { updateTextStyle: { range: { startIndex: 31, endIndex: 37 }, textStyle: { link: { url: "https://google.com" } }, fields: "link" } }
  ]});
  console.log(`  ✓ Wrote text + hyperlink`);

  await tools.docs_batch_update({ documentId: docId, requests: [
    { insertInlineImage: { uri: "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png", location: { index: 1 }, objectSize: { height: { magnitude: 50, unit: "PT" }, width: { magnitude: 150, unit: "PT" } } } }
  ]});
  console.log(`  ✓ Inserted image`);

  // Table
  const preTable = safeParseJson(await tools.docs_read_content({ documentId: docId }));
  const tableIdx = Math.max((preTable?.totalChars || 2) - 1, 2);
  await tools.docs_batch_update({ documentId: docId, requests: [
    { insertTable: { rows: 2, columns: 2, location: { index: tableIdx } } }
  ]});
  console.log(`  ✓ Inserted table`);

  // DeleteContentRange
  await tools.docs_batch_update({ documentId: docId, requests: [
    { deleteContentRange: { range: { startIndex: 2, endIndex: 4 } } }
  ]});
  console.log(`  ✓ Deleted content range`);

  // Verify
  const vUrls = safeParseJson(await tools.docs_get_urls({ documentId: docId }));
  if (!vUrls?.urls?.find(u => u.url.includes("google.com"))) throw new Error("URL verification failed");
  console.log(`  ✓ URL verified`);

  const vImgs = safeParseJson(await tools.docs_get_images({ documentId: docId }));
  if (!vImgs?.images?.length) throw new Error("Image verification failed");
  console.log(`  ✓ Image verified`);

  return true;
}

async function suiteSheets() {
  const existingId = extractId(TEST_SHEET_URL, /spreadsheets\/d\/([a-zA-Z0-9-_]+)/);

  // Part 1: Read-only
  if (existingId) {
    const meta = safeParseJson(await tools.sheets_get_metadata({ spreadsheetId: existingId }));
    if (!meta?.title) throw new Error("sheets_get_metadata failed");
    console.log(`  ✓ Metadata: "${meta.title}", ${meta.sheets?.length || 0} tab(s)`);

    const read = safeParseJson(await tools.sheets_read_range({ spreadsheetId: existingId, range: `${meta.sheets?.[0]?.title || "Sheet1"}!A1:Z10` }));
    console.log(`  ✓ Read: ${read?.returnedRows || 0} rows`);

    const csv = await tools.sheets_read_as_csv({ spreadsheetId: existingId, range: `${meta.sheets?.[0]?.title || "Sheet1"}!A1:E5` });
    console.log(`  ✓ CSV export OK`);

    const urls = safeParseJson(await tools.sheets_get_urls({ spreadsheetId: existingId, range: `${meta.sheets?.[0]?.title || "Sheet1"}!A1:Z50` }));
    console.log(`  ✓ URLs: ${urls?.length || 0}`);
  }

  // Part 2: Create + CRUD
  const title = `RunAll Sheets ${RUN_ID}`;
  const createRes = await tools.sheets_create({ title });
  let sheetId = null;
  const cText = createRes?.content?.[0]?.text || "";
  try { const j = JSON.parse(cText); sheetId = j._createdFileId; } catch {}
  if (!sheetId) { const m = cText.match(/spreadsheet: ([a-zA-Z0-9-_]+)/); if (m) sheetId = m[1]; }
  if (!sheetId) throw new Error("sheets_create failed");
  console.log(`  ✓ Created sheet: ${sheetId}`);

  // Add tab
  await tools.sheets_batch_update({ spreadsheetId: sheetId, requests: [{ addSheet: { properties: { title: "Tab2" } } }] });
  console.log(`  ✓ Added tab "Tab2"`);

  // Write + hyperlinks
  await tools.sheets_write_range({ spreadsheetId: sheetId, range: "Sheet1!A1", values: [
    ["Name", "Link"], ["Google", '=HYPERLINK("https://google.com","Google")']
  ]});
  const urlRes = safeParseJson(await tools.sheets_get_urls({ spreadsheetId: sheetId, range: "Sheet1!A1:B10" }));
  if (!urlRes?.find(u => u.url?.includes("google.com"))) throw new Error("Hyperlink extraction failed");
  console.log(`  ✓ Hyperlink verified`);

  // Cross-sheet write
  await tools.sheets_write_range({ spreadsheetId: sheetId, range: "Tab2!A1", values: [["CrossTab", "Data"]] });
  console.log(`  ✓ Cross-sheet write`);

  // Stress + pagination
  const stress = Array.from({ length: 50 }, (_, i) => [`Item${i}`, `${Math.random()}`]);
  await tools.sheets_write_range({ spreadsheetId: sheetId, range: "Sheet1!A5", values: stress });
  const page = safeParseJson(await tools.sheets_read_range({ spreadsheetId: sheetId, range: "Sheet1!A5:B55", offset: 25, limit: 5 }));
  if (page?.values?.[0]?.[0] !== "Item25") throw new Error("Pagination failed");
  console.log(`  ✓ Pagination verified`);

  // Formulas
  await tools.sheets_write_range({ spreadsheetId: sheetId, range: "Sheet1!D1", values: [["A","B","Sum"],["10","20","=D2+E2"]] });
  const fRes = safeParseJson(await tools.sheets_read_range({ spreadsheetId: sheetId, range: "Sheet1!F2" }));
  if (fRes?.values?.[0]?.[0] === "30") console.log(`  ✓ Formula evaluation verified`);
  else console.log(`  ⚠ Formula: got ${fRes?.values?.[0]?.[0]} (expected 30)`);

  // Clear range
  await tools.sheets_clear_range({ spreadsheetId: sheetId, range: "Sheet1!D1:F2" });
  const cleared = safeParseJson(await tools.sheets_read_range({ spreadsheetId: sheetId, range: "Sheet1!D1:F2" }));
  const isEmpty = !cleared?.values || cleared.values.length === 0;
  console.log(`  ✓ Clear range ${isEmpty ? "verified empty" : "sent"}`);

  return true;
}

async function suiteSlides() {
  const existingId = extractId(TEST_SLIDES_URL, /presentation\/d\/([a-zA-Z0-9-_]+)/);

  // Part 1: Read-only
  if (existingId) {
    const meta = safeParseJson(await tools.slides_get_metadata({ presentationId: existingId }));
    if (!meta?.title) throw new Error("slides_get_metadata failed");
    console.log(`  ✓ Metadata: "${meta.title}", ${meta.slides?.length || 0} slides`);

    const content = safeParseJson(await tools.slides_read_content({ presentationId: existingId }));
    const allText = (content?.slides || []).map(s => s.text).filter(Boolean).join("\n");
    console.log(`  ✓ Content: ${allText.length} chars`);

    const imgs = safeParseJson(await tools.slides_get_images({ presentationId: existingId }));
    console.log(`  ✓ Images: ${imgs?.images?.length || 0}`);

    const urls = safeParseJson(await tools.slides_get_urls({ presentationId: existingId }));
    console.log(`  ✓ URLs: ${urls?.urls?.length || 0}`);

    if (imgs?.images?.[0]?.contentUrl || imgs?.images?.[0]?.contentUri) {
      const dlRes = await tools.gsuite_download_image({ contentUri: imgs.images[0].contentUrl || imgs.images[0].contentUri });
      if (!dlRes?.isError) console.log(`  ✓ Image download OK`);
      else console.log(`  ⚠ Image download failed`);
    }
  }

  // Part 2: Create + CRUD
  const slideId = `runall_slide_${RUN_ID}`;
  const textBoxId = `runall_tb_${RUN_ID}`;

  // Find or create persistent deck
  const search = safeParseJson(await tools.drive_search({ searchTerm: "Koi Automation Persistent Test Deck", mimeType: "application/vnd.google-apps.presentation" }));
  let presId = search?.files?.[0]?.id;
  if (!presId) {
    const createRes = await tools.slides_create({ title: "Koi Automation Persistent Test Deck" });
    const cText = createRes?.content?.[0]?.text || "";
    const m = cText.match(/presentation: ([a-zA-Z0-9-_]+)/);
    if (m) presId = m[1];
    try { const j = JSON.parse(cText); if (j._createdFileId) presId = j._createdFileId; } catch {}
  }
  if (!presId) throw new Error("slides create/find failed");
  console.log(`  ✓ Using deck: ${presId}`);

  // Add slide + image
  await tools.slides_batch_update({ presentationId: presId, requests: [
    { createSlide: { objectId: slideId } },
    { createImage: { url: "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png", elementProperties: { pageObjectId: slideId } } }
  ]});
  console.log(`  ✓ Created slide + image`);

  // Add text box + text
  await tools.slides_batch_update({ presentationId: presId, requests: [
    { createShape: { objectId: textBoxId, shapeType: "TEXT_BOX", elementProperties: { pageObjectId: slideId, size: { width: { magnitude: 400, unit: "PT" }, height: { magnitude: 50, unit: "PT" } }, transform: { scaleX: 1, scaleY: 1, translateX: 50, translateY: 50, unit: "PT" } } } },
    { insertText: { objectId: textBoxId, text: `RunAll Test ${RUN_ID}`, insertionIndex: 0 } }
  ]});
  console.log(`  ✓ Created text box + text`);

  // Verify text
  const vContent = safeParseJson(await tools.slides_read_content({ presentationId: presId }));
  const vText = (vContent?.slides || []).map(s => s.text).filter(Boolean).join("\n");
  if (vText.includes(`RunAll Test ${RUN_ID}`)) console.log(`  ✓ Text content verified`);
  else console.log(`  ⚠ Text not found in ${vText.length} chars`);

  // Delete test slide (cleanup)
  await tools.slides_batch_update({ presentationId: presId, requests: [{ deleteObject: { objectId: slideId } }] });
  console.log(`  ✓ Test slide deleted`);

  return true;
}

async function suiteGmailCalendar() {
  // Gmail
  const labels = safeParseJson(await tools.gmail_list_labels({}));
  if (!Array.isArray(labels)) throw new Error("gmail_list_labels failed");
  console.log(`  ✓ Labels: ${labels.length}`);

  const search = safeParseJson(await tools.gmail_search({ query: "newer_than:7d", maxResults: 3 }));
  const msgs = search?.messages || [];
  console.log(`  ✓ Search: ${msgs.length} messages`);

  if (msgs.length > 0) {
    const msg = safeParseJson(await tools.gmail_get_message({ messageId: msgs[0].id }));
    if (!msg?.id) throw new Error("gmail_get_message failed");
    console.log(`  ✓ Message: "${msg.subject}" (${(msg.body || "").length} chars)`);

    if (msgs[0].threadId) {
      const thread = safeParseJson(await tools.gmail_get_thread({ threadId: msgs[0].threadId }));
      if (!thread?.threadId) throw new Error("gmail_get_thread failed");
      console.log(`  ✓ Thread: ${(thread.messages || []).length} message(s)`);
    }
  }

  // Calendar
  const cals = safeParseJson(await tools.calendar_list({}));
  if (!Array.isArray(cals)) throw new Error("calendar_list failed");
  console.log(`  ✓ Calendars: ${cals.length}`);

  const primaryId = cals.find(c => c.primary)?.id || "primary";
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const events = safeParseJson(await tools.calendar_get_events({ calendarId: primaryId, timeMin: now.toISOString(), timeMax: future.toISOString(), maxResults: 5 }));
  const evList = events?.events || [];
  console.log(`  ✓ Events: ${evList.length} upcoming`);

  if (evList.length > 0) {
    const ev = safeParseJson(await tools.calendar_get_event({ calendarId: primaryId, eventId: evList[0].id }));
    if (!ev?.summary && !ev?.id) throw new Error("calendar_get_event failed");
    console.log(`  ✓ Event detail: "${ev.summary}"`);
  }

  return true;
}

async function suiteDrive() {
  const list = safeParseJson(await tools.drive_list({ maxResults: 3 }));
  if (!list?.files) throw new Error("drive_list failed");
  console.log(`  ✓ List: ${list.files.length} files`);

  const filtered = safeParseJson(await tools.drive_list({ query: "mimeType='application/vnd.google-apps.document'", maxResults: 3 }));
  console.log(`  ✓ Filtered: ${filtered?.files?.length || 0} docs`);

  const search = safeParseJson(await tools.drive_search({ searchTerm: "test", maxResults: 3 }));
  console.log(`  ✓ Search: ${search?.files?.length || 0} results`);

  if (list.files.length > 0) {
    const meta = safeParseJson(await tools.drive_get_file_metadata({ fileId: list.files[0].id }));
    if (!meta?.name) throw new Error("drive_get_file_metadata failed");
    console.log(`  ✓ Metadata: "${meta.name}" (${meta.mimeType})`);
  }

  const sheets = safeParseJson(await tools.sheets_list({ maxResults: 3 }));
  console.log(`  ✓ sheets_list: OK`);

  return true;
}

async function suiteGuardrailNegative() {
  // Guardrail deny: write to non-owned files
  const fakeIds = [
    { tool: "sheets_write_range", args: { spreadsheetId: "FAKE_ID_AAA", range: "A1", values: [["x"]] }, label: "sheets_write" },
    { tool: "docs_batch_update", args: { documentId: "FAKE_ID_BBB", requests: [{ insertText: { text: "x", location: { index: 1 } } }] }, label: "docs_update" },
    { tool: "slides_batch_update", args: { presentationId: "FAKE_ID_CCC", requests: [{ createSlide: {} }] }, label: "slides_update" },
  ];

  for (const { tool, args, label } of fakeIds) {
    const res = await tools[tool](args);
    const text = res?.content?.[0]?.text || "";
    if (res?.isError || text.includes("GUARDRAIL") || text.includes("denied") || text.includes("not allowed")) {
      console.log(`  ✓ ${label} correctly blocked`);
    } else {
      throw new Error(`${label} was NOT blocked: ${text.slice(0, 80)}`);
    }
  }

  // Error handling: bad IDs
  const badReads = [
    { tool: "sheets_read_range", args: { spreadsheetId: "BAD_ID", range: "A1:B2" }, label: "bad sheet read" },
    { tool: "docs_read_content", args: { documentId: "BAD_ID" }, label: "bad doc read" },
    { tool: "slides_get_metadata", args: { presentationId: "BAD_ID" }, label: "bad slides read" },
    { tool: "gmail_get_message", args: { messageId: "BAD_ID" }, label: "bad gmail read" },
  ];

  for (const { tool, args, label } of badReads) {
    const res = await tools[tool](args);
    const text = res?.content?.[0]?.text || "";
    if (res?.isError || text.includes("Error") || text.includes("error") || text.includes("404") || text.includes("Not Found")) {
      console.log(`  ✓ ${label}: got expected error`);
    } else {
      console.log(`  ⚠ ${label}: unexpected response: ${text.slice(0, 80)}`);
    }
  }

  // Clear range on own file
  const createRes = await tools.sheets_create({ title: `RunAll ClearTest ${RUN_ID}` });
  let sid = null;
  const ct = createRes?.content?.[0]?.text || "";
  try { const j = JSON.parse(ct); sid = j._createdFileId; } catch {}
  if (!sid) { const m = ct.match(/spreadsheet: ([a-zA-Z0-9-_]+)/); if (m) sid = m[1]; }
  if (!sid) throw new Error("create for clear test failed");

  await tools.sheets_write_range({ spreadsheetId: sid, range: "Sheet1!A1", values: [["x","y"],["1","2"]] });
  await tools.sheets_clear_range({ spreadsheetId: sid, range: "Sheet1!A1:B2" });
  const verify = safeParseJson(await tools.sheets_read_range({ spreadsheetId: sid, range: "Sheet1!A1:B2" }));
  const isEmpty = !verify?.values || verify.values.length === 0;
  console.log(`  ✓ clear_range ${isEmpty ? "verified empty" : "sent"}`);

  return true;
}

async function suiteGmailAttachmentRouting() {
  await tools.readSkill({ name: "pdf" });

  const url = "https://mail.google.com/mail/u/0/?tab=rm&ogbl#inbox/KtbxLxGSsVWBvHvXVVnqDCNTZPJrVkLjFg";
  const parts = url.split(/inbox\//);
  const lastPart = String(parts[parts.length - 1]);
  let messageId = String(lastPart.split("?")[0]);
  console.log(`  ✓ Target URL ID: ${messageId}`);

  let msgRes = null;

  // Resolve UI Hash to API Hex ID
  if (messageId.length > 20) {
    console.log(`  ⚠ Detected UI Hash: ${messageId}. Searching for actual Message ID...`);
    const searchRes = await tools.gmail_search({ query: `rfc822msgid:${messageId}`, maxResults: 1 });
    const searchData = safeParseJson(searchRes);
    if (searchData?.messages?.length > 0) {
      messageId = searchData.messages[0].id;
      console.log(`  ✓ Resolved to API ID: ${messageId}`);
    } else {
      console.log("  ⚠ Direct ID search failed, falling back to recent has:attachment...");
      messageId = "";
    }
  }

  if (messageId !== "" && messageId.length <= 20) {
    msgRes = await tools.gmail_get_message({ messageId });
  }

  // Fallback to dynamic search
  if (!messageId || msgRes?.isError) {
    console.log(`  ⚠ URL ID invalid. Falling back to dynamic search...`);
    const searchRes = await tools.gmail_search({ query: "has:attachment", maxResults: 1 });
    const parsedSearch = safeParseJson(searchRes);
    if (!parsedSearch?.messages?.length) {
      throw new Error("No recent emails with attachments found.");
    }
    messageId = String(parsedSearch.messages[0].id);
    console.log(`  ✓ Using discovered Message ID: ${messageId}`);
    msgRes = await tools.gmail_get_message({ messageId });
  }

  if (!msgRes || msgRes.isError) {
    throw new Error("Failed to retrieve message.");
  }

  const msg = safeParseJson(msgRes);
  const attachments = (msg !== null && typeof msg === "object" && Array.isArray(msg.attachments) === true) ? msg.attachments : [];
  console.log(`  ✓ Found ${attachments.length} attachments.`);

  for (const att of attachments) {
    console.log(`  ── Processing: ${att.filename} (${att.mimeType})`);

    if (att.mimeType === "application/pdf") {
      const dataRes = await tools.gmail_get_attachment({ messageId, attachmentId: att.attachmentId, returnRawBase64: true });
      if (dataRes !== null && dataRes !== undefined && dataRes.isError === true) {
        throw new Error(String(dataRes.content[0].text));
      }
      const rawData = JSON.parse(String(dataRes.content[1].text));
      const pdfLoadRes = await tools.pdf_load({ base64: rawData.base64 });
      if (pdfLoadRes?.isError === true) throw new Error(String(pdfLoadRes.content[0].text));

      const parsedData = JSON.parse(String(pdfLoadRes.content[0].text));
      console.log(`    ✓ PDF Loaded correctly. Handle: ${parsedData.handle}`);

    } else if (typeof att.mimeType === "string" && att.mimeType.startsWith("image/") === true) {
      await tools.gmail_get_attachment({ messageId, attachmentId: att.attachmentId, returnRawBase64: true });
      console.log(`    ✓ Image data fetched.`);

    } else if (typeof att.mimeType === "string" && att.mimeType.includes("vnd.google-apps") === true) {
      console.log(`    ✓ Routing to Workspace MCP tools for ID: ${att.attachmentId}`);
    }
  }

  return true;
}

// ── Runner ───────────────────────────────────────────────────

const suites = [
  { name: "Docs",               fn: suiteDocs },
  { name: "Sheets",             fn: suiteSheets },
  { name: "Slides",             fn: suiteSlides },
  { name: "Gmail & Calendar",   fn: suiteGmailCalendar },
  { name: "Gmail Attachment Routing", fn: suiteGmailAttachmentRouting },
  { name: "Drive",              fn: suiteDrive },
  { name: "Guardrail/Negative", fn: suiteGuardrailNegative },
];

async function run() {
  const results = [];

  for (const suite of suites) {
    console.log(`\n${"█".repeat(50)}`);
    console.log(`  ${suite.name}`);
    console.log(`${"█".repeat(50)}`);

    const t0 = Date.now();
    try {
      await suite.fn();
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      results.push({ name: suite.name, pass: true, elapsed });
      console.log(`  ── PASS (${elapsed}s)`);
    } catch (e) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      results.push({ name: suite.name, pass: false, elapsed, error: e.message });
      console.error(`  ── FAIL (${elapsed}s): ${e.message}`);
    }
  }

  // Summary
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  FINAL SUMMARY`);
  console.log(`${"=".repeat(50)}`);

  for (const r of results) {
    const icon = r.pass ? "✓" : "✗";
    console.log(`  ${icon} [${r.pass ? "PASS" : "FAIL"}] ${r.name} (${r.elapsed}s)${r.error ? " — " + r.error : ""}`);
  }

  const passCount = results.filter(r => r.pass).length;
  console.log(`\n  ${passCount}/${results.length} suites passed.`);

  const allPassed = results.every(r => r.pass);
  if (allPassed) console.log(`\n✓ ALL SUITES PASSED`);
  else console.error(`\n✗ FAILED: ${results.filter(r => !r.pass).map(r => r.name).join(", ")}`);

  return { success: allPassed, suites: results };
}

return run();
