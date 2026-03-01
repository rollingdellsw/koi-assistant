---
name: visual-conversation-test
description: Test skill for visual workspace functionality - validates selection, overlay, annotations, and image stack operations
version: 1.0.0
parameters:
  - name: url
    description: URL to navigate to for testing (e.g., cnn.com)
    required: true
  - name: rounds
    description: Number of selection rounds to perform
    default: "3"
allowed-tools:
  - navigate_page
  - scroll_viewport
  - take_screenshot
  - run_browser_script
  - prompt_user_selection
  - show_workspace_overlay
  - hide_workspace_overlay
  - add_workspace_annotation
  - get_image_stack
  - get_workspace_state
  - highlight_element
  - clear_highlight
---

# Visual Conversation Test Skill

This skill tests the visual workspace functionality of the browser extension.

## Test Flow

1. Navigate to a specified URL
2. Prompt user to select regions and add annotations
3. Verify annotation data is captured correctly
4. Test LLM adding annotations
5. Test minimize/restore workflow
6. Test image stack with multiple captures
7. Test reloading workspace and appending annotations

## Usage

```
/skill visual-conversation-test/scripts/main.js --url cnn.com --full-auto
```

## Test Coverage

- [ ] User selection capture
- [ ] Overlay display
- [ ] User annotations
- [ ] LLM annotations
- [ ] Minimize/restore
- [ ] Image stack management
- [ ] Workspace state persistence
