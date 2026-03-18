// skills/cdp-trap-test/scripts/cdp.js
await tools.readSkill({ name: "dom-interactor" });

console.log("🚀 Starting Bridge Validation Suite (Handle-Based)...");

// Refresh the test page to start clean
await tools.navigatePage('http://localhost:8000/cdp_trap_test.html');
await tools.waitFor({ event: "load", timeout: 5000 });

await tools.resetContext();

// Helper: Typed wrapper for new DOM tools
const dom = {
  get: async (selectorOrGlobal, prop) => {
    const args = selectorOrGlobal.startsWith?.('#') || selectorOrGlobal.startsWith?.('.')
      ? { selector: selectorOrGlobal, property: prop }
      : { global: selectorOrGlobal, property: prop };

    const res = await tools.dom_get_property(args);
    if (res.isError) throw new Error(res.content[0].text);
    return JSON.parse(res.content[0].text);
  },
  call: async (selector, method, args=[]) => {
    const res = await tools.dom_call_method({ selector, method, args });
    if (res.isError) throw new Error(res.content[0].text);
    return JSON.parse(res.content[0].text);
  }
};

// Ensure test page
try {
  const title = await dom.get("document", "title");
  if (!title || !title.includes("Koi Bridge")) {
    console.log("❌ WRONG PAGE. Title:", title);
    return;
  }
} catch (e) {
  console.error("❌ Failed to get title:", e.message);
  return;
}

// ---------------------------------------------------------
// TEST 1: Input
// ---------------------------------------------------------
console.log("\n🧪 TEST 1: Input");

// 1. Focus
await dom.call("#cdp-input", "focus");

// 2. Type "Hello" (Using native tool for robustness)
await tools.fill("#cdp-input", "Hello");

// 3. Press Enter (Native tool)
try {
  await tools.pressKey("Enter");
} catch (e) {
  console.log("⚠️ CDP Key press failed (permission?):", e);
}

// 4. Verify
const logText = await dom.get("#key-log", "innerText");
if (logText && logText.includes("Enter")) {
  console.log("✅ PASS: 'Enter' detected.");
} else {
  console.log("❌ FAIL: 'Enter' not detected. Log:", logText);
}

// ... Rest of test (Network Traps) remains the same as it uses native tools ...
console.log("\n🧪 TEST 2: Network Traps...");
await tools.setTrap("test_net_trap", "network");
await tools.click("#btn-fetch-404");
await tools.sleep(500);
// ...
