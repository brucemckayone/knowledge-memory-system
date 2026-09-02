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

/**
 * Every epoch id this suite has staged into. `clean()` deletes staging ONLY for
 * these.
 *
 * It used to run bare `DELETE FROM staging_proposed_facts`,
 * `DELETE FROM staging_proposed_entities` and `DELETE FROM arbiter_verdicts` with
 * no WHERE clause at all, on a SHARED test database. That wiped every other
 * writer's staging rows too. It cost real data on 2026-08-31: a 294-document
 * ingest was running against cognitive_test, and running this suite deleted the
 * in-flight batch's staging before the ingest harness could snapshot its
 * paper-level attribution from it — so 10 documents landed in the graph with NO
 * attribution, silently, reported only as `attributed 0 facts / 0 entities` in a
 * log line. Staging is transient by design (cleanupAbandonedStaging GCs it), so
 * nothing could reconstruct it afterwards.
 */
const stagedEpochIds = new Set<string>();

interface MintedEventRow {
  transition_type: string;
  fact_id: string;
  subject_entity_id: string | null;
  predicate: string | null;
  delta_confidence: number | null;
}

/**
 * Clear the causal layer (edge refs -> edge history -> edges -> events) for this
 * test's TAG facts. E6: promotion now mints causal_events from settled fact
 * mutations; causal_events.fact_id and .subject_entity_id are RESTRICT FKs, so the
 * causal rows MUST go before the facts/entities they reference. Defensive about
 * edges — promotion alone mints only events, but the causal pass adds edges.
 */
async function clearCausalForTag(): Promise<void> {
  const tagFacts = `SELECT id FROM facts WHERE source_text LIKE '${TAG}%'`;
  const tagEvents = `SELECT id FROM causal_events WHERE fact_id IN (${tagFacts})`;
  await testDb.unsafe(
    `DELETE FROM edge_source_refs WHERE edge_id IN (SELECT id FROM causal_edges WHERE cause_event_id IN (${tagEvents}) OR effect_event_id IN (${tagEvents}))`,
  );
  await testDb.unsafe(
    `DELETE FROM causal_edge_history WHERE edge_id IN (SELECT id FROM causal_edges WHERE cause_event_id IN (${tagEvents}) OR effect_event_id IN (${tagEvents}))`,
  );
  await testDb.unsafe(
    `DELETE FROM causal_edges WHERE cause_event_id IN (${tagEvents}) OR effect_event_id IN (${tagEvents})`,
  );
  await testDb.unsafe(`DELETE FROM causal_events WHERE fact_id IN (${tagFacts})`);
}

