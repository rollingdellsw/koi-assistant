// scripts/outlook-calendar-test.js
// Outlook Mail & Calendar read-only sanity test
// Covers: outlook_search, outlook_get_message, outlook_list_folders, outlook_get_thread,
//         outlook_get_attachment, ms_calendar_list, ms_calendar_get_events, ms_calendar_get_event

await tools.readSkill({ name: "microsoft-365" });
console.log("Starting Outlook & Calendar Read-Only Test...");

async function run() {
  const results = { outlook: {}, calendar: {} };

  try {
    // =========================================================
    // OUTLOOK MAIL
    // =========================================================
    console.log(`\n==================================================`);
    console.log(`PART 1: OUTLOOK MAIL READ-ONLY`);
    console.log(`==================================================`);

    // 1. List Folders
    console.log(`\n[1/5] Listing Outlook Mail Folders...`);
    const foldersRes = await tools.outlook_list_folders({});
    const foldersText = foldersRes.content ? foldersRes.content[0].text : "[]";

    if (foldersRes.isError || foldersText.includes("API Error")) {
      console.error(`✗ outlook_list_folders failed: ${foldersText}`);
      results.outlook.folders = false;
    } else {
      try {
        const folders = JSON.parse(foldersText);
        console.log(`✓ Found ${folders.length} folders.`);
        folders.slice(0, 5).forEach(f => {
          console.log(`   - "${f.displayName}" (Total: ${f.totalItemCount}, Unread: ${f.unreadItemCount})`);
        });
        results.outlook.folders = true;
      } catch (e) {
        console.warn(`⚠️ Folder parse error: ${foldersText.slice(0, 200)}`);
        results.outlook.folders = false;
      }
    }

    // 2. Search Messages
    console.log(`\n[2/5] Searching Outlook (recent messages)...`);
    const searchRes = await tools.outlook_search({ query: "*", maxResults: 5 });
    const searchText = searchRes.content ? searchRes.content[0].text : "{}";

    let firstMessageId = null;
    let firstConversationId = null;
    let firstHasAttachments = false;

    if (searchRes.isError || searchText.includes("API Error")) {
      console.error(`✗ outlook_search failed: ${searchText}`);
      results.outlook.search = false;
    } else {
      try {
        const searchData = JSON.parse(searchText);
        const msgs = searchData.messages || [];
        console.log(`✓ Found ${msgs.length} messages.`);
        if (msgs.length > 0) {
          firstMessageId = msgs[0].id;
          firstConversationId = msgs[0].conversationId;
          firstHasAttachments = msgs[0].hasAttachments;
          console.log(`   First: "${msgs[0].subject}" from ${msgs[0].from?.name || msgs[0].from?.address || "unknown"}`);
          console.log(`   WebLink: ${msgs[0].webLink || "N/A"}`);
        }
        results.outlook.search = true;
      } catch (e) {
        console.warn(`⚠️ Search parse error: ${searchText.slice(0, 200)}`);
        results.outlook.search = false;
      }
    }

    // 3. Get Message Detail
    console.log(`\n[3/5] Fetching Message Detail...`);
    if (firstMessageId) {
      const msgRes = await tools.outlook_get_message({ messageId: firstMessageId });
      const msgText = msgRes.content ? msgRes.content[0].text : "{}";

      if (msgRes.isError || msgText.includes("API Error")) {
        console.error(`✗ outlook_get_message failed: ${msgText}`);
        results.outlook.getMessage = false;
      } else {
        try {
          const msg = JSON.parse(msgText);
          console.log(`✓ Message ID: ${msg.id}`);
          console.log(`   Subject: "${msg.subject}"`);
          console.log(`   From: ${msg.from?.name || msg.from?.address || "unknown"}`);
          console.log(`   Body length: ${(msg.body || "").length} chars`);
          console.log(`   Attachments: ${(msg.attachments || []).length}`);
          console.log(`   WebLink: ${msg.webLink || "N/A"}`);

          // If there are attachments, test attachment metadata retrieval
          if (msg.attachments && msg.attachments.length > 0) {
            console.log(`\n   [Bonus] Testing outlook_get_attachment (metadata only)...`);
            const att = msg.attachments[0];
            const attRes = await tools.outlook_get_attachment({
              messageId: firstMessageId,
              attachmentId: att.id
            });
            const attText = attRes.content ? attRes.content[0].text : "{}";
            try {
              const attData = JSON.parse(attText);
              console.log(`   ✓ Attachment: "${attData.name}" (${attData.contentType}, ${attData.size} bytes)`);
              results.outlook.getAttachment = true;
            } catch (e) {
              console.warn(`   ⚠️ Attachment parse error`);
              results.outlook.getAttachment = false;
            }
          }

          results.outlook.getMessage = true;
        } catch (e) {
          console.warn(`⚠️ Message parse error: ${msgText.slice(0, 200)}`);
          results.outlook.getMessage = false;
        }
      }
    } else {
      console.log(`   (Skipped: No messages found to fetch)`);
      results.outlook.getMessage = "skipped";
    }

    // 4. Get Thread (Conversation)
    console.log(`\n[4/5] Fetching Conversation Thread...`);
    if (firstConversationId) {
      const threadRes = await tools.outlook_get_thread({ conversationId: firstConversationId });
      const threadText = threadRes.content ? threadRes.content[0].text : "{}";

      if (threadRes.isError || threadText.includes("API Error")) {
        console.error(`✗ outlook_get_thread failed: ${threadText}`);
        results.outlook.getThread = false;
      } else {
        try {
          const thread = JSON.parse(threadText);
          console.log(`✓ Conversation ID: ${thread.conversationId}`);
          console.log(`   Messages in thread: ${(thread.messages || []).length}`);
          results.outlook.getThread = true;
        } catch (e) {
          console.warn(`⚠️ Thread parse error: ${threadText.slice(0, 200)}`);
          results.outlook.getThread = false;
        }
      }
    } else {
      console.log(`   (Skipped: No conversationId available)`);
      results.outlook.getThread = "skipped";
    }

    // 5. Attachment test (standalone, if not already tested above)
    if (!results.outlook.getAttachment && results.outlook.getAttachment !== false) {
      console.log(`\n[5/5] Attachment test...`);
      console.log(`   (Skipped: No message with attachments found in search results)`);
      results.outlook.getAttachment = "skipped";
    } else {
      console.log(`\n[5/5] Attachment test: already covered above.`);
    }

    // =========================================================
    // CALENDAR
    // =========================================================
    console.log(`\n==================================================`);
    console.log(`PART 2: CALENDAR READ-ONLY`);
    console.log(`==================================================`);

    // 1. List Calendars
    console.log(`\n[1/3] Listing Calendars...`);
    const calListRes = await tools.ms_calendar_list({});
    const calListText = calListRes.content ? calListRes.content[0].text : "[]";

    let defaultCalId = null;

    if (calListRes.isError || calListText.includes("API Error")) {
      console.error(`✗ ms_calendar_list failed: ${calListText}`);
      results.calendar.list = false;
    } else {
      try {
        const calendars = JSON.parse(calListText);
        console.log(`✓ Found ${calendars.length} calendars.`);
        calendars.forEach(c => {
          const isDefault = c.isDefaultCalendar ? " [DEFAULT]" : "";
          console.log(`   - "${c.name}" (${c.id})${isDefault}`);
          if (c.isDefaultCalendar) defaultCalId = c.id;
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

    const eventsArgs = {
      startDateTime: now.toISOString(),
      endDateTime: future.toISOString(),
      maxResults: 10
    };
    if (defaultCalId) eventsArgs.calendarId = defaultCalId;

    const eventsRes = await tools.ms_calendar_get_events(eventsArgs);
    const eventsText = eventsRes.content ? eventsRes.content[0].text : "{}";

    let firstEventId = null;

    if (eventsRes.isError || eventsText.includes("API Error")) {
      console.error(`✗ ms_calendar_get_events failed: ${eventsText}`);
      results.calendar.getEvents = false;
    } else {
      try {
        const eventsData = JSON.parse(eventsText);
        const events = eventsData.events || [];
        console.log(`✓ Found ${events.length} upcoming events.`);
        events.slice(0, 3).forEach(e => {
          const start = e.start?.dateTime || e.start?.date || "?";
          console.log(`   - "${e.subject}" @ ${start}`);
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
      const eventRes = await tools.ms_calendar_get_event({ eventId: firstEventId });
      const eventText = eventRes.content ? eventRes.content[0].text : "{}";

      if (eventRes.isError || eventText.includes("API Error")) {
        console.error(`✗ ms_calendar_get_event failed: ${eventText}`);
        results.calendar.getEvent = false;
      } else {
        try {
          const event = JSON.parse(eventText);
          console.log(`✓ Event: "${event.subject}"`);
          console.log(`   Location: ${event.location?.displayName || "(none)"}`);
          console.log(`   Attendees: ${(event.attendees || []).length}`);
          console.log(`   WebLink: ${event.webLink || "N/A"}`);
          console.log(`   Online Meeting: ${event.isOnlineMeeting ? "Yes" : "No"}`);
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

    const allPassed = Object.values(results.outlook).every(v => v === true || v === "skipped")
                   && Object.values(results.calendar).every(v => v === true || v === "skipped");

    return { success: allPassed, results };

  } catch (e) {
    console.error("\n✗ TEST FAILED:", e.message);
    if (e.stack) console.error(e.stack);
    return { success: false, error: e.message, results };
  }
}

return run();
