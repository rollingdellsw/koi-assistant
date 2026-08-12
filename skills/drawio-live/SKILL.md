---
name: drawio-live
description: Turn-based human/AI co-editing of draw.io diagrams in a live browser canvas. AI edits XML, user edits the GUI, both sides stay in sync.
runnable: true
# One optional parameter, defaulting to empty on purpose: the runnable
# dispatcher seeds parameters[0] into the new session as a *user* message, so
# anything with a default would read as if the human had typed it. Left blank,
# nothing is seeded and the deployment below (or the built-in default) is used.
parameters:
  - name: canvasUrl
    description: >-
      draw.io instance to edit in. Leave blank for the configured default
      (embed.diagrams.net unless canvas-url is set below). Accepts a bare
      origin: http://localhost:7080 for a local webapp checkout, or any
      self-hosted https origin.
    required: false
    default: ""
mcp-servers:
  - name: drawio_bridge
    script: mcp/drawio_mcp.js
    # Pin a deployment for every run without touching code. Overridden by the
    # canvasUrl parameter above. Optional companions:
    #   host-url:      page that frames the canvas (default: same origin)
    #   canvas-hosts:  hostnames the bridge may attach to (default: the
    #                  configured host plus diagrams.net/localhost)
    #   layout-engine: elk (default) | mx — use mx on a self-hosted build
    #                  without the ELK plugin, where an elk layout silently
    #                  does nothing
    #   layout-settle-ms / layout-timeout-ms: raise on slow instances
    canvas-url: https://embed.diagrams.net/
allowed-tools:
  - drawio_init
  - drawio_sync
  # Internal, called by scripts/pre_send.js at each user-message boundary to
  # arm the sync-before-edit gate. Listed because the hook cannot call a tool
  # the skill has not declared.
  - drawio_begin_turn
  - drawio_ops
  - drawio_apply
  - drawio_route
  - drawio_arrange
  - drawio_validate
  - drawio_render
  # Lists the document's pages and moves the view between them. Page CRUD is
  # ops, not this tool — see the Pages section of the body.
  - drawio_pages
  # Reads (or sets) which draw.io deployment this session talks to. The skill's
  # scripts set it before the tab opens; the pre-send hook reads it.
  - drawio_config
  - drawio_get
  - drawio_shape_search
  - drawio_history
  - drawio_save
  - newPage
  - selectPage
  - listPages
  - getPageContext
  - takeScreenshot
  - runSubtask
  - readSkill
prerequisites:
  - "A draw.io canvas tab will be opened for you if one isn't already open."
  - "Load or draw your diagram in draw.io directly — File ▸ Open, drag-and-drop, or paste."
  - "When the diagram is ready, describe the change you want in the chat box."
reminders:
  - id: "drawio:sync-before-edit"
    trigger:
      type: "tool_call"
      toolName: "drawio_ops"
    content: |
      IMPORTANT: drawio_sync() must be called BEFORE the FIRST drawio_ops or
      drawio_apply of the turn. The canvas is ground truth — the user may have
      edited it since your last turn. drawio_sync returns a diff of what changed.
      If you have NOT yet synced this turn, do it now.

      ONE sync per turn is enough. The base stays fresh across as many
      drawio_ops calls as you like, and a second sync buys nothing while
      costing a full round trip. If the canvas really did move under you, the
      edit itself returns status:"drifted" and tells you to re-sync — you do
      not need to check.

      Better still, send the whole turn's edits in a single drawio_ops batch.
    strategy: "persistent"
    priority: "high"
  - id: "drawio:respect-reverts"
    trigger:
      type: "tool_result"
      toolName: "drawio_sync"
    content: |
      drawio_sync returned. If userDiff.revertedAiCells is non-empty, the user
      removed or undid changes you made. Treat those as rejected — do NOT
      silently re-add them unless the user's current prompt explicitly asks.
    strategy: "one_shot"
    priority: "medium"
pre-send-hook: scripts/pre_send.js
guardrails: scripts/guardrail.js
---

# drawio-live — Turn-Based Diagram Co-Editing

You have a live draw.io editor open in a browser tab. You and the user take turns
editing the same diagram. The user edits the canvas GUI directly (drag, style,
add, delete, undo, redo — any number of edits). You edit by calling tools that
mutate the underlying XML.

## The Canvas Is Already Attached

This skill is launched by the user, not by you. `scripts/run.js` has already
opened (or focused) the draw.io canvas tab and attached the bridge in adopt
mode, without writing to the canvas. **Do not open a canvas, and do not call
`drawio_init`.** Start every turn with `drawio_sync()`.

