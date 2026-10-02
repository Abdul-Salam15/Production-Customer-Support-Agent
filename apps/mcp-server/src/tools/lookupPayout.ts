import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { getVerifiedCustomerId, isOwnershipViolation } from "../lib/verification.js";
import { isPastEstimatedArrival } from "../lib/dates.js";
import { withLogging, type ToolContext } from "../lib/withLogging.js";
import { recordConversationEvent } from "../lib/conversationEvents.js";

const inputShape = {
  payout_id: z.string().optional(),
  transaction_id: z.string().optional(),
};

type LookupPayoutArgs = {
  payout_id?: string;
  transaction_id?: string;
};

// The MCP spec's lookup_payout output includes support_summary, but payouts
// have no such column. The linked transaction's support_summary is the
// customer-safe line for the same money movement, so it's used when there is
// one; otherwise a plain line is built from the payout's own status.
function fallbackSummary(status: string, failureReason: string | null): string {
  switch (status) {
    case "scheduled":
      return "Payout is scheduled.";
    case "processing":
      return "Payout is processing.";
    case "completed":
      return "Payout completed.";
    case "failed":
      return failureReason ? `Payout failed because ${failureReason}.` : "Payout failed.";
    case "review required":
      return failureReason ? `Payout is on hold for ${failureReason}.` : "Payout is on hold for review.";
    default:
      return `Payout status: ${status}.`;
  }
}

async function supportSummaryFor(
  supabase: ReturnType<typeof getSupabaseClient>,
  payout: { transaction_id: string | null; status: string; failure_reason: string | null }
): Promise<string> {
  if (payout.transaction_id) {
    const { data } = await supabase
      .from("transactions")
      .select("support_summary")
      .eq("transaction_id", payout.transaction_id)
      .maybeSingle();
    if (data?.support_summary) return data.support_summary;
  }
  return fallbackSummary(payout.status, payout.failure_reason);
}

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
    // Staff-only signal, never spoken — see lookupTransaction.ts.
    const reference = payout_id ?? transaction_id ?? "";
    await recordConversationEvent(
      ctx.conversationId,
      "lookup_denied_ownership",
      `Caller asked about payout ${reference}, which isn't linked to their verified account.`,
      { requested_reference: reference, owner_customer_id: data.customer_id, caller_customer_id: verifiedCustomerId }
    );
    return { found: false };
  }

  return {
    found: true,
    payout_id: data.payout_id,
    status: data.status,
    scheduled_for: data.scheduled_for,
    failure_reason: data.failure_reason,
    support_summary: await supportSummaryFor(supabase, data),
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
