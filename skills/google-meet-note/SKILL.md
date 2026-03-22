---
name: google-meet-notes
description: Privacy-first meeting capture using in-browser DOM polling. Captures live Google Meet captions to generate a private, draft summary for human review.
runnable: true
parameters:
  - name: action
    description: "reserved for future use"
    required: false
    default: ""
prerequisites:
  - "Enable Closed Captions (CC) — click the **CC** button at the bottom of the Google Meet window"
url-patterns:
  - "https://meet.google.com/*"
allowed-tools:
  - run_browser_script
  - listPages
  - searchDom
  - takeSnapshot
  - calendar_get_events
  - docs_create
  - docs_batch_update
reminders:
  - id: "meet:capture-active"
    trigger:
      type: "tool_call"
      toolName: "run_browser_script"
    content: |
      Caption capture is running inside the blocking script. Wait for the script to
      return — it will detect when the meeting ends automatically. Do not make
      additional calls until the script completes.
    strategy: "sticky"
    priority: "high"
---

# Google Meet Notes

This skill acts as a privacy-first Executive Assistant. It captures lossy, real-time meeting captions via the browser and returns raw data for you to process into a coherent, private draft for the user to review.

🚨 **CRITICAL INSTRUCTION FOR THE AI AGENT:** 🚨
**DO NOT** attempt to manually read the DOM, take screenshots, click buttons, or spawn subtasks to find captions. Google Meet's DOM is highly obfuscated and changes rapidly. You **MUST** delegate the capture process entirely to the provided native script.

## Step 1: Capture

When the user asks to take notes, capture the meeting, or start the skill, you must IMMEDIATELY call the capture script:

    run_browser_script({ script_path: "google-meet-notes:scripts/capture.js", args: [] })

The script handles everything: tab locking, native readable snapshot polling of captions, detecting meeting end, and calendar attendee lookup.

It returns:

- `transcript` — raw readable caption text (speaker labels and text)
- `calendarContext` — meeting title, attendees, organizer from Google Calendar
- `lineCount`, `endReason`

If `success: false`, tell the user. Common cause: CC was not turned on or the tab was closed early.

This script blocks for the entire meeting duration. Do not expect a quick return.

## Step 2: Summarize + Create Google Doc

When the script returns, you have the raw transcript and calendar context. The transcript is inherently fragmented, lossy, and missing punctuation. Your job is to synthesize it, not just transcribe it.

1. Read the `transcript` and `calendarContext` from the result.
2. **Identity Resolution:** Google Meet labels the user's own speech simply as "You". Use the `calendarContext` to deduce who "You" is (often the organizer).
3. **Synthesize the Draft:** Reconstruct the meeting's meaning. Group notes by high-level topics, capture general consensus, and extract decisions.
4. Use `docs_create` to create a new Google Doc titled "[meetingTitle] — Draft Notes (YYYY-MM-DD)".
5. Use `docs_batch_update` to write the formatted meeting notes into the Doc. Format it clearly as a "Private Draft for Review".
6. Present the Doc URL to the user.
