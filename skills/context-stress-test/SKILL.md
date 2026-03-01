---
name: context-stress-test
description: Validates browser tool context isolation and switching
allowed-tools:
  - run_browser_script
  - new_page
mcp-servers:
  - name: dom-interactor
    script: mcp/dom_interactor.js
---

# Context Stress Test Skill

This skill validates the robustness of the browser toolchain, specifically focusing on deep context switching between Shadow DOMs and Iframes.

## Usage

Run the full verification suite:

```javascript
// 1. Open the test fixture: the test page is already serving
await new_page({ url: "http://localhost:8000/context_stress_test.html" });

// 2. Execute the stress test script
run_browser_script({
  script_path: "context-stress-test:scripts/stress.js",
});
```
