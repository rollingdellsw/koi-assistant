---
name: pdf
description: Load and read PDF documents from URLs, the active browser tab, or base64 data. Supports text extraction, visual page rendering, full-text search, and hyperlink extraction.
url-patterns:
  - "*.pdf"
  - "*://*/*.pdf*"
  - "file:///**/*.pdf"
mcp-servers:
  - name: pdf
    script: mcp/pdf_mcp.js
---

# PDF Reader

Read PDF documents with smart text + image extraction.

## Tools

| Tool            | Purpose                                                                     |
| --------------- | --------------------------------------------------------------------------- |
| `pdf_load`      | Load a PDF from URL, base64, or active tab. Returns a handle + metadata.    |
| `pdf_read`      | Read pages — returns text always, plus images when visual content detected. |
| `pdf_search`    | Full-text search across all pages. Use on large docs before reading.        |
| `pdf_get_links` | Extract hyperlinks from pages.                                              |
| `pdf_release`   | Free memory when done.                                                      |

## Workflow

### Small PDF (< 10 pages)

1. `pdf_load` → get handle + page count
2. `pdf_read` all pages

### Large PDF (10+ pages)

1. `pdf_load` → get handle + page count
2. `pdf_search` for relevant terms → get page numbers
3. `pdf_read` only the matching pages

### From Active Tab

If the user has a PDF open in their browser:

1. `pdf_load({ activeTab: true })`
2. Read/search as above

### From Gmail Attachment

1. Get attachment data (base64) from Gmail
2. `pdf_load({ base64: attachmentData })`
3. Read/search as above

## Notes

- `pdf_read` automatically renders page images when visual content is detected (charts, figures, sparse text). No need to request images explicitly.
- Page numbers are 1-based.
- Handles persist for the session. Call `pdf_release` when done to free memory.
- For very large PDFs, always search before reading to avoid loading unnecessary pages.
