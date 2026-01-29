import type { Skill, SkillContext } from '../types.js';
import { extractTask, extractTaskEnhanced, ExtractedTask, ExtractedTaskEnhanced } from '../../services/task.js';

export interface ExtractTaskInput {
  text: string;
  contextMessages?: string[];
  existingTasks?: Array<{ content: string; id?: string }>;
  userPreferences?: Record<string, any>;
  useEnhanced?: boolean;
}

export type ExtractTaskOutput = ExtractedTaskEnhanced;

// Quality thresholds (must match ML service)
const MIN_CONFIDENCE = 0.6;
const MIN_CONTENT_LENGTH = 10;

/**
 * Extract Task skill - Parse task details from natural language
 *
 * Enhanced version supports:
 * - Task decomposition (composite tasks → subtasks)
 * - Dependency detection
 * - Conflict detection
 * - Effort estimation
 * - Context-aware extraction
 *
 * Quality Gate: Returns empty action for low-quality tasks
 */
export const extractTaskSkill: Skill<ExtractTaskInput, ExtractTaskOutput> = {
  name: 'extract-task',
  description: 'Extract task details from text using LLM (supports enhanced mode with decomposition)',
  version: '2.0.0',

  async execute(input: ExtractTaskInput, context: SkillContext): Promise<ExtractTaskOutput> {
    context.log(`Extracting task from: "${input.text.slice(0, 50)}..."` + (input.useEnhanced ? ' (enhanced)' : ''));

    let result: ExtractedTask | ExtractedTaskEnhanced;

    // Use enhanced extraction if requested or if context is provided
    if (input.useEnhanced || input.contextMessages || input.existingTasks || input.userPreferences) {
      try {
        result = await extractTaskEnhanced(input.text, {
          contextMessages: input.contextMessages,
          existingTasks: input.existingTasks,
          userPreferences: input.userPreferences,
          includeReasoning: false,
        });
      } catch (error) {
        context.log(`Enhanced extraction failed, falling back to basic: ${error}`);
        result = await extractTask(input.text);
      }
    } else {
      result = await extractTask(input.text);
    }

    // Quality gate: Check if task was rejected by ML service
    if (!result.action || result.action.length < MIN_CONTENT_LENGTH) {
      context.log(`Task rejected by ML service: ${result.rejection_reason || 'insufficient content'}`);

      // Return empty action to signal rejection (confidence may be 0 or low)
      return {
        action: '',
        due_date: null,
        priority: 'low',
        confidence: result.confidence || 0.0,
        raw_due_text: result.raw_due_text,
        rejection_reason: result.rejection_reason || 'Task rejected: insufficient content',
      };
    }

    // Quality gate: Check confidence threshold
    if (result.confidence < MIN_CONFIDENCE) {
      context.log(`Task blocked: low confidence (${result.confidence} < ${MIN_CONFIDENCE})`);

      return {
        action: '',
        due_date: null,
        priority: 'low',
        confidence: result.confidence,
        raw_due_text: result.raw_due_text,
        rejection_reason: `Confidence too low: ${result.confidence} < ${MIN_CONFIDENCE}`,
      };
    }

    const isComposite = (result as ExtractedTaskEnhanced).is_composite;
    const subtaskCount = (result as ExtractedTaskEnhanced).subtasks?.length || 0;
    const depCount = (result as ExtractedTaskEnhanced).dependencies?.length || 0;

    context.log(`Extracted: "${result.action}" (${result.priority}, ${result.due_date || 'no date'}, confidence: ${result.confidence}${isComposite ? `, composite: ${subtaskCount} subtasks` : ''}${depCount > 0 ? `, ${depCount} dependencies` : ''})`);

    return result as ExtractTaskOutput;
  },
};
