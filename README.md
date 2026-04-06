# Activities Calendar

A custom calendar view that shows **all** Notion Activities items — both parent items and sub-items — solving the Notion limitation where calendar views only display parent items.

## Quick Setup

### 1. Create a Notion Integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **+ New integration**
3. Name it "Activities Calendar"
4. Select your workspace
5. Under **Capabilities**, enable "Read content"
6. Click **Submit** and copy the **Internal Integration Secret**

### 2. Share the Database with the Integration

1. Open your Activities database in Notion
2. Click the **...** menu in the top right
3. Click **Connect to** → search for "Activities Calendar"
4. Click **Confirm**

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and paste your integration token:

```
NOTION_API_KEY=ntn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=3200571b42f3800fa077f6403964d566
PORT=3000
```

### 4. Run Locally

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) to view the calendar.

## Deploy for Notion Embed

To embed this in Notion, you need to host it publicly. Here are two easy options:

### Option A: Deploy to Render (free tier)

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your repo
4. Set environment variables (`NOTION_API_KEY`, `NOTION_DATABASE_ID`)
5. Deploy — you'll get a URL like `https://activities-calendar-xxxx.onrender.com`

### Option B: Deploy to Railway

1. Install Railway CLI: `npm install -g @railway/cli`
2. Run `railway login && railway init && railway up`
3. Set env vars in Railway dashboard
4. Get your public URL

### Embed in Notion

Once deployed:

1. Open any Notion page
2. Type `/embed`
3. Paste your deployment URL
4. The calendar will render inline on the page

## Features

- Shows **all items**: parents, milestones, and action items
- **Color-coded by category**: Event (yellow), Campaign (purple), Asset (brown), Project (orange), PR & Comms (pink)
- **Filter by**: category, item type (parent/milestone/action), and status
- **Status indicators**: colored dots showing Backlog, Not started, In progress, Done
- **Click any item** to see details and jump to Notion
- **Multi-day spans**: items with start and end dates render across multiple days
- **Keyboard navigation**: arrow keys for months, Escape to close popups
- **Live data**: always pulls the latest from Notion (no sync needed)
