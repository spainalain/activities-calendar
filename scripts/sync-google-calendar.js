// scripts/sync-google-calendar.js
//
// Sync Notion Activities (via the Render /api/activities feed) into the
// Lambda Marketing Activities Google Calendar. Run on a 15-min schedule
// from GitHub Actions.

const { google } = require('googleapis');

const RENDER_API = 'https://activities-calendar.onrender.com/api/activities';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const SA_KEY = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

// Match Render calendar category colors (Google Calendar colorIds 1-11)
const COLOR_MAP = {
  Event: '5',        // banana / yellow
  Campaign: '3',     // grape / purple
  Asset: '8',        // graphite / brown-gray
  Project: '6',      // tangerine / orange
  'PR & Comms': '4', // flamingo / pink
};

const SOURCE_TAG = 'notion-activities-sync';
const EVENT_ID_PREFIX = 'notion';

function notionToEventId(notionId) {
  // Calendar event IDs must be base32hex (lowercase a-v + 0-9), 5-1024 chars.
  // Notion IDs are hex UUIDs, which are a subset of base32hex. Strip dashes.
  return EVENT_ID_PREFIX + notionId.replace(/-/g, '').toLowerCase();
}

function addOneDay(yyyymmdd) {
  // Google Calendar's all-day end date is exclusive, so add one day.
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

function buildEventBody(activity) {
  const end = activity.endDate?.start;
  const start = activity.startDate?.start;
  const isEvent = activity.type === 'Parent - Event';

  // End Date is the golden rule. For non-Event types, require End Date.
  // For Parent - Event, allow span from Start to End.
  let eventStart, eventEndExclusive;
  if (isEvent) {
    if (!end && !start) return null;
    if (start && end && start !== end) {
      eventStart = start;
      eventEndExclusive = addOneDay(end);
    } else {
      const single = end || start;
      eventStart = single;
      eventEndExclusive = addOneDay(single);
    }
  } else {
    if (!end) return null; // skip non-Event activities without End Date
    eventStart = end;
    eventEndExclusive = addOneDay(end);
  }

  const owners = (activity.owner || []).join(', ') || '—';
  const description = [
    `Status: ${activity.status || '—'}`,
    `Type: ${activity.type || '—'}`,
    `Owner: ${owners}`,
    `Strategic Initiative: ${activity.strategicInitiative || '—'}`,
    `Lifecycle: ${activity.lifecycle || '—'}`,
    '',
    `Notion: ${activity.notionUrl}`,
  ].join('\n');

  return {
    id: notionToEventId(activity.id),
    summary: activity.name,
    description,
    start: { date: eventStart },
    end: { date: eventEndExclusive },
    colorId: COLOR_MAP[activity.category],
    extendedProperties: {
      private: {
        source: SOURCE_TAG,
        notionId: activity.id,
      },
    },
  };
}

function eventsEqual(a, b) {
  return (
    a.summary === b.summary &&
    a.description === b.description &&
    a.start?.date === b.start?.date &&
    a.end?.date === b.end?.date &&
    (a.colorId || null) === (b.colorId || null)
  );
}

async function listAllManagedEvents(calendar) {
  const events = new Map();
  let pageToken;
  do {
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      maxResults: 250,
      privateExtendedProperty: `source=${SOURCE_TAG}`,
      showDeleted: false,
      singleEvents: false,
      pageToken,
    });
    for (const ev of res.data.items || []) {
      events.set(ev.id, ev);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return events;
}

async function main() {
  if (!CALENDAR_ID) throw new Error('GOOGLE_CALENDAR_ID is not set');
  if (!SA_KEY?.client_email) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is malformed');

  const auth = new google.auth.JWT({
    email: SA_KEY.client_email,
    key: SA_KEY.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  await auth.authorize();
  const calendar = google.calendar({ version: 'v3', auth });

  // 1. Fetch activities from Render
  const res = await fetch(RENDER_API);
  if (!res.ok) throw new Error(`Render API failed: ${res.status} ${res.statusText}`);
  const payload = await res.json();
  if (!payload.success) throw new Error(`Render API returned success=false`);
  const activities = payload.data || [];
  console.log(`Fetched ${activities.length} activities from Render`);

  // 2. Build expected event set (skipping activities with no valid date)
  const expected = new Map();
  for (const a of activities) {
    const body = buildEventBody(a);
    if (body) expected.set(body.id, body);
  }
  console.log(`${expected.size} activities will be synced (rest skipped due to missing End Date)`);

  // 3. List all events we currently manage on this calendar
  const existing = await listAllManagedEvents(calendar);
  console.log(`Found ${existing.size} existing managed events on the calendar`);

  // 4. Compute work
  let inserted = 0, updated = 0, unchanged = 0, deleted = 0, errors = 0;

  // Inserts and updates
  for (const [id, body] of expected) {
    const existingEvent = existing.get(id);
    try {
      if (!existingEvent) {
        await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: body });
        inserted++;
      } else if (!eventsEqual(existingEvent, body)) {
        await calendar.events.update({
          calendarId: CALENDAR_ID,
          eventId: id,
          requestBody: body,
        });
        updated++;
      } else {
        unchanged++;
      }
    } catch (err) {
      console.error(`Error syncing ${id} (${body.summary}):`, err.message);
      errors++;
    }
  }

  // Deletes (events on calendar that are no longer in expected set)
  for (const [id, ev] of existing) {
    if (!expected.has(id)) {
      try {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: id });
        deleted++;
      } catch (err) {
        console.error(`Error deleting ${id} (${ev.summary}):`, err.message);
        errors++;
      }
    }
  }

  console.log(
    `Sync complete — inserted: ${inserted}, updated: ${updated}, ` +
    `unchanged: ${unchanged}, deleted: ${deleted}, errors: ${errors}`
  );

  if (errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});
