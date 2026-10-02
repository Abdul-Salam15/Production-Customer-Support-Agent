import type { SupabaseClient } from "@supabase/supabase-js";

// Generates a CUS-#### id not already in use, same pattern as
// createSupportTicket.ts's RP-#### generator in apps/mcp-server.
async function generateCustomerId(supabase: SupabaseClient): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `CUS-${Math.floor(1000 + Math.random() * 9000)}`;
    const { data } = await supabase.from("customers").select("customer_id").eq("customer_id", candidate).maybeSingle();
    if (!data) return candidate;
  }
  throw new Error("failed to generate a unique CUS-#### id after 10 attempts");
}

export interface EnsureCustomerRecordInput {
  email: string;
  fullName: string;
  companyName?: string | null;
}

// Gives a website signup a matching row in the business "customers" table,
// so the voice agent's lookup_customer — and this file's own signed-in-
// caller auto-verify — can recognize them. customer_accounts (the website
// login) and customers (the business record lookup_customer checks) were
// previously unlinked: signing up never created the second one, so a new
// customer could never be verified by voice, signed in or not.
//
// If a customers row already exists for this email (a seed/business
// customer creating a web login, e.g. Amara signing up with
// amara@lagosledger.example), it's reused rather than duplicated — that
// keeps one customer_id per real account and lets the existing
// signed-in-caller linking below find it immediately.
export async function ensureCustomerRecord(
  supabase: SupabaseClient,
  { email, fullName, companyName }: EnsureCustomerRecordInput
): Promise<void> {
  try {
    const escaped = email.replace(/[\\%_]/g, (c) => `\\${c}`);
    const { data: existing } = await supabase
      .from("customers")
      .select("customer_id")
      .ilike("contact_email", escaped)
      .limit(1)
      .maybeSingle();
    if (existing) return; // a business record already covers this email

    const customerId = await generateCustomerId(supabase);
    const { error } = await supabase.from("customers").insert({
      customer_id: customerId,
      // No company field was collected before this (optional) form field
      // existed, and it's still optional — default to the person's own
      // name so the column (not null) always has something meaningful.
      company_name: companyName?.trim() || fullName,
      contact_name: fullName,
      contact_email: email,
      plan: "Starter",
      account_status: "active",
      kyc_status: "approved",
      region: "Unspecified",
      support_notes: "Self-signup account created from the website.",
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    // Best-effort: customer_accounts (the website login) already exists and
    // works regardless of this — it only adds voice recognition on top.
    console.error("ensureCustomerRecord: failed to create a customers row", error);
  }
}
