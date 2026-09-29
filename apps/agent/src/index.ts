import { loadEnv, getEnv } from "./env.js";
loadEnv();

import express from "express";
import { createVapiRouter } from "./vapi/customLlm.js";

const app = express();
app.use(express.json());
app.use(createVapiRouter());

const env = getEnv();
app.listen(env.PORT, () => {
  console.log(`Agent backend listening on port ${env.PORT}`);
});
