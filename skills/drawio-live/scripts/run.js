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
//
// The Skills panel's "Additional Instructions (Optional)" box has no channel of
// its own. useSkillExecution folds it into the FIRST declared parameter before
// the script runs:
//
//   canvasUrl filled  ->  args[0] = "<url>\n\n# Additional Instructions\n<text>"
//   canvasUrl blank   ->  args[0] = "<text>"
//
// Handing that blob to drawio_config as a URL loses the text silently — the
// WHATWG URL parser strips newlines, so the prose is folded into a fragment and
// the canvas opens as if nothing had been typed. Split the two halves here:
// only the URL half reaches drawio_config, and the prose half is carried out
// through `findings`, which IS seeded into the follow-up session.
const ADDITIONAL_HEADER = /\n\s*#+\s*Additional Instructions\s*\n/i;

function looksLikeUrl(s) {
  if (!s || /\s/.test(s)) return false;
  return (
    /^https?:\/\//i.test(s) ||
    /^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(s)
  );
}

function splitEntryArg(raw) {
  const s = (raw || "").trim();
  if (s === "") return { canvasUrl: "", instructions: "" };
  const parts = s.split(ADDITIONAL_HEADER);
  if (parts.length > 1) {
    const head = parts[0].trim();
    const tail = parts.slice(1).join("\n").trim();
    // A saved parameter default puts a real URL in head; anything else means
    // the user typed prose into the parameter box too — keep all of it.
    return looksLikeUrl(head)
      ? { canvasUrl: head, instructions: tail }
      : { canvasUrl: "", instructions: (head + "\n\n" + tail).trim() };
  }
  return looksLikeUrl(s)
    ? { canvasUrl: s, instructions: "" }
    : { canvasUrl: "", instructions: s };
}

const ENTRY = splitEntryArg(args[0]);
const canvasUrlArg = ENTRY.canvasUrl;
// args[1] is a forward-compatible slot: if the dispatcher is ever changed to
// pass the instructions on their own rather than merged into parameter 0, they
// land here and this script keeps working either way.
const USER_INSTRUCTIONS = ENTRY.instructions || (args[1] || "").trim();

// Filled in from drawio_config before any tab is touched. The literals here are
// only a fallback for an MCP too old to answer.
//
// CRITICAL: open HOST_URL, never CANVAS_URL. CANVAS_URL carries
// ?embed=1&proto=json and is loaded inside an iframe by the bridge. Opening it
// as a top-level tab lets draw.io window.close() a script-opened tab the moment
// the embed handshake has no parent — the tab vanishes, waitForCanvasTab times
// out, and the user sees "tools pointed at another tab (unknown)".
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

// listPages' id key is not contractually fixed either — normalize it here so
// the polling below can compare ids from newPage against ids from listPages.
function tabIdOf(p) {
  if (!p) return null;
  const id = p.id != null ? p.id : p.pageId != null ? p.pageId : p.tabId;
  return id == null ? null : id;
}

