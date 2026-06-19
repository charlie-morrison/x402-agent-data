// x402-gated pay-per-call API — v6 (side-hustle, 2026-06-18)
//
// WHY v6 (strict additive superset of v5): folds in a REAL JSON-RPC MCP server at POST /mcp
// (Streamable HTTP, stateless) so we are a listable REMOTE MCP server. The Official MCP
// Registry (Anthropic/GitHub/PulseMCP) is NON-GATED (GitHub-OIDC namespace, no KYC) — a
// better discovery surface than the KYC-blocked Coinbase CDP Bazaar. The 3 MCP tools PROXY
// to the same paid x402 endpoints (unpaid → decoded x402 challenge; with `x402_payment` →
// forwarded as X-PAYMENT → real data). Single process; express.json scoped to /mcp so paid
// GET routes are untouched. v5 stays instant rollback.
//
// --- v5 rationale ---
// WHY v5 (strict additive superset of v4 — all 3 paid endpoints byte-identical):
//   Day-9 read: /signal live, $0 organic, root cause = DISCOVERABILITY, not the product.
//   We are findable on x402scan + 402index, but absent from the two discovery surfaces
//   that NON-x402-native agent frameworks crawl:
//     1. MCP (Model Context Protocol) — MCP-aware agents look for /.well-known/mcp.json
//     2. A2A (Agent2Agent)            — A2A agents look for /.well-known/agent.json
//   v5 ADDS both manifests (free routes) describing the same 3 paid x402 endpoints so an
//   MCP/A2A agent can discover + pay them. Zero account, zero KYC, additive, reversible.
//
//   v5 ALSO wires an OPTIONAL Coinbase CDP facilitator (06-17 green-lit plan) behind env:
//   if CDP_API_KEY_ID is set we route settlement through the CDP facilitator (→ native
//   Coinbase Bazaar catalog on first settle); otherwise we keep the xpay facilitator
//   path BYTE-IDENTICAL to v4. No keys yet → behaviour is exactly v4 + 2 new free routes.
//
// Superset of v4: / , /healthz , /.well-known/x402(.json) , /extract , /audit , /signal
// all unchanged. New: /.well-known/mcp.json , /.well-known/agent.json.

import express from "express";
import { auditRepo } from "./audit.js";
import { extractUrl } from "./extract.js";
import { marketSignal } from "./marketdata.js";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { generateJwt } from "@coinbase/cdp-sdk/auth"; // CDP facilitator JWT auth (env-gated)

const PAY_TO = process.env.PAY_TO || "0x435afaC555fe115f18e657E49960063c12C6AEd0";
const NETWORK = process.env.NETWORK || "eip155:8453"; // CAIP-2, Base mainnet
const PORT = process.env.PORT || 4021;
const SYNC_ON_START = process.env.SYNC_FACILITATOR === "1";
const ORIGIN = process.env.ORIGIN || "https://x402.charliemorrison.dev";

// ---- facilitator selection (xpay default; CDP optional, env-gated, 06-17 plan) ----
// Default path is byte-identical to v4. CDP path only activates when CDP_API_KEY_ID is
// present (keys come from KeePass "Coinbase CDP - x402" once the dev account exists).
const CDP_KEY_ID = process.env.CDP_API_KEY_ID || "";
const CDP_FACILITATOR_URL =
  process.env.CDP_FACILITATOR_URL || "https://api.cdp.coinbase.com/platform/v2/x402";
const XPAY_FACILITATOR =
  process.env.FACILITATOR || "https://facilitator.xpay.sh";
const CDP_KEY_SECRET = process.env.CDP_API_KEY_SECRET || "";
const USE_CDP = CDP_KEY_ID.length > 0 && CDP_KEY_SECRET.length > 0;
const FACILITATOR = USE_CDP ? CDP_FACILITATOR_URL : XPAY_FACILITATOR;

// CDP facilitator auth: sign a short-lived Ed25519 JWT per operation. The x402 client
// fetches `${FACILITATOR}/{verify|settle|supported}`, so the JWT 'uri' claim
// (method+host+path) must match each endpoint exactly or CDP returns 401.
function buildCdpAuthHeaders() {
  const u = new URL(CDP_FACILITATOR_URL);
  const host = u.host; // api.cdp.coinbase.com
  const base = u.pathname.replace(/\/$/, ""); // /platform/v2/x402
  const sign = async (method, op) => {
    const jwt = await generateJwt({
      apiKeyId: CDP_KEY_ID,
      apiKeySecret: CDP_KEY_SECRET,
      requestMethod: method,
      requestHost: host,
      requestPath: `${base}/${op}`,
      expiresIn: 120,
    });
    return { Authorization: `Bearer ${jwt}` };
  };
  return async () => ({
    verify: await sign("POST", "verify"),
    settle: await sign("POST", "settle"),
    supported: await sign("GET", "supported"),
  });
}

