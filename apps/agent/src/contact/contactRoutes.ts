import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { getSupabaseClient } from "../supabaseClient.js";
import { publishCallEvent } from "../realtime/callEvents.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

interface ContactSubmissionBody {
  name?: unknown;
  email?: unknown;
  callbackTime?: unknown;
}

export function registerContactRoutes(router: Router): void {
  router.post("/api/calls/:callId/contact", async (req: Request, res: Response) => {
    const { callId } = req.params;
    const body = req.body as ContactSubmissionBody;

    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim())) {
      res.status(400).json({ error: "a valid email is required" });
      return;
    }
    if (body.callbackTime !== undefined && typeof body.callbackTime !== "string") {
      res.status(400).json({ error: "callbackTime must be a string" });
      return;
    }

    const name = body.name.trim();
    const email = body.email.trim();
    const callbackTime = typeof body.callbackTime === "string" ? body.callbackTime.trim() || null : null;

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

    const { error } = await supabase.from("contact_submissions").upsert({
      conversation_id: conversation.conversation_id,
      name,
      email,
      callback_time: callbackTime,
    });

    if (error) {
      res.status(500).json({ error: "failed to store contact details" });
      return;
    }

    // Prepares the note for Stage 8's frontend to relay into the live Vapi
    // session via the Web SDK's add-message call — a browser-side API this
    // backend cannot invoke itself.
    publishCallEvent(callId, {
      type: "contact_details_received",
      note: `Contact details received: ${maskEmail(email)}`,
    });

    res.status(200).json({ stored: true });
  });
}

export function createContactRouter(): Router {
  const router = createRouter();
  registerContactRoutes(router);
  return router;
}
