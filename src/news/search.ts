// News search. The spec just says "Web search scoped to financial news" —
// there's no preferred provider. We use yahoo-finance2's search() module
// (no API key, no rate limits we hit at benchmark scale) and return an
// empty list if nothing returns or the call fails.
//
// Real-world: swap this for SerpAPI/NewsAPI/Brave if you need richer results.

import yahooFinance from "yahoo-finance2";
import type { SearchNews, SearchResult } from "yahoo-finance2/modules/search";

const yf = new yahooFinance({ validation: { logErrors: false } });

export interface NewsHeadline {
  title: string;
  publisher?: string;
  link?: string;
  publishedAt?: string;
}

function toHeadline(n: SearchNews): NewsHeadline {
  const out: NewsHeadline = { title: n.title };
  if (n.publisher) out.publisher = n.publisher;
  if (n.link) out.link = n.link;
  if (n.providerPublishTime instanceof Date && !Number.isNaN(n.providerPublishTime.getTime())) {
    out.publishedAt = n.providerPublishTime.toISOString();
  }
  return out;
}

export async function searchNews(query: string): Promise<NewsHeadline[]> {
  try {
    const result: SearchResult = await yf.search(query, { newsCount: 10 });
    return (result.news ?? []).map(toHeadline);
  } catch {
    // News is non-critical to the benchmark — return empty on any failure.
    return [];
  }
}
