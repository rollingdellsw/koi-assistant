---
name: freecad-live
description: Turn-based human/AI co-design of a live FreeCAD document running natively on this machine. Reads the document every turn, edits it through a validated call whitelist inside a transaction envelope, measures the result rather than trusting it, and keeps user-picked face and edge references alive across recomputes. Purchased parts are interfaces bound by expression, not modelled solids. Pins the exact FreeCAD build the session is talking to.
runnable: true
# Left blank on purpose: the runnable dispatcher seeds parameters[0] into the
# session as a *user* message, so a default would read as if the human typed it.
parameters:
  - name: bridgeUrl
    description: >-
      Where koi_bridge.py is listening inside the running FreeCAD. Leave blank
      for the configured default (bridge-url below). Loopback unless FreeCAD is
      in a container with a published port.
    required: false
    default: ""
mcp-servers:
  - name: freecad_bridge
    script: mcp/freecad_mcp.js
    # Where the FreeCAD-side macro listens. Loopback: the bridge binds
    # 127.0.0.1 and nothing off this machine can reach it.
    bridge-url: http://127.0.0.1:8765
    bridge-token: "57c5d4c01a424d1fb891d20021987080"
    stream-url: https://192.168.68.113:3001
    # Optional. The page showing this FreeCAD's window — KasmVNC, Selkies,
    # any WebRTC/VNC front end. Nothing in the skill talks to it; it exists so
    # the human can see the model and take the mouse. Without it the session
    # still works and the human is blind.
    # stream-url: http://127.0.0.1:3000
    # Optional but not optional on a shared host: the bridge executes Python
    # with your privileges, and this is the only thing standing between it and
    # another local user. Start FreeCAD with KOI_BRIDGE_TOKEN set to the same
    # value.
    # bridge-token: ""

    # ===== K0: the pin =====================================================
    # Filled in by running the skill once and pasting the pinBlock it returns.
    # An unpinned session says so on every attach.
    #
    #   pin-version:     ExeVersion + suffix, e.g. "1.1.0dev". NOT sufficient
    #                    on its own — a whole development series carries one
    #                    version string, and a distro can ship two builds under
    #                    one release number.
    #   pin-commit:      BuildRevisionHash from the running FreeCAD. The strong
    #                    identifier when the build carries one. Prefix match.
    #   pin-fingerprint: size and mtime of the FreeCAD binary on disk, reported
    #                    by the bridge. The fallback identifier for a build
    #                    with no revision hash, and the only layer that answers
    #                    while the interpreter is busy. It moves under an
    #                    upgrade, a reinstall or a re-pulled container image —
    #                    which is the point.
    #   pin-mode:        off | warn | strict. strict refuses to attach to a
    #                    build that is not the pinned one.
    #
    # Armed against the build every probe result and every suite in scripts/
    # was measured on. The commit carries the weight: it is prefix-matched, so
    # an abbreviation from any layer still compares, and it is the one field
    # that does not stay constant across a development series the way the
    # version string does.
    #
    # !! These values are UNSET because the transport changed. Every number
    # !! below this line used to describe a wasm snapshot, and none of them
    # !! describe the FreeCAD on your machine. Nothing carries over: the kill
    # !! probes measured a different binary with a different OCCT and a
    # !! different set of workbenches. Run, in this order:
    # !!
    # !!     scripts/test_native.js          the transport's own claims
    # !!     scripts/test_build_contract.js  the platform assumptions
    # !!     scripts/test_probes.js          the behaviour they rest on
    # !!
    # !! then paste the pinBlock freecad_version() returns and set strict.
    # pin-version: ""
    # pin-commit: ""
    # pin-fingerprint: ""
    pin-version: "1.1.3"
    pin-commit: "145529fe741292ff0b3977a01195bf0247425794"
    pin-fingerprint: "exe:159624@1784962801"
    pin-mode: strict
    # Probe-stage escape hatch. freecad_exec and freecad_edit are arbitrary
    # code at `mutating` tier, which is what the freecad_call/freecad_script
    # split exists to prevent — so they are hidden from the LLM entirely unless
    # this is on. scripts/test_probes.js, test_koi_cad.js and test_koi_call.js
    # need them to set up conditions the envelope is meant to handle.
    # !! OFF for any LLM-facing session. The last live run had this ON, and
    # !! the runtime log shows the consequence: freecad_exec and freecad_edit
    # !! were injected into the model's tool set alongside freecad_call and
    # !! freecad_script, which is exactly the surface the call/script split
    # !! exists to keep away from it. Turn it on to run the suites in
    # !! scripts/, turn it off before handing the session to a model.
    probe-exec: off
