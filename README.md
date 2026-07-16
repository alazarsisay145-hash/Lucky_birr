# Lucky Birr

Lucky Birr is a Telegram Mini App lottery game served from a single HTML app with a minimal Express server for Render deployment.

## Project Structure

- `index.html` – main app entry and client-side game logic
- `server.js` – minimal Express static file server
- `render.yaml` – Render service configuration
- `bot.js` – unused placeholder file

## Run Locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Telegram Integration

The app detects Telegram WebApp automatically when loaded inside Telegram, with browser fallbacks for local testing.

## Admin Access

Tap the Admin button and enter the default PIN `1234`. Change the `ADMIN_PIN_PARTS` value in `index.html` before deploying to production.
