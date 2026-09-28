import type { SupabaseClient } from "@supabase/supabase-js";

export interface CustomerRecord {
  customer_id: string;
  company_name: string;
  contact_name: string;
  contact_email: string;
  plan: string;
  account_status: string;
  region: string;
  kyc_status: string;
  support_notes: string | null;
}

export interface LookupCustomerFields {
  customer_id?: string;
  email?: string;
  company_name?: string;
  contact_name?: string;
}

const MIN_MATCHED_FACTS = 2;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

// "Amara" matches contact_name "Amara Okafor" (first-name or full-name match),
// per Scenario 3: a caller rarely gives a full legal name over voice.
function matchesContactName(recordContactName: string, supplied: string): boolean {
  const suppliedNorm = normalize(supplied);
  const recordNorm = normalize(recordContactName);
  if (recordNorm === suppliedNorm) return true;
  return recordNorm.split(/\s+/).includes(suppliedNorm);
}

function countMatchedFacts(record: CustomerRecord, fields: LookupCustomerFields): number {
  let count = 0;
  if (fields.customer_id && normalize(fields.customer_id) === normalize(record.customer_id)) count++;
  if (fields.email && normalize(fields.email) === normalize(record.contact_email)) count++;
  if (fields.company_name && normalize(fields.company_name) === normalize(record.company_name)) count++;
  if (fields.contact_name && matchesContactName(record.contact_name, fields.contact_name)) count++;
  return count;
}

// Picks the best-matching record and requires at least two supplied fields to
// agree with it. One field alone (e.g. company name only) is never enough —
// this is what closes the enumeration gap in Scenario 3.
export function findVerifiedCustomer(
  records: CustomerRecord[],
  fields: LookupCustomerFields
): CustomerRecord | null {
  let best: { record: CustomerRecord; score: number } | null = null;

  for (const record of records) {
    const score = countMatchedFacts(record, fields);
    if (!best || score > best.score) {
      best = { record, score };
    }
  }

  if (best && best.score >= MIN_MATCHED_FACTS) {
    return best.record;
  }
  return null;
}

// True when a transaction/payout's owning customer differs from the one
// already verified in this conversation — the caller must never see another
// customer's record just because they guessed a valid reference.
export function isOwnershipViolation(
  recordCustomerId: string,
  verifiedCustomerId: string | null
): boolean {
  return verifiedCustomerId !== null && recordCustomerId !== verifiedCustomerId;
}

export async function getVerifiedCustomerId(
  supabase: SupabaseClient,
  conversationId: string | null
): Promise<string | null> {
  if (!conversationId) return null;

  const { data, error } = await supabase
    .from("conversations")
    .select("customer_id")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (error || !data) return null;
  return data.customer_id ?? null;
}
