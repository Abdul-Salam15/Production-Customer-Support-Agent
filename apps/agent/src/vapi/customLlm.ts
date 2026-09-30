import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { query, AbortError } from "@anthropic-ai/claude-agent-sdk";
import { getEnv } from "../env.js";
import { getSupabaseClient } from "../supabaseClient.js";
import { buildSystemPrompt } from "../systemPrompt.js";
import { getSession, createSession, setSdkSessionId, nextTurnIndex } from "../session/agentSession.js";
import { createAbortController } from "../session/abort.js";
import { createTagStrippingBuffer, stripTag, writeSseChunk, writeSseDone, newChunkId } from "./streaming.js";
import { OutputGuard, extractInternalPhrases, logGuardBlock, type GuardContext } from "../outputGuard.js";
import { publishCallEvent, type CallEvent } from "../realtime/callEvents.js";

interface VapiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

interface VapiChatCompletionRequest {
  model?: string;
  messages: VapiMessage[];
  stream?: boolean;
  call?: { id?: string };
}

function bearerAuth(req: Request, res: Response, next: () => void): void {
  const expected = getEnv().VAPI_PRIVATE_KEY;
  const header = req.headers["authorization"];
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token || token !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

function lastUserMessage(messages: VapiMessage[]): VapiMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i];
  }
  return undefined;
}

// If the in-memory session was lost (server restart mid-call) but Vapi's
// request still carries prior turns, fold them into one prompt instead of
// failing — a degraded fallback, not the normal path (Phase 4.2, step 2).
function buildPromptFromHistory(messages: VapiMessage[]): string {
  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant");
  if (turns.length <= 1) {
    return turns[0]?.content ?? "";
  }

  const priorTurns = turns.slice(0, -1);
  const latest = turns[turns.length - 1];

  const transcript = priorTurns
    .map((m) => `${m.role === "user" ? "Customer" : "Agent"}: ${m.content}`)
    .join("\n");

  return `[Conversation so far, already handled by a previous agent process — do not respond to it, only to the final message below]\n${transcript}\n\nCustomer: ${latest.content}`;
}

async function upsertConversation(callId: string): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("conversations")
    .upsert({ vapi_call_id: callId }, { onConflict: "vapi_call_id" })
    .select("conversation_id")
    .single();

  if (error || !data) {
    throw new Error(`failed to upsert conversations row: ${error?.message}`);
  }
  return data.conversation_id as string;
}

async function writeConversationTurns(
  conversationId: string,
  callId: string,
  customerText: string,
  agentText: string,
  answerType: string | null,
  confidence: string | null
): Promise<void> {
  const supabase = getSupabaseClient();
  const customerIndex = nextTurnIndex(callId);
  const agentIndex = nextTurnIndex(callId);

  const { error } = await supabase.from("conversation_turns").insert([
    {
      conversation_id: conversationId,
      turn_index: customerIndex,
      role: "customer",
      transcript: customerText,
    },
    {
      conversation_id: conversationId,
      turn_index: agentIndex,
      role: "agent",
      transcript: agentText,
      answer_type: answerType,
      confidence,
    },
  ]);

  if (error) {
    console.error("customLlm: failed to write conversation_turns rows", error.message);
  }
}

async function buildGuardContext(conversationId: string, customerUtterance: string): Promise<GuardContext> {
  const supabase = getSupabaseClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("customer_id")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (!conversation?.customer_id) {
    return { verifiedAccountEmail: null, customerUtterance, internalPhrases: [], isVerified: false };
  }

  const { data: customer } = await supabase
    .from("customers")
    .select("contact_email, support_notes")
    .eq("customer_id", conversation.customer_id)
    .maybeSingle();

  return {
    verifiedAccountEmail: customer?.contact_email ?? null,
    customerUtterance,
    internalPhrases: extractInternalPhrases(customer?.support_notes),
    isVerified: true,
  };
}

