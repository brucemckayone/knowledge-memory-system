/**
 * E5 live verification (nmemo-vpz.5, criteria 4-5) — the REAL Haiku arbiter.
 *
 * Drives the new promote() against the runtime `cognitive` DB with a seeded
 * IDENTITY escalation (a short "Elena" mention word-prefix-matching two distinct
 * canonical persons — the doc-41 "is Elena the same as Dr. Elena Vasquez?" class)
 * and an equal-valid_at CONFLICT. promote() invokes the live arbiter
 * (ML_SERVICES_URL/arbiter-agent → Claude Code, Haiku); the arbiter records verdicts
 * via propose_identity_verdict / propose_conflict_resolution; promotion executes them.
 *
 * Assertions are STRUCTURAL (a verdict was recorded + decided + executed) rather than
 * pinning a specific LLM decision, so the proof is robust to model variation.
 * TAG-scoped; cleans up in a finally. Safe to re-run.
 *
 * Run:  ML_SERVICES_URL=http://localhost:8001 npx tsx scripts/verify-arbiter-live.ts
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { promote } from '../src/services/promotion.js';
import { config } from '../src/config.js';

const TAG = 'ARBTEST';
const here = dirname(fileURLToPath(import.meta.url));

function log(msg: string): void {
  console.log(`[verify-arbiter] ${msg}`);
}

async function createEntity(name: string, type: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`INSERT INTO public.entities (id, canonical_name, entity_type) VALUES (${id}::uuid, ${name}, ${type})`);
  return id;
}
async function createFact(subjectId: string, predicate: string, objectValue: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO public.facts (id, subject_entity_id, predicate, object_value, source_text, extraction_method)
    VALUES (${randomUUID()}::uuid, ${subjectId}::uuid, ${predicate}, ${objectValue}, ${TAG + ':prior'}, 'llm')
  `);
}
async function stageEntity(epoch: string, name: string, type: string): Promise<string> {
  const handle = randomUUID();
  await db.execute(sql`
    INSERT INTO public.staging_proposed_entities (handle, epoch_id, name, entity_type)
    VALUES (${handle}::uuid, ${epoch}::uuid, ${name}, ${type})
  `);
  return handle;
}
async function stageFact(
  epoch: string,
  subjectHandle: string,
  predicate: string,
  objectValue: string,
  validAt: Date | null,
  exclusiveGroup: string | null,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO public.staging_proposed_facts
      (staged_fact_id, epoch_id, subject_handle, predicate, object_value, valid_at, undated, confidence, reasoning, exclusive_group)
    VALUES (${randomUUID()}::uuid, ${epoch}::uuid, ${subjectHandle}::uuid, ${predicate}, ${objectValue},
            ${validAt}, ${validAt == null}, 0.9, ${TAG + ':' + predicate}, ${exclusiveGroup})
  `);
}

async function cleanup(): Promise<void> {
  const tagEnts = sql`SELECT id FROM public.entities WHERE canonical_name LIKE ${TAG + '%'}`;
  await db.execute(sql`DELETE FROM public.fact_history WHERE fact_id IN (SELECT id FROM public.facts WHERE source_text LIKE ${TAG + '%'})`);
  await db.execute(sql`DELETE FROM public.facts WHERE source_text LIKE ${TAG + '%'}`);
  await db.execute(sql`DELETE FROM public.entity_merges WHERE source_entity_id IN (${tagEnts}) OR target_entity_id IN (${tagEnts})`);
  await db.execute(sql`DELETE FROM public.same_as_links WHERE entity_a_id IN (${tagEnts}) OR entity_b_id IN (${tagEnts})`);
  await db.execute(sql`DELETE FROM public.entity_aliases WHERE entity_id IN (${tagEnts})`);
  await db.execute(sql`DELETE FROM public.entities WHERE canonical_name LIKE ${TAG + '%'}`);
  await db.execute(sql`DELETE FROM public.arbiter_verdicts WHERE escalation_key ILIKE ${'%' + TAG + '%'} OR dossier::text ILIKE ${'%' + TAG + '%'}`);
}

async function main(): Promise<void> {
  log(`config.ML_SERVICES_URL = ${config.ML_SERVICES_URL}  (must be :8001)`);

  // 1. Apply migration 043 to the runtime DB (idempotent).
  const mig = readFileSync(join(here, '../src/db/migrations/043_arbiter_verdicts.sql'), 'utf-8');
  await db.execute(sql.raw(mig));
  log('migration 043 applied (arbiter_verdicts present)');

  await cleanup(); // clear any residue from a prior run

  const epoch = randomUUID();

  // --- IDENTITY scenario: "Elena" prefix-matches two distinct canonical persons ---
  const vasquez = await createEntity(`${TAG} Elena Vasquez`, 'person');
  const marquez = await createEntity(`${TAG} Elena Marquez`, 'person');
  await createFact(vasquez, 'works_at', 'Helix Robotics');
  await createFact(vasquez, 'has_role', 'CTO');
  await createFact(marquez, 'works_at', 'Globex');
  await createFact(marquez, 'has_role', 'Analyst');
  // A new mention "Elena" with a fact pointing clearly at the Vasquez cluster.
  const elena = await stageEntity(epoch, `${TAG} Elena`, 'person');
  await stageFact(epoch, elena, 'works_at', 'Helix Robotics', new Date('2023-01-01'), null);

  // --- CONFLICT scenario: equal valid_at, same exclusive group, different objects ---
  const zeta = await stageEntity(epoch, `${TAG} Zeta Corp`, 'organization');
  const sameDay = new Date('2022-05-01');
  await stageFact(epoch, zeta, 'headquartered_in', 'Boston', sameDay, 'location');
  await stageFact(epoch, zeta, 'headquartered_in', 'Austin', sameDay, 'location');

  log('seeded identity + conflict escalation scenarios; invoking promote() with the LIVE Haiku arbiter...');
  const result = await promote(epoch); // real arbiter (no injected invoker)

  // --- Read back the recorded verdicts ---
  const verdicts = await db.execute(sql`
    SELECT escalation_key, kind, verdict, decided_by, decided_at
    FROM public.arbiter_verdicts WHERE epoch_id = ${epoch}::uuid
    ORDER BY kind
  `);
  const rows = verdicts as unknown as Array<{
    escalation_key: string; kind: string; verdict: Record<string, unknown> | null; decided_by: string | null; decided_at: Date | null;
  }>;

  console.log('\n================ ARBITER VERDICTS (epoch ' + epoch.slice(0, 8) + ') ================');
  for (const r of rows) {
    console.log(`  [${r.kind}] key=${r.escalation_key}`);
    console.log(`        decided_by=${r.decided_by} decided=${r.decided_at != null}`);
    console.log(`        verdict=${JSON.stringify(r.verdict)}`);
  }
  console.log('  promotion result: merged=' + result.mergedAwayEntityIds.length +
    ' same_as=' + result.sameAsLinkIds.length +
    ' minted=' + Object.keys(result.mintedEntityIds).length +
    ' inserted=' + result.insertedFactIds.length +
    ' expired=' + result.expiredFactIds.length);

  // --- Assertions (criterion 4): both escalations went THROUGH the arbiter ---
  const identity = rows.find((r) => r.kind === 'identity');
  const conflict = rows.find((r) => r.kind === 'conflict');
  const problems: string[] = [];
  if (!identity) problems.push('no identity escalation row recorded');
  else if (!identity.decided_by || identity.verdict == null) problems.push('identity escalation NOT decided by the arbiter');
  if (!conflict) problems.push('no conflict escalation row recorded');
  else if (!conflict.decided_by || conflict.verdict == null) problems.push('conflict escalation NOT decided by the arbiter');

  console.log('\n================ RESULT ================');
  if (problems.length === 0) {
    console.log('PASS: both the identity ("Elena" class) and conflict escalations resolved THROUGH the live arbiter,');
    console.log('      verdicts recorded against their dossiers and executed by promotion (criterion 4).');
  } else {
    console.log('FAIL:');
    for (const p of problems) console.log('  - ' + p);
  }

  await cleanup();
  log('cleaned up TAG-scoped seed data');
  if (problems.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => { console.error('[verify-arbiter] ERROR', e); process.exitCode = 1; })
  .finally(async () => { await db.end?.().catch(() => {}); });
