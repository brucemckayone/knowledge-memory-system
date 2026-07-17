/**
 * Bridge / explore service (iOS API v1 — ASK-014 degraded v1).
 *
 * Two READ surfaces feeding the iOS bridge/explore module
 * (design/07-modules/bridge.md, contract pinned in
 * Sources/MnemoBackend/ASK/Bridge/BridgeData.swift):
 *
 *   1. composeBridgeCurrent()  -> { bridgeNarrative: BridgeNarrative | null }
 *      The pregenerated Voice-C read of the user's structural bridge this
 *      season — the highest-betweenness entity, plus the communities (cluster
 *      spokes) running through it. `null` when no qualifying bridge exists
 *      (fresh graph / no topology).
 *
 *   2. composeExploreNode(entityId) -> ExploreNodeResponse
 *      One node + its 1-hop neighbors (+ edge strengths), for the endless walk.
 *      secondDegree / secondDegreeStubs are [] in this v1 (see SIMPLIFICATIONS).
 *
 * DEFERRED (out of scope for this v1, iOS keeps 501 stubs): the three handle
 * endpoints (confirm / reject / rename) and the bridgeShift notification.
 *
 * ============================================================================
 * SIMPLIFICATIONS / HONESTY (this is a degraded v1 — read before trusting):
 * ============================================================================
 *
 *   - CLUSTER SPOKE NAMING is a REAL LLM TOPIC LABEL (ASK-014 chosen path).
 *     Each spoke is labeled by the ml-services POST /label-cluster endpoint: it
 *     composes ONE short Voice-C topic phrase ("the move", "the tired weeks")
 *     from the cluster's member entity canonical names (+ entity_meta.summary
 *     where present). Spokes are labeled CONCURRENTLY (Promise.all) so N
 *     clusters cost one round of parallel LLM calls, not N serial ones.
 *     FALLBACK: on a per-cluster label failure (503 / network / junk) the spoke
 *     falls back to the highest-pagerank member's canonical name — the original
 *     v1 heuristic — so the endpoint never 500s on a labeling hiccup. The label
 *     is therefore a synthesized theme when the LLM is healthy, and an entity
 *     name when it is not.
 *
 *   - The NARRATIVE is REAL Voice-C prose with REAL in-bounds annotations,
 *     composed via the deterministic composeVoiceC floor (NOT the LLM seam):
 *     each spoke name is emitted as a sourced part, so the composer computes
 *     in-bounds UTF-16 spans citing each community id. It is template prose
 *     ("<n> threads run through <bridge> this season — <spoke>, <spoke>…"),
 *     not LLM-generated. The richer LLM narrative is the documented follow-up.
 *
 *   - isNewThisMonth on a spoke derives from the cluster computed_at month
 *     bucket. entity_clusters carries a single computed_at snapshot, so this
 *     means "this clustering run computed within the current calendar month",
 *     a coarse proxy for "the cluster emerged this month". FLAGGED.
 *
 *   - DRAWER TEXT for an explore node is the deterministic summarizeEntity
 *     Voice-C composition (the same floor hero.ts uses), NOT the agent-authored
 *     entity_meta.summary and NOT an LLM read. summarizeEntity always emits one
 *     annotation (the entity name), so the multi-sentence iOS guard never trips.
 *
 *   - edgeStrength for explore neighbors is 1.0 (unit strength). The AGE
 *     subgraph carries no per-edge weight in v1 (same as hero.ts). FLAGGED.
 *
 *   - secondDegree = [] and secondDegreeStubs = [] for this v1. iOS defaults
 *     both to [] and the renderer simply shows no ghost ring. FLAGGED.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { getTopologySnapshot } from './topology.js';
import { getSelfEntity } from './entities.js';
import { getEntityProfile } from './entity-profile.js';
import { getSubgraph } from './graph.js';
import {
  composeVoiceC,
  summarizeEntity,
  assertVoiceC,
  type VoiceCAnnotation,
  type VoiceCPart,
} from './voice-c-composer.js';

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// =============================================================================
// Wire DTOs (camelCase — match the iOS CodingKeys exactly; see BridgeData.swift)
// =============================================================================

/** iOS AnnotationBlock — a bare-array-under-{annotations} wrapper (ASK-009). */
export interface AnnotationBlock {
  annotations: VoiceCAnnotation[];
}

