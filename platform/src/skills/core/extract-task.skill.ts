import type { Skill, SkillContext } from '../types.js';
import { extractTask, ExtractedTask } from '../../services/task.js';

export interface ExtractTaskInput {
  text: string;
}

export type ExtractTaskOutput = ExtractedTask;

/**
 * Extract Task skill - Parse task details from natural language
 */
export const extractTaskSkill: Skill<ExtractTaskInput, ExtractTaskOutput> = {
  name: 'extract-task',
  description: 'Extract task details from text using LLM',
  version: '1.0.0',

  async execute(input: ExtractTaskInput, context: SkillContext): Promise<ExtractTaskOutput> {
    context.log(`Extracting task from: "${input.text.slice(0, 50)}..."`);

    const result = await extractTask(input.text);

    context.log(`Extracted: "${result.action}" (${result.priority}, ${result.due_date || 'no date'})`);

    return result;
  },
};
