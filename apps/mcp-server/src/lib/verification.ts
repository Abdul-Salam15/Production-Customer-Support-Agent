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

// Every fact arrives through speech recognition, which splits, joins, and
// mishears words: "LagosLedger" comes back as "Lagos Ledger" or "Legos
// Ledger", "CUS-1001" as "cus 1001". Comparing letters and digits only, with
// one slip allowed in longer values, stops genuine callers failing while
// still requiring the email plus another fact to agree (MIN_MATCHED_FACTS).
function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const COMPANY_SUFFIX_RE = /(limited|ltd|inc|incorporated|llc|plc|corp|corporation|company|co)$/;

function compactCompany(value: string): string {
  const c = compact(value);
  const stripped = c.replace(COMPANY_SUFFIX_RE, "");
  return stripped.length >= 3 ? stripped : c;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return prev[b.length];
}

// One slip (a misheard or dropped letter) for values of 6+ characters; exact
// for shorter ones, where a single letter changes the name entirely.
function closeEnough(record: string, supplied: string): boolean {
  if (!record || !supplied) return false;
  if (record === supplied) return true;
  return Math.min(record.length, supplied.length) >= 6 && editDistance(record, supplied) <= 1;
}

// "Amara" matches contact_name "Amara Okafor" (first-name or full-name match),
// per Scenario 3: a caller rarely gives a full legal name over voice.
function matchesContactName(recordContactName: string, supplied: string): boolean {
  if (closeEnough(compact(recordContactName), compact(supplied))) return true;
  const recordParts = normalize(recordContactName).split(/\s+/).map(compact);
  const suppliedParts = normalize(supplied).split(/\s+/).map(compact).filter(Boolean);
  // Every word the caller gave must match a word of the record's name.
  return (
    suppliedParts.length > 0 &&
    suppliedParts.every((part) => recordParts.some((recordPart) => closeEnough(recordPart, part)))
  );
}

// Speech recognition delivers emails as "amara at lagosledger dot example"
// or with stray spaces; turn that back into a written address.
export function normalizeSpokenEmail(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+at\s+/g, "@")
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s+/g, "");
}

function emailMatches(record: CustomerRecord, supplied: string | undefined): boolean {
  // Exact once spacing is fixed — no fuzzy slip: one character in an email
  // is a different person.
  return !!supplied && normalizeSpokenEmail(supplied) === normalize(record.contact_email);
}

function countOtherFacts(record: CustomerRecord, fields: LookupCustomerFields): number {
  let count = 0;
  if (fields.customer_id && compact(fields.customer_id) === compact(record.customer_id)) count++;
  if (fields.company_name && closeEnough(compactCompany(record.company_name), compactCompany(fields.company_name))) count++;
  if (fields.contact_name && matchesContactName(record.contact_name, fields.contact_name)) count++;
  return count;
}

// The account email is required, plus at least one other fact (name,
// company, or customer id) that agrees with the same record. A name and a
// company alone are public knowledge — anyone who knows Amara works at
// LagosLedger could otherwise talk to support on her behalf. Customers
// rarely know their customer id, so the agent never asks for it; it only
// counts if the caller volunteers it.
export function findVerifiedCustomer(
  records: CustomerRecord[],
  fields: LookupCustomerFields
): CustomerRecord | null {
  if (!fields.email) return null;
  const record = records.find((r) => emailMatches(r, fields.email));
  if (!record) return null;
  return countOtherFacts(record, fields) >= MIN_MATCHED_FACTS - 1 ? record : null;
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
