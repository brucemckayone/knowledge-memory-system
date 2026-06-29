/**
 * One-shot recovery: run the post-promotion CAUSAL PASS for an epoch whose
 * promote() ran but whose Phase-4 causal pass was skipped (e.g. promoted via
 * scripts/promote-epoch.ts, which only calls promote()). Symptom: causal_events
 * is populated but causal_edges = 0 — the events exist, but nothing turned them
 * into edges.
 *
 * runCausalPass(epochId, promotion) is gated on promotion.mintedCausalEventIds —
 * the set of events minted by THAT promotion (it loads them via
 * `inArray(causalEvents.id, mintedCausalEventIds)`). That set lived only in the
 * in-memory PromotionResult, which the promote-only recovery discarded. We
 * reconstruct it: this is safe ONLY right after a reset()+single-epoch promote,
 * where every row currently in causal_events belongs to that one epoch — so the
 * minted set == all current causal_event ids. (If the DB held other epochs' events
 * this reconstruction would over-scope; pass an explicit id set in that case.)
 *
 * runCausalPass reads only three PromotionResult fields (mintedCausalEventIds,
 * insertedFactIds, corroboratedFactIds — the last two only feed the fact-count
 * trigger), so we synthesise a minimal stub. The agent scope is hard-capped at
 * config.CAUSAL_PASS_SCOPE_CAP events; a large recovered epoch is truncated to
 * the cap (logged), so this mints edges over a bounded sample, not every event.
 *
 *   npx tsx scripts/run-causal-pass.ts <epoch_id>
 */

import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { runCausalPass } from '../src/services/causal-pass.js';
import type { PromotionResult } from '../src/services/promotion.js';

async function main(): Promise<void> {
  const epochId = process.argv[2];
  if (!epochId) {
    console.error('usage: tsx scripts/run-causal-pass.ts <epoch_id>');
    process.exit(2);
  }

  // postgres-js drizzle: db.execute() returns the rows directly as an array.
  const eventRows = (await db.execute(sql`SELECT id::text AS id FROM causal_events`)) as unknown as Array<{ id: string }>;
  const factRows = (await db.execute(sql`SELECT id::text AS id FROM facts`)) as unknown as Array<{ id: string }>;
  const mintedCausalEventIds = eventRows.map((r) => r.id);
  const insertedFactIds = factRows.map((r) => r.id);

  console.log(
    `[run-causal-pass] epoch=${epochId} reconstructed minted set: ` +
      `${mintedCausalEventIds.length} causal_event(s), ${insertedFactIds.length} fact(s)`,
  );
  if (mintedCausalEventIds.length === 0) {
    console.log('[run-causal-pass] no causal_events present — nothing to reason over.');
    return;
  }

  // Minimal stub — runCausalPass only reads these three fields.
  const promotion = {
    epochId,
    mintedCausalEventIds,
    insertedFactIds,
    corroboratedFactIds: [],
  } as unknown as PromotionResult;

  const res = await runCausalPass(epochId, promotion);
  console.log('[run-causal-pass] done:');
  console.log(`  trigger fired: ${res.ran}  (reasons: ${res.decision.reasons.join('; ') || 'none'})`);
  if (res.ran) {
    console.log(`  scope size (events reasoned over): ${res.scopeSize}`);
    console.log(`  causal edges created:  ${res.promotion?.created.length ?? 0}`);
    console.log(`  causal edges dropped:  ${res.promotion?.dropped.length ?? 0}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[run-causal-pass] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
