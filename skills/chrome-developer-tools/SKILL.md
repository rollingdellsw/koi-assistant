---
name: chrome-developer-tools
description: "Advanced Chrome Developer Tools. Activates direct page manipulation (click, fill, script execution) and inspection capabilities without user confirmation steps. Use for complex automation, debugging, or when the passive assistant capabilities are insufficient."
version: 1.0.0
allowed-tools:
  - click
  - fill
  - hover
  - press_key
  - evaluate_script
  - set_trap
  - remove_trap
mcp-servers:
  - name: devtools
    type: local
    script: mcp/devtools.js
---

# Developer Tools Skill

This skill restores the full power of Chrome DevTools capabilities which are disabled by default in Assistant mode.

## Capabilities

- **Direct Interaction**: `click`, `fill`, `hover`, `press_key` (executed via JavaScript).
- **Script Execution**: `evaluate_script` for running arbitrary code in the page context.
- **Monitoring**: `set_trap` to listen for console errors or network failures.

## Usage

Load this skill when you need to perform actions automatically without stopping for user confirmation, or when you need to debug page state using scripts.

**Note**: `scroll_viewport` is available in the default Assistant mode for safe navigation. This skill focuses on direct manipulation tools that require explicit opt-in.
