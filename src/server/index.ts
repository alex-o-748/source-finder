import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3939);
const app = createApp();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "warning: ANTHROPIC_API_KEY is not set — /verify-claim and /verify-article will fail.",
  );
}

serve({ fetch: app.fetch, port }, ({ port: actual }) => {
  console.log(`cnfirmed: listening on http://localhost:${actual}`);
});
