---
name: db-to-gsheet-report
version: 1.0.0
description: Export PostgreSQL data to Google Sheets using shared MCP skills
runnable: true

parameters:
  - name: table_name
    description: Name of the table to query
    required: true
    default: "sessions"
  - name: limit
    description: Max rows to fetch (default 50)
    required: false
    default: "50"
  - name: sheet_title
    description: Title for the generated Google Sheet
    required: false
    default: "Sessions Export Test"
  - name: max_cell_length
    description: Truncate message size to fit into cell
    required: false
    default: "200"

allowed-tools:
  - run_browser_script
---

# Sessions Report Generator

Orchestrates `postgresql` and `google-wrokspace` skills to generate reports.

## Usage

```javascript
// 1. Run the integration test
run_browser_script({
  script_path: "db-to-gsheet-report:scripts/main.js",
});
```
