import Anthropic from "@anthropic-ai/sdk";

let sharedClient: Anthropic | null = null;

/** Default model. Overridable via CNFIRMED_MODEL env var. */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Returns a singleton Anthropic client, constructed lazily. */
export function getClient(): Anthropic {
  if (!sharedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Export it in your shell before running CNfirmed.",
      );
    }
    sharedClient = new Anthropic({ apiKey });
  }
  return sharedClient;
}

/** Returns the model ID to use (env-overridable). */
export function getModel(): string {
  return process.env.CNFIRMED_MODEL || DEFAULT_MODEL;
}

/**
 * Build a cache-friendly system message. The static policy preamble is marked
 * with a cache_control breakpoint so repeated calls (e.g. many claims on the
 * same article) get a cache hit on the policy portion.
 */
export function cachedSystem(
  staticPreamble: string,
  dynamicTail?: string,
): Anthropic.Messages.TextBlockParam[] {
  const blocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type: "text",
      text: staticPreamble,
      cache_control: { type: "ephemeral" },
    },
  ];
  if (dynamicTail && dynamicTail.trim().length > 0) {
    blocks.push({ type: "text", text: dynamicTail });
  }
  return blocks;
}
