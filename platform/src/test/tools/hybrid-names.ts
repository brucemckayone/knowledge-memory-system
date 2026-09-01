/**
 * Shippable hybrid — retrieval experiment #2 (nmemo-uhp.18).
 * FROZEN pre-registration: docs/architecture/single-graph/11-prereg-shippable-hybrid.md
 *
 * H = retrieved-set RRF over (dense-over-names, BM25-over-names). doc 05 measured
 * this configuration post-hoc at the best R@10 in the study (0.2260); this is its
 * pre-registered run. Reuses the committed cache and the identical cosine /
 * query-pair / oracle machinery of e0-oracle.ts + pool-rerank.ts.
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/hybrid-names.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { rawQuery } from '../../db/raw.js';
import { entityEmbedTextFor } from '../../services/embed-text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARC = join(HERE, '../../../../docs/architecture/cross-corpus-audit/multihop-artifacts');
const CORPORA_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');
const CORPORA = ['dal-nlp', 'dal-cv'] as const;
const DOC_FILE: Record<string, string> = { 'dal-nlp': 'corpus-A.json', 'dal-cv': 'corpus-B.json' };
const K_VALUES = [10, 30, 60, 100] as const;
const HEADLINE_K = 60;

const REG_NAME_R10 = 0.20056497175141244;
const REG_BM25N_R10 = 0.18926553672316385;
const REG_N = 354;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
function tokenise(t: string): string[] {
  return t.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 0);
}
function buildBm25(docs: string[]) {
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
function bm25Scores(idx: ReturnType<typeof buildBm25>, query: string): number[] {
  const out = new Array<number>(idx.n).fill(0);
  for (const q of new Set(tokenise(query))) {
    const dfq = idx.df.get(q);
    if (!dfq) continue;
    const idf = Math.log(1 + (idx.n - dfq + 0.5) / (dfq + 0.5));
    for (let d = 0; d < idx.n; d++) {
      const f = idx.tf[d]!.get(q);
      if (!f) continue;
      out[d] = out[d]! + idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (idx.docLen[d]! / idx.avgLen))));
    }
  }
  return out;
}
function rankByScore(scores: number[], minScore = -Infinity): number[] {
  const idx = scores.map((_, i) => i).filter((i) => scores[i]! > minScore);
  idx.sort((a, b) => (scores[b]! - scores[a]!) || (a - b));
  return idx;
}
function rrfRetrievedSet(rankings: number[][], K: number, universe: number): number[] {
  const s = new Array<number>(universe).fill(0);
  for (const r of rankings) for (let i = 0; i < r.length; i++) s[r[i]!] = s[r[i]!]! + 1 / (K + i + 1);
  return s;
}
function rrfFullRanking(rankings: number[][], K: number, universe: number): number[] {
  const s = new Array<number>(universe).fill(0);
  for (const r of rankings) {
    const rankOf = new Array<number>(universe).fill(r.length);
    for (let i = 0; i < r.length; i++) rankOf[r[i]!] = i;
    for (let u = 0; u < universe; u++) s[u] = s[u]! + 1 / (K + rankOf[u]! + 1);
  }
  return s;
}
function clusteredBootstrap(
  a: number[], b: number[], clusterOf: string[], resamples = 10_000, seed = 20260831,
): { delta: number; lo: number; hi: number } {
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
const ciStr = (r: { delta: number; lo: number; hi: number }): string =>
  `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(4)} CI [${r.lo.toFixed(4)}, ${r.hi.toFixed(4)}]` +
  `  ${r.lo > 0 ? 'ABOVE 0' : r.hi < 0 ? 'BELOW 0' : 'SPANS 0'}`;
function nameMatcher(name: string): RegExp {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`);
}
function strictRankOf(ranking: number[], t: number): number {
  const i = ranking.indexOf(t);
  return i < 0 ? Infinity : i + 1;
}
function condensedRankOf(ranking: number[], t: number, relevant: Set<number>): number {
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

interface Doc { id: string; title: string; abstract: string }
interface Ent { id: string; name: string; description: string | null }

async function main(): Promise<void> {
  const cache = JSON.parse(readFileSync(join(OUT, 'embed-cache.json'), 'utf8')) as Record<string, number[]>;
  console.log(`embed cache: ${Object.keys(cache).length} vectors`);

  const docsById = new Map<string, Doc>();
  const entsByCorpus = new Map<string, Ent[]>();
  const attrByCorpus = new Map<string, Record<string, string[]>>();
  const pairs: Array<{ entityId: string; docId: string; corpusId: string }> = [];
  for (const c of CORPORA) {
    const docs: Doc[] = JSON.parse(readFileSync(join(CORPORA_DIR, DOC_FILE[c]!), 'utf8'));
    for (const d of docs) docsById.set(d.id, d);
    const attr = (JSON.parse(readFileSync(join(ARC, `attribution-${c}.json`), 'utf8')) as {
      paperToEntities: Record<string, string[]>;
    }).paperToEntities;
    attrByCorpus.set(c, attr);
    const order: string[] = JSON.parse(readFileSync(join(ARC, `ingest-ledger-${c}.json`), 'utf8'));
    const pos = new Map(order.map((id, i) => [id, i]));
    const e2p = new Map<string, string[]>();
    for (const [paper, ents] of Object.entries(attr)) for (const e of ents) {
      const l = e2p.get(e) ?? []; l.push(paper); e2p.set(e, l);
    }
    for (const [entityId, ps] of e2p) {
      const uniq = [...new Set(ps)].filter((p) => docsById.has(p) && pos.has(p));
      if (uniq.length < 2) continue;
      uniq.sort((a, b) => pos.get(a)! - pos.get(b)!);
      for (const docId of uniq.slice(1)) pairs.push({ entityId, docId, corpusId: c });
    }
    entsByCorpus.set(c, await rawQuery<Ent>(sql`
      SELECT id::text AS id, canonical_name AS name, description FROM public.entities
      WHERE corpus_id = ${c} ORDER BY id`));
  }
  console.log(`query pairs: ${pairs.length} (target ${REG_N})`);

  // Tier A / Tier B (condensed oracle)
  const relevantByKey = new Map<string, Set<number>>();
  for (const c of CORPORA) {
    const ents = entsByCorpus.get(c)!;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const matchers = ents.map((e, i) => {
      const nm = (e.name ?? '').trim();
      return nm.length < 3 ? null : { idx: i, re: nameMatcher(nm.toLowerCase()) };
    });
    const attr = attrByCorpus.get(c)!;
    for (const p of pairs.filter((q) => q.corpusId === c)) {
      const key = `${c}#${p.docId}`;
      if (relevantByKey.has(key)) continue;
      const d = docsById.get(p.docId)!;
      const text = `${d.title} ${d.abstract}`.toLowerCase();
      const rel = new Set<number>();
      for (const eid of attr[p.docId] ?? []) { const i = idxOf.get(eid); if (i !== undefined) rel.add(i); }
      for (const m of matchers) { if (m && !rel.has(m.idx) && m.re.test(text)) rel.add(m.idx); }
      relevantByKey.set(key, rel);
    }
  }

  const ARMS = ['NAME', 'BM25n', ...K_VALUES.map((k) => `H${k}`), 'HFULL60'] as const;
  const strictRank: Record<string, number[]> = {};
  const condRank: Record<string, number[]> = {};
  for (const a of ARMS) { strictRank[a] = []; condRank[a] = []; }
  const corpusOf: string[] = []; const entityOf: string[] = []; const docOf: string[] = [];
  const hEqName: number[] = [];
  const compJaccard: number[] = [];

  for (const c of CORPORA) {
    const ents = entsByCorpus.get(c)!;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const vName = ents.map((e) => cache[entityEmbedTextFor(e.name, e.description, 'name')]!);
    const bmN = buildBm25(ents.map((e) => e.name));

    for (const p of pairs.filter((q) => q.corpusId === c)) {
      const t = idxOf.get(p.entityId);
      if (t === undefined) continue;
      const d = docsById.get(p.docId)!;
      const qtext = `${d.title} ${d.abstract}`;
      const qv = cache[qtext]!;
      const rel = relevantByKey.get(`${c}#${p.docId}`)!;

      const rName = rankByScore(vName.map((v) => dot(qv, v)));
      const rBmN = rankByScore(bm25Scores(bmN, qtext), 0);

      strictRank['NAME']!.push(strictRankOf(rName, t));
      condRank['NAME']!.push(condensedRankOf(rName, t, rel));
      strictRank['BM25n']!.push(strictRankOf(rBmN, t));
      condRank['BM25n']!.push(condensedRankOf(rBmN, t, rel));

      for (const K of K_VALUES) {
        const h = rankByScore(rrfRetrievedSet([rName, rBmN], K, ents.length), 0);
        strictRank[`H${K}`]!.push(strictRankOf(h, t));
        condRank[`H${K}`]!.push(condensedRankOf(h, t, rel));
      }
      const hf = rankByScore(rrfFullRanking([rName, rBmN], 60, ents.length));
      strictRank['HFULL60']!.push(strictRankOf(hf, t));
      condRank['HFULL60']!.push(condensedRankOf(hf, t, rel));

      const hTop = new Set(rankByScore(rrfRetrievedSet([rName, rBmN], HEADLINE_K, ents.length), 0).slice(0, 10));
      const nTop = new Set(rName.slice(0, 10));
      let same = hTop.size === nTop.size;
      if (same) for (const x of hTop) if (!nTop.has(x)) { same = false; break; }
      hEqName.push(same ? 1 : 0);

      // component disagreement: dense-names vs BM25-names top-10 Jaccard
      const dTop = new Set(rName.slice(0, 10));
      const bTop = new Set(rBmN.slice(0, 10));
      const inter = [...dTop].filter((x) => bTop.has(x)).length;
      const uni = new Set([...dTop, ...bTop]).size;
      compJaccard.push(uni ? inter / uni : 0);

      corpusOf.push(c); entityOf.push(p.entityId); docOf.push(p.docId);
    }
  }

  const n = strictRank['NAME']!.length;
  const hitStrict = (arm: string, k: number): number[] => strictRank[arm]!.map((r) => (r <= k ? 1 : 0));
  const hitCond = (arm: string, k: number): number[] => condRank[arm]!.map((r) => (r <= k ? 1 : 0));

  // regression gate
  const nameR10 = mean(hitStrict('NAME', 10));
  const bmR10 = mean(hitStrict('BM25n', 10));
  console.log('');
  console.log('=== STRICT REGRESSION GATE ===');
  console.log(`  ARM-NAME strict R@10 = ${nameR10}  (target ${REG_NAME_R10})`);
  console.log(`  BM25n    strict R@10 = ${bmR10}  (target ${REG_BM25N_R10})`);
  console.log(`  n = ${n}  (target ${REG_N})`);
  const gateFail: string[] = [];
  if (Math.abs(nameR10 - REG_NAME_R10) >= 1e-9) gateFail.push('ARM-NAME strict R@10 mismatch');
  if (Math.abs(bmR10 - REG_BM25N_R10) >= 1e-9) gateFail.push('BM25n strict R@10 mismatch');
  if (n !== REG_N) gateFail.push(`n=${n} != ${REG_N}`);
  if (gateFail.length) { console.log('=== VOID ==='); for (const g of gateFail) console.log(`  ${g}`); process.exit(1); }
  console.log('  GATE PASSED.');

  // degeneracy + component disagreement
  const overlap = mean(hEqName);
  const jac = mean(compJaccard);
  console.log('');
  console.log(`arm-identity degeneracy: H(K=${HEADLINE_K}) top-10 == NAME top-10 for ${(overlap * 100).toFixed(1)}% of pairs` +
    (overlap > 0.95 ? '  >>> DEGENERATE (prereg §6)' : ''));
  console.log(`component top-10 Jaccard (dense-names vs BM25-names): ${jac.toFixed(3)}` +
    (jac > 0.9 ? '  >>> UNINFORMATIVE (arms barely disagree)' : ''));

  // arm table
  console.log('');
  console.log('| arm | strict R@10 | condensed R@10 |');
  console.log('|-----|-------------|----------------|');
  for (const a of ARMS) console.log(`| ${a.padEnd(8)} | ${mean(hitStrict(a, 10)).toFixed(4)} | ${mean(hitCond(a, 10)).toFixed(4)} |`);

  const pairKeys = pairs.map((_, i) => String(i));
  const report: Record<string, unknown> = { n, corpora: [...CORPORA], degeneracyHEqName: overlap, componentJaccard: jac,
    armsStrictR10: Object.fromEntries(ARMS.map((a) => [a, mean(hitStrict(a, 10))])),
    armsCondR10: Object.fromEntries(ARMS.map((a) => [a, mean(hitCond(a, 10))])) };

  console.log('');
  console.log(`=== PRIMARY (strict): H(K=${HEADLINE_K}) R@10 - ARM-NAME R@10 ===`);
  const primary = {
    byPair: clusteredBootstrap(hitStrict(`H${HEADLINE_K}`, 10), hitStrict('NAME', 10), pairKeys),
    byEntity: clusteredBootstrap(hitStrict(`H${HEADLINE_K}`, 10), hitStrict('NAME', 10), entityOf),
    byDocument: clusteredBootstrap(hitStrict(`H${HEADLINE_K}`, 10), hitStrict('NAME', 10), docOf),
  };
  console.log(`  byPair     ${ciStr(primary.byPair)}`);
  console.log(`  byEntity   ${ciStr(primary.byEntity)}`);
  console.log(`  byDocument ${ciStr(primary.byDocument)}`);
  report.primary = primary;

  console.log('');
  console.log(`=== secondary (condensed): H(K=${HEADLINE_K}) R@10 - ARM-NAME R@10 ===`);
  const primaryCond = clusteredBootstrap(hitCond(`H${HEADLINE_K}`, 10), hitCond('NAME', 10), pairKeys);
  console.log(`  byPair     ${ciStr(primaryCond)}`);
  report.primaryCondensed = primaryCond;

  console.log('');
  console.log('=== secondaries ===');
  const sec: Record<string, unknown> = {};
  sec.hMinusBm25Strict = clusteredBootstrap(hitStrict(`H${HEADLINE_K}`, 10), hitStrict('BM25n', 10), pairKeys);
  console.log(`  H(${HEADLINE_K}) - BM25n (strict): ${ciStr(sec.hMinusBm25Strict as any)}`);
  console.log('  K-robustness (H(K) - NAME, strict):');
  for (const K of K_VALUES) {
    const s = clusteredBootstrap(hitStrict(`H${K}`, 10), hitStrict('NAME', 10), pairKeys);
    console.log(`    K=${String(K).padEnd(3)} H R@10 ${mean(hitStrict(`H${K}`, 10)).toFixed(4)}  ${ciStr(s)}`);
    sec[`H${K}_minus_name_strict`] = s;
  }
  const hfull = clusteredBootstrap(hitStrict('HFULL60', 10), hitStrict('NAME', 10), pairKeys);
  console.log(`  full-ranking RRF(60) - NAME (strict): H R@10 ${mean(hitStrict('HFULL60', 10)).toFixed(4)}  ${ciStr(hfull)}`);
  console.log(`  (retrieved-set H60 R@10 ${mean(hitStrict(`H${HEADLINE_K}`, 10)).toFixed(4)} vs full-ranking ${mean(hitStrict('HFULL60', 10)).toFixed(4)})`);
  sec.fullRanking60MinusName = hfull;
  report.secondaries = sec;

  console.log('');
  console.log(`=== per corpus (H K=${HEADLINE_K} - NAME, strict R@10) ===`);
  const perCorpus: Record<string, unknown> = {};
  for (const c of CORPORA) {
    const idx = corpusOf.map((x, i) => (x === c ? i : -1)).filter((i) => i >= 0);
    const hh = idx.map((i) => hitStrict(`H${HEADLINE_K}`, 10)[i]!);
    const nh = idx.map((i) => hitStrict('NAME', 10)[i]!);
    const r = clusteredBootstrap(hh, nh, idx.map((i) => String(i)));
    console.log(`  ${c}: n=${idx.length}  NAME ${mean(nh).toFixed(3)}  H ${mean(hh).toFixed(3)}  ${ciStr(r)}`);
    perCorpus[c] = { n: idx.length, name: mean(nh), h: mean(hh), ...r };
  }
  report.perCorpus = perCorpus;

  writeFileSync(join(OUT, 'hybrid-names-results.json'), JSON.stringify(report, null, 2));
  console.log(`\nartifact: ${join(OUT, 'hybrid-names-results.json')}`);
  process.exit(0);
}
main();
