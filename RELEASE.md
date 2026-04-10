# Release 1.0.12
1. Add Slack skill
2. Make dom-interactor handle acquisition CSP-safe

# Release 1.0.11

1. Add Google Meet Skill
1. Add Zoom Meeting Skill
3. Enhance Google workspace OAuth flow for secondary accounts.
4. Fix bug in Google workspace and Windows 365 guardrail: LLM can not update files created by itself.

# Release 1.0.10

1. UI Improvements: replaced raw tool call messages with customized display messages.
2. Enhance visual workspace images management to support long lasting visual conversations.
3. UI Improvements: add banner to notify user to allow access to file URLs when user trying to read local files.
4. Blocking wait for user action when call `request_action`, if the element is found.
5. Issue fixed: making `evaluate_script` context (Iframe, shadow DOM) aware.
6. Removed `acquireHandle` tool, replaced by MCP scripts using `evaluateScript` directly.
