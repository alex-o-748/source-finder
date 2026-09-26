/**
 * How the evaluation set is spread across subjects.
 *
 * Each stratum is a CirrusSearch topic filter over
 * Category:All articles with unsourced statements, sampled at random, one claim
 * per article. The set is deliberately tilted towards subjects where a
 * digitised book is a plausible source (history, war, religion, literature,
 * architecture, places, science), since that is what the Internet Archive stage
 * can find, while keeping enough modern and pop-culture claims (sport, music,
 * film, games, business, politics, medicine) to show what the tool does where
 * books will not help.
 */
export interface Stratum {
  id: string;
  /** Extra CirrusSearch terms, ANDed with the category. */
  search: string;
  /** Claims to take (one per article). */
  quota: number;
  /** Subjects where a digitised book is a plausible source. */
  bookLeaning: boolean;
}

export const CATEGORY = "All_articles_with_unsourced_statements";

export const STRATA: Stratum[] = [
  { id: "history", search: "articletopic:history", quota: 12, bookLeaning: true },
  { id: "military", search: "articletopic:military-and-warfare", quota: 8, bookLeaning: true },
  { id: "historical-biography", search: "articletopic:biography articletopic:history", quota: 8, bookLeaning: true },
  { id: "religion-philosophy", search: "articletopic:philosophy-and-religion", quota: 6, bookLeaning: true },
  { id: "literature", search: "articletopic:literature", quota: 6, bookLeaning: true },
  { id: "architecture", search: "articletopic:architecture", quota: 6, bookLeaning: true },
  { id: "places", search: "articletopic:geographical -articletopic:sports", quota: 8, bookLeaning: true },
  { id: "science", search: "articletopic:stem -articletopic:computing -articletopic:software", quota: 6, bookLeaning: true },
  { id: "sports", search: "articletopic:sports", quota: 8, bookLeaning: false },
  { id: "music", search: "articletopic:music", quota: 6, bookLeaning: false },
  { id: "film-tv", search: "articletopic:films|television", quota: 6, bookLeaning: false },
  { id: "games-internet", search: "articletopic:video-games|internet-culture|software", quota: 5, bookLeaning: false },
  { id: "business", search: "articletopic:business-and-economics", quota: 5, bookLeaning: false },
  { id: "politics", search: "articletopic:politics-and-government -articletopic:history", quota: 5, bookLeaning: false },
  { id: "medicine", search: "articletopic:medicine-and-health", quota: 5, bookLeaning: false },
];
