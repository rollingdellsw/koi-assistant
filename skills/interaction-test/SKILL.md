---
name: interaction-test
description: Validates browser tool DOM interaction functions
allowed-tools:
  - run_browser_script
  - new_page
  - dom_get_property
  - dom_call_method
---

# Context Stress Test Skill

This skill validates the robustness of the browser toolchain, specifically focusing on DOM elements interaction functions.

## Usage

Run the full verification suite:

```javascript
run_browser_script({
  script_path: "interaction-test:scripts/interaction.js",
});
```
