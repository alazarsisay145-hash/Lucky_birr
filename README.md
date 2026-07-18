# Lucky Birr

Lucky Birr is a browser-based raffle game designed for Telegram Mini App usage and static hosting.

## How to play

1. Select a tier (Mini / Standard / Premium).
2. Tap a ticket and reserve it with your name + phone.
3. Admin confirms tickets as sold.
4. Start the live draw once at least 3 tickets are sold.
5. Review winners and share draw results.

## What was improved

- Fixed serving path so the real game shell is loaded at `/`.
- Stabilized draw/restart flow by clearing active timers when restarting or switching tiers.
- Fixed share flow runtime issue (`WEBAPP_URL` now defined from current page URL).
- Improved keyboard and accessibility support:
  - Keyboard-open for ticket actions and upload area
  - Escape-to-close modal support
  - Clear focus-visible styling
  - Reduced-motion CSS fallback
- Added a lightweight automated smoke test for startup and game shell rendering.
- Added GitHub Pages deployment workflow for project-site hosting.

## Local development

```bash
npm install
npm start
```

Then open `http://localhost:10000` (or your configured `PORT`).

## Validation

```bash
npm run lint
npm test
```

`npm test` runs a Node smoke test that starts the server and verifies the game page is served.

## GitHub Pages deployment

This repository includes `.github/workflows/pages.yml`, which deploys the static game to GitHub Pages from `Index.html` (published as `index.html` in the artifact).

After merging:

1. Go to **Repository Settings → Pages**.
2. Set **Source** to **GitHub Actions**.
3. Push to `main`/`master` (or run the workflow manually).
4. Open: `https://alazarsisay145-hash.github.io/Lucky_birr/`

Because the deployed page is a single self-contained HTML file, there are no broken relative asset paths under `/Lucky_birr/`.
