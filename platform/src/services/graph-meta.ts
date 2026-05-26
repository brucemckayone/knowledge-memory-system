/**
 * Graph Meta Service
 *
 * Computes per-entity statistics (entity_meta) from source vectors and graph
 * structure, and surfaces within-component merge candidates by enumerating
 * eligible pairs and delegating scoring + upsert to merge-scorer.ts (bead
 * nmemo-2yv.42). The signal computation and merge_candidates write surface
 * now lives in merge-scorer; this module owns:
 *   1. entity_meta upserts (mention/memory/fact counts, centroid, spread).
 *   2. The within-component pair enumeration used by detectMergeCandidates.
 *
 * Historical note: this file previously embedded a three-signal scorer with
 * per-pair DB roundtrips. The scorer extraction is the bead .42 deliverable;
 * the staging vs candidate threshold semantics are preserved.
 */

import { db } from '../db/index.js';
import { facts, memoryEntities } from '../db/schema.js';
import { eq, and, sql, isNull } from 'drizzle-orm';
import { getMemoryVectors } from './qdrant.js';
import {
  scoreMergeCandidates,
  upsertScoredCandidates,
  filterResolvedPairs,
  type PairInput,
} from './merge-scorer.js';
import { getGraphStats } from './graph-stats.js';

// Minimum mentions before an entity is eligible for merge analysis
const MIN_MENTIONS_FOR_ANALYSIS = 2;

// Minimum combined score to create a merge candidate. Below STAGING — drop
// (signal too weak); STAGING ≤ score < CANDIDATE — status='staging' (visible
// in viz but not a Reconciliation-Agent target); ≥ CANDIDATE — status='candidate'
// (Reconciliation-Agent target). The scorer's NULL-aware renormalisation keeps
// these thresholds comparable across the within-component domain (3 signals
// always populated when inputs exist).
const SCORE_THRESHOLD_STAGING = 0.4;
const SCORE_THRESHOLD_CANDIDATE = 0.7;

/**
 * Update entity_meta for a set of entity IDs.
 * Recomputes mention count, memory count, fact count, centroid, and spread.
 */
export async function updateEntityMeta(entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;

  for (const entityId of entityIds) {
    // Count mentions and get memory IDs
    const mentions = await db
      .select({
        memoryId: memoryEntities.memoryId,
        createdAt: memoryEntities.createdAt,
      })
      .from(memoryEntities)
      .where(eq(memoryEntities.entityId, entityId));

    const memoryIds = [...new Set(mentions.map(m => m.memoryId))];
    const mentionCount = mentions.length;
    const sourceMemoryCount = memoryIds.length;

    // Count active facts
    const factRows = await db
      .select({ id: facts.id })
      .from(facts)
      .where(and(eq(facts.subjectEntityId, entityId), isNull(facts.expiredAt)));
    const factCount = factRows.length;

    // Compute centroid from source memory vectors
    let centroidArray: number[] | null = null;
    let spread: number | null = null;

    if (memoryIds.length > 0) {
      const vectors = await getMemoryVectors(memoryIds);

      if (vectors.size > 0) {
        const vecs = [...vectors.values()];
        const dim = vecs[0]!.length;

        // Centroid = mean of vectors
        centroidArray = new Array(dim).fill(0);
        for (const v of vecs) {
          for (let i = 0; i < dim; i++) centroidArray[i]! += v[i]!;
        }
        for (let i = 0; i < dim; i++) centroidArray[i]! /= vecs.length;

        // Spread = mean distance from centroid
        if (vecs.length > 1) {
          let totalDist = 0;
          for (const v of vecs) {
            let dist = 0;
            for (let i = 0; i < dim; i++) dist += (v[i]! - centroidArray[i]!) ** 2;
            totalDist += Math.sqrt(dist);
          }
          spread = totalDist / vecs.length;
        }
      }
    }

    // Temporal span
    const timestamps = mentions
      .map(m => m.createdAt)
      .filter((t): t is Date => t != null)
      .sort((a, b) => a.getTime() - b.getTime());

    const firstMentioned = timestamps[0] ?? null;
    const lastMentioned = timestamps[timestamps.length - 1] ?? null;

    // Upsert entity_meta
    if (centroidArray) {
      const centroidStr = `[${centroidArray.join(',')}]`;
      await db.execute(sql`
        INSERT INTO entity_meta (entity_id, mention_count, source_memory_count, fact_count, centroid, spread, first_mentioned_at, last_mentioned_at, updated_at)
        VALUES (${entityId}, ${mentionCount}, ${sourceMemoryCount}, ${factCount}, ${sql.raw(`'${centroidStr}'::vector`)}, ${spread}, ${firstMentioned}, ${lastMentioned}, NOW())
        ON CONFLICT (entity_id) DO UPDATE SET
          mention_count = ${mentionCount},
          source_memory_count = ${sourceMemoryCount},
          fact_count = ${factCount},
          centroid = ${sql.raw(`'${centroidStr}'::vector`)},
          spread = ${spread},
          first_mentioned_at = ${firstMentioned},
          last_mentioned_at = ${lastMentioned},
          updated_at = NOW()
      `);
    } else {
      await db.execute(sql`
        INSERT INTO entity_meta (entity_id, mention_count, source_memory_count, fact_count, first_mentioned_at, last_mentioned_at, updated_at)
        VALUES (${entityId}, ${mentionCount}, ${sourceMemoryCount}, ${factCount}, ${firstMentioned}, ${lastMentioned}, NOW())
        ON CONFLICT (entity_id) DO UPDATE SET
          mention_count = ${mentionCount},
          source_memory_count = ${sourceMemoryCount},
          fact_count = ${factCount},
          first_mentioned_at = ${firstMentioned},
          last_mentioned_at = ${lastMentioned},
          updated_at = NOW()
      `);
    }
  }
}

