---
name: wait-for-demo
description: Demo skill script's capabilty of watching for current page's DOM elements
allowed-tools:
  - runBrowserScript
  - newPage
---

# Wait-for Demo Skill

This skill validates demo the capabilty of wait for a DOM element's state change from skill script

## Usage

Run the full verification suite:

```javascript
runBrowserScript({
  script_path: "wait-for-demo:scripts/wait-for.js",
});
```
