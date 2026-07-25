// scripts/monaco-test.js
// Monaco MCP test script
// Usage: Navigate to a page with a Monaco editor (e.g., https://microsoft.github.io/monaco-editor/)
// Then run: /skill monaco-editor/scripts/monaco-test.js --full-auto

await tools.readSkill({ name: "monaco-editor" });
console.log("Starting Monaco MCP Test...");

await tools.navigatePage('https://microsoft.github.io/monaco-editor/');
await tools.waitFor({ event: "load", timeout: 5000 });
await tools.resetContext();

async function run() {
  try {
    console.log("1. Finding editors...");
    const findRes = await tools.monaco_find({});
    if (findRes.isError) throw new Error(findRes.content[0].text);

    const editors = JSON.parse(findRes.content[0].text);
    if (editors.length === 0) {
      console.log("No editors found. Please run this on a page with a Monaco editor.");
      return { success: false, reason: "No editors found" };
    }

    const handle = editors[0].handle;
    console.log(`✓ Found ${editors.length} editor(s). Using handle: ${handle}`);
    console.log(`   Language: ${editors[0].language}, Lines: ${editors[0].lineCount}`);

    console.log("\n2. Reading text...");
    const readRes = await tools.monaco_read({ handle });
    if (readRes.isError) throw new Error(readRes.content[0].text);
    const originalText = readRes.content[0].text;
    console.log(`✓ Read ${originalText.length} characters. Preview:`);
    console.log(originalText.slice(0, 80).replace(/\n/g, " ") + "...");

    console.log("\n3. Replacing lines 10-20...");
    const replacementContent =
      "// =========================================\n" +
      "// REPLACED CONTENT FROM KOI ASSISTANT MCP\n" +
      "// Lines 10 through 20 were overwritten.\n" +
      "// =========================================";

    const editRes = await tools.monaco_edit_lines({
      handle,
      startLine: 10,
      endLine: 20,
      text: replacementContent
    });
    if (editRes.isError) throw new Error(editRes.content[0].text);
    console.log(`✓ Lines 10-20 replaced successfully.`);

    console.log("\n4. Reading back to verify...");
    const verifyRes = await tools.monaco_read({ handle });
    if (verifyRes.isError) throw new Error(verifyRes.content[0].text);

    const verifyText = verifyRes.content[0].text;
    const verifyLines = verifyText.split('\n');

    if (verifyLines[9] === "// =========================================") {
      console.log("✓ Verification PASS: New content found at Line 10!");
    } else {
      console.log("✗ Verification FAIL: Content did not match expected output.");
    }

    console.log("\n5. Releasing handle...");
    await tools.monaco_release({ handle });
    console.log(`✓ Handle released.`);

    return { success: true };
  } catch (e) {
    console.error(`✗ TEST FAILED: ${e.message}`);
    return { success: false, error: e.message };
  }
}

return run();
