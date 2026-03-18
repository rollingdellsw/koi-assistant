// ============================================================================
// Koi Browser Tools - Context Stress Test v3 (Enhanced)
// ============================================================================
//
// This enhanced test covers:
// 1. Linear descent/ascent (original test)
// 2. Random jumps within the context tree
// 3. Partial descent then reset
// 4. Repeated enter/exit at same level
// 5. Skip-level navigation (exit multiple, enter different branch)
// 6. Rapid context switching
// 7. Edge cases (exit at root, enter non-existent, etc.)
// 8. State isolation verification at each level
//
// Context Tree Structure:
//   L0: Main Document
//   └── L1: Shadow DOM L1 (#shadow-host-L1)
//       └── L2: Iframe L1 (#iframe-L1)
//           └── L3: Shadow DOM L2 (#shadow-host-L2)
//               └── L4: Iframe L2 (#iframe-L2)
//                   └── L5: Shadow DOM L3 (#shadow-host-L3)
//
// Run with: /run context-stress-v3
// ============================================================================

await tools.readSkill({ name: "dom-interactor" });

const CONTEXT_PATH = [
  { level: 0, type: 'main', name: 'Main Document', enter: null, selector: null },
  { level: 1, type: 'shadow', name: 'Shadow L1', enter: 'enterShadow', selector: '#shadow-host-L1' },
  { level: 2, type: 'iframe', name: 'Iframe L1', enter: 'enterIframe', selector: '#iframe-L1' },
  { level: 3, type: 'shadow', name: 'Shadow L2', enter: 'enterShadow', selector: '#shadow-host-L2' },
  { level: 4, type: 'iframe', name: 'Iframe L2', enter: 'enterIframe', selector: '#iframe-L2' },
  { level: 5, type: 'shadow', name: 'Shadow L3', enter: 'enterShadow', selector: '#shadow-host-L3' },
];

// Refresh the test page to start clean
await tools.navigatePage('http://localhost:8000/context_stress_test.html');
await tools.waitFor({ event: "load", timeout: 5000 });