// A tab that was just created is not necessarily enumerable yet, and while the
// navigation commits its url is often empty or still the pre-navigation value.
// Sampling listPages once after a fixed sleep therefore loses a race that no
// amount of sleeping closes: the old code logged "could not find it" and
// carried on WITHOUT selectPage, leaving the tools pointed at the new-tab page,
// where the bridge's evaluateScript fails with "Cannot access a chrome:// URL".
// Poll until the canvas shows up instead.
async function waitForCanvasTab(hintId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  while (Date.now() < deadline) {
    const pages = await pageList();
    // Prefer the tab newPage actually created; fall back to matching by URL
    // for the case where newPage returned nothing useful.
    const byId =
      hintId == null ? null : pages.find((p) => tabIdOf(p) === hintId);
    if (byId && isCanvasUrl(byId.url)) return hintId;
    const byUrl = pages.find((p) => isCanvasUrl(p.url));
    if (byUrl) return tabIdOf(byUrl);
    await tools.sleep(500);
  }
  // Timed out with the URL never settling. If newPage gave us an id, focusing
  // it is still better than leaving the active tab wherever it was.
  return hintId;
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

function hostUrlFrom(canvasOrHost) {
  try {
    const u = new URL(canvasOrHost);
    const path = u.pathname && u.pathname !== "" ? u.pathname : "/";
    return u.origin + path;
  } catch (_) {
    return "https://embed.diagrams.net/";
  }
}

async function resolveDeployment() {
  try {
    const cfg = unwrap(
      await tools.drawio_config(canvasUrlArg ? { canvasUrl: canvasUrlArg } : {})
    );
    if (cfg && cfg.error) return cfg.error;
    if (cfg && cfg.canvasUrl) {
      CANVAS_URL = cfg.canvasUrl;
      // Prefer the MCP's hostUrl (strips embed query). Fall back locally for
      // older MCP builds that returned the same string for both.
      HOST_URL = cfg.hostUrl ? hostUrlFrom(cfg.hostUrl) : hostUrlFrom(cfg.canvasUrl);
      if (Array.isArray(cfg.hosts) && cfg.hosts.length) CANVAS_HOSTS = cfg.hosts;
      console.log(
        "canvas: " + CANVAS_URL.split("?")[0] +
          " host: " + HOST_URL +
          (cfg.source ? " (source: " + cfg.source + ")" : "")
      );
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
  if (!HOST_URL) HOST_URL = hostUrlFrom(CANVAS_URL);
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
      // Open the HOST document, not the embed canvas URL. The bridge installs
      // an iframe pointed at CANVAS_URL; the top-level tab must not carry
      // ?proto=json or draw.io will window.close() a script-opened tab.
      // newPage also does not guarantee the new tab becomes ACTIVE for tools —
      // always selectPage after.
      const created = unwrap(await tools.newPage(HOST_URL));
      const hintId = tabIdOf(created) || tabIdOf(created && created.page);
      console.log("newPage host=" + HOST_URL + " pageId=" + hintId);

      const openedId = await waitForCanvasTab(hintId, 20000);
      if (openedId != null) {
        // Confirm the tab is still alive. A vanished pageId is the classic
        // symptom of opening CANVAS_URL (embed/proto) top-level.
        const stillThere = (await pageList()).some(
          (p) => String(tabIdOf(p)) === String(openedId),
        );
        if (!stillThere) {
          return {
            success: false,
            action: "opened",
            error: "canvas tab self-closed",
            findings:
              "Opened a draw.io tab (pageId " + openedId + ") but it closed " +
              "itself immediately. This happens when the top-level URL carries " +
              "the embed protocol (?embed=1&proto=json) — draw.io then " +
              "window.close()s a script-opened tab. The skill should open the " +
              "host URL (" + HOST_URL + ") and frame the canvas in an iframe. " +
              "Re-run the skill; if it keeps failing, update the drawio-live skill.",
          };
        }
        await tools.selectPage(openedId);
        await tools.sleep(500);
      } else {
        console.log("Opened the host tab but never saw it in listPages.");
      }
      await tools.sleep(1500); // host document boot; iframe is installed later by drawio_init

      action = "opened";
      console.log("Opened a new host tab for the draw.io canvas.");
    }
  }

  // The MCP server is already registered (loadMcp, above) — it had to be, to
  // tell us which URL to open. Registering it does NOT put the SKILL.md body in
  // front of the model; that arrives when the skill auto-loads on the canvas tab
  // or when the model calls readSkill itself.

  // Last line of defence: attaching to the wrong tab produces a chrome:// error
  // from deep inside the bridge, which reads as a draw.io failure. Check first
  // and say something the user can act on.
  const pagesNow = await pageList();
  const activeNow = await activeUrl(pagesNow);
  const anyCanvas = pagesNow.find((p) => isCanvasUrl(p.url));
  if (!isCanvasUrl(activeNow)) {
    // If a canvas/host tab exists but isn't active, try one more selectPage
    // before giving up — listPages has no active flag, so activeUrl depends on
    // getPageContext which can lag a focus change.
    if (anyCanvas) {
      const id = tabIdOf(anyCanvas);
      console.log("activeUrl not canvas (" + (activeNow || "null") + "); re-selecting " + id);
      try {
        await tools.selectPage(id);
        await tools.sleep(500);
      } catch (e) {
        console.log("re-select failed: " + (e.message || e));
      }
      const retry = await activeUrl(await pageList());
      if (isCanvasUrl(retry)) {
        // fall through to drawio_init
      } else {
        return {
          success: false,
          action,
          error: "canvas tab not active",
          findings:
            "A draw.io host tab is open (" + (anyCanvas.url || id) + "), but " +
            "the browser tools are still pointed at another tab (" +
            (retry || activeNow || "unknown") + "). Click the draw.io tab to " +
            "focus it, then run the skill again.",
        };
      }
    } else {
      return {
        success: false,
        action,
        error: "canvas tab not active",
        findings:
          "No draw.io host tab is open (tools see: " +
          (activeNow || "unknown") + "). The tab may have self-closed after " +
          "being opened at the embed URL (?proto=json). Run the skill again; " +
          "it should open " + (HOST_URL || "the host origin") + " instead.",
      };
    }
  }

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

// Every exit path — success, config rejection, bridge failure — goes through
// here, so the instructions survive even when the canvas did not come up.
function attachInstructions(res) {
  if (USER_INSTRUCTIONS === "") return res;
  const out = res || {};
  const note =
    "\n\n---\n\nYou also gave me these instructions when you started the skill:\n\n" +
    USER_INSTRUCTIONS +
    "\n\nI haven't acted on them yet — send a message when the canvas is ready " +
    "and I'll start there.";
  out.instructions = USER_INSTRUCTIONS;
  out.findings = (typeof out.findings === "string" ? out.findings : "") + note;
  return out;
}

return run().then(attachInstructions);