const EXTRACT_ROUTE = "/extract";
const EXTRACT_PRICE = process.env.EXTRACT_PRICE || "$0.002"; // cheap → loop-friendly
const AUDIT_ROUTE = "/audit";
const AUDIT_PRICE = process.env.AUDIT_PRICE || "$0.005";
const SIGNAL_ROUTE = "/signal";
const SIGNAL_PRICE = process.env.SIGNAL_PRICE || "$0.005"; // structured market data (in-loop)

const ASSET_USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // native USDC, Base mainnet

const app = express();
app.set("trust proxy", true); // canonical https:// resource behind Caddy TLS

// ---- health + discovery (free) ----------------------------------------------
app.get("/", (_req, res) =>
  res.json({
    service: "agent-web-reader",
    description:
      "Pay-per-call data API for AI agents: structured crypto market signal, web-content " +
      "reader, and GitHub-repo SEO audit — paid per call over x402 (USDC on Base).",
    x402: true,
    x402Version: 2,
    paid_endpoints: {
      [SIGNAL_ROUTE]: { price: SIGNAL_PRICE, network: NETWORK, payTo: PAY_TO, params: "ids" },
      [EXTRACT_ROUTE]: { price: EXTRACT_PRICE, network: NETWORK, payTo: PAY_TO, params: "url" },
      [AUDIT_ROUTE]: { price: AUDIT_PRICE, network: NETWORK, payTo: PAY_TO, params: "owner, repo" },
    },
    free_endpoints: {
      "/": "this discovery doc",
      "/healthz": "liveness",
      "/.well-known/x402.json": "x402 manifest",
      "/.well-known/mcp.json": "MCP discovery manifest",
      "/.well-known/agent.json": "A2A agent card",
      "/mcp": "MCP server (JSON-RPC, Streamable HTTP, POST)",
    },
  })
);
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---- shared paid-resource catalog (single source of truth for all manifests) ----
const PAID = [
  {
    route: SIGNAL_ROUTE,
    price: SIGNAL_PRICE,
    serviceName: "crypto-market-signal",
    title: "Crypto market signal",
    description:
      "For each CoinGecko id return price, market cap, 24h change, 24h volume, plus a " +
      "derived momentum score (-100..100), a bullish/neutral/bearish signal, and a " +
      "volatility flag — enriched data an agent ingests in a trading/research loop.",
    params: { ids: "Comma-separated CoinGecko ids (e.g. 'bitcoin,ethereum,solana'), max 25" },
    required: ["ids"],
    tags: ["crypto", "market-data", "price", "signal", "trading", "data", "agent-tools"],
    example: { ids: "bitcoin,ethereum" },
  },
  {
    route: EXTRACT_ROUTE,
    price: EXTRACT_PRICE,
    serviceName: "agent-web-reader",
    title: "Web-content reader",
    description:
      "Fetch any http(s) URL and return clean readable text, title/description/canonical, " +
      "and outbound links as JSON — the data an agent ingests on each step of a crawl/RAG loop.",
    params: { url: "Absolute http(s) URL to fetch and extract (e.g. 'https://example.com/article')" },
    required: ["url"],
    tags: ["reader", "scraping", "rag", "web", "data", "agent-tools"],
    example: { url: "https://example.com/article" },
  },
  {
    route: AUDIT_ROUTE,
    price: AUDIT_PRICE,
    serviceName: "github-repo-seo-audit",
    title: "GitHub repo SEO audit",
    description:
      "Score a GitHub repo's README, description, topics, homepage and metadata and return " +
      "a 0-100 score, a grade, and concrete fixes. Input: owner, repo.",
    params: { owner: "GitHub repository owner or org", repo: "GitHub repository name" },
    required: ["owner", "repo"],
    tags: ["github", "seo", "audit", "developer-tools"],
    example: { owner: "facebook", repo: "react" },
  },
];