async function clean(): Promise<void> {
  // fact_history → facts (no cascade); facts.subject_entity_id is RESTRICT (mig
  // 038). Delete history by fact_id (promotion's audit rows aren't TAG-reasoned),
  // then facts, then entities.
  await testDb.unsafe(
    `DELETE FROM fact_history WHERE fact_id IN (SELECT id FROM facts WHERE source_text LIKE '${TAG}%')`,
  );
  await clearCausalForTag();
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
  // SCOPED to this suite's own epochs — see stagedEpochIds above for what an
  // unscoped delete cost. A no-op when the suite has staged nothing yet.
  if (stagedEpochIds.size > 0) {
    const ids = [...stagedEpochIds].map((e) => `'${e}'::uuid`).join(',');
    await testDb.unsafe(`DELETE FROM staging_proposed_facts WHERE epoch_id IN (${ids})`);
    await testDb.unsafe(`DELETE FROM staging_proposed_entities WHERE epoch_id IN (${ids})`);
    await testDb.unsafe(`DELETE FROM arbiter_verdicts WHERE epoch_id IN (${ids})`);
  }
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
  summary?: string,
): Promise<string> {
  stagedEpochIds.add(epochId);
  const handle = randomUUID();
  await testDb`
    INSERT INTO staging_proposed_entities (handle, epoch_id, name, entity_type, anchor_canonical_id, summary)
    VALUES (${handle}::uuid, ${epochId}::uuid, ${name}, ${type}, ${anchorCanonicalId ?? null}::uuid, ${summary ?? null})
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
  stagedEpochIds.add(epochId);
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
  await clearCausalForTag();
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
          sourceId: null,
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
      droppedOrphanEntities: [],
      entityMerges: [],
      sameAsLinks: [],
      entityDescriptionFills: [],
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

  it('nmemo-avd (PC8-1): a promoted entity is minted with a populated 768-dim embedding, never NULL', async () => {
    // The promote path embeds via embedForWrite, which THROWS on an ML failure rather
    // than committing a NULL embedding that pgvector recall would silently skip. Here
    // ML is up, so the minted entity must carry a real 768-dim vector. (folds PC8-6.)
    const epoch = randomUUID();
    const org = await stageEntity(epoch, `${TAG} Embedded Co`, 'organization');
    await stageFact(epoch, org, 'headquartered_in', {
      objectValue: 'Boston',
      validAt: new Date('2021-01-01'),
    });
    const result = await promote(epoch);
    expect(Object.keys(result.mintedEntityIds)).toHaveLength(1);

    const rows = await testDb`
      SELECT embedding IS NOT NULL AS present, vector_dims(embedding) AS dims
      FROM entities WHERE canonical_name LIKE ${TAG + '%'}
    `;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { present: boolean }).present).toBe(true);
    expect((rows[0] as { dims: number }).dims).toBe(768);
  });

  it('nmemo-vga: every promoted fact carries a 768-dim fact_embedding, flag-independent', async () => {
    // The write end of the fact-vector defect. This embedding used to be gated on
    // config.EMBED_DESCRIPTIONS, which defaults to false and was set nowhere, so
    // facts.fact_embedding was NULL on the whole epoch path (measured: 0 of 136
    // on the default corpus) while the serial createFact path always populated
    // it. EMBED_DESCRIPTIONS is off in this test env, which is exactly the
    // configuration that used to produce NULL — so this test fails on the old code.
    const epoch = randomUUID();
    const org = await stageEntity(epoch, `${TAG} FactVec Co`, 'organization');
    await stageFact(epoch, org, 'headquartered_in', {
      objectValue: 'Reykjavik',
      validAt: new Date('2021-06-01'),
    });
    const result = await promote(epoch);
    expect(result.insertedFactIds).toHaveLength(1);

    const rows = await testDb`
      SELECT fact_embedding IS NOT NULL AS present, vector_dims(fact_embedding) AS dims
      FROM facts WHERE id = ${result.insertedFactIds[0]!}::uuid
    `;
    expect((rows[0] as { present: boolean }).present).toBe(true);
    expect((rows[0] as { dims: number }).dims).toBe(768);
  });
});

/**
 * nmemo-86z — the proposer-authored entity summary must survive promotion.
 * promotion-plan hardcoded `summary: null`, so entities.description was NULL on
 * all 3,406 canonical rows and every entity vector embedded a bare name even
 * with EMBED_DESCRIPTIONS on.
 */
describe('entity descriptions survive promotion (nmemo-86z)', () => {
  beforeEach(async () => {
    await clearCausalForTag();
    await clean();
  });
  afterAll(async () => {
    await clearCausalForTag();
    await clean();
  });

  const SUMMARY = 'Diffusion models trained on 2D image data';

  it('carries the staged summary into entities.description', async () => {
    const epoch = randomUUID();
    const e = await stageEntity(epoch, `${TAG} Descr Co`, 'organization', undefined, SUMMARY);
    await stageFact(epoch, e, 'headquartered_in', { objectValue: 'Oslo', validAt: new Date('2022-02-02') });
    const result = await promote(epoch);
    const id = Object.values(result.mintedEntityIds)[0]!;
    const rows = await testDb`SELECT description FROM entities WHERE id = ${id}::uuid`;
    expect((rows[0] as { description: string | null }).description).toBe(SUMMARY);
  });

  it('fills a NULL description on reuse-by-name, and does not overwrite an existing one', async () => {
    // Epoch 1: no summary at all → description stays NULL (nothing to write).
    const e1 = randomUUID();
    const h1 = await stageEntity(e1, `${TAG} Reuse Co`, 'organization');
    await stageFact(e1, h1, 'headquartered_in', { objectValue: 'Lima', validAt: new Date('2022-03-03') });
    const r1 = await promote(e1);
    const id = Object.values(r1.mintedEntityIds)[0]!;
    let rows = await testDb`SELECT description FROM entities WHERE id = ${id}::uuid`;
    expect((rows[0] as { description: string | null }).description).toBeNull();

    // Epoch 2: same name, now WITH a summary → reuse-by-name fills the null.
    const e2 = randomUUID();
    const h2 = await stageEntity(e2, `${TAG} Reuse Co`, 'organization', undefined, SUMMARY);
    await stageFact(e2, h2, 'headquartered_in', { objectValue: 'Quito', validAt: new Date('2023-04-04') });
    await promote(e2);
    // The planner binds the handle straight to the existing canonical, so this
    // path produces NO mintedEntityIds entry at all — which is exactly why the
    // fill has to be planned separately (plan.entityDescriptionFills) rather
    // than ride on entitiesToMint. Assert no second row was created instead.
    // lower() because promotion canonicalises the staged name (normalizeName
    // lowercases), so an exact name match is brittle here.
    const sameName = await testDb`
      SELECT id FROM entities WHERE lower(canonical_name) = ${`${TAG} Reuse Co`.toLowerCase()}
    `;
    expect(sameName).toHaveLength(1);
    rows = await testDb`SELECT description FROM entities WHERE id = ${id}::uuid`;
    expect((rows[0] as { description: string | null }).description).toBe(SUMMARY);

    // Epoch 3: same name, a DIFFERENT summary → first-write-wins, no thrash.
    const e3 = randomUUID();
    const h3 = await stageEntity(e3, `${TAG} Reuse Co`, 'organization', undefined, 'A completely different and much longer replacement summary');
    await stageFact(e3, h3, 'headquartered_in', { objectValue: 'Bogota', validAt: new Date('2024-05-05') });
    await promote(e3);
    rows = await testDb`SELECT description FROM entities WHERE id = ${id}::uuid`;
    expect((rows[0] as { description: string | null }).description).toBe(SUMMARY);
  });
});

describe('E6 — causal event minting at promotion (nmemo-vpz.6, doc 41 §12 #5)', () => {
  beforeEach(clean);
  afterAll(clean);

  /** All causal events whose fact is one of this test's TAG facts. */
  async function tagEvents(): Promise<MintedEventRow[]> {
    const rows = await testDb`
      SELECT transition_type, fact_id::text AS fact_id, subject_entity_id::text AS subject_entity_id,
             predicate, delta_confidence
      FROM causal_events
      WHERE fact_id IN (SELECT id FROM facts WHERE source_text LIKE ${TAG + '%'})
    `;
    return rows as unknown as MintedEventRow[];
  }

  it('mints exactly one "created" event per newly-active fact, keyed to its fact id', async () => {
    const epoch = randomUUID();
    const alice = await stageEntity(epoch, `${TAG} Alice Mint`, 'person');
    const acme = await stageEntity(epoch, `${TAG} Acme Mint`, 'organization');
    await stageFact(epoch, alice, 'works_at', { objectHandle: acme, validAt: new Date('2022-01-01') });
    await stageFact(epoch, alice, 'born_in', { objectValue: 'Boston', validAt: new Date('1990-01-01') });

    const result = await promote(epoch);

    // Two active facts inserted -> two minted ids, both returned and 'created'.
    expect(result.insertedFactIds).toHaveLength(2);
    expect(result.mintedCausalEventIds).toHaveLength(2);

    const events = await tagEvents();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.transition_type === 'created')).toBe(true);
    // Keyed to the stable fact ids promotion just inserted (§12 #5).
    expect(new Set(events.map((e) => e.fact_id))).toEqual(new Set(result.insertedFactIds));
    // No orphan events: Graph C node inputs are populated.
    expect(events.every((e) => e.subject_entity_id && e.predicate)).toBe(true);
  });

  it('mints NO event for a fact born inactive (lost group supersession on arrival)', async () => {
    // Two location facts in one epoch: Austin (2023) wins the group, Boston (2019)
    // is inserted already-expired. Only the active winner mints an event.
    const epoch = randomUUID();
    const co = await stageEntity(epoch, `${TAG} BornInactive Co`, 'organization');
    await stageFact(epoch, co, 'headquartered_in', { objectValue: 'Boston', validAt: new Date('2019-01-01'), exclusiveGroup: 'location' });
    await stageFact(epoch, co, 'relocated_to', { objectValue: 'Austin', validAt: new Date('2023-01-01'), exclusiveGroup: 'location' });

    const result = await promote(epoch);

    expect(result.insertedFactIds).toHaveLength(2); // both inserted (one born-inactive)
    expect(result.mintedCausalEventIds).toHaveLength(1); // only the active one mints

    const events = await tagEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.transition_type).toBe('created');
  });

  it('mints an "expired" event for a prior-canonical fact superseded by a later epoch', async () => {
    // Epoch 0: prior HQ Boston (active canonical).
    const epoch0 = randomUUID();
    const co0 = await stageEntity(epoch0, `${TAG} Expire Co`, 'organization');
    await stageFact(epoch0, co0, 'headquartered_in', { objectValue: 'Boston', validAt: new Date('2019-01-01'), exclusiveGroup: 'location' });
    await promote(epoch0);
    const canonId = ((await testDb`SELECT id FROM entities WHERE canonical_name LIKE ${TAG + '%'}`)[0] as { id: string }).id;
    const priorFactId = ((await testDb`SELECT id FROM facts WHERE source_text LIKE ${TAG + '%'} AND object_value = 'Boston'`)[0] as { id: string }).id;

    // Epoch 1: a later-valid HQ supersedes the prior -> the prior fact expires.
    const epoch1 = randomUUID();
    const co1 = await stageEntity(epoch1, `${TAG} Expire Co`, 'organization', canonId);
    await stageFact(epoch1, co1, 'headquartered_in', { objectValue: 'Austin', validAt: new Date('2024-01-01'), exclusiveGroup: 'location' });
    const result = await promote(epoch1);

    expect(result.expiredFactIds).toContain(priorFactId);
    const events = await tagEvents();
    expect(events.filter((e) => e.transition_type === 'expired').map((e) => e.fact_id)).toContain(priorFactId);
    // The new active fact still got its 'created' event.
    expect(events.some((e) => e.transition_type === 'created')).toBe(true);
  });

  it('mints a "strengthened" event when a corroboration raises confidence', async () => {
    // Epoch 0: a fact at modest confidence.
    const epoch0 = randomUUID();
    const co0 = await stageEntity(epoch0, `${TAG} Corrob Co`, 'organization');
    await stageFact(epoch0, co0, 'founded_in', { objectValue: '2015', confidence: 0.6 });
    await promote(epoch0);
    const canonId = ((await testDb`SELECT id FROM entities WHERE canonical_name LIKE ${TAG + '%'}`)[0] as { id: string }).id;
    const priorFactId = ((await testDb`SELECT id FROM facts WHERE source_text LIKE ${TAG + '%'} AND object_value = '2015'`)[0] as { id: string }).id;

    // Epoch 1: the SAME triple at higher confidence -> corroboration raises it.
    const epoch1 = randomUUID();
    const co1 = await stageEntity(epoch1, `${TAG} Corrob Co`, 'organization', canonId);
    await stageFact(epoch1, co1, 'founded_in', { objectValue: '2015', confidence: 0.95 });
    const result = await promote(epoch1);

    expect(result.corroboratedFactIds).toContain(priorFactId);
    const strengthened = (await tagEvents()).filter((e) => e.transition_type === 'strengthened');
    expect(strengthened.map((e) => e.fact_id)).toContain(priorFactId);
    expect(strengthened.find((e) => e.fact_id === priorFactId)!.delta_confidence).toBeGreaterThan(0);
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

/**
 * Corpus-scoped promotion (doc 34 §6 step 1). The multi-hop concept test needs each
 * corpus to be its OWN entity+fact graph; before this, applyPromotion had no corpus
 * awareness at all, so every ingest landed in 'default' and the entity reuse-by-name
 * lookup was a cross-corpus fusion path.
 */
describe('corpus-scoped promotion (doc 34 §6 step 1)', () => {
  const CA = 'promtest-corpus-a';
  const CB = 'promtest-corpus-b';
  const SHARED = `${TAG} Shared Name Co`;

  async function cleanCorpora(): Promise<void> {
    for (const c of [CA, CB]) {
      await testDb.unsafe(`DELETE FROM fact_history WHERE fact_id IN (SELECT id FROM facts WHERE corpus_id = '${c}')`);
      await testDb.unsafe(`DELETE FROM causal_events WHERE fact_id IN (SELECT id FROM facts WHERE corpus_id = '${c}')`);
      await testDb.unsafe(`DELETE FROM facts WHERE corpus_id = '${c}'`);
      await testDb.unsafe(`DELETE FROM entities WHERE corpus_id = '${c}'`);
    }
  }

  beforeEach(cleanCorpora);
  afterAll(cleanCorpora);

  /** One staged entity of the shared name, optionally with a fact hanging off it. */
  function staged(withFact: boolean): StagedProposals {
    const handle = randomUUID();
    return {
      entities: [{ handle, name: SHARED, type: 'organization', summary: null, anchorCanonicalId: null }],
      facts: withFact
        ? [{
          stagedFactId: randomUUID(), subjectHandle: handle, predicate: 'located_in',
          objectHandle: null, objectValue: 'Testville', validAt: new Date('2026-01-01'),
          undated: false, sourceId: null, chunkIndex: 0, confidence: 0.9, reasoning: `${TAG} corpus scope`,
          exclusiveGroup: null, supersedesFactId: null,
        }]
        : [],
    };
  }

  const apply = async (corpusId?: string, withFact = true): Promise<string> => {
    const plan = planPromotion({ entities: [], activeFacts: [] }, staged(withFact));
    const res = await applyPromotion(randomUUID(), plan, corpusId);
    return Object.values(res.mintedEntityIds)[0]!;
  };

  it('mints a SEPARATE entity per corpus for the same name (no cross-corpus fusion)', async () => {
    const idA = await apply(CA);
    const idB = await apply(CB);
    expect(idA).not.toBe(idB);

    // Grouped over the two dedicated test corpora (cleaned in beforeEach) rather than
    // filtered on canonical_name — promotion canonicalises the staged name, so a name
    // filter is brittle and tests the wrong thing.
    const rows = await testDb.unsafe(
      `SELECT corpus_id, count(*)::int AS n FROM entities WHERE corpus_id IN ('${CA}','${CB}') GROUP BY corpus_id ORDER BY corpus_id`,
    );
    expect(rows).toEqual([{ corpus_id: CA, n: 1 }, { corpus_id: CB, n: 1 }]);
  });

  it('writes facts into the same corpus as their endpoints (mig 052 composite FK)', async () => {
    await apply(CA);
    const rows = await testDb.unsafe(
      `SELECT f.corpus_id AS fc, e.corpus_id AS ec FROM facts f JOIN entities e ON e.id = f.subject_entity_id WHERE f.corpus_id = '${CA}'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fc).toBe(CA);
    expect(rows[0]!.ec).toBe(CA);
  });

  it('fusion guard #5: an anchor pointing OUTSIDE the corpus is dropped, not bound', async () => {
    // The real failure this prevents, from the 2026-08-31 re-ingest: a proposer
    // anchored a dal-nlp entity to 'User (stream default)', the self entity, which
    // lives in corpus 'default'. resolveEntities binds anchorCanonicalId straight
    // from the staged row (the planner is pure and does not consult the DB), so the
    // handle bound to a foreign-corpus id and the fact insert then hit migration
    // 052's composite FK:
    //   Key (subject_entity_id, corpus_id)=(..., dal-nlp) is not present in "entities"
    // The constraint did its job - it stopped a silent cross-corpus fusion - but it
    // killed the whole epoch. The guard turns that into correct isolation.
    const foreign = await testDb`
      INSERT INTO entities (canonical_name, entity_type, corpus_id)
      VALUES (${`${TAG} Foreign Anchor`}, 'organization', ${CB})
      RETURNING id
    `;
    const foreignId = (foreign[0] as { id: string }).id;

    const epoch = randomUUID();
    // Stage into corpus CA, anchored at an entity that lives in CB.
    const handle = await stageEntity(epoch, `${TAG} Anchored Across`, 'organization', foreignId);
    await stageFact(epoch, handle, 'located_in', { objectValue: 'Testville', validAt: new Date('2026-02-02') });

    // Must NOT throw: previously this raised 23503 and took the epoch down.
    const res = await promote(epoch, { corpusId: CA });

    // The handle minted a FRESH entity in CA rather than binding across.
    const mintedIds = Object.values(res.mintedEntityIds);
    expect(mintedIds).toHaveLength(1);
    expect(mintedIds[0]).not.toBe(foreignId);

    const rows = await testDb.unsafe(
      `SELECT corpus_id FROM entities WHERE id = '${mintedIds[0]}'`,
    );
    expect((rows[0] as unknown as { corpus_id: string }).corpus_id).toBe(CA);

    // And the foreign entity is untouched in its own corpus.
    const still = await testDb.unsafe(
      `SELECT corpus_id FROM entities WHERE id = '${foreignId}'`,
    );
    expect((still[0] as unknown as { corpus_id: string }).corpus_id).toBe(CB);
  });

  it('still reuses by name WITHIN one corpus (scoping did not disable dedup)', async () => {
    // Entity-only: re-staging the same fact would hit uniq_facts_active_triple (mig 037),
    // which is correct behaviour and not what this test is about.
    const first = await apply(CA, false);
    const second = await apply(CA, false);
    expect(second).toBe(first);
  });
});
