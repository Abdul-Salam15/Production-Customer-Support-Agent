# RelayPay voice support agent

A production-style voice customer support agent for RelayPay, a fictional business payments company. Callers talk to it in the browser. It answers from approved documentation, verifies callers before looking up their transactions and payouts, and escalates to specialists through a callback queue.

- **Live voice interface:** https://agent-backend-ct16.onrender.com
- **Specialist dashboard:** https://agent-backend-ct16.onrender.com/login
- **MCP server (deployed):** https://mcp-server-q9jz.onrender.com/mcp (`GET /health` is open; `/mcp` needs the bearer token)
- **How it works (one page):** [docs/how-it-works.md](docs/how-it-works.md)
- **Testing evidence:** [docs/testing-evidence.md](docs/testing-evidence.md)

## Repository layout

| Path | What it is |
|---|---|
| `apps/agent` | Agent backend: Vapi's Custom LLM endpoint (Claude Agent SDK), webhooks, the web page and dashboard (`public/`) |
| `apps/mcp-server` | MCP server with the 8 support tools: the only code that reads or writes business data |
| `supabase/migrations` | Database schema, in order (`0001` → `0015`) |
| `supabase/seed`, `assets/seed-data` | Seed customers, transactions and payouts |
| `scripts/ingest-knowledge-base.ts` | Chunks and embeds `assets/relaypay-knowledge-base.md` into `kb_chunks` |
| `scripts/run-evals.ts` | Replays the test scenarios against a running backend and records the results |
| `docs/` | How it works, deployment guide, testing evidence, reflection notes |
| `PRD.md`, `assets/` | The original brief and source material |

## The MCP server

It's a standalone Streamable HTTP MCP server at `POST /mcp`, protected by a bearer token. Any MCP client can use it, not only this agent.

| Tool | Purpose |
|---|---|
| `search_knowledge_base` | Hybrid vector and keyword search over the knowledge base; returns 3 chunks and `sufficient_context` |
| `lookup_customer` | Verifies a caller: the account email plus name or company must match one customer |
| `lookup_transaction` | A transaction's status, arrival estimate and summary, for verified callers only |
| `lookup_payout` | A payout's status and failure reason, for verified callers only |
| `create_support_ticket` | A tracked issue, for verified callers only; priority is computed by the server |
| `create_escalation` | A specialist callback case; priority computed by the server; emails a confirmation |
| `request_contact_details` | Tells the browser to show the contact form |
| `log_conversation_event` | Records a notable moment in the call history |

To pass the caller's conversation to the tools, send it in an `x-conversation-id` header. Every call is logged to `tool_calls`, with email addresses masked.

**Run it on its own:**

```bash
npm install
cp .env.example apps/mcp-server/.env   # keep the "apps/mcp-server/.env" section
npm run dev -w apps/mcp-server          # listens on PORT (default 3001), endpoint /mcp
```

| Variable | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Database access |
| `MCP_SERVER_TOKEN` | Bearer token clients must send |
| `RESEND_API_KEY`, `EMAIL_FROM` | Escalation emails, sent from an address on a domain verified in Resend |
| `SUPPORT_TEAM_EMAIL` | Where new-case alerts go |

## Running everything locally

1. **Supabase:** create a project, then run every file in `supabase/migrations` in order in the SQL editor.
2. **Seed and ingest:**
   ```bash
   npm install
   npm run seed        # customers, transactions, payouts
   npm run ingest-kb   # knowledge base chunks + embeddings
   ```
3. **Env files:** copy the sections of [.env.example](.env.example) into `apps/agent/.env` and `apps/mcp-server/.env`, and fill in real values. `MCP_SERVER_TOKEN` must match in both.
4. **Start both services:**
   ```bash
   npm run dev -w apps/mcp-server   # :3001
   npm run dev -w apps/agent        # :3000
   ```
5. **Voice:** Vapi needs a public URL to reach the agent. Use a tunnel, or deploy to Render. [docs/deployment.md](docs/deployment.md) walks through both, including the Vapi assistant settings:
   - the Custom LLM credential;
   - the server URL `/vapi/events` and its secret;
   - the End Call Phrase `Thank you for calling RelayPay`.

## Testing

```bash
npm run evals -- --url https://agent-backend-ct16.onrender.com
```

This plays each test scenario once in text mode, through the real backend, tools and database. It checks what actually happened in Supabase (tools called, cases created, events logged) as well as the reply text. Results go to the `evaluations` table and [docs/testing-evidence.md](docs/testing-evidence.md).
- `--only 4,6` runs a subset.
- `--runs 3` repeats each scenario and reports a pass rate.
- `--keep` keeps the cases it creates; by default it deletes them.

The voice path itself (scenario 9) is checked with a real call.

## Deployment

Both services run on Render, from this repository. The model is set with `ANTHROPIC_MODEL` and is currently `claude-sonnet-5`. In testing, Sonnet passed every scenario in every attempt; Haiku 4.5 passed 18 of 24. See [docs/deployment.md](docs/deployment.md).
