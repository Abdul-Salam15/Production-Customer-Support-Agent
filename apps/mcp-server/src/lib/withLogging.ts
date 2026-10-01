import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { getSupabaseClient } from "./supabaseClient.js";
import { logAudit } from "./auditLog.js";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// "amara@lagosledger.example" -> "am***@lagosledger.example"
function maskEmails(text: string): string {
  return text.replace(EMAIL_RE, (match) => {
    const [local, domain] = match.split("@");
    return `${local.slice(0, 2)}***@${domain}`;
  });
}

function summarize(value: unknown, maxLength = 500): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const masked = maskEmails(text ?? "");
  return masked.length > maxLength ? `${masked.slice(0, maxLength)}…` : masked;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export function getConversationId(extra: Extra): string | null {
  const headers = extra.requestInfo?.headers;
  const raw = headers?.["x-conversation-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface ToolContext {
  conversationId: string | null;
}

type ToolHandler<Args> = (args: Args, ctx: ToolContext) => Promise<Record<string, unknown>>;

// Wraps every tool handler: records start time and duration, writes a
// tool_calls row (masked input_summary, result_summary, status,
// error_message), and never lets a logging failure crash the tool call.
export function withLogging<Args extends Record<string, unknown>>(
  toolName: string,
  purpose: string,
  handler: ToolHandler<Args>
) {
  return async (args: Args, extra: Extra) => {
    const start = Date.now();
    const conversationId = getConversationId(extra);

    let status: "success" | "error" = "success";
    let errorMessage: string | null = null;
    let output: Record<string, unknown>;

    try {
      output = await handler(args, { conversationId });
    } catch (err) {
      status = "error";
      errorMessage = err instanceof Error ? err.message : String(err);
      output = { error: "internal_error" };
    }

    const durationMs = Date.now() - start;

    try {
      const supabase = getSupabaseClient();
      await supabase.from("tool_calls").insert({
        conversation_id: conversationId,
        tool_name: toolName,
        purpose,
        input_summary: summarize(args),
        result_summary: summarize(output),
        status,
        error_message: errorMessage,
        duration_ms: durationMs,
      });
    } catch (logError) {
      console.error(`withLogging: failed to write tool_calls row for ${toolName}`, logError);
    }

    // Plain-English line for the admin-facing Audit Logs tab — `purpose` is
    // already written as a human-readable description (e.g. "Check payout
    // status for the caller's question"), unlike `toolName`/`args`.
    void logAudit("tool", status === "success" ? purpose : `${purpose} — failed`);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(output) }],
      structuredContent: output,
      isError: status === "error",
    };
  };
}
