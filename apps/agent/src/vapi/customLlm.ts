import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { getEnv } from "../env.js";
import { getSupabaseClient } from "../supabaseClient.js";
import { getOrCreateCallAgent, type CallAgent } from "../session/agentSession.js";
import { createAbortController } from "../session/abort.js";
import { createTagStrippingBuffer, stripTag, writeSseChunk, writeSseDone, newChunkId, END_CALL_PHRASE } from "./streaming.js";
import { OutputGuard, extractInternalPhrases, logGuardBlock, type GuardContext } from "../outputGuard.js";
import { publishCallEvent, type CallEvent } from "../realtime/callEvents.js";
import { speakReferences } from "./spokenReferences.js";
import { NarrationFilter } from "./narrationFilter.js";
import { PreToolGate } from "./preToolGate.js";
import { needsReview, awaitReview, consumeTyped } from "./review.js";

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

async function writeConversationTurns(
  agent: CallAgent,
  customerText: string,
  agentText: string,
  answerType: string | null,
  confidence: string | null,
  customerAt: Date,
  agentAt: Date
): Promise<void> {
  const supabase = getSupabaseClient();
  const customerIndex = agent.turnIndex++;
  const agentIndex = agent.turnIndex++;
  const conversationId = agent.conversationId;

  const { error } = await supabase.from("conversation_turns").insert([
    {
      conversation_id: conversationId,
      turn_index: customerIndex,
      role: "customer",
      transcript: customerText,
      // Real times, not insert time (both rows are written after the reply
      // finishes) — the transcript clocks in call history are built from them.
      created_at: customerAt.toISOString(),
    },
    {
      conversation_id: conversationId,
      turn_index: agentIndex,
      role: "agent",
      transcript: agentText,
      answer_type: answerType,
      confidence,
      created_at: agentAt.toISOString(),
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
              // Shown on the verified caller's own screen, never spoken.
              amount: isVerified ? (result.internal as { amount?: unknown } | undefined)?.amount ?? null : null,
              currency: isVerified ? (result.internal as { currency?: unknown } | undefined)?.currency ?? null : null,
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

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return domain ? `${local.slice(0, 2)}***@${domain}` : email;
}

// The contact form's verified-caller variant shows "We'll contact you at the
// email on file: am***@...". lookup_customer deliberately doesn't return the
// email to the model, so it's fetched here and only ever sent masked.
async function withMaskedAccountEmail(event: CallEvent, customerId: unknown): Promise<CallEvent> {
  if (typeof customerId !== "string" || event.type !== "outcome" || !event.card) return event;
  try {
    const { data } = await getSupabaseClient()
      .from("customers")
      .select("contact_email, contact_name")
      .eq("customer_id", customerId)
      .maybeSingle();
    if (!data?.contact_email) return event;
    return {
      ...event,
      card: {
        ...event.card,
        data: { ...event.card.data, masked_email: maskEmail(data.contact_email), contact_name: data.contact_name },
      },
    };
  } catch (error) {
    console.error("customLlm: failed to load account email for the contact form", error);
    return event;
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

  const turnStartedAt = new Date();
  const callId = body.call?.id ?? `manual-test-${Date.now()}`;
  const userMessage = lastUserMessage(body.messages);
  if (!userMessage) {
    res.status(400).json({ error: "no user message found" });
    return;
  }

  // Usually already started by the "in-progress" status-update webhook, so
  // this resolves immediately instead of paying for SDK startup here.
  const agent = await getOrCreateCallAgent(callId);

  // Vapi signals barge-in by dropping this HTTP connection. Interrupting
  // (rather than killing the session) stops generation for a reply nobody
  // will hear while keeping the subprocess warm for the next turn.
  let interrupted = false;
  const abortController = createAbortController(req, res);
  abortController.signal.addEventListener("abort", () => {
    interrupted = true;
    agent.interrupt();
  });

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Review before sending: hold the turn until the caller approves (or
  // edits) what they said, then answer that text everywhere below — prompt,
  // knowledge-base search, output guard and the logged transcript.
  const typedByCaller = consumeTyped(callId, userMessage.content);
  if (needsReview(callId, userMessage.content, typedByCaller)) {
    // SSE comments keep the connection to Vapi visibly alive while waiting;
    // OpenAI-style stream parsers ignore them.
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(": waiting for the caller to review\n\n");
    }, 5_000);
    const approved = await awaitReview(callId, userMessage.content, abortController.signal);
    clearInterval(keepAlive);
    if (approved === null) {
      // The caller spoke again before sending; Vapi starts a new turn that
      // carries this text forward.
      if (!res.writableEnded) res.end();
      return;
    }
    userMessage.content = approved;
  }
  // search_knowledge_base also searches with the caller's own words (the
  // model's rewritten query sometimes misses), so store them for this turn.
  await getSupabaseClient()
    .from("conversations")
    .update({ current_utterance: userMessage.content.slice(0, 1000) })
    .eq("conversation_id", agent.conversationId)
    .then(({ error }) => {
      if (error) console.error("customLlm: failed to store current utterance", error.message);
    });
  const spokenOrTyped = agent.turnsSent === 0 ? buildPromptFromHistory(body.messages) : userMessage.content;
  // Typed text has no speech-recognition slips: the model shouldn't read a
  // typed email back or second-guess a typed reference. The label is only in
  // the prompt; the transcript keeps the caller's words as they are.
  const utterance = typedByCaller
    ? `${spokenOrTyped.slice(0, spokenOrTyped.length - userMessage.content.length)}(Typed on screen) ${userMessage.content}`
    : spokenOrTyped;
  const notes = agent.takeNotes();
  const prompt = notes.length > 0 ? `${notes.join("\n")}\n\n${utterance}` : utterance;

  const conversationId = agent.conversationId;
  const guardContext = await buildGuardContext(conversationId, userMessage.content);
  const guard = new OutputGuard(guardContext);

  const chunkId = newChunkId();
  const modelName = body.model ?? env.ANTHROPIC_MODEL;
  const pendingToolUses = new Map<string, string>();

  // A turn that uses a tool produces several text blocks (e.g. "Let me check
  // that." before the tool call, then the answer after it). Each block may
  // open with its own tag, and gets a space before it so consecutive blocks
  // aren't spoken as "fees.RelayPay".
  let tagBuffer = createTagStrippingBuffer();
  const narration = new NarrationFilter();
  let streamedTag: ReturnType<typeof tagBuffer.getTag> = { answerType: null, confidence: null, endCall: false };
  let spokenSoFar = "";
  let needsSeparator = false;
  let firstSpokenAt: Date | null = null;
  // The guard releases text on word boundaries, so a reference like
  // "TXN-9001" always arrives here whole and can be rewritten for speech.
  const speak = (raw: string) => {
    if (!raw) return;
    firstSpokenAt ??= new Date();
    const text = speakReferences(raw);
    const out = needsSeparator && spokenSoFar && !/\s$/.test(spokenSoFar) && !/^\s/.test(text) ? ` ${text}` : text;
    needsSeparator = false;
    spokenSoFar += out;
    writeSseChunk(res, modelName, chunkId, out);
  };
  const gate = new PreToolGate(speak);
  // Any text block of the turn may carry end_call=true (in a tool-using turn
  // the final block's tag isn't the first one), so track it separately.
  let endCallTagged = false;
  const rememberTag = () => {
    const tag = tagBuffer.getTag();
    if (tag.answerType && !streamedTag.answerType) streamedTag = tag;
    if (tag.endCall) endCallTagged = true;
  };

  let finalText = "";
  let sawResult = false;

  try {
      for await (const message of agent.runTurn(prompt)) {
        if (message.type === "stream_event") {
          const event = message.event;
          if (event.type === "content_block_start" && event.content_block.type === "text") {
            tagBuffer = createTagStrippingBuffer();
            narration.reset();
            needsSeparator = true;
            gate.startText();
          } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
            // Text written just before a tool call is a lead-in, and often
            // a wrong one ("the docs don't cover that") — never spoken.
            gate.startTool();
          } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            gate.push(narration.push(guard.push(tagBuffer.push(event.delta.text))));
          } else if (event.type === "content_block_stop") {
            // Run the block's tail through the guard now; the gate decides
            // whether it's spoken once we see what comes next.
            gate.push(narration.push(guard.push(tagBuffer.flush())));
            gate.push(narration.push(guard.flushRemaining()));
            gate.push(narration.flush());
            rememberTag();
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
              if (toolName === "lookup_customer" && parsed?.found === true) {
                const internal = parsed.internal as { support_notes?: string | null } | undefined;
                guard.markVerified(extractInternalPhrases(internal?.support_notes));
              }
              const outcomeEvent = buildOutcomeEvent(toolName, parsed, guardContext.isVerified);
              if (outcomeEvent?.type === "outcome" && outcomeEvent.card?.kind === "account_verified") {
                // Not awaited: the extra lookup must not hold up the spoken reply.
                void withMaskedAccountEmail(outcomeEvent, parsed?.customer_id).then((event) =>
                  publishCallEvent(callId, event)
                );
              } else if (outcomeEvent) {
                publishCallEvent(callId, outcomeEvent);
              }
            }
          }
        } else if (message.type === "result") {
          sawResult = true;
          finalText = message.subtype === "success" ? message.result : "";
        }
      }
    } catch (error) {
      console.error(`customLlm: Agent SDK turn failed for call ${callId}`, error);
    }

    if (interrupted) {
      console.log(`customLlm: turn interrupted for call ${callId} (caller talked over the reply)`);
    }

    if (!res.writableEnded) {
      gate.push(narration.push(guard.push(tagBuffer.flush())));
      gate.push(narration.push(guard.flushRemaining()));
      gate.push(narration.flush());
      gate.flush();
      rememberTag();
      // The sign-off Vapi's End Call Phrases listen for: Vapi hangs up once
      // it's spoken. Skipped if the reply was interrupted or the guard
      // replaced it with the fallback line.
      if (endCallTagged && !interrupted && !guard.wasTripped()) speak(` ${END_CALL_PHRASE}`);
      writeSseDone(res, modelName, chunkId);
    }
    rememberTag();

    if (guard.wasTripped()) {
      const reason = guard.getBlockReason();
      if (reason) await logGuardBlock(conversationId, reason, finalText);
    }

    // An interrupted turn was never heard in full, so it isn't recorded —
    // the same as before, when an interruption aborted the whole query.
    if (sawResult && !interrupted) {
      const { text: cleanedText, tag: finalTag } = stripTag(finalText);
      // In a tool-using turn the tag usually leads the first text block, not
      // the final one `result` holds, so fall back to the tag seen in-stream.
      const tag = finalTag.answerType ? finalTag : streamedTag;
      await writeConversationTurns(
        agent,
        userMessage.content,
        cleanedText,
        tag.answerType,
        tag.confidence,
        turnStartedAt,
        firstSpokenAt ?? new Date()
      );
      // The goodbye was heard in full (an interrupted turn never gets here),
      // so tell the browser to hang up once it's done speaking. A
      // tool-using turn only counts if the tag says so on its final text.
      if (endCallTagged || tag.endCall) {
        publishCallEvent(callId, { type: "end_call" });
        void getSupabaseClient()
          .from("conversation_events")
          .insert({
            conversation_id: conversationId,
            event_type: "agent_ended_call",
            summary: "The agent ended the call after the caller said they were done.",
            metadata: { source: "server" },
          })
          .then(({ error }) => {
            if (error) console.error("customLlm: failed to record end-call event", error.message);
          });
      }

      // Recorded by the server, not left to the model: a decline is what the
      // support team reviews to find gaps in the knowledge base.
      if (tag.answerType === "decline") {
        void getSupabaseClient()
          .from("conversation_events")
          .insert({
            conversation_id: conversationId,
            event_type: "declined",
            summary: `Declined: "${userMessage.content.slice(0, 200)}"`,
            metadata: { source: "server" },
          })
          .then(({ error }) => {
            if (error) console.error("customLlm: failed to record decline event", error.message);
          });
      }
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
