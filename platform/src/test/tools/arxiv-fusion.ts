/**
 * R4 — entity+fact fusion, confirmation on the independent arxiv extraction.
 * FROZEN pre-registration: docs/architecture/single-graph/15-prereg-fusion-confirmation.md
 *
 * Same machinery as fact-level (R3), new substrate: arxiv-nlp / arxiv-cv (same
 * 294 papers, a DIFFERENT extraction — descriptions NULL). Query vectors from the
 * frozen cache; arxiv entity NAME vectors + any arxiv query docs not in the frozen
 * cache are embedded via Ollama into a SEPARATE writable cache so the frozen doc-05
 * cache is untouched. Now a thin config over the shared retrieval-eval engine
 * (bead nmemo-u8j.2).
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/arxiv-fusion.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clusteredBootstrap, ciStr, triStr, mean } from './retrieval-eval/core.js';
import { runEval } from './retrieval-eval/harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARC = join(HERE, '../../../../docs/architecture/cross-corpus-audit/multihop-artifacts');
const CORPORA_DIR = join(HERE, '../../../../docs/architecture/cross-corpus-audit/convergence-artifacts');
const OUT = join(HERE, '../../../../docs/architecture/single-graph/prereg-artifacts');
const CORPORA = ['arxiv-nlp', 'arxiv-cv'] as const;

async function main(): Promise<void> {
  const r = await runEval({
    label: 'arxiv-fusion',
    corpora: CORPORA,
    paths: { arcDir: ARC, corporaDir: CORPORA_DIR, docFileFor: { 'arxiv-nlp': 'corpus-A.json', 'arxiv-cv': 'corpus-B.json' } },
    frozenCachePath: join(OUT, 'embed-cache.json'),
    writableCachePath: join(OUT, 'arxiv-embed-cache.json'),
    arms: ['NAME', 'FACTMAX', 'FACTNAME'],
    ensureEmbedEntityNames: true,
    ensureEmbedQueryDocs: true,
    underpoweredMin: 100,
    factNormStrict: true,
    degeneracyArm: 'FACTMAX',
  });

  const { n, hitStrict, hitCond, tri, corpusOf } = r;
  console.log('');
  console.log(`n=${n}  held-out guard fired on ${r.pairsWithExclusion}/${n} pairs  retrievability ${((n - r.noEligibleFact!) / n * 100).toFixed(1)}%`);

  const report: Record<string, unknown> = {
    n, corpora: [...CORPORA], pairsWithExclusion: r.pairsWithExclusion, noEligible: r.noEligibleFact,
    factmaxEqName: r.degeneracyOverlap,
    armsStrictR10: r.armStrictR(10), armsCondR10: r.armCondR(10),
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
    const rr = clusteredBootstrap(fh, nh, idx.map((i) => String(i)));
    console.log(`  ${c}: n=${idx.length}  NAME ${mean(nh).toFixed(3)}  FACTNAME ${mean(fh).toFixed(3)}  ${ciStr(rr)}`);
    perCorpus[c] = { n: idx.length, name: mean(nh), factname: mean(fh), ...rr };
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
