-- Stores the customer's own typed contact-form submission (Phase 4.5), so
-- create_escalation (Phase 3.6) can prefer it over whatever the model
-- transcribed from speech. One row per conversation — a resubmission
-- (corrected email, say) replaces the prior one rather than accumulating.
create table contact_submissions (
  conversation_id uuid primary key references conversations(conversation_id),
  name text not null,
  email text not null,
  callback_time text,
  created_at timestamptz not null default now()
);

alter table contact_submissions enable row level security;
