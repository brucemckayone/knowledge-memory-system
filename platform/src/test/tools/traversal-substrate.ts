/**
 * Doc 47 — does a STRUCTURAL (traversal) substrate add to the fusion?
 *
 * TRAV(e) = sum over NAME-top-10 seeds s adjacent to e of 1/(rank(s)+1), over
 * entity<->entity adjacency from public.facts. Seeds excluded from their own
 * score. Edges whose underlying fact came from the QUERY DOCUMENT are dropped
 * (the same held-out guard factSignals applies to the dense fact signal) —
 * without it the target's own edges leak the answer.
 *
 * Includes the MANDATORY artifact control doc 46 omitted: TRAV-RAND, the same
 * signal over a DEGREE-PRESERVING SHUFFLED graph. A real structural signal must
 * beat a graph with the same degree distribution and scrambled edges.
 *
 * Cost ZERO: frozen embed caches + SQL adjacency. No Ollama, no LLM.
 *
 * Run (both pairs):
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     NODE_ENV=test npx tsx src/test/tools/traversal-substrate.ts
 *   CORPUS_SET=arxiv ... npx tsx src/test/tools/traversal-substrate.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { rawQuery } from '../../db/raw.js';
import { buildBm25, bm25Scores, rankByScore, ciStr, mean } from './retrieval-eval/core.js';
import { reciprocalRankFusion } from '../../services/fusion.js';
import { runEval } from './retrieval-eval/harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARC = join(HERE, '../../../../docs/architecture/cross-corpus-audit/multihop-artifacts');
const CORPORA_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');

const SET = (process.env.CORPUS_SET ?? 'dal') as 'dal' | 'arxiv';
const SETS = {
  dal: { corpora: ['dal-nlp', 'dal-cv'], docFileFor: { 'dal-nlp': 'corpus-A.json', 'dal-cv': 'corpus-B.json' }, writable: undefined as string | undefined, reg: { NAME: 0.20056497175141244 } as Record<string, number> | undefined, regN: 354 as number | undefined },
  arxiv: { corpora: ['arxiv-nlp', 'arxiv-cv'], docFileFor: { 'arxiv-nlp': 'corpus-A.json', 'arxiv-cv': 'corpus-B.json' }, writable: 'arxiv-embed-cache.json', reg: undefined, regN: undefined },
}[SET];
const CORPORA = SETS.corpora as readonly string[];
const RRF_K = 60;
const SEEDS = 10;
const SEED_RNG = 20260917;
const byIndex = (a: number, b: number): number => a - b;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type EdgeRow = { fid: string; s: string | null; o: string | null };
/** adjacency as parallel arrays of entity indices + the source paper per edge */
type Adj = { a: number[]; b: number[]; paper: string[]; deg: number[] };

/** Degree-preserving edge shuffle (configuration model via double-edge swaps). */
function shuffleDegreePreserving(adj: Adj, iters: number): Adj {
  const a = adj.a.slice(), b = adj.b.slice();
  const rand = rng(SEED_RNG);
  const m = a.length;
  for (let it = 0; it < iters; it++) {
    const i = Math.floor(rand() * m), j = Math.floor(rand() * m);
    if (i === j) continue;
    // swap endpoints b_i <-> b_j (preserves every node's degree)
    const bi = b[i]!, bj = b[j]!;
    if (a[i] === bj || a[j] === bi) continue;   // avoid self-loops
    b[i] = bj; b[j] = bi;
  }
  return { a, b, paper: adj.paper, deg: adj.deg };
}

function travScores(
  adj: Adj, U: number, seeds: number[], docId: string, dropUnmapped: boolean,
): { score: number[]; excluded: number } {
  const w = new Map<number, number>();
  seeds.forEach((s, i) => w.set(s, 1 / (i + 1)));
  const out = new Array<number>(U).fill(0);
  let excluded = 0;
  for (let e = 0; e < adj.a.length; e++) {
    const p = adj.paper[e]!;
    if (p === docId) { excluded += 1; continue; }        // held-out guard (§3)
    if (dropUnmapped && !p) continue;                    // conservative variant
    const x = adj.a[e]!, y = adj.b[e]!;
    const wx = w.get(x), wy = w.get(y);
    if (wy !== undefined && !w.has(x)) out[x] = out[x]! + wy;   // seeds excluded from own score
    if (wx !== undefined && !w.has(y)) out[y] = out[y]! + wx;
  }
  return { score: out, excluded };
}

