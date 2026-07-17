# Lucky Birr

Lucky Birr runs as an Express backend + static frontend, with persistent submissions in Supabase and optional Telegram admin notifications.

## Project Structure

- `server.js` – Express server, API routes, webhook route, static hosting
- `public/index.html` – game-first landing + payment submission UI
- `public/styles.css` – mobile-friendly styling
- `public/script.js` – play flow + frontend submission logic
- `supabase.sql` – schema for the `submissions` table
- `.env.example` – required runtime variables for Render/local

## Quick Start

```bash
npm install
cp .env.example .env
npm start
```

## Runtime

- Node.js 22.x

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

## Player Flow

1. Player opens the site and sees the game-first landing screen.
2. Player clicks **Play Now** to open the payment submission form.
3. Submission is saved with `status = pending` and awaits approval.

Telegram notifications are best-effort and non-blocking: if Telegram is not configured or Telegram API calls fail, submissions still succeed.

## Telegram Webhook Command

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://lucky-birr.onrender.com/webhook/<TELEGRAM_WEBHOOK_SECRET>"}'
```
