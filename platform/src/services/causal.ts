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
import { recordEdgeChange, type Actor } from './audit.js';

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

  // Phase 1 audit context — REQUIRED.
  actor: Actor;
  reasoningReportId?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Corroboration strength bump per re-assertion (Phase 2 — doc 13).
 * Diminishing returns are enforced by the 1.0 cap, not by varying this delta.
 */
const CORROBORATION_STRENGTH_DELTA = 0.05;

function sourceRefKey(ref: SourceReference): string {
  return `${ref.type}:${ref.id}`;
}

/**
 * Merge two source-reference arrays, deduplicating by `${type}:${id}`. Returns
 * the merged array (existing first, then new unique refs in input order) plus
 * the diff — the refs from `added` that were not already present, used for the
 * `added_source_refs` column on the corroborated audit row.
 */
function mergeSourceReferences(
  existing: SourceReference[],
  added: SourceReference[],
): { merged: SourceReference[]; addedDiff: SourceReference[] } {
  const seen = new Set(existing.map(sourceRefKey));
  const merged: SourceReference[] = [...existing];
  const addedDiff: SourceReference[] = [];
  for (const ref of added) {
    const key = sourceRefKey(ref);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(ref);
      addedDiff.push(ref);
    }
  }
  return { merged, addedDiff };
}

/**
 * Apply the corroboration update + audit to an already-locked active edge.
 * Caller is responsible for selecting `existing` with `FOR UPDATE` inside the
 * same transaction so concurrent corroborations of the same target serialise
 * behind the row lock instead of racing.
 */
async function applyCorroboration(
  tx: typeof db,
  existing: { id: string; strength: number; source_references: unknown },
  params: CreateCausalEdgeParams,
): Promise<string> {
  const prevRefs = Array.isArray(existing.source_references)
    ? (existing.source_references as SourceReference[])
    : [];
  const { merged, addedDiff } = mergeSourceReferences(prevRefs, params.sourceReferences);
  const prevStrength = Number(existing.strength);
  const newStrength = Math.min(1.0, prevStrength + CORROBORATION_STRENGTH_DELTA);
  const mergedLiteral = sql.raw(
    `'${JSON.stringify(merged).replace(/'/g, "''")}'::jsonb`,
  );

  await tx.execute(sql`
    UPDATE public.causal_edges
    SET strength = ${newStrength},
        corroboration_count = corroboration_count + 1,
        last_corroborated = NOW(),
        source_references = ${mergedLiteral}
    WHERE id = ${existing.id}::uuid
  `);

  await recordEdgeChange({
    edgeId: existing.id,
    eventType: 'corroborated',
    previousStrength: prevStrength,
    newStrength,
    addedSourceRefs: addedDiff,
    reasoning: params.reasoning,
    actor: params.actor,
    reasoningReportId: params.reasoningReportId ?? null,
    tx,
  });

  return existing.id;
}

