// One long-lived Agent SDK session per Vapi call, kept in memory only.
//
// Starting a fresh SDK subprocess on every turn cost several seconds of
// startup before Claude was even contacted (measured 3.4-5.6s locally, more on
// Render), which is what made replies feel slow and let a first turn run past
// Vapi's patience. Instead each call gets one subprocess, started as early as
// possible (Vapi's "in-progress" status-update, via warmCallAgent) and fed one
// user message per turn through a streaming-input queue.
//
// If the process restarts mid-call the map is lost; the next turn just starts
// a new session and customLlm.ts rebuilds context from the message history
// Vapi resends (Phase 4.2, step 2).
import { tmpdir } from "node:os";
import { startup, query, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { getEnv } from "../env.js";
import { getSupabaseClient } from "../supabaseClient.js";
import { buildSystemPrompt } from "../systemPrompt.js";
import { logAudit } from "../auditLog.js";
import { finalizeCall } from "./finalizeCall.js";

// Each SDK process holds roughly 250 MB, so sessions are closed once a call
// goes quiet rather than relying on a call-ended webhook that may not be
// configured.
const IDLE_CLOSE_MS = 3 * 60 * 1000;
const REAP_INTERVAL_MS = 30 * 1000;
// Pre-warming is an optimisation, so it is capped; a turn always gets a
// session regardless of this limit.
const MAX_WARM_SESSIONS = 2;
// Closing an idle session is cheap to undo (the next turn starts a new one),
// but finalizing a call is not — so a call is only finalized as abandoned
// once it has also stayed quiet this much longer with no new session.
const FINALIZE_AFTER_CLOSE_MS = 12 * 60 * 1000;

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = [];
  private waiter: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private ended = false;

  push(text: string): void {
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ value: message, done: false });
    } else {
      this.pending.push(message);
    }
  }

  end(): void {
    this.ended = true;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const next = this.pending.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

interface RunningQuery {
  query: Query;
  messages: AsyncIterator<SDKMessage>;
}

function buildOptions(conversationId: string): Options {
  const env = getEnv();
  return {
    systemPrompt: buildSystemPrompt(),
    model: env.ANTHROPIC_MODEL,
    tools: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    // SDK isolation: without these the subprocess loads every settings source
    // on the machine (user/project/local), CLAUDE.md, and any MCP servers or
    // plugins those define — measured several seconds of extra latency, and it
    // leaked this repo's folder name into replies.
    settingSources: [],
    strictMcpConfig: true,
    cwd: tmpdir(),
    thinking: { type: "disabled" },
    env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
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
        // Our 8 tools must always be visible to the model — deferring them
        // behind tool search risks the model never discovering (or
        // hallucinating the use of) search_knowledge_base, which the system
        // prompt requires before every product/policy answer.
        alwaysLoad: true,
      },
    },
  };
}

async function startRunningQuery(input: InputQueue, options: Options): Promise<RunningQuery> {
  let q: Query;
  try {
    const warm = await startup({ options });
    q = warm.query(input);
  } catch (error) {
    console.error("agentSession: startup() failed, falling back to a cold query()", error);
    q = query({ prompt: input, options });
  }
  return { query: q, messages: q[Symbol.asyncIterator]() };
}

export class CallAgent {
  // conversation_turns row index — only advances for turns actually written.
  turnIndex = 0;
  // Messages actually sent to the SDK, including interrupted ones: the first
  // one carries Vapi's resent history, every later one just the new utterance.
  turnsSent = 0;
  // Things the backend learned out-of-band (e.g. a contact-form submission)
  // that the model must see, prepended to the next turn's message.
  private pendingNotes: string[] = [];
  private readonly input = new InputQueue();
  private readonly ready: Promise<RunningQuery>;
  private turnLock: Promise<void> = Promise.resolve();
  private busy = false;
  private closed = false;
  lastActivity = Date.now();

  constructor(
    readonly callId: string,
    readonly conversationId: string
  ) {
    this.ready = startRunningQuery(this.input, buildOptions(conversationId));
    this.ready.catch((error) => {
      console.error(`agentSession: session for call ${callId} failed to start`, error);
      closeCallAgent(callId);
    });
  }

  addNote(note: string): void {
    this.pendingNotes.push(note);
  }

  takeNotes(): string[] {
    const notes = this.pendingNotes;
    this.pendingNotes = [];
    return notes;
  }

  get isIdle(): boolean {
    return !this.busy;
  }

