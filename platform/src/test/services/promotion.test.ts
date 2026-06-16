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
import { planPromotion, type PromotionPlan, type PriorCanonical, type StagedProposals } from '../../services/promotion-plan.js';
import { resolveEscalations, type ArbiterInvoker, type EscalationDossier } from '../../services/promotion-arbiter.js';

const TAG = 'promtest';

async function clean(): Promise<void> {
  // fact_history → facts (no cascade); facts.subject_entity_id is RESTRICT (mig
  // 038). Delete history by fact_id (promotion's audit rows aren't TAG-reasoned),
  // then facts, then entities.
  await testDb.unsafe(
    `DELETE FROM fact_history WHERE fact_id IN (SELECT id FROM facts WHERE source_text LIKE '${TAG}%')`,
  );
  await testDb.unsafe(`DELETE FROM facts WHERE source_text LIKE '${TAG}%'`);
  // E5 identity verdicts create entity_merges / same_as_links / entity_aliases rows
  // that FK-reference the TAG entities — clear them before deleting the entities.
  const tagEntities = `SELECT id FROM entities WHERE canonical_name LIKE '${TAG}%'`;
  await testDb.unsafe(
    `DELETE FROM entity_merges WHERE source_entity_id IN (${tagEntities}) OR target_entity_id IN (${tagEntities})`,
  );
  await testDb.unsafe(
    `DELETE FROM same_as_links WHERE entity_a_id IN (${tagEntities}) OR entity_b_id IN (${tagEntities})`,
  );
  await testDb.unsafe(`DELETE FROM entity_aliases WHERE entity_id IN (${tagEntities})`);
  await testDb.unsafe(`DELETE FROM entities WHERE canonical_name LIKE '${TAG}%'`);
  await testDb.unsafe('DELETE FROM staging_proposed_facts');
  await testDb.unsafe('DELETE FROM staging_proposed_entities');
  await testDb.unsafe('DELETE FROM arbiter_verdicts');
}

/** Insert a canonical entity directly (a prior-canonical row for E5 escalations). */
async function createCanonicalEntity(name: string, type: string): Promise<string> {
  const id = randomUUID();
  await testDb`INSERT INTO entities (id, canonical_name, entity_type) VALUES (${id}::uuid, ${name}, ${type})`;
  return id;
}

/** Insert a canonical active fact directly (TAG-scoped so clean() removes it). */
async function createCanonicalFact(subjectId: string, predicate: string, objectValue: string): Promise<string> {
  const id = randomUUID();
  await testDb`
    INSERT INTO facts (id, subject_entity_id, predicate, object_value, source_text, extraction_method)
    VALUES (${id}::uuid, ${subjectId}::uuid, ${predicate}, ${objectValue}, ${TAG + ':prior'}, 'llm')
  `;
  return id;
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

/**
 * Value-normalised canonical snapshot of this test's facts (E8). id-AGNOSTIC:
 * subject/object are joined to canonical NAMES, not ids, so two promotions of the
 * same staged set compare equal despite each minting fresh UUIDs. Sorted for a
 * stable string compare.
 */
async function canonicalValueSnapshot(): Promise<string> {
  const rows = await testDb`
    SELECT e.canonical_name AS subj, f.predicate AS pred,
           COALESCE(oe.canonical_name, f.object_value) AS obj,
           (f.expired_at IS NULL) AS active,
           to_char(f.valid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS valid_at
    FROM facts f
    JOIN entities e ON e.id = f.subject_entity_id
    LEFT JOIN entities oe ON oe.id = f.object_entity_id
    WHERE f.source_text LIKE ${TAG + '%'}
    ORDER BY subj, pred, obj, active, valid_at
  `;
  return JSON.stringify(rows.map((r) => [r.subj, r.pred, r.obj, r.active, r.valid_at]));
}

/**
 * Delete this test's CANONICAL rows (facts + audit + minted entities) while
 * LEAVING the staged proposals intact, so promote() can replay the same staging
 * into a clean canonical (E8 criterion 2). Facts before entities (subject FK is
 * RESTRICT, mig 038).
 */
async function wipeCanonical(): Promise<void> {
  await testDb.unsafe(
    `DELETE FROM fact_history WHERE fact_id IN (SELECT id FROM facts WHERE source_text LIKE '${TAG}%')`,
  );
  await testDb.unsafe(`DELETE FROM facts WHERE source_text LIKE '${TAG}%'`);
  await testDb.unsafe(`DELETE FROM entities WHERE canonical_name LIKE '${TAG}%'`);
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
      entityMerges: [],
      sameAsLinks: [],
    };

    await expect(applyPromotion(randomUUID(), plan)).rejects.toThrow();

    const ghost = await testDb`SELECT id FROM entities WHERE canonical_name = ${bogusName}`;
    expect(ghost).toHaveLength(0); // rolled back — nothing persisted
  });
});

