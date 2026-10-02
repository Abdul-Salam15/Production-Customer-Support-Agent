// One-off fix: conversations whose end-of-call webhook was rejected (the
// Vapi server secret mismatch, see docs/reflection-notes.md "Correction to
// an earlier entry") and whose idle backstop was then wiped by a later
// redeploy never got finalized. They sit in the customer's call history as
// "Call in progress" forever. This closes them out using the same outcome
// logic finalizeCall.ts uses, but deliberately skips the summary email, so
// re-running this never spams a customer's inbox for an old test call.
//
//   npx tsx scripts/backfill-stuck-conversations.ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { deriveFinalOutcome } from "../apps/agent/src/session/finalizeCall.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, "..", "apps", "agent", ".env") });

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: stuck, error } = await supabase
    .from("conversations")
    .select("conversation_id, vapi_call_id, started_at")
    .is("ended_at", null)
    .not("vapi_call_id", "like", "eval-%")
    .order("started_at", { ascending: true });
  if (error) throw new Error(`conversations query failed: ${error.message}`);

  for (const conv of stuck ?? []) {
    const outcome = await deriveFinalOutcome(conv.conversation_id);
    const { error: updateError } = await supabase
      .from("conversations")
      .update({
        ended_at: new Date().toISOString(),
        ended_reason: "backfilled-after-webhook-failure",
        final_status: outcome.status,
        summary: outcome.summary,
      })
      .eq("conversation_id", conv.conversation_id)
      .is("ended_at", null); // don't race a webhook that finalizes it mid-script
    if (updateError) throw new Error(`update ${conv.conversation_id} failed: ${updateError.message}`);
    console.log(`${conv.vapi_call_id} (started ${conv.started_at}): ${outcome.status}`);
  }
  console.log(`Backfilled ${(stuck ?? []).length} conversation(s). No emails were sent.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
