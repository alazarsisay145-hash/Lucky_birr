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

-- ===== TRANSACTIONS TABLE =====
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  amount numeric not null check (amount <> 0),
  type text not null check (type in ('deposit', 'withdrawal', 'raffle_bet', 'raffle_win')),
  description text,
  balance_before numeric not null,
  balance_after numeric not null,
  created_at timestamptz not null default now()
);

create index if not exists transactions_user_id_idx on transactions(user_id);

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
