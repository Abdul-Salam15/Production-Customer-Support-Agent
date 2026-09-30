import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withLogging, type ToolContext } from "../lib/withLogging.js";

const inputShape = {
  conversation_id: z.string().optional(),
};

type RequestContactDetailsArgs = {
  conversation_id?: string;
};

// Signal-only: collects nothing itself. The agent backend (Phase 4.2) turns
// this into a "show contact form" event pushed to the frontend, so the
// customer's own typed input becomes the source of truth, not the model's
// transcription of speech.
async function handle(_args: RequestContactDetailsArgs, _ctx: ToolContext): Promise<Record<string, unknown>> {
  return { requested: true };
}

export function registerRequestContactDetails(server: McpServer): void {
  server.registerTool(
    "request_contact_details",
    {
      title: "Request Contact Details",
      description:
        "Shows the caller an on-screen form (name, email, preferred callback time) they can fill in themselves, " +
        "instead of speaking those details aloud. Call this whenever you need the caller's contact details for a " +
        "callback or escalation — always as the default, not only when asked. Does not collect or store anything " +
        "itself; the caller's own submission is the source of truth.",
      inputSchema: inputShape,
    },
    withLogging("request_contact_details", "Signal that a contact form is needed", handle)
  );
}