export interface ClusterSpoke {
  communityId: string;
  name: string;
  isNewThisMonth: boolean;
}

export interface BridgeNarrative {
  compositionId: string;
  /** null when isMe (no distinct entity row). */
  bridgeEntityId: string | null;
  bridgeEntityName: string;
  isMe: boolean;
  narrativeText: string;
  narrativeAnnotations: VoiceCAnnotation[];
  clusterSpokes: ClusterSpoke[];
  composedAt: string;
}

export interface BridgeNarrativeResponse {
  bridgeNarrative: BridgeNarrative | null;
}

export type NodeType = 'entity' | 'thread' | 'entry' | 'self';

export interface NodeMeta {
  threadsCount?: number;
  entriesCount?: number;
}

export interface ExploreNode {
  entityId: string;
  name: string;
  type: NodeType;
  isBridge: boolean;
  isSelf: boolean;
  isNewThisMonth: boolean;
  drawerText: string;
  drawerAnnotations: VoiceCAnnotation[];
  meta: NodeMeta;
  // --- Lens-facet fields (iOS exploration lens chip row) ---------------------
  // Additive per-node facets the ask surface joins against the visible graph to
  // light the bridges / type / community / recency chips. Kept as flat sibling
  // scalars — never nest or restructure drawerAnnotations (bare-array contract).
  /** Raw entity taxonomy (person/place/company/project/…) for the TYPE lens.
   *  Distinct from `type`, which collapses every real entity to 'entity'. */
  entityType: string;
  /** True graph articulation point — the BRIDGES lens. Same field + semantics
   *  as /api/hero's topology.isArticulationPoint (NOT the betweenness-max
   *  `isBridge` heuristic above, which is unchanged and coexists). */
  isArticulationPoint: boolean;
  /** Leiden community id as a string, null when uncomputed — the COMMUNITY lens.
   *  Matches ClusterSpoke.communityId on the bridge surface. */
  communityId: string | null;
  /** entity_meta.last_mentioned_at as ISO-8601, null when absent — the RECENCY
   *  lens. Deliberately NOT the first-mention-based isNewThisMonth. */
  lastMentionedAt: string | null;
}

export interface ExploreNeighbor {
  entityId: string;
  name: string;
  type: NodeType;
  edgeStrength: number;
  isBridge: boolean;
  isNewThisMonth: boolean;
  // Lens-facet fields — see ExploreNode for semantics.
  entityType: string;
  isArticulationPoint: boolean;
  communityId: string | null;
  lastMentionedAt: string | null;
}

export interface ExploreSecondDegreeNode {
  entityId: string;
  name: string;
  type: NodeType;
  parentEntityId: string;
  edgeStrength: number;
}

export interface SecondDegreeStub {
  fromEntityId: string;
  directionHint: number;
}

export interface ExploreNodeResponse {
  node: ExploreNode;
  neighbors: ExploreNeighbor[];
  secondDegree: ExploreSecondDegreeNode[];
  secondDegreeStubs: SecondDegreeStub[];
}

// Raised when an EXPLICIT entityId does not resolve to a profile, so the route
// answers 404 (matches the iOS contract — ExploreNodeRequest has no documented
// let-go success-shape, unlike rise; an unknown node is a transport 404).
export class ExploreNodeNotFoundError extends Error {}

// =============================================================================
// Bridge entity + spoke derivation
// =============================================================================

/** Lowercase + collapse whitespace + trim, matching voice-c-composer.normalize. */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Map a raw AGE node type string onto the iOS NodeType discriminator.
 * Unknown / absent types fall back to 'entity' (the explore canvas's default
 * pearl) rather than throwing — a single off-spec type on a neighbor would
 * otherwise drop the whole frame.
 */
function toNodeType(raw: string | null | undefined, isSelf: boolean): NodeType {
  if (isSelf) return 'self';
  switch (raw) {
    case 'thread':
      return 'thread';
    case 'entry':
      return 'entry';
    case 'self':
      return 'self';
    case 'entity':
      return 'entity';
    default:
      return 'entity';
  }
}

