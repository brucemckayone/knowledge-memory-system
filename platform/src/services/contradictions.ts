/**
 * Contradiction Detection Service (Phase 5 — doc 16)
 *
 * Detection: cheap SQL heuristics that flag conflicts without false positives
 * on clean data. Runs on the same periodic counter as confidence decay
 * (`pipeline.ts` DECAY_RUN_INTERVAL). Each heuristic INSERTs into
 * `public.contradictions` with `detected_by = 'sql_heuristic'`. The partial
 * unique index `idx_contradictions_unique_active` ensures re-running detection
 * does not duplicate rows for already-open contradictions.
 *
 * Resolution: thoughtful and auditable, executed by the reasoning agent during
 * patrol via `resolveContradiction()`. Resolution dispatches into the
 * existing `expireFact` / `invalidateFact` paths so audit + cascade fire for
 * free.
 *
 * Heuristics implemented in this group:
 *   - detectOpposingObjects — same subject + predicate with different active
 *     objects, excluding exclusive predicates (handled by supersession)
 *
 * Later groups add detectExpiredButCited, detectCyclicCausal,
 * detectTemporalImpossible.
 */

import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { expireFact, invalidateFact } from './facts.js';
import { expireCausalEdge } from './causal.js';
import { jsonbLiteral, type Actor } from './audit.js';
import {
  preflightBlastRadius,
  maybeWarnBlastRadius,
  type PreflightResult,
} from './impact.js';

// ============================================
// Types
// ============================================

export type ContradictionType =
  | 'opposing_object'
  | 'expired_but_cited'
  | 'cyclic_causal'
  | 'temporal_impossible'
  | 'chain_conflict';

export type ContradictionSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface DetectionResult {
  detected: number;
  byType: Partial<Record<ContradictionType, number>>;
}

export interface GetContradictionsOptions {
  unresolvedOnly?: boolean;
  contradictionType?: ContradictionType;
  severity?: ContradictionSeverity;
  limit?: number;
}

export interface ContradictionRow {
  id: string;
  contradictionType: ContradictionType;
  factAId: string | null;
  factBId: string | null;
  edgeAId: string | null;
  edgeBId: string | null;
  entityId: string | null;
  detectedAt: Date;
  detectedBy: string;
  detectionReasoning: string;
  detectionContext: Record<string, unknown> | null;
  severity: ContradictionSeverity;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionType: string | null;
  resolutionReasoning: string | null;
  resolutionReportId: string | null;
  dismissedReason: string | null;
}

// ============================================
// Detection — opposing_object
// ============================================

/**
 * Flag pairs of active facts that share `(subject_entity_id, predicate)` but
 * have different objects. Excludes facts whose predicate is marked
 * `is_exclusive=true` in `fact_predicates` — those are handled at write time
 * by supersession (newer fact expires older), so any surviving collision is
 * a write-path bug rather than a data-level contradiction.
 *
 * Severity is `high` when either fact has confidence >= 0.8 (the conflict is
 * between two well-supported claims), `medium` otherwise.
 *
 * Returns the number of newly-inserted contradiction rows.
 */
export async function detectOpposingObjects(): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO public.contradictions (
      contradiction_type, fact_a_id, fact_b_id, entity_id,
      detected_by, detection_reasoning, detection_context, severity
    )
    SELECT
      'opposing_object',
      LEAST(f1.id, f2.id),
      GREATEST(f1.id, f2.id),
      f1.subject_entity_id,
      'sql_heuristic',
      format(
        'Same subject %s and predicate %s with different objects: %s vs %s',
        f1.subject_entity_id, f1.predicate,
        COALESCE(f1.object_entity_id::text, f1.object_value),
        COALESCE(f2.object_entity_id::text, f2.object_value)
      ),
      jsonb_build_object(
        'fact_a_confidence', f1.confidence,
        'fact_b_confidence', f2.confidence
      ),
      CASE
        WHEN GREATEST(f1.confidence, f2.confidence) >= 0.8 THEN 'high'
        ELSE 'medium'
      END
    FROM public.facts f1
    JOIN public.facts f2 ON
      f1.subject_entity_id = f2.subject_entity_id
      AND f1.predicate = f2.predicate
      AND f1.id < f2.id
      AND (
        COALESCE(f1.object_entity_id::text, f1.object_value, '')
        <> COALESCE(f2.object_entity_id::text, f2.object_value, '')
      )
    WHERE f1.expired_at IS NULL AND f1.invalid_at IS NULL
      AND f2.expired_at IS NULL AND f2.invalid_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.fact_predicates p
        WHERE p.predicate = f1.predicate AND p.is_exclusive = true
      )
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  return (result as unknown as { length?: number }).length ?? 0;
}

