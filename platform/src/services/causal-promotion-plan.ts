/**
 * Causal-promotion planner — the DETERMINISTIC, DB-FREE core of the causal pass's
 * dispose side (doc 41 §6, §8a.6, §12 #5; bead nmemo-vpz.6 / E6).
 *
 * "Agents propose, reconciliation disposes" (doc 41 §1). The causal agent reads the
 * SETTLED canonical graph and writes candidate edges into `staging_causal_edges` via
 * `propose_causal_edge` — never canonical. This module is the pure authority that,
 * given the staged proposals + which events are settled + the live status of each
 * cited fact, computes exactly which edges to create (and whether to flag a stale
 * citation) and which to drop. `causal-promotion.ts` (the DB layer) loads the inputs,
 * calls {@link planCausalPromotion}, and applies the result.
 *
 * Disposal rules, per staged edge, in order:
 *   1. ref-resolve   DROP if the cited cause/effect event id is not a SETTLED
 *                    causal_event. Edges are built on promotion-minted (stable) ids
 *                    (§12 #5), so a miss means the agent grounded on something the
 *                    pass should not act on — the repointing / `expired_but_cited`
 *                    debt is designed out, not patched.
 *   2. self-loop     DROP if cause == effect.
 *   3. cited-fact    the §6 branch on each cited FACT's live status:
 *                      invalidated → KEEP + flag `stale_citation` (re-ground or
 *                                    expire next delta pass; NEVER auto-repoint —
 *                                    a different fact may not support the claim);
 *                      superseded  → KEEP, no flag (the past event is still real;
 *                                    the timeline merely moved on);
 *                      active      → KEEP, no flag.
 *   4. dedup         NOT done here — `createCausalEdge`'s corroborate-or-insert
 *                    (causal.ts) collapses duplicate claims for free at apply time.
 *
 * WHY pure + DB-free (the promotion-plan.ts discipline): same inputs always yield the
 * same plan, so the unit tests run with zero infra. Allowed imports: the
 * `SourceReference` type only (type-only, erased at compile time). Never the DB pool.
 */

import type { SourceReference } from './audit.js';

/** Live status of a fact cited as an edge source reference (doc 41 §6). */
export type CitedFactStatus = 'active' | 'superseded' | 'invalidated';

/** A staged causal edge, scoped from a `staging_causal_edges` row. */
export interface StagedCausalEdge {
  stagedEdgeId: string;
  causeEventId: string;
  effectEventId: string;
  reasoning: string;
  sourceReferences: SourceReference[];
}

/** A staged edge that survives disposal and will be written to canonical. */
export interface PlannedCausalEdge {
  stagedEdgeId: string;
  causeEventId: string;
  effectEventId: string;
  reasoning: string;
  sourceReferences: SourceReference[];
  /** true = cites an invalidated fact; flag stale_citation on a FRESH insert. */
  staleCitation: boolean;
  /** Why it is stale (cites which invalidated fact ids); null when not stale. */
  staleCitationReason: string | null;
}

/** A staged edge dropped during disposal, with the reason (for logging/audit). */
export interface DroppedCausalEdge {
  stagedEdgeId: string;
  reason: string;
}

export interface CausalPromotionPlan {
  toCreate: PlannedCausalEdge[];
  dropped: DroppedCausalEdge[];
}

/**
 * Pure, DB-free disposal planner (doc 41 §6, §8a.6). Given the staged edges, the set
 * of SETTLED causal-event ids, and the live status of every cited fact, computes the
 * edges to create (with the stale-citation flag) and the edges to drop. No DB, no
 * mutation — same inputs always yield the same plan, so the unit tests need zero infra.
 *
 * Dedup is intentionally NOT done here: `createCausalEdge`'s corroborate-or-insert
 * collapses duplicate claims at apply time, so the planner passes duplicates through.
 *
 * `citedFactStatus` only contains facts the applier found in `facts`. A cited fact id
 * absent from the map is a fact that no longer exists → treated as `invalidated`
 * (conservative: flag it rather than silently trust a vanished citation).
 */
export function planCausalPromotion(
  stagedEdges: StagedCausalEdge[],
  settledEventIds: ReadonlySet<string>,
  citedFactStatus: ReadonlyMap<string, CitedFactStatus>,
): CausalPromotionPlan {
  const toCreate: PlannedCausalEdge[] = [];
  const dropped: DroppedCausalEdge[] = [];

  for (const e of stagedEdges) {
    // (1) ref-resolve — both endpoints must be settled events.
    const causeOk = settledEventIds.has(e.causeEventId);
    const effectOk = settledEventIds.has(e.effectEventId);
    if (!causeOk || !effectOk) {
      const missing = [
        causeOk ? null : `cause ${e.causeEventId}`,
        effectOk ? null : `effect ${e.effectEventId}`,
      ]
        .filter(Boolean)
        .join(', ');
      dropped.push({
        stagedEdgeId: e.stagedEdgeId,
        reason: `unresolved event ref(s) not in settled causal_events: ${missing}`,
      });
      continue;
    }

    // (2) self-loop.
    if (e.causeEventId === e.effectEventId) {
      dropped.push({ stagedEdgeId: e.stagedEdgeId, reason: 'self-loop (cause == effect)' });
      continue;
    }

    // (3) cited-fact branch — invalidated → flag stale_citation; superseded/active → keep.
    const citedFactIds = e.sourceReferences.filter((r) => r.type === 'fact').map((r) => r.id);
    const invalidated = [
      ...new Set(citedFactIds.filter((fid) => (citedFactStatus.get(fid) ?? 'invalidated') === 'invalidated')),
    ].sort();

    let staleCitation = false;
    let staleCitationReason: string | null = null;
    if (invalidated.length > 0) {
      staleCitation = true;
      staleCitationReason = `cites invalidated fact(s): ${invalidated.join(', ')} — re-ground or expire next delta pass (never auto-repointed)`;
    }

    toCreate.push({
      stagedEdgeId: e.stagedEdgeId,
      causeEventId: e.causeEventId,
      effectEventId: e.effectEventId,
      reasoning: e.reasoning,
      sourceReferences: e.sourceReferences,
      staleCitation,
      staleCitationReason,
    });
  }

  // Canonical sort so the plan is order-independent by value (mirrors promotion-plan.ts).
  return {
    toCreate: toCreate.sort((a, b) => (a.stagedEdgeId < b.stagedEdgeId ? -1 : 1)),
    dropped: dropped.sort((a, b) => (a.stagedEdgeId < b.stagedEdgeId ? -1 : 1)),
  };
}
