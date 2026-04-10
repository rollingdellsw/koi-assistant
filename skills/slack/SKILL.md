---
name: slack
version: 0.1.0
description: Slack co-pilot. Auto-loads on app.slack.com — reads the active conversation, helps the user discuss it, draft replies, and post on their behalf.
url-patterns:
  - "https://app.slack.com/client/*"
allowed-tools:
  - run_browser_script
  - run_subtask
  - listPages
  - navigatePage
  - slack_parse_channel_url
  - slack_conversations_info
  - slack_conversations_history
  - slack_conversations_replies
  - slack_users_info
  - slack_files_info
  - slack_files_download
  - slack_chat_post_message
  - slack_auth_test
  - slack_get_fetch_state
  - slack_set_fetch_state
  - slack_clear_fetch_state
mcp-servers:
  - name: slack
    type: local
    script: mcp/slack_mcp.js
    oauth:
      authority: https://slack.com/oauth/v2/authorize
      token_endpoint: https://slack.com/api/oauth.v2.access
      client_id: "10888455083809.10888469271985"
      response_type: code
      pkce: true
      # Slack returns the user token nested under authed_user.access_token,
      # not at the top-level access_token (which is the bot token).
      token_field: authed_user.access_token
      expires_field: authed_user.expires_in
      extra_params:
        # Slack uses "user_scope" for user-token scopes; the standard "scope"
        # param is for bot scopes. We pass user_scope as the same scope list.
        user_scope: channels:history,groups:history,im:history,mpim:history,channels:read,groups:read,im:read,mpim:read,users:read,files:read,chat:write
      allowed_domains:
        - slack.com
        - files.slack.com
guardrails: scripts/guardrail.js
pre-send-hook: scripts/pre_send.js
reminders:
  - id: "slack:auto-fetch-context"
    trigger:
      type: "always"
    content: |
      The slack skill is active. The user is viewing a Slack conversation
      in their browser. On every user turn, your first action is to call:

        run_browser_script({
          script_path: "slack:scripts/analyze.js",
          args: []
        })

      The script tracks its own state across turns via the MCP server's
      module scope — you do not need to pass anything. It fetches the
      last 24h on the first call and only new messages on later calls.
      If the user switches channels or navigates to a thread view, it
      detects that automatically and does a fresh fetch. To force a
      full re-fetch, pass args: ["force_fresh"].

      The guardrail blocks @channel / @here / @everyone in drafts. If
      the user explicitly asks for a broadcast, ask them to confirm
      in chat first, then retry without the literal mention syntax.

      If the URL points at a specific thread, the script returns that thread's messages.
      Threads in channel view are NOT auto-expanded. If a message says "(has X replies)"
      and the user asks about it, use `slack_conversations_replies` to fetch the thread.

      Images are lazy-loaded. If you need to know what an image contains, call:
        run_browser_script({
          script_path: "slack:scripts/analyze_image.js",
          args: ["<fileId>"]
        })

      Outcomes:
        { success: true, empty: true } — No new messages. Respond from
          the context you already have.
        { success: true, messages: [...] } — New activity. Use it as
          context for whatever the user asks.
        { success: false, error: "..." } — Tell the user what went wrong.

      Posting: When the user asks you to send a reply, do NOT preview the draft in chat. Instead, call:
        run_browser_script({
          script_path: "slack:scripts/post.js",
          args: ["<channelId>", "<draft text>", "<optional thread_ts>"]
        })
      This script will automatically navigate the user to the correct channel and present the draft for their approval.
    strategy: "persistent"
    priority: "high"
  - id: "slack:post-rejected"
    trigger:
      type: "tool_result"
      toolName: "slack_chat_post_message"
      success: false
      outputPattern: "User rejected the "
    content: |
      User rejected the post. Do not retry sending the same draft.
      Ask the user what they'd like to change, or move on.
    strategy: "one_shot"
    priority: "high"
---

# Slack

This skill is a Slack co-pilot that activates whenever the user has a Slack
conversation open in their browser. It reads the current channel or DM and
helps the user discuss it, draft replies, and post messages.

## Workflow

On every user message, your first action is to refresh context:

    run_browser_script({
      script_path: "slack:scripts/analyze.js",
      args: []
    })

The script tracks its own state across turns via the MCP server's
module scope — you do not need to pass anything. It fetches the last
24h on the first call and only new messages on later calls. If the
user switches channels or navigates to a thread view, it detects that
automatically and does a fresh fetch. To force a full re-fetch, pass
`args: ["force_fresh"]`.

The result includes a `me` field identifying the signed-in user.

## Sending replies

When the user asks to reply, do NOT preview the draft. Call the wrapper script:
run_browser_script({
script_path: "slack:scripts/post.js",
args: ["<channelId>", "<draft text>", "<optional thread_ts>"]
})
