// Moves the seed data's one "on time" example forward to today.
//
// Every date in assets/seed-data/ is in August 2026, so on any later day every
// record is past its estimate and the agent can only ever say "that date has
// passed". TXN-9001 / PAY-7001 is the seed's normal, processing payout; this
// keeps it processing within its window (arriving in two days, scheduled for
// tomorrow) so that path can be demonstrated. Nothing else is changed: the
// delayed, failed and review-required records keep their CSV dates.
//
//   npm run seed            # loads the CSVs exactly as provided
//   npm run refresh-dates   # then shifts these two dates relative to today
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, "..", "apps", "agent", ".env") });

function daysFromToday(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const arrival = daysFromToday(2);
  const scheduled = daysFromToday(1);

  const { error: txError } = await supabase
    .from("transactions")
    .update({ estimated_arrival: arrival })
    .eq("transaction_id", "TXN-9001");
  if (txError) throw new Error(`TXN-9001 update failed: ${txError.message}`);

  const { error: payoutError } = await supabase
    .from("payouts")
    .update({ scheduled_for: scheduled })
    .eq("payout_id", "PAY-7001");
  if (payoutError) throw new Error(`PAY-7001 update failed: ${payoutError.message}`);

  console.log(`TXN-9001 estimated_arrival -> ${arrival}; PAY-7001 scheduled_for -> ${scheduled}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
