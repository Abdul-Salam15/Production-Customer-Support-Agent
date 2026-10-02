import { getSupabaseClient } from "./supabaseClient.js";

// Last line of defense before any text reaches Vapi (Phase 4.6). Checked
// against a rolling window of the most recent output rather than the whole
// buffered response, so the common (safe) case still streams incrementally;
// the window just needs to be longer than any pattern we're watching for.
// Sized per call from what this guard actually watches, not a fixed 200 —
// a fixed 200 (flushed only past 400) meant a typical sub-400-char spoken
// reply reached Vapi in one lump only after the model had fully finished.
const EMAIL_HOLD_BACK = 64;
const AMOUNT_HOLD_BACK = 32;
const HOLD_BACK_MARGIN = 8;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Covers the corridors RelayPay serves (Africa, Europe, North America) by
// symbol, ISO code before or after the number, and spoken name — not just
// USD/EUR/GBP, which let "850,000 NGN" or "fifty thousand shillings" through.
const CURRENCY_CODES =
  "usd|eur|gbp|cad|ngn|kes|ghs|zar|ugx|tzs|rwf|etb|egp|xof|xaf|zmw|mwk|bwp|aud|chf|inr|cny|jpy";
const CURRENCY_WORDS =
  "dollars?|pounds?|euros?|naira|shillings?|cedis?|rand|francs?|birr|dirhams?|kwacha|pula|rupees?|yen|yuan|cfa";
const NUMBER = String.raw`\d[\d,]*(?:\.\d{1,2})?`;
const NUMBER_WORDS = String.raw`(?:\b(?:hundred|thousand|million|billion)\b)`;
const AMOUNT_RE = new RegExp(
  [
    String.raw`[$€£₦₵]\s?${NUMBER}`,
    String.raw`\b(?:${CURRENCY_CODES}|ksh)\s?${NUMBER}`,
    String.raw`\b${NUMBER}\s?(?:${CURRENCY_CODES}|${CURRENCY_WORDS})\b`,
    String.raw`${NUMBER_WORDS}\s+(?:${CURRENCY_CODES}|${CURRENCY_WORDS})\b`,
  ].join("|"),
  "gi"
);

const FALLBACK_LINE =
  "I'm not able to share that over the phone right now, but I can connect you with a specialist who can help.";

export interface GuardContext {
  verifiedAccountEmail: string | null;
  customerUtterance: string;
  internalPhrases: string[];
  isVerified: boolean;
}

export type BlockReason = "email" | "amount" | "internal_phrase";

// `final` is false while the model is still streaming: an email that runs
// right up to the end of the buffer may still be growing ("...@lagosledger.ex"
// before ".ample" arrives), and judging that partial against the caller's own
// address false-positives. It stays held back and is judged once complete,
// or at the final flush.
function detectViolation(buffer: string, ctx: GuardContext, final: boolean): BlockReason | null {
  for (const match of buffer.matchAll(EMAIL_RE)) {
    const email = match[0];
    const stillGrowing = !final && (match.index ?? 0) + email.length === buffer.length;
    if (stillGrowing) continue;
    const normalized = email.toLowerCase();
    const isOwnAccount = ctx.verifiedAccountEmail?.toLowerCase() === normalized;
    const callerSaidItThemselves = ctx.customerUtterance.toLowerCase().includes(normalized);
    if (!isOwnAccount && !callerSaidItThemselves) return "email";
  }

  if (!ctx.isVerified && buffer.match(AMOUNT_RE)) {
    return "amount";
  }

  for (const phrase of ctx.internalPhrases) {
    if (phrase.length > 0 && buffer.toLowerCase().includes(phrase.toLowerCase())) {
      return "internal_phrase";
    }
  }

  return null;
}

// Splits support_notes into sentence-length phrases worth blocking verbatim;
// short fragments are skipped to avoid false-positiving on common words.
// Trailing punctuation is stripped: a model reproducing the sentence mid-
// reply naturally drops the period ("...compliance review, so...") rather
// than reproducing it exactly, and the match must survive that.
export function extractInternalPhrases(supportNotes: string | null | undefined): string[] {
  if (!supportNotes) return [];
  return supportNotes
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim().replace(/[.!?]+$/, ""))
    .filter((sentence) => sentence.length >= 15);
}

export class OutputGuard {
  private buffer = "";
  private tripped = false;
  private fallbackSent = false;
  private blockReason: BlockReason | null = null;
  // A watched pattern can only be missed if part of it was flushed before
  // the rest arrived, so the held-back tail must be at least as long as the
  // longest pattern this call could produce.
  private holdBack: number;

  constructor(private readonly ctx: GuardContext) {
    this.holdBack = OutputGuard.holdBackFor(ctx);
  }

  private static holdBackFor(ctx: GuardContext): number {
    const longestPhrase = Math.max(0, ...ctx.internalPhrases.map((phrase) => phrase.length));
    return Math.max(EMAIL_HOLD_BACK, AMOUNT_HOLD_BACK, longestPhrase) + HOLD_BACK_MARGIN;
  }

  // A caller can be verified partway through a turn ("I'm Amina from
  // CapeCloud, amina@…, about TXN-9004" → lookup_customer, then
  // lookup_transaction, in one reply). The context was built before that, so
  // without this the rest of the turn was judged as unverified: the reply
  // tripped the guard and the caller heard nothing, not even the ticket
  // reference. Text already released was checked under the stricter rules.
  markVerified(internalPhrases: string[]): void {
    this.ctx.isVerified = true;
    this.ctx.internalPhrases = [...this.ctx.internalPhrases, ...internalPhrases];
    this.holdBack = OutputGuard.holdBackFor(this.ctx);
  }

  push(deltaText: string): string {
    if (this.tripped) {
      return this.maybeSendFallback();
    }

    this.buffer += deltaText;

    const violation = detectViolation(this.buffer, this.ctx, false);
    if (violation) {
      this.tripped = true;
      this.blockReason = violation;
      this.buffer = "";
      return this.maybeSendFallback();
    }

    if (this.buffer.length > this.holdBack) {
      // Release up to a word boundary only: if a later chunk trips the guard,
      // the fallback line follows a whole word instead of "...check thI'm not".
      const lastSpace = this.buffer.lastIndexOf(" ", this.buffer.length - this.holdBack - 1);
      if (lastSpace < 0) return "";
      const flushLength = lastSpace + 1;
      const toFlush = this.buffer.slice(0, flushLength);
      this.buffer = this.buffer.slice(flushLength);
      return toFlush;
    }

    return "";
  }

  flushRemaining(): string {
    if (this.tripped) {
      return this.maybeSendFallback();
    }
    const violation = detectViolation(this.buffer, this.ctx, true);
    if (violation) {
      this.tripped = true;
      this.blockReason = violation;
      this.buffer = "";
      return this.maybeSendFallback();
    }
    const remaining = this.buffer;
    this.buffer = "";
    return remaining;
  }

  private maybeSendFallback(): string {
    if (this.fallbackSent) return "";
    this.fallbackSent = true;
    return FALLBACK_LINE;
  }

  wasTripped(): boolean {
    return this.tripped;
  }

  getBlockReason(): BlockReason | null {
    return this.blockReason;
  }
}

export async function logGuardBlock(
  conversationId: string,
  reason: BlockReason,
  originalText: string
): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    await supabase.from("conversation_events").insert({
      conversation_id: conversationId,
      event_type: "output_guard_blocked",
      summary: `Response blocked by output guard (${reason})`,
      metadata: { reason, original_length: originalText.length },
    });
  } catch (error) {
    console.error("outputGuard: failed to log block event", error);
  }
}
