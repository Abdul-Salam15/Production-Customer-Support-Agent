create table conversations (
  conversation_id uuid primary key default gen_random_uuid(),
  vapi_call_id text unique,
  channel text not null default 'voice',
  customer_id text references customers(customer_id),   -- set once verified mid-call
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_reason text,
  final_status text,             -- resolved | ticket_created | escalated | abandoned
  summary text
);

create table conversation_turns (
  id bigint generated always as identity primary key,
  conversation_id uuid references conversations(conversation_id),
  turn_index int not null,
  role text not null,            -- customer | agent
  transcript text not null,
  answer_type text,              -- answer | clarify | escalate | decline
  confidence text,                -- high | low | uncertain
  created_at timestamptz not null default now()
);

create table retrieval_logs (
  id bigint generated always as identity primary key,
  conversation_id uuid references conversations(conversation_id),
  query text not null,
  chunk_ids text[] not null,
  source_titles text[] not null,
  source_summaries text[] not null,
  sufficient_context boolean not null,
  created_at timestamptz not null default now()
);

create table tool_calls (
  id bigint generated always as identity primary key,
  conversation_id uuid references conversations(conversation_id),
  tool_name text not null,
  purpose text,
  input_summary text,             -- redacted: emails masked, no raw secrets
  result_summary text,
  status text not null,           -- success | error
  error_message text,
  duration_ms int,
  created_at timestamptz not null default now()
);

create table support_tickets (
  ticket_id text primary key,     -- e.g. RP-4821
  conversation_id uuid references conversations(conversation_id),
  customer_id text references customers(customer_id),
  category text not null,
  priority text not null,         -- high | medium | low
  summary text not null,
  related_transaction_id text references transactions(transaction_id),
  related_payout_id text references payouts(payout_id),
  status text not null default 'open',
  assigned_to text,
  resolution_notes text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table escalations (
  escalation_id text primary key,  -- e.g. RP-4821 (shares the ticket's reference when linked)
  ticket_id text references support_tickets(ticket_id),
  conversation_id uuid references conversations(conversation_id),
  customer_id text references customers(customer_id),
  user_name text not null,
  user_email text not null,
  category text not null,          -- compliance | account | dispute | payment | other
  reason text not null,
  preferred_time text,
  callback_at timestamptz,
  call_booked boolean not null default false,
  status text not null default 'open',   -- open | in_progress | closed
  assigned_to text,
  resolution_notes text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table evaluations (
  id bigint generated always as identity primary key,
  run_id text not null,
  scenario text not null,
  expected_behavior text not null,
  actual_behavior text,
  pass boolean,
  notes text,
  created_at timestamptz not null default now()
);

-- Addition #1: log_conversation_event needs somewhere to write.
create table conversation_events (
  id bigint generated always as identity primary key,
  conversation_id uuid references conversations(conversation_id),
  event_type text not null,
  summary text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

alter table conversations enable row level security;
alter table conversation_turns enable row level security;
alter table retrieval_logs enable row level security;
alter table tool_calls enable row level security;
alter table support_tickets enable row level security;
alter table escalations enable row level security;
alter table evaluations enable row level security;
alter table conversation_events enable row level security;
