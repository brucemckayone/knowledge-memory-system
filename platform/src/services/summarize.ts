import { config } from '../config.js';

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
  // Truncate content if too long
  const truncated = content.slice(0, maxLength);

  const response = await fetch(`${config.ML_SERVICES_URL}/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: truncated,
      title: title || 'Untitled',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Summarization failed: ${response.status} - ${error}`);
  }

  return response.json() as Promise<SummarizeResult>;
}
