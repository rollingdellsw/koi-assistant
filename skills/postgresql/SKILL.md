---
name: postgresql
version: 1.0.0
description: Shared PostgreSQL access via Gateway

mcp-servers:
  - name: postgres
    type: remote
    gateway: default
    server: postgres

allowed-tools:
  - run_browser_script
---

# PostgreSQL Provider

This skill provides SQL query capabilities to other skills.
