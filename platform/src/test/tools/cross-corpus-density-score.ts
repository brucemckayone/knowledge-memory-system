/**
 * doc-32 scoring — coverage ceiling (dense nodes) + discrimination AUC (anti-hub guard) + hub diagnostic.
 * Deterministic; reuses frozen co-citation oracle (cc-cociters.json), embeddings (cc-docemb.json), τ=0.615.
 * Compares dense (cc-seeded-dense.json) to sparse (cc-seeded.json).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const load = <T,>(n: string): T => JSON.parse(readFileSync(join(OUT, n), 'utf8')) as T;
function cosine(a: number[], b: number[]): number { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }
// tie-corrected AUC (Mann-Whitney): P(score(pos) > score(neg)), 0.5 for ties
function auc(scores: number[], labels: number[]): number {
  const idx = scores.map((s, i) => [s, i] as const).sort((a, b) => a[0] - b[0]);
  const rank = new Array(scores.length).fill(0);
  let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) rank[idx[k]![1]] = avg; i = j + 1; }
  let sumPos = 0, nPos = 0, nNeg = 0; for (let k = 0; k < labels.length; k++) { if (labels[k]) { sumPos += rank[k]; nPos++; } else nNeg++; }
  if (!nPos || !nNeg) return NaN;
  return (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}

function scoreSet(seededFile: string, label: string): any {
  const A = load<Array<{ id: string }>>('corpus-A.json'), B = load<Array<{ id: string }>>('corpus-B.json');
  const cite = load<Record<string, string[]>>('cc-cociters.json'), demb = load<Record<string, number[]>>('cc-docemb.json');
  const seeded = load<Record<string, string[]>>(seededFile);
  const nA = A.map((d) => new Set(seeded[`A:${d.id}`] ?? [])), nB = B.map((d) => new Set(seeded[`B:${d.id}`] ?? []));
  const eA = A.map((d) => demb[`A:${d.id}`]!), eB = B.map((d) => demb[`B:${d.id}`]!);
  const citersA = A.map((d) => new Set(cite[d.id] ?? [])), citersB = B.map((d) => new Set(cite[d.id] ?? []));
  const coCited = (i: number, j: number) => { const [s, l] = citersA[i]!.size < citersB[j]!.size ? [citersA[i]!, citersB[j]!] : [citersB[j]!, citersA[i]!]; for (const x of s) if (l.has(x)) return true; return false; };
  const df = new Map<string, number>(); [...nA, ...nB].forEach((cs) => cs.forEach((c) => df.set(c, (df.get(c) ?? 0) + 1)));
  const idf = (c: string) => Math.log((A.length + B.length) / (df.get(c) ?? 1));
  const shareCount = (i: number, j: number) => { let n = 0; for (const c of nA[i]!) if (nB[j]!.has(c)) n++; return n; };
  const joinScore = (i: number, j: number) => { let s = 0; for (const c of nA[i]!) if (nB[j]!.has(c)) s += idf(c); return s; };
  const cos = (i: number, j: number) => cosine(eA[i]!, eB[j]!);

  // coverage ceilings + AUC arrays
  let lcCo = 0, lcCoShared = 0, allCo = 0, allCoShared = 0;
  const scores: number[] = [], labels: number[] = [], ovlScores: number[] = [], ovlLabels: number[] = [];
  const sharedFreq = new Map<string, number>();
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) {
    const cc = coCited(i, j), sc = shareCount(i, j), js = joinScore(i, j);
    scores.push(js); labels.push(cc ? 1 : 0);
    if (cc) { allCo++; if (sc > 0) allCoShared++; if (cos(i, j) < 0.615) { lcCo++; if (sc > 0) lcCoShared++; } }
    if (sc > 0) { ovlScores.push(js); ovlLabels.push(cc ? 1 : 0); for (const c of nA[i]!) if (nB[j]!.has(c)) sharedFreq.set(c, (sharedFreq.get(c) ?? 0) + 1); }
  }
  const counts = [...A.map((d) => (seeded[`A:${d.id}`] ?? []).length), ...B.map((d) => (seeded[`B:${d.id}`] ?? []).length)];
  const vocab = new Set<string>(); [...nA, ...nB].forEach((s) => s.forEach((c) => vocab.add(c)));
  return {
    label, meanNodesPerDoc: +(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1), vocab: vocab.size, emptyDocs: counts.filter((c) => c === 0).length,
    coverageCeiling_textDissimilar: { pairs: lcCo, shared: lcCoShared, ceiling: +(lcCoShared / lcCo).toFixed(3) },
    coverageCeiling_fullOracle: { pairs: allCo, shared: allCoShared, ceiling: +(allCoShared / allCo).toFixed(3) },
    joinAUC_fullOracle: +auc(scores, labels).toFixed(3),
    joinAUC_amongOverlap: +auc(ovlScores, ovlLabels).toFixed(3),
    topSharedNodes: [...sharedFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => `${c}(${n},df=${df.get(c)})`),
  };
}

const dense = scoreSet('cc-seeded-dense.json', 'DENSE');
const sparse = scoreSet('cc-seeded.json', 'SPARSE (doc-31 baseline)');
const result = {
  prereg: 'doc-32', tau: 0.615,
  bars: 'LIVE iff textDissimilar ceiling >=0.25 AND dense joinAUC_fullOracle >=0.63',
  DENSE: dense, SPARSE: sparse,
  verdict: {
    coverage: dense.coverageCeiling_textDissimilar.ceiling >= 0.25 ? 'PASS(>=0.25)' : dense.coverageCeiling_textDissimilar.ceiling < 0.10 ? 'DEAD(<0.10)' : 'MARGINAL(0.10-0.25)',
    discrimination: dense.joinAUC_fullOracle >= 0.63 ? 'PASS(>=0.63)' : 'FAIL(<0.63 = hub-noise risk)',
  },
};
writeFileSync(join(OUT, 'cc-density-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
