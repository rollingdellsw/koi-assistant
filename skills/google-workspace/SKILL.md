---
name: google-workspace
version: 2.1.2
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
  - gsuite_download_image
  - slides_create
  - slides_batch_update
  - slides_get_metadata
  - slides_read_content
  - slides_get_urls
  - slides_get_thumbnail
  - drive_list
  - drive_search
  - drive_get_file_metadata
  - drive_render_page
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
    oauth:
      authority: https://accounts.google.com/o/oauth2/v2/auth
      client_id: 474535101182-poobgugcnom698jmuq6o0io9376el2jl.apps.googleusercontent.com
      allowed_domains:
        - googleapis.com
        # The Slides thumbnail endpoint (slides_get_thumbnail) and image
        # content URLs resolve to short-lived signed CDN hosts such as
        # lh7-us.googleusercontent.com / lh7-rt.googleusercontent.com.
        # Without this, the JSON call succeeds but the image fetch is
        # blocked ("Domain not in allowed_domains").
        - googleusercontent.com
---

# Google Workspace Skill

Comprehensive Google Workspace integration covering Drive, Sheets, Docs, Slides, Gmail, and Calendar.

## Security: Write Guardrail

Write/mutate tools (`sheets_write_range`, `sheets_batch_update`, `sheets_clear_range`, `docs_batch_update`, `slides_batch_update`) are protected by `guardrail.js`. They can **only** operate on files created by this agent session (via `sheets_create`, `docs_create`, `slides_create`). Attempting to write to a pre-existing file will be blocked with an explanation.

Read tools work on any file the user has access to — no restrictions.

## Reading Visual Content

The text APIs see text runs and embedded rasters. They do **not** see native
charts, linked Sheets charts, Drawings, equations, or the geometry of a table or
a slide layout. When a question turns on any of those, read the text _and_ look
at the page:

- **Slides** — `slides_get_thumbnail({ presentationId, slideIndex })`. One call,
  no export, renders exactly what the slide looks like. Prefer it over
  `drive_render_page` for any presentation.
- **Docs and Sheets** — `drive_render_page({ fileId, page })`. Google exports the
  file to PDF with its own renderer and the page is rasterized, so page numbers
  match what the user sees on screen. The response reports `totalPages`,
  `prevPage`, and `nextPage` for paging through.
- **Zooming in** — pass `region` in normalized 0-1 page coordinates to crop. The
  pixel budget is spent on the crop, so a small region comes back sharper. Supported
  by both `drive_render_page` and `slides_get_thumbnail`:
  `drive_render_page({ fileId, page: 3, region: { x: 0, y: 0.5, width: 0.5, height: 0.5 } })`
  `slides_get_thumbnail({ presentationId, slideIndex: 3, region: { x: 0, y: 0.5, width: 0.5, height: 0.5 } })`

**Images cost context.** Resolution tiers match `takeScreenshot`: `low` (480px,
the default, ~1k tokens), `medium` (1280px), `high` (1920px), `original`
(uncapped). A `low` crop of one chart is both cheaper and more legible than a
whole page at `high`, so crop first and raise the tier only when the crop is
genuinely unreadable.

Text remains the source of truth for prose and numbers — `docs_read_content` and
`sheets_read_range` are exact, and a render is not. Use the render for what the
text cannot express, and do not transcribe body text out of an image when a text
tool can return it.

**Text APIs return element order, not visual order.** `slides_read_content`
returns text runs in the presentation's internal element order — not
left-to-right, top-to-bottom layout order. On slides with several text boxes
(e.g. a heading plus per-column captions), a caption can appear _before_ the
heading it belongs to, and bio/description text can be mis-attributed to the
wrong name. When which text goes with which person, date, or column matters,
confirm the layout with `slides_get_thumbnail`.

Exports are cached for five minutes per file, so paging through a document does
not re-export it. Drive refuses to export files over ~10MB.

## Available Tools

### Google Drive (read-only)

- `drive_list` - List/filter files with pagination
- `drive_search` - Full-text search across Drive
- `drive_get_file_metadata` - Get file details (name, type, owners, URL)
- `drive_render_page` - Render one page of a Doc/Sheet/Slides file as an image (see Reading Visual Content)

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
- `slides_get_thumbnail` - Render a single slide as an image (see Reading Visual Content)

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
