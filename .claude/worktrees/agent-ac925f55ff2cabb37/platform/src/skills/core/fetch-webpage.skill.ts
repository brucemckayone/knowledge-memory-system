import type { Skill, SkillContext } from '../types.js';
import { scrapeUrl, ScrapeResult } from '../../services/scrape.js';

export interface FetchWebpageInput {
  url: string;
}

export type FetchWebpageOutput = ScrapeResult;

/**
 * Fetch Webpage skill - Download and extract content from a URL
 */
export const fetchWebpageSkill: Skill<FetchWebpageInput, FetchWebpageOutput> = {
  name: 'fetch-webpage',
  description: 'Fetch and extract content from a webpage',
  version: '1.0.0',

  async execute(input: FetchWebpageInput, context: SkillContext): Promise<FetchWebpageOutput> {
    context.log(`Fetching: ${input.url}`);

    const result = await scrapeUrl(input.url);

    context.log(`Fetched "${result.title}" (${result.word_count} words)`);

    return result;
  },
};
