/**
 * Bridge / explore service + routes (iOS API v1 — ASK-014 degraded v1).
 *
 * Pins the iOS BridgeData.swift wire contract for the two READ surfaces:
 *
 *   GET /api/bridge/current → { bridgeNarrative: BridgeNarrative | null }
 *     - topology bridge present → BridgeNarrative shape + named spokes,
 *       in-bounds annotations, Voice-C narrative
 *     - no bridge (fresh / no betweenness) → { bridgeNarrative: null }
 *     - self entity is the bridge → isMe=true, bridgeEntityId=null
 *
 *   GET /api/explore/node/:entityId → ExploreNodeResponse
 *     - known id → node + neighbors (bare arrays, finite edgeStrength)
 *     - unknown / malformed id → 404 (no let-go shape for explore)
 *
 * DB-backed (shared cognitive_test). entity_topology + entities + entity_meta +
 * stream_participants are seeded directly; the 1-hop neighborhood is seeded into
 * the Apache AGE `knowledge_graph` via Cypher (the source getSubgraph reads).
 *
 * Mirrors promises.test.ts / rise.test.ts conventions (clean slate around each,
 * self entity via stream_participants, route tested via a fake Hono context).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { testDb, createTestEntity, deleteFromTables } from '../setup.js';
import { streamParticipants } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  composeBridgeCurrent,
  composeExploreCommunities,
  composeExploreNode,
  ExploreNodeNotFoundError,
} from '../../services/bridge.js';
import {
  bridgeCurrentHandler,
  exploreCommunitiesHandler,
  exploreNodeHandler,
} from '../../routes/bridge.js';

// ---------------------------------------------------------------------------
// AGE graph helpers — getSubgraph reads the `knowledge_graph` Cypher graph,
// which is separate from the postgres `entities` table. Seed Entity nodes +
// a relationship so 1-hop neighbor discovery returns them.
// ---------------------------------------------------------------------------

async function loadAge(): Promise<void> {
  // LOAD 'age' is required per-session for cypher() to resolve (mirrors
  // causal-service.test.ts).
  await testDb.unsafe(`LOAD 'age'`).catch(() => {});
  await testDb.unsafe(`SET search_path = ag_catalog, public, "$user"`);
}

/** Create an Entity node in the AGE graph with the props getSubgraph reads. */
async function seedGraphNode(entityId: string, name: string, type: string): Promise<void> {
  await testDb.unsafe(
    `SELECT * FROM cypher('knowledge_graph', $$
       CREATE (:Entity {entity_id: '${entityId}', name: '${name}', type: '${type}'})
     $$) as (v agtype)`,
  );
}

/** Create a directed relationship between two seeded Entity nodes. */
async function seedGraphEdge(fromId: string, toId: string): Promise<void> {
  await testDb.unsafe(
    `SELECT * FROM cypher('knowledge_graph', $$
       MATCH (a:Entity {entity_id: '${fromId}'}), (b:Entity {entity_id: '${toId}'})
       CREATE (a)-[:RELATES]->(b)
     $$) as (v agtype)`,
  );
}

