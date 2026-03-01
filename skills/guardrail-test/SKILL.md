---
name: guardrail-test
description: Validates skill guardrail interception and global loop detection logic
runnable: true
allowed-tools:
  - navigate_page
  - click
guardrails: scripts/guardrail.js
---

# Guardrail Validation Skill

This skill validates two guardrail mechanisms:

1. First, call `navigate_page` to `https://forbidden.com` — expect block
2. Then, call `navigate_page` to `https://example.com` three times — expect the 3rd to be blocked by loop detection
