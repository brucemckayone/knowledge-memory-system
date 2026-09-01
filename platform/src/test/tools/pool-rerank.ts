/**
 * Pool-then-re-rank — retrieval experiment #1.
 * FROZEN pre-registration: docs/architecture/single-graph/08-prereg-pool-then-rerank.md
 *
 * Reuses the committed embedding cache and the IDENTICAL cosine / query-pair /
 * oracle machinery of e0-oracle.ts. Nothing about the vectors changes.
 *
 * Arm B (primary) = DESC-pool(P) -> NAME-rerank:
 *   pool = P entities with the highest ARM-DESC cosine; re-rank those P by
 *   ARM-NAME cosine (desc, tie-break index asc); final ranking = the re-ranked
 *   pool. Target outside the pool = a miss.
 * Arm B' (control) = NAME-pool(P) -> DESC-rerank (the mirror; expected not to help).
 *
 * Scored under BOTH oracles (strict = doc 05; condensed = E0 Tier-B min-3).
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/pool-rerank.ts
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
const POOL_SIZES = [50, 100, 200] as const;
const HEADLINE_P = 100;

const REG_NAME_R10 = 0.20056497175141244;
const REG_DESC_R10 = 0.13841807909604520;
const REG_N = 354;

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
function rankByScore(scores: number[], minScore = -Infinity): number[] {
  const idx = scores.map((_, i) => i).filter((i) => scores[i]! > minScore);
  idx.sort((a, b) => (scores[b]! - scores[a]!) || (a - b));
  return idx;
}
/** Re-rank a pool of indices by a score array, desc, tie-break index asc. */
function rerank(pool: number[], scores: number[]): number[] {
  return [...pool].sort((a, b) => (scores[b]! - scores[a]!) || (a - b));
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

/** strict rank of target in a ranking (1-based; Infinity if absent). */
function strictRankOf(ranking: number[], t: number): number {
  const i = ranking.indexOf(t);
  return i < 0 ? Infinity : i + 1;
}
/** condensed rank: count only NON-relevant entities ranked above the target. */
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

  // ---- query pairs (identical rules to doc 05 / E0) ----------------------
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

  // ---- Tier A / Tier B (condensed oracle), per query document ------------
  const relevantByKey = new Map<string, Set<number>>(); // `${corpus}#${docId}` -> relevant indices
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

  // ---- score arms; keep strict + condensed rank per pair -----------------
  const ARMS = ['NAME', 'DESC',
    ...POOL_SIZES.map((p) => `B${p}`), ...POOL_SIZES.map((p) => `Bp${p}`)] as const;
  const strictRank: Record<string, number[]> = {};
  const condRank: Record<string, number[]> = {};
  for (const a of ARMS) { strictRank[a] = []; condRank[a] = []; }
  const descInTopP: Record<number, number[]> = {}; for (const p of POOL_SIZES) descInTopP[p] = [];
  const corpusOf: string[] = []; const entityOf: string[] = []; const docOf: string[] = [];
  const b100EqName: number[] = []; // degeneracy: B(headline) top-10 set == NAME top-10 set

  for (const c of CORPORA) {
    const ents = entsByCorpus.get(c)!;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    const vName = ents.map((e) => cache[entityEmbedTextFor(e.name, e.description, 'name')]!);
    const vDesc = ents.map((e) => cache[entityEmbedTextFor(e.name, e.description, 'name_description')]!);

    for (const p of pairs.filter((q) => q.corpusId === c)) {
      const t = idxOf.get(p.entityId);
      if (t === undefined) continue;
      const d = docsById.get(p.docId)!;
      const qv = cache[`${d.title} ${d.abstract}`]!;
      const rel = relevantByKey.get(`${c}#${p.docId}`)!;

      const sName = vName.map((v) => dot(qv, v));
      const sDesc = vDesc.map((v) => dot(qv, v));
      const rName = rankByScore(sName);
      const rDesc = rankByScore(sDesc);

      strictRank['NAME']!.push(strictRankOf(rName, t));
      condRank['NAME']!.push(condensedRankOf(rName, t, rel));
      strictRank['DESC']!.push(strictRankOf(rDesc, t));
      condRank['DESC']!.push(condensedRankOf(rDesc, t, rel));

      for (const P of POOL_SIZES) {
        descInTopP[P]!.push(rDesc.slice(0, P).includes(t) ? 1 : 0);
        // B = DESC-pool -> NAME-rerank
        const b = rerank(rDesc.slice(0, P), sName);
        strictRank[`B${P}`]!.push(strictRankOf(b, t));
        condRank[`B${P}`]!.push(condensedRankOf(b, t, rel));
        // B' = NAME-pool -> DESC-rerank
        const bp = rerank(rName.slice(0, P), sDesc);
        strictRank[`Bp${P}`]!.push(strictRankOf(bp, t));
        condRank[`Bp${P}`]!.push(condensedRankOf(bp, t, rel));
      }

      // degeneracy: headline B top-10 set vs NAME top-10 set
      const bTop = new Set(rerank(rDesc.slice(0, HEADLINE_P), sName).slice(0, 10));
      const nTop = new Set(rName.slice(0, 10));
      let same = bTop.size === nTop.size;
      if (same) for (const x of bTop) if (!nTop.has(x)) { same = false; break; }
      b100EqName.push(same ? 1 : 0);

      corpusOf.push(c); entityOf.push(p.entityId); docOf.push(p.docId);
    }
  }

  const n = strictRank['NAME']!.length;
  const hitStrict = (arm: string, k: number): number[] => strictRank[arm]!.map((r) => (r <= k ? 1 : 0));
  const hitCond = (arm: string, k: number): number[] => condRank[arm]!.map((r) => (r <= k ? 1 : 0));

  // ---- regression gate ---------------------------------------------------
  const nameR10 = mean(hitStrict('NAME', 10));
  const descR10 = mean(hitStrict('DESC', 10));
  console.log('');
  console.log('=== STRICT REGRESSION GATE ===');
  console.log(`  ARM-NAME strict R@10 = ${nameR10}  (target ${REG_NAME_R10})`);
  console.log(`  ARM-DESC strict R@10 = ${descR10}  (target ${REG_DESC_R10})`);
  console.log(`  n = ${n}  (target ${REG_N})`);
  const gateFail: string[] = [];
  if (Math.abs(nameR10 - REG_NAME_R10) >= 1e-9) gateFail.push('ARM-NAME strict R@10 mismatch');
  if (Math.abs(descR10 - REG_DESC_R10) >= 1e-9) gateFail.push('ARM-DESC strict R@10 mismatch');
  if (n !== REG_N) gateFail.push(`n=${n} != ${REG_N}`);
  if (gateFail.length) { console.log('=== VOID ==='); for (const g of gateFail) console.log(`  ${g}`); process.exit(1); }
  console.log('  GATE PASSED.');

  // ---- degeneracy guard --------------------------------------------------
  const overlap = mean(b100EqName);
  console.log('');
  console.log(`arm-identity degeneracy: B(P=${HEADLINE_P}) top-10 == NAME top-10 for ${(overlap * 100).toFixed(1)}% of pairs` +
    (overlap > 0.95 ? '  >>> DEGENERATE (prereg §6)' : ''));

  // ---- ceilings ----------------------------------------------------------
  console.log('');
  console.log('=== ceilings: ARM-DESC R@P (null = re-rank cannot recover what the pool missed) ===');
  for (const P of POOL_SIZES) console.log(`  DESC R@${P} = ${mean(descInTopP[P]!).toFixed(4)}`);

  // ---- arm table ---------------------------------------------------------
  console.log('');
  console.log('| arm | strict R@10 | condensed R@10 |');
  console.log('|-----|-------------|----------------|');
  for (const a of ARMS) {
    console.log(`| ${a.padEnd(6)} | ${mean(hitStrict(a, 10)).toFixed(4)} | ${mean(hitCond(a, 10)).toFixed(4)} |`);
  }

  // ---- PRIMARY + secondaries --------------------------------------------
  const pairKeys = pairs.map((_, i) => String(i));
  const report: Record<string, unknown> = { n, corpora: [...CORPORA], degeneracyB100EqName: overlap,
    ceilings: Object.fromEntries(POOL_SIZES.map((P) => [P, mean(descInTopP[P]!)])),
    armsStrictR10: Object.fromEntries(ARMS.map((a) => [a, mean(hitStrict(a, 10))])),
    armsCondR10: Object.fromEntries(ARMS.map((a) => [a, mean(hitCond(a, 10))])) };

  console.log('');
  console.log(`=== PRIMARY (strict): B(P=${HEADLINE_P}) R@10 - ARM-NAME R@10 ===`);
  const primary = {
    byPair: clusteredBootstrap(hitStrict(`B${HEADLINE_P}`, 10), hitStrict('NAME', 10), pairKeys),
    byEntity: clusteredBootstrap(hitStrict(`B${HEADLINE_P}`, 10), hitStrict('NAME', 10), entityOf),
    byDocument: clusteredBootstrap(hitStrict(`B${HEADLINE_P}`, 10), hitStrict('NAME', 10), docOf),
  };
  console.log(`  byPair     ${ciStr(primary.byPair)}`);
  console.log(`  byEntity   ${ciStr(primary.byEntity)}`);
  console.log(`  byDocument ${ciStr(primary.byDocument)}`);
  report.primary = primary;

  console.log('');
  console.log(`=== secondary (condensed): B(P=${HEADLINE_P}) R@10 - ARM-NAME R@10 ===`);
  const primaryCond = clusteredBootstrap(hitCond(`B${HEADLINE_P}`, 10), hitCond('NAME', 10), pairKeys);
  console.log(`  byPair     ${ciStr(primaryCond)}`);
  report.primaryCondensed = primaryCond;

  console.log('');
  console.log('=== secondaries: B - ARM-DESC, control B\' - NAME, pool-size sensitivity ===');
  const sec: Record<string, unknown> = {};
  sec.bMinusDescStrict = clusteredBootstrap(hitStrict(`B${HEADLINE_P}`, 10), hitStrict('DESC', 10), pairKeys);
  console.log(`  B(${HEADLINE_P}) - DESC (strict): ${ciStr(sec.bMinusDescStrict as any)}`);
  sec.controlMinusNameStrict = clusteredBootstrap(hitStrict(`Bp${HEADLINE_P}`, 10), hitStrict('NAME', 10), pairKeys);
  console.log(`  B'(${HEADLINE_P}) control - NAME (strict): ${ciStr(sec.controlMinusNameStrict as any)}`);
  for (const P of POOL_SIZES) {
    const s = clusteredBootstrap(hitStrict(`B${P}`, 10), hitStrict('NAME', 10), pairKeys);
    const cd = clusteredBootstrap(hitCond(`B${P}`, 10), hitCond('NAME', 10), pairKeys);
    console.log(`  B(P=${String(P).padEnd(3)}) - NAME  strict ${ciStr(s)}   condensed ${ciStr(cd)}`);
    sec[`B${P}_minus_name_strict`] = s;
    sec[`B${P}_minus_name_cond`] = cd;
  }
  report.secondaries = sec;

  // ---- per corpus (headline P, strict) -----------------------------------
  console.log('');
  console.log(`=== per corpus (B P=${HEADLINE_P} - NAME, strict R@10) ===`);
  const perCorpus: Record<string, unknown> = {};
  for (const c of CORPORA) {
    const idx = corpusOf.map((x, i) => (x === c ? i : -1)).filter((i) => i >= 0);
    const bh = idx.map((i) => hitStrict(`B${HEADLINE_P}`, 10)[i]!);
    const nh = idx.map((i) => hitStrict('NAME', 10)[i]!);
    const r = clusteredBootstrap(bh, nh, idx.map((i) => String(i)));
    console.log(`  ${c}: n=${idx.length}  NAME ${mean(nh).toFixed(3)}  B ${mean(bh).toFixed(3)}  ${ciStr(r)}`);
    perCorpus[c] = { n: idx.length, name: mean(nh), b: mean(bh), ...r };
  }
  report.perCorpus = perCorpus;

  writeFileSync(join(OUT, 'pool-rerank-results.json'), JSON.stringify(report, null, 2));
  console.log(`\nartifact: ${join(OUT, 'pool-rerank-results.json')}`);
  process.exit(0);
}
main();
