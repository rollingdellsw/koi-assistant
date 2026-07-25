---
name: search-dom-test
description: Validates browser tool DOM search functions
allowed-tools:
  - runBrowserScript
  - newPage
---

# Context Stress Test Skill

This skill validates the robustness of the browser toolchain, specifically focusing on DOM search functions.

## Usage

Run the full verification suite:

```javascript
runBrowserScript({
  script_path: "search-dom-test:scripts/search.js",
});
```
