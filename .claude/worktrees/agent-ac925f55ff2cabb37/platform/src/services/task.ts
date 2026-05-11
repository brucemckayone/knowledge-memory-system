import { ml } from './ml-client.js';

export interface ExtractedTask {
  action: string;
  due_date: string | null;
  priority: 'high' | 'medium' | 'low';
  confidence: number;
  raw_due_text?: string;
  rejection_reason?: string;
}

export interface ExtractedTaskEnhanced extends ExtractedTask {
  is_composite?: boolean;
  subtasks?: Array<{
    action: string;
    estimated_duration_minutes?: number;
    priority?: string;
    dependencies?: string[];
  }>;
  estimated_duration_minutes?: number;
  duration_confidence?: number;
  dependencies?: Array<{
    type: 'blocking' | 'prerequisite' | 'related';
    reference: string;
    confidence: number;
  }>;
  detected_conflicts?: Array<{
    type: string;
    description: string;
    severity: string;
  }>;
  suggestions?: string[];
  reasoning?: string;
}

/**
 * Extract task details from text using LLM
 *
 * Returns empty action for rejected/low-quality tasks
 */
export async function extractTask(text: string): Promise<ExtractedTask> {
  return ml.extractTask(text);
}

/**
 * Enhanced task extraction with context and preferences
 */
export async function extractTaskEnhanced(
  text: string,
  options: {
    contextMessages?: string[];
    existingTasks?: Array<{ content: string; id?: string }>;
    userPreferences?: Record<string, unknown>;
    includeReasoning?: boolean;
  } = {}
): Promise<ExtractedTaskEnhanced> {
  try {
    return await ml.extractTaskEnhanced(text, options);
  } catch {
    console.warn('Enhanced extraction failed, falling back to basic');
    return extractTask(text) as Promise<ExtractedTaskEnhanced>;
  }
}
