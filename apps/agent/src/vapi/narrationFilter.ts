// Drops "I'm about to use a tool" narration from the start of a spoken text
// block: "Let me check that.", "Now I'll create the escalation:", "I need to
// search our documentation first." The prompt forbids it, but the model
// keeps writing a lead-in before a tool call, and Vapi speaks it.
//
// Only the first sentence of each block is inspected, and only dropped when
// it's clearly about the agent's own lookup/search/record-keeping — a real
// commitment to the caller ("I'll arrange a callback for you") passes
// through. Holding a block until its first sentence ends costs a fraction
// of a second, not the whole reply.
const NARRATION_RE =
  /^(?:(?:okay|ok|alright|great|got it|sure|perfect|thanks|thank you)[,.!]?\s+)?(?:now\s+)?(?:let me|i'll|i will|i'm going to|i am going to|i need to|allow me to|give me a moment(?: to)?|one moment(?: while)?(?: i)?)\s+(?:quickly\s+|just\s+|first\s+|go ahead and\s+)?(?:check|look|search|pull|find|verify|confirm (?:those|that|your details)|create (?:the|an|a|your|this) (?:escalation|ticket|case|record|support ticket)|log|record|see what|take a look|run|get that)\b[^.!?:]*[.!?:]+\s*$/i;

const MAX_HOLD = 200;

export class NarrationFilter {
  private pending = "";
  private decided = false;

  // Call at the start of every text block.
  reset(): void {
    this.pending = "";
    this.decided = false;
  }

  push(text: string): string {
    if (!text) return "";
    if (this.decided) return text;
    this.pending += text;
    // A sentence end is punctuation followed by whitespace — so "TXN-9001."
    // still streaming isn't judged before we know the sentence is over.
    const end = this.pending.search(/[.!?:]\s/);
    if (end >= 0) {
      this.decided = true;
      const firstSentence = this.pending.slice(0, end + 1);
      const rest = this.pending.slice(end + 1);
      this.pending = "";
      return NARRATION_RE.test(`${firstSentence} `) ? rest.replace(/^\s+/, "") : firstSentence + rest;
    }
    if (this.pending.length >= MAX_HOLD) {
      this.decided = true;
      const out = this.pending;
      this.pending = "";
      return out;
    }
    return "";
  }

  // Call when the block ends.
  flush(): string {
    if (this.decided) return "";
    this.decided = true;
    const out = this.pending;
    this.pending = "";
    return NARRATION_RE.test(`${out.trim()} `) ? "" : out;
  }
}
