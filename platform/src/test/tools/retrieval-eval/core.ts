/**
 * retrieval-eval — shared numeric / oracle / statistics primitives.
 *
 * These were copy-pasted verbatim across the five one-off loop harnesses
 * (e0-oracle, pool-rerank, hybrid-names, fact-level, arxiv-fusion). They live
 * here now so there is exactly ONE definition of the bootstrap, both oracle rank
 * functions, RRF, and the cosine helpers. Every function is lifted byte-for-byte
 * from those harnesses so the folded configs reproduce the frozen results
 * bit-exactly (docs 07/10/12/14/16). Do not "improve" them — the frozen numbers
 * depend on the exact tie-break, seed, and resample order.
 *
 * bead nmemo-u8j.2
 */

// ---- numeric ---------------------------------------------------------------

/** Deterministic PRNG. Seed + call order fixes every bootstrap CI. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export function norm(v: number[]): number {
  let m = 0;
  for (const x of v) m += x * x;
  return Math.sqrt(m);
}

export function normalise(v: number[]): number[] {
  const m = norm(v);
  return m === 0 ? v.slice() : v.map((x) => x / m);
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

/** Rank indices by score, descending, tie-break index ascending. Drops indices
 *  at or below `minScore` (used to exclude -Infinity / zero-score entities). */
export function rankByScore(scores: number[], minScore = -Infinity): number[] {
  const idx = scores.map((_, i) => i).filter((i) => scores[i]! > minScore);
  idx.sort((a, b) => (scores[b]! - scores[a]!) || (a - b));
  return idx;
}

/** Re-rank a fixed pool of indices by a score array, desc, tie-break index asc. */
export function rerank(pool: number[], scores: number[]): number[] {
  return [...pool].sort((a, b) => (scores[b]! - scores[a]!) || (a - b));
}

/** Retrieved-set RRF lives in services/fusion.ts (reciprocalRankFusion) so the
 *  eval and the production read path share one definition; the arms import it.
 *
 *  RRF over the FULL ranking: an index missing from an input is treated as
 *  ranked at r.length (the tail), so every input contributes to every index. */
export function rrfFullRanking(rankings: number[][], K: number, universe: number): number[] {
  const s = new Array<number>(universe).fill(0);
  for (const r of rankings) {
    const rankOf = new Array<number>(universe).fill(r.length);
    for (let i = 0; i < r.length; i++) rankOf[r[i]!] = i;
    for (let u = 0; u < universe; u++) s[u] = s[u]! + 1 / (K + rankOf[u]! + 1);
  }
  return s;
}

/** Parse a pgvector text literal `[a,b,...]` into a number[]. */
export function parseVec(text: string): number[] {
  return text.trim().replace(/^\[/, '').replace(/\]$/, '').split(',').map(Number);
}

// ---- BM25 ------------------------------------------------------------------

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

export function tokenise(t: string): string[] {
  return t.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 0);
}

export interface Bm25Index {
  docLen: number[];
  avgLen: number;
  df: Map<string, number>;
  tf: Array<Map<string, number>>;
  n: number;
}

export function buildBm25(docs: string[]): Bm25Index {
  const docTokens = docs.map(tokenise);
  const docLen = docTokens.map((t) => t.length);
  const avgLen = docLen.reduce((s, x) => s + x, 0) / Math.max(1, docLen.length);
  const df = new Map<string, number>();
  for (const toks of docTokens) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const tf = docTokens.map((toks) => {
    const m = new Map<string, number>();
    for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  });
  return { docLen, avgLen, df, tf, n: docs.length };
}

export function bm25Scores(idx: Bm25Index, query: string, k1 = BM25_K1, b = BM25_B): number[] {
  const out = new Array<number>(idx.n).fill(0);
  for (const q of new Set(tokenise(query))) {
    const dfq = idx.df.get(q);
    if (!dfq) continue;
    const idf = Math.log(1 + (idx.n - dfq + 0.5) / (dfq + 0.5));
    for (let d = 0; d < idx.n; d++) {
      const f = idx.tf[d]!.get(q);
      if (!f) continue;
      out[d] = out[d]! + idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (idx.docLen[d]! / idx.avgLen))));
    }
  }
  return out;
}

// ---- oracle rank functions -------------------------------------------------

/** Word-boundary matcher for a verbatim name (Tier B), name regex-escaped.
 *  Boundary defined against [a-z0-9]. Match against a lower-cased text. */
export function nameMatcher(name: string): RegExp {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`);
}

/** strict rank of the target in a ranking (1-based; Infinity if absent). */
export function strictRankOf(ranking: number[], t: number): number {
  const i = ranking.indexOf(t);
  return i < 0 ? Infinity : i + 1;
}

/** condensed rank: 1 + count of NON-relevant entities ranked above the target. */
export function condensedRankOf(ranking: number[], t: number, relevant: Set<number>): number {
  const posT = ranking.indexOf(t);
  if (posT < 0) return Infinity;
  let above = 0;
  for (let r = 0; r < posT; r++) {
    const i = ranking[r]!;
    if (i === t) continue;
    if (relevant.has(i)) continue;
    above += 1;
  }
  return above + 1;
}

// ---- statistics ------------------------------------------------------------

export interface BootstrapResult { delta: number; lo: number; hi: number }
export interface TriResult { byPair: BootstrapResult; byEntity: BootstrapResult; byDocument: BootstrapResult }

/** Paired cluster bootstrap over UNITS grouped by a cluster key. Passing each
 *  pair index as its own cluster reproduces the pre-registered pair bootstrap. */
export function clusteredBootstrap(
  a: number[], b: number[], clusterOf: string[], resamples = 10_000, seed = 20260831,
): BootstrapResult {
  const byCluster = new Map<string, number[]>();
  clusterOf.forEach((c, i) => { const l = byCluster.get(c) ?? []; l.push(i); byCluster.set(c, l); });
  const clusters = [...byCluster.values()];
  const delta = mean(a) - mean(b);
  const rnd = mulberry32(seed);
  const deltas: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sa = 0; let sb = 0; let n = 0;
    for (let c = 0; c < clusters.length; c++) {
      const pick = clusters[Math.floor(rnd() * clusters.length)]!;
      for (const i of pick) { sa += a[i]!; sb += b[i]!; n += 1; }
    }
    deltas.push(n ? sa / n - sb / n : 0);
  }
  deltas.sort((x, y) => x - y);
  return { delta, lo: deltas[Math.floor(0.025 * resamples)]!, hi: deltas[Math.floor(0.975 * resamples) - 1]! };
}

export const ciStr = (r: BootstrapResult): string =>
  `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(4)} CI [${r.lo.toFixed(4)}, ${r.hi.toFixed(4)}]` +
  `  ${r.lo > 0 ? 'ABOVE 0' : r.hi < 0 ? 'BELOW 0' : 'SPANS 0'}`;

export const triStr = (t: TriResult): string =>
  `\n      pair ${ciStr(t.byPair)}\n      entity ${ciStr(t.byEntity)}\n      doc ${ciStr(t.byDocument)}` +
  `\n      => ALL-THREE-ABOVE-0: ${t.byPair.lo > 0 && t.byEntity.lo > 0 && t.byDocument.lo > 0 ? 'YES (DEMONSTRATED)' : 'NO'}`;
