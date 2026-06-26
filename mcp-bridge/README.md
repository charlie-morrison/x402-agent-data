# agent-web-reader-mcp

A tiny **stdio MCP server** that bridges any MCP client (Claude Desktop, Cursor, Cline, …) to the hosted **Agent Web Reader** x402 service. Three pay-per-call tools for AI agents — **no API key, no signup**. Payment is x402 / USDC on Base, settled per call from the agent's own wallet.

## Tools

- **`crypto_market_signal`** — price, market cap, 24h change/volume + a derived momentum score (−100..100), bullish/neutral/bearish signal and volatility flag for any CoinGecko ids. *$0.005 USDC.*
- **`agent_web_reader`** — clean readable text + title/description/canonical and outbound links as JSON for a URL — the data an agent ingests each crawl/RAG step. *$0.002 USDC.*
- **`github_repo_seo_audit`** — 0–100 discoverability score for a GitHub repo + concrete fixes. *$0.005 USDC.*

## Use

```jsonc
// Claude Desktop / Cursor MCP config
{
  "mcpServers": {
    "agent-web-reader": {
      "command": "npx",
      "args": ["-y", "github:charlie-morrison/agent-web-reader-mcp"]
    }
  }
}
```

Or run directly:

```bash
npx -y github:charlie-morrison/agent-web-reader-mcp
```

Without payment each tool returns the x402 **402 challenge** (scheme `exact`, USDC on Base mainnet). Supply the base64 `X-PAYMENT` header value as the `x402_payment` argument to settle and get the result.

Override the upstream with `AGENT_WEB_READER_URL` (default `https://x402.charliemorrison.dev/mcp`).

## Links

- Service: https://x402.charliemorrison.dev
- Discovery: https://x402.charliemorrison.dev/.well-known/x402
- Official MCP Registry: `dev.charliemorrison/agent-web-reader`

MIT