allowed-tools:
  - freecad_config
  - freecad_probe
  - freecad_attach
  - freecad_version
  - freecad_sync
  - freecad_get
  - freecad_measure
  - freecad_resolve
  - freecad_export
  - freecad_call
  - freecad_script
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
---

# freecad-live — co-designing a live FreeCAD document

FreeCAD is running on this machine with `tools/koi_bridge.py` loaded, the bridge
is attached, and the document belongs to the human as much as to you. If a
stream is configured they are watching that FreeCAD's real window in a browser
tab and can take the mouse at any moment.

You are in the same process they are. That is the whole architecture: one
interpreter, one document, one undo stack, and both of you writing to it.

**What is here:** the build pin, the transaction envelope, the call
dispatcher, the fastener table and component catalog, the fingerprint
resolver, interference and clearance, lint, dry run, the BOM, and export.

**What is not, and must be said rather than improvised:** assembly constraints
and mates (parts are positioned, not mated), motion and interference through a
sweep, drawings and dimensioned output, threads as geometry, sheet metal, FEA,
and import of a supplier STEP file. If the user asks for one of those, say it
is not in this skill — a bolt you model as geometry is not a bolt, and a mate
you fake with a placement is not a mate.

`mate` is the placement, not the exception. It reads the axis and the seating
face off a hole and writes one Placement, which is the arithmetic six bolts
used to cost by hand; nothing is constrained afterwards, and moving the plate
leaves the bolt behind. Say that when you use it.

## The one thing K0 asserts

Every later claim this skill makes — that a reference survived a dimensional
change, that a hole carries a thread spec rather than cut geometry, that
Assembly is available — is a claim about **one build**. An install is not more
stable than a snapshot for being local: `apt upgrade`, a new AppImage or a
re-pulled container image all move it, without anybody deciding to change CAD
behaviour that day, and a version string moves later than the behaviour does.
A session that cannot name its build cannot honour those claims.

So: identify the build, compare it to the pin, and refuse when they disagree
and `pin-mode` is `strict`.

## Workflow

1. `freecad_config()` — reports the deployment and the current pin. Call it
   first when anything looks confused about _which_ FreeCAD is in play.
2. `freecad_attach()` — waits for the module and the interpreter, reads the
   build identity, checks the pin. Slow on a cold load; that is expected.
3. `freecad_version()` — the full picture from three independent layers:
   - `runtime` — read out of the live interpreter. Authoritative.
   - `deploy` — the FreeCAD install the bridge is inside. Answers while the
     interpreter is busy.
   - `transport` — the bridge itself: protocol, pid, GUI or headless.
     Pass `layers: ["deploy","transport"]` to answer "is FreeCAD even up?"
     without waiting for the interpreter.
4. `freecad_probe()` — diagnostics only: whether a bridge answers, which
   protocol it speaks, whether it has a GUI, and what is running on the thread.

**If `gui` is false there is no human in this session.** No selection to read,
no view to isolate or restore, nobody watching. The geometry rules all still
apply; the ones that say "ask the user to click it" have no way to be
satisfied, so say that rather than authoring the reference yourself.

## Getting a document

Every write needs one, and a FreeCAD the user just started has none — in which
case the first edit comes back `no-document`, and `freecad_sync()` reports
`document: null`.

