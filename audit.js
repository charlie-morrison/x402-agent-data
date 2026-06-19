// GitHub repo discoverability / SEO audit — the zero-marginal-cost data product
// served behind the x402 paywall. Buyer agents that auto-publish repos pay a few
// tenths of a cent to get a structured discoverability score + concrete fixes.
//
// Pure: takes owner/repo, hits the public GitHub REST API (no token needed for
// low volume; honors GITHUB_TOKEN if present for higher rate limits), returns JSON.

const GH = "https://api.github.com";

function ghHeaders() {
  const h = { "User-Agent": "x402-repo-audit", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

// Heuristic README discoverability scoring — mirrors the GitHub-SEO findings
// accumulated in side-hustle/research/monetization-scan.md.
function scoreReadme(readme) {
  if (!readme) return { present: false, points: 0, notes: ["No README — repos without one are nearly invisible in GitHub search."] };
  const len = readme.length;
  const notes = [];
  let points = 0;
  if (len > 300) points += 10; else notes.push("README is very short (<300 chars) — add a keyword-rich intro paragraph.");
  if (/^#\s/m.test(readme)) points += 5; else notes.push("No top-level H1 heading.");
  const headings = (readme.match(/^#{1,3}\s/gm) || []).length;
  if (headings >= 3) points += 5; else notes.push("Add more section headings (Install / Usage / Features) — they rank as keywords.");
  if (/```/.test(readme)) points += 5; else notes.push("No fenced code block — usage examples lift both ranking and conversion.");
  if (/!\[.*\]\(.*\)/.test(readme)) points += 5; else notes.push("No image/badge — a screenshot or badge improves click-through.");
  return { present: true, length: len, headings, points, notes };
}

export async function auditRepo(owner, repo) {
  if (!owner || !repo) {
    return { error: "owner and repo query params are required", example: "/audit?owner=facebook&repo=react" };
  }
  const base = `${GH}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const headers = ghHeaders();

  const repoRes = await fetch(base, { headers });
  if (repoRes.status === 404) return { error: `repo ${owner}/${repo} not found or private` };
  if (!repoRes.ok) return { error: `GitHub API error ${repoRes.status}` };
  const data = await repoRes.json();

  // topics + README in parallel
  const [topicsRes, readmeRes] = await Promise.all([
    fetch(`${base}/topics`, { headers: { ...headers, Accept: "application/vnd.github.mercy-preview+json" } }),
    fetch(`${base}/readme`, { headers: { ...headers, Accept: "application/vnd.github.raw" } }),
  ]);
  const topics = topicsRes.ok ? (await topicsRes.json()).names || [] : (data.topics || []);
  const readme = readmeRes.ok ? await readmeRes.text() : null;

  // Scoring (0–100). Discoverability levers GitHub search actually weights.
  const fixes = [];
  let score = 0;

  // description (20)
  if (data.description && data.description.length > 20) score += 20;
  else fixes.push("Add a keyword-rich description (>20 chars) — it's the #1 GitHub search signal after the repo name.");

  // topics (25) — sweet spot 5–10
  if (topics.length >= 5) score += 25;
  else if (topics.length >= 1) { score += 12; fixes.push(`Only ${topics.length} topic tag(s) — add more (aim 5–10 searched-but-not-saturated tags).`); }
  else fixes.push("No topic tags — these are the strongest discoverability lever after the name. Add 5–10.");

  // readme (30)
  const rm = scoreReadme(readme);
  score += rm.points;
  fixes.push(...rm.notes);

  // homepage / license / activity (25)
  if (data.homepage) score += 5; else fixes.push("No homepage URL set — point it at your funnel/landing page.");
  if (data.license) score += 5; else fixes.push("No license — many users filter to licensed repos.");
  if (data.has_issues) score += 3;
  const pushedDaysAgo = data.pushed_at ? Math.floor((Date.now() - new Date(data.pushed_at)) / 86400000) : 999;
  if (pushedDaysAgo < 90) score += 12; else fixes.push(`Last push ${pushedDaysAgo}d ago — fresh activity ranks higher; commit something.`);

  return {
    repo: `${owner}/${repo}`,
    discoverability_score: Math.min(100, score),
    grade: score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D",
    signals: {
      description: !!data.description,
      topic_count: topics.length,
      topics,
      readme: rm,
      homepage: data.homepage || null,
      license: data.license?.spdx_id || null,
      stars: data.stargazers_count,
      last_push_days: pushedDaysAgo,
    },
    top_fixes: fixes.slice(0, 6),
    generated_at: new Date().toISOString(),
  };
}
