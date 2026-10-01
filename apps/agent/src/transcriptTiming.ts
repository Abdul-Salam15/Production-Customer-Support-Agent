// Seconds into the call at which something happened, for the "mm:ss" clock
// shown beside each transcript line (customer call history and the
// specialist case view). Built from real timestamps: customLlm.ts records
// when the caller's turn arrived and when the agent began replying.
export function secondsIntoCall(callStartedAt: string | null | undefined, at: string | null | undefined): number {
  if (!callStartedAt || !at) return 0;
  const seconds = Math.round((new Date(at).getTime() - new Date(callStartedAt).getTime()) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}
