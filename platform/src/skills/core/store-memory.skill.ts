import type { Skill, SkillContext } from '../types.js';

export interface StoreMemoryInput {
  id: string;
  vector: number[];
  type: string;
  content: string;
  summary?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface StoreMemoryOutput {
  memory_id: string;
  stored_at: string;
}

/**
 * Store Memory skill - Persist a memory to Qdrant vector database
 * Includes origin context and metadata from the envelope
 */
export const storeMemorySkill: Skill<StoreMemoryInput, StoreMemoryOutput> = {
  name: 'store-memory',
  description: 'Store a memory in Qdrant vector database',
  version: '1.0.0',

  async execute(input: StoreMemoryInput, context: SkillContext): Promise<StoreMemoryOutput> {
    context.log(`Storing memory: ${input.type}`);

    const stored_at = new Date().toISOString();

    await context.services.qdrant.storeMemory({
      id: input.id,
      vector: input.vector,
      payload: {
        trace_id: input.id,
        type: input.type,
        content: input.content,
        summary: input.summary || input.content.slice(0, 200),
        tags: input.tags || [],
        created_at: stored_at,
        status: 'active',
        origin: context.envelope.origin,
        ...input.metadata,
      },
    });

    context.log(`Memory stored: ${input.id}`);

    return {
      memory_id: input.id,
      stored_at,
    };
  },
};
