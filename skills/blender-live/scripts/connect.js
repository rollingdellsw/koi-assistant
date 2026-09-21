// scripts/connect.js — preflight, then hand back the first digest.
//
// Usage (human): Skills → blender-live → Run, or `/skill
//                blender-live/scripts/connect.js --full-auto` from the input box
// Usage (LLM):   runBrowserScript({ script_path: "blender-live:scripts/connect.js" })
//                — but runBrowserScript is not registered in every build. Two
//                sessions have now opened with it absent from the tool list, so
//                a model that cannot see it should not hunt for it: go straight
//                to the digest through execute_blender_code and say the
//                preflight never ran, since everything below went unchecked.
//
// Five things can be wrong and they fail at five different layers with five
// unhelpful messages: the Gateway is not running, the `blender` server is not
// registered in gateway-config.json, the koi-blender container is not up so
// `podman exec` has nothing to attach to, blender-mcp is not installed inside
// it, or the addon's socket server was never started. Each one surfaces here as
// a sentence with the fix in it, which is the entire reason this script exists.
//
// Streamed deployment. Blender runs inside a rootless podman container and is
// watched in a browser tab over WebRTC (Selkies), the same shape freecad-live
// uses. Only the stream ports are published; the addon's socket stays on the
// container's own loopback and the MCP server is spawned *inside* the container
// with `podman exec -i`, so the unauthenticated Python-execution socket is
// never reachable from the host at all. That is the one place this design
// deliberately diverges from freecad-live, whose bridge has a token and can
// therefore afford to be published on 127.0.0.1.

// Where the human watches. Nothing here fetches it; it is the link to hand
// back so the model can say "open this tab" instead of "open Blender".
const STREAM_URL = "https://localhost:3001";
const CONTAINER = "koi-blender";

// Build pinning, freecad-live style: the container is pinned by image digest,
// and this is the second, independent pin — read from inside the running
// process. Empty means "report, do not enforce"; fill them in from a known-good
// session and drift shows up on attach instead of three edits later.
const PIN_VERSION = "";   // e.g. "4.5.0"
const PIN_BUILD = "";     // e.g. "8cb6b388974a"

function textOf(res) {
  if (!res) return "";
  try {
    if (typeof res.content === "string") return res.content;
    if (Array.isArray(res.content)) return res.content.map((c) => (c && c.text) || "").join("\n");
    return JSON.stringify(res);
  } catch (_) {
    return String(res);
  }
}

// Keep this byte-identical to the digest in SKILL.md. The whole point of the
// turn-open diff is comparing two runs of the same snippet, and a field derived
// two different ways compares as a change the human never made. (It was not
// byte-identical before this: this copy imported `hashlib` and `array`, left
// over from the vertex-hash digest that was removed, and ordered its keys
// differently.)
//
// Two things in here are load-bearing and neither is obvious:
//
//   bpy.app.build_hash is BYTES, not str — as are build_branch, build_date,
//   build_time and build_platform. json.dumps raises TypeError on it. Upstream
//   does not return that exception; it severs the socket, so the most ordinary
//   read in this file failed on call #1 of a session and arrived looking
//   exactly like a crashed bridge. Hence the explicit decode, and hence
//   default=str as a backstop for Vector/Matrix/IDPropertyGroup.
//
//   The try/except is what makes a Python error legible at all here. Caught and
//   printed, it comes back on stdout, which upstream does capture. Uncaught, it
//   is four indistinguishable words.
const DIGEST = `
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
`;

// 1. Register the MCP server. Tools arrive asynchronously after readSkill, so
//    poll rather than sleeping a fixed amount and hoping.
try {
  await tools.readSkill({ name: "blender-live" });
} catch (e) {
  return {
    success: false,
    error: "readSkill failed: " + (e.message || e),
  };
}

let ready = false;
for (let i = 0; i < 20 && !ready; i++) {
  if (typeof tools.get_scene_info === "function") ready = true;
  else await tools.sleep(500);
}
if (!ready) {
  return {
    success: false,
    error: "The `blender` MCP server never registered.",
    fix:
      "Check, in order, and stop at the first one that fails: `podman ps " +
      "--filter name=" + CONTAINER + "` shows the container Up (if not: " +
      "`systemctl --user start koi-blender`); `podman exec -i " + CONTAINER +
      " /config/.local/bin/blender-mcp --help` prints usage (if not, the " +
      "server is not installed in /config — re-run the container setup " +
      "script); the Koi Gateway is running (`systemctl --user status " +
      "koi-gateway`); gateway-config.json has a `blender` entry under " +
      "`servers`. The gateway spawns this child once at startup, so restart " +
      "the gateway after starting the container, not the other way round.",
  };
}

// Both get_scene_info and execute_blender_code take `user_prompt`; it feeds
// upstream's trajectory capture, and the schema asks for the human's own words
// verbatim so that every call of a multi-step task links back to one intent.
// Preflight has no human message to quote yet — it runs before the first turn —
// so this says what the call is for instead. In session the model should be
// quoting them, which is what SKILL.md now says; an earlier note here told it to
// summarise, and that was wrong. Telemetry is off via the gateway env block, so
// those words stay on this machine; if that is ever re-enabled, this is the one
// field here that is not about the scene and therefore the one that leaves.
const PROBE_PROMPT = "koi preflight: read scene state";