- If the human already has a document open, work in it. It is theirs.
- Otherwise `freecad_call({fn: "new_document", args: {name: "Gearbox"}, id:
"doc.main"})`. It turns undo on before the first transaction and takes the
  sync baseline, so the first edit after it is not refused for being stale.
- It reuses a document of that name rather than opening a second one. Two
  documents holding the same design is a state nobody recovers from.

Their File > Save is a real save to a real file. `freecad_export` is a handover
or a checkpoint, not the only copy of the work.

## Working on the document

`freecad_sync()` opens every turn. It is not a formality: the human may have
moved, deleted or rejected something since your last reply, and answering from
the document as it was is how you overwrite their work. Read four things from
it before anything else:

- **`userDiff`** — what they changed. `revertedAiObjects` means they deleted
  something you made: a rejection, never silently re-created. `dofChanges`
  means a sketch came loose.
- **`selection`** — what they have clicked, fingerprinted. When they say "this
  one", this is what they mean; you do not have to guess and must not.
- **`health`** — errors, touched, underconstrained, at a glance.
- **`guiBusy`** — advisory here. The real gate is inside the edit, which fails
  closed. If it is set, answer in prose and wait.

`freecad_sync` says what exists; **`freecad_get({id})`** says what one thing
_is_ — full properties, state and shape metrics, for a koi id, an internal
name or a label. Pass `ids: [...]` to read several in one round trip. It is
`safe`, so use it instead of guessing from the tree.

Then edit:

- **`freecad_call({fn, args, id})` is the default.** It is validated before it
  reaches the page, it runs inside the transaction envelope, and it registers
  an id. Read `freecad_call`'s own description for the current call list.
- **`freecad_script({python})` is for what the whitelist genuinely does not
  cover** — loops, computation, a profile whose points come out of a formula,
  bulk edits. Same envelope. But an object a script creates gets no id unless
  the script registers it, and the reply names the ones it did not
  (`unregisteredObjects`): those are objects turn 7 cannot address and will
  have to rebuild rather than edit. So when a call exists, use the call — and
  when a script does create something real, register it:
  `koi.register(doc, "pad.base", obj)`.

**`batch` when the next few calls are already decided.** A datum, a sketch, a
pad, another sketch, a pocket and six fasteners is six to twelve tool calls,
each one an LLM turn, a dispatch, a transaction, a recompute and a diff — and
the user watching the stream sits through all of it. `freecad_call({fn:
"batch", args: {ops: [{fn, args, id}, ...]}})` runs them inside **one**
transaction: one confirmation, one undo entry, one diff. It is atomic, so a
step that fails rolls back the whole batch and names the step — there is never
half a bolt pattern to clean up.

Do not batch across a measurement. If step 2 depends on what step 1 measured —
which way a pocket flipped, what a query matched, whether the user's pick still
resolves — those are two turns, because nothing in a batch is read back until
it returns. Rule of thumb: batch what you would have written as one sentence to
a machinist, and stop where you would have had to look.

Rules that are not negotiable:

- **Give every created object an id** (`sk.plate`, `pad.base`, `bolt.mount`).
  The id is what lets turn 7 edit what turn 3 built. The dispatcher refuses a
  creating call without one.
- **`feature_edit` before building a replacement.** Rebuilding throws away the
  DAG, the downstream features and the user's own references.
- **Every loop carries a bound.** A script that does not return holds the
  thread that owns the document, and the human watches their window stop
  responding until it comes back. The process survives it and so does their
  work — but the deadline only preempts a runaway _Python_ loop, and nothing
  can interrupt the geometry kernel.
- **Dry-run a parametric change before committing to it** when anything
  downstream could break. `dryRun: true` applies, measures and rolls back, and
  the `report` it returns is the review packet: which objects moved, by how
  much, what broke. Show those numbers — "3 objects changed" is not a blast
  radius, and an engineer will not accept a change from an AI without one.

## Shaping material

`freecad_call`'s own description carries the full list and the current
arguments; this is how to choose between them.

