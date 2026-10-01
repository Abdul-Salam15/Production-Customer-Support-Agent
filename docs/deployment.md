# Deployment — Vapi assistant and hosting (Phase 6)

This is a runbook, not a reference doc — follow it top to bottom, in order. Each step says:
the exact command, what you should see when it works, and what to do next. Steps that happen
in the Vapi or Render dashboard are manual — Claude Code has no login for either, so those
parts describe what to click, but you're the one clicking.

**Hosting note:** `implementation.md`'s Phase 6 says Railway throughout. This project uses
**Render** instead (your own choice, made earlier) — the structure (two services, one repo)
and every env var are unchanged; only the dashboard mechanics differ. Wherever you see
"Railway" in `implementation.md`, mentally read "Render."

**Why this order:** you test everything against your own laptop first, with a temporary
public URL (a "tunnel"), before touching Render at all. That way if something's broken, you're
debugging it on your own machine with full logs in front of you, not guessing at a deployed
service's logs.

You'll want **two terminal windows** open side by side for Part A (one for each service), plus
a browser for the Vapi/Render dashboards.

---

## Part A — Run both services on your own machine

### A1. Start the MCP server

In terminal 1, from the repo root:
```
npm run dev --workspace apps/mcp-server
```

**You should see:**
```
MCP server listening on port 3001
```
Leave this terminal running — don't close it or press Ctrl+C. This is the "hands" layer
(Phase 3's eight tools); the agent backend calls into it.

### A2. Start the agent backend

In terminal 2, from the repo root:
```
npm run dev --workspace apps/agent
```

**You should see:**
```
> agent@0.0.0 dev
> tsx watch src/index.ts

Agent backend listening on port 3000
```
Leave this running too. This is the service Vapi will actually talk to.

**If instead you see** `Error: listen EADDRINUSE: address already in use :::3000` — something
is already using port 3000, almost always a dev server left running from an earlier session
that you forgot to stop. Fix it:
```powershell
Get-NetTCPConnection -LocalPort 3000 | Select-Object OwningProcess
Stop-Process -Id <the OwningProcess number printed above> -Force
```
Then re-run the `npm run dev --workspace apps/agent` command from A2. (This happened once
already while building this — see `docs/reflection-notes.md`.)

### A3. Confirm both are actually up

In a third terminal (or a browser), check the agent backend responds:
```
curl http://localhost:3000/api/config
```
**You should see** a small JSON object like
`{"vapiPublicKey":"placeholder-vapi-public-key","vapiAssistantId":"placeholder-vapi-assistant-id"}`
(or your real values, if you've already filled them into `apps/agent/.env`). Any JSON response
means the server is alive — move on.

---

## Part B — Expose the agent backend with a tunnel

Vapi runs in the cloud and can't reach `localhost`, so you need a temporary public URL that
forwards to your machine.

### B1. Pick ngrok or Cloudflare Tunnel and install it if you haven't

- ngrok: https://ngrok.com/download
- Cloudflare Tunnel (`cloudflared`): https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

### B2. Start the tunnel, pointed at port 3000 (the agent backend, not the MCP server)

ngrok:
```
ngrok http 3000
```
**You should see** a screen that stays open, with a line like:
```
Forwarding    https://abcd-1234.ngrok-free.app -> http://localhost:3000
```

Cloudflare Tunnel:
```
cloudflared tunnel --url http://localhost:3000
```
**You should see** a line containing a URL like `https://random-words-here.trycloudflare.com`.

Either way: **copy that HTTPS URL** — you'll paste it into Vapi in the next part. Leave this
terminal running too (closing it kills the tunnel).

---

## Part C — Create a temporary TEST Vapi assistant

Don't touch your real assistant yet. Create a throwaway one so a mistake here doesn't affect
anything you keep.

1. In the Vapi dashboard, create a new assistant. Name it something obviously temporary, e.g.
   `abdulsalam-test-tunnel`.
2. Find the model/LLM provider setting and set it to **Custom LLM**. For the URL field, paste
   your tunnel URL from Part B with `/vapi` appended — e.g.
   `https://abcd-1234.ngrok-free.app/vapi`. (Vapi appends `/chat/completions` itself, landing
   on the backend's real route, `POST /vapi/chat/completions`.)
3. Find the assistant's **Advanced** tab, and within it a section about authenticating Custom
   LLM requests (worded something like "Select a custom credential to authenticate API
   requests"). Click **Add New** next to the Credential dropdown, and for credential **type**
   choose **"Custom LLM"** specifically. Paste your `VAPI_PRIVATE_KEY` value (from
   `apps/agent/.env`) into its API Key field, with no `Bearer ` prefix, and save.
   - **Do not** use the assistant's generic "HTTP Headers" field for this, and don't use a
     "Bearer Token" type credential — both look plausible but silently fail: Vapi sends a
     literal placeholder string instead of your real token, and you'll see 401s with no
     obvious cause. There's a second, visually similar "Authorization" section on the same
     page for a webhook/tools integration — that's a different thing; ignore it here.
4. Find the assistant's server URL / webhook settings and set the URL to your tunnel URL plus
   `/vapi/events` — e.g. `https://abcd-1234.ngrok-free.app/vapi/events`. Set a secret value
   here (make one up), and put the same value into `VAPI_SERVER_SECRET` in
   `apps/agent/.env`, then restart the agent backend (Ctrl+C in terminal 2, re-run A2) so it
   picks up the new value.

---

## Part D — Place a test call against the tunnel

Most Vapi dashboards have a built-in "Talk to Assistant" / test-call button right on the
assistant page — use that first, since it needs no extra setup.

**You should see/hear:** the assistant answers with a real, coherent response (not silence,
not an error tone). **At the same time**, watch terminal 2 (the agent backend) — you should
see it print activity as the request comes in.

**If it fails immediately with something like an auth error:** re-check Part C step 3 — this
is almost always the credential-type mismatch.

**If it's silent or times out:** check terminal 1 and 2 are both still running, and that the
tunnel terminal from Part B is still open (closing it kills the URL Vapi is calling).

Once a real exchange works, ask a question that should trigger a tool call (e.g. something
about a product feature) and confirm the response actually reflects looked-up information,
not a generic answer.

---

## Part E — Verify the call landed in Supabase

In the Supabase dashboard's SQL editor, or Table editor:
```sql
select * from conversations order by started_at desc limit 5;
select * from conversation_turns order by created_at desc limit 10;
select * from tool_calls order by created_at desc limit 10;
```
**You should see** a row in `conversations` matching your test call's time, at least two rows
in `conversation_turns` (customer + agent), and (if you triggered a lookup) matching rows in
`tool_calls`.

If you'd rather not do this by hand each time, tell me once you've placed a call and I can
write a small script using your existing `SUPABASE_SERVICE_ROLE_KEY` to check this for you
automatically.

Once Parts C–E all pass, stop and don't delete the test assistant yet — keep it as a reference
until the real one (Part G) also works. Move on to deploying for real.

---

## Part F — Deploy both services to Render for real

Do this in the Render dashboard, in two passes — MCP server first, since the agent backend
needs its URL.

### F1. Deploy `mcp-server`

1. In Render, choose **New > Web Service**, and connect this GitHub repo.
2. Set **Root Directory** to `apps/mcp-server`.
3. Set **Build Command** to `npm install && npm run build`.
4. Set **Start Command** to `npm start`.
5. Add environment variables (from the table below) in the service's Environment tab.
6. Create the service.

**You should see** a build log stream in the dashboard, ending with something like "Your
service is live" and a URL such as `https://mcp-server-xxxx.onrender.com`. **Copy that URL** —
you need it for the next service.

| Variable | Value |
|---|---|
| `SUPABASE_URL` | your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | your Supabase service role key |
| `MCP_SERVER_TOKEN` | make up a long random token — the agent backend must use this exact same value |
| `RESEND_API_KEY` | your Resend API key (see the setup note below) |
| `EMAIL_FROM` | the address emails are sent from — must be on a domain verified in Resend |
| `SUPPORT_TEAM_EMAIL` | where escalation/call-summary alerts go — can be the same as `EMAIL_FROM` |

Do not set `PORT` — Render sets it automatically and the code already reads it from the
environment.

**Resend setup** (needed once): emails go through Resend's HTTP API, not SMTP — Render blocks
outbound SMTP entirely (confirmed: both port 465 and 587 just hang until timeout from a deployed
Render service, while both work fine from an unrestricted network), but plain HTTPS is never
blocked.
1. Sign up at resend.com (free tier: 3,000 emails/month, 100/day).
2. **Domains → Add Domain** — enter a domain you control (e.g. `yourdomain.com`), then add the
   DNS records Resend shows (DKIM and SPF; DMARC recommended) at your domain registrar and click
   **Verify**. Resend does not allow `@gmail.com`/`@outlook.com` senders at all.
3. Set `EMAIL_FROM` to an address on that domain, optionally with a display name —
   e.g. `RelayPay Support <support@yourdomain.com>`.
4. **API Keys → Create API Key** (sending access is enough) and use it as `RESEND_API_KEY`.

**Without a verified domain** you can only send from `onboarding@resend.dev`, and only to the
email address your Resend account was created with — fine for a quick smoke test with
`SUPPORT_TEAM_EMAIL` set to that address, but customer emails (escalation confirmations, call
summaries) will be rejected until a domain is verified. A rejected send shows up in the Audit
Logs tab as "Failed to send email ... (Resend API returned 403 ...)".

### F2. Deploy `agent-backend`

Same flow as F1, with:
- **Root Directory:** `apps/agent`
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your real Anthropic key |
| `ANTHROPIC_MODEL` | e.g. `claude-haiku-4-5` |
| `SUPABASE_URL` | your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | your Supabase service role key |
| `MCP_SERVER_URL` | the `mcp-server` URL you copied in F1 |
| `MCP_SERVER_TOKEN` | the exact same value you set in F1 |
| `VAPI_PRIVATE_KEY` | same value you'll register as the Custom LLM credential (Part G) |
| `VAPI_SERVER_SECRET` | same value you'll set as the server-URL secret (Part G) |
| `VAPI_PUBLIC_KEY` | your Vapi public key |
| `VAPI_ASSISTANT_ID` | your **real** assistant's ID (Part G) |
| `SUPABASE_ANON_KEY` | your Supabase project's anon/public key — safe client-side, powers the specialist dashboard's login |
| `RESEND_API_KEY` | same Resend API key as `mcp-server`'s |
| `EMAIL_FROM` | same sender address as `mcp-server`'s (see F1's Resend setup note) |
| `SUPPORT_TEAM_EMAIL` | same internal recipient as `mcp-server`'s |

**You should see** the same build-log-then-live pattern, ending in a URL like
`https://agent-backend-xxxx.onrender.com`. That's your real, deployed voice-agent URL.

**Bootstrapping the first admin:** the specialist dashboard only lets an existing admin invite
new teammates, and `profiles` starts out empty — so the very first account has to be created
by hand, once:
1. In the Supabase dashboard, go to **Authentication → Users → Add user**, create a user with
   your own email and a password, and **check "Auto Confirm User"**.
2. In the SQL editor, run:
   ```sql
   insert into profiles (id, email, full_name, role)
   values ('<the user's UID from step 1>', '<same email>', '<your name>', 'admin');
   ```
3. Log in at `/admin` with that email/password — you're now an admin and can invite everyone
   else normally from the Team tab.

**Supabase Auth redirect URL:** in **Authentication → URL Configuration**, add your
`agent-backend` URL's `/admin` path (e.g. `https://agent-backend-xxxx.onrender.com/admin`) to
**Redirect URLs** — invite and password-reset emails link back here, and Supabase rejects
redirects to URLs not on this list. (`/specialist` is the same page under a different, more
memorable path for non-admin invites — either one works for this.) Also add the `/customer`
path (e.g. `https://agent-backend-xxxx.onrender.com/customer`): customer sign-up confirmation
emails link back there, and an account can't see its call history until that link is clicked.

---

## Part G — Point your real Vapi assistant at Render

Repeat Part C's steps, but on your **real** assistant (e.g. `abdulsalam-relaypay-support`, not
the test one), substituting the Render `agent-backend` URL wherever Part C said the tunnel
URL — so the Custom LLM URL becomes
`https://agent-backend-xxxx.onrender.com/vapi`, and the events server URL becomes
`https://agent-backend-xxxx.onrender.com/vapi/events`.

---

## Part H — Final real-call verification

1. Open the deployed `agent-backend` URL itself in a browser (the customer-facing web page is
   served from the same service).
2. Start a real call from the page.
3. **You should see/hear** the same working exchange as Part D, but now against the live
   deployment.
4. Repeat Part E's Supabase queries against this real call.
5. Confirm the MCP server answers directly when hit with its bearer token:
   ```
   curl -X POST https://mcp-server-xxxx.onrender.com/mcp \
     -H "Authorization: Bearer <your MCP_SERVER_TOKEN value>" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```
   **You should see** a JSON response listing the eight tools, not a 401 or connection error.

---

## Definition of done (Phase 6, from `implementation.md`)

- [ ] A real call from the deployed web page, end to end, produces a spoken response.
- [ ] `conversations`, `conversation_turns`, `tool_calls`, and (if triggered) `support_tickets`
      / `escalations` rows appear in Supabase for that call.
- [ ] The MCP server, hit directly at its deployed URL with the correct bearer token,
      responds — it may be submitted as a standalone endpoint.

---

## Troubleshooting index

- **`EADDRINUSE` on port 3000/3001** — a leftover dev server from an earlier session. See A2.
- **Vapi Custom LLM call gets a 401 / assistant says nothing coherent** — almost always the
  credential-type mismatch in Part C step 3. Re-check you used credential type "Custom LLM,"
  not "Bearer Token" or the plain HTTP Headers field.
- **MCP server calls fail from the deployed agent backend** — check `MCP_SERVER_URL` on
  `agent-backend` exactly matches `mcp-server`'s Render URL (no trailing slash mismatch), and
  `MCP_SERVER_TOKEN` is identical on both services.
- **Changed an env var on Render and nothing changed** — Render redeploys automatically when
  you save an environment variable change; check the service's deploy log to confirm a new
  deploy actually ran.
