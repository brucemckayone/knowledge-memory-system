/**
 * E0 — is the retrieval oracle the binding constraint?
 *
 * FROZEN pre-registration: docs/architecture/single-graph/06-prereg-e0-oracle.md
 *
 * Nothing about retrieval changes here. This reuses the committed embedding cache
 * and the IDENTICAL ranking path of desc-aligned-followups.ts (exact cosine over
 * the full corpus entity set, tie-break by index asc, entityEmbedTextFor for arm
 * text) and the IDENTICAL query-pair reconstruction. Because the rankings are
 * byte-identical to doc 05, every number that moves between the two oracles is
 * attributable to the oracle alone.
 *
 * Two scores on the same ranking, per the frozen text:
 *   strict rank    = 1-based position of the target t (doc 05's metric).
 *   condensed rank = 1 + |{ i : rank(i) < rank(t) AND i NOT in relevant(d) }|,
 *                    where relevant(d) = TierA(d) union TierB(d), t always in it.
 *   TierA = attributed (fact-endpoint). TierB = canonical name matches verbatim in
 *   lower(title+' '+abstract) under a word-boundary regex, name length >= 3.
 *
 * Headline = shift = Δcondensed − Δstrict, Δ = (ARM-DESC R@10) − (ARM-NAME R@10).
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     NODE_ENV=test npx tsx src/test/tools/e0-oracle.ts
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

// --- frozen regression targets (doc 05 / prereg 06 §6) --------------------
const REG_NAME_R10 = 0.20056497175141244;
const REG_DESC_R10 = 0.13841807909604520;
const REG_N = 354;

// --- helpers, identical to desc-aligned-followups.ts ----------------------
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

/** Word-boundary matcher for a verbatim name (Tier B), name regex-escaped.
 *  Boundary defined against [a-z0-9], consistent with the premise check. */
