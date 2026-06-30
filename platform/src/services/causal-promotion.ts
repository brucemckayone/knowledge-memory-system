/**
 * Causal-promotion (DB layer) — the apply side of the post-promotion causal pass's
 * disposal (doc 41 §6, §8a.6, §12 #5; bead nmemo-vpz.6 / E6). Mirrors promotion.ts:
 * it loads the inputs the pure {@link planCausalPromotion} needs, plans, and applies.
 *
 * The deterministic disposal rules (ref-resolve, self-loop, cited-fact branch, dedup)
 * live in `causal-promotion-plan.ts` (pure, DB-free). This module is only the seam to
 * the database + `createCausalEdge`.
 *
 * Invariant (doc 01): every promoted edge keeps non-empty reasoning +
 * source_references. The staging CHECKs (mig 044) enforce it on the way in, and
 * `createCausalEdge` re-validates it on the way out.
 */

import { db } from '../db/index.js';
import { config } from '../config.js';
import { eq, inArray, sql } from 'drizzle-orm';
import { causalEvents, stagingCausalEdges, facts as factsTable } from '../db/schema.js';
import { createCausalEdge } from './causal.js';
import { unwrapRows, type SourceReference } from './audit.js';
import {
  planCausalPromotion,
  type CitedFactStatus,
  type DroppedCausalEdge,
  type StagedCausalEdge,
} from './causal-promotion-plan.js';

export {
  planCausalPromotion,
  type CitedFactStatus,
  type StagedCausalEdge,
  type PlannedCausalEdge,
  type DroppedCausalEdge,
  type CausalPromotionPlan,
} from './causal-promotion-plan.js';

/** Promotion code, not an agent, disposes staged edges (mirrors promotion.ts PROMOTION_ACTOR). */
const CAUSAL_PROMOTION_ACTOR = 'promotion' as const;

export interface CausalPromotionResult {
  epochId: string;
  /** Edges actually written (or corroborated) to canonical, with whether stale was flagged. */
  created: Array<{ stagedEdgeId: string; edgeId: string; staleCitation: boolean }>;
  /** Staged edges dropped before write (ref-resolve, self-loop, or a createCausalEdge error). */
  dropped: DroppedCausalEdge[];
}

/**
 * Apply causal-promotion for one epoch (doc 41 §6; bead nmemo-vpz.6 / E6). Loads the
 * staged edges, gathers the inputs the pure planner needs (settled event ids + cited
 * fact statuses), plans, then writes each surviving edge via `createCausalEdge` and
 * flags stale citations.
 *
 * Unlike `applyPromotion` (one transaction), this is a loop of INDEPENDENT writes:
 * `createCausalEdge` (causal.ts) opens its own transaction, dedups (corroborate-or-
 * insert), re-validates the doc-01 invariant, and fires off pattern matching. The
 * causal pass is post-promotion and safe to re-run (dedup converges), so a per-edge
 * failure is routed to `dropped` rather than aborting the whole pass — one malformed
 * staged edge cannot block the rest on every retry (doc 41 §12 #9).
 */
export async function applyCausalPromotion(epochId: string): Promise<CausalPromotionResult> {
  // 1. Load this epoch's staged edges.
  const rows = await db
    .select({
      id: stagingCausalEdges.id,
      causeEventId: stagingCausalEdges.causeEventId,
      effectEventId: stagingCausalEdges.effectEventId,
      reasoning: stagingCausalEdges.reasoning,
      sourceReferences: stagingCausalEdges.sourceReferences,
    })
    .from(stagingCausalEdges)
    .where(eq(stagingCausalEdges.epochId, epochId));

  if (rows.length === 0) {
    return { epochId, created: [], dropped: [] };
  }

  const staged: StagedCausalEdge[] = rows.map((r) => ({
    stagedEdgeId: r.id,
    causeEventId: r.causeEventId,
    effectEventId: r.effectEventId,
    reasoning: r.reasoning,
    sourceReferences: (r.sourceReferences as SourceReference[]) ?? [],
  }));

  // 2. Settled event ids — which cited cause/effect events actually exist now.
  const eventIds = [...new Set(staged.flatMap((e) => [e.causeEventId, e.effectEventId]))];
  const eventRows = await db
    .select({ id: causalEvents.id })
    .from(causalEvents)
    .where(inArray(causalEvents.id, eventIds));
  const settledEventIds = new Set(eventRows.map((r) => r.id));

  // 3. Cited fact statuses — live status of every FACT cited as a source ref
  //    (mirrors the propose_causal_edge handler: invalid_at → invalidated;
  //    expired_at → superseded; else active).
  const citedFactIds = [
    ...new Set(staged.flatMap((e) => e.sourceReferences.filter((r) => r.type === 'fact').map((r) => r.id))),
  ];
  const citedFactStatus = new Map<string, CitedFactStatus>();
  if (citedFactIds.length > 0) {
    const factRows = await db
      .select({ id: factsTable.id, expiredAt: factsTable.expiredAt, invalidAt: factsTable.invalidAt })
      .from(factsTable)
      .where(inArray(factsTable.id, citedFactIds));
    for (const f of factRows) {
      citedFactStatus.set(f.id, f.invalidAt ? 'invalidated' : f.expiredAt ? 'superseded' : 'active');
    }
  }

  // 4. Pure plan.
  const plan = planCausalPromotion(staged, settledEventIds, citedFactStatus);

  // 5. Dispose — createCausalEdge owns its tx + dedup + validation. The pre-filter
  //    (ref-resolve + self-loop) prevents those validations throwing; a residual
  //    failure (e.g. a malformed source ref) is isolated to its own edge.
  const created: CausalPromotionResult['created'] = [];
  const dropped: DroppedCausalEdge[] = [...plan.dropped];

  for (const p of plan.toCreate) {
    let edgeId: string;
    try {
      edgeId = await createCausalEdge({
        causeEventId: p.causeEventId,
        effectEventId: p.effectEventId,
        strength: config.CAUSAL_PROMOTION_STRENGTH,
        reasoning: p.reasoning,
        sourceReferences: p.sourceReferences,
        extractionMethod: 'causal_promotion',
        actor: CAUSAL_PROMOTION_ACTOR,
      });
    } catch (err) {
      dropped.push({
        stagedEdgeId: p.stagedEdgeId,
        reason: `createCausalEdge failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // Flag stale_citation ONLY on a FRESH insert. createCausalEdge inserts new edges
    // at the corroboration_count default of 1; any corroboration increments it (≥2).
    // A corroboration lands the shaky ref on an edge with prior, independent grounding
    // — flagging it would condemn a healthy edge — so the WHERE clause skips it. The
    // RETURNING tells us whether the flag actually took.
    let flagged = false;
    if (p.staleCitation) {
      const res = await db.execute(sql`
        UPDATE public.causal_edges
        SET stale_citation = true, stale_citation_reason = ${p.staleCitationReason}
        WHERE id = ${edgeId}::uuid AND corroboration_count = 1
        RETURNING id
      `);
      flagged = unwrapRows<{ id: string }>(res).length > 0;
    }

    created.push({ stagedEdgeId: p.stagedEdgeId, edgeId, staleCitation: flagged });
  }

  return { epochId, created, dropped };
}
