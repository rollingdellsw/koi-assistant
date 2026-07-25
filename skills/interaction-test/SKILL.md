---
name: interaction-test
description: Validates browser tool DOM interaction functions
allowed-tools:
  - runBrowserScript
  - newPage
  - domGetProperty
  - domCallMethod
---

# Context Stress Test Skill

This skill validates the robustness of the browser toolchain, specifically focusing on DOM elements interaction functions.

## Usage

Run the full verification suite:

```javascript
runBrowserScript({
  script_path: "interaction-test:scripts/interaction.js",
});
```
