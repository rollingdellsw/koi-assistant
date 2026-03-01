---
name: microsoft-365
version: 1.0.0
description: Microsoft 365 integration — Outlook Mail, OneDrive, Word/Excel/PowerPoint Online, Calendar. Uses Microsoft Graph API. Write operations restricted to agent-created files via guardrail.
url-patterns:
  - "https://outlook.office.com/*"
  - "https://outlook.live.com/*"
  - "https://*.sharepoint.com/*"
  - "https://onedrive.live.com/*"
  - "https://graph.microsoft.com/*"
  - "https://*.office.com/*"
allowed-tools:
  # OneDrive
  - onedrive_list
  - onedrive_search
  - onedrive_get_file_metadata
  - onedrive_download_text
  - onedrive_resolve_link
  # Excel Online
  - excel_list
  - excel_create
  - excel_get_metadata
  - excel_read_range
  - excel_read_as_csv
  - excel_write_range
  - excel_batch_update
  - excel_clear_range
  # Word Online
  - word_create
  - word_get_metadata
  - word_read_content
  - word_batch_update
  - word_get_images
  - word_download_image
  # PowerPoint Online
  - ppt_create
  - ppt_get_metadata
  - ppt_read_content
  - ppt_batch_update
  - ppt_download_image
  # Outlook Mail
  - outlook_search
  - outlook_get_message
  - outlook_list_folders
  - outlook_get_thread
  - outlook_get_attachment
  # Calendar
  - ms_calendar_list
  - ms_calendar_get_events
  - ms_calendar_get_event
mcp-servers:
  - name: microsoft_365
    script: mcp/microsoft_365_mcp.js
    oauth:
      authority: https://login.microsoftonline.com/common/oauth2/v2.0
      client_id: "75fa222a-47ad-44d9-8925-98eca21e1d1c"
      allowed_domains:
        - graph.microsoft.com
        - "*.files.1drv.com"
        - "*.sharepoint.com"
        - "*.microsoftpersonalcontent.com"
    scopes:
      - https://graph.microsoft.com/Mail.Read
      - https://graph.microsoft.com/Files.ReadWrite.All
      - https://graph.microsoft.com/Calendars.Read
      - https://graph.microsoft.com/User.Read
guardrails: scripts/guardrail.js
---

# Microsoft 365 Skill

Microsoft 365 integration via Microsoft Graph API. Covers OneDrive, Excel Online, Word Online, PowerPoint Online, Outlook Mail, and Calendar.

## Security: Write Guardrail

Write/mutate tools (`excel_write_range`, `excel_batch_update`, `excel_clear_range`, `word_batch_update`, `ppt_batch_update`) are protected by `guardrail.js`. They can **only** operate on files created by this agent session (via `excel_create`, `word_create`, `ppt_create`). Attempting to write to a pre-existing file will be blocked.

Read tools work on any file the user has access to — no restrictions.

## Visual Tools & Screenshots

Never use `take_screenshot` or visual subtasks (like `run_subtask`) to read the contents of documents, spreadsheets, or emails. You MUST rely exclusively on the API tools (e.g., `word_read_content`, `excel_read_range`) for data extraction. Vision models often hallucinate dense text from screenshots. If the API fails, report the error directly rather than falling back to visual reading.

To fully summarize a document with images: call word_read_content for text, call word_get_images to list embedded images, then selectively call word_download_image for relevant ones.

## Setup

1. Configure your Microsoft Azure App Client ID in Extension Settings → Microsoft 365
2. On first use, you'll be prompted to sign in with your Microsoft account
3. Required permissions are requested automatically (Mail.Read, Files.ReadWrite.All, Calendars.Read)

## PowerPoint: Reading Slides Efficiently

When the user asks about "this slide" or "the current slide", explicitly inform them that you cannot detect the currently active slide in PowerPoint Online.
Ask the user to provide the exact slide number they want to interact with.

`ppt_read_content` returns both text and an image inventory per slide (image names and sizes). To view actual image content, call `ppt_download_image` with the image name(s) from the read output. Multiple images can be fetched in one call using comma-separated names.

Never read all slides just to answer a question about a single slide. Use the range parameters to minimize token usage.

For large decks (20+ slides), always paginate reads using startSlide/endSlide rather than reading the whole deck at once.

## Extracting IDs from URLs

When reading URLs from personal OneDrive (onedrive.live.com), the `id` or `resid` parameter usually looks like `F149FA8C0789C155!158`.

- The entire string (`F149FA8C0789C155!158`) is the `itemId`.
- The part before the `!` (`F149FA8C0789C155`) is the `driveId`.

Always parse and pass both parameters to the API tools to avoid 400 errors. Do not use `onedrive_resolve_link` on `onedrive.live.com/edit` URLs, as the Graph API will reject them with a 403.
