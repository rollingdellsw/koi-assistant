// ============================================================================
// Koi Interaction & Trap Stress Test
// Tests: Click, Hover, Trap System (Error/Network)
// ============================================================================

console.log("🧪 Starting Interaction & Trap Test...");

// Refresh the test page to start clean
await tools.navigatePage('http://localhost:8000/interaction_test.html');
await tools.waitFor({ event: "load", timeout: 5000 });

// FIX: Force reset to Main Context to clear state from previous tests
console.log("🔄 Resetting context to Main Document...");
await tools.resetContext();
await tools.readSkill({ name: "dom-interactor" });

// Helper: Typed wrapper for DOM tools
const dom = {
  get: async (selectorOrGlobal, prop) => {
    // Detect if it's a CSS selector vs global path
    // CSS selectors start with: # . [ or contain > : ~
    const isSelector = /^[#.\[]/.test(selectorOrGlobal) || /[>:~]/.test(selectorOrGlobal);
    const args = isSelector
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

console.log("⚠️ Please ensure 'interaction_test.html' is currently open in the active tab.");

// 1. Debug Current Context (Now safe because we are at root)
const pageTitle = await dom.get('document', 'title');

if (!pageTitle) {
  console.log("❌ ERROR: Could not read document title.");
  return;
}

if (!pageTitle.includes("Interaction & Trap Test")) {
  console.log(`❌ WRONG PAGE: Title is "${pageTitle}"`);
  console.log("   Please open 'interaction_test.html' and try again.");
  return;
}

console.log("✅ Page Verified. Starting Phase 1...");

// ────────────────────────────────────────────────────────────────────────────
// PHASE 0a: Snapshot Mode Tests
// ────────────────────────────────────────────────────────────────────────────
console.log("\n📋 PHASE 0a: Snapshot Mode Verification");

// readable mode (default) - clean text
const readableSnap = await tools.takeSnapshot({ selector: 'body' });
const readable = (typeof readableSnap === 'string' ? JSON.parse(readableSnap) : readableSnap);
console.log(`  Readable mode: ${readable.totalLength} chars, mode=${readable.mode || 'readable'}`);

// dom mode - compact tree for selectors
const domSnap = await tools.takeSnapshot({ selector: 'body', mode: 'dom', maxDepth: 5 });
const domResult = (typeof domSnap === 'string' ? JSON.parse(domSnap) : domSnap);
console.log(`  DOM mode: ${domResult.totalLength} chars, mode=${domResult.mode || 'dom'}`);
console.log(`  DOM preview:\n${domResult.content?.substring(0, 300)}`);

// full mode - raw legacy
const fullSnap = await tools.takeSnapshot({ selector: 'body', mode: 'full' });
const fullResult = (typeof fullSnap === 'string' ? JSON.parse(fullSnap) : fullSnap);
console.log(`  Full mode: ${fullResult.totalLength} chars, mode=${fullResult.mode || 'full'}`);

// ────────────────────────────────────────────────────────────────────────────
// PHASE 0: Request Action (User-Assisted Highlight)
// ────────────────────────────────────────────────────────────────────────────
console.log("\n📋 PHASE 0: Request Action (Highlight + Tooltip)");

// Use search_dom to find the Click Me button
console.log("  Searching for 'Click Me' button...");
const searchResult = await tools.searchDom("Click Me");
// Core tools return parsed objects directly (not MCP { content: [{text}] } format)
const searchData = searchResult;

if (!searchData.matches || searchData.matches.length === 0) {
  console.log("❌ FAIL: Could not find 'Click Me' button via search_dom");
} else {
  const match = searchData.matches[0];
  console.log(`  Found button: selector="${match.selector}", text="${match.text}"`);

  // Call request_action to highlight and prompt the user
  console.log("  Calling request_action to highlight the button...");
  try {
    const raResult = await tools.requestAction({
      selector: match.selector,
      action: "click",
      description: "Click Me button in Main Context"
    });
    console.log("  raw raResult:", JSON.stringify(raResult));
    // Core tools return parsed objects directly
    const raData = (typeof raResult === 'string') ? JSON.parse(raResult) : raResult;

    if (raData.success) {
      console.log("✅ PASS: request_action highlighted the element");
      console.log("   Status: " + (raData.status || "ok"));
      console.log("   Message: " + (raData.message || ""));
    } else {
      console.log("❌ FAIL: request_action returned error: " + (raData.error || JSON.stringify(raData)));
    }
  } catch (e) {
    console.log("❌ FAIL: request_action threw: " + e.message);
  }

  // Wait a moment so user can see the highlight, then proceed
  await tools.sleep(3000);
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 1: Basic Interaction (Click & Hover)
// ────────────────────────────────────────────────────────────────────────────
console.log("\n📋 PHASE 1: Basic Interaction");

// Test Click
console.log("  Testing click...");
await tools.click('#btn-main');
const btnText = await dom.get('#btn-main', 'innerText');
if (btnText === 'CLICKED') {
  console.log("✅ PASS: Main button clicked");
} else {
  console.log(`❌ FAIL: Button text is '${btnText}'`);
}

// Test Hover
console.log("  Testing hover...");
await tools.hover('#hover-target');

// Verify JS event trigger (Synthetic events trigger listeners, but not CSS :hover)
const hoverText = await dom.get('#hover-target', 'innerText');

if (hoverText === 'HOVERED_JS') {
  console.log("✅ PASS: Hover triggered JS event");
} else {
  console.log(`❌ FAIL: Hover text is '${hoverText}' (Expected 'HOVERED_JS')`);
  console.log("   Note: Synthetic events do not trigger CSS :hover states.");
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 2: Shadow DOM Interaction
// ────────────────────────────────────────────────────────────────────────────
console.log("\n📋 PHASE 2: Shadow DOM Interaction");

// Enter Shadow
await tools.enterShadow('#shadow-host');

// Click inside shadow
console.log("  Clicking inside Shadow DOM...");
await tools.click('#btn-shadow');

// Verify - in shadow context, we can use dom.get directly
const shadowBtnText = await dom.get('#btn-shadow', 'innerText');

if (shadowBtnText === 'SHADOW CLICKED') {
  console.log("✅ PASS: Shadow DOM button clicked");
} else {
  console.log(`❌ FAIL: Shadow button text is '${shadowBtnText}'`);
}

// Exit back to main for Traps
await tools.resetContext();

// ────────────────────────────────────────────────────────────────────────────
// PHASE 3: Trap System (The Critical Test)
// ────────────────────────────────────────────────────────────────────────────
console.log("\n📋 PHASE 3: Trap System Verification");

// A. Test Error Trap
console.log("  A. Testing Error Trap...");
await tools.setTrap('test_error_trap', 'error');

// Trigger error (this button throws an error onclick)
await tools.click('#btn-error');
await tools.sleep(500); // Give time for trap to catch it

// Verify: Check if the trap registered in the page.
const trapRegistered = await dom.get('window.__deftTraps.test_error_trap', 'constructor.name');

if (trapRegistered === 'Object') {
  console.log("✅ PASS: Error trap registered in page");
} else {
  console.log("❌ FAIL: Trap not found in window object");
}

// Clean up
await tools.removeTrap('test_error_trap');

// B. Test Network Trap
console.log("  B. Testing Network Trap...");
await tools.setTrap('test_net_trap', 'network');

await tools.click('#btn-network');
await tools.sleep(1000); // Wait for fetch to fail

// Check if trap is still active (it should be)
// Note: hasOwnProperty is a method, not a property, so we need a different approach
try {
  const trapObj = await dom.get('window.__deftTraps.test_net_trap', 'constructor.name');
  const netTrapExists = (trapObj === 'Object');

  if (netTrapExists) {
    console.log("✅ PASS: Network trap registered");
  } else {
    console.log("❌ FAIL: Network trap not found");
  }
} catch (e) {
  console.log("❌ FAIL: Network trap not found - " + e.message);
}

await tools.removeTrap('test_net_trap');

console.log("\n🎉 Interaction Test Complete!");
