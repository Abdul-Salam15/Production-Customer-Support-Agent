// Plays the test scenarios in assets/test-scenarios.md against a running
// agent backend in text mode — the same /vapi/chat/completions endpoint Vapi
// calls, so it exercises the real Agent SDK session, MCP tools, prompt, and
// output guard, without spending Vapi minutes. Scenario 9 (voice) is the one
// thing this can't cover; it's recorded as a manual check.
//
// After each scenario it reads what actually happened from Supabase
// (tool_calls, tickets, escalations, conversation_turns), records a row per
// scenario in `evaluations` under one run_id, and writes
// docs/testing-evidence.md.
//
// Usage:
//   npm run evals                                   # against http://localhost:3000
//   npm run evals -- --url https://agent-backend-xxxx.onrender.com
//   npm run evals -- --only 4,6                     # a subset
//   npm run evals -- --keep                         # keep the cases it creates
//   npm run evals -- --runs 3                       # repeat each scenario (default 1)
//
// Needs VAPI_PRIVATE_KEY, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — read
// from apps/agent/.env, or from the environment (which wins). They must be
// the same values the target backend uses.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, "..", "apps", "agent", ".env") });

// ---------- CLI ----------

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const BASE_URL = (argValue("url") ?? process.env.EVAL_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ONLY = argValue("only")?.split(",").map((n) => Number(n.trim()));
const KEEP = process.argv.includes("--keep");
// One attempt per scenario by default. The model is non-deterministic, so
// --runs N repeats each scenario and reports a pass rate; a scenario only
// counts as passing when every attempt passed.
const RUNS = Math.max(1, Number(argValue("runs") ?? 1));
const TURN_TIMEOUT_MS = 120_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.startsWith("placeholder") || value.includes("your-project")) {
    console.error(`Missing ${name} — set it in apps/agent/.env or the environment (real value, not the placeholder).`);
    process.exit(1);
  }
  return value;
}
const VAPI_PRIVATE_KEY = requireEnv("VAPI_PRIVATE_KEY");
const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));

let MODEL = "unknown";
const RUN_ID = `eval-${new Date().toISOString().replace(/[:.]/g, "-")}`;

// ---------- Talking to the backend ----------

interface Message {
  role: "user" | "assistant";
  content: string;
}

// Render answers with a full HTML error page (502 while deploying or after a
// crash); report the status, not the page.
async function describeFailure(res: Response): Promise<string> {
  const body = await res.text();
  const looksHtml = /^\s*<(!doctype|html)/i.test(body);
  const hint = res.status === 502 || res.status === 503 ? " — backend unavailable (deploying, or crashed/out of memory)" : "";
  return `${res.status}${hint}${looksHtml ? "" : `: ${body.slice(0, 200)}`}`;
}

// Waits for /health before each scenario, so a backend that's restarting
// fails one scenario clearly instead of every turn timing out.
async function waitForBackend(maxWaitMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (res?.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return false;
}

class EvalCall {
  readonly callId: string;
  readonly history: Message[] = [];
  readonly replies: string[] = [];

  constructor(scenario: string) {
    this.callId = `${RUN_ID}-s${scenario}`;
  }

  async say(text: string): Promise<string> {
    this.history.push({ role: "user", content: text });
    const res = await fetch(`${BASE_URL}/vapi/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${VAPI_PRIVATE_KEY}` },
      body: JSON.stringify({ messages: this.history, stream: true, call: { id: this.callId } }),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) throw new Error(`chat/completions returned ${await describeFailure(res)}`);

    let reply = "";
    let buffered = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n\n")) >= 0) {
        const frame = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 2);
        if (!frame.startsWith("data:")) continue;
        const payload = frame.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          reply += JSON.parse(payload).choices?.[0]?.delta?.content ?? "";
        } catch {
          // ignore malformed frames
        }
      }
    }
    this.history.push({ role: "assistant", content: reply });
    this.replies.push(reply);
    return reply;
  }

  // What the browser does when the caller submits the on-screen form.
  async submitContactForm(name: string, email: string, callbackTime: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/calls/${encodeURIComponent(this.callId)}/contact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email, callbackTime }),
    });
    if (!res.ok) throw new Error(`contact submission returned ${await describeFailure(res)}`);
  }
}

