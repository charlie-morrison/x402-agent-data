// extract.js — in-loop web-content reader, the x402 product PIVOT (2026-06-14).
//
// WHY the pivot: the GitHub-repo SEO-audit endpoint was a human-shaped one-shot —
// 60 days live, 0 organic agentic calls. The x402 demand sh-night1's scan found is
// for DATA an agent consumes repeatedly inside a loop (Exa/Jina "reader", Alchemy
// RPC, Heurist inference). This endpoint serves that category with ZERO paid
// upstream and statelessly: URL in -> clean readable text + metadata + links out,
// the exact JSON a RAG / research agent ingests on every step of a crawl loop.
//
// Pure + cheap: Node global fetch, no API key, no DB, no headless browser. Caps
// the fetch so a 1GB VPS never blows up. SSRF-guarded (blocks private/loopback/
// link-local targets and non-http(s) schemes) because it fetches caller-supplied
// URLs server-side.

import dns from "node:dns/promises";
import net from "node:net";

const MAX_BYTES = 2 * 1024 * 1024;      // 2 MB hard cap on fetched body
const FETCH_TIMEOUT_MS = 12000;
const MAX_TEXT_CHARS = 40000;           // returned text cap (agents chunk anyway)
const MAX_LINKS = 50;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const o = ip.split(".").map(Number);
    if (o[0] === 10) return true;
    if (o[0] === 127) return true;                      // loopback
    if (o[0] === 169 && o[1] === 254) return true;      // link-local
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 0) return true;
    return false;
  }
  // IPv6: block loopback, link-local (fe80::/10), unique-local (fc00::/7)
  const l = ip.toLowerCase();
  if (l === "::1" || l === "::") return true;
  if (l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb")) return true;
  if (l.startsWith("fc") || l.startsWith("fd")) return true;
  if (l.startsWith("::ffff:")) return isPrivateIp(l.replace("::ffff:", "")); // mapped v4
  return false;
}

async function assertPublicHost(hostname) {
  // literal IP supplied directly
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("blocked: private/loopback address");
    return;
  }
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".internal")) {
    throw new Error("blocked: internal hostname");
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error("dns resolution failed");
  }
  if (!records.length) throw new Error("dns resolution failed");
  for (const r of records) {
    if (isPrivateIp(r.address)) throw new Error("blocked: resolves to private address");
  }
}

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  middot: "·", mdash: "—", ndash: "–", hellip: "…", rarr: "→", larr: "←",
  copy: "©", reg: "®", trade: "™", deg: "°", times: "×", "#39": "'" };
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return _; } })
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', "i")) ||
            tag.match(new RegExp(name + "\\s*=\\s*'([^']*)'", "i"));
  return m ? m[1] : null;
}

function absolutize(href, base) {
  try { return new URL(href, base).href; } catch { return null; }
}

// Lightweight, dependency-free HTML -> readable text + metadata.
function parseHtml(html, baseUrl) {
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? decodeEntities(titleM[1].replace(/\s+/g, " ").trim()) : null;

  let description = null, canonical = null;
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const m of metaTags) {
    const nm = (attr(m, "name") || attr(m, "property") || "").toLowerCase();
    if ((nm === "description" || nm === "og:description") && !description) {
      const c = attr(m, "content");
      if (c) description = decodeEntities(c.trim());
    }
  }
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  for (const l of linkTags) {
    if ((attr(l, "rel") || "").toLowerCase() === "canonical") {
      const h = attr(l, "href");
      if (h) canonical = absolutize(h, baseUrl);
    }
  }

  // links (anchor hrefs, absolutized, de-duped)
  const links = [];
  const seen = new Set();
  for (const a of html.match(/<a\b[^>]*href\s*=\s*["'][^"']+["'][^>]*>/gi) || []) {
    const h = attr(a, "href");
    if (!h || h.startsWith("#") || h.startsWith("javascript:") || h.startsWith("mailto:")) continue;
    const abs = absolutize(h, baseUrl);
    if (abs && /^https?:/i.test(abs) && !seen.has(abs)) {
      seen.add(abs); links.push(abs);
      if (links.length >= MAX_LINKS) break;
    }
  }

  // body text: drop non-content elements, strip tags, collapse whitespace
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text).replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
  const truncated = text.length > MAX_TEXT_CHARS;
  if (truncated) text = text.slice(0, MAX_TEXT_CHARS);

  return { title, description, canonical, text, links, truncated };
}

// Public entry point. Returns the JSON an agent ingests, or throws Error(message).
export async function extractUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") throw new Error("missing url");
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error("invalid url"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http/https supported");

  await assertPublicHost(u.hostname);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(u.href, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": "x402-reader/1.0 (+https://x402.charliemorrison.dev)",
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === "AbortError" ? "fetch timed out" : "fetch failed");
  }
  clearTimeout(timer);

  const finalUrl = resp.url || u.href;
  const status = resp.status;
  const ctype = (resp.headers.get("content-type") || "").toLowerCase();

  // read body with a hard byte cap
  const reader = resp.body?.getReader?.();
  let received = 0;
  const chunks = [];
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_BYTES) { try { await reader.cancel(); } catch {} break; }
      chunks.push(value);
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const body = buf.toString("utf8");

  const base = { url: rawUrl, final_url: finalUrl, status, content_type: ctype,
                 bytes: received, fetched_at: new Date().toISOString() };

  if (ctype.includes("application/json")) {
    let json = null;
    try { json = JSON.parse(body); } catch {}
    return { ...base, kind: "json", json: json ?? body.slice(0, MAX_TEXT_CHARS) };
  }
  if (ctype.includes("text/html") || ctype.includes("xhtml") || (!ctype && /<html/i.test(body))) {
    const parsed = parseHtml(body, finalUrl);
    return { ...base, kind: "html", ...parsed, word_count: parsed.text.split(/\s+/).filter(Boolean).length };
  }
  // plain text / other
  const text = body.slice(0, MAX_TEXT_CHARS);
  return { ...base, kind: "text", text, truncated: body.length > MAX_TEXT_CHARS,
           word_count: text.split(/\s+/).filter(Boolean).length };
}
