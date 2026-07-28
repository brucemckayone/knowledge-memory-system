/**
 * doc-35 scoring harness — multi-hop concept-mediated cross-corpus recall.
 *
 * Deterministic; no LLM. Implements exactly the arms, metrics and bars frozen in doc 35
 * §4-§7. Reads the graph via the shipped/new recall primitives and lifts entity pairs to
 * PAPER pairs through the doc-34 §7.2 attribution map.
 *
 * Run: cd platform && DATABASE_URL=...cognitive_test NODE_ENV=test \
 *   npx tsx src/test/tools/multihop-score.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { recallMultiHopConcepts, type MultiHopPair } from '../../services/concept-multihop.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, '../../../../docs/architecture/cross-corpus-audit');
const OUT = join(DOCS, 'multihop-artifacts');
const SRC = 'arxiv-nlp';
const TGT = 'arxiv-cv';
const TAU = 0.615;          // frozen, doc-31
const DECAY = 0.5;          // frozen, doc-35 §5
const ATTRIBUTION_FLOOR = 0.95; // doc-35 §3

// ── BM25, copied verbatim from recall-hybrid.ts (R37: the real IDF retriever, never raw
// Jaccard). Textbook untuned params; same frozen [a-z0-9]{2,} tokenizer.
const BM25_K1 = 1.2, BM25_B = 0.75;
function tokenCounts(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const g of s.toLowerCase().matchAll(/[a-z0-9]+/g)) if (g[0].length >= 2) m.set(g[0], (m.get(g[0]) ?? 0) + 1);
  return m;
}
interface Bm25Index { idf: Map<string, number>; docs: Map<string, { tf: Map<string, number>; len: number }>; avgdl: number }
function buildBm25(docTexts: Map<string, string>): Bm25Index {
  const docs = new Map<string, { tf: Map<string, number>; len: number }>();
  const df = new Map<string, number>();
  let total = 0;
  for (const [id, text] of docTexts) {
    const tf = tokenCounts(text);
    let len = 0; for (const c of tf.values()) len += c;
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    docs.set(id, { tf, len }); total += len;
  }
  const N = docs.size;
  const idf = new Map<string, number>();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  return { idf, docs, avgdl: total / N };
}
function bm25Score(index: Bm25Index, docId: string, queryTerms: Set<string>): number {
  const doc = index.docs.get(docId); if (!doc) return 0;
  let s = 0;
  for (const t of queryTerms) {
    const tf = doc.tf.get(t); if (!tf) continue;
    s += (index.idf.get(t) ?? 0) * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.len / index.avgdl)));
  }
  return s;
}

interface Doc { id: string; title: string; abstract: string }
const load = <T,>(n: string): T => JSON.parse(readFileSync(join(DOCS, n), 'utf8')) as T;
function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
/** Tie-corrected Mann-Whitney AUC. */
function auc(scores: number[], labels: number[]): number {
  const idx = scores.map((s, i) => [s, i] as const).sort((a, b) => a[0] - b[0]);
  const rank = new Array(scores.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rank[idx[k]![1]] = avg;
    i = j + 1;
  }
  let sumPos = 0, nPos = 0, nNeg = 0;
  for (let k = 0; k < labels.length; k++) { if (labels[k]) { sumPos += rank[k]; nPos++; } else nNeg++; }
  return (!nPos || !nNeg) ? NaN : (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}
function rows(r: unknown): Array<Record<string, unknown>> { return r as unknown as Array<Record<string, unknown>>; }

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const A = load<Doc[]>('convergence-artifacts/corpus-A.json');
  const B = load<Doc[]>('convergence-artifacts/corpus-B.json');
  const cite = load<Record<string, string[]>>('convergence-artifacts/cc-cociters.json');
  const demb = load<Record<string, number[]>>('convergence-artifacts/cc-docemb.json');

  const attrPath = join(OUT, 'doc-attribution.json');
  if (!existsSync(attrPath)) throw new Error('doc-attribution.json missing — run doc-attribution.ts first');
  const attr = JSON.parse(readFileSync(attrPath, 'utf8')) as {
    stats: { factsTotal: number; factsAttributed: number };
    entityToPapers: Record<string, string[]>;
  };
  const attrRate = attr.stats.factsTotal === 0 ? 0 : attr.stats.factsAttributed / attr.stats.factsTotal;
  if (attrRate < ATTRIBUTION_FLOOR) {
    throw new Error(`attribution ${(attrRate * 100).toFixed(1)}% < ${ATTRIBUTION_FLOOR * 100}% floor (doc-35 §3) — run VOID`);
  }
  const entityToPapers = new Map(Object.entries(attr.entityToPapers));

  // ── oracle + slice, over paper pairs
  const citersA = A.map((d) => new Set(cite[d.id] ?? []));
  const citersB = B.map((d) => new Set(cite[d.id] ?? []));
  const coCited = (i: number, j: number): boolean => {
    const [s, l] = citersA[i]!.size < citersB[j]!.size ? [citersA[i]!, citersB[j]!] : [citersB[j]!, citersA[i]!];
    for (const x of s) if (l.has(x)) return true;
    return false;
  };
  const eA = A.map((d) => demb[`A:${d.id}`]);
  const eB = B.map((d) => demb[`B:${d.id}`]);
  const cos = (i: number, j: number): number => (eA[i] && eB[j]) ? cosine(eA[i]!, eB[j]!) : 1;

  const pairIdx: Array<[number, number]> = [];
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) pairIdx.push([i, j]);
  const isCo = pairIdx.map(([i, j]) => (coCited(i, j) ? 1 : 0));
  const isDissim = pairIdx.map(([i, j]) => cos(i, j) < TAU);
  const pairKey = (i: number, j: number): string => `${A[i]!.id} ${B[j]!.id}`;
  const keyToPos = new Map(pairIdx.map(([i, j], p) => [pairKey(i, j), p]));

  /** Lift entity-level pairs to paper-level scores (max over contributing entity pairs). */
  function liftToPapers(pairs: MultiHopPair[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const p of pairs) {
      const pa = entityToPapers.get(p.elementRef) ?? [];
      const pb = entityToPapers.get(p.ruleId) ?? [];
      for (const x of pa) for (const y of pb) {
        const k = `${x} ${y}`;
        if (!keyToPos.has(k)) continue; // only A×B pairs count
        out.set(k, Math.max(out.get(k) ?? 0, p.score));
      }
    }
    return out;
  }

  interface ArmResult {
    arm: string; cells: number;
    coverageFull: number; coveredFull: number; coCitedFull: number;
    coverageDissim: number; coveredDissim: number; coCitedDissim: number;
    auc: number;
  }
  let coFull = 0, coDissim = 0;
  for (let p = 0; p < pairIdx.length; p++) {
    if (!isCo[p]) continue;
    coFull += 1;
    if (isDissim[p]) coDissim += 1;
  }

  function scoreArm(arm: string, scoreByPair: Map<string, number>): ArmResult {
    const scores = new Array(pairIdx.length).fill(0);
    for (const [k, v] of scoreByPair) { const p = keyToPos.get(k); if (p !== undefined) scores[p] = v; }
    let coveredFull = 0, coveredDissim = 0;
    for (let p = 0; p < pairIdx.length; p++) {
      if (!isCo[p] || scores[p] <= 0) continue;
      coveredFull++;
      if (isDissim[p]) coveredDissim++;
    }
    return {
      arm,
      cells: [...scoreByPair.values()].filter((v) => v > 0).length,
      coveredFull, coCitedFull: coFull, coverageFull: coFull ? +(coveredFull / coFull).toFixed(4) : 0,
      coveredDissim, coCitedDissim: coDissim, coverageDissim: coDissim ? +(coveredDissim / coDissim).toFixed(4) : 0,
      auc: +auc(scores, isCo).toFixed(4),
    };
  }

  const results: ArmResult[] = [];
  const rawByArm: Record<string, MultiHopPair[]> = {};
  for (const hops of [0, 1, 2]) {
    const t0 = Date.now();
    const pairs = await recallMultiHopConcepts(SRC, TGT, { hops, decay: DECAY });
    rawByArm[`hops${hops}`] = pairs;
    results.push(scoreArm(hops === 0 ? 'S0 single-hop' : `M${hops} multi-hop`, liftToPapers(pairs)));
    console.log(`  hops=${hops}: ${pairs.length} entity pairs in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  // Arm E — dense embedding over paper vectors. Cells are undefined for a dense scorer
  // (it scores every pair), so coverage is reported at "any positive score" = all pairs;
  // its discriminating value is the AUC.
  const embScores = new Map<string, number>();
  for (const [i, j] of pairIdx) embScores.set(pairKey(i, j), cos(i, j));
  results.push(scoreArm('E dense embedding', embScores));

  // Arm B — BM25 over title+abstract.
  const texts = new Map<string, string>();
  for (const d of [...A, ...B]) texts.set(d.id, `${d.title}. ${d.abstract}`);
  const idx = buildBm25(texts);
  const bmScores = new Map<string, number>();
  for (const [i, j] of pairIdx) {
    const q = new Set(tokenCounts(`${A[i]!.title}. ${A[i]!.abstract}`).keys());
    bmScores.set(pairKey(i, j), bm25Score(idx, B[j]!.id, q));
  }
  results.push(scoreArm('B BM25', bmScores));

  // ── hub diagnostic (doc-35 §6): top linking concepts + AUC excluding the top 3
  const hubs = rows(await db.execute(sql`
    SELECT c.canonical_name AS name, count(DISTINCT be.a_ref)::int AS degree
    FROM public.entities c
    JOIN public.bridge_edges be ON be.b_ref = c.id AND be.expired_at IS NULL
    WHERE c.corpus_id = '_concepts' AND be.source_corpus_id IN (${SRC}, ${TGT})
    GROUP BY c.canonical_name ORDER BY degree DESC LIMIT 10
  `)).map((r) => ({ name: r.name as string, degree: r.degree as number }));

  const s0 = results.find((r) => r.arm.startsWith('S0'))!;
  const verdict = (m: ArmResult): Record<string, unknown> => ({
    arm: m.arm,
    bar1_reach: m.coverageDissim >= 0.25 && s0.coverageDissim > 0 && m.coverageDissim >= 3 * s0.coverageDissim
      ? 'PASS' : `FAIL (need >=0.25 AND >=3x S0's ${s0.coverageDissim})`,
    bar2_discrimination: m.auc >= 0.63 && m.auc >= s0.auc ? 'PASS' : `FAIL (need >=0.63 AND >= S0's ${s0.auc})`,
    bar3_notHubDriven: 'requires the top-3-excluded recomputation (reported separately)',
  });

  const out = {
    prereg: 'doc-35', frozen: { tau: TAU, decay: DECAY, attributionFloor: ATTRIBUTION_FLOOR },
    attribution: { rate: +attrRate.toFixed(4), ...attr.stats },
    oracle: { coCitedPairs: coFull, coCitedTextDissimilar: coDissim, totalPairs: pairIdx.length },
    arms: results,
    hubDiagnostic: hubs,
    verdicts: results.filter((r) => r.arm.startsWith('M')).map(verdict),
  };
  writeFileSync(join(OUT, 'multihop-results.json'), JSON.stringify(out, null, 2));
  writeFileSync(join(OUT, 'multihop-raw-pairs.json'), JSON.stringify(rawByArm, null, 2));
  console.log(JSON.stringify({ ...out, hubDiagnostic: hubs.slice(0, 5) }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
