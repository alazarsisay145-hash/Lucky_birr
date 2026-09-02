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
| `TELEBIRR_NUMBER` | Optional | Telebirr destination shown to players (default `0936719379`) |
| `TELEBIRR_ACCOUNT_HOLDER` | Optional | Name displayed next to the Telebirr number |
| `MANUAL_PAYMENT_ACCOUNTS_JSON` | Optional | JSON array of extra (bank) destinations, validated at startup |
| `MANUAL_PROOF_BUCKET` | Optional | **Private** Supabase Storage bucket for proof screenshots (default `deposit-proofs`) |
| `CHAPA_ENABLED` | Optional | `true` turns the legacy automatic gateway back on (default off) |
| `CHAPA_SECRET_KEY` | Chapa only | Chapa secret key (use a `CHASECK_TEST-` key outside production) |
| `CHAPA_WEBHOOK_SECRET` | Chapa only | Verifies the Chapa callback signature |
| `DEPOSIT_MIN_ETB` / `DEPOSIT_MAX_ETB` | Optional | Deposit limits in ETB (default `10` / `50000`) |
| `WITHDRAW_MIN_ETB` / `WITHDRAW_MAX_ETB` | Optional | Withdrawal limits in ETB (default `50` / `25000`) |
| `FAST_KENO_BETTING_MS` | Optional | Fast Keno betting window (default `20000`) |
| `FAST_KENO_DRAWING_MS` | Optional | Fast Keno drawing phase (default `6000`) |
| `FAST_KENO_RESULT_MS` | Optional | Fast Keno result phase (default `6000`) |

The Chapa gateway is **disabled by default**; it only comes back to life when
`CHAPA_ENABLED=true` *and* `CHAPA_SECRET_KEY` are both set. When it is enabled,
the callback URL to register in the dashboard is
`<WEBSITE_URL>/api/deposits/callback`.

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

Fast Keno, Keno, Higher/Lower, Aviator, and Dice are the games currently
implemented in this repository (there are no Slots/Lotto/Wheel screens yet —
if a future PR adds them, follow the same pattern described here). All wager
validation,
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
| Fast Keno (pick 1–8) | exact (hypergeometric, 10-of-40 draw) | 0.9500 |
| Higher/Lower | analytic, conditioned on a decisive (non-push) outcome, for every visible card | exactly 0.9500 |
| Aviator | analytic, for any cashout target ≤ the 100x payout cap | exactly 0.9500 |
| Dice | analytic, for every legal target and direction | exactly 0.9500 |

Keno multipliers are solved analytically per pick-count using the exact
hypergeometric distribution of hits against the 20-of-80 draw, then rounded to
the nearest cent-equivalent (0.01), so the achieved RTP is within ~0.01% of
the 95% target rather than an approximation. Higher/Lower ties (equal rank)
are an explicit **push** — the stake is fully refunded, not a loss. Aviator's
crash-point formula (`crash = max(1, TARGET_RTP / (1 - r))`) yields an exact
95% RTP for every cashout target algebraically (see comments in
`lib/gameMath.js`), independent of player strategy. All of this is verified
by exact/analytic assertions in `test/gameMath.test.js` — not simulation
approximations. Dice rolls 1–100 and pays `TARGET_RTP * 100 / winning_faces`,
so its RTP is identical for every target and direction the player picks. The
Dice screen previews that multiplier using the RTP reported by
`GET /api/games/rules`, never a hard-coded value, so changing `TARGET_RTP`
keeps the UI and the server in step.

### Fast Keno (live rounds)

Fast Keno runs a continuous schedule of short rounds shared by every player.
The round is derived from the server clock, so all clients agree on it without
any coordination state:

```
round index = floor(server_time / (FAST_KENO_BETTING_MS + FAST_KENO_DRAWING_MS + FAST_KENO_RESULT_MS))
```

| Phase | Default | What happens |
|---|---|---|
| `betting` | 20 s | Wagers accepted; the draw does not exist yet |
| `drawing` | 6 s | Wagers rejected with `409`; draw is generated at the end |
| `result` | 6 s | Draw revealed, bets settled, payouts credited |

