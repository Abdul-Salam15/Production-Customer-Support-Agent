// Splits a record into speakable fields and an internal block, per Phase 3.7.
// The internal block may inform a tool's derived fields (e.g. recommended_action)
// but must never be spoken or paraphrased aloud — enforced by the system prompt
// (Phase 4), not by this function.
export function splitSpeakable<T extends Record<string, unknown>, K extends keyof T>(
  record: T,
  internalKeys: readonly K[]
): { speakable: Omit<T, K>; internal: Pick<T, K> } {
  const speakable = { ...record };
  const internal = {} as Pick<T, K>;

  for (const key of internalKeys) {
    internal[key] = record[key];
    delete speakable[key];
  }

  return { speakable: speakable as Omit<T, K>, internal };
}
