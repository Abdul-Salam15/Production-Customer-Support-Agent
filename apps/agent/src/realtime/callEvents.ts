import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { setReviewEnabled, submitReview, markTyped } from "../vapi/review.js";

// Per-call SSE stream the frontend subscribes to (Phase 4.7), wired into
// window.RelayCall in Stage 8. activity's key is one of app.js's existing
// ACTIVITIES keys (help/account/transactions/payouts/ticket/callback) —
// setActivity() only recognizes that fixed vocabulary, not free text.
export type CallEvent =
  | { type: "activity"; key: string }
  | { type: "outcome"; card: OutcomeCard }
  | { type: "contact_form_requested" }
  // The agent said goodbye; the browser hangs up once it finishes speaking.
  | { type: "end_call" }
  | { type: "contact_details_received"; note: string }
  // Review before sending (vapi/review.ts): show the caller's words for
  // editing, then close the box once the agent has the approved text.
  | { type: "review_requested"; reviewId: string; text: string; timeoutMs: number }
  | { type: "review_sent"; reviewId: string; text: string };

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

// The page's "Review before sending" switch, and the text the caller sends
// from the review box. Keyed by Vapi call id, like the contact form route.
export function registerReviewRoutes(router: Router): void {
  router.post("/api/calls/:callId/review-mode", (req: Request, res: Response) => {
    const enabled = (req.body as { enabled?: unknown })?.enabled;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be true or false" });
      return;
    }
    setReviewEnabled(req.params.callId, enabled);
    res.status(200).json({ enabled });
  });

  router.post("/api/calls/:callId/review/:reviewId", (req: Request, res: Response) => {
    const text = (req.body as { text?: unknown })?.text;
    if (typeof text !== "string" || text.length > 1000) {
      res.status(400).json({ error: "text must be a string of at most 1000 characters" });
      return;
    }
    const accepted = submitReview(req.params.callId, req.params.reviewId, text);
    // 409: that review already went ahead (timed out, or the caller spoke again).
    res.status(accepted ? 200 : 409).json({ accepted });
  });
}

// The page registers a typed message here just before sending it to Vapi,
// so it isn't held for review (vapi/review.ts).
export function registerTypedMessageRoute(router: Router): void {
  router.post("/api/calls/:callId/typed", (req: Request, res: Response) => {
    const text = (req.body as { text?: unknown })?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 500) {
      res.status(400).json({ error: "text must be 1 to 500 characters" });
      return;
    }
    markTyped(req.params.callId, text);
    res.status(200).json({ ok: true });
  });
}

export function createCallEventsRouter(): Router {
  const router = createRouter();
  registerCallEventsRoute(router);
  registerReviewRoutes(router);
  registerTypedMessageRoute(router);
  return router;
}