- The 10 numbers (from a pool of 40) are drawn **once** per round with the
  CSPRNG in `lib/rng.js`, only after the round's draw time has passed, and are
  persisted to `fast_keno_rounds`. The insert ignores duplicates and the row is
  re-read afterwards, so concurrent requests or multiple server instances all
  converge on the same authoritative draw. If the draw cannot be persisted or
  read back, it is discarded rather than cached — nothing is displayed or
  settled against numbers that only one process knows about, and the bets stay
  `pending` for a later pass.
- The stake is debited when the bet is placed (`place_fast_keno_bet`), not at
  settlement, which closes the window where a player could stake more than
  their balance across several rounds. `(user_id, round_index)` and
  `(user_id, idempotency_key)` are unique, so a retry replays the original bet
  instead of placing a second one.
- Payouts are credited by `settle_fast_keno_bet`, which only acts on rows still
  in `pending`, making duplicate settlement a no-op.
- `GET /api/games/fast-keno/state` is public so the countdown works before
  sign-in, but it never returns the draw before the round's draw time. With a
  valid bearer token it also returns the player's bet for the current round,
  which is what restores the ticket after a refresh or reconnect.

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

### Wallet: manual deposits and withdrawals

Money moves **manually** and is always reviewed by an operator. Players transfer
the money themselves to one of the configured destinations, upload a screenshot
as proof, and an admin approves or rejects the request. **Uploading proof never
credits a wallet and does not guarantee approval.**

Every balance mutation goes through a Postgres function that locks the user
row, so the browser can never decide an amount, a payment status, or a
resulting balance.

#### Payment destinations

Destinations live **only on the server**, in `MANUAL_PAYMENT_ACCOUNTS_JSON`, and
are parsed and validated at startup by `lib/paymentDestinations.js`. Invalid
configuration is logged as a warning and falls back to the Telebirr destination
alone — it never guesses bank details and never stops the deployment.

```jsonc
// MANUAL_PAYMENT_ACCOUNTS_JSON – placeholders only, replace with your accounts
[
  {
    "id": "cbe",
    "type": "bank",                       // "bank" or "telebirr"
    "bank_name": "Example Bank",
    "account_holder": "EXAMPLE ACCOUNT HOLDER",
    "account_number": "0000000000000",    // placeholder, not a real account
    "instructions": "Optional extra note" // optional
  }
]
```

The operator's Telebirr number `0936719379` is always offered (override it with
`TELEBIRR_NUMBER`). The client learns about destinations only through the
authenticated, read-only `GET /api/payment/destinations` endpoint; nothing is
hard-coded in `Index.html`.

#### Proof storage

Proof screenshots go into the **private** bucket named by `MANUAL_PROOF_BUCKET`
(default `deposit-proofs`, created by `supabase.sql`). Filenames are generated
server-side as `manual-deposits/<user-id>/<deposit-id>.<ext>`, so no request
value ever reaches a storage path. Only JPEG/PNG/WebP up to 6 MB are accepted,
and the file is readable exclusively through a 5-minute signed URL issued to the
owner or to an admin.

| Endpoint | Purpose |
|---|---|
| `GET /api/wallet/summary` | Available balance, pending/reserved funds, configured limits |
| `GET /api/transactions` | Paginated history; `filter=all\|deposits\|withdrawals\|games`, optional `type` |
| `GET /api/payment/destinations` | Read-only list of destinations a player may transfer to |
| `POST /api/deposits/manual` | Submits amount, destination, reference and proof image; creates a **pending** request |
| `GET /api/deposits/manual` | The player's own manual deposit requests |
| `GET /api/deposits/:id/proof` | Short-lived signed URL for the proof (owner or admin only) |
| `POST /api/withdrawals` | Requests a withdrawal, atomically reserving the funds |
| `GET /api/withdrawals` | The player's own withdrawal requests |
| `POST /api/withdrawals/:id/cancel` | Cancels a still-pending request and refunds the reservation once |

