// Probe: does plain web search (Tavily) + the free Verify API find a source
// for the eval claims? One query per claim, results checked in rank order,
// stopping at the first SUPPORTED. Responses are cached in eval/tavily/cache/
// so a rerun resumes and costs nothing.
//
//   NODE_USE_ENV_PROXY=1 node eval/tavily/probe.mjs [--limit N] [--name tag]
//
// Uses TAVILY_API_KEY when set, else Tavily's keyless (rate-limited) mode.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const EVAL = path.join(HERE, "..");
const CACHE = path.join(HERE, "cache");
fs.mkdirSync(CACHE, { recursive: true });
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const LIMIT = +arg("limit", 1000);
const NAME = arg("name", "probe");
const MAX_CHECK = +arg("max-check", 10);

const claims = JSON.parse(fs.readFileSync(path.join(EVAL, "claims.json")));
const gold = JSON.parse(fs.readFileSync(path.join(EVAL, "gold.json")));

// Wikipedia and its mirrors (circular), user-generated and social sites, and
// the WP:RSP deprecated seed list from src/policy/unreliable_sources.ts.
const EXCLUDE = [
  "wikipedia.org", "wikiwand.com", "wikimili.com", "dbpedia.org", "alchetron.com",
  "everybodywiki.com", "kiddle.co", "wiki2.org", "infogalactic.com", "justapedia.org",
  "wikizero.com", "wikibrief.org", "en-academic.com", "dictionary.sensagent.com",
  "fandom.com", "wikia.com", "reddit.com", "quora.com", "answers.com", "medium.com",
  "substack.com", "facebook.com", "instagram.com", "x.com", "twitter.com", "tiktok.com",
  "pinterest.com", "linkedin.com", "scribd.com", "dailymail.co.uk", "thesun.co.uk",
  "mirror.co.uk", "rt.com", "sputniknews.com", "breitbart.com", "infowars.com",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (o) => crypto.createHash("sha1").update(JSON.stringify(o)).digest("hex").slice(0, 16);
function cached(kind, req, fn) {
  const f = path.join(CACHE, `${kind}-${key(req)}.json`);
  if (fs.existsSync(f)) return Promise.resolve(JSON.parse(fs.readFileSync(f)));
  return fn().then((v) => { if (v && !v.__nocache) fs.writeFileSync(f, JSON.stringify(v)); return v; });
}

async function tavily(query) {
  const req = {
    query, search_depth: "basic", max_results: 10, chunks_per_source: 3,
    include_raw_content: "markdown", exclude_domains: EXCLUDE,
  };
  return cached("search", req, async () => {
    const headers = { "content-type": "application/json" };
    if (process.env.TAVILY_API_KEY) headers.authorization = `Bearer ${process.env.TAVILY_API_KEY}`;
    else headers["x-tavily-access-mode"] = "keyless";
    for (let i = 0; i < 6; i++) {
      const r = await fetch("https://api.tavily.com/search", { method: "POST", headers, body: JSON.stringify(req) });
      if (r.status === 429 || r.status >= 500) { console.error(`  tavily ${r.status}, waiting`); await sleep(15000 * (i + 1)); continue; }
      const j = await r.json();
      if (!r.ok) throw new Error(`tavily ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
      return j;
    }
    throw new Error("tavily: retries exhausted");
  });
}

// The Verify API's own request handler, run in-process (the public
// citation-verifier tool can be down): same prompt, parser, model
// (gpt-oss-20b) and llm-router route. CCS_DIR points at a
// citation-checker-script checkout with its dependencies installed.
const CCS_DIR = process.env.CCS_DIR || path.join(EVAL, "../../citation-checker-script");
const { verifyRequest } = await import(path.join(CCS_DIR, "api/verify.js"));

async function verify(claim, text) {
  const req = { claim, source_content: text.slice(0, 50000) };
  return cached("verify", req, async () => {
    for (let i = 0; i < 4; i++) {
      const r = await verifyRequest(req);
      if (r.status === 200) return r.body;
      if (r.status === 422) return { verdict: "SOURCE UNAVAILABLE", comments: r.body.error };
      console.error(`  verify ${r.status}: ${r.body.error}`);
      await sleep(5000 * (i + 1));
    }
    return { verdict: "ERROR", comments: "verifier failed", __nocache: true };
  });
}

// A page that repeats a long run of the claim word for word is likely a
// Wikipedia copy (or Wikipedia copied it). Counted separately, never as found.
const words = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
function verbatim(claim, text) {
  const w = words(claim); if (w.length < 8) return false;
  const t = " " + words(text).join(" ") + " ";
  for (let i = 0; i + 8 <= w.length; i++) if (t.includes(" " + w.slice(i, i + 8).join(" ") + " ")) return true;
  return false;
}

const out = [];
let credits = 0;
for (const c of claims.slice(0, LIMIT)) {
  const claim = (gold[c.id] && gold[c.id].claim) || c.claim;
  const query = `${c.title}: ${claim}`.slice(0, 400);
  let res;
  try { res = await tavily(query); } catch (e) { console.error(c.id, e.message); out.push({ id: c.id, error: e.message }); continue; }
  credits += res.usage?.credits ?? 1;
  const row = { id: c.id, title: c.title, stratum: c.stratum, claim, query, results: [] };
  for (const [rank, r] of (res.results || []).entries()) {
    // Tavily's query-matched excerpts first, then the page, so a long page's
    // relevant passage survives the 50,000-character cap.
    const text = [r.content, r.raw_content].filter(Boolean).join("\n\n");
    const item = { rank: rank + 1, url: r.url, title: r.title, chars: text.length, verbatim: verbatim(claim, text), snippet: (r.content || "").slice(0, 600) };
    if (rank < MAX_CHECK && !row.results.some((x) => x.verdict === "SUPPORTED" && !x.verbatim) && text.trim()) {
      const v = await verify(claim, text);
      Object.assign(item, { verdict: v.verdict, score: v.support_score, quote: v.verified_text || null, comments: v.comments });
    }
    row.results.push(item);
  }
  const good = row.results.find((x) => x.verdict === "SUPPORTED" && !x.verbatim);
  console.error(`${out.length + 1}. ${c.title} — ${good ? "SUPPORTED @" + good.rank + " " + good.url : "none"}`);
  out.push(row);
  fs.writeFileSync(path.join(HERE, `${NAME}.json`), JSON.stringify(out, null, 1));
}
console.error(`credits used (uncached): ~${credits}`);
