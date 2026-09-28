import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { withLogging, type ToolContext } from "../lib/withLogging.js";

const inputShape = {
  conversation_id: z.string().optional(),
  event_type: z.string(),
  summary: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
};

type LogConversationEventArgs = {
  conversation_id?: string;
  event_type: string;
  summary?: string;
  metadata?: Record<string, unknown>;
};

async function handle(args: LogConversationEventArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const supabase = getSupabaseClient();
  const conversationId = ctx.conversationId ?? args.conversation_id ?? null;

  const { error } = await supabase.from("conversation_events").insert({
    conversation_id: conversationId,
    event_type: args.event_type,
    summary: args.summary ?? null,
    metadata: args.metadata ?? null,
  });

  if (error) throw new Error(`conversation_events insert failed: ${error.message}`);

  return { logged: true };
}

export function registerLogConversationEvent(server: McpServer): void {
  server.registerTool(
    "log_conversation_event",
    {
      title: "Log Conversation Event",
      description: "Log an important agent action or decision for this conversation.",
      inputSchema: inputShape,
    },
    withLogging("log_conversation_event", "Record an agent action or decision", handle)
  );
}
