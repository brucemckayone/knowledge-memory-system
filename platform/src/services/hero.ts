/**
 * Home hero composition (iOS API v1 — ASK-017, GET /api/hero).
 *
 * Orchestrates the existing graph services into the single hero payload iOS
 * renders on the home (`design/03-home.md` §"Section 2 — The hero"). The wire
 * shape below is the iOS-side contract (camelCase keys, explicit CodingKeys);
 * see _research/backend-asks.md ASK-017 for the pinned shape.
 *
 *   - getEntityProfile(seed)                 -> active.name/summary/meta
 *   - entity_meta row                        -> active.meta counts + timestamps
 *   - entity_topology row                    -> active.topology.isArticulationPoint
 *   - getSubgraph([seed], depth 1)           -> neighbors + edges
 *   - getSubgraph([seed], depth 2) - 1-hop   -> secondDegreeStubs (count + hint)
 *   - summarizeEntity (voice-c-composer)     -> deterministic summary + annotations
 *
 * Seed resolution: an explicit ?nodeId wins; otherwise the SELF entity
 * (getSelfEntity, ASK-006). A fresh DB has no self entity yet (capture works
 * offline; the self entity is bootstrapped on first ingest) — composeHero then
 * returns { active: null } and iOS renders the pre-data hero stub.
 *
 * There is NO LLM call here in v1: the summary line is composed deterministically
 * by the voice-c-composer. The richer LLM-composed summary/offer (ASK-005) is a
 * documented follow-up that replaces the deterministic floor.
 */

import { getEntityProfile } from './entity-profile.js';
import { getSubgraph } from './graph.js';
import { getSelfEntity } from './entities.js';
import { summarizeEntity, type VoiceCAnnotation } from './voice-c-composer.js';
import { db, entityMeta } from '../db/index.js';
import { eq, sql } from 'drizzle-orm';

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface HeroNeighbor {
  entityId: string;
  type: string;
  name: string;
  edgeStrength: number;
  summary: string | null;
  isArticulationPoint: boolean;
}

export interface HeroEdge {
  fromEntityId: string;
  toEntityId: string;
  strength: number;
}

export interface HeroSecondDegreeStub {
  fromEntityId: string;
  directionHint: number;
}

export interface HeroActive {
  entityId: string;
  type: 'entity' | 'thread' | 'entry';
  name: string;
  isSelf: boolean;
  summary: string;
  summaryAnnotations: VoiceCAnnotation[];
  offer: string | null;
  meta: {
    threadsCount: number;
    entriesCount: number;
    lastMentionedAt: string | null;
    isNewThisMonth: boolean;
  };
  topology: {
    isArticulationPoint: boolean;
  };
}

export interface HeroComposition {
  active: HeroActive | null;
  neighbors: HeroNeighbor[];
  edges: HeroEdge[];
  secondDegreeStubs: HeroSecondDegreeStub[];
}

/** Per-entity articulation flag from the precomputed entity_topology table.
 *  Absent (no topology compute yet, or entity not covered) -> false. */
async function articulationFlags(entityIds: string[]): Promise<Set<string>> {
  const flagged = new Set<string>();
  if (entityIds.length === 0) return flagged;
  const rows = (await db.execute(sql`
    SELECT entity_id::text AS entity_id
    FROM public.entity_topology
    WHERE is_articulation_point = true
      AND entity_id = ANY(ARRAY[${sql.join(
        entityIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}])
  `)) as unknown as Array<{ entity_id: string }>;
  for (const r of rows) flagged.add(r.entity_id);
  return flagged;
}

/**
 * Compose the hero payload for a seed entity.
 *
 * `nodeId` optional — when absent, resolves to the SELF entity. Returns
 * `{ active: null, ... }` when there is no seed (fresh DB) or the seed has no
 * profile. Throws `HeroNodeNotFoundError` only when an EXPLICIT nodeId does not
 * resolve to a profile, so the route can answer 404 for that case while a
 * missing self entity stays the sparse-data 200.
 */
export class HeroNodeNotFoundError extends Error {}

const EMPTY: HeroComposition = { active: null, neighbors: [], edges: [], secondDegreeStubs: [] };

