/**
 * Causal Service
 *
 * Write and read functions for Graph C (causal graph).
 * Every edge requires reasoning (TEXT NOT NULL) and source_references (JSONB NOT NULL).
 */

import { db } from '../db/index.js';
import { rawQuery } from '../db/raw.js';
import { causalEdges, causalEvents, type CausalEvent, type CausalEdge } from '../db/schema.js';
import { eq, and, gte, lte, sql, or, inArray, isNull } from 'drizzle-orm';

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

// ============================================
// Read / Query Functions
// ============================================

export interface CausalChainNode {
  event: CausalEvent;
  edge?: CausalEdge; // the edge that connects this node to the next in the chain
}

export interface TraceOptions {
  maxDepth?: number;
  minStrength?: number;
}

/**
 * Walk Graph C backwards from a fact's causal event to root causes.
 * Returns the chain from root cause → ... → starting event.
 */
export async function traceCauses(
  factId: string,
  options: TraceOptions = {},
): Promise<CausalChainNode[]> {
  const { maxDepth = 10, minStrength = 0 } = options;

  const rows = await rawQuery<{
    eventId: string;
    factId: string | null;
    transitionType: string;
    subjectEntityId: string | null;
    predicate: string | null;
    deltaConfidence: number | null;
    occurredAt: Date;
    sourceMemoryId: string | null;
    sourceText: string | null;
    createdAt: Date;
    edgeId: string | null;
    causeEventId: string | null;
    effectEventId: string | null;
    strength: number | null;
    reasoning: string | null;
    sourceReferences: unknown;
    extractionMethod: string | null;
    depth: number;
  }>(sql`
    WITH RECURSIVE chain AS (
      -- Base: the event for this fact
      SELECT
        ce.id as event_id,
        ce.fact_id, ce.transition_type, ce.subject_entity_id,
        ce.predicate, ce.delta_confidence, ce.occurred_at,
        ce.source_memory_id, ce.source_text, ce.created_at,
        NULL::uuid as edge_id,
        NULL::uuid as cause_event_id,
        NULL::uuid as effect_event_id,
        NULL::float as strength,
        NULL::text as reasoning,
        NULL::jsonb as source_references,
        NULL::varchar as extraction_method,
        0 as depth
      FROM causal_events ce
      WHERE ce.fact_id = ${factId}

      UNION ALL

      -- Recurse: follow edges backwards (effect → cause)
      SELECT
        parent.id as event_id,
        parent.fact_id, parent.transition_type, parent.subject_entity_id,
        parent.predicate, parent.delta_confidence, parent.occurred_at,
        parent.source_memory_id, parent.source_text, parent.created_at,
        edge.id as edge_id,
        edge.cause_event_id,
        edge.effect_event_id,
        edge.strength,
        edge.reasoning,
        edge.source_references,
        edge.extraction_method,
        chain.depth + 1 as depth
      FROM chain
      JOIN causal_edges edge ON edge.effect_event_id = chain.event_id
        AND edge.expired_at IS NULL
        AND edge.strength >= ${minStrength}
      JOIN causal_events parent ON parent.id = edge.cause_event_id
      WHERE chain.depth < ${maxDepth}
    )
    SELECT * FROM chain ORDER BY depth DESC
  `);

  return rows.map(row => ({
    event: {
      id: row.eventId,
      factId: row.factId,
      transitionType: row.transitionType,
      subjectEntityId: row.subjectEntityId,
      predicate: row.predicate,
      deltaConfidence: row.deltaConfidence,
      occurredAt: row.occurredAt,
      sourceMemoryId: row.sourceMemoryId,
      sourceText: row.sourceText,
      createdAt: row.createdAt,
    } as CausalEvent,
    edge: row.edgeId ? {
      id: row.edgeId,
      causeEventId: row.causeEventId!,
      effectEventId: row.effectEventId!,
      strength: row.strength!,
      reasoning: row.reasoning!,
      sourceReferences: row.sourceReferences,
      extractionMethod: row.extractionMethod!,
    } as unknown as CausalEdge : undefined,
  }));
}

/**
 * Walk Graph C forward from a fact's causal event to downstream effects.
 * Returns the chain from starting event → ... → leaf effects.
 */
