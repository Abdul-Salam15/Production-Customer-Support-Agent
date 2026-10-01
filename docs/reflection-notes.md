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
- Stage 8's backend event shapes changed to match app.js's existing, fixed vocabulary rather
  than the other way around: `setActivity()` only recognizes six keys
  (help/account/transactions/payouts/ticket/callback), so the SSE 'activity' event now carries
  `key` (one of those six), not free text. Verified end-to-end: a real transaction lookup
  produced `{"type":"activity","key":"transactions"}` and an outcome payload with exactly the
  fields `statusCardFromOutcome()` needs (including `amount`/`currency` correctly nulled out
  for an unverified/reference-only caller).
- The Vapi Web SDK's call ID is not on `vapi.call.id` (that's the underlying Daily.co WebRTC
  object) — it's the resolved value of `vapi.start(assistantId)` itself, a `Call` object with
  `.id`. Confirmed by downloading and reading the actual `@vapi-ai/web@2.7.1` source
  (`npm pack`), not guessed; the event names used (`call-start`, `call-end`, `speech-start`,
  `speech-end`, `message` with `role`/`transcript`/`transcriptType`) were confirmed the same
  way. The exact CDN import path (`esm.sh/@vapi-ai/web`) and behavior are still unverified
  against a live Vapi account — do that in Stage 9.
- Real Vapi Web SDK initialization is loaded via dynamic `import()` inside app.js rather than
  adding a `<script>` tag to index.html, keeping this stage's changes confined to app.js as
  instructed. `VAPI_PUBLIC_KEY`/`VAPI_ASSISTANT_ID` reach the browser via a new `GET
  /api/config` route (added to `index.ts`) rather than templating them into the static HTML.
- Could not test an actual real-call end-to-end in this environment: no real Vapi account/keys
  exist yet (Stage 9), and there is no microphone or real browser available here. What was
  verified instead: the toolbar/demo path is provably unaffected (driven live via jsdom — every
  preview control still updates the DOM exactly as before); static serving and `/api/config`
  work against the real running Express app; and the backend's SSE event shapes were confirmed
  correct against real tool-call data. The Vapi SDK's own API (call-id retrieval, event names)
  was verified against its actual published source rather than assumed. The one thing that
  cannot be verified without a live account is Vapi's actual runtime behavior calling our
  endpoints.
- Real bug found during first live Vapi testing (not a Stage 8 change): every route handler's
  async body ran with only a narrow inner try/catch (around the query() loop in customLlm.ts;
  none at all in events.ts/contactRoutes.ts). Express 4 does not catch a rejected promise from
  an async handler, so anything thrown outside that narrow block — a Supabase hiccup, a bad
  request — became an unhandled rejection, and Node kills the whole process on those by
  default. That took the entire backend down for every other in-progress call, not just the
  one bad request. Fixed by wrapping each route's full handler body in try/catch (respond
  500/close the stream on failure instead of crashing), plus a process-level
  unhandledRejection/uncaughtException safety net in index.ts as a last resort. Verified: a
  real turn through the live tunnel completed normally and the process was still running
  and answering afterward.
- First live Vapi test call (a real, duplicated cohort assistant, pointed at a local
  Cloudflare quick tunnel) surfaced a genuine Vapi-side gotcha worth remembering for the real
  deployment: **Custom LLM authentication is controlled by a specific credential type**, not
  by the generic "HTTP Headers" field on the assistant, and not by the "Bearer Token"
  credential type either (that one is for the separate Webhook Server / tools-and-events
  section, which is a different integration point entirely and looks confusingly similar in
  the UI). Both wrong attempts made Vapi send a literal placeholder string
  (`Bearer no-custom-llm-key-provided`) as the Authorization header instead of erroring
  helpfully, which made the wrong-credential-type diagnosis take three attempts (visible in
  the backend's own request logs at the time). The fix: create a credential of type
  **"Custom LLM"** specifically (a plain API Key field, no OAuth2 needed), attach only that
  credential's ID to the assistant's `credentialIds`, and leave the Custom LLM URL field's
  own auth/API-key inputs blank. Confirmed end-to-end: a real voice call reached the deployed
  backend, called `search_knowledge_base` for real, and was logged correctly in Supabase with
  the right `answer_type`/`confidence` tag. Deployment target is Render, not Railway as
  implementation.md's Phase 6 assumes (the student's choice, based on prior familiarity) —
  the same Custom LLM credential and URL-path convention (`<base>/vapi` so Vapi's
  `/chat/completions` append lands on our real `/vapi/chat/completions` route) carries over
  unchanged to a Render URL.
