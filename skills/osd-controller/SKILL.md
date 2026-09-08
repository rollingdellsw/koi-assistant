---
name: osd-controller
description: Specialist for OpenSeadragon (OSD) viewers. Operates the image that currently has focus — listing viewers, moving focus, panning, zooming into regions — and performs iterative visual analysis by capturing and annotating what the focused viewer shows.
version: 3.1.0
runnable: true
url-patterns:
  - "https://portal.gdc.cancer.gov/*"
  - "*/context_stress_test.html"
allowed-tools:
  - runBrowserScript
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
  - id: "osd:saccadic-memory"
    trigger:
      type: "tool_result"
      toolName: "createWorkspace"
    content: |
      Focus Shifted: You have created a new active Visual Workspace.
      Remember that your previous workspaces are now demoted to low-res thumbnails to save context window space.
      Before you pan away or create your next workspace, ALWAYS use `<scratchpad_update>...</scratchpad_update>` to jot down your analysis of the current image ID so you have a persistent record of what you found.
    strategy: "sticky"
    priority: "high"
  - id: "osd:focus-follows-workspace"
    trigger:
      type: "tool_result"
      toolName: "osd_focus"
    content: "Focus moved to a different viewer. Any workspace you captured earlier shows the PREVIOUS image — capture a new one with `createWorkspace` using the `selector` reported for the now-focused viewer before annotating."
    strategy: "sticky"
    priority: "medium"
  - id: "osd:minimize-workspace-before-nav"
    trigger:
      type: "tool_result"
      toolName: "createWorkspace"
    content: "Visual Workspace overlay is active. Before doing your next zoom, pan, reset, or region zoom on the OSD viewer, ALWAYS minimize/hide the workspace overlay first using `hideWorkspaceOverlay`."
    strategy: "sticky"
    priority: "high"
guardrails: scripts/guardrail.js
---

Analyze current image on focus.

---

## Core Operational Behavior: Image Analysis Protocol

When asked to inspect, read, or analyze an image on the page, follow this exact workflow:

### 1. Discovery & Focus Verification

- Call `osd_list_viewers` to inspect available viewers and find which viewer is focused.
- **If no viewer is found or no image is loaded:** Ask the user to open or load an image in the viewer before proceeding.
- **If multiple viewers exist and the intended one is not focused:** Call `osd_focus({ viewer })` to bring it forward.
- Call `osd_get_status` on the focused viewer to read slide dimensions, zoom level, and viewport boundaries.

### 2. Overview Capture & Global Architecture Annotation

- Capture the full-slide overview using `createWorkspace({ selector })` with the focused viewer's `selector` (use `settle_ms: 1500` to allow multi-resolution tiles to render).
- Interpret the global tissue/image architecture (e.g., tumor compartments, necrosis, desmoplastic stroma, margins).
- Place macro annotations on the overview workspace using `addWorkspaceAnnotation` (with descriptive labels, colors, and commentary).

### 3. Overlay Minimization Before Viewport Navigation

- **Crucial step:** Whenever an active workspace overlay exists, call `hideWorkspaceOverlay` before triggering any zoom, pan, or region navigation on the OSD viewer so the overlay does not obstruct interactions.

### 4. High-Magnification Region Navigation

- Zoom into key regions of diagnostic or visual interest using `osd_zoom_to_region({ x, y, width, height })` (coordinates are 0–1 normalized fractions of the image).
- For fine adjustments, use `osd_zoom` and `osd_pan`.

### 5. Microscopic Capture & Detailed Annotation

- Capture the zoomed viewport into a new workspace frame with `createWorkspace({ selector, settle_ms: 1500 })`.
- Add fine-grained diagnostic annotations using `addWorkspaceAnnotation` to highlight cellular, nuclear, vascular, or textural features.

### 6. Multi-Image & Context History Switching

- **Switching slides:** Call `osd_focus({ viewer })` to move focus to another viewer autonomously without waiting for manual user clicks.
- **Restoring previous workspaces:** Call `getImageStack` to list prior frames and `showWorkspaceOverlay({ imageId })` to restore any previous workspace and its annotations.

---

## Focus Rules

`osd_zoom`, `osd_pan`, `osd_zoom_to_region`, `osd_reset`, and `osd_get_status`
all target the focused viewer when called with no `viewer` argument.

- **`osd_focus({ viewer })`** — dispatches native pointer events so the host app moves
  focus itself, bringing the chosen window forward in sync with the agent.
- **`viewer` override** — an optional argument on any tool to operate on a background
  viewer without moving focus (ideal for read-only status checks).
- `viewer` accepts an element id, a window title, or an index as a string (as reported by `osd_list_viewers`).

---

## Coordinates & Scaling

- `osd_zoom_to_region` takes `x`, `y`, `width`, `height` as **0–1 fractions of the full image** — the identical normalized space workspace annotations use.
- `osd_pan` takes deltas in OSD viewport coordinates (`1.0` equals full image width at home zoom).
- `osd_zoom` is absolute unless `relative: true` is passed (`level: 2` doubles current zoom, `level: 0.5` halves).

---

## Error Handling & Recovery

- _"No OpenSeadragon viewer on this page"_ — The viewer has not mounted or no image is open. Ask the user to open a slide.
- _"No viewer is focused and the page has N viewers"_ — Call `osd_focus` or supply an explicit `viewer` target.
- _"The viewer instance ... is not reachable yet"_ — The viewer is initializing; retry after a brief delay.