function nameMatcher(name: string): RegExp {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`);
}

interface Doc { id: string; title: string; abstract: string }
interface Ent { id: string; name: string; description: string | null }
interface MatchedName { idx: number; nameLen: number; multi: boolean }

async function main(): Promise<void> {
  const cache = JSON.parse(readFileSync(join(OUT, 'embed-cache.json'), 'utf8')) as Record<string, number[]>;
  console.log(`embed cache: ${Object.keys(cache).length} vectors`);

  // ---- 1. Query pairs, identical rules to doc 05 -------------------------
  const docsById = new Map<string, Doc>();
  const entsByCorpus = new Map<string, Ent[]>();
  const pairs: Array<{ entityId: string; docId: string; corpusId: string }> = [];
  for (const c of CORPORA) {
    const docs: Doc[] = JSON.parse(readFileSync(join(CORPORA_DIR, DOC_FILE[c]!), 'utf8'));
    for (const d of docs) docsById.set(d.id, d);
    const attr = JSON.parse(readFileSync(join(ARC, `attribution-${c}.json`), 'utf8')) as {
      paperToEntities: Record<string, string[]>;
    };
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
      for (const docId of uniq.slice(1)) pairs.push({ entityId, docId, corpusId: c });
    }
    entsByCorpus.set(c, await rawQuery<Ent>(sql`
      SELECT id::text AS id, canonical_name AS name, description FROM public.entities
      WHERE corpus_id = ${c} ORDER BY id`));
  }
  console.log(`query pairs: ${pairs.length} (target n=${REG_N})`);

  // ---- 2. Tier A / Tier B per query document (per corpus) ----------------
  // attribution entity-id set -> corpus-index set for Tier A; verbatim-name
  // match -> corpus-index set for Tier B, tagged by name length + token count
  // so the {3,5,8}/multi-token sensitivity configs are pure filters.
  const attrByCorpus = new Map<string, Record<string, string[]>>();
  for (const c of CORPORA) {
    attrByCorpus.set(c, (JSON.parse(readFileSync(join(ARC, `attribution-${c}.json`), 'utf8')) as {
      paperToEntities: Record<string, string[]>;
    }).paperToEntities);
  }
  const tierA = new Map<string, Set<number>>(); // key `${corpus}#${docId}`
  const tierBMatched = new Map<string, MatchedName[]>();
  const queryDocs = new Map<string, Set<string>>(); // corpus -> docIds used as queries
  for (const p of pairs) {
    const s = queryDocs.get(p.corpusId) ?? new Set<string>();
    s.add(p.docId); queryDocs.set(p.corpusId, s);
  }
  const tierBSizes: number[] = [];
  const relevantFracs: number[] = [];
  for (const c of CORPORA) {
    const ents = entsByCorpus.get(c)!;
    const idxOf = new Map(ents.map((e, i) => [e.id, i]));
    // compile name matchers once (names >= 3 chars only, per frozen Tier B)
    const matchers = ents.map((e, i) => {
      const nm = (e.name ?? '').trim();
      if (nm.length < 3) return null;
      return { idx: i, re: nameMatcher(nm.toLowerCase()), nameLen: nm.length, multi: /\s/.test(nm) };
    });
    const p2e = attrByCorpus.get(c)!;
    for (const docId of queryDocs.get(c)!) {
      const d = docsById.get(docId)!;
      const text = `${d.title} ${d.abstract}`.toLowerCase();
      const a = new Set<number>();
      for (const eid of p2e[docId] ?? []) { const i = idxOf.get(eid); if (i !== undefined) a.add(i); }
      const matched: MatchedName[] = [];
      for (const m of matchers) {
        if (!m) continue;
        if (a.has(m.idx)) continue; // Tier A takes precedence over Tier B
        if (m.re.test(text)) matched.push({ idx: m.idx, nameLen: m.nameLen, multi: m.multi });
      }
      tierA.set(`${c}#${docId}`, a);
      tierBMatched.set(`${c}#${docId}`, matched);
      tierBSizes.push(matched.length);
      relevantFracs.push((a.size + matched.length) / ents.length);
    }
  }
  console.log(`Tier-B size / doc: mean ${mean(tierBSizes).toFixed(1)}   ` +
    `mean |relevant|/|corpus|: ${(mean(relevantFracs) * 100).toFixed(1)}%`);

  const tierBSet = (key: string, minLen: number, multiOnly: boolean): Set<number> => {
    const out = new Set<number>();
    for (const m of tierBMatched.get(key) ?? []) {
      if (m.nameLen < minLen) continue;
      if (multiOnly && !m.multi) continue;
      out.add(m.idx);
    }
    return out;
  };

  // ---- 3. Rank both arms; keep strict + condensed ranks ------------------
  // Sensitivity configs for Tier B; primary is min-3.
  const CONFIGS: Array<{ label: string; minLen: number; multi: boolean }> = [
    { label: 'min3', minLen: 3, multi: false },
    { label: 'min5', minLen: 5, multi: false },
    { label: 'min8', minLen: 8, multi: false },
    { label: 'multi', minLen: 3, multi: true },
  ];
  const strictRank: Record<string, number[]> = { NAME: [], DESC: [] };
  // condensedRank[config][arm]
  const condRank: Record<string, Record<string, number[]>> = {};
  for (const cfg of CONFIGS) condRank[cfg.label] = { NAME: [], DESC: [] };
  const corpusOf: string[] = [];
  const entityOf: string[] = [];
  const docOf: string[] = [];
  const targetVerbatim: boolean[] = [];
  // miss-mass: for strict>10, per arm, top-10 composition
  interface MissRow { arm: string; corpus: string; tierAOther: number; tierB: number; tierC: number }
  const missRows: MissRow[] = [];
  const recovered: Record<string, { strictMiss: number; recovered: number; corpus: string }[]> = { NAME: [], DESC: [] };

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
      const key = `${c}#${p.docId}`;
      const aSet = tierA.get(key)!;

      for (const [arm, vecs] of [['NAME', vName], ['DESC', vDesc]] as const) {
        const ranking = rankByScore(vecs.map((v) => dot(qv, v)));
        const posT = ranking.indexOf(t); // 0-based
        const sRank = posT < 0 ? Infinity : posT + 1;
        strictRank[arm]!.push(sRank);

        // condensed rank per config
        for (const cfg of CONFIGS) {
          const bSet = tierBSet(key, cfg.minLen, cfg.multi);
          let above = 0;
          const limit = posT < 0 ? ranking.length : posT;
          for (let r = 0; r < limit; r++) {
            const i = ranking[r]!;
            if (i === t) continue;
            if (aSet.has(i) || bSet.has(i)) continue; // co-relevant, do not count
            above += 1;
          }
          condRank[cfg.label]![arm]!.push(posT < 0 ? Infinity : above + 1);
        }

        // miss-mass at primary config (min3), for strict misses only
        if (sRank > 10) {
          const bSet = tierBSet(key, 3, false);
          let aO = 0; let bC = 0; let cC = 0;
          for (const i of ranking.slice(0, 10)) {
            if (i === t) continue;
            if (aSet.has(i)) aO += 1;
            else if (bSet.has(i)) bC += 1;
            else cC += 1;
          }
          missRows.push({ arm, corpus: c, tierAOther: aO, tierB: bC, tierC: cC });
        }
        // recovered by condensation (primary min3)
        const cr = condRank['min3']![arm]!;
        const crv = cr[cr.length - 1]!;
        recovered[arm]!.push({ strictMiss: sRank > 10 ? 1 : 0, recovered: sRank > 10 && crv <= 10 ? 1 : 0, corpus: c });
      }

      corpusOf.push(c); entityOf.push(p.entityId); docOf.push(p.docId);
      targetVerbatim.push(nameMatcher(ents[t]!.name.toLowerCase()).test(`${d.title} ${d.abstract}`.toLowerCase()));
    }
  }

  const n = strictRank['NAME']!.length;
  const hit = (ranks: number[], k: number): number[] => ranks.map((r) => (r <= k ? 1 : 0));

  // ---- 4. REGRESSION GATE (prereg §6) ------------------------------------
  const nameR10 = mean(hit(strictRank['NAME']!, 10));
  const descR10 = mean(hit(strictRank['DESC']!, 10));
  console.log('');
  console.log('=== STRICT REGRESSION GATE (must reproduce doc 05 bit-exact) ===');
  console.log(`  ARM-NAME strict R@10 = ${nameR10}   target ${REG_NAME_R10}`);
  console.log(`  ARM-DESC strict R@10 = ${descR10}   target ${REG_DESC_R10}`);
  console.log(`  n = ${n}   target ${REG_N}`);
  const gateFail: string[] = [];
  if (Math.abs(nameR10 - REG_NAME_R10) >= 1e-9) gateFail.push('ARM-NAME strict R@10 does not reproduce doc 05');
  if (Math.abs(descR10 - REG_DESC_R10) >= 1e-9) gateFail.push('ARM-DESC strict R@10 does not reproduce doc 05');
  if (n !== REG_N) gateFail.push(`n=${n} != ${REG_N}`);
  if (gateFail.length > 0) {
    console.log('');
    console.log('=== VOID — regression gate failed, harness is mis-wired ===');
    for (const g of gateFail) console.log(`  ${g}`);
    process.exit(1);
  }
  console.log('  GATE PASSED — strict rankings are byte-identical to doc 05.');

  // ---- 5. Tier-B degeneracy check (prereg §6) ----------------------------
  if (mean(tierBSizes) < 1 || mean(relevantFracs) > 0.9) {
    console.log('');
    console.log('=== Tier-B DEGENERATE — reporting, NO condensed conclusion (prereg §6) ===');
    console.log(`  mean Tier-B/doc ${mean(tierBSizes).toFixed(2)}, mean |relevant|/|corpus| ${(mean(relevantFracs) * 100).toFixed(1)}%`);
    process.exit(0);
  }

  // ---- 6. Headline: strict vs condensed deltas + the shift ---------------
  const clusterKeys = { pair: pairs.map((_, i) => String(i)), entity: entityOf, doc: docOf };
  const report: Record<string, unknown> = { n, corpora: [...CORPORA], tierBMeanPerDoc: mean(tierBSizes), relevantFracMean: mean(relevantFracs) };

  const deltaBlock = (armA: number[], armB: number[]): Record<string, unknown> => ({
    byPair: clusteredBootstrap(armA, armB, clusterKeys.pair),
    byEntity: clusteredBootstrap(armA, armB, clusterKeys.entity),
    byDocument: clusteredBootstrap(armA, armB, clusterKeys.doc),
  });

  console.log('');
  console.log('=== HEADLINE: Δ = ARM-DESC minus ARM-NAME, R@10, strict vs condensed(min3) ===');
  const dStrict = hit(strictRank['DESC']!, 10).map((x, i) => x - hit(strictRank['NAME']!, 10)[i]!);
  const dCond = hit(condRank['min3']!['DESC']!, 10).map((x, i) => x - hit(condRank['min3']!['NAME']!, 10)[i]!);

  const strictDelta = deltaBlock(hit(strictRank['DESC']!, 10), hit(strictRank['NAME']!, 10));
  const condDelta = deltaBlock(hit(condRank['min3']!['DESC']!, 10), hit(condRank['min3']!['NAME']!, 10));
  const shift = deltaBlock(dCond, dStrict); // (Δcond − Δstrict) per pair, then bootstrap

  console.log(`  ARM-NAME  strict R@10 ${nameR10.toFixed(4)}  condensed R@10 ${mean(hit(condRank['min3']!['NAME']!, 10)).toFixed(4)}`);
  console.log(`  ARM-DESC  strict R@10 ${descR10.toFixed(4)}  condensed R@10 ${mean(hit(condRank['min3']!['DESC']!, 10)).toFixed(4)}`);
  console.log(`  Δstrict    (byPair) ${ciStr((strictDelta as any).byPair)}`);
  console.log(`  Δcondensed (byPair) ${ciStr((condDelta as any).byPair)}`);
  console.log(`  SHIFT = Δcond − Δstrict (byPair) ${ciStr((shift as any).byPair)}`);
  console.log(`  SHIFT (byEntity) ${ciStr((shift as any).byEntity)}`);
  console.log(`  SHIFT (byDocument) ${ciStr((shift as any).byDocument)}`);
  report.pooled = { nameR10, descR10, nameCondR10: mean(hit(condRank['min3']!['NAME']!, 10)), descCondR10: mean(hit(condRank['min3']!['DESC']!, 10)), strictDelta, condDelta, shift };

  // ---- 7. Per corpus + per k ---------------------------------------------
  console.log('');
  console.log('=== per corpus (R@10, min3) ===');
  const perCorpus: Record<string, unknown> = {};
  for (const c of CORPORA) {
    const idx = corpusOf.map((x, i) => (x === c ? i : -1)).filter((i) => i >= 0);
    const sN = idx.map((i) => hit(strictRank['NAME']!, 10)[i]!);
    const sD = idx.map((i) => hit(strictRank['DESC']!, 10)[i]!);
    const cN = idx.map((i) => hit(condRank['min3']!['NAME']!, 10)[i]!);
    const cD = idx.map((i) => hit(condRank['min3']!['DESC']!, 10)[i]!);
    const dS = sD.map((x, j) => x - sN[j]!);
    const dC = cD.map((x, j) => x - cN[j]!);
    const keys = idx.map((i) => String(i));
    const sh = clusteredBootstrap(dC, dS, keys);
    console.log(`  ${c}: n=${idx.length}  NAME s${mean(sN).toFixed(3)}/c${mean(cN).toFixed(3)}  DESC s${mean(sD).toFixed(3)}/c${mean(cD).toFixed(3)}  ` +
      `Δstrict ${ciStr(clusteredBootstrap(sD, sN, keys))}  Δcond ${ciStr(clusteredBootstrap(cD, cN, keys))}  shift ${ciStr(sh)}`);
    perCorpus[c] = {
      n: idx.length, nameStrict: mean(sN), nameCond: mean(cN), descStrict: mean(sD), descCond: mean(cD),
      strictDelta: clusteredBootstrap(sD, sN, keys), condDelta: clusteredBootstrap(cD, cN, keys), shift: sh,
    };
  }
  report.perCorpus = perCorpus;

  console.log('');
  console.log('=== per-k pooled (strict R@k -> condensed R@k) ===');
  const perK: Record<string, unknown> = {};
  for (const k of [1, 5, 10, 20]) {
    const row = {
      nameStrict: mean(hit(strictRank['NAME']!, k)), nameCond: mean(hit(condRank['min3']!['NAME']!, k)),
      descStrict: mean(hit(strictRank['DESC']!, k)), descCond: mean(hit(condRank['min3']!['DESC']!, k)),
    };
    console.log(`  R@${String(k).padEnd(3)} NAME ${row.nameStrict.toFixed(3)}->${row.nameCond.toFixed(3)}  DESC ${row.descStrict.toFixed(3)}->${row.descCond.toFixed(3)}`);
    perK[k] = row;
  }
  report.perK = perK;

  // ---- 8. Miss-mass decomposition + recovered-by-condensation ------------
  console.log('');
  console.log('=== miss-mass: for STRICT R@10 misses, mean top-10 composition (min3) ===');
  const missAgg: Record<string, unknown> = {};
  for (const arm of ['NAME', 'DESC'] as const) {
    for (const c of CORPORA) {
      const rows = missRows.filter((r) => r.arm === arm && r.corpus === c);
      const key = `${arm}/${c}`;
      const rec = recovered[arm]!.filter((r) => r.corpus === c);
      const strictMiss = rec.filter((r) => r.strictMiss === 1).length;
      const recCount = rec.filter((r) => r.recovered === 1).length;
      console.log(`  ${key.padEnd(12)} strict-misses=${rows.length}  top10: TierA(other) ${mean(rows.map((r) => r.tierAOther)).toFixed(1)}  ` +
        `TierB ${mean(rows.map((r) => r.tierB)).toFixed(1)}  TierC ${mean(rows.map((r) => r.tierC)).toFixed(1)}  ` +
        `| recovered by condensation ${recCount}/${strictMiss}`);
      missAgg[key] = {
        strictMisses: rows.length,
        tierAOther: mean(rows.map((r) => r.tierAOther)), tierB: mean(rows.map((r) => r.tierB)), tierC: mean(rows.map((r) => r.tierC)),
        recovered: recCount, strictMissTotal: strictMiss,
      };
    }
  }
  report.missMass = missAgg;

  // ---- 9. Tier-B sensitivity: shift at each config -----------------------
  console.log('');
  console.log('=== Tier-B sensitivity: SHIFT (byPair) at each config ===');
  const sens: Record<string, unknown> = {};
  for (const cfg of CONFIGS) {
    const dC = hit(condRank[cfg.label]!['DESC']!, 10).map((x, i) => x - hit(condRank[cfg.label]!['NAME']!, 10)[i]!);
    const sh = clusteredBootstrap(dC, dStrict, pairs.map((_, i) => String(i)));
    const nB = mean(CORPORA.flatMap((c) => [...queryDocs.get(c)!].map((docId) => tierBSet(`${c}#${docId}`, cfg.minLen, cfg.multi).size)));
    console.log(`  ${cfg.label.padEnd(6)} (meanTierB/doc ${nB.toFixed(1)})  NAMEcond ${mean(hit(condRank[cfg.label]!['NAME']!, 10)).toFixed(3)}  DESCcond ${mean(hit(condRank[cfg.label]!['DESC']!, 10)).toFixed(3)}  shift ${ciStr(sh)}`);
    sens[cfg.label] = { meanTierBPerDoc: nB, nameCond: mean(hit(condRank[cfg.label]!['NAME']!, 10)), descCond: mean(hit(condRank[cfg.label]!['DESC']!, 10)), shift: sh };
  }
  report.sensitivity = sens;

  console.log('');
  console.log(`target-verbatim rate: ${(mean(targetVerbatim.map((v) => (v ? 1 : 0))) * 100).toFixed(1)}%`);
  report.targetVerbatimRate = mean(targetVerbatim.map((v) => (v ? 1 : 0)));

  writeFileSync(join(OUT, 'e0-oracle-results.json'), JSON.stringify(report, null, 2));
  console.log(`\nartifact: ${join(OUT, 'e0-oracle-results.json')}`);
  process.exit(0);
}
main();
