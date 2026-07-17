# Lucky Birr

Lucky Birr runs as an Express backend + static frontend, with persistent submissions in Supabase and Telegram admin notifications.

## Project Structure

- `server.js` – Express server, API routes, webhook route, static hosting
- `public/index.html` – responsive submission form UI
- `public/styles.css` – mobile-friendly styling
- `public/script.js` – frontend submission logic
- `supabase.sql` – schema for the `submissions` table
- `.env.example` – required runtime variables for Render/local

## Quick Start

```bash
npm install
cp .env.example .env
npm start
```

## Required Render Environment Variables

```env
NODE_ENV=production
PORT=10000
WEBSITE_URL=https://lucky-birr.onrender.com
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
ADMIN_CHAT_ID=7065387172
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_BUCKET=screenshots
```

## Supabase Setup

1. Run SQL from `supabase.sql` in Supabase SQL editor.
2. Create a **public** Storage bucket named `screenshots`.

## Telegram Webhook Command

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://lucky-birr.onrender.com/webhook/<TELEGRAM_WEBHOOK_SECRET>"}'
```