export async function composeHero(nodeId?: string): Promise<HeroComposition> {
  // 1. Resolve the seed. Explicit nodeId wins; else the self entity.
  let seedId: string;
  let isSelf: boolean;
  if (nodeId) {
    if (!UUID_RE.test(nodeId)) throw new HeroNodeNotFoundError(`nodeId is not a uuid: ${nodeId}`);
    seedId = nodeId;
    const self = await getSelfEntity();
    isSelf = self?.id === nodeId;
  } else {
    const self = await getSelfEntity();
    if (!self) return EMPTY; // fresh DB — no self entity yet. iOS renders the stub.
    seedId = self.id;
    isSelf = true;
  }

  // 2. Profile + 1-hop + 2-hop subgraphs in parallel.
  const [profile, oneHop, twoHop, metaRows] = await Promise.all([
    getEntityProfile(seedId),
    getSubgraph([seedId], { maxDepth: 1, limit: 20 }),
    getSubgraph([seedId], { maxDepth: 2, limit: 50 }),
    db
      .select({
        sourceMemoryCount: entityMeta.sourceMemoryCount,
        factCount: entityMeta.factCount,
        lastMentionedAt: entityMeta.lastMentionedAt,
        firstMentionedAt: entityMeta.firstMentionedAt,
      })
      .from(entityMeta)
      .where(eq(entityMeta.entityId, seedId))
      .limit(1),
  ]);

  if (!profile) {
    // An explicit, well-formed nodeId that resolves to nothing -> 404.
    if (nodeId) throw new HeroNodeNotFoundError(`entity ${nodeId} not found`);
    return EMPTY;
  }

  const meta = metaRows[0];
  // threadsCount = distinct 1-hop neighbors (relations); entriesCount = source
  // memory count (entries that mention the entity).
  const oneHopNeighbors = oneHop.nodes.filter((n) => n.entityId !== seedId);
  const threadsCount = oneHopNeighbors.length;
  const entriesCount = meta?.sourceMemoryCount ?? 0;
  const lastMentionedAt = meta?.lastMentionedAt ?? null;

  // isNewThisMonth — first_mentioned_at within the current calendar month.
  let isNewThisMonth = false;
  if (meta?.firstMentionedAt) {
    const now = new Date();
    const fm = meta.firstMentionedAt;
    isNewThisMonth =
      fm.getUTCFullYear() === now.getUTCFullYear() && fm.getUTCMonth() === now.getUTCMonth();
  }

  // 3. Summary line. Prefer the agent-authored summary if present (it is already
  //    Voice-C per ASK-005); otherwise compose the deterministic floor with a
  //    single annotated span (the entity name). summarizeEntity always emits at
  //    least one annotation, so the multi-sentence iOS guard never trips.
  const composed = summarizeEntity({
    entityId: seedId,
    name: profile.entity.canonicalName,
    threadCount: threadsCount,
    entryCount: entriesCount,
  });
  const summary = composed.text;
  const summaryAnnotations = composed.annotations;

  // 4. Articulation flags for the seed + its 1-hop neighbors (one query).
  const flags = await articulationFlags([seedId, ...oneHopNeighbors.map((n) => n.entityId)]);

  // Summaries for neighbors come from the relatedEntities profile rows where
  // available; otherwise null (iOS renders without a neighbor caption).
  const relatedSummary = new Map<string, string | null>();
  for (const r of profile.relatedEntities) relatedSummary.set(r.entityId, null);

  const neighbors: HeroNeighbor[] = oneHopNeighbors.map((n) => ({
    entityId: n.entityId,
    type: n.type,
    name: n.name,
    // The AGE subgraph carries no per-edge weight in v1; threads read as
    // unit-strength. A future weighted-edge pass can populate this.
    edgeStrength: 1.0,
    summary: relatedSummary.get(n.entityId) ?? null,
    isArticulationPoint: flags.has(n.entityId),
  }));

  const oneHopIds = new Set(oneHopNeighbors.map((n) => n.entityId));
  const edges: HeroEdge[] = oneHop.edges
    .filter((e) => e.fromEntityId !== e.toEntityId)
    .map((e) => ({ fromEntityId: e.fromEntityId, toEntityId: e.toEntityId, strength: 1.0 }));

  // secondDegreeStubs: 2-hop nodes that are neither the seed nor 1-hop neighbors.
  // directionHint is a stable [0,1) angle derived from the entity id so the hero
  // can scatter the stubs deterministically without leaking real geometry.
  const secondDegreeStubs: HeroSecondDegreeStub[] = twoHop.nodes
    .filter((n) => n.entityId !== seedId && !oneHopIds.has(n.entityId))
    .map((n) => ({ fromEntityId: n.entityId, directionHint: directionHint(n.entityId) }));

  const active: HeroActive = {
    entityId: seedId,
    type: 'entity',
    name: profile.entity.canonicalName,
    isSelf,
    summary,
    summaryAnnotations,
    // offer (Voice-C question) needs ASK-005 for production quality; null in v1
    // (optional per the contract — iOS renders the hero without an offer).
    offer: null,
    meta: {
      threadsCount,
      entriesCount,
      lastMentionedAt: lastMentionedAt ? lastMentionedAt.toISOString() : null,
      isNewThisMonth,
    },
    topology: {
      isArticulationPoint: flags.has(seedId),
    },
  };

  return { active, neighbors, edges, secondDegreeStubs };
}

/** Deterministic [0,1) hint from a uuid's leading hex digits. */
function directionHint(id: string): number {
  const hex = id.replace(/-/g, '').slice(0, 8);
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? (n % 10000) / 10000 : 0;
}
