/**
 * Graph-anchored fallback — neighbour expansion + evidence-unit fetch
 * (bead nmemo-0wq.2; design doc 38 §3, §8.1).
 *
 * ISOLATION (mandatory — bead .2 is pure traversal + retrieval logic):
 *   - Postgres: cognitive_test only (via src/test/setup.ts DATABASE_URL default).
 *   - Qdrant: memories_test only (via QDRANT_COLLECTION='memories_test', bead .wow).
 *   - SYNTHETIC data ONLY: we seed entities + facts in Postgres, and seed their
 *     AGE nodes/edges in the knowledge_graph DIRECTLY via cypher MERGE (see
 *     `ageMergeNode`/`ageMergeEdge` below), plus fact_units rows pointing at
 *     synthetic unit point ids we upsert into memories_test ourselves.
 *
 * WHY WE SEED AGE NODES/EDGES DIRECTLY (trigger-independent, idempotent):
 *   The entity-sync trigger PREVIOUSLY silently no-op'd: `sync_entity_to_graph`
 *   ran `MERGE (e) SET e.updated_at = localtimestamp`, which this AGE build
 *   rejects inside cypher ("could not find rte for localtimestamp", SQLSTATE
 *   42703), and `create_entity_edge` had an ambiguous 3-arg/4-arg overload
 *   ("function is not unique"). The bare-catch swallowed both as WARNINGs, so
 *   entity inserts populated ZERO AGE nodes and findConnectedEntities returned [].
 *   That bug is FIXED by migration 039 (bead nmemo-zgw) — the trigger now syncs.
 *   This suite still seeds the AGE node/edge itself via a trigger-free MERGE so
 *   the synthetic graph is deterministic and the suite is robust to any future
 *   AGE-sync regression; with the trigger fixed the direct MERGE is idempotent
 *   belt-and-suspenders over the same knowledge_graph + findConnectedEntities
 *   read path. Nothing global is changed; other suites see cognitive_test as before.
 *
 * Legacy note (superseded): earlier this file assumed the entities_sync_graph /
 * facts_sync_graph triggers would populate AGE; they don't in cognitive_test.
 *   - NO real graph agent, NO ml-services, NO embeddings, NO Ollama, NO
 *     production memories/cognitive. Vectors are random unit vectors (the
 *     primitive never re-ranks on them — that's bead .3).
 *
 * Acceptance (bd show nmemo-0wq.2):
 *   expansion from anchor reaches neighbours within the depth cap, ranks/caps
 *   candidates per §3, and fetches the UNIT-grained evidence behind each
 *   neighbour fact via fact_units -> unit_point_id -> memories_test retrieve.
 *   Covers: depth cap, candidate cap (~20), missing-unit graceful path.
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
} from '../setup.js';
import { qdrant, COLLECTIONS } from '../../services/qdrant.js';
import { findConnectedEntities } from '../../services/graph.js';
import { expandFromAnchors } from '../../services/graph-fallback.js';

/** A cypher relationship type — uppercased A–Z/underscore, mirrors create_entity_edge. */
function relType(predicate: string): string {
  return predicate.toUpperCase().replace(/[^A-Z_]/g, '_');
}

/**
 * Merge an Entity node into the knowledge_graph directly (test-local AGE seed).
 * Deliberately omits the `SET e.updated_at = localtimestamp` that the production
 * sync_entity_to_graph trigger uses and that this AGE build rejects (SQLSTATE
 * 42703). Sets only the properties findConnectedEntities reads back (entity_id,
 * name, type). Idempotent via MERGE; scoped to this file.
 */
async function ageMergeNode(entityId: string, name: string, type: string): Promise<void> {
  await testDb.unsafe(
    `SELECT * FROM cypher('knowledge_graph', $$
       MERGE (e:Entity {entity_id: '${entityId}'})
       SET e.name = '${name.replace(/'/g, '')}', e.type = '${type}'
       RETURN e
     $$) AS (v agtype)`,
  );
}

/**
 * Merge a directed Entity->Entity edge into the knowledge_graph directly. Uses
 * two separate MATCH clauses (this AGE build won't bind a comma-joined endpoint
 * the way create_entity_edge's format string does) and omits the SET that the
 * production create_entity_edge trigger applies. Both endpoints must already be
 * merged as nodes.
 */
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

/** Detach-delete a set of Entity nodes from the knowledge_graph (cleanup). */
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

