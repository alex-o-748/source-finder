import type { CandidateSource, Citation } from "./types.js";

const NEWS_DOMAINS = [
  "nytimes.com",
  "washingtonpost.com",
  "theguardian.com",
  "bbc.com",
  "bbc.co.uk",
  "reuters.com",
  "apnews.com",
  "bloomberg.com",
  "wsj.com",
  "ft.com",
  "economist.com",
  "npr.org",
  "cnn.com",
  "aljazeera.com",
  "lemonde.fr",
];

const JOURNAL_DOMAINS = [
  "doi.org",
  "ncbi.nlm.nih.gov",
  "pubmed.ncbi.nlm.nih.gov",
  "arxiv.org",
  "nature.com",
  "science.org",
  "springer.com",
  "sciencedirect.com",
  "jstor.org",
  "cambridge.org",
  "oxfordjournals.org",
  "wiley.com",
  "tandfonline.com",
  "academic.oup.com",
];

const BOOK_DOMAINS = ["books.google.com", "archive.org/details"];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function pickKind(url: string): Citation["kind"] {
  const host = hostOf(url);
  const full = url.toLowerCase();
  if (JOURNAL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return "cite journal";
  }
  if (BOOK_DOMAINS.some((d) => full.includes(d))) {
    return "cite book";
  }
  if (NEWS_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return "cite news";
  }
  return "cite web";
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "{{!}}");
}

function today(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

/** Emits a Wikipedia cite template for a source, choosing the kind heuristically. */
export function formatCitation(source: CandidateSource): Citation {
  const kind = pickKind(source.url);
  const host = hostOf(source.url);
  const title = escapePipes(source.title || source.url);
  const accessDate = today();

  let template: string;
  switch (kind) {
    case "cite news":
      template = `{{cite news |url=${source.url} |title=${title} |work=${host} |access-date=${accessDate}}}`;
      break;
    case "cite journal":
      template = `{{cite journal |url=${source.url} |title=${title} |access-date=${accessDate}}}`;
      break;
    case "cite book":
      template = `{{cite book |url=${source.url} |title=${title} |access-date=${accessDate}}}`;
      break;
    case "cite web":
    default:
      template = `{{cite web |url=${source.url} |title=${title} |website=${host} |access-date=${accessDate}}}`;
      break;
  }

  return { template, kind };
}
