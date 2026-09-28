// Compares a record's date against the real current date at call time.
// Never left to the model to calculate — see Phase 3.3.
export function isPastEstimatedArrival(dateStr: string | null): boolean {
  if (!dateStr) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const estimated = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(estimated.getTime())) return false;

  return estimated.getTime() < today.getTime();
}
