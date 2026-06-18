/**
 * PC4 (nmemo-213.4) — promote-time predicate canonicalization fold ("the spine").
 *
 * End-to-end against testDb + ml-services: stages facts with synonym / novel
 * predicates, runs promote(), and asserts the fold canonicalized them so dedup
 * and exclusive-group supersession fire on the CANONICAL predicate, and a
 * genuinely new relation mints a candidate. Requires pgvector + Ollama +
 * ml-services (the resolve endpoint). Backfills the canonical embeddings in
 * beforeAll so the fold has candidates.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testDb, skipCtx, isMLServiceAvailable, hasVectorExtension } from '../setup.js';
import { promote } from '../../services/promotion.js';
import { backfillPredicateEmbeddings } from '../../services/predicate-embeddings.js';

const TAG = 'predfold';
const MINTED = 'enjoys_hiking_with';

async function clean(): Promise<void> {
  await testDb.unsafe(`DELETE FROM fact_history WHERE fact_id IN (SELECT id FROM facts WHERE source_text LIKE '${TAG}%')`);
  await testDb.unsafe(`DELETE FROM causal_events WHERE fact_id IN (SELECT id FROM facts WHERE source_text LIKE '${TAG}%')`);
  await testDb.unsafe(`DELETE FROM facts WHERE source_text LIKE '${TAG}%'`);
  await testDb.unsafe(`DELETE FROM entities WHERE canonical_name LIKE '${TAG}%'`);
  await testDb.unsafe('DELETE FROM staging_proposed_facts');
  await testDb.unsafe('DELETE FROM staging_proposed_entities');
}

async function stageEntity(epochId: string, name: string, type: string): Promise<string> {
  const handle = randomUUID();
  await testDb`
    INSERT INTO staging_proposed_entities (handle, epoch_id, name, entity_type)
    VALUES (${handle}::uuid, ${epochId}::uuid, ${name}, ${type})
  `;
  return handle;
}

async function stageFact(
  epochId: string,
  subjectHandle: string,
  predicate: string,
  opts: { objectHandle?: string; objectValue?: string; validAt?: Date },
): Promise<void> {
  const validAt = opts.validAt ?? null;
  await testDb`
    INSERT INTO staging_proposed_facts
      (staged_fact_id, epoch_id, subject_handle, predicate, object_handle, object_value,
       valid_at, undated, confidence, reasoning)
    VALUES
      (${randomUUID()}::uuid, ${epochId}::uuid, ${subjectHandle}::uuid, ${predicate},
       ${opts.objectHandle ?? null}::uuid, ${opts.objectValue ?? null},
       ${validAt}, ${validAt == null}, 0.9, ${TAG + ':' + predicate})
  `;
}

async function aliceFacts(): Promise<Array<{ predicate: string; object_value: string | null; active: boolean }>> {
  // Query by source_text tag (robust to how promotion normalises minted entity
  // names). All staged facts here have subject = Alice and a TAG-tagged reasoning
  // that promotion writes to facts.source_text.
  const rows = await testDb`
    SELECT f.predicate, f.object_value, (f.expired_at IS NULL) AS active
    FROM facts f
    WHERE f.source_text LIKE ${TAG + '%'}
    ORDER BY f.valid_at NULLS FIRST
  `;
  return rows as Array<{ predicate: string; object_value: string | null; active: boolean }>;
}

describe('PC4 — promote-time predicate fold', () => {
  beforeAll(async (ctx) => {
    if (!hasVectorExtension || !(await isMLServiceAvailable())) {
      skipCtx(ctx);
      return;
    }
    try {
      await testDb`SELECT subject_type FROM fact_predicates LIMIT 1`;
      await backfillPredicateEmbeddings(); // ensure the fold has candidates
    } catch {
      skipCtx(ctx);
    }
  });

  beforeEach(clean);

  afterAll(async () => {
    await clean();
    // Un-pollute the shared test DB: drop the minted predicate and clear the
    // embeddings so unrelated promote tests see a fresh (fold-inert) registry.
    await testDb.unsafe(`DELETE FROM fact_predicates WHERE predicate = '${MINTED}'`);
    await testDb`UPDATE fact_predicates SET embedding = NULL`;
  });

  it('folds synonym predicates to one canonical and dedups (works_at + employed_at)', async () => {
    const epochId = randomUUID();
    const alice = await stageEntity(epochId, `${TAG} Alice`, 'person');
    const acme = await stageEntity(epochId, `${TAG} Acme`, 'organization');
    await stageFact(epochId, alice, 'employed_at', { objectHandle: acme, validAt: new Date('2020-01-01') });
    await stageFact(epochId, alice, 'works_at', { objectHandle: acme, validAt: new Date('2021-01-01') });

    await promote(epochId);

    const facts = await aliceFacts();
    // Both canonicalized to works_at -> identical triple -> one active fact.
    expect(facts.length).toBe(1);
    expect(facts[0]!.predicate).toBe('works_at');
    expect(facts[0]!.active).toBe(true);
  });

  it('folds a synonym into an exclusive group and supersedes (title + job_title)', async () => {
    const epochId = randomUUID();
    const alice = await stageEntity(epochId, `${TAG} Alice`, 'person');
    await stageFact(epochId, alice, 'title', { objectValue: 'Engineer', validAt: new Date('2020-01-01') });
    await stageFact(epochId, alice, 'job_title', { objectValue: 'Senior Engineer', validAt: new Date('2021-01-01') });

    await promote(epochId);

    const facts = await aliceFacts();
    // 'title' canonicalizes to job_title; same exclusive group, different value ->
    // the later one wins, the earlier is expired.
    expect(facts.every((f) => f.predicate === 'job_title')).toBe(true);
    const active = facts.filter((f) => f.active);
    expect(active.length).toBe(1);
    expect(active[0]!.object_value).toBe('Senior Engineer');
  });

  it('mints a candidate for a genuinely novel relation', async () => {
    const epochId = randomUUID();
    const alice = await stageEntity(epochId, `${TAG} Alice`, 'person');
    const bob = await stageEntity(epochId, `${TAG} Bob`, 'person');
    await stageFact(epochId, alice, MINTED, { objectHandle: bob });

    await promote(epochId);

    const pred = await testDb`SELECT status, is_canonical FROM fact_predicates WHERE predicate = ${MINTED}`;
    expect(pred.length).toBe(1);
    expect(pred[0]!.status).toBe('staging');
    expect(pred[0]!.is_canonical).toBe(false);

    const facts = await aliceFacts();
    expect(facts.length).toBe(1);
    expect(facts[0]!.predicate).toBe(MINTED);
  });
});
