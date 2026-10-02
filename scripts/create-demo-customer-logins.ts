// Creates website logins for the five seed customers, so the customer
// account page (/customer) can show the calls made as them. Their call
// history is matched by email.
//
// Normal signup sends a confirmation link, and the seed's .example addresses
// can't receive email, so these accounts are created already confirmed. Only
// for the demo customers in assets/seed-data/customers.csv.
//
// The password comes from the environment, not the repository:
//   DEMO_CUSTOMER_PASSWORD='...' npx tsx scripts/create-demo-customer-logins.ts
// Safe to re-run: an existing login gets the password reset and stays confirmed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, "..", "apps", "agent", ".env") });

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEMO_CUSTOMER_PASSWORD } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  if (!DEMO_CUSTOMER_PASSWORD || DEMO_CUSTOMER_PASSWORD.length < 8) {
    throw new Error("Set DEMO_CUSTOMER_PASSWORD (at least 8 characters, the same rule as /signup)");
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const customers = parse(readFileSync(join(__dirname, "..", "assets", "seed-data", "customers.csv"), "utf-8"), {
    columns: true,
    skip_empty_lines: true,
  }) as { contact_name: string; contact_email: string }[];

  const { data: existing, error: listError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listError) throw new Error(`listing users failed: ${listError.message}`);

  for (const { contact_name: fullName, contact_email: email } of customers) {
    let userId = existing.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id;

    if (userId) {
      const { error } = await supabase.auth.admin.updateUserById(userId, {
        password: DEMO_CUSTOMER_PASSWORD,
        email_confirm: true,
      });
      if (error) throw new Error(`updating ${email} failed: ${error.message}`);
    } else {
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password: DEMO_CUSTOMER_PASSWORD,
        email_confirm: true,
      });
      if (error || !data.user) throw new Error(`creating ${email} failed: ${error?.message}`);
      userId = data.user.id;
    }

    // The same row /signup creates; it's what marks the login as a customer.
    const { error: accountError } = await supabase
      .from("customer_accounts")
      .upsert({ id: userId, email, full_name: fullName }, { onConflict: "id" });
    if (accountError) throw new Error(`customer_accounts for ${email} failed: ${accountError.message}`);

    console.log(`${email} (${fullName}): login ready`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