Admin-only (requires an `ADMIN_EMAILS` account):

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/deposits` | Queue of manual deposits, filterable by status |
| `POST /api/admin/deposits/:id/approve` | Credits the wallet exactly once and writes the ledger row |
| `POST /api/admin/deposits/:id/reject` | Records reviewer, timestamp and optional reason; balance untouched |
| `GET /api/admin/withdrawals` | Queue of withdrawal requests |
| `POST /api/admin/withdrawals/:id/processing` | Marks a request as being paid out |
| `POST /api/admin/withdrawals/:id/paid` | Marks it paid with an external payment reference (never debits twice) |
| `POST /api/admin/withdrawals/:id/reject` | Refunds the reservation exactly once |

- **No player-supplied input can credit a balance.** `POST /api/deposits/manual`
  only ever writes a `pending` row plus the proof object; the response says
  *"Proof submitted for review"* and carries no balance.
- Approval runs the `review_manual_deposit` function, which is guarded on the
  pending state inside the transaction, so retries, refreshes, or two admins
  clicking at the same time credit the wallet exactly once.
- Duplicate submissions are rejected with `409` through unique indexes on
  `(user_id, external_reference)` and `(user_id, idempotency_key)`; the client
  attaches an `Idempotency-Key` header to every submission.
- Withdrawals debit and reserve the funds in `request_withdrawal` at request
  time, so reserved money cannot be wagered or withdrawn again;
  `resolve_withdrawal` either marks them paid or refunds the reservation, and is
  likewise idempotent and validates the state transition.
- Deposit and withdrawal amounts, Ethiopian phone formats, and account field
  lengths are all validated server-side; limits come from `DEPOSIT_MIN_ETB` /
  `DEPOSIT_MAX_ETB` / `WITHDRAW_MIN_ETB` / `WITHDRAW_MAX_ETB`.
- Deposit states are `pending`, `approved`, `rejected`, `cancelled`; withdrawal
  states are `pending`, `processing`, `paid`, `rejected`, `cancelled`.
- Proof uploads and withdrawal requests are rate-limited. Telegram admin
  notifications carry only ids, the amount, the destination name and a masked
  account number — never proof URLs, tokens, or full account numbers.

#### Legacy Chapa gateway

The automatic Chapa endpoints (`/api/deposits/initialize`,
`/api/deposits/:txRef/status`, `/api/deposits/callback`) are still present but
respond `503` unless `CHAPA_ENABLED=true` and a secret key are configured. They
remain fully separate from the manual flow: a manual proof can never trigger a
Chapa credit, and the Chapa webhook still verifies the payment with the provider
before `complete_deposit` moves any money.

### Testing Fast Keno and the wallet in a sandbox

1. Apply `supabase.sql` to your Supabase project (it is re-runnable; the
   `MIGRATIONS FOR EXISTING INSTALLS` block updates an older database in
   place).
2. Create the private storage bucket named by `MANUAL_PROOF_BUCKET` (the SQL
   file does this for you) and set `MANUAL_PAYMENT_ACCOUNTS_JSON` to your own
   accounts. Leave `CHAPA_ENABLED` unset.
3. Start the server, register a user, and open **Games → Fast Keno**. The
   countdown, the round id, and the previous round's numbers are visible
   without signing in; placing a bet requires a session.
4. Place a bet during the `betting` phase and refresh the page mid-round — the
   ticket is restored from the server. Betting during `drawing`/`result`
   returns `409`.
5. For a faster feedback loop, shorten the round with
   `FAST_KENO_BETTING_MS=5000 FAST_KENO_DRAWING_MS=2000 FAST_KENO_RESULT_MS=2000`.
6. For deposits, open **Wallet → Deposit**, transfer the money to one of the
   listed destinations, and upload the receipt. The request stays `pending` and
   the balance does not move. Sign in with an `ADMIN_EMAILS` account, open the
   admin panel's **Manual Money Requests** queue, and approve it — the wallet is
   credited exactly once, no matter how often the approval is retried.
7. For withdrawals, submit a request from the wallet: the amount is reserved
   immediately. Cancelling or rejecting refunds it exactly once; marking it paid
   records the external payment reference without debiting again.

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
- Slots, Lotto 4/50, and Wheel are **not implemented** in this repository;
  only Fast Keno, Keno, Higher/Lower, Aviator, and Dice exist today.



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

