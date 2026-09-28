import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedDataDir = join(__dirname, "..", "..", "assets", "seed-data");

// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY live in apps/agent/.env per Section 3.
loadEnv({ path: join(__dirname, "..", "..", "apps", "agent", ".env") });

function loadCsv(fileName: string): Record<string, string>[] {
  const raw = readFileSync(join(seedDataDir, fileName), "utf-8");
  return parse(raw, { columns: true, skip_empty_lines: true });
}

function toNullableString(value: string): string | null {
  return value === "" ? null : value;
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

  const customers = loadCsv("customers.csv").map((row) => ({
    customer_id: row.customer_id,
    company_name: row.company_name,
    contact_name: row.contact_name,
    contact_email: row.contact_email,
    plan: row.plan,
    account_status: row.account_status,
    region: row.region,
    kyc_status: row.kyc_status,
    support_notes: toNullableString(row.support_notes),
  }));

  const transactions = loadCsv("transactions.csv").map((row) => ({
    transaction_id: row.transaction_id,
    customer_id: row.customer_id,
    transaction_type: row.transaction_type,
    amount: Number(row.amount),
    currency: row.currency,
    destination_country: toNullableString(row.destination_country),
    status: row.status,
    created_at: row.created_at,
    estimated_arrival: toNullableString(row.estimated_arrival),
    support_summary: row.support_summary,
  }));

  const payouts = loadCsv("payouts.csv").map((row) => ({
    payout_id: row.payout_id,
    transaction_id: row.transaction_id,
    customer_id: row.customer_id,
    recipient_name: row.recipient_name,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    scheduled_for: toNullableString(row.scheduled_for),
    failure_reason: toNullableString(row.failure_reason),
  }));

  const { error: customersError } = await supabase
    .from("customers")
    .upsert(customers, { onConflict: "customer_id" });
  if (customersError) throw new Error(`customers upsert failed: ${customersError.message}`);

  const { error: transactionsError } = await supabase
    .from("transactions")
    .upsert(transactions, { onConflict: "transaction_id" });
  if (transactionsError) throw new Error(`transactions upsert failed: ${transactionsError.message}`);

  const { error: payoutsError } = await supabase
    .from("payouts")
    .upsert(payouts, { onConflict: "payout_id" });
  if (payoutsError) throw new Error(`payouts upsert failed: ${payoutsError.message}`);

  console.log(
    `Seed load complete: ${customers.length} customers, ${transactions.length} transactions, ${payouts.length} payouts.`
  );
}

main().catch((error) => {
  console.error("Seed load failed:", error);
  process.exitCode = 1;
});
