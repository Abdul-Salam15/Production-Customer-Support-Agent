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
- Real customer accounts (signup/login/call history at `/signup` and `/customer`) were added
  as a separate `customer_accounts` table/auth flow from staff's `profiles` — same Supabase
  Auth mechanism (`auth.users`), two different "what kind of account is this" tables. `/login`
  is universal for both: it signs in via Supabase first, then asks the new `GET /api/whoami`
  which table the resulting user belongs to, and redirects accordingly (`/admin`/`/specialist`
  for staff, `/customer` for customers). A customer's "calls" aren't stored against their
  account directly — matched by email at read time against `customers.contact_email`,
  `contact_submissions.email`, and `escalations.user_email`, the same three places an identity
  already surfaces elsewhere in this schema. Migration `0009_customer_accounts.sql` needs
  applying alongside `0008` before this works against real data.
- The original customer-facing account system (`customer.js`, `shared-cases.js`, and the
  `#login`/`#signup`/`#history` hash-routed views in `index.html`) was removed entirely rather
  than kept alongside the real one — it was a fully local, unauthenticated prototype
  (hardcoded `CUSTOMERS` array, plaintext password comparison) that looked identical to the
  real staff login and caused a real mix-up (a real admin password typed into the fake
  customer login, which silently rejected it). One login system per concern now: `/login` ->
  `/api/whoami`-routed, `/signup` -> real `customer_accounts`.
- Added an admin-only "Audit Logs" tab: a single append-only `audit_log` table (`message` is a
  complete, pre-composed plain-English sentence written at the point each event happens, not
  reconstructed from raw columns at read time — the audience is explicitly non-technical
  admins). `logAudit()` (duplicated once per app, matching every other small lib in this
  codebase) is called from: every MCP tool call (`withLogging.ts`, reusing the already
  human-readable `purpose` string each tool registers itself with), every email send (inside
  `sendEmail()` itself, so all five email scenarios get covered for free), escalation/ticket
  creation, a call starting and ending, and every case/team action in the dashboard
  (claim/unclaim/resolve/reopen/note/invite/role-change/remove). "User logged in" needed two
  new tiny endpoints (`POST /api/dashboard/login-event`, `POST /api/customer/login-event`)
  since Supabase Auth itself never tells the backend when someone signs in — the frontend calls
  these once, right after a fresh `signInWithPassword` succeeds (explicitly not on every
  session-restore page load, which would otherwise log a "logged in" line on every refresh).
  The tab polls `GET /api/dashboard/audit-log` every 8s while open rather than using Realtime/
  websockets — simplest thing that reads as "live" at this traffic scale. Migration
  `0010_audit_log.sql` needs applying (after `0008`, which it depends on for `is_admin()`)
  before this tab shows anything.
- Refined after seeing a reference design (a past project, "Casefile", with an equivalent
  tool-call audit system): tool calls specifically got pulled out of the generic `audit_log`
  feed into their own structured view, backed by the `tool_calls` table that already existed
  (migration `0002`) and was already written to by every tool via `withLogging.ts` — no new
  table needed, just a read policy (`0011_tool_calls_admin_read.sql`) and two new endpoints.
  Casefile's design also logs *blocked* tool calls (denied by a `PreToolUse` allowlist hook
  before they reach the tool), which doesn't have an equivalent here: our tools live in a
  separate MCP server process reached over HTTP, not as in-process SDK tools gated by hooks,
  so the model can only ever call one of the 8 tools that server actually registers — there's
  no mechanism that would currently produce a "blocked" row, and building one (an agent-side
  allowlist gate) was deliberately deferred as speculative scope until a real need shows up.
  The per-case "Tool calls, live" panel (`GET /api/dashboard/cases/:reference/tool-calls`)
  polls every 3s while a case is open and its underlying call hasn't ended, then stops itself
  once the server reports `callEnded` or the case closes — for a short voice call, by the time
  a specialist actually opens the case the call has usually already ended, so in practice this
  often settles into "load once, stop" rather than truly live-updating; it's still built to
  update in real time for the case where a specialist has the case open while the call is
  still going.
- Real bug found via user report: "Confirm change" on a role change appeared to do nothing.
  Root cause — `await sendEmail(...)` (and the equivalent in resolve/escalation-create/call-
  summary) sat directly in the request path before responding; with `GMAIL_USER`/
  `GMAIL_APP_PASSWORD` still placeholders, the SMTP connection attempt stalls, and with zero
  loading feedback on the button, a multi-second-to-minutes-long hang looked identical to a
  dead click. Fixed by making every such send fire-and-forget (`sendEmail(...).catch(...)`,
  never `await`ed) in `createEscalation.ts`, `vapi/events.ts`, and both dashboard handlers
  (resolve, role-change) — the HTTP/tool-call response no longer waits on Gmail at all, which
  was the real fix, not just a UX band-aid. Paired with it: every async button in the app
  (login, signup, set-password, invite, role-change confirm, remove confirm, name edit, and
  every case action in the queue) now sets `aria-busy="true"` + `disabled` while in flight, via
  a shared `setBusy()` helper and a `bindForm()` change that applies it automatically to any
  form's submit button — a CSS rule keyed off `[aria-busy="true"]` draws a small spinner using
  `currentColor`, so it looks right on every button variant without per-button color rules.
  `queue.js`'s case actions needed a different approach than a plain disable-the-clicked-button,
  since `render()` replaces the whole detail pane's innerHTML on every action — a `ui.actionBusy`
  flag is threaded through `actionsHTML()` instead, checked again on each render.
