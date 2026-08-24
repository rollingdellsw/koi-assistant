---
name: freecad-live
description: Turn-based human/AI co-design of a live FreeCAD document running natively on this machine. Reads the document every turn, edits it through a validated call whitelist inside a transaction envelope, measures the result rather than trusting it, and keeps user-picked face and edge references alive across recomputes. Purchased parts are interfaces bound by expression, not modelled solids. Pins the exact FreeCAD build the session is talking to.
runnable: true

# Positional. scripts/connect.js reads them as args[0], args[1], args[2] —
# do not reorder without changing that script.
parameters:
  - name: bridgeUrl
    description: >-
      Where koi_bridge.py is listening, e.g. http://localhost:8765. Plain http
      is correct — the bridge serves no TLS, and on the documented deploy it is
      reached over loopback or an SSH tunnel. See README.md, Step 7.
    required: false
    default: "http://localhost:8765"
  - name: bridgeToken
    description: >-
      The KOI_BRIDGE_TOKEN the bridge was started with. On the documented
      deploy: grep KOI_BRIDGE_TOKEN ~/freecad-stream/bridge.env on the FreeCAD
      host. It goes from this form straight to the bridge client — it is not
      written to any file and does not enter the conversation.
      Check https://github.com/rollingdellsw/koi-assistant/blob/main/skills/freecad-live/README.md for details
    required: true
    default: ""
  - name: streamUrl
    description: >-
      Optional. The page showing this FreeCAD's window, e.g.
      https://localhost:3001 (3001 is the TLS listener; 3000 is plaintext).
      Nothing in the skill fetches it — it is the link the human opens to watch.
      Without it the session works and the human is blind.
      Check https://github.com/rollingdellsw/koi-assistant/blob/main/skills/freecad-live/README.md for details
    required: false
    default: "https://localhost:3001"

mcp-servers:
  - name: freecad_bridge
    type: local
    script: mcp/freecad_mcp.js

    # Where the FreeCAD-side macro listens. Loopback: the bridge binds
    # 127.0.0.1 and nothing off this machine can reach it.
    bridge-url: http://localhost:8765

    # ===== CREDENTIAL ==================================================
    # The bridge executes Python with your privileges, so this token is the
    # only thing between another local user and your machine. It is checked
    # into a file, so treat it as a secret at rest: rotate it whenever this
    # file is shared, copied, or committed.
    #
    # Kept as a field because scripts/test_*.js run headless and have no Run
    # dialog to read it from. For an LLM-facing session, prefer leaving this
    # empty and letting the human supply it through Skills → freecad-live →
    # Run, which keeps the token out of the transcript AND out of this file.
    bridge-token: "f501339ded74b6248b5e5ab6eb0a756d475a8e919158511948e2016834aee77f"

    # Optional. The page showing this FreeCAD's window — KasmVNC, Selkies,
    # any WebRTC/VNC front end. Nothing in the skill talks to it; it exists so
    # the human can see the model and take the mouse.
    #
    # The token is not the security boundary. Ports 3000/3001 serve a FreeCAD
    # desktop with a Python console in it, and it has no password unless
    # CUSTOM_USER/PASSWORD were set on the container — anyone who can reach
    # that port skips the token entirely. Bind both listeners to loopback and
    # reach them through a tunnel. See README.md, Step 6.
    stream-url: https://localhost:3001

    # ===== K0: the build pin ===========================================
    #   pin-version:     ExeVersion + suffix, e.g. "1.1.3". NOT sufficient on
    #                    its own — a whole development series carries one
    #                    version string.
    #   pin-commit:      BuildRevisionHash from the running FreeCAD. The strong
    #                    identifier when the build carries one. Prefix match.
    #   pin-fingerprint: size and mtime of the FreeCAD binary on disk.
    #                    The fallback for a build with no revision hash, and
    #                    the only layer that answers while the interpreter is
    #                    busy. DELIBERATELY UNSET on this deployment: the
    #                    bridge resolves a launcher shim rather than the real
    #                    ELF here, so it reported drift on every attach for a
    #                    binary that had not changed — which is how a gate
    #                    stops being read. The commit is the identity.
    #   pin-mode:        off | warn | strict.
    pin-version: "1.1.3"
    pin-commit: "145529fe741292ff0b3977a01195bf0247425794"
    # pin-fingerprint: ""
    pin-mode: strict

    # ===== Probe-stage escape hatch ====================================
    # freecad_exec and freecad_edit are arbitrary code at `mutating` tier,
    # which is exactly what the freecad_call/freecad_script split exists to
    # prevent. They are hidden from the LLM entirely unless this is on.
    # scripts/test_probes.js, test_koi_cad.js and test_koi_call.js need them
    # to set up conditions the envelope is meant to handle.
    # !! MUST be off for any LLM-facing session.
    probe-exec: off

guardrails: scripts/guardrail.js

