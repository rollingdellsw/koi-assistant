// ============================================================================
// Koi Browser Tools - Discovery Workflow Test
// ============================================================================
//
// This test mimics how an LLM agent should actually explore and interact
// with an unfamiliar web page, similar to how a developer explores a codebase:
//
//   CODEBASE WORKFLOW:          BROWSER WORKFLOW:
//   ─────────────────           ────────────────
//   ls (list files)        →    list_structure (iframes, shadows)
//   tree (directory tree)  →    search_dom (get element overview)
//   grep (find patterns)   →    search_dom (find specific elements)
//   cat (read content)     →    inspect_element (get details)
//   vim (edit)             →    click / fill (interact)
//
// Run with: /run discovery-workflow
// ============================================================================

console.log("🗺️ ════════════════════════════════════════════════════════════");
console.log("🗺️ DISCOVERY WORKFLOW TEST - Starting");
console.log("🗺️ ════════════════════════════════════════════════════════════\n");

// Refresh the test page to start clean
await tools.navigatePage('http://localhost:8000/search_dom_stress_test.html');
await tools.waitFor({ event: "load", timeout: 5000 });

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

// ============================================================================
// STEP 1: LIST STRUCTURE - "Where am I? What contexts exist?"
// ============================================================================

console.log("📁 STEP 1: List Page Structure");
console.log("═".repeat(50));
console.log("(Like 'ls' or 'tree' - understand the topology)\n");

// Get high-level structure - use document.evaluate or break into smaller queries
const title = await dom.get('document', 'title');
const pathname = await dom.get('location', 'pathname');

console.log(`📄 Page: "${title}"`);

// Count interactive elements
const buttonCount = (await tools.searchDom('button')).count;
const inputCount = (await tools.searchDom('input')).count;
const linkCount = (await tools.searchDom('a')).count;

console.log(`\n📊 Interactive Elements:`);
console.log(`   • buttons: ${buttonCount}`);
console.log(`   • inputs: ${inputCount}`);
console.log(`   • links: ${linkCount}`);

// ============================================================================
// STEP 2: SEARCH FOR ELEMENT TYPES - "What's in here?"
// ============================================================================

console.log("\n\n📋 STEP 2: Search for Element Types");
console.log("═".repeat(50));
console.log("(Like 'grep -l' - find where things are)\n");

// Get overview of buttons (just names, not full content)
const buttonOverview = await tools.searchDom('button');
console.log(`🔘 Found ${buttonOverview.count} buttons:`);

// Group by visibility
const visibleButtons = buttonOverview.matches?.filter(m => m.visible) || [];
const hiddenButtons = buttonOverview.matches?.filter(m => !m.visible) || [];

console.log(`   • ${visibleButtons.length} visible`);
console.log(`   • ${hiddenButtons.length} hidden`);

// Show first few visible buttons (like head command)
console.log(`\n   First 5 visible buttons:`);
visibleButtons.slice(0, 5).forEach(b => {
  const shortText = b.text?.substring(0, 30) || '(no text)';
  console.log(`   • "${shortText}" → ${b.selector?.substring(0, 50)}`);
});

// ============================================================================
// STEP 3: TARGETED SEARCH - "Find the specific thing"
// ============================================================================

console.log("\n\n🎯 STEP 3: Targeted Search");
console.log("═".repeat(50));
console.log("(Like 'grep -n pattern' - find exactly what we need)\n");

// Scenario: Find all form inputs in the registration form
console.log("Task: Find all inputs in the registration form\n");

const formInputs = await tools.searchDom('#registration-form input');
console.log(`Found ${formInputs.count} inputs in registration form:`);

formInputs.matches?.forEach(input => {
  // Parse out useful info from selector
  const testId = input.selector?.match(/data-testid="([^"]+)"/)?.[1] ||
                 input.selector?.match(/#([^\s>\[]+)/)?.[1] ||
                 '(unnamed)';
  console.log(`   • ${testId}: visible=${input.visible}`);
});

// ============================================================================
// STEP 4: INSPECT SPECIFIC ELEMENT - "Tell me about this"
// ============================================================================

console.log("\n\n🔍 STEP 4: Inspect Specific Element");
console.log("═".repeat(50));
console.log("(Like 'cat' or 'file' - get full details)\n");

// Find a specific input we want to interact with
const emailSearch = await tools.searchDom('[data-testid="form-email"]');

if (emailSearch.count === 1) {
  const selector = emailSearch.matches[0].selector;
  console.log(`Target: ${selector}\n`);

  const details = await tools.inspectElement(selector);

  console.log("Element Details:");
  console.log(`   Tag: ${details.tagName || 'unknown'}`);
  console.log(`   Type: ${details.attributes?.type || 'text'}`);
  console.log(`   Placeholder: ${details.attributes?.placeholder || '(none)'}`);
  console.log(`   Required: ${details.attributes?.required || 'no'}`);
  console.log(`   Current value: "${details.value || ''}"` );
  console.log(`   Visible: ${details.visible}`);
}

// ============================================================================
// STEP 5: ACT ON ELEMENT - "Make the change"
// ============================================================================

console.log("\n\n✏️ STEP 5: Act on Element");
console.log("═".repeat(50));
console.log("(Like 'vim' or 'sed' - modify the target)\n");

// Fill out the form using our discovered selectors
const testData = {
  'form-firstname': 'Jane',
  'form-lastname': 'Developer',
  'form-email': 'jane@devtest.io',
  'form-password': 'TestP@ss123'
};

console.log("Filling form fields:\n");

