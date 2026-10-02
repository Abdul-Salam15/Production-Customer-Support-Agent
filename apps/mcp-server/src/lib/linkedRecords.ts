import type { SupabaseClient } from "@supabase/supabase-js";

export interface LinkedRecords {
  transactionId: string | null;
  payoutId: string | null;
}

// The reference a case is about. The model's argument is used only if the
// record really exists (both columns are foreign keys — a made-up or
// misheard id would fail the insert and lose the case). If the model left
// it out, fall back to what this call actually looked up successfully:
// the most recent lookup_transaction / lookup_payout on the conversation.
export async function resolveLinkedRecords(
  supabase: SupabaseClient,
  conversationId: string | null,
  supplied: { transactionId?: string; payoutId?: string }
): Promise<LinkedRecords> {
  const [txn, payout] = await Promise.all([
    existing(supabase, "transactions", "transaction_id", supplied.transactionId),
    existing(supabase, "payouts", "payout_id", supplied.payoutId),
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
      const id = await existing(supabase, "payouts", "payout_id", payoutRef);
      if (id) return { transactionId: null, payoutId: id };
    }
    if (txnRef) {
      const id = await existing(supabase, "transactions", "transaction_id", txnRef);
      if (id) return { transactionId: id, payoutId: null };
    }
  }
  return { transactionId: null, payoutId: null };
}

async function existing(
  supabase: SupabaseClient,
  table: "transactions" | "payouts",
  column: "transaction_id" | "payout_id",
  id: string | undefined
): Promise<string | null> {
  if (!id) return null;
  const clean = id.trim().toUpperCase();
  const { data } = await supabase.from(table).select(column).eq(column, clean).maybeSingle();
  return data ? clean : null;
}