// 2. Probe the socket to Blender itself. The server registers happily whether
//    or not Blender is listening — that is a separate hop and a separate
//    failure.
// The first call of a session may land on upstream's cached socket after the
// addon closed it. get_addon_status takes no arguments and is the cheapest
// thing to spend that failure on, so the real probe below reports the truth.
try {
  await tools.get_addon_status({});
} catch (_) { /* expected to fail sometimes; that is the point */ }

let probe;
try {
  probe = await tools.get_scene_info({ user_prompt: PROBE_PROMPT });
} catch (e) {
  probe = { isError: true, content: String(e.message || e) };
}
const probeText = textOf(probe);
if (
  (probe && probe.isError) ||
  /could not connect to blender|connection refused|Errno 111|ECONNREFUSED/i.test(probeText)
) {
  return {
    success: false,
    error:
      "blender-mcp is running inside the container but Blender is not " +
      "answering on 127.0.0.1:9876 there.",
    detail: probeText.slice(0, 400),
    stream: STREAM_URL,
    fix:
      "The startup script should have started that socket automatically. " +
      "Check `podman logs " + CONTAINER + " | grep BlenderMCP` — a line " +
      "reading 'BlenderMCP server started on 127.0.0.1:9876' means it came up " +
      "and something closed it since. Fastest recovery is in the stream tab " +
      "(" + STREAM_URL + "): press N in the 3D viewport → MCP for Blender → " +
      "Connect to MCP server. If the panel is missing entirely the addon " +
      "never enabled, which means the startup script is not on the /config " +
      "bind mount — re-run the container setup script. Only one MCP client " +
      "may hold that socket at a time.",
  };
}

// 3. The first digest. Handing this back now means the model opens the
//    conversation already knowing what is in the scene and what is selected,
//    instead of spending its first turn finding out.
let digest = null;
let digestError = null;
try {
  const res = await tools.execute_blender_code({
    code: DIGEST,
    user_prompt: PROBE_PROMPT,
  });
  const raw = textOf(res);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const env = JSON.parse(raw.slice(start, end + 1));
    // Envelope, not bare payload. `ok: false` means the snippet ran and raised
    // — a real traceback, on stdout, instead of a severed socket. Surfacing it
    // here is the difference between "the skill has a bug on line N" and "the
    // bridge is down", which is the confusion that cost a whole session.
    if (env && env.ok === true) digest = env.data;
    else if (env && env.ok === false) digestError = env.error;
    else digest = env; // pre-envelope snippet, or someone edited SKILL.md
  }
} catch (e) {
  console.log("digest note: " + (e.message || e));
}

if (digestError) {
  return {
    success: false,
    connected: true,
    stream: STREAM_URL,
    error: "The digest snippet raised inside Blender. The bridge is fine.",
    detail: String(digestError).slice(0, 1200),
    fix:
      "This is a bug in the digest in scripts/connect.js and in SKILL.md, not " +
      "in the session. Read the traceback, fix both copies, and keep them " +
      "identical. If it is a TypeError about bytes, something in the snippet " +
      "reaches bpy.app.build_* without decoding and without default=str.",
  };
}

if (!digest) {
  return {
    success: true,
    connected: true,
    stream: STREAM_URL,
    warning:
      "Connected, but the digest did not come back as JSON at all — not even as " +
      "an {ok:false} envelope, which means the snippet did not reach its own " +
      "except block. If the result says the " +
      "connection closed, the bridge severed on a snippet that should be cheap — " +
      "that is a real problem worth telling the human about, not something to work " +
      "around. Otherwise this addon build may not capture stdout from " +
      "execute_blender_code. Either way fall back to get_scene_info + " +
      "get_object_info and SAY SO rather than guessing at scene contents.",
    sceneInfo: probeText.slice(0, 2000),
  };
}

console.log(
  "Blender " + digest.blender + " — " + digest.count + " objects, file: " + digest.file,
);

// Second pin. The image digest fixes what starts; this fixes what is actually
// running, which is the thing every claim in SKILL.md is a claim about.
const drift = [];
if (PIN_VERSION && digest.blender !== PIN_VERSION)
  drift.push("version " + digest.blender + " != pinned " + PIN_VERSION);
if (PIN_BUILD && digest.build !== PIN_BUILD)
  drift.push("build " + digest.build + " != pinned " + PIN_BUILD);

return {
  success: true,
  connected: true,
  stream: STREAM_URL,
  container: CONTAINER,
  pinDrift: drift.length ? drift : null,
  blender: digest.blender,
  build: digest.build,
  file: digest.file,
  objectCount: digest.count,
  active: digest.active,
  selected: digest.selected,
  digest,
  hint:
    "Session is live and this digest is your editing base. Keep it and diff " +
    "against it at the start of each turn — the human can take the mouse at " +
    "any moment and nothing will tell you when they did. Every edit batch ends " +
    'with bpy.ops.ed.undo_push(message="koi: ..."), and anything you create ' +
    'gets obj["koi_origin"] = "agent"; nothing enforces either. ' +
    "get_viewport_screenshot works (pass max_size 400-800); for 'this part " +
    "here' ask the human to Ctrl-drag the stream tab at " + STREAM_URL + ". " +
    "Two things break this bridge, both because your code runs on Blender's " +
    "main thread, which is the thread answering this socket. A synchronous " +
    "bpy.ops.render.render() severs and must never be retried; schedule it " +
    "with INVOKE_DEFAULT and expect the first poll to sever too. And any " +
    "Python loop over mesh data severs; read " +
    "counts, or foreach_get on one object. When a call does fail, tell the " +
    "human which one rather than routing around it. Only /workspace survives " +
    "the container being recreated, so every save or export goes there.",
};
