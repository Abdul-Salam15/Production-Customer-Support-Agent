import { loadEnv, getEnv } from "./env.js";
loadEnv();

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createVapiRouter } from "./vapi/customLlm.js";
import { createVapiEventsRouter } from "./vapi/events.js";
import { createContactRouter } from "./contact/contactRoutes.js";
import { createCallEventsRouter } from "./realtime/callEvents.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(createVapiRouter());
app.use(createVapiEventsRouter());
app.use(createContactRouter());
app.use(createCallEventsRouter());

// Browser-exposed, not secret (Section 3) — lets app.js initialize the Vapi
// Web SDK without baking keys into the static files at build time.
app.get("/api/config", (_req, res) => {
  const env = getEnv();
  res.json({ vapiPublicKey: env.VAPI_PUBLIC_KEY, vapiAssistantId: env.VAPI_ASSISTANT_ID });
});

// Unauthenticated, cheap target for uptime/keep-alive pings. /api/config's
// JSON response comes back chunked (no Content-Length) through Render's
// Cloudflare front end, which some monitors misjudge as unbounded/"too
// large" and flag as a failure — a plain-text response avoids that.
app.get("/health", (_req, res) => {
  res.status(200).type("text/plain").send("ok");
});

// Customer site and specialist queue site are one deployed service (Phase 5).
app.use(express.static(join(__dirname, "..", "public")));

// Last-resort safety net: every route already wraps its own async work in
// try/catch (an unhandled rejection would otherwise kill this whole process
// by default, taking down every other in-progress call with it), but this
// catches anything missed rather than silently going down.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (process kept alive):", reason);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception (process kept alive):", error);
});

const env = getEnv();
app.listen(env.PORT, () => {
  console.log(`Agent backend listening on port ${env.PORT}`);
});
