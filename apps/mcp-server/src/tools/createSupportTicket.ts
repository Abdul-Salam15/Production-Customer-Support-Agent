import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { withLogging, type ToolContext } from "../lib/withLogging.js";
import { logAudit } from "../lib/auditLog.js";
import { getVerifiedCustomerId } from "../lib/verification.js";
import { computePriority, confirmSignals, normalizeCategory } from "../lib/priority.js";

// Priority is not an input: it's computed server-side (lib/priority.ts)
// from the category and the caller signals below.
const inputShape = {
  customer_id: z.string().optional(),
  category: z
    .string()
    .describe(
      "What the issue concerns: compliance, account, dispute, payment, or other. 'payment' covers transactions, " +
        "payouts, transfers, and invoices; 'dispute' covers refunds, chargebacks, and cancellations."
    ),
  summary: z
    .string()
    .describe("One plain sentence a specialist can act on, in written form (not phrased for speech)."),
  conversation_id: z.string().optional(),
  related_transaction_id: z
    .string()
    .optional()
    .describe("The transaction reference this is about, exactly as a lookup returned it (e.g. TXN-9001)."),
  related_payout_id: z
    .string()
    .optional()
    .describe("The payout reference this is about, exactly as a lookup returned it (e.g. PAY-7002)."),
  caller_urgent: z
    .boolean()
    .describe(
      "true if the caller expressed frustration, anger, distress, or urgency in their own words or tone — e.g. 'this is " +
        "the third time I'm calling', 'I need this today', 'my business is losing money', repeated complaints, raised " +
        "voice, threats to leave. false for a calm, routine request. Judge from what the caller actually said, not from " +
        "the topic."
    ),
  funds_overdue: z
    .boolean()
    .describe(
      "true if money the caller expected has not arrived after its expected arrival or scheduled date, a payout or " +
        "transaction has failed, or the caller says funds are missing, stuck, or late ('it still hasn't arrived', 'it " +
        "should have landed last week'). false if nothing is late, or the expected date hasn't passed yet."
    ),
  account_restricted: z
    .boolean()
    .describe(
      "true if the caller's account is restricted, suspended, frozen, locked, blocked from payments, or under " +
        "compliance/verification review — whether they told you or a lookup showed it. false otherwise."
    ),
};

type CreateSupportTicketArgs = {
  customer_id?: string;
  category: string;
  summary: string;
  conversation_id?: string;
  related_transaction_id?: string;
  related_payout_id?: string;
  caller_urgent?: boolean;
  funds_overdue?: boolean;
  account_restricted?: boolean;
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

// Tickets and escalations share one RP-#### space: the dashboard and the
// caller both look a case up by reference alone, so the same number in both
// tables made claim/resolve/notes act on whichever table was checked first.
export async function referenceInUse(supabase: SupabaseClient, candidate: string): Promise<boolean> {
  const [{ data: ticket }, { data: escalation }] = await Promise.all([
    supabase.from("support_tickets").select("ticket_id").eq("ticket_id", candidate).maybeSingle(),
    supabase.from("escalations").select("escalation_id").eq("escalation_id", candidate).maybeSingle(),
  ]);
  return ticket !== null || escalation !== null;
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

  const ticketId = await generateUniqueReference((candidate) => referenceInUse(supabase, candidate));

  const signals = await confirmSignals(
    supabase,
    conversationId,
    { callerUrgent: args.caller_urgent, fundsOverdue: args.funds_overdue, accountRestricted: args.account_restricted },
    { transactionId: args.related_transaction_id, payoutId: args.related_payout_id }
  );
  const { priority, basis } = computePriority(normalizeCategory(args.category), signals);

  const { error } = await supabase.from("support_tickets").insert({
    ticket_id: ticketId,
    conversation_id: conversationId,
    // Only the customer verified on this call — a model-supplied id that
    // isn't a real customers row would fail the foreign key and lose the ticket.
    customer_id: await getVerifiedCustomerId(supabase, conversationId),
    category: args.category,
    priority,
    summary: args.summary,
    related_transaction_id: args.related_transaction_id ?? null,
    related_payout_id: args.related_payout_id ?? null,
    status: "open",
  });

  if (error) throw new Error(`support_tickets insert failed: ${error.message}`);

  void logAudit("case", `New ${priority}-priority support ticket created (${ticketId}) — ${basis}.`);

  return { ticket_id: ticketId, status: "open", priority };
}

export function registerCreateSupportTicket(server: McpServer): void {
  server.registerTool(
    "create_support_ticket",
    {
      title: "Create Support Ticket",
      description:
        "Log an issue for the support team to follow up on, when it needs tracking but not a specialist callback " +
        "(use create_escalation when a person must call the caller back). Calling this twice for the same open issue " +
        "returns the same ticket. Priority is computed by the server from the category and the three caller signals — " +
        "report those signals honestly; do not try to set a priority. The returned ticket_id is the only valid reference.",
      inputSchema: inputShape,
    },
    withLogging("create_support_ticket", "Log an issue for support follow-up", handle)
  );
}
