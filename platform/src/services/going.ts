/**
 * Going-toward service (iOS API v1 — going-toward surface).
 *
 * Aggregates the EXISTING graph signals into the iOS DirectionalCommitment
 * wire shape and composes each throughline's `line` DETERMINISTICALLY. There
 * is NO backend ASK-GOING in _research/backend-asks.md — going-toward is an
 * iOS-internal surface (see BACKEND-INTEGRATION-SCOPING.md §"Surface:
 * going-toward"). The derivation here is a DOCUMENTED DECISION built to the
 * design/03-home.md §"Section 5 — Going toward" intent; flag it as a spike
 * (see SPIKE note below).
 *
 * Sources aggregated (all pre-computed, no inline LLM):
 *   - entity_clusters   (getClustersSnapshot / clustering.ts)  — focus areas
 *   - entity_topology   (getTopologySnapshot / topology.ts)    — community +
 *                                                                pagerank for
 *                                                                the "spoke"
 *                                                                entity
 *   - entity_drift_events (getDriftEvents / drift.ts)          — stability /
 *                                                                movement
 *   - entities + memory_entities (raw SQL)                     — canonical
 *                                                                name + the
 *                                                                supporting-
 *                                                                entry count
 *
 * WIRE CONTRACT this service must satisfy (iOS DirectionalCommitment.swift):
 *   - directionId        non-empty string
 *   - line               non-empty Voice-C prose, lowercase; MUST contain
 *                        italicEntity.name as a substring (the iOS decoder
 *                        soft-validates this — a miss degrades to non-italic,
 *                        not a throw, but we never ship a miss)
 *   - italicEntity       { entityId: non-empty, name: non-empty }
 *   - status             "confirmed" | "still-inferring"
 *   - confirmedSince     ISO-8601 when confirmed; null when still-inferring
 *   - supportingEntries  int >= 0  (the iOS decoder REJECTS negatives)
 *
 * The throughline composer lives HERE (not in the shared voice-c-composer.ts)
 * per the surface brief, to avoid collisions with hero/notification phrasing.
 * It follows the same deterministic pattern (assertVoiceC + a compose helper)
 * but emits a throughline-shaped line rather than a {text, annotations} block —
 * the going-toward wire carries `line` as a plain string, not an annotated
 * VoiceCComposition (the iOS DTO has no annotation field for going-toward).
 *
 * SPIKE / FLAG-FOR-REVIEW — derivation is a documented decision, not a pinned
 * contract: design/03-home.md §5 says a direction is "inferred from
 * communities + drift" and "confirmed when its supporting fact count is stable
 * for ≥4 weeks", but does not pin (a) how a community becomes a *direction*
 * (the throughline phrase), (b) which entity in a community is the italicized
 * "throughline word", or (c) what counts as "supporting entries". The choices
 * below are the deterministic floor; the LLM-throughline upgrade is a
 * documented follow-up (mirrors voice-c-composer.ts's deterministic-floor
 * posture):
 *   - DIRECTION = a stable community (entity_clusters cluster_id != -1, or a
 *     topology community_id) with >= MIN_SUPPORTING_ENTRIES distinct
 *     supporting memories. Each community yields one direction.
 *   - ITALIC ENTITY = the community's representative highest-pagerank entity
 *     (reuses the bridge spoke-naming decision G2 from the scoping doc:
 *     deterministic, no new table/agent).
 *   - STATUS = "confirmed" when the community has been stable (no drift event
 *     moving its entities out) for >= STABLE_WEEKS (4) weeks AND has >=
 *     MIN_CONFIRMED_SUPPORTING supporting entries; else "still-inferring".
 *     "Stable for >=4 weeks" is approximated by the representative entity's
 *     first_seen_at being >= STABLE_WEEKS ago (the cluster tables carry only a
 *     single computed_at snapshot, not a stability history — see DECISION
 *     below).
 *   - SUPPORTING ENTRIES = count of distinct memory_id rows in memory_entities
 *     for the community's entities.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { getClustersSnapshot } from './clustering.js';
import { getTopologySnapshot } from './topology.js';
import { getDriftEvents } from './drift.js';
import {
  assertVoiceC,
  type VoiceCSourceType,
} from './voice-c-composer.js';

// =============================================================================
// Tunable knobs
// =============================================================================

/** Minimum distinct supporting memories for a community to count as a
 *  direction at all. Mirrors the iOS visibility filter's >=3 floor
 *  (design/03-home.md §5: "fewer than 2 directions with >=3 supporting
 *  entries" hides the section). */
const MIN_SUPPORTING_ENTRIES = 3;

