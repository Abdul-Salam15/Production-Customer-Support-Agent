// Finalizes a call's conversations row and sends the call-summary emails.
//
// Triggered by Vapi's end-of-call-report and "ended" status-update webhooks,
// with the idle-session reaper as a server-side backstop if neither arrives.
// Whichever runs first wins: the row is claimed with a conditional update on
// ended_at, so the summary email goes out exactly once.
import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "../env.js";
import { getSupabaseClient } from "../supabaseClient.js";
import { sendEmail } from "../mailer.js";
import { logAudit } from "../auditLog.js";

type FinalStatus = "resolved" | "ticket_created" | "escalated" | "abandoned";

interface FinalOutcome {
  status: FinalStatus;
  summary: string;
  escalation: { escalation_id: string; category: string; preferred_time: string | null } | null;
  ticket: { ticket_id: string; category: string } | null;
}

async function deriveFinalOutcome(conversationId: string): Promise<FinalOutcome> {
  const supabase = getSupabaseClient();

  const { data: escalation } = await supabase
    .from("escalations")
    .select("escalation_id, category, preferred_time")
    .eq("conversation_id", conversationId)
    .limit(1)
    .maybeSingle();

  if (escalation) {
    return {
      status: "escalated",
      summary: `Escalated to a specialist (${escalation.category}, ${escalation.escalation_id}).`,
      escalation,
      ticket: null,
    };
  }

  const { data: ticket } = await supabase
    .from("support_tickets")
    .select("ticket_id, category")
    .eq("conversation_id", conversationId)
    .limit(1)
    .maybeSingle();

  if (ticket) {
    return {
      status: "ticket_created",
      summary: `Support ticket ${ticket.ticket_id} created (${ticket.category}).`,
      escalation: null,
      ticket,
    };
  }

  const { data: answeredTurn } = await supabase
    .from("conversation_turns")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("role", "agent")
    .eq("answer_type", "answer")
    .limit(1)
    .maybeSingle();

  if (answeredTurn) {
    return { status: "resolved", summary: "Resolved directly by the agent.", escalation: null, ticket: null };
  }

  return { status: "abandoned", summary: "Call ended without a resolution.", escalation: null, ticket: null };
}

const SUMMARY_SYSTEM_PROMPT =
  "You write the summary line a RelayPay support specialist reads in the call log. Given a call transcript and " +
  "its recorded outcome, write one or two plain sentences: what the caller wanted, what was done (verification, " +
  "lookups, any ticket or escalation and its reference), and how the call ended. Use only what the transcript " +
  "shows. No preamble, no markdown.";

let anthropic: Anthropic | null = null;

