import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { withLogging, type ToolContext } from "../lib/withLogging.js";

const inputShape = {
  query: z.string(),
};

type SearchKnowledgeBaseArgs = {
  query: string;
};

interface MatchRow {
  id: number;
  source_title: string;
  source_summary: string;
  content: string;
  combined_score: number;
}

// Chosen by testing real queries against the ingested knowledge base:
// on-topic queries (e.g. "Can I create invoices in multiple currencies?")
// scored 0.88-0.95; off-topic queries (e.g. "What's the weather in Lagos?",
// "Can you help me book a flight to Paris?") scored 0.44-0.47 — a wide,
// clean gap. 0.6 sits comfortably in the middle.
const SUFFICIENT_CONTEXT_THRESHOLD = 0.6;

async function handle(args: SearchKnowledgeBaseArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const supabase = getSupabaseClient();

  const { data: embedData, error: embedError } = await supabase.functions.invoke("embed-kb", {
    body: { text: args.query },
  });
  if (embedError) throw new Error(`embed-kb failed: ${embedError.message}`);

  const { data, error } = await supabase.rpc("match_kb_chunks", {
    query_embedding: embedData.embedding,
    query_text: args.query,
    match_count: 3,
  });
  if (error) throw new Error(`match_kb_chunks failed: ${error.message}`);

  const rows = (data ?? []) as MatchRow[];
  const topScore = rows.length > 0 ? rows[0].combined_score : 0;
  const sufficientContext = topScore >= SUFFICIENT_CONTEXT_THRESHOLD;

  const chunks = rows.map((row) => ({
    source_title: row.source_title,
    source_summary: row.source_summary,
    content: row.content,
  }));

  // Not awaited: the log is bookkeeping, and the caller is waiting on this
  // tool's result with a live voice call.
  supabase
    .from("retrieval_logs")
    .insert({
      conversation_id: ctx.conversationId,
      query: args.query,
      chunk_ids: rows.map((row) => String(row.id)),
      source_titles: chunks.map((chunk) => chunk.source_title),
      source_summaries: chunks.map((chunk) => chunk.source_summary),
      sufficient_context: sufficientContext,
    })
    .then(({ error: logError }) => {
      if (logError) console.error("search_knowledge_base: failed to write retrieval_logs row", logError.message);
    });

  return { sufficient_context: sufficientContext, chunks };
}

export function registerSearchKnowledgeBase(server: McpServer): void {
  server.registerTool(
    "search_knowledge_base",
    {
      title: "Search Knowledge Base",
      description: "Hybrid (vector + keyword) search over the RelayPay knowledge base. Required before any product or policy answer.",
      inputSchema: inputShape,
    },
    withLogging("search_knowledge_base", "Retrieve grounding context for a product/policy question", handle)
  );
}
