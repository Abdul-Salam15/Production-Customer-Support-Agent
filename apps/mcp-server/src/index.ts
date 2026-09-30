import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, "..", ".env") });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { bearerAuth } from "./auth.js";
import { registerLookupCustomer } from "./tools/lookupCustomer.js";
import { registerLookupTransaction } from "./tools/lookupTransaction.js";
import { registerLookupPayout } from "./tools/lookupPayout.js";
import { registerSearchKnowledgeBase } from "./tools/searchKnowledgeBase.js";
import { registerCreateSupportTicket } from "./tools/createSupportTicket.js";
import { registerCreateEscalation } from "./tools/createEscalation.js";
import { registerRequestContactDetails } from "./tools/requestContactDetails.js";
import { registerLogConversationEvent } from "./tools/logConversationEvent.js";

function buildServer(): McpServer {
  const server = new McpServer({ name: "relaypay-mcp-server", version: "0.1.0" });
  registerLookupCustomer(server);
  registerLookupTransaction(server);
  registerLookupPayout(server);
  registerSearchKnowledgeBase(server);
  registerCreateSupportTicket(server);
  registerCreateEscalation(server);
  registerRequestContactDetails(server);
  registerLogConversationEvent(server);
  return server;
}

// createMcpExpressApp() defaults its DNS-rebinding Host check to only
// 127.0.0.1/localhost/::1, applied ahead of every route. Render serves this
// app under its own public hostname, so without listing it here every
// request — including from Vapi's real MCP tool calls — gets rejected with
// 403 "Invalid Host" before reaching any route. RENDER_EXTERNAL_HOSTNAME is
// set automatically by Render, so this needs no manual per-deploy config.
const allowedHosts = ["127.0.0.1", "localhost", "::1"];
if (process.env.RENDER_EXTERNAL_HOSTNAME) allowedHosts.push(process.env.RENDER_EXTERNAL_HOSTNAME);

const app = createMcpExpressApp({ allowedHosts });

// Unauthenticated, cheap target for uptime/keep-alive pings — /mcp requires
// a bearer token, so a monitor hitting it would always see 403 and
// eventually get auto-disabled by services that give up after repeated
// "failures."
app.get("/health", (_req, res) => {
  res.status(200).type("text/plain").send("ok");
});

app.use("/mcp", bearerAuth);

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null })
  );
});

app.delete("/mcp", (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null })
  );
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`MCP server listening on port ${port}`);
});
