-- support_tickets has always had these; escalations didn't, so the
-- dashboard's "Transaction or payout" field was always empty for them even
-- when the call was about a specific transaction.
alter table escalations
  add column related_transaction_id text references transactions(transaction_id),
  add column related_payout_id text references payouts(payout_id);
