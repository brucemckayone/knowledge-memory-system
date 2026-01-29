/**
 * Facts Service
 * 
 * Manages bi-temporal facts in the knowledge graph.
 * Based on Graphiti research with 4-timestamp model:
 * - valid_at / invalid_at: When the fact was true in reality
 * - created_at / expired_at: When we recorded/corrected it
 */

import { db } from '../db/index.js';
import { facts, factPredicates, entities, type Fact } from '../db/schema.js';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { config } from '../config.js';

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
export async function expireFact(factId: string, _reason?: string): Promise<void> {
  await db
    .update(facts)
    .set({ expiredAt: new Date() })
    .where(and(
      eq(facts.id, factId),
      isNull(facts.expiredAt)
    ));
}

/**
 * Invalidate a fact (mark as no longer true in reality)
 */
export async function invalidateFact(factId: string, invalidTime?: Date): Promise<void> {
  await db
    .update(facts)
    .set({ invalidAt: invalidTime || new Date() })
    .where(and(
      eq(facts.id, factId),
      isNull(facts.invalidAt)
    ));
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
    return db.execute(sql`
      SELECT * FROM facts
      WHERE expired_at IS NULL
        AND (invalid_at IS NULL OR invalid_at > NOW())
        AND (subject_entity_id = ${entityId} OR object_entity_id = ${entityId})
      ORDER BY created_at DESC
    `).then(r => (r as unknown as { rows: Fact[] }).rows);
  }
  
  if (asSubject) {
    return db
      .select()
      .from(facts)
      .where(and(
        eq(facts.subjectEntityId, entityId),
        isNull(facts.expiredAt)
      ));
  }
  
  if (asObject) {
    return db
      .select()
      .from(facts)
      .where(and(
        eq(facts.objectEntityId, entityId),
        isNull(facts.expiredAt)
      ));
  }
  
  return [];
}

/**
 * Query facts at a specific point in time (bi-temporal query)
 */
export async function getFactsAtTime(queryTime: Date): Promise<Fact[]> {
  const result = await db.execute(sql`
    SELECT * FROM facts_at_time(${queryTime}::timestamptz)
  `);
  return (result as unknown as { rows: Fact[] }).rows;
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

  const results = await db.execute(sql`
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

  return (results as unknown as { rows: Array<Fact & { similarity: number }> }).rows.map(row => ({
    fact: row,
    similarity: row.similarity,
  }));
}

/**
 * Get the timeline of facts for an entity
 */
export async function getEntityTimeline(entityId: string): Promise<Fact[]> {
  return db
    .select()
    .from(facts)
    .where(and(
      eq(facts.subjectEntityId, entityId),
      isNull(facts.expiredAt)
    ))
    .orderBy(facts.validAt);
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
    const response = await fetch(`${config.ML_SERVICES_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    
    if (!response.ok) {
      return [];
    }
    
    const data = await response.json() as { embedding?: number[]; vector?: number[] };
    return data.embedding || data.vector || [];
  } catch {
    return [];
  }
}