// ============================================
// Detection — expired_but_cited
// ============================================

/**
 * Flag active causal edges whose `edge_source_refs` row of type `fact` points
 * at a fact that has been expired. The edge's grounding is compromised — at
 * least one of its evidence sources is no longer trusted.
 *
 * Severity:
 *   - corroboration_count = 1 → 'high' (sole source)
 *   - strength >= 0.7         → 'medium'
 *   - otherwise               → 'low'
 */
export async function detectExpiredButCited(): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO public.contradictions (
      contradiction_type, edge_a_id, fact_a_id,
      detected_by, detection_reasoning, detection_context, severity
    )
    SELECT DISTINCT
      'expired_but_cited',
      e.id,
      f.id,
      'sql_heuristic',
      format('Edge %s cites expired fact %s (expired_at=%s)', e.id, f.id, f.expired_at),
      jsonb_build_object(
        'corroboration_count', e.corroboration_count,
        'edge_strength', e.strength,
        'fact_expired_at', f.expired_at
      ),
      CASE
        WHEN e.corroboration_count = 1 THEN 'high'
        WHEN e.strength >= 0.7         THEN 'medium'
        ELSE 'low'
      END
    FROM public.causal_edges e
    JOIN public.edge_source_refs r ON r.edge_id = e.id AND r.ref_type = 'fact'
    JOIN public.facts f ON f.id = r.ref_id
    WHERE e.expired_at IS NULL
      AND f.expired_at IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  return (result as unknown as { length?: number }).length ?? 0;
}

// ============================================
// Detection — cyclic_causal
// ============================================

/**
 * Flag pairs of active causal edges that form a cycle (A→B and B→A) where
 * neither edge has a `temporal_span` set. True causality requires temporal
 * ordering; a cycle without temporal separation is a modelling error. Edges
 * with `temporal_span` set legitimately model time-windowed cycles
 * (e.g. periodic feedback loops) and are excluded.
 *
 * One contradiction per cycle (canonicalised via LEAST/GREATEST so the same
 * pair never produces two rows even if encountered in either order).
 */
export async function detectCyclicCausal(): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO public.contradictions (
      contradiction_type, edge_a_id, edge_b_id,
      detected_by, detection_reasoning, severity
    )
    SELECT
      'cyclic_causal',
      LEAST(e1.id, e2.id),
      GREATEST(e1.id, e2.id),
      'sql_heuristic',
      format(
        'Cyclic causality between edges %s and %s with no temporal_span on either',
        LEAST(e1.id, e2.id), GREATEST(e1.id, e2.id)
      ),
      'medium'
    FROM public.causal_edges e1
    JOIN public.causal_edges e2 ON
      e1.cause_event_id  = e2.effect_event_id
      AND e1.effect_event_id = e2.cause_event_id
      AND e1.id < e2.id
    WHERE e1.expired_at IS NULL AND e1.temporal_span IS NULL
      AND e2.expired_at IS NULL AND e2.temporal_span IS NULL
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  return (result as unknown as { length?: number }).length ?? 0;
}

// ============================================
// Detection — temporal_impossible
// ============================================

/**
 * Flag active causal edges whose cause event's `occurred_at` is later than the
 * effect event's `occurred_at`. Effect cannot precede cause. Severity is
 * always 'high' — temporal violations indicate either bad source data or a
 * write-path bug.
 */
