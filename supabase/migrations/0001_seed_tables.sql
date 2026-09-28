create table customers (
  customer_id text primary key,
  company_name text not null,
  contact_name text not null,
  contact_email text not null,
  plan text not null,
  account_status text not null,
  region text not null,
  kyc_status text not null,
  support_notes text            -- internal only, never spoken
);

create table transactions (
  transaction_id text primary key,
  customer_id text references customers(customer_id),
  transaction_type text not null,
  amount numeric not null,
  currency text not null,
  destination_country text,
  status text not null,
  created_at date not null,
  estimated_arrival date,
  support_summary text not null
);

create table payouts (
  payout_id text primary key,
  transaction_id text references transactions(transaction_id),
  customer_id text references customers(customer_id),
  recipient_name text not null,
  amount numeric not null,
  currency text not null,
  status text not null,
  scheduled_for date,
  failure_reason text
);

alter table customers enable row level security;
alter table transactions enable row level security;
alter table payouts enable row level security;