- Phase 8.3's email notification was built against **Gmail SMTP via `nodemailer`**, not Resend
  as `implementation.md` originally sketched — a later choice, made once real email became a
  requirement rather than a stretch goal. Gmail requires an **App Password** (2-Step
  Verification on the sending account), not the account's normal password, and rejects any
  `From` address other than the authenticated account itself. Gmail SMTP tops out around
  500 sends/day on a regular account (2000/day on Workspace) — fine for support-ticket volume,
  not for anything approaching marketing-scale sends.
- Five email triggers now exist: new escalation → internal team, escalation created →
  customer confirmation, every call ending → internal summary (+ customer, when an email is
  resolvable) with the full transcript and any submitted contact-form data, a staff role
  change → that staff member, and a case being resolved → the customer. All five are
  best-effort side effects — every send is wrapped so a Gmail failure (bad credentials, an
  outage) never blocks or fails the underlying operation (the escalation/ticket row, the call
  finalization, the role change, the resolve action all already committed by the time the
  email is attempted).
- Staff **invite** emails deliberately still go through Supabase Auth's own built-in
  `inviteUserByEmail` flow, not the new Gmail mailer — the user only asked for a role-*change*
  notification, and building a second, custom invite-token flow just to route that one email
  through Gmail too wasn't worth the extra surface area. This means invite emails are subject
  to Supabase's own rate limits/sender config, separate from Gmail's.
- Phase 8.1/8.2 (real dashboard backend) got built alongside the email work, since two of the
  five requested email scenarios (role-change, resolved) had no real event to trigger from
  otherwise — `queue.js`/`auth.js` were previously a pure frontend mock with hardcoded arrays
  and zero `fetch()` calls anywhere. `support_tickets.assigned_to`/`escalations.assigned_to`
  changed from free-text to `uuid references profiles(id)`, safe only because neither column
  had ever actually been populated by any existing code path. A new `case_notes` table backs
  the multi-entry note thread `queue.js` already rendered but had nowhere real to store.
- RLS policies were added on `profiles`/`case_notes` (Postgres's classic self-reference
  recursion avoided via a `security definer` `is_admin()` function) mostly as defense in depth:
  the actual read/write path for the dashboard is the agent backend's own Express API, using
  the same service-role Supabase client every other tool already uses, which bypasses RLS
  entirely. RLS only matters here if something ever queries these tables directly with the
  anon key.
- The staff dashboard's public self-signup form (creating a no-access `'user'` role) and the
  "prototype: view as" dev switcher were both removed once real Supabase Auth login existed —
  a real backend means staff accounts only get created via admin invite, and the switcher was
  scaffolding for a state that no longer needs faking.
- Known remaining gaps: `case_notes` entries can't be edited or deleted once posted; there's
  still no audit log of who viewed a given customer's contact details; and the "leave zero
  admins" guard on role-change/remove-staff is a simple count check, not a transaction-level
  lock, so a true race between two admins acting simultaneously isn't fully closed.
- `auth.js`'s invite-acceptance flow (parsing `#type=invite`/`#type=recovery` off a Supabase
  email link, then `supabase.auth.updateUser({ password })`) is written against
  `@supabase/supabase-js@2`'s documented `detectSessionInUrl` behavior but has not been
  exercised against a real Supabase project's invite email yet — same category of gap the
  Vapi Web SDK work already called out (verified against real source/docs, not yet against a
  live send). Do this for real once `GMAIL_USER`/`GMAIL_APP_PASSWORD`/a real Supabase project
  are in place: invite a specialist, click the email link, confirm the set-password screen
  gets the right name/email/role and actually signs them in afterward.
- Migration `0008_dashboard_backend.sql` was written and the code built against it, but not
  yet applied to the live Supabase project from this environment — `supabase db push` needs
  interactive DB-password input this non-interactive session can't provide. Apply it (or paste
  it into the Supabase SQL editor) before any of Phase 8's endpoints will work against real
  data.
