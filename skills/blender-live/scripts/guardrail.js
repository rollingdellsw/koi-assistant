// scripts/guardrail.js — plumbing only. Nothing here blocks anything.
//
// This file used to enforce six rules: destructive operators, undo_push, a
// screenshot budget, write paths, a paid-API confirmation, and refusing edits
// while the socket was down. All six are gone. The container is the security
// boundary — rootless, nothing published but the stream ports, nothing mounted
// from the host but /workspace — and a hook that sees tool arguments but never
// the conversation was guessing at intent in exactly the cases where intent was
// the whole question.
//
// What is left is not a restriction. It is a translator for one string.
//
// Upstream returns "Connection closed" — sometimes with isError:false — for
// several unrelated conditions: a synchronous render, a snippet that holds the
// main thread too long, a dropped Python exception, a stale cached socket.
// Undecorated, that string tells the model nothing it can act on, so it
// retries, works around, or concludes Blender crashed when Blender is fine.
// This hook attaches what is actually known about the call that produced it. It
// never changes what runs.
//
// It used to carry a sixth explanation, for get_viewport_screenshot, asserting
// the tool severed the socket on every call. That was wrong. The tool always
// worked; the Koi Gateway was dying on an unhandled EPIPE from an unrelated
// keep-alive ping, and the resulting 1006 close rejected whatever was in flight
// with "Connection closed". A hook that confidently explains a symptom it has
// misattributed is worse than one that says nothing, because it stops anyone
// looking further — that branch survived weeks of sessions on the strength of
// its own certainty. What replaced it is the TRANSPORT branch below, which
// names the layer instead of guessing at the cause.
//
// Module state lives for the sandbox/session only. Nothing here persists.

// Shape of the calls in flight, keyed by tool leaf name. A single `lastTool`
// global was wrong the moment two calls overlapped — and per guardrails_api.md
// these hooks also run inside runSubtask, which shares this module, so the
// output hook could be handed the shape of somebody else's call. Keying by tool
// name is not a call id, but it is strictly closer to one.
const pending = new Map();

// Known Blender MCP tools. Guardrails apply globally across all tool executions,
// so non-Blender tools (sandbox_exec, readSkill, etc.) must be passed through
// unmodified and never matched against Blender connection/socket regexes.
const BLENDER_TOOLS = new Set([
  "execute_blender_code",
  "get_scene_info",
  "get_object_info",
  "get_viewport_screenshot",
  "get_addon_status",
  "disable_telemetry",
  "get_polyhaven_categories",
  "search_polyhaven_assets",
  "download_polyhaven_asset",
  "set_texture",
  "get_polyhaven_status",
  "get_hyper3d_status",
  "get_sketchfab_status",
  "search_sketchfab_models",
  "get_sketchfab_model_preview",
  "download_sketchfab_model",
  "get_polypizza_status",
  "search_polypizza_models",
  "download_polypizza_model",
  "generate_hyper3d_model_via_text",
  "generate_hyper3d_model_via_images",
  "poll_rodin_job_status",
  "import_generated_asset",
  "get_hunyuan3d_status",
  "generate_hunyuan3d_model",
  "poll_hunyuan_job_status",
  "import_generated_asset_hunyuan",
  "record_trajectory_feedback",
]);

// A render scheduled with INVOKE_DEFAULT still occupies Blender's main thread
// on this build — measured on 5.2 / EEVEE Next — and EVERY other bridge call is
// marshalled onto that same thread, so anything sent while it runs queues behind
// it and severs. Remember when one was scheduled so a severed call afterwards
// gets the true explanation rather than the five-way one.
let renderScheduledAt = 0;
const RENDER_WINDOW_MS = 10 * 60 * 1000;

function leaf(name) {
  return String(name || "").split(/__|[.:/]/).pop();
}

function parseResult(ctx) {
  try {
    const raw = ctx && ctx.result && ctx.result.content;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch (_) {
        return { text: raw };
      }
    }
    if (Array.isArray(raw) && raw[0] && raw[0].text) {
      try {
        return JSON.parse(raw[0].text);
      } catch (_) {
        return { text: raw[0].text };
      }
    }
    return raw || null;
  } catch (_) {
    return null;
  }
}

function resultText(ctx) {
  const r = parseResult(ctx);
  if (!r) return "";
  if (typeof r === "string") return r;
  return JSON.stringify(r);
}

// Informational only. Used to say whether a severed call may have left half an
// edit behind, which is the one thing the model cannot work out for itself.
const MUTATES =
  /(bpy\.data\.\w+\.(new|remove)|bpy\.ops\.(mesh|object|material|curve|transform|node)\b|\.location\s*=|\.scale\s*=|\.rotation_euler\s*=|modifiers\.new)/;

