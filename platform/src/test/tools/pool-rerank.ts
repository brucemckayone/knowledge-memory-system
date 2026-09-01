/**
 * Pool-then-re-rank — retrieval experiment #1.
 * FROZEN pre-registration: docs/architecture/single-graph/08-prereg-pool-then-rerank.md
 *
 * Arm B (primary) = DESC-pool(P) -> NAME-rerank; arm B' (control) = the mirror.
 * Scored under BOTH oracles. Now a thin config over the shared retrieval-eval
 * engine (bead nmemo-u8j.2).
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/pool-rerank.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clusteredBootstrap, ciStr, mean } from './retrieval-eval/core.js';
import { runEval } from './retrieval-eval/harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARC = join(HERE, '../../../../docs/architecture/cross-corpus-audit/multihop-artifacts');
const CORPORA_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');
const CORPORA = ['dal-nlp', 'dal-cv'] as const;
const POOL_SIZES = [50, 100, 200] as const;
const HEADLINE_P = 100;
const REG_NAME_R10 = 0.20056497175141244;
const REG_DESC_R10 = 0.13841807909604520;
const REG_N = 354;

async function main(): Promise<void> {
  const r = await runEval({
    label: 'pool-rerank',
    corpora: CORPORA,
    paths: { arcDir: ARC, corporaDir: CORPORA_DIR, docFileFor: { 'dal-nlp': 'corpus-A.json', 'dal-cv': 'corpus-B.json' } },
    frozenCachePath: join(OUT, 'embed-cache.json'),
    arms: ['NAME', 'DESC', ...POOL_SIZES.map((p) => `B${p}`), ...POOL_SIZES.map((p) => `Bp${p}`)],
    regression: { targets: { NAME: REG_NAME_R10, DESC: REG_DESC_R10 }, n: REG_N },
    degeneracyArm: `B${HEADLINE_P}`,
    keepBaseRankings: true,
  });

  const { n, hitStrict, hitCond, tri, pairKeys, corpusOf, targetIdx } = r;
  const rDesc = r.baseRankings!.rDesc!;

  // ceilings: ARM-DESC R@P (re-rank cannot recover what the pool missed)
  const descInTopP: Record<number, number[]> = {};
  for (const P of POOL_SIZES) descInTopP[P] = rDesc.map((rk, i) => (rk.slice(0, P).includes(targetIdx[i]!) ? 1 : 0));
  console.log('');
  console.log('=== ceilings: ARM-DESC R@P ===');
  for (const P of POOL_SIZES) console.log(`  DESC R@${P} = ${mean(descInTopP[P]!).toFixed(4)}`);

  const report: Record<string, unknown> = {
    n, corpora: [...CORPORA], degeneracyB100EqName: r.degeneracyOverlap,
    ceilings: Object.fromEntries(POOL_SIZES.map((P) => [P, mean(descInTopP[P]!)])),
    armsStrictR10: r.armStrictR(10), armsCondR10: r.armCondR(10),
  };

  console.log('');
  console.log(`=== PRIMARY (strict): B(P=${HEADLINE_P}) R@10 - ARM-NAME R@10 ===`);
  const primary = tri(hitStrict(`B${HEADLINE_P}`, 10), hitStrict('NAME', 10));
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

  console.log('');
  console.log(`=== per corpus (B P=${HEADLINE_P} - NAME, strict R@10) ===`);
  const perCorpus: Record<string, unknown> = {};
  for (const c of CORPORA) {
    const idx = corpusOf.map((x, i) => (x === c ? i : -1)).filter((i) => i >= 0);
    const bh = idx.map((i) => hitStrict(`B${HEADLINE_P}`, 10)[i]!);
    const nh = idx.map((i) => hitStrict('NAME', 10)[i]!);
    const rr = clusteredBootstrap(bh, nh, idx.map((i) => String(i)));
    console.log(`  ${c}: n=${idx.length}  NAME ${mean(nh).toFixed(3)}  B ${mean(bh).toFixed(3)}  ${ciStr(rr)}`);
    perCorpus[c] = { n: idx.length, name: mean(nh), b: mean(bh), ...rr };
  }
  report.perCorpus = perCorpus;

  writeFileSync(join(OUT, 'pool-rerank-results.json'), JSON.stringify(report, null, 2));
  console.log(`\nartifact: ${join(OUT, 'pool-rerank-results.json')}`);
  process.exit(0);
}
main();
