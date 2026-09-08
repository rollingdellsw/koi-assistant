---
name: pdf
description: Load and read PDF documents from URLs, the active browser tab, or base64 data. Supports text extraction, visual page rendering, page-by-page viewing, full-text search, and hyperlink extraction.
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

| Tool             | Purpose                                                                     |
| ---------------- | --------------------------------------------------------------------------- |
| `pdf_load`       | Load a PDF from URL, base64, or active tab. Returns a handle + metadata.    |
| `pdf_read`       | Read pages — returns text always, plus images when visual content detected. |
| `pdf_page_image` | Render one page to an image. Use when text can't be trusted.                |
| `pdf_search`     | Full-text search across all pages. Use on large docs before reading.        |
| `pdf_get_links`  | Extract hyperlinks from pages.                                              |
| `pdf_release`    | Free memory when done.                                                      |

## Workflow

### Small PDF (< 10 pages)

1. `pdf_load` → get handle + page count
2. `pdf_read` all pages

### Large PDF (10+ pages)

1. `pdf_load` → get handle + page count
2. `pdf_search` for relevant terms → get page numbers
3. `pdf_read` only the matching pages

### Charts, Figures, and Anything Visual

Extracted text is a lossy view of a page. A bar chart becomes a scatter of
numbers with no axes; a two-column layout interleaves; a scanned page yields
nothing. When the answer depends on what the page _looks like_, look at it:

1. `pdf_search` (or `pdf_read`) to find the page
2. `pdf_page_image({ handle, page: N })` → rendered image + text
3. To read a dense figure, crop rather than raising resolution:
   `pdf_page_image({ handle, page: N, region: { x: 0, y: 0.5, width: 0.5, height: 0.5 } })`

**Images cost context.** Resolution tiers match `takeScreenshot`: `low` (480px,
the default, ~1k tokens), `medium` (1280px), `high` (1920px). A `low` crop of
one figure is both cheaper and more legible than a whole page at `high`, so
crop first and raise the tier only if it is genuinely unreadable. `pdf_read`
with `renderImages` is capped at 3 pages for the same reason.

Rendering happens offscreen from the loaded document — it does **not** scroll or
navigate the user's tab, and it works on PDFs that were never open in one.

To flip through a document, `page` also accepts `"next"`, `"prev"`, `"first"`,
`"last"`, or a relative offset like `"+3"`.

### From Active Tab

If the user has a PDF open in their browser:

1. `pdf_load({ activeTab: true })`
2. Read/search as above

Chrome's **native PDF viewer exposes no scriptable DOM**, so `activeTab` cannot
see a `file://` PDF or a plugin-rendered one. When it fails it says so and names
the fallback: re-call `pdf_load` with the explicit `url` (the tab URL is in your
context). Prefer `url` outright when you already have it.

### From Gmail Attachment

1. Get attachment data (base64) from Gmail
2. `pdf_load({ base64: attachmentData })`
3. Read/search as above

## Notes

- `pdf_read` renders page images only when `renderImages: true` **and** its heuristic fires (embedded image XObjects or sparse text). Vector-drawn charts on a text-heavy page will not trigger it — use `pdf_page_image` when you need to be certain you get an image.
- `pdf_page_image` never skips rendering. Prefer it over trusting extracted numbers from a graph.
- **Trust the `textQuality` flag.** A subset font with no ToUnicode CMap makes
  pdf.js return raw glyph codes — text that looks like `=<6>?J+B:F>*:</` rather
  than words. Pages like that come back with `textQuality: "suspect"` and a
  `letterRatio`. Never quote or summarize flagged text: call `pdf_page_image`
  on that page and read the image. Only part of a page may be affected, so
  prose elsewhere on the same page can still be perfectly good.
- All tools here are read-only: they never move, scroll, or navigate the user's tab.
- Page numbers are 1-based.
- Handles persist for the session. Call `pdf_release` when done to free memory.
- For very large PDFs, always search before reading to avoid loading unnecessary pages.
