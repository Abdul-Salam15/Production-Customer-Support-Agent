import { getSupabaseClient } from "./supabaseClient.js";

export type AuditCategory = "call" | "tool" | "case" | "email" | "team" | "account";

// Best-effort, fire-and-forget: a logging failure must never affect the
// operation being logged.
export async function logAudit(category: AuditCategory, message: string): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    await supabase.from("audit_log").insert({ category, message });
  } catch (error) {
    console.error("logAudit: failed to write audit_log row", error);
  }
}
