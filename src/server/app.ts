import { Hono } from "hono";
import { cors } from "hono/cors";
import { scanRoute } from "./routes/scan.js";
import { verifyClaimRoute } from "./routes/verifyClaim.js";
import { verifyArticleRoute } from "./routes/verifyArticle.js";

const ALLOWED_ORIGIN_RE =
  /^(https:\/\/(?:[a-z-]+\.)?wikipedia\.org|http:\/\/localhost(?::\d+)?|http:\/\/127\.0\.0\.1(?::\d+)?)$/;

export function createApp() {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: (origin) => (origin && ALLOWED_ORIGIN_RE.test(origin) ? origin : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      maxAge: 86400,
    }),
  );

  app.get("/", (c) => c.json({ name: "cnfirmed", endpoints: ["/scan", "/verify-claim", "/verify-article"] }));

  app.route("/scan", scanRoute);
  app.route("/verify-claim", verifyClaimRoute);
  app.route("/verify-article", verifyArticleRoute);

  return app;
}