# The per-turn protocol that a long session forgets. These fire on evidence
# in the tool result rather than on a wall of standing text, so the rule
# arrives at the moment it applies.
reminders:
  - id: "freecad-live:turn-open"
    description: Sync opens every turn; the human shares this document.
    trigger:
      type: "user_message"
      pattern: "."
    content: |
      FreeCAD turn protocol: call freecad_sync() BEFORE any edit or any claim
      about the model. Read userDiff (what the human changed — revertedAiObjects
      is a rejection, never re-create), selection (what "this one" means),
      health, and guiBusy. Answering from the document as you left it is how
      their work gets overwritten.
    strategy: "persistent"
    priority: "high"

  - id: "freecad-live:measure-not-pixels"
    description: A render proves existence, never dimension.
    trigger:
      type: "tool_result"
      toolName: "freecad_render"
    content: |
      A render shows a hole EXISTS; it cannot show the hole is 6.2 mm. Before
      stating any dimension, clearance or fit, call freecad_measure or
      freecad_call({fn:"measure_between"}). Also confirm `drawn` per target —
      anything in notDrawn is not on screen whatever Visibility says.
    strategy: "sticky"
    priority: "high"

  - id: "freecad-live:silent-failure"
    description: The lint findings that recompute perfectly clean.
    trigger:
      type: "tool_result"
      toolName: "freecad_(call|script)"
      outputPattern: 'removed-nothing|removedAtProfile|split-stale|bindingNote|bindingVerified":false|constraintsLost|rehealedExternal'
    content: |
      This reply carries a SILENT failure marker. A cut that removed nothing, a
      binding that stayed a literal, a stale split, or a sketch that lost
      constraints all report Up-to-date and isValid(). Believe the marker over
      the state flags and over the screenshot. Say what it means to the user
      and fix it before building anything on top of it.
    strategy: "persistent"
    priority: "high"

  - id: "freecad-live:refs-moved"
    description: Face6 is an index; a recompute renumbers it.
    trigger:
      type: "tool_result"
      toolName: "freecad_(call|script|resolve|sync)"
      outputPattern: "refsBroken|rederived|ambiguous|rehealed"
    content: |
      A stored reference moved. `rederived`/`rehealed` means it was found again
      from what generated it — re-capture it and check what it now points at.
      `broken`/`ambiguous` means STOP: name the reference and ask the human to
      re-pick. Never author a replacement index yourself.
    strategy: "persistent"
    priority: "high"

  - id: "freecad-live:undo-cost"
    description: The user's Ctrl+Z is a promise this measures.
    trigger:
      type: "tool_result"
      toolName: "freecad_(call|script)"
      outputPattern: 'undoNote|singleUndo":false'
    content: |
      This edit did not book exactly one undo entry. Tell the user how many
      Ctrl+Z it takes to reverse — or that it cannot be reversed that way —
      rather than letting them discover it.
    strategy: "persistent"
    priority: "medium"

  - id: "freecad-live:prefer-batch"
    description: A dozen turns the human sits through.
    trigger:
      type: "tool_call"
      toolName: "freecad_call"
    content: |
      If the next few calls are already decided (datum, sketch, pad, sketch,
      pocket, fasteners), send them as ONE freecad_call({fn:"batch"}): one
      transaction, one undo entry, one diff, one wait for the human. Stop the
      batch where you would have had to look at a measurement.
    strategy: "one_shot"
    priority: "medium"

  - id: "freecad-live:script-is-last-resort"
    description: Objects a script creates have no handle.
    trigger:
      type: "tool_call"
      toolName: "freecad_script"
    content: |
      freecad_script is for what the whitelist genuinely does not cover. An
      object it creates gets NO id unless you register it —
      koi.register(doc, "pad.base", obj) — and unregisteredObjects in the reply
      names the ones turn 7 will have to rebuild instead of edit. Every loop
      carries its own bound; the deadline cannot interrupt the geometry kernel.
    strategy: "sticky"
    priority: "high"

  - id: "freecad-live:bridge-down"
    description: Attach failure is infrastructure, not a user error.
    trigger:
      type: "tool_error"
      toolName: "freecad_(attach|call|script|sync|measure)"
    content: |
      Diagnose before retrying: freecad_probe() says whether a bridge answers
      and whether it has a GUI. "Bridge up, interpreter never answered" means
      FreeCAD is alive and busy — a long recompute or a modal waiting for a
      click. Say which it looks like and WAIT. Do not tell the user to restart
      anything, and never restart FreeCAD yourself.
    strategy: "persistent"
    priority: "high"

  - id: "freecad-live:checkpoint"
    description: Long build, unsaved work.
    trigger:
      type: "iteration"
      every: 15
    content: |
      Checkpoint: offer the user a save (freecad_call({fn:"save"}) writes their
      own file; freecad_export({format:"FCStd"}) writes a separate copy) and
      run freecad_measure({partsOnly:true, interference:true}) so the state of
      the model is measured rather than assumed at this point.
    strategy: "one_shot"
    priority: "medium"

allowed-tools:
  - freecad_config
  - freecad_probe
  - freecad_attach
  - freecad_version
  - freecad_sync
  - freecad_get
  - freecad_render
  - freecad_measure
  - freecad_resolve
  - freecad_export
  - freecad_call
  - freecad_script
  - runBrowserScript
  - newPage
  - selectPage
  - listPages
  - getPageContext
  - takeScreenshot
  - readSkill

prerequisites:
  - "FreeCAD installed on this machine (package, AppImage or container), started with the bridge macro loaded: `freecad tools/koi_bridge.py`."
  - "The bridge must run inside the FreeCAD the human is looking at. A second interpreter started alongside it has its own document, and nothing built there reaches their screen."
  - "For the human half: a WebRTC/VNC front end serving that FreeCAD's window (KasmVNC, Selkies), and stream-url pointed at it. Without one the session still works and nobody can watch."
  - "A rotated KOI_BRIDGE_TOKEN. The bridge executes Python with your privileges."
---

# freecad-live — co-designing a live FreeCAD document

FreeCAD is running on this machine with `tools/koi_bridge.py` loaded. You are in
the same process the human is: one interpreter, one document, one undo stack,
and both of you writing to it. If a stream is configured they are watching that
FreeCAD's real window in a browser tab and can take the mouse at any moment.

That is the whole architecture, and every rule below follows from it.

---

## 1. Binding the session

`freecad_config()` reports `tokenSet` and `bridgeUrl`. If `tokenSet` is false,
or an attach comes back 401, the session has no credentials and no tool call
will fix that.

**Do not ask the user to paste the token into the chat.** Ask them to open
Skills → freecad-live → Run, fill in `bridgeUrl`, `bridgeToken` and optionally
`streamUrl`, and press Run Skill. That configures the bridge client and attaches.

The binding lasts for the session. A new session needs the dialog again.

## 2. K0 — the build pin

Every later claim this skill makes — that a reference survived a dimensional
change, that a hole carries a thread spec rather than cut geometry, that a
module is available — is a claim about **one build**. An install is not more
stable than a snapshot for being local: `apt upgrade`, a new AppImage or a
re-pulled container image all move it without anybody deciding to change CAD
behaviour that day, and a version string moves later than the behaviour does.

1. `freecad_attach()` — waits for the module and the interpreter, reads the
   build identity, checks the pin. Slow on a cold load; that is expected. It
   returns a one-line `status`. **Open the session with that line, then ask
   what they want to build.** Do not paste configuration at somebody who has
   not spoken yet.