const priceToAtomic = (p) => String(Math.round(parseFloat(String(p).replace("$", "")) * 1e6)); // USDC 6dp
const inputSchema = (r) => ({
  type: "object",
  properties: Object.fromEntries(Object.entries(r.params).map(([k, d]) => [k, { type: "string", description: d }])),
  required: r.required,
});

// ---- .well-known/x402 manifest (x402-native discovery) ----------------------
const X402_MANIFEST = {
  x402Version: 2,
  name: "agent-web-reader",
  description:
    "Pay-per-call data API for AI agents: crypto market signal, web-content reader, and " +
    "GitHub-repo SEO audit, paid per call over x402 (USDC on Base).",
  resources: PAID.map((r) => ({
    resource: `${ORIGIN}${r.route}`,
    method: "GET",
    price: r.price,
    accepts: [{ scheme: "exact", network: NETWORK, asset: ASSET_USDC_BASE, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
    mimeType: "application/json",
    tags: r.tags,
    input: inputSchema(r),
  })),
};
const serveX402 = (_req, res) => res.json(X402_MANIFEST);
app.get("/.well-known/x402.json", serveX402);
app.get("/.well-known/x402", serveX402);

// ---- .well-known/mcp.json (MCP discovery manifest) --------------------------
// Lets MCP-aware agents discover our endpoints as payable tools. Each tool carries an
// `x402` payment block (resource URL + price + network + asset + payTo) so an MCP client
// with an x402 wallet can pay-and-call. Not the JSON-RPC transport itself — a discovery
// pointer (the on-chain rail is x402, surfaced here for MCP crawlers).
const MCP_MANIFEST = {
  schema_version: "2025-06-18",
  name: "agent-web-reader",
  description:
    "Pay-per-call data tools for AI agents (crypto market signal, web reader, GitHub SEO " +
    "audit), settled per call via x402 (USDC on Base). No API key, no signup — pay-per-use.",
  provider: { name: "Charlie Morrison", url: ORIGIN },
  transport: { type: "streamable-http", endpoint: `${ORIGIN}/mcp` },
  payment: { protocol: "x402", version: 2, network: NETWORK, asset: ASSET_USDC_BASE, payTo: PAY_TO },
  tools: PAID.map((r) => ({
    name: r.serviceName.replace(/-/g, "_"),
    title: r.title,
    description: r.description,
    inputSchema: inputSchema(r),
    annotations: { readOnlyHint: true, openWorldHint: true },
    x402: {
      resource: `${ORIGIN}${r.route}`,
      method: "GET",
      price: r.price,
      maxAmountRequired: priceToAtomic(r.price),
      network: NETWORK,
      asset: ASSET_USDC_BASE,
      payTo: PAY_TO,
      example: r.example,
    },
  })),
};
app.get("/.well-known/mcp.json", (_req, res) => res.json(MCP_MANIFEST));

// ---- .well-known/agent.json (A2A Agent Card) --------------------------------
// Agent2Agent discovery card. Skills map 1:1 to paid endpoints; each carries x402
// payment metadata under `extensions` so an A2A client can pay-and-invoke.
const AGENT_CARD = {
  protocolVersion: "0.2.0",
  name: "agent-web-reader",
  description:
    "Pay-per-call data agent: crypto market signal, web-content reader, and GitHub-repo " +
    "SEO audit. Each skill is settled per call via x402 (USDC on Base) — no API key, no signup.",
  url: ORIGIN,
  version: "5.0.0",
  provider: { organization: "Charlie Morrison", url: ORIGIN },
  capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
  defaultInputModes: ["application/json"],
  defaultOutputModes: ["application/json"],
  skills: PAID.map((r) => ({
    id: r.serviceName,
    name: r.title,
    description: r.description,
    tags: r.tags,
    examples: [`${ORIGIN}${r.route}?${new URLSearchParams(r.example).toString()}`],
    inputModes: ["application/json"],
    outputModes: ["application/json"],
    extensions: [
      {
        uri: "https://x402.org/protocol",
        description: "x402 pay-per-call settlement",
        params: {
          resource: `${ORIGIN}${r.route}`,
          method: "GET",
          price: r.price,
          maxAmountRequired: priceToAtomic(r.price),
          network: NETWORK,
          asset: ASSET_USDC_BASE,
          payTo: PAY_TO,
        },
      },
    ],
  })),
};
app.get("/.well-known/agent.json", (_req, res) => res.json(AGENT_CARD));
app.get("/.well-known/agent-card.json", (_req, res) => res.json(AGENT_CARD)); // newer A2A alias

// ---- paid handlers ----------------------------------------------------------
async function handleExtract(req, res) {
  try {
    const result = await extractUrl(req.query.url);
    res.status(200).json(result);
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
}
async function handleAudit(req, res) {
  try {
    const { owner, repo } = req.query;
    const result = await auditRepo(owner, repo);
    res.status(result.error ? 400 : 200).json(result);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
async function handleSignal(req, res) {
  try {
    const result = await marketSignal(req.query.ids);
    if (result.error) return res.status(400).json(result);
    result.asof = new Date().toISOString(); // stamp at request time
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}

// ---- v2 payment gating ------------------------------------------------------
const facilitatorClient = new HTTPFacilitatorClient(
  USE_CDP
    ? { url: FACILITATOR, createAuthHeaders: buildCdpAuthHeaders() }
    : { url: FACILITATOR }
);
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme())
  .registerExtension(bazaarResourceServerExtension);

const extractDiscovery = declareDiscoveryExtension({
  method: "GET",
  input: { url: "https://example.com/article" },
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute http(s) URL to fetch and extract" } },
    required: ["url"],
  },
  output: {
    example: { kind: "html", title: "Example", text: "…", links: [], word_count: 120 },
    schema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        text: { type: "string" },
        links: { type: "array", items: { type: "string" } },
        word_count: { type: "number" },
      },
    },
  },
});

const auditDiscovery = declareDiscoveryExtension({
  method: "GET",
  input: { owner: "facebook", repo: "react" },
  inputSchema: {
    type: "object",
    properties: { owner: { type: "string" }, repo: { type: "string" } },
    required: ["owner", "repo"],
  },
  output: {
    example: { score: 100, grade: "A", fixes: [] },
    schema: { type: "object", properties: { score: { type: "number" }, grade: { type: "string" }, fixes: { type: "array", items: { type: "string" } } } },
  },
});

const signalDiscovery = declareDiscoveryExtension({
  method: "GET",
  input: { ids: "bitcoin,ethereum,solana" },
  inputSchema: {
    type: "object",
    properties: { ids: { type: "string", description: "Comma-separated CoinGecko ids, max 25" } },
    required: ["ids"],
  },
  output: {
    example: {
      source: "coingecko",
      count: 1,
      assets: [{ id: "bitcoin", price_usd: 65000, change_24h_pct: 1.6, signal: "neutral", momentum: 31, volatility: "calm" }],
    },
    schema: {
      type: "object",
      properties: {
        source: { type: "string" },
        count: { type: "number" },
        assets: { type: "array", items: { type: "object" } },
      },
    },
  },
});

const routes = {
  [`GET ${EXTRACT_ROUTE}`]: {
    accepts: [{ scheme: "exact", price: EXTRACT_PRICE, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
    resource: `${ORIGIN}${EXTRACT_ROUTE}`,
    description:
      "Web-content reader: fetch any http(s) URL and return clean readable text, " +
      "title/description/canonical, and outbound links as JSON — the data an agent " +
      "ingests on each step of a crawl or RAG loop. Input: url.",
    mimeType: "application/json",
    serviceName: "agent-web-reader",
    tags: ["reader", "scraping", "rag", "web", "data", "agent-tools"],
    extensions: extractDiscovery,
  },
  [`GET ${AUDIT_ROUTE}`]: {
    accepts: [{ scheme: "exact", price: AUDIT_PRICE, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
    resource: `${ORIGIN}${AUDIT_ROUTE}`,
    description:
      "GitHub repo discoverability & SEO audit: scores a repo's README, description, " +
      "topics, homepage and metadata and returns a 0-100 score, a grade, and fixes. " +
      "Input: owner, repo.",
    mimeType: "application/json",
    serviceName: "github-repo-seo-audit",
    tags: ["github", "seo", "audit", "developer-tools"],
    extensions: auditDiscovery,
  },
  [`GET ${SIGNAL_ROUTE}`]: {
    accepts: [{ scheme: "exact", price: SIGNAL_PRICE, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
    resource: `${ORIGIN}${SIGNAL_ROUTE}`,
    description:
      "Structured crypto market signal: for each CoinGecko id return price, market cap, " +
      "24h change, 24h volume, plus a derived momentum score (-100..100), a bullish/" +
      "neutral/bearish signal, and a volatility flag — enriched data an agent ingests " +
      "in a trading/research loop without computing it itself. Input: ids (comma-separated).",
    mimeType: "application/json",
    serviceName: "crypto-market-signal",
    tags: ["crypto", "market-data", "price", "signal", "trading", "data", "agent-tools"],
    extensions: signalDiscovery,
  },
};

const middleware = paymentMiddleware(routes, resourceServer, undefined, undefined, SYNC_ON_START);
app.use(middleware);
app.get(EXTRACT_ROUTE, handleExtract);
app.get(AUDIT_ROUTE, handleAudit);
app.get(SIGNAL_ROUTE, handleSignal);

// ---- MCP bridge (POST /mcp, Streamable HTTP, stateless) ---------------------
// Each tool proxies to the local paid endpoint (same process, real x402 middleware):
// unpaid → decoded `payment-required` challenge; with x402_payment → X-PAYMENT → data.
const SELF = `http://127.0.0.1:${PORT}`;
const X402_ARG = { x402_payment: z.string().optional().describe("Base64 X-PAYMENT header from your x402 wallet (omit to get the payment challenge)") };
const zShape = (r) => Object.fromEntries(Object.entries(r.params).map(([k, d]) => [k, z.string().describe(d)]));
const qStr = (r, a) => "?" + Object.keys(r.params).filter((k) => a[k] != null).map((k) => `${k}=${encodeURIComponent(a[k])}`).join("&");

async function proxyPaid(path, paymentHeader) {
  const headers = { accept: "application/json" };
  if (paymentHeader) headers["X-PAYMENT"] = paymentHeader;
  const r = await fetch(`${SELF}${path}`, { headers, signal: AbortSignal.timeout(20000) });
  const body = await r.text();
  let json; try { json = JSON.parse(body); } catch { json = { raw: body.slice(0, 2000) }; }
  if (r.status === 402) {
    const pr = r.headers.get("payment-required");
    if (pr) { try { json = JSON.parse(Buffer.from(pr, "base64").toString("utf8")); } catch { json = { payment_required_header: pr }; } }
  }
  return { status: r.status, json, paymentRequired: r.status === 402 };
}

function buildMcpServer() {
  const server = new McpServer({ name: "agent-web-reader", version: "6.0.0" });
  for (const r of PAID) {
    server.registerTool(
      r.serviceName.replace(/-/g, "_"),
      {
        title: r.title,
        description: `Paid (x402, ${r.price} USDC on Base). ${r.description}`,
        inputSchema: { ...zShape(r), ...X402_ARG },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args) => {
        const { x402_payment, ...rest } = args;
        const res = await proxyPaid(`${r.route}${qStr(r, rest)}`, x402_payment);
        if (res.paymentRequired) {
          return {
            content: [{ type: "text", text: `Payment required (x402). Pay USDC on Base, then re-call with the X-PAYMENT header as 'x402_payment'.\n${JSON.stringify(res.json, null, 2)}` }],
            structuredContent: { payment_required: true, challenge: res.json },
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(res.json, null, 2) }],
          structuredContent: typeof res.json === "object" ? res.json : { result: res.json },
          isError: res.status >= 400,
        };
      }
    );
  }
  return server;
}

app.post("/mcp", express.json({ limit: "256kb" }), async (req, res) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String(e?.message || e) });
  }
});
const mcpNoSession = (_req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
app.get("/mcp", mcpNoSession);
app.delete("/mcp", mcpNoSession);

app.listen(PORT, () => {
  console.log(`x402 agent-data server [v6] on :${PORT}`);
  console.log(`  payTo=${PAY_TO} network=${NETWORK} facilitator=${FACILITATOR} (CDP=${USE_CDP}) syncOnStart=${SYNC_ON_START}`);
  console.log(`  paid: GET ${SIGNAL_ROUTE}?ids=<ids> (${SIGNAL_PRICE}) | GET ${EXTRACT_ROUTE}?url=<u> (${EXTRACT_PRICE}) | GET ${AUDIT_ROUTE}?owner=&repo= (${AUDIT_PRICE})`);
  console.log(`  free: / , /healthz , /.well-known/x402.json , /.well-known/mcp.json , /.well-known/agent.json , POST /mcp (MCP)`);
});
