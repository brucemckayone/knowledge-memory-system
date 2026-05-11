/**
 * One-shot live verification for nmemo-dey.2 F3:
 * confirms save_reasoning_report sets entity_meta.last_reasoned_at
 * on the live `cognitive` database.
 *
 * Usage: pnpm tsx scripts/verify-f3-live.ts
 * Safe to delete after verification.
 */

import { db } from '../src/db/index.js';
import { entityMeta, entities, reasoningReports } from '../src/db/schema.js';
import { handleToolCall } from '../src/services/causal-agent.js';
import { eq, sql, isNotNull } from 'drizzle-orm';

async function main() {
  // Pick any real entity that has an entity_meta row.
  const [{ entityId }] = await db.execute<{ entityId: string }>(sql`
    SELECT em.entity_id AS "entityId"
    FROM public.entity_meta em
    LIMIT 1
  `);
  if (!entityId) throw new Error('No entity_meta rows in cognitive db — cannot verify');

  console.log(`[F3 verify] target entity_id = ${entityId}`);

  // Force last_reasoned_at NULL so we can prove the UPDATE fires.
  await db.execute(sql`
    UPDATE public.entity_meta SET last_reasoned_at = NULL WHERE entity_id = ${entityId}::uuid
  `);

  const before = await db.execute<{ last_reasoned_at: Date | null }>(sql`
    SELECT last_reasoned_at FROM public.entity_meta WHERE entity_id = ${entityId}::uuid
  `);
  console.log(`[F3 verify] before: last_reasoned_at = ${before[0]?.last_reasoned_at}`);

  // Call save_reasoning_report through the same dispatch path the agent uses.
  const out = await handleToolCall('save_reasoning_report', {
    mode: 'patrol',
    report: 'F3 live verification — safe to delete',
    entity_ids: [entityId],
    fact_ids: [],
    causal_edge_ids: [],
    actions_taken: { verify: true },
  });
  const { reportId } = JSON.parse(out);
  console.log(`[F3 verify] reportId = ${reportId}`);

  const after = await db.execute<{ last_reasoned_at: Date | null }>(sql`
    SELECT last_reasoned_at FROM public.entity_meta WHERE entity_id = ${entityId}::uuid
  `);
  console.log(`[F3 verify] after:  last_reasoned_at = ${after[0]?.last_reasoned_at}`);

  if (after[0]?.last_reasoned_at) {
    const ageMs = Date.now() - new Date(after[0].last_reasoned_at).getTime();
    if (ageMs < 60_000) {
      console.log(`[F3 verify] ✓ PASS — last_reasoned_at written ${ageMs}ms ago`);
    } else {
      console.log(`[F3 verify] ✗ FAIL — timestamp too old (${ageMs}ms)`);
      process.exit(1);
    }
  } else {
    console.log(`[F3 verify] ✗ FAIL — last_reasoned_at still NULL`);
    process.exit(1);
  }

  // Cleanup the verification report row.
  await db.execute(sql`DELETE FROM public.reasoning_reports WHERE id = ${reportId}::uuid`);
  console.log(`[F3 verify] cleanup OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
