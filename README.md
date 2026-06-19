# x402-agent-data

Pay-per-call data tools for AI agents, settled per call in **USDC on Base** via the
[**x402** protocol](https://docs.cdp.coinbase.com/x402/welcome). The buyer is another
agent: it discovers an endpoint, auto-pays per request (HTTP 402 → payment → data),
and gets structured JSON back. **No API key, no signup, no account** — the seller's
only setup is one public wallet address.

Live at **https://x402.charliemorrison.dev** — also listed as a remote MCP server in the
[Official MCP Registry](https://registry.modelcontextprotocol.io) as
`dev.charliemorrison/agent-web-reader`.

## Tools

| Tool | Endpoint | Price | Returns |
|------|----------|-------|---------|
| `market_signal` | `GET /signal` | $0.005 | Crypto market signal (price/trend/momentum) for a symbol |
| `web_read` | `GET /extract` | $0.005 | Clean, readable text + metadata extracted from any URL |
| `repo_audit` | `GET /audit?owner=&repo=` | $0.005 | GitHub repo discoverability/SEO score (0–100) + concrete fixes |

Free, unpaid routes:

- `GET /` — discovery doc (service + paid-endpoint metadata, x402-aware)
- `GET /healthz` — liveness
- `GET /.well-known/mcp.json` — MCP discovery manifest
- `GET /.well-known/agent.json` — A2A Agent Card
- `POST /mcp` — **remote MCP server** (Streamable HTTP). Lists the three tools; an
  unpaid `tools/call` returns the decoded x402 payment-required challenge, and a call
  carrying an x402 payment returns the data.

## How payment works

1. Agent calls a paid route with no payment → server responds **HTTP 402** with an
   x402 challenge (amount, asset = USDC, network = `base`, `payTo` address).
2. Agent's x402 client signs a payment authorization and retries with the
   `X-PAYMENT` header.
3. Server verifies/settles via an x402 facilitator and returns the data.

No private key ever lives in this server's config — it only **receives**. Settlement
is delegated to an x402 facilitator (default: a zero-fee, gas-sponsored facilitator;
Coinbase CDP facilitator is supported via env and inert unless configured).

## Run it

```bash
npm install
PAY_TO=0xYourReceivingAddress node server.js   # listens on :4021
```

Environment:

- `PAY_TO` — your receiving wallet (USDC on Base). Required for real revenue.
- `PORT` — default `4021`.
- `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` — optional; switches settlement to the
  Coinbase CDP facilitator. Omitted by default.

## Why this shape

The buyer is a machine and distribution is a registry — there's no cold human
audience to recruit, which is the wall that kills most indie API/tool launches.
Seller setup is a single wallet address; every call is zero-marginal-cost public data.

## License

MIT