/**
 * Create a causal edge between two causal events, or corroborate an existing
 * active edge that represents the same causal claim.
 *
 * Corroboration runs in two stages (doc 13 part A):
 *   1. **Exact match** on `(cause_event_id, effect_event_id)`.
 *   2. **Semantic match** — same `(subject_entity_id, predicate)` on cause AND
 *      effect via different events. Strongest active candidate wins,
 *      tiebreak by earliest `created_at`.
 *
 * On either match, the existing edge is updated:
 *   - strength += 0.05 capped at 1.0
 *   - corroboration_count += 1
 *   - last_corroborated = NOW()
 *   - source_references merged (dedup by type+id)
 *   - causal_edge_history row with event_type='corroborated'
 *
 * Validates reasoning, source references, and event existence on all paths.
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

  // --- Corroborate-or-insert + audit (same transaction) ---
  // Drizzle 0.29 + postgres.js 3.4 stringify jsonb array values when passed
  // through `.values({ ... })` inside a tx callback (jsonb_typeof lands as
  // 'string' instead of 'array'). Outside a tx the same construction
  // serialises correctly. Workaround: perform the INSERT with a raw SQL
  // template (which postgres.js JSON-encodes once and casts server-side
  // with ::jsonb) inside the tx, then chain the audit write. See
  // docs/handoff/phase1-findings.md for the investigation notes.

  return db.transaction(async (tx) => {
    // Step 1: exact-match corroboration. SELECT … FOR UPDATE so two
    // concurrent corroborations of the same pair serialise behind the row
    // lock instead of racing into a duplicate edge.
    const exactResult = await tx.execute(sql`
      SELECT id, strength, source_references
      FROM public.causal_edges
      WHERE cause_event_id = ${params.causeEventId}::uuid
        AND effect_event_id = ${params.effectEventId}::uuid
        AND expired_at IS NULL
      LIMIT 1
      FOR UPDATE
    `);
    const exactRows = Array.isArray(exactResult)
      ? exactResult
      : (exactResult as { rows?: unknown[] }).rows ?? [];
    const exactMatch = exactRows[0] as
      | { id: string; strength: number; source_references: unknown }
      | undefined;

    if (exactMatch) {
      return applyCorroboration(tx as unknown as typeof db, exactMatch, params);
    }

    // Step 2: semantic-match corroboration. Two distinct (cause, effect)
    // event pairs that share `(subject_entity_id, predicate)` on both ends
    // describe the same causal claim — corroborate instead of branching.
    // JOIN equality naturally excludes NULL metadata; the IS NOT NULL
    // guards make that explicit and avoid surprising matches if the join
    // semantics ever shift. ORDER BY strength DESC, created_at ASC so the
    // strongest, oldest candidate wins (stable across runs).
    const semanticResult = await tx.execute(sql`
      WITH new_cause AS (
        SELECT subject_entity_id, predicate
        FROM public.causal_events
        WHERE id = ${params.causeEventId}::uuid
      ),
      new_effect AS (
        SELECT subject_entity_id, predicate
        FROM public.causal_events
        WHERE id = ${params.effectEventId}::uuid
      )
      SELECT e.id, e.strength, e.source_references
      FROM public.causal_edges e
      JOIN public.causal_events ce ON ce.id = e.cause_event_id
      JOIN public.causal_events ee ON ee.id = e.effect_event_id
      JOIN new_cause nc
        ON ce.subject_entity_id = nc.subject_entity_id
       AND ce.predicate = nc.predicate
      JOIN new_effect ne
        ON ee.subject_entity_id = ne.subject_entity_id
       AND ee.predicate = ne.predicate
      WHERE e.expired_at IS NULL
        AND nc.subject_entity_id IS NOT NULL
        AND nc.predicate IS NOT NULL
        AND ne.subject_entity_id IS NOT NULL
        AND ne.predicate IS NOT NULL
      ORDER BY e.strength DESC, e.created_at ASC
      LIMIT 1
      FOR UPDATE OF e
    `);
    const semanticRows = Array.isArray(semanticResult)
      ? semanticResult
      : (semanticResult as { rows?: unknown[] }).rows ?? [];
    const semanticMatch = semanticRows[0] as
      | { id: string; strength: number; source_references: unknown }
      | undefined;

    if (semanticMatch) {
      return applyCorroboration(tx as unknown as typeof db, semanticMatch, params);
    }

    // Step 3: no match — INSERT new edge.
    const inserted = await tx.execute(sql`
      INSERT INTO public.causal_edges (
        cause_event_id, effect_event_id, strength, reasoning,
        source_references, extraction_method, temporal_span, initial_strength,
        source_memory_id, source_text, pattern_id, pattern_position
      ) VALUES (
        ${params.causeEventId}::uuid,
        ${params.effectEventId}::uuid,
        ${params.strength},
        ${params.reasoning},
        ${sql.raw(`'${JSON.stringify(params.sourceReferences).replace(/'/g, "''")}'::jsonb`)},
        ${params.extractionMethod ?? 'llm'},
        ${params.temporalSpan ?? null},
        ${params.strength},
        ${params.sourceMemoryId ?? null}::uuid,
        ${params.sourceText ?? null},
        ${params.patternId ?? null}::uuid,
        ${params.patternPosition ?? null}
      ) RETURNING id
    `);

    const rows = Array.isArray(inserted) ? inserted : (inserted as { rows?: unknown[] }).rows ?? [];
    const edgeId = (rows[0] as { id: string } | undefined)?.id;
    if (!edgeId) throw new Error('createCausalEdge: INSERT returned no row');

    await recordEdgeChange({
      edgeId,
      eventType: 'created',
      newStrength: params.strength,
      newReasoning: params.reasoning,
      addedSourceRefs: params.sourceReferences,
      reasoning: params.reasoning,
      actor: params.actor,
      reasoningReportId: params.reasoningReportId ?? null,
      tx,
    });

    return edgeId;
  });
}

// ============================================
// Edge mutation helpers — Phase 1 lifecycle events
// ============================================

export interface ExpireCausalEdgeParams {
  edgeId: string;
  reasoning: string;
  actor: Actor;
  reasoningReportId?: string | null;
  /** Free-text reason persisted on causal_edges.expire_reason (defaults to `reasoning`). */
  expireReason?: string;
}

