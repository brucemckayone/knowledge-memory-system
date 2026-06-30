/**
 * Unit tests for repeat-run aggregation (doc 39 §2.F / §5 phase 6, nmemo-hm4.9).
 *
 * Pure — no DB / fs / network. Proves the population-stddev math, the NaN-safe
 * empty case, and that {@link aggregateRepeats} skips nulls per field so `n`
 * reflects the non-null count for the nullable metrics.
 */

import { describe, it, expect } from 'vitest';
import { aggregate, aggregateRepeats, type RepeatSample } from '../../services/benchmark-aggregate.js';

describe('aggregate', () => {
  it('computes mean / population stddev / min / max / n', () => {
    // Classic worked example: population stddev of this set is exactly 2.
    const a = aggregate([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(a.mean).toBe(5);
    expect(a.stddev).toBeCloseTo(2, 10); // population (÷ n), NOT sample (÷ n-1 → 2.138)
    expect(a.min).toBe(2);
    expect(a.max).toBe(9);
    expect(a.n).toBe(8);
  });

  it('is NaN-safe on an empty list (n === 0 → all zeros)', () => {
    expect(aggregate([])).toEqual({ mean: 0, stddev: 0, min: 0, max: 0, n: 0 });
  });

  it('handles a single value (stddev 0, min === max === mean)', () => {
    expect(aggregate([7])).toEqual({ mean: 7, stddev: 0, min: 7, max: 7, n: 1 });
  });
});

describe('aggregateRepeats', () => {
  // 3 repeats; the middle one has no gold-derived metrics (null current-state-
  // correctness / factF1 / sprawl) — the no-gold-this-repeat case.
  const samples: RepeatSample[] = [
    { wallClockMs: 100, entities: 10, activeFacts: 20, currentStateCorrectness: 0.5, invariantErrorViolations: 2, factF1VsGold: 0.6, predicateSprawlMax: 3 },
    { wallClockMs: 200, entities: 12, activeFacts: 24, currentStateCorrectness: null, invariantErrorViolations: 4, factF1VsGold: null, predicateSprawlMax: null },
    { wallClockMs: 300, entities: 14, activeFacts: 28, currentStateCorrectness: 1.0, invariantErrorViolations: 0, factF1VsGold: 0.8, predicateSprawlMax: 5 },
  ];
  const dist = aggregateRepeats(samples);

  it('emits one aggregate per RepeatSample metric field', () => {
    expect(Object.keys(dist).sort()).toEqual(
      ['activeFacts', 'currentStateCorrectness', 'entities', 'factF1VsGold', 'invariantErrorViolations', 'predicateSprawlMax', 'wallClockMs'],
    );
  });

  it('aggregates the always-present numeric fields over all 3 repeats', () => {
    // wallClockMs [100,200,300]: mean 200, popvar (10000+0+10000)/3 → stddev ≈ 81.6497.
    expect(dist.wallClockMs).toMatchObject({ mean: 200, min: 100, max: 300, n: 3 });
    expect(dist.wallClockMs!.stddev).toBeCloseTo(81.649658, 4);

    expect(dist.entities).toMatchObject({ mean: 12, min: 10, max: 14, n: 3 });
    expect(dist.activeFacts).toMatchObject({ mean: 24, min: 20, max: 28, n: 3 });

    // invariantErrorViolations [2,4,0]: mean 2, popvar (0+4+4)/3 → stddev ≈ 1.63299.
    expect(dist.invariantErrorViolations).toMatchObject({ mean: 2, min: 0, max: 4, n: 3 });
    expect(dist.invariantErrorViolations!.stddev).toBeCloseTo(1.632993, 4);
  });

  it('skips nulls per field so n reflects the non-null count', () => {
    // currentStateCorrectness present on 2 of 3 repeats [0.5, 1.0]: n=2, mean 0.75,
    // popvar ((−0.25)²+(0.25)²)/2 = 0.0625 → stddev 0.25.
    expect(dist.currentStateCorrectness).toMatchObject({ mean: 0.75, min: 0.5, max: 1.0, n: 2 });
    expect(dist.currentStateCorrectness!.stddev).toBeCloseTo(0.25, 10);

    // factF1VsGold [0.6, 0.8]: n=2, mean 0.7, stddev 0.1.
    expect(dist.factF1VsGold).toMatchObject({ mean: 0.7, min: 0.6, max: 0.8, n: 2 });
    expect(dist.factF1VsGold!.stddev).toBeCloseTo(0.1, 10);

    // predicateSprawlMax [3, 5]: n=2, mean 4, stddev 1.
    expect(dist.predicateSprawlMax).toMatchObject({ mean: 4, min: 3, max: 5, n: 2 });
    expect(dist.predicateSprawlMax!.stddev).toBeCloseTo(1, 10);
  });

  it('yields the n=0 empty aggregate for a field null on every repeat', () => {
    const allNull: RepeatSample[] = samples.map((s) => ({ ...s, factF1VsGold: null }));
    expect(aggregateRepeats(allNull).factF1VsGold).toEqual({ mean: 0, stddev: 0, min: 0, max: 0, n: 0 });
  });
});
