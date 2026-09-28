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

function buildServer(): McpServer {
  const server = new McpServer({ name: "relaypay-mcp-server", version: "0.1.0" });
  registerLookupCustomer(server);
  registerLookupTransaction(server);
  registerLookupPayout(server);
  return server;
}

const app = createMcpExpressApp();

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
