// scripts/gmail-calendar-test.js
// Gmail & Calendar read-only sanity test
// Covers: gmail_search, gmail_get_message, gmail_list_labels, gmail_get_thread,
//         calendar_list, calendar_get_events, calendar_get_event

await tools.readSkill({ name: "google-workspace" });
console.log("Starting Gmail & Calendar Read-Only Test...");

async function run() {
  const results = { gmail: {}, calendar: {} };

  try {
    // =========================================================
    // GMAIL
    // =========================================================
    console.log(`\n==================================================`);
    console.log(`PART 1: GMAIL READ-ONLY`);
    console.log(`==================================================`);

    // 1. List Labels
    console.log(`\n[1/4] Listing Gmail Labels...`);
    const labelsRes = await tools.gmail_list_labels({});
    const labelsText = labelsRes.content ? labelsRes.content[0].text : "[]";

    if (labelsRes.isError || labelsText.includes("API Error")) {
      console.error(`✗ gmail_list_labels failed: ${labelsText}`);
      results.gmail.labels = false;
    } else {
      try {
        const labels = JSON.parse(labelsText);
        const labelNames = labels.map(l => l.name || l.id).slice(0, 5);
        console.log(`✓ Found ${labels.length} labels. Sample: ${labelNames.join(", ")}`);
        results.gmail.labels = true;
      } catch (e) {
        console.warn(`⚠️ Label parse error: ${labelsText.slice(0, 200)}`);
        results.gmail.labels = false;
      }
    }

    // 2. Search Messages
    console.log(`\n[2/4] Searching Gmail (recent messages)...`);
    const searchRes = await tools.gmail_search({ query: "newer_than:7d", maxResults: 5 });
    const searchText = searchRes.content ? searchRes.content[0].text : "{}";

    let firstMessageId = null;
    let firstThreadId = null;

    if (searchRes.isError || searchText.includes("API Error")) {
      console.error(`✗ gmail_search failed: ${searchText}`);
      results.gmail.search = false;
    } else {
      try {
        const searchData = JSON.parse(searchText);
        const msgs = searchData.messages || [];
        console.log(`✓ Found ${msgs.length} messages (resultSizeEstimate: ${searchData.resultSizeEstimate})`);
        if (msgs.length > 0) {
          firstMessageId = msgs[0].id;
          firstThreadId = msgs[0].threadId;
          console.log(`   First: "${msgs[0].subject}" from ${msgs[0].from}`);
          console.log(`   URL: ${msgs[0].url}`);
        }
        results.gmail.search = true;
      } catch (e) {
        console.warn(`⚠️ Search parse error: ${searchText.slice(0, 200)}`);
        results.gmail.search = false;
      }
    }

    // 3. Get Message Detail
    console.log(`\n[3/4] Fetching Message Detail...`);
    if (firstMessageId) {
      const msgRes = await tools.gmail_get_message({ messageId: firstMessageId });
      const msgText = msgRes.content ? msgRes.content[0].text : "{}";

      if (msgRes.isError || msgText.includes("API Error")) {
        console.error(`✗ gmail_get_message failed: ${msgText}`);
        results.gmail.getMessage = false;
      } else {
        try {
          const msg = JSON.parse(msgText);
          console.log(`✓ Message ID: ${msg.id}`);
          console.log(`   Subject: "${msg.subject}"`);
          console.log(`   From: ${msg.from}`);
          console.log(`   Body length: ${(msg.body || "").length} chars`);
          console.log(`   Attachments: ${(msg.attachments || []).length}`);
          console.log(`   URL: ${msg.url}`);
          results.gmail.getMessage = true;
        } catch (e) {
          console.warn(`⚠️ Message parse error: ${msgText.slice(0, 200)}`);
          results.gmail.getMessage = false;
        }
      }
    } else {
      console.log(`   (Skipped: No messages found to fetch)`);
      results.gmail.getMessage = "skipped";
    }

    // 4. Get Thread
    console.log(`\n[4/4] Fetching Thread...`);
    if (firstThreadId) {
      const threadRes = await tools.gmail_get_thread({ threadId: firstThreadId });
      const threadText = threadRes.content ? threadRes.content[0].text : "{}";

      if (threadRes.isError || threadText.includes("API Error")) {
        console.error(`✗ gmail_get_thread failed: ${threadText}`);
        results.gmail.getThread = false;
      } else {
        try {
          const thread = JSON.parse(threadText);
          console.log(`✓ Thread ID: ${thread.threadId}`);
          console.log(`   Messages in thread: ${(thread.messages || []).length}`);
          console.log(`   URL: ${thread.url}`);
          results.gmail.getThread = true;
        } catch (e) {
          console.warn(`⚠️ Thread parse error: ${threadText.slice(0, 200)}`);
          results.gmail.getThread = false;
        }
      }
    } else {
      console.log(`   (Skipped: No threadId available)`);
      results.gmail.getThread = "skipped";
    }

    // =========================================================
    // CALENDAR
    // =========================================================
    console.log(`\n==================================================`);
    console.log(`PART 2: CALENDAR READ-ONLY`);
    console.log(`==================================================`);

    // 1. List Calendars
    console.log(`\n[1/3] Listing Calendars...`);
    const calListRes = await tools.calendar_list({});
    const calListText = calListRes.content ? calListRes.content[0].text : "[]";

    let primaryCalId = "primary";

    if (calListRes.isError || calListText.includes("API Error")) {
      console.error(`✗ calendar_list failed: ${calListText}`);
      results.calendar.list = false;
    } else {
      try {
        const calendars = JSON.parse(calListText);
        console.log(`✓ Found ${calendars.length} calendars.`);
        calendars.forEach(c => {
          console.log(`   - "${c.summary}" (${c.id})${c.primary ? " [PRIMARY]" : ""}`);
          if (c.primary) primaryCalId = c.id;
        });
        results.calendar.list = true;
      } catch (e) {
        console.warn(`⚠️ Calendar list parse error: ${calListText.slice(0, 200)}`);
        results.calendar.list = false;
      }
    }

    // 2. Get Events (next 30 days)
    console.log(`\n[2/3] Fetching Events (next 30 days)...`);
    const now = new Date();
    const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const eventsRes = await tools.calendar_get_events({
      calendarId: primaryCalId,
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      maxResults: 10
    });
    const eventsText = eventsRes.content ? eventsRes.content[0].text : "{}";

    let firstEventId = null;

    if (eventsRes.isError || eventsText.includes("API Error")) {
      console.error(`✗ calendar_get_events failed: ${eventsText}`);
      results.calendar.getEvents = false;
    } else {
      try {
        const eventsData = JSON.parse(eventsText);
        const events = eventsData.events || [];
        console.log(`✓ Found ${events.length} upcoming events.`);
        events.slice(0, 3).forEach(e => {
          const start = e.start?.dateTime || e.start?.date || "?";
          console.log(`   - "${e.summary}" @ ${start}`);
        });
        if (events.length > 0) {
          firstEventId = events[0].id;
        }
        results.calendar.getEvents = true;
      } catch (e) {
        console.warn(`⚠️ Events parse error: ${eventsText.slice(0, 200)}`);
        results.calendar.getEvents = false;
      }
    }

    // 3. Get Single Event
    console.log(`\n[3/3] Fetching Single Event Detail...`);
    if (firstEventId) {
      const eventRes = await tools.calendar_get_event({ calendarId: primaryCalId, eventId: firstEventId });
      const eventText = eventRes.content ? eventRes.content[0].text : "{}";

      if (eventRes.isError || eventText.includes("API Error")) {
        console.error(`✗ calendar_get_event failed: ${eventText}`);
        results.calendar.getEvent = false;
      } else {
        try {
          const event = JSON.parse(eventText);
          console.log(`✓ Event: "${event.summary}"`);
          console.log(`   Status: ${event.status}`);
          console.log(`   Location: ${event.location || "(none)"}`);
          console.log(`   Attendees: ${(event.attendees || []).length}`);
          console.log(`   Link: ${event.htmlLink}`);
          results.calendar.getEvent = true;
        } catch (e) {
          console.warn(`⚠️ Event parse error: ${eventText.slice(0, 200)}`);
          results.calendar.getEvent = false;
        }
      }
    } else {
      console.log(`   (Skipped: No events found to fetch)`);
      results.calendar.getEvent = "skipped";
    }

    // =========================================================
    // SUMMARY
    // =========================================================
    console.log(`\n==================================================`);
    console.log(`SUMMARY`);
    console.log(`==================================================`);
    console.log(JSON.stringify(results, null, 2));

    const allPassed = Object.values(results.gmail).every(v => v === true || v === "skipped")
                   && Object.values(results.calendar).every(v => v === true || v === "skipped");

    return { success: allPassed, results };

  } catch (e) {
    console.error("\n✗ TEST FAILED:", e.message);
    if (e.stack) console.error(e.stack);
    return { success: false, error: e.message, results };
  }
}

return run();
