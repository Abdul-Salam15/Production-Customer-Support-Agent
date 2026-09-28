import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { getVerifiedCustomerId, isOwnershipViolation } from "../lib/verification.js";
import { isPastEstimatedArrival } from "../lib/dates.js";
import { withLogging, type ToolContext } from "../lib/withLogging.js";

const inputShape = {
  transaction_id: z.string(),
};

type LookupTransactionArgs = {
  transaction_id: string;
};

function recommendedActionFor(status: string): "none" | "ticket" | "escalate" {
  if (status === "review required") return "escalate";
  if (status === "failed") return "ticket";
  return "none";
}

async function handle(args: LookupTransactionArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("transaction_id", args.transaction_id)
    .maybeSingle();

  if (error) throw new Error(`transactions query failed: ${error.message}`);
  if (!data) return { found: false };

  const verifiedCustomerId = await getVerifiedCustomerId(supabase, ctx.conversationId);
  if (isOwnershipViolation(data.customer_id, verifiedCustomerId)) {
    return { found: false };
  }

  return {
    found: true,
    transaction_id: data.transaction_id,
    customer_id: data.customer_id,
    type: data.transaction_type,
    status: data.status,
    amount: data.amount,
    currency: data.currency,
    estimated_arrival: data.estimated_arrival,
    support_summary: data.support_summary,
    past_estimated_arrival: isPastEstimatedArrival(data.estimated_arrival),
    recommended_action: recommendedActionFor(data.status),
  };
}

export function registerLookupTransaction(server: McpServer): void {
  server.registerTool(
    "lookup_transaction",
    {
      title: "Lookup Transaction",
      description: "Find a transaction record by its reference when the caller asks about it.",
      inputSchema: inputShape,
    },
    withLogging("lookup_transaction", "Check transaction status for the caller's question", handle)
  );
}
