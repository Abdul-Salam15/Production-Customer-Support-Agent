import { loadEnv, getEnv } from "./env.js";
loadEnv();

import express from "express";
import { createVapiRouter } from "./vapi/customLlm.js";
import { createVapiEventsRouter } from "./vapi/events.js";
import { createContactRouter } from "./contact/contactRoutes.js";
import { createCallEventsRouter } from "./realtime/callEvents.js";

const app = express();
app.use(express.json());
app.use(createVapiRouter());
app.use(createVapiEventsRouter());
app.use(createContactRouter());
app.use(createCallEventsRouter());

const env = getEnv();
app.listen(env.PORT, () => {
  console.log(`Agent backend listening on port ${env.PORT}`);
});
