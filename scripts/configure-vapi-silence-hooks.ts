// Makes the assistant check in on a silent caller, then end the call if
// they still don't respond — the Custom LLM endpoint only runs when the
// caller speaks (Vapi calls /vapi/chat/completions per turn), so there's no
// way for our own backend to speak first. Vapi's own assistant hooks exist
// for exactly this: https://docs.vapi.ai/assistants/assistant-hooks
//
// Two hooks, both on "customer.speech.timeout", both counting from the same
// "time since the caller last spoke" clock (so the 15s hook doesn't wait 15s
// *after* the 10s one — they fire 5 seconds apart, as asked for):
//   10s of silence -> says "Are you still there?"
//   15s of silence -> says a closing line, then ends the call (the tool
//     action, not a spoken phrase match — independent of the separate "End
//     Call Phrases" setting already configured for model-driven goodbyes).
// triggerResetMode "onUserSpeech" means both can fire again later in the same
// call if the caller goes quiet more than once, not just the first time.
//
// Needs the Vapi account's own Private API key (Dashboard -> API Keys) —
// NOT VAPI_PRIVATE_KEY from apps/agent/.env, which is a different, separate
// shared secret for the Custom LLM credential and isn't valid for Vapi's own
// API. Never commit the real key; pass it only as an environment variable.
//
//   VAPI_API_KEY='...' npx tsx scripts/configure-vapi-silence-hooks.ts
import { config as loadEnv } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, "..", "apps", "agent", ".env") });

interface Hook {
  on: string;
  name?: string;
  options?: Record<string, unknown>;
  do: Record<string, unknown>[];
}

const OUR_HOOKS: Hook[] = [
  {
    on: "customer.speech.timeout",
    name: "relaypay_silence_check_in",
    options: { timeoutSeconds: 10, triggerMaxCount: 1, triggerResetMode: "onUserSpeech" },
    do: [{ type: "say", exact: "Are you still there?" }],
  },
  {
    on: "customer.speech.timeout",
    name: "relaypay_silence_hangup",
    options: { timeoutSeconds: 15, triggerMaxCount: 1, triggerResetMode: "onUserSpeech" },
    do: [
      {
        type: "say",
        // The same canonical sign-off the backend appends after a
        // model-driven goodbye (streaming.ts's END_CALL_PHRASE), so a call
        // that ends from silence sounds the same as one that ends normally,
        // and the existing "End Call Phrases" setting is a second, redundant
        // way for Vapi to catch the hangup if the tool action below doesn't.
        exact: "It looks like there might be an issue on your end — feel free to reach out again. Thank you for calling RelayPay. Goodbye.",
      },
      { type: "tool", tool: { type: "endCall" } },
    ],
  },
];

async function vapiFetch(apiKey: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`https://api.vapi.ai${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Vapi API ${init?.method ?? "GET"} ${path} returned ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  const apiKey = process.env.VAPI_API_KEY;
  const assistantId = process.env.VAPI_ASSISTANT_ID;
  if (!apiKey) {
    throw new Error(
      "Set VAPI_API_KEY to the Vapi account's own Private API key (Dashboard -> API Keys) — not VAPI_PRIVATE_KEY, " +
        "which is a different, separate shared secret used for the Custom LLM credential."
    );
  }
  if (!assistantId) throw new Error("VAPI_ASSISTANT_ID must be set (apps/agent/.env already has it).");

  const assistant = await vapiFetch(apiKey, `/assistant/${assistantId}`);
  const existing: Hook[] = Array.isArray(assistant.hooks) ? assistant.hooks : [];
  const ourNames = new Set(OUR_HOOKS.map((h) => h.name));
  const keep = existing.filter((h) => !ourNames.has(h.name));
  if (keep.length > 0) {
    console.log(`Keeping ${keep.length} existing hook(s) not managed by this script:`, keep.map((h) => h.name ?? h.on));
  }
  const merged = [...keep, ...OUR_HOOKS];

  const updated = await vapiFetch(apiKey, `/assistant/${assistantId}`, {
    method: "PATCH",
    body: JSON.stringify({ hooks: merged }),
  });

  console.log(`Updated assistant ${assistantId}. Hooks now:`);
  console.log(JSON.stringify(updated.hooks, null, 2));
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