/**
 * Probe whether AGE traversal actually WORKS in cognitive_test — not just
 * whether the extension is installed. cognitive_test has AGE installed and
 * knowledge_graph registered, but the production entity-sync trigger silently
 * no-ops (see file header), so we seed the AGE node+edge DIRECTLY via the
 * trigger-free MERGE helpers and then walk via the SAME findConnectedEntities
 * read path the production code uses. Only if the neighbour comes back is the
 * suite meaningful. Synthetic + isolated; cleans up its own Postgres rows AND
 * AGE nodes.
 */
async function ageTraversalWorks(): Promise<boolean> {
  try {
    const ext = await testDb`SELECT 1 FROM pg_extension WHERE extname = 'age'`;
    if (ext.length === 0) return false;
    const a = await createTestEntity({ canonicalName: `probe-a-${randomUUID().slice(0, 8)}`, entityType: 'person' });
    const b = await createTestEntity({ canonicalName: `probe-b-${randomUUID().slice(0, 8)}`, entityType: 'person' });
    let ok = false;
    try {
      await ageMergeNode(a.id, 'probe-a', 'person');
      await ageMergeNode(b.id, 'probe-b', 'person');
      await ageMergeEdge(a.id, b.id, 'knows');
      const reached = await findConnectedEntities(a.id, { maxDepth: 1 });
      ok = reached.some((n) => n.entityId === b.id);
    } finally {
      await ageDeleteNodes([a.id, b.id]);
      // FK on facts is RESTRICT — delete facts before their entities.
      await testDb`DELETE FROM facts WHERE subject_entity_id = ${a.id}::uuid OR object_entity_id = ${a.id}::uuid`;
      await testDb`DELETE FROM entities WHERE id = ANY(${[a.id, b.id]})`;
    }
    return ok;
  } catch {
    return false;
  }
}

