-- A single, append-only, plain-English activity feed for the admin-facing
-- Audit Logs tab. Each row's `message` is composed in full at write time by
-- whichever code path logged it (a tool call, an email send, a role change,
-- a login, ...), not reconstructed from raw fields at read time — the
-- audience is non-technical admins, so the sentence needs to already be
-- the thing they read, not a row of columns.
create table audit_log (
  id bigint generated always as identity primary key,
  category text not null,  -- call | tool | case | email | team | account
  message text not null,
  created_at timestamptz not null default now()
);

alter table audit_log enable row level security;

create policy "audit_log readable by admins" on audit_log
  for select using (is_admin(auth.uid()));
