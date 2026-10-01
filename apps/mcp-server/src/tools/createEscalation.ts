import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { getVerifiedCustomerId } from "../lib/verification.js";
import { withLogging, type ToolContext } from "../lib/withLogging.js";
import { generateUniqueReference } from "./createSupportTicket.js";
import { sendEmail } from "../lib/mailer.js";
import { logAudit } from "../lib/auditLog.js";

const CATEGORY_PRIORITY: Record<string, "high" | "medium" | "low"> = {
  compliance: "high",
  account: "high",
  dispute: "high",
  payment: "medium",
  other: "low",
};

const inputShape = {
  ticket_id: z.string().optional(),
  customer_id: z.string().optional(),
  conversation_id: z.string().optional(),
  user_name: z.string(),
  user_email: z.string(),
  category: z.enum(["compliance", "account", "dispute", "payment", "other"]),
  reason: z.string(),
  preferred_time: z.string().optional(),
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
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Best-effort notification, never the source of truth: the escalation row
// above is already committed by the time this runs, so a Gmail outage or a
// bad GMAIL_APP_PASSWORD must not surface as a tool failure to the caller.
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

async function escalationIdExists(supabase: SupabaseClient, candidate: string): Promise<boolean> {
  const { data } = await supabase
    .from("escalations")
    .select("escalation_id")
    .eq("escalation_id", candidate)
    .maybeSingle();
  return data !== null;
}

// A value the customer typed into the contact form (Phase 4.5) and the
// server stored is authoritative; a value the model transcribed from speech
// is not.
async function getStoredContactSubmission(
  supabase: SupabaseClient,
  conversationId: string | null
): Promise<{ name: string; email: string } | null> {
  if (!conversationId) return null;

  const { data } = await supabase
    .from("contact_submissions")
    .select("name, email")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  return data ?? null;
}

async function resolveContactDetails(
  supabase: SupabaseClient,
  args: CreateEscalationArgs,
  conversationId: string | null
): Promise<{ userName: string; userEmail: string }> {
  // A value the customer typed and the server stored is authoritative; a
  // value the model transcribed from speech is not.
  const stored = await getStoredContactSubmission(supabase, conversationId);
  if (stored) {
    return { userName: stored.name, userEmail: stored.email };
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
      };
    }
  }

  return { userName: args.user_name, userEmail: args.user_email };
}

async function handle(args: CreateEscalationArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const supabase = getSupabaseClient();
  const conversationId = ctx.conversationId ?? args.conversation_id ?? null;

  const { userName, userEmail } = await resolveContactDetails(supabase, args, conversationId);

  if (!userName || userName.trim().length === 0) {
    return { status: "invalid", error: "missing_name" };
  }
  if (!EMAIL_RE.test(userEmail)) {
    return { status: "invalid", error: "invalid_email" };
  }

  const priority = CATEGORY_PRIORITY[args.category];

  const escalationId = args.ticket_id
    ? args.ticket_id
    : await generateUniqueReference((candidate) => escalationIdExists(supabase, candidate));

  const { error } = await supabase.from("escalations").insert({
    escalation_id: escalationId,
    ticket_id: args.ticket_id ?? null,
    conversation_id: conversationId,
    customer_id: args.customer_id ?? null,
    user_name: userName,
    user_email: userEmail,
    category: args.category,
    reason: args.reason,
    preferred_time: args.preferred_time ?? null,
    priority,
    status: "open",
  });

  if (error) throw new Error(`escalations insert failed: ${error.message}`);

  void logAudit("case", `New ${priority}-priority ${args.category} escalation created (${escalationId}).`);

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
    preferredTime: args.preferred_time,
  });

  return {
    escalation_id: escalationId,
    status: "open",
    follow_up_summary: `A ${priority}-priority ${args.category} escalation has been created and a specialist will follow up.`,
  };
}

export function registerCreateEscalation(server: McpServer): void {
  server.registerTool(
    "create_escalation",
    {
      title: "Create Escalation",
      description: "Escalate a request that requires human support. Priority is derived from category, not model-chosen.",
      inputSchema: inputShape,
    },
    withLogging("create_escalation", "Escalate a request that requires human support", handle)
  );
}