If `drawio_sync()` returns "Not initialized", the canvas tab was closed or
reloaded. Do not try to recover it yourself — tell the user to run the
drawio-live skill again from the Skills panel.

The canvas may be the public editor, a localhost server, or a self-hosted
instance — `drawio_config()` reports which, and everything else behaves the
same. You do not need to set it; the skill does that before the tab opens. If
`drawio_arrange` reports that nothing moved, that deployment may lack the ELK
plugin: retry once with `drawio_arrange({engine:"mx"})`.

To load a diagram the user attached as a file: `readAttachment` to get the XML,
then `drawio_init({ name, xml, mode: "replace" })`. This is the only situation
in which you may call `drawio_init`, and only when the user explicitly asks for
that file to be loaded.

`drawio_init` modes:

| call                                              | effect                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `drawio_init({name})`                             | Adopts whatever is on the canvas. Safe default.                    |
| `drawio_init({name, xml})`                        | Loads `xml`, replacing the canvas. Use to open a specific diagram. |
| `drawio_init({name, mode:"adopt"})`               | Never writes to the canvas.                                        |
| `drawio_init({name, mode:"replace", force:true})` | Deliberately blanks the canvas. Ask the user first.                |

Once initialized, **do not call `drawio_init` again** — `drawio_sync()` is the
turn opener. Re-initializing resets turn history for no benefit.

## Every AI Turn: Sync → Edit → Verify

### Step 1: Sync (MANDATORY first call every turn)

    drawio_sync()

Once per turn, before your first edit — not before each edit. The base stays
valid for every `drawio_ops` call in the turn, and re-syncing between them
costs a round trip and tells you nothing new. If the user does touch the canvas
mid-turn, the edit itself comes back `status: "drifted"` and asks you to
re-sync; until then, assume you are current.

This pulls the current canvas state, adopts it as your editing base, and returns
a structured diff of what the user changed since your last edit:

```json
{
  "userDiff": {
    "added": [{"id": "...", "kind": "vertex", "label": "...", "at": [x,y,w,h]}],
    "removed": [{"id": "..."}],
    "changed": [{"id": "...", "geometry": {"from": [...], "to": [...]}}],
    "revertedAiCells": ["id1", "id2"],
    "summary": "human-readable summary"
  },
  "canonical": "...",
  "stats": {"cells": 12, "pages": 1},
  "rev": 5
}
```

If the user's prompt includes an annotated screenshot (CTRL+Select capture), you
have three registers of their intent: **prose** (the prompt), **pixels** (the
annotation), **text** (the diff from sync). Use all three.

### Step 2: Edit

**Preferred — `drawio_ops` for targeted edits:**

```json
drawio_ops({ "ops": [
  {"op": "add_node", "id": "n.auth", "label": "Auth Service", "x": 200, "y": 300, "style": "rounded=1;fillColor=#d5e8d4;"},
  {"op": "add_edge", "source": "n.gateway", "target": "n.auth", "label": "JWT"},
  {"op": "set_label", "id": "n.payment", "label": "Payment API"},
  {"op": "move_by", "ids": ["n.auth", "n.user"], "dx": 100, "dy": 0},
  {"op": "delete", "ids": ["e.old_edge"]},
  {"op": "set_style", "id": "n.auth", "style": "fillColor=#f8cecc;"},
  {"op": "adopt", "id": "A3kF-9x", "newId": "n.fraud_check", "label": "Fraud Check"}
]})
```

Available ops: `add_node`, `add_edge`, `set_label`, `set_edge_label`,
`set_edge_points`, `set_edge_anchor`, `resize_to_fit`, `set_style`,
`set_geometry`, `move_by`, `delete`, `adopt`, `align`, `distribute`,
`grid_layout`, plus the page ops `add_page`, `rename_page`, `delete_page`,
`duplicate_page`, `move_page` (see Pages).

**Connectors have three ops of their own, and none of them moves a shape.**
Aligning the boxes does not align the lines between them — that is a separate
job with separate tools:

```json
{"op": "set_edge_anchor", "id": "e.db__r1", "exit": "bottom", "exitAt": 0.25, "entry": "top"}
{"op": "set_edge_label",  "id": "e.api__db", "dy": -24}
{"op": "set_edge_points", "id": "e.api__db", "points": [{"x": 480, "y": 620}]}
```

**`set_edge_anchor` decides which side of a box a line attaches to.** Left to
itself, draw.io picks a floating attachment point per edge from where the shapes
happen to sit, so two edges leaving one database can depart from two different
sides while the boxes below them are perfectly symmetric. That is not something
`align` or `drawio_route` can fix — neither touches attachment. `exit` and
`entry` take `"top"`, `"bottom"`, `"left"`, `"right"`, or `"auto"` to release
the pin; `exitAt`/`entryAt` slide `0`..`1` along that side, which is how a fan-
out is made symmetric:

