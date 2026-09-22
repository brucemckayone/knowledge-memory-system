/**
 * BLIND ADVERSARY controls against doc 46 (lexical fact signal / L3).
 *
 * Recomputes every doc-46 arm from the same frozen substrate, then adds the three
 * pre-registered kill controls:
 *   (1) RANDOM / SHUFFLED / INDEX third arm  — how much of +0.076 does a
 *       MEANINGLESS third ranking reproduce through RRF mechanics alone?
 *   (2) index-DESCENDING tie-break           — do the deltas survive the flip?
 *   (3) degree-only third arm                — is BM25f a popularity prior?
 * plus leak probes (no-guard variant, textual containment of surviving target
 * facts in the query document, entity-name-stripped fact text).
 *
 * Read-only. Cost ZERO (frozen embed cache + BM25). No Ollama, no LLM.
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     NODE_ENV=test npx tsx src/test/tools/doc46adv-controls.ts
 *   CORPUS_SET=arxiv ... ; TIE=desc ... (control 2)
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBm25, bm25Scores, ciStr, mean, dot, mulberry32, tokenise, nameMatcher,
  type Bm25Index, type TriResult,
} from './retrieval-eval/core.js';
import { reciprocalRankFusion } from '../../services/fusion.js';
import { runEval } from './retrieval-eval/harness.js';
import { entityEmbedTextFor } from '../../services/embed-text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARC = join(HERE, '../../../../docs/architecture/cross-corpus-audit/multihop-artifacts');
const CORPORA_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');
const SET = (process.env.CORPUS_SET ?? 'dal') as 'dal' | 'arxiv';
const DESC = (process.env.TIE ?? 'asc') === 'desc';
const NSEEDS = Number(process.env.NSEEDS ?? 10);
const SETS = {
  dal: { corpora: ['dal-nlp', 'dal-cv'] as const, docFileFor: { 'dal-nlp': 'corpus-A.json', 'dal-cv': 'corpus-B.json' }, writable: undefined as string | undefined, reg: { NAME: 0.20056497175141244 }, regN: 354 },
  arxiv: { corpora: ['arxiv-nlp', 'arxiv-cv'] as const, docFileFor: { 'arxiv-nlp': 'corpus-A.json', 'arxiv-cv': 'corpus-B.json' }, writable: 'arxiv-embed-cache.json', reg: undefined, regN: undefined },
}[SET];
const CORPORA = SETS.corpora as readonly string[];
const K = 60;

/** rankByScore with a switchable index tie-break (asc reproduces the frozen order). */
function rank(scores: number[], minScore: number): number[] {
  const idx = scores.map((_, i) => i).filter((i) => scores[i]! > minScore);
  idx.sort((a, b) => (scores[b]! - scores[a]!) || (DESC ? b - a : a - b));
  return idx;
}
const tieBreak = (a: number, b: number): number => (DESC ? b - a : a - b);

/** Strict rank of `t` under retrieved-set RRF(k) — identical semantics to
 *  strictRankOf(reciprocalRankFusion(...)) but O(U) instead of O(U log U). */
function fusedRank(rankings: number[][], t: number, U: number): number {
  const score = new Float64Array(U);
  const seen = new Uint8Array(U);
  for (const r of rankings) for (let i = 0; i < r.length; i++) { const it = r[i]!; score[it] += 1 / (K + i + 1); seen[it] = 1; }
  if (!seen[t]) return Number.POSITIVE_INFINITY;
  const st = score[t]!;
  let above = 0;
  for (let u = 0; u < U; u++) {
    if (u === t || !seen[u]) continue;
    const s = score[u]!;
    if (s > st) above += 1;
    else if (s === st && (DESC ? u > t : u < t)) above += 1;
  }
  return above + 1;
}
const plainRank = (r: number[], t: number): number => { const i = r.indexOf(t); return i < 0 ? Number.POSITIVE_INFINITY : i + 1; };

