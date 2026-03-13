import { ml, MlClientError } from './ml-client.js';

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
  try {
    const data = await ml.classify(text, includeReasoning);
    return data as ClassificationResult;
  } catch (error) {
    if (error instanceof MlClientError) {
      console.warn(`Classification failed: ${error.message}`);
    }
    return {
      intents: [{ type: 'thought', confidence: 0.5 }],
      primary_intent: 'thought',
      suggested_workflow: 'process-thought',
    };
  }
}

/**
 * Check if classification service is available
 */
export async function checkClassifyHealth(): Promise<boolean> {
  return ml.health();
}
