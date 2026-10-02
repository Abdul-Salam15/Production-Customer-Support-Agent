import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { getVerifiedCustomerId, isOwnershipViolation } from "../lib/verification.js";
import { isPastEstimatedArrival } from "../lib/dates.js";
import { withLogging, type ToolContext } from "../lib/withLogging.js";
import { recordConversationEvent } from "../lib/conversationEvents.js";

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

  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .eq("transaction_id", args.transaction_id)
    .maybeSingle();

  if (error) throw new Error(`transactions query failed: ${error.message}`);
  if (!data) return { found: false };

  if (isOwnershipViolation(data.customer_id, verifiedCustomerId)) {
    // Staff-only signal, never spoken: the caller gets the same found:false
    // as a reference that doesn't exist at all, so confirming (or denying)
    // ownership here would tell a verified stranger someone else's
    // reference is real.
    await recordConversationEvent(
      ctx.conversationId,
      "lookup_denied_ownership",
      `Caller asked about transaction ${args.transaction_id}, which isn't linked to their verified account.`,
      { requested_reference: args.transaction_id, owner_customer_id: data.customer_id, caller_customer_id: verifiedCustomerId }
    );
    return { found: false };
  }

  return {
    found: true,
    transaction_id: data.transaction_id,
    customer_id: data.customer_id,
    type: data.transaction_type,
    status: data.status,
    estimated_arrival: data.estimated_arrival,
    support_summary: data.support_summary,
    past_estimated_arrival: isPastEstimatedArrival(data.estimated_arrival),
    recommended_action: recommendedActionFor(data.status),
    // The KB: "RelayPay does not share sensitive account information through
    // automated or voice-based systems." The amount is for case summaries
    // staff read, never for the caller to hear.
    internal: {
      amount: data.amount,
      currency: data.currency,
    },
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
