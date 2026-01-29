import { config } from '../config.js';

export interface ExtractedTask {
  action: string;
  due_date: string | null;
  priority: 'high' | 'medium' | 'low';
  confidence: number;
  raw_due_text?: string;
  rejection_reason?: string; // Why task was rejected (if empty action)
}

export interface ExtractedTaskEnhanced extends ExtractedTask {
  // Enhanced fields from /extract-task-enhanced endpoint
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

/**
 * Enhanced task extraction with context and preferences
 *
 * Supports task decomposition, dependency extraction, effort estimation,
 * and conflict detection using the enhanced LLM endpoint.
 *
 * @param text - The user's message text
 * @param options - Additional context for better extraction
 * @returns Enhanced extracted task data
 */
export async function extractTaskEnhanced(
  text: string,
  options: {
    contextMessages?: string[];
    existingTasks?: Array<{ content: string; id?: string }>;
    userPreferences?: Record<string, any>;
    includeReasoning?: boolean;
  } = {}
): Promise<ExtractedTaskEnhanced> {
  const response = await fetch(`${config.ML_SERVICES_URL}/extract-task-enhanced`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      context_messages: options.contextMessages,
      existing_tasks: options.existingTasks,
      user_preferences: options.userPreferences,
      include_reasoning: options.includeReasoning ?? false,
    }),
  });

  if (!response.ok) {
    // Fall back to basic extraction on error
    console.warn('Enhanced extraction failed, falling back to basic:', response.statusText);
    return extractTask(text) as Promise<ExtractedTaskEnhanced>;
  }

  return response.json() as Promise<ExtractedTaskEnhanced>;
}
