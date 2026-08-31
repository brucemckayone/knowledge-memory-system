/**
 * Follow-up measurements demanded by the blind adversarial review of
 * `05-results-description-aligned-and-hybrid.md`.
 *
 * Every number the corrected results document cites is computed HERE, from the
 * embedding cache the original run wrote, so the corrected doc rests on this
 * repo's own reproducible harness rather than on a reviewer's scratch scripts.
 * The original harness (desc-aligned-recall.ts) is left untouched: it is what
 * produced the pre-registered headline and must stay auditable against the frozen
 * text.
 *
 * What this computes, and why each was needed:
 *
 *  1. EXHAUSTIVE mean pairwise cosine. The original mechanism figure sampled
 *     every 7th entity and was reported to 4 decimal places as though it were the
 *     population value, and its rhetorical point ("almost identical in both
 *     corpora", 0.5155 vs 0.5156) turned out to be a sampling coincidence. This
 *     settles it all-pairs.
 *  2. Discriminability that actually bears on ranking: the target's z-score
 *     within its own candidate set. Mean pairwise cosine is first-order
 *     irrelevant to a ranking, because cosine ranking is invariant to a
 *     similarity offset shared by all candidates.
 *  3. Hub concentration: distinct entities ever appearing in a top-10, the top-20
 *     hubs' share of slots, and entropy. The claimed "everything reads as a
 *     generic sentence" mechanism predicts MORE concentration.
 *  4. Per-corpus split — a doc 02 pre-registered secondary that was omitted.
 *  5. Deeper cutoffs (R@20/50/100/200) and mean/median rank.
 *  6. Verbatim-name rate, and the headline split on it — the largest confound in
 *     the task design.
 *  7. BM25 over NAME-ONLY text, and the fusion configuration a production hybrid
 *     would actually ship (dense-over-names + BM25-over-names).
 *  8. Cluster bootstraps (by entity, by query document), because the
 *     pre-registered pair resampling is anti-conservative when 300 pairs come
 *     from 155 entities and 149 documents.
 *  9. The same-epoch guard breach: the held-out guard drops only the first
 *     attributing DOCUMENT, but descriptions are authored per 10-document EPOCH.
 * 10. A description-only arm, which separates "descriptions are bad signal" from
 *     "appending a description dilutes the name".
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     NODE_ENV=test npx tsx src/test/tools/desc-aligned-followups.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { rawQuery } from '../../db/raw.js';
import { ml } from '../../services/ml-client.js';
import { entityEmbedTextFor } from '../../services/embed-text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARC = join(HERE, '../../../../docs/architecture/cross-corpus-audit/multihop-artifacts');
const CORPORA_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');
const CORPORA = ['dal-nlp', 'dal-cv'] as const;
const DOC_FILE: Record<string, string> = { 'dal-nlp': 'corpus-A.json', 'dal-cv': 'corpus-B.json' };
const EPOCH_SIZE = 10; // corpus-graph-ingest.ts --batch default

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
function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function tokenise(t: string): string[] {
  return t.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 0);
}

// --- BM25, identical to the original harness ------------------------------
const K1 = 1.2;
const B = 0.75;
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
      out[d] = out[d]! + idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (idx.docLen[d]! / idx.avgLen))));
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

/** Paired bootstrap over UNITS (indices grouped by a cluster key). Passing each
 *  pair as its own cluster reproduces the pre-registered pair bootstrap. */
