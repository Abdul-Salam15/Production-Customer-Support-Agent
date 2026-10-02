// Holds back the start of each spoken text block until we know whether a
// tool call follows it. The model often writes a sentence *before* calling a
// tool — "I don't have documentation that covers that. Let me search…" —
// and once streamed to Vapi it can't be taken back, even when the tool then
// proves it wrong.
//
// A short block followed by a tool call is set aside. If the model then
// writes more text, the set-aside block was a lead-in and is dropped. If the
// turn ends after the tool instead (an answer followed by bookkeeping, like
// reading back a reference and then logging it), the set-aside block *was*
// the answer and is spoken.
//
// A block longer than HOLD_LIMIT is treated as a real answer and streams
// normally (lead-ins are short), so long replies keep their low latency;
// the cost is that a short final answer is released when its block ends
// rather than word by word.
const HOLD_LIMIT = 220;

export class PreToolGate {
  private held = "";
  private holding = false;
  private parked = "";
  private dropped: string[] = [];

  constructor(private readonly release: (text: string) => void) {}

  // A text block started; an earlier held block (no tool between them) is
  // real speech, so release it first.
  startText(): void {
    if (this.parked.trim()) this.dropped.push(this.parked.trim());
    this.parked = "";
    const out = this.held;
    this.held = "";
    if (out) this.release(out);
    this.holding = true;
  }

  push(text: string): void {
    if (!text) return;
    if (!this.holding) {
      this.release(text);
      return;
    }
    this.held += text;
    if (this.held.length > HOLD_LIMIT) this.flush();
  }

  // A tool call is starting: set aside what's held until we know whether
  // more text follows the tool.
  startTool(): void {
    if (this.holding && this.held) this.parked += this.held;
    this.held = "";
    this.holding = false;
  }

  // End of the reply (or a new text block): speak what's held.
  flush(): void {
    const out = this.parked + this.held;
    this.parked = "";
    this.held = "";
    this.holding = false;
    if (out) this.release(out);
  }

  droppedText(): string[] {
    return this.dropped;
  }
}
