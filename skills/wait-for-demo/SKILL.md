---
name: wait-for-demo
description: Demo skill script's capabilty of watching for current page's DOM elements
allowed-tools:
  - run_browser_script
  - new_page
mcp-servers:
  - name: dom-interactor
    script: mcp/dom_interactor.js
---

# Wait-for Demo Skill

This skill validates demo the capabilty of wait for a DOM element's state change from skill script

## Usage

Run the full verification suite:

```javascript
// 1. Open the test fixture: the test page is already serving
await new_page({ url: "http://localhost:8000/interaction_test.html" });

// 2. Execute the stress test script
run_browser_script({
  script_path: "wait-for-demo:scripts/wait-for.js",
});
```