function clusteredBootstrap(
  a: number[], b: number[], clusterOf: string[], resamples = 10_000, seed = 20260831,
): { delta: number; lo: number; hi: number } {
  const byCluster = new Map<string, number[]>();
  clusterOf.forEach((c, i) => {
    const l = byCluster.get(c) ?? [];
    l.push(i);
    byCluster.set(c, l);
  });
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

interface Doc { id: string; title: string; abstract: string }
interface Ent { id: string; name: string; description: string | null }

async function main(): Promise<void> {
  const cache = JSON.parse(readFileSync(join(OUT, 'embed-cache.json'), 'utf8')) as Record<string, number[]>;
  console.log(`embed cache: ${Object.keys(cache).length} vectors`);

  // The original run embedded only the 'name' and 'name_description' texts, so
  // every 'description'-only lookup missed. Left unhandled that produced an
  // exactly-0.0000 arm - a silent no-op dressed as a finding. Embed what is
  // missing, and FAIL LOUD rather than degrade if a vector cannot be obtained.
  const normalise = (v: number[]): number[] => {
    let m = 0;
    for (const x of v) m += x * x;
    m = Math.sqrt(m);
    return m === 0 ? v.slice() : v.map((x) => x / m);
  };
  const needed = new Set<string>();
  for (const c of CORPORA) {
    const es = await rawQuery<Ent>(sql`
      SELECT id::text AS id, canonical_name AS name, description FROM public.entities
      WHERE corpus_id = ${c} ORDER BY id`);
    for (const e of es) needed.add(entityEmbedTextFor(e.name, e.description, 'description'));
  }
  const missing = [...needed].filter((t) => !cache[t]);
  if (missing.length > 0) {
    console.log(`embedding ${missing.length} description-only texts the first run never embedded`);
    let done = 0;
    for (const t of missing) {
      const { vector } = await ml.embed(t);
      if (!vector || vector.length === 0) throw new Error(`empty embedding for description text: ${t.slice(0, 60)}`);
      cache[t] = normalise(vector);
      done += 1;
      if (done % 500 === 0) console.log(`   ${done}/${missing.length}`);
    }
    writeFileSync(join(OUT, 'embed-cache.json'), JSON.stringify(cache));
  }
  console.log('');

  const report: Record<string, unknown> = {};

  // ================= 1. EXHAUSTIVE mean pairwise cosine =================
  console.log('=== 1. mean pairwise cosine, ALL PAIRS (was sampled every 7th) ===');
  const pairwise: Record<string, unknown> = {};
  for (const c of CORPORA) {
    const ents = await rawQuery<Ent>(sql`
      SELECT id::text AS id, canonical_name AS name, description FROM public.entities
      WHERE corpus_id = ${c} ORDER BY id`);
    const nv = ents.map((e) => cache[entityEmbedTextFor(e.name, e.description, 'name')]).filter(Boolean) as number[][];
    const dv = ents.map((e) => cache[entityEmbedTextFor(e.name, e.description, 'name_description')]).filter(Boolean) as number[][];
    const allPairs = (vs: number[][]): { m: number; sd: number; n: number } => {
      let s = 0; let n = 0;
      const vals: number[] = [];
      for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
        const v = dot(vs[i]!, vs[j]!); s += v; n += 1; vals.push(v);
      }
      const m = n ? s / n : NaN;
      const sd = Math.sqrt(mean(vals.map((v) => (v - m) ** 2)));
      return { m, sd, n };
    };
    const pn = allPairs(nv); const pd = allPairs(dv);
    console.log(`${c}: name ${pn.m.toFixed(4)} (sd ${pn.sd.toFixed(4)}) | name+desc ${pd.m.toFixed(4)} (sd ${pd.sd.toFixed(4)}) | ${pn.n} pairs`);
    pairwise[c] = { nameMean: pn.m, nameSd: pn.sd, descMean: pd.m, descSd: pd.sd, pairs: pn.n };
  }
  report.pairwiseExhaustive = pairwise;

  // ================= build the query set (same rules as the harness) =====
  const docsById = new Map<string, Doc>();
  const entsByCorpus = new Map<string, Ent[]>();
  const pairs: Array<{ entityId: string; docId: string; corpusId: string; sameEpoch: boolean }> = [];
  for (const c of CORPORA) {
    const docs: Doc[] = JSON.parse(readFileSync(join(CORPORA_DIR, DOC_FILE[c]!), 'utf8'));
    for (const d of docs) docsById.set(d.id, d);
    const attr = JSON.parse(readFileSync(join(ARC, `attribution-${c}.json`), 'utf8')) as { paperToEntities: Record<string, string[]> };
    const order: string[] = JSON.parse(readFileSync(join(ARC, `ingest-ledger-${c}.json`), 'utf8'));
    const pos = new Map(order.map((id, i) => [id, i]));
    const e2p = new Map<string, string[]>();
    for (const [paper, ents] of Object.entries(attr.paperToEntities)) {
      for (const e of ents) { const l = e2p.get(e) ?? []; l.push(paper); e2p.set(e, l); }
    }
    for (const [entityId, ps] of e2p) {
      const uniq = [...new Set(ps)].filter((p) => docsById.has(p) && pos.has(p));
      if (uniq.length < 2) continue;
      uniq.sort((a, b) => pos.get(a)! - pos.get(b)!);
      const mintEpoch = Math.floor(pos.get(uniq[0]!)! / EPOCH_SIZE);
      for (const docId of uniq.slice(1)) {
        pairs.push({ entityId, docId, corpusId: c, sameEpoch: Math.floor(pos.get(docId)! / EPOCH_SIZE) === mintEpoch });
      }
    }
    entsByCorpus.set(c, await rawQuery<Ent>(sql`
      SELECT id::text AS id, canonical_name AS name, description FROM public.entities
      WHERE corpus_id = ${c} ORDER BY id`));
  }
  console.log(`\nquery pairs: ${pairs.length}\n`);

  // ================= score every arm, keeping RANKS =====================
  const ARMS = ['NAME', 'DESC', 'DESCONLY', 'BM25c', 'BM25n', 'RRF_desc_bm25c', 'RRF_name_bm25n'] as const;
  const rank: Record<string, number[]> = {};
  for (const a of ARMS) rank[a] = [];
  const verbatim: boolean[] = [];
  const corpusOf: string[] = [];
  const entityOf: string[] = [];
  const docOf: string[] = [];
  const sameEpochOf: boolean[] = [];
  const zName: number[] = [];
  const zDesc: number[] = [];
  const top10Name: string[][] = [];
  const top10Desc: string[][] = [];

  for (const c of CORPORA) {
    const ents = entsByCorpus.get(c)!;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const vName = ents.map((e) => cache[entityEmbedTextFor(e.name, e.description, 'name')]!);
    const vDesc = ents.map((e) => cache[entityEmbedTextFor(e.name, e.description, 'name_description')]!);
    const vDescOnly = ents.map((e) => {
      const v = cache[entityEmbedTextFor(e.name, e.description, 'description')];
      if (!v) throw new Error(`missing description-only vector for entity ${e.id}`);
      return v;
    });
    const bmC = buildBm25(ents.map((e) => entityEmbedTextFor(e.name, e.description, 'name_description')));
    const bmN = buildBm25(ents.map((e) => e.name));

    for (const p of pairs.filter((q) => q.corpusId === c)) {
      const t = idxOf.get(p.entityId);
      if (t === undefined) continue;
      const d = docsById.get(p.docId)!;
      const qtext = `${d.title} ${d.abstract}`;
      const qv = cache[qtext]!;

      const sName = vName.map((v) => dot(qv, v));
      const sDesc = vDesc.map((v) => dot(qv, v));
      const rName = rankByScore(sName);
      const rDesc = rankByScore(sDesc);
      const rBmC = rankByScore(bm25Scores(bmC, qtext), 0);
      const rBmN = rankByScore(bm25Scores(bmN, qtext), 0);
      const rDescOnly = rankByScore(vDescOnly.map((v) => dot(qv, v)));

      const pos = (r: number[]): number => { const i = r.indexOf(t); return i < 0 ? Infinity : i + 1; };
      rank['NAME']!.push(pos(rName));
      rank['DESC']!.push(pos(rDesc));
      rank['DESCONLY']!.push(pos(rDescOnly));
      rank['BM25c']!.push(pos(rBmC));
      rank['BM25n']!.push(pos(rBmN));
      rank['RRF_desc_bm25c']!.push(pos(rankByScore(rrfRetrievedSet([rDesc, rBmC], 60, ents.length), 0)));
      rank['RRF_name_bm25n']!.push(pos(rankByScore(rrfRetrievedSet([rName, rBmN], 60, ents.length), 0)));

      // z-score of the target's similarity within its candidate set
      const z = (s: number[]): number => {
        const m = mean(s); const sd = Math.sqrt(mean(s.map((x) => (x - m) ** 2)));
        return sd ? (s[t]! - m) / sd : 0;
      };
      zName.push(z(sName)); zDesc.push(z(sDesc));
      // Key by corpus so per-corpus indices cannot collide when pooled.
      top10Name.push(rName.slice(0, 10).map((i) => `${c}#${i}`));
      top10Desc.push(rDesc.slice(0, 10).map((i) => `${c}#${i}`));

      verbatim.push(qtext.toLowerCase().includes(ents[t]!.name.toLowerCase()));
      corpusOf.push(c); entityOf.push(p.entityId); docOf.push(p.docId); sameEpochOf.push(p.sameEpoch);
    }
  }

  const n = rank['NAME']!.length;
  const hitAt = (arm: string, k: number): number[] => rank[arm]!.map((r) => (r <= k ? 1 : 0));

  // ================= 2/3. mechanism checks ==============================
  console.log('=== 2. discriminability that bears on ranking: target z-score in its candidate set ===');
  console.log(`  NAME mean z ${mean(zName).toFixed(3)} median ${median(zName).toFixed(3)}`);
  console.log(`  DESC mean z ${mean(zDesc).toFixed(3)} median ${median(zDesc).toFixed(3)}`);
  console.log('  (higher = target stands further above the crowd; the "less discriminative" story predicts DESC LOWER)');
  report.targetZ = { nameMean: mean(zName), descMean: mean(zDesc), nameMedian: median(zName), descMedian: median(zDesc) };

  console.log('\n=== 3. hub concentration across the top-10s ===');
  const hubStats = (tops: string[][]): { distinct: number; top20Share: number; entropy: number } => {
    const cnt = new Map<string, number>();
    let slots = 0;
    for (const t of tops) for (const e of t) { cnt.set(e, (cnt.get(e) ?? 0) + 1); slots += 1; }
    const sorted = [...cnt.values()].sort((a, b) => b - a);
    const top20 = sorted.slice(0, 20).reduce((s, x) => s + x, 0);
    const entropy = -[...cnt.values()].reduce((s, v) => { const p = v / slots; return s + p * Math.log2(p); }, 0);
    return { distinct: cnt.size, top20Share: top20 / slots, entropy };
  };
  const hName = hubStats(top10Name); const hDesc = hubStats(top10Desc);
  console.log(`  NAME distinct ${hName.distinct}  top-20 share ${(hName.top20Share * 100).toFixed(1)}%  entropy ${hName.entropy.toFixed(3)}`);
  console.log(`  DESC distinct ${hDesc.distinct}  top-20 share ${(hDesc.top20Share * 100).toFixed(1)}%  entropy ${hDesc.entropy.toFixed(3)}`);
  console.log('  ("everything reads as a generic sentence" predicts DESC MORE concentrated)');
  report.hubs = { name: hName, desc: hDesc };

  // ================= 4. per-corpus split ================================
  console.log('\n=== 4. PER-CORPUS SPLIT (pre-registered doc 02 secondary, omitted from the first write-up) ===');
  const perCorpus: Record<string, unknown> = {};
  for (const c of CORPORA) {
    const idx = corpusOf.map((x, i) => (x === c ? i : -1)).filter((i) => i >= 0);
    const a = idx.map((i) => hitAt('DESC', 10)[i]!);
    const b = idx.map((i) => hitAt('NAME', 10)[i]!);
    const r = clusteredBootstrap(a, b, idx.map((i) => String(i)));
    console.log(`  ${c}: n=${idx.length} NAME ${mean(b).toFixed(4)} DESC ${mean(a).toFixed(4)} delta ${ciStr(r)}`);
    perCorpus[c] = { n: idx.length, name: mean(b), desc: mean(a), ...r };
  }
  report.perCorpus = perCorpus;

  // ================= 5. deeper cutoffs + rank ===========================
  console.log('\n=== 5. deeper cutoffs, and mean/median rank ===');
  const cutoffs: Record<string, unknown> = {};
  for (const k of [1, 5, 10, 20, 50, 100, 200]) {
    const r = clusteredBootstrap(hitAt('DESC', k), hitAt('NAME', k), pairs.map((_, i) => String(i)));
    console.log(`  R@${String(k).padEnd(3)} NAME ${mean(hitAt('NAME', k)).toFixed(4)} DESC ${mean(hitAt('DESC', k)).toFixed(4)}  delta ${ciStr(r)}`);
    cutoffs[k] = { name: mean(hitAt('NAME', k)), desc: mean(hitAt('DESC', k)), ...r };
  }
  const finite = (xs: number[]): number[] => xs.filter((x) => Number.isFinite(x));
  console.log(`  mean rank   NAME ${mean(finite(rank['NAME']!)).toFixed(1)}  DESC ${mean(finite(rank['DESC']!)).toFixed(1)}`);
  console.log(`  median rank NAME ${median(finite(rank['NAME']!)).toFixed(1)}  DESC ${median(finite(rank['DESC']!)).toFixed(1)}`);
  report.cutoffs = cutoffs;
  report.rankStats = { nameMean: mean(finite(rank['NAME']!)), descMean: mean(finite(rank['DESC']!)),
    nameMedian: median(finite(rank['NAME']!)), descMedian: median(finite(rank['DESC']!)) };

  // ================= 6. verbatim-name confound ==========================
  console.log('\n=== 6. VERBATIM-NAME CONFOUND (largest confound in the task design) ===');
  const vb = verbatim.filter(Boolean).length;
  console.log(`  entity name appears verbatim in the query text: ${vb}/${n} = ${(vb / n * 100).toFixed(1)}%`);
  const vbSplit: Record<string, unknown> = {};
  for (const want of [true, false]) {
    const idx = verbatim.map((v, i) => (v === want ? i : -1)).filter((i) => i >= 0);
    const a = idx.map((i) => hitAt('DESC', 10)[i]!);
    const b = idx.map((i) => hitAt('NAME', 10)[i]!);
    const r = clusteredBootstrap(a, b, idx.map((i) => String(i)));
    console.log(`  ${want ? 'verbatim    ' : 'NOT verbatim'}: n=${idx.length} NAME ${mean(b).toFixed(4)} DESC ${mean(a).toFixed(4)} delta ${ciStr(r)}`);
    vbSplit[String(want)] = { n: idx.length, name: mean(b), desc: mean(a), ...r };
  }
  report.verbatim = { rate: vb / n, split: vbSplit };

  // ================= 7. lexical-only control + shippable fusion =========
  console.log('\n=== 7. arms the first run omitted ===');
  for (const arm of ['BM25c', 'BM25n', 'DESCONLY', 'RRF_desc_bm25c', 'RRF_name_bm25n'] as const) {
    console.log(`  ${arm.padEnd(15)} R@10 ${mean(hitAt(arm, 10)).toFixed(4)}`);
  }
  const bmDil = clusteredBootstrap(hitAt('BM25n', 10), hitAt('BM25c', 10), pairs.map((_, i) => String(i)));
  console.log(`  BM25-over-names MINUS BM25-over-composite: ${ciStr(bmDil)}`);
  console.log('    (a purely lexical dilution check - no neural encoder involved)');
  const bmVec = clusteredBootstrap(hitAt('BM25c', 10), hitAt('DESC', 10), pairs.map((_, i) => String(i)));
  console.log(`  BM25 MINUS VEC (doc 04 required secondary, omitted): ${ciStr(bmVec)}`);
  const shipFusion = clusteredBootstrap(hitAt('RRF_name_bm25n', 10), hitAt('NAME', 10), pairs.map((_, i) => String(i)));
  console.log(`  shippable fusion (dense-names + BM25-names) MINUS ARM-NAME: ${ciStr(shipFusion)}`);
  report.omittedArms = {
    bm25Composite: mean(hitAt('BM25c', 10)), bm25Names: mean(hitAt('BM25n', 10)),
    descriptionOnly: mean(hitAt('DESCONLY', 10)),
    rrfDescBm25c: mean(hitAt('RRF_desc_bm25c', 10)), rrfNameBm25n: mean(hitAt('RRF_name_bm25n', 10)),
    bm25Dilution: bmDil, bm25MinusVec: bmVec, shippableFusionMinusName: shipFusion,
  };

  // ================= 8. cluster bootstraps ==============================
  console.log('\n=== 8. cluster bootstraps (pair resampling is anti-conservative here) ===');
  const d10 = hitAt('DESC', 10); const n10 = hitAt('NAME', 10);
  const byPair = clusteredBootstrap(d10, n10, pairs.map((_, i) => String(i)));
  const byEnt = clusteredBootstrap(d10, n10, entityOf);
  const byDoc = clusteredBootstrap(d10, n10, docOf);
  console.log(`  by query pair (pre-registered): ${ciStr(byPair)}`);
  console.log(`  by entity   (${new Set(entityOf).size} clusters): ${ciStr(byEnt)}`);
  console.log(`  by document (${new Set(docOf).size} clusters): ${ciStr(byDoc)}`);
  report.bootstraps = { byPair, byEntity: byEnt, byDocument: byDoc,
    entities: new Set(entityOf).size, documents: new Set(docOf).size };

  // ================= 9. same-epoch guard breach =========================
  console.log('\n=== 9. same-epoch guard breach (guard drops the first DOCUMENT; descriptions are authored per EPOCH) ===');
  const se = sameEpochOf.filter(Boolean).length;
  console.log(`  same-epoch pairs: ${se}/${n} = ${(se / n * 100).toFixed(1)}%`);
  const diffIdx = sameEpochOf.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  const rDiff = clusteredBootstrap(diffIdx.map((i) => d10[i]!), diffIdx.map((i) => n10[i]!), diffIdx.map((i) => String(i)));
  console.log(`  strictly different-epoch only (n=${diffIdx.length}): ${ciStr(rDiff)}`);
  report.sameEpoch = { rate: se / n, strictDifferentEpoch: { n: diffIdx.length, ...rDiff } };

  writeFileSync(join(OUT, 'desc-aligned-followups.json'), JSON.stringify(report, null, 2));
  console.log(`\nartifact: ${join(OUT, 'desc-aligned-followups.json')}`);
  process.exit(0);
}
main();