```json
{"op": "add_edge", "id": "e.db__r1", "source": "n.db", "target": "n.r1",
 "label": "Replication", "exit": "bottom", "exitAt": 0.25, "entry": "top"}
{"op": "add_edge", "id": "e.db__r2", "source": "n.db", "target": "n.r2",
 "label": "Replication", "exit": "bottom", "exitAt": 0.75, "entry": "top"}
```

**`set_edge_label` moves an edge's text.** A label landing on a shape is text in
the wrong place, not a layout failure — do not move shapes to fix it. `position`
slides the label along the edge from `-1` (near the source) through `0` (the
middle, the default) to `1` (near the target); `dx`/`dy` nudge it in pixels from
wherever that lands. `background: true` paints white behind the text — useful
over a long connector, actively harmful over a short one, where it covers the
line and leaves a label floating with no visible arrow. If the lint says the
label is wider than the visible connector, offset it or move the shapes; do not
reach for `background`.

**`set_edge_points`** replaces one edge's waypoints; `points: []` clears them
and hands the edge back to automatic routing.

**`resize_to_fit`** re-sizes a node to its own label, using the same rule
`add_node` applies at creation. Use it after any `set_label` that lengthens the
text, instead of guessing a width.

Use `adopt` to claim user-created cells (they have random IDs like "A3kF-9x")
by assigning a semantic ID and optionally relabeling/restyling them.

**Placement is a judgement call, and it is yours.** There is no layout you are
obliged to run. Put shapes where they belong — tier by tier, left to right,
however the subject suggests — and then decide what, if anything, needs
tidying. `add_node` snaps to the 10px grid and widens itself to fit its label,
so the coordinates only have to be roughly right.

Two tools do the tidying, and the difference between them matters more than
anything else on this page:

### `drawio_route()` — moves nothing

    drawio_route()

Runs draw.io's own libavoid obstacle-avoiding router plus its parallel-edge
router. Edges stop cutting through shapes and stop drawing on top of each
other. **No shape moves.** This is safe on any diagram, including one the user
arranged by hand, and it is the correct answer to almost every "this looks
messy" situation — most messiness is connectors, not positions.

Options: `buffer` (clearance around shapes, default 16), `nudge` (separation
between parallel segments, default 14), `spacing` (parallel connector spacing,
default 20). Pass `route: false` or `parallels: false` to run only one pass.

### `drawio_arrange()` — re-places everything

    drawio_arrange({ algorithm: "layered", direction: "DOWN" })

Runs ELK. `layered` is Sugiyama — flows, architectures, DAGs, and the usual
choice. Also `tree` (hierarchies, org charts), `radial`, `organic` (mind maps,
networks), `stress`.

**This discards the user's arrangement.** Use it freely on shapes you just
created yourself. On a diagram the user built or adjusted, ask first — moving
someone's shapes without asking is the diagram equivalent of reformatting their
code. If it turns out to be wrong, `drawio_history({index, xml: true})` plus
`drawio_apply` puts it back.

Options: `direction` (`DOWN`/`UP`/`RIGHT`/`LEFT`), `nodeSep` (default 40),
`rankSep` (layered only, default 80), `rootIds` (force roots and limit the run
to their components), `resizeNodes`.

### Choosing

| Symptom                                 | Reach for                                    |
| --------------------------------------- | -------------------------------------------- |
| Edges cut through shapes                | `drawio_route()`                             |
| Edges overlap each other                | `drawio_route()`                             |
| A label sits on a shape                 | `set_edge_label` (`dy`, or `background`)     |
| Two labels sit on each other            | `set_edge_label` on one of them              |
| A label is wider than its connector     | `set_edge_label` `dy` — NOT `background`     |
| Lines leave a shape from mixed sides    | `set_edge_anchor`                            |
| One edge takes a silly path             | `set_edge_points`                            |
| A renamed node clips its label          | `resize_to_fit`                              |
| A few nodes are out of line             | `align` / `distribute` / `grid_layout` ops   |
| You just built 12 nodes from nothing    | `drawio_arrange({algorithm:"layered"})`      |
| The user asks for a tidy-up / re-layout | `drawio_arrange`, after confirming the style |
| The user arranged it and it looks fine  | nothing                                      |

Both tools need `drawio_sync()` first, and both change the canvas outside the
ops pipeline, so they re-adopt it as your base and report what moved.

Local touch-ups, when you want to keep the composition:

