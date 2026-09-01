/**
 * E0 — is the retrieval oracle the binding constraint?
 * FROZEN pre-registration: docs/architecture/single-graph/06-prereg-e0-oracle.md
 *
 * Nothing about retrieval changes: NAME/DESC exact-cosine rankings, byte-identical
 * to doc 05. Two scores on the same ranking — strict rank (doc 05) and condensed
 * rank (1 + non-relevant entities ranked above the target, relevant = Tier A
 * attribution ∪ Tier B verbatim-name match). Headline = shift = Δcondensed −
 * Δstrict, Δ = (ARM-DESC R@10) − (ARM-NAME R@10). Now a thin config over the
 * shared retrieval-eval engine (bead nmemo-u8j.2); the Tier-B {min3,min5,min8,
 * multi} sensitivity is a pure filter over the shared RelevanceModel.
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     NODE_ENV=test npx tsx src/test/tools/e0-oracle.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clusteredBootstrap, ciStr, mean, condensedRankOf, nameMatcher } from './retrieval-eval/core.js';
import { runEval } from './retrieval-eval/harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARC = join(HERE, '../../../../docs/architecture/cross-corpus-audit/multihop-artifacts');
const CORPORA_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');
const CORPORA = ['dal-nlp', 'dal-cv'] as const;
const REG_NAME_R10 = 0.20056497175141244;
const REG_DESC_R10 = 0.13841807909604520;
const REG_N = 354;

const CONFIGS = [
  { label: 'min3', minLen: 3, multi: false },
  { label: 'min5', minLen: 5, multi: false },
  { label: 'min8', minLen: 8, multi: false },
  { label: 'multi', minLen: 3, multi: true },
] as const;

async function main(): Promise<void> {
  const r = await runEval({
    label: 'e0-oracle',
    corpora: CORPORA,
    paths: { arcDir: ARC, corporaDir: CORPORA_DIR, docFileFor: { 'dal-nlp': 'corpus-A.json', 'dal-cv': 'corpus-B.json' } },
    frozenCachePath: join(OUT, 'embed-cache.json'),
    arms: ['NAME', 'DESC'],
    regression: { targets: { NAME: REG_NAME_R10, DESC: REG_DESC_R10 }, n: REG_N },
    keepBaseRankings: true,
  });

  // Tier-B degeneracy (prereg §6)
  if (r.rel.meanTierBPerDoc < 1 || r.rel.meanRelevantFrac > 0.9) {
    console.log('');
    console.log('=== Tier-B DEGENERATE — reporting, NO condensed conclusion (prereg §6) ===');
    process.exit(0);
  }

  const { n, corpusOf, docOf, targetIdx, pairKeys, entityOf } = r;
  const rName = r.baseRankings!.rName; const rDesc = r.baseRankings!.rDesc!;
  const rankingOf: Record<string, number[][]> = { NAME: rName, DESC: rDesc };
  const keyOf = (i: number): string => `${corpusOf[i]}#${docOf[i]}`;

  // strict hit@10 per arm
  const strictHit = (arm: string): number[] => r.hitStrict(arm, 10);
  // condensed hit@10 per arm under a Tier-B config
  const condHit = (arm: string, cfg: { minLen: number; multi: boolean }): number[] =>
    rankingOf[arm]!.map((rk, i) => {
      const rel = r.rel.relevant(keyOf(i), cfg.minLen, cfg.multi);
      return condensedRankOf(rk, targetIdx[i]!, rel) <= 10 ? 1 : 0;
    });

  const report: Record<string, unknown> = {
    n, corpora: [...CORPORA], tierBMeanPerDoc: r.rel.meanTierBPerDoc, relevantFracMean: r.rel.meanRelevantFrac,
  };
  const tri = (a: number[], b: number[]) => ({
    byPair: clusteredBootstrap(a, b, pairKeys),
    byEntity: clusteredBootstrap(a, b, entityOf),
    byDocument: clusteredBootstrap(a, b, docOf),
  });

  // ---- headline: strict vs condensed(min3) + the shift ----
  const sN = strictHit('NAME'); const sD = strictHit('DESC');
  const cN = condHit('NAME', CONFIGS[0]); const cD = condHit('DESC', CONFIGS[0]);
  const dStrict = sD.map((x, i) => x - sN[i]!);
  const dCond = cD.map((x, i) => x - cN[i]!);
  const strictDelta = tri(sD, sN);
  const condDelta = tri(cD, cN);
  const shift = tri(dCond, dStrict);
  const nameR10 = mean(sN); const descR10 = mean(sD);
  console.log('');
  console.log('=== HEADLINE: Δ = ARM-DESC minus ARM-NAME, R@10, strict vs condensed(min3) ===');
  console.log(`  ARM-NAME  strict R@10 ${nameR10.toFixed(4)}  condensed R@10 ${mean(cN).toFixed(4)}`);
  console.log(`  ARM-DESC  strict R@10 ${descR10.toFixed(4)}  condensed R@10 ${mean(cD).toFixed(4)}`);
  console.log(`  Δstrict    (byPair) ${ciStr(strictDelta.byPair)}`);
  console.log(`  Δcondensed (byPair) ${ciStr(condDelta.byPair)}`);
  console.log(`  SHIFT = Δcond − Δstrict (byPair) ${ciStr(shift.byPair)}`);
  console.log(`  SHIFT (byEntity) ${ciStr(shift.byEntity)}`);
  console.log(`  SHIFT (byDocument) ${ciStr(shift.byDocument)}`);
  report.pooled = { nameR10, descR10, nameCondR10: mean(cN), descCondR10: mean(cD), strictDelta, condDelta, shift };

  // ---- per corpus (min3) ----
  console.log('');
  console.log('=== per corpus (R@10, min3) ===');
  const perCorpus: Record<string, unknown> = {};
  for (const c of CORPORA) {
    const idx = corpusOf.map((x, i) => (x === c ? i : -1)).filter((i) => i >= 0);
    const sNc = idx.map((i) => sN[i]!); const sDc = idx.map((i) => sD[i]!);
    const cNc = idx.map((i) => cN[i]!); const cDc = idx.map((i) => cD[i]!);
    const dSc = sDc.map((x, j) => x - sNc[j]!); const dCc = cDc.map((x, j) => x - cNc[j]!);
    const keys = idx.map((i) => String(i));
    const sh = clusteredBootstrap(dCc, dSc, keys);
    console.log(`  ${c}: n=${idx.length}  NAME s${mean(sNc).toFixed(3)}/c${mean(cNc).toFixed(3)}  DESC s${mean(sDc).toFixed(3)}/c${mean(cDc).toFixed(3)}  shift ${ciStr(sh)}`);
    perCorpus[c] = {
      n: idx.length, nameStrict: mean(sNc), nameCond: mean(cNc), descStrict: mean(sDc), descCond: mean(cDc),
      strictDelta: clusteredBootstrap(sDc, sNc, keys), condDelta: clusteredBootstrap(cDc, cNc, keys), shift: sh,
    };
  }
  report.perCorpus = perCorpus;

  // ---- per k ----
  console.log('');
  console.log('=== per-k pooled (strict R@k -> condensed R@k, min3) ===');
  const perK: Record<string, unknown> = {};
  for (const k of [1, 5, 10, 20]) {
    const sNk = r.hitStrict('NAME', k); const sDk = r.hitStrict('DESC', k);
    const cNk = rName.map((rk, i) => (condensedRankOf(rk, targetIdx[i]!, r.rel.relevant(keyOf(i), 3, false)) <= k ? 1 : 0));
    const cDk = rDesc.map((rk, i) => (condensedRankOf(rk, targetIdx[i]!, r.rel.relevant(keyOf(i), 3, false)) <= k ? 1 : 0));
    const row = { nameStrict: mean(sNk), nameCond: mean(cNk), descStrict: mean(sDk), descCond: mean(cDk) };
    console.log(`  R@${String(k).padEnd(3)} NAME ${row.nameStrict.toFixed(3)}->${row.nameCond.toFixed(3)}  DESC ${row.descStrict.toFixed(3)}->${row.descCond.toFixed(3)}`);
    perK[k] = row;
  }
  report.perK = perK;

  // ---- miss-mass decomposition + recovered-by-condensation (min3) ----
  console.log('');
  console.log('=== miss-mass: for STRICT R@10 misses, mean top-10 composition (min3) ===');
  const missAgg: Record<string, unknown> = {};
  for (const arm of ['NAME', 'DESC'] as const) {
    const sHit = strictHit(arm); const cH = condHit(arm, CONFIGS[0]);
    for (const c of CORPORA) {
      const idx = corpusOf.map((x, i) => (x === c ? i : -1)).filter((i) => i >= 0 && sHit[i] === 0);
      let aO = 0; let bC = 0; let cC = 0;
      for (const i of idx) {
        const aSet = r.rel.tierAOf(keyOf(i)); const bSet = r.rel.tierBOf(keyOf(i), 3, false);
        for (const e of rankingOf[arm]![i]!.slice(0, 10)) {
          if (e === targetIdx[i]!) continue;
          if (aSet.has(e)) aO += 1; else if (bSet.has(e)) bC += 1; else cC += 1;
        }
      }
      const strictMiss = idx.length;
      const recCount = idx.filter((i) => cH[i] === 1).length;
      const key = `${arm}/${c}`;
      console.log(`  ${key.padEnd(12)} strict-misses=${strictMiss}  top10: TierA(other) ${(aO / Math.max(1, strictMiss)).toFixed(1)}  TierB ${(bC / Math.max(1, strictMiss)).toFixed(1)}  TierC ${(cC / Math.max(1, strictMiss)).toFixed(1)}  | recovered by condensation ${recCount}/${strictMiss}`);
      missAgg[key] = { strictMisses: strictMiss, tierAOther: aO / Math.max(1, strictMiss), tierB: bC / Math.max(1, strictMiss), tierC: cC / Math.max(1, strictMiss), recovered: recCount, strictMissTotal: strictMiss };
    }
  }
  report.missMass = missAgg;

  // ---- Tier-B sensitivity: shift at each config ----
  console.log('');
  console.log('=== Tier-B sensitivity: SHIFT (byPair) at each config ===');
  const sens: Record<string, unknown> = {};
  for (const cfg of CONFIGS) {
    const cNcfg = condHit('NAME', cfg); const cDcfg = condHit('DESC', cfg);
    const dCcfg = cDcfg.map((x, i) => x - cNcfg[i]!);
    const sh = clusteredBootstrap(dCcfg, dStrict, pairKeys);
    const nB = mean(CORPORA.flatMap((c) => [...new Set(corpusOf.map((x, i) => (x === c ? keyOf(i) : '')).filter((k) => k))].map((key) => r.rel.tierBOf(key, cfg.minLen, cfg.multi).size)));
    console.log(`  ${cfg.label.padEnd(6)} (meanTierB/doc ${nB.toFixed(1)})  NAMEcond ${mean(cNcfg).toFixed(3)}  DESCcond ${mean(cDcfg).toFixed(3)}  shift ${ciStr(sh)}`);
    sens[cfg.label] = { meanTierBPerDoc: nB, nameCond: mean(cNcfg), descCond: mean(cDcfg), shift: sh };
  }
  report.sensitivity = sens;

  // ---- target-verbatim rate ----
  const targetVerbatim = corpusOf.map((c, i) => {
    const ent = r.sub.entsByCorpus.get(c)![targetIdx[i]!]!;
    const d = r.sub.docsById.get(docOf[i]!)!;
    return nameMatcher(ent.name.toLowerCase()).test(`${d.title} ${d.abstract}`.toLowerCase()) ? 1 : 0;
  });
  console.log('');
  console.log(`target-verbatim rate: ${(mean(targetVerbatim) * 100).toFixed(1)}%`);
  report.targetVerbatimRate = mean(targetVerbatim);

  writeFileSync(join(OUT, 'e0-oracle-results.json'), JSON.stringify(report, null, 2));
  console.log(`\nartifact: ${join(OUT, 'e0-oracle-results.json')}`);
  process.exit(0);
}
main();
