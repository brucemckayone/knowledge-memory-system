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
// Orchestrator
// ============================================

/**
 * Run every detection heuristic in parallel. Each heuristic is INSERT-only
 * with `ON CONFLICT DO NOTHING` so they cannot conflict with each other.
 *
 * Group B ships only `detectOpposingObjects`; later groups extend the
 * orchestrator as the remaining heuristics land.
 */
export async function detectContradictions(): Promise<DetectionResult> {
  const [opposingCount] = await Promise.all([
    detectOpposingObjects(),
  ]);

  const byType: Partial<Record<ContradictionType, number>> = {};
  if (opposingCount > 0) byType.opposing_object = opposingCount;

  return {
    detected: opposingCount,
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
