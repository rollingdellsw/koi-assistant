
// ============================================================================
// Chrome Developer Tools MCP - Integration Test
// Tests: click, fill, hover, press_key, set_trap, remove_trap
// via the devtools MCP server (runtime.evaluateScript path)
//
// Uses: interaction_test.html and cdp_trap_test.html at localhost:8000
// Run: /skill chrome-developer-tools/scripts/devtools-test.js --full-auto
// ============================================================================

await tools.readSkill({ name: "dom-interactor" });
await tools.readSkill({ name: "chrome-developer-tools" });

console.log("🧪 ════════════════════════════════════════════════════════════");
console.log("🧪 CHROME DEVELOPER TOOLS MCP - Integration Test");
console.log("🧪 ════════════════════════════════════════════════════════════\n");

// Helper: read DOM via dom-interactor MCP
const dom = {
  get: async (selectorOrGlobal, prop) => {
    const isSelector = /^[#.\[]/.test(selectorOrGlobal) || /[>:~]/.test(selectorOrGlobal);
    const params = isSelector
      ? { selector: selectorOrGlobal, property: prop }
      : { global: selectorOrGlobal, property: prop };
    const res = await tools.dom_get_property(params);
    if (res.isError) throw new Error(res.content[0].text);
    return JSON.parse(res.content[0].text);
  }
};

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`✅ PASS: ${message}`);
  } else {
    failed++;
    errors.push(message);
    console.log(`❌ FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`✅ PASS: ${message}`);
  } else {
    failed++;
    const full = `${message} (expected: "${expected}", got: "${actual}")`;
    errors.push(full);
    console.log(`❌ FAIL: ${full}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// PART A: interaction_test.html — click, hover, fill (shadow)
// ────────────────────────────────────────────────────────────────────────────
await tools.navigatePage('http://localhost:8000/interaction_test.html');
await tools.waitFor({ event: "load", timeout: 5000 });
await tools.resetContext();

const pageTitle = await dom.get('document', 'title');
assert(pageTitle && pageTitle.includes("Interaction"), `Page A loaded: "${pageTitle}"`);

// --- click ---
console.log("\n📋 PHASE 1: click");
console.log("─".repeat(60));

const clickTarget = '#btn-main';
const beforeClick = await dom.get(clickTarget, 'innerText');
console.log(`  Before: "${beforeClick}"`);

const clickRes = await tools.click(clickTarget);
assert(!clickRes.isError, "click returned success");
await tools.sleep(100);

const afterClick = await dom.get(clickTarget, 'innerText');
assertEqual(afterClick, "CLICKED", "button text changed to CLICKED");

// --- hover ---
console.log("\n📋 PHASE 2: hover");
console.log("─".repeat(60));

const hoverTarget = '#hover-target';
// Reset hover-target text first by clicking (sets to CLICKED_BY_USER),
// then we test hover changes it
const hoverRes = await tools.hover(hoverTarget);
assert(!hoverRes.isError, "hover returned success");

// hover dispatches mouseenter which sets innerText to HOVERED_JS
await tools.sleep(100);
const afterHover = await dom.get(hoverTarget, 'innerText');
assertEqual(afterHover, "HOVERED_JS", "hover triggered mouseenter handler");

// --- click in shadow DOM ---
console.log("\n📋 PHASE 3: click inside shadow DOM");
console.log("─".repeat(60));

await tools.enterShadow('#shadow-host');

const shadowBtn = '#btn-shadow';
const beforeShadow = await dom.get(shadowBtn, 'innerText');
console.log(`  Before: "${beforeShadow}"`);

const shadowClickRes = await tools.click(shadowBtn);
assert(!shadowClickRes.isError, "click inside shadow DOM returned success");
await tools.sleep(100);

const afterShadow = await dom.get(shadowBtn, 'innerText');
assertEqual(afterShadow, "SHADOW CLICKED", "shadow button text changed");

await tools.resetContext();

// ────────────────────────────────────────────────────────────────────────────
// PART B: cdp_trap_test.html — fill, press_key, set_trap, remove_trap
// ────────────────────────────────────────────────────────────────────────────
await tools.navigatePage('http://localhost:8000/cdp_trap_test.html');
await tools.waitFor({ event: "load", timeout: 5000 });
await tools.resetContext();

const pageB = await dom.get('document', 'title');
assert(pageB && pageB.includes("CDP"), `Page B loaded: "${pageB}"`);

// --- fill ---
console.log("\n📋 PHASE 4: fill");
console.log("─".repeat(60));

const input = '#cdp-input';
const fillValue = `MCP-Test-${Date.now()}`;

const fillRes = await tools.fill(input, fillValue);
assert(!fillRes.isError, "fill returned success");

const readBack = await dom.get(input, 'value');
assertEqual(readBack, fillValue, "fill value persisted in DOM");

// --- press_key ---
console.log("\n📋 PHASE 5: press_key");
console.log("─".repeat(60));

// Focus the input first
await tools.click(input);
await tools.sleep(50);

const keyRes = await tools.pressKey('Enter');
assert(!keyRes.isError, "pressKey('Enter') returned success");
await tools.sleep(100);

// cdp_trap_test.html logs "KeyDown: Enter (Trusted: false)" to #key-log
const keyLog = await dom.get('#key-log', 'innerText');
assert(keyLog && keyLog.includes("Enter"), `key-log captured Enter: "${keyLog}"`);

const comboRes = await tools.pressKey('Control+a');
assert(!comboRes.isError, "pressKey('Control+a') returned success");

const escRes = await tools.pressKey('Escape');
assert(!escRes.isError, "pressKey('Escape') returned success");

// --- set_trap / remove_trap ---
console.log("\n📋 PHASE 6: set_trap / remove_trap");
console.log("─".repeat(60));

const trapRes = await tools.setTrap('test-error-trap', 'error', {});
assert(!trapRes.isError, "setTrap (error) returned success");

const trapRes2 = await tools.setTrap('test-net-trap', 'network', {});
assert(!trapRes2.isError, "setTrap (network) returned success");

const removeRes = await tools.removeTrap('test-error-trap');
assert(!removeRes.isError, "removeTrap (error) returned success");

const removeRes2 = await tools.removeTrap('test-net-trap');
assert(!removeRes2.isError, "removeTrap (network) returned success");

// Non-existent trap should not crash
const removeRes3 = await tools.removeTrap('non-existent');
assert(!removeRes3.isError, "removeTrap (non-existent) is graceful");

// ════════════════════════════════════════════════════════════════════════════
// Report
// ════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 ════════════════════════════════════════════════════════════");
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log(`📊 Total:  ${passed + failed}`);

if (errors.length > 0) {
  console.log("\n❌ Failed tests:");
  errors.forEach((e, i) => console.log(`   ${i + 1}. ${e}`));
}

if (failed === 0) {
  console.log("\n🎉 ALL TESTS PASSED!");
} else {
  console.log("\n⚠️ Some tests failed. Review above.");
}

return { passed, failed, total: passed + failed, errors };
