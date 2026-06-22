/**
 * One-shot backfill of enriched embeddings for the canonical predicates
 * (truth-graph doc 42 §5, PC2/PC4). Run at deploy and before a benchmark run so
 * the promote-time predicate fold (predicate-resolve.ts) has candidates to match
 * against — without embeddings the fold is a graceful no-op.
 *
 * Honours DATABASE_URL + ML_SERVICES_URL from the environment.
 *   npx tsx scripts/backfill-predicate-embeddings.ts            # embed only NULL rows
 *   npx tsx scripts/backfill-predicate-embeddings.ts --force    # re-embed all canonicals
 */

import { backfillPredicateEmbeddings } from '../src/services/predicate-embeddings.js';

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const res = await backfillPredicateEmbeddings({ force });
  console.log(`[backfill-predicate-embeddings] embedded ${res.embedded} canonical predicate(s) (force=${force})`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[backfill-predicate-embeddings] failed:', err);
    process.exit(1);
  },
);