describe('promotion replay determinism (nmemo-vpz.8 / E8 criterion 2)', () => {
  beforeEach(clean);
  afterAll(clean);

  it('re-promoting the SAME staged set into clean canonical yields identical canonical', async () => {
    // A set that exercises merge + cross-predicate supersession + triple dedup, so
    // the snapshot is a non-trivial fixed point, not just one inert fact.
    const epoch = randomUUID();
    const helix = await stageEntity(epoch, `${TAG} Helix`, 'organization');
    const helixR = await stageEntity(epoch, `${TAG} Helix Robotics`, 'organization'); // merges with helix
    const elena = await stageEntity(epoch, `${TAG} Elena`, 'person');
    await stageFact(epoch, elena, 'works_at', { objectHandle: helix, validAt: new Date('2021-01-01') });
    await stageFact(epoch, helixR, 'headquartered_in', { objectValue: 'Boston', validAt: new Date('2020-01-01'), exclusiveGroup: 'location' });
    await stageFact(epoch, helix, 'relocated_to', { objectValue: 'Austin', validAt: new Date('2023-01-01'), exclusiveGroup: 'location' });
    await stageFact(epoch, elena, 'works_at', { objectHandle: helix, validAt: new Date('2021-01-01') }); // dup → corroborate

    await promote(epoch);
    const snap1 = await canonicalValueSnapshot();

    await wipeCanonical(); // clear canonical, KEEP the staging rows
    await promote(epoch); // replay the same staged set into now-empty canonical

    const snap2 = await canonicalValueSnapshot();
    expect(snap2).toBe(snap1); // byte-identical by VALUE (ids differ, structure does not)

    // Guard the check is meaningful: merge + supersession actually applied.
    const tuples = JSON.parse(snap1) as Array<[string, string, string, boolean, string | null]>;
    const activeLoc = tuples.filter((t) => t[3] && (t[1] === 'headquartered_in' || t[1] === 'relocated_to'));
    expect(activeLoc).toHaveLength(1); // exactly one active location after supersession
    expect(activeLoc[0]![2]).toBe('Austin'); // latest-valid
  });
});

describe('epoch-v2 bug-fix scenarios — named harness cases (nmemo-vpz.8 / E8 criterion 4)', () => {
  beforeEach(clean);
  afterAll(clean);

  it('nmemo-bsb: supersession keeps the latest-VALID fact, not the last-committed one', async () => {
    // The fact committed LAST carries the EARLIER valid_at (a back-dated mention):
    // last-committed != latest-valid. Promotion must keep latest-VALID active.
    const epoch = randomUUID();
    const helix = await stageEntity(epoch, `${TAG} Helix BSB`, 'organization');
    await stageFact(epoch, helix, 'relocated_to', { objectValue: 'Austin', validAt: new Date('2023-01-01'), chunkIndex: 0, exclusiveGroup: 'location' });
    await stageFact(epoch, helix, 'headquartered_in', { objectValue: 'Boston', validAt: new Date('2019-01-01'), chunkIndex: 1, exclusiveGroup: 'location' });
    await promote(epoch);
    const ent = await testDb`SELECT id FROM entities WHERE canonical_name LIKE ${TAG + '%'}`;
    const active = await testDb`
      SELECT object_value FROM facts
      WHERE subject_entity_id = ${(ent[0] as { id: string }).id}::uuid AND expired_at IS NULL
    `;
    expect(active).toHaveLength(1);
    expect((active[0] as { object_value: string }).object_value).toBe('Austin'); // latest-valid wins
  });

  it('nmemo-wyb: helix / helix-robotics duplicate entities merge to ONE canonical entity at promotion', async () => {
    const epoch = randomUUID();
    const a = await stageEntity(epoch, `${TAG} Helix WYB`, 'organization');
    const b = await stageEntity(epoch, `${TAG} Helix WYB Robotics`, 'organization');
    await stageFact(epoch, a, 'founded_in', { objectValue: '2015' });
    await stageFact(epoch, b, 'headquartered_in', { objectValue: 'Austin', validAt: new Date('2023-01-01'), exclusiveGroup: 'location' });
    const result = await promote(epoch);
    expect(Object.keys(result.mintedEntityIds)).toHaveLength(1); // collapsed to one
    const ents = await testDb`SELECT count(*)::int AS n FROM entities WHERE canonical_name LIKE ${TAG + '%'}`;
    expect((ents[0] as { n: number }).n).toBe(1);
  });

  it('nmemo-3bp: a fact on a freshly-proposed OBJECT entity promotes with NO FK violation', async () => {
    // Both subject and object are fresh (no canonical id until promotion mints them)
    // — the exact case that FK-violated under the old per-chunk write race.
    const epoch = randomUUID();
    const alice = await stageEntity(epoch, `${TAG} Alice 3BP`, 'person');
    const acme = await stageEntity(epoch, `${TAG} Acme 3BP`, 'organization');
    await stageFact(epoch, alice, 'works_at', { objectHandle: acme, validAt: new Date('2022-01-01') });
    const result = await promote(epoch); // must not throw on the object FK
    expect(result.insertedFactIds).toHaveLength(1);
    const fact = await testDb`SELECT object_entity_id FROM facts WHERE id = ${result.insertedFactIds[0]!}::uuid`;
    expect((fact[0] as { object_entity_id: string | null }).object_entity_id).not.toBeNull();
  });
});

