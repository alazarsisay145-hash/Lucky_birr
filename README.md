# Lucky Birr

Lucky Birr is a browser-based raffle game designed for Telegram Mini App usage, backed by a Node.js/Express API and Supabase persistence.

## Quick Start (local)

```bash
npm ci
cp .env.example .env   # fill in required values
npm start              # http://localhost:10000
```

## Validation

```bash
npm run lint   # Node.js syntax check
npm test       # automated smoke tests
npm audit      # dependency security audit
```

## Environment Variables

See [`.env.example`](.env.example) for full documentation. Key required variables:

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | **Yes** | Min 32-char random secret for JWT signing |
| `SUPABASE_URL` | **Yes** | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Supabase service role key (server-side only) |
| `WEBSITE_URL` | Prod | Public HTTPS URL for CORS, no trailing slash (e.g. `https://lucky-birr.onrender.com`) |
| `ADMIN_EMAILS` | Prod | Comma-separated admin emails |
| `TELEGRAM_BOT_TOKEN` | Optional | Enables outbound admin notifications (both this and `ADMIN_CHAT_ID` required) |
| `ADMIN_CHAT_ID` | Optional | Telegram chat ID for notifications (both this and `TELEGRAM_BOT_TOKEN` required) |
| `TELEGRAM_WEBHOOK_SECRET` | Optional | Enables inbound `/webhook/:secret` endpoint |

> **Startup diagnostics:** The server emits actionable `console.warn` messages at startup for every missing or misconfigured variable. Check your Render logs if a feature is not working.

## Supabase Setup

Run [`supabase.sql`](supabase.sql) once in the Supabase SQL editor to create all tables, indexes, and constraints. The file is idempotent (`CREATE TABLE IF NOT EXISTS`). See inline comments for RLS and storage bucket setup.

## Telegram Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token into `TELEGRAM_BOT_TOKEN`.
2. Set `ADMIN_CHAT_ID` to your personal or group chat ID.
3. To receive inbound webhook calls, set `TELEGRAM_WEBHOOK_SECRET` and register the URL:
   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-domain.com/webhook/<SECRET>
   ```

**Note:** Outbound notifications require only `TELEGRAM_BOT_TOKEN` + `ADMIN_CHAT_ID`. `TELEGRAM_WEBHOOK_SECRET` is only for inbound webhook authentication.

## Health and Readiness

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Process liveness – returns `200` with uptime |
| `GET /readyz` | Dependency readiness – returns `200` if DB + JWT configured, `503` otherwise |

## Docker

```bash
docker build -t lucky-birr .
docker run -d -p 10000:10000 --env-file .env lucky-birr
```

The container runs as a non-root user and uses `npm ci` for deterministic dependency installation. A `HEALTHCHECK` is included.

## Production Deployment Checklist

- [ ] Set all **required** environment variables (see table above)
- [ ] Use a cryptographically random `JWT_SECRET` (≥ 32 chars)
- [ ] `SUPABASE_SERVICE_ROLE_KEY` is set only in server environment, never client-side
- [ ] `WEBSITE_URL` matches your public HTTPS URL exactly (used for CORS)
- [ ] Run `supabase.sql` in Supabase SQL editor
- [ ] Create the `screenshots` storage bucket in Supabase (see `supabase.sql` comments)
- [ ] Verify `GET /readyz` returns `200 ok:true` before routing traffic
- [ ] Confirm `npm audit` reports no high/critical vulnerabilities

## Operations

- **Logs:** Standard stdout/stderr – use your platform's log aggregation
- **Health check:** Poll `GET /healthz` (process alive) and `GET /readyz` (deps ready)
- **Backups:** Use Supabase's built-in PITR or scheduled exports
- **Secret rotation:** Update `JWT_SECRET` → restart server (existing tokens invalidate immediately)
- **Rollback:** Deploy previous image/release; no DB migration needed for rollback of app code

## CI

GitHub Actions runs on every push/PR: `npm ci` → syntax lint → tests → `npm audit --audit-level=high` → server smoke test → Docker build.

## Deployment

Lucky Birr is a full-stack Express application. It **cannot be hosted on GitHub Pages** (or any static host) because it requires a running Node.js server for authentication, submissions, and API routes.

Deploy to **Render** using the included `render.yaml` Blueprint:

1. Push this repository to GitHub.
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint** → connect this repo.
3. Render creates a **Web Service** with `npm ci`, `npm start`, and `/healthz` health checks pre-configured.
4. Set the required environment variables in the Render dashboard (see table above and `render.yaml` comments).
5. After the first deploy completes, copy your Render service URL (e.g. `https://lucky-birr.onrender.com`) and set it as `WEBSITE_URL` in the Render environment, then **redeploy**.
6. Verify: `GET https://your-service.onrender.com/healthz` → `{"ok":true}` and `/readyz` → `{"ok":true}`.

See [DEPLOYMENT.md](DEPLOYMENT.md) for full step-by-step instructions including Supabase setup.