/** Upsert a synthetic unit satellite point into memories_test. */
async function upsertUnitPoint(args: {
  pointId: string;
  parentWindowId: string;
  unitText: string;
}): Promise<void> {
  await qdrant.upsert(COLLECTIONS.MEMORIES, {
    points: [
      {
        id: args.pointId,
        vector: normalizeVector(randomEmbedding()),
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
 * Insert a synthetic entity->entity fact AND seed its AGE edge directly.
 * (In production the facts_sync_graph trigger would create the edge; in
 * cognitive_test that trigger silently no-ops — see file header — so we MERGE
 * the edge ourselves via the trigger-free helper. Both endpoint nodes must
 * already have been merged by mkEntity.)
 */
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

/** Link a fact to a unit point (mirrors the extract() fact_units write). */
async function linkFactUnit(args: {
  factId: string;
  unitPointId: string;
  charStart: number | null;
  charEnd: number | null;
  matchKind: string;
}): Promise<void> {
  await testDb`
    INSERT INTO fact_units (fact_id, unit_point_id, char_start, char_end, match_kind)
    VALUES (${args.factId}::uuid, ${args.unitPointId}, ${args.charStart}, ${args.charEnd}, ${args.matchKind})
    ON CONFLICT (fact_id, unit_point_id) DO NOTHING
  `;
}

const createdEntityIds: string[] = [];
const createdPointIds: string[] = [];

async function mkEntity(name: string): Promise<string> {
  const canonicalName = `${name}-${randomUUID().slice(0, 8)}`;
  const e = await createTestEntity({ canonicalName, entityType: 'person' });
  // Seed the AGE node directly — the production entity-sync trigger no-ops in
  // cognitive_test (see file header). MERGE is trigger-free + idempotent.
  await ageMergeNode(e.id, canonicalName, 'person');
  createdEntityIds.push(e.id);
  return e.id;
}

describe('expandFromAnchors — neighbour expansion + evidence-unit fetch (synthetic, isolated)', () => {
  let ready = false;

  beforeAll(async () => {
    ready = (await isQdrantAvailable()) && (await ageTraversalWorks());
    if (!ready) {
      console.warn(
        'graph-fallback suite SKIPPED: Qdrant unavailable, or AGE traversal is non-functional ' +
        'in cognitive_test (broken AGE graph / entity-sync). See bead nmemo-0wq.2 HALT note.',
      );
    }
  });

  beforeEach(async () => {
    await testDb`DELETE FROM fact_units`;
  });

  afterAll(async () => {
    await testDb`DELETE FROM fact_units`;
    if (createdEntityIds.length > 0) {
      // Detach-delete the AGE nodes we merged before dropping the Postgres rows,
      // so the shared knowledge_graph is left exactly as we found it.
      await ageDeleteNodes(createdEntityIds);
      // facts.subject_entity_id is RESTRICT in cognitive_test — delete the facts
      // (and their fact_units, already cleared) before their entities.
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

  it('reaches a depth-1 neighbour and fetches its unit-grained evidence', async (ctx) => {
    if (!ready) return skipCtx(ctx);

    const anchor = await mkEntity('anchor');
    const neighbour = await mkEntity('neighbour');

    const windowId = randomUUID();
    const unitId = randomUUID();
    const unitText = 'graduated in Business Administration';
    await upsertUnitPoint({ pointId: unitId, parentWindowId: windowId, unitText });
    createdPointIds.push(unitId);

    const factId = await insertFact({
      subjectId: anchor,
      objectId: neighbour,
      predicate: 'studied_at',
      sourceMemoryId: windowId,
      sourceText: unitText,
    });
    await linkFactUnit({ factId, unitPointId: unitId, charStart: 10, charEnd: 46, matchKind: 'offset_overlap' });

    const result = await expandFromAnchors([anchor]);

    expect(result.length).toBe(1);
    const ev = result[0]!;
    expect(ev.anchorEntityId).toBe(anchor);
    expect(ev.neighbourEntityId).toBe(neighbour);
    expect(ev.factId).toBe(factId);
    expect(ev.predicate).toBe('studied_at');
    expect(ev.hop).toBe(1);
    expect(ev.units.length).toBe(1);
    const u = ev.units[0]!;
    expect(u.qdrantPointId).toBe(unitId);
    expect(u.unitText).toBe(unitText); // UNIT grain, not the whole window
    expect(u.parentWindowId).toBe(windowId); // provenance unchanged
    expect(u.windowFallback).toBe(false);
    expect(u.charStart).toBe(10);
  });

  it('honours the depth cap: a depth-2 neighbour is excluded at maxHops=1, included at maxHops=2', async (ctx) => {
    if (!ready) return skipCtx(ctx);

    const anchor = await mkEntity('a');
    const bridge = await mkEntity('bridge');
    const far = await mkEntity('far');

    // anchor -> bridge (hop 1), bridge -> far (hop 2 from anchor)
    const w1 = randomUUID();
    const w2 = randomUUID();
    const p1 = randomUUID();
    const p2 = randomUUID();
    await upsertUnitPoint({ pointId: p1, parentWindowId: w1, unitText: 'anchor knows bridge' });
    await upsertUnitPoint({ pointId: p2, parentWindowId: w2, unitText: 'bridge knows far' });
    createdPointIds.push(p1, p2);

    const f1 = await insertFact({ subjectId: anchor, objectId: bridge, predicate: 'knows', sourceMemoryId: w1, sourceText: 'anchor knows bridge' });
    const f2 = await insertFact({ subjectId: bridge, objectId: far, predicate: 'knows', sourceMemoryId: w2, sourceText: 'bridge knows far' });
    await linkFactUnit({ factId: f1, unitPointId: p1, charStart: 0, charEnd: 19, matchKind: 'offset_overlap' });
    await linkFactUnit({ factId: f2, unitPointId: p2, charStart: 0, charEnd: 17, matchKind: 'offset_overlap' });

    const depth1 = await expandFromAnchors([anchor], { maxHops: 1 });
    const reached1 = new Set(depth1.map((e) => e.neighbourEntityId));
    expect(reached1.has(bridge)).toBe(true);
    expect(reached1.has(far)).toBe(false); // far is 2 hops away

    const depth2 = await expandFromAnchors([anchor], { maxHops: 2 });
    const reached2 = new Set(depth2.map((e) => e.neighbourEntityId));
    expect(reached2.has(bridge)).toBe(true);
    expect(reached2.has(far)).toBe(true);
    const farEv = depth2.find((e) => e.neighbourEntityId === far)!;
    expect(farEv.hop).toBe(2);
    expect(farEv.units[0]!.unitText).toBe('bridge knows far');
  });

  it('clamps maxHops above the hard cap of 2', async (ctx) => {
    if (!ready) return skipCtx(ctx);
    const anchor = await mkEntity('a');
    const n = await mkEntity('n');
    const w = randomUUID();
    const f = await insertFact({ subjectId: anchor, objectId: n, predicate: 'knows', sourceMemoryId: w, sourceText: 'x' });
    await linkFactUnit({ factId: f, unitPointId: randomUUID(), charStart: null, charEnd: null, matchKind: 'window_fallback' });
    // maxHops=99 must not throw and must still return (clamped to 2).
    const result = await expandFromAnchors([anchor], { maxHops: 99 });
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('caps expansion candidates at maxNeighbours', async (ctx) => {
    if (!ready) return skipCtx(ctx);

    const anchor = await mkEntity('hub');
    // 6 neighbours, each a distinct fact edge from the anchor.
    for (let i = 0; i < 6; i++) {
      const nb = await mkEntity(`leaf${i}`);
      const w = randomUUID();
      const f = await insertFact({ subjectId: anchor, objectId: nb, predicate: 'knows', sourceMemoryId: w, sourceText: `edge ${i}` });
      await linkFactUnit({ factId: f, unitPointId: randomUUID(), charStart: null, charEnd: null, matchKind: 'window_fallback' });
    }

    const capped = await expandFromAnchors([anchor], { maxNeighbours: 3 });
    expect(capped.length).toBe(3);

    const uncapped = await expandFromAnchors([anchor], { maxNeighbours: 50 });
    expect(uncapped.length).toBe(6);
  });

  it('gracefully handles a fact_units row whose unit point is absent from Qdrant', async (ctx) => {
    if (!ready) return skipCtx(ctx);

    const anchor = await mkEntity('a');
    const neighbour = await mkEntity('n');
    const windowId = randomUUID();
    const missingPointId = randomUUID(); // never upserted into memories_test

    const factId = await insertFact({
      subjectId: anchor, objectId: neighbour, predicate: 'knows',
      sourceMemoryId: windowId, sourceText: 'something',
    });
    await linkFactUnit({ factId, unitPointId: missingPointId, charStart: 0, charEnd: 9, matchKind: 'offset_overlap' });

    const result = await expandFromAnchors([anchor]);
    expect(result.length).toBe(1);
    const u = result[0]!.units[0]!;
    expect(u.qdrantPointId).toBe(missingPointId);
    expect(u.unitText).toBeNull();       // missing point -> null text, no throw
    expect(u.windowFallback).toBe(false); // it was an offset_overlap link, just absent
  });

  it('flags window_fallback evidence and resolves its window text', async (ctx) => {
    if (!ready) return skipCtx(ctx);

    const anchor = await mkEntity('a');
    const neighbour = await mkEntity('n');
    const windowId = randomUUID();
    const windowText = 'A whole window of prose that could not be attributed to a unit.';
    // window_fallback rows are keyed on the parent WINDOW id; the window point
    // carries `content`, so the primitive resolves windowFallback text too.
    await qdrant.upsert(COLLECTIONS.MEMORIES, {
      points: [{ id: windowId, vector: normalizeVector(randomEmbedding()), payload: { point_type: 'window', content: windowText } }],
    });
    createdPointIds.push(windowId);

    const factId = await insertFact({
      subjectId: anchor, objectId: neighbour, predicate: 'knows',
      sourceMemoryId: windowId, sourceText: 'non-verbatim',
    });
    await linkFactUnit({ factId, unitPointId: windowId, charStart: null, charEnd: null, matchKind: 'window_fallback' });

    const result = await expandFromAnchors([anchor]);
    const u = result[0]!.units[0]!;
    expect(u.windowFallback).toBe(true);
    expect(u.parentWindowId).toBe(windowId);
    expect(u.unitText).toBe(windowText);
  });

  it('returns [] for an empty anchor list (no infra touched)', async () => {
    const result = await expandFromAnchors([]);
    expect(result).toEqual([]);
  });

  it('pools evidence from multiple anchors', async (ctx) => {
    if (!ready) return skipCtx(ctx);
    const a1 = await mkEntity('a1');
    const a2 = await mkEntity('a2');
    const n1 = await mkEntity('n1');
    const n2 = await mkEntity('n2');
    const w1 = randomUUID();
    const w2 = randomUUID();
    const f1 = await insertFact({ subjectId: a1, objectId: n1, predicate: 'knows', sourceMemoryId: w1, sourceText: 'a1 n1' });
    const f2 = await insertFact({ subjectId: a2, objectId: n2, predicate: 'knows', sourceMemoryId: w2, sourceText: 'a2 n2' });
    await linkFactUnit({ factId: f1, unitPointId: randomUUID(), charStart: null, charEnd: null, matchKind: 'window_fallback' });
    await linkFactUnit({ factId: f2, unitPointId: randomUUID(), charStart: null, charEnd: null, matchKind: 'window_fallback' });

    const result = await expandFromAnchors([a1, a2]);
    const anchors = new Set(result.map((e) => e.anchorEntityId));
    expect(anchors.has(a1)).toBe(true);
    expect(anchors.has(a2)).toBe(true);
  });
});
