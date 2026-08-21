// scripts/open.js — Open a draw.io canvas tab and initialize the bridge.
//
// Usage (LLM):  runBrowserScript({ script_path: "drawio-live:scripts/open.js", args: ["My Diagram", "<optional xml>", "<mode>", "<canvasUrl>"] })
// Usage (human): /skill drawio-live/scripts/open.js --full-auto
//
// args[0] = diagram name (default: "untitled")
// args[1] = initial .drawio XML (default: empty diagram)
// args[2] = mode: "auto" (default) | "adopt" | "replace"
// args[3] = canvasUrl: draw.io deployment to use (default: whatever the
//           drawio_bridge server resolves — `canvas-url:` in SKILL.md, or the
//           public embed.diagrams.net). Accepts a bare origin such as
//           http://localhost:7080 or a self-hosted https origin.
//
// Reuses an already-open canvas tab instead of spawning a second one. If the
// user opened the canvas themselves, or a previous turn opened it, this
// attaches to it rather than starting over.

const [name, initialXml, mode, canvasUrlArg] = args;

// Resolved from the MCP before any tab is touched — see resolveDeployment().
// Open HOST_URL (no embed query). CANVAS_URL is for the iframe only; loading
// it top-level with ?proto=json makes draw.io window.close() script-opened tabs.
let CANVAS_URL = null;
let HOST_URL = null;
let CANVAS_HOSTS = ["embed.diagrams.net", "viewer.diagrams.net", "localhost", "127.0.0.1"];

function unwrap(res) {
  if (!res) return null;
  try {
    if (typeof res.content === "string") return JSON.parse(res.content);
    if (Array.isArray(res.content) && res.content[0] && res.content[0].text) {
      return JSON.parse(res.content[0].text);
    }
  } catch (_) { /* fall through */ }
  return res;
}

function isCanvasUrl(url) {
  return (
    typeof url === "string" &&
    (CANVAS_HOSTS.some((h) => url.includes(h)) || url.includes("embed=1"))
  );
}

async function findCanvasTab() {
  try {
    const parsed = unwrap(await tools.listPages());
    const arr = Array.isArray(parsed) ? parsed : (parsed && parsed.pages) || [];
    const tab = arr.find((p) => isCanvasUrl(p.url));
    return tab ? tab.id || tab.pageId : null;
  } catch (e) {
    console.log("listPages note: " + (e.message || e));
    return null;
  }
}

// 0. Register the MCP server first: it owns the deployment configuration, so
//    nothing above can know which URL to open until it has answered. (Loading
//    it later, as this script used to, meant the URL had to be hardcoded here.)
try {
  await tools.readSkill({ name: "drawio-live" });
  await tools.sleep(1500); // allow MCP server startup
} catch (e) {
  console.log("readSkill note: " + (e.message || e));
}

function hostUrlFrom(canvasOrHost) {
  try {
    const u = new URL(canvasOrHost);
    const path = u.pathname && u.pathname !== "" ? u.pathname : "/";
    return u.origin + path;
  } catch (_) {
    return "https://embed.diagrams.net/";
  }
}

try {
  const cfg = unwrap(await tools.drawio_config(canvasUrlArg ? { canvasUrl: canvasUrlArg } : {}));
  if (cfg && cfg.error) return { success: false, error: "Invalid canvasUrl: " + cfg.error };
  if (cfg && cfg.canvasUrl) {
    CANVAS_URL = cfg.canvasUrl;
    HOST_URL = cfg.hostUrl ? hostUrlFrom(cfg.hostUrl) : hostUrlFrom(cfg.canvasUrl);
    if (Array.isArray(cfg.hosts) && cfg.hosts.length) CANVAS_HOSTS = cfg.hosts;
  }
} catch (e) {
  console.log("drawio_config note: " + (e.message || e));
}
if (!CANVAS_URL) {
  const origin = (canvasUrlArg || "https://embed.diagrams.net/").replace(/\/+$/, "");
  CANVAS_URL =
    origin.indexOf("embed=1") === -1
      ? origin + "/?embed=1&proto=json&spin=1&modified=0&libraries=1&ui=kennedy&noExitBtn=1"
      : origin;
}
if (!HOST_URL) HOST_URL = hostUrlFrom(CANVAS_URL);

// 1. Reuse an existing canvas tab if one is open — the user may already have
//    a diagram in progress, and opening a second tab strands it.
let canvasTabId = await findCanvasTab();
let reused = canvasTabId !== null;

if (!reused) {
  console.log("No canvas tab found — opening host " + HOST_URL + " ...");
  await tools.newPage(HOST_URL);
  await tools.sleep(3000);
  canvasTabId = await findCanvasTab();
  if (canvasTabId === null) {
    return {
      success: false,
      error:
        "Opened host tab at " + HOST_URL + " but it never appeared in listPages. " +
        "If the URL carried ?proto=json the tab may have self-closed.",
    };
  }
} else {
  console.log("Reusing existing canvas tab: " + canvasTabId);
}

// 2. The canvas tab must be the active tab: MCP evaluateScript targets whatever
//    the background resolves as active, and a screenshot or a push aimed at the
//    wrong tab fails silently.
if (canvasTabId !== null) {
  await tools.selectPage(canvasTabId);
  await tools.sleep(500);
}

// 4. Initialize the bridge + load content
console.log("Initializing bridge...");
const initResult = await tools.drawio_init({
  name: name || "untitled",
  xml: initialXml || "",
  // On a reused tab, default to adopting whatever the user has drawn. Only an
  // explicit mode (or supplied xml) may overwrite it.
  mode: mode || (reused && !initialXml ? "adopt" : "auto"),
});

if (initResult && initResult.isError) {
  const text = initResult.content && initResult.content[0] && initResult.content[0].text;
  return { success: false, error: text || "drawio_init failed" };
}

// Parse the MCP result
let parsed;
try {
  const text = initResult.content ? initResult.content[0].text : JSON.stringify(initResult);
  parsed = JSON.parse(text);
} catch (_) {
  parsed = initResult;
}

if (parsed.error) {
  return { success: false, error: parsed.error };
}

// 5. Get the tab ID for future selectPage calls
const pages = await tools.listPages();
let tabId = null;
if (pages && !pages.isError) {
  const pageList = pages.content
    ? (typeof pages.content === "string"
        ? JSON.parse(pages.content)
        : (pages.content[0] && pages.content[0].text ? JSON.parse(pages.content[0].text) : []))
    : (Array.isArray(pages) ? pages : pages.pages || []);
  const drawioTab = (Array.isArray(pageList) ? pageList : []).find((p) => isCanvasUrl(p.url));
  if (drawioTab) tabId = drawioTab.id || drawioTab.pageId;
}

console.log("draw.io canvas ready: " + (name || "untitled"));
return {
  success: true,
  tabId,
  reused,
  mode: parsed.mode,
  name: name || "untitled",
  rev: parsed.rev,
  stats: parsed.stats,
  hint: reused
    ? "Attached to the canvas the user already had open; their diagram is intact. Call drawio_sync() then drawio_ops()."
    : "Canvas is open. The user can edit the diagram directly. When you need to edit, call drawio_sync() first, then drawio_ops().",
};