/** Remove every Entity node (and its edges) from the AGE graph. */
async function clearGraph(): Promise<void> {
  await testDb
    .unsafe(
      `SELECT * FROM cypher('knowledge_graph', $$ MATCH (n) DETACH DELETE n $$) as (v agtype)`,
    )
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Postgres seed helpers
// ---------------------------------------------------------------------------

/** Seed the default-stream USER speaker as the self entity; returns its id. */
async function seedSelfEntity(name = 'user'): Promise<string> {
  const { id } = await createTestEntity({ canonicalName: name, entityType: 'person' });
  await db
    .insert(streamParticipants)
    .values({ streamId: 'default', speakerKey: 'user', entityId: id, role: 'user' });
  return id;
}

/** Seed an entity_topology row (only the columns the bridge service reads). */
async function seedTopology(args: {
  entityId: string;
  betweenness?: number | null;
  communityId?: number | null;
  pagerank?: number | null;
  isArticulationPoint?: boolean;
}): Promise<void> {
  await testDb`
    INSERT INTO public.entity_topology
      (entity_id, betweenness_sampled, community_id, pagerank, is_articulation_point)
    VALUES (
      ${args.entityId}::uuid,
      ${args.betweenness ?? null},
      ${args.communityId ?? null},
      ${args.pagerank ?? null},
      ${args.isArticulationPoint ?? false}
    )
    ON CONFLICT (entity_id) DO UPDATE SET
      betweenness_sampled = EXCLUDED.betweenness_sampled,
      community_id = EXCLUDED.community_id,
      pagerank = EXCLUDED.pagerank,
      is_articulation_point = EXCLUDED.is_articulation_point
  `;
}

/**
 * Seed an entity_meta row. `firstMentionedAt` feeds the existing isNewThisMonth
 * (first-seen) signal; `lastMentionedAt` feeds the recency lens facet — the two
 * are deliberately distinct timestamps.
 */
async function seedMeta(args: {
  entityId: string;
  sourceMemoryCount?: number;
  firstMentionedAt?: Date | null;
  lastMentionedAt?: Date | null;
}): Promise<void> {
  await testDb`
    INSERT INTO public.entity_meta
      (entity_id, source_memory_count, first_mentioned_at, last_mentioned_at)
    VALUES (
      ${args.entityId}::uuid,
      ${args.sourceMemoryCount ?? 0},
      ${args.firstMentionedAt ?? null},
      ${args.lastMentionedAt ?? null}
    )
    ON CONFLICT (entity_id) DO UPDATE SET
      source_memory_count = EXCLUDED.source_memory_count,
      first_mentioned_at = EXCLUDED.first_mentioned_at,
      last_mentioned_at = EXCLUDED.last_mentioned_at
  `;
}

async function cleanSlate(): Promise<void> {
  await db.delete(streamParticipants).where(eq(streamParticipants.streamId, 'default'));
  await testDb`DELETE FROM public.entity_topology`.catch(() => {});
  await testDb`DELETE FROM public.entity_meta`.catch(() => {});
  await clearGraph();
  await deleteFromTables({
    tables: ['memory_entities', 'entity_aliases', 'facts', 'entity_merges', 'entities'],
    acknowledgeGlobal: true,
  });
}

// A fixed "now" inside a known month so isNewThisMonth assertions are stable.
const NOW = new Date('2027-05-15T12:00:00.000Z');

// ---------------------------------------------------------------------------
// LLM label stub. The spoke labeler POSTs ml-services /label-cluster; CI has
// no live LLM, so we stub global.fetch for that one endpoint and let every
// other fetch fall through. Default behavior: the call FAILS (non-ok), which
// drives the documented heuristic fallback (highest-pagerank member name) —
// keeping the exact-label assertions below deterministic. Individual tests can
// override the stub to assert the live-LLM topic-label path.
// ---------------------------------------------------------------------------
let labelResponder: (body: { member_names: string[] }) => Response;

function isLabelCluster(input: RequestInfo | URL): boolean {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return url.includes('/label-cluster');
}

beforeAll(() => {
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isLabelCluster(input)) {
      const body = init?.body ? JSON.parse(String(init.body)) : { member_names: [] };
      return labelResponder(body);
    }
    return realFetch(input as any, init);
  });
});

afterEach(() => {
  // Reset to the failing default so each test re-opts-in to a live label.
  labelResponder = () => new Response('busy', { status: 503 });
});

// Set the default before the first test runs.
labelResponder = () => new Response('busy', { status: 503 });

// ===========================================================================
// composeBridgeCurrent (service)
// ===========================================================================

