/**
 * Phase 3 — Source Reference Indexing (doc 14, nmemo-d1r)
 *
 * Verifies the edge_source_refs reverse-lookup index stays in step with
 * causal_edges.source_references (the authoritative JSONB) across all
 * edge-mutation paths, and that findEdgesCitingReference returns correct
 * results with the documented semantics:
 *   - active edges only by default
 *   - includeExpired=true returns expired too
 *   - ref_type discriminates (memory vs fact vs entity with same UUID)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  testDb,
  createTestEntity,
  createTestFact,
  deleteFromTables,
  randomUUID,
} from '../setup.js';
import {
  createCausalEdge,
  expireCausalEdge,
  findEdgesCitingReference,
} from '../../services/causal.js';

async function cleanSlate(): Promise<void> {
  // edge_source_refs ON DELETE CASCADE from causal_edges; the global
  // ordered list above deletes causal_edges before causal_events, which
  // cascades the index entries. No explicit edge_source_refs delete.
  await deleteFromTables({
    tables: [
      'causal_edge_history',
      'fact_history',
      'causal_edges',
      'causal_events',
      'memory_entities',
      'entity_aliases',
      'facts',
      'entity_merges',
      'entities',
    ],
    acknowledgeGlobal: true,
  });
}

/**
 * Seed a fresh cause/effect event pair so each test starts with no edges
 * for that pair (avoids accidental corroboration with leftover state).
 */
async function seedEventPair(): Promise<{ causeEventId: string; effectEventId: string }> {
  const subject = await createTestEntity({
    canonicalName: `srf-subj-${randomUUID().slice(0, 8)}`,
    entityType: 'person',
  });
  const fact = await createTestFact({
    subjectEntityId: subject.id,
    predicate: 'works_at',
    objectValue: `srf-obj-${randomUUID().slice(0, 8)}`,
  });
  const [cause] = await testDb`
    INSERT INTO public.causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
    VALUES (${fact.id}::uuid, 'created', ${subject.id}::uuid, 'works_at', 'srf cause')
    RETURNING id
  `;
  const [effect] = await testDb`
    INSERT INTO public.causal_events (fact_id, transition_type, subject_entity_id, predicate, source_text)
    VALUES (${fact.id}::uuid, 'expired', ${subject.id}::uuid, 'works_at', 'srf effect')
    RETURNING id
  `;
  return {
    causeEventId: cause!.id as string,
    effectEventId: effect!.id as string,
  };
}

async function indexRefsForEdge(edgeId: string): Promise<Array<{ ref_type: string; ref_id: string }>> {
  return testDb`
    SELECT ref_type, ref_id::text AS ref_id
    FROM public.edge_source_refs
    WHERE edge_id = ${edgeId}::uuid
    ORDER BY ref_type, ref_id
  ` as unknown as Promise<Array<{ ref_type: string; ref_id: string }>>;
}

describe('Phase 3 — Source Reference Indexing: sync on edge creation', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('createCausalEdge populates edge_source_refs with one row per (type, id)', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const memId = randomUUID();
    const factId = randomUUID();

    const edgeId = await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: 'two refs of different type',
      sourceReferences: [
        { type: 'memory', id: memId, relevance: 'memory ref' },
        { type: 'fact', id: factId, relevance: 'fact ref' },
      ],
      actor: 'graph_agent',
    });

    const rows = await indexRefsForEdge(edgeId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.ref_type === 'memory')!.ref_id).toBe(memId);
    expect(rows.find((r) => r.ref_type === 'fact')!.ref_id).toBe(factId);
  });

  it('deduplicates identical (ref_type, ref_id) tuples within a single insert', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const memId = randomUUID();

    const edgeId = await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: 'duplicate refs collapsed by composite PK',
      sourceReferences: [
        { type: 'memory', id: memId, relevance: 'first relevance text' },
        { type: 'memory', id: memId, relevance: 'duplicate relevance text' },
      ],
      actor: 'graph_agent',
    });

    const rows = await indexRefsForEdge(edgeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref_id).toBe(memId);
  });
});

