/**
 * Graph-anchored fallback — query-failure TRIGGER + RE-RANK, integrated
 * (bead nmemo-0wq.3; design doc 38 §4 anchor seeding, §5 re-rank, §6 trigger).
 *
 * ISOLATION (mandatory — .3 is trigger + anchor-seed + re-rank logic only):
 *   - Postgres: cognitive_test (src/test/setup.ts DATABASE_URL default).
 *   - Qdrant: memories_test (QDRANT_COLLECTION='memories_test', bead .wow).
 *   - SYNTHETIC data ONLY. Entities + facts seeded in Postgres; AGE nodes/edges
 *     seeded DIRECTLY via cypher MERGE (trigger-free, idempotent — same pattern
 *     as graph-fallback.test.ts); unit points upserted into memories_test with
 *     CONTROLLED vectors so the cosine re-rank ordering is deterministic.
 *   - NO real graph agent / ml-services / Ollama / production collections.
 *     The query embedding is supplied as a controlled vector (in production the
 *     /api/reason/query boundary reuses the flat-search query embedding) — this
 *     suite exercises recallViaGraph + flatRetrievalFailed DIRECTLY, which is
 *     the acceptance per the bead's isolation note (no real-agent end-to-end).
 *
 * Acceptance (bd show nmemo-0wq.3):
 *   (a) a failing flat query (top score < floor, or empty) WITH a reachable
 *       neighbour answer triggers expansion + re-rank and surfaces the
 *       recovered unit;
 *   (b) a SUCCESSFUL flat query (top score >= floor) does NOT trigger the
 *       fallback (no regression / no extra work);
 *   (c) the re-rank orders fetched evidence by unit-grained cosine vs the query.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import {
  testDb,
  createTestEntity,
  randomEmbedding,
  normalizeVector,
  isQdrantAvailable,
  skipCtx,
  TEST_EMBED_DIMENSIONS,
} from '../setup.js';
import { qdrant, COLLECTIONS } from '../../services/qdrant.js';
import { findConnectedEntities } from '../../services/graph.js';
import {
  flatRetrievalFailed,
  recallViaGraph,
  type FlatHit,
} from '../../services/graph-fallback.js';

// --- AGE seed helpers (trigger-free MERGE; identical approach to .2's suite) ---

function relType(predicate: string): string {
  return predicate.toUpperCase().replace(/[^A-Z_]/g, '_');
}

async function ageMergeNode(entityId: string, name: string, type: string): Promise<void> {
  await testDb.unsafe(
    `SELECT * FROM cypher('knowledge_graph', $$
       MERGE (e:Entity {entity_id: '${entityId}'})
       SET e.name = '${name.replace(/'/g, '')}', e.type = '${type}'
       RETURN e
     $$) AS (v agtype)`,
  );
}

async function ageMergeEdge(fromId: string, toId: string, predicate: string): Promise<void> {
  const rel = relType(predicate);
  await testDb.unsafe(
    `SELECT * FROM cypher('knowledge_graph', $$
       MATCH (a:Entity {entity_id: '${fromId}'})
       MATCH (b:Entity {entity_id: '${toId}'})
       MERGE (a)-[r:${rel}]->(b)
       RETURN r
     $$) AS (v agtype)`,
  );
}

async function ageDeleteNodes(entityIds: string[]): Promise<void> {
  for (const id of entityIds) {
    try {
      await testDb.unsafe(
        `SELECT * FROM cypher('knowledge_graph', $$
           MATCH (e:Entity {entity_id: '${id}'}) DETACH DELETE e
         $$) AS (v agtype)`,
      );
    } catch {
      // best-effort cleanup of the shared test graph
    }
  }
}

/** Same readiness probe as the .2 suite: only run if AGE traversal works. */
async function ageTraversalWorks(): Promise<boolean> {
  try {
    const ext = await testDb`SELECT 1 FROM pg_extension WHERE extname = 'age'`;
    if (ext.length === 0) return false;
    const a = await createTestEntity({ canonicalName: `tprobe-a-${randomUUID().slice(0, 8)}`, entityType: 'person' });
    const b = await createTestEntity({ canonicalName: `tprobe-b-${randomUUID().slice(0, 8)}`, entityType: 'person' });
    let ok = false;
    try {
      await ageMergeNode(a.id, 'tprobe-a', 'person');
      await ageMergeNode(b.id, 'tprobe-b', 'person');
      await ageMergeEdge(a.id, b.id, 'knows');
      const reached = await findConnectedEntities(a.id, { maxDepth: 1 });
      ok = reached.some((n) => n.entityId === b.id);
    } finally {
      await ageDeleteNodes([a.id, b.id]);
      await testDb`DELETE FROM facts WHERE subject_entity_id = ${a.id}::uuid OR object_entity_id = ${a.id}::uuid`;
      await testDb`DELETE FROM entities WHERE id = ANY(${[a.id, b.id]})`;
    }
    return ok;
  } catch {
    return false;
  }
}

