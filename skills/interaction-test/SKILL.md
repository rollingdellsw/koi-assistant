---
name: interaction-test
description: Validates browser tool DOM interaction functions
allowed-tools:
  - run_browser_script
  - new_page
  - dom_get_property
  - dom_call_method
mcp-servers:
  - name: dom-interactor
    script: mcp/dom_interactor.js
---

# Context Stress Test Skill

This skill validates the robustness of the browser toolchain, specifically focusing on DOM elements interaction functions.

## Usage

Run the full verification suite:

```javascript
// 1. Open the test fixture: the test page is already serving
await new_page({ url: "http://localhost:8000/interaction_test.html" });

// 2. Execute the stress test script
run_browser_script({
  script_path: "interaction-test:scripts/interaction.js",
});
```
