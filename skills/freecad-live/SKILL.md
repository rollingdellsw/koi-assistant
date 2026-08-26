---
name: freecad-live
description: Turn-based human/AI co-design of a live FreeCAD document running natively on this machine. Reads the document every turn, edits it through a validated call whitelist inside a transaction envelope, measures the result rather than trusting it, and keeps user-picked face and edge references alive across recomputes. Purchased parts are interfaces bound by expression, not modelled solids. Checks that the result can actually be made -- corner radii, tool reach, undercuts and the volume no cutter can reach -- and can run the CAM workbench to prove a toolpath exists. Where CalculiX is installed it also runs a linear static solve, so "is it strong enough" is answered with a measured stress or refused, never with a sentence. Pins the exact FreeCAD build the session is talking to.
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
    description: Sync before reacting to human changes or ambiguous context.
    trigger:
      type: "user_message"
      pattern: "."
    content: |
      FreeCAD turn protocol: call freecad_sync() when starting a session,
      when referencing user selections ("this face", "this one"), or before
      reacting to human changes (userDiff). For direct, self-contained design
      sequences or known batches, proceed directly with freecad_call/batch to
      avoid unnecessary latency.
    strategy: "persistent"
    priority: "medium"

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

  - id: "freecad-live:manufacturable"
    description: A design nobody can make is not a finished design.
    trigger:
      type: "tool_call"
      toolName: "freecad_export"
    content: |
      Geometry is about to leave this session. Before handing it to anyone who
      will make it, run freecad_dfm — it is `safe`, it writes nothing, and it
      is the only thing here that answers whether the shape exists in metal
      rather than only in the document. Report its `verdict` with the export,
      including a `manufacturable: null` (a check that did not run is not a
      pass). If they are machining it, freecad_cam({mode:"job"}) then
      {mode:"verify"} is the toolpath-level proof.
    strategy: "persistent"
    priority: "high"

  - id: "freecad-live:dfm-findings"
    description: The findings that are geometry, not opinion.
    trigger:
      type: "tool_result"
      toolName: "freecad_(dfm|cam)"
      outputPattern: 'manufacturable":false|manufacturable":null|machinable":false|dfm-|emptyOperations":\["'
    content: |
      This reply carries a manufacturability finding. `dfm-sharp-corner`,
      `dfm-undercut`, `dfm-unreachable-volume` and `dfm-internal-void` are not
      tolerances to negotiate — no smaller tool, slower feed or extra setup
      fixes them. An empty CAM operation is the workbench saying it could not
      cut that feature. Say which finding it is, what it costs, and what
      change would clear it, BEFORE building anything else on the part.
      `manufacturable: null` means a check did not run: report it as
      unfinished, never as a pass.
    strategy: "persistent"
    priority: "high"

  - id: "freecad-live:drawing-findings"
    description: A sheet that agrees with itself and disagrees with the part.
    trigger:
      type: "tool_result"
      toolName: "freecad_draw"
      outputPattern: "dimensionsDisagree|projectionReferenced|emptyViews|templateMissing|mixedScales|undimensioned|dimensionsUnchecked"
    content: |
      This sheet carries a finding that prints. `dimensionsDisagree` means a
      dimension shows a number the model does not measure — somebody will make
      the part to the sheet, so name it and stop. `projectionReferenced` means
      a dimension is attached to the projected edge: it reads short on
      anything not parallel to the sheet and migrates when the view
      regenerates. `emptyViews` prints blank. `templateMissing` means no
      border, no title block, no scale field. `mixedScales` is legitimate and
      is also how a part gets made at the wrong size. `dimensionsUnchecked` is
      unchecked, not correct. And never call a drawing complete — the tool
      reports a count and refuses that verdict on purpose.
    strategy: "persistent"
    priority: "high"

  - id: "freecad-live:motion-findings"
    description: A mechanism that solves at one pose and fails at another.
    trigger:
      type: "tool_result"
      toolName: "freecad_motion"
      outputPattern: 'collides":true|branchFlip":true|sweepIncomplete|lockedNote|ungrounded":true|mismatch":true|checked":false'
    content: |
      This mechanism carries a finding that outranks the pose in any render.
      `collides` means it fouls itself in travel — name the pair AND the
      angle. `branchFlip` means the solver walked onto the other assembly
      configuration: every pose is valid and the physical linkage cannot get
      there, so the far side is not reachable travel. `sweepIncomplete` and
      `lockedNote` mean it does not go as far as it was asked to. `ungrounded`
      means every placement is measured off a floating frame.
      `interference.checked:false` is not a clean bill — it means nothing was
      looked at. Say which one applies before describing how the mechanism
      moves.
    strategy: "persistent"
    priority: "high"

  - id: "freecad-live:fem-findings"
    description: A stress number that is a property of the mesh, not the part.
    trigger:
      type: "tool_result"
      toolName: "freecad_fem"
      outputPattern: 'singularitySuspect":true|converged":null|factorOfSafety":null|displacementImplausible|stale":true|solved":false'
    content: |
      This solve carries a finding that outranks the number next to it.
      `singularitySuspect` means the peak sits on a sharp corner and rises
      forever as the mesh refines — quote the p99, say the peak was discarded
      and why, and offer the fillet. `converged: null` means it was solved
      once, so mesh-independence is UNKNOWN: report it as an unfinished check.
      `factorOfSafety: null` is a refusal with a reason attached, never a pass.
      `displacementImplausible` usually means a missing restraint, not a bendy
      part. `stale` means the geometry moved after the solve. Say which one it
      is before saying anything about strength.
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
      the model is measured rather than assumed at this point. If there is a
      solid, freecad_dfm() as well: an undercut found at turn 15 is a sketch
      edit, and the same undercut found at handover is a redesign.
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
  - freecad_dfm
  - freecad_cam
  - freecad_fem
  - freecad_motion
  - freecad_draw
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

