import type { Request, Response } from "express";

// A custom-LLM integration has no explicit "the caller talked over you"
// message — the signal is that Vapi drops the in-flight HTTP connection.
// Detecting that and aborting the Agent SDK call stops token generation
// (and its cost) for a reply nobody will hear (Phase 4.3).
export function createAbortController(req: Request, res: Response): AbortController {
  const controller = new AbortController();

  const onClose = () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  };

  // res.on('close') — not req's — is the reliable Node/Express signal for a
  // client disconnecting mid-response; req's readable side is usually
  // already drained by the time a streaming handler is running.
  res.once("close", onClose);
  return controller;
}
