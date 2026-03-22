// scripts/capture.js — Native Readable Snapshot Polling (Bulletproof)

async function run() {
  console.log("📦 Loading dependencies...");
  try {
    await tools.readSkill({ name: "google-workspace" });
  } catch (e) {}

  console.log("\n🔍 Phase 1: Initializing Native DOM Capture...");
  console.log("   ✓ Using highly reliable 'Readable Snapshot' mode.");

  const POLL_INTERVAL_MS = 2000;
  const MAX_MEETING_MS = 4 * 60 * 60 * 1000;
  const captureStartTime = Date.now();

  let meetingEnded = false;
  let endReason = "";

  let fullTranscriptLines = [];
  let lastSeenText = "";
  let lineCount = 0;
  let consecutiveErrors = 0;
  let pollCount = 0;

  // ══════════════════════════════════════════════════════════════
  // PHASE 2: Poll until meeting ends
  // ══════════════════════════════════════════════════════════════

  while (!meetingEnded) {
    await tools.sleep(POLL_INTERVAL_MS);

    if ((Date.now() - captureStartTime) > MAX_MEETING_MS) {
      endReason = "max_duration";
      break;
    }

    pollCount++;
    if (pollCount % 10 === 1) {
      console.log("   🔄 Poll #" + pollCount + " (errors: " + consecutiveErrors + ", lines: " + lineCount + ")");
    }

    // Check if meeting ended
    try {
      const domRes = await tools.searchDom("You left the meeting");
      const hasError = domRes && (domRes.error || domRes.isError);
      if (hasError) {
        console.log("   ⚠ searchDom error: " + (domRes.error || JSON.stringify(domRes)));
        consecutiveErrors++;
      } else {
        consecutiveErrors = 0;
      }
      const count = domRes?.count ?? (Array.isArray(domRes) ? domRes.length : 0);
      if (!hasError && count > 0) {
        endReason = "left_meeting";
        console.log("   🚪 'You left the meeting' detected.");
        break;
      }
    } catch (_) {}

    try {
      const domRes2 = await tools.searchDom("The meeting has ended");
      const count2 = domRes2?.count ?? (Array.isArray(domRes2) ? domRes2.length : 0);
      if (count2 > 0) {
        endReason = "meeting_ended";
        console.log("   🏁 'The meeting has ended' detected.");
        break;
      }
    } catch (_) {}

    // Check if we got redirected to the Meet home page
    // "New meeting" might not be the exact text — also check for other landing indicators
    try {
      const domRes3 = await tools.searchDom("Start a new meeting");
      const count3a = domRes3?.count ?? (Array.isArray(domRes3) ? domRes3.length : 0);
      const domRes3b = await tools.searchDom("New meeting");
      const count3b = domRes3b?.count ?? (Array.isArray(domRes3b) ? domRes3b.length : 0);
      const domRes3c = await tools.searchDom("Enter a code or link");
      const count3c = domRes3c?.count ?? (Array.isArray(domRes3c) ? domRes3c.length : 0);
      if (count3a > 0 || count3b > 0 || count3c > 0) {
        endReason = "returned_to_home";
        console.log("   🏠 Landing page detected (counts: " + count3a + "/" + count3b + "/" + count3c + ")");
        break;
      }
      if (pollCount % 10 === 1) {
        console.log("   🔍 Landing check counts: start=" + count3a + " new=" + count3b + " code=" + count3c);
      }
    } catch (_) {}

    // Take a "Readable" snapshot of the Captions container
    try {
      const snapRes = await tools.takeSnapshot({
          selector: 'div[aria-label="Captions"]',
          mode: "readable"
      });

      const snapError = snapRes && (snapRes.error || snapRes.isError);
      if (snapError) {
        // "Element not found" is normal (CC off), but "No active tab" means tab is gone
        const errMsg = snapRes.error || '';
        if (errMsg.includes("No active tab") || errMsg.includes("disconnected")) {
          consecutiveErrors++;
          if (pollCount % 5 === 1) {
            console.log("   ⚠ Tab may be gone: " + errMsg + " (consecutive: " + consecutiveErrors + ")");
          }
        }
        // "Element not found" is benign — CC may not be on yet
      } else if (snapRes) {
        const rawText = snapRes.content || snapRes.text || snapRes.markdown || "";

        if (rawText && rawText !== lastSeenText) {
            // Split the readable block into individual non-empty lines
            const currentLines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            for (const line of currentLines) {
                // Deduplication: Ignore lines we've already recorded recently
                const recentLines = fullTranscriptLines.slice(-6);
                if (recentLines.includes(line)) continue;

                // Typing/Autocorrect handling: Update the line if it's just being extended
                if (fullTranscriptLines.length > 0) {
                    const lastRecordedLine = fullTranscriptLines[fullTranscriptLines.length - 1];
                    if (line.startsWith(lastRecordedLine) && line.length > lastRecordedLine.length) {
                        fullTranscriptLines[fullTranscriptLines.length - 1] = line;
                        continue;
                    }
                }

                // Genuine new line (Speaker name or Caption text)
                fullTranscriptLines.push(line);
                lineCount++;

                if (lineCount % 10 === 0) {
                    console.log("   📝 Captured " + lineCount + " readable lines...");
                }
            }
            lastSeenText = rawText;
        }
      }
    } catch (err) {
        consecutiveErrors++;
        console.log("   ⚠ Snapshot exception: " + (err.message || err) + " (consecutive: " + consecutiveErrors + ")");
    }

    if (consecutiveErrors >= 5) {
      endReason = "tab_closed_or_disconnected";
      console.log("   ❌ Lost connection (" + consecutiveErrors + " consecutive errors). Ending capture.");
      break;
    }
  }

  console.log("\n⏹️ Phase 3: Stopping capture (reason: " + endReason + ")...");
  console.log("   ✓ Processed " + fullTranscriptLines.length + " transcript lines.");

  if (fullTranscriptLines.length === 0) {
    return {
      success: false,
      error: "No transcript captured. Was CC turned on during the meeting? (Note: Keep the Meet tab active/focused for capture to work)",
      endReason: endReason,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // PHASE 4: Pull calendar context
  // ══════════════════════════════════════════════════════════════
  let calendarContext = "";
  let meetingTitle = "";
  console.log("\n📅 Phase 4: Loading calendar context...");

  try {
    let calRetries = 5;
    while (typeof tools.calendar_get_events !== "function" && calRetries > 0) {
      await tools.sleep(500);
      calRetries--;
    }

    if (typeof tools.calendar_get_events === "function") {
      const now = new Date();
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      const oneHourAhead = new Date(now.getTime() + 1 * 60 * 60 * 1000);

      // MCP Tool: Returns wrapped object
      const calRes = await tools.calendar_get_events({
        calendarId: "primary",
        timeMin: twoHoursAgo.toISOString(),
        timeMax: oneHourAhead.toISOString(),
        maxResults: 10,
      });

      if (calRes && !calRes.isError) {
        // Safe to use content[0].text here because it's an MCP tool
        const calData = JSON.parse(String(calRes.content[0].text));
        const events = Array.isArray(calData.events) ? calData.events : [];

        let matchedEvent = null;
        for (const event of events) {
          if (event.hangoutLink || (event.summary && event.status !== "cancelled")) {
            const start = new Date(event.start?.dateTime || event.start?.date || "");
            const end = new Date(event.end?.dateTime || event.end?.date || "");
            if (start <= now && end >= twoHoursAgo) {
              matchedEvent = event;
              break;
            }
          }
        }

        if (matchedEvent) {
          meetingTitle = matchedEvent.summary || "";
          const attendees = (matchedEvent.attendees || [])
            .map((a) => (a.displayName ? a.displayName + " <" + a.email + ">" : a.email))
            .join(", ");

          calendarContext =
            "Meeting Title: " + meetingTitle + "\n" +
            "Scheduled Time: " + (matchedEvent.start?.dateTime || matchedEvent.start?.date || "unknown") + "\n" +
            "Organizer: " + (matchedEvent.organizer?.email || "unknown") + "\n" +
            "Attendees: " + (attendees || "none listed") + "\n" +
            "Description: " + (matchedEvent.description || "none") + "\n";

          console.log("   ✓ Matched: " + meetingTitle);
        } else {
          console.log("   ⚠ No matching calendar event found.");
        }
      }
    }
  } catch (e) {
    console.warn("   ⚠ Calendar lookup failed.");
  }

  console.log("\n✅ Capture complete! Returning data for LLM processing.");

  return {
    success: true,
    endReason: endReason,
    meetingTitle: meetingTitle || "(no calendar match)",
    lineCount: fullTranscriptLines.length,
    calendarContext: calendarContext || "(no calendar event matched)",
    transcript: fullTranscriptLines.join("\n"),
  };
}

return run();
