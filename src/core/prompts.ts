import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type PromptName = "verify_source" | "find_sources";

/**
 * Loads a prompt by name from the prompts directory on disk.
 *
 * At dev time (tsx) __dirname is src/core/, so ../prompts/ is src/prompts/.
 * At runtime (compiled) __dirname is dist/core/, so ../prompts/ is dist/prompts/
 * (populated by the copy:prompts build step).
 */
export function loadPrompt(name: PromptName): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "..", "prompts", `${name}.md`);
  return readFileSync(path, "utf8");
}
