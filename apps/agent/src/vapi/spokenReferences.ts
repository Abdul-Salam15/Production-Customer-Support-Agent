// Rewrites raw references into the way a person says them, right before text
// goes to Vapi's speech engine: "TXN-9001" -> "T-X-N, nine-zero-zero-one".
//
// The system prompt already asks for this, but the model doesn't always
// comply, and the speech engine reads a raw "RP-2382" as "R-P twenty-three,
// eighty-two" or splits it mid-number. This makes it deterministic. Only the
// spoken stream is rewritten; transcripts keep the readable written form.
const DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

// TXN-9001, PAY-7002, RP-2382, CUS-1001 (also without the hyphen or with a space).
const REFERENCE_RE = /\b(TXN|PAY|RP|CUS)[-\s]?(\d{3,6})\b/gi;

export function speakReferences(text: string): string {
  return text.replace(REFERENCE_RE, (_match, prefix: string, digits: string) => {
    const letters = prefix.toUpperCase().split("").join("-");
    const spokenDigits = digits
      .split("")
      .map((d) => DIGIT_WORDS[Number(d)])
      .join("-");
    return `${letters}, ${spokenDigits}`;
  });
}
