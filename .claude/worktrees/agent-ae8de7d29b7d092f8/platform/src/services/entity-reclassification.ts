/**
 * Entity Reclassification Service
 *
 * When a new entity type is promoted, reclassifies existing entities
 * that may match the new type using vector centroid + LLM verification.
 *
 * Approach:
 *   1. Compute centroid embedding from exemplar entities that triggered promotion
 *   2. Vector scan the source type for candidates above the verification threshold
 *   3. High-similarity candidates are auto-reclassified; borderline ones need LLM verification
 *   4. Every change is audited in entity_type_history (migration 024)
 */

import { db } from '../db/index.js';
import { rawQuery } from '../db/raw.js';
import { entities, entityTypeHistory } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';

export interface ReclassificationCandidate {
  id: string;
  name: string;
  similarity: number;
}

export interface ReclassificationResult {
  entityId: string;
  previousType: string;
  newType: string;
  confidence: number;
  method: 'centroid' | 'llm_verified';
}

export interface CandidatePartition {
  autoReclassify: ReclassificationCandidate[];
  needsVerification: ReclassificationCandidate[];
}

interface FindCandidatesOptions {
  maxCandidates?: number;
  autoReclassifyThreshold?: number;
  llmVerifyThreshold?: number;
}

/**
 * Find entities that might belong to a newly promoted type.
 * Uses vector centroid of exemplar entities for candidate discovery.
 *
 * @param newType - The newly promoted entity type name
 * @param exemplarEntityIds - IDs of entities that triggered the promotion
 * @param sourceType - The broader type to search in (e.g., 'concept')
 * @param options - Thresholds and limits
 * @returns Candidates partitioned into auto-reclassify and needs-verification buckets
 */
export async function findReclassificationCandidates(
  newType: string,
  exemplarEntityIds: string[],
  sourceType: string,
  options: FindCandidatesOptions = {}
): Promise<CandidatePartition> {
  const {
    maxCandidates = 100,
    autoReclassifyThreshold = 0.90,
    llmVerifyThreshold = 0.75,
  } = options;

  const empty: CandidatePartition = { autoReclassify: [], needsVerification: [] };

  if (exemplarEntityIds.length === 0) {
    return empty;
  }

  // Compute centroid of exemplar embeddings.
  // pgvector AVG() returns a vector; we extract it as a float array for re-use.
  const centroidRows = await rawQuery<{ centroid: string }>(sql`
    SELECT AVG(embedding)::text AS centroid
    FROM entities
    WHERE id = ANY(${exemplarEntityIds}::uuid[])
      AND embedding IS NOT NULL
  `);

  const centroidText = centroidRows[0]?.centroid;
  if (!centroidText) {
    return empty;
  }

  // Parse the pgvector text representation "[0.1,0.2,...]" into a numeric array
  const centroid = parsePgVector(centroidText);
  if (centroid.length === 0) {
    return empty;
  }

  const centroidLiteral = `'[${centroid.join(',')}]'::vector`;

  // Find candidates in the source type by cosine similarity to centroid.
  // Excludes the exemplar entities themselves (they already have the right type).
  const candidates = await rawQuery<{
    id: string;
    canonicalName: string;
    similarity: number;
  }>(sql`
    SELECT
      id,
      canonical_name,
      1 - (embedding <=> ${sql.raw(centroidLiteral)}) AS similarity
    FROM entities
    WHERE entity_type = ${sourceType}
      AND entity_type != ${newType}
      AND embedding IS NOT NULL
      AND id != ALL(${exemplarEntityIds}::uuid[])
      AND 1 - (embedding <=> ${sql.raw(centroidLiteral)}) > ${llmVerifyThreshold}
    ORDER BY similarity DESC
    LIMIT ${maxCandidates}
  `);

  const autoReclassify: ReclassificationCandidate[] = [];
  const needsVerification: ReclassificationCandidate[] = [];

  for (const c of candidates) {
    const entry: ReclassificationCandidate = {
      id: c.id,
      name: c.canonicalName,
      similarity: c.similarity,
    };

    if (c.similarity >= autoReclassifyThreshold) {
      autoReclassify.push(entry);
    } else {
      needsVerification.push(entry);
    }
  }

  return { autoReclassify, needsVerification };
}

/**
 * Reclassify an entity to a new type and record the change in history.
 *
 * No-ops if the entity already has the target type or does not exist.
 */
export async function reclassifyEntity(
  entityId: string,
  newType: string,
  reason: string,
  changedBy = 'ontology-evolution'
): Promise<void> {
  const current = await db
    .select({ entityType: entities.entityType })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);

  if (!current[0]) return;

  const previousType = current[0].entityType;
  if (previousType === newType) return;

  await db
    .update(entities)
    .set({ entityType: newType, updatedAt: new Date() })
    .where(eq(entities.id, entityId));

  await db.insert(entityTypeHistory).values({
    entityId,
    previousType,
    newType,
    changedBy,
    reason,
  });
}

/**
 * Batch reclassify entities with high confidence (no LLM needed).
 *
 * @returns The number of entities actually reclassified
 */
export async function batchReclassify(
  entityIds: string[],
  newType: string,
  reason: string
): Promise<number> {
  let count = 0;
  for (const id of entityIds) {
    await reclassifyEntity(id, newType, reason);
    count++;
  }
  return count;
}

/**
 * Parse a pgvector text representation into a numeric array.
 * pgvector returns vectors as "[0.1,0.2,0.3]" when cast to text.
 */
function parsePgVector(vectorText: string): number[] {
  const trimmed = vectorText.replace(/^\[|\]$/g, '').trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(',').map(Number);
}