2. `freecad_version()` — the full picture from three independent layers:
   `runtime` (read out of the live interpreter — authoritative), `deploy` (the
   install the bridge is inside — answers while the interpreter is busy), and
   `transport` (the bridge: protocol, pid, GUI or headless). Pass
   `layers: ["deploy","transport"]` to answer "is FreeCAD even up?" without
   waiting for the interpreter. Its `pinBlock` is the YAML to paste into this
   file — show it when the user is setting the skill up or asks for it, and
   tell them the skill cannot write its own frontmatter. Mid-design is not
   that moment.
3. `freecad_probe()` — diagnostics only. Whether a bridge answers, which
   protocol it speaks, whether it has a GUI, what is running on the thread.
4. `freecad_call({fn: "capabilities"})` — what THIS FreeCAD can actually do:
   which modules import here, and what the Assembly API exposes on this build.
   Check it rather than assuming. Importable is not the same as wired.

When `pin.drift` is non-empty, name the fields that moved and say what it
implies: the probe suites were run against a different build, so their results
do not carry over. Do not soften that into a suggestion.

**If `gui` is false there is no human in this session.** No selection to read,
no view to isolate or restore, nobody watching. The geometry rules all still
apply; the ones that say "ask the user to click it" have no way to be
satisfied, so say that rather than authoring the reference yourself.

## 3. The turn protocol

**`freecad_sync()` opens every turn.** It is not a formality — the human may
have moved, deleted or rejected something since your last reply. Read four
things from it before anything else:

- **`userDiff`** — what they changed. `revertedAiObjects` means they deleted
  something you made: a rejection, never silently re-created. `dofChanges`
  means a sketch came loose.
- **`selection`** — what they have clicked, fingerprinted. When they say "this
  one", this is what they mean; you do not have to guess and must not.
- **`health`** — errors, touched, underconstrained, at a glance.
- **`guiBusy`** — advisory. The real gate is inside the edit, which fails
  closed. If it is set, answer in prose and wait.

The tree and the lint are **trimmed** on a large document. `objectCount` and
`lintTotal` are always exact and `treeNote`/`lintNote` say when something was
cut; lint is sorted errors-first before truncation. Drill in with
`freecad_get({ids: [...]})` rather than reaching for `detail: "full"` by
reflex. `freecad_sync` says what exists; `freecad_get` says what one thing
**is** — full properties, state and shape metrics, for a koi id, an internal
name or a label.

Then edit. Two channels, and the split is the point:

- **`freecad_call({fn, args, id})` is the default.** Validated before it
  reaches the interpreter, run inside the transaction envelope (GUI gate, seal,
  run, recompute, abort on a newly introduced error), and it registers an id.
  Read `freecad_call`'s own description for the current call list and argument
  detail — §5 below is the map, not the reference.
- **`freecad_script({python})` is for what the whitelist genuinely does not
  cover** — loops, computation, a profile whose points come out of a formula,
  bulk edits. Same envelope. But an object a script creates gets no id unless
  the script registers it (`koi.register(doc, "pad.base", obj)`), and the reply
  names the ones it did not under `unregisteredObjects`. Those are objects turn
  7 cannot address and will have to rebuild rather than edit.

**`batch` when the next few calls are already decided.** A datum, a sketch, a
pad, another sketch, a pocket and six fasteners is six to twelve tool calls —
each one a turn, a dispatch, a transaction, a recompute and a diff, with the
human watching the stream sit through all of it.
`freecad_call({fn: "batch", args: {ops: [{fn, args, id}, ...]}})` runs them in
**one** transaction: one confirmation, one undo entry, one diff. Atomic — a
step that fails rolls the whole batch back and names the step, so there is
never half a bolt pattern to clean up. Capped at 24 steps; `new_document` and
`batch` cannot be steps.

Do not batch across a measurement. If step 2 depends on what step 1 measured —
which way a pocket flipped, what a query matched, whether the user's pick still
resolves — those are two turns, because nothing in a batch is read back until
it returns. Rule of thumb: batch what you would have said to a machinist in one
sentence, and stop where you would have had to look.

**Non-negotiable:**

- **Give every created object an id** (`sk.plate`, `pad.base`, `bolt.mount`).
  The id is what lets turn 7 edit what turn 3 built. The dispatcher refuses a
  creating call without one.
- **Edit in place before building a replacement.** `feature_edit` for features
  and properties, `sketch_edit` for sketch geometry and constraints, `suppress`
  for "that pocket was wrong". Rebuilding throws away the DAG, the downstream
  features and the user's own references.
- **Every loop carries a bound.** A script that does not return holds the
  thread that owns the document, and the human watches their window stop
  responding until it comes back. The deadline preempts a runaway _Python_
  loop; nothing can interrupt the geometry kernel.
- **Dry-run a parametric change before committing** when anything downstream
  could break. `dryRun: true` applies, measures and rolls back, and the
  `report` it returns is the review packet: which objects moved, by how much,
  what broke. Show those numbers — "3 objects changed" is not a blast radius,
  and an engineer will not accept a change from an AI without one.

## 4. Getting a document

Every write needs one, and a FreeCAD the user just started has none — the first
edit comes back `no-document` and `freecad_sync()` reports `document: null`.

- If the human already has a document open, **work in it**. It is theirs.
- Otherwise `freecad_call({fn: "new_document", args: {name: "Gearbox"}, id:
"doc.main"})`. It turns undo on before the first transaction and takes the
  sync baseline, so the first edit after it is not refused for being stale. It
  reuses a document of that name rather than opening a second one — two
  documents holding the same design is a state nobody recovers from.
- `open_document({path})` adopts an existing `.FCStd` from disk. **koi ids come
  back with the file** — they live in `doc.Meta`, which is saved inside the
  FCStd — so a document this skill built last week is still editable by id
  rather than by rebuild. A document built elsewhere has none and the reply
  says so.

**Read paths are confined**, and this catches people out: `open_document` and
`import_geometry` accept a path only under the export directory, anything
`KOI_OPEN_DIRS` names, or the folder of a document the human already has open.
FreeCAD's own config and macro directories are refused in both directions —
files under them execute at every start. If a path is refused, the error names
the allowed roots; relay it and offer the fix (`KOI_OPEN_DIRS`, or have the
human open one file from that folder) rather than trying another path.

## 5. The call surface

