import { loadEnv, getEnv } from "./env.js";
loadEnv();

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createVapiRouter } from "./vapi/customLlm.js";
import { createVapiEventsRouter } from "./vapi/events.js";
import { createContactRouter } from "./contact/contactRoutes.js";
import { createCallEventsRouter } from "./realtime/callEvents.js";
import { createDashboardRouter } from "./dashboard/routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(createVapiRouter());
app.use(createVapiEventsRouter());
app.use(createContactRouter());
app.use(createCallEventsRouter());
app.use(createDashboardRouter());

// Browser-exposed, not secret (Section 3) — lets app.js initialize the Vapi
// Web SDK, and support-queue.html initialize a Supabase Auth session,
// without baking keys into the static files at build time. The anon key is
// safe here by design — RLS governs what it can reach — unlike the
// service-role key, which stays server-side only.
app.get("/api/config", (_req, res) => {
  const env = getEnv();
  res.json({
    vapiPublicKey: env.VAPI_PUBLIC_KEY,
    vapiAssistantId: env.VAPI_ASSISTANT_ID,
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
  });
});

// Unauthenticated, cheap target for uptime/keep-alive pings. /api/config's
// JSON response comes back chunked (no Content-Length) through Render's
// Cloudflare front end, which some monitors misjudge as unbounded/"too
// large" and flag as a failure — a plain-text response avoids that.
app.get("/health", (_req, res) => {
  res.status(200).type("text/plain").send("ok");
});

// Clean aliases for the staff dashboard — the same page for both, since the
// page itself already gates admin-only UI/endpoints by the logged-in
// profile's role, not by which URL was used to reach it.
app.get(["/admin", "/specialist"], (_req, res) => {
  res.sendFile(join(__dirname, "..", "public", "support-queue.html"));
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