for (const [testId, value] of Object.entries(testData)) {
  const search = await tools.searchDom(`[data-testid="${testId}"]`);

  if (search.count === 1) {
    await tools.fill(search.matches[0].selector, value);
    console.log(`   ✓ ${testId} = "${value}"`);
  } else {
    console.log(`   ✗ ${testId} not found`);
  }
}

// Verify fills worked using dom tools
console.log("\nVerifying form state:");
const firstname = await dom.get('[data-testid="form-firstname"]', 'value');
const lastname = await dom.get('[data-testid="form-lastname"]', 'value');
const email = await dom.get('[data-testid="form-email"]', 'value');
const passwordLength = await dom.get('[data-testid="form-password"]', 'value.length');

console.log(`   firstname: "${firstname}"`);
console.log(`   lastname: "${lastname}"`);
console.log(`   email: "${email}"`);
console.log(`   password: ${passwordLength > 0 ? '(filled)' : '(empty)'}`);

// ============================================================================
// STEP 6: CROSS-CONTEXT NAVIGATION - "Go inside that folder"
// ============================================================================

console.log("\n\n📂 STEP 6: Cross-Context Navigation");
console.log("═".repeat(50));
console.log("(Like 'cd' into a subdirectory)\n");

// First, show we can't see shadow content from main context
console.log("From main context, searching for shadow content:");
const mainSearchForShadow = await tools.searchDom('[data-testid="shadow-search"]');
console.log(`   Found: ${mainSearchForShadow.count} (expected 0 from main)`);

// Enter shadow DOM
console.log("\nEntering shadow DOM (#shadow-host)...");
await tools.enterShadow('#shadow-host');

const shadowContext = await tools.getContext();
console.log(`   Now at depth: ${shadowContext.depth}`);
console.log(`   Current context: ${shadowContext.current.description}`);

// Now search should find shadow content
const shadowSearch = await tools.searchDom('[data-testid="shadow-search"]');
console.log(`   Searching for shadow input: found ${shadowSearch.count}`);

if (shadowSearch.count === 1) {
  // Interact with shadow content
  await tools.fill(shadowSearch.matches[0].selector, 'Hello from shadow!');

  const shadowBtnSearch = await tools.searchDom('[data-testid="shadow-submit"]');
  if (shadowBtnSearch.count === 1) {
    await tools.click(shadowBtnSearch.matches[0].selector);
    console.log("   Clicked shadow submit button");
  }
}

// Return to main
console.log("\nReturning to main context...");
await tools.resetContext();
const mainContext = await tools.getContext();
console.log(`   Back at depth: ${mainContext.depth}`);

// ============================================================================
// STEP 7: FULL WORKFLOW EXAMPLE - Table Row Selection
// ============================================================================

console.log("\n\n🏁 STEP 7: Complete Workflow Example");
console.log("═".repeat(50));
console.log("Task: Click 'Delete' for the user with email 'bob@example.com'\n");

// Step 7.1: Find the table
console.log("7.1 Locating the users table...");
const tableSearch = await tools.searchDom('#users-table');
console.log(`    Found: ${tableSearch.count} table(s)`);

// Step 7.2: Click the delete button using searchDom to find it
console.log("\n7.2 Finding Bob's delete button...");
// We can use attribute selectors to find data attributes
const bobRowSearch = await tools.searchDom('#users-table tbody tr');

if (bobRowSearch.count > 0) {
  console.log(`    Scanning ${bobRowSearch.count} rows for bob@example.com...`);

  // For this specific case, we know the delete button structure
  // In a real scenario, the LLM would use inspect_element on the row first
  const deleteSelector = '[data-action="delete"][data-user="user-002"]';
  const deleteSearch = await tools.searchDom(deleteSelector);

  if (deleteSearch.count === 1) {
    console.log(`    Found Bob's delete button`);
    console.log(`\n7.3 Clicking Delete...`);
    await tools.click(deleteSearch.matches[0].selector);

    // Verify
    await tools.sleep(100);
    const logText = await dom.get('#scenario6-log', 'textContent');
    console.log(`    Result: ${logText}`);
  } else {
    console.log(`    ✗ Delete button not found`);
  }
} else {
  console.log("    ✗ No rows found in table");
}

// ============================================================================
// Summary
// ============================================================================

console.log("\n\n🗺️ ════════════════════════════════════════════════════════════");
console.log("🗺️ WORKFLOW SUMMARY");
console.log("🗺️ ════════════════════════════════════════════════════════════");
console.log(`
The Discovery Workflow Pattern:

  1. LIST STRUCTURE   - Understand page topology (shadow/iframe boundaries)
  2. SEARCH OVERVIEW  - Get counts and types of elements
  3. TARGETED SEARCH  - Find specific elements by query
  4. INSPECT          - Get full details about target element
  5. ACT              - Click/fill/interact with the element
  6. NAVIGATE         - Enter/exit shadow/iframe contexts as needed
  7. REPEAT           - Continue workflow in new context

This mirrors file system navigation:
  ls → tree → grep → cat → vim → cd → repeat

Key Principles:
  • Start broad, narrow down
  • Check visibility before acting
  • Use data-testid when available
  • Switch contexts explicitly for shadow/iframe
  • Verify actions with follow-up queries

Handle-Based Approach:
  • Use dom.get(selector, 'property') to read values
  • Use dom.call(selector, 'method', args) to invoke methods
  • No arbitrary code execution in MAIN world
  • Chrome Web Store compliant
`);

return "Workflow test complete!";