export async function detectTemporalImpossible(): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO public.contradictions (
      contradiction_type, edge_a_id,
      detected_by, detection_reasoning, detection_context, severity
    )
    SELECT
      'temporal_impossible',
      e.id,
      'sql_heuristic',
      format(
        'Edge %s cause %s (occurred_at=%s) occurs after effect %s (occurred_at=%s)',
        e.id, ev1.id, ev1.occurred_at, ev2.id, ev2.occurred_at
      ),
      jsonb_build_object(
        'cause_occurred_at',  ev1.occurred_at,
        'effect_occurred_at', ev2.occurred_at,
        'inversion_seconds',  EXTRACT(EPOCH FROM (ev1.occurred_at - ev2.occurred_at))
      ),
      'high'
    FROM public.causal_edges e
    JOIN public.causal_events ev1 ON ev1.id = e.cause_event_id
    JOIN public.causal_events ev2 ON ev2.id = e.effect_event_id
    WHERE e.expired_at IS NULL
      AND ev1.occurred_at > ev2.occurred_at
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  return (result as unknown as { length?: number }).length ?? 0;
}

// ============================================
// Orchestrator
// ============================================

/**
 * Run every detection heuristic in parallel. Each heuristic is INSERT-only
 * with `ON CONFLICT DO NOTHING` so they cannot conflict with each other.
 */
export async function detectContradictions(): Promise<DetectionResult> {
  const [opposing, expired, cyclic, temporal] = await Promise.all([
    detectOpposingObjects(),
    detectExpiredButCited(),
    detectCyclicCausal(),
    detectTemporalImpossible(),
  ]);

  const byType: Partial<Record<ContradictionType, number>> = {};
  if (opposing > 0) byType.opposing_object = opposing;
  if (expired > 0)  byType.expired_but_cited = expired;
  if (cyclic > 0)   byType.cyclic_causal = cyclic;
  if (temporal > 0) byType.temporal_impossible = temporal;

  return {
    detected: opposing + expired + cyclic + temporal,
    byType,
  };
}

// ============================================
// Read API
// ============================================

/**
 * Fetch contradictions for the reasoning agent / viz / endpoints. Defaults
 * to unresolved only, newest first, limit 50.
 */
export async function getContradictions(
  options: GetContradictionsOptions = {},
): Promise<ContradictionRow[]> {
  const unresolvedOnly = options.unresolvedOnly ?? true;
  const limit = options.limit ?? 50;

  const result = await db.execute(sql`
    SELECT
      id,
      contradiction_type     AS "contradictionType",
      fact_a_id              AS "factAId",
      fact_b_id              AS "factBId",
      edge_a_id              AS "edgeAId",
      edge_b_id              AS "edgeBId",
      entity_id              AS "entityId",
      detected_at            AS "detectedAt",
      detected_by            AS "detectedBy",
      detection_reasoning    AS "detectionReasoning",
      detection_context      AS "detectionContext",
      severity,
      resolved_at            AS "resolvedAt",
      resolved_by            AS "resolvedBy",
      resolution_type        AS "resolutionType",
      resolution_reasoning   AS "resolutionReasoning",
      resolution_report_id   AS "resolutionReportId",
      dismissed_reason       AS "dismissedReason"
    FROM public.contradictions
    WHERE (${!unresolvedOnly}::boolean OR resolved_at IS NULL)
      AND (${options.contradictionType ?? null}::text IS NULL OR contradiction_type = ${options.contradictionType ?? null}::text)
      AND (${options.severity ?? null}::text IS NULL OR severity = ${options.severity ?? null}::text)
    ORDER BY detected_at DESC
    LIMIT ${limit}
  `);

  return result as unknown as ContradictionRow[];
}

// ============================================
// Resolution
// ============================================

export type ResolutionType =
  | 'expire_a'
  | 'expire_b'
  | 'expire_both'
  | 'invalidate_a'
  | 'invalidate_b'
  | 'expire_edge_a'
  | 'expire_edge_b'
  | 'expire_both_edges'
  | 'reconcile'
  | 'both_valid'
  | 'dismissed';

export interface ResolveContradictionParams {
  contradictionId: string;
  resolutionType: ResolutionType;
  resolutionReasoning: string;
  actor: Actor;
  reasoningReportId?: string | null;
  /** Required when resolutionType is 'dismissed' — captured to dismissed_reason. */
  dismissedReason?: string;
}

const MIN_REASONING_LENGTH = 20;

