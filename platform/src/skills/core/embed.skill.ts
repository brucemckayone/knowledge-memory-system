import type { Skill, SkillContext } from '../types.js';

export interface EmbedInput {
  text: string;
  model?: string;
}

export interface EmbedOutput {
  vector: number[];
  model: string;
  dimensions: number;
}

/**
 * Embed skill - Generate embedding vector for text
 * Uses Ollama's nomic-embed-text model (768 dimensions)
 */
export const embedSkill: Skill<EmbedInput, EmbedOutput> = {
  name: 'embed',
  description: 'Generate embedding vector for text using Ollama',
  version: '1.0.0',

  async execute(input: EmbedInput, context: SkillContext): Promise<EmbedOutput> {
    context.log(`Generating embedding for ${input.text.length} chars`);

    const result = await context.services.ml.embed(input.text);

    context.log(`Generated ${result.dimensions}-dim vector`);

    return result;
  },
};
