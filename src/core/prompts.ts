import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Loads a prompt by name from the prompts directory.
 *
 * At dev time (tsx) __dirname is src/core/, so ../prompts/ is src/prompts/.
 * At runtime (compiled) __dirname is dist/core/, so ../prompts/ is dist/prompts/
 * (populated by the copy:prompts build step).
 */
export function loadPrompt(name: "verify_source" | "find_sources"): string {
  const path = join(__dirname, "..", "prompts", `${name}.md`);
  return readFileSync(path, "utf8");
}