`freecad_call`'s own description carries the full argument list. This is the map
— what exists, and how to choose. **Nothing here is hidden from you; if a task
needs something not on this list, say it is absent rather than improvising.**

| Group          | Calls                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| Document       | `new_document`, `open_document`, `save`, `import_geometry`, `recompute`                                    |
| Read / inspect | `ids`, `lookup`, `capabilities`, `query`, `sketch_get`, `measure_between`, `bom`                           |
| Sketching      | `sketch`, `sketch_edit`, `datum_plane`, `attach`, `bind`, `ref`, `bolt_sketch`                             |
| Prismatic      | `pad`, `pocket`                                                                                            |
| Round          | `revolve`, `groove`                                                                                        |
| Swept          | `pipe` (alias `sweep`), `subtractive_pipe` (alias `subtractive_sweep`)                                     |
| Lofted         | `loft`, `subtractive_loft`                                                                                 |
| Dressing       | `fillet`, `chamfer`, `draft`, `shell`                                                                      |
| Repeats        | `pattern` (feature in its body), `polar_array` / `link_array` (whole-object links), `mirror` (whole solid) |
| Multi-solid    | `boolean`, `split_body`, `primitive`, `place`                                                              |
| Purchased      | `insert`, `swap`, `hole`, `mate`, `fastener_pattern`, `param`, `material`                                  |
| Lifecycle      | `feature_edit`, `suppress`, `delete`, `allow`, `batch`                                                     |
| Presentation   | `isolate`, `show`, `view_set`, `view_fit`, `view_section`, `view_restore`, `render`                        |

### Shaping material

- **Prismatic** — `sketch` then `pad` or `pocket`. `pocket` measures which way
  the material is and flips itself once if the cut removed nothing. A through
  cut whose profile plane runs **through** the material is made symmetric
  automatically — a bore sketched on a centre plane means the whole bore, and a
  one-way through cut leaves the far half standing while recomputing perfectly
  clean. The result says when that happened; `midplane: false` cuts one way.
