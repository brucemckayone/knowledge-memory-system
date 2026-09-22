/**
 * Doc 46 — does a LEXICAL fact signal add to the confirmed name⊕fact fusion (R4)?
 *
 * BM25f = BM25 over fact `source_text`, MAX-aggregated to entities, mirroring
 * FACTMAX's aggregation exactly so the ONLY difference is dense vs lexical.
 * Applies the same held-out guard as `factSignals`: facts sourced from the query
 * document are EXCLUDED (omitting it leaks the query's own text).
 *
 * Baselines (NAME / FACTMAX / FACTNAME) come from the FROZEN arm registry via
 * runEval, so the R4 comparison is exact and the ARM-NAME regression guard
 * applies. The new arms are computed here with the same reciprocalRankFusion and
 * the same index-asc tie-break.
 *
 * Cost ZERO: frozen embed cache + BM25. No Ollama, no LLM.
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     NODE_ENV=test npx tsx src/test/tools/lexical-fact-signal.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBm25, bm25Scores, rankByScore, ciStr, mean } from './retrieval-eval/core.js';
import { reciprocalRankFusion } from '../../services/fusion.js';
import { runEval } from './retrieval-eval/harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARC = join(HERE, '../../../../docs/architecture/cross-corpus-audit/multihop-artifacts');
const CORPORA_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');
// CORPUS_SET=dal (default, the R4/doc-12 corpus pair with its frozen regression
// guard) or CORPUS_SET=arxiv (the INDEPENDENT extraction R4 was confirmed on).
const SET = (process.env.CORPUS_SET ?? 'dal') as 'dal' | 'arxiv';
const SETS = {
  dal: { corpora: ['dal-nlp', 'dal-cv'] as const, docFileFor: { 'dal-nlp': 'corpus-A.json', 'dal-cv': 'corpus-B.json' }, writable: undefined as string | undefined, reg: { NAME: 0.20056497175141244 }, regN: 354 },
  arxiv: { corpora: ['arxiv-nlp', 'arxiv-cv'] as const, docFileFor: { 'arxiv-nlp': 'corpus-A.json', 'arxiv-cv': 'corpus-B.json' }, writable: 'arxiv-embed-cache.json', reg: undefined, regN: undefined },
}[SET];
const CORPORA = SETS.corpora as readonly string[];
const RRF_K = 60;
const byIndex = (a: number, b: number): number => a - b;

async function main(): Promise<void> {
  const r = await runEval({
    label: `lexical-fact-signal-${SET}`,
    corpora: CORPORA,
    paths: { arcDir: ARC, corporaDir: CORPORA_DIR, docFileFor: SETS.docFileFor },
    frozenCachePath: join(OUT, 'embed-cache.json'),
    writableCachePath: SETS.writable ? join(OUT, SETS.writable) : undefined,
    arms: ['NAME', 'FACTMAX', 'FACTNAME', 'BM25n', 'H60'],
    regression: SETS.reg ? { targets: SETS.reg, n: SETS.regN! } : undefined,
    ensureEmbedEntityNames: SET === 'arxiv',
    ensureEmbedQueryDocs: SET === 'arxiv',
    keepBaseRankings: true,
  });

  const { sub, factStateByCorpus, corpusOf, docOf, targetIdx, pairKeys } = r;
  if (!factStateByCorpus) throw new Error('fact states missing');
  const rName = r.baseRankings!.rName;
  const rFactMax = r.baseRankings!.rFactMax!;

  // ---- fact-text coverage (kill condition §6.4) ----
  let totFacts = 0, emptyText = 0;
  for (const c of CORPORA) {
    const fs = factStateByCorpus.get(c)!;
    totFacts += fs.texts.length;
    emptyText += fs.texts.filter((t) => !t || !t.trim()).length;
  }
  console.log(`\nfact text coverage: ${totFacts - emptyText}/${totFacts} non-empty (${(100 * (1 - emptyText / totFacts)).toFixed(1)}%)`);
  if (emptyText / totFacts > 0.5) throw new Error('§6.4: majority of facts have no text — BM25f measures nothing');

  // ---- BM25 index over FACT TEXTS, per corpus ----
  const bmFactByCorpus = new Map<string, ReturnType<typeof buildBm25>>();
  for (const c of CORPORA) bmFactByCorpus.set(c, buildBm25(factStateByCorpus.get(c)!.texts));

  // ---- per-pair BM25f, MAX-aggregated, with the SAME held-out exclusion ----
  const rBm25f: number[][] = [];
  const rBm25fC: number[][] = [];
  let exclusions = 0;
  const entCountByCorpus = new Map<string, number>();
  for (const c of CORPORA) entCountByCorpus.set(c, sub.entsByCorpus.get(c)!.length);

  for (let i = 0; i < pairKeys.length; i++) {
    const c = corpusOf[i]!;
    const docId = docOf[i]!;
    const fs = factStateByCorpus.get(c)!;
    const U = entCountByCorpus.get(c)!;
    const d = sub.docsById.get(docId)!;
    const qtext = `${d.title} ${d.abstract}`;

    const fscore = bm25Scores(bmFactByCorpus.get(c)!, qtext);
    const entMax = new Array<number>(U).fill(-Infinity);
    // CONSERVATIVE variant: additionally drop facts with NO source-paper mapping,
    // for which the held-out guard cannot fire (3.5% of facts). If the headline
    // survives here, the residual leak exposure is not driving it.
    const entMaxC = new Array<number>(U).fill(-Infinity);
    for (const [ei, fidxs] of fs.entFacts) {
      let best = -Infinity, bestC = -Infinity;
      for (const fi of fidxs) {
        if (fs.paper[fi] === docId) { exclusions += 1; continue; }   // held-out guard (§3)
        const s = fscore[fi]!;
        if (s > best) best = s;
        if (fs.paper[fi] && s > bestC) bestC = s;
      }
      if (best > -Infinity) entMax[ei] = best;
      if (bestC > -Infinity) entMaxC[ei] = bestC;
    }
    rBm25f.push(rankByScore(entMax, -Infinity));
    rBm25fC.push(rankByScore(entMaxC, -Infinity));
  }
  console.log(`held-out fact exclusions applied: ${exclusions}`);

  // ---- new arms ----
  const strictOf = (ranking: number[], t: number): number => {
    const p = ranking.indexOf(t);
    return p < 0 ? Number.POSITIVE_INFINITY : p + 1;
  };
  const armRanks: Record<string, number[]> = { BM25f: [], L2: [], L3: [], L3c: [] };
  for (let i = 0; i < pairKeys.length; i++) {
    const t = targetIdx[i]!;
    const b = rBm25f[i]!, n = rName[i]!, f = rFactMax[i]!;
    armRanks.BM25f!.push(strictOf(b, t));
    armRanks.L2!.push(strictOf(reciprocalRankFusion([n, b], { k: RRF_K, tieBreak: byIndex }), t));
    armRanks.L3!.push(strictOf(reciprocalRankFusion([n, f, b], { k: RRF_K, tieBreak: byIndex }), t));
    armRanks.L3c!.push(strictOf(reciprocalRankFusion([n, f, rBm25fC[i]!], { k: RRF_K, tieBreak: byIndex }), t));
  }

  // ---- degeneracy check (§6.3): FACTMAX vs BM25f top-10 Jaccard ----
  const jac = mean(rFactMax.map((fr, i) => {
    const A = new Set(fr.slice(0, 10)); const B = new Set(rBm25f[i]!.slice(0, 10));
    const inter = [...A].filter((x) => B.has(x)).length;
    const uni = new Set([...A, ...B]).size;
    return uni ? inter / uni : 0;
  }));
  console.log(`FACTMAX vs BM25f top-10 Jaccard: ${jac.toFixed(3)}` + (jac > 0.9 ? '  >>> DEGENERATE — result uninformative (§6.3)' : '  (distinct signals)'));

  // ---- CONTROL: is BM25f just BM25-over-NAMES in disguise? ----
  const rBm25n = r.baseRankings!.rBm25!;
  const jacFN = mean(rBm25n.map((br, i) => {
    const A = new Set(br.slice(0, 10)); const B = new Set(rBm25f[i]!.slice(0, 10));
    const inter = [...A].filter((x) => B.has(x)).length;
    const uni = new Set([...A, ...B]).size;
    return uni ? inter / uni : 0;
  }));
  console.log(`CONTROL BM25n vs BM25f top-10 Jaccard: ${jacFN.toFixed(3)}` + (jacFN > 0.9 ? '  >>> SAME SIGNAL' : '  (distinct)'));
  // L3n = the same three-way but with BM25-over-NAMES instead of fact text.
  // If L3n ~= L3, the gain is "add any lexical signal", NOT fact text specifically.
  for (let i = 0; i < pairKeys.length; i++) {
    const t = targetIdx[i]!;
    armRanks.L3n = armRanks.L3n ?? [];
    armRanks.L3n.push(strictOf(reciprocalRankFusion([rName[i]!, rFactMax[i]!, rBm25n[i]!], { k: RRF_K, tieBreak: byIndex }), t));
  }

  // ---- LEAK CHECK: can the held-out guard be bypassed by a missing paper mapping? ----
  let unmappedFacts = 0, totF = 0;
  for (const c of CORPORA) {
    const fs = factStateByCorpus.get(c)!;
    totF += fs.paper.length;
    unmappedFacts += fs.paper.filter((x) => !x).length;
  }
  console.log(`LEAK CHECK: facts with NO source-paper mapping (guard cannot fire): ${unmappedFacts}/${totF} (${(100*unmappedFacts/totF).toFixed(1)}%)`);

  // ---- metrics ----
  const hitNew = (arm: string, k: number): number[] => armRanks[arm]!.map((x) => (x <= k ? 1 : 0));
  const hit = (arm: string, k: number): number[] => (armRanks[arm] ? hitNew(arm, k) : r.hitStrict(arm, k));
  const R = (arm: string, k: number): number => mean(hit(arm, k));
  const ALL = ['NAME', 'FACTMAX', 'FACTNAME', 'BM25n', 'H60', 'BM25f', 'L2', 'L3', 'L3n', 'L3c'];

  console.log(`\n=== STRICT R@k (n=${r.n}) ===`);
  console.log('arm'.padEnd(10) + [1, 5, 10, 20, 30].map((k) => `R@${k}`.padStart(9)).join(''));
  const table: Record<string, Record<string, number>> = {};
  for (const a of ALL) {
    table[a] = {};
    for (const k of [1, 5, 10, 20, 30]) table[a]![`R@${k}`] = R(a, k);
    console.log(a.padEnd(10) + [1, 5, 10, 20, 30].map((k) => R(a, k).toFixed(4).padStart(9)).join(''));
  }

  console.log('\n=== PER CORPUS, strict R@10 ===');
  const perCorpus: Record<string, Record<string, number>> = {};
  for (const c of CORPORA) {
    perCorpus[c] = {};
    const idx = corpusOf.map((x, i) => (x === c ? i : -1)).filter((i) => i >= 0);
    const line = ALL.map((a) => {
      const h = hit(a, 10);
      const v = mean(idx.map((i) => h[i]!));
      perCorpus[c]![a] = v;
      return `${a}=${v.toFixed(4)}`;
    });
    console.log(`  ${c} (n=${idx.length}): ${line.join('  ')}`);
  }

  console.log(`\n=== THE BAR (doc 46 §5): L3 - FACTNAME strict R@10, all three bootstraps ===`);
  const deltas: Record<string, unknown> = {};
  const report = (label: string, a: string, b: string) => {
    const t = r.tri(hit(a, 10), hit(b, 10));
    deltas[label] = t;
    const clears = t.byPair.lo > 0 && t.byEntity.lo > 0 && t.byDocument.lo > 0;
    console.log(`  ${label.padEnd(20)} byPair ${ciStr(t.byPair)}  byEntity ${ciStr(t.byEntity)}  byDoc ${ciStr(t.byDocument)}  -> ${clears ? 'DEMONSTRATED' : 'not demonstrated'}`);
    return clears;
  };
  const primaryClears = report('L3 - FACTNAME', 'L3', 'FACTNAME');
  console.log('\n=== secondary deltas ===');
  report('L2 - FACTNAME', 'L2', 'FACTNAME');
  report('BM25f - FACTMAX', 'BM25f', 'FACTMAX');
  report('L3 - NAME', 'L3', 'NAME');
  report('FACTNAME - NAME', 'FACTNAME', 'NAME');
  console.log('\n=== THE CONTROL: does fact TEXT matter, or just any lexical signal? ===');
  report('L3 - L3n', 'L3', 'L3n');
  report('BM25f - BM25n', 'BM25f', 'BM25n');
  report('L2 - H60', 'L2', 'H60');
  report('H60 - NAME', 'H60', 'NAME');
  report('L3c - FACTNAME', 'L3c', 'FACTNAME');

  console.log(`\nOUTCOME: ${primaryClears ? 'L3 DEMONSTRATED over R4 (all 3 bootstraps)' : 'L3 does NOT clear the bar — LEAD at best'}`);

  const out = {
    doc: '46-lexical-fact-signal-prereg.md', run_at: new Date().toISOString(),
    n: r.n, corpus_set: SET, corpora: [...CORPORA], rrf_k: RRF_K,
    fact_text_coverage: (totFacts - emptyText) / totFacts,
    factmax_bm25f_jaccard: jac, bm25n_bm25f_jaccard: jacFN, unmapped_facts: unmappedFacts, heldout_exclusions: exclusions,
    strictR: table, perCorpusR10: perCorpus, deltas,
    outcome: primaryClears ? 'DEMONSTRATED' : 'NOT_DEMONSTRATED',
  };
  const path = join(OUT, `lexical-fact-signal-results-${SET}.json`);
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${path}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
