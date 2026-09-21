---
name: blender-live
version: 3.0.0
description: >-
  Turn-based human/AI co-editing of a live, browser-streamed Blender session.
  Redirects to the upstream blender-mcp server (ahujasid/blender-mcp), spawned
  by the Koi Gateway inside the Blender container; nothing here forks it. Adds what a shared session
  needs and a desktop MCP client cannot give: a scene digest read at turn open
  so the human can take the mouse mid-session, an undo checkpoint around every
  edit so one Ctrl+Z reverses one agent step, and measurement instead of
  eyeballing a viewport. Nothing is enforced: the container is the security
  boundary, so there are no blocks, no budgets and no safe mode — only a scene
  digest, a set of reminders, and a translator for the one error string this
  bridge returns for five different reasons.
runnable: true
parameters:
  - name: streamUrl
    description: Tab the human is watching Blender in.
    default: "https://localhost:3001"

mcp-servers:
  - name: blender
    type: remote
    gateway: default
    server: blender

guardrails: scripts/guardrail.js

prerequisites:
  - "The `koi-blender` container is Up (`podman ps --filter name=koi-blender`)."
  - "The stream tab is open and shows the Blender desktop (https://localhost:3001)."
  - "The MCP for Blender panel reports a connection (N panel in the 3D viewport). The container's startup script does this automatically; the panel is where you confirm it."
  - "The Koi Gateway has a `blender` server registered in gateway-config.json, and was restarted after the container came up."
  - "Save your .blend under /workspace first. The agent runs Python in your session, and nothing outside /workspace survives the container being recreated."

