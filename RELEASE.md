# Release 03/22/2026

1. Add Google Meet Skill
2. Fix bug in Google workspace and Windows 365 guardrail: LLM can not update files created by itself.
3. Update global guardrail and system reminder for OAuth expired failure.

# Release 1.0.10

1. UI Improvements: replaced raw tool call messages with customized display messages.
2. Enhance visual workspace images management to support long lasting visual conversations.
3. UI Improvements: add banner to notify user to allow access to file URLs when user trying to read local files.
4. Blocking wait for user action when call `request_action`, if the element is found.
5. Issue fixed: making `evaluate_script` context (Iframe, shadow DOM) aware.
6. Removed `acquireHandle` tool, replaced by MCP scripts using `evaluateScript` directly.