describe('Phase 3 — Source Reference Indexing: sync on corroboration', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('adds only newly-introduced refs to the index (addedDiff path)', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const mem1 = randomUUID();
    const mem2 = randomUUID();

    const firstId = await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: 'first assertion',
      sourceReferences: [{ type: 'memory', id: mem1, relevance: 'first source' }],
      actor: 'graph_agent',
    });

    const secondId = await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.6,
      reasoning: 'corroboration with new ref',
      sourceReferences: [{ type: 'memory', id: mem2, relevance: 'second source' }],
      actor: 'reasoning_agent',
    });
    expect(secondId).toBe(firstId);

    const rows = await indexRefsForEdge(firstId);
    const ids = rows.map((r) => r.ref_id).sort();
    expect(ids).toEqual([mem1, mem2].sort());
  });

  it('does not duplicate an already-indexed ref when the same source is re-asserted', async () => {
    const { causeEventId, effectEventId } = await seedEventPair();
    const mem1 = randomUUID();

    const firstId = await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.5,
      reasoning: 'first assertion',
      sourceReferences: [{ type: 'memory', id: mem1, relevance: 'first text' }],
      actor: 'graph_agent',
    });

    const secondId = await createCausalEdge({
      causeEventId,
      effectEventId,
      strength: 0.6,
      reasoning: 're-assert same ref — corroborates without adding to index',
      sourceReferences: [{ type: 'memory', id: mem1, relevance: 'identical re-assertion' }],
      actor: 'reasoning_agent',
    });
    expect(secondId).toBe(firstId);

    const rows = await indexRefsForEdge(firstId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref_id).toBe(mem1);
  });
});

describe('Phase 3 — Source Reference Indexing: findEdgesCitingReference', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('returns every active edge that cites the given (refType, refId)', async () => {
    // Build 3 edges; first 2 cite the same fact, third cites a different fact.
    const target = randomUUID();
    const decoy = randomUUID();

    const pair1 = await seedEventPair();
    const edge1 = await createCausalEdge({
      causeEventId: pair1.causeEventId,
      effectEventId: pair1.effectEventId,
      strength: 0.5,
      reasoning: 'edge1',
      sourceReferences: [{ type: 'fact', id: target, relevance: 'cites target' }],
      actor: 'graph_agent',
    });

    const pair2 = await seedEventPair();
    const edge2 = await createCausalEdge({
      causeEventId: pair2.causeEventId,
      effectEventId: pair2.effectEventId,
      strength: 0.6,
      reasoning: 'edge2',
      sourceReferences: [{ type: 'fact', id: target, relevance: 'cites target' }],
      actor: 'graph_agent',
    });

    const pair3 = await seedEventPair();
    const edge3 = await createCausalEdge({
      causeEventId: pair3.causeEventId,
      effectEventId: pair3.effectEventId,
      strength: 0.7,
      reasoning: 'edge3',
      sourceReferences: [{ type: 'fact', id: decoy, relevance: 'unrelated' }],
      actor: 'graph_agent',
    });

    const found = await findEdgesCitingReference('fact', target);
    const ids = found.map((e) => e.id).sort();
    expect(ids).toEqual([edge1, edge2].sort());
    expect(ids).not.toContain(edge3);
  });

  it('excludes expired edges by default', async () => {
    const target = randomUUID();

    const p1 = await seedEventPair();
    const live = await createCausalEdge({
      causeEventId: p1.causeEventId,
      effectEventId: p1.effectEventId,
      strength: 0.5,
      reasoning: 'live edge',
      sourceReferences: [{ type: 'fact', id: target, relevance: 'live' }],
      actor: 'graph_agent',
    });

    const p2 = await seedEventPair();
    const dead = await createCausalEdge({
      causeEventId: p2.causeEventId,
      effectEventId: p2.effectEventId,
      strength: 0.5,
      reasoning: 'edge that will be expired',
      sourceReferences: [{ type: 'fact', id: target, relevance: 'will die' }],
      actor: 'graph_agent',
    });
    await expireCausalEdge({ edgeId: dead, reasoning: 'tombstoned for test', actor: 'user' });

    const active = await findEdgesCitingReference('fact', target);
    expect(active.map((e) => e.id)).toEqual([live]);
  });

  it('returns expired edges too when includeExpired=true', async () => {
    const target = randomUUID();

    const p1 = await seedEventPair();
    const live = await createCausalEdge({
      causeEventId: p1.causeEventId,
      effectEventId: p1.effectEventId,
      strength: 0.5,
      reasoning: 'live',
      sourceReferences: [{ type: 'fact', id: target, relevance: 'live' }],
      actor: 'graph_agent',
    });

    const p2 = await seedEventPair();
    const dead = await createCausalEdge({
      causeEventId: p2.causeEventId,
      effectEventId: p2.effectEventId,
      strength: 0.5,
      reasoning: 'dead',
      sourceReferences: [{ type: 'fact', id: target, relevance: 'dead' }],
      actor: 'graph_agent',
    });
    await expireCausalEdge({ edgeId: dead, reasoning: 'tombstoned', actor: 'user' });

    const all = await findEdgesCitingReference('fact', target, { includeExpired: true });
    expect(all.map((e) => e.id).sort()).toEqual([live, dead].sort());
  });

  it('discriminates by ref_type — a memory query does not match fact-typed refs with the same UUID', async () => {
    // Contrived but important: a fact and a memory could (by accident or test
    // design) share a UUID. The index must not collapse them.
    const sharedId = randomUUID();

    const p1 = await seedEventPair();
    const factEdge = await createCausalEdge({
      causeEventId: p1.causeEventId,
      effectEventId: p1.effectEventId,
      strength: 0.5,
      reasoning: 'cites sharedId as fact',
      sourceReferences: [{ type: 'fact', id: sharedId, relevance: 'fact-typed' }],
      actor: 'graph_agent',
    });

    const p2 = await seedEventPair();
    const memEdge = await createCausalEdge({
      causeEventId: p2.causeEventId,
      effectEventId: p2.effectEventId,
      strength: 0.5,
      reasoning: 'cites sharedId as memory',
      sourceReferences: [{ type: 'memory', id: sharedId, relevance: 'memory-typed' }],
      actor: 'graph_agent',
    });

    const factHits = await findEdgesCitingReference('fact', sharedId);
    expect(factHits.map((e) => e.id)).toEqual([factEdge]);

    const memHits = await findEdgesCitingReference('memory', sharedId);
    expect(memHits.map((e) => e.id)).toEqual([memEdge]);
  });

  it('returns an empty array when no edges cite the given reference', async () => {
    const found = await findEdgesCitingReference('fact', randomUUID());
    expect(found).toEqual([]);
  });
});

