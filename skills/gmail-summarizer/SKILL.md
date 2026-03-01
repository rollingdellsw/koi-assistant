---
name: gmail-summarizer
version: 1.0.0
description: Orchestrates fetching gmails and safely reading large attachments (like PDFs) using sub-agents to prevent context overflow.
runnable: true

allowed-tools:
  - run_browser_script
  - run_subtask
---

# Email Summarizer Skill

This skill provides an isolated browser script to safely process gmails and delegate attachment summarization.

Instead of calling `gmail_get_message` and `pdf_read` manually, simply call:
`run_browser_script({ script_path: "gmail-summarizer:scripts/analyze.js", args: [url] })`

The script will automatically:

1. Parse the Gmail URL to find the actual Message ID (resolving UI hashes automatically).
2. Download any PDF attachments via `returnRawBase64: true` and load them into memory.
3. Spawn a sub-agent (`run_subtask`) to read and summarize the PDF using the memory handle.
4. Return the email body and the sub-agent's summary to the main LLM for final synthesis.
