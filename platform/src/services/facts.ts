/**
 * Facts Service
 * 
 * Manages bi-temporal facts in the knowledge graph.
 * Based on Graphiti research with 4-timestamp model:
 * - valid_at / invalid_at: When the fact was true in reality
 * - created_at / expired_at: When we recorded/corrected it
 */

import { db } from '../db/index.js';
import { rawQuery } from '../db/raw.js';
import { facts, factPredicates, entities, causalEvents, type Fact } from '../db/schema.js';
import { eq, and, or, gt, isNull, sql, desc } from 'drizzle-orm';
import { ml } from './ml-client.js';
import { recordPredicateUsage } from './predicates.js';

export interface CreateFactParams {
  subjectEntityId: string;
  predicate: string;
  objectEntityId?: string;
  objectValue?: string;
  validAt?: Date;
  invalidAt?: Date;
  sourceMemoryId?: string;
  sourceText?: string;
  extractionMethod?: string;
  confidence?: number;
}

export interface FactSearchResult {
  fact: Fact;
  similarity: number;
}

/**
 * Create a new fact with supersession detection
 */
export async function createFact(params: CreateFactParams): Promise<string> {
  const {
    subjectEntityId,
    predicate,
    objectEntityId,
    objectValue,
    validAt = new Date(),
    invalidAt,
    sourceMemoryId,
    sourceText,
    extractionMethod = 'llm',
    confidence = 1.0,
  } = params;

  // Check if this predicate is exclusive
  const predicateInfo = await getPredicateInfo(predicate);
  
  if (predicateInfo?.isExclusive) {
    // Find and supersede old facts for exclusive predicates
    const superseded = await findSupersedingFacts(
      subjectEntityId,
      predicate,
      validAt,
      invalidAt
    );

    // Expire old facts that this one supersedes
    for (const oldFact of superseded) {
      await expireFact(oldFact.id, 'Superseded by new information');
    }
  }

  // Dedup: check for existing active fact with matching triple
  const existingMatch = await db
    .select({ id: facts.id, confidence: facts.confidence })
    .from(facts)
    .where(and(
      eq(facts.subjectEntityId, subjectEntityId),
      eq(facts.predicate, predicate),
      objectEntityId
        ? eq(facts.objectEntityId, objectEntityId)
        : eq(facts.objectValue, objectValue ?? ''),
      isNull(facts.expiredAt),
    ))
    .limit(1);

  if (existingMatch[0]) {
    // Exact match exists — update confidence and source, don't create duplicate
    const existing = existingMatch[0];
    await db.update(facts).set({
      confidence: Math.max(existing.confidence ?? 0, confidence),
      sourceMemoryId: sourceMemoryId ?? undefined,
    }).where(eq(facts.id, existing.id));
    return existing.id;
  }

  // Generate embedding for fact text
  const factText = sourceText || `${predicate} ${objectValue || ''}`.trim();
  const embedding = await generateEmbedding(factText);

  // Insert new fact
  const result = await db
    .insert(facts)
    .values({
      subjectEntityId,
      predicate,
      objectEntityId,
      objectValue,
      validAt,
      invalidAt,
      sourceMemoryId,
      sourceText,
      extractionMethod,
      confidence,
    })
    .returning({ id: facts.id });

  const fact = result[0];
  if (!fact) {
    throw new Error('Failed to create fact');
  }

  // Store embedding if generated (skip if vector extension not available)
  if (embedding && embedding.length > 0) {
    try {
      await db.execute(sql`
        UPDATE facts
        SET fact_embedding = ${sql.raw(`'[${embedding.join(',')}]'::vector`)}
        WHERE id = ${fact.id}
      `);
    } catch (error) {
      // Vector extension may not be available - that's OK, continue without embedding
      if (!(error instanceof Error) || !error.message.includes('type "vector" does not exist')) {
        throw error;
      }
    }
  }

  // Track predicate usage for living ontology evolution
  await recordPredicateUsage(predicate).catch(() => {});

  // Create causal event for this fact creation
  await createCausalEvent({
    factId: fact.id,
    transitionType: 'created',
    subjectEntityId,
    predicate,
    deltaConfidence: confidence,
    sourceMemoryId,
    sourceText,
  });

  return fact.id;
}

