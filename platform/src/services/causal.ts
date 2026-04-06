/**
 * Causal Service — Write Functions
 *
 * Creates and validates causal edges in Graph C.
 * Every edge requires reasoning (TEXT NOT NULL) and source_references (JSONB NOT NULL).
 */

import { db } from '../db/index.js';
import { causalEdges, causalEvents } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export interface SourceReference {
  type: 'memory' | 'fact' | 'entity';
  id: string;
  relevance: string;
}

export interface CreateCausalEdgeParams {
  causeEventId: string;
  effectEventId: string;
  strength: number;
  reasoning: string;
  sourceReferences: SourceReference[];
  extractionMethod?: string;
  temporalSpan?: string;
  sourceMemoryId?: string;
  sourceText?: string;
  patternId?: string;
  patternPosition?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Create a causal edge between two causal events.
 * Validates reasoning, source references, and event existence.
 */
export async function createCausalEdge(params: CreateCausalEdgeParams): Promise<string> {
  // --- Validation ---

  if (!params.reasoning || params.reasoning.trim().length === 0) {
    throw new Error('reasoning must be a non-empty string');
  }

  if (!Array.isArray(params.sourceReferences) || params.sourceReferences.length === 0) {
    throw new Error('sourceReferences must be a non-empty array');
  }

  for (const ref of params.sourceReferences) {
    if (!['memory', 'fact', 'entity'].includes(ref.type)) {
      throw new Error(`sourceReference type must be 'memory', 'fact', or 'entity', got '${ref.type}'`);
    }
    if (!ref.id || !UUID_RE.test(ref.id)) {
      throw new Error(`sourceReference id must be a valid UUID, got '${ref.id}'`);
    }
    if (!ref.relevance || ref.relevance.trim().length === 0) {
      throw new Error('sourceReference relevance must be a non-empty string');
    }
  }

  if (params.causeEventId === params.effectEventId) {
    throw new Error('causeEventId and effectEventId must be different (no self-loops)');
  }

  if (params.strength < 0 || params.strength > 1) {
    throw new Error('strength must be between 0.0 and 1.0');
  }

  // Verify both events exist
  const [causeEvent, effectEvent] = await Promise.all([
    db.select({ id: causalEvents.id }).from(causalEvents).where(eq(causalEvents.id, params.causeEventId)).limit(1),
    db.select({ id: causalEvents.id }).from(causalEvents).where(eq(causalEvents.id, params.effectEventId)).limit(1),
  ]);

  if (causeEvent.length === 0) {
    throw new Error(`causeEventId '${params.causeEventId}' does not reference an existing causal event`);
  }
  if (effectEvent.length === 0) {
    throw new Error(`effectEventId '${params.effectEventId}' does not reference an existing causal event`);
  }

  // --- Insert ---

  const result = await db
    .insert(causalEdges)
    .values({
      causeEventId: params.causeEventId,
      effectEventId: params.effectEventId,
      strength: params.strength,
      reasoning: params.reasoning,
      sourceReferences: params.sourceReferences,
      extractionMethod: params.extractionMethod ?? 'llm',
      temporalSpan: params.temporalSpan ?? null,
      initialStrength: params.strength,
      sourceMemoryId: params.sourceMemoryId ?? null,
      sourceText: params.sourceText ?? null,
      patternId: params.patternId ?? null,
      patternPosition: params.patternPosition ?? null,
    })
    .returning({ id: causalEdges.id });

  return result[0]!.id;
}
