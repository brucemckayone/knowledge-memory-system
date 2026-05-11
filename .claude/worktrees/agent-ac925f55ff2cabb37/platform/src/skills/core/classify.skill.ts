import type { Skill, SkillContext } from '../types.js';
import { classify, ClassificationResult } from '../../services/classify.js';

export interface ClassifyInput {
  text: string;
  include_reasoning?: boolean;
}

export type ClassifyOutput = ClassificationResult;

/**
 * Classify skill - Determine message intent using LLM router
 */
export const classifySkill: Skill<ClassifyInput, ClassifyOutput> = {
  name: 'classify',
  description: 'Classify message intent using LLM router',
  version: '1.0.0',

  async execute(input: ClassifyInput, context: SkillContext): Promise<ClassifyOutput> {
    context.log(`Classifying: "${input.text.slice(0, 50)}..."`);

    const result = await classify(input.text, input.include_reasoning);

    const intentsStr = result.intents
      .map(i => `${i.type}(${(i.confidence * 100).toFixed(0)}%)`)
      .join(', ');

    context.log(`Classified: [${intentsStr}] -> ${result.suggested_workflow}`);

    return result;
  },
};
