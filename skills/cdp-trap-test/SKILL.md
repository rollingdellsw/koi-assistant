---
name: cdp-trap-test
description: Validates browser tool CDP trap function
allowed-tools:
  - runBrowserScript
  - newPage
---

# Context Stress Test Skill

This skill validates the robustness of the browser toolchain, specifically focusing on CDP trap function.

## Usage

Run the full verification suite:

```javascript
runBrowserScript({
  script_path: "cdp-trap-test:scripts/cdp.js",
});
```
