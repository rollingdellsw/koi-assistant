// scripts/run-all.js
// Runs all Microsoft 365 test scripts sequentially
// Usage: /skill microsoft-365-test/scripts/run-all.js --full-auto

await tools.readSkill({ name: "microsoft-365" });
console.log("========================================");
console.log("  Microsoft 365 — Full Test Suite");
console.log("========================================\n");

const scripts = [
  { name: "OneDrive Read-Only", path: "microsoft-365-test/scripts/onedrive-test.js" },
  { name: "Excel CRUD", path: "microsoft-365-test/scripts/excel-crud-test.js" },
  { name: "Word Comprehensive", path: "microsoft-365-test/scripts/word-comprehensive-test.js" },
  { name: "PowerPoint Comprehensive", path: "microsoft-365-test/scripts/ppt-comprehensive-test.js" },
  { name: "Outlook & Calendar", path: "microsoft-365-test/scripts/outlook-calendar-test.js" },
  { name: "Guardrail & Negative", path: "microsoft-365-test/scripts/guardrail-negative-test.js" },
];

const results = {};

for (const script of scripts) {
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║  Running: ${script.name.padEnd(39)}║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);

  try {
    const result = await tools.runScript({ path: script.path });
    results[script.name] = result?.success ? "✓ PASS" : "✗ FAIL";
    if (!result?.success && result?.error) {
      console.log(`   Error: ${result.error}`);
    }
  } catch (e) {
    results[script.name] = `✗ ERROR: ${e.message}`;
  }
}

console.log(`\n╔══════════════════════════════════════════════════╗`);
console.log(`║              FINAL RESULTS                       ║`);
console.log(`╚══════════════════════════════════════════════════╝\n`);

let allPassed = true;
for (const [name, status] of Object.entries(results)) {
  console.log(`  ${status.padEnd(12)} ${name}`);
  if (!status.startsWith("✓")) allPassed = false;
}

const passCount = Object.values(results).filter(v => v.startsWith("✓")).length;
const totalCount = Object.keys(results).length;

console.log(`\n  Total: ${passCount}/${totalCount} passed`);

return { success: allPassed, results };
