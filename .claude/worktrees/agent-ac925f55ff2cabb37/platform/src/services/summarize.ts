import { ml } from './ml-client.js';

export interface SummarizeResult {
  summary: string;
  key_points: string[];
  word_count: number;
}

/**
 * Summarize text content using LLM
 */
export async function summarize(
  content: string,
  title?: string,
  maxLength = 4000
): Promise<SummarizeResult> {
  const truncated = content.slice(0, maxLength);
  return ml.summarize(truncated, title);
}