- **Round** — `revolve` (shafts, bosses, seats) or `groove` (bores, O-ring and
  retaining-ring grooves). `axis` is `V` (the sketch's own vertical) or `H`, and
  the profile has to stay on one side of it. `groove` is measured like `pocket`.
- **Swept** — `pipe` / `subtractive_pipe` carry a profile sketch along a path
  sketch. `mode` (`Fixed`, `Frenet`, `Auxiliary`, `Binormal`, `Curvilinear`) and
  `transition` (`Transformed`, `RightCorner`, `RoundCorner`) match
  case-insensitively, and an unrecognised value is **refused** rather than
  quietly defaulted. A path sketch with no edges is refused for the same reason:
  an empty spine builds, reports Up-to-date, and adds nothing.
- **Lofted** — `loft` / `subtractive_loft` between 2–32 closed sketches. Every
  section is profile-checked before the feature is built, and a section listed
  twice is refused. `ruled: true`, `closed: true`.
- **Tapered** — `draft` tapers **faces** relative to a neutral plane (`XY`,
  `XZ`, `YZ`, a datum, or a face ref) for mould and die-cast release. Pick faces
  the way `fillet` picks edges — `refs` from a user pick, or `query`, which
  defaults to `kind: "face"` here and is stored with the feature so an upstream
  change re-resolves instead of aborting. The reply reports `taper`
  (`inward`/`outward`/`none`) and `volumeDelta`: which way it pulled is
  measured, not assumed. `taper: "none"` is a failure.
- **Hollowing** — `shell` needs `refs`: the faces to open. Same rule as
  `fillet`.
- **Repeats are one distinction with two ops, not two names for one thing.**
  `pattern` repeats a **feature inside its own body**, fused into the solid: six
  holes in one plate, a row of slots, a ring of teeth. `polar_array` and
  `link_array` make **App::Link copies of a whole object**: three planets at
  120°, 120 bolts as one master and 120 links. Links cannot be cut into a plate
  and a hole is not a part; each op refuses the other's target and names the one
  you wanted. `mirror` is the third case and mirrors a **whole solid** across a
  plane — it does not mirror a feature. For a symmetric pair of pockets, put
  both in one sketch or use `pattern`.
- **Between bodies** — `boolean` with `op: cut | fuse | common`. PartDesign
  works inside one body; a housing minus its internals is a document-level
  boolean and this is the only way to ask for one. It reports a cut that removed
  nothing, a fuse that added nothing and an empty intersection rather than
  passing any of them off as success. `primitive` (box, cylinder, sphere, cone)
  exists so `boolean` has something to cut with — a tool solid carries no
  sketch and nothing to bind an expression to, so anything the user will want to
  change later is still sketch + pad.
- **Two parts out of one** — `split_body`. PartDesign refuses a feature whose
  result is more than one solid, and _"Result has multiple solids"_ is not a
  mistake you made: it is the workbench saying this is two parts. A clamp with a
  slit, a split housing, a stem and its faceplate are all this. Pass the plane
  (`XY`/`XZ`/`YZ` or a datum id), `offset`, `gap` for the width of the cut, and
  `ids: [a, b]`. Read `sides: {positive, negative}` rather than remembering that
  `ids[0]` is the `+normal` half. `asBodies` says whether the halves came back
  as PartDesign Bodies. The halves are snapshots: an upstream edit does not
  reach them, so split late — and lint reports `split-stale` every turn until
  the split is re-run, because the halves are then describing a shape the
  document no longer has. Re-running `split_body` updates them in place and
  preserves downstream features.
- **Moving something** — `place`, with `at`, `rotate`, or both, and
  `relative: true` to add to where it already is. It refuses a PartDesign
  feature: those are positioned by their sketch's attachment, and a Placement
  written on one is discarded without an error.

### Sketching

Primitives are `rect`, `circle` and `slot` (all fully constrained and anchored),
`line`, `arc`, `polyline` and `bspline`. **There is no ellipse.**

- **`rect` takes `anchor: "center"`**, and for a mechanical part that is usually
  the one you want: `x, y` becomes the middle rather than the bottom-left
  corner. A body symmetric about a bore written corner-first is a negated
  half-dimension typed by hand once per rectangle, and nothing downstream can
  tell a correct one from one that is half a width out.
- **`slot`** is a rounded slot — `{type: "slot", x, y, length, width, angle}`,
  `length` tip to tip, `x, y` the centre. Reach for it instead of computing cap
  points into a `polyline`: a generated polyline carries no dimensions, so it
  can never be bound to a parameter and it warns about degrees of freedom
  forever.
- **`polyline` is the channel for a computed profile** — an involute flank, a
  cam, an offset outline. Its points are joined but not dimensioned, so pass
  `fix: true` to block them.
- **`bspline`** (`poles: [[x,y],...]`, `closed`, `fix`) says the same curve in
  far fewer points. Reach for it wherever a polyline would need hundreds of
  segments — that is a sketch that recomputes slowly forever after — and for any
  smooth section an ellipse would have covered.
- `sketch` takes `on: "XY" | "XZ" | "YZ"` **or the id of a datum plane or a
  captured user pick**, and reads the attachment back, so it cannot silently
  no-op. Attaching at creation is one call rather than two.
- **`sketch_get` before `sketch_edit`.** `sketch_get` returns every geoId with
  the numbers that identify it, every constraint with its index and expression,
  the DoF, the conflicts, and what the profile encloses. Indices shift when
  geometry is deleted, so read them in the same turn you use them and never
  author one from memory. `sketch_edit` then adds/removes geometry, adds/drops
  constraints, binds a dimension, or flips an element to construction —
  removals happen before adds. Deleting geometry silently deletes the
  constraints that used it; the reply counts them as `constraintsLost`, and a
  sketch that lost constraints solves fine at the wrong shape.

### Parameters and expressions

- `param` reads or sets a named value in the parameter sheet. It takes units:
  `45`, `"45 mm"`, `"1.5 in"`, `"12 deg"` all work and convert to the
  document's own. **Do not convert in your head** in a skill whose argument is
  that conversions done in someone's head are where the 0.2 mm comes from. The
  reply echoes what the sheet reads back **after** its recompute, so the value
  you see is the value features will bind to.
- **A feature dimension can be the expression itself.** `pad`/`pocket` `length`,
  `hole` `diameter` and `depth`, `fillet` `radius`, `chamfer` `size`, `shell`
  `thickness`, `revolve`/`groove` `angle`, `datum_plane` `offset`,
  `split_body` `offset`/`gap` and the `primitive` dimensions all take a string:
  `pad({sketch: "sk.base", length: "koi_params.StackHeight"})` is one call. Do
  **not** pad with a literal and then `feature_edit` it parametric — that is two
  transactions, two undo entries, and a literal sitting in the document in
  between that nobody meant. The reply carries `dimension` with the binding and
  whether the document kept it; a quoted number (`"40"`) is still a number.
- **A sketch dimension can be the expression itself.** Any `x`, `y`, `w`, `h`,
  `d` or `r` in a primitive takes a string and binds to it:
  `{type: "circle", d: "koi_params.bore", x: "koi_params.pitch / 2"}`. A
  diameter is bound as a diameter — the halving onto the radius constraint
  happens here, not in your head. The reply lists every binding with the value
  it solved to; if `bindingNote` comes back, one of them is a literal and will
  not follow the parameter, and that has to be said rather than reported as
  parametric.

## 6. References to faces and edges

`Face6` is an index, not a name. A recompute renumbers it, and the reference you
captured in turn 3 is the one that bites in turn 7.

- **Never invent one.** A face or edge reference authored on this side is
  banned. If you need "that face", ask the user to click it, then capture it:
  `freecad_call({fn: "ref", args: {from: "selection"}, id: "pick.top"})`.
- **Re-validate every turn that changed geometry.** `freecad_resolve()` is
  `safe` and takes no arguments; `freecad_sync` already carries the report.
  `stored` means the name still means the same element. **`rederived` means
  re-capture it** — it was found again from what generated it, and the name it
  returns is a raw index, accurate now and no more durable than any other.
  **`broken` or `ambiguous` means stop and ask.**
- **Prefer a datum plane to a picked face wherever one exists.** `datum_plane`
  makes one, `sketch` attaches to it through `on`, and `attach` moves an
  existing object onto it. A datum survives the recompute that renumbers
  `Face6`. Datums are created invisible; `visible: true` for one the user
  should actually look at.
- **`query` is how you select by geometry instead of by index.** Filters:
  `kind` (`face`/`edge`), `surface` (`Plane`, `Cylinder`, `Line`, `Circle`),
  `normal`/`direction` (`+Z` or `[x,y,z]`), `at`, `tol`, `minSize`, `maxSize`,
  `radius`, `sort`, `limit`. It reports how many matched instead of picking the
  first. **A plural selection is not an ambiguous one** — chamfering four corner
  edges is one intent that matches four edges, so pass `expect: "many"` (or a
  count) and hand the returned `refs` array straight to `fillet`, `chamfer`,
  `shell` or `draft`. What is banned is choosing _by index_, not choosing more
  than one.
- **On a model that is still moving, give `fillet`/`chamfer`/`draft` a `query`
  instead of `refs`.** The filter is stored with the feature, so when a later
  parameter change renumbers the edges the envelope re-runs it and repairs the
  feature instead of aborting the whole write with
  `new-recompute-errors: chamfer_…`. That abort is expensive: it takes the
  thirteen-step geometry batch behind it with it, and the recovery is deleting
  the downstream features, deleting the chamfer, changing the parameter and
  rebuilding all of it. When the repair fires, the result carries `rehealed` —
  the edges were re-derived, not preserved, so check them before reporting.
- **To make a profile follow the model, project it.**
  `sketch({external: ["pad.housing:Edge4"]})` — or better,
  `sketch({query: {...}})` — puts a model edge into the sketch so a constraint
  can be written against it. A cover plate sketched this way IS as wide as the
  housing; written with `w: 60` it merely happens to be, until the housing
  changes. The reply gives a `geoId` per projection (external geometry starts at
  `-3`), and that is the address `constraints: [{type, args}]` uses. Projecting
  and then writing the dimension as a literal anyway buys nothing at all.
- **Prefer `query` here more strongly than for `fillet`, and for a worse
  reason.** When a chamfer's edge goes, the chamfer errors and the write aborts
  — loud. When a projection's reference goes, FreeCAD **deletes every constraint
  that used it** and the sketch solves at whatever shape is left: no error, no
  abort, a quietly wrong part. The envelope re-runs a stored filter and reports
  `rehealedExternal` with the constraint count before and after; if it says
  constraints were lost, the sketch is the wrong shape until somebody looks at
  it. Say so rather than reporting the edit as clean.
- **`external` will not cross a body. `bind` is the way across.** A cover plate
  is its own body and the housing it matches is another, so
  `bind({body: "body.cover", of: "pad.housing:Face2"})` makes a
  `SubShapeBinder` — a local object that follows the source. Then
  `sketch({on: <id>})` attaches to it and `sketch({external: ["<id>:Edge1"]})`
  projects from it, exactly as if the geometry had always been local. Get the
  `of` ref from `query` or a user pick; do not type an index. Created invisible,
  like every other piece of scaffolding.

## 7. Purchased parts, fasteners and mass

A bought component is not a solid you model. It is an **interface** (M5
clearance 5.5, head Ø8.5; bore Ø25 h6, OD Ø37 H7, width 7), an **envelope**, and
**metadata** (MPN, mass, purchased). Model the interface; the solid is only how
you look at it.

- `lookup` gives the fastener table, the catalog, the stock sizes and what this
  document has published (`what: "all"|"fasteners"|"catalog"|"stock"|"params"`).
  **Quote it rather than recalling it** — a clearance hole 0.2 mm out does not
  assemble.
- `insert` brings in a fastener (`fastener: "M5", length: 16`), a catalog part
  (`catalog: "NEMA17_envelope"`), or an inline spec, and publishes the part's
  interface into the `koi_params` sheet. That publication is what makes a swap
  propagate.
- `hole` takes **one spec, not three numbers**. `spec: {from:
"bolt.mount.clearance"}` binds the diameter to a published value **by
  expression** — do this instead of typing 5.5. `spec: {clearance: "M5"}` or
  `{tap: "M5"}` reads the table directly. With neither spec nor `diameter` it
  takes the size from the profile sketch's own circles (reported as
  `diameterFrom`), which is how `bolt_sketch` composes straight into it.
  `counterbore: true` alongside a spec, or `counterbore: "M5"`, takes `cbore_d`
  and `head_h` straight from the table so the head sits flush without a second
  sketch. `depth` **means** a depth and is verified against the document;
  `through: true` **and** a depth together is refused rather than resolved in
  favour of one of them.
