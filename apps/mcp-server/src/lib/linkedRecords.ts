import type { SupabaseClient } from "@supabase/supabase-js";
import { getVerifiedCustomerId } from "./verification.js";

export interface LinkedRecords {
  transactionId: string | null;
  payoutId: string | null;
}

// The reference a case is about. The model's argument is used only if the
// record really exists (both columns are foreign keys — a made-up or
// misheard id would fail the insert and lose the case). If the model left
// it out, fall back to what this call actually looked up successfully:
// the most recent lookup_transaction / lookup_payout on the conversation.
//
// Only records owned by the caller verified on this call are ever linked.
// Knowing a reference isn't proof of owning it: an unverified caller's case
// must not attach someone else's transaction, or a specialist could call a
// stranger back to discuss another customer's payout.
export async function resolveLinkedRecords(
  supabase: SupabaseClient,
  conversationId: string | null,
  supplied: { transactionId?: string; payoutId?: string }
): Promise<LinkedRecords> {
  const verifiedCustomerId = await getVerifiedCustomerId(supabase, conversationId);
  if (!verifiedCustomerId) return { transactionId: null, payoutId: null };
  const owner = verifiedCustomerId;
  const existing = (table: "transactions" | "payouts", column: "transaction_id" | "payout_id", id: string | undefined) =>
    ownedRecord(supabase, table, column, id, owner);

  const [txn, payout] = await Promise.all([
    existing("transactions", "transaction_id", supplied.transactionId),
    existing("payouts", "payout_id", supplied.payoutId),
  ]);
  if (txn || payout || !conversationId) return { transactionId: txn, payoutId: payout };

  const { data: lookups } = await supabase
    .from("tool_calls")
    .select("tool_name, input_summary")
    .eq("conversation_id", conversationId)
    .eq("status", "success")
    .in("tool_name", ["lookup_transaction", "lookup_payout"])
    .order("created_at", { ascending: false })
    .limit(5);

  for (const row of (lookups ?? []) as { tool_name: string; input_summary: string | null }[]) {
    const summary = row.input_summary ?? "";
    const payoutRef = summary.match(/PAY-\d+/i)?.[0]?.toUpperCase();
    const txnRef = summary.match(/TXN-\d+/i)?.[0]?.toUpperCase();
    if (row.tool_name === "lookup_payout" && payoutRef) {
      const id = await existing("payouts", "payout_id", payoutRef);
      if (id) return { transactionId: null, payoutId: id };
    }
    if (txnRef) {
      const id = await existing("transactions", "transaction_id", txnRef);
      if (id) return { transactionId: id, payoutId: null };
    }
  }
  return { transactionId: null, payoutId: null };
}

async function ownedRecord(
  supabase: SupabaseClient,
  table: "transactions" | "payouts",
  column: "transaction_id" | "payout_id",
  id: string | undefined,
  ownerCustomerId: string
): Promise<string | null> {
  if (!id) return null;
  const clean = id.trim().toUpperCase();
  const { data } = await supabase
    .from(table)
    .select(column)
    .eq(column, clean)
    .eq("customer_id", ownerCustomerId)
    .maybeSingle();
  return data ? clean : null;
}
