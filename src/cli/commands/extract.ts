import { fetchArticle } from "../../core/fetchArticle.js";
import { extractClaims } from "../../core/extractClaims.js";

interface ExtractArgs {
  urlOrTitle: string;
  json: boolean;
}

export async function extractCommand(args: ExtractArgs): Promise<void> {
  const article = await fetchArticle(args.urlOrTitle);
  const claims = extractClaims(article.wikitext);

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ article: stripWikitext(article), claims }, null, 2) +
        "\n",
    );
    return;
  }

  console.log(`# ${article.title}`);
  console.log(`  ${article.url}`);
  console.log(`  ${claims.length} citation-needed tag(s) found`);
  console.log();
  claims.forEach((c, i) => {
    console.log(`## [${i + 1}] ${c.section ?? "(no section)"}`);
    console.log(`    tag: ${c.tag}`);
    console.log(`    claim: ${c.claim}`);
    console.log();
  });
}

function stripWikitext<T extends { wikitext: string }>(a: T) {
  const { wikitext: _omit, ...rest } = a;
  void _omit;
  return rest;
}
