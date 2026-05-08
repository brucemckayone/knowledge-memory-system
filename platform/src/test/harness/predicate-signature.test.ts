/**
 * Phase 4 prep — predicate-signature populator (doc 25 §2.2 W4)
 *
 * Migration 014 declared `entity_topology.predicate_signature VECTOR(25)`
 * but left the compute path "TBD". This module owns it now (Phase 4 prep).
 * These tests pin the contract that doc 25's role_similarity reads:
 *   role_similarity(a, b) = cosine(predicate_signature_a, predicate_signature_b)
 *
 * Coverage maps to the populator's responsibilities:
 *   - Single-predicate entity → unit basis vector at the canonical index
 *   - Multi-predicate entity → L2-normalised mix of bins
 *   - Count multiplicity collapses to direction (3x works_at == 1x works_at direction)
 *   - Identical predicate sets → cosine == 1.0 across two entities
 *   - No outgoing facts → NULL signature, skipped count incremented
 *   - Alias predicates (e.g. "worked_at") land on canonical bin (works_at)
 *   - All-non-canonical predicates → zero norm → NULL, skipped
 *   - Idempotent: running twice yields the same vector
 *   - Update on new fact: re-running shifts direction
 *   - Pre-existing entity_topology row with other columns set → only
 *     predicate_signature is touched, sibling columns preserved (this is the
 *     critical safety property: the populator must not stomp Phase 2 work).
 *
 * Uses `testDb` against `cognitive_test`. No Python sidecar — populator is
 * pure TypeScript. `deleteFromTables` between tests so each case is isolated.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  testDb,
  createTestEntity,
  createTestFact,
  deleteFromTables,
} from '../setup.js';
import {
  populatePredicateSignatures,
  computePredicateSignature,
  cosineSignatureSimilarity,
  getPredicateOrder,
} from '../../services/predicate-signature.js';

const ORDER = getPredicateOrder();
const IDX_WORKS_AT = ORDER.indexOf('works_at');
const IDX_MANAGES = ORDER.indexOf('manages');
const IDX_LIVES_IN = ORDER.indexOf('lives_in');

/** Parse a pgvector text output like '[0.1,0.2,...]' into number[]. */
function parseVec(raw: string | null): number[] | null {
  if (!raw) return null;
  return raw.replace(/^\[|\]$/g, '').split(',').map((s) => Number.parseFloat(s));
}

async function getSignature(entityId: string): Promise<number[] | null> {
  const rows = await testDb<{ predicate_signature: string | null }[]>`
    SELECT predicate_signature::text AS predicate_signature
    FROM public.entity_topology WHERE entity_id = ${entityId}::uuid
  `;
  if (rows.length === 0) return null;
  return parseVec(rows[0]!.predicate_signature);
}

