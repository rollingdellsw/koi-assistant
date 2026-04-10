// scripts/pre_send.js
// Runs in the same sandbox as analyze.js. args[0] is the user's draft text.
// Returns {block: false} or {block: true, message: "..."}.
async function run() {
  // Find the active Slack tab
  const pagesRes = await tools.listPages({});
  if (!pagesRes || pagesRes.isError) return { block: false }; // fail open

  let pages;
  try {
    pages = Array.isArray(pagesRes.content)
      ? JSON.parse(String(pagesRes.content[0].text))
      : pagesRes;
  } catch (_) { return { block: false }; }
  const tabList = Array.isArray(pages) ? pages : (pages.pages || []);

  // Prioritize the active tab if the user has multiple Slack tabs open
  const slackTabs = tabList.filter((p) => typeof p.url === "string" && p.url.includes("app.slack.com/client/"));
  const slackTab = slackTabs.find((p) => p.active) || slackTabs[0];

  if (!slackTab) return { block: false }; // user navigated away from Slack entirely; let them ask general questions

  // Compare current channel against whatever the last analyze.js fetch bound.
  // _lastActiveChannel is module-scope state in slack_mcp.js, exposed via
  // slack_get_fetch_state.
  const parseRes = await tools.slack_parse_channel_url({ url: slackTab.url });
  if (parseRes.isError) return { block: false };
  const parsed = JSON.parse(String(parseRes.content[0].text));
  if (!parsed.matched || !parsed.hasChannel) return { block: false };

  const currentChannelId = parsed.channelId;

  // Read the module-scope `_lastActiveChannel` from slack_mcp.js. The
  // `channel` arg scopes the per-channel `state` field (unused here) but
  // `lastActiveChannel` is always returned from module scope, so we pass
  // an empty string to make it clear we don't depend on per-channel state.
  const stateRes = await tools.slack_get_fetch_state({ channel: "" });
  if (stateRes.isError) return { block: false };
  let lastActiveChannel = null;
  try {
    const parsedState = JSON.parse(String(stateRes.content[0].text));
    lastActiveChannel = parsedState.lastActiveChannel;
  } catch (_) { return { block: false }; }

  // First message of the session — nothing bound yet
  if (lastActiveChannel === null) return { block: false };

  if (lastActiveChannel !== currentChannelId) {
    return {
      block: true,
      message: `This conversation is about a different Slack channel. Switch back to that channel, or start a new session.`
    };
  }
  return { block: false };
}
return run();
