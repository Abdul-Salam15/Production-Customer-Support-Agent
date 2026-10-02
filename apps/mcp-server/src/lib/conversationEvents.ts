import { getSupabaseClient } from "./supabaseClient.js";

// Events the support team must always see in a call's history. The model
// was asked to log these with log_conversation_event, but only did so some
// of the time (2 calls for 9 escalations), so the tools that cause them now
// record them directly. Best-effort: a logging failure never fails the tool.
export async function recordConversationEvent(
  conversationId: string | null,
  eventType: string,
  summary: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  if (!conversationId) return;
  try {
    const { error } = await getSupabaseClient()
      .from("conversation_events")
      .insert({ conversation_id: conversationId, event_type: eventType, summary, metadata: { ...metadata, source: "server" } });
    if (error) console.error(`conversation_events insert failed (${eventType})`, error.message);
  } catch (error) {
    console.error(`conversation_events insert failed (${eventType})`, error);
  }
}
