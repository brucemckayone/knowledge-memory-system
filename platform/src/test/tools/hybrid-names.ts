/**
 * Shippable hybrid — retrieval experiment #2 (nmemo-uhp.18).
 * FROZEN pre-registration: docs/architecture/single-graph/11-prereg-shippable-hybrid.md
 *
 * H = retrieved-set RRF over (dense-over-names, BM25-over-names). Now a thin
 * config over the shared retrieval-eval engine (bead nmemo-u8j.2).
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/hybrid-names.ts
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
const K_VALUES = [10, 30, 60, 100] as const;
const HEADLINE_K = 60;
const REG_NAME_R10 = 0.20056497175141244;
const REG_BM25N_R10 = 0.18926553672316385;
const REG_N = 354;

async function main(): Promise<void> {
  const r = await runEval({
    label: 'hybrid-names',
    corpora: CORPORA,
    paths: { arcDir: ARC, corporaDir: CORPORA_DIR, docFileFor: { 'dal-nlp': 'corpus-A.json', 'dal-cv': 'corpus-B.json' } },
    frozenCachePath: join(OUT, 'embed-cache.json'),
    arms: ['NAME', 'BM25n', ...K_VALUES.map((k) => `H${k}`), 'HFULL60'],
    regression: { targets: { NAME: REG_NAME_R10, BM25n: REG_BM25N_R10 }, n: REG_N },
    degeneracyArm: `H${HEADLINE_K}`,
    keepBaseRankings: true,
  });

  const { n, hitStrict, hitCond, tri, pairKeys, corpusOf } = r;
  const rName = r.baseRankings!.rName; const rBm25 = r.baseRankings!.rBm25!;

  // component top-10 Jaccard (dense-names vs BM25-names)
  const compJaccard = rName.map((nr, i) => {
    const dTop = new Set(nr.slice(0, 10)); const bTop = new Set(rBm25[i]!.slice(0, 10));
    const inter = [...dTop].filter((x) => bTop.has(x)).length;
    const uni = new Set([...dTop, ...bTop]).size;
    return uni ? inter / uni : 0;
  });
  const jac = mean(compJaccard);
  console.log('');
  console.log(`component top-10 Jaccard (dense-names vs BM25-names): ${jac.toFixed(3)}` + (jac > 0.9 ? '  >>> UNINFORMATIVE' : ''));

  const report: Record<string, unknown> = {
    n, corpora: [...CORPORA], degeneracyHEqName: r.degeneracyOverlap, componentJaccard: jac,
    armsStrictR10: r.armStrictR(10), armsCondR10: r.armCondR(10),
  };

  console.log('');
  console.log(`=== PRIMARY (strict): H(K=${HEADLINE_K}) R@10 - ARM-NAME R@10 ===`);
  const primary = tri(hitStrict(`H${HEADLINE_K}`, 10), hitStrict('NAME', 10));
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
  sec.fullRanking60MinusName = hfull;
  report.secondaries = sec;

  console.log('');
  console.log(`=== per corpus (H K=${HEADLINE_K} - NAME, strict R@10) ===`);
  const perCorpus: Record<string, unknown> = {};
  for (const c of CORPORA) {
    const idx = corpusOf.map((x, i) => (x === c ? i : -1)).filter((i) => i >= 0);
    const hh = idx.map((i) => hitStrict(`H${HEADLINE_K}`, 10)[i]!);
    const nh = idx.map((i) => hitStrict('NAME', 10)[i]!);
    const rr = clusteredBootstrap(hh, nh, idx.map((i) => String(i)));
    console.log(`  ${c}: n=${idx.length}  NAME ${mean(nh).toFixed(3)}  H ${mean(hh).toFixed(3)}  ${ciStr(rr)}`);
    perCorpus[c] = { n: idx.length, name: mean(nh), h: mean(hh), ...rr };
  }
  report.perCorpus = perCorpus;

  writeFileSync(join(OUT, 'hybrid-names-results.json'), JSON.stringify(report, null, 2));
  console.log(`\nartifact: ${join(OUT, 'hybrid-names-results.json')}`);
  process.exit(0);
}
main();
