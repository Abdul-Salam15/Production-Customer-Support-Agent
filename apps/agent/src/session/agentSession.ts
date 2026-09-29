// One Agent SDK session per Vapi call ID, kept in memory only. If the
// process restarts mid-call, the map is lost and customLlm.ts falls back to
// rebuilding context from the message history Vapi resends, rather than
// failing (Phase 4.2, step 2).
export interface AgentSessionEntry {
  conversationId: string; // Supabase conversations.conversation_id (uuid)
  sdkSessionId: string | null; // set once the SDK's first message arrives
  turnIndex: number;
}

const sessions = new Map<string, AgentSessionEntry>();

export function getSession(callId: string): AgentSessionEntry | undefined {
  return sessions.get(callId);
}

export function createSession(callId: string, conversationId: string): AgentSessionEntry {
  const entry: AgentSessionEntry = { conversationId, sdkSessionId: null, turnIndex: 0 };
  sessions.set(callId, entry);
  return entry;
}

export function setSdkSessionId(callId: string, sdkSessionId: string): void {
  const entry = sessions.get(callId);
  if (entry) entry.sdkSessionId = sdkSessionId;
}

export function nextTurnIndex(callId: string): number {
  const entry = sessions.get(callId);
  if (!entry) return 0;
  const index = entry.turnIndex;
  entry.turnIndex += 1;
  return index;
}
