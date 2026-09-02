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
| `WEBSITE_URL` | Prod | Public URL for CORS (`https://your-domain.com`) |
| `ADMIN_EMAILS` | Prod | Comma-separated admin emails |
| `TELEGRAM_BOT_TOKEN` | Optional | Enables outbound admin notifications |
| `ADMIN_CHAT_ID` | Optional | Telegram chat ID for notifications |
| `TELEGRAM_WEBHOOK_SECRET` | Optional | Enables inbound webhook endpoint |

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

## Games — Server-Authoritative Engine & Math

Keno, Higher/Lower, and Aviator are the games currently implemented in this
repository (there are no Slots/Lotto/Dice/Wheel screens yet — if a future PR
adds them, follow the same pattern described here). All wager validation,
randomness, payout calculation, and balance mutation happen **only** on the
server (`server.js` + `lib/gameMath.js` + `lib/rng.js`); the browser renders
the JSON result it receives and never computes an outcome itself.

- **RNG:** `lib/rng.js` wraps Node's `crypto` module exclusively
  (`crypto.randomInt`/`crypto.randomBytes`). `Math.random()` is never used to
  decide a monetary outcome.
- **Math version:** `lib/gameMath.js` exports `MATH_VERSION` (currently `v1`).
  Every settled round stores the math version that produced it
  (`game_rounds.math_version`), so historical rounds stay auditable even after
  a paytable changes in a future version. Paytables/weights are fixed and
  global — never personalized per player.
- **Target RTP:** 95% by default (`TARGET_RTP` env var, must be a number in
  `(0,1)` or the server falls back to 0.95 and logs a warning — invalid
  configuration is never applied silently).
- **Disclosure endpoint:** `GET /api/games/rules` returns the active math
  version, target RTP, and full paytables for in-app display.

### Calculated RTP per game (math version `v1`, target 0.95)

| Game | Method | RTP |
|---|---|---|
| Keno (pick 1) | exact (hypergeometric) | 0.9500 |
| Keno (pick 2) | exact | 0.9500 |
| Keno (pick 3) | exact | 0.9500 |
| Keno (pick 4) | exact | 0.9500 |
| Keno (pick 5) | exact | 0.9500 |
| Keno (pick 6) | exact | 0.9499 |
| Keno (pick 7) | exact | 0.9500 |
| Keno (pick 8) | exact | 0.9500 |
| Keno (pick 9) | exact | 0.9500 |
| Keno (pick 10) | exact | 0.9501 |
| Higher/Lower | analytic, conditioned on a decisive (non-push) outcome, for every visible card | exactly 0.9500 |
| Aviator | analytic, for any cashout target ≤ the 100x payout cap | exactly 0.9500 |

Keno multipliers are solved analytically per pick-count using the exact
hypergeometric distribution of hits against the 20-of-80 draw, then rounded to
the nearest cent-equivalent (0.01), so the achieved RTP is within ~0.01% of
the 95% target rather than an approximation. Higher/Lower ties (equal rank)
are an explicit **push** — the stake is fully refunded, not a loss. Aviator's
crash-point formula (`crash = max(1, TARGET_RTP / (1 - r))`) yields an exact
95% RTP for every cashout target algebraically (see comments in
`lib/gameMath.js`), independent of player strategy. All of this is verified
by exact/analytic assertions in `test/gameMath.test.js` — not simulation
approximations.

### Wallet, idempotency, and settlement

- `supabase.sql` adds a `game_rounds` table (integer-cents amounts, math
  version, idempotency key, immutable outcome/RNG metadata) and a
  `settle_game_round` Postgres function that, in a single transaction: locks
  the user's row, validates the stake against the current balance, debits the
  stake, credits the payout, records the round, and updates the running
  balance — never allowing it to go negative.
- The `(user_id, idempotency_key)` unique constraint means replayed requests
  (e.g. a client retry after a dropped response) return the original result
  instead of double-charging or double-paying. The frontend sends a fresh
  `Idempotency-Key` header per bet.
- All money math inside the settlement path uses integer minor units
  (cents), avoiding floating-point drift.

### Known limitations / responsible-gaming notes

- This project ships in **demo-credit mode only**. Nothing in this PR
  constitutes gambling authorization or independent RNG/game-math
  certification.
- Real-money deployment would additionally require: applicable gambling
  licensing, age/identity verification, geolocation checks where required,
  responsible-gaming controls (self-exclusion, deposit/loss/session limits),
  approved payment-provider integration, legal review, and independent
  security/RNG/game-math testing for the jurisdiction served. None of that is
  implemented or claimed here.
- Slots, Lotto 4/50, Dice, and Wheel are **not implemented** in this
  repository; only Keno, Higher/Lower, and Aviator exist today.



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