/** Minimum supporting entries for a direction to be "confirmed" (the
 *  emergence gate in design/03-home.md §5 references >=2 confirmed focus
 *  areas for the section's FIRST emergence; per-direction we require the
 *  visibility floor plus stability). */
const MIN_CONFIRMED_SUPPORTING = 3;

/** A direction is "confirmed" when its representative entity has been seen
 *  for at least this many weeks (design/03-home.md §5: "stable for >=4
 *  weeks"). See DECISION below for why first_seen_at stands in for a true
 *  cluster-stability history. */
const STABLE_WEEKS = 4;

/** How many directions to return, newest/most-supported first. The iOS view
 *  layer applies its own visibility filter; we cap to keep the payload sane. */
const MAX_DIRECTIONS = 12;

/** Months in lowercase per 01-voice-and-tone.md §"Time" (never "mar"). */
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// =============================================================================
// Wire DTO (camelCase — matches the iOS CodingKeys exactly)
// =============================================================================

export type DirectionStatus = 'confirmed' | 'still-inferring';

export interface DirectionItalicEntity {
  entityId: string;
  name: string;
}

export interface DirectionalCommitment {
  directionId: string;
  line: string;
  italicEntity: DirectionItalicEntity;
  status: DirectionStatus;
  /** ISO-8601 when status === 'confirmed'; null when 'still-inferring'. */
  confirmedSince: string | null;
  supportingEntries: number;
}

export interface GoingTowardResponse {
  directions: DirectionalCommitment[];
}

// =============================================================================
// Deterministic throughline composer
// =============================================================================

/**
 * Compose a single throughline `line` for a direction. DETERMINISTIC — no LLM.
 *
 * The line is short Voice-C-adjacent prose that NAMES the throughline via the
 * representative entity, with the entity's canonical name appearing verbatim
 * as a substring (the iOS decoder soft-validates that italicEntity.name is a
 * substring of line; we guarantee it by construction). Lowercase, no
 * forbidden verbs, no system-self — asserted before return.
 *
 * The composition is a fixed template filled with the lowercased entity name,
 * so the substring guarantee is structural rather than searched:
 *
 *   "moving toward <name>."          (default — a gentle directional read)
 *
 * The representative entity's name is itself the italicized throughline word
 * (design/03-home.md §5: "The italicized word is the entity name"). We do not
 * attempt to derive a *different* throughline noun (e.g. "honest" from an
 * "honesty" entity) — that is the LLM-throughline upgrade's job, flagged as a
 * spike. Lowercasing + whitespace-collapse keeps "Project  Atlas" clean.
 *
 * Single sentence, so the multi-sentence annotation invariant that
 * voice-c-composer.ts enforces does not apply (going-toward carries `line` as
 * a plain string, not an annotated VoiceCComposition).
 */
export function composeThroughline(entityName: string): string {
  // normalize exactly as voice-c-composer.ts does: lowercase, collapse
  // internal whitespace, trim — so the substring guarantee holds against the
  // same-normalized italicEntity.name the route emits.
  const name = entityName.toLowerCase().replace(/\s+/g, ' ').trim();
  if (name.length === 0) {
    throw new Error(
      'going-toward: cannot compose a throughline from an empty entity name',
    );
  }
  const line = `moving toward ${name}.`;
  assertVoiceC(line);
  return line;
}

// =============================================================================
// Aggregation
// =============================================================================

interface CommunityEntity {
  entityId: string;
  canonicalName: string;
  communityId: number;
  /** PageRank-weighted representativeness within the community. Null => treat
   *  as 0 (least representative). */
  pagerank: number | null;
}

interface CommunityAggregate {
  communityId: number;
  /** The representative highest-pagerank entity (the italic "throughline word"). */
  representative: CommunityEntity;
  /** All entity ids in this community (for the supporting-entry count + the
   *  directionId). */
  entityIds: string[];
}

/** Lowercase month name for a Date, per 01-voice-and-tone.md §"Time". */
function lowercaseMonth(d: Date): string {
  return MONTH_NAMES[d.getUTCMonth()] ?? 'unknown';
}

/**
 * Build the set of candidate communities from topology community_id, each with
 * its representative (highest-pagerank) entity and full entity-id roster.
 *
 * Topology is the canonical community source (Leiden community_id, per
 * design/03-home.md §5 "Communities (/api/topology — Leiden community_id)").
 * entity_clusters (HDBSCAN) is the secondary signal — its cluster_id != -1
 * rows corroborate, but topology's community_id is what the design doc names.
 * We use topology community_id as the grouping key.
 *
 * Returns [] when topology is empty (fresh DB / not yet computed).
 */
