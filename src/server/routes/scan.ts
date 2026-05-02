import { Hono } from "hono";
import { fetchArticle } from "../../core/fetchArticle.js";
import { extractClaims } from "../../core/extractClaims.js";

export const scanRoute = new Hono();

scanRoute.get("/", async (c) => {
  const article = c.req.query("article");
  if (!article) {
    return c.json({ error: "missing ?article= parameter" }, 400);
  }
  try {
    const fetched = await fetchArticle(article);
    const claims = extractClaims(fetched.wikitext);
    const { wikitext: _omit, ...meta } = fetched;
    void _omit;
    return c.json({ article: meta, claims });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 502);
  }
});
