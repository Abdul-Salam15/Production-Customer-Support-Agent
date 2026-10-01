import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { withLogging, type ToolContext } from "../lib/withLogging.js";
import { logAudit } from "../lib/auditLog.js";
import { getVerifiedCustomerId } from "../lib/verification.js";

const inputShape = {
  customer_id: z.string().optional(),
  category: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  summary: z.string(),
  conversation_id: z.string().optional(),
  related_transaction_id: z.string().optional(),
  related_payout_id: z.string().optional(),
};

type CreateSupportTicketArgs = {
  customer_id?: string;
  category: string;
  priority: "high" | "medium" | "low";
  summary: string;
  conversation_id?: string;
  related_transaction_id?: string;
  related_payout_id?: string;
};

// Speakable on a call: "R-P, four-eight-two-one".
export async function generateUniqueReference(
  checkExists: (candidate: string) => Promise<boolean>
): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `RP-${Math.floor(1000 + Math.random() * 9000)}`;
    if (!(await checkExists(candidate))) return candidate;
  }
  throw new Error("failed to generate a unique RP-#### reference after 10 attempts");
}

async function ticketIdExists(supabase: SupabaseClient, candidate: string): Promise<boolean> {
  const { data } = await supabase
    .from("support_tickets")
    .select("ticket_id")
    .eq("ticket_id", candidate)
    .maybeSingle();
  return data !== null;
}

async function handle(args: CreateSupportTicketArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const supabase = getSupabaseClient();
  const conversationId = ctx.conversationId ?? args.conversation_id ?? null;

  // Idempotency: retries and repeated requests within one call shouldn't
  // create two tickets for the same issue.
  if (conversationId) {
    const { data: existing } = await supabase
      .from("support_tickets")
      .select("ticket_id, status")
      .eq("conversation_id", conversationId)
      .eq("category", args.category)
      .eq("status", "open")
      .maybeSingle();

    if (existing) {
      return { ticket_id: existing.ticket_id, status: existing.status };
    }
  }

  const ticketId = await generateUniqueReference((candidate) => ticketIdExists(supabase, candidate));

  const { error } = await supabase.from("support_tickets").insert({
    ticket_id: ticketId,
    conversation_id: conversationId,
    // Only the customer verified on this call — a model-supplied id that
    // isn't a real customers row would fail the foreign key and lose the ticket.
    customer_id: await getVerifiedCustomerId(supabase, conversationId),
    category: args.category,
    priority: args.priority,
    summary: args.summary,
    related_transaction_id: args.related_transaction_id ?? null,
    related_payout_id: args.related_payout_id ?? null,
    status: "open",
  });

  if (error) throw new Error(`support_tickets insert failed: ${error.message}`);

  void logAudit("case", `New support ticket created (${ticketId}).`);

  return { ticket_id: ticketId, status: "open" };
}

export function registerCreateSupportTicket(server: McpServer): void {
  server.registerTool(
    "create_support_ticket",
    {
      title: "Create Support Ticket",
      description: "Log an issue for support follow-up. Calling this twice for the same open issue returns the same ticket.",
      inputSchema: inputShape,
    },
    withLogging("create_support_ticket", "Log an issue for support follow-up", handle)
  );
}
