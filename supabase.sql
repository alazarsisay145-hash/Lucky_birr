create table if not exists submissions (
  id bigserial primary key,
  full_name text not null,
  phone text not null,
  ticket_number text not null,
  amount numeric not null,
  status text not null default 'pending',
  screenshot_url text,
  screenshot_path text,
  created_at timestamptz default now()
);

alter table submissions
add column if not exists status text not null default 'pending';