**`freecad_sync()` synchronizes with the human co-designer.** Call it when
opening a session, responding to user references ("this one", GUI selection),
or inspecting what changed since your last response. Read four things from it:

- **`userDiff`** — what they changed. `revertedAiObjects` means they deleted
  something you made: a rejection, never silently re-created. `dofChanges`
  means a sketch came loose.
- **`selection`** — what they have clicked, fingerprinted. When they say "this
  one", this is what they mean; you do not have to guess and must not.
- **`health`** — errors, touched, underconstrained, at a glance.
- **`guiBusy`** — advisory. The real gate is inside the edit, which fails
  closed. If it is set, answer in prose and wait.

**Avoid redundant syncs during continuous design flows.** When executing a
known sequence of steps (such as setting parameters, building sketches, or
running batches), you can proceed directly to `freecad_call` or `batch`. Each
write call runs inside the transaction envelope, checks the GUI gate, and
returns its own diff and lint report.

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
| Manufacturing  | `cam` (Job, operations, toolpaths, G-code — see §8)                                                        |
| Analysis       | `fem` (analysis, restraints, loads, mesh, CalculiX solve — see §8)                                         |
| Mechanism      | `motion` (grounding, mobility, sweep a joint, interference in travel, holding torque — see §8)             |
| Handover       | `draw` (page, views, dimensions cross-checked against the model, DXF/PDF — see §8)                         |
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

### Manufacturability

Everything above this line answers _is the model what I meant_. None of it
answers _can this be made_, and those are different questions. A part can be
dimensionally perfect, recompute clean, pass interference, and weigh exactly
what the BOM says, and still be a shape no cutter can produce. An internal
corner with a zero radius is the canonical case: it is trivially valid
geometry, and it does not exist in metal.

**Do not assert manufacturability. Measure it.** A sentence from you saying a
part looks machinable is worth nothing; a residual volume that came out of an
offset operation is worth what it says.

**`freecad_dfm` is `safe`, writes nothing, and needs no CAM workbench.** Run it
on any solid before handing geometry to anybody who will make it, and run it
early enough that a finding is still a sketch edit. It reports:

- **Internal corner radii** — the tightest concave corner running along the
  tool axis sets the largest cutter that fits, and `nearestStockTool` says
  which one you can actually buy. A **sharp** internal corner (`dfm-sharp-corner`)
  is not a smaller tool: a rotating cutter leaves its own radius, so the answer
  is a corner relief, EDM, or a redesign. Rounding a corner to a stock radius
  usually costs nothing and lets a bigger, faster tool in — that is worth
  offering.
- **Reach per setup direction** — a face reachable from none of the tested axes
  is an **undercut** (`dfm-undercut`) and no feed rate, tool or setup reaches
  it on a 3-axis machine. A part needing more than one direction is
  `dfm-multi-setup`: makeable, but each re-fixture is a tolerance stack, so say
  so before quoting a position tolerance across the two.