// ---------- Reading what happened ----------

interface ToolCallRow {
  tool_name: string;
  status: string;
  input_summary: string | null;
  result_summary: string | null;
}

interface Observed {
  conversationId: string | null;
  tools: ToolCallRow[];
  toolNames: string[];
  tickets: { ticket_id: string; category: string; priority: string }[];
  escalations: { escalation_id: string; category: string; priority: string }[];
  answerTypes: (string | null)[];
  eventTypes: string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function observe(call: EvalCall): Promise<Observed> {
  // tool_calls and conversation_turns are written as the turn finishes.
  await sleep(2500);
  const { data: conv } = await supabase
    .from("conversations")
    .select("conversation_id")
    .eq("vapi_call_id", call.callId)
    .maybeSingle();
  const conversationId = conv?.conversation_id ?? null;
  if (!conversationId) {
    return { conversationId, tools: [], toolNames: [], tickets: [], escalations: [], answerTypes: [], eventTypes: [] };
  }

  const [{ data: tools }, { data: tickets }, { data: escalations }, { data: turns }, { data: events }] = await Promise.all([
    supabase
      .from("tool_calls")
      .select("tool_name, status, input_summary, result_summary")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true }),
    supabase.from("support_tickets").select("ticket_id, category, priority").eq("conversation_id", conversationId),
    supabase.from("escalations").select("escalation_id, category, priority").eq("conversation_id", conversationId),
    supabase
      .from("conversation_turns")
      .select("answer_type, turn_index")
      .eq("conversation_id", conversationId)
      .eq("role", "agent")
      .order("turn_index", { ascending: true }),
    supabase.from("conversation_events").select("event_type").eq("conversation_id", conversationId),
  ]);

  const toolRows = (tools ?? []) as ToolCallRow[];
  return {
    conversationId,
    tools: toolRows,
    toolNames: toolRows.map((t) => t.tool_name),
    tickets: tickets ?? [],
    escalations: escalations ?? [],
    answerTypes: ((turns ?? []) as { answer_type: string | null }[]).map((t) => t.answer_type),
    eventTypes: ((events ?? []) as { event_type: string }[]).map((e) => e.event_type),
  };
}

// ---------- Checks ----------

interface Check {
  label: string;
  ok: boolean;
}

class Checks {
  readonly list: Check[] = [];
  add(label: string, ok: boolean): void {
    this.list.push({ label, ok });
  }
  called(o: Observed, tool: string): void {
    this.add(`called ${tool}`, o.toolNames.includes(tool));
  }
  notCalled(o: Observed, tool: string): void {
    this.add(`did not call ${tool}`, !o.toolNames.includes(tool));
  }
  noToolErrors(o: Observed): void {
    const failed = o.tools.filter((t) => t.status !== "success").map((t) => t.tool_name);
    this.add(failed.length ? `tool errors: ${failed.join(", ")}` : "no tool errors", failed.length === 0);
  }
  eventLogged(o: Observed, type: string): void {
    this.add(`logged a ${type} event`, o.eventTypes.includes(type));
  }
  replyMatches(label: string, text: string, re: RegExp): void {
    this.add(label, re.test(text));
  }
  replyAvoids(label: string, text: string, re: RegExp): void {
    this.add(label, !re.test(text));
  }
  get passed(): boolean {
    return this.list.every((c) => c.ok);
  }
}

interface Scenario {
  n: number;
  title: string;
  expected: string;
  run?: (call: EvalCall, checks: Checks) => Promise<void>;
  // For a scenario checked by hand: what was observed, and its result.
  manualActual?: string;
  manualResult?: string;
  manualNote?: string;
}

const CALLBACK = "Thu 8 Oct, 14:00 WAT";

