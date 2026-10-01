-- The website login (customer_accounts) a caller was signed in with when the
-- call started, set by POST /api/calls/:callId/identity. Separate from
-- customer_id: a login only verifies the caller when its email matches a
-- business customer record, but the dashboard still distinguishes "signed
-- in, no business account" from a fully anonymous caller.
alter table conversations
  add column signed_in_account_id uuid references customer_accounts(id) on delete set null;