export async function projectTrajectory(
  factId: string,
  options: TraceOptions = {},
): Promise<CausalChainNode[]> {
  const { maxDepth = 10, minStrength = 0 } = options;

  const rows = await rawQuery<{
    eventId: string;
    factId: string | null;
    transitionType: string;
    subjectEntityId: string | null;
    predicate: string | null;
    deltaConfidence: number | null;
    occurredAt: Date;
    sourceMemoryId: string | null;
    sourceText: string | null;
    createdAt: Date;
    edgeId: string | null;
    causeEventId: string | null;
    effectEventId: string | null;
    strength: number | null;
    reasoning: string | null;
    sourceReferences: unknown;
    extractionMethod: string | null;
    depth: number;
  }>(sql`
    WITH RECURSIVE chain AS (
      -- Base: the event for this fact
      SELECT
        ce.id as event_id,
        ce.fact_id, ce.transition_type, ce.subject_entity_id,
        ce.predicate, ce.delta_confidence, ce.occurred_at,
        ce.source_memory_id, ce.source_text, ce.created_at,
        NULL::uuid as edge_id,
        NULL::uuid as cause_event_id,
        NULL::uuid as effect_event_id,
        NULL::float as strength,
        NULL::text as reasoning,
        NULL::jsonb as source_references,
        NULL::varchar as extraction_method,
        0 as depth
      FROM causal_events ce
      WHERE ce.fact_id = ${factId}

      UNION ALL

      -- Recurse: follow edges forward (cause → effect)
      SELECT
        child.id as event_id,
        child.fact_id, child.transition_type, child.subject_entity_id,
        child.predicate, child.delta_confidence, child.occurred_at,
        child.source_memory_id, child.source_text, child.created_at,
        edge.id as edge_id,
        edge.cause_event_id,
        edge.effect_event_id,
        edge.strength,
        edge.reasoning,
        edge.source_references,
        edge.extraction_method,
        chain.depth + 1 as depth
      FROM chain
      JOIN causal_edges edge ON edge.cause_event_id = chain.event_id
        AND edge.expired_at IS NULL
        AND edge.strength >= ${minStrength}
      JOIN causal_events child ON child.id = edge.effect_event_id
      WHERE chain.depth < ${maxDepth}
    )
    SELECT * FROM chain ORDER BY depth ASC
  `);

  return rows.map(row => ({
    event: {
      id: row.eventId,
      factId: row.factId,
      transitionType: row.transitionType,
      subjectEntityId: row.subjectEntityId,
      predicate: row.predicate,
      deltaConfidence: row.deltaConfidence,
      occurredAt: row.occurredAt,
      sourceMemoryId: row.sourceMemoryId,
      sourceText: row.sourceText,
      createdAt: row.createdAt,
    } as CausalEvent,
    edge: row.edgeId ? {
      id: row.edgeId,
      causeEventId: row.causeEventId!,
      effectEventId: row.effectEventId!,
      strength: row.strength!,
      reasoning: row.reasoning!,
      sourceReferences: row.sourceReferences,
      extractionMethod: row.extractionMethod!,
    } as unknown as CausalEdge : undefined,
  }));
}

/**
 * Get all causal events and edges involving an entity.
 */
export async function getEntityCausalHistory(entityId: string): Promise<{
  events: CausalEvent[];
  edges: CausalEdge[];
}> {
  const events = await db
    .select()
    .from(causalEvents)
    .where(eq(causalEvents.subjectEntityId, entityId))
    .orderBy(causalEvents.occurredAt);

  if (events.length === 0) {
    return { events: [], edges: [] };
  }

  const eventIds = events.map(e => e.id);

  // Find all active edges where cause or effect is one of this entity's events
  const edges = await db
    .select()
    .from(causalEdges)
    .where(and(
      isNull(causalEdges.expiredAt),
      or(
        inArray(causalEdges.causeEventId, eventIds),
        inArray(causalEdges.effectEventId, eventIds),
      ),
    ))
    .orderBy(causalEdges.createdAt);

  return { events, edges };
}

/**
 * Get causal events and edges created within a time window.
 */
export async function getCausalDelta(
  from: Date,
  to: Date,
  options: { entityId?: string } = {},
): Promise<{
  events: CausalEvent[];
  edges: CausalEdge[];
}> {
  const eventConditions = [
    gte(causalEvents.createdAt, from),
    lte(causalEvents.createdAt, to),
  ];
  if (options.entityId) {
    eventConditions.push(eq(causalEvents.subjectEntityId, options.entityId));
  }

  const events = await db
    .select()
    .from(causalEvents)
    .where(and(...eventConditions))
    .orderBy(causalEvents.createdAt);

  const edges = await db
    .select()
    .from(causalEdges)
    .where(and(
      gte(causalEdges.createdAt, from),
      lte(causalEdges.createdAt, to),
    ))
    .orderBy(causalEdges.createdAt);

  return { events, edges };
}
