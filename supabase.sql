-- ===== USERS TABLE =====
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  phone text unique,
  password_hash text not null,
  full_name text,
  balance numeric not null default 0 check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists users_email_idx on users(email);

-- ===== SUBMISSIONS TABLE =====
create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  ticket_number integer,
  tier text check (tier in ('mini', 'standard', 'premium')),
  amount numeric not null check (amount > 0),
  payment_method text check (payment_method in ('telebirr', 'dashen', 'cbe')) default 'telebirr',
  screenshot_url text,
  screenshot_path text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists submissions_user_id_idx on submissions(user_id);
create index if not exists submissions_status_idx on submissions(status);
create index if not exists submissions_created_at_idx on submissions(created_at desc);

-- ===== DEPOSITS TABLE =====
create table if not exists deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  amount numeric not null check (amount > 0),
  tx_ref text unique not null,
  payment_method text check (payment_method in ('telebirr', 'dashen', 'cbe', 'chapa')) default 'chapa',
  screenshot_url text,
  screenshot_path text,
  checkout_url text,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deposits_user_id_idx on deposits(user_id);
create index if not exists deposits_status_idx on deposits(status);
create index if not exists deposits_tx_ref_idx on deposits(tx_ref);

-- ===== WITHDRAWALS TABLE =====
create table if not exists withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  amount numeric not null check (amount > 0),
  payment_method text not null check (payment_method in ('telebirr', 'dashen', 'cbe')),
  account_number text not null,
  account_name text not null,
  status text not null default 'pending' check (status in ('pending', 'completed', 'rejected')),
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists withdrawals_user_id_idx on withdrawals(user_id);
create index if not exists withdrawals_status_idx on withdrawals(status);

-- ===== GAME BETS TABLE (legacy summary log — kept for backward compatibility) =====
create table if not exists game_bets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  game text not null check (game in ('keno', 'higher_lower', 'aviator')),
  bet_amount numeric not null check (bet_amount > 0),
  payout numeric not null default 0,
  profit numeric not null default 0,
  result jsonb,
  server_seed text,
  created_at timestamptz not null default now()
);

create index if not exists game_bets_user_id_idx on game_bets(user_id);
create index if not exists game_bets_game_idx on game_bets(game);
create index if not exists game_bets_created_at_idx on game_bets(created_at desc);

-- ===== GAME ROUNDS TABLE =====
-- Durable, audit-safe record of every server-settled game round. Money is
-- stored in integer minor units (cents) to avoid floating point drift.
-- The (user_id, idempotency_key) unique constraint guarantees that retried
-- requests can never double-charge or double-pay a player.
create table if not exists game_rounds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  game text not null check (game in ('keno', 'higher_lower', 'aviator')),
  math_version text not null,
  idempotency_key text not null,
  stake_cents bigint not null check (stake_cents > 0),
  payout_cents bigint not null default 0 check (payout_cents >= 0),
  balance_before_cents bigint not null check (balance_before_cents >= 0),
  balance_after_cents bigint not null check (balance_after_cents >= 0),
  status text not null default 'settled' check (status in ('settled')),
  outcome jsonb not null,
  rng_meta jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create index if not exists game_rounds_user_id_idx on game_rounds(user_id);
create index if not exists game_rounds_game_idx on game_rounds(game);
create index if not exists game_rounds_created_at_idx on game_rounds(created_at desc);
create index if not exists game_rounds_math_version_idx on game_rounds(math_version);

-- ===== TRANSACTIONS TABLE =====
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  amount numeric not null check (amount <> 0),
  type text not null check (type in ('deposit', 'withdrawal', 'withdrawal_refund', 'game_win', 'game_loss', 'raffle_bet', 'raffle_win')),
  description text,
  created_at timestamptz not null default now()
);

create index if not exists transactions_user_id_idx on transactions(user_id);
create index if not exists transactions_created_at_idx on transactions(created_at desc);

-- ===== HELPER FUNCTIONS =====
-- credit_balance: atomically add delta to a user's balance
create or replace function credit_balance(uid uuid, delta numeric)
returns void language plpgsql as $$
begin
  update users set balance = balance + delta, updated_at = now() where id = uid;
