import { loadEnv, getEnv } from "./env.js";
loadEnv();

import { setDefaultResultOrder } from "node:dns";
// Render's containers have no outbound IPv6 route; Node 18+ otherwise tries
// a resolved IPv6 address first and fails with ENETUNREACH before ever
// falling back to IPv4 — this hit Gmail SMTP specifically (smtp.gmail.com
// resolves to both). Forces every dns.lookup in this process to prefer
// IPv4, process-wide.
setDefaultResultOrder("ipv4first");

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createVapiRouter } from "./vapi/customLlm.js";
import { createVapiEventsRouter } from "./vapi/events.js";
import { createContactRouter } from "./contact/contactRoutes.js";
import { createCallEventsRouter } from "./realtime/callEvents.js";
import { createDashboardRouter } from "./dashboard/routes.js";
import { createCustomerRouter } from "./customer/routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
// Render sits behind a reverse proxy — without this, req.protocol always
// reports "http" even over a real https:// connection, which would send
// invite emails an http:// redirectTo link.
app.set("trust proxy", true);
app.use(express.json());
app.use(createVapiRouter());
app.use(createVapiEventsRouter());
app.use(createContactRouter());
app.use(createCallEventsRouter());
app.use(createDashboardRouter());
app.use(createCustomerRouter());

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

// One staff dashboard page behind three paths. /login is the universal,
// role-agnostic entry point; auth.js redirects the browser to /admin or
// /specialist right after a successful sign-in, based on the logged-in
// profile's role — not whichever of these paths was used to arrive here.
app.get(["/login", "/admin", "/specialist"], (_req, res) => {
  res.sendFile(join(__dirname, "..", "public", "support-queue.html"));
});

// Customer-facing signup + "my calls" — separate page, separate account
// type (customer_accounts) from staff's. /login (above) redirects here via
// GET /api/whoami once it knows a freshly signed-in session is a customer,
// not staff.
app.get(["/signup", "/customer"], (_req, res) => {
  res.sendFile(join(__dirname, "..", "public", "customer-account.html"));
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
