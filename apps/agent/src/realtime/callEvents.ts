import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";

// Per-call SSE stream the frontend subscribes to (Phase 4.7). Wiring this
// into window.RelayCall is Stage 8's job — this stage only has to prove the
// stream carries the right events.
export type CallEvent =
  | { type: "activity"; text: string }
  | { type: "outcome"; card: OutcomeCard }
  | { type: "contact_form_requested" }
  | { type: "contact_details_received"; note: string };

export interface OutcomeCard {
  kind: "account_verified" | "ticket_created" | "escalation_created" | "transaction_status" | "payout_status";
  data: Record<string, unknown>;
}

const subscribers = new Map<string, Set<Response>>();

export function publishCallEvent(callId: string, event: CallEvent): void {
  const subs = subscribers.get(callId);
  if (!subs || subs.size === 0) return;

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subs) {
    res.write(payload);
  }
}

export function registerCallEventsRoute(router: Router): void {
  router.get("/api/calls/:callId/events", (req: Request, res: Response) => {
    const { callId } = req.params;

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    if (!subscribers.has(callId)) {
      subscribers.set(callId, new Set());
    }
    subscribers.get(callId)!.add(res);

    req.on("close", () => {
      subscribers.get(callId)?.delete(res);
    });
  });
}

export function createCallEventsRouter(): Router {
  const router = createRouter();
  registerCallEventsRoute(router);
  return router;
}