function shuffled(n: number, rnd: () => number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]!; a[i] = a[j]!; a[j] = t; }
  return a;
}

/** Spearman rho between two score arrays over the same index set. */
function spearman(x: number[], y: number[]): number {
  const n = x.length;
  const rk = (v: number[]): number[] => {
    const ord = v.map((_, i) => i).sort((a, b) => v[a]! - v[b]!);
    const out = new Array<number>(n);
    let i = 0;
    while (i < n) { let j = i; while (j + 1 < n && v[ord[j + 1]!]! === v[ord[i]!]!) j += 1; const avg = (i + j) / 2; for (let q = i; q <= j; q++) out[ord[q]!] = avg; i = j + 1; }
    return out;
  };
  const rx = rk(x); const ry = rk(y);
  const mx = mean(rx); const my = mean(ry);
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i]! - mx; const b = ry[i]! - my; num += a * b; dx += a * a; dy += b * b; }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

async function main(): Promise<void> {
  const r = await runEval({
    label: `doc46adv-${SET}-${DESC ? 'desc' : 'asc'}`,
    corpora: CORPORA,
    paths: { arcDir: ARC, corporaDir: CORPORA_DIR, docFileFor: SETS.docFileFor },
    frozenCachePath: join(OUT, 'embed-cache.json'),
    writableCachePath: SETS.writable ? join(OUT, SETS.writable) : undefined,
    arms: ['NAME', 'FACTMAX', 'FACTNAME', 'BM25n', 'H60'],
    regression: !DESC && SETS.reg ? { targets: SETS.reg, n: SETS.regN! } : undefined,
    ensureEmbedEntityNames: false,
    ensureEmbedQueryDocs: false,
    keepBaseRankings: false,
  });
  const { sub, factStateByCorpus } = r;
  if (!factStateByCorpus) throw new Error('fact states missing');

  // ---------------- recompute every base signal (own code path) ----------------
  const ranks: Record<string, number[]> = {};
  const push = (arm: string, v: number): void => { (ranks[arm] ??= []).push(v); };
  const corpusOf: string[] = []; const targetIdx: number[] = [];
  // diagnostics
  const degTarget: number[] = []; const degCorpusMean: number[] = [];
  const spRhoLexDeg: number[] = []; const posFrac: number[] = [];
  const leakMaxContTarget: number[] = []; const leakMaxContRand: number[] = [];
  const leakArgmaxCont: number[] = []; const nameInBestFact: number[] = [];
  let unmappedIsArgmax = 0; let exclusions = 0;
  const jacPairs: Array<{ fm: number[]; lx: number[]; dg: number[] }> = [];

  const seeds = Array.from({ length: NSEEDS }, (_, i) => 1000 + i);

  for (const c of CORPORA) {
    const ents = sub.entsByCorpus.get(c)!;
    const U = ents.length;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const vName = ents.map((e) => r.store.getEntity(entityEmbedTextFor(e.name, e.description, 'name')));
    const bmN: Bm25Index = buildBm25(ents.map((e) => e.name));
    const fs = factStateByCorpus.get(c)!;
    const bmF: Bm25Index = buildBm25(fs.texts);
    // entity-name-stripped fact text: removes the fact's two endpoint names
    const factOwners = new Map<number, Set<number>>();
    for (const [ei, fis] of fs.entFacts) for (const fi of fis) { const s = factOwners.get(fi) ?? new Set<number>(); s.add(ei); factOwners.set(fi, s); }
    const strippedTexts = fs.texts.map((t, fi) => {
      let out = t;
      for (const ei of factOwners.get(fi) ?? []) {
        const nm = (ents[ei]!.name ?? '').trim();
        if (nm.length < 3) continue;
        out = out.replace(new RegExp(nameMatcher(nm.toLowerCase()).source, 'gi'), ' ');
      }
      return out;
    });
    const bmFX: Bm25Index = buildBm25(strippedTexts);
    const factTokSet = fs.texts.map((t) => new Set(tokenise(t)));
    // corpus-wide degree (all facts, for the task-construction check)
    const degAll = new Array<number>(U).fill(0);
    for (const [ei, fis] of fs.entFacts) degAll[ei] = fis.length;
    const degAllMean = mean(degAll);

    for (const p of sub.pairs) {
      if (p.corpusId !== c) continue;
      const t = idxOf.get(p.entityId);
      if (t === undefined) continue;
      const d = sub.docsById.get(p.docId)!;
      const qtext = `${d.title} ${d.abstract}`;
      const qv = r.store.getQuery(qtext);
      const qTok = new Set(tokenise(qtext));

      const nameScore = vName.map((v) => dot(qv, v));
      const bm25nScore = bm25Scores(bmN, qtext);
      const fDense = fs.vecs.map((v) => dot(qv, v));
      const fLex = bm25Scores(bmF, qtext);
      const fLexX = bm25Scores(bmFX, qtext);

      const NEG = Number.NEGATIVE_INFINITY;
      const eDense = new Array<number>(U).fill(NEG);
      const eLex = new Array<number>(U).fill(NEG);
      const eLexC = new Array<number>(U).fill(NEG);     // conservative: mapped facts only
      const eLexNG = new Array<number>(U).fill(NEG);    // NO held-out guard
      const eLexX = new Array<number>(U).fill(NEG);     // endpoint-name-stripped text
      const eCnt = new Array<number>(U).fill(0);        // eligible fact degree
      let argmaxFiT = -1; let argmaxUnmapped = false;
      for (const [ei, fis] of fs.entFacts) {
        for (const fi of fis) {
          const sNG = fLex[fi]!;
          if (sNG > eLexNG[ei]!) eLexNG[ei] = sNG;
          if (fs.paper[fi] === p.docId) { exclusions += 1; continue; }
          eCnt[ei] += 1;
          if (fDense[fi]! > eDense[ei]!) eDense[ei] = fDense[fi]!;
          if (fLexX[fi]! > eLexX[ei]!) eLexX[ei] = fLexX[fi]!;
          if (sNG > eLex[ei]!) { eLex[ei] = sNG; if (ei === t) { argmaxFiT = fi; argmaxUnmapped = !fs.paper[fi]; } }
          if (fs.paper[fi] && sNG > eLexC[ei]!) eLexC[ei] = sNG;
        }
      }
      if (argmaxUnmapped) unmappedIsArgmax += 1;

      const rName = rank(nameScore, NEG);
      const rFm = rank(eDense, NEG);
      const rBn = rank(bm25nScore, 0);
      const rLex = rank(eLex, NEG);
      const rLexC = rank(eLexC, NEG);
      const rLexNG = rank(eLexNG, NEG);
      const rLexX = rank(eLexX, NEG);
      const rDeg = rank(eCnt, 0);
      // MEAN aggregation removes the max-over-degree order statistic
      const eLexMean = new Array<number>(U).fill(NEG);
      {
        const sum = new Array<number>(U).fill(0);
        for (const [ei, fis] of fs.entFacts) for (const fi of fis) { if (fs.paper[fi] === p.docId) continue; sum[ei] += fLex[fi]!; }
        for (let i = 0; i < U; i++) if (eCnt[i]! > 0) eLexMean[i] = sum[i]! / eCnt[i]!;
      }
      const rLexMean = rank(eLexMean, NEG);
      const rIdxAsc = Array.from({ length: U }, (_, i) => i);
      const rIdxDesc = rIdxAsc.slice().reverse();

      // ---- doc-46 arms ----
      push('NAME', plainRank(rName, t));
      push('FACTMAX', plainRank(rFm, t));
      push('BM25n', plainRank(rBn, t));
      push('BM25f', plainRank(rLex, t));
      push('BM25fX', plainRank(rLexX, t));
      push('DEG', plainRank(rDeg, t));
      push('FACTNAME', fusedRank([rName, rFm], t, U));
      push('H60', fusedRank([rName, rBn], t, U));
      push('L2', fusedRank([rName, rLex], t, U));
      push('L3', fusedRank([rName, rFm, rLex], t, U));
      push('L3c', fusedRank([rName, rFm, rLexC], t, U));
      push('L3n', fusedRank([rName, rFm, rBn], t, U));
      // ---- leak: no guard at all ----
      push('L3ng', fusedRank([rName, rFm, rLexNG], t, U));
      push('BM25fNG', plainRank(rLexNG, t));
      // ---- control 3: degree-only third arm ----
      push('L3deg', fusedRank([rName, rFm, rDeg], t, U));
      push('L2deg', fusedRank([rName, rDeg], t, U));
      // ---- zero-information index third arm ----
      push('L3idxA', fusedRank([rName, rFm, rIdxAsc], t, U));
      push('L3idxD', fusedRank([rName, rFm, rIdxDesc], t, U));
      // ---- mechanism: name-stripped fact text as the third arm ----
      push('L3x', fusedRank([rName, rFm, rLexX], t, U));
      // ---- mechanism: MEAN instead of MAX aggregation ----
      push('BM25fMEAN', plainRank(rLexMean, t));
      push('L3mean', fusedRank([rName, rFm, rLexMean], t, U));

      // ---- control 1: random + shuffled third arms ----
      const nF = fs.vecs.length;
      for (const sd of seeds) {
        const rnd = mulberry32(sd + 7919 * (ranks.NAME!.length));
        const rRand = shuffled(U, rnd);
        push(`L3rand${sd}`, fusedRank([rName, rFm, rRand], t, U));
        push(`L2rand${sd}`, fusedRank([rName, rRand], t, U));
        // matched control A: same score multiset as eLex, permuted ENTITY labels
        const perm = shuffled(U, rnd);
        const shufScores = perm.map((j) => eLex[j]!);
        const rShuf = rank(shufScores, NEG);
        push(`L3shuf${sd}`, fusedRank([rName, rFm, rShuf], t, U));
        push(`L2shuf${sd}`, fusedRank([rName, rShuf], t, U));
        // matched control B (DECISIVE): permute the per-FACT BM25 scores across
        // facts, then MAX-aggregate with the identical exclusion. Keeps the exact
        // score distribution AND each entity's fact-degree structure; destroys only
        // the query<->fact-content association. Isolates the degree order statistic.
        const fperm = shuffled(nF, rnd);
        const eFs = new Array<number>(U).fill(NEG);
        for (const [ei, fis] of fs.entFacts) for (const fi of fis) {
          if (fs.paper[fi] === p.docId) continue;
          const s = fLex[fperm[fi]!]!;
          if (s > eFs[ei]!) eFs[ei] = s;
        }
        const rFs = rank(eFs, NEG);
        push(`L3fshuf${sd}`, fusedRank([rName, rFm, rFs], t, U));
        push(`L2fshuf${sd}`, fusedRank([rName, rFs], t, U));
      }

      // ---- diagnostics ----
      corpusOf.push(c); targetIdx.push(t);
      degTarget.push(degAll[t]!); degCorpusMean.push(degAllMean);
      const elig = [...Array(U).keys()].filter((i) => eLex[i]! > NEG);
      spRhoLexDeg.push(spearman(elig.map((i) => eLex[i]!), elig.map((i) => eCnt[i]!)));
      posFrac.push(elig.filter((i) => eLex[i]! > 0).length / U);
      jacPairs.push({ fm: rFm.slice(0, 10), lx: rLex.slice(0, 10), dg: rDeg.slice(0, 10) });

      // ---- leak: token containment of surviving target facts in the query doc ----
      const cont = (fi: number): number => { const s = factTokSet[fi]!; let h = 0; for (const x of s) if (qTok.has(x)) h += 1; return s.size ? h / s.size : 0; };
      const tFacts = (fs.entFacts.get(t) ?? []).filter((fi) => fs.paper[fi] !== p.docId);
      leakMaxContTarget.push(tFacts.length ? Math.max(...tFacts.map(cont)) : 0);
      leakArgmaxCont.push(argmaxFiT >= 0 ? cont(argmaxFiT) : 0);
      const rnd2 = mulberry32(31 + corpusOf.length);
      const others: number[] = [];
      for (let q = 0; q < 20; q++) { const u = Math.floor(rnd2() * U); if (u !== t) others.push(u); }
      const oc = others.map((u) => { const ff = (fs.entFacts.get(u) ?? []).filter((fi) => fs.paper[fi] !== p.docId); return ff.length ? Math.max(...ff.map(cont)) : 0; });
      leakMaxContRand.push(mean(oc));
      if (argmaxFiT >= 0) {
        const nm = (ents[t]!.name ?? '').trim();
        nameInBestFact.push(nm.length >= 3 && nameMatcher(nm.toLowerCase()).test(fs.texts[argmaxFiT]!.toLowerCase()) ? 1 : 0);
      } else nameInBestFact.push(0);
    }
  }

  const n = ranks.NAME!.length;
  if (n !== r.n) throw new Error(`recomputed n=${n} != harness n=${r.n}`);
  for (let i = 0; i < n; i++) if (targetIdx[i] !== r.targetIdx[i]) throw new Error(`pair order drift at ${i}`);

  const hit = (arm: string, k = 10): number[] => ranks[arm]!.map((x) => (x <= k ? 1 : 0));
  const R = (arm: string, k = 10): number => mean(hit(arm, k));
  const tri = (a: string, b: string): TriResult => r.tri(hit(a), hit(b));
  const clears = (t: TriResult): boolean => t.byPair.lo > 0 && t.byEntity.lo > 0 && t.byDocument.lo > 0;

  console.log(`\n### ADVERSARY RECOMPUTE  set=${SET}  tie=${DESC ? 'index-DESC' : 'index-ASC'}  n=${n}`);
  const MAIN = ['NAME', 'FACTMAX', 'FACTNAME', 'BM25n', 'H60', 'BM25f', 'BM25fX', 'BM25fNG', 'DEG', 'L2', 'L3', 'L3c', 'L3n', 'L3ng', 'L3deg', 'L2deg', 'L3idxA', 'L3idxD', 'L3x', 'BM25fMEAN', 'L3mean'];
  console.log('arm'.padEnd(10) + [1, 5, 10, 20, 30].map((k) => `R@${k}`.padStart(9)).join(''));
  const table: Record<string, Record<string, number>> = {};
  for (const a of MAIN) { table[a] = {}; for (const k of [1, 5, 10, 20, 30]) table[a]![`R@${k}`] = R(a, k); console.log(a.padEnd(10) + [1, 5, 10, 20, 30].map((k) => R(a, k).toFixed(4).padStart(9)).join('')); }

  const deltas: Record<string, TriResult> = {};
  const rep = (label: string, a: string, b: string): TriResult => {
    const t = tri(a, b); deltas[label] = t;
    console.log(`  ${label.padEnd(20)} byPair ${ciStr(t.byPair)}  byEntity ${ciStr(t.byEntity)}  byDoc ${ciStr(t.byDocument)}  -> ${clears(t) ? 'CLEARS' : 'no'}`);
    return t;
  };
  console.log('\n--- headline + doc-46 secondaries (recomputed) ---');
  rep('L3 - FACTNAME', 'L3', 'FACTNAME');
  rep('L2 - FACTNAME', 'L2', 'FACTNAME');
  rep('L3c - FACTNAME', 'L3c', 'FACTNAME');
  rep('L3 - NAME', 'L3', 'NAME');
  rep('FACTNAME - NAME', 'FACTNAME', 'NAME');
  rep('L2 - H60', 'L2', 'H60');
  rep('L3 - L3n', 'L3', 'L3n');
  rep('BM25f - FACTMAX', 'BM25f', 'FACTMAX');

  console.log('\n--- CONTROL 1: meaningless third arm ---');
  const dd = (arm: string, base = 'FACTNAME'): number => R(arm) - R(base);
  const summ = (pfx: string, base: string): { deltas: number[]; cl: number } => {
    const ds = seeds.map((sd) => dd(`${pfx}${sd}`, base));
    let cl = 0; for (const sd of seeds) if (clears(tri(`${pfx}${sd}`, base))) cl += 1;
    const s = ds.slice().sort((a, b) => a - b);
    console.log(`  ${pfx}* vs ${base}: n=${ds.length} seeds  min ${s[0]!.toFixed(4)}  med ${s[Math.floor(s.length / 2)]!.toFixed(4)}  max ${s[s.length - 1]!.toFixed(4)}  mean ${mean(ds).toFixed(4)}  | seeds clearing all-3-bootstraps: ${cl}/${ds.length}`);
    return { deltas: ds, cl };
  };
  const randSum = summ('L3rand', 'FACTNAME');
  const shufSum = summ('L3shuf', 'FACTNAME');
  const fshufSum = summ('L3fshuf', 'FACTNAME');
  const rand2Sum = summ('L2rand', 'FACTNAME');
  const fshuf2Sum = summ('L2fshuf', 'FACTNAME');
  const shuf2Sum = summ('L2shuf', 'FACTNAME');
  console.log(`  REAL L3 - FACTNAME = ${dd('L3').toFixed(4)}   REAL L2 - FACTNAME = ${dd('L2').toFixed(4)}`);
  console.log(`  zero-info INDEX third arm: L3idxA - FACTNAME = ${dd('L3idxA').toFixed(4)}   L3idxD - FACTNAME = ${dd('L3idxD').toFixed(4)}`);

  console.log('\n--- CONTROL 3: degree prior ---');
  console.log(`  mean Spearman rho(BM25f entity score, eligible fact degree) = ${mean(spRhoLexDeg).toFixed(3)}`);
  console.log(`  mean target fact-degree ${mean(degTarget).toFixed(2)} vs corpus mean fact-degree ${mean(degCorpusMean).toFixed(2)}  (ratio ${(mean(degTarget) / mean(degCorpusMean)).toFixed(2)}x)`);
  console.log(`  DEG-alone strict R@10 = ${R('DEG').toFixed(4)}   (NAME ${R('NAME').toFixed(4)})`);
  const jac = (k: 'fm' | 'lx' | 'dg', j: 'fm' | 'lx' | 'dg'): number => mean(jacPairs.map((p) => { const A = new Set(p[k]); const B = new Set(p[j]); const inter = [...A].filter((x) => B.has(x)).length; return new Set([...A, ...B]).size ? inter / new Set([...A, ...B]).size : 0; }));
  console.log(`  top-10 Jaccard  BM25f~DEG ${jac('lx', 'dg').toFixed(3)}   FACTMAX~DEG ${jac('fm', 'dg').toFixed(3)}   FACTMAX~BM25f ${jac('fm', 'lx').toFixed(3)}`);
  rep('L3deg - FACTNAME', 'L3deg', 'FACTNAME');
  rep('L2deg - FACTNAME', 'L2deg', 'FACTNAME');
  rep('L3 - L3deg', 'L3', 'L3deg');
  rep('L3mean - FACTNAME', 'L3mean', 'FACTNAME');
  rep('L3 - L3mean', 'L3', 'L3mean');
  for (const sd of [seeds[0]!]) { rep(`L3 - L3fshuf${sd}`, 'L3', `L3fshuf${sd}`); }

  console.log('\n--- LEAK PROBES ---');
  console.log(`  held-out exclusions applied: ${exclusions}`);
  console.log(`  pairs whose TARGET BM25f argmax fact is UNMAPPED (guard could not fire): ${unmappedIsArgmax}/${n}`);
  console.log(`  no-guard BM25f R@10 ${R('BM25fNG').toFixed(4)} vs guarded ${R('BM25f').toFixed(4)};  L3ng ${R('L3ng').toFixed(4)} vs L3 ${R('L3').toFixed(4)}`);
  rep('L3ng - L3', 'L3ng', 'L3');
  const ge = (xs: number[], thr: number): number => xs.filter((x) => x >= thr).length;
  console.log(`  token-containment of surviving TARGET facts in the query doc: mean max ${mean(leakMaxContTarget).toFixed(3)}; >=0.9 on ${ge(leakMaxContTarget, 0.9)}/${n}; ==1.0 on ${ge(leakMaxContTarget, 0.999)}/${n}`);
  console.log(`  same statistic for 20 random NON-target entities:            mean max ${mean(leakMaxContRand).toFixed(3)}`);
  console.log(`  containment of the exact fact BM25f picks as target argmax:   mean ${mean(leakArgmaxCont).toFixed(3)}; >=0.9 on ${ge(leakArgmaxCont, 0.9)}/${n}`);
  console.log(`  target canonical name appears verbatim in its BM25f argmax fact: ${(100 * mean(nameInBestFact)).toFixed(1)}%`);
  console.log(`  fraction of entities with POSITIVE BM25f score (mean over pairs): ${(100 * mean(posFrac)).toFixed(1)}%`);
  console.log('\n--- MECHANISM: endpoint-name-stripped fact text ---');
  rep('L3x - FACTNAME', 'L3x', 'FACTNAME');
  rep('L3 - L3x', 'L3', 'L3x');

  const path = join(OUT, `doc46adv-${SET}-${DESC ? 'desc' : 'asc'}.json`);
  writeFileSync(path, JSON.stringify({
    set: SET, tie: DESC ? 'desc' : 'asc', n, strictR: table, deltas,
    control1: { seeds, L3rand: randSum, L3shuf: shufSum, L2rand: rand2Sum, L2shuf: shuf2Sum, L3fshuf: fshufSum, L2fshuf: fshuf2Sum, realL3: dd('L3'), realL2: dd('L2'), L3idxA: dd('L3idxA'), L3idxD: dd('L3idxD') },
    control3: { rhoLexDeg: mean(spRhoLexDeg), targetDeg: mean(degTarget), corpusDeg: mean(degCorpusMean), degR10: R('DEG'), jacLexDeg: jac('lx', 'dg'), jacFmDeg: jac('fm', 'dg') },
    leak: { exclusions, unmappedIsArgmax, contTarget: mean(leakMaxContTarget), contRand: mean(leakMaxContRand), contArgmax: mean(leakArgmaxCont), nameInBest: mean(nameInBestFact), posFrac: mean(posFrac) },
  }, null, 2));
  console.log(`\nwrote ${path}`);

  // sanity: the O(U) fusedRank must agree with the real RRF on a sample
  let bad = 0;
  for (const c of CORPORA) {
    const ents = sub.entsByCorpus.get(c)!; const U = ents.length;
    const a = Array.from({ length: U }, (_, i) => (i * 7) % U);
    const b = Array.from({ length: U }, (_, i) => (i * 13 + 5) % U);
    const full = reciprocalRankFusion([a, b], { k: K, tieBreak });
    for (const t of [0, 1, 5, U - 1]) if (plainRank(full, t) !== fusedRank([a, b], t, U)) bad += 1;
  }
  console.log(`fusedRank vs reciprocalRankFusion agreement check: ${bad === 0 ? 'OK' : `${bad} MISMATCHES`}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