describe('predicate-signature populator', () => {
  beforeEach(async () => {
    // Wipe everything that could leave outgoing-fact noise. entity_topology
    // is cleaned via the entity FK cascade.
    await deleteFromTables({ acknowledgeGlobal: true });
    await testDb`DELETE FROM public.entity_topology`;
  });

  it('vocabulary order is stable and 25-dim per migration 014 lock', () => {
    expect(ORDER.length).toBe(25);
    expect(IDX_WORKS_AT).toBeGreaterThanOrEqual(0);
    expect(IDX_MANAGES).toBeGreaterThanOrEqual(0);
    expect(IDX_LIVES_IN).toBeGreaterThanOrEqual(0);
  });

  it('pure helper: single canonical predicate yields unit basis vector', () => {
    const sig = computePredicateSignature(['works_at']);
    expect(sig).not.toBeNull();
    expect(sig![IDX_WORKS_AT]).toBeCloseTo(1.0, 6);
    let nonZero = 0;
    for (const v of sig!) if (v > 0) nonZero++;
    expect(nonZero).toBe(1);
  });

  it('pure helper: multiple canonical predicates split L2-normalised', () => {
    const sig = computePredicateSignature(['works_at', 'manages']);
    expect(sig).not.toBeNull();
    const expected = 1 / Math.sqrt(2);
    expect(sig![IDX_WORKS_AT]).toBeCloseTo(expected, 6);
    expect(sig![IDX_MANAGES]).toBeCloseTo(expected, 6);
  });

  it('pure helper: count multiplicity collapses to direction (3x same predicate == 1x)', () => {
    const sigOne = computePredicateSignature(['works_at']);
    const sigThree = computePredicateSignature(['works_at', 'works_at', 'works_at']);
    expect(sigOne).not.toBeNull();
    expect(sigThree).not.toBeNull();
    // Direction (cosine) should be 1; cosineSignatureSimilarity expects unit vectors.
    expect(cosineSignatureSimilarity(sigOne, sigThree)).toBeCloseTo(1.0, 6);
  });

  it('pure helper: aliases normalise to canonical bins ("worked_at" → works_at)', () => {
    const direct = computePredicateSignature(['works_at']);
    const aliased = computePredicateSignature(['worked_at']);
    expect(direct).not.toBeNull();
    expect(aliased).not.toBeNull();
    expect(cosineSignatureSimilarity(direct, aliased)).toBeCloseTo(1.0, 6);
  });

  it('pure helper: all-unknown predicates yield zero-norm → null', () => {
    const sig = computePredicateSignature(['totally_made_up_predicate', 'another_unknown']);
    expect(sig).toBeNull();
  });

  it('populator writes a unit vector for an entity with one outgoing fact', async () => {
    const subj = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const obj = await createTestEntity({ canonicalName: 'Acme', entityType: 'organization' });
    await createTestFact({ subjectEntityId: subj.id, predicate: 'works_at', objectEntityId: obj.id });

    const result = await populatePredicateSignatures();
    expect(result.entitiesProcessed).toBe(1);
    expect(result.entitiesSkipped).toBe(0);

    const sig = await getSignature(subj.id);
    expect(sig).not.toBeNull();
    expect(sig![IDX_WORKS_AT]).toBeCloseTo(1.0, 6);
    // Object-side entity has no outgoing facts → no row written.
    const objSig = await getSignature(obj.id);
    expect(objSig).toBeNull();
  });

  it('populator: two entities with identical predicate sets have cosine == 1', async () => {
    const a = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'Bob', entityType: 'person' });
    const o = await createTestEntity({ canonicalName: 'Acme', entityType: 'organization' });
    await createTestFact({ subjectEntityId: a.id, predicate: 'works_at', objectEntityId: o.id });
    await createTestFact({ subjectEntityId: a.id, predicate: 'manages', objectEntityId: b.id });
    await createTestFact({ subjectEntityId: b.id, predicate: 'works_at', objectEntityId: o.id });
    await createTestFact({ subjectEntityId: b.id, predicate: 'manages', objectEntityId: a.id });

    await populatePredicateSignatures();
    const sigA = await getSignature(a.id);
    const sigB = await getSignature(b.id);
    expect(sigA).not.toBeNull();
    expect(sigB).not.toBeNull();
    expect(cosineSignatureSimilarity(sigA, sigB)).toBeCloseTo(1.0, 6);
  });

  it('populator: entity with all-unknown predicates is skipped (NULL signature)', async () => {
    const subj = await createTestEntity({ canonicalName: 'Solo', entityType: 'person' });
    const obj = await createTestEntity({ canonicalName: 'Place', entityType: 'location' });
    await createTestFact({
      subjectEntityId: subj.id,
      predicate: 'unknown_relationship_xyz',
      objectEntityId: obj.id,
    });

    const result = await populatePredicateSignatures();
    expect(result.entitiesProcessed).toBe(0);
    expect(result.entitiesSkipped).toBe(1);
    expect(await getSignature(subj.id)).toBeNull();
  });

  it('populator: idempotent — second run produces identical vector', async () => {
    const subj = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const obj = await createTestEntity({ canonicalName: 'Acme', entityType: 'organization' });
    await createTestFact({ subjectEntityId: subj.id, predicate: 'works_at', objectEntityId: obj.id });
    await createTestFact({ subjectEntityId: subj.id, predicate: 'manages', objectEntityId: obj.id });

    await populatePredicateSignatures();
    const sig1 = await getSignature(subj.id);
    await populatePredicateSignatures();
    const sig2 = await getSignature(subj.id);

    expect(sig1).not.toBeNull();
    expect(sig2).not.toBeNull();
    expect(sig1!.length).toBe(sig2!.length);
    for (let i = 0; i < sig1!.length; i++) {
      expect(sig1![i]).toBeCloseTo(sig2![i] ?? -999, 6);
    }
  });

  it('populator: re-running after a new fact is added updates the signature', async () => {
    const subj = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const obj = await createTestEntity({ canonicalName: 'Place', entityType: 'location' });
    await createTestFact({ subjectEntityId: subj.id, predicate: 'works_at', objectEntityId: obj.id });

    await populatePredicateSignatures();
    const sigBefore = await getSignature(subj.id);
    expect(sigBefore![IDX_WORKS_AT]).toBeCloseTo(1.0, 6);
    expect(sigBefore![IDX_LIVES_IN]).toBeCloseTo(0.0, 6);

    await createTestFact({ subjectEntityId: subj.id, predicate: 'lives_in', objectEntityId: obj.id });
    await populatePredicateSignatures();
    const sigAfter = await getSignature(subj.id);
    const expected = 1 / Math.sqrt(2);
    expect(sigAfter![IDX_WORKS_AT]).toBeCloseTo(expected, 6);
    expect(sigAfter![IDX_LIVES_IN]).toBeCloseTo(expected, 6);
  });

  it('populator: scoped run touches only the requested entities', async () => {
    const a = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const b = await createTestEntity({ canonicalName: 'Bob', entityType: 'person' });
    const o = await createTestEntity({ canonicalName: 'Acme', entityType: 'organization' });
    await createTestFact({ subjectEntityId: a.id, predicate: 'works_at', objectEntityId: o.id });
    await createTestFact({ subjectEntityId: b.id, predicate: 'manages', objectEntityId: o.id });

    const result = await populatePredicateSignatures([a.id]);
    expect(result.entitiesProcessed).toBe(1);
    expect(await getSignature(a.id)).not.toBeNull();
    expect(await getSignature(b.id)).toBeNull();
  });

  it('populator: pre-existing entity_topology row preserves sibling columns', async () => {
    const subj = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const obj = await createTestEntity({ canonicalName: 'Acme', entityType: 'organization' });
    await createTestFact({ subjectEntityId: subj.id, predicate: 'works_at', objectEntityId: obj.id });

    // Seed a Phase 2-style row: component / pagerank / etc set, predicate_signature NULL.
    await testDb`
      INSERT INTO public.entity_topology
        (entity_id, component_id, component_size, k_core, is_articulation_point,
         community_id, participation_coef, pagerank, betweenness_sampled,
         predicate_signature, computation_version)
      VALUES (${subj.id}::uuid, 7, 42, 3, TRUE, 11, 0.42, 0.123, 0.456, NULL, 5)
    `;

    await populatePredicateSignatures([subj.id]);

    const rows = await testDb<{
      component_id: number; component_size: number; k_core: number;
      is_articulation_point: boolean; community_id: number;
      participation_coef: number; pagerank: number; betweenness_sampled: number;
      predicate_signature: string | null; computation_version: number;
    }[]>`
      SELECT component_id, component_size, k_core, is_articulation_point,
             community_id, participation_coef, pagerank, betweenness_sampled,
             predicate_signature::text AS predicate_signature,
             computation_version
      FROM public.entity_topology WHERE entity_id = ${subj.id}::uuid
    `;
    const r = rows[0]!;
    // All sibling columns survive — populator did not stomp them.
    expect(r.component_id).toBe(7);
    expect(r.component_size).toBe(42);
    expect(r.k_core).toBe(3);
    expect(r.is_articulation_point).toBe(true);
    expect(r.community_id).toBe(11);
    expect(r.participation_coef).toBeCloseTo(0.42, 6);
    expect(r.pagerank).toBeCloseTo(0.123, 6);
    expect(r.betweenness_sampled).toBeCloseTo(0.456, 6);
    expect(r.computation_version).toBe(5);
    // And the signature is now populated.
    const sig = parseVec(r.predicate_signature);
    expect(sig).not.toBeNull();
    expect(sig![IDX_WORKS_AT]).toBeCloseTo(1.0, 6);
  });

  it('populator: expired facts do not contribute', async () => {
    const subj = await createTestEntity({ canonicalName: 'Alice', entityType: 'person' });
    const obj = await createTestEntity({ canonicalName: 'Place', entityType: 'location' });
    // Active fact: works_at. Expired fact: lives_in (should not influence the signature).
    await createTestFact({ subjectEntityId: subj.id, predicate: 'works_at', objectEntityId: obj.id });
    await createTestFact({
      subjectEntityId: subj.id,
      predicate: 'lives_in',
      objectEntityId: obj.id,
      expiredAt: new Date(),
    });

    await populatePredicateSignatures();
    const sig = await getSignature(subj.id);
    expect(sig).not.toBeNull();
    expect(sig![IDX_WORKS_AT]).toBeCloseTo(1.0, 6);
    expect(sig![IDX_LIVES_IN]).toBeCloseTo(0.0, 6);
  });
});
