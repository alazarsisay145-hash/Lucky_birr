# Lucky Birr – Deployment Guide

## Overview

Lucky Birr is a Telegram Mini App raffle interface served by a Node.js/Express API with Supabase persistence and optional Telegram notifications.

---

## Prerequisites

- Node.js 22 (`node -v` should show `v22.x`)
- Supabase project with SQL schema applied (see [supabase.sql](supabase.sql))
- A Telegram Bot Token (optional, for admin notifications)

---

## Local Development

```bash
# 1. Clone the repository
git clone https://github.com/alazarsisay145-hash/Lucky_birr.git
cd Lucky_birr

# 2. Install dependencies (deterministic)
npm ci

# 3. Copy and configure environment variables
cp .env.example .env
# Edit .env – at minimum set JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

# 4. Start the server
npm start
# App available at http://localhost:10000
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `JWT_SECRET` | **Yes** | — | Min 32-char random secret for JWT signing |
| `SUPABASE_URL` | **Yes** | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | — | Supabase service role key (server-side only, never expose to clients) |
| `WEBSITE_URL` | **Prod** | — | Public HTTPS URL for CORS (e.g. `https://lucky-birr.onrender.com`) |
| `ADMIN_EMAILS` | Prod | — | Comma-separated admin email addresses |
| `PORT` | No | `10000` | HTTP port |
| `NODE_ENV` | No | `development` | Set to `production` in production |
| `SUPABASE_BUCKET` | No | `screenshots` | Supabase storage bucket name |
| `TELEGRAM_BOT_TOKEN` | No | — | Telegram bot token – enables outbound admin notifications |
| `ADMIN_CHAT_ID` | No | — | Telegram chat/user ID for notifications |
| `TELEGRAM_WEBHOOK_SECRET` | No | — | Secret path segment – enables inbound webhook endpoint |

> **Note:** `TELEGRAM_WEBHOOK_SECRET` is only required for the inbound `/webhook/:secret` endpoint. It is **not** required for outbound admin notifications (those only need `TELEGRAM_BOT_TOKEN` + `ADMIN_CHAT_ID`).

---

## Supabase Setup

1. Open your Supabase project → SQL editor.
2. Run the contents of [`supabase.sql`](supabase.sql) (idempotent – safe to re-run).
3. Create the storage bucket:
   ```sql
   insert into storage.buckets (id, name, public) values ('screenshots', 'screenshots', true)
   on conflict do nothing;
   ```
4. (Recommended) Enable Row Level Security and add policies per the comments in `supabase.sql`.

---

## Telegram Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) → copy the token to `TELEGRAM_BOT_TOKEN`.
2. Set `ADMIN_CHAT_ID` to your Telegram user or group chat ID.
3. Optional – enable inbound webhook:
   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-domain.com/webhook/<SECRET>
   ```
   where `<SECRET>` matches `TELEGRAM_WEBHOOK_SECRET`.

---

## Docker Deployment

```bash
# Build the image
docker build -t lucky-birr .

# Run the container
docker run -d \
  --name lucky-birr \
  -p 10000:10000 \
  --env-file .env \
  lucky-birr

# Check health
docker inspect --format='{{.State.Health.Status}}' lucky-birr
```

The Dockerfile:
- Uses `node:22-alpine`
- Installs only production dependencies via `npm ci`
- Runs as a non-root user
- Exposes port 10000 (matches default `PORT`)
- Includes a `HEALTHCHECK` against `/healthz`

---

## Health and Readiness Endpoints

| Endpoint | Purpose | Success |
|---|---|---|
| `GET /healthz` | Process liveness | `200 { ok: true, uptime: N }` |
| `GET /readyz` | Dependency readiness (DB + JWT) | `200 { ok: true, checks: {...} }` |

Use `/readyz` in your load balancer/orchestrator readiness probe. It returns `503` if the database or JWT secret is not configured.

---

## Production Deployment Checklist

- [ ] Set all **required** environment variables
- [ ] `JWT_SECRET` is cryptographically random (≥ 32 characters)
- [ ] `SUPABASE_SERVICE_ROLE_KEY` is only in the server environment, never in client code
- [ ] `WEBSITE_URL` exactly matches your public HTTPS URL
- [ ] `supabase.sql` has been applied in Supabase
- [ ] Storage bucket `screenshots` created in Supabase
- [ ] `GET /readyz` returns `200 ok:true` before routing live traffic
- [ ] `npm audit --audit-level=high` reports zero findings
- [ ] Node.js 22 is installed on the deployment target

---

## Rollback

1. Identify the previous working image tag or git ref.
2. Deploy the previous image/release.
3. No database migration is needed for app-only rollbacks (schema changes are additive and idempotent).
4. Verify `GET /readyz` returns `200` after rollback.

---

## Operations

### Logs
- Structured request logs via `morgan` (format: `tiny` in production, `dev` locally).
- Errors logged to stderr with `console.error`.
- Use your platform's log aggregation (Render Logs, Fly.io `fly logs`, `docker logs`, etc.).

### Backups
- Enable Supabase Point-in-Time Recovery (PITR) in the Supabase dashboard.
- For free-tier projects, periodically export data via the Supabase table editor.

### Secret Rotation
- `JWT_SECRET`: update the env var and restart. All existing tokens are immediately invalidated; users must log in again.
- `SUPABASE_SERVICE_ROLE_KEY`: rotate in Supabase dashboard → update env var → restart.
- `TELEGRAM_BOT_TOKEN`: generate a new token via BotFather → update env var → re-register webhook URL.

### Runbook

**Server not starting**
- Check port conflicts: `lsof -i :10000`
- Ensure Node.js 22 is installed: `node --version`
- Verify required env vars are set

**`GET /readyz` returns 503**
- Check `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `JWT_SECRET` are set
- Test Supabase connectivity independently

**Telegram notifications not sending**
- Verify `TELEGRAM_BOT_TOKEN` and `ADMIN_CHAT_ID` are set (webhook secret is **not** required for notifications)
- Test bot token: `curl https://api.telegram.org/bot<TOKEN>/getMe`

**Container won't start**
- Check logs: `docker logs lucky-birr`
- Confirm all required env vars are provided to `docker run`
