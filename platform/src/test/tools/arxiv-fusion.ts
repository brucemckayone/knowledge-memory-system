/**
 * R4 — entity+fact fusion, confirmation on the independent arxiv extraction.
 * FROZEN pre-registration: docs/architecture/single-graph/15-prereg-fusion-confirmation.md
 *
 * Same machinery as fact-level.ts (R3), new substrate: arxiv-nlp / arxiv-cv (same
 * 294 papers as dal, a DIFFERENT extraction — different entities/facts/attribution,
 * descriptions NULL). Query vectors reused from the frozen embed cache (same
 * papers); arxiv entity NAME vectors embedded via Ollama into a SEPARATE cache so
 * the frozen doc-05 cache is untouched. Fact vectors from the DB (raw -> L2-norm).
 * All three bootstraps (pair/entity/doc) for the primary and co-primary — the R3
 * harness omitted cluster bootstraps for secondaries; that does not recur.
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/arxiv-fusion.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
const CORPORA = ['arxiv-nlp', 'arxiv-cv'] as const;
const DOC_FILE: Record<string, string> = { 'arxiv-nlp': 'corpus-A.json', 'arxiv-cv': 'corpus-B.json' };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function dot(a: number[], b: number[]): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; }
function nrm(v: number[]): number { let m = 0; for (const x of v) m += x * x; return Math.sqrt(m); }
function normalise(v: number[]): number[] { const m = nrm(v); return m === 0 ? v.slice() : v.map((x) => x / m); }
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
const triStr = (t: { byPair: any; byEntity: any; byDocument: any }): string =>
  `\n      pair ${ciStr(t.byPair)}\n      entity ${ciStr(t.byEntity)}\n      doc ${ciStr(t.byDocument)}` +
  `\n      => ALL-THREE-ABOVE-0: ${t.byPair.lo > 0 && t.byEntity.lo > 0 && t.byDocument.lo > 0 ? 'YES (DEMONSTRATED)' : 'NO'}`;
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
function parseVec(text: string): number[] { return text.trim().replace(/^\[/, '').replace(/\]$/, '').split(',').map(Number); }

interface Doc { id: string; title: string; abstract: string }
interface Ent { id: string; name: string; description: string | null }
interface FactRow { id: string; subj: string; obj: string; emb: string }

async function main(): Promise<void> {
  const qcache = JSON.parse(readFileSync(join(OUT, 'embed-cache.json'), 'utf8')) as Record<string, number[]>;
  const nameCachePath = join(OUT, 'arxiv-embed-cache.json');
  const nameCache: Record<string, number[]> = existsSync(nameCachePath) ? JSON.parse(readFileSync(nameCachePath, 'utf8')) : {};
  console.log(`query cache: ${Object.keys(qcache).length} vectors; arxiv name cache: ${Object.keys(nameCache).length}`);

  const docsById = new Map<string, Doc>();
  const entsByCorpus = new Map<string, Ent[]>();
  const attrByCorpus = new Map<string, Record<string, string[]>>();
  const f2pByCorpus = new Map<string, Record<string, string>>();
  const pairs: Array<{ entityId: string; docId: string; corpusId: string }> = [];
  for (const c of CORPORA) {
    const docs: Doc[] = JSON.parse(readFileSync(join(CORPORA_DIR, DOC_FILE[c]!), 'utf8'));
    for (const d of docs) docsById.set(d.id, d);
    const attrFull = JSON.parse(readFileSync(join(ARC, `attribution-${c}.json`), 'utf8')) as {
      paperToEntities: Record<string, string[]>; factToPaper: Record<string, string>;
    };
    attrByCorpus.set(c, attrFull.paperToEntities); f2pByCorpus.set(c, attrFull.factToPaper);
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
  console.log(`query pairs: ${pairs.length}`);
  if (pairs.length < 100) { console.log(`=== UNDERPOWERED: n=${pairs.length} < 100 ===`); process.exit(0); }

  // Embed arxiv entity NAME texts AND any query-doc texts not already in the
  // frozen cache (arxiv query docs are a different subset of the 294 papers than
  // dal's, so some `${title} ${abstract}` were never embedded). Misses only,
  // fail loud, never degrade to []. All go in the writable arxiv cache; the
  // frozen doc-05 cache is never modified.
  const needTexts = new Set<string>();
  for (const c of CORPORA) for (const e of entsByCorpus.get(c)!) needTexts.add(entityEmbedTextFor(e.name, e.description, 'name'));
  for (const p of pairs) { const d = docsById.get(p.docId)!; const qt = `${d.title} ${d.abstract}`; if (!qcache[qt]) needTexts.add(qt); }
  const missing = [...needTexts].filter((t) => !nameCache[t]);
  if (missing.length) {
    console.log(`embedding ${missing.length} arxiv entity-name texts (Ollama)`);
    let done = 0;
    for (const t of missing) {
      const { vector } = await ml.embed(t);
      if (!vector || vector.length === 0) throw new Error(`empty embedding for entity name: ${t.slice(0, 60)}`);
      nameCache[t] = normalise(vector); done += 1;
      if (done % 500 === 0) { writeFileSync(nameCachePath, JSON.stringify(nameCache)); console.log(`   ${done}/${missing.length}`); }
    }
    writeFileSync(nameCachePath, JSON.stringify(nameCache));
  }

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

  // Pull + normalise facts
  const factState = new Map<string, { vecs: number[][]; paper: string[]; entFacts: Map<number, number[]> }>();
  let rawNormSum = 0; let rawNormN = 0; let selfDotViol = 0; let dimViol = 0;
  for (const c of CORPORA) {
    const ents = entsByCorpus.get(c)!;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const rows = await rawQuery<FactRow>(sql`
      SELECT id::text AS id, subject_entity_id::text AS subj, object_entity_id::text AS obj, fact_embedding::text AS emb
      FROM public.facts WHERE corpus_id = ${c} AND expired_at IS NULL AND invalid_at IS NULL AND fact_embedding IS NOT NULL`);
    const f2p = f2pByCorpus.get(c)!;
    const vecs: number[][] = []; const paper: string[] = []; const entFacts = new Map<number, number[]>();
    for (const row of rows) {
      const raw = parseVec(row.emb);
      if (raw.length !== 768 || raw.some((x) => !Number.isFinite(x))) { dimViol += 1; continue; }
      rawNormSum += nrm(raw); rawNormN += 1;
      const nv = normalise(raw); if (Math.abs(dot(nv, nv) - 1) > 1e-6) selfDotViol += 1;
      const fi = vecs.length; vecs.push(nv); paper.push(f2p[row.id] ?? '');
      for (const eid of [row.subj, row.obj]) { const ei = idxOf.get(eid); if (ei !== undefined) { const l = entFacts.get(ei) ?? []; l.push(fi); entFacts.set(ei, l); } }
    }
    factState.set(c, { vecs, paper, entFacts });
    console.log(`${c}: ${rows.length} active embedded facts, ${entFacts.size}/${ents.length} entities with >=1 fact`);
  }
  console.log('');
  console.log(`integrity: dim violations ${dimViol}; mean RAW fact norm ${(rawNormSum / Math.max(1, rawNormN)).toFixed(3)} (expect !=1); self-dot violations ${selfDotViol}`);
  if (dimViol > 0 || selfDotViol > 0 || Math.abs(rawNormSum / Math.max(1, rawNormN) - 1) < 0.05) { console.log('=== VOID: fact integrity/normalisation ==='); process.exit(1); }

  const ARMS = ['NAME', 'FACTMAX', 'FACTNAME'] as const;
  const strictRank: Record<string, number[]> = {}; const condRank: Record<string, number[]> = {};
  for (const a of ARMS) { strictRank[a] = []; condRank[a] = []; }
  const corpusOf: string[] = []; const entityOf: string[] = []; const docOf: string[] = [];
  const factmaxEqName: number[] = []; let noEligible = 0; let pairsWithExclusion = 0;

  for (const c of CORPORA) {
    const ents = entsByCorpus.get(c)!;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const vName = ents.map((e) => nameCache[entityEmbedTextFor(e.name, e.description, 'name')]!);
    const fs = factState.get(c)!;
    for (const p of pairs.filter((q) => q.corpusId === c)) {
      const t = idxOf.get(p.entityId); if (t === undefined) continue;
      const d = docsById.get(p.docId)!; const qtext = `${d.title} ${d.abstract}`;
      const qv = qcache[qtext] ?? nameCache[qtext]; if (!qv) throw new Error(`missing query vector for ${p.docId}`);
      const rel = relevantByKey.get(`${c}#${p.docId}`)!;
      const factScore = fs.vecs.map((v) => dot(qv, v));
      const entMax = new Array<number>(ents.length).fill(-Infinity);
      let excl = 0;
      for (const [ei, fis] of fs.entFacts) for (const fi of fis) {
        if (fs.paper[fi] === p.docId) { excl += 1; continue; }
        if (factScore[fi]! > entMax[ei]!) entMax[ei] = factScore[fi]!;
      }
      if (excl > 0) pairsWithExclusion += 1;
      const rName = rankByScore(vName.map((v) => dot(qv, v)));
      const rFactMax = rankByScore(entMax, -Infinity);
      const rFactName = rankByScore(rrfRetrievedSet([rName, rFactMax], 60, ents.length), 0);
      strictRank['NAME']!.push(strictRankOf(rName, t)); condRank['NAME']!.push(condensedRankOf(rName, t, rel));
      strictRank['FACTMAX']!.push(strictRankOf(rFactMax, t)); condRank['FACTMAX']!.push(condensedRankOf(rFactMax, t, rel));
      strictRank['FACTNAME']!.push(strictRankOf(rFactName, t)); condRank['FACTNAME']!.push(condensedRankOf(rFactName, t, rel));
      if (entMax[t]! === -Infinity) noEligible += 1;
      const fTop = new Set(rFactMax.slice(0, 10)); const nTop = new Set(rName.slice(0, 10));
      let same = fTop.size === nTop.size; if (same) for (const x of fTop) if (!nTop.has(x)) { same = false; break; }
      factmaxEqName.push(same ? 1 : 0);
      corpusOf.push(c); entityOf.push(p.entityId); docOf.push(p.docId);
    }
  }

  const n = strictRank['NAME']!.length;
  const hitStrict = (arm: string, k: number): number[] => strictRank[arm]!.map((r) => (r <= k ? 1 : 0));
  const hitCond = (arm: string, k: number): number[] => condRank[arm]!.map((r) => (r <= k ? 1 : 0));
  const pairKeys = pairs.map((_, i) => String(i));
  const tri = (a: number[], b: number[]) => ({ byPair: clusteredBootstrap(a, b, pairKeys), byEntity: clusteredBootstrap(a, b, entityOf), byDocument: clusteredBootstrap(a, b, docOf) });

  console.log('');
  console.log(`n=${n}  held-out guard fired on ${pairsWithExclusion}/${n} pairs  retrievability ${((n - noEligible) / n * 100).toFixed(1)}%  FACTMAX==NAME top10 ${(mean(factmaxEqName) * 100).toFixed(1)}%`);
  console.log('');
  console.log('| arm | strict R@10 | condensed R@10 |');
  for (const a of ARMS) console.log(`| ${a.padEnd(8)} | ${mean(hitStrict(a, 10)).toFixed(4)} | ${mean(hitCond(a, 10)).toFixed(4)} |`);
  // non-trivial guard
  for (const a of ARMS) { const v = mean(hitStrict(a, 10)); if (v <= 0 || v >= 1) { console.log(`=== SUSPECT: ${a} strict R@10 = ${v} (0/1) — verify ===`); } }

  const report: Record<string, unknown> = {
    n, corpora: [...CORPORA], pairsWithExclusion, noEligible, factmaxEqName: mean(factmaxEqName),
    armsStrictR10: Object.fromEntries(ARMS.map((a) => [a, mean(hitStrict(a, 10))])),
    armsCondR10: Object.fromEntries(ARMS.map((a) => [a, mean(hitCond(a, 10))])),
  };

  console.log('');
  console.log('=== PRIMARY (strict): FACTNAME R@10 - ARM-NAME R@10 ===');
  const primaryStrict = tri(hitStrict('FACTNAME', 10), hitStrict('NAME', 10));
  console.log(`  ${triStr(primaryStrict)}`);
  report.primaryStrict = primaryStrict;

  console.log('');
  console.log('=== CO-PRIMARY (condensed): FACTNAME R@10 - ARM-NAME R@10 ===');
  const primaryCond = tri(hitCond('FACTNAME', 10), hitCond('NAME', 10));
  console.log(`  ${triStr(primaryCond)}`);
  report.primaryCondensed = primaryCond;

  console.log('');
  console.log('=== secondaries ===');
  const sec: Record<string, unknown> = {};
  sec.factmaxStrict = tri(hitStrict('FACTMAX', 10), hitStrict('NAME', 10));
  console.log(`  FACTMAX - NAME (strict): ${ciStr((sec.factmaxStrict as any).byPair)} (pair)`);
  // fusion complementarity decomposition (strict, R@10)
  const nameHits = hitStrict('NAME', 10).reduce((s, x) => s + x, 0);
  const factHits = hitStrict('FACTMAX', 10).reduce((s, x) => s + x, 0);
  const fuseHits = hitStrict('FACTNAME', 10).reduce((s, x) => s + x, 0);
  console.log(`  complementarity (strict hits): NAME ${nameHits}  FACTMAX ${factHits}  FACTNAME ${fuseHits}  (fusion>max(components)? ${fuseHits > Math.max(nameHits, factHits)})`);
  sec.hits = { name: nameHits, factmax: factHits, factname: fuseHits };
  report.secondaries = sec;

  console.log('');
  console.log('=== per corpus (FACTNAME - NAME, strict R@10) ===');
  const perCorpus: Record<string, unknown> = {};
  for (const c of CORPORA) {
    const idx = corpusOf.map((x, i) => (x === c ? i : -1)).filter((i) => i >= 0);
    const fh = idx.map((i) => hitStrict('FACTNAME', 10)[i]!); const nh = idx.map((i) => hitStrict('NAME', 10)[i]!);
    const r = clusteredBootstrap(fh, nh, idx.map((i) => String(i)));
    console.log(`  ${c}: n=${idx.length}  NAME ${mean(nh).toFixed(3)}  FACTNAME ${mean(fh).toFixed(3)}  ${ciStr(r)}`);
    perCorpus[c] = { n: idx.length, name: mean(nh), factname: mean(fh), ...r };
  }
  report.perCorpus = perCorpus;

  console.log('');
  console.log('=== k-ladder (strict / condensed) ===');
  const perK: Record<string, unknown> = {};
  for (const k of [1, 5, 10, 20]) {
    perK[k] = { nameStrict: mean(hitStrict('NAME', k)), factnameStrict: mean(hitStrict('FACTNAME', k)), nameCond: mean(hitCond('NAME', k)), factnameCond: mean(hitCond('FACTNAME', k)) };
    console.log(`  R@${String(k).padEnd(3)} NAME ${mean(hitStrict('NAME', k)).toFixed(3)}/${mean(hitCond('NAME', k)).toFixed(3)}  FACTNAME ${mean(hitStrict('FACTNAME', k)).toFixed(3)}/${mean(hitCond('FACTNAME', k)).toFixed(3)}`);
  }
  report.perK = perK;

  writeFileSync(join(OUT, 'arxiv-fusion-results.json'), JSON.stringify(report, null, 2));
  console.log(`\nartifact: ${join(OUT, 'arxiv-fusion-results.json')}`);
  process.exit(0);
}
main();
