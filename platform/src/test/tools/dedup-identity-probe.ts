/**
 * dedup-identity-probe.ts — nmemo-asf.5 (Phase 1.4): DETERMINISTIC proof that entity
 * identity is now (name, corpus) with entity_type demoted to a first-seen ATTRIBUTE, on
 * BOTH ingest arms, and that dedup is corpus-isolated (nmemo-cki). No LLM / no Claude:
 * the serial arm is exercised via createEntity directly; the epoch arm via hand-seeded
 * staging + the real promote() (same pattern as promote-probe.ts). Self-cleaning scratch
 * corpora. Run from platform/:
 *
 *   DATABASE_URL=postgres://cognitive:cognitive@127.0.0.1:5433/cognitive_test \
 *     ML_SERVICES_URL=http://localhost:8000 QDRANT_URL=http://localhost:6335 \
 *     QDRANT_COLLECTION=cognitive_test NODE_ENV=test EMBED_MODEL=nomic-embed-text \
 *     npx tsx src/test/tools/dedup-identity-probe.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { createEntity } from '../../services/entities.js';
import { promote } from '../../services/promotion.js';

const SA = '_dedup_probe_a';
const SB = '_dedup_probe_b';
const EC = '_dedup_probe_epoch';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function nameCount(corpus: string, name: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM public.entities WHERE corpus_id = ${corpus} AND lower(canonical_name) = ${name.toLowerCase()}
  `)) as unknown as Array<{ n: number }>;
  return rows[0]!.n;
}

async function cleanup(): Promise<void> {
  const corpora = sql`(${SA}, ${SB}, ${EC})`;
  await db.execute(sql`DELETE FROM public.causal_edges WHERE cause_event_id IN (SELECT id FROM public.causal_events WHERE corpus_id IN ${corpora}) OR effect_event_id IN (SELECT id FROM public.causal_events WHERE corpus_id IN ${corpora})`);
  await db.execute(sql`DELETE FROM public.fact_history WHERE fact_id IN (SELECT id FROM public.facts WHERE corpus_id IN ${corpora})`);
  await db.execute(sql`DELETE FROM public.causal_events WHERE corpus_id IN ${corpora}`);
  await db.execute(sql`DELETE FROM public.facts WHERE corpus_id IN ${corpora}`);
  await db.execute(sql`DELETE FROM public.entities WHERE corpus_id IN ${corpora}`);
  await db.execute(sql`DELETE FROM public.staging_proposed_facts WHERE source_id::text LIKE '_dedup%' OR epoch_id IN (SELECT epoch_id FROM public.staging_proposed_entities WHERE name LIKE 'ZZDedup%')`);
  await db.execute(sql`DELETE FROM public.staging_proposed_entities WHERE name LIKE 'ZZDedup%'`);
}

async function main(): Promise<void> {
  const run = randomUUID().slice(0, 8);
  console.log(`[dedup-identity-probe] run=${run}`);
  await cleanup();

  try {
    // ===== SERIAL ARM (createEntity) =====
    const sName = `ZZDedupSerial ${run}`;
    // same name, two DIFFERENT types, same corpus -> ONE entity (type is not identity)
    const e1 = await createEntity({ name: sName, type: 'model', corpusId: SA });
    const e2 = await createEntity({ name: sName, type: 'tool', corpusId: SA });
    assert(!e1.existed, 'serial: first createEntity mints (existed=false)');
    assert(e2.existed && e2.id === e1.id, 'serial: same name + DIFFERENT type + same corpus -> SAME entity (type demoted to attribute)');
    assert((await nameCount(SA, sName)) === 1, 'serial: exactly ONE row for the name in corpus A');
    // same name, same type, DIFFERENT corpus -> a SEPARATE entity (nmemo-cki isolation)
    const e3 = await createEntity({ name: sName, type: 'model', corpusId: SB });
    assert(!e3.existed && e3.id !== e1.id, 'serial: same name in a DIFFERENT corpus -> separate entity (corpus-scoped dedup, nmemo-cki)');
    assert((await nameCount(SB, sName)) === 1 && (await nameCount(SA, sName)) === 1, 'serial: one row per corpus, not collapsed across corpora');

    // ===== EPOCH ARM (promote over hand-seeded staging) =====
    const eName = `ZZDedupEpoch ${run}`;
    const epochId = randomUUID();
    const sourceId = randomUUID();
    const h1 = randomUUID();
    const h2 = randomUUID();
    // two staged entities: SAME name, DIFFERENT type -> the planner makes two (type,norm)
    // clusters; the mint-idempotency query must converge them onto one canonical row.
    await db.execute(sql`INSERT INTO public.staging_proposed_entities (handle, epoch_id, source_id, name, entity_type, summary) VALUES (${h1}::uuid, ${epochId}::uuid, ${sourceId}::uuid, ${eName}, 'model', 'epoch dedup subject A')`);
    await db.execute(sql`INSERT INTO public.staging_proposed_entities (handle, epoch_id, source_id, name, entity_type, summary) VALUES (${h2}::uuid, ${epochId}::uuid, ${sourceId}::uuid, ${eName}, 'tool', 'epoch dedup subject B')`);
    await db.execute(sql`INSERT INTO public.staging_proposed_facts (epoch_id, source_id, subject_handle, predicate, object_value, valid_at, undated, chunk_index, confidence, reasoning) VALUES (${epochId}::uuid, ${sourceId}::uuid, ${h1}::uuid, 'p_alpha', 'V1', '2026-01-01T00:00:00Z', false, 0, 0.9, ${'reason A ' + run})`);
    await db.execute(sql`INSERT INTO public.staging_proposed_facts (epoch_id, source_id, subject_handle, predicate, object_value, valid_at, undated, chunk_index, confidence, reasoning) VALUES (${epochId}::uuid, ${sourceId}::uuid, ${h2}::uuid, 'p_beta', 'V2', '2026-01-01T00:00:00Z', false, 0, 0.9, ${'reason B ' + run})`);

    await promote(epochId, { corpusId: EC });

    assert((await nameCount(EC, eName)) === 1, 'epoch: same name under TWO types promotes to ONE canonical entity (fragmentation ratchet killed)');
    const factSubjRows = (await db.execute(sql`
      SELECT count(*)::int AS facts, count(DISTINCT subject_entity_id)::int AS subjects
      FROM public.facts WHERE corpus_id = ${EC}
    `)) as unknown as Array<{ facts: number; subjects: number }>;
    assert(factSubjRows[0]!.facts === 2, `epoch: both staged facts promoted (got ${factSubjRows[0]!.facts})`);
    assert(factSubjRows[0]!.subjects === 1, 'epoch: both facts resolve to the SINGLE collapsed entity (handles converged via mintedEntityIds)');

    console.log('\n[dedup-identity-probe] RESULT: PASS — identity = (name, corpus) on both arms; entity_type is a first-seen attribute; dedup is corpus-isolated.');
  } finally {
    await cleanup();
    const left = (await db.execute(sql`
      SELECT (SELECT count(*) FROM public.entities WHERE corpus_id IN (${SA}, ${SB}, ${EC})) AS entities,
             (SELECT count(*) FROM public.facts WHERE corpus_id IN (${SA}, ${SB}, ${EC})) AS facts
    `)) as unknown as Array<{ entities: number; facts: number }>;
    console.log(`[dedup-identity-probe] cleanup: leftover entities=${left[0]!.entities} facts=${left[0]!.facts} (all must be 0)`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