```json
{"op": "grid_layout", "ids": ["n.replica_1", "n.replica_2", "n.replica_3"], "cols": 3, "x": 200, "y": 600}
{"op": "distribute", "ids": ["n.web", "n.api", "n.cache"], "axis": "horizontal", "gap": 120}
{"op": "align", "ids": ["n.web", "n.api", "n.cache"], "axis": "top"}
```

`align` axes: `left`, `right`, `hcenter`, `top`, `bottom`, `vcenter`.
`distribute` takes `axis: "horizontal" | "vertical"` and an optional `gap`
(minimum 40px). `grid_layout` takes `cols` and optional `x`, `y`, `hgap`, `vgap`.

`add_edge` also takes `points: [{x, y}, ...]` when you want to route one edge
by hand around an obstacle.

**Styling.** `set_style` **merges** into the existing style by default — pass
only the keys you want to change. `merge: false` replaces the whole string,
which also drops `shape=`, `rounded=`, and everything else already on the cell.

**Colour.** Pass `role` on `add_node` (or `set_style`) instead of typing hex:

```json
{
  "op": "add_node",
  "id": "n.api",
  "label": "API Gateway",
  "x": 0,
  "y": 0,
  "role": "compute"
}
```

Roles: `compute` (blue), `service` (green), `storage` (orange), `security`
(red), `external` (purple), `process` (yellow), `neutral` (grey). A role sets
only `fillColor`/`strokeColor`, so it composes with `preset` and with any style
string you pass. Use it for anything that has a semantic tier; reach for raw
hex only when the user asks for a specific colour.

**Vendor icons.** `add_node` accepts `preset` instead of a raw style string:

```json
{
  "op": "add_node",
  "id": "n.fn",
  "label": "Ingest",
  "x": 200,
  "y": 300,
  "preset": "aws.lambda"
}
```

The preset is fuzzy-matched against the same catalog `drawio_shape_search`
queries, and the op report echoes back `resolvedShape` so you can see what you
actually got. When the match is wrong, or nothing matches, use
`drawio_shape_search` and pass the exact `style` string.

**Full rewrite — `drawio_apply` for structural overhauls:**

    drawio_apply({ "xml": "<mxfile>...</mxfile>" })

Use this when restructuring the entire layout. Prefer `drawio_ops` for targeted
changes — it preserves the user's undo stack.

### Step 3: Verify

`drawio_ops` and `drawio_apply` return `{ ok, report, lint, rev, verified }`.
**No `drawio_*` tool can return an image.** A tool result is text, so a PNG
would arrive as base64 prose: full token cost, nothing you can see. Pixels come
from `takeScreenshot`, which is a core browser tool and lands in context as a
real image.

`verified: true` means the canvas was read back and structurally matches what
you pushed. That is a structural claim, not a visual one — a diagram can be
`verified: true` and still be unreadable.

`lint` is the cheap half of the visual check, and it is free. It reports vertex
overlaps, labels too wide for their box, off-grid coordinates, edge labels
colliding with nodes, **edges passing through shapes**, and **edge crossings**.
Each warning names the cheapest fix. A non-empty `lint` is a to-do list: act on
it before you reply, or tell the user why you left it.

**Looking at your work is `takeScreenshot()`.** The draw.io tab is the active
tab, so a bare call captures the canvas:

    takeScreenshot()

This is the only call that puts pixels in front of you. Spend one when you have
built something structurally complicated, when `lint` is non-empty and you want
to see how bad it really is, or when the user asked for something you are not
sure you delivered — **especially after `drawio_route` or `drawio_arrange`,
which move things you did not place.** Budget: two per turn, at the end of a
multi-edit sequence rather than after every edit.

`drawio_render({format: "svg"})` is the other half, and it is text you read
rather than an image you see. It is unbudgeted, and it is the only way to find
out where an edge label or waypoint _actually_ landed after `drawio_route` —
the XML does not record routed positions, and `lint` estimates them from
endpoint centres, so it can report clean on a label that is sitting on top of a
shape. When a screenshot shows you a collision and you need the coordinate to
fix it, this is where the coordinate is.

What to look for:

- Overlapping nodes
- Clipped or truncated labels
- **Edge labels sitting on top of a shape** — the most common survivor of a
  clean `lint`
- Edges routing through shapes
- Off-grid alignment

Fix what you find with another `drawio_ops` call (max 2 fix rounds), then reply
describing what you did. Do not describe a layout you have not looked at: "I
re-routed the connectors around the obstacles" is a claim about pixels, and
`route`'s success message is not evidence for it.

## Pages

A `.drawio` file holds a list of pages; draw.io shows one at a time, with tabs
along the bottom. Two separate things follow, and conflating them is the usual
mistake:

