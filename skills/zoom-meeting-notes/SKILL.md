---
name: zoom-meeting-notes
description: "Beta: Privacy-first meeting capture using in-browser DOM polling. Captures live Zoom Web Client captions to generate a private draft for human review. Zoom's obfuscated DOM may require updates after Zoom releases."
runnable: true
parameters:
  - name: action
    description: "reserved for future use"
    required: false
    default: ""
  - name: duration
    description: "Meeting duration limit in minutes"
    required: false
    default: "30"
prerequisites:
  - "Join the Zoom meeting via the **web client** (app.zoom.us) in Chrome — not the desktop app"
  - "Enable Closed Captions (CC) — click the **CC / Show Captions** button in the meeting toolbar, or ask the host to enable Auto-Transcription"
url-patterns:
  - "https://app.zoom.us/*"
guardrails: scripts/guardrail.js
allowed-tools:
  - run_browser_script
  - listPages
  - searchDom
  - takeSnapshot
  - calendar_get_events
  - docs_create
  - docs_batch_update
reminders:
  - id: "zoom:capture-active"
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

# Zoom Meet Notes

This skill acts as a privacy-first Executive Assistant. It captures lossy, real-time meeting captions from the Zoom Web Client via the browser and returns raw data for you to process into a coherent, private draft for the user to review.

🚨 **CRITICAL INSTRUCTION FOR THE AI AGENT:** 🚨
**DO NOT** attempt to manually read the DOM, take screenshots, click buttons, or spawn subtasks to find captions. Zoom's Web Client DOM is highly obfuscated and changes rapidly. You **MUST** delegate the capture process entirely to the provided native script.

## Step 1: Capture

When the user asks to take notes, capture the meeting, or start the skill, first determine the meeting duration. Ask the user if not obvious. Default is 30 minutes.

Then IMMEDIATELY call the capture script with the duration and a matching timeout:

    run_browser_script({
      script_path: "zoom-meeting-notes:scripts/capture.js",
      args: ["<duration_in_minutes>"],
      timeout: (<duration_in_minutes> + 5) * 60 * 1000
    })

For example, for a 30-minute meeting: `args: ["30"], timeout: 2100000`
For a 60-minute meeting: `args: ["60"], timeout: 3900000`

The script handles everything: tab locking, native readable snapshot polling of captions, detecting meeting end (including stale-caption detection), and calendar attendee lookup.

It returns:

- `transcript` — raw readable caption text (speaker labels and text)
- `calendarContext` — meeting title, attendees, organizer from Google Calendar
- `lineCount`, `endReason`

If `success: false`, tell the user. Common causes:

- CC was not turned on (the host must enable Auto-Transcription, or the user must click "Show Captions")
- The user joined via the desktop Zoom app instead of the web client
- The tab was closed early, or user switched to another tab

## Step 2: Summarize + Create Google Doc

When the script returns, you have the raw transcript and calendar context. The transcript is inherently fragmented, lossy, and missing punctuation. Your job is to synthesize it, not just transcribe it.

1. Read the `transcript` and `calendarContext` from the result.
2. **Identity Resolution:** Zoom's web client labels the user's own speech as "You" or by their display name. Use the `calendarContext` to cross-reference attendees.
3. **Synthesize the Draft:** Reconstruct the meeting's meaning. Group notes by high-level topics, capture general consensus, and extract decisions.
4. Use `docs_create` to create a new Google Doc titled "[meetingTitle] — Draft Notes (YYYY-MM-DD)".
5. Use `docs_batch_update` to write the formatted meeting notes into the Doc. Format it clearly as a "Private Draft for Review".
6. Present the Doc URL to the user.
