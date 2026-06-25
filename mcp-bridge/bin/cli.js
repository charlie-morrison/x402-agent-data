#!/usr/bin/env node
// agent-web-reader-mcp — stdio MCP server that bridges to the hosted
// Agent Web Reader x402 service (https://x402.charliemorrison.dev/mcp).
// Drop it into any MCP client (Claude Desktop, Cursor, ...) via npx and it
// exposes the 3 paid tools locally; payment stays x402/USDC on Base, no API key.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const REMOTE = process.env.AGENT_WEB_READER_URL || "https://x402.charliemorrison.dev/mcp";

async function connectRemote() {
  const client = new Client({ name: "agent-web-reader-bridge", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(REMOTE)));
  return client;
}

async function main() {
  const remote = await connectRemote();

  const server = new Server(
    { name: "agent-web-reader", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return await remote.listTools();
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return await remote.callTool({
      name: req.params.name,
      arguments: req.params.arguments ?? {},
    });
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(`agent-web-reader-mcp: bridging stdio → ${REMOTE}\n`);
}

main().catch((err) => {
  process.stderr.write(`agent-web-reader-mcp fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
