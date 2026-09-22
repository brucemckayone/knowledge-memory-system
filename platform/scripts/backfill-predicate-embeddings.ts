/**
 * One-shot backfill of enriched embeddings for the canonical predicates
 * (truth-graph doc 42 §5, PC2/PC4). Populating these is what ARMS the
 * promote-time predicate fold (predicate-resolve.ts) — without embeddings the
 * fold is a graceful no-op.
 *
 * DO NOT RUN THIS CASUALLY. cross-corpus-audit doc 41 §7 measured the fold at a
 * 3.7% predicate reduction against a 60% PASS bar, with 0.43 merge precision on
 * the decidable subset; a bad merge is lossy and unrecoverable. The fold is OFF
 * by decision of record, so this script requires the same explicit opt-in as the
 * promote path (`PREDICATE_FOLD_ENABLED=true`) rather than silently arming it.
 *
 * Honours DATABASE_URL + ML_SERVICES_URL from the environment.
 *   PREDICATE_FOLD_ENABLED=true npx tsx scripts/backfill-predicate-embeddings.ts         # NULL rows
 *   PREDICATE_FOLD_ENABLED=true npx tsx scripts/backfill-predicate-embeddings.ts --force # re-embed all
 */

import { config } from '../src/config.js';
import { backfillPredicateEmbeddings } from '../src/services/predicate-embeddings.js';

async function main(): Promise<void> {
  if (!config.PREDICATE_FOLD_ENABLED) {
    console.error(
      '[backfill-predicate-embeddings] REFUSING TO RUN. Backfilling these embeddings arms the\n' +
        '  promote-time predicate fold, which doc 41 §7 measured at 3.7% reduction (60% bar) and\n' +
        '  0.43 merge precision — net-harmful as calibrated, and OFF by decision of record.\n' +
        '  Re-run with PREDICATE_FOLD_ENABLED=true only with a fresh pre-registration.',
    );
    process.exit(1);
  }
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
