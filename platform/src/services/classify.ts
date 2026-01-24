import { config } from '../config.js';

export interface Intent {
  type: 'thought' | 'link' | 'task' | 'question' | 'search' | 'command';
  confidence: number;
}

export interface ClassificationResult {
  intents: Intent[];
  primary_intent: Intent['type'];
  suggested_workflow: string;
  reasoning?: string;
}

/**
 * Classify message intent using LLM
 */
export async function classify(
  text: string,
  includeReasoning = false
): Promise<ClassificationResult> {
  const response = await fetch(`${config.ML_SERVICES_URL}/classify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      include_reasoning: includeReasoning
    }),
  });

  if (!response.ok) {
    // Fallback on error
    console.warn(`Classification failed: ${response.statusText}`);
    return {
      intents: [{ type: 'thought', confidence: 0.5 }],
      primary_intent: 'thought',
      suggested_workflow: 'process-thought',
    };
  }

  return response.json() as Promise<ClassificationResult>;
}

/**
 * Check if classification service is available
 */
export async function checkClassifyHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${config.ML_SERVICES_URL}/classify/test`);
    return response.ok;
  } catch {
    return false;
  }
}
