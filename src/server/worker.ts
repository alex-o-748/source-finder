/**
 * Cloudflare Worker entrypoint. The same Hono app that serves the local
 * Node dev server runs here unchanged; only two things differ from Node:
 *
 *   1. Prompts are inlined (Workers have no filesystem) — registered before
 *      any request via the in-memory registry on src/core/prompts.ts.
 *   2. The Anthropic API key arrives as a Worker secret (env binding) instead
 *      of a process env var — bridged into process.env per request so the
 *      core's getClient() can find it without modification.
 *
 * Deploy:
 *   wrangler secret put ANTHROPIC_API_KEY
 *   wrangler deploy
 */
import { findSources, verifySource } from "./generated/prompts.js";
import { registerPrompt } from "../core/prompts.js";
import { createApp } from "./app.js";

registerPrompt("find_sources", findSources);
registerPrompt("verify_source", verifySource);

const app = createApp();

interface Env {
  ANTHROPIC_API_KEY: string;
  CNFIRMED_MODEL?: string;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    if (env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    }
    if (env.CNFIRMED_MODEL) {
      process.env.CNFIRMED_MODEL = env.CNFIRMED_MODEL;
    }
    return app.fetch(request, env, ctx);
  },
};