**The document — which pages exist.** Ordinary ops, batched and pushed like any
other edit:

```json
drawio_ops({"ops": [
  {"op": "add_page",       "id": "page-data", "name": "Data Model"},
  {"op": "rename_page",    "page": "page-2",  "name": "Sequence"},
  {"op": "duplicate_page", "page": "Data Model", "name": "Data Model v2"},
  {"op": "move_page",      "page": "page-data", "to": 0},
  {"op": "delete_page",    "page": "Sequence"}
]})
```

**The view — which page is on screen.** Not in the file at all:

```json
drawio_pages()                        // list pages + which one is showing
drawio_pages({"select": "Data Model"}) // bring one on screen
```

**Editing a page does not require switching to it.** `page` scopes a batch, and
any single op can override it. A page reference is a page id, a page name, or a
0-based index:

```json
drawio_ops({"page": "Data Model", "ops": [
  {"op": "add_node", "id": "n.orders", "label": "Orders", "x": 40, "y": 40},
  {"op": "add_node", "id": "n.legend", "label": "Legend", "x": 40, "y": 400,
   "page": "page-1"}
]})
```

Omit `page` and ops land on the page the user is looking at — which is what
"add a box here" means when they are staring at page 3. `drawio_sync` reports
`pages` and `activePage` whenever there is more than one page; read them before
assuming which page you are on.

Switch pages only when the user asked to see one, or before `takeScreenshot()`
— screenshots, `drawio_save({format:"png"|"svg"})` and `drawio_render` all
capture the visible page. `drawio_render({page})` switches for you and leaves
that page selected.

## Validation

    drawio_validate({ "xml": "..." })

Dry-run validation without pushing to canvas. Returns `{ errors, warnings }`.
Errors block pushes; warnings are informational.

## Rendering

    drawio_render({ "format": "svg" })

Exports the live canvas as SVG text — exact geometry, including post-route edge
and label positions. There is no PNG here: use `takeScreenshot()` to look at
the diagram, and `drawio_save` to hand the user a file.

## Reading State

    drawio_get({ "what": "canonical" })   — normalized text form (for diffing)
    drawio_get({ "what": "xml" })         — raw .drawio XML

## Shape Search

    drawio_shape_search({ "query": "aws lambda" })

Returns official draw.io shape styles. Use the returned `style` string in
`add_node` ops to get real vendor icons instead of generic boxes.

## History and Revert

    drawio_history()                          — list past turns
    drawio_history({ index: 2, xml: true })   — that turn's full document

Reverting is: `drawio_sync()`, then `drawio_history({index, xml: true})`, then
`drawio_apply({ xml })`. The list gives you `index`, `turn`, `summary` and cell
count for the last 10 pushes; pick the one you want and feed its XML back.

Prefer the user's own Ctrl+Z for undoing a single recent edit — `drawio_ops`
pushes are undoable in draw.io. Use history when you need to jump back several
steps or the user asks to restore a specific earlier state.

## Saving

    drawio_save({ "target": "download", "format": "drawio" })
    drawio_save({ "target": "download", "format": "png" })
    drawio_save({ "target": "download", "format": "svg" })

Triggers a browser download of the diagram file.

## ID Conventions

Always use semantic IDs for cells you create:

- Vertices: `n.<slug>` (e.g., `n.api_gateway`, `n.auth_svc`)
- Edges: `e.<from>__<to>` (e.g., `e.gw__auth`)
- Pages: `page-<n>` or `page-<slug>`

User-created cells have random IDs (like `A3kF-9x`). Use `adopt` to claim them.

## Layout Doctrine

- Snap to 10px grid. `add_node` does this for you; `set_geometry` does not.
- Default node size: 160×60, auto-widened to fit the label. Reckon ~7px per
  character plus 20px padding when you need to size a box yourself.
- Spacing between nodes: ≥40px (scale up for dense diagrams).
- **Labelled edges need room for the label.** A horizontal edge carries its text
  at the midpoint between the two nodes, so the clear gap between them must
  exceed the label width — ~7px per character. "HTTPS Request" needs ~110px of
  clear space, not the 40px minimum. The `lint` array flags this.
- **An edge that skips a tier needs a corridor, not a diagonal.** Leave a lane
  beside the nodes for it. You do not have to compute the route: place the
  shapes, then `drawio_route()`.
- Route edges through corridors between nodes, not through shapes.
- Use tier-based vertical layout for architectures (clients top → services → data bottom).
- Use `role` for colour rather than hex literals — the palette lives in the ops
  engine, so it stays consistent across turns without you remembering it.
