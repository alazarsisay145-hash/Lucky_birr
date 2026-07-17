create table if not exists submissions (
  id bigserial primary key,
  full_name text not null,
  phone text not null,
  ticket_number text not null,
  amount numeric not null,
  screenshot_url text,
  screenshot_path text,
  created_at timestamptz default now()
);