// A render without INVOKE_DEFAULT runs on the main thread — the same thread the
// addon services its socket from — so the call cannot return even though the
// render succeeds and writes its file.
const RENDER_CALL = /bpy\.ops\.render\.(render|opengl)\s*\(/;
const RENDER_MODAL = /INVOKE_DEFAULT/;

// Whether the snippet caught its own exceptions. Unwrapped, a plain Python
// error is not returned by this bridge — it severs the socket and arrives
// indistinguishable from a crash. That is a different diagnosis and a different
// fix from everything else in the SEVERED branch, so it is worth knowing.
const WRAPPED = /except\s+(Exception|BaseException|:)|traceback\./;

// ...but a try/except further down does not help an import above it that
// raises: a missing module fails before the except exists, and the snippet
// looks wrapped. Anything past these modules before the first `try:` counts
// as unwrapped.
const SAFE_IMPORTS = new Set(["bpy", "json", "traceback", "os", "math", "mathutils", "bmesh", "bpy_extras"]);
function importsBeforeTry(code) {
  const head = code.split(/^\s*try\s*:/m)[0];
  for (const m of head.matchAll(/^\s*(?:import\s+([^\n#]+)|from\s+([\w.]+)\s+import)/gm)) {
    const mods = m[1] ? m[1].split(",").map((x) => x.trim().split(/\s+/)[0]) : [m[2]];
    if (mods.some((x) => !SAFE_IMPORTS.has(x.split(".")[0]))) return true;
  }
  return false;
}

module.exports = {
  // Never blocks. Records what was sent so the output hook can explain what
  // came back. The sandbox dry-runs this against a dummy context, so nothing
  // here may assume a field exists.
  input: async (ctx) => {
    const name = leaf(ctx && ctx.tool && ctx.tool.name);
    if (!BLENDER_TOOLS.has(name)) {
      return { allowed: true };
    }
    const args = (ctx && ctx.tool && ctx.tool.args) || {};
    if (name === "execute_blender_code") {
      const code = String(args.code || "");
      const isRender = RENDER_CALL.test(code);
      const modal = RENDER_MODAL.test(code);
      if (isRender && modal) renderScheduledAt = Date.now();
      pending.set(name, {
        edit: MUTATES.test(code),
        blockingRender: isRender && !modal,
        isModalRender: isRender && modal,
        wrapped: WRAPPED.test(code) && !importsBeforeTry(code),
      });
    } else {
      pending.set(name, { edit: false, blockingRender: false, isModalRender: false, wrapped: true });
    }
    return { allowed: true };
  },

  output: async (ctx) => {
    const name = leaf(ctx && ctx.tool && ctx.tool.name);
    if (!BLENDER_TOOLS.has(name)) {
      return { override: false };
    }

    const text = resultText(ctx);
    const sent = pending.get(name) || {};
    pending.delete(name);
    const renderRunning =
      renderScheduledAt && Date.now() - renderScheduledAt < RENDER_WINDOW_MS;

    // Koi's own transport, not Blender's. The gateway died, its MCP child's
    // stdin closed, or the WebSocket to the extension dropped. Checked FIRST
    // because these strings also contain "connection closed" and would
    // otherwise be explained as a Blender main-thread stall, which is the exact
    // misattribution that put a false "this tool is broken" claim in SKILL.md.
    const TRANSPORT =
      /(koi gateway unavailable|is not running \(its stdin is closed\)|while '[^']+' was in flight|gateway handshake timeout)/i;

    // Nothing listening at all. Distinct from everything below: the socket was
    // never opened, so the call definitely did not reach Blender.
    const DEAD = /(could not connect to blender|Errno 111|connection refused|ConnectionRefusedError)/i;

    // The socket went away mid-call, or the result never came back. On this
    // deployment this is usually NOT a failure.
    const SEVERED = /(connection closed|connection (reset|aborted|lost)|closed before receiving|communication error with blender)/i;

    if (TRANSPORT.test(text)) {
      return {
        override: true,
        isError: true,
        result:
          "This failed in Koi's transport, NOT in Blender. The WebSocket between " +
          "the extension and the Koi Gateway dropped, or the gateway's MCP child " +
          "is gone. Blender itself is almost certainly running and its scene is " +
          "untouched by this — do not re-read the scene as though the human " +
          "changed it, and do not describe Blender as crashed. Whether YOUR call " +
          "ran is unknown: the transport died, so no answer came back either " +
          "way. Tell the human plainly that the Koi Gateway dropped, and that " +
          "the check is `systemctl --user status koi-gateway` on the host — " +
          "restart it if it is not active. Then wait for them; re-issuing calls " +
          "into a dead gateway just produces more of this.",
      };
    }

    if (DEAD.test(text)) {
      return {
        override: true,
        isError: true,
        result:
          "Nothing is listening on Blender's socket, so this call did not reach " +
          "the scene — regardless of how the result envelope was marked. Ask the " +
          "human to check the stream tab at https://localhost:3001: if the " +
          "desktop is there, press N in the 3D viewport and click Connect to MCP " +
          "server; if the tab will not load either, the container is down and " +
          "that is `systemctl --user restart koi-blender` then `systemctl --user " +
          "restart koi-gateway`, on the host, by them. Re-read the scene before " +
          "re-issuing anything.",
      };
    }

    if (SEVERED.test(text)) {
      // Known-good cases first: on this build these are the normal outcome, not
      // an error, and treating them as errors is what sends a session off into
      // workarounds.
      if (sent.blockingRender) {
        return {
          override: true,
          // NOT isError. Per guardrails_api.md an isError override drives the
          // model's fix loop, which is the exact behaviour this message spends
          // its whole length arguing against. Saying "expected, do not retry"
          // in an envelope marked `error` was telling it two opposite things.
          isError: false,
          result:
            "EXPECTED — not a crash. bpy.ops.render.render() blocks the thread " +
            "the addon answers its socket on, so the result can never come back, " +
            "while the render itself completes normally and writes its file. Do " +
            "NOT retry: a retry starts a second render on top of the first. Wait, " +
            "then check for the file in a separate call. If you need the call " +
            "itself to return, schedule the render from bpy.app.timers with " +
            "'INVOKE_DEFAULT' — SKILL.md → \"What is broken on this build\".",
        };
      }

      // Scheduled-render fallout. The schedule call returned cleanly; this is a
      // later call queued behind a render that still owns the main thread.
      if (renderRunning && !sent.blockingRender) {
        return {
          override: true,
          isError: false,
          result:
            "EXPECTED — a render scheduled earlier in this session is still " +
            "holding Blender's main thread, and every bridge call is marshalled " +
            "onto that same thread, so this one queued behind it and timed out. " +
            "INVOKE_DEFAULT does not prevent this on this build; it only makes " +
            "the SCHEDULING call return. The render is almost certainly still " +
            "fine. Do NOT re-schedule it — that starts a second render. Wait, " +
            "then send the cheap poll from SKILL.md (os.path.exists on the " +
            ".done marker). If several polls in a row sever, say so to the human " +
            "and point them at the file rather than continuing to poll.",
        };
      }

      // An unwrapped snippet cannot tell you it raised, so it looks like this.
      if (sent.wrapped === false) {
        return {
          override: true,
          isError: true,
          result:
            "The connection severed on a snippet that was NOT wrapped in the " +
            "error envelope (or imported a non-bpy module above its try:), so " +
            "an ordinary Python exception — ModuleNotFoundError included — and a genuine " +
            "bridge failure are indistinguishable from here — upstream drops " +
            "the traceback rather than returning it. Before concluding anything " +
            "about the bridge: re-send the SAME snippet inside try/except with " +
            "json.dumps(..., default=str), imports inside the try " +
            "(SKILL.md -> \"The error envelope\"). " +
            "If it comes back as {\"ok\": false}, it was your code and the " +
            "traceback is right there. bpy.app.build_hash and its siblings are " +
            "bytes, so an unguarded json.dumps over them raises TypeError on the " +
            "most ordinary read in the file. Only if the wrapped version severs " +
            "too is this actually the bridge.",
        };
      }

      const partial = sent.edit
        ? "This call was an EDIT, so part of it may have run. Do not assume the " +
          "scene is unchanged, and do not assume it changed — read it. "
        : "This was a read, so nothing was written either way. ";

      return {
        override: true,
        isError: true,
        result:
          "The connection was severed during this call. On this deployment that " +
          "covers several unrelated things and they are indistinguishable from " +
          "here: the snippet held Blender's main thread too long (any loop over " +
          "mesh data, a bake, a dense modifier evaluation), upstream's cached " +
          "socket went stale, a Python exception was dropped instead of " +
          "returned, or Blender crashed at the C level. " + partial +
          "Do this, in order: re-read the scene with the MINIMAL digest " +
          "(SKILL.md → \"The digest\") to find out what is actually there; if " +
          "that also severs, the bridge is the problem and not your code. Then " +
          "tell the human plainly that the call failed and what you are doing " +
          "about it — do not quietly route around it. If you suspect a specific " +
          "call, name it. A reproducible failure here is a bug report, not " +
          "something to retry around.",
      };
    }

    // Call succeeded cleanly; if a render was in flight and this was a subsequent
    // call (not the schedule call itself), Blender has finished and is responsive.
    if (renderScheduledAt !== 0 && !sent.isModalRender && !ctx.result?.isError) {
      renderScheduledAt = 0;
    }

    return { override: false };
  },
};