// The PRD's conversation record has a summary; the outcome line alone
// ("Resolved directly by the agent.") says nothing about what was discussed.
// Best-effort: on any failure the caller keeps the outcome line.
async function summarizeCall(conversationId: string, outcome: FinalOutcome): Promise<string | null> {
  const { data: turns } = await getSupabaseClient()
    .from("conversation_turns")
    .select("role, transcript")
    .eq("conversation_id", conversationId)
    .order("turn_index", { ascending: true });
  if (!turns || turns.length === 0) return null;

  const transcript = (turns as { role: string; transcript: string }[])
    .map((turn) => `${turn.role === "agent" ? "Agent" : "Caller"}: ${turn.transcript}`)
    .join("\n");

  try {
    anthropic ??= new Anthropic({ apiKey: getEnv().ANTHROPIC_API_KEY, timeout: 15_000, maxRetries: 1 });
    const response = await anthropic.messages.create({
      model: getEnv().ANTHROPIC_MODEL,
      // Deliberately short: the output is one or two sentences.
      max_tokens: 300,
      thinking: { type: "disabled" },
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Recorded outcome: ${outcome.summary}\n\nTranscript:\n${transcript}` }],
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();
    return text || null;
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.error(`finalizeCall: summary request failed (${error.status})`, error.message);
    } else {
      console.error("finalizeCall: summary request failed", error);
    }
    return null;
  }
}

export type FinalizeResult = "finalized" | "already_finalized" | "not_found";

export async function finalizeCall(callId: string, endedReason: string | null): Promise<FinalizeResult> {
  const supabase = getSupabaseClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("conversation_id, ended_at")
    .eq("vapi_call_id", callId)
    .maybeSingle();

  if (!conversation) return "not_found";
  if (conversation.ended_at) return "already_finalized";

  const outcome = await deriveFinalOutcome(conversation.conversation_id);
  // For the log and staff; the customer's email keeps the plain outcome line.
  const summary = (await summarizeCall(conversation.conversation_id, outcome)) ?? outcome.summary;

  const { data: claimed, error } = await supabase
    .from("conversations")
    .update({
      ended_at: new Date().toISOString(),
      ended_reason: endedReason,
      final_status: outcome.status,
      summary,
    })
    .eq("conversation_id", conversation.conversation_id)
    .is("ended_at", null)
    .select("conversation_id");

  if (error) throw new Error(`failed to finalize conversation: ${error.message}`);
  if (!claimed || claimed.length === 0) return "already_finalized";

  void logAudit("call", `Call ended — ${summary}`);

  // Best-effort and NOT awaited: the conversation is already finalized
  // above, so neither an email-provider failure nor a slow connection
  // should delay the caller of this function (Vapi's webhook retry logic
  // in particular).
  sendCallSummaryEmail(conversation.conversation_id, callId, outcome, summary).catch((emailError) => {
    console.error("finalizeCall: failed to send call summary email", emailError);
  });

  return "finalized";
}

interface ConversationTurnRow {
  role: string;
  transcript: string;
  turn_index: number;
}

interface ContactSubmissionRow {
  name: string;
  email: string;
  callback_time: string | null;
}

function customerOutcomeLines(outcome: FinalOutcome, callbackTime: string | null): string[] {
  if (outcome.escalation) {
    const when = callbackTime ?? outcome.escalation.preferred_time;
    return [
      `A RelayPay specialist will follow up on your ${outcome.escalation.category} request.`,
      `Reference: ${outcome.escalation.escalation_id}`,
      ...(when ? [`Requested callback time: ${when}`] : []),
    ];
  }
  if (outcome.ticket) {
    return [`We opened support ticket ${outcome.ticket.ticket_id} (${outcome.ticket.category}) for you.`];
  }
  if (callbackTime) {
    return [`We received your callback request for ${callbackTime}. A specialist will be in touch.`];
  }
  return [outcome.summary];
}

async function sendCallSummaryEmail(
  conversationId: string,
  callId: string,
  outcome: FinalOutcome,
  summary: string
): Promise<void> {
  const supabase = getSupabaseClient();
  const env = getEnv();

  const [{ data: conversation }, { data: turns }, { data: contactSubmission }] = await Promise.all([
    supabase.from("conversations").select("customer_id").eq("conversation_id", conversationId).maybeSingle(),
    supabase
      .from("conversation_turns")
      .select("role, transcript, turn_index")
      .eq("conversation_id", conversationId)
      .order("turn_index", { ascending: true }),
    supabase
      .from("contact_submissions")
      .select("name, email, callback_time")
      .eq("conversation_id", conversationId)
      .maybeSingle(),
  ]);

  // An anonymous caller's only address is the one they typed into the
  // contact form; a logged-in/verified caller falls back to their account's
  // contact_email when they didn't submit the form.
  const submission = contactSubmission as ContactSubmissionRow | null;
  let customerEmail = submission?.email ?? null;
  let customerName = submission?.name ?? null;
  if (!customerEmail && conversation?.customer_id) {
    const { data: customer } = await supabase
      .from("customers")
      .select("contact_name, contact_email")
      .eq("customer_id", conversation.customer_id)
      .maybeSingle();
    customerEmail = customer?.contact_email ?? null;
    customerName = customer?.contact_name ?? null;
  }

  const transcriptText =
    ((turns as ConversationTurnRow[] | null) ?? [])
      .map((turn) => `${turn.role === "agent" ? "RelayPay" : "You"}: ${turn.transcript}`)
      .join("\n") || "(no transcript recorded)";

  const formLines = submission
    ? [
        ``,
        `Contact form submitted:`,
        `  Name: ${submission.name}`,
        `  Email: ${submission.email}`,
        submission.callback_time ? `  Callback time: ${submission.callback_time}` : null,
      ].filter((line): line is string => line !== null)
    : [];

  const internalText = [
    `Call ${callId} ended.`,
    `Status: ${outcome.status}`,
    `Summary: ${summary}`,
    ...formLines,
    ``,
    `Transcript:`,
    transcriptText,
  ].join("\n");

  const sends: Promise<void>[] = [
    sendEmail({ to: env.SUPPORT_TEAM_EMAIL, subject: `Call summary — ${callId} (${outcome.status})`, text: internalText }),
  ];

  if (customerEmail) {
    const customerText = [
      customerName ? `Hi ${customerName},` : `Hi,`,
      ``,
      `Thanks for calling RelayPay support. Here's a summary of your call.`,
      ``,
      ...customerOutcomeLines(outcome, submission?.callback_time ?? null),
      ``,
      `Transcript:`,
      transcriptText,
      ``,
      `— RelayPay Support`,
    ].join("\n");
    sends.push(sendEmail({ to: customerEmail, subject: "Your RelayPay support call summary", text: customerText }));
  }

  const results = await Promise.allSettled(sends);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("finalizeCall: call summary email failed", result.reason);
    }
  }
}