- **The residual** — the volume a cutter of that diameter cannot reach from
  **any of the setup directions being checked**. This is the conclusive number,
  and it is an intersection, not a sum: a pocket in the underside of a plate is
  a second setup, not a defect. **Read `obstructed`, not `volumeMm3`.** The
  reply names the `method`, and the two do not claim quite the same thing:
  `slab-2d` slices along each axis and models a flat end mill arriving from
  above, so a square pocket floor reads zero; `ball-closing` is the fallback,
  axis-free and therefore stronger where it works, but its structuring element
  is a ball, so it leaves the cutter's own radius in every internal corner —
  reported as `skinOnly` with `dfm-corner-leftover` at `info`, not as a
  failure. That one is still worth a sentence: the corners will be radiused,
  not square, and a drawing that says otherwise is a drawing the shop will
  phone about. A leftover that could not be classified is reported as
  obstructed on purpose.

  Stock defaults to the part's **bounding box**, so the material to remove is
  what a rectangular billet has and the part does not. Pass `stock` or
  `stockMargin` for a real billet with an allowance — but an allowance on the
  underside is machined in its own setup, and counting it against the first one
  would report every plate as unreachable from the side its top was cut from.

- **Enclosed voids, hole depth ratios, flat-bottomed blind holes** — a cavity
  with no opening cannot be cut by anything; a hole past 5×D is a peck cycle
  with a special drill; a twist drill leaves a 118° cone, so a flat blind
  bottom is an end mill and its diameter has to be a cutter size.

A part with a machined underside needs **two** setups, and `setupCount: 2` on
a plain plate is the right answer rather than a complaint — the top and the
bottom are not reachable from the same side. What matters is
`unreachableFaceCount`.

Read `manufacturable`. `false` is a refusal, and it **outranks** an unfinished
check: a residual that could not be measured cannot make a sharp internal
corner go away, so a blocking finding is reported as one even when something
else did not run. `true` is a pass on **the checks that ran**. **`null` means a
check did not run and nothing blocking was found** — an OCC offset that failed on
a hard shape is reported as a failure, not resolved in favour of a pass — and
`null` must be relayed as an unfinished check.

### The sheet

The part leaves the building as a **drawing**, not as a STEP file and a
conversation, and everything not dimensioned on it is a decision somebody else
makes on the shop floor. A drawing is also the easiest artefact in CAD to get
wrong while it still looks right, because the wrongness is internally
consistent: the sheet agrees with itself and disagrees with the part.

`freecad_draw` builds one and measures it. `{mode: "page"}`, then
`{mode: "view", source: ["body.x"], direction: "top"}`, then
`{mode: "dimension", refs: [...], dimType: "Distance"}` — where `refs` follows
the `fillet` rule exactly: a `query` result or a user pick, never an authored
edge index. **Every dimension is attached to the model in 3D and cross-checked
against what the model measures**, and `{mode: "check"}` re-audits the page.

Two things are **refused rather than reported**, which is unusual here and
deliberate — both survive a review that consists of looking at the tree:

- a **view that projected nothing**, which prints a title block around white
  space;
- a **dimension that disagrees with the model**, which is the one drawing error
  that survives everything, because the sheet is consistent and only wrong
  against the part.

Also read `projectionReferenced` (attached to the projected edge: reads short
on anything not parallel to the sheet, and migrates when the view regenerates),
`templateMissing`, `mixedScales` and `dimensionsUnchecked` — unchecked is not
correct.

**It will not tell you a drawing is complete.** Whether a part is fully
constrained by its dimensions is a judgement about design intent; counting
dimensions is not that judgement, so it reports the count and refuses the
verdict. GD&T feature control frames, datums, surface finish and tolerance
callouts are not created or checked at all — say so rather than implying the
sheet is ready to release.

### Motion

An assembly render shows **one pose**. The mechanism was designed for a range,
and every interesting failure lives at an angle nobody screenshotted. Do not
describe how a mechanism moves from a picture of it standing still.

`freecad_motion` drives a native Assembly (FreeCAD 1.0+) and watches:

- `{mode: "check"}` — what is grounded, what reaches ground through joints,
  and **mobility measured against a Kutzbach-Grübler count of the same joint
  list**. Two numbers from two methods; `mobility.mismatch` means redundant
  constraints, which the solver absorbs silently while the geometry is exactly
  aligned and which bind on the real machine as soon as it is not.
- `{mode: "joints"}` — what each joint is and which of its properties this
  build lets you drive. Nothing is guessed: driving the wrong property moves
  the mechanism somewhere real and reports success.
- `{mode: "sweep", joint: "Joint", from: 0, to: 90, steps: 24}` — every pose,
  checked for solve failure, for **lock** (the driving value changed and
  nothing moved — a toggle or a dead point, reported as success by the
  solver), for **branch flip** (the solver walked onto the linkage's other
  assembly configuration; every pose satisfies every constraint and the
  physical mechanism would have to come apart to get there, so the far side is
  not reachable travel), and for **self-interference**.
- `{mode: "torque", ...}` — the sweep plus the gravity torque needed to
  **hold** each pose, by virtual work over measured centres of mass.

