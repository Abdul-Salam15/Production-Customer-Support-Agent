<!-- Placeholder — the one-page explanation deliverable. Implemented in Phase 9. -->

## Design choice: contact-form storage (Phase 4.5)

Contact-form submissions are stored in a dedicated `contact_submissions` table
(`supabase/migrations/0007_contact_submissions.sql`), one row per
`conversation_id` (a resubmission upserts/replaces the prior row), rather
than a JSON column on `conversations`. A normalized table matches the rest
of the schema, is simpler to query from `create_escalation`, and is easier
to extend if a later phase wants to audit or list submissions.
