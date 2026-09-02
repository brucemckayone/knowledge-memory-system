/**
 * Supporting analysis for prereg-24 (nmemo-u8j.3): the ARXIV per-degree lift curve,
 * to test the blind adversary's decomposition — does q-bio's null come from the lever
 * failing, or from a degree-MIX difference (same per-bin curve, different bin weights)?
 *
 * Mirrors qbio-fusion.ts's degree block on the arxiv corpora (arxiv-nlp + arxiv-cv),
 * reusing the warm arxiv-embed-cache.json. Ollama-only (no Claude). NOT a pre-registered
 * gate — post-hoc supporting analysis introduced by the adversary; reproduced here so the
 * cross-domain comparison is banked from a committed tool, not a deleted temp script.
 *
 * Run:
 *   cd platform && DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test npx tsx src/test/tools/arxiv-degree.ts
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

const BINS: Array<{ label: string; lo: number; hi: number }> = [
  { label: '1', lo: 1, hi: 1 },
  { label: '2-3', lo: 2, hi: 3 },
  { label: '4-7', lo: 4, hi: 7 },
  { label: '8+', lo: 8, hi: Infinity },
];

async function main(): Promise<void> {
  const r = await runEval({
    label: 'arxiv-degree',
    corpora: ['arxiv-nlp', 'arxiv-cv'],
    paths: { arcDir: ARC, corporaDir: CORPORA_DIR, docFileFor: { 'arxiv-nlp': 'corpus-A.json', 'arxiv-cv': 'corpus-B.json' } },
    frozenCachePath: join(OUT, 'embed-cache.json'),
    writableCachePath: join(OUT, 'arxiv-embed-cache.json'),
    arms: ['NAME', 'FACTMAX', 'FACTNAME'],
    ensureEmbedEntityNames: true,
    ensureEmbedQueryDocs: true,
    factNormStrict: true,
  });

  const fnS = r.hitStrict('FACTNAME', 10); const nS = r.hitStrict('NAME', 10);
  const tfc = r.targetFactCount!;
  console.log(`\nn=${r.n}  (arxiv-nlp + arxiv-cv)`);
  console.log('=== ARXIV degree-stratified lift (FACTNAME - NAME, strict R@10) on HELD-OUT fact-degree ===');
  const table: Record<string, unknown> = {};
  let lowN = 0; let highN = 0;
  for (const bin of BINS) {
    const idx = tfc.map((d, i) => (d >= bin.lo && d <= bin.hi ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 0) { console.log(`  bin ${bin.label.padEnd(4)}: n=0`); table[bin.label] = { n: 0 }; continue; }
    const b = clusteredBootstrap(idx.map((i) => fnS[i]!), idx.map((i) => nS[i]!), idx.map((i) => String(i)));
    console.log(`  bin ${bin.label.padEnd(4)}: n=${String(idx.length).padEnd(4)}  NAME ${mean(idx.map((i) => nS[i]!)).toFixed(3)}  FACTNAME ${mean(idx.map((i) => fnS[i]!)).toFixed(3)}  ${ciStr(b)}`);
    table[bin.label] = { n: idx.length, nameStrict: mean(idx.map((i) => nS[i]!)), factnameStrict: mean(idx.map((i) => fnS[i]!)), strict: b };
    if (bin.label === '1' || bin.label === '2-3') lowN += idx.length;
    if (bin.label === '8+') highN += idx.length;
  }
  console.log(`\n  query-mix: low(1..3) = ${lowN}/${r.n} = ${(100 * lowN / r.n).toFixed(0)}%   high(8+) = ${highN}/${r.n} = ${(100 * highN / r.n).toFixed(0)}%`);
  writeFileSync(join(OUT, 'arxiv-degree-results.json'), JSON.stringify({ n: r.n, degree: table, lowFrac: lowN / r.n, highFrac: highN / r.n }, null, 2));
  console.log(`\nartifact: ${join(OUT, 'arxiv-degree-results.json')}`);
  process.exit(0);
}
main();
