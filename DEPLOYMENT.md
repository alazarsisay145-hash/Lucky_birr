# Lucky Birr – Deployment Guide

## Overview

Lucky Birr is a Telegram Mini App raffle interface: a Node.js/Express server that hosts a static frontend (`public/`) and exposes REST + Telegram webhook endpoints.

---

## Prerequisites

- Node.js 20+
- A Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- A [Supabase](https://supabase.com) project with the `submissions` table and a `screenshots` storage bucket (see `supabase.sql`)
- A publicly accessible HTTPS URL (provided automatically by Render)

---

## Local Development

```bash
# 1. Clone the repository
git clone https://github.com/alazarsisay145-hash/Lucky_birr.git
cd Lucky_birr

# 2. Install dependencies
npm install

# 3. Copy and configure environment variables
cp .env.example .env
# Edit .env and fill in all required values

# 4. Start the server
npm start
# App available at http://localhost:10000
```

---

## Environment Variables

| Variable                  | Required | Default        | Description                                      |
|---------------------------|----------|----------------|--------------------------------------------------|
| `NODE_ENV`                | No       | –              | Set to `production` in production                |
| `PORT`                    | No       | `10000`        | HTTP listen port                                 |
| `WEBSITE_URL`             | Yes      | –              | Public HTTPS URL (e.g. `https://lucky-birr.onrender.com`) used for CORS |
| `TELEGRAM_BOT_TOKEN`      | Yes      | –              | Telegram bot token from @BotFather               |
| `TELEGRAM_WEBHOOK_SECRET` | Yes      | –              | Random secret appended to the webhook URL path   |
| `ADMIN_CHAT_ID`           | Yes      | –              | Telegram chat ID that receives submission alerts |
| `SUPABASE_URL`            | Yes      | –              | Supabase project URL                             |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes    | –              | Supabase service role key (keep secret)          |
| `SUPABASE_BUCKET`         | No       | `screenshots`  | Supabase Storage bucket name                     |

---

## Render Deployment (Recommended)

The repo includes a `render.yaml` [Render Blueprint](https://render.com/docs/blueprint-spec) that auto-configures the service.

### Steps

1. **Fork / push** this repository to your GitHub account.
2. In the [Render Dashboard](https://dashboard.render.com), click **New → Blueprint** and connect your repository.
3. Render will detect `render.yaml` and create the `lucky-birr` web service automatically.
4. In the service's **Environment** tab, supply the secret values that were marked `sync: false` in `render.yaml`:

   | Variable                  | Where to get it                          |
   |---------------------------|------------------------------------------|
   | `WEBSITE_URL`             | Your Render service URL (e.g. `https://lucky-birr.onrender.com`) |
   | `TELEGRAM_BOT_TOKEN`      | [@BotFather](https://t.me/BotFather)     |
   | `TELEGRAM_WEBHOOK_SECRET` | Any random string you choose             |
   | `ADMIN_CHAT_ID`           | Your Telegram user/chat ID               |
   | `SUPABASE_URL`            | Supabase project Settings → API          |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase project Settings → API        |

5. Click **Deploy**. Render will run `npm ci --omit=dev` then `npm start`.
6. The service health-checks `GET /healthz` – a `200 {"ok":true}` response means it is healthy.

### Register the Telegram Webhook

After your service is live, register the webhook once:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://lucky-birr.onrender.com/webhook/<TELEGRAM_WEBHOOK_SECRET>"
```

---

## Docker Deployment

```bash
# Build the image
docker build -t lucky-birr .

# Run the container
docker run -d \
  --name lucky-birr \
  -p 10000:10000 \
  -e NODE_ENV=production \
  -e WEBSITE_URL=https://your-domain.com \
  -e TELEGRAM_BOT_TOKEN=your-bot-token \
  -e TELEGRAM_WEBHOOK_SECRET=your-secret \
  -e ADMIN_CHAT_ID=your-chat-id \
  -e SUPABASE_URL=https://xxxx.supabase.co \
  -e SUPABASE_SERVICE_ROLE_KEY=your-key \
  lucky-birr
```

---

## Health Check

```bash
curl http://localhost:10000/healthz
# Expected: {"ok":true,"uptime":...}
```

---

## Runbook

### Server not starting
- Check `PORT` is not already in use: `lsof -i :10000`
- Ensure Node.js 20+ is installed: `node --version`
- Confirm all required env vars are set (app logs warnings for missing values)

### Submissions not saving
- Verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are correct
- Confirm the `submissions` table exists (run `supabase.sql` in the Supabase SQL editor)
- Confirm the `screenshots` storage bucket exists and is accessible

### Telegram notifications not arriving
- Verify `TELEGRAM_BOT_TOKEN` and `ADMIN_CHAT_ID` are set correctly
- Re-register the webhook URL with the Telegram API (see above)

### Container won't start
- Check logs: `docker logs lucky-birr`
- Ensure all required env vars are passed via `-e` flags

---

## CI/CD

The `.github/workflows/ci.yml` workflow:
- Runs on every push and pull request to `main`/`master`
- Installs dependencies, runs lint and tests
- Verifies the server starts and responds on `/healthz`
- Builds the Docker image to catch container errors early
