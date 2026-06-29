/**
 * One-shot recovery: run the deterministic PROMOTE gate for an existing staging
 * epoch. Use when an epoch batch stored + proposed into staging but died before
 * reaching its in-pipeline promote() (e.g. the HTTP client was killed mid-batch,
 * leaving staging_proposed_{facts,entities} orphaned under that epoch_id).
 *
 * promote(epochId) is the SAME call runEpochBatch makes (pipeline.ts) — it reads
 * whatever is staged for the epoch, canonicalizes predicates, resolves identity +
 * exclusive-group supersession + triple dedup (surfacing arbiter escalations), and
 * writes canonical in one transaction. It keys purely on epoch_id and has no
 * "all chunks proposed" precondition, so promoting a PARTIAL staged set is safe:
 * promotion always reconciles against prior canonical, and a later top-up epoch
 * converges to the same graph (order-independence is a design property).
 *
 * Honours DATABASE_URL + ML_SERVICES_URL from the environment (platform/.env).
 *   npx tsx scripts/promote-epoch.ts <epoch_id>
 */

import { promote } from '../src/services/promotion.js';

async function main(): Promise<void> {
  const epochId = process.argv[2];
  if (!epochId) {
    console.error('usage: tsx scripts/promote-epoch.ts <epoch_id>');
    process.exit(2);
  }

  console.log(`[promote-epoch] promoting staging epoch ${epochId} ...`);
  const result = await promote(epochId);

  console.log('[promote-epoch] done:');
  console.log(`  minted entities:    ${Object.keys(result.mintedEntityIds).length}`);
  console.log(`  inserted facts:     ${result.insertedFactIds.length}`);
  console.log(`  expired (superseded): ${result.expiredFactIds.length}`);
  console.log(`  corroborated facts: ${result.corroboratedFactIds.length}`);
  console.log(`  merged-away entities: ${result.mergedAwayEntityIds.length}`);
  console.log(`  same-as links:      ${result.sameAsLinkIds.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[promote-epoch] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
