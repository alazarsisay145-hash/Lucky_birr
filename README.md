# Lucky Birr

Lucky Birr is a Telegram Mini App style raffle interface with tiered tickets, payment proof upload flow, admin confirmation, and live draw simulation.

## Project Structure

- `Index.html` – main application (all-in-one HTML/CSS/JS)
- `server.js` – Node.js HTTP server that serves the app
- `bot.js` – Telegram bot entry point
- `package.json` – Node.js project manifest and scripts
- `.env.example` – environment variable template
- `Dockerfile` – container build definition
- `.github/workflows/ci.yml` – CI/CD pipeline
- `DEPLOYMENT.md` – full deployment and runbook guide

## Quick Start

```bash
npm install
cp .env.example .env   # fill in BOT_TOKEN and WEBAPP_URL
npm start              # http://localhost:3000
```

## Telegram Integration

The app detects Telegram WebApp automatically when loaded inside Telegram.

Set your real app/bot URL in `Index.html`:

- `const WEBAPP_URL = 'https://t.me/LuckyBirrBot';`

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for full instructions including Docker, Railway, Render, and VPS deployment.

## Notes

- File name is `Index.html` (capital I) in this repository.
- Browser fallbacks are included for non-Telegram usage.
- Telegram Mini Apps require HTTPS in production.