- **Prismatic** — `sketch` then `pad` or `pocket`. `pocket` measures which way
  the material is and flips itself once if the cut removed nothing.
- **Round** — `sketch` then `revolve` (shafts, bosses, seats) or `groove`
  (bores, O-ring and retaining-ring grooves). `axis` is `V`, the sketch's own
  vertical axis, or `H`; the profile has to stay on one side of it. `groove`
  is measured the same way `pocket` is.
- **Repeats — of a whole part, or of a feature inside one.** This is one
  distinction with two ops, not two names for one thing, so it does not go
  away by merging them. `polar_array` (around an axis: three planets at 120°,
  six bolts on a circle) and `link_array` (a linear step) make **App::Link
  copies of a whole object** — cost is driven by _unique_ parts, so 120 bolts
  are one master and an array, never 120 solids. `pattern` repeats a
  **feature inside its own body**, fused into the solid: six holes in one
  plate, a row of slots, a ring of teeth. Links cannot be cut into a plate,
  and a hole is not a part. Each op refuses the other's target and names the
  one you wanted; `mirror` is the third case, a symmetric half.
- **Between bodies** — `boolean` with `op: cut | fuse | common`. PartDesign
  works inside one body; a housing minus its internals is a document-level
  boolean and this is the only way to ask for one. It reports a cut that
  removed nothing, a fuse that added nothing and an empty intersection rather
  than passing any of them off as success.
- **Hollowing** — `shell`, which needs `refs`: the faces to open. Same rule as
  `fillet`, and for the same reason — see references, below.
- **A through cut on a centre plane cuts both ways.** `pocket({through:
true})` from a sketch on a plane that runs through the material is made
  symmetric automatically, because a bore sketched on a centre plane means the
  whole bore, and a one-way through cut leaves the far half standing while
  recomputing perfectly clean. The result says when this happened;
  `midplane: false` cuts one way only.
- **Moving something** — `place`, with `at`, `rotate`, or both, and
  `relative: true` to add to where it already is. It refuses a PartDesign
  feature: those are positioned by their sketch's attachment, and a Placement
  written on one is discarded without an error.
- **`split_body` reports its halves by side, not by position in a list.** The
  reply carries `sides: {positive: {...}, negative: {...}}` with an id, volume
  and bbox each. `ids[0]` is the `+normal` half, but read `sides` rather than
  remembering that; `offset` and `gap` both take an expression.
- **Two parts out of one** — `split_body`. PartDesign refuses a feature whose
  result is more than one solid, and _"Result has multiple solids"_ is not a
  mistake you made: it is the workbench saying this is two parts. A clamp with
  a slit, a split housing, a stem and its faceplate are all this. Pass the
  plane (`XY`, `XZ`, `YZ` or a datum id), `offset`, `gap` for the width of the
  cut, and `ids: [a, b]`. Each half comes back as a PartDesign Body where the
  build allows it — `asBodies` says whether it did. The halves are snapshots:
  an upstream edit does not reach them, so split late. That is not left to one
  turn's reply either — once a split exists, lint measures the source against
  what it was when it was cut and reports `split-stale` every turn until the
  split is re-run. If you see it, re-run `split_body` before exporting
  anything; the halves are describing a shape the document no longer has.

Sketch primitives are `rect`, `circle` and `slot` (all fully constrained and
anchored), `line`, `arc`, and `polyline`. **`polyline` is the channel for a
computed profile** — an involute flank, a cam, an offset outline — which is
what `freecad_script` used to be needed for. Its points are joined but not
dimensioned, so pass `fix: true` to block them rather than leave the sketch
lint-warning every turn about degrees of freedom it was never going to lose.

- **`rect` takes `anchor: "center"`**, and for a mechanical part that is
  usually the one you want: `x, y` becomes the middle rather than the
  bottom-left corner. A body symmetric about a bore written corner-first is a
  negated half-dimension typed by hand once per rectangle, and nothing
  downstream can tell a correct one from one that is half a width out.
