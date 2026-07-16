# Lucky Birr

Lucky Birr is a Telegram Mini App style raffle interface with tiered tickets, payment proof upload flow, admin confirmation, and live draw simulation.

## Project Structure

- `Index.html` – main HTML entry (loads external CSS/JS)
- `styles.css` – all UI styling
- `app.js` – app logic and interactions
- `manifest.webmanifest` – optional install metadata
- `.gitignore` – ignores local/editor/system files

## Run Locally

Open `Index.html` directly in your browser, or serve with any static server.

## Telegram Integration

The app detects Telegram WebApp automatically when loaded inside Telegram.

Set your real app/bot URL in `app.js`:

- `const WEBAPP_URL = 'https://t.me/LuckyBirrBot';`

## Notes

- File name is `Index.html` (capital I) in this repository.
- Browser fallbacks are included for non-Telegram usage.
