---
name: cdp-trap-test
description: Validates browser tool CDP trap function
allowed-tools:
  - run_browser_script
  - new_page
---

# Context Stress Test Skill

This skill validates the robustness of the browser toolchain, specifically focusing on CDP trap function.

## Usage

Run the full verification suite:

```javascript
run_browser_script({
  script_path: "cdp-trap-test:scripts/cdp.js",
});
```
