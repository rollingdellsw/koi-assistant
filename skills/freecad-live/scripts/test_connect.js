// scripts/connect.js — bind this session to a FreeCAD bridge, from the Run dialog.
//
// args, positional, in the order the parameters are declared in SKILL.md:
//   [0] bridgeUrl    e.g. http://localhost:8765
//   [1] bridgeToken  the KOI_BRIDGE_TOKEN the bridge was started with
//   [2] streamUrl    optional, e.g. https://localhost:3001
//
// Why this exists: the alternative is telling every user to edit bridge-token:
// in SKILL.md, which means editing skill source to configure a skill, and means
// a live secret sitting in a tracked file. The form collects it instead, and
// freecad_config puts it in the MCP server's module state — the same state the
// LLM's later tool calls read, because the router is a singleton for the
// session. Nothing is written to disk and the token never enters the
// conversation.
//
// State lasts as long as the sandbox does, i.e. the session. A new session
// means running this again, which is the same gesture as opening the document.

const [rawUrl, rawToken, rawStream] = args || [];
const bridgeUrl = String(rawUrl || "").trim();
const bridgeToken = String(rawToken || "").trim();
const streamUrl = String(rawStream || "").trim();

function parseResult(res) {
  if (!res) return null;
  if (res.error) throw new Error(res.error);
  if (!Array.isArray(res.content)) return res;
  const text = res.content.find((c) => c && c.type === "text" && c.text);
  if (!text) return res;
  try {
    return JSON.parse(text.text);
  } catch (e) {
    return text.text;
  }
}

async function waitForTool(name, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (typeof tools[name] === "function") return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return typeof tools[name] === "function";
}

// A token crossing a network in the clear is worth one line of noise, and the
// person who can act on it is the one reading this output.
function transportWarning(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }
  if (u.protocol !== "http:") return null;
  const h = u.hostname;
  if (h === "localhost" || h === "::1" || h === "[::1]" || /^127\./.test(h)) return null;
  return (
    "bridgeUrl is plain HTTP to " + u.host + ": the token and every document " +
    "cross the network unencrypted. Tunnel it (ssh -N -L 8765:127.0.0.1:8765 " +
    "user@host) and use http://localhost:8765 here."
  );
}

async function run() {
  if (!bridgeUrl) {
    return {
      success: false,
      error:
        "bridgeUrl is empty. It is where koi_bridge.py listens — " +
        "http://localhost:8765 on the documented deploy.",
    };
  }

  const warning = transportWarning(bridgeUrl);
  if (warning) console.warn("⚠️  " + warning);
  if (!bridgeToken) {
    console.warn(
      "⚠️  No token given. This only works if the bridge was started without " +
      "KOI_BRIDGE_TOKEN; otherwise expect 401."
    );
  }

  if (!(await waitForTool("freecadConfig", 5000))) {
    await tools.readSkill({ name: "freecad-live" });
    if (!(await waitForTool("freecadConfig", 10000))) {
      return { success: false, error: "the freecad_bridge MCP server never registered" };
    }
  }

  const cfgArgs = { bridgeUrl: bridgeUrl };
  if (bridgeToken) cfgArgs.bridgeToken = bridgeToken;
  if (streamUrl) cfgArgs.streamUrl = streamUrl;
  const cfg = parseResult(await tools.freecadConfig(cfgArgs));
  if (!cfg || cfg.error) {
    return { success: false, error: (cfg && cfg.error) || "freecad_config returned nothing" };
  }
  // cfg reports tokenSet, a boolean. It does not report the token, and neither
  // does this script: the point of the exercise is that it stays out of the
  // transcript.
  console.log("bridge " + cfg.bridgeUrl + " · token " + (cfg.tokenSet ? "set" : "NOT set"));

  let attach;
  try {
    attach = parseResult(await tools.freecadAttach({ timeoutMs: 60000 }));
  } catch (e) {
    return {
      success: false,
      bridgeUrl: cfg.bridgeUrl,
      tokenSet: !!cfg.tokenSet,
      error: e.message,
      hint: /401|403|rejected/.test(e.message || "")
        ? "The bridge is up and guarded — the token does not match. Compare " +
          "against `grep KOI_BRIDGE_TOKEN ~/freecad-stream/bridge.env` on the " +
          "FreeCAD host and run this again."
        : "Check the bridge is listening and, if it is remote, that the tunnel is up.",
    };
  }

  if (!attach || attach.attached !== true) {
    return {
      success: false,
      bridgeUrl: cfg.bridgeUrl,
      tokenSet: !!cfg.tokenSet,
      error: "attach did not succeed",
      detail: attach,
    };
  }

  const out = {
    success: true,
    bridgeUrl: cfg.bridgeUrl,
    tokenSet: !!cfg.tokenSet,
    streamUrl: cfg.streamUrl || null,
    attached: true,
    gui: attach.gui !== false,
    version: attach.version || attach.freecadVersion || null,
    document: attach.document || attach.doc || null,
    pin: attach.pin || null,
  };
  if (warning) out.warning = warning;
  if (!out.gui) {
    out.note =
      "Headless: no viewport, so freecad_render and the human's stream are " +
      "both unavailable. Geometry still works.";
  }
  console.log("attached · FreeCAD " + (out.version || "?") + (out.gui ? " · gui" : " · headless"));
  return out;
}

return run().catch((e) => {
  console.error(e);
  return { success: false, error: e.message };
});