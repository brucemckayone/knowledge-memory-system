/**
 * Fact-level retrieval — retrieval experiment #3 (queue #4).
 * FROZEN pre-registration: docs/architecture/single-graph/13-prereg-fact-level-retrieval.md
 *
 * Ranks entities by their best-matching FACT (stored fact_embedding), vs by name
 * vector (ARM-NAME). Query vectors from the frozen embed cache; fact vectors from
 * the DB (stored RAW / non-unit-norm -> L2-normalised here). Held-out fact guard:
 * for query (e, d), every fact arm excludes facts sourced from d (factToPaper).
 * Exact cosine in-process (NOT HNSW), matching doc 05 / E0 / R1 / R2.
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/fact-level.ts
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
const REG_NAME_R10 = 0.20056497175141244;
const REG_N = 354;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function dot(a: number[], b: number[]): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; }
function norm(v: number[]): number { let m = 0; for (const x of v) m += x * x; return Math.sqrt(m); }
function normalise(v: number[]): number[] { const m = norm(v); return m === 0 ? v.slice() : v.map((x) => x / m); }
const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
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
function clusteredBootstrap(a: number[], b: number[], clusterOf: string[], resamples = 10_000, seed = 20260831): { delta: number; lo: number; hi: number } {
  const byCluster = new Map<string, number[]>();
  clusterOf.forEach((c, i) => { const l = byCluster.get(c) ?? []; l.push(i); byCluster.set(c, l); });
  const clusters = [...byCluster.values()];
  const delta = mean(a) - mean(b); const rnd = mulberry32(seed); const deltas: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sa = 0; let sb = 0; let nn = 0;
    for (let c = 0; c < clusters.length; c++) { const pick = clusters[Math.floor(rnd() * clusters.length)]!; for (const i of pick) { sa += a[i]!; sb += b[i]!; nn += 1; } }
    deltas.push(nn ? sa / nn - sb / nn : 0);
  }
  deltas.sort((x, y) => x - y);
  return { delta, lo: deltas[Math.floor(0.025 * resamples)]!, hi: deltas[Math.floor(0.975 * resamples) - 1]! };
}
const ciStr = (r: { delta: number; lo: number; hi: number }): string =>
  `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(4)} CI [${r.lo.toFixed(4)}, ${r.hi.toFixed(4)}]  ${r.lo > 0 ? 'ABOVE 0' : r.hi < 0 ? 'BELOW 0' : 'SPANS 0'}`;
function nameMatcher(name: string): RegExp {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`);
}
function strictRankOf(ranking: number[], t: number): number { const i = ranking.indexOf(t); return i < 0 ? Infinity : i + 1; }
function condensedRankOf(ranking: number[], t: number, relevant: Set<number>): number {
  const posT = ranking.indexOf(t); if (posT < 0) return Infinity;
  let above = 0; for (let r = 0; r < posT; r++) { const i = ranking[r]!; if (i === t) continue; if (relevant.has(i)) continue; above += 1; }
  return above + 1;
}
function parseVec(text: string): number[] {
  const inner = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  const out = inner.split(',').map(Number);
  return out;
}

interface Doc { id: string; title: string; abstract: string }
interface Ent { id: string; name: string; description: string | null }
interface FactRow { id: string; subj: string; obj: string; emb: string }

async function main(): Promise<void> {
  const cache = JSON.parse(readFileSync(join(OUT, 'embed-cache.json'), 'utf8')) as Record<string, number[]>;
  console.log(`embed cache: ${Object.keys(cache).length} vectors`);

  const docsById = new Map<string, Doc>();
  const entsByCorpus = new Map<string, Ent[]>();
  const attrByCorpus = new Map<string, Record<string, string[]>>();
  const factToPaperByCorpus = new Map<string, Record<string, string>>();
  const pairs: Array<{ entityId: string; docId: string; corpusId: string }> = [];
  for (const c of CORPORA) {
    const docs: Doc[] = JSON.parse(readFileSync(join(CORPORA_DIR, DOC_FILE[c]!), 'utf8'));
    for (const d of docs) docsById.set(d.id, d);
    const attrFull = JSON.parse(readFileSync(join(ARC, `attribution-${c}.json`), 'utf8')) as {
      paperToEntities: Record<string, string[]>; factToPaper: Record<string, string>;
    };
    attrByCorpus.set(c, attrFull.paperToEntities);
    factToPaperByCorpus.set(c, attrFull.factToPaper);
    const order: string[] = JSON.parse(readFileSync(join(ARC, `ingest-ledger-${c}.json`), 'utf8'));
    const pos = new Map(order.map((id, i) => [id, i]));
    const e2p = new Map<string, string[]>();
    for (const [paper, ents] of Object.entries(attrFull.paperToEntities)) for (const e of ents) { const l = e2p.get(e) ?? []; l.push(paper); e2p.set(e, l); }
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

  // Tier A/B for the condensed oracle
  const relevantByKey = new Map<string, Set<number>>();
  for (const c of CORPORA) {
    const ents = entsByCorpus.get(c)!;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const matchers = ents.map((e, i) => { const nm = (e.name ?? '').trim(); return nm.length < 3 ? null : { idx: i, re: nameMatcher(nm.toLowerCase()) }; });
    const attr = attrByCorpus.get(c)!;
    for (const p of pairs.filter((q) => q.corpusId === c)) {
      const key = `${c}#${p.docId}`; if (relevantByKey.has(key)) continue;
      const d = docsById.get(p.docId)!; const text = `${d.title} ${d.abstract}`.toLowerCase();
      const rel = new Set<number>();
      for (const eid of attr[p.docId] ?? []) { const i = idxOf.get(eid); if (i !== undefined) rel.add(i); }
      for (const m of matchers) { if (m && !rel.has(m.idx) && m.re.test(text)) rel.add(m.idx); }
      relevantByKey.set(key, rel);
    }
  }

  // Pull + normalise facts; build per-entity fact membership
  const factState = new Map<string, {
    vecs: number[][]; paper: string[]; entFacts: Map<number, number[]>;
  }>();
  let rawNormSum = 0; let rawNormCount = 0; let selfDotViol = 0; let dimViol = 0;
  for (const c of CORPORA) {
    const ents = entsByCorpus.get(c)!;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const rows = await rawQuery<FactRow>(sql`
      SELECT id::text AS id, subject_entity_id::text AS subj, object_entity_id::text AS obj, fact_embedding::text AS emb
      FROM public.facts WHERE corpus_id = ${c} AND expired_at IS NULL AND invalid_at IS NULL AND fact_embedding IS NOT NULL`);
    const f2p = factToPaperByCorpus.get(c)!;
    const vecs: number[][] = []; const paper: string[] = []; const entFacts = new Map<number, number[]>();
    for (const row of rows) {
      const raw = parseVec(row.emb);
      if (raw.length !== 768 || raw.some((x) => !Number.isFinite(x))) { dimViol += 1; continue; }
      rawNormSum += norm(raw); rawNormCount += 1;
      const nv = normalise(raw);
      if (Math.abs(dot(nv, nv) - 1) > 1e-6) selfDotViol += 1;
      const fi = vecs.length; vecs.push(nv); paper.push(f2p[row.id] ?? '');
      for (const eid of [row.subj, row.obj]) { const ei = idxOf.get(eid); if (ei !== undefined) { const l = entFacts.get(ei) ?? []; l.push(fi); entFacts.set(ei, l); } }
    }
    factState.set(c, { vecs, paper, entFacts });
    console.log(`${c}: ${rows.length} active embedded facts, ${entFacts.size}/${ents.length} entities with >=1 fact`);
  }

  // integrity / normalisation sanity (prereg §6)
  console.log('');
  console.log('=== integrity / normalisation sanity ===');
  console.log(`  fact vectors: dim/finite violations ${dimViol}; mean RAW norm ${(rawNormSum / Math.max(1, rawNormCount)).toFixed(3)} (expect != 1); post-normalise self-dot violations ${selfDotViol}`);
  if (dimViol > 0) { console.log('=== VOID: fact vector integrity failed ==='); process.exit(1); }
  if (Math.abs(rawNormSum / Math.max(1, rawNormCount) - 1) < 0.05) { console.log('=== WARNING: raw fact norms ~1, normalisation may be a no-op ==='); }
  if (selfDotViol > 0) { console.log('=== VOID: normalisation failed self-dot ==='); process.exit(1); }

  // Score arms
  const ARMS = ['NAME', 'FACTMAX', 'FACTMEAN', 'FACTNAME'] as const;
  const strictRank: Record<string, number[]> = {}; const condRank: Record<string, number[]> = {};
  for (const a of ARMS) { strictRank[a] = []; condRank[a] = []; }
  const corpusOf: string[] = []; const entityOf: string[] = []; const docOf: string[] = [];
  const factmaxEqName: number[] = [];
  let noEligibleFact = 0; // target has 0 facts after held-out exclusion
  let pairsWithExclusion = 0;
  const targetFactCount: number[] = []; const targetFactMaxHit: number[] = []; // degree diagnostic

  for (const c of CORPORA) {
    const ents = entsByCorpus.get(c)!;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const vName = ents.map((e) => cache[entityEmbedTextFor(e.name, e.description, 'name')]!);
    const fs = factState.get(c)!;

    for (const p of pairs.filter((q) => q.corpusId === c)) {
      const t = idxOf.get(p.entityId); if (t === undefined) continue;
      const d = docsById.get(p.docId)!; const qv = cache[`${d.title} ${d.abstract}`]!;
      const rel = relevantByKey.get(`${c}#${p.docId}`)!;

      // per-query fact scores
      const factScore = fs.vecs.map((v) => dot(qv, v));
      // aggregate to entities, excluding facts sourced from d
      const entMax = new Array<number>(ents.length).fill(-Infinity);
      const entSum = new Array<number>(ents.length).fill(0);
      const entCnt = new Array<number>(ents.length).fill(0);
      let excludedThisPair = 0;
      for (const [ei, factIdxs] of fs.entFacts) {
        for (const fi of factIdxs) {
          if (fs.paper[fi] === p.docId) { excludedThisPair += 1; continue; }
          const sc = factScore[fi]!;
          if (sc > entMax[ei]!) entMax[ei] = sc;
          entSum[ei] += sc; entCnt[ei] += 1;
        }
      }
      if (excludedThisPair > 0) pairsWithExclusion += 1;
      const entMean = entMax.map((_, i) => (entCnt[i]! > 0 ? entSum[i]! / entCnt[i]! : -Infinity));

      const rName = rankByScore(vName.map((v) => dot(qv, v)));
      const rFactMax = rankByScore(entMax, -Infinity);
      const rFactMean = rankByScore(entMean, -Infinity);
      const rFactName = rankByScore(rrfRetrievedSet([rName, rFactMax], 60, ents.length), 0);

      strictRank['NAME']!.push(strictRankOf(rName, t)); condRank['NAME']!.push(condensedRankOf(rName, t, rel));
      strictRank['FACTMAX']!.push(strictRankOf(rFactMax, t)); condRank['FACTMAX']!.push(condensedRankOf(rFactMax, t, rel));
      strictRank['FACTMEAN']!.push(strictRankOf(rFactMean, t)); condRank['FACTMEAN']!.push(condensedRankOf(rFactMean, t, rel));
      strictRank['FACTNAME']!.push(strictRankOf(rFactName, t)); condRank['FACTNAME']!.push(condensedRankOf(rFactName, t, rel));

      if (entCnt[t]! === 0) noEligibleFact += 1;
      targetFactCount.push(entCnt[t]!);
      targetFactMaxHit.push(strictRankOf(rFactMax, t) <= 10 ? 1 : 0);

      const fTop = new Set(rFactMax.slice(0, 10)); const nTop = new Set(rName.slice(0, 10));
      let same = fTop.size === nTop.size; if (same) for (const x of fTop) if (!nTop.has(x)) { same = false; break; }
      factmaxEqName.push(same ? 1 : 0);

      corpusOf.push(c); entityOf.push(p.entityId); docOf.push(p.docId);
    }
  }

  const n = strictRank['NAME']!.length;
  const hitStrict = (arm: string, k: number): number[] => strictRank[arm]!.map((r) => (r <= k ? 1 : 0));
  const hitCond = (arm: string, k: number): number[] => condRank[arm]!.map((r) => (r <= k ? 1 : 0));

  const nameR10 = mean(hitStrict('NAME', 10));
  console.log('');
  console.log('=== STRICT REGRESSION GATE ===');
  console.log(`  ARM-NAME strict R@10 = ${nameR10}  (target ${REG_NAME_R10});  n = ${n} (target ${REG_N})`);
  if (Math.abs(nameR10 - REG_NAME_R10) >= 1e-9 || n !== REG_N) { console.log('=== VOID: regression gate failed ==='); process.exit(1); }
  console.log('  GATE PASSED.');

  console.log('');
  console.log(`held-out fact guard: ${pairsWithExclusion}/${n} pairs excluded >=1 d-sourced fact`);
  console.log(`fact-arm retrievability ceiling: ${((n - noEligibleFact) / n * 100).toFixed(1)}% of targets have >=1 eligible fact (${noEligibleFact} unretrievable)`);
  const overlap = mean(factmaxEqName);
  console.log(`arm-identity degeneracy: FACTMAX top-10 == NAME top-10 for ${(overlap * 100).toFixed(1)}% of pairs` + (overlap > 0.95 ? '  >>> DEGENERATE' : ''));

  console.log('');
  console.log('| arm | strict R@10 | condensed R@10 |');
  console.log('|-----|-------------|----------------|');
  for (const a of ARMS) console.log(`| ${a.padEnd(8)} | ${mean(hitStrict(a, 10)).toFixed(4)} | ${mean(hitCond(a, 10)).toFixed(4)} |`);

  const pairKeys = pairs.map((_, i) => String(i));
  const report: Record<string, unknown> = {
    n, corpora: [...CORPORA], pairsWithExclusion, noEligibleFact, factmaxEqName: overlap,
    armsStrictR10: Object.fromEntries(ARMS.map((a) => [a, mean(hitStrict(a, 10))])),
    armsCondR10: Object.fromEntries(ARMS.map((a) => [a, mean(hitCond(a, 10))])),
  };

  console.log('');
  console.log('=== PRIMARY (strict): FACTMAX R@10 - ARM-NAME R@10 ===');
  const primary = {
    byPair: clusteredBootstrap(hitStrict('FACTMAX', 10), hitStrict('NAME', 10), pairKeys),
    byEntity: clusteredBootstrap(hitStrict('FACTMAX', 10), hitStrict('NAME', 10), entityOf),
    byDocument: clusteredBootstrap(hitStrict('FACTMAX', 10), hitStrict('NAME', 10), docOf),
  };
  console.log(`  byPair     ${ciStr(primary.byPair)}`);
  console.log(`  byEntity   ${ciStr(primary.byEntity)}`);
  console.log(`  byDocument ${ciStr(primary.byDocument)}`);
  report.primary = primary;

  console.log('');
  console.log('=== secondaries ===');
  // prereg §5 commits to cluster bootstraps by entity AND document for the
  // pre-registered analyses, not byPair alone. Compute all three for the
  // load-bearing secondaries (the pre-adversary run reported byPair only).
  const tri = (a: number[], b: number[]): { byPair: any; byEntity: any; byDocument: any } => ({
    byPair: clusteredBootstrap(a, b, pairKeys),
    byEntity: clusteredBootstrap(a, b, entityOf),
    byDocument: clusteredBootstrap(a, b, docOf),
  });
  const sec: Record<string, unknown> = {};
  sec.factmaxCond = tri(hitCond('FACTMAX', 10), hitCond('NAME', 10));
  console.log(`  FACTMAX - NAME (condensed):  pair ${ciStr((sec.factmaxCond as any).byPair)}`);
  sec.factmeanStrict = clusteredBootstrap(hitStrict('FACTMEAN', 10), hitStrict('NAME', 10), pairKeys);
  console.log(`  FACTMEAN - NAME (strict):    pair ${ciStr(sec.factmeanStrict as any)}`);
  sec.factnameStrict = tri(hitStrict('FACTNAME', 10), hitStrict('NAME', 10));
  console.log(`  FACTNAME(RRF) - NAME (strict):    pair ${ciStr((sec.factnameStrict as any).byPair)}`);
  console.log(`                                   entity ${ciStr((sec.factnameStrict as any).byEntity)}`);
  console.log(`                                   doc ${ciStr((sec.factnameStrict as any).byDocument)}`);
  sec.factnameCond = tri(hitCond('FACTNAME', 10), hitCond('NAME', 10));
  console.log(`  FACTNAME(RRF) - NAME (condensed): pair ${ciStr((sec.factnameCond as any).byPair)}`);
  console.log(`                                   entity ${ciStr((sec.factnameCond as any).byEntity)}`);
  console.log(`                                   doc ${ciStr((sec.factnameCond as any).byDocument)}`);
  report.secondaries = sec;

  console.log('');
  console.log('=== k-ladder (strict / condensed) ===');
  const perK: Record<string, unknown> = {};
  for (const k of [1, 5, 10, 20]) {
    const row = { nameStrict: mean(hitStrict('NAME', k)), factmaxStrict: mean(hitStrict('FACTMAX', k)), factmaxCond: mean(hitCond('FACTMAX', k)), nameCond: mean(hitCond('NAME', k)) };
    console.log(`  R@${String(k).padEnd(3)} NAME ${row.nameStrict.toFixed(3)}/${row.nameCond.toFixed(3)}  FACTMAX ${row.factmaxStrict.toFixed(3)}/${row.factmaxCond.toFixed(3)}  (strict/condensed)`);
    perK[k] = row;
  }
  report.perK = perK;

  console.log('');
  console.log('=== per corpus (FACTMAX - NAME, strict R@10) ===');
  const perCorpus: Record<string, unknown> = {};
  for (const c of CORPORA) {
    const idx = corpusOf.map((x, i) => (x === c ? i : -1)).filter((i) => i >= 0);
    const fh = idx.map((i) => hitStrict('FACTMAX', 10)[i]!); const nh = idx.map((i) => hitStrict('NAME', 10)[i]!);
    const r = clusteredBootstrap(fh, nh, idx.map((i) => String(i)));
    console.log(`  ${c}: n=${idx.length}  NAME ${mean(nh).toFixed(3)}  FACTMAX ${mean(fh).toFixed(3)}  ${ciStr(r)}`);
    perCorpus[c] = { n: idx.length, name: mean(nh), factmax: mean(fh), ...r };
  }
  report.perCorpus = perCorpus;

  // degree diagnostic (prereg §7 adversary task c)
  const hitCounts = targetFactCount.filter((_, i) => targetFactMaxHit[i] === 1);
  const missCounts = targetFactCount.filter((_, i) => targetFactMaxHit[i] === 0);
  console.log('');
  console.log(`degree diagnostic: target fact-count (eligible) — FACTMAX hits mean ${mean(hitCounts).toFixed(1)} vs misses mean ${mean(missCounts).toFixed(1)}`);
  report.degree = { hitMeanFactCount: mean(hitCounts), missMeanFactCount: mean(missCounts) };

  writeFileSync(join(OUT, 'fact-level-results.json'), JSON.stringify(report, null, 2));
  console.log(`\nartifact: ${join(OUT, 'fact-level-results.json')}`);
  process.exit(0);
}
main();