- `bolt_sketch({component, on, at})` is a sketch of clearance circles on an
  inserted component's bolt pattern, with positions bound **by expression** to
  its published pitch. This is what makes a NEMA 17 → NEMA 23 swap move the
  plate's **holes** and not just their diameter. Check `bindingVerified` — if it
  is false the positions are literals and will not follow a swap, and that has
  to be said rather than reported as a parametric pattern.
- `swap` changes the part and the plate follows on recompute. **If a change
  request means "a bigger bolt", swap the bolt — do not edit the hole.**
- `mate` seats an inserted part in a hole: `{target: "bolt.a", hole:
"hole.mount", near: [x,y,z]}`. It takes the axis and the seat from the hole's
  own profile sketch, so nothing here is a hand-computed position or a
  quaternion. `offset` lifts along the axis (a washer), `spin` turns about it,
  `flip` seats from the other side. A hole with several instances refuses until
  `near` says which one.
- **`fastener_pattern` seats every instance at once** — `{hole:
"hole.face_bolts", fastener: "M5", length: 16}` — and is what you want any
  time the answer is "a bolt in each of those". It reads all the seats out of
  the same profile sketch `mate` reads one from: no `near` per bolt and no
  coordinate typed by hand. One hidden master and N links, so the BOM reads it
  as one line of N. `offset` defaults to the counterbore depth so heads seat
  instead of standing on the face. Reach for `mate` only when a single part goes
  in a single named hole.
- **`material` is what gives the BOM a mass.** A body with no material weighs
  nothing, and `bom` says which ones those are. Call `material` with no target
  for the table (32 entries, g/cm³), or with `target`/`targets` and a `name`
  (`aluminium-6061`, `stainless-304`, `pom-acetal`) or an explicit `density`.
  Mass is volume × density and nothing else.
- `bom` reads it all back out: purchased components with MPN, quantity, mass and
  role, plus the bodies that still have to be made. A pattern is one line of N,
  not N lines. A solid a `split_body` cut halves out of is `split-source` and is
  excluded from `fabricatedVolumeMm3` — it is the same material as both halves
  and nobody makes it. Quote this when the user asks what the design weighs,
  costs or needs ordering, and if a line reports no mass, say so rather than
  giving them a total that quietly omits it.

**Threads are a specification, never geometry.** `threaded: true` writes the
spec; nothing here cuts a helix, and lint reports it if something does.
`threadSize` is matched against this build's own enumeration — `"M5"` finds
`"M5x0.8"` — and a size it cannot match is **refused** rather than written,
because `Threaded: true` over a rejected size silently drills the default: an M5
that became an M4 at Ø3.3 with nothing in the reply to show it. Threading also
moves `Diameter` to the tap drill; quote the readback.

**Dimensions come from stock.** Plate thicknesses and drill sizes are in the
library. A 7.3 mm plate cannot be bought and a 9.3 mm hole cannot be drilled, so
`non-stock` and `thread-engagement` are lint errors rather than matters of
taste. Report them with the number to hit.

## 8. Verifying

`freecad_measure` is `safe` — it costs the user nothing, so use it. A screenshot
cannot tell a plate with a hole from a plate without one, and neither can the
state flags: check the volume.

- `interference: true` gives the common volume of each pair. Zero for parts that
  merely touch; anything above zero means they cannot both exist. Bounding boxes
  reject most pairs first, so this is cheap enough to run every turn that moved
  something.
- `clearance: true` gives the minimum distance — service gaps, wrench access,
  whether a 2 mm gap is still 2 mm after the edit.
- `deepLint: true` adds the rules that walk face lists (sliver faces, unclosed
  solids). Out of the per-turn lint on purpose; ask for them when a boolean or
  an export starts behaving strangely.
