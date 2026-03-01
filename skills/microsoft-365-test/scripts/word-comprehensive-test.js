// scripts/word-comprehensive-test.js
// Word Online comprehensive test
// Covers: word_create, word_get_metadata, word_read_content, word_batch_update
// NOTE: MS Graph Word API uses whole-file replacement (HTML upload), not incremental edits.
//       This is fundamentally different from Google Docs API.

await tools.readSkill({ name: "microsoft-365" });
console.log("Starting Word Online Comprehensive Test...");

const RUN_ID = Math.floor(Math.random() * 1000);
const DOC_TITLE = `Koi Word Test ${new Date().toLocaleTimeString().replace(/:/g, '-')} (Run ${RUN_ID})`;

async function run() {
  try {
    // ---------------------------------------------------------
    // PART 1: READ-ONLY TEST (Existing Document)
    // ---------------------------------------------------------
    let existingItemId = null;
    if (typeof args !== 'undefined') {
      if (args.itemId) existingItemId = args.itemId;
    }

    if (existingItemId) {
      console.log(`\n==================================================`);
      console.log(`PART 1: READ-ONLY VERIFICATION`);
      console.log(`Target ID: ${existingItemId}`);
      console.log(`==================================================`);

      // A. Metadata
      console.log(`\n[1/3] Fetching Metadata...`);
      const metaRes = await tools.word_get_metadata({ itemId: existingItemId });
      const metaText = metaRes.content ? metaRes.content[0].text : "{}";

      try {
        const meta = JSON.parse(metaText);
        console.log(`✓ Name: "${meta.name}"`);
        console.log(`✓ Size: ${meta.size} bytes`);
        console.log(`✓ Last Modified: ${meta.lastModified}`);
        console.log(`✓ URL: ${meta.webUrl}`);
      } catch (e) {
        console.warn(`⚠️ Meta Parse Error: ${metaText.slice(0, 200)}`);
      }

      // B. Read Content
      console.log(`\n[2/3] Reading Content...`);
      const contentRes = await tools.word_read_content({ itemId: existingItemId });
      const contentText = contentRes.content ? contentRes.content[0].text : "{}";

      try {
        const content = JSON.parse(contentText);
        console.log(`✓ Content (${content.totalLength} chars total, ${content.returnedLength} returned):`);
        console.log(`   "${(content.text || "").slice(0, 100).replace(/\n/g, ' ')}..."`);
      } catch (e) {
        console.warn(`⚠️ Content Parse Error: ${contentText.slice(0, 200)}`);
      }

      // C. Read with pagination
      console.log(`\n[3/3] Testing Content Pagination (startIndex/endIndex)...`);
      const pageRes = await tools.word_read_content({ itemId: existingItemId, startIndex: 0, endIndex: 50 });
      const pageText = pageRes.content ? pageRes.content[0].text : "{}";
      try {
        const pageData = JSON.parse(pageText);
        console.log(`✓ Paginated read: ${pageData.returnedLength} chars (requested 0-50)`);
      } catch (e) {
        console.warn(`⚠️ Pagination parse error`);
      }

      console.log(`\nPart 1 Complete.\n`);
    } else {
      console.log("\n(Skipping Part 1: No --itemId provided)");
    }

    // ---------------------------------------------------------
    // PART 2: CREATION & WRITE VERIFICATION
    // ---------------------------------------------------------
    console.log(`\n==================================================`);
    console.log(`PART 2: CREATION & WRITE VERIFICATION`);
    console.log(`==================================================`);

    console.log(`\n[1/5] Creating Document: "${DOC_TITLE}"...`);
    const createResult = await tools.word_create({ title: DOC_TITLE });

    let itemId = null;
    if (createResult.content) {
      for (const block of createResult.content) {
        if (block._createdFileId) {
          itemId = block._createdFileId;
          break;
        }
        if (typeof block.text === 'string') {
          const match = block.text.match(/Created document: (\S+)/);
          if (match) itemId = match[1];
        }
      }
    }

    if (!itemId) throw new Error("Failed to extract itemId from word_create");
    console.log(`✓ Created. ID: ${itemId}`);

    // 2. Write Content via HTML upload
    console.log(`\n[2/5] Writing Content (HTML upload — replaces entire doc)...`);

    const htmlContent = `
      <html>
      <body>
        <h1>Koi Word Test - Run ${RUN_ID}</h1>
        <p>Welcome to the automated Word document test.</p>
        <p>This document was created by the Koi agent at ${new Date().toISOString()}.</p>
        <h2>References</h2>
        <p>Check this reference: <a href="https://www.google.com">Google Search</a></p>
        <p>And this one: <a href="https://www.microsoft.com">Microsoft Home</a></p>
        <h2>Table Test</h2>
        <table border="1">
          <tr><th>Name</th><th>Value</th></tr>
          <tr><td>Alpha</td><td>100</td></tr>
          <tr><td>Beta</td><td>200</td></tr>
          <tr><td>Gamma</td><td>300</td></tr>
        </table>
        <h2>Image Test</h2>
        <img src="https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png" width="150" />
        <p>End of document.</p>
      </body>
      </html>
    `.trim();

    const writeRes = await tools.word_batch_update({ itemId, htmlContent });
    const writeText = writeRes.content ? writeRes.content[0].text : "";

    if (writeRes.isError || writeText.includes("error") || writeText.includes("Error")) {
      console.warn(`⚠️ Write failed: ${writeText.slice(0, 200)}`);
    } else {
      console.log("✓ Wrote HTML content to document");
    }

    // 3. Read back & verify
    console.log(`\n[3/5] Verifying Content...`);
    const verifyRes = await tools.word_read_content({ itemId });
    const verifyText = verifyRes.content ? verifyRes.content[0].text : "{}";

    try {
      const verifyData = JSON.parse(verifyText);
      const text = verifyData.text || "";
      console.log(`✓ Content length: ${verifyData.totalLength} chars`);

      if (text.includes("Koi Word Test")) {
        console.log(`✓ Title verified in content`);
      } else {
        console.warn(`⚠️ Title not found in content`);
      }

      if (text.includes("Alpha") && text.includes("Beta")) {
        console.log(`✓ Table data verified in content`);
      } else {
        console.warn(`⚠️ Table data not found`);
      }
    } catch (e) {
      console.warn(`⚠️ Verify parse error: ${verifyText.slice(0, 200)}`);
    }

    // 4. Second write (overwrite) to test idempotency
    console.log(`\n[4/5] Testing Second Write (Overwrite)...`);

    const htmlContent2 = `
      <html><body>
        <h1>Updated: Koi Word Test - Run ${RUN_ID}</h1>
        <p>This content replaces the previous version.</p>
        <p>Timestamp: ${new Date().toISOString()}</p>
      </body></html>
    `.trim();

    await tools.word_batch_update({ itemId, htmlContent: htmlContent2 });

    const verify2Res = await tools.word_read_content({ itemId });
    const verify2Text = verify2Res.content ? verify2Res.content[0].text : "{}";
    try {
      const v2 = JSON.parse(verify2Text);
      if ((v2.text || "").includes("Updated: Koi Word Test")) {
        console.log(`✓ Overwrite verified: new content present`);
      } else {
        console.warn(`⚠️ Overwrite content mismatch`);
      }
      if (!(v2.text || "").includes("Alpha")) {
        console.log(`✓ Old content removed (table no longer present)`);
      } else {
        console.warn(`⚠️ Old content still present after overwrite`);
      }
    } catch (e) {
      console.warn(`⚠️ Verify2 parse error`);
    }

    // 5. Get metadata and navigate
    console.log(`\n[5/5] Navigating to Document...`);
    const metaFinal = await tools.word_get_metadata({ itemId });
    let webUrl = null;
    try {
      const mf = JSON.parse(metaFinal.content[0].text);
      webUrl = mf.webUrl;
    } catch (e) {}

    if (webUrl) {
      console.log(` URL: ${webUrl}`);
      await tools.navigatePage(webUrl);
    } else {
      console.log(`   (Could not extract webUrl)`);
    }

    return {
      success: true,
      itemId,
      url: webUrl
    };

  } catch (e) {
    console.error("\n❌ TEST FAILED:", e.message);
    if (e.stack) console.error(e.stack);
    return { success: false, error: e.message };
  }
}

return run();
