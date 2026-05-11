import { ml } from './ml-client.js';

export interface ScrapeResult {
  url: string;
  title: string;
  content: string;
  text: string;
  domain: string;
  word_count: number;
  description?: string;
  image?: string;
}

/**
 * Scrape and extract content from a URL
 */
export async function scrapeUrl(url: string): Promise<ScrapeResult> {
  return ml.scrape(url);
}
