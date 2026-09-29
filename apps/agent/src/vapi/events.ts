import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { getEnv } from "../env.js";
import { getSupabaseClient } from "../supabaseClient.js";

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

export function registerVapiEventsRoute(router: Router): void {
  router.post("/vapi/events", verifySecret, async (req: Request, res: Response) => {
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

    res.status(200).json({ received: true });
  });
}

export function createVapiEventsRouter(): Router {
  const router = createRouter();
  registerVapiEventsRoute(router);
  return router;
}
