/**
 * The model client for the batch job.
 *
 * In a browser, CNfirmed reaches the open-weight models through its Cloudflare
 * Worker, which allows 20 requests a minute per address. On Toolforge every
 * tool shares a few outbound addresses, so the batch job talks to Hugging Face
 * directly when the tool has its own token (`HF_TOKEN`, set with
 * `toolforge envvars create HF_TOKEN`), and falls back to the Worker otherwise.
 */

import {
  workerChatClient,
  workerReplyText,
  workerRequestBody,
  workerShouldRetry,
  WORKER_RETRY_WAIT_MS,
  type ChatClient,
} from "../core/archiveLibrarian.js";

export const HF_ROUTER_URL = "https://router.huggingface.co/v1";

/** Hugging Face Inference Providers' chat-completions endpoint, with a token. */
export function hfChatClient(
  token: string,
  base = HF_ROUTER_URL,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
): ChatClient {
  const url = `${base.replace(/\/+$/, "")}/chat/completions`;
  return {
    async chat(model, system, user, maxTokens, effort) {
      const body = workerRequestBody(model, system, user, maxTokens, effort);
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body,
        });
        const text = await res.text();
        if (workerShouldRetry(res.status, text, attempt)) {
          await sleep(WORKER_RETRY_WAIT_MS * 2 ** attempt);
          continue;
        }
        return workerReplyText(res.status, text);
      }
    },
  };
}

/** Hugging Face with the tool's own token when there is one, else the Worker. */
export function defaultChatClient(env: NodeJS.ProcessEnv = process.env): { client: ChatClient; via: string } {
  const token = env.HF_TOKEN?.trim();
  if (token) return { client: hfChatClient(token, env.HF_BASE_URL || HF_ROUTER_URL), via: "Hugging Face (HF_TOKEN)" };
  return { client: workerChatClient(), via: "the CNfirmed Worker" };
}
