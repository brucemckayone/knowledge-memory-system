/**
 * Reciprocal Rank Fusion — the one confirmed cross-substrate retrieval lever.
 *
 * The 2026-09-01 single-graph loop settled that a single retrieval substrate
 * saturates (name / description / pool-re-rank / BM25-hybrid / fact-max all tie at
 * R@10 ~= 0.20-0.23), and the only thing that beats name-only is FUSING two
 * substrates: dense-over-names ⊕ dense-over-facts, combined by retrieved-set RRF
 * at k=60 (docs 14/16, R4 — +0.0724 strict R@10, above 0 on all three bootstraps,
 * adversary-verified on an independent extraction). This is that fusion, extracted
 * so the production read path (`retrieval.ts::recallEntitiesFused`) and the eval
 * harness (`test/tools/retrieval-eval`) share ONE definition and cannot drift.
 *
 * bead nmemo-u8j.1
 */

/** The k the R4 result was confirmed at. Larger k flattens the rank weighting. */
export const RRF_K_DEFAULT = 60;

/**
 * Retrieved-set Reciprocal Rank Fusion. Each input is a ranking (best-first) of
 * items; an item's fused score is the sum over the inputs it appears in of
 * `1 / (k + rank)` (rank 0-based). An item absent from an input contributes
 * nothing from that input — this is retrieved-set RRF, not full-ranking RRF, so a
 * shorter candidate list is not penalised for the items it never surfaced.
 *
 * Returns the items appearing in at least one input, sorted by fused score
 * descending. Ties break by `tieBreak` if given (the eval passes ascending entity
 * index to reproduce the frozen `rankByScore` order); otherwise by first
 * appearance across the inputs, so the result is always deterministic.
 */
export function reciprocalRankFusion<T>(
  rankings: T[][],
  opts: { k?: number; tieBreak?: (a: T, b: T) => number } = {},
): T[] {
  const k = opts.k ?? RRF_K_DEFAULT;
  const score = new Map<T, number>();
  const firstSeen = new Map<T, number>();
  const trackFirstSeen = opts.tieBreak === undefined; // only the default tie-break reads it
  let order = 0;
  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i++) {
      const item = ranking[i]!;
      score.set(item, (score.get(item) ?? 0) + 1 / (k + i + 1));
      if (trackFirstSeen && !firstSeen.has(item)) firstSeen.set(item, order++);
    }
  }
  const tieBreak = opts.tieBreak ?? ((a: T, b: T) => firstSeen.get(a)! - firstSeen.get(b)!);
  return [...score.keys()].sort((a, b) => (score.get(b)! - score.get(a)!) || tieBreak(a, b));
}