- **`slot`** is a rounded slot — `{type: "slot", x, y, length, width, angle}`,
  `length` tip to tip, `x, y` the centre. Reach for it instead of computing
  cap points into a `polyline`: a generated polyline carries no dimensions, so
  it can never be bound to a parameter and it warns about degrees of freedom
  forever.

`sketch` takes `on: "XY" | "XZ" | "YZ"` **or the id of a datum plane or a
captured user pick**, and reads the attachment back. Attaching at creation is
one call rather than two.

## Verifying

`freecad_measure` is `safe` — it costs the user nothing, so use it. A
screenshot cannot tell a plate with a hole from a plate without one, and
neither can the state flags: check the volume.

- `interference: true` gives the common volume of each pair of parts. Zero for
  parts that merely touch; anything above zero means they cannot both exist.
  Bounding boxes reject most pairs first, so this is cheap enough to run on
  every turn that moved something.
- `clearance: true` gives the minimum distance — service gaps, wrench access,
  whether a 2 mm gap is still 2 mm after the edit.
- `deepLint: true` adds the rules that walk face lists. They are out of the
  per-turn lint on purpose; ask for them when a boolean or an export starts
  behaving strangely.

**`volume` is exact; `bbox` is not.** On a curved face the bounding box is read
off the triangulation when the 3D view has drawn the shape, and an inscribed
mesh is smaller than the surface it approximates — a Ø12 cylinder measures
11.976 across. Whether it does depends on whether the window has rendered,
which is not a fact about the model. Half a percent on anything round: fine for
"does this fit through that", not a number to quote to a machinist and not a
number to assert an equality on. Check volume when it has to be right.

## Purchased parts

A bought component is not a solid you model. It is an **interface** (M5
clearance 5.5, head Ø8.5; bore Ø25 h6, OD Ø37 H7, width 7), an **envelope**,
and **metadata** (MPN, mass, purchased). Model the interface; the solid is
only how you look at it.

- `freecad_call({fn: "lookup"})` gives the fastener table, the catalog and
  the stock sizes. **Quote it rather than recalling it** — a clearance hole
  0.2 mm out does not assemble.
- `param` takes units: `45`, `"45 mm"`, `"1.5 in"`, `"12 deg"` all work, and
  the document's own units come back. Do not convert in your head in a skill
  whose argument is that conversions done in someone's head are where the
  0.2 mm comes from. The reply echoes what the sheet reads back **after** its
  recompute, so the value you see is the value features will bind to.
- `insert` brings in a fastener (`fastener: "M5", length: 16`), a catalog part
  (`catalog: "NEMA17_envelope"`), or an inline spec. It publishes the part's
  interface into the `koi_params` sheet.
- `hole` with `spec: {from: "bolt.mount.clearance"}` binds the diameter to
  that published value **by expression**. Do this instead of typing 5.5.
- **A feature dimension can be the expression itself, not only a sketch one.**
  `pad`/`pocket` `length`, `hole` `diameter` and `depth`, `fillet` `radius`,
  `chamfer` `size`, `shell` `thickness`, `revolve`/`groove` `angle`,
  `datum_plane` `offset` and the `primitive` dimensions all take a string:
  `pad({sketch: "sk.base", length: "koi_params.StackHeight"})` is one call.
  Do **not** pad with a literal and then `feature_edit` it parametric — that
  is two transactions, two undo entries, and a literal sitting in the document
  in between that nobody meant. The reply carries `dimension` with the binding
  and whether the document kept it; a quoted number (`"40"`) is still a
  number, not an expression.
- **A sketch dimension can be the expression itself.** Any `x`, `y`, `w`, `h`,
  `d` or `r` in a primitive takes a string instead of a number and binds to it:
  `{type: "circle", d: "koi_params.bore", x: "koi_params.pitch / 2"}`. A
  diameter is bound as a diameter — the halving onto the radius constraint
  happens here, not in your head. The reply lists every binding with the value
  it solved to and whether it took; if `bindingNote` comes back, one of them is
  a literal and will not follow the parameter, and that has to be said rather
  than reported as parametric.