- **`partsOnly: true` for verification a human is going to read.** The default
  measures every object with a shape — origins with infinite boxes, every
  sketch, every intermediate pocket — and truncates before it reaches the parts
  that were the question. `partsOnly` is bodies and purchased components, minus
  the hidden solid a split was cut from and the hidden master a pattern's links
  point at, which otherwise fill the interference hits with parts overlapping
  their own copies.

**`measure_between` is the other half, and `freecad_measure` cannot do its
job.** `freecad_measure` answers questions about whole objects; it cannot reach
inside one. Centre-to-centre, axis-to-axis, minimum distance, angle, parallel,
perpendicular, coaxial, and the material left between two bores are all
`measure_between`. It takes refs the way `fillet` does — a ref id from a user
pick, an `object:Face3` pair from `query`, or a whole object — and `a` alone
asks what one thing IS. **Passing a PartDesign feature id measures the whole
body's shape**, so to get the distance between two bores, `query` their
cylindrical faces and pass those.

**`volume` is exact; `bbox` is not.** On a curved face the bounding box is read
off the triangulation once the 3D view has drawn the shape, and an inscribed
mesh is smaller than the surface it approximates — a Ø12 cylinder measures
11.976 across. Whether it does depends on whether the window has rendered, which
is not a fact about the model. Half a percent on anything round: fine for "does
this fit through that", not a number to quote to a machinist and not a number to
assert an equality on.

**`allow` is how the interference check stays readable.** Declare that a pair is
_designed_ to overlap, with a bound and a reason: `allow({pairs: [["body.crank",
"pin.pivot"]], upTo: 0.05, why: "m6/h7 press fit"})`. Meshing gear flanks, press
fits, tapped holes. It is stored on the document so it survives the turn. It
bounds an overlap, it does not hide one — anything past `upTo` is still a hit,
and everything allowed is still reported under `expectedOverlaps`. Without it
the first gearbox makes interference permanently red and the check stops being
read.

**`recompute` is the repair call, and it is the only fix for two things.**
`force: true` rebuilds a document sitting touched-but-not-rebuilt, or stuck in
an error state a plain edit will not clear — before this the only move was
delete-and-rebuild, which throws away the DAG to fix a stale flag. `refine:
true` sets Refine on every feature that has it, removing the coplanar splitter
edges a boolean leaves across a face — **the sliver faces `deepLint` reports.**
Refining cannot change the volume, so the volume is measured either side and a
difference is reported as a problem rather than a result.

## 9. Changing your mind

- **`feature_edit`** reaches any property or expression an object has,
  `Label` and `Visibility` included. Several in one `batch` is one round trip,
  and that is what to reach for instead of a Python loop over a handful of
  objects.
- **`suppress`** switches a feature off without deleting it: the material goes
  away and the DAG, the ids, the downstream features and the user's picked refs
  all stay. This is the answer to "that pocket was wrong". `suppressed: false`
  puts it back; the reply carries the tip's volume before and after, so a
  suppression that changed nothing says so. A suppressed feature is left out of
  lint, because it is off on purpose.
- **`delete`** refuses the two deletes that quietly break a model — a feature in
  the middle of a body (deleting it rewires `BaseFeature` for everything after
  it, which has collapsed a body to a single cut) and an object something else
  is built from. Both refusals name `suppress`, which is almost always what was
  meant. `force: true` goes through and the reply says it was forced.

## 10. Showing, saving and handing over

The scaffolding hides itself. A datum plane is created invisible, and a profile
sketch and the datum it stands on are hidden as soon as a `pad`, `pocket`,
`hole`, `revolve` or `groove` consumes them — the ops report what they hid. Only
objects this session made are ever hidden; the user's own datum stays where they
put it. Origins stay out of the tree entirely: every body carries an
`App::Origin` with six datum features that are never edited and never
referenced.

- **`isolate` before a screenshot of anything internal** — a pocket inside a
  housing is invisible until its surroundings are hidden — then **always**
  `view_restore`. The user did not ask for their model to disappear.
  `view_restore` leaves origin planes and axes hidden and lists them under
  `originsLeftHidden`; restoring 18 translucent infinite planes over the part
  you just framed is worse than not restoring at all. `includeOrigins: true`
  when the document has to go back exactly as it was found.
- **`show({targets, visible})`** for the other case: hide the jig, show the
  faceplate and its bolts. It reports what actually changed and what was already
  that way, so a no-op does not read as success.
- **`already: true` is not "the user can see it", and neither is `Visibility`.**
  Both are facts about a _container_. After a `split_body` the solid lives in a
  `PartDesign::FeatureBase` inside the Body, and hiding that leaves
  `Body.Visibility` reading `true` over an empty viewport. `isolate` and `show`
  return `{label, volume, bbox, drawn, hiddenBy}` per target and a `notDrawn`
  list. **Read `drawn`.** If anything is in `notDrawn`, say so instead of
  describing what the model looks like. `isolate` keeps the solid and its
  instances, **including the FeatureBase** — do not hide a `_base` object as a
  duplicate, it is the shape.
- **`view_section`** clips the 3D view on a plane so the human can see inside.
  `plane: "XY"|"XZ"|"YZ"` or `normal: [x,y,z]`, with `offset` and `flip`. It
  clips the **view**: no geometry changes, nothing recomputes, and the cut face
  is open rather than capped — so it answers "does that break through" and not
  "how thick is that wall". The second is `measure_between`. Turn it off with
  `off: true`; `view_restore` drops it too. Leaving a session's clip on the
  human's view is the same mistake as leaving their model isolated.
- **`freecad_render({view, width, height})`** is the pixel channel. It goes
  through FreeCAD's own renderer, so it does not care whether the browser has
  focus or whether the WebRTC canvas has painted, and the image arrives as an
  image rather than a screenshot of a video frame. It frames the shot and puts
  the camera back. Two views minimum for anything three-dimensional, about two
  screenshots a turn. Pixels are for the human's sanity check; use
  `freecad_measure` for your own.
- **`freecad_call({fn: "render"})`** is the same capture written to disk and
  needs `savePath`; it returns the path and the dimensions, never the pixels.
  Reach for it to leave a file behind, not to look at something. `savePath` is a
  bare filename or a path inside the export directory — anywhere else is
  refused, and so is an extension that does not match the format.
- **`view_set`** points the camera (`iso`, `front`, `rear`, `top`, `bottom`,
  `left`, `right`). It moves the user's view, so say why before using it.
