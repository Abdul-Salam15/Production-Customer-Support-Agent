import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { getEnv } from "../env.js";
import { logAudit } from "../auditLog.js";
import { warmCallAgent, closeCallAgent } from "../session/agentSession.js";
import { finalizeCall } from "../session/finalizeCall.js";
import { clearReview } from "./review.js";

// Vapi's documented webhook contract: every server message arrives wrapped
// as { message: { type, call: { id }, endedReason, ... } }. Verify against
// Vapi's current docs when wiring the real assistant (Stage 9) — this is
// our best-documented understanding at build time.
interface VapiEndOfCallReport {
  message?: {
    type?: string;
    call?: { id?: string };
    endedReason?: string;
    // status-update messages only: "queued" | "ringing" | "in-progress" | "ended" | ...
    status?: string;
  };
}

// Vapi authenticates server messages one of two ways depending on how the
// assistant's server URL was set up: the legacy "secret" field sends
// x-vapi-secret, while a Bearer Token credential sends Authorization:
// Bearer <token>. Checking only the first rejected every webhook from a
// credential-based setup — end-of-call-report included, which is why calls
// never got ended_at and the summary email never went out.
// Trimmed on both sides: a secret pasted into Render or Vapi's dashboard
// easily picks up a trailing space or newline, and the exact-match check
// then rejected every webhook with no visible difference between values.
function hasValidSecret(req: Request, rawExpected: string): boolean {
  const expected = rawExpected.trim();
  if (!expected) return false;
  const secret = req.headers["x-vapi-secret"];
  if (typeof secret === "string" && secret.trim() === expected) return true;
  const auth = req.headers["authorization"];
  if (typeof auth !== "string") return false;
  const token = auth.trim().replace(/^Bearer\s+/i, "");
  return token === expected;
}

// A rejected webhook is otherwise invisible without Render log access, but
// Vapi sends many messages per call, so log at most one rejection per window.
const REJECTION_LOG_INTERVAL_MS = 10 * 60 * 1000;
let lastRejectionLoggedAt = 0;

function verifySecret(req: Request, res: Response, next: () => void): void {
  if (!hasValidSecret(req, getEnv().VAPI_SERVER_SECRET)) {
    const now = Date.now();
    if (now - lastRejectionLoggedAt > REJECTION_LOG_INTERVAL_MS) {
      lastRejectionLoggedAt = now;
      const type = (req.body as VapiEndOfCallReport)?.message?.type ?? "unknown";
      const authHeaders = ["x-vapi-secret", "authorization", "x-vapi-signature"].filter((h) => h in req.headers);
      void logAudit(
        "call",
        `Rejected a Vapi webhook (${type}): secret didn't match VAPI_SERVER_SECRET. ` +
          `Auth headers sent: ${authHeaders.join(", ") || "none"}.`
      );
    }
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

async function handleEndOfCallReport(req: Request, res: Response): Promise<void> {
    const body = req.body as VapiEndOfCallReport;

    if (body.message?.type === "status-update") {
      // The call is live: start the Agent SDK session now, while Vapi plays
      // the greeting, so the caller's first sentence doesn't pay for it.
      const statusCallId = body.message.call?.id;
      if (statusCallId && body.message.status === "in-progress") warmCallAgent(statusCallId);
      if (statusCallId && body.message.status === "ended") {
        closeCallAgent(statusCallId);
        clearReview(statusCallId);
        finalizeCall(statusCallId, null).catch((error) => {
          console.error("vapi/events: finalize on status-update ended failed", error);
        });
      }
      res.status(200).json({ received: true });
      return;
    }

    if (body.message?.type !== "end-of-call-report") {
      // Acknowledge and ignore the other Vapi server-message types.
      res.status(200).json({ received: true });
      return;
    }

    const callId = body.message.call?.id;
    if (!callId) {
      res.status(400).json({ error: "call.id is required" });
      return;
    }
    closeCallAgent(callId);
    clearReview(callId);

    const result = await finalizeCall(callId, body.message.endedReason ?? null);
    if (result === "not_found") {
      res.status(404).json({ error: "no conversation found for this call" });
      return;
    }

    res.status(200).json({ received: true });
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
