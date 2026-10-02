// One-off backfill: escalations created before create_escalation set
// call_booked and callback_at have call_booked = false and callback_at = null
// even when a callback time was stored. Sets both from preferred_time, using
// the same rule as create_escalation, with each row's created_at as the
// reference for the missing year. Safe to re-run: only touches rows that have
// a preferred_time and aren't marked booked yet.
//
//   npx tsx scripts/backfill-escalation-callbacks.ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { callbackInstant } from "../apps/mcp-server/src/lib/spokenTime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, "..", "apps", "agent", ".env") });

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data, error } = await supabase
    .from("escalations")
    .select("escalation_id, preferred_time, created_at")
    .eq("call_booked", false)
    .not("preferred_time", "is", null);
  if (error) throw new Error(`escalations query failed: ${error.message}`);

  for (const row of data ?? []) {
    const at = callbackInstant(row.preferred_time, new Date(row.created_at));
    const { error: updateError } = await supabase
      .from("escalations")
      .update({ call_booked: true, callback_at: at?.toISOString() ?? null })
      .eq("escalation_id", row.escalation_id);
    if (updateError) throw new Error(`update ${row.escalation_id} failed: ${updateError.message}`);
    console.log(`${row.escalation_id}: "${row.preferred_time}" -> ${at?.toISOString() ?? "unparsed (call_booked only)"}`);
  }
  console.log(`Backfilled ${(data ?? []).length} escalation(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