// Maps an mcp__relaypay__<tool> invocation to one of app.js's existing
// ACTIVITIES keys (help/account/transactions/payouts/ticket/callback) — not
// free text, since setActivity() only recognizes that fixed vocabulary
// (Stage 8 wiring). log_conversation_event is deliberately absent — it's
// an internal bookkeeping call, not something a caller needs to hear about.
const ACTIVITY_KEY: Partial<Record<string, string>> = {
  lookup_customer: "account",
  lookup_transaction: "transactions",
  lookup_payout: "payouts",
  search_knowledge_base: "help",
  create_support_ticket: "ticket",
  create_escalation: "callback",
  request_contact_details: "callback",
};

function tryParseToolResult(content: unknown): Record<string, unknown> | null {
  if (typeof content === "string") {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (Array.isArray(content)) {
    const textBlock = content.find(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
    );
    if (textBlock) {
      try {
        return JSON.parse(textBlock.text);
      } catch {
        return null;
      }
    }
  }
  return null;
}

// data carries exactly what app.js's statusCardHTML()/setStatusCards() need
// to build a card (Stage 8 wiring) — amount is only included when verified,
// matching the frontend's own "reference-only callers never see it" rule.
function buildOutcomeEvent(
  toolName: string,
  result: Record<string, unknown> | null,
  isVerified: boolean
): CallEvent | null {
  if (!result) return null;

  switch (toolName) {
    case "lookup_customer":
      if (result.found) {
        return {
          type: "outcome",
          card: {
            kind: "account_verified",
            data: { company_name: result.company_name, plan: result.plan, account_status: result.account_status },
          },
        };
      }
      return null;
    case "lookup_transaction":
      if (result.found) {
        return {
          type: "outcome",
          card: {
            kind: "transaction_status",
            data: {
              transaction_id: result.transaction_id,
              status: result.status,
              support_summary: result.support_summary,
              estimated_arrival: result.estimated_arrival,
              past_estimated_arrival: result.past_estimated_arrival,
              amount: isVerified ? result.amount : null,
              currency: isVerified ? result.currency : null,
            },
          },
        };
      }
      return null;
    case "lookup_payout":
      if (result.found) {
        return {
          type: "outcome",
          card: {
            kind: "payout_status",
            data: {
              payout_id: result.payout_id,
              status: result.status,
              failure_reason: result.failure_reason,
              scheduled_for: result.scheduled_for,
              past_estimated_arrival: result.past_estimated_arrival,
            },
          },
        };
      }
      return null;
    case "create_support_ticket":
      if (result.ticket_id) {
        return {
          type: "outcome",
          card: { kind: "ticket_created", data: { ticket_id: result.ticket_id, status: result.status } },
        };
      }
      return null;
    case "create_escalation":
      if (result.escalation_id) {
        return {
          type: "outcome",
          card: {
            kind: "escalation_created",
            data: { escalation_id: result.escalation_id, follow_up_summary: result.follow_up_summary },
          },
        };
      }
      return null;
    case "request_contact_details":
      return { type: "contact_form_requested" };
    default:
      return null;
  }
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
}

async function handleTurn(req: Request, res: Response): Promise<void> {
  const env = getEnv();
  const body = req.body as VapiChatCompletionRequest;

  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    res.status(400).json({ error: "messages is required" });
    return;
  }

  const callId = body.call?.id ?? `manual-test-${Date.now()}`;
  const userMessage = lastUserMessage(body.messages);
  if (!userMessage) {
    res.status(400).json({ error: "no user message found" });
    return;
  }

  let session = getSession(callId);
  let prompt: string;

  if (session) {
    prompt = userMessage.content;
  } else {
    const conversationId = await upsertConversation(callId);
    session = createSession(callId, conversationId);
    prompt = buildPromptFromHistory(body.messages);
  }

  const conversationId = session.conversationId;
  const guardContext = await buildGuardContext(conversationId, userMessage.content);
  const guard = new OutputGuard(guardContext);
  const abortController = createAbortController(req, res);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const chunkId = newChunkId();
  const modelName = body.model ?? env.ANTHROPIC_MODEL;
  const tagBuffer = createTagStrippingBuffer();
  const pendingToolUses = new Map<string, string>();

  let finalText = "";
  let sawResult = false;

  try {
      const q = query({
        prompt,
        options: {
          systemPrompt: buildSystemPrompt(),
          model: env.ANTHROPIC_MODEL,
          tools: [],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          resume: session.sdkSessionId ?? undefined,
          abortController,
          mcpServers: {
            relaypay: {
              type: "http",
              // MCP_SERVER_URL is the service's base origin; the server's
              // Streamable HTTP endpoint is mounted at /mcp.
              url: `${env.MCP_SERVER_URL}/mcp`,
              headers: {
                Authorization: `Bearer ${env.MCP_SERVER_TOKEN}`,
                "x-conversation-id": conversationId,
              },
              // Our 8 tools must always be visible to the model — deferring
              // them behind tool search risks the model never discovering
              // (or hallucinating the use of) search_knowledge_base, which
              // the system prompt requires before every product/policy answer.
              alwaysLoad: true,
            },
          },
        },
      });

      for await (const message of q) {
        if ("session_id" in message && message.session_id) {
          setSdkSessionId(callId, message.session_id);
        }

        if (message.type === "stream_event") {
          const event = message.event;
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            const afterTag = tagBuffer.push(event.delta.text);
            const toForward = guard.push(afterTag);
            writeSseChunk(res, modelName, chunkId, toForward);
          }
        } else if (message.type === "assistant") {
          const content = (message.message?.content ?? []) as unknown[];
          for (const block of content) {
            if ((block as ToolUseBlock)?.type === "tool_use") {
              const toolUse = block as ToolUseBlock;
              const toolName = toolUse.name.replace(/^mcp__relaypay__/, "");
              pendingToolUses.set(toolUse.id, toolName);
              const activityKey = ACTIVITY_KEY[toolName];
              if (activityKey) publishCallEvent(callId, { type: "activity", key: activityKey });
            }
          }
        } else if (message.type === "user") {
          const content = (message.message?.content ?? []) as unknown[];
          for (const block of content) {
            if ((block as ToolResultBlock)?.type === "tool_result") {
              const toolResult = block as ToolResultBlock;
              const toolName = pendingToolUses.get(toolResult.tool_use_id);
              if (!toolName) continue;
              const parsed = tryParseToolResult(toolResult.content);
              const outcomeEvent = buildOutcomeEvent(toolName, parsed, guardContext.isVerified);
              if (outcomeEvent) publishCallEvent(callId, outcomeEvent);
            }
          }
        } else if (message.type === "result") {
          sawResult = true;
          finalText = message.subtype === "success" ? message.result : "";
        }
      }
    } catch (error) {
      if (error instanceof AbortError) {
        console.log(`customLlm: turn aborted for call ${callId} (caller interrupted)`);
      } else {
        console.error("customLlm: Agent SDK query failed", error);
      }
    }

    if (!res.writableEnded) {
      const remaining = guard.flushRemaining();
      if (remaining) writeSseChunk(res, modelName, chunkId, remaining);
      writeSseDone(res, modelName, chunkId);
    }

    if (guard.wasTripped()) {
      const reason = guard.getBlockReason();
      if (reason) await logGuardBlock(conversationId, reason, finalText);
    }

    if (sawResult) {
      const { text: cleanedText, tag } = stripTag(finalText);
      await writeConversationTurns(
        conversationId,
        callId,
        userMessage.content,
        cleanedText,
        tag.answerType,
        tag.confidence
      );
    }
}

export function registerCustomLlmRoute(router: Router): void {
  router.post("/vapi/chat/completions", bearerAuth, async (req: Request, res: Response) => {
    try {
      await handleTurn(req, res);
    } catch (error) {
      // A single failed request must never take down the process — every
      // other in-progress or future call shares this server. Anything
      // thrown here before or around the query() loop (a Supabase hiccup,
      // a bad request) would otherwise become an unhandled rejection, and
      // Node kills the whole process on those by default.
      console.error("customLlm: unhandled error while processing turn", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error" });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });
}

export function createVapiRouter(): Router {
  const router = createRouter();
  registerCustomLlmRoute(router);
  return router;
}
