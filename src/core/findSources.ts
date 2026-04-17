import { cachedSystem, getClient, getModel } from "./anthropic.js";
import { loadPrompt } from "./prompts.js";
import { isUnreliableSource } from "../policy/unreliable_sources.js";
import type { CandidateSource, Claim } from "./types.js";

interface FindOptions {
  /** Max candidate sources to return after filtering (default 5). */
  maxResults?: number;
  /** Max web_search tool calls the model may make (default 3). */
  maxSearches?: number;
}

/**
 * Uses Claude with the web_search tool to discover candidate sources that
 * could substantiate `claim`. Results are filtered against the WP:RSP
 * deprecated-domain list before return.
 */
export async function findSources(
  claim: Claim,
  options: FindOptions = {},
): Promise<CandidateSource[]> {
  const maxResults = options.maxResults ?? 5;
  const maxSearches = options.maxSearches ?? 6;

  const system = cachedSystem(loadPrompt("find_sources"));
  const userMessage = [
    `Claim: ${claim.claim}`,
    ``,
    `Context (surrounding paragraph): ${claim.context}`,
    ``,
    `Section: ${claim.section ?? "(none)"}`,
  ].join("\n");

  const client = getClient();
  const response = await client.messages.create({
    model: getModel(),
    max_tokens: 4096,
    system,
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: maxSearches,
      },
    ],
    messages: [{ role: "user", content: userMessage }],
  });

  // Claude's final message should be a JSON object per the prompt.
  const textBlocks = response.content.filter((b) => b.type === "text");
  const combined = textBlocks.map((b) => (b as { text: string }).text).join("\n");
  const parsed = parseCandidates(combined);

  return parsed
    .filter((c) => !isUnreliableSource(c.url))
    .slice(0, maxResults);
}

function parseCandidates(raw: string): CandidateSource[] {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("candidates" in parsed) ||
    !Array.isArray((parsed as { candidates: unknown }).candidates)
  ) {
    return [];
  }
  const items = (parsed as { candidates: unknown[] }).candidates;
  const out: CandidateSource[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.url !== "string") continue;
    out.push({
      url: o.url,
      title: typeof o.title === "string" ? o.title : o.url,
      snippet: typeof o.snippet === "string" ? o.snippet : "",
      relevance: typeof o.relevance === "string" ? o.relevance : "",
    });
  }
  return out;
}

function extractJsonObject(raw: string): string | null {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1] : raw;
  const first = candidate.indexOf("{");
  if (first === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = first; i < candidate.length; i++) {
    const c = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return candidate.slice(first, i + 1);
    }
  }
  return null;
}
