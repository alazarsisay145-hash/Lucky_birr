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

-- ===== FAST KENO =====
-- Shared, server-scheduled rapid rounds. The round index is derived from wall
-- clock time (see lib/fastKeno.js) so every process agrees on the schedule;
-- only the draw is random and it is written exactly once per round.
create table if not exists fast_keno_rounds (
  round_index bigint primary key,
  round_id text unique not null,
  drawn jsonb not null,
  math_version text not null,
  drawn_at timestamptz not null default now()
);

create index if not exists fast_keno_rounds_drawn_at_idx on fast_keno_rounds(drawn_at desc);

-- One bet per player per round. The stake is debited when the bet is accepted
-- (never at settlement) so a player can not spend the same balance twice while
-- a round is running. `settled_at`/`status` make settlement idempotent.
create table if not exists fast_keno_bets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  round_index bigint not null,
  round_id text not null,
  idempotency_key text not null,
  math_version text not null,
  picks jsonb not null,
  stake_cents bigint not null check (stake_cents > 0),
  payout_cents bigint not null default 0 check (payout_cents >= 0),
  hits integer,
  multiplier numeric,
  matched jsonb,
  status text not null default 'pending' check (status in ('pending', 'settled', 'refunded')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (user_id, round_index),
  unique (user_id, idempotency_key)
);

create index if not exists fast_keno_bets_user_id_idx on fast_keno_bets(user_id);
create index if not exists fast_keno_bets_status_idx on fast_keno_bets(status);
create index if not exists fast_keno_bets_round_idx on fast_keno_bets(round_index desc);


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


-- ===== MIGRATIONS FOR EXISTING INSTALLS =====
-- Safe to re-run. These widen existing CHECK constraints so previously
-- deployed databases accept the games and transaction states added later.
alter table game_bets drop constraint if exists game_bets_game_check;
alter table game_bets add constraint game_bets_game_check
  check (game in ('keno', 'higher_lower', 'aviator', 'dice', 'fast_keno'));

alter table game_rounds drop constraint if exists game_rounds_game_check;
alter table game_rounds add constraint game_rounds_game_check
  check (game in ('keno', 'higher_lower', 'aviator', 'dice', 'fast_keno'));

alter table deposits drop constraint if exists deposits_status_check;
alter table deposits add constraint deposits_status_check
  check (status in ('pending', 'completed', 'failed', 'cancelled'));

alter table withdrawals drop constraint if exists withdrawals_status_check;
alter table withdrawals add constraint withdrawals_status_check
  check (status in ('pending', 'completed', 'rejected', 'cancelled'));

alter table withdrawals add column if not exists idempotency_key text;
create unique index if not exists withdrawals_user_idempotency_idx
  on withdrawals(user_id, idempotency_key) where idempotency_key is not null;

-- ===== FAST KENO FUNCTIONS =====
-- place_fast_keno_bet: atomically reserve (debit) the stake and record the bet.
-- The unique (user_id, round_index) and (user_id, idempotency_key) constraints
-- mean a retried or concurrent request can never debit twice: the second
-- insert loses and the already-recorded bet is returned unchanged.
create or replace function place_fast_keno_bet(
  p_user_id uuid,
  p_round_index bigint,
  p_round_id text,
  p_idempotency_key text,
  p_math_version text,
  p_picks jsonb,
  p_stake_cents bigint
) returns table(bet_id uuid, balance_after_cents bigint, replayed boolean)
language plpgsql as $$
declare
  existing fast_keno_bets%rowtype;
  cur_balance numeric;
  cur_balance_cents bigint;
  new_balance_cents bigint;
  new_bet_id uuid;
begin
  if p_stake_cents is null or p_stake_cents <= 0 then
    raise exception 'Invalid stake';
  end if;

  select * into existing from fast_keno_bets
    where user_id = p_user_id
      and (round_index = p_round_index or idempotency_key = p_idempotency_key)
    limit 1;
  if found then
    select balance into cur_balance from users where id = p_user_id;
    return query select existing.id, round(cur_balance * 100)::bigint, true;
    return;
  end if;

  select balance into cur_balance from users where id = p_user_id for update;
  if not found then
    raise exception 'User not found';
  end if;

  cur_balance_cents := round(cur_balance * 100)::bigint;
  if cur_balance_cents < p_stake_cents then
    raise exception 'Insufficient balance';
  end if;
  new_balance_cents := cur_balance_cents - p_stake_cents;

  update users set balance = new_balance_cents::numeric / 100, updated_at = now() where id = p_user_id;

  insert into fast_keno_bets (
    user_id, round_index, round_id, idempotency_key, math_version, picks, stake_cents
  ) values (
    p_user_id, p_round_index, p_round_id, p_idempotency_key, p_math_version, p_picks, p_stake_cents
  ) returning id into new_bet_id;

  insert into transactions(user_id, amount, type, description)
  values (p_user_id, -p_stake_cents::numeric / 100, 'game_loss', 'fast_keno stake ' || p_round_id);

  return query select new_bet_id, new_balance_cents, false;
end;
$$;

-- settle_fast_keno_bet: credit the payout exactly once. The status guard makes
-- replays (retries, overlapping settlement passes, multiple instances) no-ops.
create or replace function settle_fast_keno_bet(
  p_bet_id uuid,
  p_payout_cents bigint,
  p_hits integer,
  p_multiplier numeric,
  p_matched jsonb
) returns table(balance_after_cents bigint, settled boolean)
language plpgsql as $$
declare
  bet fast_keno_bets%rowtype;
  cur_balance_cents bigint;
  new_balance_cents bigint;