/**
 * Get predicate info from ontology
 */
async function getPredicateInfo(predicate: string) {
  const result = await db
    .select()
    .from(factPredicates)
    .where(eq(factPredicates.predicate, predicate))
    .limit(1);
  
  return result[0] || null;
}

/**
 * Find facts that would be superseded by a new fact
 */
export async function findSupersedingFacts(
  subjectId: string,
  predicate: string,
  validAt: Date,
  invalidAt?: Date
): Promise<Fact[]> {
  // Find active facts with same subject + predicate
  const activeFacts = await db
    .select()
    .from(facts)
    .where(and(
      eq(facts.subjectEntityId, subjectId),
      eq(facts.predicate, predicate),
      isNull(facts.expiredAt)
    ));

  // Filter by temporal overlap
  return activeFacts.filter(fact => {
    // If no times specified, assume overlap
    if (!fact.validAt) return true;
    
    const factEnd = fact.invalidAt || new Date('9999-12-31');
    const newEnd = invalidAt || new Date('9999-12-31');
    
    // Check if ranges overlap
    return fact.validAt < newEnd && factEnd > validAt;
  });
}

/**
 * Expire a fact (mark as incorrect in our records)
 */
export async function expireFact(factId: string, reason?: string): Promise<void> {
  // Fetch fact metadata before expiring (for causal event context)
  const existing = await db
    .select({
      subjectEntityId: facts.subjectEntityId,
      predicate: facts.predicate,
      confidence: facts.confidence,
      sourceMemoryId: facts.sourceMemoryId,
      sourceText: facts.sourceText,
    })
    .from(facts)
    .where(and(eq(facts.id, factId), isNull(facts.expiredAt)))
    .limit(1);

  await db
    .update(facts)
    .set({
      expiredAt: new Date(),
      expireReason: reason ?? 'Superseded by new information',
    })
    .where(and(
      eq(facts.id, factId),
      isNull(facts.expiredAt)
    ));

  if (existing[0]) {
    await createCausalEvent({
      factId,
      transitionType: 'expired',
      subjectEntityId: existing[0].subjectEntityId,
      predicate: existing[0].predicate,
      deltaConfidence: existing[0].confidence ? -existing[0].confidence : undefined,
      sourceMemoryId: existing[0].sourceMemoryId ?? undefined,
      sourceText: existing[0].sourceText ?? undefined,
    });
  }
}

/**
 * Invalidate a fact (mark as no longer true in reality)
 */
export async function invalidateFact(factId: string, invalidTime?: Date): Promise<void> {
  // Fetch fact metadata before invalidating (for causal event context)
  const existing = await db
    .select({
      subjectEntityId: facts.subjectEntityId,
      predicate: facts.predicate,
      confidence: facts.confidence,
      sourceMemoryId: facts.sourceMemoryId,
      sourceText: facts.sourceText,
    })
    .from(facts)
    .where(and(eq(facts.id, factId), isNull(facts.invalidAt)))
    .limit(1);

  await db
    .update(facts)
    .set({ invalidAt: invalidTime || new Date() })
    .where(and(
      eq(facts.id, factId),
      isNull(facts.invalidAt)
    ));

  if (existing[0]) {
    await createCausalEvent({
      factId,
      transitionType: 'invalidated',
      subjectEntityId: existing[0].subjectEntityId,
      predicate: existing[0].predicate,
      deltaConfidence: existing[0].confidence ? -existing[0].confidence : undefined,
      sourceMemoryId: existing[0].sourceMemoryId ?? undefined,
      sourceText: existing[0].sourceText ?? undefined,
    });
  }
}

/**
 * Get all active facts about an entity
 */
