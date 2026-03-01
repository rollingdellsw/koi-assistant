---
name: osd-controller
description: Specialist for OpenSeadragon (OSD) viewers. Performs iterative visual analysis by capturing, annotating, and zooming into regions of interest.
version: 2.1.0
runnable: true
url-patterns:
  - "https://portal.gdc.cancer.gov/*"
  - "*/context_stress_test.html"
allowed-tools:
  - run_browser_script
  - "visual-workspace:*"
  - "openseadragon:*"
mcp-servers:
  - name: openseadragon
    type: local
    script: mcp/osd_mcp.js
reminders:
  - id: "visual-workspace:ctx-limit"
    trigger:
      {
        type: "context",
        condition: { type: "low_context_window", threshold: 80000 },
      }
    content: "⚠️ Context running low. Stop creating new workspaces. Summarize findings."
    strategy: "sticky"
    priority: "high"
guardrails: scripts/guardrail.js
---

# OpenSeadragon Controller Skill

Specialized agent for high-resolution pathology image analysis.

### Capabilities

1. **Workspace Management**: Initialize an analysis session using `create_workspace`.
2. **Direct Operation**: Navigate via `osd_pan` and `osd_zoom` through the `openseadragon` MCP server.
3. **Visual Feedback**: Use `visual-workspace` tools to annotate specific cells or regions of interest.

### Workflow

1. Call `read_skill("osd-controller")`.
2. Locate the viewer and call `create_workspace({"selector":".openseadragon-canvas"})`.
3. Use OSD tools to find regions of interest and annotations to document findings.
