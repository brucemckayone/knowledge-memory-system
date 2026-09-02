/**
 * prereg-24 (nmemo-u8j.3) — fusion generalization to a new domain (arXiv q-bio).
 * FROZEN pre-registration: docs/architecture/single-graph/24-prereg-generalization.md
 *
 * Reuses the R4 arms UNCHANGED (NAME, FACTMAX[=prereg "FACT"], FACTNAME=RRF-60(NAME,FACTMAX))
 * over the new-domain `qbio` corpus, via the shared retrieval-eval engine (bead nmemo-u8j.2)
 * that produced R4/doc 20/22. Adds the degree-stratified decay curve (prereg §4/§6 SECONDARY)
 * using the engine's held-out targetFactCount (facts from the query doc are excluded — §8e).
 *
 * PRIMARY bar (§6): FACTNAME - NAME strict R@10 > 0 on ALL THREE bootstraps (pair/entity/doc)
 * => the fusion lever GENERALIZES (DEMONSTRATED). Condensed reported alongside.
 *
 * Query/entity/fact vectors are nomic (as ingested); the frozen doc-05 cache is read-only,
 * qbio entity-name + query-doc vectors embed into a SEPARATE writable cache.
 *
 * Run (after the attended ingest completes):
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/qbio-fusion.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clusteredBootstrap, ciStr, triStr, mean, type BootstrapResult } from './retrieval-eval/core.js';
import { runEval } from './retrieval-eval/harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARC = join(HERE, '../../../../docs/architecture/cross-corpus-audit/multihop-artifacts');
const CORPORA_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');
const CORPORA = ['qbio'] as const;

/** held-out fact-degree bins (§4). Bin 0 is reported separately (no fact signal to fuse). */
const BINS: Array<{ label: string; lo: number; hi: number }> = [
  { label: '1', lo: 1, hi: 1 },
  { label: '2-3', lo: 2, hi: 3 },
  { label: '4-7', lo: 4, hi: 7 },
  { label: '8+', lo: 8, hi: Infinity },
];

