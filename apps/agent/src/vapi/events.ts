import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { getEnv } from "../env.js";
import { getSupabaseClient } from "../supabaseClient.js";
import { sendEmail } from "../mailer.js";
import { logAudit } from "../auditLog.js";

// Vapi's documented webhook contract: every server message arrives wrapped
// as { message: { type, call: { id }, endedReason, ... } }. Verify against
// Vapi's current docs when wiring the real assistant (Stage 9) — this is
// our best-documented understanding at build time.
interface VapiEndOfCallReport {
  message?: {
    type?: string;
    call?: { id?: string };
    endedReason?: string;
  };
}

function verifySecret(req: Request, res: Response, next: () => void): void {
  const expected = getEnv().VAPI_SERVER_SECRET;
  const provided = req.headers["x-vapi-secret"];
  if (provided !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

type FinalStatus = "resolved" | "ticket_created" | "escalated" | "abandoned";

async function deriveFinalStatus(conversationId: string): Promise<{ status: FinalStatus; summary: string }> {
  const supabase = getSupabaseClient();

  const { data: escalation } = await supabase
    .from("escalations")
    .select("escalation_id, category")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (escalation) {
    return {
      status: "escalated",
      summary: `Escalated to a specialist (${escalation.category}, ${escalation.escalation_id}).`,
    };
  }

  const { data: ticket } = await supabase
    .from("support_tickets")
    .select("ticket_id, category")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (ticket) {
    return {
      status: "ticket_created",
      summary: `Support ticket ${ticket.ticket_id} created (${ticket.category}).`,
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
    return { status: "resolved", summary: "Resolved directly by the agent." };
  }

  return { status: "abandoned", summary: "Call ended without a resolution." };
}

async function handleEndOfCallReport(req: Request, res: Response): Promise<void> {
    const body = req.body as VapiEndOfCallReport;

    if (body.message?.type !== "end-of-call-report") {
      // Not the report we finalize on; acknowledge and ignore other Vapi
      // server-message types (this stage only handles the end-of-call one).
      res.status(200).json({ received: true });
      return;
    }

    const callId = body.message.call?.id;
    if (!callId) {
      res.status(400).json({ error: "call.id is required" });
      return;
    }

    const supabase = getSupabaseClient();
    const { data: conversation } = await supabase
      .from("conversations")
      .select("conversation_id")
      .eq("vapi_call_id", callId)
      .maybeSingle();

    if (!conversation) {
      res.status(404).json({ error: "no conversation found for this call" });
      return;
    }

    const { status, summary } = await deriveFinalStatus(conversation.conversation_id);

    const { error } = await supabase
      .from("conversations")
      .update({
        ended_at: new Date().toISOString(),
        ended_reason: body.message.endedReason ?? null,
        final_status: status,
        summary,
      })
      .eq("conversation_id", conversation.conversation_id);

    if (error) {
      console.error("vapi/events: failed to finalize conversation", error.message);
      res.status(500).json({ error: "failed to finalize conversation" });
      return;
    }

    void logAudit("call", `Call ended — ${summary}`);

    // Best-effort: the conversation is already finalized above, so a Gmail
    // hiccup here must not turn into a 500 for Vapi's webhook retry logic.
    try {
      await sendCallSummaryEmail(conversation.conversation_id, callId, status, summary);
    } catch (emailError) {
      console.error("vapi/events: failed to send call summary email", emailError);
    }

    res.status(200).json({ received: true });
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

async function sendCallSummaryEmail(
  conversationId: string,
  callId: string,
  status: FinalStatus,
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

  const submission = contactSubmission as ContactSubmissionRow | null;
  let customerEmail = submission?.email ?? null;
  if (!customerEmail && conversation?.customer_id) {
    const { data: customer } = await supabase
      .from("customers")
      .select("contact_email")
      .eq("customer_id", conversation.customer_id)
      .maybeSingle();
    customerEmail = customer?.contact_email ?? null;
  }

  const transcriptText =
    ((turns as ConversationTurnRow[] | null) ?? [])
      .map((turn) => `[${turn.role}] ${turn.transcript}`)
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

  const text = [
    `Call ${callId} ended.`,
    `Status: ${status}`,
    `Summary: ${summary}`,
    ...formLines,
    ``,
    `Transcript:`,
    transcriptText,
  ].join("\n");

  const sends: Promise<void>[] = [
    sendEmail({ to: env.SUPPORT_TEAM_EMAIL, subject: `Call summary — ${callId} (${status})`, text }),
  ];
  if (customerEmail) {
    sends.push(sendEmail({ to: customerEmail, subject: "Your RelayPay support call summary", text }));
  }

  const results = await Promise.allSettled(sends);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("vapi/events: call summary email failed", result.reason);
    }
  }
}

export function registerVapiEventsRoute(router: Router): void {
  router.post("/vapi/events", verifySecret, async (req: Request, res: Response) => {
    try {
      await handleEndOfCallReport(req, res);
    } catch (error) {
      // Never let one bad webhook delivery crash the process — see the same
      // fix in vapi/customLlm.ts for why this matters.
      console.error("vapi/events: unhandled error", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });
}

export function createVapiEventsRouter(): Router {
  const router = createRouter();
  registerVapiEventsRoute(router);
  return router;
}
