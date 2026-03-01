---
name: google-workspace
version: 2.1.0
description: Comprehensive Google Workspace MCP - Drive, Sheets, Docs, Slides, Gmail, Calendar. Write operations restricted to agent-created files via guardrail.
url-patterns:
  - "https://docs.google.com/spreadsheets/*"
  - "https://sheets.googleapis.com/*"
  - "https://docs.google.com/document/*"
  - "https://docs.google.com/presentation/*"
  - "https://drive.google.com/*"
  - "https://mail.google.com/*"
  - "https://calendar.google.com/*"
allowed-tools:
  - sheets_read_range
  - sheets_write_range
  - sheets_create
  - sheets_list
  - sheets_get_metadata
  - sheets_batch_update
  - sheets_clear_range
  - sheets_get_urls
  - sheets_read_as_csv
  - docs_create
  - docs_batch_update
  - docs_get_metadata
  - docs_read_content
  - docs_get_images
  - docs_get_urls
  - slides_create
  - slides_batch_update
  - slides_get_metadata
  - slides_read_content
  - slides_get_urls
  - drive_list
  - drive_search
  - drive_get_file_metadata
  - gmail_search
  - gmail_get_message
  - gmail_list_labels
  - gmail_get_thread
  - calendar_list
  - calendar_get_events
  - calendar_get_event
mcp-servers:
  - name: google_workspace
    script: mcp/google_workspace_mcp.js
    scopes:
      - https://www.googleapis.com/auth/spreadsheets
      - https://www.googleapis.com/auth/drive
      - https://www.googleapis.com/auth/documents
      - https://www.googleapis.com/auth/presentations
      - https://www.googleapis.com/auth/gmail.readonly
      - https://www.googleapis.com/auth/calendar.readonly
guardrails: scripts/guardrail.js
---

# Google Workspace Skill

Comprehensive Google Workspace integration covering Drive, Sheets, Docs, Slides, Gmail, and Calendar.

## Security: Write Guardrail

Write/mutate tools (`sheets_write_range`, `sheets_batch_update`, `sheets_clear_range`, `docs_batch_update`, `slides_batch_update`) are protected by `guardrail.js`. They can **only** operate on files created by this agent session (via `sheets_create`, `docs_create`, `slides_create`). Attempting to write to a pre-existing file will be blocked with an explanation.

Read tools work on any file the user has access to — no restrictions.

## Available Tools

### Google Drive (read-only)

- `drive_list` - List/filter files with pagination
- `drive_search` - Full-text search across Drive
- `drive_get_file_metadata` - Get file details (name, type, owners, URL)

### Google Sheets (CRUD on own files, read on all)

- `sheets_list` - List recent spreadsheets
- `sheets_create` - Create a new spreadsheet
- `sheets_get_metadata` - Get spreadsheet tabs/structure
- `sheets_read_range` - Read cell range (with pagination)
- `sheets_read_as_csv` - Read range as CSV text (with pagination)
- `sheets_write_range` - Write data to a range (own files only)
- `sheets_batch_update` - Batch operations: add/delete sheets, format, merge (own files only)
- `sheets_clear_range` - Clear values from a range (own files only)
- `sheets_get_urls` - Extract all hyperlinks from a range

### Google Docs (CRUD on own files, read on all)

- `docs_create` - Create a new blank document
- `docs_batch_update` - Batch edit a doc: insert text, styles, images, tables (own files only)
- `docs_get_metadata` - Get doc title, tabs, revision
- `docs_read_content` - Read tab text content (with char-offset pagination)
- `docs_get_images` - Extract inline images with content URIs
- `docs_get_urls` - Extract all hyperlinks

### Google Slides (CRUD on own files, read on all)

- `slides_create` - Create a new blank presentation
- `slides_batch_update` - Batch edit a presentation: add slides, text, images (own files only)
- `slides_get_metadata` - Get presentation metadata and slide list
- `slides_read_content` - Read slide text and image inventory (with slide-range pagination). Each slide includes any embedded images with contentUrl for downloading via `gsuite_download_image`.
- `slides_get_urls` - Extract all hyperlinks

### Gmail (read-only)

- `gmail_search` - Search messages with Gmail query syntax
- `gmail_get_message` - Get full message content
- `gmail_list_labels` - List all labels
- `gmail_get_thread` - Get all messages in a thread

### Google Calendar (read-only)

- `calendar_list` - List accessible calendars
- `calendar_get_events` - Get events with time range/search/pagination
- `calendar_get_event` - Get single event details

## All results include source URLs pointing to the original Google Workspace documents.
