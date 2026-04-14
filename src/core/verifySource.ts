import { cachedSystem, getClient, getModel } from "./anthropic.js";
import { loadPrompt } from "./prompts.js";
import type {
  Reliability,
  SubstantiationVerdict,
  VerifyVerdict,
} from "./types.js";

interface VerifyOptions {
  /**
   * Pre-fetched source body. If omitted, verifySource will fetch the URL.
   * Pass this when you already have the text (e.g. from a cache or another
   * part of the pipeline) to avoid a redundant network round-trip.
   */
  sourceText?: string;
  /** Max characters of source text to pass to the model (defaults to 40_000). */
  maxChars?: number;
}

/** Fetches `url` as text, with a timeout and a size cap. */
async function fetchSource(url: string, maxChars: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "CNfirmed/0.1 (+https://github.com/alex-o-748/source-finder)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const body = await res.text();
    // Strip HTML tags and collapse whitespace. Naive but adequate for v1.
    const stripped = body
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return stripped.slice(0, maxChars);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Asks Claude whether `source` substantiates `claim`. Separable from the rest
 * of the pipeline so it can be used standalone (CLI subcommand, HTTP endpoint,
 * future MCP tool) without changes to the core.
 */
export async function verifySource(
  claim: string,
  sourceUrl: string,
  options: VerifyOptions = {},
): Promise<VerifyVerdict> {
  const maxChars = options.maxChars ?? 40_000;
  const sourceText =
    options.sourceText ?? (await fetchSource(sourceUrl, maxChars));

  const system = cachedSystem(loadPrompt("verify_source"));
  const userMessage = [
    `Claim: ${claim}`,
    ``,
    `Source URL: ${sourceUrl}`,
    ``,
    `Source text (fetched, may be truncated):`,
    sourceText,
    ``,
    `Respond with the JSON object described in the system prompt — grading both axes (substantiation verdict + reliability) independently.`,
  ].join("\n");

  const client = getClient();
  const response = await client.messages.create({
    model: getModel(),
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Verifier returned no text content");
  }
  return parseVerdict(textBlock.text);
}

/** Extracts the JSON verdict from Claude's response, tolerating prose wrappers. */
function parseVerdict(raw: string): VerifyVerdict {
  const jsonText = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Verifier response was not valid JSON: ${(err as Error).message}\n---\n${raw}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Verifier response was not an object: ${raw}`);
  }
  const obj = parsed as Record<string, unknown>;
  const verdict = normaliseVerdict(obj.verdict);
  const rawConfidence =
    typeof obj.confidence === "number" ? obj.confidence : 0;
  // Clamp to [0, 100]; the prompt specifies a 0-100 scale.
  const confidence = Math.max(0, Math.min(100, rawConfidence));
  const comments = typeof obj.comments === "string" ? obj.comments : "";
  // Accept either reliability_reason (per prompt spec) or reliabilityReason
  // (camelCase), in case the model normalises the key.
  const reliability = normaliseReliability(obj.reliability, verdict);
  const reliabilityReason =
    typeof obj.reliability_reason === "string"
      ? obj.reliability_reason
      : typeof obj.reliabilityReason === "string"
        ? obj.reliabilityReason
        : "";
  return {
    verdict,
    confidence,
    comments,
    reliability,
    reliabilityReason,
  };
}

function normaliseVerdict(raw: unknown): SubstantiationVerdict {
  if (typeof raw !== "string") return "NOT SUPPORTED";
  const v = raw.trim().toUpperCase();
  if (
    v === "SUPPORTED" ||
    v === "PARTIALLY SUPPORTED" ||
    v === "NOT SUPPORTED" ||
    v === "SOURCE UNAVAILABLE"
  ) {
    return v;
  }
  // Tolerate minor variants (e.g. "PARTIAL", "UNSUPPORTED").
  if (v.startsWith("PARTIAL")) return "PARTIALLY SUPPORTED";
  if (v.includes("UNAVAILABLE")) return "SOURCE UNAVAILABLE";
  if (v === "UNSUPPORTED") return "NOT SUPPORTED";
  return "NOT SUPPORTED";
}

function normaliseReliability(
  raw: unknown,
  verdict: SubstantiationVerdict,
): Reliability {
  if (raw === "high" || raw === "medium" || raw === "low" || raw === "n/a") {
    return raw;
  }
  // If the source is unavailable, reliability is n/a by construction.
  if (verdict === "SOURCE UNAVAILABLE") return "n/a";
  // Default to "medium" when the model omits the field rather than failing
  // hard — the caller can still decide based on substantiation.
  return "medium";
}

/** Finds the first balanced {...} JSON object in a string. */
function extractJsonObject(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1] : raw;
  const first = candidate.indexOf("{");
  if (first === -1) return candidate;
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
  return candidate.slice(first);
}