// --- synthetic-data builders ---

const createdEntityIds: string[] = [];
const createdPointIds: string[] = [];
const createdWindowIds: string[] = [];

async function mkEntity(name: string): Promise<string> {
  const canonicalName = `${name}-${randomUUID().slice(0, 8)}`;
  const e = await createTestEntity({ canonicalName, entityType: 'person' });
  await ageMergeNode(e.id, canonicalName, 'person');
  createdEntityIds.push(e.id);
  return e.id;
}

async function insertFact(args: {
  subjectId: string;
  objectId: string;
  predicate: string;
  sourceMemoryId: string;
  sourceText: string;
}): Promise<string> {
  const rows = await testDb`
    INSERT INTO facts (subject_entity_id, predicate, object_entity_id, source_memory_id, source_text)
    VALUES (${args.subjectId}::uuid, ${args.predicate}, ${args.objectId}::uuid,
            ${args.sourceMemoryId}::uuid, ${args.sourceText})
    RETURNING id
  `;
  await ageMergeEdge(args.subjectId, args.objectId, args.predicate);
  return rows[0]!.id as string;
}

async function linkFactUnit(args: {
  factId: string;
  unitPointId: string;
  matchKind: string;
}): Promise<void> {
  await testDb`
    INSERT INTO fact_units (fact_id, unit_point_id, char_start, char_end, match_kind)
    VALUES (${args.factId}::uuid, ${args.unitPointId}, 0, 10, ${args.matchKind})
    ON CONFLICT (fact_id, unit_point_id) DO NOTHING
  `;
}

/** Link a window (flat hit) to an entity so anchor seeding (§4.1.1) can resolve it. */
async function linkMemoryEntity(memoryId: string, entityId: string): Promise<void> {
  await testDb`
    INSERT INTO memory_entities (memory_id, entity_id)
    VALUES (${memoryId}::uuid, ${entityId}::uuid)
    ON CONFLICT DO NOTHING
  `;
}

/** Upsert a unit satellite with a CONTROLLED vector so cosine ordering is known. */
async function upsertUnitWithVector(args: {
  pointId: string;
  parentWindowId: string;
  unitText: string;
  vector: number[];
}): Promise<void> {
  await qdrant.upsert(COLLECTIONS.MEMORIES, {
    points: [
      {
        id: args.pointId,
        vector: normalizeVector(args.vector),
        payload: {
          point_type: 'unit',
          parent_window_id: args.parentWindowId,
          unit_text: args.unitText,
        },
      },
    ],
  });
}

/**
 * Build a 768-d vector that aligns with the query direction (basis e0) by a
 * controllable amount `align` in [0,1]: align=1 is identical-direction (cosine
 * ~1), align=0 is orthogonal-ish (the rest of the vector is small random noise
 * on the other axes). Lets us assert deterministic re-rank ordering.
 */
const QUERY_VECTOR = (() => {
  const v = new Array(TEST_EMBED_DIMENSIONS).fill(0);
  v[0] = 1; // query points purely along e0
  return v;
})();

function alignedVector(align: number): number[] {
  const v = randomEmbedding().map((x) => x * 0.01); // small noise on all axes
  v[0] = align; // dominant component along the query axis
  return v;
}