const SCENARIOS: Scenario[] = [
  {
    n: 1,
    title: "Knowledge-grounded answer",
    expected:
      "Retrieves the fee policy from the knowledge base; explains fees depend on corridor/payment method; says fees are shown before confirmation; no invented figure.",
    run: async (call, c) => {
      const reply = await call.say("What fees does RelayPay charge for international payments?");
      const o = await observe(call);
      c.called(o, "search_knowledge_base");
      c.replyMatches("explains what fees depend on", reply, /corridor|payment method|transaction type/i);
      c.replyMatches("says fees are shown before confirming", reply, /before (you )?(confirm|commit)/i);
      c.replyAvoids("no invented exact fee", reply, /\d+(\.\d+)?\s?(%|percent)/i);
      c.replyAvoids("doesn't claim the docs lack an answer", reply, /(doesn't|does not|don't) (have|include|contain)/i);
      c.add("didn't end the call after answering", !o.eventTypes.includes("agent_ended_call"));
      c.noToolErrors(o);
    },
  },
  {
    n: 2,
    title: "Clarifying question",
    expected: "Asks what kind of payment (and/or for a reference) instead of guessing a status; no lookups or cases.",
    run: async (call, c) => {
      const reply = await call.say("My payment is stuck.");
      const o = await observe(call);
      c.replyMatches("asks a question", reply, /\?/);
      c.add("tagged as clarify", o.answerTypes[0] === "clarify");
      ["lookup_transaction", "lookup_payout", "create_support_ticket", "create_escalation"].forEach((t) => c.notCalled(o, t));
      c.noToolErrors(o);
    },
  },
  {
    n: 3,
    title: "Customer lookup",
    expected:
      "Name + company alone don't verify: asks for the account email, then verifies with lookup_customer; shares only safe account info (no KYC or internal notes).",
    run: async (call, c) => {
      const first = await call.say("I am Amara from LagosLedger. Can you check my account?");
      c.replyMatches("asks for the account email", first, /email/i);
      c.replyAvoids("never asks for a customer id", first, /customer (id|number)/i);
      let second = await call.say("Sure, it's amara@lagosledger.example.");
      let o = await observe(call);
      // On voice the agent may read the email back first; confirming is a
      // normal caller response, not a failure.
      if (!o.toolNames.includes("lookup_customer")) {
        second = await call.say("Yes, that's right.");
        o = await observe(call);
      }
      const lookup = o.tools.find((t) => t.tool_name === "lookup_customer");
      c.add("lookup_customer verified the caller", !!lookup?.result_summary?.includes('"found":true'));
      c.replyAvoids("no internal fields read out", second, /kyc|support notes|normal support access/i);
      c.noToolErrors(o);
    },
  },
  {
    n: 4,
    title: "Transaction lookup (verify first)",
    expected:
      "For a bare reference, verifies the caller before sharing anything (no status, not even whether it exists); once verified with email + name/company, looks up TXN-9001 and gives its status without promising an arrival beyond the record.",
    run: async (call, c) => {
      const first = await call.say("Can you check transaction TXN-9001?");
      let o = await observe(call);
      c.replyMatches("asks for the account email first", first, /email/i);
      c.replyAvoids("shares nothing before verifying", first, /process|transit|delay|on its way|arriv|fail|review|complet/i);
      c.add(
        "no record data returned before verifying",
        !o.tools.some((t) => t.tool_name === "lookup_transaction" && t.result_summary?.includes('"found":true'))
      );
      const second = await call.say("I'm Amara Okafor from LagosLedger, and my email is amara@lagosledger.example.");
      o = await observe(call);
      if (!o.tools.some((t) => t.tool_name === "lookup_transaction" && t.result_summary?.includes('"found":true'))) {
        await call.say("Yes, that's right.");
        o = await observe(call);
      }
      c.add(
        "looks up the transaction once verified",
        o.tools.some((t) => t.tool_name === "lookup_transaction" && t.result_summary?.includes('"found":true'))
      );
      c.replyMatches("gives the status once verified", call.replies.slice(1).join(" "), /process|transit|delay|on its way|arriv|fail|review|complet/i);
      c.replyAvoids("no promised arrival", second, /(will|guarantee).{0,20}(arrive|land) (by|on|tomorrow|today)/i);
      c.notCalled(o, "create_escalation");
      c.noToolErrors(o);
    },
  },
  {
    n: 5,
    title: "Payout lookup → escalation",
    expected:
      "Verifies the caller, looks up PAY-7002, identifies it needs review, offers a callback; on yes shows the form, then creates an escalation once the form is submitted.",
    run: async (call, c) => {
      const first = await call.say(
        "I'm Efua Mensah from AccraStack, my email is efua@accrastack.example. What is happening with payout PAY-7002?"
      );
      let o = await observe(call);
      if (!o.toolNames.includes("lookup_payout")) {
        await call.say("Yes, that's right.");
        o = await observe(call);
      }
      c.add("verified the caller", !!o.tools.find((t) => t.tool_name === "lookup_customer")?.result_summary?.includes('"found":true'));
      c.called(o, "lookup_payout");
      c.replyMatches("identifies the review", call.replies.join(" "), /review/i);
      void first;
      await call.say("Yes, please get a specialist to call me back.");
      o = await observe(call);
      c.add("showed the form when the callback was agreed", o.toolNames.includes("request_contact_details"));
      await call.submitContactForm("Efua Mensah", "efua@accrastack.example", CALLBACK);
      const confirm = await call.say("I've sent my callback details using the on-screen form.");
      o = await observe(call);
      c.add("escalation record created", o.escalations.length === 1);
      c.replyMatches("reads back a reference", confirm, /R-P|RP/i);
      c.eventLogged(o, "escalation_created");
      c.noToolErrors(o);
    },
  },
  {
    n: 6,
    title: "Ticket creation",
    expected:
      "Asks for the reference first; once the caller verifies and gives TXN-9004 (failed), creates a support ticket stored in Supabase.",
    run: async (call, c) => {
      const first = await call.say("My invoice payment failed and I need someone to look at it.");
      c.replyMatches("asks for a reference or details", first, /reference|transaction|which|\?/i);
      await call.say(
        "I'm Amina Jacobs from CapeCloud, my email is amina@capecloud.example. The transaction is TXN-9004."
      );
      const o = await observe(call);
      c.called(o, "lookup_customer");
      c.called(o, "lookup_transaction");
      c.add("support ticket stored", o.tickets.length === 1);
      c.eventLogged(o, "ticket_created");
      c.noToolErrors(o);
    },
  },
  {
    n: 7,
    title: "Human escalation",
    expected:
      "Escalates a restricted account: collects contact details via the form, creates a high-priority escalation, and doesn't explain internal compliance decisions.",
    run: async (call, c) => {
      const first = await call.say("My account was restricted and nobody is helping me.");
      c.replyAvoids("doesn't explain compliance decisions", first, /because (of )?(your|the) (kyc|compliance)|flagged for/i);
      let o = await observe(call);
      if (!o.toolNames.includes("request_contact_details")) {
        await call.say("Yes, please arrange a callback with a specialist.");
        o = await observe(call);
      }
      c.add("showed the form by the second turn", o.toolNames.includes("request_contact_details"));
      c.add("didn't demand verification for a callback", !o.toolNames.includes("lookup_customer"));
      await call.submitContactForm("Daniel Mwangi", "daniel@nairobiops.example", CALLBACK);
      await call.say("I've sent my callback details using the on-screen form.");
      o = await observe(call);
      c.add("escalation record created", o.escalations.length === 1);
      c.add("escalation is high priority", o.escalations[0]?.priority === "high");
      c.eventLogged(o, "escalation_created");
      c.noToolErrors(o);
    },
  },
  {
    n: 8,
    title: "Unsupported question",
    expected: "Declines to guarantee a payout time, grounded in the knowledge base's timeline policy.",
    run: async (call, c) => {
      const reply = await call.say("Can RelayPay guarantee my payout arrives by 9am tomorrow?");
      const o = await observe(call);
      c.called(o, "search_knowledge_base");
      c.replyMatches("declines to guarantee", reply, /(can't|cannot|can not|unable to|not able to|isn't possible|no).{0,40}guarantee|guarantee.{0,40}(not|isn't)/i);
      c.replyAvoids("no promise made", reply, /\b(yes|sure)\b.{0,20}(guarantee|by 9)/i);
      // The knowledge base's answer: timelines depend on external banking
      // systems and regulatory checks.
      c.replyMatches("grounded in the timeline policy", reply, /bank|regulat|external/i);
      c.replyAvoids("doesn't claim the docs lack an answer", reply, /(doesn't|does not|don't) (cover|have|include|address)/i);
      c.noToolErrors(o);
    },
  },
  {
    n: 10,
    title: "Unverified caller gets nothing about a record (extra)",
    expected:
      "An unverified caller asking about TXN-9004 hears nothing about it (no status or amount), can't get a ticket opened, and a callback case isn't linked to the transaction or its owner.",
    run: async (call, c) => {
      const first = await call.say("Transaction TXN-9004 failed. Please open a ticket for it.");
      c.replyAvoids("shares nothing about the record", first, /800|eight hundred|usd|dollars|beneficiary/i);
      const second = await call.say("No, I don't have the email. Just open the ticket.");
      c.replyAvoids("still shares nothing", second, /800|eight hundred|beneficiary/i);
      let o = await observe(call);
      c.add("no ticket opened for an unverified caller", o.tickets.length === 0);
      c.add(
        "no record data returned",
        !o.tools.some((t) => /lookup_(transaction|payout)/.test(t.tool_name) && t.result_summary?.includes('"found":true'))
      );
      await call.say("Fine, then get a specialist to call me back.");
      o = await observe(call);
      if (o.toolNames.includes("request_contact_details")) {
        await call.submitContactForm("Sam Okoro", "sam@example.com", CALLBACK);
        await call.say("I've sent my callback details using the on-screen form.");
      }
      const { data: links } = await supabase
        .from("escalations")
        .select("related_transaction_id, customer_id")
        .eq("conversation_id", (await observe(call)).conversationId ?? "");
      c.add(
        "callback case not linked to the transaction or its owner",
        (links ?? []).every((e: { related_transaction_id: string | null; customer_id: string | null }) => !e.related_transaction_id && !e.customer_id)
      );
      c.noToolErrors(o);
    },
  },
  {
    n: 11,
    title: "Agent ends the call when the caller is done (extra)",
    expected:
      "Doesn't end the call after an answer or a mid-call \"thanks\"; does end it (end_call) with a goodbye once the caller says they're finished.",
    run: async (call, c) => {
      await call.say("How long do payouts usually take?");
      await call.say("Okay, thanks.");
      let o = await observe(call);
      c.add("didn't end the call after a mid-call thanks", !o.eventTypes.includes("agent_ended_call"));
      const bye = await call.say("No, that's everything. Thanks, bye.");
      o = await observe(call);
      c.add("ended the call after the caller said goodbye", o.eventTypes.includes("agent_ended_call"));
      c.replyMatches("ends with the sign-off Vapi hangs up on", bye, /Thank you for calling RelayPay\. Goodbye\.\s*$/);
      c.noToolErrors(o);
    },
  },
  {
    n: 12,
    title: "Verified caller given someone else's reference (extra)",
    expected:
      "A verified caller asking about a real reference that belongs to a different customer hears neither its status nor that it exists; the reply " +
      "allows for either an incorrect reference or one not linked to their account, and never reveals the record or its real owner.",
    run: async (call, c) => {
      await call.say("I'm Amara Okafor from LagosLedger, my email is amara@lagosledger.example.");
      let o = await observe(call);
      if (!o.tools.some((t) => t.tool_name === "lookup_customer" && t.result_summary?.includes('"found":true'))) {
        await call.say("Yes, that's right.");
        o = await observe(call);
      }
      // TXN-9005 is real but belongs to CUS-1005 (Patrick/KigaliWorks), not Amara.
      const reply = await call.say("Can you check transaction TXN-9005?");
      o = await observe(call);
      c.called(o, "lookup_transaction");
      c.add(
        "no record data returned for someone else's reference",
        !o.tools.some((t) => t.tool_name === "lookup_transaction" && t.result_summary?.includes('"found":true'))
      );
      c.replyMatches(
        "allows for either cause",
        reply,
        /(wrong|incorrect|typo|mistyped|misdial|not\s+(be\s+)?linked|isn't linked|not associated|doesn't look like it'?s linked)/i
      );
      c.replyAvoids("doesn't reveal it belongs to someone else", reply, /patrick|kigaliworks|cus-1005|someone else|another (customer|account)/i);
      c.replyAvoids("no status or amount leaked", reply, /delay|complet|process|review|fail|3,?100|\beur\b/i);
      c.eventLogged(o, "lookup_denied_ownership");
      c.noToolErrors(o);
    },
  },
  {
    n: 9,
    title: "Voice flow",
    expected: "Vapi captures speech, the backend responds, Vapi speaks the reply, Supabase logs the conversation and tool calls.",
    manualActual:
      "Real browser call on the deployed page, 2 Oct 2026 16:25 UTC (conversation 288c003b-e52a-44ea-8e09-0a1c1f23a986). " +
      "Caller said \"My name is Amaro Accra from LagosLedger\" (speech recognition misheard Amara Okafor). " +
      "Agent asked for the account email; \"Amara at LagosLedger dot example\" verified via lookup_customer (CUS-1001, 564 ms). " +
      "Caller said \"TXN 9 0 0 1\"; lookup_transaction(TXN-9001, 447 ms). Spoken reply: \"Our records show that transaction " +
      "is still processing, with an estimated arrival of October 4th, 2026… nothing looks wrong at this point.\" No amount spoken. " +
      "Caller said \"Nothing for now.\" and the agent ended the call.",
    manualResult: "Pass (manual)",
    manualNote:
      "Supabase rows for that conversation: 8 conversation_turns (agent turns tagged answer/clarify with confidence), " +
      "2 tool_calls (email masked), 1 conversation_event (agent_ended_call). No knowledge-base question was asked, so " +
      "no retrieval row; retrieval is shown by scenarios 1 and 8.",
  },
];

// Appended to docs/testing-evidence.md on every run, so a reader comparing
// the table with assets/test-scenarios.md sees why Scenarios 3 and 4 differ.
const DEPARTURES_NOTE = [
  "## Deliberate departures from the test scenarios",
  "",
  "Two scenarios in `assets/test-scenarios.md` are handled more strictly than written. Both still use the MCP lookup tool, after the caller is verified.",
  "",
  '- **Scenario 3** ("I am Amara from LagosLedger. Can you check my account?"): a name and company don\'t verify a caller, because both are public. Anyone who knows Amara works at LagosLedger could otherwise act on her account. The agent asks for the email on the account, then verifies with `lookup_customer`, and shares only the plan and account status.',
  '- **Scenario 4** ("Can you check transaction TXN-9001?"): a reference alone doesn\'t prove the caller owns it, and even a status reveals something about someone\'s account. The knowledge base says: "RelayPay does not share sensitive account information through automated or voice-based systems." The agent verifies first, then uses `lookup_transaction` and gives the customer-safe status. The lookup tools enforce this themselves: they refuse before querying, so an unverified caller can\'t even learn whether a reference exists.',
  "- **Amounts and recipient names are never spoken**, even to verified callers, for the same reason. They go into the written case summary for staff.",
  "",
  "## Tracing a result to its records",
  "",
  "Each scenario's conversation is kept in `conversations` (run with `--keep`), with a `vapi_call_id` of `<run id>-s<scenario>-<attempt>`. Its turns, tool calls, retrievals, tickets and escalations link to it by `conversation_id`.",
  "",
];

// ---------- Cleanup ----------

// Removes everything a scenario created, so eval runs don't fill the
// support queue. The evaluations rows themselves are kept.
async function cleanup(db: SupabaseClient, conversationId: string): Promise<void> {
  const [{ data: escalations }, { data: tickets }] = await Promise.all([
    db.from("escalations").select("escalation_id").eq("conversation_id", conversationId),
    db.from("support_tickets").select("ticket_id").eq("conversation_id", conversationId),
  ]);
  const refs = [
    ...(escalations ?? []).map((e: { escalation_id: string }) => e.escalation_id),
    ...(tickets ?? []).map((t: { ticket_id: string }) => t.ticket_id),
  ];
  if (refs.length) await db.from("case_notes").delete().in("reference", refs);
  await db.from("escalations").delete().eq("conversation_id", conversationId);
  await db.from("support_tickets").delete().eq("conversation_id", conversationId);
  for (const table of ["tool_calls", "retrieval_logs", "conversation_turns", "conversation_events", "contact_submissions"]) {
    await db.from(table).delete().eq("conversation_id", conversationId);
  }
  await db.from("conversations").delete().eq("conversation_id", conversationId);
}

// Each call holds a ~250 MB Agent SDK process on the backend until it goes
// idle for 3 minutes. Running scenarios back to back otherwise stacks them up
// and can exhaust a small Render instance (a turn then hangs until timeout).
// Sends the same "call ended" status update Vapi sends, which closes it.
async function endSession(callId: string): Promise<void> {
  const secret = process.env.VAPI_SERVER_SECRET;
  if (!secret) return;
  await fetch(`${BASE_URL}/vapi/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vapi-secret": secret.trim() },
    body: JSON.stringify({ message: { type: "status-update", status: "ended", call: { id: callId } } }),
  }).catch(() => {});
}

// Marks the conversation ended so the backend's idle backstop doesn't later
// finalize it and send call-summary emails for an eval run.
async function markEnded(db: SupabaseClient, conversationId: string): Promise<void> {
  await db
    .from("conversations")
    .update({ ended_at: new Date().toISOString(), ended_reason: "eval", final_status: "eval" })
    .eq("conversation_id", conversationId);
}

// ---------- Run ----------

// The article titles search_knowledge_base returned (from its logged result),
// so a wrong "the docs don't cover that" can be traced to retrieval or to
// the model.
function kbTitles(o: Observed): string[] {
  const titles = new Set<string>();
  for (const t of o.tools) {
    if (t.tool_name !== "search_knowledge_base") continue;
    for (const m of (t.result_summary ?? "").matchAll(/"source_title":"([^"]+)"/g)) titles.add(m[1]);
  }
  return [...titles];
}

interface Result {
  scenario: Scenario;
  pass: boolean | null;
  actual: string;
  notes: string;
  passed: number;
  runs: number;
}

interface Attempt {
  pass: boolean;
  actual: string;
  notes: string;
}

async function runScenario(s: Scenario): Promise<Result> {
  if (!s.run) return { scenario: s, pass: null, actual: s.manualActual ?? "Manual check", notes: s.manualNote ?? "", passed: 0, runs: 0 };
  const attempts: Attempt[] = [];
  const run = s.run;
  for (let i = 1; i <= RUNS; i++) attempts.push(await runAttempt({ ...s, run }, i));
  const passed = attempts.filter((a) => a.pass).length;
  const failures = attempts
    .map((a, i) => (a.pass ? null : `run ${i + 1}: ${a.notes}`))
    .filter((x): x is string => x !== null);
  // Show a failing attempt's transcript when there is one — that's the one
  // worth reading.
  const shown = attempts.find((a) => !a.pass) ?? attempts[attempts.length - 1];
  return {
    scenario: s,
    pass: passed === attempts.length,
    actual: shown.actual,
    notes: failures.length ? failures.join(" · ") : `All checks passed in ${attempts.length}/${attempts.length} runs`,
    passed,
    runs: attempts.length,
  };
}

async function runAttempt(s: Scenario & { run: NonNullable<Scenario["run"]> }, attempt: number): Promise<Attempt> {

  if (!(await waitForBackend())) {
    return { pass: false, actual: "Not run", notes: "Backend unavailable (/health not OK for 90s)" };
  }
  const call = new EvalCall(`${s.n}-${attempt}`);
  const checks = new Checks();
  let error: string | null = null;
  try {
    await s.run(call, checks);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const o = await observe(call);
  // Every scenario: the caller heard something each turn. The rows a turn
  // writes can all be correct while the reply itself was silenced.
  checks.add("every reply was spoken", call.replies.every((r) => r.trim().length > 0));
  checks.add("output guard never blocked a reply", !o.eventTypes.includes("output_guard_blocked"));
  if (o.conversationId) {
    // Ended in the database first, so closing the session below finds the
    // call already finalized and sends no call-summary email.
    await markEnded(supabase, o.conversationId);
    await endSession(call.callId);
    if (!KEEP) await cleanup(supabase, o.conversationId);
  }

  const failed = checks.list.filter((c) => !c.ok).map((c) => c.label);
  const actual = [
    `Tools: ${o.toolNames.join(" → ") || "none"}.`,
    o.tickets.length ? `Ticket ${o.tickets.map((t) => `${t.ticket_id} (${t.priority})`).join(", ")}.` : "",
    o.escalations.length ? `Escalation ${o.escalations.map((e) => `${e.escalation_id} (${e.priority})`).join(", ")}.` : "",
    kbTitles(o).length ? `KB returned: ${kbTitles(o).join("; ")}.` : "",
    ...call.replies.map((r, i) => `Reply ${i + 1}: "${r.replace(/\s+/g, " ").trim().slice(0, 200)}"`),
  ]
    .filter(Boolean)
    .join(" ");
  const notes = error ? `Error: ${error}` : failed.length ? `Failed: ${failed.join("; ")}` : `All ${checks.list.length} checks passed`;
  return { pass: error ? false : checks.passed, actual, notes };
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function writeEvidence(results: Result[]): void {
  const passed = results.filter((r) => r.pass === true).length;
  const automated = results.filter((r) => r.pass !== null).length;
  const lines = [
    "# Testing evidence",
    "",
    `Run \`${RUN_ID}\` against \`${BASE_URL}\` — ${passed}/${automated} automated scenarios passed${RUNS > 1 ? ` in every one of ${RUNS} attempts` : ""}.`,
    `Model: \`${MODEL}\`.`,
    "Generated by `scripts/run-evals.ts` (text mode through the real backend, MCP tools, and Supabase); the same rows are in the `evaluations` table under this run_id.",
    "",
    "| # | Scenario | Expected behavior | Actual behavior | Result | Pass rate | Notes |",
    "|---|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.scenario.n} | ${escapeCell(r.scenario.title)} | ${escapeCell(r.scenario.expected)} | ${escapeCell(r.actual)} | ${
          r.pass === null ? (r.scenario.manualResult ?? "Manual") : r.pass ? "Pass" : "Fail"
        } | ${r.runs ? `${r.passed}/${r.runs}` : "—"} | ${escapeCell(r.notes)} |`
    ),
    "",
    ...DEPARTURES_NOTE,
  ];
  writeFileSync(join(__dirname, "..", "docs", "testing-evidence.md"), lines.join("\n"));
}

async function main(): Promise<void> {
  const health = await fetch(`${BASE_URL}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`Agent backend not reachable at ${BASE_URL} — start it (npm run dev -w apps/agent) or pass --url.`);
    process.exit(1);
  }
  MODEL = health.headers.get("x-agent-model") ?? "unknown (backend predates model reporting)";
  console.log(`Model: ${MODEL}`);

  console.log(`Run ${RUN_ID} against ${BASE_URL}, ${RUNS} attempt(s) per scenario${KEEP ? " (keeping created cases)" : ""}\n`);
  const results: Result[] = [];
  for (const s of SCENARIOS.filter((x) => !ONLY || ONLY.includes(x.n))) {
    process.stdout.write(`Scenario ${s.n}: ${s.title} … `);
    const result = await runScenario(s);
    results.push(result);
    console.log(result.pass === null ? "MANUAL" : `${result.pass ? "PASS" : "FAIL"} (${result.passed}/${result.runs})`);
    if (result.pass === false) console.log(`   ${result.notes}`);

    const { error } = await supabase.from("evaluations").insert({
      run_id: `${RUN_ID} (${MODEL})`,
      scenario: `${s.n}. ${s.title}`,
      expected_behavior: s.expected,
      actual_behavior: result.actual,
      pass: result.pass,
      notes: result.runs ? `${result.passed}/${result.runs} runs passed. ${result.notes}` : result.notes,
    });
    if (error) console.error(`   (could not write evaluations row: ${error.message})`);
  }

  if (!ONLY) writeEvidence(results);
  const failed = results.filter((r) => r.pass === false).length;
  console.log(`\n${results.filter((r) => r.pass).length} passed, ${failed} failed${ONLY ? "" : " — wrote docs/testing-evidence.md"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
