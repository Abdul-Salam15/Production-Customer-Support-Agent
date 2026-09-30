# Deployment — Vapi assistant and hosting (Phase 6)

These are manual steps performed in the Vapi and Render dashboards. Claude Code cannot
perform them (no dashboard access) — this document is the checklist for doing them by hand.

**Hosting note:** the plan in `implementation.md`'s Phase 6 and system-overview table says
Railway. This project uses **Render** instead (a platform-choice substitution only — the
two-services-from-one-repo structure, env vars, and Vapi wiring below are unchanged; only the
dashboard mechanics differ). Everywhere Phase 6 says "Railway," read "Render."

No new deployment config file (`render.yaml`, Procfile, etc.) is needed: both
`apps/agent/package.json` and `apps/mcp-server/package.json` already have `build` (`tsc`) and
`start` (`node dist/index.js`) scripts, which is exactly what Render's per-service Build
Command / Start Command fields expect directly.

---

## 6.2 — Local tunnel testing (do this before touching Render)

Confirm a full call works end to end locally first — debugging a live deployment is slower
than debugging localhost.

1. Start the agent backend locally:
   ```
   npm run dev --workspace apps/agent
   ```
   (Point its `.env` at the real MCP server — either a locally-running `apps/mcp-server`, also
   started with `npm run dev --workspace apps/mcp-server`, or an already-reachable deployed
   one.)
2. Expose the local agent backend with a tunnel — ngrok (`ngrok http 3000`) or Cloudflare
   Tunnel (`cloudflared tunnel --url http://localhost:3000`) — and note the public HTTPS URL
   it prints.
3. In the Vapi dashboard, create (or reuse) a **test** assistant and point it at the tunnel
   URL using the same Custom LLM + server URL settings described in 6.1 below, substituting
   the tunnel URL for the real deployed URL.
4. Place a real call against that test assistant and confirm: the assistant responds with a
   real Agent SDK answer, a `conversations` row and at least one `conversation_turns` row
   appear in Supabase, and (if triggered) a tool call reaches the MCP server successfully.
5. Only once this passes, move to deploying for real (below) and repoint the **real**
   assistant's URLs at the deployed one.

---

## 6.1 — Vapi assistant configuration

1. **Create the assistant** in the Vapi dashboard, named distinctly to avoid colliding with
   cohort-mates on the shared account — e.g. `abdulsalam-relaypay-support`.
2. **Set the LLM provider to "Custom LLM"**, with the URL pointing at the deployed
   `agent-backend`'s Vapi endpoint. Vapi appends `/chat/completions` to whatever base URL is
   configured here, and the backend's route is `POST /vapi/chat/completions`
   ([customLlm.ts](../apps/agent/src/vapi/customLlm.ts)) — so the Custom LLM URL field should
   be `<deployed-agent-backend-url>/vapi` (e.g.
   `https://<your-render-service>.onrender.com/vapi`), not the bare service root.
3. **Register the endpoint's bearer token** (the agent backend's `VAPI_PRIVATE_KEY` value)
   through Vapi's credential settings so it's sent as the Custom LLM call's `Authorization`
   header. On the assistant's Advanced tab, under the **"Select a custom credential to
   authenticate API requests"** section, click "Add New" next to the Credential dropdown and
   choose credential type **"Custom LLM"** specifically — paste the raw token (no `Bearer `
   prefix) into its API Key field. Two other-looking options do **not** work for this call and
   fail silently (Vapi sends a literal placeholder `Bearer no-custom-llm-key-provided` instead
   of erroring): the assistant's generic "HTTP Headers" field, and a "Bearer Token" credential
   attached under the *other*, visually similar "Authorization" section (the one under
   "Configure a webhook server to connect tools and events to your assistant" — that one is
   for the separate server-URL/events integration in the next step, not the Custom LLM call).
4. **Set the server URL and shared secret for `/vapi/events`**: in the assistant's server-URL
   / webhook settings, set the URL to `<deployed-agent-backend-url>/vapi/events`
   ([events.ts](../apps/agent/src/vapi/events.ts)), and configure the same secret value on
   both sides — the Vapi assistant's server-URL secret field, and the agent backend's
   `VAPI_SERVER_SECRET` environment variable.

---

## 6.3 — Render deployment

Two services from this one repository:

### Service 1 — `agent-backend`
- New Web Service in Render, connected to this repo.
- **Root Directory:** `apps/agent`
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`
- **Environment variables** (Section 3 of `implementation.md`):
  | Variable | Value |
  |---|---|
  | `ANTHROPIC_API_KEY` | real Anthropic key |
  | `ANTHROPIC_MODEL` | e.g. `claude-haiku-4-5` |
  | `SUPABASE_URL` | Supabase project URL |
  | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
  | `MCP_SERVER_URL` | the deployed `mcp-server` service's URL (Service 2 below) |
  | `MCP_SERVER_TOKEN` | same token value as `mcp-server`'s `MCP_SERVER_TOKEN` |
  | `VAPI_PRIVATE_KEY` | the bearer token registered in Vapi's Custom LLM credential (6.1) |
  | `VAPI_SERVER_SECRET` | the shared secret set on Vapi's server URL (6.1) |
  | `VAPI_PUBLIC_KEY` | Vapi public key (browser-exposed via `/api/config`) |
  | `VAPI_ASSISTANT_ID` | this assistant's ID (browser-exposed via `/api/config`) |
  Render sets `PORT` itself — do not set it manually; the app already reads it from the
  environment (`env.ts`).

### Service 2 — `mcp-server`
- New Web Service in Render, connected to the same repo.
- **Root Directory:** `apps/mcp-server`
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`
- **Environment variables:**
  | Variable | Value |
  |---|---|
  | `SUPABASE_URL` | Supabase project URL |
  | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
  | `MCP_SERVER_TOKEN` | same token value as `agent-backend`'s `MCP_SERVER_TOKEN` |
  | `SUPPORT_EMAIL_FROM` | only needed if the Phase 8.3 escalation-email stretch goal is built |

### Wiring it together
1. Deploy `mcp-server` first, note its Render URL, and set `agent-backend`'s
   `MCP_SERVER_URL` to it.
2. Deploy `agent-backend`.
3. Back in the Vapi dashboard, replace the tunnel URL from 6.2 with the real deployed
   `agent-backend` URL in both the Custom LLM URL (6.1 step 2) and the server URL
   (6.1 step 4).

---

## Definition of done (Phase 6, from `implementation.md`)

- [ ] A real call from the deployed web page, end to end, produces a spoken response.
- [ ] `conversations`, `conversation_turns`, `tool_calls`, and (if triggered) `support_tickets`
      / `escalations` rows appear in Supabase for that call.
- [ ] The MCP server, hit directly at its deployed URL with the correct bearer token,
      responds — it may be submitted as a standalone endpoint.
