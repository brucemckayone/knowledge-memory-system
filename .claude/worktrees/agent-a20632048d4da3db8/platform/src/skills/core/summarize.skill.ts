import type { Skill, SkillContext } from '../types.js';
import { summarize, SummarizeResult } from '../../services/summarize.js';

export interface SummarizeInput {
  content: string;
  title?: string;
}

export type SummarizeOutput = SummarizeResult;

/**
 * Summarize skill - Generate summary using LLM
 */
export const summarizeSkill: Skill<SummarizeInput, SummarizeOutput> = {
  name: 'summarize',
  description: 'Summarize text content using LLM',
  version: '1.0.0',

  async execute(input: SummarizeInput, context: SkillContext): Promise<SummarizeOutput> {
    context.log(`Summarizing: ${input.content.slice(0, 50)}...`);

    const result = await summarize(input.content, input.title);

    context.log(`Summary: ${result.summary.slice(0, 100)}...`);

    return result;
  },
};