end;
$$;

-- debit_balance: atomically subtract delta, reject if insufficient
create or replace function debit_balance(uid uuid, delta numeric)
returns void language plpgsql as $$
declare
  cur_balance numeric;
begin
  select balance into cur_balance from users where id = uid for update;
  if cur_balance < delta then
    raise exception 'Insufficient balance';
  end if;
  update users set balance = balance - delta, updated_at = now() where id = uid;
end;
$$;

-- settle_game_round: the single atomic entry point used by /api/games/bet.
-- Validates the authenticated user's balance, locks their row, debits the
-- stake, credits the payout, and records an immutable game_rounds entry —
-- all inside one transaction so a round can never be partially applied.
-- Idempotent: replaying the same (user_id, idempotency_key) simply returns
-- the original result instead of settling twice, which is what prevents
-- duplicate/concurrent requests from double-charging or double-paying.
create or replace function settle_game_round(
  p_user_id uuid,
  p_game text,
  p_math_version text,
  p_idempotency_key text,
  p_stake_cents bigint,
  p_payout_cents bigint,
  p_outcome jsonb,
  p_rng_meta jsonb
) returns table(round_id uuid, balance_after_cents bigint, replayed boolean)
language plpgsql as $$
declare
  existing game_rounds%rowtype;
  cur_balance numeric;
  cur_balance_cents bigint;
  new_balance_cents bigint;
  new_round_id uuid;
begin
  if p_stake_cents is null or p_stake_cents <= 0 then
    raise exception 'Invalid stake';
  end if;
  if p_payout_cents is null or p_payout_cents < 0 then
    raise exception 'Invalid payout';
  end if;

  -- Idempotent replay: return the previously settled round unchanged.
  select * into existing from game_rounds
    where user_id = p_user_id and idempotency_key = p_idempotency_key;
  if found then
    return query select existing.id, existing.balance_after_cents, true;
    return;
  end if;

  select balance into cur_balance from users where id = p_user_id for update;
  if not found then
    raise exception 'User not found';
  end if;

  cur_balance_cents := round(cur_balance * 100)::bigint;
  new_balance_cents := cur_balance_cents - p_stake_cents + p_payout_cents;
  if cur_balance_cents < p_stake_cents or new_balance_cents < 0 then
    raise exception 'Insufficient balance';
  end if;

  update users set balance = new_balance_cents::numeric / 100, updated_at = now() where id = p_user_id;

  insert into game_rounds (
    user_id, game, math_version, idempotency_key, stake_cents, payout_cents,
    balance_before_cents, balance_after_cents, outcome, rng_meta
  ) values (
    p_user_id, p_game, p_math_version, p_idempotency_key, p_stake_cents, p_payout_cents,
    cur_balance_cents, new_balance_cents, p_outcome, p_rng_meta
  ) returning id into new_round_id;

  if p_payout_cents <> p_stake_cents then
    insert into transactions(user_id, amount, type, description)
    values (
      p_user_id,
      (p_payout_cents - p_stake_cents)::numeric / 100,
      case when p_payout_cents > p_stake_cents then 'game_win' else 'game_loss' end,
      p_game || ' round ' || new_round_id
    );
  end if;

  return query select new_round_id, new_balance_cents, false;
end;
$$;


-- ===== ROW LEVEL SECURITY =====
-- Enable RLS on all tables. The service role key used by the backend bypasses RLS.
-- The following policies allow the service role unrestricted access.
-- If you use Supabase Auth client-side, add appropriate policies for your access patterns.
--
-- alter table users enable row level security;
-- alter table submissions enable row level security;
-- alter table transactions enable row level security;
--
-- IMPORTANT: The SUPABASE_SERVICE_ROLE_KEY must never be exposed to clients.
-- Only use it server-side. Use the anon key or user JWTs for any client-side access.

-- ===== STORAGE =====
-- Create the screenshots bucket (idempotent – safe to re-run):
insert into storage.buckets (id, name, public)
values ('screenshots', 'screenshots', true)
on conflict (id) do nothing;

-- IMPORTANT: Set the bucket to public only if screenshot URLs must be directly accessible.
-- Consider restricting uploads to authenticated service role only via storage policies.
