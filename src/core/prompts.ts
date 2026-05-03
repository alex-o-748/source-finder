import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type PromptName = "verify_source" | "find_sources";

const inlineRegistry = new Map<PromptName, string>();

/**
 * Pre-register a prompt's text in memory. Used by runtimes without a
 * filesystem (Cloudflare Workers): the worker imports prompt files as
 * text at build time and registers them before any loadPrompt call.
 */
export function registerPrompt(name: PromptName, text: string): void {
  inlineRegistry.set(name, text);
}

/**
 * Loads a prompt by name. Checks the in-memory registry first, then falls
 * back to reading from the prompts directory on disk.
 *
 * At dev time (tsx) __dirname is src/core/, so ../prompts/ is src/prompts/.
 * At runtime (compiled) __dirname is dist/core/, so ../prompts/ is dist/prompts/
 * (populated by the copy:prompts build step).
 *
 * The disk fallback is computed lazily so module load doesn't crash in
 * runtimes where `import.meta.url` is unavailable (Cloudflare Workers).
 */
export function loadPrompt(name: PromptName): string {
  const inline = inlineRegistry.get(name);
  if (inline !== undefined) return inline;
  if (!import.meta.url) {
    throw new Error(
      `loadPrompt("${name}"): no inline prompt registered and no filesystem ` +
        `available. Call registerPrompt() before any pipeline call in this runtime.`,
    );
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "..", "prompts", `${name}.md`);
  return readFileSync(path, "utf8");
}