/**
 * Detect merge candidates for a set of entity IDs (the three-signal /
 * within-component domain).
 *
 * Flow (bead nmemo-2yv.42):
 *   1. Read entity_meta for entities with mention_count >= MIN_MENTIONS and a
 *      centroid — the eligibility gate for this domain.
 *   2. Enumerate (target × other) pairs where target ∈ entityIds and both
 *      sides are eligible.
 *   3. Drop pairs whose existing merge_candidates row is already 'resolved'
 *      (set-based filter — no per-pair lookup).
 *   4. Score all remaining pairs in ONE set-based SQL roundtrip via
 *      scoreMergeCandidates (9 signals with NULL-aware weighted combine).
 *   5. Drop pairs below SCORE_THRESHOLD_STAGING, label the rest, and upsert
 *      via upsertScoredCandidates (the only writer of signal columns on
 *      merge_candidates per the bead).
 *
 * Roundtrips: 1 eligibility read + 1 resolved-filter + 1 score CTE +
 * 1 max-pagerank bootstrap (inside scoreMergeCandidates) + N upserts. The
 * pre-bead path was O(pairs × 5); the new path is O(pairs) only at the upsert
 * step.
 */
export async function detectMergeCandidates(entityIds: string[]): Promise<number> {
  if (entityIds.length === 0) return 0;

  // Eligibility gate — same as the pre-bead version (mention_count >= 2 and
  // a centroid). Pairs where either side fails this don't enter the scoring
  // pass; their signal would be NULL-dominated and below threshold anyway.
  const allMeta = await db.execute(sql`
    SELECT entity_id::text AS entity_id
    FROM entity_meta
    WHERE mention_count >= ${MIN_MENTIONS_FOR_ANALYSIS}
      AND centroid IS NOT NULL
  `) as unknown as Array<{ entity_id: string }>;

  if (allMeta.length < 2) return 0;

  const eligibleIds = new Set(allMeta.map((m) => m.entity_id));
  const targets = entityIds.filter((id) => eligibleIds.has(id));
  if (targets.length === 0) return 0;

  // Enumerate (target × other) pairs, canonical-ordered, dedup'd. The set
  // prevents same-pair duplication when two targets in entityIds happen to
  // also be in allMeta (the second-pass would emit the same canonical pair).
  const seen = new Set<string>();
  const pairs: PairInput[] = [];
  for (const t of targets) {
    for (const other of allMeta) {
      if (other.entity_id === t) continue;
      const [a, b] = t < other.entity_id ? [t, other.entity_id] : [other.entity_id, t];
      const key = `${a}|${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ entityAId: a, entityBId: b });
    }
  }
  if (pairs.length === 0) return 0;

  // Pre-filter resolved pairs so the scorer doesn't spend roundtrips on them
  // and the upsert path doesn't churn detection_count / last_detected_at on
  // already-decided rows.
  const eligible = await filterResolvedPairs(pairs, db);
  if (eligible.length === 0) return 0;

  // Bead nmemo-2yv.43 — read graph_stats once per batch and pass to the
  // scorer so weights adapt to the current graph distribution (centroid
  // saturation, single-cluster collapse). Null is fine: the scorer treats
  // null/undefined identically (no adaptation), so a freshly-migrated DB
  // with no graph_stats row falls back cleanly to static weights.
  const graphStats = await getGraphStats();

  // ONE set-based SQL pass for nine-signal scoring.
  const scored = await scoreMergeCandidates(eligible, { runner: db, graphStats });

  // Threshold filter — STAGING is the floor; CANDIDATE is the promotion line.
  const kept = scored.filter((s) => s.combinedScore >= SCORE_THRESHOLD_STAGING);
  if (kept.length === 0) return 0;

  return upsertScoredCandidates(kept, {
    runner: db,
    candidateSource: 'three_signal_scoring',
    statusFor: (s) => (s.combinedScore >= SCORE_THRESHOLD_CANDIDATE ? 'candidate' : 'staging'),
    // No caller-extras for the three-signal domain — the scorer's standard
    // {signals, combined_score} blob is the full record.
  });
}

/** Default page size when no explicit limit is passed (bead nmemo-2yv.45). */
export const DEFAULT_MERGE_CANDIDATES_LIMIT = 50;

/** Default status set when neither `statuses` nor `includeResolved` is passed. */
const DEFAULT_UNRESOLVED_STATUSES = ['staging', 'candidate', 'provisional'] as const;

/** All known statuses — sugar shorthand for `{ includeResolved: true }`. */
const ALL_STATUSES = [...DEFAULT_UNRESOLVED_STATUSES, 'resolved'] as const;

export interface GetMergeCandidatesOptions {
  /** Explicit status filter. Wins over `includeResolved`. */
  statuses?: string[];
  /** Sugar: when true and `statuses` is unset, fetch every status incl. resolved. */
  includeResolved?: boolean;
  /** Page size; defaults to DEFAULT_MERGE_CANDIDATES_LIMIT (50). */
  limit?: number;
  /** Page offset; defaults to 0. */
  offset?: number;
}

/**
 * Get merge candidates filtered by status, paginated, ordered by combined_score DESC.
 *
 * Default contract: returns at most {@link DEFAULT_MERGE_CANDIDATES_LIMIT} rows where
 * status != 'resolved' (i.e. staging | candidate | provisional). The default query
 * is index-friendly via `idx_merge_candidates_score` (partial WHERE status != 'resolved').
 *
 * Options:
 *   - `statuses`: explicit allow-list. Pass `['resolved']` to fetch resolved-only.
 *   - `includeResolved`: sugar for "all statuses". Ignored if `statuses` is set.
 *   - `limit` / `offset`: pagination. Stable ordering via secondary `mc.id` tiebreak.
 *
 * Replicating the legacy "get all" call:
 *   `getMergeCandidates({ includeResolved: true, limit: <large> })`.
 *
 * (bead nmemo-2yv.45 — was previously docstring-vs-SQL mismatched: no WHERE / no LIMIT.)
 */
export async function getMergeCandidates(options: GetMergeCandidatesOptions = {}): Promise<Array<{
  id: string;
  entityA: { id: string; name: string; type: string };
  entityB: { id: string; name: string; type: string };
  centroidSimilarity: number | null;
  memoryOverlap: number | null;
  structuralSimilarity: number | null;
  combinedScore: number;
  status: string;
  detectionCount: number;
  resolution: string | null;
  // mig 017 — distinguishes 'three_signal_scoring' from 'cross_cluster_generator'
  candidateSource: string;
}>> {
  const statuses: readonly string[] = options.statuses
    ?? (options.includeResolved ? ALL_STATUSES : DEFAULT_UNRESOLVED_STATUSES);
  const limit = options.limit ?? DEFAULT_MERGE_CANDIDATES_LIMIT;
  const offset = options.offset ?? 0;

  const rows = await db.execute(sql`
    SELECT
      mc.id, mc.entity_a_id, mc.entity_b_id,
      mc.centroid_similarity, mc.memory_overlap, mc.structural_similarity,
      mc.combined_score, mc.status, mc.detection_count, mc.resolution,
      mc.resolution_reasoning,
      mc.candidate_source,
      a.canonical_name as a_name, a.entity_type as a_type,
      b.canonical_name as b_name, b.entity_type as b_type
    FROM merge_candidates mc
    JOIN entities a ON mc.entity_a_id = a.id
    JOIN entities b ON mc.entity_b_id = b.id
    WHERE mc.status = ANY(ARRAY[${sql.join(statuses.map(s => sql`${s}`), sql`, `)}]::text[])
    ORDER BY mc.combined_score DESC, mc.id ASC
    LIMIT ${limit} OFFSET ${offset}
  `) as unknown as Array<Record<string, unknown>>;

  return rows.map(r => ({
    id: r.id as string,
    entityA: { id: r.entity_a_id as string, name: r.a_name as string, type: r.a_type as string },
    entityB: { id: r.entity_b_id as string, name: r.b_name as string, type: r.b_type as string },
    centroidSimilarity: r.centroid_similarity as number | null,
    memoryOverlap: r.memory_overlap as number | null,
    structuralSimilarity: r.structural_similarity as number | null,
    combinedScore: r.combined_score as number,
    status: r.status as string,
    detectionCount: r.detection_count as number,
    resolution: r.resolution as string | null,
    candidateSource: (r.candidate_source as string) ?? 'three_signal_scoring',
  }));
}
