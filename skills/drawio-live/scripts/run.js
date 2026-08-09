// scripts/run.js — Runnable entry point for drawio-live.
//
// Dispatched deterministically when the user clicks Run in the Skills panel:
// useSkillExecution sees `runnable: true`, finds this file, and executes it in
// the sandbox. No LLM call is made, and none should be — this script's whole
// job is to make a canvas available and then get out of the way.
//
// Contract:
//   - current tab IS the canvas       -> do nothing
//   - a canvas tab exists elsewhere   -> focus it
//   - no canvas tab                   -> open one
//   - in every case: attach the bridge WITHOUT writing to the canvas, and stop
//
// The user then loads or draws whatever they like in draw.io's own UI and types
// their first request when ready. The findings string returned below is seeded
// into a fresh session as an assistant message; the input unfreezes and nothing
// is sent until the user sends it.

// args[0] = canvasUrl — the draw.io deployment to use. Optional; empty means
// "whatever the drawio_bridge server resolves", which is `canvas-url:` in
// SKILL.md if set and the public embed.diagrams.net otherwise. Any origin
// works: http://localhost:7080 for a local webapp checkout, or a corporate
// self-host. The MCP owns the resolution so that the scripts, the bridge and
// the host allowlist can never disagree about which instance is in play.
const [canvasUrlArg] = args;

// Filled in from drawio_config before any tab is touched. The literals here are
// only a fallback for an MCP too old to answer, and are never used to open a
// tab — only to recognize one.
let CANVAS_URL = null;
let CANVAS_HOSTS = ["embed.diagrams.net", "viewer.diagrams.net", "localhost", "127.0.0.1"];

function unwrap(res) {
  if (!res) return null;
  try {
    if (typeof res.content === "string") return JSON.parse(res.content);
    if (Array.isArray(res.content) && res.content[0] && res.content[0].text) {
      return JSON.parse(res.content[0].text);
    }
  } catch (_) {
    /* not JSON — fall through */
  }
  return res;
}

function isCanvasUrl(url) {
  return typeof url === "string" && CANVAS_HOSTS.some((h) => url.includes(h));
}

async function pageList() {
  try {
    const parsed = unwrap(await tools.listPages());
    const arr = Array.isArray(parsed) ? parsed : (parsed && parsed.pages) || [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.log("listPages failed: " + (e.message || e));
    return [];
  }
}

// Best-effort read of the ACTIVE tab's URL. listPages' active-flag key is not
// contractually fixed, so try the flag first and fall back to getPageContext,
// which reports meta.url for the tab the tools would actually operate on.
async function activeUrl(pages) {
  const flagged = pages.find(
    (p) => p.active === true || p.current === true || p.isActive === true,
  );
  if (flagged && flagged.url) return flagged.url;
  try {
    const ctx = unwrap(await tools.getPageContext({ maxReadable: 1 }));
    if (ctx && ctx.meta && typeof ctx.meta.url === "string") return ctx.meta.url;
  } catch (_) {
    /* ignore */
  }
  return null;
}

// Register the MCP server before anything else: it is the thing that knows
// which URL to open. Tools register asynchronously.
async function loadMcp() {
  await tools.readSkill({ name: "drawio-live" });
  let retries = 12;
  while (typeof tools.drawio_init !== "function" && retries-- > 0) {
    await tools.sleep(500);
  }
  return typeof tools.drawio_init === "function";
}

async function resolveDeployment() {
  try {
    const cfg = unwrap(
      await tools.drawio_config(canvasUrlArg ? { canvasUrl: canvasUrlArg } : {})
    );
    if (cfg && cfg.error) return cfg.error;
    if (cfg && cfg.canvasUrl) {
      CANVAS_URL = cfg.canvasUrl;
      if (Array.isArray(cfg.hosts) && cfg.hosts.length) CANVAS_HOSTS = cfg.hosts;
    }
  } catch (e) {
    console.log("drawio_config note: " + (e.message || e));
  }
  if (!CANVAS_URL) {
    // Older MCP build with no drawio_config: honour the argument locally so the
    // parameter still does something, and fall back to the public editor.
    const origin = (canvasUrlArg || "https://embed.diagrams.net/").replace(/\/+$/, "");
    CANVAS_URL =
      origin.indexOf("embed=1") === -1
        ? origin + "/?embed=1&proto=json&spin=1&modified=0&libraries=1&ui=kennedy&noExitBtn=1"
        : origin;
  }
  return null;
}

async function run() {
  if (!(await loadMcp())) {
    return {
      success: false,
      action: "none",
      findings:
        "The drawio_bridge MCP server did not start, so there is nothing to " +
        "attach a canvas to. Try running the skill again; if it keeps failing, " +
        "reinstall the drawio-live skill.",
    };
  }

  const configError = await resolveDeployment();
  if (configError) {
    return {
      success: false,
      action: "none",
      findings: "That draw.io URL was rejected: " + configError,
    };
  }

  const pages = await pageList();
  const here = await activeUrl(pages);

  let action;
  if (isCanvasUrl(here)) {
    // Requirement: if the current tab is already the canvas, open does nothing.
    action = "already-active";
    console.log("Current tab is already the draw.io canvas — nothing to open.");
  } else {
    const existing = pages.find((p) => isCanvasUrl(p.url));
    if (existing) {
      const id = existing.id || existing.pageId;
      await tools.selectPage(id);
      await tools.sleep(500);
      action = "focused-existing";
      console.log("Focused existing canvas tab " + id);
    } else {
      await tools.newPage(CANVAS_URL);
      await tools.sleep(4000); // draw.io needs time before the bridge can attach
      action = "opened";
      console.log("Opened a new canvas tab.");
    }
  }

  // The MCP server is already registered (loadMcp, above) — it had to be, to
  // tell us which URL to open. Registering it does NOT put the SKILL.md body in
  // front of the model; that arrives when the skill auto-loads on the canvas tab
  // or when the model calls readSkill itself.

  // Attach in adopt mode: never writes to the canvas. A diagram the user
  // already has open survives untouched, and a blank canvas stays blank for
  // them to fill from draw.io's own UI.
  const init = unwrap(await tools.drawio_init({ name: "canvas", mode: "adopt" }));

  if (!init || init.success !== true) {
    return {
      success: false,
      action,
      error: (init && init.error) || "drawio_init failed",
      findings:
        "Opened the draw.io canvas, but could not attach the editing bridge: " +
        ((init && init.error) || "unknown error") +
        ". Make sure the draw.io tab is the active tab, then run the skill again.",
    };
  }

  const cells = (init.stats && init.stats.cells) || 0;
  const where =
    CANVAS_URL.indexOf("embed.diagrams.net") === -1
      ? " (" + CANVAS_URL.split("?")[0] + ")"
      : "";
  const opened =
    action === "opened"
      ? "Opened a draw.io canvas" + where + "."
      : action === "focused-existing"
        ? "Switched to your open draw.io canvas."
        : "Using the draw.io canvas already in this tab.";

  const state =
    cells > 0
      ? "It already holds " + cells + " cells — I've adopted that diagram as the editing base and changed nothing."
      : "It's empty. Load a diagram in draw.io (File ▸ Open, drag-and-drop, or paste), or just describe what you'd like me to draw.";

  return {
    success: true,
    action,
    cells,
    rev: init.rev,
    findings:
      opened +
      " " +
      state +
        "\n\nWhen you're ready, tell me what to change and I'll edit it directly on the canvas.",
  };
}

return run();