- `swap` then changes the part and the plate follows on recompute. If a change
  request means "a bigger bolt", swap the bolt — do not edit the hole.
- `mate` seats an inserted part in a hole: `{target: "bolt.a", hole:
"hole.mount", near: [x, y, z]}`. It takes the axis and the seat from the
  hole's own profile sketch, so nothing here is a hand-computed position or a
  quaternion. `offset` lifts along the axis (a washer), `spin` turns about it,
  `flip` seats from the other side. A hole with six instances refuses until
  `near` says which one.
- **`hole` takes one spec, not three numbers.** `counterbore: true` alongside
  `spec: {clearance: "M5"}` (or `counterbore: "M5"`) takes `cbore_d` and
  `head_h` straight from the table, so the head sits flush without a second
  sketch. `threadSize` is matched against this build's own enumeration — `"M5"`
  finds `"M5x0.8"` — and a size it cannot match is **refused** rather than
  written, because `Threaded: true` over a rejected size silently drills the
  default: an M5 that became an M4 at Ø3.3 with nothing in the reply to show
  it. Threading also moves `Diameter` to the tap drill; quote the readback.
- **`fastener_pattern` seats every instance at once** — `{hole:
"hole.face_bolts", fastener: "M5", length: 16}` — and is what you want any
  time the answer is "a bolt in each of those". It reads all the seats out of
  the same profile sketch `mate` reads one from, so there is no `near` per
  bolt and no coordinate typed by hand at all. One master and N links, so the
  BOM reads it as one line of N. Reach for `mate` only when a single part goes
  in a single named hole.

Threads are a **specification**, never geometry. `threaded: true` writes the
thread spec; nothing here cuts a helix, and lint reports it if something does.

Dimensions come from stock: plate thicknesses and drill sizes are in the
library. A 7.3 mm plate cannot be bought and a 9.3 mm hole cannot be drilled,
so both are lint errors rather than matters of taste.

`freecad_call({fn: "bom"})` reads it all back out: the purchased parts with
MPN, quantity and mass, and the bodies that still have to be made. A pattern
is one line of N, not N lines. Quote it when the user asks what the design
weighs, costs or needs ordering — and if a line reports no mass, say so rather
than giving them a total that quietly omits it.

## References to faces and edges

`Face6` is an index, not a name. A recompute renumbers it, and the reference
you captured in turn 3 is the one that bites in turn 7.

- **Never invent one.** A face reference authored on this side is banned. If
  you need "that face", ask the user to click it, then capture it with
  `freecad_call({fn: "ref", args: {from: "selection"}, id: "pick.top"})`.
- **Re-validate every turn that changed geometry.** `freecad_resolve()` is
  `safe` and takes no arguments. `sync` already carries the report.
- **`rederived` means re-capture it.** The reference was found again from what
  generated it, and the name it returns is a raw index — accurate now, no more
  durable than any other index.
- **`broken` or `ambiguous` means stop and ask.** Guessing attaches the next
  feature to the wrong face, which is the failure this whole mechanism exists
  to prevent. Name the reference that broke and say what you need.
- **Prefer a datum plane to a picked face wherever one exists.** `datum_plane`
  makes one; `sketch` can attach to it directly through `on`, and `attach`
  moves an existing object onto it. A datum survives the recompute that
  renumbers `Face6`.
- `fillet`, `chamfer` and `shell` take element references and will not invent
  one, for exactly this reason: an edge or face chosen on this side is an index
  that renumbers under the next upstream edit. Ask the user to click it, or
  select geometrically with `query`.
- **On a model that is still moving, give `fillet`/`chamfer` a `query` instead
  of `refs`.** The same filter object `query` takes, passed straight to the op:
  `chamfer({body: "b", size: 2, query: {kind: "edge", direction: "+Z",
expect: "many"}})`. The filter is stored with the feature, so when a later
  parameter change renumbers the edges the envelope re-runs it and repairs the
  feature instead of aborting the whole write with
  `new-recompute-errors: chamfer_…`. That abort is expensive: it takes the
  thirteen-step geometry batch behind it with it, and the recovery is deleting
  the downstream features, deleting the chamfer, changing the parameter and
  rebuilding all of it. When it fires, the result carries `rehealed` — the
  edges were re-derived, not preserved, so check them before reporting.
