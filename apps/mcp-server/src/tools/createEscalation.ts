import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { getVerifiedCustomerId } from "../lib/verification.js";
import { withLogging, type ToolContext } from "../lib/withLogging.js";
import { generateUniqueReference, referenceInUse } from "./createSupportTicket.js";
import { sendEmail } from "../lib/mailer.js";
import { logAudit } from "../lib/auditLog.js";
import { computePriority, confirmSignals } from "../lib/priority.js";
import { resolveLinkedRecords } from "../lib/linkedRecords.js";
import { spokenCallbackTime } from "../lib/spokenTime.js";

const inputShape = {
  ticket_id: z.string().optional(),
  customer_id: z.string().optional(),
  conversation_id: z.string().optional(),
  user_name: z.string(),
  user_email: z.string(),
  category: z
    .enum(["compliance", "account", "dispute", "payment", "other"])
    .describe(
      "compliance: identity/KYC/verification or regulatory concerns. account: account access, restrictions, " +
        "suspensions, balances, or account-specific questions. dispute: disputes, refunds, chargebacks, cancellations. " +
        "payment: transactions, payouts, transfers, or invoices that are late, failed, or wrong. other: anything else."
    ),
  reason: z
    .string()
    .describe(
      "One plain written sentence a specialist can act on — what the caller needs and any reference involved " +
        "(e.g. 'Payout PAY-7002 to Kente Labs has not arrived; caller needs an update'). Not phrased for speech."
    ),
  preferred_time: z
    .string()
    .optional()
    .describe(
      "Only if the caller spoke a callback time aloud (a submitted contact form's time is used automatically). " +
        "Written form, e.g. 'Fri 30 Oct, 14:00 WAT' — never spelled out for speech."
    ),
  related_transaction_id: z
    .string()
    .optional()
    .describe("A transaction reference this concerns, exactly as a lookup returned it. Used to confirm lateness."),
  related_payout_id: z
    .string()
    .optional()
    .describe("A payout reference this concerns, exactly as a lookup returned it. Used to confirm lateness."),
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

type CreateEscalationArgs = {
  ticket_id?: string;
  customer_id?: string;
  conversation_id?: string;
  user_name: string;
  user_email: string;
  category: "compliance" | "account" | "dispute" | "payment" | "other";
  reason: string;
  preferred_time?: string;
  related_transaction_id?: string;
  related_payout_id?: string;
  caller_urgent?: boolean;
  funds_overdue?: boolean;
  account_restricted?: boolean;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Best-effort notification, never the source of truth: the escalation row
// above is already committed by the time this runs, so an email provider
// outage or bad credentials must not surface as a tool failure to the caller.
async function notifyEscalationCreated(args: {
  escalationId: string;
  priority: string;
  category: string;
  reason: string;
  userName: string;
  userEmail: string;
  preferredTime?: string;
}): Promise<void> {
  const teamEmail = process.env.SUPPORT_TEAM_EMAIL;

  const internalSend = teamEmail
    ? sendEmail({
        to: teamEmail,
        subject: `[${args.priority.toUpperCase()}] New escalation ${args.escalationId} (${args.category})`,
        text: [
          `Escalation ${args.escalationId} was just created.`,
          ``,
          `Priority: ${args.priority}`,
          `Category: ${args.category}`,
          `Reason: ${args.reason}`,
          `Contact: ${args.userName} <${args.userEmail}>`,
          args.preferredTime ? `Preferred callback time: ${args.preferredTime}` : null,
        ]
          .filter((line) => line !== null)
          .join("\n"),
      })
    : Promise.resolve();

  const customerSend = sendEmail({
    to: args.userEmail,
    subject: `We've received your request — reference ${args.escalationId}`,
    text: [
      `Hi ${args.userName},`,
      ``,
      `Thanks for reaching out. A specialist will follow up on your ${args.category} request.`,
      ``,
      `Reference: ${args.escalationId}`,
      args.preferredTime ? `Callback time: ${args.preferredTime}` : null,
      ``,
      `— RelayPay Support`,
    ]
      .filter((line) => line !== null)
      .join("\n"),
  });

  const results = await Promise.allSettled([internalSend, customerSend]);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("createEscalation: notification email failed", result.reason);
    }
  }
}

// A value the customer typed into the contact form (Phase 4.5) and the
// server stored is authoritative; a value the model transcribed from speech
// is not.
async function getStoredContactSubmission(
  supabase: SupabaseClient,
  conversationId: string | null
): Promise<{ name: string; email: string; callback_time: string | null } | null> {
  if (!conversationId) return null;

  const { data } = await supabase
    .from("contact_submissions")
    .select("name, email, callback_time")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  return data ?? null;
}