async function gatherCommunities(): Promise<CommunityAggregate[]> {
  const topo = await getTopologySnapshot();
  if (topo.entities.length === 0) return [];

  // Join topology community_id -> entities for canonical_name + pagerank.
  // community_id NULL entities (not yet assigned) are excluded from directions.
  const assigned = topo.entities.filter((e) => e.communityId !== null);
  if (assigned.length === 0) return [];

  const entityIds = assigned.map((e) => e.id);
  const nameRows = (await db.execute(sql`
    SELECT id::text AS entity_id, canonical_name
    FROM public.entities
    WHERE id IN (${sql.join(
      entityIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `)) as unknown as Array<{ entity_id: string; canonical_name: string }>;
  const nameById = new Map(nameRows.map((r) => [r.entity_id, r.canonical_name]));

  // Group by community_id.
  const byCommunity = new Map<number, CommunityEntity[]>();
  for (const e of assigned) {
    const cid = e.communityId!;
    const name = nameById.get(e.id);
    if (!name) continue; // entity vanished between snapshots — skip
    const entry: CommunityEntity = {
      entityId: e.id,
      canonicalName: name,
      communityId: cid,
      pagerank: e.pagerank,
    };
    const list = byCommunity.get(cid);
    if (list) list.push(entry);
    else byCommunity.set(cid, [entry]);
  }

  const aggregates: CommunityAggregate[] = [];
  for (const [communityId, members] of byCommunity) {
    // Representative = highest pagerank (ties broken by canonical_name for
    // determinism). Null pagerank sorts last.
    members.sort((a, b) => {
      const pa = a.pagerank ?? -1;
      const pb = b.pagerank ?? -1;
      if (pb !== pa) return pb - pa;
      return a.canonicalName.localeCompare(b.canonicalName);
    });
    const representative = members[0]!;
    aggregates.push({
      communityId,
      representative,
      entityIds: members.map((m) => m.entityId),
    });
  }
  return aggregates;
}

/**
 * Count distinct supporting memories (memory_entities.memory_id) for a set of
 * entity ids, and return the earliest first_seen_at among those entities
 * (the stability proxy — see DECISION below).
 *
 * Returns { supportingEntries: 0, firstSeenAt: null } when the community has
 * no memory links yet (a computed community whose entities have not been
 * mentioned in any captured memory).
 */
interface CommunitySupport {
  supportingEntries: number;
  /** Earliest first_seen_at among the community's entities, or null if none. */
  firstSeenAt: Date | null;
}

