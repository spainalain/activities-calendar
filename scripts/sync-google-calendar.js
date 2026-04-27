// scripts/sync-google-calendar.js
//
// Sync Notion Activities (via the Render /api/activities feed) into the
// Lambda Marketing Activities Google Calendar. Run on a 15-min schedule
// from GitHub Actions.

const { google } = require('googleapis');

const RENDER_API = 'https://activities-calendar.onrender.com/api/activities';
const env = process.env;
const CALENDAR_ID = env.GOOGLE_CALENDAR_ID;
const SA_KEY = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');

const COLOR_MAP = {
  Event: '5',
  Campaign: '3',
  Asset: '8',
  Project: '6',
  'PR & Comms': '4',
};

const SOURCE_TAG = 'notion-activities-sync';
const EVENT_ID_PREFIX = 'notion';

function notionToEventId(notionId) {
  return EVENT_ID_PREFIX + notionId.replace(/-/g, '').toLowerCase();
}

function addOneDay(yyyymmdd) {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

function buildEventBody(activity) {
  // Skip Action Item types — only Parent and Milestone activities sync to Google Calendar
  if (activity.type && activity.type.startsWith('Action item')) return null;

  const end = activity.endDate && activity.endDate.start;
  const start = activity.startDate && activity.startDate.start;
  const isEvent = activity.type === 'Parent - Event';

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
    if (!end) return null;
    eventStart = end;
    eventEndExclusive = addOneDay(end);
  }

  const owners = (activity.owner || []).join(', ') || '—';
  const description = [
    'Status: ' + (activity.status || '—'),
    'Type: ' + (activity.type || '—'),
    'Owner: ' + owners,
    'Strategic Initiative: ' + (activity.strategicInitiative || '—'),
    'Lifecycle: ' + (activity.lifecycle || '—'),
    '',
    'Notion: ' + activity.notionUrl,
  ].join('\n');

  const activityId = activity.id;
  return {
    id: notionToEventId(activityId),
    summary: activity.name,
    description: description,
    start: { date: eventStart },
    end: { date: eventEndExclusive },
    colorId: COLOR_MAP[activity.category],
    extendedProperties: {
      private: {
        source: SOURCE_TAG,
        notionId: activityId,
      },
    },
  };
}

function eventsEqual(a, b) {
  return (
    a.summary === b.summary &&
    a.description === b.description &&
    (a.start && a.start.date) === (b.start && b.start.date) &&
    (a.end && a.end.date) === (b.end && b.end.date) &&
    (a.colorId || null) === (b.colorId || null)
  );
}

async function listAllManagedEvents(cal) {
  const events = new Map();
  let pageToken;
  do {
    const res = await cal.events.list({
      calendarId: CALENDAR_ID,
      maxResults: 250,
      privateExtendedProperty: 'source=' + SOURCE_TAG,
      showDeleted: false,
      singleEvents: false,
      pageToken: pageToken,
    });
    const items = (res.data && res.data.items) || [];
    for (const ev of items) {
      const evId = ev.id;
      events.set(evId, ev);
    }
    pageToken = res.data && res.data.nextPageToken;
  } while (pageToken);
  return events;
}

function isAlreadyDeleted(err) {
  const code = err.code || (err.response && err.response.status);
  const msg = (err.message || '').toLowerCase();
  return code === 410 || msg.includes('has been deleted');
}

function isRateLimit(err) {
  const code = err.code || (err.response && err.response.status);
  const msg = err.message || '';
  return code === 429 || (code === 403 && /rate limit|quota/i.test(msg));
}

async function callWithBackoff(fn, label) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimit(err) && attempt < 3) {
        const wait = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
        console.log('Rate limited on ' + label + ', waiting ' + wait + 'ms (retry ' + (attempt + 2) + '/4)');
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

async function main() {
  if (!CALENDAR_ID) throw new Error('GOOGLE_CALENDAR_ID is not set');
  if (!SA_KEY || !SA_KEY.client_email) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is malformed');

  const auth = new google.auth.JWT({
    email: SA_KEY.client_email,
    key: SA_KEY.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  await auth.authorize();
  const cal = google.calendar({ version: 'v3', auth: auth });

  const res = await fetch(RENDER_API);
  if (!res.ok) throw new Error('Render API failed: ' + res.status + ' ' + res.statusText);
  const payload = await res.json();
  if (!payload.success) throw new Error('Render API returned success=false');
  const activities = (payload && payload.data) || [];
  console.log('Fetched ' + activities.length + ' activities from Render');

  const expected = new Map();
  for (const a of activities) {
    const body = buildEventBody(a);
    if (body) {
      const bId = body.id;
      expected.set(bId, body);
    }
  }
  console.log(expected.size + ' activities will be synced (rest skipped)');

  const existing = await listAllManagedEvents(cal);
  console.log('Found ' + existing.size + ' existing managed events on the calendar');

  let inserted = 0, updated = 0, unchanged = 0, deleted = 0, errors = 0;
  const THROTTLE_MS = 150;

  for (const [id, body] of expected) {
    const existingEvent = existing.get(id);
    try {
      if (!existingEvent) {
        await callWithBackoff(
          () => cal.events.insert({ calendarId: CALENDAR_ID, requestBody: body }),
          'insert ' + id
        );
        inserted++;
        await new Promise((r) => setTimeout(r, THROTTLE_MS));
      } else if (!eventsEqual(existingEvent, body)) {
        await callWithBackoff(
          () => cal.events.update({ calendarId: CALENDAR_ID, eventId: id, requestBody: body }),
          'update ' + id
        );
        updated++;
        await new Promise((r) => setTimeout(r, THROTTLE_MS));
      } else {
        unchanged++;
      }
    } catch (err) {
      console.error('Error syncing ' + id + ' (' + body.summary + '):', err.message);
      errors++;
    }
  }

  for (const [id, ev] of existing) {
    if (!expected.has(id)) {
      try {
        await callWithBackoff(
          () => cal.events.delete({ calendarId: CALENDAR_ID, eventId: id }),
          'delete ' + id
        );
        deleted++;
      } catch (err) {
        if (isAlreadyDeleted(err)) {
          deleted++;
        } else {
          console.error('Error deleting ' + id + ' (' + ev.summary + '):', err.message);
          errors++;
        }
      }
      await new Promise((r) => setTimeout(r, THROTTLE_MS));
    }
  }

  console.log('Sync complete — inserted: ' + inserted + ', updated: ' + updated + ', unchanged: ' + unchanged + ', deleted: ' + deleted + ', errors: ' + errors);

  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});
