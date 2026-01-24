import type { Skill, SkillContext } from '../types.js';

export interface ExtractUrlInput {
  text: string;
}

export interface ExtractUrlOutput {
  found: boolean;
  urls: Array<{
    url: string;
    domain: string;
    position: number;
  }>;
  primary_url?: string;
}

// URL regex that captures most common URLs
const URL_REGEX = /https?:\/\/(?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/gi;

/**
 * Extract URL skill - Find URLs in text
 */
export const extractUrlSkill: Skill<ExtractUrlInput, ExtractUrlOutput> = {
  name: 'extract-url',
  description: 'Extract URLs from text',
  version: '1.0.0',

  async execute(input: ExtractUrlInput, context: SkillContext): Promise<ExtractUrlOutput> {
    const matches = [...input.text.matchAll(URL_REGEX)];

    if (matches.length === 0) {
      context.log('No URLs found');
      return { found: false, urls: [] };
    }

    const urls = matches.map(match => {
      const url = match[0];
      let domain = 'unknown';
      try {
        domain = new URL(url).hostname.replace('www.', '');
      } catch {
        // Invalid URL, keep as-is
      }

      return {
        url,
        domain,
        position: match.index || 0,
      };
    });

    context.log(`Found ${urls.length} URL(s): ${urls.map(u => u.domain).join(', ')}`);

    const firstUrl = urls[0];
    return {
      found: true,
      urls,
      primary_url: firstUrl?.url,
    };
  },
};