async function gatherSupport(entityIds: string[]): Promise<CommunitySupport> {
  if (entityIds.length === 0) {
    return { supportingEntries: 0, firstSeenAt: null };
  }
  // FIX (integration): hoist sql.join to a variable instead of inlining
  // `sql.join(..., sql`, `)` directly inside the outer tagged template. The
  // inline nested-backtick form made tsc mis-tokenize and emit TS1005/TS1109
  // at the trailing `)) as unknown as Array<{`. graph-fallback.ts:110 uses
  // this hoisted-variable idiom and typechecks clean.
  const idList = sql.join(entityIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = (await db.execute(sql`
    SELECT
      (SELECT COUNT(DISTINCT me.memory_id)::int
         FROM public.memory_entities me
        WHERE me.entity_id IN (${idList})) AS supporting_entries,
      (SELECT MIN(e.first_seen_at)
         FROM public.entities e
        WHERE e.id IN (${idList})) AS first_seen_at
  `)) as unknown as Array<{
    supporting_entries: number | null;
    first_seen_at: Date | null;
  }>;
  const r = rows[0];
  return {
    supportingEntries: Math.max(0, Number(r?.supporting_entries ?? 0) || 0),
    firstSeenAt: r?.first_seen_at instanceof Date ? r.first_seen_at : null,
  };
}

/**
 * DECISION (documented): "stable for >=4 weeks" (design/03-home.md §5) is
 * approximated by the representative entity's first_seen_at being >=
 * STABLE_WEEKS ago. The cluster/topology tables carry only a single
 * computed_at snapshot (no per-community stability history), so a true
 * "supporting fact count has been stable for 4 weeks" signal is not
 * available without a new table. first_seen_at is a conservative proxy: an
 * entity first seen <4 weeks ago cannot yet have a 4-week-stable throughline.
 *
 * A drift event moving the representative (or any community entity) to a
 * DIFFERENT cluster within the stability window DISCONFIRMS — the community is
 * "still-inferring" until it settles again. We only count drift events newer
 * than the stability cutoff.
 */
function isStable(
  firstSeenAt: Date | null,
  driftedAwayWithinWindow: boolean,
  now: Date,
): boolean {
  if (firstSeenAt === null) return false;
  const stableCutoff = new Date(now.getTime() - STABLE_WEEKS * 7 * 24 * 60 * 60 * 1000);
  if (firstSeenAt > stableCutoff) return false; // not yet 4 weeks old
  if (driftedAwayWithinWindow) return false; // moved recently
  return true;
}

/**
 * The set of entity ids that drifted to a different cluster within the
 * stability window. A community containing any of these is not yet stable.
 */
async function driftedWithinWindow(now: Date): Promise<Set<string>> {
  const cutoff = new Date(now.getTime() - STABLE_WEEKS * 7 * 24 * 60 * 60 * 1000);
  const result = await getDriftEvents({ entityId: null, limit: 500 });
  const drifted = new Set<string>();
  for (const ev of result.events) {
    const detected = new Date(ev.detected_at);
    if (detected < cutoff) continue;
    // A drift event whose target_cluster_id differs from cluster_id_at_detection
    // represents an entity that moved communities.
    if (
      ev.target_cluster_id !== null &&
      ev.cluster_id_at_detection !== null &&
      ev.target_cluster_id !== ev.cluster_id_at_detection
    ) {
      drifted.add(ev.entity_id);
    }
  }
  return drifted;
}

// =============================================================================
// Public entry point
// =============================================================================

/**
 * Aggregate the graph signals into the iOS GoingTowardResponse. Deterministic;
 * no LLM. Returns { directions: [] } on a fresh / not-yet-computed graph
 * (no topology, or no community with enough supporting entries) — the iOS
 * view layer then hides the section (design/03-home.md §5 empty-state rule).
 *
 * Callable directly (tests) or via the Hono handler in routes/going.ts.
 */
export async function composeGoingToward(now: Date = new Date()): Promise<GoingTowardResponse> {
  // getClustersSnapshot is read for the corroborating cluster summary (used
  // to skip the HDBSCAN noise bucket -1 when topology community_id aligns
  // with it). It is not the primary grouping key; topology community_id is.
  const clusters = await getClustersSnapshot();
  const noiseClusterIds = new Set<number>(
    Object.entries(clusters.summary)
      .filter(([, size]) => Number(size) > 0)
      .map(([id]) => Number(id))
      .filter((id) => id === -1),
  );

  const communities = await gatherCommunities();
  if (communities.length === 0) return { directions: [] };

  const drifted = await driftedWithinWindow(now);

  const candidates: Array<DirectionalCommitment> = [];
  for (const comm of communities) {
    const support = await gatherSupport(comm.entityIds);

    // Visibility floor: a community needs >= MIN_SUPPORTING_ENTRIES distinct
    // supporting memories to be a direction at all.
    if (support.supportingEntries < MIN_SUPPORTING_ENTRIES) continue;

    // Representative entity drives the throughline word + the stability check.
    const repSupport = await gatherSupport([comm.representative.entityId]);
    const stable = isStable(
      repSupport.firstSeenAt,
      comm.entityIds.some((id) => drifted.has(id)),
      now,
    );
    const confirmed = stable && support.supportingEntries >= MIN_CONFIRMED_SUPPORTING;

    // directionId is deterministic + unique per community: it must be
    // non-empty (iOS rejects empty) and stable across runs (so re-fetches
    // don't reshuffle SwiftUI ForEach identity). community prefix + rep id.
    const directionId = `going:community-${comm.communityId}:${comm.representative.entityId}`;

    const name = comm.representative.canonicalName
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    // If the rep name normalizes to empty (shouldn't happen — entities have
    // NOT NULL canonical_name), skip rather than ship an empty italic name.
    if (name.length === 0) continue;

    const line = composeThroughline(name);

    let confirmedSince: string | null = null;
    if (confirmed) {
      // confirmedSince = when the direction first stabilized. With only a
      // single computed_at snapshot available, the representative entity's
      // first_seen_at is the earliest credible "stability start" (an entity
      // cannot stabilize before it was first seen). DOCUMENTED proxy.
      confirmedSince = (repSupport.firstSeenAt ?? now).toISOString();
    }

    candidates.push({
      directionId,
      line,
      italicEntity: {
        entityId: comm.representative.entityId,
        name,
      },
      status: confirmed ? 'confirmed' : 'still-inferring',
      confirmedSince,
      supportingEntries: support.supportingEntries,
    });
  }

  // Most-supported first (stable throughlines surface above thin ones); tie-
  // break by community id for determinism.
  candidates.sort((a, b) => {
    if (b.supportingEntries !== a.supportingEntries) {
      return b.supportingEntries - a.supportingEntries;
    }
    return a.directionId.localeCompare(b.directionId);
  });

  return { directions: candidates.slice(0, MAX_DIRECTIONS) };
}

// silence "unused" on the re-export consumers may import directly.
export type { VoiceCSourceType };
