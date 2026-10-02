import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { findVerifiedCustomer, type CustomerRecord } from "../lib/verification.js";
import { withLogging, type ToolContext } from "../lib/withLogging.js";

const inputShape = {
  customer_id: z.string().optional(),
  email: z.string().optional(),
  company_name: z.string().optional(),
  contact_name: z.string().optional(),
};

type LookupCustomerArgs = {
  customer_id?: string;
  email?: string;
  company_name?: string;
  contact_name?: string;
};

async function handle(args: LookupCustomerArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const { customer_id, email, company_name, contact_name } = args;

  if (!email) {
    // Not an enumeration leak: says nothing about whether the person exists.
    return { found: false, needs: "email" };
  }
  if (!customer_id && !company_name && !contact_name) {
    return { found: false, needs: "name_or_company" };
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("customers").select("*");
  if (error) throw new Error(`customers query failed: ${error.message}`);

  const match = findVerifiedCustomer((data ?? []) as CustomerRecord[], {
    customer_id,
    email,
    company_name,
    contact_name,
  });

  if (!match) {
    // Enumeration guard: never confirm the company exists, never say which
    // field was wrong.
    return { found: false };
  }

  const escalationRecommended =
    match.account_status === "restricted" ||
    match.account_status === "pending verification" ||
    match.kyc_status === "review required";

  if (ctx.conversationId) {
    await supabase
      .from("conversations")
      .update({ customer_id: match.customer_id })
      .eq("conversation_id", ctx.conversationId);
  }

  return {
    found: true,
    customer_id: match.customer_id,
    company_name: match.company_name,
    plan: match.plan,
    account_status: match.account_status,
    escalation_recommended: escalationRecommended,
    recommended_action: escalationRecommended ? "escalate" : "none",
    internal: {
      kyc_status: match.kyc_status,
      support_notes: match.support_notes,
    },
  };
}

export function registerLookupCustomer(server: McpServer): void {
  server.registerTool(
    "lookup_customer",
    {
      title: "Lookup Customer",
      description:
        "Verify the caller and fetch their account. Requires the account email address plus at least one of " +
        "contact name or company name (a customer id counts only if the caller volunteers it — never ask for one). " +
        "Name and company alone never verify. Pass the email in written form (amara@lagosledger.example). " +
        "found: false means no match — never say which detail was wrong.",
      inputSchema: inputShape,
    },
    withLogging("lookup_customer", "Verify caller identity and fetch account status", handle)
  );
}
