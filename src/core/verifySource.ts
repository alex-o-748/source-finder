import type { SubstantiationVerdict, VerifyVerdict } from "./types.js";

/**
 * The Verify API (`POST /v1/verify`, from alex-o-748/citation-checker-script)
 * checks one claim against one source. It runs the same fetch, prompt, model,
 * verdict parser and quote check as that project's userscript, CLI and batch
 * pipeline, so CNfirmed's verdicts come from the one tuned verifier rather
 * than a second prompt of its own. Override the base with CNFIRMED_VERIFY_URL
 * (e.g. http://localhost:8080 for a local `npm start`).
 */
const DEFAULT_VERIFY_BASE = "https://citation-verifier.toolforge.org";

/** The API's `source_content` limit; longer text is rejected with a 400. */
const MAX_SOURCE_CONTENT_CHARS = 50_000;

/**
 * The service allows 10 requests/minute across all callers and answers 429
 * with Retry-After. A whole-article run verifies candidates one after another,
 * so it waits out the window a few times rather than failing the candidate.
 */
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_WAIT_SECONDS = 60;

interface VerifyOptions {
  /**
   * Pre-fetched source body. When given it is sent as `source_content` and
   * the API does not fetch the URL. Otherwise the API fetches `sourceUrl`
   * itself (through its source fetcher).
   */
  sourceText?: string;
  /** Verify API base URL. Defaults to CNFIRMED_VERIFY_URL, then the public host. */
  baseUrl?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Injected for tests; waits between rate-limited attempts. */
  sleep?: (ms: number) => Promise<void>;
}

/** The API's success body (snake_case, as it is on the wire). */
interface VerifyApiResult {
  verdict: string;
  support_score: number | null;
  comments: string | null;
  reason_type: string | null;
  source_quote: string | null;
  quote_status: string | null;
  verified_text: string | null;
}

export function verifyBaseUrl(explicit?: string): string {
  const base = explicit || process.env.CNFIRMED_VERIFY_URL || DEFAULT_VERIFY_BASE;
  return base.replace(/\/+$/, "");
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Asks the Verify API whether `source` substantiates `claim`. Separable from
 * the rest of the pipeline so it can be used standalone (CLI subcommand,
 * future MCP tool) without changes to the core.
 *
 * A source the API cannot fetch comes back as a SOURCE UNAVAILABLE verdict;
 * any other failure (bad request, provider down, rate limit not lifting)
 * throws.
 */
export async function verifySource(
  claim: string,
  sourceUrl: string,
  options: VerifyOptions = {},
): Promise<VerifyVerdict> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const endpoint = `${verifyBaseUrl(options.baseUrl)}/v1/verify`;

  const body: Record<string, string> = { claim };
  if (options.sourceText?.trim()) {
    body.source_content = options.sourceText.slice(0, MAX_SOURCE_CONTENT_CHARS);
  } else {
    body.source_url = sourceUrl;
  }

  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "CNfirmed/0.1 (+https://github.com/alex-o-748/source-finder)",
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const seconds = retryAfter > 0 ? Math.min(retryAfter, MAX_RETRY_WAIT_SECONDS) : 10;
      await sleep(seconds * 1000);
      continue;
    }

    const payload = (await res.json().catch(() => null)) as
      | (VerifyApiResult & { error?: string; stage?: string })
      | null;

    if (res.ok && payload) return toVerdict(payload);

    const message = payload?.error || `${res.status} ${res.statusText}`;
    // 422: the source could not be fetched or was empty — a verdict about the
    // source, not a failure of the verifier.
    if (res.status === 422) {
      return {
        verdict: "SOURCE UNAVAILABLE",
        confidence: 0,
        comments: message,
        reliability: "n/a",
        reliabilityReason: "source unavailable",
      };
    }
    throw new Error(`Verify API ${res.status}: ${message}`);
  }
}

function toVerdict(r: VerifyApiResult): VerifyVerdict {
  const verdict = normaliseVerdict(r.verdict);
  const score = typeof r.support_score === "number" ? r.support_score : 0;
  const quote = r.verified_text?.trim() || undefined;
  return {
    verdict,
    confidence: verdict === "SOURCE UNAVAILABLE" ? 0 : Math.max(0, Math.min(100, score)),
    comments: r.comments ?? "",
    // The API grades substantiation only; reliability is left to the
    // candidate filters (the WP:RSP blocklist) and the editor.
    reliability: "n/a",
    reliabilityReason:
      verdict === "SOURCE UNAVAILABLE" ? "source unavailable" : "not assessed by the Verify API",
    // verified_text, never source_quote: only the former is known to be in
    // the source.
    ...(quote ? { quote } : {}),
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
  if (v.startsWith("PARTIAL")) return "PARTIALLY SUPPORTED";
  if (v.includes("UNAVAILABLE")) return "SOURCE UNAVAILABLE";
  return "NOT SUPPORTED";
}
