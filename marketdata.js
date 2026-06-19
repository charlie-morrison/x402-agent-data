// Structured crypto market-data signal — x402 paid-endpoint candidate (sh-night1, 2026-06-15).
//
// WHY this module exists: the audit (/audit) and reader (/extract) endpoints are
// commodity supply with no moat — /extract is strictly a worse, *paid* Jina Reader
// (free r.jina.ai already returns clean Markdown). Research (monetization-scan.md
// 2026-06-15) found the ACTUALLY-earning x402 template is "wrap a free DATA source
// in a structured paywall": the canonical earner did $1.5–2.4k/mo on CoinGecko +
// Yahoo-Finance market data. Paying categories on Bazaar = Data / Trading / Inference.
//
// This is the de-risked candidate for that lane and it matches our existing crypto
// competence. NOT a raw passthrough of CoinGecko (agents could call that free):
// it ENRICHES — normalized momentum score, signal label, volatility flag — i.e. a
// derived read an agent ingests in-loop without doing the math itself. Dependency-free
// (global fetch, node 20+), no API key, no DB.
//
// NOT DEPLOYED. Product swaps are Petro-gated (the /extract pivot was Petro-approved).
// This + a test prove the data layer; wiring into the x402 route is mechanical (mirror
// server-v3 /extract). Left ready for sh-night2 / Petro to approve + deploy.

const CG = "https://api.coingecko.com/api/v3";
const MAX_IDS = 25; // cap fan-out per call
const TIMEOUT_MS = 12000;

// CoinGecko ids are lowercase slugs ("bitcoin","ethereum","solana"). Validate to
// avoid passing junk straight through to the upstream and to keep the URL clean.
const ID_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

function classify(change24h) {
  // Simple, transparent momentum read on the 24h % change. Honest about being a
  // heuristic — the value is that it's computed + normalized so the agent doesn't.
  const c = Number(change24h);
  if (!Number.isFinite(c)) return { signal: "unknown", momentum: 0, volatility: "unknown" };
  // momentum: tanh-squashed to [-100,100] so callers get a bounded, comparable score.
  const momentum = Math.round(Math.tanh(c / 5) * 100);
  let signal = "neutral";
  if (c >= 3) signal = "bullish";
  else if (c <= -3) signal = "bearish";
  const absC = Math.abs(c);
  const volatility = absC >= 8 ? "high" : absC >= 3 ? "elevated" : "calm";
  return { signal, momentum, volatility };
}

export async function marketSignal(idsRaw) {
  if (!idsRaw || typeof idsRaw !== "string") {
    return { error: "missing 'ids' query param (comma-separated CoinGecko ids, e.g. bitcoin,ethereum)" };
  }
  const ids = [...new Set(idsRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (ids.length === 0) return { error: "no valid ids supplied" };
  if (ids.length > MAX_IDS) return { error: `too many ids (max ${MAX_IDS})` };
  const bad = ids.filter((id) => !ID_RE.test(id));
  if (bad.length) return { error: `invalid id(s): ${bad.join(", ")}` };

  const url =
    `${CG}/simple/price?ids=${encodeURIComponent(ids.join(","))}` +
    `&vs_currencies=usd&include_market_cap=true&include_24hr_change=true&include_24hr_vol=true`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let raw;
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!r.ok) return { error: `upstream HTTP ${r.status}` };
    raw = await r.json();
  } catch (e) {
    return { error: e?.name === "AbortError" ? "upstream timeout" : `upstream error: ${String(e?.message || e)}` };
  } finally {
    clearTimeout(t);
  }

  const assets = [];
  const missing = [];
  for (const id of ids) {
    const row = raw[id];
    if (!row || typeof row.usd !== "number") { missing.push(id); continue; }
    const change24h = row.usd_24h_change ?? null;
    assets.push({
      id,
      price_usd: row.usd,
      market_cap_usd: row.usd_market_cap ?? null,
      change_24h_pct: change24h === null ? null : Math.round(change24h * 100) / 100,
      volume_24h_usd: row.usd_24h_vol ?? null,
      ...classify(change24h),
    });
  }
  if (assets.length === 0) return { error: `no data for: ${ids.join(", ")} (unknown CoinGecko ids?)` };

  return {
    source: "coingecko",
    asof: null, // stamped by caller (Date.now unavailable in some contexts); fill at handler
    count: assets.length,
    assets,
    ...(missing.length ? { missing } : {}),
  };
}