describe('recallViaGraph — query-failure trigger + re-rank (synthetic, isolated)', () => {
  let ready = false;

  beforeAll(async () => {
    ready = (await isQdrantAvailable()) && (await ageTraversalWorks());
    if (!ready) {
      console.warn(
        'graph-fallback-trigger suite SKIPPED: Qdrant unavailable or AGE traversal non-functional in cognitive_test.',
      );
    }
  });

  beforeEach(async () => {
    await testDb`DELETE FROM fact_units`;
  });

  afterAll(async () => {
    await testDb`DELETE FROM fact_units`;
    if (createdEntityIds.length > 0) {
      await ageDeleteNodes(createdEntityIds);
      await testDb`DELETE FROM memory_entities WHERE entity_id = ANY(${createdEntityIds})`;
      await testDb`DELETE FROM facts WHERE subject_entity_id = ANY(${createdEntityIds}) OR object_entity_id = ANY(${createdEntityIds})`;
      await testDb`DELETE FROM entities WHERE id = ANY(${createdEntityIds})`;
    }
    if (createdPointIds.length > 0) {
      try {
        await qdrant.delete(COLLECTIONS.MEMORIES, { points: createdPointIds });
      } catch {
        // best-effort cleanup of the isolated test collection
      }
    }
  });

  // ---- (§6.1) the trigger: pure failure-detection over the flat result ----

  describe('flatRetrievalFailed (§6.1)', () => {
    it('fires on an empty flat result', () => {
      expect(flatRetrievalFailed([])).toBe(true);
    });

    it('fires when the top score is below the floor', () => {
      const hits: FlatHit[] = [{ id: randomUUID(), score: 0.41 }, { id: randomUUID(), score: 0.2 }];
      expect(flatRetrievalFailed(hits, 0.5)).toBe(true);
    });

    it('does NOT fire when a hit clears the floor (no regression)', () => {
      const hits: FlatHit[] = [{ id: randomUUID(), score: 0.72 }, { id: randomUUID(), score: 0.1 }];
      expect(flatRetrievalFailed(hits, 0.5)).toBe(false);
    });

    it('uses the TOP score, not the first/last, vs the floor', () => {
      const hits: FlatHit[] = [{ id: randomUUID(), score: 0.3 }, { id: randomUUID(), score: 0.66 }];
      expect(flatRetrievalFailed(hits, 0.5)).toBe(false); // 0.66 clears it
    });
  });

  // ---- (a) failing flat query WITH a reachable neighbour -> recovered ----

  it('(a) recovers the neighbour unit on a FAILED flat query', async (ctx) => {
    if (!ready) return skipCtx(ctx);

    // anchor is named in a weak flat hit; the answer lives on a neighbour fact.
    const anchor = await mkEntity('anchor');
    const neighbour = await mkEntity('neighbour');

    const weakWindow = randomUUID(); // the surviving (weak) flat hit
    createdWindowIds.push(weakWindow);
    await linkMemoryEntity(weakWindow, anchor); // §4.1.1 seed: hit -> anchor entity

    const answerWindow = randomUUID();
    const answerUnit = randomUUID();
    const answerText = 'graduated in Business Administration in 2015';
    // The answer unit aligns strongly with the query direction.
    await upsertUnitWithVector({
      pointId: answerUnit,
      parentWindowId: answerWindow,
      unitText: answerText,
      vector: alignedVector(1.0),
    });
    createdPointIds.push(answerUnit);

    const factId = await insertFact({
      subjectId: anchor,
      objectId: neighbour,
      predicate: 'studied_at',
      sourceMemoryId: answerWindow,
      sourceText: answerText,
    });
    await linkFactUnit({ factId, unitPointId: answerUnit, matchKind: 'offset_overlap' });

    // The failed flat result: one weak hit below the 0.5 floor.
    const flatHits: FlatHit[] = [{ id: weakWindow, score: 0.38 }];
    expect(flatRetrievalFailed(flatHits, 0.5)).toBe(true); // trigger fires

    const recovered = await recallViaGraph(QUERY_VECTOR, flatHits);
    expect(recovered.length).toBeGreaterThanOrEqual(1);
    const top = recovered[0]!;
    expect(top.qdrantPointId).toBe(answerUnit);
    expect(top.unitText).toBe(answerText); // UNIT-grained recovered evidence
    expect(top.neighbourEntityId).toBe(neighbour);
    expect(top.factId).toBe(factId);
    expect(top.cosine).toBeGreaterThan(0.9); // strongly aligned with the query
  });

  // ---- (b) successful flat query -> no fallback work (no regression) ----

  it('(b) does NOT fire on a SUCCESSFUL flat query (trigger gate)', async (ctx) => {
    if (!ready) return skipCtx(ctx);

    // A strong flat hit: the integrated path must NOT invoke the fallback.
    // We assert the GATE (flatRetrievalFailed=false) is what guards recallViaGraph,
    // exactly as the integration wiring uses it (see causal-agent boundary check).
    const strongHits: FlatHit[] = [{ id: randomUUID(), score: 0.82 }];
    expect(flatRetrievalFailed(strongHits, 0.5)).toBe(false);

    // The integrated path is: `if (flatRetrievalFailed(hits)) recallViaGraph(...)`.
    // With the gate false, recallViaGraph is never called — no graph walk, no
    // re-rank, no extra Qdrant reads. We model that here and assert the gate.
    let fallbackInvoked = false;
    if (flatRetrievalFailed(strongHits, 0.5)) {
      fallbackInvoked = true;
      await recallViaGraph(QUERY_VECTOR, strongHits);
    }
    expect(fallbackInvoked).toBe(false);
  });

  // ---- (c) re-rank orders by unit-grained cosine vs the query ----

  it('(c) re-ranks fetched evidence by unit-grained cosine vs the query', async (ctx) => {
    if (!ready) return skipCtx(ctx);

    const anchor = await mkEntity('hub');
    const weakWindow = randomUUID();
    createdWindowIds.push(weakWindow);
    await linkMemoryEntity(weakWindow, anchor);

    // Three neighbour facts, same predicate (so predicate weight is uniform and
    // cosine alone decides ordering). Their unit vectors have DESCENDING
    // alignment with the query, so the expected rank is high -> mid -> low.
    const specs = [
      { name: 'high', align: 1.0, text: 'the strongly-relevant answer unit' },
      { name: 'mid', align: 0.5, text: 'a moderately-relevant unit' },
      { name: 'low', align: 0.05, text: 'a barely-relevant unit' },
    ];
    const expectedUnitIds: Record<string, string> = {};
    for (const s of specs) {
      const nb = await mkEntity(s.name);
      const w = randomUUID();
      const unit = randomUUID();
      await upsertUnitWithVector({ pointId: unit, parentWindowId: w, unitText: s.text, vector: alignedVector(s.align) });
      createdPointIds.push(unit);
      const f = await insertFact({ subjectId: anchor, objectId: nb, predicate: 'related_to', sourceMemoryId: w, sourceText: s.text });
      await linkFactUnit({ factId: f, unitPointId: unit, matchKind: 'offset_overlap' });
      expectedUnitIds[s.name] = unit;
    }

    const flatHits: FlatHit[] = [{ id: weakWindow, score: 0.3 }];
    const ranked = await recallViaGraph(QUERY_VECTOR, flatHits, { limit: 10 });

    expect(ranked.length).toBe(3);
    // Ordered by descending cosine == descending rerankScore (uniform pred weight).
    expect(ranked[0]!.qdrantPointId).toBe(expectedUnitIds.high);
    expect(ranked[1]!.qdrantPointId).toBe(expectedUnitIds.mid);
    expect(ranked[2]!.qdrantPointId).toBe(expectedUnitIds.low);
    expect(ranked[0]!.cosine).toBeGreaterThan(ranked[1]!.cosine);
    expect(ranked[1]!.cosine).toBeGreaterThan(ranked[2]!.cosine);
    // rerankScore monotonic with cosine here.
    expect(ranked[0]!.rerankScore).toBeGreaterThan(ranked[1]!.rerankScore);
    expect(ranked[1]!.rerankScore).toBeGreaterThan(ranked[2]!.rerankScore);
  });

  // ---- §4.2: no-anchor case returns [] (booster, not guarantee) ----

  it('returns [] when no anchor seeds (no-anchor case, §4.2)', async (ctx) => {
    if (!ready) return skipCtx(ctx);
    // Flat hits whose windows link to NO entity, and no injected seeds.
    const hits: FlatHit[] = [{ id: randomUUID(), score: 0.2 }];
    const result = await recallViaGraph(QUERY_VECTOR, hits);
    expect(result).toEqual([]);
  });

  it('honours the anchor cap (FALLBACK_MAX_ANCHORS) on injected seeds', async (ctx) => {
    if (!ready) return skipCtx(ctx);
    // 7 injected seed entities, each with a neighbour fact; cap is 5 by default,
    // so at most 5 anchors expand. We assert recall does not blow past the cap
    // by counting DISTINCT anchors among the recovered units' neighbours' edges.
    const seeds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const a = await mkEntity(`seed${i}`);
      const nb = await mkEntity(`nb${i}`);
      const w = randomUUID();
      const unit = randomUUID();
      await upsertUnitWithVector({ pointId: unit, parentWindowId: w, unitText: `unit ${i}`, vector: alignedVector(0.5) });
      createdPointIds.push(unit);
      const f = await insertFact({ subjectId: a, objectId: nb, predicate: 'knows', sourceMemoryId: w, sourceText: `s${i}` });
      await linkFactUnit({ factId: f, unitPointId: unit, matchKind: 'offset_overlap' });
      seeds.push(a);
    }
    // No flat-hit anchors; all 7 come in as injected seeds. recallViaGraph caps
    // anchors at 5, so the returned (limit-bounded) set never reflects all 7.
    const ranked = await recallViaGraph(QUERY_VECTOR, [], { seedEntityIds: seeds, limit: 100 });
    // The recovered units come from at most MAX_ANCHORS (5) distinct anchors.
    // Each seed has exactly one neighbour fact, so distinct factIds <= 5.
    const distinctFacts = new Set(ranked.map((r) => r.factId));
    expect(distinctFacts.size).toBeLessThanOrEqual(5);
    expect(distinctFacts.size).toBeGreaterThanOrEqual(1);
  });
});
