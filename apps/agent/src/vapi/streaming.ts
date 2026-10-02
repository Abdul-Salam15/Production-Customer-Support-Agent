import type { Response } from "express";
import { randomUUID } from "node:crypto";

// Matches the leading [path=...;confidence=...] tag the system prompt
// requires on every response. Vapi must never see it.
// Appended by the backend — never written by the model — to the agent's
// last reply when it ends the call. It must match, exactly, the phrase in the
// Vapi assistant's "End Call Phrases": Vapi hangs up once it's been spoken.
// Because only code ever produces it, the model can't end a call by
// accident with a stray "goodbye".
export const END_CALL_PHRASE = "Thank you for calling RelayPay. Goodbye.";

// Optional ";end_call=true" means the caller is done and the agent's reply
// is its goodbye — the browser hangs up once that reply has been spoken.
const TAG_RE = /^\[path=(answer|clarify|escalate|decline);confidence=(high|low|uncertain)(?:;end_call=(true|false))?\]\s*/i;
const MAX_TAG_LOOKAHEAD = 100;

export interface ParsedTag {
  answerType: string | null;
  confidence: string | null;
  endCall: boolean;
}

// Buffers just enough of the start of the stream to detect and strip the
// tag (which may arrive split across multiple deltas), then passes
// subsequent text straight through.
export function createTagStrippingBuffer() {
  let buffer = "";
  let resolved = false;
  let tag: ParsedTag = { answerType: null, confidence: null, endCall: false };

  return {
    push(deltaText: string): string {
      if (resolved) return deltaText;

      buffer += deltaText;
      const match = buffer.match(TAG_RE);

      if (match) {
        resolved = true;
        tag = { answerType: match[1].toLowerCase(), confidence: match[2].toLowerCase(), endCall: match[3]?.toLowerCase() === "true" };
        return buffer.slice(match[0].length);
      }

      if (buffer.length > MAX_TAG_LOOKAHEAD) {
        // No tag showed up within a reasonable lookahead — flush as-is
        // rather than withholding real output indefinitely.
        resolved = true;
        return buffer;
      }

      return "";
    },
    // The text block ended: release whatever is still being held while
    // waiting to see whether a tag would appear, stripping the tag if the
    // whole block was just the tag. Without this, a short block (< lookahead)
    // was never released at all.
    flush(): string {
      if (resolved) return "";
      resolved = true;
      const match = buffer.match(TAG_RE);
      if (match) {
        tag = { answerType: match[1].toLowerCase(), confidence: match[2].toLowerCase(), endCall: match[3]?.toLowerCase() === "true" };
        return buffer.slice(match[0].length);
      }
      return buffer;
    },
    getTag(): ParsedTag {
      return tag;
    },
  };
}

// Strips the tag from a complete, final response string (used for the
// conversation_turns row, where we have the whole text at once).
export function stripTag(fullText: string): { text: string; tag: ParsedTag } {
  const match = fullText.match(TAG_RE);
  if (!match) return { text: fullText, tag: { answerType: null, confidence: null, endCall: false } };
  return {
    text: fullText.slice(match[0].length),
    tag: { answerType: match[1].toLowerCase(), confidence: match[2].toLowerCase(), endCall: match[3]?.toLowerCase() === "true" },
  };
}

// Writes one OpenAI-style chat.completion.chunk SSE frame.
export function writeSseChunk(res: Response, model: string, id: string, contentDelta: string): void {
  if (contentDelta.length === 0) return;
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: contentDelta }, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export function writeSseDone(res: Response, model: string, id: string): void {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

export function newChunkId(): string {
  return `chatcmpl-${randomUUID()}`;
}