- Once failed sends became visible in the Audit Logs tab (the fix above), the real cause of
  "still no email" showed up immediately: `connect ENETUNREACH 2607:f8b0:...` — an IPv6 address,
  not a credentials error. First attempt: `dns.setDefaultResultOrder("ipv4first")` at each app's
  entry point — did not fix it (confirmed by the user still hitting the identical error after
  deploying). Read nodemailer's actual source (`node_modules/nodemailer/dist/cjs/shared/index.js`)
  to find out why: it does its own DNS resolution via `dns.resolve4`/`dns.resolve6` directly,
  completely bypassing `dns.lookup()` and therefore `setDefaultResultOrder` — and
  `formatDNSValue` deliberately picks a **random** address from the combined IPv4+IPv6 result
  list rather than preferring IPv4, so on a host with no outbound IPv6 route (Render's
  containers) it fails roughly as often as Gmail's DNS answer includes an IPv6 record. Real fix:
  resolve the IPv4 address ourselves (`dns/promises.resolve4`) and pass that literal IP as
  nodemailer's `host` — `resolveHostname` short-circuits entirely when `host` is already an IP
  (`net.isIP(options.host)`), so none of nodemailer's own resolution logic runs. `servername:
  "smtp.gmail.com"` is required alongside it so TLS still validates against the real hostname
  instead of the IP (confirmed in source: `this.servername` defaults to `false` when `host` is
  an IP literal unless `options.servername` is set explicitly). Verified end-to-end from this
  environment, not just by reasoning about the source: resolved a real IPv4 address, connected,
  authenticated, and got Gmail's `250 2.0.0 OK` back with a real message-id, confirmed delivered.
- Also fixed while investigating: the Tool Calls table was rendering oldest-first —
  `GET /api/dashboard/tool-calls` already orders newest-first server-side, but
  `renderToolCallTable()` was reversing that a second time (copy-pasted from the live feed's own
  reverse, where it's correct because that endpoint returns oldest-first). And the table had no
  scroll boundary of its own, so on a narrower viewport the Status/Time columns were pushed
  completely out of reach rather than reachable via a contained horizontal scrollbar.
- The IPv4-literal fix changed the error on Render from `ENETUNREACH` to `Connection timeout` —
  same IPv4 address, same port 465, just hangs instead of failing fast. Port 465 worked fine
  from this dev environment (the verified send above), which points at Render specifically
  blocking or dropping outbound port 465 — a known category of restriction on cloud platforms to
  curb spam. Switched to port 587 with STARTTLS (`secure: false, requireTLS: true`) instead of
  465's direct TLS, at the user's request, as a cheaper thing to rule out before committing to
  replacing Gmail SMTP with an HTTP-based provider. Could not verify this one end-to-end the way
  465 was verified — port 587 also timed out from this dev environment, which may just be this
  environment's own restriction on that port rather than telling us anything about Render, so
  this one needs a real test from Render itself. If 587 also times out there, that's reasonably
  strong evidence Render blocks outbound SMTP broadly, and the real fix is switching to an
  HTTP-based email API (Resend was the original plan in `implementation.md` before Gmail SMTP
  was chosen) rather than continuing to try SMTP ports.
- Port 587 also failed on Render (still "Connection timeout" per the user's report) — confirming
  Render blocks outbound SMTP broadly, not just port 465. Switched to Brevo's HTTP API
  (`https://api.brevo.com/v3/smtp/email`, plain `fetch`, no new dependency) at the user's
  request, replacing `nodemailer` entirely in both apps' `mailer.ts` and removing it from both
  `package.json`s. Env vars changed shape: `GMAIL_USER`/`GMAIL_APP_PASSWORD` are gone, replaced
  by `BREVO_API_KEY` and `EMAIL_FROM` (the sender address, which must be a verified sender in
  Brevo — Settings → Senders & IP → Senders, confirmed via an emailed link — not an app password
  like Gmail needed). Unlike the port-465 fix, this one could not be verified end-to-end from
  this environment — no real Brevo account/API key was available here — so it's unverified until
  the user tests it against their own Render deployment with a real key.
- Known, accepted limitation (not a bug): `EMAIL_FROM` is a `@gmail.com` address, and Brevo
  flags it accordingly — "DMARC: Freemail domain is not recommended." Gmail's own DMARC policy
  tells every receiving mail server to reject or quarantine mail claiming `From: ...@gmail.com`
  that didn't actually originate from Google's infrastructure, regardless of which third-party
  provider relays it or whether that provider has verified the sender owns the inbox. The first
  test send (before the sender was verified in Brevo) got silently rerouted through Brevo's own
  `brevosend.com` sandbox domain and was never seen in the recipient's inbox or spam — consistent
  with either DMARC enforcement or the sandbox domain's own lack of sender reputation. The only
  durable fix is sending from a domain the user controls DNS for (adding Brevo's provided SPF/
  DKIM DNS records there); the user chose to keep the gmail.com sender for now and accept
  reduced/unreliable deliverability rather than acquire a domain. If outbound email reliability
  becomes a real requirement later, revisit this — it is not something further code changes can
  fix.