export async function getEntityFacts(
  entityId: string,
  options: { asSubject?: boolean; asObject?: boolean } = {}
): Promise<Fact[]> {
  const { asSubject = true, asObject = true } = options;

  if (asSubject && asObject) {
    return db
      .select()
      .from(facts)
      .where(and(
        or(
          eq(facts.subjectEntityId, entityId),
          eq(facts.objectEntityId, entityId)
        ),
        isNull(facts.expiredAt),
        or(isNull(facts.invalidAt), gt(facts.invalidAt, sql`NOW()`))
      ))
      .orderBy(desc(facts.createdAt));
  }
  
  if (asSubject) {
    return db
      .select()
      .from(facts)
      .where(and(
        eq(facts.subjectEntityId, entityId),
        isNull(facts.expiredAt),
        or(isNull(facts.invalidAt), gt(facts.invalidAt, sql`NOW()`))
      ));
  }

  if (asObject) {
    return db
      .select()
      .from(facts)
      .where(and(
        eq(facts.objectEntityId, entityId),
        isNull(facts.expiredAt),
        or(isNull(facts.invalidAt), gt(facts.invalidAt, sql`NOW()`))
      ));
  }
  
  return [];
}

/**
 * Search facts by semantic similarity
 */
export async function searchFacts(
  query: string,
  options: { limit?: number; threshold?: number } = {}
): Promise<FactSearchResult[]> {
  const { limit = 10, threshold = 0.5 } = options;

  const embedding = await generateEmbedding(query);
  if (!embedding || embedding.length === 0) {
    return [];
  }

  const rows = await rawQuery<Fact & { similarity: number }>(sql`
    SELECT
      f.*,
      1 - (fact_embedding <=> ${sql.raw(`'[${embedding.join(',')}]'::vector`)}) as similarity
    FROM facts f
    WHERE fact_embedding IS NOT NULL
      AND expired_at IS NULL
      AND 1 - (fact_embedding <=> ${sql.raw(`'[${embedding.join(',')}]'::vector`)}) > ${threshold}
    ORDER BY fact_embedding <=> ${sql.raw(`'[${embedding.join(',')}]'::vector`)}
    LIMIT ${limit}
  `);

  return rows.map(row => ({
    fact: row,
    similarity: row.similarity,
  }));
}

/**
 * Get fact by ID with entity names
 */
export async function getFactById(factId: string): Promise<(Fact & { 
  subjectName?: string; 
  objectName?: string;
}) | null> {
  const result = await db
    .select()
    .from(facts)
    .where(eq(facts.id, factId))
    .limit(1);
  
  if (!result[0]) return null;
  
  const fact = result[0];
  
  // Get entity names
  const subjectResult = await db
    .select({ name: entities.canonicalName })
    .from(entities)
    .where(eq(entities.id, fact.subjectEntityId))
    .limit(1);
  
  let objectName: string | undefined;
  if (fact.objectEntityId) {
    const objectResult = await db
      .select({ name: entities.canonicalName })
      .from(entities)
      .where(eq(entities.id, fact.objectEntityId))
      .limit(1);
    objectName = objectResult[0]?.name;
  }
  
  return {
    ...fact,
    subjectName: subjectResult[0]?.name,
    objectName,
  };
}

/**
 * Generate embedding via ML service
 */
async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const data = await ml.embed(text);
    return data.vector || [];
  } catch {
    return [];
  }
}

/**
 * Create a causal event recording a Graph S state transition.
 * Called explicitly from fact operations (not via triggers) so full context is available.
 */
async function createCausalEvent(params: {
  factId: string;
  transitionType: 'created' | 'strengthened' | 'weakened' | 'expired' | 'invalidated';
  subjectEntityId: string;
  predicate: string;
  deltaConfidence?: number;
  sourceMemoryId?: string;
  sourceText?: string;
}): Promise<string> {
  try {
    const result = await db
      .insert(causalEvents)
      .values({
        factId: params.factId,
        transitionType: params.transitionType,
        subjectEntityId: params.subjectEntityId,
        predicate: params.predicate,
        deltaConfidence: params.deltaConfidence ?? null,
        sourceMemoryId: params.sourceMemoryId ?? null,
        sourceText: params.sourceText ?? null,
      })
      .returning({ id: causalEvents.id });

    return result[0]!.id;
  } catch (error) {
    // Causal event creation is non-blocking — log and continue
    console.warn('Failed to create causal event:', error instanceof Error ? error.message : error);
    return '';
  }
}