// ============================================
// E5 — promotion-escalation arbiter seam (nmemo-vpz.5, doc 41 §8a.5)
// ============================================

describe('promotion-escalation arbiter (nmemo-vpz.5 / E5)', () => {
  beforeEach(clean);
  afterAll(clean);

  it('criterion 1: an ambiguous cluster escalates, the arbiter MERGE verdict is executed by promotion', async () => {
    // Two prior canonical orgs a short proposal word-prefix-matches → identity
    // escalation. The arbiter says "merge"; promotion executes the canonical merge.
    const epoch = randomUUID();
    const robo = await createCanonicalEntity(`${TAG} Helix Robotics`, 'organization');
    const bio = await createCanonicalEntity(`${TAG} Helix Biosciences`, 'organization');
    // A fact on each side — whichever becomes the merge source gets re-pointed,
    // so the 'merged' audit invariant is exercised regardless of the id sort.
    await createCanonicalFact(robo, 'industry', 'robotics');
    await createCanonicalFact(bio, 'industry', 'biotech');
    const helix = await stageEntity(epoch, `${TAG} Helix`, 'organization');
    await stageFact(epoch, helix, 'headquartered_in', { objectValue: 'Austin', validAt: new Date('2023-01-01'), exclusiveGroup: 'location' });

    // Fake arbiter: merge the candidates into the lexicographically-first id (the
    // dossier lists candidateIds sorted), writing the verdict the tools would write.
    let invoked = 0;
    const mergeArbiter: ArbiterInvoker = async (epochId, dossiers) => {
      invoked++;
      const d = dossiers.find((x): x is Extract<EscalationDossier, { kind: 'identity' }> => x.kind === 'identity')!;
      const target = d.candidates[0]!.id;
      await testDb`
        UPDATE arbiter_verdicts
        SET verdict = ${JSON.stringify({ members: [robo, bio], decision: 'merge', canonicalTarget: target, reasoning: 'Same org; Biosciences is the former name (test)' })}::jsonb,
            decided_by = 'reconciliation_agent', decided_at = now()
        WHERE epoch_id = ${epochId}::uuid AND escalation_key = ${d.escalationKey}
      `;
    };

    const result = await promote(epoch, { invokeArbiter: mergeArbiter });

    expect(invoked).toBe(1);
    expect(result.mergedAwayEntityIds).toHaveLength(1); // one candidate merged into the other
    // Exactly one of the two prior canonical orgs survives.
    const survivors = await testDb`SELECT id FROM entities WHERE id IN (${robo}::uuid, ${bio}::uuid)`;
    expect(survivors).toHaveLength(1);
    // The proposed "Helix" cluster bound to the survivor — no third fresh entity minted.
    const freshHelix = await testDb`SELECT id FROM entities WHERE canonical_name = ${TAG + ' Helix'}`;
    expect(freshHelix).toHaveLength(0);
    // The proposed HQ fact landed on the survivor.
    const survivorId = (survivors[0] as { id: string }).id;
    const hq = await testDb`
      SELECT object_value FROM facts
      WHERE subject_entity_id = ${survivorId}::uuid AND predicate = 'headquartered_in' AND expired_at IS NULL
    `;
    expect((hq[0] as { object_value: string }).object_value).toBe('Austin');
    // Merge audit invariant (replaces the retired execute_merge dispatch coverage):
    // the re-pointed fact gets a 'merged' fact_history row stamped actor='promotion'.
    const mergedAudit = await testDb`
      SELECT fh.actor FROM fact_history fh
      JOIN facts f ON f.id = fh.fact_id
      WHERE f.source_text LIKE ${TAG + '%'} AND fh.event_type = 'merged'
    `;
    expect(mergedAudit.length).toBeGreaterThanOrEqual(1);
    expect((mergedAudit[0] as { actor: string }).actor).toBe('promotion');
  });

  it('criterion 1: a SAME_AS verdict links the candidates instead of merging', async () => {
    const epoch = randomUUID();
    const robo = await createCanonicalEntity(`${TAG} Helix Robotics`, 'organization');
    const bio = await createCanonicalEntity(`${TAG} Helix Biosciences`, 'organization');
    const helix = await stageEntity(epoch, `${TAG} Helix`, 'organization');
    await stageFact(epoch, helix, 'founded_in', { objectValue: '2009' });

    const sameAsArbiter: ArbiterInvoker = async (epochId, dossiers) => {
      const d = dossiers.find((x): x is Extract<EscalationDossier, { kind: 'identity' }> => x.kind === 'identity')!;
      await testDb`
        UPDATE arbiter_verdicts
        SET verdict = ${JSON.stringify({ members: [robo, bio], decision: 'same_as', canonicalTarget: d.candidates[0]!.id, reasoning: 'related, kept separate (test)' })}::jsonb,
            decided_at = now()
        WHERE epoch_id = ${epochId}::uuid AND escalation_key = ${d.escalationKey}
      `;
    };

    const result = await promote(epoch, { invokeArbiter: sameAsArbiter });
    expect(result.mergedAwayEntityIds).toHaveLength(0); // not merged
    expect(result.sameAsLinkIds).toHaveLength(1); // linked
    // Both prior canonical orgs survive.
    const survivors = await testDb`SELECT id FROM entities WHERE id IN (${robo}::uuid, ${bio}::uuid)`;
    expect(survivors).toHaveLength(2);
    const link = await testDb`SELECT created_by FROM same_as_links WHERE id = ${result.sameAsLinkIds[0]!}::uuid`;
    expect((link[0] as { created_by: string }).created_by).toBe('promotion');
  });

  it('criterion 3: a replayed promotion reuses the recorded verdict WITHOUT re-invoking the arbiter', async () => {
    // resolveEscalations is exercised directly so the prior canonical (which a
    // promote()/wipe cycle would delete) stays fixed and the SAME escalation key
    // re-surfaces — isolating the store-reuse short-circuit.
    const epoch = randomUUID();
    const prior: PriorCanonical = {
      entities: [
        { id: randomUUID(), name: `${TAG} Helix Robotics`, type: 'organization' },
        { id: randomUUID(), name: `${TAG} Helix Biosciences`, type: 'organization' },
      ],
      activeFacts: [],
    };
    const staged: StagedProposals = {
      entities: [{ handle: randomUUID(), name: `${TAG} Helix`, type: 'organization', summary: null, anchorCanonicalId: null }],
      facts: [],
    };
    const plan = planPromotion(prior, staged);
    expect(plan.escalations).toHaveLength(1);

    let invoked = 0;
    const distinctArbiter: ArbiterInvoker = async (epochId, dossiers) => {
      invoked++;
      const d = dossiers[0]!;
      await testDb`
        UPDATE arbiter_verdicts
        SET verdict = ${JSON.stringify({ members: [], decision: 'distinct', canonicalTarget: null, reasoning: 'distinct (test)' })}::jsonb,
            decided_at = now()
        WHERE epoch_id = ${epochId}::uuid AND escalation_key = ${d.escalationKey}
      `;
    };

    const first = await resolveEscalations(epoch, prior, staged, plan.escalations, { invokeArbiter: distinctArbiter });
    expect(invoked).toBe(1);
    expect(first).toHaveLength(1);
    expect(first[0]!.kind).toBe('identity');

    // Same epoch + same escalations → reuse the recorded verdict, no LLM.
    const second = await resolveEscalations(epoch, prior, staged, plan.escalations, { invokeArbiter: distinctArbiter });
    expect(invoked).toBe(1); // NOT incremented — verdict reused from arbiter_verdicts
    expect(second).toEqual(first);
  });

  it('criterion 1: an undecided escalation falls back to the conservative default (promotion still completes)', async () => {
    const epoch = randomUUID();
    await createCanonicalEntity(`${TAG} Helix Robotics`, 'organization');
    await createCanonicalEntity(`${TAG} Helix Biosciences`, 'organization');
    const helix = await stageEntity(epoch, `${TAG} Helix`, 'organization');
    await stageFact(epoch, helix, 'founded_in', { objectValue: '2009' });

    // Arbiter declines (writes no verdict). Promotion must still complete with the
    // conservative default: the cluster stays distinct (a fresh entity is minted).
    const silentArbiter: ArbiterInvoker = async () => { /* no verdict written */ };
    const result = await promote(epoch, { invokeArbiter: silentArbiter });
    expect(result.mergedAwayEntityIds).toHaveLength(0);
    expect(result.sameAsLinkIds).toHaveLength(0);
    // Conservative default: the cluster stays distinct → a fresh entity is minted
    // (the planner mints under the normalised, lower-cased name).
    expect(Object.keys(result.mintedEntityIds)).toHaveLength(1);
    const freshHelix = await testDb`SELECT id FROM entities WHERE lower(canonical_name) = ${(TAG + ' Helix').toLowerCase()}`;
    expect(freshHelix).toHaveLength(1);
  });
});
