-- Phase 8 backend: real staff accounts (Supabase Auth + role) and real case
-- management (claim/resolve/notes), replacing the frontend-only prototype
-- state in queue.js/auth.js with actual tables an API can read and write.

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role text not null check (role in ('admin', 'specialist')),
  invited_by uuid references profiles(id),
  role_changed_at timestamptz,
  role_changed_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

-- security definer so a policy on profiles can check "is the caller an
-- admin" without recursively re-evaluating RLS on profiles itself.
create function is_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles where id = uid and role = 'admin'
  );
$$;

create policy "profiles readable by admins or self" on profiles
  for select using (is_admin(auth.uid()) or id = auth.uid());

create policy "profiles writable by admins" on profiles
  for all using (is_admin(auth.uid())) with check (is_admin(auth.uid()));

-- Multi-entry note thread for a case. support_tickets and escalations share
-- the RP-#### reference format (see createEscalation.ts), so case_type
-- disambiguates which table a reference belongs to.
create table case_notes (
  id bigint generated always as identity primary key,
  reference text not null,
  case_type text not null check (case_type in ('ticket', 'escalation')),
  author_id uuid references profiles(id),
  body text not null,
  created_at timestamptz not null default now()
);

alter table case_notes enable row level security;

create policy "case_notes readable by staff" on case_notes
  for select using (exists (select 1 from profiles where id = auth.uid()));

create policy "case_notes insertable by staff" on case_notes
  for insert with check (exists (select 1 from profiles where id = auth.uid()));

-- assigned_to has never been populated (nothing set it until this phase),
-- so changing its type is safe.
alter table support_tickets alter column assigned_to type uuid using null;
alter table support_tickets
  add constraint support_tickets_assigned_to_fkey
  foreign key (assigned_to) references profiles(id);

alter table escalations alter column assigned_to type uuid using null;
alter table escalations
  add constraint escalations_assigned_to_fkey
  foreign key (assigned_to) references profiles(id);
