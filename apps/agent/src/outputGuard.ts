import { getSupabaseClient } from "./supabaseClient.js";

// Last line of defense before any text reaches Vapi (Phase 4.6). Checked
// against a rolling window of the most recent output rather than the whole
// buffered response, so the common (safe) case still streams incrementally;
// the window just needs to be longer than any pattern we're watching for.
const HOLD_BACK_CHARS = 200;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const AMOUNT_RE = /\$\s?\d[\d,]*(\.\d{1,2})?|\b\d[\d,]*(\.\d{1,2})?\s?(usd|eur|gbp|dollars?|pounds?|euros?)\b/gi;

const FALLBACK_LINE =
  "I'm not able to share that over the phone right now, but I can connect you with a specialist who can help.";

export interface GuardContext {
  verifiedAccountEmail: string | null;
  customerUtterance: string;
  internalPhrases: string[];
  isVerified: boolean;
}

export type BlockReason = "email" | "amount" | "internal_phrase";

function detectViolation(buffer: string, ctx: GuardContext): BlockReason | null {
  const emails = buffer.match(EMAIL_RE) ?? [];
  for (const email of emails) {
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

  constructor(private readonly ctx: GuardContext) {}

  push(deltaText: string): string {
    if (this.tripped) {
      return this.maybeSendFallback();
    }

    this.buffer += deltaText;

    const violation = detectViolation(this.buffer, this.ctx);
    if (violation) {
      this.tripped = true;
      this.blockReason = violation;
      this.buffer = "";
      return this.maybeSendFallback();
    }

    if (this.buffer.length > HOLD_BACK_CHARS * 2) {
      const flushLength = this.buffer.length - HOLD_BACK_CHARS;
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
