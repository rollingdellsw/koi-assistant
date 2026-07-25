---
name: chrome-developer-tools
description: "Advanced Chrome Developer Tools. Activates direct page manipulation (click, fill, script execution) and inspection capabilities without user confirmation steps. Use for complex automation, debugging, or when the passive assistant capabilities are insufficient."
version: 1.0.0
allowed-tools:
  - click
  - fill
  - hover
  - pressKey
  - evaluateScript
  - setTrap
  - removeTrap
mcp-servers:
  - name: devtools
    type: local
    script: mcp/devtools.js
---

# Developer Tools Skill

This skill restores the full power of Chrome DevTools capabilities which are disabled by default in Assistant mode.

## Capabilities

- **Direct Interaction**: `click`, `fill`, `hover`, `pressKey` (executed via JavaScript).
- **Script Execution**: `evaluateScript` for running arbitrary code in the page context.
- **Monitoring**: `setTrap` to listen for console errors or network failures.

## Usage

Load this skill when you need to perform actions automatically without stopping for user confirmation, or when you need to debug page state using scripts.

**Note**: `scrollViewport` is available in the default Assistant mode for safe navigation. This skill focuses on direct manipulation tools that require explicit opt-in.
