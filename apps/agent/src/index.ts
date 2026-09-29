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

// Customer site and specialist queue site are one deployed service (Phase 5).
app.use(express.static(join(__dirname, "..", "public")));

const env = getEnv();
app.listen(env.PORT, () => {
  console.log(`Agent backend listening on port ${env.PORT}`);
});
