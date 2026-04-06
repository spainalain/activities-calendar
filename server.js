require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Client } = require('@notionhq/client');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Fetch all pages from the Activities database (handles pagination)
async function getAllActivities() {
  const allPages = [];
  let cursor = undefined;

  do {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
      filter: {
        timestamp: 'created_time',
        created_time: { on_or_after: '2026-01-01' }
      }
    });

    allPages.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return allPages;
}

// Transform Notion pages into calendar-friendly format
function transformPage(page) {
  const props = page.properties;

  const getName = () => {
    const title = props['Name']?.title;
    return title?.map(t => t.plain_text).join('') || 'Untitled';
  };

  const getSelect = (propName) => {
    return props[propName]?.select?.name || null;
  };

  const getStatus = () => {
    return props['Status']?.status?.name || null;
  };

  const getDate = (propName) => {
    const date = props[propName]?.date;
    if (!date) return null;
    return { start: date.start, end: date.end };
  };

  const getRelation = (propName) => {
    return props[propName]?.relation?.map(r => r.id) || [];
  };

  const getPeople = (propName) => {
    return props[propName]?.people?.map(p => p.name || p.id) || [];
  };

  const type = getSelect('Type') || '';
  const isParent = type.startsWith('Parent');
  const isMilestone = type.startsWith('Milestone');
  const isActionItem = type.startsWith('Action item');

  // Extract category from type (e.g., "Parent - Event" -> "Event")
  const category = type.split(' - ')[1] || 'Other';

  return {
    id: page.id,
    name: getName(),
    type: type,
    category: category,
    isParent: isParent,
    isMilestone: isMilestone,
    isActionItem: isActionItem,
    status: getStatus(),
    startDate: getDate('Start date'),
    endDate: getDate('End date (due date)'),
    parentItem: getRelation('Parent item'),
    subItems: getRelation('Sub-item'),
    owner: getPeople('Owner (DRI)'),
    lifecycle: getSelect('Lifecycle'),
    strategicInitiative: getSelect('Strategic Initiative'),
    notionUrl: page.url
  };
}

// API endpoint: get all activities for calendar
app.get('/api/activities', async (req, res) => {
  try {
    const pages = await getAllActivities();
    const activities = pages.map(transformPage);
    res.json({ success: true, data: activities, count: activities.length });
  } catch (error) {
    console.error('Error fetching activities:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Serve the calendar HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Activities Calendar running at http://localhost:${PORT}`);
});
