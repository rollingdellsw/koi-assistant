// scripts/capture.js — Zoom Web Client Caption Capture via Readable Snapshot Polling
//
// args[0] = meeting duration in minutes (default: 30)
//
// ─── DESIGN RATIONALE ────────────────────────────────────────────────────────
//
// This script is a direct adaptation of the Google Meet capture.js for the
// Zoom Web Client (app.zoom.us). The core technique is identical: poll the
// DOM for a caption container using takeSnapshot in "readable" mode, dedupe
// lines, and detect meeting-end signals.
//
// Key differences from the Google Meet version:
//
// 1. CAPTION SELECTOR
//    Google Meet uses a single well-known aria-label: div[aria-label="Captions"].
//    Zoom's web client does NOT have a stable aria-label for its caption container.
//    Zoom renders captions in two places:
//      a) Subtitle overlay at the bottom of the video area (transient, disappears)
//      b) Full Transcript side panel (persistent, scrollable)
//    We attempt BOTH selectors with a priority cascade. The Full Transcript panel
//    is preferred because it accumulates text and has speaker labels. The subtitle
//    overlay is a fallback — it only shows the most recent utterance.
//    Since Zoom's DOM is obfuscated and class names may change across releases,
//    we use multiple selector strategies and a discovery phase at startup.
//
// 2. MEETING-END DETECTION
//    Google Meet shows "You left the meeting" / "The meeting has ended" text.
//    Zoom shows different end-of-meeting indicators:
//      - "This meeting has been ended by the host"
//      - "The host has ended the meeting"
//      - "You have been removed from the meeting"
//      - Redirect to a "Thank you for attending" / post-meeting survey page
//      - Redirect back to the Zoom home/join page
//    We check for all of these text patterns plus URL-based detection.
//
// 3. HOME PAGE DETECTION
//    Google Meet redirects to meet.google.com with "New meeting" / "Enter a code".
//    Zoom redirects to app.zoom.us/wc or zoom.us with "Join" / "Host a meeting".
//    We check for Zoom-specific landing page indicators.
//
// 4. SPEAKER LABELS
//    Google Meet's caption container neatly separates speaker names from text.
//    Zoom's Full Transcript panel formats each entry as "Speaker Name  HH:MM"
//    followed by the caption text. The readable snapshot should capture both,
//    but the format may differ — we handle this in deduplication.
//
// 5. CALENDAR MATCHING
//    Google Meet events have a `hangoutLink` field in Google Calendar.
//    Zoom events typically have a `location` field with "https://...zoom.us/..."
//    or a `conferenceData` entry. We broaden the calendar match to look for
//    Zoom URLs in addition to the hangoutLink check.
//
// ─── END RATIONALE ───────────────────────────────────────────────────────────

