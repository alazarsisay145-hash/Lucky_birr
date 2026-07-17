# Lucky Birr

Lucky Birr is a Telegram Mini App style raffle interface with tiered tickets, payment proof upload flow, admin confirmation, and live draw simulation.

## Project Structure

- `Index.html` – main HTML entry (loads external CSS/JS)
- `styles.css` – all UI styling
- `app.js` – app logic and interactions
- `manifest.webmanifest` – optional install metadata
- `.gitignore` – ignores local/editor/system files

## Run Locally

Open `Index.html` directly in your browser, or start the Node.js server:

```bash
npm install
npm start   # http://localhost:3000
```

## Telegram Integration

The app detects Telegram WebApp automatically when loaded inside Telegram.

Set your real app/bot URL in `app.js`:

- `const WEBAPP_URL = 'https://t.me/LuckyBirrBot';`

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for full instructions on deploying to [Render](https://render.com), including required environment variables, build/start commands, and post-deploy verification steps.

## Notes

- File name is `Index.html` (capital I) in this repository.
- Browser fallbacks are included for non-Telegram usage.
