// scripts/post.js
async function run() {
  const channelId = args[0];
  const text = args[1];
  const threadTs = args[2];

  // Fetch auth info to get teamId (cached in MCP)
  const authRes = await tools.slack_auth_test({});
  if (!authRes || authRes.isError) {
    return { isError: true, content: [{ type: "text", text: "Cannot post: auth.test failed. Re-authenticate Slack." }] };
  }
  let teamId;
  try {
    const auth = JSON.parse(String(authRes.content[0].text));
    teamId = auth.teamId;
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: "Cannot post: could not parse auth response." }] };
  }
  if (!teamId) {
    return { isError: true, content: [{ type: "text", text: "Cannot post: no teamId in auth response." }] };
  }

  // 1. Construct target URL
  let targetUrl = `https://app.slack.com/client/${teamId}/${channelId}`;
  if (threadTs) {
    targetUrl += `/thread/${channelId}-${threadTs}`;
  }

  // 2. Force the browser to snap back
  console.log(`Navigating to target channel to ensure visual sync...`);
  if (typeof tools.navigatePage === "function") {
    await tools.navigatePage(targetUrl);
    await new Promise((r) => setTimeout(r, 500)); // allow DOM rendering buffer
  }

  // 3. Execute post (prompts system Accept/Reject modal)
  console.log(`Posting message to ${channelId}...`);
  const result = await tools.slack_chat_post_message({
    channel: channelId,
    text: text,
    thread_ts: threadTs || undefined
  });

  return result;
}
return run();