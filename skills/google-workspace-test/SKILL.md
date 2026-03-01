---
name: google-workspace-test
version: 1.1.0
description: Comprehensive stress test for Google Workspace integration (Docs, Sheets, Slides, Calendar, GMail)

mcp-servers:
  - name: google_workspace
    type: local
    script: mcp/google_workspace_mcp.js
    scopes:
      - https://www.googleapis.com/auth/spreadsheets
      - https://www.googleapis.com/auth/drive

allowed-tools:
  - run_browser_script
  - sheets_create
  - sheets_write_range
  - sheets_read_range
  - sheets_batch_update
  - sheets_get_metadata
  - sheets_get_urls
  - sheets_read_as_csv
---

# Google Workspace Test

This skill runs a comprehensive validation suite against the Google Workspace MCP implementation.

## Usage

Run the test script directly:
`read_skill("google-sheets-test")`
`run_browser_script("google-workspace-test:scripts/sheets-crud-test.js")`
`run_browser_script("google-workspace-test:scripts/docs-comprehensive-test.js")`
`run_browser_script("google-workspace-test:scripts/slides-comprehensive-test.js")`

## Coverage

1. **Creation**: Creates new spreadsheet
2. **Structure**: Adds new tabs via batchUpdate
3. **Data**: Writes mixed data types (Strings, Numbers, Booleans)
4. **Metadata**: Verifies hyperlinks and formulas
5. **Scale**: Writes 100+ rows and verifies via pagination
6. **Export**: Verifies CSV generation
