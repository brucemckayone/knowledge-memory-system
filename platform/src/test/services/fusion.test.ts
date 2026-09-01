/**
 * reciprocalRankFusion — the shared RRF primitive (bead nmemo-u8j.1).
 *
 * This is the exact fusion the eval harness measures (retrieval-eval/arms routes
 * FACTNAME + H<K> through it) and the production read path ships
 * (retrieval.ts::recallEntitiesFused), so its contract — retrieved-set scoring,
 * score-descending order, deterministic tie-break — is locked here. Pure; no DB/ML.
 */
import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion, RRF_K_DEFAULT } from '../../services/fusion.js';

/** Reference retrieved-set RRF over dense indices, matching the frozen
 *  rankByScore(rrfRetrievedSet(...), 0) the eval used before extraction. */
function reference(rankings: number[][], k: number, universe: number): number[] {
  const s = new Array<number>(universe).fill(0);
  for (const r of rankings) for (let i = 0; i < r.length; i++) s[r[i]!] = s[r[i]!]! + 1 / (k + i + 1);
  return s.map((_, i) => i).filter((i) => s[i]! > 0).sort((a, b) => (s[b]! - s[a]!) || (a - b));
}

describe('reciprocalRankFusion', () => {
  it('a single ranking is returned in its own order', () => {
    expect(reciprocalRankFusion([[3, 1, 2]])).toEqual([3, 1, 2]);
  });

  it('agreement across inputs outranks a top rank in only one input', () => {
    // B is 2nd in both lists; A is 1st in one and absent from the other.
    // score(A) = 1/(k+1); score(B) = 2/(k+2). With k=60: A=0.0164, B=0.0323 -> B wins.
    const fused = reciprocalRankFusion([['A', 'B'], ['C', 'B']]);
    expect(fused[0]).toBe('B');
    expect(new Set(fused)).toEqual(new Set(['A', 'B', 'C']));
  });

  it('is retrieved-set, not full-ranking: an item absent from an input is not penalised for it', () => {
    // X appears only in list 1 at rank 0; Y appears in both at rank 1. X keeps its
    // full 1/(k+1); it is not charged a tail rank for being missing from list 2.
    const fused = reciprocalRankFusion([['X', 'Y'], ['Z', 'Y']], { k: 1 });
    // score(X)=1/2=0.5, score(Y)=1/3+1/3=0.667, score(Z)=1/2=0.5 -> Y, then X/Z tie
    expect(fused[0]).toBe('Y');
  });

  it('ties break by first appearance across inputs by default', () => {
    // X and Z both score 1/(k+1) (each rank-0 in one list). X is seen first.
    const fused = reciprocalRankFusion([['X'], ['Z']]);
    expect(fused).toEqual(['X', 'Z']);
  });

  it('honours an explicit tie-break (eval uses ascending index)', () => {
    const fused = reciprocalRankFusion([[5], [2]], { tieBreak: (a, b) => a - b });
    expect(fused).toEqual([2, 5]); // 2 < 5 wins the tie despite 5 seen first
  });

  it('reproduces the eval reference (retrieved-set + ascending-index tie-break) exactly', () => {
    const rName = [0, 4, 2, 9, 1];
    const rFact = [7, 4, 0, 3];
    const U = 10;
    const got = reciprocalRankFusion([rName, rFact], { k: RRF_K_DEFAULT, tieBreak: (a, b) => a - b });
    expect(got).toEqual(reference([rName, rFact], RRF_K_DEFAULT, U));
  });

  it('empty input yields empty output', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it('RRF_K_DEFAULT is 60 (the k R4 was confirmed at)', () => {
    expect(RRF_K_DEFAULT).toBe(60);
  });
});
