/**
 * Graph Meta Service
 *
 * Computes per-entity statistics from source vectors and graph structure.
 * Detects merge candidates using three signals:
 *   1. Source vector centroid similarity
 *   2. Source memory overlap (Jaccard)
 *   3. Graph structural similarity (shared outgoing facts)
 */

import { db } from '../db/index.js';
import { facts, memoryEntities, mergeCandidates } from '../db/schema.js';
import { eq, and, sql, isNull } from 'drizzle-orm';
import { getMemoryVectors } from './qdrant.js';

// Weights for combined score (tune via benchmarking)
const W_CENTROID = 0.3;
const W_MEMORY_OVERLAP = 0.4;
const W_STRUCTURAL = 0.3;

// Minimum mentions before an entity is eligible for merge analysis
const MIN_MENTIONS_FOR_ANALYSIS = 2;

// Minimum combined score to create a merge candidate
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
 * Detect merge candidates for a set of entity IDs.
 * Compares each entity against all other entities with sufficient data.
 * Only creates candidates above the staging threshold.
 */
export async function detectMergeCandidates(entityIds: string[]): Promise<number> {
  if (entityIds.length === 0) return 0;

  // Get meta for all entities that have enough mentions
  const allMeta = await db.execute(sql`
    SELECT entity_id, mention_count, source_memory_count, fact_count, centroid
    FROM entity_meta
    WHERE mention_count >= ${MIN_MENTIONS_FOR_ANALYSIS}
      AND centroid IS NOT NULL
  `) as unknown as Array<{
    entity_id: string;
    mention_count: number;
    source_memory_count: number;
    fact_count: number;
  }>;

  if (allMeta.length < 2) return 0;

  // For each input entity, compare against all eligible entities
  const eligibleIds = new Set(allMeta.map(m => m.entity_id));
  const targetIds = entityIds.filter(id => eligibleIds.has(id));
  if (targetIds.length === 0) return 0;

  let candidatesCreated = 0;

  for (const entityId of targetIds) {
    // Get this entity's memory IDs for overlap computation
    const myMemories = await db
      .select({ memoryId: memoryEntities.memoryId })
      .from(memoryEntities)
      .where(eq(memoryEntities.entityId, entityId));
    const myMemorySet = new Set(myMemories.map(m => m.memoryId));

    // Get this entity's outgoing facts for structural comparison
    const myFacts = await db
      .select({ predicate: facts.predicate, objectEntityId: facts.objectEntityId })
      .from(facts)
      .where(and(eq(facts.subjectEntityId, entityId), isNull(facts.expiredAt)));
    const myFactSet = new Set(myFacts.map(f => `${f.predicate}|${f.objectEntityId ?? ''}`));

    // Compare against all other eligible entities
    for (const other of allMeta) {
      if (other.entity_id === entityId) continue;

      // Canonical ordering
      const [aId, bId] = entityId < other.entity_id
        ? [entityId, other.entity_id]
        : [other.entity_id, entityId];

      // Skip if already resolved
      const existing = await db
        .select({ status: mergeCandidates.status })
        .from(mergeCandidates)
        .where(and(
          eq(mergeCandidates.entityAId, aId),
          eq(mergeCandidates.entityBId, bId),
        ))
        .limit(1);

      if (existing[0]?.status === 'resolved') continue;

      // Signal 1: Centroid similarity (via pgvector)
      const centroidResult = await db.execute(sql`
        SELECT 1 - (a.centroid <=> b.centroid) as similarity
        FROM entity_meta a, entity_meta b
        WHERE a.entity_id = ${aId} AND b.entity_id = ${bId}
          AND a.centroid IS NOT NULL AND b.centroid IS NOT NULL
      `) as unknown as Array<{ similarity: number }>;
      const centroidSimilarity = centroidResult[0]?.similarity ?? 0;

      // Signal 2: Memory overlap (Jaccard)
      const otherMemories = await db
        .select({ memoryId: memoryEntities.memoryId })
        .from(memoryEntities)
        .where(eq(memoryEntities.entityId, other.entity_id));
      const otherMemorySet = new Set(otherMemories.map(m => m.memoryId));

      const sharedMemories = [...myMemorySet].filter(m => otherMemorySet.has(m)).length;
      const unionMemories = new Set([...myMemorySet, ...otherMemorySet]).size;
      const memoryOverlap = unionMemories > 0 ? sharedMemories / unionMemories : 0;

      // Signal 3: Structural similarity (shared outgoing facts)
      const otherFacts = await db
        .select({ predicate: facts.predicate, objectEntityId: facts.objectEntityId })
        .from(facts)
        .where(and(eq(facts.subjectEntityId, other.entity_id), isNull(facts.expiredAt)));
      const otherFactSet = new Set(otherFacts.map(f => `${f.predicate}|${f.objectEntityId ?? ''}`));

      const sharedFacts = [...myFactSet].filter(f => otherFactSet.has(f)).length;
      const unionFacts = new Set([...myFactSet, ...otherFactSet]).size;
      const structuralSimilarity = unionFacts > 0 ? sharedFacts / unionFacts : 0;

      // Combined score
      const combinedScore = W_CENTROID * centroidSimilarity
        + W_MEMORY_OVERLAP * memoryOverlap
        + W_STRUCTURAL * structuralSimilarity;

      if (combinedScore < SCORE_THRESHOLD_STAGING) continue;

      const status = combinedScore >= SCORE_THRESHOLD_CANDIDATE ? 'candidate' : 'staging';

      // Upsert merge candidate
      await db.execute(sql`
        INSERT INTO merge_candidates (entity_a_id, entity_b_id, centroid_similarity, memory_overlap, structural_similarity, combined_score, status, detection_count, last_detected_at)
        VALUES (${aId}, ${bId}, ${centroidSimilarity}, ${memoryOverlap}, ${structuralSimilarity}, ${combinedScore}, ${status}, 1, NOW())
        ON CONFLICT (entity_a_id, entity_b_id) DO UPDATE SET
          centroid_similarity = ${centroidSimilarity},
          memory_overlap = ${memoryOverlap},
          structural_similarity = ${structuralSimilarity},
          combined_score = ${combinedScore},
          status = CASE WHEN merge_candidates.status = 'resolved' THEN merge_candidates.status ELSE ${status} END,
          detection_count = merge_candidates.detection_count + 1,
          last_detected_at = NOW()
      `);

      candidatesCreated++;
    }
  }

  return candidatesCreated;
}

/**
 * Get all unresolved merge candidates, ordered by score.
 */
export async function getMergeCandidates(): Promise<Array<{
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
    ORDER BY mc.combined_score DESC
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