describe('Phase 3 — Source Reference Indexing: drift detection', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('drift query returns 0 after a batch of mixed edge mutations', async () => {
    // Create several edges via the wired path; corroborate one; let one
    // expire. The drift query should return 0 across the lot.
    const refs = [randomUUID(), randomUUID(), randomUUID()];

    const p1 = await seedEventPair();
    const e1 = await createCausalEdge({
      causeEventId: p1.causeEventId,
      effectEventId: p1.effectEventId,
      strength: 0.5,
      reasoning: 'e1',
      sourceReferences: [{ type: 'memory', id: refs[0]!, relevance: 'r' }],
      actor: 'graph_agent',
    });

    const p2 = await seedEventPair();
    await createCausalEdge({
      causeEventId: p2.causeEventId,
      effectEventId: p2.effectEventId,
      strength: 0.5,
      reasoning: 'e2',
      sourceReferences: [
        { type: 'fact', id: refs[1]!, relevance: 'r1' },
        { type: 'fact', id: refs[2]!, relevance: 'r2' },
      ],
      actor: 'graph_agent',
    });

    // Corroborate e1 with a new ref — exercises the addedDiff sync
    await createCausalEdge({
      causeEventId: p1.causeEventId,
      effectEventId: p1.effectEventId,
      strength: 0.6,
      reasoning: 'corroborate e1',
      sourceReferences: [{ type: 'memory', id: refs[1]!, relevance: 'cross-cite' }],
      actor: 'reasoning_agent',
    });

    // Expire one edge — index rows stay (cascade only fires on edge DELETE)
    await expireCausalEdge({ edgeId: e1, reasoning: 'tombstone', actor: 'user' });

    const [{ drift }] = await testDb`
      WITH normalized AS (
        SELECT
          e.id AS edge_id,
          CASE
            WHEN jsonb_typeof(e.source_references) = 'array' THEN e.source_references
            WHEN jsonb_typeof(e.source_references) = 'string' THEN (e.source_references #>> '{}')::jsonb
            ELSE '[]'::jsonb
          END AS refs
        FROM public.causal_edges e
      )
      SELECT COUNT(*)::int AS drift
      FROM normalized n
      CROSS JOIN LATERAL jsonb_array_elements(n.refs) ref
      WHERE ref->>'type' IN ('memory','fact','entity')
        AND ref->>'id' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.edge_source_refs r
          WHERE r.edge_id = n.edge_id
            AND r.ref_type = (ref->>'type')
            AND r.ref_id = (ref->>'id')::uuid
        )
    ` as unknown as Array<{ drift: number }>;

    expect(drift).toBe(0);
  });
});
