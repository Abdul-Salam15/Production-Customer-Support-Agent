<!-- Placeholder — running list of known simplifications, for the reflection sheet. Updated throughout the build. -->

- `lookup_payout`'s output omits `support_summary` (present in `mcp-tool-requirements.md`'s
  example contract) because the Phase 1 `payouts` schema has no such column — only
  `failure_reason` and `status` are customer-safe fields for payouts. Speaking a fabricated
  summary would mean inventing data not backed by the seed dataset.
- Phase 1's `escalations` table had no `priority` column, added via
  `0006_escalations_priority.sql` once Phase 3.6 made clear one was needed (and Phase 8.2
  later requires it for queue sorting).
- `create_escalation`'s "stored contact-form submission" check (`getStoredContactSubmission`
  in `createEscalation.ts`) now queries the real `contact_submissions` table (Phase 4.5,
  Stage 7) instead of the stub that always returned null. Verified end-to-end: a
  resubmitted/corrected email in `contact_submissions` overrides both the model's transcribed
  email and the verified customer's account-default email in the resulting escalation row.
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
- `session/abort.ts` listens on `res.on('close')`, not `req.on('close')` — the request's
  readable side is already drained by express.json() by the time a streaming handler runs, so
  it never fires on client disconnect. `res`'s close event is the one that reliably fires and
  distinguishes a premature disconnect (`writableEnded: false`) from a normal completion.
- `outputGuard.ts`'s internal-phrase matching strips trailing sentence punctuation from
  extracted `support_notes` phrases. A model paraphrasing mid-sentence naturally drops the
  period ("...compliance review, so let me..." vs. the source's "...compliance review.");
  without stripping it, an exact-substring match against the punctuated phrase silently never
  fires. The guard is still a "known phrases" blocklist, not semantic matching — it won't
  catch a genuine paraphrase, only near-verbatim reproduction.
- The output guard is a rolling-window filter (holds back the last ~200 characters, not the
  whole response), so a violation could in principle appear after enough safe text was already
  flushed to Vapi. This is a deliberate latency/safety tradeoff (Phase 4.6 frames it as a
  backstop, not a guarantee) rather than buffering the entire response before sending anything.
- Caught mid-testing: after editing `createEscalation.ts`'s contact-submission lookup, the
  already-running mcp-server process kept serving the old code (tsx doesn't hot-reload without
  `--watch`) — the escalation kept using the account-default email until the process was
  restarted. A reminder to restart both services after any mcp-server source change, not just
  the agent backend.
