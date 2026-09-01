/**
 * retrieval-eval — the arm registry.
 *
 * An arm turns the per-query base signals into a RANKING of entity indices. Every
 * arm the five harnesses used is expressed here as a pure function of the
 * precomputed base scores/rankings, so no arm recomputes cosines and the ranking
 * semantics are identical to the originals. Parameterised arm names:
 *   B<P>   DESC-pool(top P) -> NAME-rerank            (pool-rerank primary)
 *   Bp<P>  NAME-pool(top P) -> DESC-rerank            (pool-rerank control)
 *   H<K>   retrieved-set RRF(K) of (NAME, BM25-names) (shippable hybrid)
 *   HFULL<K> full-ranking RRF(K) of (NAME, BM25-names)
 * Fixed arm names: NAME, DESC, BM25n, FACTMAX, FACTMEAN, FACTNAME.
 *
 * bead nmemo-u8j.2
 */
import { rankByScore, rerank, rrfFullRanking } from './core.js';
import { reciprocalRankFusion } from '../../../services/fusion.js';

/** Eval tie-break: ascending entity index, reproducing the frozen rankByScore order. */
const byIndex = (a: number, b: number): number => a - b;

/** Which optional base signals an arm depends on. `name` is always available. */
export type Signal = 'desc' | 'bm25' | 'facts';

export interface Derived {
  U: number;
  nameScore: number[]; descScore?: number[]; bm25Score?: number[]; factMax?: number[]; factMean?: number[];
  rName: number[]; rDesc?: number[]; rBm25?: number[]; rFactMax?: number[]; rFactMean?: number[];
}

export type ArmFn = (d: Derived) => number[];
export interface ArmDef { fn: ArmFn; needs: Signal[] }

const FACTNAME_K = 60;

export function resolveArm(name: string): ArmDef {
  switch (name) {
    case 'NAME': return { fn: (d) => d.rName, needs: [] };
    case 'DESC': return { fn: (d) => d.rDesc!, needs: ['desc'] };
    case 'BM25n': return { fn: (d) => d.rBm25!, needs: ['bm25'] };
    case 'FACTMAX': return { fn: (d) => d.rFactMax!, needs: ['facts'] };
    case 'FACTMEAN': return { fn: (d) => d.rFactMean!, needs: ['facts'] };
    case 'FACTNAME':
      return { fn: (d) => reciprocalRankFusion([d.rName, d.rFactMax!], { k: FACTNAME_K, tieBreak: byIndex }), needs: ['facts'] };
    default: break;
  }
  let m = /^B(\d+)$/.exec(name);
  if (m) { const P = Number(m[1]); return { fn: (d) => rerank(d.rDesc!.slice(0, P), d.nameScore), needs: ['desc'] }; }
  m = /^Bp(\d+)$/.exec(name);
  if (m) { const P = Number(m[1]); return { fn: (d) => rerank(d.rName.slice(0, P), d.descScore!), needs: ['desc'] }; }
  m = /^HFULL(\d+)$/.exec(name);
  if (m) { const K = Number(m[1]); return { fn: (d) => rankByScore(rrfFullRanking([d.rName, d.rBm25!], K, d.U)), needs: ['bm25'] }; }
  m = /^H(\d+)$/.exec(name);
  if (m) { const K = Number(m[1]); return { fn: (d) => reciprocalRankFusion([d.rName, d.rBm25!], { k: K, tieBreak: byIndex }), needs: ['bm25'] }; }
  throw new Error(`unknown arm: ${name}`);
}
