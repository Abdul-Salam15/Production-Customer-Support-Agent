-- Real customer-facing accounts (Supabase Auth), separate from staff
-- `profiles`. A customer_accounts row just links an auth.users id to the
-- email/name they signed up with; "their calls" are matched by email
-- against conversations/escalations/contact_submissions at query time,
-- not stored here.
create table customer_accounts (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  created_at timestamptz not null default now()
);

alter table customer_accounts enable row level security;

create policy "customer_accounts readable by self" on customer_accounts
  for select using (auth.uid() = id);

create policy "customer_accounts writable by self" on customer_accounts
  for all using (auth.uid() = id) with check (auth.uid() = id);
