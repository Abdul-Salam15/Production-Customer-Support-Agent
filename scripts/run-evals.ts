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

const RUN_ID = `eval-${new Date().toISOString().replace(/[:.]/g, "-")}`;

// ---------- Talking to the backend ----------

interface Message {
  role: "user" | "assistant";
  content: string;
}

class EvalCall {
  readonly callId: string;
  readonly history: Message[] = [];
  readonly replies: string[] = [];

  constructor(scenario: number) {
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
    if (!res.ok || !res.body) throw new Error(`chat/completions returned ${res.status}: ${await res.text()}`);

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
    if (!res.ok) throw new Error(`contact submission returned ${res.status}: ${await res.text()}`);
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
    return { conversationId, tools: [], toolNames: [], tickets: [], escalations: [], answerTypes: [] };
  }

  const [{ data: tools }, { data: tickets }, { data: escalations }, { data: turns }] = await Promise.all([
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
  ]);

  const toolRows = (tools ?? []) as ToolCallRow[];
  return {
    conversationId,
    tools: toolRows,
    toolNames: toolRows.map((t) => t.tool_name),
    tickets: tickets ?? [],
    escalations: escalations ?? [],
    answerTypes: ((turns ?? []) as { answer_type: string | null }[]).map((t) => t.answer_type),
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
      const second = await call.say("Sure, it's amara@lagosledger.example.");
      const o = await observe(call);
      const lookup = o.tools.find((t) => t.tool_name === "lookup_customer");
      c.add("lookup_customer verified the caller", !!lookup?.result_summary?.includes('"found":true'));
      c.replyAvoids("no internal fields read out", second, /kyc|support notes|normal support access/i);
      c.noToolErrors(o);
    },
  },
  {
    n: 4,
    title: "Transaction lookup (unverified, reference only)",
    expected:
      "Looks up TXN-9001; gives the status summary only (no amount or recipient, caller unverified); no promised arrival time beyond the record.",
    run: async (call, c) => {
      const reply = await call.say("Can you check transaction TXN-9001?");
      const o = await observe(call);
      c.called(o, "lookup_transaction");
      c.replyMatches("gives a status", reply, /process|status|transit|delay/i);
      c.replyAvoids("no amount for an unverified caller", reply, /2,?400|two thousand|usd|dollars/i);
      c.replyAvoids("no promised arrival", reply, /(will|guarantee).{0,20}(arrive|land) (by|on|tomorrow|today)/i);
      c.notCalled(o, "create_escalation");
      c.noToolErrors(o);
    },
  },
  {
    n: 5,
    title: "Payout lookup → escalation",
    expected:
      "Looks up PAY-7002, identifies it needs review, offers a callback; on yes shows the form, then creates an escalation once the form is submitted.",
    run: async (call, c) => {
      const first = await call.say("What is happening with payout PAY-7002?");
      let o = await observe(call);
      c.called(o, "lookup_payout");
      c.replyMatches("identifies the review", first, /review/i);
      await call.say("Yes, please get a specialist to call me back.");
      o = await observe(call);
      c.called(o, "request_contact_details");
      await call.submitContactForm("Efua Mensah", "efua@accrastack.example", CALLBACK);
      const confirm = await call.say("I've sent my callback details using the on-screen form.");
      o = await observe(call);
      c.add("escalation record created", o.escalations.length === 1);
      c.replyMatches("reads back a reference", confirm, /R-P|RP/i);
      c.called(o, "log_conversation_event");
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
      c.called(o, "log_conversation_event");
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
      c.called(o, "request_contact_details");
      await call.submitContactForm("Daniel Mwangi", "daniel@nairobiops.example", CALLBACK);
      await call.say("I've sent my callback details using the on-screen form.");
      o = await observe(call);
      c.add("escalation record created", o.escalations.length === 1);
      c.add("escalation is high priority", o.escalations[0]?.priority === "high");
      c.called(o, "log_conversation_event");
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
      c.noToolErrors(o);
    },
  },
  {
    n: 9,
    title: "Voice flow",
    expected: "Vapi captures speech, the backend responds, Vapi speaks the reply, Supabase logs the conversation and tool calls.",
    manualNote: "Not covered by text mode — verify with one real voice call (see docs/testing-evidence.md).",
  },
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

interface Result {
  scenario: Scenario;
  pass: boolean | null;
  actual: string;
  notes: string;
}

async function runScenario(s: Scenario): Promise<Result> {
  if (!s.run) return { scenario: s, pass: null, actual: "Manual check", notes: s.manualNote ?? "" };

  const call = new EvalCall(s.n);
  const checks = new Checks();
  let error: string | null = null;
  try {
    await s.run(call, checks);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const o = await observe(call);
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
    `Last reply: "${(call.replies.at(-1) ?? "").replace(/\s+/g, " ").trim().slice(0, 220)}"`,
  ]
    .filter(Boolean)
    .join(" ");
  const notes = error ? `Error: ${error}` : failed.length ? `Failed: ${failed.join("; ")}` : `All ${checks.list.length} checks passed`;
  return { scenario: s, pass: error ? false : checks.passed, actual, notes };
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
    `Run \`${RUN_ID}\` against \`${BASE_URL}\` — ${passed}/${automated} automated scenarios passed.`,
    "Generated by `scripts/run-evals.ts` (text mode through the real backend, MCP tools, and Supabase); the same rows are in the `evaluations` table under this run_id.",
    "",
    "| # | Scenario | Expected behavior | Actual behavior | Result | Notes |",
    "|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.scenario.n} | ${escapeCell(r.scenario.title)} | ${escapeCell(r.scenario.expected)} | ${escapeCell(r.actual)} | ${
          r.pass === null ? "Manual" : r.pass ? "Pass" : "Fail"
        } | ${escapeCell(r.notes)} |`
    ),
    "",
  ];
  writeFileSync(join(__dirname, "..", "docs", "testing-evidence.md"), lines.join("\n"));
}

async function main(): Promise<void> {
  const health = await fetch(`${BASE_URL}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`Agent backend not reachable at ${BASE_URL} — start it (npm run dev -w apps/agent) or pass --url.`);
    process.exit(1);
  }

  console.log(`Run ${RUN_ID} against ${BASE_URL}${KEEP ? " (keeping created cases)" : ""}\n`);
  const results: Result[] = [];
  for (const s of SCENARIOS.filter((x) => !ONLY || ONLY.includes(x.n))) {
    process.stdout.write(`Scenario ${s.n}: ${s.title} … `);
    const result = await runScenario(s);
    results.push(result);
    console.log(result.pass === null ? "MANUAL" : result.pass ? "PASS" : "FAIL");
    if (result.pass === false) console.log(`   ${result.notes}`);

    const { error } = await supabase.from("evaluations").insert({
      run_id: RUN_ID,
      scenario: `${s.n}. ${s.title}`,
      expected_behavior: s.expected,
      actual_behavior: result.actual,
      pass: result.pass,
      notes: result.notes,
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