Read `collides`, `branchFlip`, `sweepIncomplete` and `lockedNote` before
anything else, and treat `interference.checked: false` or
`interferenceIncomplete` as _nothing was looked at_ rather than as clear. A
collision narrower than one step is a collision this does not see, so sweep a
tight range finely rather than the whole range coarsely.

Two boundaries. The torque is **quasi-static and gravity only** — no inertia,
friction, bearing drag, spring, backlash or payload beyond the masses listed,
and it is refused outright if any moving part has no density, because a sum
that silently drops a link is smooth, plausible and wrong. And this **drives
an assembly; it does not author one.** A joint is made by clicking the two
features that mate — that is the human's job in the window they are already
looking at, and inventing which geometry it attaches to from this side is
exactly the kind of guess the rest of this file exists to prevent.

### Strength

`freecad_dfm` and `freecad_cam` answer whether the shape can be made. Neither
answers whether it survives its load, and that is the question you are most
likely to be asked and least able to answer by looking. **A sentence saying a
wall looks strong enough is worth nothing, and the user cannot tell it apart
from a number.** So either measure it or say it has not been measured.

**`freecad_fem` is a linear static solve through CalculiX**, in the same
envelope as every other write, and it is deliberately narrow: small
displacements, linear elastic material, everything bonded, one load case. No
contact, no plasticity, no buckling, no fatigue, no dynamics, no thermal. Every
one of those is a real way the part fails that this cannot see, so what comes
out is evidence, never a certificate — and never a substitute for whatever
standard the part is actually built to.

The sequence is `study` → `constrain` (at least twice) → `mesh` → `solve`:

- `freecad_fem({mode: "study", target: "body.bracket", material:
"aluminium-6061", id: "fea.bracket"})` builds the Analysis, its solver and its
  material. **Nothing here defaults a modulus.** A material not in the table
  needs `E` and `nu` explicitly, because every stress and every displacement
  in the result scales with them, and a modulus recalled from memory is exactly
  the kind of number this skill exists to stop being recalled from memory.
  `{mode: "materials"}` is the table and writes nothing.
- `freecad_fem({mode: "constrain", analysis: "fea.bracket", kind: "fixed",
refs: [...], id: "bc.bolted"})`, then again with `kind: "force"` and
  `magnitude` in newtons — or `kind: "pressure"` in **MPa, which is N/mm²**;
  convert bar and psi with `param` rather than in your head. `refs` follows the
  `fillet` rule exactly: a user pick or a `query` result, never an index you
  authored. **A load on a renumbered face solves perfectly cleanly**, and the
  reply reports what the constraint actually stored so you can check.
- `freecad_fem({mode: "mesh", analysis: "fea.bracket", elementSize: 2})`.
- `freecad_fem({mode: "solve", analysis: "fea.bracket"})`.

