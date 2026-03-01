---
name: outlook-email-summarizer
version: 1.0.0
description: Orchestrates fetching Outlook emails and safely reading large attachments (PDFs, images, OneDrive links) using sub-agents to prevent context overflow.
runnable: true

allowed-tools:
  - run_browser_script
  - run_subtask
  - new_page
---

# Outlook Email Summarizer Skill

This skill provides an isolated browser script to safely process Outlook emails and delegate attachment summarization.

Instead of calling `outlook_get_message` and `outlook_get_attachment` manually, simply call:
`run_browser_script({ script_path: "outlook-email-summarizer:scripts/analyze.js", args: [url_or_messageId] })`

The script will automatically:

1. Parse the Outlook Web URL to extract the message ID, or resolve it via search using the browser tab title.
2. Fetch the full email via `outlook_get_message` (body, attachments, metadata).
3. Download PDF attachments via `returnRawBase64: true`, load into the PDF skill, and spawn a sub-agent to summarize.
4. Download image attachments as base64 and include them in the result for visual analysis by the main LLM.
5. Detect OneDrive/SharePoint linked files in the email body and spawn sub-agents to read them.
6. Return the email body, all attachment summaries, and images to the main LLM for final synthesis.
