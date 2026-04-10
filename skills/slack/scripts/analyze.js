// scripts/analyze.js
// Slack co-pilot orchestrator. Called on every user turn while the
// slack skill is loaded. Reads the active Slack tab URL, fetches recent
// messages (last 24h on first call, only new messages on subsequent
// calls), resolves user IDs to display names, describes any images via
// vision subtasks, and returns a structured summary the main LLM can
// present.

async function run() {
  console.log("[analyze.js] 📦 Loading slack skill dependencies...");

  // Incremental-fetch state lives in the MCP server's module scope
  // (slack_mcp.js _fetchState), NOT here. The skill-script sandbox is
  // recreated per run_browser_script call (script-runner.ts:429), so
  // anything we put in this file's module scope dies with the iframe.
  // The MCP sandbox is long-lived and is the right place for state.
  //
  // args[0] === "force_fresh" forces a fresh 24h fetch on every channel.
  let forceFresh = (typeof args !== "undefined" && Array.isArray(args) && args[0] === "force_fresh");

  // The MCP server is declared in this skill's own SKILL.md, so it's
  // already loaded by the time this script runs.
  if (typeof tools.slack_parse_channel_url !== "function") {
    return { success: false, error: "Slack MCP tools failed to register. Check OAuth setup." };
  }

  // ── Step 1: Find the active Slack tab and parse the URL ───────────
  console.log("[analyze.js] 🔍 Locating active Slack tab (calling listPages)...");
  if (typeof tools.listPages !== "function") {
    console.log("[analyze.js] 🛑 listPages tool unavailable. Exiting.");
    return { success: false, error: "listPages tool unavailable" };
  }

  const pagesRes = await tools.listPages({});
  console.log("[analyze.js] listPages returned. isError:", pagesRes?.isError);

  if (!pagesRes || pagesRes.isError) {
    console.log("[analyze.js] 🛑 listPages failed. Exiting.");
    return { success: false, error: "Failed to list browser tabs" };
  }

  let pages;
  try {
    // Handle both browser tool shapes (direct object/string) and MCP shapes (wrapped content)
    if (pagesRes && Array.isArray(pagesRes.content)) {
      pages = JSON.parse(String(pagesRes.content[0].text));
    } else if (typeof pagesRes === "string") {
      pages = JSON.parse(pagesRes);
    } else {
      pages = pagesRes; // Already a parsed JSON object
    }
  } catch (e) {
    console.log("[analyze.js] 🛑 Failed to parse pages JSON:", e.message);
    return { success: false, error: "Could not parse tab list: " + String(e.message) };
  }

  const tabList = Array.isArray(pages) ? pages : (pages.pages || []);
  console.log(`[analyze.js] Parsed ${tabList.length} tabs from listPages.`);

  // Prioritize the active tab if the user has multiple Slack workspaces open
  const slackTabs = tabList.filter((p) => typeof p.url === "string" && p.url.includes("app.slack.com/client/"));
  const slackTab = slackTabs.find((p) => p.active) || slackTabs[0];

  if (!slackTab) {
    console.log("[analyze.js] 🛑 No Slack tab found in tabList. Exiting.");
    return { success: false, error: "No Slack tab found. Open a Slack conversation in your browser first." };
  }

  console.log("[analyze.js] ✓ Found Slack tab: " + slackTab.url);

  const parseRes = await tools.slack_parse_channel_url({ url: slackTab.url });
  if (parseRes.isError) {
    return { success: false, error: "URL parse failed: " + String(parseRes.content[0].text) };
  }
  const parsed = JSON.parse(String(parseRes.content[0].text));

  if (!parsed.matched || !parsed.hasChannel) {
    // User is on Slack but not in a conversation (e.g., workspace home,
    // search results, settings). Empty state — script exits cleanly so
    // the LLM knows to wait for input.
    console.log("   ⚠ Slack tab is open but no channel/DM is active.");
    return {
      success: true,
      empty: true,
      reason: "no_active_channel",
      url: slackTab.url,
    };
  }

  const channelId = parsed.channelId;
  const channelType = parsed.channelType;
  const urlThreadTs = parsed.threadTs || null;

  // ── Identify the signed-in user ────────────────────────────────
  // Cached in MCP module scope, so this is a no-op after the first
  // turn. The LLM uses this to know which messages in the transcript
  // are the user's own — critical for the "draft a reply" workflow.
  let me = null;
  const authRes = await tools.slack_auth_test({});
  if (!authRes || authRes.isError) {
    console.log("   ⚠ auth.test failed: " + String(authRes?.content?.[0]?.text || "Unknown error")
      + " — 'me' will be null; LLM cannot identify the user's own messages.");
  } else {
    try {
      me = JSON.parse(String(authRes.content[0].text));
    } catch (e) {
      console.log("   ⚠ Could not parse auth.test response: " + String(e.message));
    }
  }
  console.log(`   ✓ Active conversation: ${channelId} (${channelType})${urlThreadTs ? ` thread=${urlThreadTs}` : ""}`);

  // If the caller asked for a fresh fetch, wipe all stored cursors.
  if (forceFresh) {
    await tools.slack_clear_fetch_state({});
    console.log("   ↪ force_fresh: cleared all fetch state.");
  }

  // Look up prior fetch state for this channel from the MCP module.
  let priorState = null;
  let lastActiveChannel = null;
  if (!forceFresh) {
    const stateRes = await tools.slack_get_fetch_state({ channel: channelId });
    if (!stateRes.isError) {
      try {
        const parsedState = JSON.parse(String(stateRes.content[0].text));
        priorState = parsedState.state;
        lastActiveChannel = parsedState.lastActiveChannel;
      } catch (_) {}
    }
  }

  // Detect channel switch for a clean slate
  let isIncremental = false;
  let oldestTs = null;
  const sameThread = (priorState?.threadTs || null) === urlThreadTs;

  if (lastActiveChannel && lastActiveChannel !== channelId && !forceFresh) {
    console.log(`   ↪ Channel switched (${lastActiveChannel} → ${channelId}). Wiping LLM memory for a clean slate.`);
    if (typeof tools.resetContext === "function") {
      await tools.resetContext();
    }
    forceFresh = true;
  } else {
    isIncremental = priorState !== null && sameThread;
    oldestTs = isIncremental ? priorState.latestTs : null;
    if (priorState && !sameThread) {
      console.log(`   ↪ Thread view changed (${priorState.threadTs || "channel"} → ${urlThreadTs || "channel"}). Fresh fetch.`);
    }
  }

  // ── Step 2: Get channel metadata (name, topic, etc.) ──────────────
  console.log("📋 Fetching channel info...");
  let channelName = channelId;
  let channelMeta = null;
  const infoRes = await tools.slack_conversations_info({ channel: channelId });
  if (!infoRes.isError) {
    try {
      channelMeta = JSON.parse(String(infoRes.content[0].text));
      if (channelMeta.name) {
        channelName = "#" + channelMeta.name;
      } else if (channelMeta.isIm && channelMeta.user) {
        // For DMs, resolve the other party's name
        const dmUserRes = await tools.slack_users_info({ user: channelMeta.user });
        if (!dmUserRes.isError) {
          const dmUser = JSON.parse(String(dmUserRes.content[0].text));
          channelName = "DM with " + (dmUser.displayName || dmUser.realName || channelMeta.user);
        }
      } else if (channelMeta.isMpim) {
        channelName = "Group DM";
      }
    } catch (_) {}
  } else {
    // Non-fatal — common reasons: bot/user not in channel, or scope missing.
    // We can still try to read history; if that also fails the user gets
    // a clearer error.
    console.log("   ⚠ Could not fetch channel info: " + String(infoRes.content[0].text));
  }

// ── Step 3: Fetch messages ────────────────────────────────────────
  // If the URL is a thread view, fetch that thread instead of channel
  // history. Otherwise fetch the channel and (below) auto-expand any
  // threads with recent activity.
  console.log(isIncremental
    ? `📜 Fetching messages newer than ts=${oldestTs}...`
    : (urlThreadTs ? `🧵 Fetching thread ${urlThreadTs}...` : "📜 Fetching last 24h of messages..."));

  let histRes;
  if (urlThreadTs) {
    histRes = await tools.slack_conversations_replies({ channel: channelId, ts: urlThreadTs, limit: 200 });
  } else {
    const histParams = { channel: channelId, limit: 200 };
    if (isIncremental) histParams.oldest = oldestTs;
    histRes = await tools.slack_conversations_history(histParams);
  }
  if (histRes.isError) {
    return {
      success: false,
      error: "History fetch failed: " + String(histRes.content[0].text),
      channelId,
      channelName,
    };
  }

  let histData;
  try {
    histData = JSON.parse(String(histRes.content[0].text));
  } catch (e) {
    return { success: false, error: "Could not parse history response: " + String(e.message) };
  }

// Slack's `oldest` is inclusive by default, so the boundary message
// would be re-delivered each turn. Filter it (and anything older,
// defensively) when running incrementally. Same applies to thread
// replies which always include the parent.
if (isIncremental && Array.isArray(histData.messages)) {
  const cutoff = parseFloat(oldestTs);
  histData.messages = histData.messages.filter(
    (m) => parseFloat(m.ts) > cutoff
  );
}

const rawMessages = Array.isArray(histData.messages) ? histData.messages : [];
  if (rawMessages.length === 0) {
    console.log(isIncremental
      ? "   ⚠ No new messages since last check."
      : "   ⚠ No messages in the last 24h.");
    // Anchor the cursor to "now" on a fresh empty fetch so the next
    // turn doesn't re-pull the same 24h window. In thread view, anchor
    // to the parent ts instead — using wall-clock `now` would cause us
    // to miss replies posted between the parent and now.
    if (!isIncremental) {
      const anchor = urlThreadTs || String(Math.floor(Date.now() / 1000));
      await tools.slack_set_fetch_state({ channel: channelId, latestTs: anchor, threadTs: urlThreadTs || "" });
    }
    return {
      success: true,
      empty: true,
      reason: isIncremental ? "no_new_messages" : "no_recent_messages",
      channelId,
      channelType,
      channelName,
      latestTs: isIncremental ? oldestTs : null,
    };
  }
  console.log(`   ✓ Got ${rawMessages.length} messages.`);

  // conversations.history returns newest-first; conversations.replies
  // returns oldest-first. Normalize to chronological.
  if (!urlThreadTs) rawMessages.reverse();

  // The highest ts in this batch. Don't trust array order — edited
  // messages and shared-channel out-of-order delivery can produce
  // surprises. Compute the true max.
  const latestTs = rawMessages.reduce(
    (acc, m) => (parseFloat(m.ts) > parseFloat(acc) ? m.ts : acc), "0");

  // ── Step 4: Resolve user IDs → display names ──────────────────────
  console.log("👤 Resolving user IDs...");
  const userIds = new Set();
  for (const m of rawMessages) {
    if (m.user) userIds.add(m.user);
  }

  // ── Step 4a: Auto-expand active threads (channel view only) ───────
  const threadReplies = {};

  // Resolve users in parallel. The MCP server's _userCache dedupes
  // across calls so concurrent lookups for the same uid are safe.
  const userMap = {};
  await Promise.all(
    Array.from(userIds).map(async (uid) => {
      const userRes = await tools.slack_users_info({ user: uid });
      if (!userRes.isError) {
        try {
          const u = JSON.parse(String(userRes.content[0].text));
          userMap[uid] = u.displayName || u.realName || uid;
          return;
        } catch (_) {}
      }
      userMap[uid] = uid;
    })
  );
  console.log(`   ✓ Resolved ${Object.keys(userMap).length} users.`);

  // ── Step 5: Process image attachments via vision subtasks ─────────
  // We loop over messages and, for each image file, spawn a subtask
  // with the base64 inlined as image_data so the subtask agent can
  // describe it visually. The description gets stitched back into the
  // message text. This mirrors gmail-summarizer's image handling.
  console.log("🖼  Processing image attachments...");
  let totalImages = 0;
  for (const m of rawMessages) {
    if (!Array.isArray(m.files) || m.files.length === 0) continue;
    for (const f of m.files) {
      totalImages++;
      f._note = `(Image unanalyzed. Call run_browser_script with slack:scripts/analyze_image.js and args: ["${f.id}"] to read it)`;
    }
  }
  console.log(`   ✓ Found ${totalImages} images (lazy-loaded).`);

  // ── Step 6: Build a human-readable transcript for the main LLM ────
  // We format messages as "Name (HH:MM): text [+ image descriptions]".
  // This is what the LLM will summarize / use as context for drafts.
  const fmtTime = (ts) => {
    const d = new Date(parseFloat(ts) * 1000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return hh + ":" + mm;
  };

  // Resolve all Slack mrkdwn entities into human-readable form so the
  // LLM and any downstream draft don't leak raw IDs or angle-bracket
  // syntax into prose. Handles:
  //   <@U123>            → @displayname  (looked up in userMap)
  //   <@U123|alice>      → @alice        (embedded label wins)
  //   <#C123|general>    → #general      (embedded label, no API call)
  //   <#C123>            → #C123         (rare; no embedded label)
  //   <!here>            → @here
  //   <!channel>         → @channel
  //   <!everyone>        → @everyone
  //   <!subteam^S123|x>  → @x            (user group)
  //   <https://x|text>   → text (https://x)
  //   <https://x>        → https://x
  //   <mailto:a@b|text>  → text (a@b)
  const resolveMentions = (text) => {
    if (typeof text !== "string") return "";
    return text.replace(/<([^>]+)>/g, (match, inner) => {
      // User mention
      if (inner.startsWith("@")) {
        const body = inner.slice(1);
        const pipe = body.indexOf("|");
        if (pipe !== -1) return "@" + body.slice(pipe + 1);
        return "@" + (userMap[body] || body);
      }
      // Channel mention
      if (inner.startsWith("#")) {
        const body = inner.slice(1);
        const pipe = body.indexOf("|");
        if (pipe !== -1) return "#" + body.slice(pipe + 1);
        return "#" + body;
      }
      // Special tokens and user groups: <!here>, <!channel>, <!everyone>,
      // <!subteam^S123|name>, <!date^...|fallback>
      if (inner.startsWith("!")) {
        const body = inner.slice(1);
        const pipe = body.indexOf("|");
        if (pipe !== -1) return "@" + body.slice(pipe + 1);
        // Bare specials: here / channel / everyone
        if (body === "here" || body === "channel" || body === "everyone") {
          return "@" + body;
        }
        // Unknown special — fall through to literal
        return match;
      }
      // Link: <url> or <url|label> or <mailto:..|label>
      if (inner.includes("://") || inner.startsWith("mailto:")) {
        const pipe = inner.indexOf("|");
        if (pipe !== -1) {
          const url = inner.slice(0, pipe);
          const label = inner.slice(pipe + 1);
          // For mailto, surface just the address; for http(s), keep both.
          if (url.startsWith("mailto:")) return `${label} (${url.slice(7)})`;
          return `${label} (${url})`;
        }
        return inner;
      }
      // Unknown bracketed entity — leave as-is.
      return match;
    });
  };

  const transcriptLines = [];
  for (const m of rawMessages) {
    const author = m.user
      ? userMap[m.user] || m.user
      : m.username || (m.botId ? "bot:" + m.botId : "system");
    const time = fmtTime(m.ts);
    const body = resolveMentions(m.text);
    let line = `[${time}] ${author}: ${body || "(no text)"}`;
    if (m.threadTs && m.threadTs !== m.ts) {
      line += ` (in thread ${m.threadTs})`;
    } else if (m.replyCount > 0) {
      line += ` (has ${m.replyCount} replies)`;
    }
    if (Array.isArray(m.files) && m.files.length > 0) {
      for (const f of m.files) {
        if (f._description) {
          line += `\n    🖼  ${f.name || f.id}: ${f._description}`;
        } else if (f._note) {
          line += `\n    📎 ${f.name || f.id} ${f._note}`;
        } else {
          line += `\n    📎 ${f.name || f.id} (${f.mimetype || "unknown"})`;
        }
      }
    }
    transcriptLines.push(line);
    // If we expanded this thread, render replies indented under the parent.
    const replies = threadReplies[m.ts];
    if (Array.isArray(replies) && replies.length > 0) {
      for (const r of replies) {
        const rAuthor = r.user
          ? userMap[r.user] || r.user
          : r.username || (r.botId ? "bot:" + r.botId : "system");
        const rTime = fmtTime(r.ts);
        const rBody = resolveMentions(r.text);
        transcriptLines.push(`    └ [${rTime}] ${rAuthor}: ${rBody || "(no text)"}`);
      }
    }
  }

  const transcript = transcriptLines.join("\n");

  console.log("[analyze.js] ✅ Slack analysis complete. Returning data...");

  // Persist cursor for next turn's incremental fetch.
  await tools.slack_set_fetch_state({
    channel: channelId,
    latestTs,
    threadTs: urlThreadTs || "",
  });

return {
    success: true,
    empty: false,
    incremental: isIncremental,
    channelId,
    channelType,
    channelName,
    threadTs: urlThreadTs,
    me,
    topic: channelMeta?.topic || "",
    purpose: channelMeta?.purpose || "",
    messageCount: rawMessages.length,
    imageCount: totalImages,
    hasMore: !!histData.hasMore,
    latestTs,
    transcript,
    // Also include a compact array form so the LLM can pick out specific
    // messages (e.g., "reply to the last message from Alice") without
    // re-parsing the transcript string.
    messages: rawMessages.map((m) => ({
      ts: m.ts,
      author: m.user ? userMap[m.user] || m.user : m.username || null,
      authorId: m.user || null,
      text: resolveMentions(m.text),
      threadTs: m.threadTs || null,
      replyCount: m.replyCount || 0,
    })),
  };
}

return run();
