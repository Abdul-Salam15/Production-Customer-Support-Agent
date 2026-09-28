-- Phase 1's escalations table had no priority column, but Phase 3.6 requires
-- deriving one by category (never left to the model), and Phase 8.2 later
-- sorts the queue by priority for both support_tickets and escalations.
alter table escalations add column priority text not null;
