/**
 * Seed blocklist of domains deemed "generally unreliable" or "deprecated" by
 * Wikipedia's Reliable Sources Perennial list (WP:RSP). Not exhaustive — this
 * is a starter list of widely-deprecated sources that should not be used to
 * substantiate Wikipedia claims. Expand over time.
 *
 * Source: https://en.wikipedia.org/wiki/Wikipedia:Reliable_sources/Perennial_sources
 */
export const UNRELIABLE_DOMAINS: readonly string[] = [
  // Deprecated by community consensus.
  "dailymail.co.uk",
  "thesun.co.uk",
  "mirror.co.uk",
  "rt.com",
  "sputniknews.com",
  "breitbart.com",
  "infowars.com",
  "naturalnews.com",
  "occupydemocrats.com",
  "thegatewaypundit.com",
  "zerohedge.com",
  "theepochtimes.com",
  "pressTV.com",
  "globalresearch.ca",
  "veteranstoday.com",
  "wnd.com",
  "newsmax.com",
  "oann.com",

  // User-generated / not a reliable source per WP:USERGENERATED.
  "wikipedia.org",
  "wikia.com",
  "fandom.com",
  "reddit.com",
  "quora.com",
  "answers.com",
  "medium.com", // personal blogs; some outlets are still ok, but default-block
  "substack.com", // same
];

/** Lower-cased set for fast lookup. */
const DOMAIN_SET = new Set(UNRELIABLE_DOMAINS.map((d) => d.toLowerCase()));

/** Returns true if a URL's registrable domain appears on the blocklist. */
export function isUnreliableSource(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (DOMAIN_SET.has(host)) return true;
    // Match suffix for subdomains: news.dailymail.co.uk -> dailymail.co.uk.
    for (const blocked of DOMAIN_SET) {
      if (host === blocked || host.endsWith(`.${blocked}`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
