/**
 * Unit tests for the PURE parts of the ingest ledger — sub-batch partitioning
 * and corpus fingerprinting. The DB-backed CRUD (createOrLoadJob etc.) is
 * exercised by the live resumable driver, not here.
 */

import { describe, it, expect } from 'vitest';
import { planSubBatches, corpusHash } from '../../services/ingest-plan.js';

describe('planSubBatches', () => {
  it('partitions into contiguous, ordered, non-overlapping ranges', () => {
    const plan = planSubBatches(200, 20);
    expect(plan).toHaveLength(10);
    expect(plan[0]).toEqual({ seq: 0, chunkStart: 0, chunkEnd: 20 });
    expect(plan[9]).toEqual({ seq: 9, chunkStart: 180, chunkEnd: 200 });
    // contiguous + monotonic
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i]!.chunkStart).toBe(plan[i - 1]!.chunkEnd);
      expect(plan[i]!.seq).toBe(plan[i - 1]!.seq + 1);
    }
  });

  it('puts the remainder in a short final sub-batch', () => {
    const plan = planSubBatches(45, 20);
    expect(plan.map((p) => [p.chunkStart, p.chunkEnd])).toEqual([
      [0, 20],
      [20, 40],
      [40, 45],
    ]);
  });

  it('yields a single sub-batch when the corpus fits in one', () => {
    expect(planSubBatches(8, 20)).toEqual([{ seq: 0, chunkStart: 0, chunkEnd: 8 }]);
  });

  it('yields nothing for an empty corpus', () => {
    expect(planSubBatches(0, 20)).toEqual([]);
  });

  it('rejects a non-positive sub-batch size', () => {
    expect(() => planSubBatches(10, 0)).toThrow();
    expect(() => planSubBatches(10, -5)).toThrow();
  });
});

describe('corpusHash', () => {
  it('is stable for the same chunks', () => {
    expect(corpusHash(['a', 'b', 'c'])).toBe(corpusHash(['a', 'b', 'c']));
  });

  it('is order-sensitive', () => {
    expect(corpusHash(['a', 'b'])).not.toBe(corpusHash(['b', 'a']));
  });

  it('changes when content changes', () => {
    expect(corpusHash(['a', 'b'])).not.toBe(corpusHash(['a', 'b', 'c']));
  });
});
