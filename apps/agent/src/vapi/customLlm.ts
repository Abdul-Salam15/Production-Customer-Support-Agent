import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getEnv } from "../env.js";
import { getSupabaseClient } from "../supabaseClient.js";
import { buildSystemPrompt } from "../systemPrompt.js";
import { getSession, createSession, setSdkSessionId, nextTurnIndex } from "../session/agentSession.js";
import { createTagStrippingBuffer, stripTag, writeSseChunk, writeSseDone, newChunkId } from "./streaming.js";

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

export function registerCustomLlmRoute(router: Router): void {
  router.post("/vapi/chat/completions", bearerAuth, async (req: Request, res: Response) => {
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

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const chunkId = newChunkId();
    const modelName = body.model ?? env.ANTHROPIC_MODEL;
    const tagBuffer = createTagStrippingBuffer();

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
            const toForward = tagBuffer.push(event.delta.text);
            writeSseChunk(res, modelName, chunkId, toForward);
          }
        } else if (message.type === "result") {
          sawResult = true;
          finalText = message.subtype === "success" ? message.result : "";
        }
      }
    } catch (error) {
      console.error("customLlm: Agent SDK query failed", error);
    }

    writeSseDone(res, modelName, chunkId);

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
  });
}

export function createVapiRouter(): Router {
  const router = createRouter();
  registerCustomLlmRoute(router);
  return router;
}
