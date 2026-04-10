// Slack MCP Server
// Read-only conversation tools + chat.postMessage (guarded by ../scripts/guardrail.js).
// All API calls go through runtime.fetch which auto-attaches the user's
// xoxp- token (acquired via PKCE code flow declared in SKILL.md).
//
// Image downloads from files.slack.com also need the bearer token, so they
// go through runtime.fetch (NOT skipAuth) with responseFormat: "base64".

return {
  // Module-scoped cache for user ID → display name. Slack user IDs are
  // stable per workspace; resolving them once per session is fine.
  _userCache: {},

  // Module-scoped fetch state. The skill-script sandbox is recreated
  // per run_browser_script call (see script-runner.ts:429), so the
  // analyze.js script cannot keep state between turns in its own
  // module scope. The MCP sandbox (sandbox-mcp.html) IS long-lived,
  // so we keep the incremental-fetch cursor here instead.
  // Keyed by channelId so switching channels and switching back works.
  // Shape: { channelId: { latestTs: string, threadTs: string|null } }
  _fetchState: {},

  _lastActiveChannel: null,

  // Module-scoped cache for the signed-in user's identity (auth.test).
  // The result never changes within a session, so we resolve once and
  // hand out the cached object on subsequent calls.
  _authCache: null,

  listTools() {
    return [
      {
        name: "slack_parse_channel_url",
        tier: "safe",
        description: "Parse a Slack web URL into team ID and channel/DM ID. Pure parser, no API call. Use this on the active tab URL before any history fetch.",
        displayMessage: "🔗 Parsing Slack URL",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "A Slack web URL like https://app.slack.com/client/T0XXX/C0YYY" },
          },
          required: ["url"],
        },
      },
      {
        name: "slack_conversations_info",
        tier: "safe",
        description: "Get metadata about a Slack channel, DM, or group DM (name, is_channel, is_im, is_member, topic, purpose).",
        displayMessage: "💬 Getting Slack channel info",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Channel ID (C…), DM ID (D…), or group DM ID (G…)" },
          },
          required: ["channel"],
        },
      },
      {
        name: "slack_conversations_history",
        tier: "safe",
        description: "Fetch recent messages from a Slack conversation. Default oldest is 24h ago. Returns messages with author user ID, text, ts, thread_ts (if threaded), and any file attachments.",
        displayMessage: "📜 Reading Slack history",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string" },
            oldest: { type: "string", description: "Unix timestamp (seconds, may be fractional). Optional. Default: 24h ago." },
            latest: { type: "string", description: "Unix timestamp upper bound. Optional." },
            limit: { type: "number", description: "Max messages to return (default 100, max 1000)" },
            cursor: { type: "string", description: "Pagination cursor from a previous response. Optional." },
          },
          required: ["channel"],
        },
      },
      {
        name: "slack_conversations_replies",
        tier: "safe",
        description: "Fetch all replies in a Slack thread. Use when a message in history has thread_ts and you want the full thread.",
        displayMessage: "🧵 Reading Slack thread",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string" },
            ts: { type: "string", description: "The parent message ts (thread_ts of any reply)" },
            limit: { type: "number" },
            cursor: { type: "string" },
          },
          required: ["channel", "ts"],
        },
      },
      {
        name: "slack_users_info",
        tier: "safe",
        description: "Resolve a Slack user ID to a profile (display name, real name, email if visible). Results are cached per session.",
        displayMessage: "👤 Looking up Slack user",
        inputSchema: {
          type: "object",
          properties: {
            user: { type: "string", description: "Slack user ID (U…)" },
          },
          required: ["user"],
        },
      },
      {
        name: "slack_files_info",
        tier: "safe",
        description: "Get metadata for a Slack file by ID, including its private download URL.",
        displayMessage: "📎 Getting Slack file info",
        inputSchema: {
          type: "object",
          properties: {
            file: { type: "string", description: "Slack file ID (F…)" },
          },
          required: ["file"],
        },
      },
      {
        name: "slack_files_download",
        tier: "safe",
        description: "Download a Slack file's binary content. By default returns metadata only to protect context. Set returnRawBase64: true to get the actual base64, then pipe it into a vision subtask. Mirrors the gmail_get_attachment pattern.",
        displayMessage: "⬇️ Downloading Slack file",
        inputSchema: {
          type: "object",
          properties: {
            url_private: { type: "string", description: "The url_private from a file object (https://files.slack.com/...)" },
            returnRawBase64: { type: "boolean", description: "If true, includes the raw base64 in the result. Default false." },
          },
          required: ["url_private"],
        },
      },
      {
        name: "slack_chat_post_message",
        tier: "mutating",
        description: "Post a message to a Slack channel, DM, or thread on behalf of the signed-in user. Show the draft text in your reply so the user can preview it.",
        displayMessage: "📤 Posting to Slack channel {{channel}}",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Channel ID (C…/D…/G…)" },
            text: { type: "string", description: "Plain text message body. Slack mrkdwn supported." },
            thread_ts: { type: "string", description: "Optional parent ts to reply in a thread" },
          },
          required: ["channel", "text"],
        },
      },
      {
        name: "slack_get_fetch_state",
        tier: "safe",
        description: "Internal: get the last-known fetch cursor for a channel. Used by analyze.js to do incremental fetches without forcing the LLM to remember state across turns.",
        displayMessage: "📍 Reading Slack fetch state",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string" },
          },
          required: ["channel"],
        },
      },
      {
        name: "slack_set_fetch_state",
        tier: "safe",
        description: "Internal: store the highest ts seen for a channel after a successful fetch. Used by analyze.js for incremental tracking.",
        displayMessage: "📍 Saving Slack fetch state",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string" },
            latestTs: { type: "string" },
            threadTs: { type: "string", description: "Optional: the thread parent ts if viewing a thread" },
          },
          required: ["channel", "latestTs"],
        },
      },
      {
        name: "slack_clear_fetch_state",
        tier: "safe",
        description: "Internal: wipe all stored fetch cursors. Used to force a fresh 24h fetch on every channel.",
        displayMessage: "🗑 Clearing Slack fetch state",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "slack_auth_test",
        tier: "safe",
        description: "Get the signed-in user's identity (user ID, team ID, display name). Result is cached for the session — calling repeatedly is cheap. Use this to identify which messages in a conversation are the user's own.",
        displayMessage: "🪪 Identifying signed-in Slack user",
        inputSchema: { type: "object", properties: {} },
      },
    ];
  },

  async callTool(name, args) {
    try {
      switch (name) {
        case "slack_parse_channel_url":
          return this.parseChannelUrl(args.url);
        case "slack_conversations_info":
          return await this.conversationsInfo(args.channel);
        case "slack_conversations_history":
          return await this.conversationsHistory(args.channel, args.oldest, args.latest, args.limit, args.cursor);
        case "slack_conversations_replies":
          return await this.conversationsReplies(args.channel, args.ts, args.limit, args.cursor);
        case "slack_users_info":
          return await this.usersInfo(args.user);
        case "slack_files_info":
          return await this.filesInfo(args.file);
        case "slack_files_download":
          return await this.filesDownload(args.url_private, args.returnRawBase64);
        case "slack_chat_post_message":
          return await this.chatPostMessage(args.channel, args.text, args.thread_ts);
        case "slack_auth_test":
          return await this.authTest();
        case "slack_get_fetch_state":
          return this.getFetchState(args.channel);
        case "slack_set_fetch_state":
          return this.setFetchState(args.channel, args.latestTs, args.threadTs);
        case "slack_clear_fetch_state":
          return this.clearFetchState();
        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  },

  // ───────────────────────────────────────────────────────────────
  // URL parsing (pure, no API)
  // ───────────────────────────────────────────────────────────────

  parseChannelUrl(url) {
    if (typeof url !== "string" || url === "") {
      return { content: [{ type: "text", text: "Error: url is required" }], isError: true };
    }
    // Slack URLs:
    //   https://app.slack.com/client/T0XXX/C0YYY                  (channel)
    //   https://app.slack.com/client/T0XXX/D0YYY                  (DM)
    //   https://app.slack.com/client/T0XXX/G0YYY                  (group DM)
    //   https://app.slack.com/client/T0XXX/C0YYY/thread/C0YYY-... (thread)
    //   https://app.slack.com/client/T0XXX                        (workspace home, no channel)
    const m = url.match(/app\.slack\.com\/client\/(T[A-Z0-9]+)(?:\/([CDG][A-Z0-9]+))?/);
    if (!m) {
      return {
        content: [{ type: "text", text: JSON.stringify({ matched: false, url }) }],
      };
    }
    const teamId = m[1];
    const channelId = m[2] || null;
    let channelType = null;
    if (channelId) {
      if (channelId.startsWith("C")) channelType = "channel";
      else if (channelId.startsWith("D")) channelType = "im";
      else if (channelId.startsWith("G")) channelType = "mpim";
    }
    // If the URL points at a specific thread, the suffix looks like
    //   .../C0YYY/thread/C0YYY-1700000000.123456
    // Extract the parent ts so analyze.js can fetch the thread directly
    // instead of (or in addition to) channel history.
    let threadTs = null;
    const tm = url.match(/\/thread\/[CDG][A-Z0-9]+-(\d+\.\d+)/);
    if (tm) threadTs = tm[1];
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          matched: true,
          teamId,
          channelId,
          channelType,
          hasChannel: channelId !== null,
          threadTs,
        }, null, 2),
      }],
    };
  },

  // ───────────────────────────────────────────────────────────────
  // Slack Web API helper
  // ───────────────────────────────────────────────────────────────

  // Slack Web API quirks:
  //   * Most read endpoints accept GET with query string.
  //   * POST endpoints want application/json with Authorization: Bearer.
  //   * Every response has { ok: bool, error?: string }. We must check ok
  //     because Slack returns HTTP 200 even on logical errors.
  async _slackGet(endpoint, params) {
    const cleanParams = {};
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) cleanParams[k] = String(v);
    }
    const qs = new URLSearchParams(cleanParams).toString();
    const url = `https://slack.com/api/${endpoint}${qs ? "?" + qs : ""}`;
    const response = await runtime.fetch(url);
    if (!response.ok) {
      const txt = await response.text();
      return { _httpError: true, message: `HTTP ${response.status}: ${txt}` };
    }
    const data = await response.json();
    if (!data.ok) {
      return { _slackError: true, message: data.error || "unknown_slack_error", raw: data };
    }
    return data;
  },

  async _slackPostJson(endpoint, body) {
    const url = `https://slack.com/api/${endpoint}`;
    const response = await runtime.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const txt = await response.text();
      return { _httpError: true, message: `HTTP ${response.status}: ${txt}` };
    }
    const data = await response.json();
    if (!data.ok) {
      return { _slackError: true, message: data.error || "unknown_slack_error", raw: data };
    }
    return data;
  },

  // ───────────────────────────────────────────────────────────────
  // Conversations
  // ───────────────────────────────────────────────────────────────

  async conversationsInfo(channel) {
    const data = await this._slackGet("conversations.info", { channel });
    if (data._httpError || data._slackError) {
      return { content: [{ type: "text", text: `API Error: ${data.message}` }], isError: true };
    }
    const c = data.channel || {};
    const result = {
      id: c.id,
      name: c.name || null,
      isChannel: !!c.is_channel,
      isIm: !!c.is_im,
      isMpim: !!c.is_mpim,
      isPrivate: !!c.is_private,
      isMember: !!c.is_member,
      topic: c.topic?.value || "",
      purpose: c.purpose?.value || "",
      user: c.user || null, // for IMs, the other user
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },

  async conversationsHistory(channel, oldest, latest, limit, cursor) {
    const params = { channel };
    // Default: 24h ago
    if (oldest === undefined || oldest === null || oldest === "") {
      params.oldest = String(Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000));
    } else {
      params.oldest = String(oldest);
    }
    if (latest) params.latest = String(latest);
    params.limit = String(Math.min(limit || 100, 1000));
    if (cursor) params.cursor = cursor;

    const data = await this._slackGet("conversations.history", params);
    if (data._httpError || data._slackError) {
      return { content: [{ type: "text", text: `API Error: ${data.message}` }], isError: true };
    }

    const messages = (data.messages || []).map((m) => ({
      ts: m.ts,
      user: m.user || null,
      botId: m.bot_id || null,
      username: m.username || null, // for app/bot messages
      text: m.text || "",
      threadTs: m.thread_ts || null,
      replyCount: m.reply_count || 0,
      subtype: m.subtype || null,
      files: (m.files || []).map((f) => ({
        id: f.id,
        name: f.name,
        title: f.title,
        mimetype: f.mimetype,
        filetype: f.filetype,
        size: f.size,
        urlPrivate: f.url_private,
        thumb360: f.thumb_360 || null,
        permalink: f.permalink,
      })),
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          messages,
          hasMore: !!data.has_more,
          nextCursor: data.response_metadata?.next_cursor || null,
        }, null, 2),
      }],
    };
  },

  async conversationsReplies(channel, ts, limit, cursor) {
    const params = { channel, ts };
    if (limit) params.limit = String(Math.min(limit, 1000));
    if (cursor) params.cursor = cursor;
    const data = await this._slackGet("conversations.replies", params);
    if (data._httpError || data._slackError) {
      return { content: [{ type: "text", text: `API Error: ${data.message}` }], isError: true };
    }
    const messages = (data.messages || []).map((m) => ({
      ts: m.ts,
      user: m.user || null,
      text: m.text || "",
      threadTs: m.thread_ts || null,
    }));
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          messages,
          hasMore: !!data.has_more,
          nextCursor: data.response_metadata?.next_cursor || null,
        }, null, 2),
      }],
    };
  },

  // ───────────────────────────────────────────────────────────────
  // Users (cached)
  // ───────────────────────────────────────────────────────────────

  async usersInfo(user) {
    if (this._userCache[user]) {
      return { content: [{ type: "text", text: JSON.stringify(this._userCache[user], null, 2) }] };
    }
    const data = await this._slackGet("users.info", { user });
    if (data._httpError || data._slackError) {
      return { content: [{ type: "text", text: `API Error: ${data.message}` }], isError: true };
    }
    const u = data.user || {};
    const result = {
      id: u.id,
      teamId: u.team_id,
      name: u.name,
      realName: u.real_name || u.profile?.real_name || "",
      displayName: u.profile?.display_name || u.profile?.real_name || u.name,
      email: u.profile?.email || null,
      isBot: !!u.is_bot,
      deleted: !!u.deleted,
    };
    this._userCache[user] = result;
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },

  // ───────────────────────────────────────────────────────────────
  // Files
  // ───────────────────────────────────────────────────────────────

  async filesInfo(file) {
    const data = await this._slackGet("files.info", { file });
    if (data._httpError || data._slackError) {
      return { content: [{ type: "text", text: `API Error: ${data.message}` }], isError: true };
    }
    const f = data.file || {};
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          id: f.id,
          name: f.name,
          title: f.title,
          mimetype: f.mimetype,
          filetype: f.filetype,
          size: f.size,
          urlPrivate: f.url_private,
          permalink: f.permalink,
        }, null, 2),
      }],
    };
  },

  async filesDownload(urlPrivate, returnRawBase64) {
    if (typeof urlPrivate !== "string" || !urlPrivate.startsWith("https://files.slack.com/")) {
      return {
        content: [{ type: "text", text: "Error: url_private must be a https://files.slack.com/ URL" }],
        isError: true,
      };
    }

    // files.slack.com requires the bearer token (NOT skipAuth). The MCP
    // manager's allowed_domains permits files.slack.com per SKILL.md.
    const response = await runtime.fetch(urlPrivate, { responseFormat: "base64" });
    if (!response.ok) {
      const txt = await response.text();
      return { content: [{ type: "text", text: `Download failed: HTTP ${response.status} ${txt}` }], isError: true };
    }

    // runtime.fetch with responseFormat:"base64" returns the base64 string
    // as the response body. The microsoft_365_mcp.js download path (~line
    // 1117) uses the same pattern — verify against that file if this stops
    // working. The buildFetchResponse path in browser-mcp-manager.ts puts
    // the base64 in `body` and sets isBase64:true, which the sandbox-side
    // Response shim should expose via .text().
    let pureBase64;
    try {
      // 1. Try to read as arrayBuffer in case the shim supports it
      const buf = await response.clone().arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      pureBase64 = btoa(binary);
    } catch (e) {
      // 2. Fall back to text if arrayBuffer isn't supported
      let base64Text = await response.text();
      if (typeof base64Text === "string" && base64Text.startsWith("data:")) {
        base64Text = base64Text.split(",")[1] || base64Text;
      }
      pureBase64 = base64Text;
    }

    // 3. If the result is a raw binary string (e.g. proxy missed the MIME type), encode it locally
    if (typeof pureBase64 === "string" && pureBase64.length > 0 && !/^[A-Za-z0-9+/=\-_\r\n]+$/.test(pureBase64)) {
      try {
        pureBase64 = btoa(pureBase64); // Try strict latin1 encoding
      } catch (err) {
        try {
          pureBase64 = btoa(unescape(encodeURIComponent(pureBase64))); // Fallback for UTF-8 mangled strings
        } catch (err2) {
          const peek = pureBase64.substring(0, 100);
          return {
            content: [{ type: "text", text: `Download failed: body cannot be base64-encoded. Peek: ${peek}` }],
            isError: true,
          };
        }
      }
    }

    if (typeof pureBase64 !== "string" || pureBase64.length === 0) {
      return {
        content: [{ type: "text", text: `Download failed: empty response body.` }],
        isError: true,
      };
    }
    const size = Math.floor((pureBase64.length * 3) / 4);

    if (returnRawBase64 !== true) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "File downloaded. Raw base64 omitted to prevent context overflow.",
            size,
            hint: "Call again with returnRawBase64: true and pipe the base64 into a vision subtask via run_subtask({ image_data: [...] }).",
          }, null, 2),
        }],
      };
    }

    return {
      content: [
        { type: "text", text: `File data retrieved (${size} bytes).` },
        { type: "text", text: JSON.stringify({ base64: pureBase64, size }) },
      ],
    };
  },

  // ───────────────────────────────────────────────────────────────
  // Posting (guarded)
  // ───────────────────────────────────────────────────────────────