describe('bridge — composeBridgeCurrent (service)', () => {
  beforeAll(async () => {
    await loadAge();
    await cleanSlate();
  });
  beforeEach(async () => {
    await cleanSlate();
  });
  afterEach(async () => {
    await cleanSlate();
  });

  it('fresh graph (no topology) → { bridgeNarrative: null }', async () => {
    const res = await composeBridgeCurrent(NOW);
    expect(res).toEqual({ bridgeNarrative: null });
  });

  it('topology present but zero betweenness → { bridgeNarrative: null }', async () => {
    const { id } = await createTestEntity({ canonicalName: 'lonely', entityType: 'concept' });
    await seedTopology({ entityId: id, betweenness: 0, communityId: 1, pagerank: 1.0 });
    const res = await composeBridgeCurrent(NOW);
    expect(res).toEqual({ bridgeNarrative: null });
  });

  it('topology bridge present (non-self) → BridgeNarrative shape + named spokes + in-bounds annotations', async () => {
    // Bridge entity (high betweenness) in community 1; two neighbors, one in a
    // second community (2), giving two spokes.
    const bridge = await createTestEntity({ canonicalName: 'the studio', entityType: 'concept' });
    const nbrA = await createTestEntity({ canonicalName: 'the move', entityType: 'concept' });
    const nbrB = await createTestEntity({ canonicalName: 'mornings', entityType: 'concept' });

    await seedTopology({ entityId: bridge.id, betweenness: 0.9, communityId: 1, pagerank: 0.5 });
    await seedTopology({ entityId: nbrA.id, betweenness: 0.1, communityId: 2, pagerank: 0.4 });
    await seedTopology({ entityId: nbrB.id, betweenness: 0.0, communityId: 1, pagerank: 0.3 });

    await seedGraphNode(bridge.id, 'the studio', 'concept');
    await seedGraphNode(nbrA.id, 'the move', 'concept');
    await seedGraphNode(nbrB.id, 'mornings', 'concept');
    await seedGraphEdge(bridge.id, nbrA.id);
    await seedGraphEdge(bridge.id, nbrB.id);

    const { bridgeNarrative } = await composeBridgeCurrent(NOW);
    expect(bridgeNarrative).not.toBeNull();
    const n = bridgeNarrative!;

    expect(n.compositionId).toBe(`bridge:${bridge.id}`);
    expect(n.bridgeEntityId).toBe(bridge.id);
    expect(n.bridgeEntityName).toBe('the studio');
    expect(n.isMe).toBe(false);

    // narrativeText: non-blank Voice-C prose, lowercase.
    expect(n.narrativeText.trim().length).toBeGreaterThan(0);
    expect(n.narrativeText).toBe(n.narrativeText.toLowerCase());

    // composedAt is ISO-8601.
    expect(new Date(n.composedAt).toISOString()).toBe(NOW.toISOString());

    // Spokes: communities 1 (rep = the studio, pagerank 0.5 > mornings 0.3) and
    // 2 (rep = the move). Two distinct communities → two spokes. With the label
    // stub failing (default 503), each spoke falls back to its highest-pagerank
    // member name — the documented heuristic fallback.
    expect(n.clusterSpokes.map((s) => s.communityId).sort()).toEqual(['1', '2']);
    const byId = new Map(n.clusterSpokes.map((s) => [s.communityId, s]));
    expect(byId.get('1')!.name).toBe('the studio'); // highest-pagerank rep (fallback)
    expect(byId.get('2')!.name).toBe('the move');
    for (const s of n.clusterSpokes) {
      expect(s.name.trim().length).toBeGreaterThan(0);
      expect(typeof s.isNewThisMonth).toBe('boolean');
    }

    // narrativeAnnotations: a bare array (the iOS AnnotationBlock wire shape —
    // NOT wrapped in {annotations}), every span in-bounds over narrativeText
    // (the iOS decoder rejects out-of-bounds), and the underlined substring
    // matches the prose.
    expect(Array.isArray(n.narrativeAnnotations)).toBe(true);
    expect(n.narrativeAnnotations.length).toBeGreaterThan(0);
    const utf16Len = n.narrativeText.length; // JS length === UTF-16 code units
    for (const ann of n.narrativeAnnotations) {
      expect(ann.start).toBeGreaterThanOrEqual(0);
      expect(ann.end).toBeGreaterThan(ann.start);
      expect(ann.end).toBeLessThanOrEqual(utf16Len);
      expect(typeof ann.source.id).toBe('string');
      expect(ann.source.id.length).toBeGreaterThan(0);
    }
    // Each spoke name occurs verbatim inside the narrative (it was sourced).
    for (const s of n.clusterSpokes) {
      expect(n.narrativeText).toContain(s.name);
    }
  });

  it('LLM topic labels → spoke names carry the composed theme, not the member name', async () => {
    // Same topology as above, but the label stub returns a synthesized THEME
    // per cluster. Spokes must carry the LLM label (not the member name) and
    // the narrative must underline those labels.
    const bridge = await createTestEntity({ canonicalName: 'the studio', entityType: 'concept' });
    const nbrA = await createTestEntity({ canonicalName: 'the apartment', entityType: 'concept' });
    const nbrB = await createTestEntity({ canonicalName: 'mornings', entityType: 'concept' });

    await seedTopology({ entityId: bridge.id, betweenness: 0.9, communityId: 1, pagerank: 0.5 });
    await seedTopology({ entityId: nbrA.id, betweenness: 0.1, communityId: 2, pagerank: 0.4 });
    await seedTopology({ entityId: nbrB.id, betweenness: 0.0, communityId: 1, pagerank: 0.3 });

    await seedGraphNode(bridge.id, 'the studio', 'concept');
    await seedGraphNode(nbrA.id, 'the apartment', 'concept');
    await seedGraphNode(nbrB.id, 'mornings', 'concept');
    await seedGraphEdge(bridge.id, nbrA.id);
    await seedGraphEdge(bridge.id, nbrB.id);

    // Stub: community 1 (the studio + mornings) → "the tired weeks";
    // community 2 (the apartment) → "the move". A theme, not a member name.
    labelResponder = (body) => {
      const names = body.member_names;
      const label = names.includes('the apartment') ? 'the move' : 'the tired weeks';
      return new Response(JSON.stringify({ label }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { bridgeNarrative } = await composeBridgeCurrent(NOW);
    const n = bridgeNarrative!;
    const byId = new Map(n.clusterSpokes.map((s) => [s.communityId, s]));
    // The composed theme — NOT the highest-pagerank member name.
    expect(byId.get('1')!.name).toBe('the tired weeks');
    expect(byId.get('2')!.name).toBe('the move');
    // The narrative sources the spoke names as parts, so the theme is underlined.
    for (const s of n.clusterSpokes) {
      expect(n.narrativeText).toContain(s.name);
    }
  });

  it('label stub junk/failure → spoke falls back to the member name (never blank)', async () => {
    const bridge = await createTestEntity({ canonicalName: 'the studio', entityType: 'concept' });
    const nbr = await createTestEntity({ canonicalName: 'the move', entityType: 'concept' });
    await seedTopology({ entityId: bridge.id, betweenness: 0.9, communityId: 1, pagerank: 0.5 });
    await seedTopology({ entityId: nbr.id, betweenness: 0.1, communityId: 2, pagerank: 0.4 });
    await seedGraphNode(bridge.id, 'the studio', 'concept');
    await seedGraphNode(nbr.id, 'the move', 'concept');
    await seedGraphEdge(bridge.id, nbr.id);

    // Stub returns a blank label → the TS fallback (member name) must kick in.
    labelResponder = () =>
      new Response(JSON.stringify({ label: '   ' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const { bridgeNarrative } = await composeBridgeCurrent(NOW);
    const n = bridgeNarrative!;
    for (const s of n.clusterSpokes) {
      expect(s.name.trim().length).toBeGreaterThan(0);
    }
    const byId = new Map(n.clusterSpokes.map((s) => [s.communityId, s]));
    expect(byId.get('1')!.name).toBe('the studio'); // member-name fallback
    expect(byId.get('2')!.name).toBe('the move');
  });

  it('self entity is the bridge → isMe=true + bridgeEntityId=null', async () => {
    const selfId = await seedSelfEntity('m');
    const nbr = await createTestEntity({ canonicalName: 'the move', entityType: 'concept' });

    await seedTopology({ entityId: selfId, betweenness: 0.9, communityId: 1, pagerank: 0.6 });
    await seedTopology({ entityId: nbr.id, betweenness: 0.0, communityId: 2, pagerank: 0.4 });

    await seedGraphNode(selfId, 'm', 'person');
    await seedGraphNode(nbr.id, 'the move', 'concept');
    await seedGraphEdge(selfId, nbr.id);

    const { bridgeNarrative } = await composeBridgeCurrent(NOW);
    expect(bridgeNarrative).not.toBeNull();
    const n = bridgeNarrative!;
    expect(n.isMe).toBe(true);
    expect(n.bridgeEntityId).toBeNull();
    expect(n.bridgeEntityName).toBe('m');
    expect(n.clusterSpokes.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// composeExploreNode (service)
// ===========================================================================

describe('bridge — composeExploreNode (service)', () => {
  beforeAll(async () => {
    await loadAge();
    await cleanSlate();
  });
  beforeEach(async () => {
    await cleanSlate();
  });
  afterEach(async () => {
    await cleanSlate();
  });

  it('known id → node + neighbors with exact wire shape', async () => {
    const node = await createTestEntity({ canonicalName: 'the studio', entityType: 'concept' });
    const nbr = await createTestEntity({ canonicalName: 'the move', entityType: 'concept' });

    // node is the bridge (highest betweenness); nbr is new this month.
    await seedTopology({ entityId: node.id, betweenness: 0.9, communityId: 1, pagerank: 0.5 });
    await seedMeta({ entityId: node.id, sourceMemoryCount: 12, firstMentionedAt: new Date('2026-01-01T00:00:00Z') });
    await seedMeta({ entityId: nbr.id, sourceMemoryCount: 3, firstMentionedAt: NOW });

    await seedGraphNode(node.id, 'the studio', 'concept');
    await seedGraphNode(nbr.id, 'the move', 'concept');
    await seedGraphEdge(node.id, nbr.id);

    const res = await composeExploreNode(node.id, NOW);

    // node
    expect(res.node.entityId).toBe(node.id);
    expect(res.node.name).toBe('the studio');
    expect(res.node.type).toBe('entity'); // 'concept' maps to entity default
    expect(res.node.isBridge).toBe(true);
    expect(res.node.isSelf).toBe(false);
    expect(res.node.isNewThisMonth).toBe(false); // first mentioned in january
    expect(res.node.drawerText.trim().length).toBeGreaterThan(0);
    expect(res.node.drawerText).toBe(res.node.drawerText.toLowerCase());
    expect(Array.isArray(res.node.drawerAnnotations)).toBe(true);
    expect(res.node.drawerAnnotations.length).toBeGreaterThan(0);
    expect(res.node.meta.threadsCount).toBe(1);
    expect(res.node.meta.entriesCount).toBe(12);

    // neighbors: bare array, finite edgeStrength.
    expect(Array.isArray(res.neighbors)).toBe(true);
    expect(res.neighbors).toHaveLength(1);
    const nb = res.neighbors[0]!;
    expect(nb.entityId).toBe(nbr.id);
    expect(nb.name).toBe('the move');
    expect(Number.isFinite(nb.edgeStrength)).toBe(true);
    expect(nb.isBridge).toBe(false);
    expect(nb.isNewThisMonth).toBe(true); // first mentioned this month

    // v1: second-degree empty.
    expect(res.secondDegree).toEqual([]);
    expect(res.secondDegreeStubs).toEqual([]);
  });

  it('self node → type "self" + isSelf=true', async () => {
    const selfId = await seedSelfEntity('m');
    await seedMeta({ entityId: selfId, sourceMemoryCount: 47 });
    await seedGraphNode(selfId, 'm', 'person');

    const res = await composeExploreNode(selfId, NOW);
    expect(res.node.isSelf).toBe(true);
    expect(res.node.type).toBe('self');
    expect(res.neighbors).toEqual([]); // no edges seeded
  });

  // ---------------------------------------------------------------------------
  // Lens-facet contract (iOS exploration lens chip row). The ask surface joins
  // these per-node facets (keyed by entityId) against the visible graph to light
  // the bridges / type / community / recency chips. They are ADDITIVE sibling
  // fields — the existing type/isBridge/isNewThisMonth stay untouched.
  // ---------------------------------------------------------------------------

  it('emits per-node lens facets — raw entityType, articulation, community, lastMentionedAt', async () => {
    // node: a person, a true articulation point, Leiden community 1, last
    // mentioned THIS month (but first mentioned long ago).
    const node = await createTestEntity({ canonicalName: 'maya', entityType: 'person' });
    // neighbor: a project, not an articulation point, community 2, last
    // mentioned LAST month.
    const nbr = await createTestEntity({ canonicalName: 'the arch league', entityType: 'project' });

    await seedTopology({ entityId: node.id, betweenness: 0.9, communityId: 1, pagerank: 0.5, isArticulationPoint: true });
    await seedTopology({ entityId: nbr.id, betweenness: 0.0, communityId: 2, pagerank: 0.3, isArticulationPoint: false });

    const nodeLast = new Date('2027-05-10T09:00:00.000Z'); // same month as NOW
    const nbrLast = new Date('2027-04-20T09:00:00.000Z');  // previous month
    await seedMeta({ entityId: node.id, sourceMemoryCount: 5, firstMentionedAt: new Date('2026-01-01T00:00:00Z'), lastMentionedAt: nodeLast });
    await seedMeta({ entityId: nbr.id, sourceMemoryCount: 2, firstMentionedAt: nbrLast, lastMentionedAt: nbrLast });

    await seedGraphNode(node.id, 'maya', 'entity');
    await seedGraphNode(nbr.id, 'the arch league', 'entity');
    await seedGraphEdge(node.id, nbr.id);

    const res = await composeExploreNode(node.id, NOW);

    // TYPE lens — the RAW entity type, not the collapsed NodeType discriminator.
    // `type` still buckets 'person' → 'entity' (existing behavior); the new
    // `entityType` field carries the real taxonomy the type chip filters on.
    expect(res.node.type).toBe('entity');
    expect(res.node.entityType).toBe('person');
    expect(res.neighbors[0]!.entityType).toBe('project');

    // BRIDGES lens — true graph articulation, the SAME field + semantics as
    // /api/hero's topology.isArticulationPoint (distinct from the betweenness-max
    // `isBridge` heuristic, which is unchanged and coexists).
    expect(res.node.isArticulationPoint).toBe(true);
    expect(res.neighbors[0]!.isArticulationPoint).toBe(false);

    // COMMUNITY lens — the Leiden community id as a string (matches
    // ClusterSpoke.communityId on the bridge surface).
    expect(res.node.communityId).toBe('1');
    expect(res.neighbors[0]!.communityId).toBe('2');

    // RECENCY lens — last_mentioned_at as an ISO-8601 string. NOT the
    // first-mention-based isNewThisMonth: the node was first seen in january 2026
    // so it is not "new" this month, yet it WAS last mentioned this month. The
    // two signals are deliberately different.
    expect(res.node.lastMentionedAt).toBe(nodeLast.toISOString());
    expect(res.neighbors[0]!.lastMentionedAt).toBe(nbrLast.toISOString());
    expect(res.node.isNewThisMonth).toBe(false);
  });

  it('facets degrade to honest nulls when topology/meta rows are absent', async () => {
    // A node with an entities row but no entity_topology and no entity_meta —
    // the "no facet distinguishes this field" state must be graceful, never a
    // throw, so the lens row can legitimately stay empty rather than break.
    const node = await createTestEntity({ canonicalName: 'lonely', entityType: 'place' });
    await seedGraphNode(node.id, 'lonely', 'entity');

    const res = await composeExploreNode(node.id, NOW);
    expect(res.node.entityType).toBe('place');        // still read from entities
    expect(res.node.isArticulationPoint).toBe(false); // absent topology → false
    expect(res.node.communityId).toBeNull();          // absent → null
    expect(res.node.lastMentionedAt).toBeNull();      // absent → null
  });

  it('unknown id → ExploreNodeNotFoundError', async () => {
    await expect(
      composeExploreNode('00000000-0000-0000-0000-0000000000ab', NOW),
    ).rejects.toBeInstanceOf(ExploreNodeNotFoundError);
  });

  it('malformed id → ExploreNodeNotFoundError', async () => {
    await expect(composeExploreNode('not-a-uuid', NOW)).rejects.toBeInstanceOf(
      ExploreNodeNotFoundError,
    );
  });
});

// ===========================================================================
// Routes
// ===========================================================================

describe('bridge — routes', () => {
  beforeAll(async () => {
    await loadAge();
    await cleanSlate();
  });
  beforeEach(async () => {
    await cleanSlate();
  });
  afterEach(async () => {
    await cleanSlate();
  });

  it('GET /api/bridge/current → 200 { bridgeNarrative: null } on a fresh graph', async () => {
    const calls: Array<[unknown, number?]> = [];
    const c = {
      json: (body: unknown, status?: number) => {
        calls.push([body, status]);
        return new Response();
      },
    } as unknown as Parameters<typeof bridgeCurrentHandler>[0];
    await bridgeCurrentHandler(c);
    const [body, status] = calls[0]!;
    expect(status ?? 200).toBe(200);
    expect(body).toEqual({ bridgeNarrative: null });
  });

  it('GET /api/explore/node/:entityId → 404 for an unknown id', async () => {
    const calls: Array<[unknown, number?]> = [];
    const c = {
      req: { param: () => '00000000-0000-0000-0000-0000000000cd' },
      json: (body: unknown, status?: number) => {
        calls.push([body, status]);
        return new Response();
      },
    } as unknown as Parameters<typeof exploreNodeHandler>[0];
    await exploreNodeHandler(c);
    const [, status] = calls[0]!;
    expect(status).toBe(404);
  });

  it('GET /api/explore/node/:entityId → 200 bare ExploreNodeResponse for a known id', async () => {
    const node = await createTestEntity({ canonicalName: 'the studio', entityType: 'concept' });
    await seedMeta({ entityId: node.id, sourceMemoryCount: 5 });
    await seedGraphNode(node.id, 'the studio', 'concept');

    const calls: Array<[any, number?]> = [];
    const c = {
      req: { param: () => node.id },
      json: (body: any, status?: number) => {
        calls.push([body, status]);
        return new Response();
      },
    } as unknown as Parameters<typeof exploreNodeHandler>[0];
    await exploreNodeHandler(c);
    const [body, status] = calls[0]!;
    expect(status ?? 200).toBe(200);
    // bare object — node at top level.
    expect(body.node.entityId).toBe(node.id);
    expect(Array.isArray(body.neighbors)).toBe(true);
  });

  it('GET /api/explore/communities → 200 bare array of { communityId, label }', async () => {
    // Two named communities; the handler answers with a bare array (the shape
    // iOS CommunityLabelProvider decodes into [CommunityCluster]).
    const a = await createTestEntity({
      canonicalName: 'the arch',
      entityType: 'concept',
      properties: { community: 'climbing' },
    });
    const b = await createTestEntity({
      canonicalName: 'the office',
      entityType: 'concept',
      properties: { community: 'work' },
    });
    await seedTopology({ entityId: a.id, communityId: 0, pagerank: 0.5 });
    await seedTopology({ entityId: b.id, communityId: 6, pagerank: 0.5 });

    const calls: Array<[any, number?]> = [];
    const c = {
      json: (body: any, status?: number) => {
        calls.push([body, status]);
        return new Response();
      },
    } as unknown as Parameters<typeof exploreCommunitiesHandler>[0];
    await exploreCommunitiesHandler(c);
    const [body, status] = calls[0]!;
    expect(status ?? 200).toBe(200);
    expect(body).toEqual([
      { communityId: '0', label: 'climbing' },
      { communityId: '6', label: 'work' },
    ]);
  });
});

// ===========================================================================
// composeExploreCommunities (service)
// ===========================================================================

describe('bridge — composeExploreCommunities (service)', () => {
  beforeAll(async () => {
    await loadAge();
    await cleanSlate();
  });
  beforeEach(async () => {
    await cleanSlate();
  });
  afterEach(async () => {
    await cleanSlate();
  });

  it('projects id→label keyed by the stringified Leiden community id', async () => {
    // The join keyspace is String(community_id) — the SAME key ExploreNode
    // .communityId carries — NOT the HDBSCAN cluster_id.
    const climbing = await createTestEntity({
      canonicalName: 'the arch',
      entityType: 'concept',
      properties: { community: 'climbing' },
    });
    const work = await createTestEntity({
      canonicalName: 'the office',
      entityType: 'concept',
      properties: { community: 'work' },
    });
    await seedTopology({ entityId: climbing.id, communityId: 0, pagerank: 0.5 });
    await seedTopology({ entityId: work.id, communityId: 6, pagerank: 0.5 });

    const out = await composeExploreCommunities();
    expect(out).toEqual([
      { communityId: '0', label: 'climbing' },
      { communityId: '6', label: 'work' },
    ]);
  });

  it('picks the MODAL label per community and ignores blank / null members', async () => {
    // Community 3: two "music" members, one blank, one null-property member —
    // the modal non-blank label wins; the blank/null members do not create a
    // spurious community and do not override the name.
    const m1 = await createTestEntity({
      canonicalName: 'the setlist',
      entityType: 'concept',
      properties: { community: 'music' },
    });
    const m2 = await createTestEntity({
      canonicalName: 'the amp',
      entityType: 'concept',
      properties: { community: 'music' },
    });
    const blank = await createTestEntity({
      canonicalName: 'the pick',
      entityType: 'concept',
      properties: { community: '  ' },
    });
    const bare = await createTestEntity({
      canonicalName: 'the case',
      entityType: 'concept',
      properties: {},
    });
    for (const e of [m1, m2, blank, bare]) {
      await seedTopology({ entityId: e.id, communityId: 3, pagerank: 0.4 });
    }

    const out = await composeExploreCommunities();
    expect(out).toEqual([{ communityId: '3', label: 'music' }]);
  });

  it('omits communities with no named member (the iOS color-only floor) and returns [] on an empty graph', async () => {
    // A community whose only member has no community property is absent from the
    // snapshot entirely — iOS renders the deterministic hue with no name.
    const unnamed = await createTestEntity({
      canonicalName: 'the fog',
      entityType: 'concept',
      properties: {},
    });
    await seedTopology({ entityId: unnamed.id, communityId: 2, pagerank: 0.3 });

    expect(await composeExploreCommunities()).toEqual([]);
  });
});
