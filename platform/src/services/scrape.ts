import { config } from '../config.js';

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
  const response = await fetch(`${config.ML_SERVICES_URL}/scrape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Scraping failed: ${response.status} - ${error}`);
  }

  return response.json() as Promise<ScrapeResult>;
}
