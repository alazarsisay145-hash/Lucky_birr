-- ===== USERS TABLE =====
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  phone text unique,
  password_hash text not null,
  full_name text,
  balance numeric not null default 0,
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
  amount numeric not null,
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

-- ===== TRANSACTIONS TABLE =====
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  amount numeric not null,
  type text not null check (type in ('deposit', 'withdrawal', 'raffle_bet', 'raffle_win')),
  description text,
  balance_before numeric not null,
  balance_after numeric not null,
  created_at timestamptz not null default now()
);

create index if not exists transactions_user_id_idx on transactions(user_id);