async function run() {
  console.log("📦 Loading dependencies...");
  try {
    await tools.readSkill({ name: "google-workspace" });
  } catch (e) {}

  console.log("\n🔍 Phase 1: Initializing Zoom Caption Capture...");
  console.log("   ✓ Using 'Readable Snapshot' polling on Zoom Web Client.");

  const meetingDurationMin = parseInt(args[0], 10) || 30;
  console.log("   ⏱ Meeting duration limit: " + meetingDurationMin + " minutes");

  // ── Enter the meeting iframe ──────────────────────────────────
  //
  // CRITICAL: Zoom's PWA web client renders the actual meeting inside
  // iframe#webclient. All DOM operations (searchDom, takeSnapshot) only
  // see the outer PWA shell unless we enter the iframe first.
  // The outer shell contains just "Search Ctrl+K" and navigation — no
  // captions, no meeting UI. We MUST enter the iframe before polling.
  console.log("   🖼️  Entering meeting iframe (iframe#webclient)...");

  try {
    await tools.exitContext();
    await tools.resetContext();
  } catch (_) {}

  let iframeEntered = false;
  try {
    await tools.enterIframe('iframe#webclient');
    console.log("   ✓ Entered iframe#webclient successfully.");
    iframeEntered = true;
  } catch (e) {
    console.log("   ⚠ Could not enter iframe#webclient: " + (e.message || e));
    console.log("   ℹ Trying alternative: iframe.pwa-webclient__iframe");
    try {
      await tools.enterIframe('iframe.pwa-webclient__iframe');
      console.log("   ✓ Entered iframe.pwa-webclient__iframe successfully.");
      iframeEntered = true;
    } catch (e2) {
      console.log("   ℹ Trying dynamic source selector: iframe[src*=\"zoom.us/wc\"]");
      try {
        await tools.enterIframe('iframe[src*="zoom.us/wc"]');
        console.log("   ✓ Entered Zoom iframe via dynamic selector successfully.");
        iframeEntered = true;
      } catch (e3) {
        console.log("   ❌ Failed to enter meeting iframe. Caption capture may not work.");
      }
    }
  }

  if (!iframeEntered) {
    return {
      success: false,
      error: "Could not enter the Zoom meeting iframe. Possible causes:\n" +
             "  1. No active Zoom meeting in the current tab\n" +
             "  2. The meeting ended before the script started\n" +
             "  3. The Zoom tab was navigated away",
      endReason: "iframe_not_found",
    };
  }

  const POLL_INTERVAL_MS = 2000;
  const MAX_MEETING_MS = meetingDurationMin * 60 * 1000;
  const STALE_TIMEOUT_MS = 3 * 60 * 1000; // 3 min with no new content → assume ended
  const captureStartTime = Date.now();

  let meetingEnded = false;
  let endReason = "";

  let fullTranscriptLines = [];
  let lastSeenText = "";
  let lineCount = 0;
  let consecutiveErrors = 0;
  let pollCount = 0;
  let lastNewContentTime = Date.now();

  // ══════════════════════════════════════════════════════════════
  // CAPTION SELECTOR DISCOVERY
  // ══════════════════════════════════════════════════════════════
  //
  // Zoom's web client DOM is obfuscated — class names change between releases.
  // We try multiple selectors in priority order:
  //
  // 1. Full Transcript panel: This is the side panel opened via CC > "View Full
  //    Transcript". It accumulates all captions with speaker labels and timestamps.
  //    Most reliable source but requires the user to have the panel open.
  //    Known selectors (may change):
  //      - div[aria-label="Transcript"]
  //      - div[class*="transcript"]  (partial class match)
  //      - #TextContainer             (seen in some versions)
  //
  // 2. Subtitle/Caption overlay: The transient text at the bottom of the video.
  //    Only shows the most recent line, so we poll frequently.
  //    Known selectors:
  //      - div[aria-label="Closed Captioning"]
  //      - div[aria-label="Captions"]
  //      - div[class*="subtitle"]
  //      - div[class*="caption"]
  //
  // We discover which selector works during the first few polls and lock onto it.
  // FOUND (March 2026): The actual caption container is:
  //   div.live-transcription-subtitle__box > span.live-transcription-subtitle__item

  // CANDIDATE_SELECTORS: aria-label based selectors we know to try.
  // IMPORTANT: The first run on a real Zoom meeting showed that NONE of these
  // aria-label selectors matched. Zoom's web client (as of March 2026) does not
  // use stable aria-labels for its caption/transcript containers.
  //
  // We keep them as a fast-path check, but the primary discovery strategy is now
  // a searchDom probe: we search for known CSS class fragments or text patterns
  // that indicate the caption container, then use a broader readable snapshot
  // if those fail too.
  const CANDIDATE_SELECTORS = [
    // Full Transcript panel variants (preferred — accumulates history)
    'div[aria-label="Transcript"]',
    'div[aria-label="Full Transcript"]',
    // Closed Caption / subtitle overlay variants (fallback — transient)
    // ACTUAL WORKING SELECTORS (discovered March 2026 via DOM inspection):
    'div.live-transcription-subtitle__box',
    'div#live-transcription-subtitle',
    'div[aria-label="Closed Captioning"]',
    'div[aria-label="Captions"]',
    'div[aria-label="closed captioning"]',
    // Class-based selectors observed in Zoom Workplace web client (may change)
    'div[class*="transcript--panel"]',
    'div[class*="transcript-panel"]',
    'div[id="TextContainer"]',
    // Subtitle container (the live caption overlay at the bottom)
    'div[class*="subtitle-text"]',
    'div[class*="caption-text"]',
    'div[class*="closed-caption"]',
    'span[class*="closed-caption"]',
  ];

  let activeSelector = null;       // locked once we find a working one
  let selectorSearchCount = 0;
  const MAX_SELECTOR_SEARCH = 30;  // give up auto-discovery after 60 seconds

  // After exhausting CANDIDATE_SELECTORS, we try a full-page readable snapshot
  // and scan its text for caption-like content. This is the last-resort strategy.
  let useFullPageFallback = false;

  let domDumpDone = false;  // only dump once

  // ══════════════════════════════════════════════════════════════
  // DOM DIAGNOSTIC DUMP (runs once at poll #3)
  // ══════════════════════════════════════════════════════════════
  //
  // Purpose: When developing for a new platform (or after Zoom updates their
  // DOM), we need to discover what the caption container actually looks like.
  // This function probes the live DOM with multiple strategies and logs
  // everything to console so it appears in Koi's side panel output.
  //
  // Runs at poll #3 (~6 seconds in) — enough time for the meeting UI to
  // fully render, early enough to be useful before selector search gives up.
  //
  // Set ENABLE_DOM_DIAGNOSTIC = false once you've found working selectors.
  const ENABLE_DOM_DIAGNOSTIC = false;

  async function runDomDiagnostic() {
    console.log("\n🔬 ── DOM DIAGNOSTIC DUMP ──────────────────────");
    console.log("   Purpose: Find the real caption container selectors.");
    console.log("   This runs once and does NOT affect capture.\n");

    // 1. Text search for caption-related keywords in visible DOM elements
    const probeQueries = [
      "caption",
      "transcript",
      "subtitle",
      "closed caption",
      "live transcription",
    ];

    for (const q of probeQueries) {
      try {
        const res = await tools.searchDom(q);
        const matches = Array.isArray(res?.matches) ? res.matches : [];
        const visible = matches.filter(m => {
          const tag = (m.tagName || "").toLowerCase();
          return tag !== "script" && tag !== "style" && tag !== "noscript";
        });
        if (visible.length > 0) {
          console.log("   🔍 searchDom('" + q + "') → " + visible.length + " visible match(es):");
          for (const m of visible.slice(0, 5)) {
            console.log("      tag=" + m.tagName + " sel=" + (m.selector || "?").substring(0, 120));
            const preview = (m.text || "").substring(0, 200).replace(/\n/g, "↵");
            if (preview) console.log("      text=" + preview);
          }
        } else {
          console.log("   🔍 searchDom('" + q + "') → no visible matches");
        }
      } catch (e) {
        console.log("   🔍 searchDom('" + q + "') → error: " + (e.message || e));
      }
    }

    // 2. Probe aria-label / role selectors that might contain captions
    const ariaProbes = [
      '[aria-label*="caption" i]',
      '[aria-label*="transcript" i]',
      '[aria-label*="subtitle" i]',
      '[aria-label*="CC" ]',
      '[role="log"]',
      '[role="region"]',
    ];

    console.log("\n   🏷️  Probing aria-label / role selectors:");
    for (const sel of ariaProbes) {
      try {
        const snap = await tools.takeSnapshot({ selector: sel, mode: "readable" });
        const isError = snap && (snap.error || snap.isError);
        if (!isError && snap) {
          const text = (snap.content || snap.text || snap.markdown || "").substring(0, 300);
          console.log("      ✓ " + sel + " → found! preview: " + text.replace(/\n/g, "↵").substring(0, 200));
        } else {
          console.log("      ✗ " + sel + " → " + (snap?.error || "not found"));
        }
      } catch (_) {
        console.log("      ✗ " + sel + " → exception");
      }
    }

    // 3. Full-page readable snapshot (first 2000 chars)
    console.log("\n   📄 Full-page readable snapshot (first 2000 chars):");
    try {
      const fullSnap = await tools.takeSnapshot({ selector: "body", mode: "readable" });
      const isError = fullSnap && (fullSnap.error || fullSnap.isError);
      if (!isError && fullSnap) {
        const text = (fullSnap.content || fullSnap.text || fullSnap.markdown || "");
        console.log(text.substring(0, 2000));
        console.log("   ... (" + text.length + " total chars)");
      } else {
        console.log("      error: " + (fullSnap?.error || "unknown"));
      }
    } catch (e) {
      console.log("      exception: " + (e.message || e));
    }

    // 4. DOM structure snapshot (tag tree, first 3000 chars)
    console.log("\n   🏗️  DOM structure snapshot (first 3000 chars):");
    try {
      const domSnap = await tools.takeSnapshot({ selector: "body", mode: "dom", maxDepth: 4 });
      const isError = domSnap && (domSnap.error || domSnap.isError);
      if (!isError && domSnap) {
        const text = (domSnap.content || domSnap.text || domSnap.markdown || "");
        console.log(text.substring(0, 3000));
        console.log("   ... (" + text.length + " total chars)");
      } else {
        console.log("      error: " + (domSnap?.error || "unknown"));
      }
    } catch (e) {
      console.log("      exception: " + (e.message || e));
    }

    console.log("\n🔬 ── END DOM DIAGNOSTIC ───────────────────────\n");
  }

  // ── Helper: check if searchDom found visible matches ──────────
  //
  // Zoom's web client embeds ALL translatable strings in a <script> tag
  // as a `langResource` JSON blob. This means searchDom("You have been
  // removed from this meeting") will match that <script> tag even when
  // the meeting is still active. We must filter out matches in non-visible
  // elements like <script>, <style>, <noscript>, <template>.
  function hasVisibleMatch(domRes) {
    if (!domRes || domRes.error || domRes.isError) return false;
    const matches = Array.isArray(domRes.matches) ? domRes.matches : [];
    if (matches.length === 0 && (domRes.count ?? 0) === 0) return false;
    const invisibleTags = new Set(["script", "style", "noscript", "template", "meta", "link"]);
    const visible = matches.filter(m => !invisibleTags.has((m.tagName || "").toLowerCase()));
    return visible.length > 0;
  }

  // ══════════════════════════════════════════════════════════════
  // PHASE 2: Poll until meeting ends
  // ══════════════════════════════════════════════════════════════

  while (!meetingEnded) {
    await tools.sleep(POLL_INTERVAL_MS);

    if ((Date.now() - captureStartTime) > MAX_MEETING_MS) {
      endReason = "max_duration";
      break;
    }

    // Stale content timeout — no new captions for a while means meeting likely ended
    if (lineCount > 0 && (Date.now() - lastNewContentTime) > STALE_TIMEOUT_MS) {
      endReason = "stale_timeout";
      console.log("   ⏰ No new captions for " + (STALE_TIMEOUT_MS / 1000) + "s. Assuming meeting ended.");
      break;
    }

    pollCount++;
    if (pollCount % 10 === 1) {
      console.log("   🔄 Poll #" + pollCount + " (errors: " + consecutiveErrors + ", lines: " + lineCount + ", selector: " + (activeSelector || "searching...") + ")");
    }

    // ── Run DOM diagnostic once at poll #3 (~6s in) ─────────────
    if (ENABLE_DOM_DIAGNOSTIC && !domDumpDone && pollCount === 3) {
      domDumpDone = true;
      await runDomDiagnostic();
    }

    // ── Meeting-end detection ──────────────────────────────────
    //
    // OPTIMIZATION: Instead of checking 5 separate end signals + 3 home signals
    // + 1 feedback signal (= 9 searchDom calls per poll!), we do ONE searchDom
    // with a single short query that's unlikely to appear in langResource as a
    // visible element during an active meeting. We check "This meeting has been
    // ended" first (most common end signal). Only if the tab seems gone (error)
    // do we check the other signals.
    //
    // Key insight from testing: Zoom embeds ALL UI strings in a <script> tag
    // (langResource). The hasVisibleMatch filter handles this, but each
    // searchDom call still costs ~50-100ms of IPC round-trip. With 9 checks
    // per poll at 2s intervals, that's most of the poll budget spent on
    // end-detection rather than caption capture.

    const endSignals = ["This meeting has been ended", "The host has ended the meeting"];
    let endDetected = false;
    for (const signal of endSignals) {
      try {
        const domRes = await tools.searchDom(signal);
        const hasError = domRes && (domRes.error || domRes.isError);
        if (hasError) {
          const errMsg = domRes.error || '';
          if (errMsg.includes("No active tab") || errMsg.includes("disconnected") || errMsg.includes("cannot be scripted") || errMsg.includes("No frame with id")) {
            consecutiveErrors++;
          }
          break; // don't check more signals on error
        } else {
          consecutiveErrors = 0;
        }
        if (hasVisibleMatch(domRes)) {
          endReason = "meeting_ended_signal: " + signal;
          console.log("   🏁 End signal detected: '" + signal + "'");
          endDetected = true;
          break;
        }
      } catch (_) {}
    }
    if (endDetected) break;

    // ── Home/landing page detection ─────────────────────────────
    // Combined: check one distinctive home-page string that won't appear
    // in langResource as a visible element during an active meeting.
    // "New meeting" button text is a good indicator of the Zoom home page.
    try {
      const homeRes = await tools.searchDom("New meeting");
      if (hasVisibleMatch(homeRes)) {
        endReason = "returned_to_home";
        console.log("   🏠 Zoom home page detected.");
        break;
      }
    } catch (_) {}

    // ── Caption snapshot ────────────────────────────────────────
    //
    // Selector discovery: if we haven't locked onto a selector yet, try all
    // candidates. Once one returns content, lock onto it for the rest of
    // the session. This avoids wasting time on failed selectors every poll.

    if (!activeSelector && selectorSearchCount < MAX_SELECTOR_SEARCH) {
      selectorSearchCount++;
      for (const sel of CANDIDATE_SELECTORS) {
        try {
          const probe = await tools.takeSnapshot({ selector: sel, mode: "readable" });
          const probeError = probe && (probe.error || probe.isError);
          if (!probeError && probe) {
            const probeText = probe.content || probe.text || probe.markdown || "";
            if (probeText && probeText.trim().length > 0) {
              activeSelector = sel;
              console.log("   🎯 Locked onto caption selector: " + sel);
              break;
            }
          }
        } catch (_) {}
      }

      if (!activeSelector && selectorSearchCount >= MAX_SELECTOR_SEARCH) {
        console.log("   ⚠ Could not find caption container after " + MAX_SELECTOR_SEARCH + " attempts.");
        console.log("   ℹ Make sure CC is enabled and, ideally, open the Full Transcript panel.");
        console.log("   ℹ Switching to full-page snapshot fallback...");
        useFullPageFallback = true;
      }
    }

    // If we have a selector (or are still searching), take a snapshot
    if (activeSelector) {
      try {
        const snapRes = await tools.takeSnapshot({
          selector: activeSelector,
          mode: "readable"
        });

        const snapError = snapRes && (snapRes.error || snapRes.isError);
        if (snapError) {
          const errMsg = snapRes.error || '';
          if (errMsg.includes("No active tab") || errMsg.includes("disconnected") || errMsg.includes("No frame with id")) {
            console.log("   🔄 Iframe lost — attempting re-entry...");
            try {
              await tools.exitContext();
              await tools.resetContext();
              await tools.enterIframe('iframe#webclient');
              activeSelector = null;
              selectorSearchCount = 0;
              consecutiveErrors = 0;
              console.log("   ✓ Re-entered iframe#webclient successfully.");
            } catch (_) {
              consecutiveErrors++;
              console.log("   ⚠ Re-entry failed (consecutive: " + consecutiveErrors + ")");
            }
          }
          // "Element not found" could mean the panel was closed — reset selector
          // so we re-discover on next poll
          if (errMsg.includes("Element not found") || errMsg.includes("not found")) {
            console.log("   ⚠ Caption container disappeared. Re-entering discovery mode...");
            activeSelector = null;
            selectorSearchCount = 0; // allow re-discovery
          }
        } else if (snapRes) {
          const rawText = snapRes.content || snapRes.text || snapRes.markdown || "";
          consecutiveErrors = 0;  // successful snapshot = connection is alive

          if (rawText && rawText !== lastSeenText) {
            // Split the readable block into individual non-empty lines
            const currentLines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            for (const line of currentLines) {
              // Deduplication: Ignore lines we've already recorded recently.
              // Using a window of 10 (slightly larger than Meet's 6) because
              // the Zoom Transcript panel can show more history at once.
              const recentLines = fullTranscriptLines.slice(-10);
              if (recentLines.includes(line)) continue;

              // Typing/Autocorrect handling: Update the line if it's just being extended.
              // Zoom's live captions also build up incrementally like Meet's.
              if (fullTranscriptLines.length > 0) {
                const lastRecordedLine = fullTranscriptLines[fullTranscriptLines.length - 1];
                if (line.startsWith(lastRecordedLine) && line.length > lastRecordedLine.length) {
                  fullTranscriptLines[fullTranscriptLines.length - 1] = line;
                  continue;
                }
              }

              // Genuine new line (Speaker name/timestamp or caption text)
              fullTranscriptLines.push(line);
              lineCount++;
              lastNewContentTime = Date.now();

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
    }

    // NOTE: Full-page body fallback was removed — it captured UI noise (buttons,
    // sidebar names, chat) mixed with captions, producing garbage transcripts.
    // If no caption selector is found, the user needs to open the Full Transcript
    // panel (CC → View Full Transcript) and the script will pick it up on the next
    // selector discovery cycle.



    if (consecutiveErrors >= 15) {
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
      error: "No transcript captured. Possible causes:\n" +
             "  1. The Full Transcript panel was not open — click CC → 'View Full Transcript'\n" +
             "     before starting capture (this gives a stable, accumulating container)\n" +
             "  2. CC / Auto-Transcription was not enabled (host must enable it)\n" +
             "  3. You joined via the desktop Zoom app instead of the web client (app.zoom.us)\n" +
             "  4. The browser tab was not active/focused during the meeting",
      endReason: endReason,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // PHASE 4: Pull calendar context
  // ══════════════════════════════════════════════════════════════
  //
  // Same approach as Google Meet: query Google Calendar for events around now.
  // The difference is in matching — Zoom events won't have a `hangoutLink`.
  // Instead, we look for:
  //   - `location` field containing "zoom.us"
  //   - `conferenceData` with Zoom entries
  //   - Or simply the most recent non-cancelled event with attendees
  //     (since the user is clearly in a meeting right now)

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
        const calData = JSON.parse(String(calRes.content[0].text));
        const events = Array.isArray(calData.events) ? calData.events : [];

        let matchedEvent = null;
        for (const event of events) {
          if (event.status === "cancelled") continue;

          // Check if this event is a Zoom meeting:
          //   - location contains "zoom.us"
          //   - description contains a Zoom link
          //   - or just any active event in the time window (fallback)
          const loc = (event.location || "").toLowerCase();
          const desc = (event.description || "").toLowerCase();
          const isZoom = loc.includes("zoom.us") || desc.includes("zoom.us");

          const start = new Date(event.start?.dateTime || event.start?.date || "");
          const end = new Date(event.end?.dateTime || event.end?.date || "");
          const isInWindow = start <= now && end >= twoHoursAgo;

          // Prefer Zoom-linked events; fall back to any event in the window
          if (isInWindow && (isZoom || event.summary)) {
            if (isZoom || !matchedEvent) {
              matchedEvent = event;
              if (isZoom) break; // exact Zoom match — stop looking
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
