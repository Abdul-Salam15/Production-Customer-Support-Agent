import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { getSupabaseClient } from "../supabaseClient.js";
import { publishCallEvent } from "../realtime/callEvents.js";
import { queueCallNote } from "../session/agentSession.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

interface ContactSubmissionBody {
  name?: unknown;
  email?: unknown;
  // Verified caller keeping their on-file email: the browser only has it
  // masked, so the server resolves the real address from the account.
  useAccountEmail?: unknown;
  callbackTime?: unknown;
}

async function handleContactSubmission(req: Request, res: Response): Promise<void> {
    const { callId } = req.params;
    const body = req.body as ContactSubmissionBody;

    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const useAccountEmail = body.useAccountEmail === true;
    if (!useAccountEmail && (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim()))) {
      res.status(400).json({ error: "a valid email is required" });
      return;
    }
    if (body.callbackTime !== undefined && typeof body.callbackTime !== "string") {
      res.status(400).json({ error: "callbackTime must be a string" });
      return;
    }

    const name = body.name.trim();
    const callbackTime = typeof body.callbackTime === "string" ? body.callbackTime.trim() || null : null;

    const supabase = getSupabaseClient();
    const { data: conversation } = await supabase
      .from("conversations")
      .select("conversation_id, customer_id")
      .eq("vapi_call_id", callId)
      .maybeSingle();

    if (!conversation) {
      res.status(404).json({ error: "no conversation found for this call" });
      return;
    }

    let email: string;
    if (useAccountEmail) {
      const { data: customer } = conversation.customer_id
        ? await supabase.from("customers").select("contact_email").eq("customer_id", conversation.customer_id).maybeSingle()
        : { data: null };
      if (!customer?.contact_email) {
        res.status(400).json({ error: "this call has no verified account email" });
        return;
      }
      email = customer.contact_email;
    } else {
      email = (body.email as string).trim();
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

    // The model only ever sees the caller's utterances, so without this it
    // never learns the form was submitted and never calls create_escalation
    // — the case silently never reaches the support queue. Delivered with
    // the next turn (which the frontend triggers right after this returns).
    queueCallNote(
      callId,
      `[System note — not spoken by the caller: the caller just submitted the on-screen contact form. ` +
        `Name: ${name}. Email: ${email}.${callbackTime ? ` Preferred callback time: ${callbackTime}.` : ""} ` +
        `These details are stored server-side and are authoritative. If no escalation has been created on this call yet, ` +
        `call create_escalation now with these details, the matching category, and a short reason from the conversation ` +
        `so far, then briefly confirm a specialist will follow up. Do not read the email address aloud. ` +
        `If the caller's message below asks something else, answer it too.]`
    );

    // Prepares the note for Stage 8's frontend to relay into the live Vapi
    // session via the Web SDK's add-message call — a browser-side API this
    // backend cannot invoke itself.
    publishCallEvent(callId, {
      type: "contact_details_received",
      note: `Contact details received: ${maskEmail(email)}`,
    });

    res.status(200).json({ stored: true });
}

export function registerContactRoutes(router: Router): void {
  router.post("/api/calls/:callId/contact", async (req: Request, res: Response) => {
    try {
      await handleContactSubmission(req, res);
    } catch (error) {
      // Never let one bad request crash the process — see the same fix in
      // vapi/customLlm.ts for why this matters.
      console.error("contactRoutes: unhandled error", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });
}

export function createContactRouter(): Router {
  const router = createRouter();
  registerContactRoutes(router);
  return router;
}
