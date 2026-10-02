// One-off backfill: website accounts created before signup started creating
// a matching `customers` row (apps/agent/src/customer/customerRecord.ts) have
// no business record, so the voice agent can never recognize them and the
// signed-in-caller auto-verify (apps/agent/src/customer/routes.ts) finds
// nothing. Gives each one the same record signup would have created.
//
// Safe to re-run: ensureCustomerRecord skips any email that already has a
// customers row, whether from this script, signup, or the original seed data.
//
//   npx tsx scripts/backfill-customer-records.ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { ensureCustomerRecord } from "../apps/agent/src/customer/customerRecord.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, "..", "apps", "agent", ".env") });

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: accounts, error } = await supabase.from("customer_accounts").select("email, full_name");
  if (error) throw new Error(`customer_accounts query failed: ${error.message}`);

  for (const account of accounts ?? []) {
    if (!account.full_name) {
      console.log(`${account.email}: skipped (no full name on file)`);
      continue;
    }
    await ensureCustomerRecord(supabase, { email: account.email, fullName: account.full_name });
    console.log(`${account.email} (${account.full_name}): done`);
  }
  console.log(`Checked ${(accounts ?? []).length} customer account(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
