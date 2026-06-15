/**
 * E3 (nmemo-vpz.3) — promotion against testDb (doc 41 §5 f–g). Encodes the
 * bead's DB-side acceptance criteria the pure planner unit test can't reach:
 *
 *   (1) promote() writes canonical in ONE transaction with full audit rows.
 *   (3) helix / helix-robotics class duplicates merge at promotion (nmemo-wyb).
 *   (4) no FK violations when a fact references a freshly-proposed entity that
 *       only exists after promotion mints it (nmemo-3bp — staging removes the
 *       pre-reconciliation-id write race).
 *   (5) a failed promotion mid-transaction leaves canonical untouched; a retry
 *       succeeds idempotently (corroborates rather than duplicating).
 *
 * The order-independence litmus (criterion 2) is proven DB-free in
 * promotion-plan.unit.test.ts.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testDb } from '../setup.js';
import { promote, applyPromotion } from '../../services/promotion.js';
import type { PromotionPlan } from '../../services/promotion-plan.js';

const TAG = 'promtest';

async function clean(): Promise<void> {
  // fact_history → facts (no cascade); facts.subject_entity_id is RESTRICT (mig
  // 038). Delete history by fact_id (promotion's audit rows aren't TAG-reasoned),
  // then facts, then entities.
  await testDb.unsafe(
    `DELETE FROM fact_history WHERE fact_id IN (SELECT id FROM facts WHERE source_text LIKE '${TAG}%')`,
  );
  await testDb.unsafe(`DELETE FROM facts WHERE source_text LIKE '${TAG}%'`);
  await testDb.unsafe(`DELETE FROM entities WHERE canonical_name LIKE '${TAG}%'`);
  await testDb.unsafe('DELETE FROM staging_proposed_facts');
  await testDb.unsafe('DELETE FROM staging_proposed_entities');
}

async function stageEntity(
  epochId: string,
  name: string,
  type: string,
  anchorCanonicalId?: string,
): Promise<string> {
  const handle = randomUUID();
  await testDb`
    INSERT INTO staging_proposed_entities (handle, epoch_id, name, entity_type, anchor_canonical_id)
    VALUES (${handle}::uuid, ${epochId}::uuid, ${name}, ${type}, ${anchorCanonicalId ?? null}::uuid)
  `;
  return handle;
}

async function stageFact(
  epochId: string,
  subjectHandle: string,
  predicate: string,
  opts: {
    objectHandle?: string;
    objectValue?: string;
    validAt?: Date;
    chunkIndex?: number;
    confidence?: number;
    exclusiveGroup?: string;
    supersedesFactId?: string;
  },
): Promise<string> {
  const id = randomUUID();
  const validAt = opts.validAt ?? null;
  await testDb`
    INSERT INTO staging_proposed_facts
      (staged_fact_id, epoch_id, subject_handle, predicate, object_handle, object_value,
       valid_at, undated, chunk_index, confidence, reasoning, exclusive_group, supersedes_fact_id)
    VALUES
      (${id}::uuid, ${epochId}::uuid, ${subjectHandle}::uuid, ${predicate},
       ${opts.objectHandle ?? null}::uuid, ${opts.objectValue ?? null},
       ${validAt}, ${validAt == null}, ${opts.chunkIndex ?? null}, ${opts.confidence ?? 0.9},
       ${TAG + ':' + predicate}, ${opts.exclusiveGroup ?? null}, ${opts.supersedesFactId ?? null}::uuid)
  `;
  return id;
}

describe('promotion against testDb (nmemo-vpz.3 / E3)', () => {
  beforeEach(clean);
  afterAll(clean);

  it('merges helix/helix-robotics and writes canonical + audit rows (criteria 1, 3)', async () => {
    const epochId = randomUUID();
    const helix = await stageEntity(epochId, `${TAG} Helix`, 'organization');
    const helixR = await stageEntity(epochId, `${TAG} Helix Robotics`, 'organization');
    await stageFact(epochId, helixR, 'headquartered_in', {
      objectValue: 'Boston',
      validAt: new Date('2020-01-01'),
      exclusiveGroup: 'location',
    });
    await stageFact(epochId, helix, 'relocated_to', {
      objectValue: 'Austin',
      validAt: new Date('2023-01-01'),
      exclusiveGroup: 'location',
    });

    const result = await promote(epochId);

    // (3) the two helix proposals collapsed to ONE canonical entity.
    expect(Object.keys(result.mintedEntityIds)).toHaveLength(1);
    const entRows = await testDb`SELECT id, canonical_name FROM entities WHERE canonical_name LIKE ${TAG + '%'}`;
    expect(entRows).toHaveLength(1);
    const entityId = (entRows[0] as { id: string }).id;

    // (1) supersession: exactly ONE active location fact (Austin, latest valid).
    const active = await testDb`
      SELECT object_value FROM facts WHERE subject_entity_id = ${entityId}::uuid AND expired_at IS NULL
    `;
    expect(active).toHaveLength(1);
    expect((active[0] as { object_value: string }).object_value).toBe('Austin');

    // (1) audit rows exist and are stamped actor='promotion'.
    const audit = await testDb`
      SELECT DISTINCT actor FROM fact_history fh
      JOIN facts f ON f.id = fh.fact_id
      WHERE f.subject_entity_id = ${entityId}::uuid
    `;
    expect(audit.map((r) => (r as { actor: string }).actor)).toContain('promotion');
  });

  it('inserts a fact referencing a freshly-proposed object entity with NO FK violation (criterion 4)', async () => {
    const epochId = randomUUID();
    const elena = await stageEntity(epochId, `${TAG} Elena`, 'person');
    const helix = await stageEntity(epochId, `${TAG} Helix Co`, 'organization');
    // Both subject and object are fresh (no canonical id yet) — the exact case
    // that FK-violated under the old per-chunk write path (nmemo-3bp).
    await stageFact(epochId, elena, 'works_at', { objectHandle: helix, validAt: new Date('2022-01-01') });

    const result = await promote(epochId); // must not throw

    expect(Object.keys(result.mintedEntityIds)).toHaveLength(2);
    expect(result.insertedFactIds).toHaveLength(1);
    const factRow = await testDb`SELECT object_entity_id FROM facts WHERE id = ${result.insertedFactIds[0]!}::uuid`;
    expect((factRow[0] as { object_entity_id: string | null }).object_entity_id).not.toBeNull();
  });

  it('is idempotent on a double-fire: re-promoting the same epoch creates no duplicates (criterion 5)', async () => {
    const epochId = randomUUID();
    const helix = await stageEntity(epochId, `${TAG} Helix Idem`, 'organization');
    await stageFact(epochId, helix, 'founded_in', { objectValue: '2015' });

    await promote(epochId);
    const after1 = await testDb`SELECT count(*)::int AS n FROM entities WHERE canonical_name LIKE ${TAG + '%'}`;
    const facts1 = await testDb`SELECT count(*)::int AS n FROM facts WHERE source_text LIKE ${TAG + '%'}`;

    await promote(epochId); // double-fire
    const after2 = await testDb`SELECT count(*)::int AS n FROM entities WHERE canonical_name LIKE ${TAG + '%'}`;
    const facts2 = await testDb`SELECT count(*)::int AS n FROM facts WHERE source_text LIKE ${TAG + '%'}`;

    expect((after2[0] as { n: number }).n).toBe((after1[0] as { n: number }).n);
    expect((facts2[0] as { n: number }).n).toBe((facts1[0] as { n: number }).n);
  });

  it('surfaces a proposer supersession hint on the plan, loaded from staging (E4, criterion 3)', async () => {
    // Epoch 0: establish a prior-canonical HQ (Boston, 2019).
    const epoch0 = randomUUID();
    const helix0 = await stageEntity(epoch0, `${TAG} HintCo`, 'organization');
    await stageFact(epoch0, helix0, 'headquartered_in', {
      objectValue: 'Boston', validAt: new Date('2019-01-01'), exclusiveGroup: 'location',
    });
    await promote(epoch0);

    const priorRows = await testDb`
      SELECT id FROM facts WHERE source_text LIKE ${TAG + '%'} AND object_value = 'Boston'
    `;
    const priorFactId = (priorRows[0] as { id: string }).id;
    const canonRows = await testDb`SELECT id FROM entities WHERE canonical_name LIKE ${TAG + '%'}`;
    const canonId = (canonRows[0] as { id: string }).id;

    // Epoch 1: anchored proposal with a later-valid HQ + a hint at the prior fact.
    const epoch1 = randomUUID();
    const helix1 = await stageEntity(epoch1, `${TAG} HintCo`, 'organization', canonId);
    await stageFact(epoch1, helix1, 'headquartered_in', {
      objectValue: 'Austin', validAt: new Date('2024-01-01'), exclusiveGroup: 'location',
      supersedesFactId: priorFactId,
    });

    const result = await promote(epoch1);

    // The hint round-tripped staging -> loader -> planner, cross-checked against
    // the deterministic order (which also expired the prior fact).
    expect(result.plan.supersessionHints).toHaveLength(1);
    expect(result.plan.supersessionHints[0]!.supersedesFactId).toBe(priorFactId);
    expect(result.plan.supersessionHints[0]!.agreed).toBe(true);
    const prior = await testDb`SELECT expired_at FROM facts WHERE id = ${priorFactId}::uuid`;
    expect((prior[0] as { expired_at: Date | null }).expired_at).not.toBeNull();
  });

  it('leaves canonical untouched when the transaction fails mid-way (criterion 5, atomicity)', async () => {
    // Hand-built plan: mint one entity, then insert a fact whose subject resolves
    // to a NON-EXISTENT canonical id → facts.subject_entity_id FK violates → the
    // whole transaction must roll back, so the minted entity must NOT persist.
    const bogusName = `${TAG} Atomic Ghost`;
    const plan: PromotionPlan = {
      entitiesToMint: [
        { clusterKey: 'cluster:organization|atomic ghost', name: bogusName, type: 'organization', summary: null, memberHandles: [] },
      ],
      factsToInsert: [
        {
          stagedFactId: randomUUID(),
          subjectRef: { kind: 'canonical', id: randomUUID() }, // not a real entity
          predicate: 'founded_in',
          objectRef: null,
          objectValue: '1999',
          validAt: null,
          chunkIndex: null,
          confidence: 0.9,
          reasoning: `${TAG} atomic`,
          exclusiveGroup: null,
          active: true,
          expireReason: null,
          corroboratesStagedFactIds: [],
        },
      ],
      factsToExpire: [],
      corroborations: [],
      escalations: [],
      supersessionHints: [],
      droppedSelfLoops: [],
    };

    await expect(applyPromotion(randomUUID(), plan)).rejects.toThrow();

    const ghost = await testDb`SELECT id FROM entities WHERE canonical_name = ${bogusName}`;
    expect(ghost).toHaveLength(0); // rolled back — nothing persisted
  });
});