async function main(): Promise<void> {
  const r = await runEval({
    label: 'qbio-fusion',
    corpora: CORPORA,
    paths: { arcDir: ARC, corporaDir: CORPORA_DIR, docFileFor: { qbio: 'corpus-C.json' } },
    frozenCachePath: join(OUT, 'embed-cache.json'),
    writableCachePath: join(OUT, 'qbio-embed-cache.json'),
    arms: ['NAME', 'FACTMAX', 'FACTNAME'],
    ensureEmbedEntityNames: true,
    ensureEmbedQueryDocs: true,
    underpoweredMin: 30, // §7 VOID (underpowered): < ~30 query pairs => no pass/fail
    factNormStrict: true,
    degeneracyArm: 'FACTMAX',
  });

  const { n, hitStrict, hitCond, tri, targetFactCount } = r;
  console.log('');
  console.log(`n=${n}  held-out guard fired on ${r.pairsWithExclusion}/${n} pairs  retrievability ${((n - r.noEligibleFact!) / n * 100).toFixed(1)}% (>=1 held-out fact)`);

  const report: Record<string, unknown> = {
    n, corpora: [...CORPORA], pairsWithExclusion: r.pairsWithExclusion, noEligible: r.noEligibleFact,
    factmaxEqName: r.degeneracyOverlap,
    armsStrictR10: r.armStrictR(10), armsCondR10: r.armCondR(10),
  };

  console.log('');
  console.log('=== PRIMARY (strict): FACTNAME R@10 - NAME R@10 ===');
  const primaryStrict = tri(hitStrict('FACTNAME', 10), hitStrict('NAME', 10));
  console.log(`  ${triStr(primaryStrict)}`);
  report.primaryStrict = primaryStrict;

  console.log('');
  console.log('=== CO-PRIMARY (condensed): FACTNAME R@10 - NAME R@10 ===');
  const primaryCond = tri(hitCond('FACTNAME', 10), hitCond('NAME', 10));
  console.log(`  ${triStr(primaryCond)}`);
  report.primaryCondensed = primaryCond;

  console.log('');
  console.log('=== complementarity (strict hits @10) ===');
  const nameHits = hitStrict('NAME', 10).reduce((s, x) => s + x, 0);
  const factHits = hitStrict('FACTMAX', 10).reduce((s, x) => s + x, 0);
  const fuseHits = hitStrict('FACTNAME', 10).reduce((s, x) => s + x, 0);
  console.log(`  NAME ${nameHits}  FACTMAX ${factHits}  FACTNAME ${fuseHits}  (fusion>max(components)? ${fuseHits > Math.max(nameHits, factHits)})`);
  report.hits = { name: nameHits, factmax: factHits, factname: fuseHits };

  console.log('');
  console.log('=== SECONDARY: degree-stratified lift (FACTNAME - NAME, R@10) on HELD-OUT fact-degree ===');
  const fnS = hitStrict('FACTNAME', 10); const nS = hitStrict('NAME', 10);
  const fnC = hitCond('FACTNAME', 10); const nC = hitCond('NAME', 10);
  const tfc = targetFactCount!;
  // degree-0 targets: no fact signal at all -> FACTMAX cannot retrieve; report the count.
  const deg0 = tfc.filter((d) => d === 0).length;
  console.log(`  degree 0 (no held-out fact; fusion has no fact signal): n=${deg0}`);
  const degTable: Record<string, unknown> = { deg0: { n: deg0 } };
  for (const bin of BINS) {
    const idx = tfc.map((d, i) => (d >= bin.lo && d <= bin.hi ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 0) { console.log(`  bin ${bin.label.padEnd(4)}: n=0`); degTable[bin.label] = { n: 0 }; continue; }
    const keys = idx.map((i) => String(i));
    const sStrict: BootstrapResult = clusteredBootstrap(idx.map((i) => fnS[i]!), idx.map((i) => nS[i]!), keys);
    const sCond: BootstrapResult = clusteredBootstrap(idx.map((i) => fnC[i]!), idx.map((i) => nC[i]!), keys);
    console.log(`  bin ${bin.label.padEnd(4)}: n=${String(idx.length).padEnd(4)}  strict ${ciStr(sStrict)}   |  condensed ${ciStr(sCond)}`);
    degTable[bin.label] = {
      n: idx.length,
      nameStrict: mean(idx.map((i) => nS[i]!)), factnameStrict: mean(idx.map((i) => fnS[i]!)), strict: sStrict,
      nameCond: mean(idx.map((i) => nC[i]!)), factnameCond: mean(idx.map((i) => fnC[i]!)), cond: sCond,
    };
  }
  report.degree = degTable;

  console.log('');
  console.log('=== k-ladder (strict / condensed) ===');
  const perK: Record<string, unknown> = {};
  for (const k of [1, 5, 10, 20]) {
    perK[k] = { nameStrict: mean(hitStrict('NAME', k)), factnameStrict: mean(hitStrict('FACTNAME', k)), nameCond: mean(hitCond('NAME', k)), factnameCond: mean(hitCond('FACTNAME', k)) };
    console.log(`  R@${String(k).padEnd(3)} NAME ${mean(hitStrict('NAME', k)).toFixed(3)}/${mean(hitCond('NAME', k)).toFixed(3)}  FACTNAME ${mean(hitStrict('FACTNAME', k)).toFixed(3)}/${mean(hitCond('FACTNAME', k)).toFixed(3)}`);
  }
  report.perK = perK;

  writeFileSync(join(OUT, 'qbio-fusion-results.json'), JSON.stringify(report, null, 2));
  console.log(`\nartifact: ${join(OUT, 'qbio-fusion-results.json')}`);
  process.exit(0);
}
main();