- **Moving the camera and redrawing the window are two different things, and
  only the first is the human's.** Every applied write raises the document's MDI
  tab and forces the 3D view to repaint, unconditionally — a viewport still
  showing the pre-pocket solid is not a preference, it is wrong. This is silent
  when it works and shows up as `guiSync` **only when it failed**, which is a
  hard stop on describing the stream. Two failures in a row means the bridge has
  lost its GUI; say so. `view_fit({sync: false})` turns the repaint off for a
  human dragging the view through a long batch; `view_fit({auto: false})` stops
  the automatic camera re-fit for a user driving the camera themselves.
- **`save` writes the human's own file.** With no path it saves in place and
  needs the document to have been saved once; with a path it is Save As, which
  **rebinds** the document so every later save goes to the new file — the reply
  says which happened in those words. Do it because they asked, not on a hunch.
- **`freecad_export`** writes FCStd, STEP, BREP or STL into the export directory
  and reports the path — a separate copy that leaves their file alone. Use it to
  hand geometry to a manufacturer or another CAD, and as a checkpoint before a
  risky edit. It is not the only thing standing between the user and losing
  their work, and saying so would be scaremongering.
- **`import_geometry`** brings a STEP, IGES or BREP file in as geometry — a
  supplier's connector, a customer's mating part, a casting. What arrives is a
  **shape**: no features, no sketches, no parameters, nothing to bind an
  expression to. Say that rather than dressing it up as a model you can edit.
  Use it to measure against, interfere against and cut with; for a part you are
  _designing against_, `insert` and its interface is still the right thing.
  Several objects come in under one `App::Part` so `place` can move the lot.

## 11. Reading the result

- `applied` — is it still in the document. `ok` — was it correct. A dry run is
  `ok: true, applied: false`; reporting that as a failure would be wrong.
- `lint` — measured, not inferred. A pocket that removed nothing reports
  `Up-to-date` and `isValid()`, so if lint says `removed-nothing`, believe it
  over the state flags and over the screenshot.
- `undoEntries` / `singleUndo` — the undo cost, measured rather than promised.
  `singleUndo: false` means one Ctrl+Z will **not** put this back, and
  `undoEntries: 0` means Ctrl+Z will not reverse it at all. The user should hear
  that from you rather than discover it.
- `revertedAiObjects` — the user deleted something you made. That is a
  rejection. Do not re-create it; ask.
- `refsBroken` / `refsNote` — the edit broke a reference the user picked. Say
  which one; do not silently pick a replacement.
- `guiStale` / `guiStaleNote` — the viewport did not refresh. Do not describe
  what is on screen; describe the change from the reply and use
  `freecad_render` for a picture that is definitely current.
- `unregisteredObjects` — a script created something nobody can address later.
- `non-stock`, `thread-engagement` — buildable in CAD and not in a workshop.
- `split-stale` — re-run `split_body` before exporting anything.

## 12. What is not here

Say it plainly rather than improvising a substitute:

- **Assembly constraints and mates.** Parts are positioned, not mated. `mate`
  and `fastener_pattern` read an axis and a seating face off a hole and write
  one Placement — the arithmetic six bolts used to cost by hand. Nothing is
  constrained afterwards, and moving the plate leaves the bolt behind. Say that
  when you use it.
- **Motion, and interference through a sweep.** You can `place` a part through
  discrete positions and measure at each one, and that is a legitimate check —
  but it samples a continuum, and the true minimum can fall between samples.
  Say which angles you sampled.
- **Drawings and dimensioned output.** No TechDraw.
- **Threads as geometry**, sheet metal, and FEA.
- **An ellipse sketch primitive**, and a mirrored _feature_ (`mirror` is a whole
  solid).
- **Mesh import.** STL goes out; only STEP, IGES and BREP come in.

If `capabilities` shows a module importing cleanly, that still does not make it
available here — importable is not wired.

## 13. What not to do

- Do not restart FreeCAD, and do not close the user's documents. Attach is
  adopt-only. Their unsaved work, undo stack and camera are theirs.
- Do not drive the GUI. No synthetic clicks, no keystrokes, no workbench
  switching. The GUI belongs to the human, and they are watching it.
- Do not run Python that can open a modal or spin the event loop. Snippets run
  on the thread that owns the document, dispatched through a timer callback; a
  modal opened from one blocks that thread and every call behind it until
  somebody clicks it — and the somebody is the human, who is not expecting a
  dialog they did not open.
- Do not model threads as cut geometry, and do not reference a face or edge you
  picked yourself.
- Do not touch the user's FreeCAD preferences. If notification toasts sit over
  the model in the stream, say so and let them turn the notification area off in
  Preferences → General; silently rewriting a preference to make a screenshot
  look better is a change to their machine they did not ask for and would not
  see.
- Do not quote a ceiling. Cost is driven by _unique_ parts, not instances, and
  the binding limit is the single-threaded recompute — but where that ceiling
  sits has not been measured at a realistic size on this transport. What holds
  without a number: a recompute that takes minutes is a recompute the human sits
  through, watching a window that does not respond. Notice when the model is
  heading that way and say it before they find out.

## 14. Reporting to the user

Open with `freecad_attach`'s one-line `status` — _Connected to FreeCAD 1.1.3
(GUI), build 4c8a2f1b90, pinned build matches._ — then ask what they want to
build.

- When the build is **unpinned**, attach says so in one clause and hands back
  `pinHint`. Mention it once, in a sentence, and get on with their request.
- When `freecad_attach` reports a **protocol mismatch**, that is version skew
  between the two halves of the bridge, not a user error: `tools/koi_bridge.py`
  and `mcp/freecad_mcp.js` ship together. Tell them to copy the macro out of
  this version of the skill and reload it.
- When it reports the **bridge is up but the interpreter never answered**,
  FreeCAD is alive and busy — a long recompute, or a modal waiting for a click.
  Say which it looks like and wait.
- When the **export directory is not writable**, everything else works but there
  is no way to hand geometry out of the session. Tell them before they build
  something they will want to export.
- When `koiCadNote` says a **stale module was replaced**, nothing in the
  document changed — but if the human ran a koi call before this attach, it ran
  against the old module.