async chatPostMessage(channel, text, threadTs) {
    // Koi's built-in tool-confirmation dialog (§8.1) prompts the user to
    // Accept/Reject this call before it reaches the MCP. By the time we
    // run, the post is already approved.
    const body = { channel, text };
    if (threadTs) body.thread_ts = threadTs;

    const data = await this._slackPostJson("chat.postMessage", body);
    if (data._httpError || data._slackError) {
      return { content: [{ type: "text", text: `API Error: ${data.message}` }], isError: true };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          posted: true,
          channel: data.channel,
          ts: data.ts,
          permalink: null, // chat.postMessage doesn't return a permalink directly
        }, null, 2),
      }],
    };
  },

  // ───────────────────────────────────────────────────────────────
  // Fetch-state tracking (module scope, persists across turns)
  // ───────────────────────────────────────────────────────────────

  getFetchState(channel) {
    const state = this._fetchState[channel] || null;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ state, lastActiveChannel: this._lastActiveChannel }),
      }],
    };
  },

  setFetchState(channel, latestTs, threadTs) {
    if (typeof channel !== "string" || channel === "") {
      return { content: [{ type: "text", text: "Error: channel required" }], isError: true };
    }
    if (typeof latestTs !== "string" || latestTs === "") {
      return { content: [{ type: "text", text: "Error: latestTs required" }], isError: true };
    }
    this._fetchState[channel] = {
      latestTs,
      threadTs: threadTs || null,
    };
    this._lastActiveChannel = channel;
    return {
      content: [{ type: "text", text: JSON.stringify({ stored: true }) }],
    };
  },

  clearFetchState() {
    this._fetchState = {};
    this._lastActiveChannel = null;
    return {
      content: [{ type: "text", text: JSON.stringify({ cleared: true }) }],
    };
  },

  // ───────────────────────────────────────────────────────────────
  // Auth identity (cached)
  // ───────────────────────────────────────────────────────────────

  async authTest() {
    if (this._authCache !== null) {
      return { content: [{ type: "text", text: JSON.stringify(this._authCache) }] };
    }
    const data = await this._slackGet("auth.test", {});
    if (data._httpError || data._slackError) {
      return { content: [{ type: "text", text: `API Error: ${data.message}` }], isError: true };
    }
    // auth.test returns { ok, url, team, user, team_id, user_id, ... }
    // It does NOT return display_name, so we follow up with users.info
    // to get the proper display name. Both calls are cached together.
    let displayName = data.user || null;
    let realName = null;
    if (data.user_id) {
      const userRes = await this.usersInfo(data.user_id);
      if (!userRes.isError) {
        try {
          const u = JSON.parse(String(userRes.content[0].text));
          displayName = u.displayName || u.realName || data.user;
          realName = u.realName || null;
        } catch (_) {}
      }
    }
    this._authCache = {
      userId: data.user_id || null,
      teamId: data.team_id || null,
      userName: data.user || null,
      displayName,
      realName,
      team: data.team || null,
    };
    return { content: [{ type: "text", text: JSON.stringify(this._authCache) }] };
  },
};
