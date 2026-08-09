// scripts/pre_send.js — block sends when the canvas the session is bound to is gone.
//
// 2s budget, fail-open. Cheap state comparison only.

async function run() {
  // Module state, no bridge round trip: returns an error when not initialized.
  let attached = false;
  try {
    const res = await tools.drawio_get({ what: "canonical" });
    const parsed =
      Array.isArray(res.content) && res.content[0] && res.content[0].text
        ? JSON.parse(res.content[0].text)
        : res;
    attached = !parsed || parsed.error === undefined;
  } catch (_) {
    return { block: false }; // MCP not loaded — not our session
  }
  if (!attached) return { block: false }; // skill loaded but never run

  // Arm the sync-before-edit gate for the upcoming user turn boundary
  try {
    await tools.drawio_begin_turn();
  } catch (_) {}

  // Which hostnames count as "the canvas" depends on the configured
  // deployment — a self-hosted instance is not on diagrams.net. Module state
  // again, no bridge round trip. Falls back to the public/local defaults.
  let hosts = ["diagrams.net", "localhost", "127.0.0.1"];
  try {
    const res = await tools.drawio_config({});
    const cfg =
      Array.isArray(res.content) && res.content[0] && res.content[0].text
        ? JSON.parse(res.content[0].text)
        : res;
    if (cfg && Array.isArray(cfg.hosts) && cfg.hosts.length) hosts = cfg.hosts;
  } catch (_) {}

  let pages;
  try {
    const res = await tools.listPages({});
    const parsed = Array.isArray(res.content)
      ? JSON.parse(String(res.content[0].text))
      : res;
    pages = Array.isArray(parsed) ? parsed : parsed.pages || [];
  } catch (_) {
    return { block: false };
  }

  const canvas = pages.find(
    (p) =>
      typeof p.url === "string" &&
      (hosts.some((h) => p.url.includes(h)) || p.url.includes("embed=1")),
  );
  if (canvas) return { block: false };

  return {
    block: true,
    message:
      "The draw.io canvas tab for this session is closed. Run the drawio-live " +
      "skill again from the Skills panel to reopen it — your draft is kept.",
  };
}

return run();