// Helper: Typed wrapper for DOM tools (same as other tests)
const dom = {
  get: async (selectorOrGlobal, prop) => {
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

const TEST_VALUES = {};
for (let i = 0; i <= 5; i++) {
  TEST_VALUES[`L${i}`] = {
    text: `Layer${i}-Test-${Date.now()}`,
    email: `layer${i}-${Date.now()}@test.com`
  };
}

let passed = 0;
let failed = 0;
const errors = [];
const testLog = [];

// ============================================================================
// Test Utilities
// ============================================================================

function log(msg) {
  console.log(msg);
  testLog.push(msg);
}

function assert(condition, message) {
  if (condition) {
    passed++;
    log(`✅ PASS: ${message}`);
    return true;
  } else {
    failed++;
    errors.push(message);
    log(`❌ FAIL: ${message}`);
    return false;
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    log(`✅ PASS: ${message}`);
    return true;
  } else {
    failed++;
    const fullMsg = `${message} (expected: "${expected}", got: "${actual}")`;
    errors.push(fullMsg);
    log(`❌ FAIL: ${fullMsg}`);
    return false;
  }
}

async function getCurrentDepth() {
  const ctx = await tools.getContext();
  return ctx.depth;
}

async function assertDepth(expected, message) {
  const actual = await getCurrentDepth();
  return assertEqual(actual, expected, message || `Depth should be ${expected}`);
}

// Navigate to a specific level from current position
async function navigateToLevel(targetLevel) {
  const ctx = await tools.getContext();
  const currentLevel = ctx.depth - 1; // depth 1 = level 0

  if (targetLevel === currentLevel) {
    return true;
  }

  if (targetLevel < currentLevel) {
    // Need to go up
    const steps = currentLevel - targetLevel;
    for (let i = 0; i < steps; i++) {
      await tools.exitContext();
    }
  } else {
    // Need to go down
    for (let level = currentLevel + 1; level <= targetLevel; level++) {
      const pathEntry = CONTEXT_PATH[level];
      if (pathEntry.enter === 'enterShadow') {
        await tools.enterShadow(pathEntry.selector);
      } else if (pathEntry.enter === 'enterIframe') {
        await tools.enterIframe(pathEntry.selector);
      }
    }
  }

  return await getCurrentDepth() === targetLevel + 1;
}

// Fill form at current level
async function fillCurrentLevel(level) {
  const testData = TEST_VALUES[`L${level}`];
  if (!testData) return false;

  try {
    await tools.fill(`[data-testid="input-L${level}-text"]`, testData.text);
    await tools.sleep(50);
    return true;
  } catch (e) {
    log(`⚠️ Fill failed at L${level}: ${e.message}`);
    return false;
  }
}

// Verify form value at current level
async function verifyCurrentLevel(level) {
  const testData = TEST_VALUES[`L${level}`];
  if (!testData) return false;

  try {
    // Use handle-based approach instead of evaluateScript
    const value = await dom.get(`[data-testid="input-L${level}-text"]`, 'value');
    return value === testData.text;
  } catch (e) {
    return false;
  }
}

// Pseudo-random number generator with seed for reproducibility
function seededRandom(seed) {
  let state = seed;
  return function() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

// ============================================================================
// Test Phases
// ============================================================================

log("🧪 ════════════════════════════════════════════════════════════");
log("🧪 CONTEXT STRESS TEST v3 (Enhanced) - Starting");
log("🧪 ════════════════════════════════════════════════════════════\n");

const startTime = Date.now();

// Reset and verify starting state
await tools.resetContext();
await tools.waitFor({ selector: 'h1', timeout: 5000 });

// ────────────────────────────────────────────────────────────────────────────
// PHASE 1: Basic Linear Navigation (Original Test)
// ────────────────────────────────────────────────────────────────────────────
log("\n📋 PHASE 1: Basic Linear Navigation");
log("─".repeat(60));

await assertDepth(1, "Starting at main (depth 1)");

// Descend to deepest level
for (let level = 1; level <= 5; level++) {
  const entry = CONTEXT_PATH[level];
  log(`  Entering ${entry.name}...`);

  if (entry.enter === 'enterShadow') {
    const result = await tools.enterShadow(entry.selector);
    assert(result.success, `Entered ${entry.name}`);
  } else {
    const result = await tools.enterIframe(entry.selector);
    assert(result.success, `Entered ${entry.name}`);
  }

  await assertDepth(level + 1, `Depth is ${level + 1} after entering ${entry.name}`);
}

// Ascend back to main
for (let level = 5; level >= 1; level--) {
  await tools.exitContext();
  await assertDepth(level, `Depth is ${level} after exiting from level ${level}`);
}

log("✅ Phase 1 Complete: Linear navigation working\n");

// ────────────────────────────────────────────────────────────────────────────
// PHASE 2: Edge Cases
// ────────────────────────────────────────────────────────────────────────────
log("\n📋 PHASE 2: Edge Cases");
log("─".repeat(60));

// Test: Exit at root should fail gracefully
await tools.resetContext();
const exitAtRoot = await tools.exitContext();
assert(!exitAtRoot.success || exitAtRoot.error, "Exit at root returns error (expected)");
await assertDepth(1, "Still at depth 1 after failed exit");

// Test: Enter non-existent shadow DOM
const badShadow = await tools.enterShadow("#non-existent-shadow");
assert(!badShadow.success, "Enter non-existent shadow fails gracefully");
await assertDepth(1, "Still at depth 1 after failed enter");

// Test: Enter non-existent iframe
const badIframe = await tools.enterIframe("#non-existent-iframe");
assert(!badIframe.success, "Enter non-existent iframe fails gracefully");
await assertDepth(1, "Still at depth 1 after failed iframe enter");

// Test: Enter wrong type (try to enter shadow on an iframe selector)
await tools.enterShadow("#shadow-host-L1");
await assertDepth(2, "At shadow L1");
const wrongType = await tools.enterShadow("#iframe-L1"); // iframe, not shadow
assert(!wrongType.success, "Enter shadow on iframe element fails");
await assertDepth(2, "Still at depth 2 after wrong type enter");

await tools.resetContext();
log("✅ Phase 2 Complete: Edge cases handled correctly\n");

// ────────────────────────────────────────────────────────────────────────────
// PHASE 3: Partial Descent + Reset
// ────────────────────────────────────────────────────────────────────────────
log("\n📋 PHASE 3: Partial Descent + Reset");
log("─".repeat(60));

// Go partway down
await tools.enterShadow("#shadow-host-L1");
await tools.enterIframe("#iframe-L1");
await tools.enterShadow("#shadow-host-L2");
await assertDepth(4, "At depth 4 (Shadow L2)");

// Reset should jump straight to main
await tools.resetContext();
await assertDepth(1, "Reset from depth 4 brings to depth 1");

// Do it again from deepest level
await navigateToLevel(5);
await assertDepth(6, "At deepest level (depth 6)");
await tools.resetContext();
await assertDepth(1, "Reset from deepest brings to depth 1");

log("✅ Phase 3 Complete: Reset works from any depth\n");

// ────────────────────────────────────────────────────────────────────────────
// PHASE 4: Repeated Enter/Exit at Same Level
// ────────────────────────────────────────────────────────────────────────────
log("\n📋 PHASE 4: Repeated Enter/Exit at Same Level");
log("─".repeat(60));

const REPEAT_COUNT = 5;
for (let i = 0; i < REPEAT_COUNT; i++) {
  await tools.enterShadow("#shadow-host-L1");
  await assertDepth(2, `Iteration ${i + 1}: Entered shadow L1`);
  await tools.exitContext();
  await assertDepth(1, `Iteration ${i + 1}: Exited to main`);
}

// Same test but going deeper
await tools.enterShadow("#shadow-host-L1");
await tools.enterIframe("#iframe-L1");
await assertDepth(3, "At iframe L1");

for (let i = 0; i < REPEAT_COUNT; i++) {
  await tools.enterShadow("#shadow-host-L2");
  await assertDepth(4, `Iteration ${i + 1}: Entered shadow L2 from iframe`);
  await tools.exitContext();
  await assertDepth(3, `Iteration ${i + 1}: Back to iframe L1`);
}

await tools.resetContext();
log("✅ Phase 4 Complete: Repeated transitions stable\n");

// ────────────────────────────────────────────────────────────────────────────
// PHASE 5: State Isolation Verification
// ────────────────────────────────────────────────────────────────────────────
log("\n📋 PHASE 5: State Isolation Verification");
log("─".repeat(60));

// Fill forms at each level with unique values
const levelValues = {};
for (let level = 0; level <= 5; level++) {
  await navigateToLevel(level);
  await assertDepth(level + 1, `At level ${level} for filling`);

  const uniqueValue = `Unique-L${level}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  levelValues[level] = uniqueValue;

  await tools.fill(`[data-testid="input-L${level}-text"]`, uniqueValue);
  log(`  Filled L${level} with: ${uniqueValue.slice(0, 30)}...`);
}

// Now verify each level still has its value (navigate in reverse)
log("  Verifying values are isolated...");
for (let level = 5; level >= 0; level--) {
  await navigateToLevel(level);

  // Use handle-based approach instead of evaluateScript
  const value = await dom.get(`[data-testid="input-L${level}-text"]`, 'value');

  assertEqual(value, levelValues[level], `L${level} value preserved after navigation`);
}

await tools.resetContext();
log("✅ Phase 5 Complete: State isolation verified\n");

// ────────────────────────────────────────────────────────────────────────────
// PHASE 6: Random Navigation Sequences
// ────────────────────────────────────────────────────────────────────────────
log("\n📋 PHASE 6: Random Navigation Sequences");
log("─".repeat(60));

const RANDOM_ITERATIONS = 20;
const random = seededRandom(42); // Deterministic for reproducibility

for (let i = 0; i < RANDOM_ITERATIONS; i++) {
  const currentCtx = await tools.getContext();
  const currentLevel = currentCtx.depth - 1;

  // Randomly choose: go up, go down, reset, or stay
  const action = random();

  if (action < 0.3 && currentLevel < 5) {
    // Go down one level
    const nextLevel = currentLevel + 1;
    const entry = CONTEXT_PATH[nextLevel];
    log(`  [${i + 1}] ↓ Descending to ${entry.name}`);

    if (entry.enter === 'enterShadow') {
      await tools.enterShadow(entry.selector);
    } else {
      await tools.enterIframe(entry.selector);
    }
    await assertDepth(nextLevel + 1, `Random nav: at ${entry.name}`);

  } else if (action < 0.6 && currentLevel > 0) {
    // Go up one level
    log(`  [${i + 1}] ↑ Ascending from level ${currentLevel}`);
    await tools.exitContext();
    await assertDepth(currentLevel, `Random nav: exited to level ${currentLevel - 1}`);

  } else if (action < 0.75) {
    // Reset to main
    log(`  [${i + 1}] ⟲ Resetting to main from level ${currentLevel}`);
    await tools.resetContext();
    await assertDepth(1, "Random nav: reset to main");

  } else {
    // Stay and verify
    log(`  [${i + 1}] ● Staying at level ${currentLevel}, verifying...`);
    const search = await tools.searchDom(`[data-testid="input-L${currentLevel}-text"]`);
    assert(search.count > 0, `Random nav: can find L${currentLevel} input`);
  }
}

await tools.resetContext();
log("✅ Phase 6 Complete: Random navigation stable\n");

// ────────────────────────────────────────────────────────────────────────────
// PHASE 7: Rapid Context Switching
// ────────────────────────────────────────────────────────────────────────────
log("\n📋 PHASE 7: Rapid Context Switching (No Delays)");
log("─".repeat(60));

const RAPID_ITERATIONS = 10;
const rapidErrors = [];

for (let i = 0; i < RAPID_ITERATIONS; i++) {
  try {
    // Rapid descent
    await tools.enterShadow("#shadow-host-L1");
    await tools.enterIframe("#iframe-L1");
    await tools.enterShadow("#shadow-host-L2");

    const midDepth = await getCurrentDepth();
    if (midDepth !== 4) {
      rapidErrors.push(`Iteration ${i + 1}: Expected depth 4, got ${midDepth}`);
    }

    // Rapid ascent
    await tools.exitContext();
    await tools.exitContext();
    await tools.exitContext();

    const endDepth = await getCurrentDepth();
    if (endDepth !== 1) {
      rapidErrors.push(`Iteration ${i + 1}: Expected depth 1, got ${endDepth}`);
    }
  } catch (e) {
    rapidErrors.push(`Iteration ${i + 1}: Exception - ${e.message}`);
  }
}

if (rapidErrors.length === 0) {
  passed++;
  log(`✅ PASS: All ${RAPID_ITERATIONS} rapid switching iterations succeeded`);
} else {
  failed++;
  errors.push(`Rapid switching: ${rapidErrors.length} errors`);
  log(`❌ FAIL: Rapid switching had ${rapidErrors.length} errors:`);
  rapidErrors.forEach(e => log(`     ${e}`));
}

await tools.resetContext();
log("✅ Phase 7 Complete: Rapid switching stable\n");

// ────────────────────────────────────────────────────────────────────────────
// PHASE 8: Jump Navigation (Skip Levels)
// ────────────────────────────────────────────────────────────────────────────
log("\n📋 PHASE 8: Jump Navigation (Multiple Exits)");
log("─".repeat(60));

// Go to deepest level
await navigateToLevel(5);
await assertDepth(6, "At deepest level");

// Exit multiple times in succession
await tools.exitContext();
await tools.exitContext();
await tools.exitContext();
await assertDepth(3, "Jumped from L5 to L2 (3 exits)");

// Go back down partially
await tools.enterShadow("#shadow-host-L2");
await assertDepth(4, "Re-entered Shadow L2");

// Reset from middle
await tools.resetContext();
await assertDepth(1, "Reset from middle");

log("✅ Phase 8 Complete: Jump navigation working\n");

// ────────────────────────────────────────────────────────────────────────────
// PHASE 9: Context Stack Integrity Check
// ────────────────────────────────────────────────────────────────────────────
log("\n📋 PHASE 9: Context Stack Integrity Check");
log("─".repeat(60));

// Build up context and verify stack at each step
const expectedStack = [{ type: 'main', depth: 1 }];

for (let level = 1; level <= 5; level++) {
  const entry = CONTEXT_PATH[level];

  if (entry.enter === 'enterShadow') {
    await tools.enterShadow(entry.selector);
  } else {
    await tools.enterIframe(entry.selector);
  }

  expectedStack.push({ type: entry.type, depth: level + 1 });

  const ctx = await tools.getContext();

  // Verify stack length
  assertEqual(ctx.stack.length, expectedStack.length, `Stack length is ${expectedStack.length} at L${level}`);

  // Verify each stack entry type
  let stackValid = true;
  for (let i = 0; i < expectedStack.length; i++) {
    if (ctx.stack[i].type !== expectedStack[i].type) {
      stackValid = false;
      break;
    }
  }
  assert(stackValid, `Stack types correct at L${level}`);
}

// Verify current context at deepest
const deepCtx = await tools.getContext();
assertEqual(deepCtx.current.type, 'shadow', "Current context type is shadow at deepest");
assert(deepCtx.current.selector === '#shadow-host-L3', "Current selector is #shadow-host-L3");

await tools.resetContext();
log("✅ Phase 9 Complete: Stack integrity verified\n");

// ────────────────────────────────────────────────────────────────────────────
// PHASE 10: Concurrent-like Access Pattern (Simulated)
// ────────────────────────────────────────────────────────────────────────────
log("\n📋 PHASE 10: Interleaved Operations Pattern");
log("─".repeat(60));

// Simulate a pattern where we do operations at different levels
// without fully ascending each time

await navigateToLevel(3); // Shadow L2
await assertDepth(4, "At Shadow L2");

// Do something at this level
const search3 = await tools.searchDom('[data-testid="input-L3-text"]');
assert(search3.count > 0, "Found L3 input while at L3");

// Go deeper
await tools.enterIframe("#iframe-L2");
await assertDepth(5, "At Iframe L2");

// Do something
const search4 = await tools.searchDom('[data-testid="input-L4-text"]');
assert(search4.count > 0, "Found L4 input while at L4");

// Come back up one
await tools.exitContext();
await assertDepth(4, "Back at Shadow L2");

// Verify L3 still accessible
const search3Again = await tools.searchDom('[data-testid="input-L3-text"]');
assert(search3Again.count > 0, "L3 input still accessible after partial navigation");

// Go all the way down
await tools.enterIframe("#iframe-L2");
await tools.enterShadow("#shadow-host-L3");
await assertDepth(6, "At deepest after interleaved ops");

// Verify deepest
const search5 = await tools.searchDom('[data-testid="input-L5-text"]');
assert(search5.count > 0, "L5 input accessible at deepest");

await tools.resetContext();
log("✅ Phase 10 Complete: Interleaved operations working\n");

// ────────────────────────────────────────────────────────────────────────────
// PHASE 11: True Concurrency (Race Condition Test)
// ────────────────────────────────────────────────────────────────────────────
log("\n📋 PHASE 11: True Concurrency (Promise.all)");
log("─".repeat(60));

await tools.resetContext();
await tools.enterShadow("#shadow-host-L1"); // At Depth 2

// Try to enter two different contexts simultaneously
// Logic dictates one should succeed, one might fail, but stack must remain valid
try {
  const results = await Promise.allSettled([
    tools.enterIframe("#iframe-L1"), // Valid move
    tools.exitContext()              // Valid move
  ]);

  const depth = await getCurrentDepth();
  log(`  Concurrency result depths: ${depth}`);

  // We just want to ensure the stack isn't corrupted (e.g. depth isn't null, stack matches depth)
  const ctx = await tools.getContext();
  assert(ctx.stack.length === ctx.depth, "Stack integrity maintained during race");

} catch (e) {
  log(`  Concurrency error (acceptable if handled gracefully): ${e.message}`);
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 12: Simulated Service Worker Restart (Persistence)
// ────────────────────────────────────────────────────────────────────────────
log("\n📋 PHASE 12: Simulated Service Worker Restart");
log("─".repeat(60));

// Setup: Go deep
await tools.resetContext();
await navigateToLevel(3);
await assertDepth(4, "Setup: At Depth 4");

// 1. Verify storage matches current memory
// Note: This requires a tool that can read chrome.storage.session directly
// OR, assuming you implement a 'clearCache' tool in your backend:
if (tools.debugClearCache) {
  log("  Simulating SW termination (clearing memory cache)...");
  await tools.debugClearCache();

  // 2. Perform operation. ContextManager should re-hydrate from storage.session
  const search = await tools.searchDom('[data-testid="input-L3-text"]');
  assert(search.count > 0, "Context recovered from storage after cache clear");
  await assertDepth(4, "Depth preserved after cache clear");
} else {
  log("⚠️ Skipping Phase 12: No 'debugClearCache' tool available");
}

// ════════════════════════════════════════════════════════════════════════════
// Final Report
// ════════════════════════════════════════════════════════════════════════════

const duration = Date.now() - startTime;

log("\n🧪 ════════════════════════════════════════════════════════════");
log("🧪 TEST RESULTS");
log("🧪 ════════════════════════════════════════════════════════════");
log(`✅ Passed: ${passed}`);
log(`❌ Failed: ${failed}`);
log(`📊 Total:  ${passed + failed}`);
log(`⏱️ Duration: ${duration}ms`);

if (errors.length > 0) {
  log("\n❌ Failed tests:");
  errors.slice(0, 20).forEach((e, i) => log(`   ${i + 1}. ${e}`));
  if (errors.length > 20) {
    log(`   ... and ${errors.length - 20} more`);
  }
}

const successRate = ((passed / (passed + failed)) * 100).toFixed(1);
log(`\n📈 Success Rate: ${successRate}%`);

if (failed === 0) {
  log("\n🎉 ALL TESTS PASSED! Context management is rock solid!");
} else if (failed <= 3) {
  log("\n⚠️ Minor issues detected. Review failed tests above.");
} else {
  log("\n🚨 Multiple failures detected. Context management needs attention.");
}

return {
  passed,
  failed,
  total: passed + failed,
  successRate: `${successRate}%`,
  duration: `${duration}ms`,
  errors: errors.slice(0, 20),
  phases: {
    linearNav: "Phase 1",
    edgeCases: "Phase 2",
    resetFromAny: "Phase 3",
    repeatedTransitions: "Phase 4",
    stateIsolation: "Phase 5",
    randomNav: "Phase 6",
    rapidSwitching: "Phase 7",
    jumpNav: "Phase 8",
    stackIntegrity: "Phase 9",
    interleavedOps: "Phase 10"
  }
};