begin
  if p_payout_cents is null or p_payout_cents < 0 then
    raise exception 'Invalid payout';
  end if;

  select * into bet from fast_keno_bets where id = p_bet_id for update;
  if not found then
    raise exception 'Bet not found';
  end if;

  select round(balance * 100)::bigint into cur_balance_cents from users where id = bet.user_id for update;

  if bet.status <> 'pending' then
    return query select cur_balance_cents, false;
    return;
  end if;

  new_balance_cents := cur_balance_cents + p_payout_cents;
  update users set balance = new_balance_cents::numeric / 100, updated_at = now() where id = bet.user_id;

  update fast_keno_bets set
    status = 'settled',
    payout_cents = p_payout_cents,
    hits = p_hits,
    multiplier = p_multiplier,
    matched = p_matched,
    settled_at = now()
  where id = p_bet_id;

  if p_payout_cents > 0 then
    insert into transactions(user_id, amount, type, description)
    values (bet.user_id, p_payout_cents::numeric / 100, 'game_win', 'fast_keno win ' || bet.round_id);
  end if;

  return query select new_balance_cents, true;
end;
$$;

-- ===== WALLET FUNCTIONS =====
-- complete_deposit: credit a verified deposit exactly once. Called only after
-- the server has verified the payment with Chapa; the amount always comes from
-- the stored deposit row, never from the callback payload.
create or replace function complete_deposit(p_tx_ref text)
returns table(credited boolean, user_id uuid, amount numeric)
language plpgsql as $$
declare
  dep deposits%rowtype;
begin
  select * into dep from deposits where tx_ref = p_tx_ref for update;
  if not found then
    raise exception 'Deposit not found';
  end if;
  if dep.status <> 'pending' then
    return query select false, dep.user_id, dep.amount;
    return;
  end if;

  update deposits set status = 'completed', updated_at = now() where id = dep.id;
  update users set balance = balance + dep.amount, updated_at = now() where id = dep.user_id;
  insert into transactions(user_id, amount, type, description)
  values (dep.user_id, dep.amount, 'deposit', 'Deposit confirmed (' || dep.tx_ref || ')');

  return query select true, dep.user_id, dep.amount;
end;
$$;

-- request_withdrawal: atomically check funds, debit (reserve) them and record
-- the request. Idempotent through (user_id, idempotency_key).
create or replace function request_withdrawal(
  p_user_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_account_number text,
  p_account_name text,
  p_idempotency_key text
) returns table(withdrawal_id uuid, balance_after_cents bigint, replayed boolean)
language plpgsql as $$
declare
  existing withdrawals%rowtype;
  cur_balance numeric;
  new_balance numeric;
  new_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Invalid amount';
  end if;

  if p_idempotency_key is not null then
    select * into existing from withdrawals
      where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if found then
      select balance into cur_balance from users where id = p_user_id;
      return query select existing.id, round(cur_balance * 100)::bigint, true;
      return;
    end if;
  end if;

  select balance into cur_balance from users where id = p_user_id for update;
  if not found then
    raise exception 'User not found';
  end if;
  if cur_balance < p_amount then
    raise exception 'Insufficient balance';
  end if;

  new_balance := cur_balance - p_amount;
  update users set balance = new_balance, updated_at = now() where id = p_user_id;

  insert into withdrawals(user_id, amount, payment_method, account_number, account_name, status, idempotency_key)
  values (p_user_id, p_amount, p_payment_method, p_account_number, p_account_name, 'pending', p_idempotency_key)
  returning id into new_id;

  insert into transactions(user_id, amount, type, description)
  values (p_user_id, -p_amount, 'withdrawal', 'Withdrawal request via ' || p_payment_method);

  return query select new_id, round(new_balance * 100)::bigint, false;
end;
$$;

-- resolve_withdrawal: move a pending withdrawal to a terminal state exactly
-- once, refunding the reserved amount for rejected/cancelled requests.
create or replace function resolve_withdrawal(
  p_withdrawal_id uuid,
  p_status text,
  p_user_id uuid,
  p_admin_notes text
) returns table(resolved boolean, refunded boolean)
language plpgsql as $$
declare
  wd withdrawals%rowtype;
begin
  if p_status not in ('completed', 'rejected', 'cancelled') then
    raise exception 'Invalid status';
  end if;

  select * into wd from withdrawals where id = p_withdrawal_id for update;
  if not found then
    raise exception 'Withdrawal not found';
  end if;
  if p_user_id is not null and wd.user_id <> p_user_id then
    raise exception 'Withdrawal not found';
  end if;
  if wd.status <> 'pending' then
    return query select false, false;
    return;
  end if;

  update withdrawals set status = p_status, admin_notes = coalesce(p_admin_notes, admin_notes), updated_at = now()
    where id = p_withdrawal_id;

  if p_status in ('rejected', 'cancelled') then
    update users set balance = balance + wd.amount, updated_at = now() where id = wd.user_id;
    insert into transactions(user_id, amount, type, description)
    values (wd.user_id, wd.amount, 'withdrawal_refund', 'Withdrawal ' || p_status || ' – balance refunded');
    return query select true, true;
    return;
  end if;

  return query select true, false;
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