interface CommunityMember {
  entityId: string;
  canonicalName: string;
  communityId: number;
  pagerank: number | null;
}

/**
 * Resolve canonical names for a set of entity ids in one query. Returns a
 * Map<id, canonical_name>; ids that vanished between snapshots are absent.
 */
async function namesFor(entityIds: string[]): Promise<Map<string, string>> {
  if (entityIds.length === 0) return new Map();
  const idList = sql.join(entityIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = (await db.execute(sql`
    SELECT id::text AS entity_id, canonical_name
    FROM public.entities
    WHERE id IN (${idList})
  `)) as unknown as Array<{ entity_id: string; canonical_name: string }>;
  return new Map(rows.map((r) => [r.entity_id, r.canonical_name]));
}

/**
 * Build the per-community member roster (with pagerank) for the communities the
 * bridge entity participates in. The bridge entity's own community is the
 * primary spoke; topology carries a single community_id per entity (Leiden), so
 * "communities running through the bridge" = the bridge's community plus the
 * communities of its 1-hop neighbors (the threads it connects). Each distinct
 * community becomes one spoke.
 */
function membersByCommunity(
  entities: Array<{ id: string; communityId: number | null; pagerank: number | null }>,
  nameById: Map<string, string>,
): Map<number, CommunityMember[]> {
  const byCommunity = new Map<number, CommunityMember[]>();
  for (const e of entities) {
    if (e.communityId === null) continue;
    const name = nameById.get(e.id);
    if (!name) continue;
    const member: CommunityMember = {
      entityId: e.id,
      canonicalName: name,
      communityId: e.communityId,
      pagerank: e.pagerank,
    };
    const list = byCommunity.get(e.communityId);
    if (list) list.push(member);
    else byCommunity.set(e.communityId, [member]);
  }
  return byCommunity;
}

/** Representative (highest-pagerank, name-tiebroken) member of a community. */
function representative(members: CommunityMember[]): CommunityMember {
  return [...members].sort((a, b) => {
    const pa = a.pagerank ?? -1;
    const pb = b.pagerank ?? -1;
    if (pb !== pa) return pb - pa;
    return a.canonicalName.localeCompare(b.canonicalName);
  })[0]!;
}

/** True if `d` falls within `now`'s calendar month (UTC). */
function isThisMonth(d: Date | null, now: Date): boolean {
  if (d === null) return false;
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
}

/**
 * The cluster computed_at for each community id (entity_clusters carries a
 * single snapshot timestamp). Used as the coarse isNewThisMonth proxy. Returns
 * a Map<cluster_id, computed_at>; communities with no entity_clusters row are
 * absent (-> isNewThisMonth false).
 */
async function clusterComputedAt(): Promise<Map<number, Date>> {
  const rows = (await db.execute(sql`
    SELECT cluster_id, MAX(computed_at) AS computed_at
    FROM public.entity_clusters
    GROUP BY cluster_id
  `)) as unknown as Array<{ cluster_id: number; computed_at: Date | null }>;
  const out = new Map<number, Date>();
  for (const r of rows) {
    if (r.computed_at instanceof Date) out.set(Number(r.cluster_id), r.computed_at);
  }
  return out;
}

/**
 * entity_meta.summary for a set of entity ids, in one query. Used as optional
 * theme context for the LLM cluster labeler. Returns a Map<id, summary> with
 * only non-blank summaries; ids with no row / null summary are absent.
 */
async function summariesFor(entityIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (entityIds.length === 0) return out;
  const idList = sql.join(entityIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = (await db.execute(sql`
    SELECT entity_id::text AS entity_id, summary
    FROM public.entity_meta
    WHERE entity_id IN (${idList}) AND summary IS NOT NULL
  `)) as unknown as Array<{ entity_id: string; summary: string | null }>;
  for (const r of rows) {
    if (typeof r.summary === 'string' && r.summary.trim().length > 0) {
      out.set(r.entity_id, r.summary.trim());
    }
  }
  return out;
}

/**
 * Compose a REAL Voice-C topic label for one cluster via ml-services
 * POST /label-cluster. The endpoint composes a short theme phrase ("the move")
 * from the cluster's member names (+ optional summaries).
 *
 * Returns the composed label on success, or `null` on ANY failure (non-2xx,
 * network, malformed body, blank label) so the caller can fall back to the
 * highest-pagerank member name. NEVER throws — a labeling hiccup must not 500
 * the bridge endpoint. Mirrors the backend->ml fetch shape in causal-agent.ts.
 */
async function labelClusterViaLLM(
  memberNames: string[],
  memberSummaries: string[],
): Promise<string | null> {
  try {
    const response = await fetch(`${config.ML_SERVICES_URL}/label-cluster`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        member_names: memberNames,
        member_summaries: memberSummaries.length > 0 ? memberSummaries : undefined,
      }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { label?: unknown };
    const label = typeof body.label === 'string' ? normalizeName(body.label) : '';
    return label.length > 0 ? label : null;
  } catch {
    return null;
  }
}

// =============================================================================
// GET /api/bridge/current — composeBridgeCurrent
// =============================================================================

/**
 * Compose the bridge narrative envelope. Returns { bridgeNarrative: null } when:
 *   - topology is empty (fresh graph / not yet computed), OR
 *   - no entity has a positive betweenness (no structural bridge), OR
 *   - the bridge entity has no community spoke to name.
 *
 * Otherwise:
 *   - bridge entity = the highest-betweenness topology entity.
 *   - isMe = the bridge entity is the self entity; then bridgeEntityId = null.
 *   - clusterSpokes = the communities running through the bridge (its own
 *     community + its 1-hop neighbors' communities), each named by its
 *     representative entity (HEURISTIC — see SIMPLIFICATIONS at the top).
 *   - narrativeText = REAL Voice-C prose naming the bridge + its spokes, with
 *     REAL in-bounds annotations citing each community id.
 */
export async function composeBridgeCurrent(now: Date = new Date()): Promise<BridgeNarrativeResponse> {
  const topo = await getTopologySnapshot();
  if (topo.entities.length === 0) return { bridgeNarrative: null };

  // Bridge entity = highest betweenness (must be > 0 to be a real bridge).
  const withBetweenness = topo.entities
    .filter((e) => typeof e.betweennessSampled === 'number' && e.betweennessSampled! > 0)
    .sort((a, b) => (b.betweennessSampled ?? 0) - (a.betweennessSampled ?? 0));
  if (withBetweenness.length === 0) return { bridgeNarrative: null };

  const bridge = withBetweenness[0]!;

  // The communities running through the bridge: the bridge's own community plus
  // the communities of its 1-hop neighbors. Pull the 1-hop subgraph to find the
  // neighbor ids, then gather community membership from topology.
  const oneHop = await getSubgraph([bridge.id], { maxDepth: 1, limit: 50 });
  const neighborIds = oneHop.nodes.map((n) => n.entityId).filter((id) => id !== bridge.id);

  const relevantEntityIds = new Set<string>([bridge.id, ...neighborIds]);
  const relevantTopo = topo.entities.filter((e) => relevantEntityIds.has(e.id));

  const nameById = await namesFor([...relevantEntityIds]);
  const byCommunity = membersByCommunity(
    relevantTopo.map((e) => ({ id: e.id, communityId: e.communityId, pagerank: e.pagerank })),
    nameById,
  );

  // Self resolution.
  const self = await getSelfEntity();
  const isMe = self?.id === bridge.id;

  const bridgeName = isMe
    ? normalizeName(self?.name ?? nameById.get(bridge.id) ?? 'you')
    : normalizeName(nameById.get(bridge.id) ?? '');
  if (bridgeName.length === 0) return { bridgeNarrative: null };

  // Spokes: one per community, each labeled with a REAL Voice-C topic phrase
  // composed by ml-services /label-cluster from the cluster's member names
  // (+ summaries). Labeling is CONCURRENT (Promise.all) — one round of parallel
  // LLM calls, not N serial. On a per-cluster label failure the spoke falls
  // back to its highest-pagerank member name (the original v1 heuristic), so a
  // labeling hiccup never 500s this endpoint.
  const computedAtByCluster = await clusterComputedAt();
  const summaryById = await summariesFor([...relevantEntityIds]);

  // Deterministic order: by community id ascending.
  const communityIds = [...byCommunity.keys()].sort((a, b) => a - b);

  const labeledSpokes = await Promise.all(
    communityIds.map(async (cid): Promise<ClusterSpoke | null> => {
      const members = byCommunity.get(cid)!;
      const rep = representative(members);
      const fallbackName = normalizeName(rep.canonicalName);
      if (fallbackName.length === 0) return null;

      // Member names highest-pagerank first, so the labeler (and the fallback)
      // see the most central members first.
      const ordered = [...members].sort((a, b) => (b.pagerank ?? -1) - (a.pagerank ?? -1));
      const memberNames = ordered.map((m) => normalizeName(m.canonicalName)).filter((n) => n.length > 0);
      const memberSummaries = ordered
        .map((m) => summaryById.get(m.entityId))
        .filter((s): s is string => typeof s === 'string' && s.length > 0);

      const llmLabel = await labelClusterViaLLM(memberNames, memberSummaries);
      return {
        communityId: String(cid),
        name: llmLabel ?? fallbackName, // LLM theme, or heuristic fallback
        isNewThisMonth: isThisMonth(computedAtByCluster.get(cid) ?? null, now),
      };
    }),
  );

  const spokes: ClusterSpoke[] = labeledSpokes.filter((s): s is ClusterSpoke => s !== null);

  if (spokes.length === 0) return { bridgeNarrative: null };

  const { text, annotations } = composeBridgeNarrative(bridgeName, spokes, now);

  // compositionId: deterministic + stable across runs so iOS ForEach identity
  // and re-fetches don't reshuffle. NOT a stored composition row (this v1
  // composes on read) — flagged: a real pregenerated-composition table is the
  // follow-up the iOS doc describes ("composed async like re-read letters").
  const compositionId = `bridge:${bridge.id}`;

  const narrative: BridgeNarrative = {
    compositionId,
    bridgeEntityId: isMe ? null : bridge.id,
    bridgeEntityName: bridgeName,
    isMe,
    narrativeText: text,
    narrativeAnnotations: annotations,
    clusterSpokes: spokes,
    composedAt: now.toISOString(),
  };

  return { bridgeNarrative: narrative };
}

/** Months in lowercase per 01-voice-and-tone.md §"Time" (the "season" word). */
const SEASONS = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer',
  'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];

function pluralizeThreads(n: number): string {
  return n === 1 ? '1 thread' : `${n} threads`;
}

/**
 * Compose the bridge narrative as REAL Voice-C prose with REAL in-bounds spans.
 *
 * Built via the deterministic composeVoiceC floor: each spoke name is emitted
 * as a SOURCED part, so the composer computes the UTF-16 span citing that
 * community id (source.type 'event' — the spoke is a community/cluster signal,
 * mapped onto the VoiceCSourceType union; the iOS AnnotationBlock carries the
 * {type,id} through opaquely). The bridge name is emitted as a sourced 'entity'
 * part too, so it underlines.
 *
 * The "new this month" tail is appended (no source — it is a metric, not a tap
 * target), and it counts spokes flagged isNewThisMonth.
 *
 * Single-sentence-ish, but multi-sentence-safe because every spoke carries a
 * span (composeVoiceC's multiSentenceWithoutAnnotations guard never trips).
 */
function composeBridgeNarrative(
  bridgeName: string,
  spokes: ClusterSpoke[],
  now: Date,
): { text: string; annotations: VoiceCAnnotation[] } {
  const season = SEASONS[now.getUTCMonth()] ?? 'season';
  const count = spokes.length;

  const parts: VoiceCPart[] = [];
  // "<n> threads run through <bridge> this <season> —"
  parts.push({ phrase: `${pluralizeThreads(count)} run through` });
  parts.push({ phrase: bridgeName, source: { type: 'entity', id: 'bridge' } });
  parts.push({ phrase: `this ${season} —` });

  // Spoke names, list-joined, each sourced to its community id. Separators are
  // plain parts; composeVoiceC's joiner attaches a "," with no leading space
  // (-> "studio,") and the following spoke / "and" with a single leading space.
  spokes.forEach((spoke, i) => {
    if (i > 0) {
      parts.push({ phrase: i === spokes.length - 1 ? ', and' : ',' });
    }
    parts.push({
      phrase: spoke.name,
      source: { type: 'event', id: `community:${spoke.communityId}` },
    });
  });

  const newCount = spokes.filter((s) => s.isNewThisMonth).length;
  if (newCount > 0) {
    parts.push({ phrase: `. ${newCount} of them ${newCount === 1 ? 'is' : 'are'} new this month.` });
  } else {
    parts.push({ phrase: '.' });
  }

  const composition = composeVoiceC(parts);
  assertVoiceC(composition.text);
  return composition;
}

// =============================================================================
// GET /api/explore/node/:entityId — composeExploreNode
// =============================================================================

/**
 * Compose one explore frame for `entityId`: the node + its 1-hop neighbors.
 *
 * Throws ExploreNodeNotFoundError when the id is malformed or resolves to no
 * profile (the route maps to 404 — the iOS ExploreNodeRequest has no documented
 * let-go success-shape, so an unknown node is a transport error, NOT an empty
 * frame; differs deliberately from rise's let-go 200).
 *
 * secondDegree / secondDegreeStubs are [] in this v1 (see SIMPLIFICATIONS).
 */
export async function composeExploreNode(
  entityId: string,
  now: Date = new Date(),
): Promise<ExploreNodeResponse> {
  if (!UUID_RE.test(entityId)) {
    throw new ExploreNodeNotFoundError(`entityId is not a uuid: ${entityId}`);
  }

  const [profile, oneHop, self, topo] = await Promise.all([
    getEntityProfile(entityId),
    getSubgraph([entityId], { maxDepth: 1, limit: 50 }),
    getSelfEntity(),
    getTopologySnapshot(),
  ]);

  if (!profile) throw new ExploreNodeNotFoundError(`entity ${entityId} not found`);

  const isSelf = self?.id === entityId;

  // Bridge = highest-betweenness topology entity (same rule as the narrative).
  let bridgeId: string | null = null;
  {
    const withBetweenness = topo.entities
      .filter((e) => typeof e.betweennessSampled === 'number' && e.betweennessSampled! > 0)
      .sort((a, b) => (b.betweennessSampled ?? 0) - (a.betweennessSampled ?? 0));
    bridgeId = withBetweenness[0]?.id ?? null;
  }

  // Per-node lens facets. Articulation (bridges lens) + community (community
  // lens) come straight from the topology snapshot already in hand — no extra
  // query. communityId 0 is a valid Leiden community, so only null/undefined
  // (no topology row) resolves to a null string.
  const topoById = new Map(topo.entities.map((e) => [e.id, e]));
  const communityIdStr = (id: string): string | null => {
    const c = topoById.get(id)?.communityId;
    return c === null || c === undefined ? null : String(c);
  };
  const isoOrNull = (d: unknown): string | null => {
    if (d instanceof Date) return d.toISOString();
    if (typeof d === 'string' && d.length > 0) return new Date(d).toISOString();
    return null;
  };

  // entity_meta counts + first_mentioned_at (isNewThisMonth) + last_mentioned_at
  // (the recency lens facet).
  const metaRows = (await db.execute(sql`
    SELECT
      source_memory_count::int AS source_memory_count,
      first_mentioned_at       AS first_mentioned_at,
      last_mentioned_at        AS last_mentioned_at
    FROM public.entity_meta
    WHERE entity_id = ${entityId}::uuid
    LIMIT 1
  `)) as unknown as Array<{
    source_memory_count: number | null;
    first_mentioned_at: Date | null;
    last_mentioned_at: Date | null;
  }>;
  const meta = metaRows[0];

  const oneHopNeighbors = oneHop.nodes.filter((n) => n.entityId !== entityId);
  const threadsCount = oneHopNeighbors.length;
  const entriesCount = Math.max(0, Number(meta?.source_memory_count ?? 0) || 0);

  const isNewThisMonth = isThisMonth(
    meta?.first_mentioned_at instanceof Date ? meta.first_mentioned_at : null,
    now,
  );

  // Drawer text: deterministic Voice-C summary (the hero floor). Always carries
  // one annotation (the entity name), so the iOS multi-sentence guard is safe.
  const nodeName = normalizeName(profile.entity.canonicalName);
  const composed = summarizeEntity({
    entityId,
    name: profile.entity.canonicalName,
    threadCount: threadsCount,
    entryCount: entriesCount,
  });

  const node: ExploreNode = {
    entityId,
    name: nodeName,
    type: toNodeType(profile.entity.entityType, isSelf),
    isBridge: bridgeId === entityId && !isSelf,
    isSelf,
    isNewThisMonth,
    drawerText: composed.text,
    drawerAnnotations: composed.annotations,
    meta: { threadsCount, entriesCount },
    entityType: profile.entity.entityType ?? 'other',
    isArticulationPoint: topoById.get(entityId)?.isArticulationPoint ?? false,
    communityId: communityIdStr(entityId),
    lastMentionedAt: isoOrNull(meta?.last_mentioned_at ?? null),
  };

  // Neighbor isNewThisMonth + bridge flags: resolve via topology (bridge) and
  // entity_meta (new-this-month) in batch.
  const neighborIds = oneHopNeighbors.map((n) => n.entityId);
  const newNeighbors = await newThisMonthSet(neighborIds, now);

  // Per-neighbor type (type lens) + last_mentioned_at (recency lens), batched.
  // Articulation + community read from the topology snapshot above.
  const neighborFacets = new Map<string, { entityType: string; lastMentionedAt: string | null }>();
  if (neighborIds.length > 0) {
    const idList = sql.join(neighborIds.map((id) => sql`${id}::uuid`), sql`, `);
    const rows = (await db.execute(sql`
      SELECT e.id::text          AS entity_id,
             e.entity_type       AS entity_type,
             m.last_mentioned_at  AS last_mentioned_at
      FROM public.entities e
      LEFT JOIN public.entity_meta m ON m.entity_id = e.id
      WHERE e.id IN (${idList})
    `)) as unknown as Array<{ entity_id: string; entity_type: string | null; last_mentioned_at: Date | null }>;
    for (const r of rows) {
      neighborFacets.set(r.entity_id, {
        entityType: r.entity_type ?? 'other',
        lastMentionedAt: isoOrNull(r.last_mentioned_at),
      });
    }
  }

  const neighbors: ExploreNeighbor[] = oneHopNeighbors.map((n) => {
    const facets = neighborFacets.get(n.entityId);
    return {
      entityId: n.entityId,
      name: normalizeName(n.name),
      type: toNodeType(n.type, false),
      // AGE subgraph carries no per-edge weight in v1 — unit strength (see hero.ts).
      edgeStrength: 1.0,
      isBridge: bridgeId === n.entityId,
      isNewThisMonth: newNeighbors.has(n.entityId),
      entityType: facets?.entityType ?? 'other',
      isArticulationPoint: topoById.get(n.entityId)?.isArticulationPoint ?? false,
      communityId: communityIdStr(n.entityId),
      lastMentionedAt: facets?.lastMentionedAt ?? null,
    };
  });

  return {
    node,
    neighbors,
    secondDegree: [],
    secondDegreeStubs: [],
  };
}

/**
 * The subset of `entityIds` whose entity_meta.first_mentioned_at falls in the
 * current calendar month (UTC). Batched. Empty input -> empty set.
 */
async function newThisMonthSet(entityIds: string[], now: Date): Promise<Set<string>> {
  const out = new Set<string>();
  if (entityIds.length === 0) return out;
  const idList = sql.join(entityIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = (await db.execute(sql`
    SELECT entity_id::text AS entity_id, first_mentioned_at
    FROM public.entity_meta
    WHERE entity_id IN (${idList})
  `)) as unknown as Array<{ entity_id: string; first_mentioned_at: Date | null }>;
  for (const r of rows) {
    const d = r.first_mentioned_at instanceof Date ? r.first_mentioned_at : null;
    if (isThisMonth(d, now)) out.add(r.entity_id);
  }
  return out;
}