async function resolveContactDetails(
  supabase: SupabaseClient,
  args: CreateEscalationArgs,
  conversationId: string | null
): Promise<{ userName: string; userEmail: string; preferredTime: string | null }> {
  // A value the customer typed and the server stored is authoritative; a
  // value the model transcribed from speech is not. That includes the
  // callback time: the model's version is phrased for speech ("Friday the
  // thirtieth of October at one oh-four in the morning, West Africa Time"),
  // which is unreadable in the dashboard and emails.
  const stored = await getStoredContactSubmission(supabase, conversationId);
  if (stored) {
    return {
      userName: stored.name,
      userEmail: stored.email,
      preferredTime: stored.callback_time ?? args.preferred_time ?? null,
    };
  }

  const verifiedCustomerId = await getVerifiedCustomerId(supabase, conversationId);
  if (verifiedCustomerId) {
    const { data: customer } = await supabase
      .from("customers")
      .select("contact_name, contact_email")
      .eq("customer_id", verifiedCustomerId)
      .maybeSingle();

    if (customer) {
      return {
        userName: args.user_name || customer.contact_name,
        userEmail: customer.contact_email,
        preferredTime: args.preferred_time ?? null,
      };
    }
  }

  return { userName: args.user_name, userEmail: args.user_email, preferredTime: args.preferred_time ?? null };
}

// The model sometimes fills ticket_id / customer_id with values it made up
// (a reference it invented, a caller's name). Both columns are foreign keys,
// so a made-up value failed the insert — the case never reached the queue
// while the model read the invented reference aloud as if it were real. Only
// a ticket actually created on this call, and only the customer verified on
// this call, are trusted.
async function resolveLinkedTicketId(
  supabase: SupabaseClient,
  ticketId: string | undefined,
  conversationId: string | null
): Promise<string | null> {
  if (!ticketId || !conversationId) return null;
  const { data } = await supabase
    .from("support_tickets")
    .select("ticket_id")
    .eq("ticket_id", ticketId)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  return data?.ticket_id ?? null;
}

async function handle(args: CreateEscalationArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const supabase = getSupabaseClient();
  const conversationId = ctx.conversationId ?? args.conversation_id ?? null;

  const { userName, userEmail, preferredTime } = await resolveContactDetails(supabase, args, conversationId);

  if (!userName || userName.trim().length === 0) {
    return { status: "invalid", error: "missing_name" };
  }
  if (!EMAIL_RE.test(userEmail)) {
    return { status: "invalid", error: "invalid_email" };
  }

  const linked = await resolveLinkedRecords(supabase, conversationId, {
    transactionId: args.related_transaction_id,
    payoutId: args.related_payout_id,
  });
  const signals = await confirmSignals(
    supabase,
    conversationId,
    { callerUrgent: args.caller_urgent, fundsOverdue: args.funds_overdue, accountRestricted: args.account_restricted },
    { transactionId: linked.transactionId ?? undefined, payoutId: linked.payoutId ?? undefined }
  );
  const { priority, basis } = computePriority(args.category, signals);

  const [ticketId, customerId] = await Promise.all([
    resolveLinkedTicketId(supabase, args.ticket_id, conversationId),
    getVerifiedCustomerId(supabase, conversationId),
  ]);

  // Always its own reference; a linked ticket stays linked via ticket_id.
  const escalationId = await generateUniqueReference((candidate) => referenceInUse(supabase, candidate));

  const { error } = await supabase.from("escalations").insert({
    escalation_id: escalationId,
    ticket_id: ticketId,
    conversation_id: conversationId,
    customer_id: customerId,
    user_name: userName,
    user_email: userEmail,
    category: args.category,
    reason: args.reason,
    preferred_time: preferredTime,
    related_transaction_id: linked.transactionId,
    related_payout_id: linked.payoutId,
    priority,
    status: "open",
  });

  if (error) throw new Error(`escalations insert failed: ${error.message}`);

  void logAudit("case", `New ${priority}-priority ${args.category} escalation created (${escalationId}) — ${basis}.`);

  // Not awaited: notifyEscalationCreated already never throws (internally
  // Promise.allSettled'd), but a slow/hanging Gmail connection must not add
  // that latency to the tool call's own response.
  void notifyEscalationCreated({
    escalationId,
    priority,
    category: args.category,
    reason: args.reason,
    userName,
    userEmail,
    preferredTime: preferredTime ?? undefined,
  });

  return {
    escalation_id: escalationId,
    status: "open",
    // What was actually stored (the form's time wins) — the agent must read
    // this back rather than re-derive the time from the conversation.
    callback_time: preferredTime,
    // Say this verbatim — converting the time to words is done here, not by
    // the model, which kept reading 14:00 back as "two thirty-five".
    callback_time_spoken: spokenCallbackTime(preferredTime),
    follow_up_summary: `A ${priority}-priority ${args.category} escalation has been created and a specialist will follow up.`,
  };
}

export function registerCreateEscalation(server: McpServer): void {
  server.registerTool(
    "create_escalation",
    {
      title: "Create Escalation",
      description:
        "Escalate a request that requires a human specialist to call the caller back. Priority is computed by the " +
        "server from the category and the three caller signals (caller_urgent, funds_overdue, account_restricted) — " +
        "report those honestly from what the caller said and what lookups returned; you cannot set a priority. " +
        "Only pass ticket_id if create_support_ticket returned it on this call; never invent one. " +
        "The returned escalation_id is the caller's only valid reference — read exactly that, or none if this call fails.",
      inputSchema: inputShape,
    },
    withLogging("create_escalation", "Escalate a request that requires human support", handle)
  );
}
