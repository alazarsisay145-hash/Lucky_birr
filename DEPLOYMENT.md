# Deploying Lucky Birr on Render

This guide explains how to deploy Lucky Birr to [Render](https://render.com).

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Static HTML/CSS/JS (`Index.html`) |
| Server | Node.js (`server.js`) – serves static files and a `/healthz` health check |
| Bot backend | `bot.js` – Telegram bot webhook (extend as needed) |

---

## Required Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | Auto | Injected by Render – do not set manually |
| `NODE_ENV` | Yes | Set to `production` (handled in `render.yaml`) |
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from [@BotFather](https://t.me/BotFather) |
| `WEBAPP_URL` | Yes | Full public URL of the deployed app (e.g. `https://lucky-birr.onrender.com`) |

Set `TELEGRAM_BOT_TOKEN` and `WEBAPP_URL` as **secret environment variables** in the Render dashboard — never commit them.

---

## Build & Start Commands

| Step | Command |
|---|---|
| Build | `npm install --production` |
| Start | `npm start` (runs `node server.js`) |

---

## Deploy on Render

### Option A – Blueprint (recommended)

1. Fork or push this repository to your GitHub account.
2. In the [Render dashboard](https://dashboard.render.com), click **New → Blueprint**.
3. Connect your repository – Render will detect `render.yaml` and pre-fill the service settings.
4. Add the secret env vars (`TELEGRAM_BOT_TOKEN`, `WEBAPP_URL`) in the dashboard.
5. Click **Apply** – Render builds and deploys automatically.

### Option B – Manual Web Service

1. In the Render dashboard click **New → Web Service**.
2. Connect your GitHub repository.
3. Fill in:
   - **Environment**: `Node`
   - **Build Command**: `npm install --production`
   - **Start Command**: `npm start`
4. Under **Environment Variables**, add:
   - `NODE_ENV` = `production`
   - `TELEGRAM_BOT_TOKEN` = *(your bot token)*
   - `WEBAPP_URL` = *(your Render service URL)*
5. Click **Create Web Service**.

---

## Post-Deploy Verification

1. Open the service URL in a browser – you should see the Lucky Birr raffle UI.
2. Hit the health check endpoint:
   ```
   curl https://<your-service>.onrender.com/healthz
   ```
   Expected response: `OK`
3. Set the Telegram Mini App URL in [@BotFather](https://t.me/BotFather):
   - `/mybots` → select your bot → **Bot Settings → Menu Button** → set the URL to your Render URL.
4. Open the Mini App inside Telegram and verify ticket selection and payment-proof flow work end-to-end.

---

## Local Development

```bash
# Install dependencies
npm install

# Copy and edit environment variables
cp .env.example .env
# Edit .env with your real values

# Start the server
npm start
# App is available at http://localhost:3000
```

---

## Notes

- Render's free tier may spin down after inactivity; upgrade to a paid plan for always-on service.
- The `PORT` is injected by Render – `server.js` reads `process.env.PORT` automatically.
- Debug mode is off in production (`NODE_ENV=production`).
