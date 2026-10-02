// "Review before sending": when the caller turns it on, each thing they say
// is shown to them on screen, editable, before the agent replies. The
// Custom LLM turn waits here until they send it (with any edits) or the
// timeout passes, then the agent answers the text they approved.
//
// Vapi replies as soon as the caller stops talking, so the hold has to live
// in the turn itself. State is in memory, per call, like the agent session.
import { randomUUID } from "node:crypto";
import { publishCallEvent } from "../realtime/callEvents.js";

// Long enough to fix a misheard word or two; well under Vapi's silence
// timeout, which would otherwise end the call while the caller edits.
export const REVIEW_TIMEOUT_MS = 20_000;

interface PendingReview {
  id: string;
  text: string;
  resolve: (text: string) => void;
}

const enabledCalls = new Set<string>();
const pending = new Map<string, PendingReview>();
// Text from a review the caller talked over before sending: Vapi drops that
// turn and starts a new one, so it's carried into the next review instead of
// being lost.
const carried = new Map<string, string>();

// Messages the page itself sends to make the agent respond (the contact form
// was submitted, or the caller chose to speak their details). The caller
// never said these, so there's nothing to review.
const PAGE_PROMPTS = [
  "I've sent my callback details using the on-screen form.",
  "I'd rather say my contact details out loud instead of using the form.",
];

export function setReviewEnabled(callId: string, enabled: boolean): void {
  if (enabled) {
    enabledCalls.add(callId);
    return;
  }
  enabledCalls.delete(callId);
  carried.delete(callId);
  // Turning it off mid-review sends what's there.
  const review = pending.get(callId);
  if (review) review.resolve(review.text);
}

export function needsReview(callId: string, text: string): boolean {
  return enabledCalls.has(callId) && !PAGE_PROMPTS.includes(text.trim());
}

// Resolves with the text to answer: the caller's edit, or the original on
// timeout. Resolves null if `signal` aborts first (the caller spoke again),
// keeping the text so the next review starts from it.
export function awaitReview(callId: string, spoken: string, signal: AbortSignal): Promise<string | null> {
  const earlier = carried.get(callId);
  carried.delete(callId);
  const text = earlier ? `${earlier} ${spoken}` : spoken;
  const id = randomUUID();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pending.get(callId)?.id === id) pending.delete(callId);
      // Closes the review box on the page, whether the caller sent it, it
      // timed out, or review was switched off.
      if (result !== null) publishCallEvent(callId, { type: "review_sent", reviewId: id, text: result });
      resolve(result);
    };
    const timer = setTimeout(() => finish(text), REVIEW_TIMEOUT_MS);
    signal.addEventListener("abort", () => {
      // Only a review still waiting is carried over: once it was sent, a
      // later abort is the caller talking over the agent's reply.
      if (settled) return;
      carried.set(callId, text);
      finish(null);
    });
    pending.set(callId, { id, text, resolve: (approved) => finish(approved) });
    publishCallEvent(callId, { type: "review_requested", reviewId: id, text, timeoutMs: REVIEW_TIMEOUT_MS });
  });
}

// The page sent the reviewed text. False if that review is no longer waiting
// (it timed out, or the caller spoke again).
export function submitReview(callId: string, reviewId: string, text: string): boolean {
  const review = pending.get(callId);
  if (!review || review.id !== reviewId) return false;
  review.resolve(text.trim() || review.text);
  return true;
}

export function clearReview(callId: string): void {
  enabledCalls.delete(callId);
  carried.delete(callId);
  pending.delete(callId);
}
