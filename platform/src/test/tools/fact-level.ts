/**
 * Fact-level retrieval — retrieval experiment #3 (queue #4).
 * FROZEN pre-registration: docs/architecture/single-graph/13-prereg-fact-level-retrieval.md
 *
 * Ranks entities by their best-matching FACT (stored fact_embedding), vs by name
 * vector (ARM-NAME). Held-out fact guard: for query (e, d), every fact arm
 * excludes facts sourced from d. Now a thin config over the shared retrieval-eval
 * engine (bead nmemo-u8j.2) — the bootstrap/oracle/RRF/pair-building/fact-loading
 * machinery lives in ./retrieval-eval, not here.
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/fact-level.ts
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
const REG_NAME_R10 = 0.20056497175141244;
const REG_N = 354;

async function main(): Promise<void> {
  const r = await runEval({
    label: 'fact-level',
    corpora: CORPORA,
    paths: { arcDir: ARC, corporaDir: CORPORA_DIR, docFileFor: { 'dal-nlp': 'corpus-A.json', 'dal-cv': 'corpus-B.json' } },
    frozenCachePath: join(OUT, 'embed-cache.json'),
    arms: ['NAME', 'FACTMAX', 'FACTMEAN', 'FACTNAME'],
    regression: { targets: { NAME: REG_NAME_R10 }, n: REG_N },
    degeneracyArm: 'FACTMAX',
  });

  const { n, hitStrict, hitCond, tri, pairKeys, corpusOf } = r;
  console.log('');
  console.log(`held-out fact guard: ${r.pairsWithExclusion}/${n} pairs excluded >=1 d-sourced fact`);
  console.log(`fact-arm retrievability ceiling: ${((n - r.noEligibleFact!) / n * 100).toFixed(1)}% of targets have >=1 eligible fact (${r.noEligibleFact} unretrievable)`);

  const report: Record<string, unknown> = {
    n, corpora: [...CORPORA], pairsWithExclusion: r.pairsWithExclusion, noEligibleFact: r.noEligibleFact,
    factmaxEqName: r.degeneracyOverlap,
    armsStrictR10: r.armStrictR(10), armsCondR10: r.armCondR(10),
  };

  console.log('');
  console.log('=== PRIMARY (strict): FACTMAX R@10 - ARM-NAME R@10 ===');
  const primary = tri(hitStrict('FACTMAX', 10), hitStrict('NAME', 10));
  console.log(`  byPair     ${ciStr(primary.byPair)}`);
  console.log(`  byEntity   ${ciStr(primary.byEntity)}`);
  console.log(`  byDocument ${ciStr(primary.byDocument)}`);
  report.primary = primary;

  console.log('');
  console.log('=== secondaries ===');
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
  report.secondaries = sec;

  console.log('');
  console.log('=== k-ladder (strict / condensed) ===');
  const perK: Record<string, unknown> = {};
  for (const k of [1, 5, 10, 20]) {
    const row = { nameStrict: mean(hitStrict('NAME', k)), factmaxStrict: mean(hitStrict('FACTMAX', k)), factmaxCond: mean(hitCond('FACTMAX', k)), nameCond: mean(hitCond('NAME', k)) };
    console.log(`  R@${String(k).padEnd(3)} NAME ${row.nameStrict.toFixed(3)}/${row.nameCond.toFixed(3)}  FACTMAX ${row.factmaxStrict.toFixed(3)}/${row.factmaxCond.toFixed(3)}`);
    perK[k] = row;
  }
  report.perK = perK;

  console.log('');
  console.log('=== per corpus (FACTMAX - NAME, strict R@10) ===');
  const perCorpus: Record<string, unknown> = {};
  for (const c of CORPORA) {
    const idx = corpusOf.map((x, i) => (x === c ? i : -1)).filter((i) => i >= 0);
    const fh = idx.map((i) => hitStrict('FACTMAX', 10)[i]!); const nh = idx.map((i) => hitStrict('NAME', 10)[i]!);
    const rr = clusteredBootstrap(fh, nh, idx.map((i) => String(i)));
    console.log(`  ${c}: n=${idx.length}  NAME ${mean(nh).toFixed(3)}  FACTMAX ${mean(fh).toFixed(3)}  ${ciStr(rr)}`);
    perCorpus[c] = { n: idx.length, name: mean(nh), factmax: mean(fh), ...rr };
  }
  report.perCorpus = perCorpus;

  // degree diagnostic (prereg §7 adversary task c)
  const tfc = r.targetFactCount!;
  const fmHit = hitStrict('FACTMAX', 10);
  const hitCounts = tfc.filter((_, i) => fmHit[i] === 1);
  const missCounts = tfc.filter((_, i) => fmHit[i] === 0);
  console.log('');
  console.log(`degree diagnostic: target fact-count (eligible) — FACTMAX hits mean ${mean(hitCounts).toFixed(1)} vs misses mean ${mean(missCounts).toFixed(1)}`);
  report.degree = { hitMeanFactCount: mean(hitCounts), missMeanFactCount: mean(missCounts) };

  writeFileSync(join(OUT, 'fact-level-results.json'), JSON.stringify(report, null, 2));
  console.log(`\nartifact: ${join(OUT, 'fact-level-results.json')}`);
  process.exit(0);
}
main();
