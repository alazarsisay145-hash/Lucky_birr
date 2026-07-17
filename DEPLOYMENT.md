# Lucky Birr – Deployment Guide

## Overview

Lucky Birr is a Telegram Mini App raffle interface served as a static HTML file via a Node.js HTTP server.

---

## Prerequisites

- Node.js 18+
- A Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- A publicly accessible HTTPS URL for the Mini App

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
# Edit .env and fill in BOT_TOKEN, WEBAPP_URL, etc.

# 4. Start the server
npm start
# App available at http://localhost:3000
```

---

## Environment Variables

| Variable              | Required | Description                                  |
|-----------------------|----------|----------------------------------------------|
| `PORT`                | No       | HTTP port (default: `3000`)                  |
| `BOT_TOKEN`           | Yes      | Telegram bot token from @BotFather           |
| `WEBAPP_URL`          | Yes      | Public HTTPS URL of the hosted Mini App      |
| `ADMIN_TELEGRAM_ID`   | No       | Telegram user ID allowed to use admin panel  |
| `NODE_ENV`            | No       | Set to `production` in production            |

---

## Docker Deployment

```bash
# Build the image
docker build -t lucky-birr .

# Run the container
docker run -d \
  --name lucky-birr \
  -p 3000:3000 \
  -e BOT_TOKEN=your-bot-token \
  -e WEBAPP_URL=https://your-domain.com \
  -e NODE_ENV=production \
  lucky-birr
```

---

## Production Deployment (Generic)

1. **Set environment variables** using your platform's secret/env management (never commit `.env` to git).
2. **Run `npm start`** – or use the provided Dockerfile.
3. **Point your Telegram Bot** to the `WEBAPP_URL` via BotFather → Edit Bot → Edit Menu Button.
4. **Use HTTPS** – Telegram Mini Apps require HTTPS. Use a reverse proxy (nginx, Caddy) or a platform like Railway/Render/Fly.io.

### Recommended platforms

| Platform  | Notes                              |
|-----------|------------------------------------|
| Railway   | Detects Node.js automatically      |
| Render    | Free tier available, supports env  |
| Fly.io    | Uses Dockerfile, global edge       |
| VPS + PM2 | `pm2 start server.js --name lucky-birr` |

---

## Health Check

Once running, verify the server responds:

```bash
curl -I http://localhost:3000/
# Expected: HTTP/1.1 200 OK
```

---

## Runbook

### Server not starting
- Check `PORT` is not already in use: `lsof -i :3000`
- Ensure Node.js 18+ is installed: `node --version`

### Telegram Mini App not loading
- Confirm `WEBAPP_URL` is publicly accessible over HTTPS
- Verify the bot's menu button or inline keyboard points to the correct URL

### Container won't start
- Check logs: `docker logs lucky-birr`
- Ensure `BOT_TOKEN` and `WEBAPP_URL` env vars are set

---

## CI/CD

The `.github/workflows/ci.yml` workflow:
- Runs on every push and pull request to `main`/`master`
- Installs dependencies, runs lint and tests
- Verifies the server starts and responds on port 3000
- Builds the Docker image to catch container errors early
