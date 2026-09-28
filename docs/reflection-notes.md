<!-- Placeholder — running list of known simplifications, for the reflection sheet. Updated throughout the build. -->

- `lookup_payout`'s output omits `support_summary` (present in `mcp-tool-requirements.md`'s
  example contract) because the Phase 1 `payouts` schema has no such column — only
  `failure_reason` and `status` are customer-safe fields for payouts. Speaking a fabricated
  summary would mean inventing data not backed by the seed dataset.
- Phase 1's `escalations` table had no `priority` column, added via
  `0006_escalations_priority.sql` once Phase 3.6 made clear one was needed (and Phase 8.2
  later requires it for queue sorting).
- `create_escalation`'s "stored contact-form submission" check (`getStoredContactSubmission`
  in `createEscalation.ts`) is a stub that always returns null — Phase 4.5 (the agent
  backend's contact-details endpoint) hasn't been built yet, so there is nowhere for a
  submission to be stored. Once Phase 4.5 lands, that one function needs its real query
  wired in; the rest of the resolution order (verified customer's `contact_email`, then the
  caller-provided value) is already correct and tested.
