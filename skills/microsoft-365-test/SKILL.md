---
name: microsoft-365-test
version: 1.0.0
description: Test suite for Microsoft 365 skill — OneDrive, Excel, Word, PowerPoint, Outlook, Calendar. Mirrors the google-workspace-test structure.
url-patterns:
  - "https://outlook.office.com/*"
  - "https://onedrive.live.com/*"
  - "https://*.sharepoint.com/*"
depends-on:
  - microsoft-365
---

# Microsoft 365 Test Suite

Automated test scripts for the Microsoft 365 skill. Mirrors the Google Workspace test suite structure.

## Scripts

| Script                       | Coverage                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onedrive-test.js`           | `onedrive_list`, `onedrive_search`, `onedrive_get_file_metadata`, `excel_list`                                                                                                         |
| `excel-crud-test.js`         | `excel_create`, `excel_get_metadata`, `excel_read_range`, `excel_read_as_csv`, `excel_write_range`, `excel_batch_update`, `excel_clear_range`                                          |
| `word-comprehensive-test.js` | `word_create`, `word_get_metadata`, `word_read_content`, `word_batch_update`                                                                                                           |
| `ppt-comprehensive-test.js`  | `ppt_create`, `ppt_get_metadata`, `ppt_read_content`, `ppt_batch_update`                                                                                                               |
| `outlook-calendar-test.js`   | `outlook_search`, `outlook_get_message`, `outlook_list_folders`, `outlook_get_thread`, `outlook_get_attachment`, `ms_calendar_list`, `ms_calendar_get_events`, `ms_calendar_get_event` |
| `guardrail-negative-test.js` | Guardrail deny path, error handling for bad IDs, `excel_clear_range` on own file                                                                                                       |
| `run-all.js`                 | Runs all tests sequentially                                                                                                                                                            |

## Usage

```
/skill microsoft-365-test/scripts/run-all.js --full-auto
/skill microsoft-365-test/scripts/excel-crud-test.js --full-auto
/skill microsoft-365-test/scripts/onedrive-test.js --full-auto
```
