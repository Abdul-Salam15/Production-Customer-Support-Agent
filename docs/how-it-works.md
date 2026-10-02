# How the RelayPay voice support agent works

RelayPay's support line is a voice agent you talk to in the browser. It answers product and policy questions from approved documentation. It looks up a caller's own transactions and payouts once they've proved who they are. Anything that needs a person goes to a specialist callback, which appears in a support queue.

**Try it:** open https://agent-backend-ct16.onrender.com, press **Start a call**, and allow the microphone. Test identities are listed under "Things to try" below.

## The four layers

| Layer | What it is | What it does |
|---|---|---|
| **Voice** | Vapi, with Deepgram Nova 3 speech-to-text (Soniox fallback) | Turns the caller's speech into text, speaks the agent's replies, and ends the call after the agent's goodbye. |
| **Agent** | `apps/agent`: a Node backend running the Claude Agent SDK (`claude-sonnet-5`), used by Vapi as a "Custom LLM" | Decides what to do each turn, calls tools, and streams a voice-safe reply back. It also serves the web page and the specialist dashboard. |
| **Tools** | `apps/mcp-server`: an MCP server with 8 tools | The only part that touches business data: search the knowledge base, verify a customer, look up a transaction or payout, create a ticket or escalation, show the contact form, log an event. |
| **Memory** | Supabase (Postgres + pgvector) | Customers, transactions and payouts; the knowledge base with embeddings; and every conversation, turn, tool call, retrieval, ticket, escalation and evaluation. |

## What happens on a call

1. The agent opens by saying it's RelayPay's AI support assistant and what it can help with. The caller speaks. Vapi transcribes it and sends the text to the agent backend.
   - With **Review before sending** switched on (next to Mute), the caller's words first appear in an editable box. The agent waits until they press Send, or answers the original words after 20 seconds.
   - The caller can also **type** at any point (handy for an email or a reference). Typed text goes to the agent as their message, skips review, and the agent takes it exactly as written.
2. The agent picks a response path (below) and calls whatever MCP tools it needs. Each tool call is logged to `tool_calls`.
3. Its reply passes through safety layers before Vapi speaks it:
   - an output guard that blocks leaked emails, amounts or internal notes;
   - a filter that drops "let me check that"-style narration, and anything said before a tool call;
   - a rewriter that reads references aloud digit by digit ("T-X-N, nine-zero-zero-one").
4. If the caller needs a specialist, an on-screen form collects their name, email and callback time. The agent then creates an escalation, which appears in the support queue with a priority and an email confirmation.
5. When the caller says they're done, the agent adds a fixed sign-off and Vapi hangs up after speaking it. A call summary is emailed to the caller and the support team.
6. If the caller goes quiet, Vapi itself (not the agent backend, which only runs when spoken to) checks in after 20 seconds, then ends the call after 25 if there's still nothing. The check only resets on actual speech, not on typing or submitting the contact form, so it's set generously to give form-filling room.

## The four response paths

Every reply is tagged with one of these paths and a confidence level. The tag is stored with each turn and removed before the caller hears it.

1. **Answer:** a general question the knowledge base covers, e.g. "What fees do you charge for international payments?" The agent always searches first and answers only from what it finds.
2. **Clarify:** the request is too vague to act on, e.g. "My payment is stuck." The agent asks one short question, such as which payment and its reference.
3. **Escalate:** a person is needed. That covers account restrictions, compliance concerns, disputes, refunds, frustration, or a record that calls for review. The agent arranges a specialist callback.
4. **Decline:** the knowledge base has nothing reliable and answering would mean guessing. The agent declines rather than inventing an answer, and the decline is logged for the support team.

## Rules enforced in code, not just the prompt

- **Nothing about an account is shared until the caller is verified.** That needs the account email plus their name or company. The lookup tools refuse unverified callers, so even a reference's status stays private. Matching tolerates speech-recognition slips in names, but the email's letters must match exactly.
- **Tickets need a verified caller.** An unverified caller's callback is never linked to anyone's transaction.
- **Priority is computed by the server,** from the category plus whether the caller is upset, money is overdue, or the account is restricted. Checks against the database can raise it but never lower it.
- **Case references and callback times come from the tools.** The agent reads back the reference and time the tools return, and doesn't make them up.

## Where we're stricter than the test scenarios

Scenarios 3 and 4 expect an answer from a name and company, or from a bare transaction reference. Here, the agent first asks for the email on the account, and only then calls `lookup_customer` or `lookup_transaction`. A name, company or reference doesn't prove who's calling, and the knowledge base says RelayPay doesn't share sensitive account information through automated or voice systems. For the same reason, amounts and recipient names are never spoken, even after verification. The details are in [testing-evidence.md](testing-evidence.md).

## Things to try

| Say | What happens |
|---|---|
| "What fees do you charge for international payments?" | Knowledge-base answer |
| "I'm Amara Okafor from LagosLedger, my email is amara@lagosledger.example. Can you check TXN-9001?" | Verified, then a transaction lookup |
| "I'm Efua Mensah from AccraStack, efua@accrastack.example. What's happening with payout PAY-7002?" | Payout under review, then a callback offer, the form, and an escalation |
| "I'm Amina Jacobs from CapeCloud, amina@capecloud.example. Transaction TXN-9004 failed." | Support ticket |
| "My account was restricted and nobody is helping me." | High-priority escalation |
| "No, that's all, bye." | The agent says goodbye and the call ends |

Specialists sign in at `/login` to see the queue. Customers can sign up at `/signup` to see their call history.

**Evidence:** `npm run evals` replays the test scenarios as text against the deployed system and writes [testing-evidence.md](testing-evidence.md).
