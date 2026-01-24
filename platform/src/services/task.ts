import { config } from '../config.js';

export interface ExtractedTask {
  action: string;
  due_date: string | null;
  priority: 'high' | 'medium' | 'low';
  confidence: number;
  raw_due_text?: string;
}

/**
 * Extract task details from text using LLM
 */
export async function extractTask(text: string): Promise<ExtractedTask> {
  const response = await fetch(`${config.ML_SERVICES_URL}/extract-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new Error(`Task extraction failed: ${response.statusText}`);
  }

  return response.json() as Promise<ExtractedTask>;
}
