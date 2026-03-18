---
name: context-stress-test
description: Validates browser tool context isolation and switching
allowed-tools:
  - run_browser_script
  - new_page
---

# Context Stress Test Skill

This skill validates the robustness of the browser toolchain, specifically focusing on deep context switching between Shadow DOMs and Iframes.

## Usage

Run the full verification suite:

```javascript
run_browser_script({
  script_path: "context-stress-test:scripts/stress.js",
});
```