- **A plural selection is not an ambiguous one.** Chamfering four corner edges
  is one intent that matches four edges. `query` returns a `refs` array ready
  to hand straight to `chamfer`, and `expect: "many"` (or a count) says the
  plural was deliberate so `ambiguous` stops firing on a correct selection.
  `{kind: "edge", surface: "circle", radius: 3}` is every hole rim of that
  size; `{kind: "edge", surface: "line", direction: "+Z"}` is the verticals.
  What is banned is choosing _by index_, not choosing more than one.

## Reading the result

- `applied` — is it still in the document. `ok` — was it correct. A dry run is
  `ok: true, applied: false`; reporting that as a failure would be wrong.
- `lint` — measured, not inferred. A pocket that removed nothing reports
  `Up-to-date` and `isValid()`, so if lint says `removed-nothing`, believe it
  over the state flags and over the screenshot.
- `undoEntries` / `singleUndo` — the undo cost, measured rather than promised.
  `singleUndo: false` means one Ctrl+Z will **not** put this back, and the user
  should hear that from you rather than discover it.
- `revertedAiObjects` from `ids` — the user deleted something you made. That is
  a rejection. Do not re-create it; ask.
- `refsBroken` / `refsNote` — the edit broke a reference the user picked. Say
  which one; do not silently pick a replacement.
- `non-stock` and `thread-engagement` in lint — the part is buildable in CAD
  and not in a workshop. Report them with the number to hit.

## Showing and saving

The scaffolding hides itself. A datum plane is created invisible (`visible:
true` if the user should see it), and a profile sketch and the datum it stands
on are hidden as soon as a `pad`, `pocket`, `hole`, `revolve` or `groove`
consumes them — the ops report what they hid. Only objects this session made
are ever hidden; the user's own datum stays where they put it. When a write
grows the model past the view, the camera re-fits itself and the result says so
under `viewFit`; `view_fit({auto: false})` stops that for a user who is driving
the camera, and `view_fit()` on its own re-centres now. The `span` it reports
covers the visible **model**: an `App::Origin` plane is infinite, measures
1e100 across, and is listed under `ignored` rather than averaged into a number
that always came back as 3.46e+100.

This is not cosmetic. The session this came from spent its second half with the
solid invisible behind six translucent datum planes, and the human — who could
only see the stream — reasonably concluded nothing was being built.

Origins stay out of the tree. Every body and part carries an `App::Origin` with
six datum features; they are never edited and never referenced, so they are
filtered out of `tree` rather than shipped seven-per-body in the payload that
opens every turn.

What is **not** touched is anything in the user's own FreeCAD settings. If
FreeCAD's notification toasts sit over the model in the stream, say so and let
them turn the notification area off in Preferences → General; silently
rewriting a preference to make a screenshot look better is a change to their
machine they did not ask for and would not see.

- `isolate` before a screenshot of anything internal — a pocket inside a
  housing is invisible until its surroundings are hidden — then **always**
  `view_restore`. The user did not ask for their model to disappear.
- `show({targets: [...], visible: false})` for the other case: hide the jig,
  show the faceplate and its bolts. It reports what actually changed and what
  was already that way, so a no-op does not read as success.
- **`already: true` is not "the user can see it", and neither is
  `Visibility`.** Both are facts about a _container_. After a `split_body` the
  solid lives in a `PartDesign::FeatureBase` inside the Body, and hiding that
  leaves `Body.Visibility` reading `true` over an empty viewport. `isolate` and
  `show` return `{label, volume, bbox, drawn, hiddenBy}` per target and a
  `notDrawn` list. **Read `drawn`.** If anything is in `notDrawn`, say so
  instead of describing what the model looks like — a session once narrated a
  framed assembly at six bolts on a grey background for several turns, and the
  screenshot was the first thing that disagreed.
