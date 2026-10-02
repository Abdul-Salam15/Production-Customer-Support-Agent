// Case priority for create_escalation and create_support_ticket.
//
// The model never picks a priority directly. It reports a category plus
// three yes/no facts about what the caller actually said, and the server
// combines them here. Facts the database can confirm (a verified customer's
// account status, a linked transaction or payout past its expected arrival)
// are checked server-side and can only raise priority, never lower it — so
// a model that misses a signal doesn't bury an urgent case.
//
// Rubric:
//   compliance                      -> high
//   dispute                         -> high
//   account, restricted/suspended   -> high
//   account, otherwise              -> medium   (e.g. a balance review)
//   payment, funds overdue          -> high
//   payment, otherwise              -> medium
//   other                           -> low
//   caller frustrated or urgent     -> one level up (low -> medium -> high)
import type { SupabaseClient } from "@supabase/supabase-js";
import { getVerifiedCustomerId } from "./verification.js";
import { isPastEstimatedArrival } from "./dates.js";

export type Priority = "high" | "medium" | "low";
export type CaseCategory = "compliance" | "account" | "dispute" | "payment" | "other";

export interface PrioritySignals {
  callerUrgent?: boolean;
  fundsOverdue?: boolean;
  accountRestricted?: boolean;
}

export interface PriorityResult {
  priority: Priority;
  // Plain-English basis, for the audit log and the tool result.
  basis: string;
}

// create_support_ticket's category is free text, so map common wordings
// onto the five escalation categories before applying the rubric.
export function normalizeCategory(raw: string): CaseCategory {
  const c = raw.toLowerCase();
  if (/complian|kyc|identity|verif|aml|sanction/.test(c)) return "compliance";
  if (/disput|refund|chargeback|cancel|fraud/.test(c)) return "dispute";
  if (/account|login|access|balance|restrict|suspen/.test(c)) return "account";
  if (/pay|transfer|transaction|invoice|settle|fund/.test(c)) return "payment";
  return "other";
}

const RAISE: Record<Priority, Priority> = { low: "medium", medium: "high", high: "high" };

export function computePriority(category: CaseCategory, signals: PrioritySignals): PriorityResult {
  let priority: Priority;
  let basis: string;

  switch (category) {
    case "compliance":
      priority = "high";
      basis = "compliance or identity concern";
      break;
    case "dispute":
      priority = "high";
      basis = "dispute, refund, or cancellation";
      break;
    case "account":
      priority = signals.accountRestricted ? "high" : "medium";
      basis = signals.accountRestricted ? "account restricted, suspended, or under review" : "general account request";
      break;
    case "payment":
      priority = signals.fundsOverdue ? "high" : "medium";
      basis = signals.fundsOverdue ? "funds overdue past expected arrival" : "payment issue";
      break;
    default:
      priority = "low";
      basis = "general request";
  }

  if (signals.callerUrgent && priority !== "high") {
    priority = RAISE[priority];
    basis += "; raised because the caller was frustrated or urgent";
  } else if (signals.callerUrgent) {
    basis += "; caller frustrated or urgent";
  }

  return { priority, basis };
}

// Server-side confirmation of the signals the database can actually check.
export async function confirmSignals(
  supabase: SupabaseClient,
  conversationId: string | null,
  reported: PrioritySignals,
  related: { transactionId?: string | null; payoutId?: string | null } = {}
): Promise<PrioritySignals> {
  const signals: PrioritySignals = { ...reported };

  const customerId = await getVerifiedCustomerId(supabase, conversationId);
  if (customerId) {
    const { data: customer } = await supabase
      .from("customers")
      .select("account_status, kyc_status")
      .eq("customer_id", customerId)
      .maybeSingle();
    const status = (customer?.account_status ?? "").toLowerCase();
    const kyc = (customer?.kyc_status ?? "").toLowerCase();
    if (status === "restricted" || status === "suspended" || status === "pending verification" || kyc === "review required") {
      signals.accountRestricted = true;
    }
  }

  if (related.transactionId) {
    const { data: txn } = await supabase
      .from("transactions")
      .select("status, estimated_arrival")
      .eq("transaction_id", related.transactionId)
      .maybeSingle();
    const status = (txn?.status ?? "").toLowerCase();
    if (txn && (status === "failed" || status === "delayed" || (status !== "completed" && isPastEstimatedArrival(txn.estimated_arrival)))) {
      signals.fundsOverdue = true;
    }
  }

  if (related.payoutId) {
    const { data: payout } = await supabase
      .from("payouts")
      .select("status, scheduled_for")
      .eq("payout_id", related.payoutId)
      .maybeSingle();
    const status = (payout?.status ?? "").toLowerCase();
    const settled = status === "completed" || status === "paid";
    if (payout && (status === "failed" || (!settled && isPastEstimatedArrival(payout.scheduled_for)))) {
      signals.fundsOverdue = true;
    }
  }

  return signals;
}