reminders:
  - id: "blender-live:turn-open"
    description: Read the scene before acting on anything the human may have changed.
    trigger:
      type: "user_message"
      pattern: "."
    content: |
      Blender turn protocol: run the MINIMAL scene digest (SKILL.md → "The
      digest") at the start of a session, before resolving a deictic reference
      ("this one", "that edge", "the one I just moved"), and whenever the human
      says they changed something. It reports selection and active object, which
      is the only way to know what "this" means. For a self-contained sequence
      you already have a current digest for, proceed without re-reading.
    strategy: "persistent"
    priority: "medium"

  - id: "blender-live:fragile-bridge"
    description: What this bridge cannot survive, and what to do instead.
    trigger:
      type: "tool_call"
      toolName: "execute_blender_code"
    content: |
      Your code runs from the addon's timer callback on Blender's MAIN THREAD —
      the same thread that answers this socket. Anything that holds it kills the
      call, and on this build that threshold is low. So:
      * No Python loop over mesh data (vertices, edges, polygons). Read counts
        and bounding boxes, or use foreach_get into a buffer. A per-vertex loop
        is the single most reliable way to sever this connection.
      * No bpy.ops.render.render() straight down the socket. It blocks, the call
        never returns, and the render succeeds anyway. Schedule it from
        bpy.app.timers with 'INVOKE_DEFAULT' and check for the file afterwards.
      * No time.sleep(). It freezes the viewport, the stream and the socket at
        once. Return and poll in a second call instead.
      * Small batches beat one long call, always.
      Context: there is no 3D viewport and no active object in that callback.
      Prefer bpy.data / bpy.types; when an operator is unavoidable, wrap it in
      bpy.context.temp_override(...). "context is incorrect", a poll() error or
      an AttributeError on bpy.context.<area> is this, not your logic — rewrite
      it rather than retrying the identical snippet. An override naming
      screen.areas[0] is the common wrong one; SKILL.md -> "Operators that need
      a 3D viewport" has the one that holds.
      Wrap EVERY snippet in try/except and print
      json.dumps({"ok": ..., ...}, default=str). An uncaught exception is not
      returned here — it severs the socket and arrives looking identical to a
      crash, and bpy.app.build_hash and friends are bytes, so an unguarded
      json.dumps raises TypeError on the most ordinary read there is. See
      SKILL.md -> "The error envelope".
      Finally: end an edit batch with bpy.ops.ed.undo_push(message="koi: ...")
      so one Ctrl+Z reverses one agent step, and stamp what you create with
      obj["koi_origin"] = "agent". Nothing enforces either any more.
    strategy: "persistent"
    priority: "high"

  - id: "blender-live:verify-visually"
    description: get_viewport_screenshot works; use it, keep it small, still measure.
    trigger:
      type: "user_message"
      pattern: "."
    content: |
      get_viewport_screenshot works. Call it when a look at the viewport would
      tell you something a number would not — composition, framing, whether a
      modifier did what you meant.
      Pass max_size explicitly and keep it modest (400-800). The image crosses
      the gateway as one frame orders of magnitude larger than anything else on
      that socket, so it is not free even though it works.
      The human's Ctrl-drag on the stream tab is still the better tool for "this
      edge here": a capture they made can point at something, one you requested
      cannot. Do not reach for a generic browser screenshot tool as a
      substitute — it captures whatever window has OS focus, which is usually
      not the stream.
      For anything dimensional a picture was never the answer anyway: read
      obj.dimensions, obj.bound_box, obj.matrix_world, a bmesh area/volume, or
      bpy_extras.object_utils.world_to_camera_view for framing, and report the
      number you read rather than the number you intended.
    strategy: "persistent"
    priority: "high"

  - id: "blender-live:say-it-broke"
    description: Report a stalled toolchain instead of navigating around it.
    trigger:
      type: "tool_result"
      toolName: ".*"
      # JS regex, case-sensitive: no (?i). Also matches the guardrail's rewrites,
      # since this is evaluated on the overridden result.
      outputPattern: "([Cc]onnection (was )?(closed|refused|reset|lost|severed)|[Cc]ould not connect to [Bb]lender|Errno 111|ConnectionRefusedError|Nothing is listening|Koi's transport)"
    content: |
      A call in the official toolchain just failed. Tell the human, in the reply
      you are about to write, which tool failed and what you are doing instead.
      Do not silently substitute a workaround and present the result as though
      the normal path worked — a session that quietly routes around a broken
      bridge produces a scene that looks right and a report that is not true,
      and it costs them the bug report.
      A result carrying "ok": false is NOT this — that is your own snippet
      raising, with the traceback in the result. Fix the code; do not report a
      broken bridge.
      If the text says the connection closed after a render, that is expected on
      this build and is not worth alarm — say so and move on. If it names the
      Koi Gateway or says an MCP server is not running, that is the transport
      between Koi and the container, NOT Blender: the scene is fine and the fix
      is on the host, not in your code. Otherwise: re-read the minimal digest
      before assuming anything about the scene, and if that severs too, stop and
      say the bridge is down rather than working around it.
    strategy: "persistent"
    priority: "high"

  - id: "blender-live:workspace-only"
    description: Only /workspace is a real directory on their machine.
    trigger:
      type: "user_message"
      pattern: "."
    content: |
      Every save, export, bake and render output goes under /workspace/. An
      absolute path anywhere else succeeds, reports success, and is gone when
      the container is next recreated — nothing blocks it any more. Quote the
      host path back to them (~/blender-stream/workspace/...), not the container
      path, so they can check you wrote somewhere real.
    strategy: "persistent"
    priority: "medium"
---

## Where you are

You are editing a live Blender session the human is watching in a browser tab at
`https://localhost:3001`. Four facts change how you act:

- **Your Python runs on Blender's main thread**, from the addon's
  `bpy.app.timers` callback — the same thread that answers this socket. Hold it
  and you kill your own call. There is no 3D viewport and no active object in
  that callback, so prefer `bpy.data` / `bpy.types`, and wrap an unavoidable
  operator in `bpy.context.temp_override(...)`.
- **You and the human share one process, one document and one undo stack.** They
  can take the mouse at any moment and nothing tells you when they did.
- **Blender runs inside a container.** `/workspace` is the only path there that
  is a real directory on their machine; anything you write elsewhere reports
  success and is gone when the container is recreated. Quote paths back to them
  as `~/blender-stream/workspace/...`.
- **Asset providers** (Poly Haven, Sketchfab, Poly Pizza, Hyper3D, Hunyuan3D)
  are per-checkbox in the addon's N panel and off unless the human ticked them.
  A `*_status` tool reporting one disabled is their decision — report it, do not
  route around it.
- **The build is Blender 5.2.x LTS** in the pinned image (4.5.0 LTS has also
  been exercised), CPU rendering by default. The digest reports `blender` and
  `build` every turn, so read them rather than assuming. When a property name
  you remember is missing, ask the build instead of guessing at a rename:
  `[p.identifier for p in mod.bl_rna.properties if "clamp" in p.identifier]`.
  Most such misses are a pre-2.8 name in your memory, not a 5.x change —
  `use_clamp_overlap` has carried that name for many releases.

## The turn protocol

The human can take the mouse at any moment, and nothing tells you when they did.
So: **read before you write.**

### The digest

Open the session, and every turn after it, by sending this digest through
`execute_blender_code`. Upstream captures stdout, so the JSON comes back in the
tool result, prefixed with `Code executed successfully: `. Parse from the first
`{`, then check `ok` before touching `data` — the wrapper below is the reason a
Python error reaches you as JSON instead of as a severed socket.

`scripts/connect.js` does this same read plus a five-layer preflight — gateway,
server registration, container, blender-mcp, the addon's socket — and names
which layer is broken instead of leaving you to infer it. **In this build it is
the human's to run**, from the Skills UI or with `/skill
blender-live/scripts/connect.js --full-auto` in the input box. `runBrowserScript`
has not been registered as a tool in any session so far, so do not go hunting
for it; if you do have it, `runBrowserScript({ script_path:
"blender-live:scripts/connect.js" })` is the better opening move and stands in
for the digest that turn. When the preflight has not run, say so once in your
first reply rather than letting the human assume the chain was checked.

**Keep it minimal.** Earlier versions of this file shipped a digest that hashed
every vertex of every mesh. It severed the socket, reproducibly, because the
loop ran on Blender's main thread — see "What is broken on this build". Object
properties are cheap C reads; mesh data is not. This one touches no mesh data at
all:

```python
import bpy, json, traceback

def _digest():
    vl = bpy.context.view_layer
    bh = bpy.app.build_hash            # bytes, not str — see below
    names = sorted(bpy.data.objects.keys())
    out = {
        "blender": bpy.app.version_string,
        "build": bh.decode("utf-8", "replace") if isinstance(bh, bytes) else str(bh),
        "file": bpy.data.filepath or "(unsaved)",
        "frame": bpy.context.scene.frame_current,
        "engine": bpy.context.scene.render.engine,
        "mode": bpy.context.mode,
        "active": vl.objects.active.name if vl.objects.active else None,
        "selected": sorted(o.name for o in bpy.context.selected_objects),
        "count": len(names),
        "truncated": len(names) > 200,
        "objects": [],
    }
    for name in names[:200]:
        o = bpy.data.objects[name]
        out["objects"].append({
            "name": name, "type": o.type,
            "parent": o.parent.name if o.parent else None,
            "loc": [round(v, 4) for v in o.location],
            "rot": [round(v, 4) for v in o.rotation_euler],
            "scale": [round(v, 4) for v in o.scale],
            "dim": [round(v, 4) for v in o.dimensions],
            "mods": [m.type for m in o.modifiers],
            "coll": [c.name for c in o.users_collection],
            "koi": o.get("koi_origin"),
        })
    return out

try:
    print(json.dumps({"ok": True, "data": _digest()}, default=str))
except Exception:
    print(json.dumps({"ok": False, "error": traceback.format_exc()[-1500:]}))
```

### The error envelope

Every snippet you send goes inside that `try` / `except` and every `json.dumps`
carries `default=str`, and any import beyond `bpy`, `json`, `traceback`, `os`,
`math`, `mathutils`, `bmesh` goes _inside_ the `try` — a missing module raises
before the `except` exists. This is not style. Two things on this build make an
unwrapped snippet actively dangerous to your own understanding of the session:

**An uncaught Python exception severs the socket instead of coming back.**
Upstream drops the connection rather than returning the traceback, so a typo, a
`KeyError` and a C-level crash are the same four words in your tool result. The
`except` turns the first two into a readable string on stdout, which upstream
_does_ capture. `{"ok": false}` in a result means the snippet ran and raised —
read `error`, fix, re-send. It is not a bridge problem and retrying unchanged
will not help.

**`json.dumps` cannot serialize half of `bpy.app`.** `bpy.app.build_hash`,
`build_branch`, `build_date`, `build_time` and `build_platform` are all `bytes`,
not `str`. `json.dumps` raises `TypeError: Object of type bytes is not JSON
serializable` on them — which, unwrapped, arrives as `Connection closed` and
looks exactly like a crashed bridge. The digest above decodes `build_hash`
explicitly because it is pinned against in `connect.js`; `default=str` catches
everything else, including `Vector`, `Matrix`, `IDPropertyGroup` and enum
wrappers, which is most of what you will reach for next.

Tool arguments: `execute_blender_code` takes `code` **and** `user_prompt`;
`get_scene_info` takes `user_prompt`; `get_object_info` takes `object_name`.
Read the registered schema if a call is rejected — an earlier version of this
file claimed `execute_blender_code` took only `code`, which was wrong, and two
sessions ran into it before it was corrected here.

`user_prompt` feeds upstream's trajectory capture, and its schema asks for the
human's **own words, verbatim** — not your paraphrase and not your sub-goal —
repeated unchanged across every call of a multi-step task, so the whole sequence
links back to one intent. Quote the goal they stated, not the whole turn: one
line, reused verbatim for the rest of the sequence, is what "one intent" means
here — a transcript pasted onto every property check is not. Where there is no
human message to quote yet, a preflight or a poll, say what the call is for and
keep it short. This is the one field here that is not about the scene, which is
the thing worth knowing about it: telemetry is disabled through the gateway's
env block, so those words stay on this machine. If anyone re-enables it,
`user_prompt` is what leaves.

If you need topology — to tell a vertex edit from a move — ask for it on the one
object you care about, not on the whole scene. Element counts are C-side property
reads and are safe:

```python
import bpy, json
me = bpy.data.objects["Lid"].data
print(json.dumps({"ok": True, "data": {"v": len(me.vertices),
                  "e": len(me.edges), "f": len(me.polygons)}}, default=str))
```

A content hash is possible with `foreach_get`, which fills the whole coordinate
buffer in one C call rather than looping in Python — but treat it as opt-in, run
it on one object, and be ready for it to sever anyway on a large mesh:

```python
import bpy, json, hashlib, array
me = bpy.data.objects["Lid"].data
n = len(me.vertices)
co = array.array("f", bytes(12 * n))
me.vertices.foreach_get("co", co)
print(json.dumps({"v": n, "hash": hashlib.blake2b(co.tobytes(), digest_size=6).hexdigest()}))
```

Keep the previous digest and diff it yourself. A changed `loc`/`dim` is a move;
a name present last turn and absent now is a deletion; a changed element count
on an object you probed is a topology edit. Report what the human changed in your
own words before you build on top of it — silently rebuilding over their edit is
the failure this whole protocol exists to prevent.

`koi_origin` is how you know whose work something is. Nothing enforces it, so:
**do not delete or destructively modify an object without `koi_origin ==
"agent"` unless the human named it in this turn.**

### The edit envelope

```python
# ... your edits, data API where possible ...
obj["koi_origin"] = "agent"                       # on anything you create
bpy.ops.ed.undo_push(message="koi: bevel the lid")  # last line, always
```

Blender's undo is operator-based. Direct `bpy.data` mutation pushes nothing, so
without the explicit push the human's Ctrl+Z jumps over your whole batch or
lands somewhere surprising. One push per logical step, not per statement.

### Operators that need a 3D viewport

`bpy.data` first, always. When an operator is the only way — `view3d.view_all`,
`object.convert`, anything under `bpy.ops.view3d.*` — it needs a context the
timer callback does not have, and the override has to name the **3D view**
specifically. `win.screen.areas[0]` is whatever editor happens to be first in
the human's layout, usually the Outliner or Properties. `render.render`
tolerates that; `view3d.*` fails `poll()` on it, which is the "context is
incorrect" nobody can debug by rereading their own logic.

This returns the smallest override a VIEW_3D operator accepts. Deliberately no
`contextlib`: a `from contextlib import ...` above the `try:` is an import the
error envelope does not cover, and it raises before the `except` exists.

```python
import bpy, json, traceback

def _view3d():
    """kwargs for temp_override that a bpy.ops.view3d.* operator will accept."""
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type != "VIEW_3D":
                continue
            region = next((r for r in area.regions if r.type == "WINDOW"), None)
            if region is None:
                continue                      # area exists but is not drawn yet
            return {"window": win, "screen": win.screen, "area": area,
                    "region": region, "space_data": area.spaces.active}
    raise RuntimeError(
        "no drawable VIEW_3D area in the streamed session — the human has that "
        "editor closed, or is in a workspace without one. Ask them rather than "
        "guessing; do it through bpy.data if you can."
    )

try:
    with bpy.context.temp_override(**_view3d()):
        bpy.ops.view3d.view_all(center=False)
    print(json.dumps({"ok": True, "data": {"framed": True}}, default=str))
except Exception:
    print(json.dumps({"ok": False, "error": traceback.format_exc()[-1500:]}))
```

`region` and `space_data` are not optional padding. Operators that read the view
matrix (`view_all`, `view_selected`, `view_axis`) poll on the region, and
`space_data` is what `clip_start` / `clip_end` and shading live on.

**That viewport is the human's.** `view_all`, a shading change and a clip-plane
edit all move what they are looking at, and `undo_push` does not cover view
state — Ctrl+Z will not give them their framing back. Prefer measuring
(`world_to_camera_view`) or the scene camera over reframing their view; when you
do reframe it, say so in the same turn.

A millimetre-scale model is the case where you will want it anyway: the default
view is framed for the 2 m startup cube, so a 100 mm part opens as a dot or
disappears behind the near clip plane entirely, and the screenshot comes back
cropped, black or flat grey. Clip planes are in **metres** whatever
`unit_settings` displays, so they do not follow a `scale_length` change. Paste
this under `_view3d()`:

```python
def _frame(names=None, span=None):
    """Fit the 3D view to `names` (or everything) and size the clip planes."""
    ov = _view3d()
    space = ov["space_data"]
    if span is None:                       # metres, largest thing in the scene
        span = max((max(o.dimensions) for o in bpy.data.objects
                    if o.type == "MESH"), default=1.0) or 1.0
    space.clip_start = max(span / 1000.0, 1e-6)
    space.clip_end = max(span * 1000.0, 10.0)
    cam = bpy.context.scene.camera
    if cam is not None and cam.type == "CAMERA":
        cam.data.clip_start, cam.data.clip_end = space.clip_start, space.clip_end

    vl = bpy.context.view_layer
    # Their selection is how you resolve "this one" next turn — borrow it, do
    # not spend it.
    was = [o for o in vl.objects if o.select_get()]
    active = vl.objects.active
    try:
        with bpy.context.temp_override(**ov):
            if names:
                for o in vl.objects:
                    o.select_set(o.name in names)
                bpy.ops.view3d.view_selected()
            else:
                bpy.ops.view3d.view_all(center=False)
    finally:
        for o in vl.objects:
            o.select_set(o in was)
        vl.objects.active = active
    return {"clip": [space.clip_start, space.clip_end],
            "framed": list(names) if names else "all"}

try:
    print(json.dumps({"ok": True, "data": _frame(["PhoneStand"])}, default=str))
except Exception:
    print(json.dumps({"ok": False, "error": traceback.format_exc()[-1500:]}))
```

Call it before `get_viewport_screenshot`, not after a disappointing one, and
tell the human you moved their view.

`_frame()` moves the **viewport**. It does not touch the camera or the lights,
and the startup file parks them for the 2 m cube: camera near (7.4, −6.9, 5.0)
m, light near (4.1, 1.0, 5.9) m. Against a 100 mm part that is a speck in an
unlit void, so a camera render looks broken when the model is fine. If the human
asks for a render rather than a screenshot, move the camera and the key light to
a multiple of the object's `bound_box` diagonal first, and remember which call
blocks — see "What is broken on this build".

### Placing things on a slope

Euler angles are where a correct model goes wrong silently. Every dimension can
check out while a part is rotated +30° instead of −30° and leans through the
thing it was meant to rest against; the numbers you thought to verify do not
cover a sign you did not think to doubt. A screenshot catches it, which is one
of the things screenshots are for — but not constructing the angle by hand is
better.

Build the basis from the surface instead:

```python
import bpy, json, traceback
from mathutils import Matrix, Vector

def _seat(name, face_normal, point, up=Vector((0.0, 0.0, 1.0))):
    """Seat an object on a plane: local +Y up the slope, local +Z off the face."""
    n = Vector(face_normal).normalized()          # out of the incline
    t = (Vector(up) - n * Vector(up).dot(n))      # world up, projected onto it
    if t.length < 1e-6:                           # the face is horizontal
        t = Vector((0.0, 1.0, 0.0))
    t.normalize()
    x = t.cross(n).normalized()
    basis = Matrix((x, t, n)).transposed().to_4x4()   # columns are the axes
    if round(basis.to_3x3().determinant(), 6) != 1.0:
        raise RuntimeError("basis is not right-handed — check the normal")
    obj = bpy.data.objects[name]
    _, _, scale = obj.matrix_world.decompose()
    obj.matrix_world = (Matrix.Translation(Vector(point)) @ basis
                        @ Matrix.Diagonal(scale).to_4x4())
    return {"matrix": [list(r) for r in obj.matrix_world],
            "euler_deg": [round(a * 57.29577951308232, 3)
                          for a in obj.matrix_world.to_euler()]}

try:
    print(json.dumps({"ok": True, "data": _seat(
        "Phone", (0.0, -0.8660254, 0.5), (0.0, 0.0, 0.012))}, default=str))
except Exception:
    print(json.dumps({"ok": False, "error": traceback.format_exc()[-1500:]}))
```

The determinant check is the point: a mirrored basis is the other way this fails,
and it produces geometry that looks right in one view and inside-out in another.
Report `euler_deg` back to the human — it is the number they will compare
against the angle they asked for, and it is derived here rather than entered.

### When the connection is severed

`Connection closed` is the most common thing this bridge says, and it means at
least five different things. In rough order of how often you will see it:

| After                                   | What it means                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| a synchronous `render.render()`         | the render is running and will succeed; the call cannot return                                                         |
| a snippet that loops over mesh data     | you held the main thread; shorten the snippet                                                                          |
| an UNWRAPPED snippet, on its first call | a plain Python exception, dropped instead of returned — re-send it inside the error envelope before blaming the bridge |
| a poll issued during a render           | the render still holds the main thread; wait, poll again                                                               |
| the first call of a session             | upstream's cached socket went stale; retry once                                                                        |
| anything else, repeatedly               | a dropped Python exception, or a C-level crash                                                                         |
| a result naming the Koi Gateway         | not Blender at all — the transport died between Koi and the container; say so and leave the scene alone                |

The guardrail annotates the first two, because they are not failures and reacting
to them as though they were is how a session ends up rebuilding things that were
fine. For the rest: **a batch that dies partway through never reached its
`undo_push` line**, so whatever landed is in the file with no checkpoint behind
it. Re-read the minimal digest before doing anything else — the object you were
building may exist, half-exist, or be missing, and only the scene knows which.

Two habits. Save to `/workspace/` early rather than at the end of a long session,
so a crash costs one step instead of all of them. And **say it broke.** If the
official toolchain stalls, tell the human in that turn which call failed and what
you did instead. Substituting a workaround and reporting the result as though the
normal path worked costs them the bug report, which on a bridge this fragile is
the most valuable thing a session produces.

### Verify

`get_viewport_screenshot` **works.** Call it when looking at the viewport would
tell you something a number would not: composition, framing, whether a modifier
did what you meant, whether the thing you built is where you think it is.

Pass `max_size` explicitly, 400–800. The image crosses the Koi Gateway as a
single frame two orders of magnitude larger than anything else on that socket.
It is not free, and a 400px view answers most questions.

The human's `Ctrl`-drag on the stream tab is still the better tool for "this
edge here": a capture they made can point at something, and one you requested
cannot. Do not substitute a generic browser screenshot tool — it captures
whatever window holds OS focus, which is reliably not the stream tab.

A picture is never the answer to a dimensional question. Read
`dimensions`, `bound_box`, world-space matrices, or a bmesh area/volume, and say
the number you read rather than the number you intended.

Framing is measurable too. `bpy_extras` is importable, and it is already correct
about lens shift, sensor fit and clipping:

```python
import bpy, mathutils
from bpy_extras.object_utils import world_to_camera_view
sc, cam = bpy.context.scene, bpy.context.scene.camera
obj = bpy.data.objects["Cube"]
uv = [world_to_camera_view(sc, cam, obj.matrix_world @ mathutils.Vector(c))
      for c in obj.bound_box]
xs = [p.x for p in uv]; ys = [p.y for p in uv]
# in frame iff every x and y is within 0..1; margins are min(xs), 1 - max(xs),
# min(ys), 1 - max(ys), as fractions of the frame.
```

That turns "about 15% headroom" from something you squint at into a number you
report.

So is mass. Volume, centre of mass and a tipping margin are the numbers a
mechanical task actually turns on, and none of them is visible in a screenshot.
`bmesh` gives you the first in one C call; the centre of mass needs a loop over
faces, which is the one place this file sanctions a Python loop over mesh data —
on **one** object, on the evaluated mesh, under an explicit face cap. Raise the
cap only deliberately, and decimate rather than raising it far.

```python
import bpy, bmesh, json, traceback
from mathutils import Vector

def _mass_props(name, cap=40000, density=None):
    dg = bpy.context.evaluated_depsgraph_get()
    obj = bpy.data.objects[name].evaluated_get(dg)   # modifiers applied
    me = obj.to_mesh()
    bm = bmesh.new()
    try:
        bm.from_mesh(me)
        bm.transform(obj.matrix_world)               # world space, post-scale
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        if len(bm.faces) > cap:
            raise RuntimeError(
                "%d faces > cap %d — this loop holds Blender's main thread; "
                "decimate or raise the cap knowingly" % (len(bm.faces), cap))
        vol = 0.0
        acc = Vector((0.0, 0.0, 0.0))
        for f in bm.faces:            # tetrahedra from the origin
            a, b, c = (v.co for v in f.verts)
            d = a.dot(b.cross(c)) / 6.0
            vol += d
            acc += d * ((a + b + c) / 4.0)
        closed = bm.calc_volume(signed=True)
        if abs(vol) < 1e-12:
            raise RuntimeError("zero volume — the mesh is probably not closed")
        out = {"faces": len(bm.faces), "volume_m3": vol,
               "volume_check_m3": closed, "com": list(acc / vol),
               "bound_min": list(obj.matrix_world @ Vector(obj.bound_box[0])),
               "bound_max": list(obj.matrix_world @ Vector(obj.bound_box[6]))}
        if density is not None:                      # kg/m3, uniform
            out["mass_kg"] = vol * density
        return out
    finally:
        bm.free()
        obj.to_mesh_clear()

try:
    print(json.dumps({"ok": True, "data": _mass_props("PhoneStand")}, default=str))
except Exception:
    print(json.dumps({"ok": False, "error": traceback.format_exc()[-1500:]}))
```

`to_mesh()` hands back a mesh the depsgraph owns, not one you created. Free it
with `eval_obj.to_mesh_clear()` and never with `bpy.data.meshes.remove()`, which
raises `ReferenceError: StructRNA of type Mesh has been removed` — a real error
about a real double-free, not a sign your measurement was wrong.

`volume_m3` and `volume_check_m3` are the same quantity by two routes and should
agree to several digits; a gap means the mesh is not closed and the centre of
mass is fiction, which is worth saying out loud rather than reporting a number
to four decimals. For a tipping margin, take the COM's X/Y against the footprint
— the convex hull of the vertices touching the ground plane, or the base
`bound_box` face if it is flat — and report the smallest distance to an edge of
it, as a length, not as "looks stable".

### Exporting

Blender's data is in Blender units; slicers and most downstream CAD read STL as
**millimetres**. `unit_settings.scale_length` is metres per Blender unit, and
`wm.stl_export` applies `global_scale` **on top of** it whenever
`use_scene_unit=True`. Set both and the file is wrong by a factor of a million,
set neither and it is wrong by a thousand, and in every case it opens without a
complaint from anything. Derive the number instead of copying one:

```python
import bpy, os, json, traceback

def _export_stl(name, path):
    sc = bpy.context.scene
    unit = sc.unit_settings.scale_length or 1.0   # metres per Blender unit
    g = unit * 1000.0                             # ...so this many mm per unit
    obj = bpy.data.objects[name]
    vl = bpy.context.view_layer
    was = [o for o in vl.objects if o.select_get()]
    active = vl.objects.active
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        for o in vl.objects:
            o.select_set(o is obj)
        vl.objects.active = obj
        bpy.ops.wm.stl_export(filepath=path, global_scale=g,
                              use_scene_unit=False, apply_modifiers=True,
                              export_selected_objects=True)
    finally:                                      # their selection, borrowed
        for o in vl.objects:
            o.select_set(o in was)
        vl.objects.active = active
    return {"path": path, "global_scale": g,
            "expected_mm": [round(d * g, 3) for d in obj.dimensions],
            "bytes": os.path.getsize(path) if os.path.exists(path) else 0}

try:
    print(json.dumps({"ok": True, "data": _export_stl(
        "PhoneStand", "/workspace/koi_export/phone-stand.stl")}, default=str))
except Exception:
    print(json.dumps({"ok": False, "error": traceback.format_exc()[-1500:]}))
```

That works whether the human models at 1 unit = 1 m or has set
`scale_length = 0.001` and models in millimetres, which is the point of deriving
it. Report `expected_mm` and the host path together — "88.0 × 75.0 × 101.6 mm at
`~/blender-stream/workspace/koi_export/phone-stand.stl`" — so a slicer that
disagrees by exactly 1000 identifies itself immediately. `wm.obj_export` takes
`global_scale` the same way; glTF is metres by specification, so leave its scale
alone and tell the human the units instead. If an argument name is rejected,
that is the operator differing across builds, not your logic: check it against
`bpy.ops.wm.stl_export.get_rna_type().properties.keys()` before guessing. Do not
probe `bpy.ops.export_mesh.stl` as a fallback: the legacy Python exporters were
replaced by C++ operators in 4.2, so on this build the name does not exist and
reaching for it raises `KeyError` rather than returning something false.

### What is broken on this build

Two things, both the same underlying cause: your code runs from the addon's
timer callback on Blender's **main thread**, which is also the thread that
answers this socket. Hold it and you kill your own call.

**1. Renders.** `bpy.ops.render.render(write_still=True)` blocks, so the call
never returns — while the render completes normally and writes its file.
**Never retry it**; a retry starts a second render on top of the first.

`INVOKE_DEFAULT` on a timer helps but **does not fix this**. Measured on
Blender 5.2 / EEVEE Next: the scheduling call returns cleanly, and then the
render still holds the main thread long enough to blow the client's request
timeout. That matters more than it sounds, because _every_ bridge call is
marshalled onto that same main thread — so a poll issued while the render runs
does not report "rendering", it queues behind the render and severs. **The first
poll after scheduling a render is expected to fail.** Do not read that as a
crash and do not re-schedule.

So: schedule, have the render stamp a marker when it finishes, tell the human
where the file will be, and poll once, later, cheaply.

```python
# call 1 — schedule, return immediately
import bpy, os, json, traceback
OUT = "/workspace/koi_export/preview.png"
DONE = OUT + ".done"

def _schedule():
    sc = bpy.context.scene
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    for p in (OUT, DONE):
        if os.path.exists(p):
            os.remove(p)                # or a stale file reads as success
    sc.render.filepath = OUT
    sc.render.resolution_x = sc.render.resolution_y = 512
    sc.render.resolution_percentage = 100
    # Keep it cheap. A render that fits inside the request timeout is worth
    # more than one that is prettier and unobservable.
    if hasattr(sc, "eevee"):
        sc.eevee.taa_render_samples = min(getattr(sc.eevee, "taa_render_samples", 64), 32)

    def _stamp(scene, _depsgraph=None):   # handler arity changed across versions
        try:
            with open(DONE, "w") as fh:
                fh.write(str(os.path.getsize(OUT)) if os.path.exists(OUT) else "0")
        finally:
            for h in (bpy.app.handlers.render_complete,
                      bpy.app.handlers.render_cancel):
                if _stamp in h:
                    h.remove(_stamp)

    bpy.app.handlers.render_complete.append(_stamp)
    bpy.app.handlers.render_cancel.append(_stamp)

    win = bpy.context.window_manager.windows[0]
    # NOT areas[0] — that is whichever editor is first in the human's layout,
    # usually the Outliner. render.render survives it more often than
    # bpy.ops.view3d.* does, and "more often" is not a contract.
    area = next((a for a in win.screen.areas if a.type == "VIEW_3D"),
                win.screen.areas[0])

    def _go():
        with bpy.context.temp_override(window=win, screen=win.screen, area=area):
            bpy.ops.render.render("INVOKE_DEFAULT", write_still=True)
        return None                     # one-shot timer

    bpy.app.timers.register(_go, first_interval=0.1)
    return {"scheduled": OUT, "done_marker": DONE}

try:
    print(json.dumps({"ok": True, "data": _schedule()}, default=str))
except Exception:
    print(json.dumps({"ok": False, "error": traceback.format_exc()[-1500:]}))
```

```python
# call 2 — poll. Expect the FIRST one to sever; that means it is still running.
import bpy, os, json
OUT = "/workspace/koi_export/preview.png"; DONE = OUT + ".done"
print(json.dumps({"ok": True, "data": {
    "done": os.path.exists(DONE),
    "rendering": bpy.app.is_job_running("RENDER"),
    "bytes": os.path.getsize(OUT) if os.path.exists(OUT) else 0}}, default=str))
```

The `temp_override` gives the operator a window to invoke into, since a bare
timer callback has none and its `poll()` fails; see "Operators that need a 3D
viewport" for why the area is searched for rather than indexed. The
`render_complete` handler is what makes the poll one `os.path.exists` instead of
a live query into a busy scene. Either way, tell the human the file is at
`~/blender-stream/workspace/koi_export/...` and let them open it, rather than
trying to get the image back through the bridge.

**2. Python loops over mesh data.** Iterating `me.vertices` and doing arithmetic
per coordinate is what severed the old canonical digest. Element counts and
bounding boxes are C-side property reads and are fine. If you need the actual
coordinates, `foreach_get` fills the buffer in one C call — use that, on one
object, not across the scene.

The same rule covers anything else that occupies the thread for seconds: baking,
a dense remesh, `convert` on a heavy modifier stack, `time.sleep()` (which also
freezes the human's viewport and the stream). Small and often beats one long
call.

## Things that will bite you

| Symptom                                                          | Cause                                                                               | Fix                                                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `poll() failed, context is incorrect`                            | the bridge's timer callback has no 3D viewport                                      | data API, or `bpy.context.temp_override(...)`                                                                            |
| Edit ran, nothing visible                                        | object is in an excluded collection, or hidden in the view layer                    | check `coll` and `hide_get()`, not just that the object exists                                                           |
| Reference points at the wrong face                               | indices renumber on every topology change                                           | bind by name, vertex group, or a custom attribute — never a stored index                                                 |
| Scale looks right, dimensions are wrong                          | non-uniform object scale not applied                                                | read `dimensions` (post-scale), and `matrix_world` for world position                                                    |
| Render call never returns, image is on disk                      | `render()` holds the thread the addon answers on                                    | expected — schedule with `INVOKE_DEFAULT` and poll; **never retry it**                                                   |
| Digest severs the socket                                         | a Python loop over mesh data held the main thread                                   | use the minimal digest; probe topology per object, never scene-wide                                                      |
| `lambda`/`dir()`/`hasattr` rejected                              | a stale `BLENDER_MCP_SAFE_MODE=1` in gateway-config.json                            | remove it and restart the gateway                                                                                        |
| Connection severed on a snippet that only reads                  | `json.dumps` hit a `bytes` from `bpy.app.build_*`, or a `Vector`/`Matrix`           | `default=str` on every dumps, and wrap in the error envelope so the `TypeError` comes back as text                       |
| Connection severed mid-snippet                                   | any of several things — see "When the connection is severed"                        | check that table first; if it is not a render, re-read the minimal digest                                                |
| Every tool fails at once, banner says the gateway is unavailable | the Koi Gateway died; nothing reached the container                                 | `systemctl --user status koi-gateway`, then restart it. Blender is untouched — do not re-read the scene as if it changed |
| First call of a session fails, next works                        | upstream's cached socket went stale; the gateway reuses the child across sessions   | retry the identical call **once**. `connection closed before receiving` is transient; `Errno 111` is not                 |
| Every tool missing, no error anywhere                            | the gateway started before the container, so `podman exec` had nothing to attach to | start the container, then restart the gateway; the child is spawned once                                                 |
| `view3d.*` still fails `poll()` inside a `temp_override`         | the override named `screen.areas[0]`, which is not the 3D view                      | build it from the VIEW_3D area **and** its WINDOW region — `_view3d()` above                                             |
| Screenshot cropped, black or all-grey after a unit change        | `unit_settings.scale_length` moved the model; clip planes did not follow            | set `clip_start`/`clip_end` on the VIEW_3D `space_data` and on `cam.data`, then re-frame                                 |
| Exported part is 1000× or 1000000× off in the slicer             | `scale_length` and `global_scale` both applied, or neither                          | `global_scale = scale_length * 1000`, `use_scene_unit=False` — "Exporting"                                               |
| Save reported success, file is nowhere                           | absolute path outside `/workspace`, i.e. inside the container                       | write under `/workspace/`, and quote the host path back to the human                                                     |

## Cost and third parties

`generate_hyper3d_model_via_text`, `generate_hyper3d_model_via_images` and
`generate_hunyuan3d_model` send the prompt or image to an external service and
bill the human's API key. Nothing stops you any more, so: ask plainly before the
first one, say which service and what you are sending, and wait for an answer.
Poly Haven, Sketchfab and Poly Pizza downloads are free but still leave the
machine; Poly Pizza is mostly CC-BY and upstream writes the required credit onto
the imported object as `polypizza_attribution` — surface it when the human asks
what they can do with the asset.

## Nothing here is enforced

Nothing blocks you. There is no write-path check, no destructive-operator list,
no screenshot budget and no pre-send probe; the guardrail only annotates results
and never refuses a call. So these are your responsibility and nothing catches
them for you:

- **Quitting, resetting, loading another .blend over unsaved work and
  `batch_remove` are not covered by any undo step.** Do not issue one unless the
  human asked for it in this turn. They can do it in Blender in two seconds,
  which is the right place for an action nothing reverses.
- **Every path you write starts with `/workspace/`,** and you quote the host path
  back to them.
- **Every edit batch ends in `undo_push`,** and everything you create carries
  `koi_origin`.
- **Say it when a tool fails.** This bridge breaks in ways that look like
  success. A quiet workaround produces a correct-looking scene and an untrue
  report, and it throws away the bug report — which, right now, is the most
  useful thing a session here can produce.