async function main(): Promise<void> {
  const r = await runEval({
    label: `traversal-substrate-${SET}`,
    corpora: CORPORA,
    paths: { arcDir: ARC, corporaDir: CORPORA_DIR, docFileFor: SETS.docFileFor },
    frozenCachePath: join(OUT, 'embed-cache.json'),
    writableCachePath: SETS.writable ? join(OUT, SETS.writable) : undefined,
    arms: ['NAME', 'FACTMAX', 'FACTNAME'],
    regression: SETS.reg ? { targets: SETS.reg, n: SETS.regN! } : undefined,
    ensureEmbedEntityNames: SET === 'arxiv',
    ensureEmbedQueryDocs: SET === 'arxiv',
    keepBaseRankings: true,
  });

  const { sub, factStateByCorpus, corpusOf, docOf, targetIdx, pairKeys } = r;
  const rName = r.baseRankings!.rName;
  const rFactMax = r.baseRankings!.rFactMax!;

  // ---- adjacency per corpus, index-aligned to the entity list ----
  const adjByCorpus = new Map<string, Adj>();
  const shufByCorpus = new Map<string, Adj>();
  for (const c of CORPORA) {
    const ents = sub.entsByCorpus.get(c)!;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const f2p = sub.factToPaperByCorpus.get(c)!;
    const rows = await rawQuery<EdgeRow>(sql`
      SELECT id::text AS fid, subject_entity_id::text AS s, object_entity_id::text AS o
      FROM public.facts
      WHERE corpus_id = ${c} AND expired_at IS NULL AND invalid_at IS NULL
      ORDER BY id`);
    const adj: Adj = { a: [], b: [], paper: [], deg: new Array<number>(ents.length).fill(0) };
    for (const row of rows) {
      if (!row.s || !row.o) continue;
      const x = idxOf.get(row.s), y = idxOf.get(row.o);
      if (x === undefined || y === undefined || x === y) continue;
      adj.a.push(x); adj.b.push(y); adj.paper.push(f2p[row.fid] ?? '');
      adj.deg[x] = adj.deg[x]! + 1; adj.deg[y] = adj.deg[y]! + 1;
    }
    adjByCorpus.set(c, adj);
    shufByCorpus.set(c, shuffleDegreePreserving(adj, adj.a.length * 10));
    console.log(`${c}: ${adj.a.length} entity-entity edges over ${ents.length} entities`);
  }

  // ---- BM25f (doc 46's signal) so the four-way and BAR B are computable ----
  const bmFactByCorpus = new Map<string, ReturnType<typeof buildBm25>>();
  for (const c of CORPORA) bmFactByCorpus.set(c, buildBm25(factStateByCorpus!.get(c)!.texts));

  const armRanks: Record<string, number[]> = {};
  const push = (k: string, v: number) => { (armRanks[k] = armRanks[k] ?? []).push(v); };
  const strictOf = (ranking: number[], t: number): number => {
    const p = ranking.indexOf(t);
    return p < 0 ? Number.POSITIVE_INFINITY : p + 1;
  };
  const rTrav: number[][] = [];
  let totalExcluded = 0;

  for (let i = 0; i < pairKeys.length; i++) {
    const c = corpusOf[i]!, docId = docOf[i]!, t = targetIdx[i]!;
    const ents = sub.entsByCorpus.get(c)!;
    const U = ents.length;
    const fs = factStateByCorpus!.get(c)!;
    const d = sub.docsById.get(docId)!;
    const qtext = `${d.title} ${d.abstract}`;
    const n = rName[i]!, f = rFactMax[i]!;
    const seeds = n.slice(0, SEEDS);

    // BM25f, MAX-aggregated, same held-out guard as doc 46
    const fsc = bm25Scores(bmFactByCorpus.get(c)!, qtext);
    const entMax = new Array<number>(U).fill(-Infinity);
    for (const [ei, fidxs] of fs.entFacts) {
      let best = -Infinity;
      for (const fi of fidxs) { if (fs.paper[fi] === docId) continue; const s = fsc[fi]!; if (s > best) best = s; }
      if (best > -Infinity) entMax[ei] = best;
    }
    const rB = rankByScore(entMax, -Infinity);

    const adj = adjByCorpus.get(c)!;
    const tv = travScores(adj, U, seeds, docId, false);
    totalExcluded += tv.excluded;
    const rT = rankByScore(tv.score, 0);
    rTrav.push(rT);
    const rTc = rankByScore(travScores(adj, U, seeds, docId, true).score, 0);
    const rTrand = rankByScore(travScores(shufByCorpus.get(c)!, U, seeds, docId, false).score, 0);
    const rTnoguard = rankByScore(travScores(adj, U, seeds, '__none__', false).score, 0);

    push('TRAV', strictOf(rT, t));
    push('TRAVc', strictOf(rTc, t));
    push('TRAV-RAND', strictOf(rTrand, t));
    push('TRAV-NOGUARD', strictOf(rTnoguard, t));
    push('L3', strictOf(reciprocalRankFusion([n, f, rB], { k: RRF_K, tieBreak: byIndex }), t));
    push('T-R4', strictOf(reciprocalRankFusion([n, f, rT], { k: RRF_K, tieBreak: byIndex }), t));
    push('T-R4-RAND', strictOf(reciprocalRankFusion([n, f, rTrand], { k: RRF_K, tieBreak: byIndex }), t));
    push('T-R4-NOGUARD', strictOf(reciprocalRankFusion([n, f, rTnoguard], { k: RRF_K, tieBreak: byIndex }), t));
    push('T4', strictOf(reciprocalRankFusion([n, f, rB, rT], { k: RRF_K, tieBreak: byIndex }), t));
  }
  console.log(`held-out adjacency exclusions: ${totalExcluded}` + (totalExcluded === 0 ? '  >>> §6.2 GUARD NEVER FIRED — VOID' : ''));
  if (totalExcluded === 0) throw new Error('§6.2: held-out guard never fired');

  // ---- degeneracy (§5) ----
  const jacc = (A: number[][], B: number[][]) => mean(A.map((x, i) => {
    const s = new Set(x.slice(0, 10)); const u = new Set(B[i]!.slice(0, 10));
    const inter = [...s].filter((y) => u.has(y)).length;
    const uni = new Set([...s, ...u]).size;
    return uni ? inter / uni : 0;
  }));
  console.log(`TRAV top-10 Jaccard vs NAME ${jacc(rTrav, rName).toFixed(3)}  vs FACTMAX ${jacc(rTrav, rFactMax).toFixed(3)}`);

  const hit = (arm: string, k: number): number[] =>
    armRanks[arm] ? armRanks[arm]!.map((x) => (x <= k ? 1 : 0)) : r.hitStrict(arm, k);
  const R = (arm: string, k: number) => mean(hit(arm, k));
  const ALL = ['NAME', 'FACTMAX', 'FACTNAME', 'L3', 'TRAV', 'TRAVc', 'TRAV-RAND', 'TRAV-NOGUARD', 'T-R4', 'T-R4-RAND', 'T-R4-NOGUARD', 'T4'];

  console.log(`\n=== STRICT R@k (${SET}, n=${r.n}) ===`);
  console.log('arm'.padEnd(15) + [1, 5, 10, 20, 30].map((k) => `R@${k}`.padStart(9)).join(''));
  const table: Record<string, Record<string, number>> = {};
  for (const a of ALL) {
    table[a] = {};
    for (const k of [1, 5, 10, 20, 30]) table[a]![`R@${k}`] = R(a, k);
    console.log(a.padEnd(15) + [1, 5, 10, 20, 30].map((k) => R(a, k).toFixed(4).padStart(9)).join(''));
  }

  console.log('\n=== PER CORPUS, strict R@10 ===');
  const perCorpus: Record<string, Record<string, number>> = {};
  for (const c of CORPORA) {
    perCorpus[c] = {};
    const idx = corpusOf.map((x, i) => (x === c ? i : -1)).filter((i) => i >= 0);
    for (const a of ALL) { const h = hit(a, 10); perCorpus[c]![a] = mean(idx.map((i) => h[i]!)); }
    console.log(`  ${c} (n=${idx.length}): ` + ['FACTNAME', 'L3', 'TRAV', 'T-R4', 'T4'].map((a) => `${a}=${perCorpus[c]![a]!.toFixed(4)}`).join('  '));
  }

  const deltas: Record<string, unknown> = {};
  const rep = (label: string, a: string, b: string) => {
    const t = r.tri(hit(a, 10), hit(b, 10));
    deltas[label] = t;
    const clears = t.byPair.lo > 0 && t.byEntity.lo > 0 && t.byDocument.lo > 0;
    console.log(`  ${label.padEnd(24)} byPair ${ciStr(t.byPair)}  byEntity ${ciStr(t.byEntity)}  byDoc ${ciStr(t.byDocument)}  -> ${clears ? 'CLEARS' : 'no'}`);
    return { clears, point: t.byPair.point };
  };

  console.log(`\n=== BAR A: T-R4 - FACTNAME (does traversal add to R4?) ===`);
  const barA = rep('T-R4 - FACTNAME', 'T-R4', 'FACTNAME');
  console.log(`\n=== BAR B: T4 - L3 (does it add on top of doc 46?) ===`);
  const barB = rep('T4 - L3', 'T4', 'L3');
  console.log(`\n=== MANDATORY ARTIFACT CONTROL (§5) ===`);
  const randDelta = rep('T-R4-RAND - FACTNAME', 'T-R4-RAND', 'FACTNAME');
  rep('T-R4 - T-R4-RAND', 'T-R4', 'T-R4-RAND');
  console.log(`\n=== LEAK SIZING (guard disabled) ===`);
  rep('T-R4-NOGUARD - T-R4', 'T-R4-NOGUARD', 'T-R4');
  rep('TRAVc - TRAV', 'TRAVc', 'TRAV');

  // ---- degree effect (§5 secondary) ----
  const degImp: [number, number][] = [];
  for (let i = 0; i < pairKeys.length; i++) {
    const c = corpusOf[i]!, t = targetIdx[i]!;
    const dg = adjByCorpus.get(c)!.deg[t]!;
    const imp = (armRanks['FACTNAME'] ? 0 : 0) + (r.hitStrict('FACTNAME', 10)[i]! === 0 && hit('T-R4', 10)[i]! === 1 ? 1 : 0);
    degImp.push([dg, imp]);
  }
  const gained = degImp.filter(([, x]) => x === 1);
  console.log(`\ndegree effect: targets RESCUED by T-R4 (miss->hit at k=10): ${gained.length}; ` +
    `mean target degree rescued ${gained.length ? mean(gained.map(([d]) => d)).toFixed(1) : 'n/a'} vs all ${mean(degImp.map(([d]) => d)).toFixed(1)}`);

  const verdict = !barA.clears ? 'BAR A FAILED — traversal does not add to R4'
    : randDelta.clears && randDelta.point >= barA.point * 0.5
      ? 'BAR A cleared BUT the degree-preserving shuffle reproduces >=50% of it — DEGREE/RRF ARTIFACT, not a traversal win'
      : barB.clears ? 'BAR A + BAR B cleared — traversal adds on top of doc 46'
        : 'BAR A cleared, BAR B failed — traversal and lexical are SUBSTITUTES';
  console.log(`\nOUTCOME (${SET}): ${verdict}`);

  writeFileSync(join(OUT, `traversal-substrate-results-${SET}.json`), JSON.stringify({
    doc: '47-traversal-substrate-prereg.md', run_at: new Date().toISOString(),
    corpus_set: SET, n: r.n, seeds: SEEDS, rrf_k: RRF_K,
    heldout_exclusions: totalExcluded,
    jaccard: { vsNAME: jacc(rTrav, rName), vsFACTMAX: jacc(rTrav, rFactMax) },
    strictR: table, perCorpusR10: perCorpus, deltas, verdict,
  }, null, 2));
  console.log(`wrote traversal-substrate-results-${SET}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