/**
 * Apply a resolution to a contradiction. Dispatches into the existing
 * `expireFact` / `invalidateFact` paths so audit + cascade fire for free,
 * then closes the contradiction with provenance fields populated.
 *
 * Side-effect matrix:
 *   expire_a          → expireFact(factAId)
 *   expire_b          → expireFact(factBId)
 *   expire_both       → expireFact(factAId) AND expireFact(factBId)
 *   invalidate_a      → invalidateFact(factAId)
 *   invalidate_b      → invalidateFact(factBId)
 *   expire_edge_a     → expireCausalEdge(edgeAId)
 *   expire_edge_b     → expireCausalEdge(edgeBId)
 *   expire_both_edges → expireCausalEdge(edgeAId) AND expireCausalEdge(edgeBId)
 *   reconcile         → no mutation (agent narrates the reconciliation only)
 *   both_valid        → no mutation (e.g. temporally-windowed claims)
 *   dismissed         → no mutation; dismissed_reason captured
 *
 * Throws if the contradiction is already resolved or if the reasoning is
 * shorter than MIN_REASONING_LENGTH characters.
 */
export async function resolveContradiction(
  params: ResolveContradictionParams,
): Promise<void> {
  const { contradictionId, resolutionType, resolutionReasoning, actor } = params;
  const reasoningReportId = params.reasoningReportId ?? null;

  if (!resolutionReasoning || resolutionReasoning.trim().length < MIN_REASONING_LENGTH) {
    throw new Error(
      `resolveContradiction: reasoning must be at least ${MIN_REASONING_LENGTH} characters; got ${resolutionReasoning?.length ?? 0}`,
    );
  }

  // Pre-mutation blast-radius severity captured per resolution type:
  //   - expire_a / expire_b / invalidate_a / invalidate_b → SeveritySummary
  //   - expire_edge_a / expire_edge_b                     → SeveritySummary
  //   - expire_both                                       → { fact_a, fact_b }
  //   - expire_both_edges                                 → { edge_a, edge_b }
  //   - reconcile / both_valid / dismissed                → null (no mutation)
  // Persisted onto contradictions.pre_resolve_blast_radius via the closing
  // UPDATE. See bead nmemo-2yv.102.
  let preResolveBlastRadius: unknown = null;

  // Wrap the claim + side effects + closing UPDATE in a single transaction so
  // the SELECT FOR UPDATE row-lock serialises concurrent callers on the same
  // contradiction. Previous shape did a SELECT (no lock), JS check, side
  // effects, and a final UPDATE — two simultaneous callers could both pass
  // the resolvedAt check and both run their side effects (e.g. expire_a +
  // expire_b expiring both facts when only one was intended). See bead
  // nmemo-2yv.38.
  await db.transaction(async (tx) => {
    /** Resolve a target fact to its preflight, warn-on-critical, return PreflightResult. */
    const preflightFactTarget = async (factId: string): Promise<PreflightResult | null> => {
      const result = await preflightBlastRadius({ nodeType: 'fact', nodeId: factId });
      if (result) {
        maybeWarnBlastRadius({
          severity: result.severity,
          totalAffected: result.totalAffected,
          actor,
          rootType: 'fact',
          rootId: factId,
        });
      }
      return result;
    };

    /**
     * Resolve an edge to its cause-event blast-radius. Bead nmemo-2yv.102:
     * "expiring an edge says 'this causal claim is wrong' and the cause is
     * the most natural anchor." The `expired_at IS NULL` filter mirrors
     * expireCausalEdge's no-op guard — an already-expired edge yields no
     * row, no preflight, no spurious critical-warn. Returns null if the
     * edge is missing/expired or (defensive) has no cause_event_id.
     */
    const preflightEdgeTarget = async (edgeId: string): Promise<PreflightResult | null> => {
      const rows = (await tx.execute(sql`
        SELECT cause_event_id::text AS "causeEventId"
        FROM public.causal_edges
        WHERE id = ${edgeId}::uuid AND expired_at IS NULL
        LIMIT 1
      `)) as unknown as Array<{ causeEventId: string | null }>;
      const causeEventId = rows[0]?.causeEventId;
      if (!causeEventId) return null;
      const result = await preflightBlastRadius({ nodeType: 'causal_event', nodeId: causeEventId });
      if (result) {
        maybeWarnBlastRadius({
          severity: result.severity,
          totalAffected: result.totalAffected,
          actor,
          rootType: 'causal_edge',
          rootId: edgeId,
        });
      }
      return result;
    };

    const lockedRows = (await tx.execute(sql`
      SELECT
        id::text                AS id,
        fact_a_id::text         AS "factAId",
        fact_b_id::text         AS "factBId",
        edge_a_id::text         AS "edgeAId",
        edge_b_id::text         AS "edgeBId",
        resolved_at             AS "resolvedAt"
      FROM public.contradictions
      WHERE id = ${contradictionId}::uuid
      FOR UPDATE
    `)) as unknown as Array<{
      id: string;
      factAId: string | null;
      factBId: string | null;
      edgeAId: string | null;
      edgeBId: string | null;
      resolvedAt: Date | null;
    }>;
    const contradiction = lockedRows[0];

    if (!contradiction) {
      throw new Error(`resolveContradiction: contradiction ${contradictionId} not found`);
    }
    if (contradiction.resolvedAt) {
      throw new Error(`resolveContradiction: ${contradictionId} already resolved`);
    }

    // Dispatch side effects on the locked tx so the contradiction claim,
    // fact/edge mutations, and final UPDATE commit atomically.
    switch (resolutionType) {
      case 'expire_a': {
        if (!contradiction.factAId) {
          throw new Error(`resolveContradiction: expire_a requires fact_a_id (none on ${contradictionId})`);
        }
        const preflight = await preflightFactTarget(contradiction.factAId);
        preResolveBlastRadius = preflight?.severity ?? null;
        await expireFact({ factId: contradiction.factAId, reasoning: resolutionReasoning, actor, reasoningReportId, tx, preExpireBlastRadius: preflight?.severity ?? null });
        break;
      }
      case 'expire_b': {
        if (!contradiction.factBId) {
          throw new Error(`resolveContradiction: expire_b requires fact_b_id (none on ${contradictionId})`);
        }
        const preflight = await preflightFactTarget(contradiction.factBId);
        preResolveBlastRadius = preflight?.severity ?? null;
        await expireFact({ factId: contradiction.factBId, reasoning: resolutionReasoning, actor, reasoningReportId, tx, preExpireBlastRadius: preflight?.severity ?? null });
        break;
      }
      case 'expire_both': {
        if (!contradiction.factAId || !contradiction.factBId) {
          throw new Error(`resolveContradiction: expire_both requires both fact_a_id and fact_b_id`);
        }
        const preflightA = await preflightFactTarget(contradiction.factAId);
        const preflightB = await preflightFactTarget(contradiction.factBId);
        preResolveBlastRadius = {
          fact_a: preflightA?.severity ?? null,
          fact_b: preflightB?.severity ?? null,
        };
        await expireFact({ factId: contradiction.factAId, reasoning: resolutionReasoning, actor, reasoningReportId, tx, preExpireBlastRadius: preflightA?.severity ?? null });
        await expireFact({ factId: contradiction.factBId, reasoning: resolutionReasoning, actor, reasoningReportId, tx, preExpireBlastRadius: preflightB?.severity ?? null });
        break;
      }
      case 'invalidate_a': {
        if (!contradiction.factAId) {
          throw new Error(`resolveContradiction: invalidate_a requires fact_a_id`);
        }
        const preflight = await preflightFactTarget(contradiction.factAId);
        preResolveBlastRadius = preflight?.severity ?? null;
        await invalidateFact({ factId: contradiction.factAId, reasoning: resolutionReasoning, actor, reasoningReportId, tx, preExpireBlastRadius: preflight?.severity ?? null });
        break;
      }
      case 'invalidate_b': {
        if (!contradiction.factBId) {
          throw new Error(`resolveContradiction: invalidate_b requires fact_b_id`);
        }
        const preflight = await preflightFactTarget(contradiction.factBId);
        preResolveBlastRadius = preflight?.severity ?? null;
        await invalidateFact({ factId: contradiction.factBId, reasoning: resolutionReasoning, actor, reasoningReportId, tx, preExpireBlastRadius: preflight?.severity ?? null });
        break;
      }
      case 'expire_edge_a': {
        if (!contradiction.edgeAId) {
          throw new Error(`resolveContradiction: expire_edge_a requires edge_a_id (none on ${contradictionId})`);
        }
        const preflight = await preflightEdgeTarget(contradiction.edgeAId);
        preResolveBlastRadius = preflight?.severity ?? null;
        await expireCausalEdge({ edgeId: contradiction.edgeAId, reasoning: resolutionReasoning, actor, reasoningReportId, tx, preExpireBlastRadius: preflight?.severity ?? null });
        break;
      }
      case 'expire_edge_b': {
        if (!contradiction.edgeBId) {
          throw new Error(`resolveContradiction: expire_edge_b requires edge_b_id (none on ${contradictionId})`);
        }
        const preflight = await preflightEdgeTarget(contradiction.edgeBId);
        preResolveBlastRadius = preflight?.severity ?? null;
        await expireCausalEdge({ edgeId: contradiction.edgeBId, reasoning: resolutionReasoning, actor, reasoningReportId, tx, preExpireBlastRadius: preflight?.severity ?? null });
        break;
      }
      case 'expire_both_edges': {
        if (!contradiction.edgeAId || !contradiction.edgeBId) {
          throw new Error(`resolveContradiction: expire_both_edges requires both edge_a_id and edge_b_id`);
        }
        const preflightA = await preflightEdgeTarget(contradiction.edgeAId);
        const preflightB = await preflightEdgeTarget(contradiction.edgeBId);
        preResolveBlastRadius = {
          edge_a: preflightA?.severity ?? null,
          edge_b: preflightB?.severity ?? null,
        };
        await expireCausalEdge({ edgeId: contradiction.edgeAId, reasoning: resolutionReasoning, actor, reasoningReportId, tx, preExpireBlastRadius: preflightA?.severity ?? null });
        await expireCausalEdge({ edgeId: contradiction.edgeBId, reasoning: resolutionReasoning, actor, reasoningReportId, tx, preExpireBlastRadius: preflightB?.severity ?? null });
        break;
      }
      case 'reconcile':
      case 'both_valid':
      case 'dismissed':
        // No mutation — the agent has narrated why the conflict is acceptable
        // or accommodated. The closing UPDATE below records the decision.
        break;
      default: {
        const _exhaustive: never = resolutionType;
        throw new Error(`resolveContradiction: unknown resolution_type ${JSON.stringify(_exhaustive)}`);
      }
    }

    const preResolveJsonb = preResolveBlastRadius == null
      ? sql`NULL::jsonb`
      : jsonbLiteral(preResolveBlastRadius);

    await tx.execute(sql`
      UPDATE public.contradictions
      SET resolved_at              = NOW(),
          resolved_by              = ${actor},
          resolution_type          = ${resolutionType},
          resolution_reasoning     = ${resolutionReasoning},
          resolution_report_id     = ${reasoningReportId},
          dismissed_reason         = ${resolutionType === 'dismissed' ? (params.dismissedReason ?? null) : null},
          pre_resolve_blast_radius = ${preResolveJsonb}
      WHERE id = ${contradictionId}::uuid
    `);
  });
}

export async function getContradictionById(id: string): Promise<ContradictionRow | null> {
  const result = await db.execute(sql`
    SELECT
      id,
      contradiction_type     AS "contradictionType",
      fact_a_id              AS "factAId",
      fact_b_id              AS "factBId",
      edge_a_id              AS "edgeAId",
      edge_b_id              AS "edgeBId",
      entity_id              AS "entityId",
      detected_at            AS "detectedAt",
      detected_by            AS "detectedBy",
      detection_reasoning    AS "detectionReasoning",
      detection_context      AS "detectionContext",
      severity,
      resolved_at            AS "resolvedAt",
      resolved_by            AS "resolvedBy",
      resolution_type        AS "resolutionType",
      resolution_reasoning   AS "resolutionReasoning",
      resolution_report_id   AS "resolutionReportId",
      dismissed_reason       AS "dismissedReason"
    FROM public.contradictions
    WHERE id = ${id}::uuid
  `);

  const rows = result as unknown as ContradictionRow[];
  return rows[0] ?? null;
}