**Three things are refused before the solver runs**, because all three return a
plausible number rather than an error: a model with **no restraint** (a
floating body's rigid-body motion reads exactly like deflection), a model with
**no load** (zero stress everywhere is not a pass), and a mesh with **no volume
elements** (a surface mesh on a solid has no stiffness at all). Relay the
refusal; do not work around it.

Read the reply in this order:

- **`singularitySuspect`** first. The peak stress node's distance to the
  nearest sharp internal corner is measured, and if it is inside the band this
  mesh can resolve, the peak is a **singularity**: refine the mesh and it rises
  without bound, so it is a property of the mesh and not of the part. When that
  fires, no single `factorOfSafety` is reported on purpose. Quote
  `p99VonMisesMPa`, say the peak was discarded and why, and offer the fillet —
  which is what the part needed anyway.
- **`factorOfSafety`** — yield over peak, and `null` is a refusal with a reason
  attached rather than a missing value. It is null for a singular peak, and
  null for every material with no yield in the table: grey iron is brittle and
  does not yield, and a polymer's strength is rate- and temperature-dependent
  and creeps under a sustained load, so dividing by one number would be a
  number nobody should act on. Displacement is still worth reading there.
- **`converged`** — `null` until `{mode: "converge"}` has solved it a second
  time on a finer mesh and compared. One mesh is one number with no error bar,
  so `null` is an unfinished check and is reported as one, exactly like
  `manufacturable: null`. A peak that keeps climbing while the p99 settles is
  the signature of a corner singularity, not of a mesh that is too coarse.
- **`displacementImplausible`** — the deflection is more than a tenth of the
  part's own size, so the solve is outside its own small-displacement
  assumption. The usual cause is a missing restraint, not a bendy part.
- **`fem-stale`** in lint — the geometry changed after the solve, so the stress
  and any factor of safety quoted from it describe the old shape. It keeps
  reporting every turn until the analysis is re-solved or removed, the same way
  `split-stale` does.

Two practical things. **gmsh and CalculiX are separate programs**, not part of
FreeCAD's Python — an install carrying the FEM workbench menu very often has
neither, and the reply reports both under `binaries`. If they are absent, say
the solver is not available here rather than reporting the design as unchecked
for some other reason. And the solve **runs on the thread that owns the
document**: the human's window stops responding for the duration, which on a
fine mesh is minutes. Say so before starting one, and never put `fem` in a
batch.

**`freecad_cam` is the toolpath, and it is the proof `freecad_dfm` cannot
give.** `freecad_dfm` reasons about the shape; this asks the workbench to
generate the actual cuts:

- `freecad_cam({mode: "job", target: "body.plate", id: "cam.plate"})` builds a
  Job with stock.
- `freecad_cam({mode: "op", job: "cam.plate", op: "pocket", id: "camop.pocket"})`
  adds an operation. `base` takes refs the way `fillet` does — a user pick or a
  `query` result, never an index you authored.
- `freecad_cam({mode: "verify", job: "cam.plate"})` recomputes and reads every
  operation's path.

**An operation that generated zero path commands is the answer, not a
glitch.** It recomputes Up-to-date, reports no error, and shows nothing on
screen a render would catch — and it means the workbench could not machine that
feature with that tool. `emptyOperations` and `machinable: false` are the
fields; believe them over the state flags. `rapidsBelowClearance` is the other
one that matters: a lateral G0 under the clearance height is a rapid through
stock, and that G-code does not go to a machine.

Two things about running it. The CAM API's spelling **moves between builds** —
`Path.Op.Profile` was `PathScripts.PathProfile` before 1.0 — so the reply
reports the spelling it found under `api`, and if a module is absent, say the
workbench is not available here rather than reporting the design as unverified
for some other reason. And toolpath generation runs **inside the geometry
kernel**, which no deadline preempts: the human's window stops responding for
the duration. Say that before starting a long one, and never put `cam` in a
batch.

A job with no tool controller is refused rather than given an invented tool.
Every feed, radius and cycle time after a default tool would be a number about
a tool nobody chose — ask the human to add one in CAM → Tool Bit Library.

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
- `manufacturable` — `false` is a refusal, `true` is a pass on the checks that
  ran, `null` is a check that did not run. Never report `null` as a pass.
- `emptyOperations` / `machinable` — the CAM workbench could not generate a cut
  for those features. A clean recompute does not contradict this.
- `singularitySuspect` / `factorOfSafety` / `converged` — a peak stress on a
  sharp corner is mesh-dependent and is not a stress; a null factor of safety
  is a refusal with a reason; `converged: null` means solved once, so
  mesh-independence is unknown. None of the three is a pass.
- `fem-stale` — the geometry moved after the solve. Re-solve before repeating
  any number from it.
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
- **GD&T, datums, surface finish and tolerance callouts.** `freecad_draw`
  makes a dimensioned sheet and checks the dimensions against the model; it
  does not create or verify a feature control frame, a datum reference frame
  or a finish symbol, and a drawing without those is not a released drawing.
- **Material-removal simulation.** `freecad_cam` proves a toolpath exists and
  measures it; it does not sweep the tool through the stock and compare the
  result with the model. Leftover material between passes, a stepover that
  misses, and a finish pass that gouges are all invisible to it. The
  `freecad_dfm` residual is the geometric bound, not a simulation.
- **Work holding, fixtures and tolerance stacks.** The setup count is
  geometry; how the part is actually clamped, and what that costs in
  tolerance, is not modelled.
- **Post-processor correctness.** G-code comes out machine-specific and
  unverified. An operator checks it.
- **Speeds, feeds, cycle time and cost.** Not estimated, and a number invented
  for them would be worse than none.
- **Everything a linear static solve cannot see.** `freecad_fem` is one load
  case, small displacements, linear elastic, everything bonded. No contact, no
  preload, no plasticity, no buckling, no fatigue or endurance limit, no
  dynamics or modal analysis, no thermal, and no anisotropy — so a laminate, a
  printed part's layer adhesion and a welded or bolted joint are all outside
  it. It does not know your service load, your shock case or your safety
  factor policy, and it certifies nothing.
- **Dynamics.** `freecad_motion` has no time in it: no inertia, no contact, no
  friction, no impact, no compliance, no backlash, no control loop. It answers
  where a mechanism can go and what holds it there, not what happens when
  something hits it.
- **Threads as geometry**, and sheet metal.
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
