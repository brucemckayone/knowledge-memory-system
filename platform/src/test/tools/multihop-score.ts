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
  // A missing paper vector used to fall back to 1 — a PERFECT score, which would silently
  // inflate arm E's coverage and corrupt its AUC in its own favour. Verified 0 missing for both
  // corpora in the frozen cc-docemb.json, so this never fires; it fails loud rather than
  // scoring a hole as a maximal match.
  const cos = (i: number, j: number): number => {
    if (!eA[i] || !eB[j]) {
      throw new Error(`missing paper embedding for A:${A[i]!.id} / B:${B[j]!.id} — arm E cannot be scored`);
    }
    return cosine(eA[i]!, eB[j]!);
  };

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
  // Concept id is carried, not just the name: bar 3 needs to EXCLUDE the top 3 by id.
  const hubs = rows(await db.execute(sql`
    SELECT c.id::text AS id, c.canonical_name AS name, count(DISTINCT be.a_ref)::int AS degree
    FROM public.entities c
    JOIN public.bridge_edges be ON be.b_ref = c.id AND be.expired_at IS NULL
    WHERE c.corpus_id = '_concepts' AND be.source_corpus_id IN (${SRC}, ${TGT})
    GROUP BY c.id, c.canonical_name ORDER BY degree DESC, c.canonical_name LIMIT 10
  `)).map((r) => ({ id: r.id as string, name: r.name as string, degree: r.degree as number }));

  // ── bar 3 (doc-35 §6, §7.3): re-score every hop arm with the top-3 concepts removed from
  // the pivot set. This is the doc-32 failure detector — reach that evaporates once three
  // generic hubs are gone was never structure. Ordered by degree then name so the top-3 choice
  // is deterministic under ties rather than dependent on Postgres row order.
  const top3 = hubs.slice(0, 3).map((h) => h.id);
  const exResults: Record<string, ArmResult> = {};
  for (const hops of [0, 1, 2]) {
    const pairs = await recallMultiHopConcepts(SRC, TGT, { hops, decay: DECAY, excludeConceptIds: top3 });
    exResults[`hops${hops}`] = scoreArm(hops === 0 ? 'S0 single-hop' : `M${hops} multi-hop`, liftToPapers(pairs));
  }

  // ── frontier (doc-35 §6): "each arm as a (cells, coverage) point; frontier_at(c) = best
  // coverage any arm-E setting achieves for <=c cells, per doc 33 §13.2". This is the
  // COST-ADJUSTED comparison, and it is the metric that turned doc-33's self-claimed
  // CLEAR_WIN into FRAGILE_DOMINANCE — reporting a concept arm's coverage without it invites
  // exactly that error again, since a cheap arm always looks good until you ask what the
  // incumbent does at the same cost.
  //
  // Built on EXACT thresholds (every achievable prefix of the cosine-sorted pair list) rather
  // than doc-33's 0.05 threshold grid. doc-33 self-caught a grid artifact — its frontier at
  // <=10 cells read 0 only because the grid had no cosine point between 1 and ~29 cells — and
  // an exact sweep removes that failure mode by construction rather than by a finer grid.
  const embRanked = pairIdx
    .map(([i, j], p) => ({ p, score: cos(i, j) }))
    .sort((a, b) => b.score - a.score);
  // cumCoveredFull[c] / cumCoveredDissim[c] = co-cited pairs inside the top-c cells.
  const cumFull: number[] = [0];
  const cumDissim: number[] = [0];
  for (const { p } of embRanked) {
    cumFull.push(cumFull[cumFull.length - 1]! + (isCo[p] ? 1 : 0));
    cumDissim.push(cumDissim[cumDissim.length - 1]! + (isCo[p] && isDissim[p] ? 1 : 0));
  }
  /** Best coverage arm E reaches spending at most `c` cells. Exact, no grid. */
  const frontierAt = (c: number): { full: number; dissim: number } => {
    const k = Math.max(0, Math.min(c, embRanked.length));
    return {
      full: coFull ? +(cumFull[k]! / coFull).toFixed(4) : 0,
      dissim: coDissim ? +(cumDissim[k]! / coDissim).toFixed(4) : 0,
    };
  };

  const s0 = results.find((r) => r.arm.startsWith('S0'))!;
  const s0Ex = exResults.hops0!;

  const verdict = (m: ArmResult, exKey: string): Record<string, unknown> => {
    const mEx = exResults[exKey]!;
    // doc-35 §7.1 reads "rises by >=3x over S0 AND reaches >=25% absolute". When S0 covers
    // NOTHING on the hard slice the multiplier is trivially satisfied (x >= 3*0) and the
    // absolute bar governs. The previous guard (`s0.coverageDissim > 0`) turned that case into
    // a FAIL on a divide-by-zero technicality rather than on the pre-registered criterion, and
    // doc 34 §3 makes S0 = 0 a live possibility. Both readings are reported side by side so no
    // interpretation is baked into the verdict silently.
    const s0Zero = s0.coverageDissim === 0;
    const ratioOk = s0Zero ? m.coverageDissim > 0 : m.coverageDissim >= 3 * s0.coverageDissim;
    const absOk = m.coverageDissim >= 0.25;

    // "retains >= half its gain over S0" — measured with the top-3 gone on BOTH sides, so the
    // baseline is comparable rather than mixing an excluded arm against a full-pivot S0.
    const gain = m.coverageDissim - s0.coverageDissim;
    const gainEx = mEx.coverageDissim - s0Ex.coverageDissim;
    const bar3 = gain <= 0 ? 'N/A (no gain over S0 to retain)' : (gainEx >= 0.5 * gain ? 'PASS' : 'FAIL');

    return {
      arm: m.arm,
      bar1_reach: (absOk && ratioOk) ? 'PASS' : 'FAIL',
      bar1_detail: {
        coverageDissim: m.coverageDissim, s0CoverageDissim: s0.coverageDissim,
        absoluteBar: 0.25, absoluteMet: absOk,
        ratioBar: '3x S0', ratioMet: ratioOk,
        s0IsZero: s0Zero,
        note: s0Zero
          ? 'S0 covers nothing on the hard slice, so the 3x multiplier is trivially satisfied and the absolute bar governs (doc-35 §7.1 as written)'
          : null,
      },
      bar2_discrimination: (m.auc >= 0.63 && m.auc >= s0.auc) ? 'PASS' : 'FAIL',
      bar2_detail: { auc: m.auc, s0Auc: s0.auc, absoluteBar: 0.63 },
      bar3_notHubDriven: bar3,
      bar3_detail: {
        excludedConcepts: hubs.slice(0, 3).map((h) => `${h.name} (deg ${h.degree})`),
        gainOverS0: +gain.toFixed(4), gainWithTop3Excluded: +gainEx.toFixed(4),
        retentionBar: 'half the gain',
        aucWithTop3Excluded: mEx.auc,
      },
      // doc-35 §7 requires ALL THREE to hold.
      overall: (absOk && ratioOk && m.auc >= 0.63 && m.auc >= s0.auc && bar3 === 'PASS')
        ? 'LIVE MECHANISM (all three bars)' : 'FAIL',
    };
  };

  const out = {
    prereg: 'doc-35', frozen: { tau: TAU, decay: DECAY, attributionFloor: ATTRIBUTION_FLOOR },
    attribution: { rate: +attrRate.toFixed(4), ...attr.stats },
    oracle: { coCitedPairs: coFull, coCitedTextDissimilar: coDissim, totalPairs: pairIdx.length },
    arms: results,
    armsTop3Excluded: Object.values(exResults),
    // Each concept arm against what dense embedding achieves for the SAME cell budget.
    // aboveFrontier=false means the incumbent matches or beats this arm at equal cost, which
    // is a negative for the product question however the three bars land.
    frontier: results
      .filter((r) => r.arm.startsWith('S0') || r.arm.startsWith('M'))
      .map((r) => {
        const f = frontierAt(r.cells);
        return {
          arm: r.arm, cells: r.cells,
          coverageFull: r.coverageFull, embeddingCoverageAtSameCells: f.full,
          coverageDissim: r.coverageDissim, embeddingCoverageDissimAtSameCells: f.dissim,
          aboveFrontierFull: r.coverageFull > f.full,
          aboveFrontierDissim: r.coverageDissim > f.dissim,
        };
      }),
    hubDiagnostic: hubs,
    verdicts: [
      results.find((r) => r.arm.startsWith('M1')) ? verdict(results.find((r) => r.arm.startsWith('M1'))!, 'hops1') : null,
      results.find((r) => r.arm.startsWith('M2')) ? verdict(results.find((r) => r.arm.startsWith('M2'))!, 'hops2') : null,
    ].filter(Boolean),
  };
  writeFileSync(join(OUT, 'multihop-results.json'), JSON.stringify(out, null, 2));
  writeFileSync(join(OUT, 'multihop-raw-pairs.json'), JSON.stringify(rawByArm, null, 2));
  console.log(JSON.stringify({ ...out, hubDiagnostic: hubs.slice(0, 5) }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