/**
 * Expire a causal edge (soft-delete via expired_at). Writes a
 * causal_edge_history row with event_type='expired' in the same transaction.
 * No-op if the edge is already expired or doesn't exist.
 */
export async function expireCausalEdge(params: ExpireCausalEdgeParams): Promise<void> {
  const { edgeId, reasoning, actor, reasoningReportId = null, expireReason } = params;

  const existing = await db
    .select({ strength: causalEdges.strength, reasoning: causalEdges.reasoning })
    .from(causalEdges)
    .where(and(eq(causalEdges.id, edgeId), isNull(causalEdges.expiredAt)))
    .limit(1);

  if (!existing[0]) return;

  await db.transaction(async (tx) => {
    await tx
      .update(causalEdges)
      .set({ expiredAt: new Date(), expireReason: expireReason ?? reasoning })
      .where(and(eq(causalEdges.id, edgeId), isNull(causalEdges.expiredAt)));

    await recordEdgeChange({
      edgeId,
      eventType: 'expired',
      previousStrength: existing[0]!.strength ?? null,
      newStrength: existing[0]!.strength ?? null,
      previousReasoning: existing[0]!.reasoning ?? null,
      reasoning,
      actor,
      reasoningReportId,
      tx,
    });
  });
}

export interface ReviseCausalEdgeParams {
  edgeId: string;
  /** Required narrative justification for the revision itself. */
  reasoning: string;
  actor: Actor;
  /** New strength value (optional — omit to keep current). */
  newStrength?: number;
  /** New on-edge reasoning text (optional — omit to keep current). */
  newReasoning?: string;
  /** Additional source references appended to the edge. */
  addedSourceRefs?: SourceReference[];
  reasoningReportId?: string | null;
}

/**
 * Revise a causal edge — update strength and/or on-edge reasoning, and
 * optionally append source references. Writes a causal_edge_history row with
 * event_type='revised' in the same transaction.
 *
 * @throws if the edge does not exist, is expired, or newStrength is out of range.
 */
export async function reviseCausalEdge(params: ReviseCausalEdgeParams): Promise<void> {
  const { edgeId, reasoning, actor, newStrength, newReasoning, addedSourceRefs, reasoningReportId = null } = params;

  if (newStrength !== undefined && (newStrength < 0 || newStrength > 1)) {
    throw new Error('newStrength must be between 0 and 1');
  }

  const existing = await db
    .select({
      strength: causalEdges.strength,
      reasoning: causalEdges.reasoning,
      sourceReferences: causalEdges.sourceReferences,
    })
    .from(causalEdges)
    .where(and(eq(causalEdges.id, edgeId), isNull(causalEdges.expiredAt)))
    .limit(1);

  if (!existing[0]) {
    throw new Error(`reviseCausalEdge: edge ${edgeId} not found or already expired`);
  }

  const prevStrength = existing[0].strength ?? 0;
  const prevReasoning = existing[0].reasoning;
  const prevRefs = Array.isArray(existing[0].sourceReferences) ? existing[0].sourceReferences : [];

  const mergedRefs: SourceReference[] = addedSourceRefs && addedSourceRefs.length > 0
    ? [...(prevRefs as SourceReference[]), ...addedSourceRefs]
    : (prevRefs as SourceReference[]);

  // Raw-SQL UPDATE (same jsonb-in-tx workaround as createCausalEdge).
  const mergedRefsLiteral = sql.raw(
    `'${JSON.stringify(mergedRefs).replace(/'/g, "''")}'::jsonb`,
  );

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE public.causal_edges
      SET strength = ${newStrength ?? prevStrength},
          reasoning = ${newReasoning ?? prevReasoning},
          source_references = ${mergedRefsLiteral}
      WHERE id = ${edgeId}::uuid
    `);

    await recordEdgeChange({
      edgeId,
      eventType: 'revised',
      previousStrength: prevStrength,
      newStrength: newStrength ?? prevStrength,
      previousReasoning: prevReasoning,
      newReasoning: newReasoning ?? prevReasoning,
      addedSourceRefs: addedSourceRefs ?? null,
      reasoning,
      actor,
      reasoningReportId,
      tx,
    });
  });
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
