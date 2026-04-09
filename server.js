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

// Fetch Content information from the embedded database inside an Asset page
async function getContentInfo(pageId) {
  try {
    // Step 1: Get the page's block children to find the inline database
    const blocks = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 30
    });

    // Step 2: Find the child_database block (Content information)
    const dbBlock = blocks.results.find(b => b.type === 'child_database');
    if (!dbBlock) return null;

    // Step 3: Query that database to get its rows
    const dbRows = await notion.databases.query({
      database_id: dbBlock.id,
      page_size: 1
    });

    if (dbRows.results.length === 0) return null;

    // Step 4: Extract Content status, Content objective, Content track
    const row = dbRows.results[0];
    const props = row.properties;

    return {
      contentStatus: props['Content status']?.select?.name || null,
      contentObjective: props['Content objective']?.select?.name || null,
      contentTrack: props['Content track']?.select?.name || null
    };
  } catch (err) {
    console.error(`Error fetching content info for page ${pageId}:`, err.message);
    return null;
  }
}

// Rate-limited batch processing (Notion API allows ~3 requests/sec)
async function batchProcess(items, fn, batchSize = 3, delayMs = 350) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + batchSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return results;
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
    notionUrl: page.url,
    // Content info fields (populated later for Asset items)
    contentStatus: null,
    contentObjective: null,
    contentTrack: null
  };
}

// API endpoint: get all activities for calendar
app.get('/api/activities', async (req, res) => {
  try {
    console.log('Fetching all activities...');
    const pages = await getAllActivities();
    const activities = pages.map(transformPage);
    console.log(`Found ${activities.length} activities total.`);

    // Fetch Content info for Asset items only
    const assetActivities = activities.filter(a => a.category === 'Asset');
    console.log(`Fetching content info for ${assetActivities.length} Asset items...`);

    await batchProcess(assetActivities, async (activity) => {
      const contentInfo = await getContentInfo(activity.id);
      if (contentInfo) {
        activity.contentStatus = contentInfo.contentStatus;
        activity.contentObjective = contentInfo.contentObjective;
        activity.contentTrack = contentInfo.contentTrack;
      }
    });

    const withContent = assetActivities.filter(a => a.contentStatus || a.contentObjective || a.contentTrack);
    console.log(`Successfully fetched content info for ${withContent.length}/${assetActivities.length} Asset items.`);

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
