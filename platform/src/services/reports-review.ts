/**
 * Reports review — agent self-report vs graph cross-check (doc 39 §2.E, nmemo-hm4.8).
 *
 * PURE, deterministic. The agents' own `extraction_reports` / `gardening_reports`
 * / `reasoning_reports` (already in the rich dump under `graph.reports`) are a
 * second, independent signal: where the agent *claimed* an action, did the graph
 * actually get it? {@link reviewReports} cross-checks the self-reported actions
 * against the live graph and surfaces the mismatches as {@link Discrepancy}s —
 * dangling references (reported facts/entities/edges absent from the graph) and
 * gardening over-claims (more merges/same_as claimed than the graph holds).
 *
 * It also CHARACTERIZES the reports — counts per type/mode and the
 * thin/patrol-only reasoning reports (empty text / no actions, no touched rows)
 * observed today — so the harness can describe what the agents are actually
 * producing, not just where they disagree with the graph.
 *
 * Allowed imports: a TYPE-ONLY `RichGraph` (erased at runtime) — so this module
 * never transitively imports the DB pool and stays unit-testable under
 * vitest.unit.config.ts. Mirrors the terse Violation/finding style of
 * `graph-invariants.ts`.
 */

import type { RichGraph } from './graph-canonical-query.js';

// ============================================
// Result shapes
// ============================================

/** One report-vs-graph mismatch. `reportId` ties it back to the offending row. */
export interface Discrepancy {
  kind: string;
  reportType: 'extraction' | 'gardening' | 'reasoning';
  reportId: string;
  detail: string;
}

/** Descriptive tallies over the agents' self-reports (what they actually produced). */
export interface ReportsCharacterization {
  extractionCount: number;
  gardeningCount: number;
  reasoningCount: number;
  /** Reasoning reports tallied by `mode` (e.g. patrol / query). */
  reasoningByMode: Record<string, number>;
  /** Reasoning reports that are patrol-only/thin — empty text OR no actions + no touched rows. */
  thinReasoningReports: number;
  /** Total gardening `actions` across all gardening reports. */
  gardeningActionsTotal: number;
}

export interface ReportsReview {
  discrepancies: Discrepancy[];
  characterization: ReportsCharacterization;
}

// ============================================
// Helpers
// ============================================

/** Count of `actions` on a gardening report (`jsonb` array; defensively typed). */
function actionCount(actions: unknown): number {
  return Array.isArray(actions) ? actions.length : 0;
}

/** A reasoning report is thin/patrol-only: empty/whitespace text OR no actions + no touched rows. */
function isThinReasoning(r: RichGraph['reports']['reasoning'][number]): boolean {
  if (!r.report || r.report.trim() === '') return true;
  const noActions = actionCount(r.actionsTaken) === 0;
  const noRows =
    (r.entityIds?.length ?? 0) === 0 &&
    (r.factIds?.length ?? 0) === 0 &&
    (r.causalEdgeIds?.length ?? 0) === 0;
  return noActions && noRows;
}

// ============================================
// Review
// ============================================

/**
 * Cross-check the agents' self-reports against the graph + characterize them.
 * Pure + deterministic — no LLM, no DB.
 *
 * Cross-checks (→ `discrepancies`):
 *  - Reasoning dangling references: each `entityIds`/`factIds`/`causalEdgeIds`
 *    not present in the graph's entity/fact/edge id sets → one discrepancy each
 *    (the "reported rows absent from the graph" check).
 *  - Gardening over-claims: `sameAsCreated` > `graph.sameAs.length`, or
 *    `mergesExecuted` > the number of entities with a non-empty `mergedFrom`.
 *    Counts may be cumulative across runs, so these are best-effort signals.
 */
export function reviewReports(graph: RichGraph): ReportsReview {
  const entityIds = new Set(graph.entities.map((e) => e.id));
  const factIds = new Set(graph.facts.map((f) => f.id));
  const edgeIds = new Set(graph.edges.map((e) => e.id));
  const mergedEntityCount = graph.entities.filter((e) => (e.mergedFrom?.length ?? 0) > 0).length;

  const discrepancies: Discrepancy[] = [];
  const dangling = (reportId: string, field: string, refId: string): void => {
    discrepancies.push({
      kind: 'dangling_reference',
      reportType: 'reasoning',
      reportId,
      detail: `reasoning report ${reportId} references missing ${field} ${refId}`,
    });
  };

  // Reasoning-report dangling references — reported rows absent from the graph.
  for (const r of graph.reports.reasoning) {
    for (const eid of r.entityIds ?? []) if (!entityIds.has(eid)) dangling(r.id, 'entity', eid);
    for (const fid of r.factIds ?? []) if (!factIds.has(fid)) dangling(r.id, 'fact', fid);
    for (const cid of r.causalEdgeIds ?? []) if (!edgeIds.has(cid)) dangling(r.id, 'causal edge', cid);
  }

  // Gardening over-claims — more claimed than the graph holds. Cumulative counts
  // across runs make these best-effort (flagged in `detail`).
  for (const g of graph.reports.gardening) {
    if (g.sameAsCreated > graph.sameAs.length) {
      discrepancies.push({
        kind: 'sameas_overclaim',
        reportType: 'gardening',
        reportId: g.id,
        detail: `gardening report ${g.id} claims ${g.sameAsCreated} same_as created but graph holds ${graph.sameAs.length} (counts may be cumulative across runs)`,
      });
    }
    if (g.mergesExecuted > mergedEntityCount) {
      discrepancies.push({
        kind: 'merge_overclaim',
        reportType: 'gardening',
        reportId: g.id,
        detail: `gardening report ${g.id} claims ${g.mergesExecuted} merges but only ${mergedEntityCount} entities carry a merged-from lineage (counts may be cumulative across runs)`,
      });
    }
  }

  // Characterization — what the agents actually produced (incl. the thin/
  // patrol-only reasoning reports observed today).
  const reasoningByMode: Record<string, number> = {};
  let thinReasoningReports = 0;
  for (const r of graph.reports.reasoning) {
    reasoningByMode[r.mode] = (reasoningByMode[r.mode] ?? 0) + 1;
    if (isThinReasoning(r)) thinReasoningReports += 1;
  }
  const gardeningActionsTotal = graph.reports.gardening.reduce(
    (sum, g) => sum + actionCount(g.actions),
    0,
  );

  return {
    discrepancies,
    characterization: {
      extractionCount: graph.reports.extraction.length,
      gardeningCount: graph.reports.gardening.length,
      reasoningCount: graph.reports.reasoning.length,
      reasoningByMode,
      thinReasoningReports,
      gardeningActionsTotal,
    },
  };
}