- `isolate` keeps the solid and its instances, **including the FeatureBase**,
  and drops origin planes. Do not hide a `_base` object as a duplicate: it is
  the shape.
- **Labels are `feature_edit`**, not a special call:
  `feature_edit({target: "bar.a", props: {Label: "Faceplate"}})` — `props`
  reaches any property the object has, `Visibility` included. Several of those
  in one `batch` is one round trip, and that is what to reach for instead of a
  Python loop over a handful of objects.
- `freecad_measure({partsOnly: true})` for verification a human is going to
  read. The default measures every object with a shape — origins with infinite
  boxes, every sketch, every intermediate pocket — and then truncates before it
  reaches the parts that were the question. `partsOnly` is bodies and purchased
  components, minus the hidden solid a split was cut from and the hidden master
  a pattern's links point at, which otherwise fill the interference hits with
  parts overlapping their own copies.
- `view_set` for the camera, two views minimum for anything three-dimensional,
  and budget about two screenshots a turn. Pixels are for the human's sanity
  check; use `freecad_measure` for your own.
- `freecad_export` writes FCStd, STEP, BREP or STL to the user's filesystem and
  reports the path. Use it to hand geometry to a manufacturer or another CAD,
  and as a checkpoint before a risky edit — but it is no longer the only thing
  standing between the user and losing their work, and saying so would be
  scaremongering. Saving is still theirs to do: File > Save, or this.

## The ceiling

Cost is driven by _unique_ parts, not instances: 120 bolts are one master and a
`link_array` or a `polar_array`. The binding limit is the single-threaded
recompute, and it is now the only one: there is no 4 GB address space and no tab
to run out of memory.

**Where that ceiling actually sits is not currently known, and this section does
not pretend otherwise.** The numbers it used to carry — a subassembly's worth of
parts, a heavy boolean eating the whole interaction budget — were measured on
the wasm build and do not survive the move: the same probe now walks 40 objects
in single-digit milliseconds and finishes the heavy boolean in about a fifth of
a second. Those measurements are also too small to mean anything. Forty objects
is far below the knee of any curve this could have, so they establish only that
nothing is already broken.

Until `test_probes.js` has been run at a realistic size (~400 objects) on the
slowest machine the skill is expected to run on, treat the ceiling as unmeasured
and say so rather than quoting a limit. What still holds without a number: a
recompute that takes minutes is a recompute the human sits through, watching a
window that does not respond. Notice when the model is heading that way, and
say it before they find out.

## Reporting to the user

`freecad_attach()` returns a one-line `status` — _Connected to FreeCAD 1.1.3
(GUI), build 4c8a2f1b90, unpinned._ Open with that line and then ask what they
want to build. Do not open a design session by pasting configuration at
somebody who has not spoken yet.

When the build is unpinned, attach says so in one clause and hands back
`pinHint`; the YAML itself comes from `freecad_version()` as `pinBlock`. Show
the block when the user is setting the skill up or asks for it, and tell them
to paste it into `SKILL.md` — the skill cannot write its own frontmatter, and
an observed version that never becomes a pin is a note, not a gate. Mid-design
is not that moment.

When `pin.drift` is non-empty, name the fields that moved and say what it
implies: the kill probes were run against a different build, so their results
do not carry over. Do not soften this into a suggestion.

If `freecad_attach` reports a protocol mismatch, that is a version skew between
the two halves of the bridge, not a user error: `tools/koi_bridge.py` and
`mcp/freecad_mcp.js` ship together. Tell them to copy the macro out of this
version of the skill and reload it.

If it reports that the bridge is up but the interpreter never answered, FreeCAD
is alive and busy — a long recompute, or a modal waiting for a click. Say which
it looks like and wait; do not tell them to restart anything.

## What not to do

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
  picked yourself — user picks are re-validated every turn, AI-authored ones are
  banned.
