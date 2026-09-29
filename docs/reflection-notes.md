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
- Phase 4.2 says to "write one conversation_turns row" per turn, but Phase 1's schema gives
  each row a single `role` (customer | agent) and `transcript`, which only makes sense if
  both roles get written. `customLlm.ts` writes two rows per turn (customer then agent);
  only the agent row gets `answer_type`/`confidence`.
- The Agent SDK session map (`session/agentSession.ts`) is in-memory only, matching Phase
  4.2's own documented fallback: a server restart mid-call loses the `vapi_call_id ->
  sdkSessionId` mapping, and the next turn falls back to reconstructing context from the
  message history Vapi resends, as a fresh (non-resumed) session, rather than truly resuming
  the lost one. Verified working, but it's a degraded path, not a full recovery.
- `alwaysLoad: true` is set on the MCP server config so all 8 tools are always visible to
  the model. Without it, the SDK defers tools behind a "tool search" mechanism meant for much
  larger tool catalogs — with it unset, the model never discovered search_knowledge_base and
  hallucinated a fake tool-call-shaped block in its own text instead of a real call. Caught by
  checking `tool_calls` was empty after a manual test that should have triggered a lookup.
