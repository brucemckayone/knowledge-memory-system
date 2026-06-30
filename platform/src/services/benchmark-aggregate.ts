/**
 * Repeat-run aggregation (doc 39 §2.F + §5 phase 6, nmemo-hm4.9).
 *
 * PURE, DB-free shaping. The comparison driver (`scripts/compare-ingestion.ts`)
 * runs each arm's FORWARD ingest several times (`--repeats N`) and captures one
 * {@link RepeatSample} per repeat; this module folds the N samples into per-metric
 * distributions (mean / population stddev / min / max / n) so a run reports
 * VARIANCE BANDS rather than single points — the LLM-noise envelope a single
 * forward run can't show. The distributions land in `metrics.distributions`
 * (→ metrics.json) and render in `report.md` (benchmark-report.ts).
 *
 * Imports nothing — kept pure so it stays unit-testable under
 * vitest.unit.config.ts and never pulls in the DB pool.
 */

/** Mean / population stddev / range for one metric over N samples. */
export interface Aggregate {
  mean: number;
  /** POPULATION stddev (÷ n, not n-1). */
  stddev: number;
  min: number;
  max: number;
  /** Count of (non-null) samples folded in. */
  n: number;
}

/**
 * One forward-repeat's headline metrics, derived from that repeat's rich graph.
 * Nullable fields are null when the inputs are absent (no gold authored for the
 * corpus); {@link aggregateRepeats} skips the nulls so `n` reflects how many
 * repeats actually carried that metric.
 */
export interface RepeatSample {
  wallClockMs: number;
  entities: number;
  activeFacts: number;
  /** Fraction (0..1) of gold exclusive expectations that pass; null without gold. */
  currentStateCorrectness: number | null;
  /** Total error-invariant violation rows (runInvariants(rich).summary.errorViolations). */
  invariantErrorViolations: number;
  /** Current-fact F1 vs gold.currentFacts; null without gold. */
  factF1VsGold: number | null;
  /** Max distinct-predicate count across sprawled exclusive groups; null without gold. */
  predicateSprawlMax: number | null;
}

/**
 * Aggregate a list of numbers into mean / population stddev / min / max / n.
 * NaN-safe: an empty list returns all-zeros with `n: 0` (never NaN), so an
 * all-null nullable field aggregates cleanly.
 */
export function aggregate(values: number[]): Aggregate {
  const n = values.length;
  if (n === 0) return { mean: 0, stddev: 0, min: 0, max: 0, n: 0 };
  let sum = 0;
  let min = values[0]!;
  let max = values[0]!;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
  return { mean, stddev: Math.sqrt(variance), min, max, n };
}

/** The numeric metric keys of {@link RepeatSample} — one distribution entry each. */
const SAMPLE_KEYS: Array<keyof RepeatSample> = [
  'wallClockMs',
  'entities',
  'activeFacts',
  'currentStateCorrectness',
  'invariantErrorViolations',
  'factF1VsGold',
  'predicateSprawlMax',
];

/**
 * Fold N {@link RepeatSample}s into one {@link Aggregate} per metric field. Nulls
 * are skipped per field (so a nullable metric absent on every repeat yields the
 * `n: 0` empty aggregate, and a partially-present one reflects only the present
 * repeats in `n`). Pure.
 */
export function aggregateRepeats(samples: RepeatSample[]): Record<string, Aggregate> {
  const out: Record<string, Aggregate> = {};
  for (const key of SAMPLE_KEYS) {
    const values: number[] = [];
    for (const s of samples) {
      const v = s[key];
      if (typeof v === 'number') values.push(v);
    }
    out[key] = aggregate(values);
  }
  return out;
}
