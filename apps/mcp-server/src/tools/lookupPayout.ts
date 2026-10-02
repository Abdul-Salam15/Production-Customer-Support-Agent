import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { getVerifiedCustomerId, isOwnershipViolation } from "../lib/verification.js";
import { isPastEstimatedArrival } from "../lib/dates.js";
import { withLogging, type ToolContext } from "../lib/withLogging.js";

const inputShape = {
  payout_id: z.string().optional(),
  transaction_id: z.string().optional(),
};

type LookupPayoutArgs = {
  payout_id?: string;
  transaction_id?: string;
};

function recommendedActionFor(status: string): "none" | "ticket" | "escalate" {
  if (status === "review required") return "escalate";
  if (status === "failed") return "ticket";
  return "none";
}

async function handle(args: LookupPayoutArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const { payout_id, transaction_id } = args;
  if (!payout_id && !transaction_id) return { found: false };

  const supabase = getSupabaseClient();

  // Nothing about a record is shared until the caller is verified — not
  // even its status. Checked before the query, so an unverified caller
  // can't learn whether a reference exists either.
  const verifiedCustomerId = await getVerifiedCustomerId(supabase, ctx.conversationId);
  if (!verifiedCustomerId) {
    return {
      found: false,
      verification_required: true,
      guidance: "Verify the caller first (their account email plus name or company), then look this up again.",
    };
  }

  let query = supabase.from("payouts").select("*");
  query = payout_id ? query.eq("payout_id", payout_id) : query.eq("transaction_id", transaction_id as string);

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`payouts query failed: ${error.message}`);
  if (!data) return { found: false };

  if (isOwnershipViolation(data.customer_id, verifiedCustomerId)) {
    return { found: false };
  }

  return {
    found: true,
    payout_id: data.payout_id,
    status: data.status,
    scheduled_for: data.scheduled_for,
    failure_reason: data.failure_reason,
    past_estimated_arrival: isPastEstimatedArrival(data.scheduled_for),
    recommended_action: recommendedActionFor(data.status),
  };
}

export function registerLookupPayout(server: McpServer): void {
  server.registerTool(
    "lookup_payout",
    {
      title: "Lookup Payout",
      description: "Find a contractor/vendor payout by payout ID or its linked transaction ID.",
      inputSchema: inputShape,
    },
    withLogging("lookup_payout", "Check payout status for the caller's question", handle)
  );
}
