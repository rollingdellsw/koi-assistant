// ============================================================================
// Koi Interaction & Trap Stress Test
// Tests: Click, Hover, Trap System (Error/Network)
// ============================================================================

console.log("🧪 Starting Wait-for Test...");

// Refresh the test page to start clean
await tools.navigatePage('http://localhost:8000/interaction_test.html');
await tools.waitFor({ event: "load", timeout: 5000 });

// FIX: Force reset to Main Context to clear state from previous tests
console.log("🔄 Resetting context to Main Document...");
await tools.resetContext();

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
// PHASE 1: Event Polling (Wait For User)
// ────────────────────────────────────────────────────────────────────────────
console.log("\n📋 PHASE 1: Event Polling / Watch For Test");
console.log("ℹ️ Assistant is guiding you via a visual hint...");

const targetSelector = '#hover-target';

// Ensure the element is visible
await tools.dom_call_method({ selector: targetSelector, method: 'scrollIntoView' });

// Use highlightElement to show the persistent "hint" overlay
await tools.requestAction({
  action: "click",
  selector: targetSelector,
  value: "👆 PLEASE CLICK HERE: The agent is watching for this element to change state."
});

let detected = false;
const timeout = 15000;
const start = Date.now();

console.log("  Waiting for element text to change to 'CLICKED_BY_USER'...");

while (Date.now() - start < timeout) {
  const currentText = await dom.get(targetSelector, 'innerText');
  if (currentText === 'CLICKED_BY_USER') {
    detected = true;
    break;
  }
  await tools.sleep(500); // Poll every 500ms
}

if (detected) {
  console.log("✅ PASS: Successfully detected user interaction via polling!");
} else {
  console.log("❌ FAIL: Timeout waiting for user interaction.");
}

console.log("\n🎉 Wait-for Test Complete!");