  // Sends one user message and yields every SDK message for that turn, ending
  // with (and including) its `result` message. Turns on the same call are
  // serialized: each turn reads only after the previous turn's result has
  // been consumed, so the shared message stream never gets out of step.
  async *runTurn(prompt: string): AsyncGenerator<SDKMessage> {
    const previous = this.turnLock;
    let release!: () => void;
    this.turnLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    let reachedResult = false;
    let running: RunningQuery | null = null;
    try {
      await previous;
      if (this.closed) throw new Error(`session for call ${this.callId} is closed`);
      running = await this.ready;
      this.busy = true;
      this.lastActivity = Date.now();
      this.input.push(prompt);
      this.turnsSent++;

      while (true) {
        const { value, done } = await running.messages.next();
        if (done) throw new Error(`session for call ${this.callId} ended unexpectedly`);
        if (value.type === "result") reachedResult = true;
        yield value;
        if (reachedResult) return;
      }
    } catch (error) {
      closeCallAgent(this.callId);
      throw error;
    } finally {
      // If the consumer stopped early, finish this turn quietly so the next
      // turn starts at its own first message, not this one's leftovers.
      if (!reachedResult && running && !this.closed) {
        try {
          await running.query.interrupt();
          while (true) {
            const { value, done } = await running.messages.next();
            if (done || value.type === "result") break;
          }
        } catch {
          closeCallAgent(this.callId);
        }
      }
      this.busy = false;
      this.lastActivity = Date.now();
      release();
    }
  }

  // Barge-in: stop the current reply without killing the session, so the
  // next turn doesn't pay for a new subprocess.
  interrupt(): void {
    if (!this.busy || this.closed) return;
    this.ready
      .then(({ query: q }) => q.interrupt())
      .catch((error) => console.error(`agentSession: interrupt failed for call ${this.callId}`, error));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.end();
    this.ready.then(({ query: q }) => q.close()).catch(() => {});
  }
}

const agents = new Map<string, Promise<CallAgent>>();
const liveAgents = new Map<string, CallAgent>();

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

// search_knowledge_base embeds every question through the `embed-kb`
// Supabase Edge Function, which cold-starts: measured 6.4s on a call's first
// search vs 1-2s once warm. Waking it as the call starts keeps that off the
// caller's first answer. Best-effort; a failure only means a slower search.
function warmEmbeddingFunction(): void {
  getSupabaseClient()
    .functions.invoke("embed-kb", { body: { text: "warm up" } })
    .then(({ error }) => {
      if (error) console.error("agentSession: embed-kb warm-up failed", error.message);
    })
    .catch((error) => console.error("agentSession: embed-kb warm-up failed", error));
}

async function createCallAgent(callId: string): Promise<CallAgent> {
  warmEmbeddingFunction();
  const conversationId = await upsertConversation(callId);
  void logAudit("call", "A new call started.");
  const agent = new CallAgent(callId, conversationId);
  liveAgents.set(callId, agent);
  return agent;
}

export function getOrCreateCallAgent(callId: string): Promise<CallAgent> {
  const existing = agents.get(callId);
  if (existing) return existing;

  const created = createCallAgent(callId);
  agents.set(callId, created);
  created.catch(() => {
    if (agents.get(callId) === created) agents.delete(callId);
  });
  return created;
}

// Called when Vapi reports the call is live, so the SDK subprocess starts
// while the greeting plays instead of after the caller's first sentence.
export function warmCallAgent(callId: string): void {
  if (agents.has(callId) || agents.size >= MAX_WARM_SESSIONS) return;
  getOrCreateCallAgent(callId).catch((error) => {
    console.error(`agentSession: pre-warm failed for call ${callId}`, error);
  });
}

// Returns false when no session for this call is held in memory (e.g. the
// process restarted mid-call), in which case the note can't be delivered.
export function queueCallNote(callId: string, note: string): boolean {
  const agent = liveAgents.get(callId);
  if (!agent) return false;
  agent.addNote(note);
  return true;
}

export function closeCallAgent(callId: string): void {
  const agent = liveAgents.get(callId);
  agents.delete(callId);
  liveAgents.delete(callId);
  agent?.close();
}

const reaper = setInterval(() => {
  const now = Date.now();
  for (const agent of liveAgents.values()) {
    if (agent.isIdle && now - agent.lastActivity > IDLE_CLOSE_MS) {
      const callId = agent.callId;
      closeCallAgent(callId);
      // Backstop for when Vapi's end-of-call webhooks never arrive. Skipped if
      // the caller spoke again (a new session exists); finalizeCall itself is
      // a no-op if a webhook already finalized the call.
      setTimeout(() => {
        if (agents.has(callId)) return;
        finalizeCall(callId, "idle-timeout").catch((error) => {
          console.error(`agentSession: idle finalize failed for call ${callId}`, error);
        });
      }, FINALIZE_AFTER_CLOSE_MS).unref();
    }
  }
}, REAP_INTERVAL_MS);
reaper.unref();
