/**
 * Facts Service
 *
 * Manages bi-temporal facts in the knowledge graph.
 * Based on Graphiti research with 4-timestamp model:
 * - valid_at / invalid_at: When the fact was true in reality
 * - created_at / expired_at: When we recorded/corrected it
 *
 * Phase 1 (doc 12): every mutation requires `actor` and writes exactly one
 * fact_history row in the same transaction as the mutation.
 */

import { db } from '../db/index.js';
import { rawQuery } from '../db/raw.js';
import { facts, factPredicates, entities, causalEvents, type Fact } from '../db/schema.js';
import { eq, and, or, gt, isNull, sql, desc } from 'drizzle-orm';
import { ml } from './ml-client.js';
import { recordPredicateUsage } from './predicates.js';
import { recordFactChange, type Actor } from './audit.js';

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

  // Phase 1 audit context — REQUIRED.
  actor: Actor;
  /** Optional: link this mutation to a reasoning_reports row. */
  reasoningReportId?: string | null;
  /** Optional: narrative justification (defaults to a CRUD-style message for `created`). */
  reasoning?: string;
}

export interface FactSearchResult {
  fact: Fact;
  similarity: number;
}

/**
 * Create a new fact with supersession detection.
 *
 * Writes a fact_history row with event_type='created' in the same transaction
 * as the INSERT. If supersession fires, each superseded fact gets its own
 * fact_history row with event_type='expired' attributed to actor='cascade'.
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
    actor,
    reasoningReportId = null,
    reasoning,
  } = params;

  // Check if this predicate is exclusive
  const predicateInfo = await getPredicateInfo(predicate);

  if (predicateInfo?.isExclusive) {
    const superseded = await findSupersedingFacts(
      subjectEntityId,
      predicate,
      validAt,
      invalidAt,
    );

    // Expire old facts that this one supersedes. The supersession is a side
    // effect of the new write, so attribute it to 'cascade' with a reasoning
    // string pointing at the parent mutation.
    for (const oldFact of superseded) {
      await expireFact({
        factId: oldFact.id,
        reasoning: `Cascade: superseded by new fact for (${subjectEntityId}, ${predicate})`,
        actor: 'cascade',
        reasoningReportId,
      });
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
    // Exact match exists — update confidence and source, don't create duplicate.
    // The confidence bump is itself a mutation; record it if confidence actually changed.
    const existing = existingMatch[0];
    const prevConfidence = existing.confidence ?? 0;
    const nextConfidence = Math.max(prevConfidence, confidence);

    await db.update(facts).set({
      confidence: nextConfidence,
      sourceMemoryId: sourceMemoryId ?? undefined,
    }).where(eq(facts.id, existing.id));

    if (nextConfidence > prevConfidence) {
      await recordFactChange({
        factId: existing.id,
        eventType: 'confidence_raised',
        previousConfidence: prevConfidence,
        newConfidence: nextConfidence,
        reasoning: reasoning ?? 'Corroborating observation raised confidence on existing fact',
        actor,
        reasoningReportId,
      });
    }
    return existing.id;
  }

  // Generate embedding for fact text
  const factText = sourceText || `${predicate} ${objectValue || ''}`.trim();
  const embedding = await generateEmbedding(factText);

  // Insert the new fact + audit row atomically. The causal_event insert and
  // embedding update sit outside the transaction to keep the hot path short;
  // they're non-blocking best-effort on failure.
  const factId = await db.transaction(async (tx) => {
    const [row] = await tx
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

    if (!row) throw new Error('Failed to create fact');

    await recordFactChange({
      factId: row.id,
      eventType: 'created',
      newConfidence: confidence,
      newValidAt: validAt,
      newInvalidAt: invalidAt ?? null,
      reasoning: reasoning ?? `Fact created by ${actor}`,
      sourceReferences: sourceMemoryId
        ? [{ type: 'memory', id: sourceMemoryId, relevance: sourceText ?? '' }]
        : [],
      actor,
      reasoningReportId,
      tx,
    });

    return row.id;
  });

  // Store embedding if generated (skip if vector extension not available)
  if (embedding && embedding.length > 0) {
    try {
      await db.execute(sql`
        UPDATE facts
        SET fact_embedding = ${sql.raw(`'[${embedding.join(',')}]'::vector`)}
        WHERE id = ${factId}
      `);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('type "vector" does not exist')) {
        throw error;
      }
    }
  }

  // Track predicate usage for living ontology evolution
  await recordPredicateUsage(predicate).catch(() => {});

  // Create causal event for this fact creation
  const causalEventId = await createCausalEvent({
    factId,
    transitionType: 'created',
    subjectEntityId,
    predicate,
    deltaConfidence: confidence,
    sourceMemoryId,
    sourceText,
  });

  // Best-effort: link the audit row back to the causal_event we just emitted
  // so reasoning-layer readers can hop from history → event without a join.
  if (causalEventId) {
    try {
      await db.execute(sql`
        UPDATE fact_history
        SET causal_event_id = ${causalEventId}::uuid
        WHERE fact_id = ${factId}::uuid
          AND event_type = 'created'
          AND causal_event_id IS NULL
      `);
    } catch {
      // Non-fatal — audit row still exists with full reasoning, just no event link.
    }
  }

  return factId;
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
  invalidAt?: Date,
): Promise<Fact[]> {
  const activeFacts = await db
    .select()
    .from(facts)
    .where(and(
      eq(facts.subjectEntityId, subjectId),
      eq(facts.predicate, predicate),
      isNull(facts.expiredAt),
    ));

  return activeFacts.filter(fact => {
    if (!fact.validAt) return true;

    const factEnd = fact.invalidAt || new Date('9999-12-31');
    const newEnd = invalidAt || new Date('9999-12-31');

    return fact.validAt < newEnd && factEnd > validAt;
  });
}

export interface ExpireFactParams {
  factId: string;
  reasoning: string;
  actor: Actor;
  reasoningReportId?: string | null;
  /** Optional free-text reason persisted on facts.expire_reason (defaults to `reasoning`). */
  expireReason?: string;
}

/**
 * Expire a fact (mark as incorrect in our records).
 *
 * Writes a fact_history row with event_type='expired' in the same transaction
 * as the UPDATE. Also emits a causal_event of transition_type='expired'.
 */
export async function expireFact(params: ExpireFactParams): Promise<void> {
  const { factId, reasoning, actor, reasoningReportId = null, expireReason } = params;

  // Fetch fact metadata BEFORE expiring — we need the pre-mutation state for
  // the history row and for the causal event context.
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

  if (!existing[0]) {
    // Already expired or does not exist — silently no-op, matching prior behaviour.
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(facts)
      .set({
        expiredAt: new Date(),
        expireReason: expireReason ?? reasoning,
      })
      .where(and(eq(facts.id, factId), isNull(facts.expiredAt)));

    await recordFactChange({
      factId,
      eventType: 'expired',
      previousConfidence: existing[0]!.confidence ?? null,
      newConfidence: existing[0]!.confidence ?? null,
      reasoning,
      actor,
      reasoningReportId,
      tx,
    });
  });

  await createCausalEvent({
    factId,
    transitionType: 'expired',
    subjectEntityId: existing[0]!.subjectEntityId,
    predicate: existing[0]!.predicate,
    deltaConfidence: existing[0]!.confidence ? -existing[0]!.confidence : undefined,
    sourceMemoryId: existing[0]!.sourceMemoryId ?? undefined,
    sourceText: existing[0]!.sourceText ?? undefined,
  });
}

export interface InvalidateFactParams {
  factId: string;
  reasoning: string;
  actor: Actor;
  /** When the fact stopped being true in reality (defaults to now). */
  invalidAt?: Date;
  reasoningReportId?: string | null;
}

/**
 * Invalidate a fact (mark as no longer true in reality, though it was once true).
 *
 * Writes a fact_history row with event_type='invalidated' in the same
 * transaction as the UPDATE.
 */
export async function invalidateFact(params: InvalidateFactParams): Promise<void> {
  const { factId, reasoning, actor, invalidAt, reasoningReportId = null } = params;
  const effectiveInvalidAt = invalidAt ?? new Date();

  const existing = await db
    .select({
      subjectEntityId: facts.subjectEntityId,
      predicate: facts.predicate,
      confidence: facts.confidence,
      sourceMemoryId: facts.sourceMemoryId,
      sourceText: facts.sourceText,
      invalidAt: facts.invalidAt,
    })
    .from(facts)
    .where(and(eq(facts.id, factId), isNull(facts.invalidAt)))
    .limit(1);

  if (!existing[0]) {
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(facts)
      .set({ invalidAt: effectiveInvalidAt })
      .where(and(eq(facts.id, factId), isNull(facts.invalidAt)));

    await recordFactChange({
      factId,
      eventType: 'invalidated',
      previousInvalidAt: existing[0]!.invalidAt ?? null,
      newInvalidAt: effectiveInvalidAt,
      reasoning,
      actor,
      reasoningReportId,
      tx,
    });
  });

  await createCausalEvent({
    factId,
    transitionType: 'invalidated',
    subjectEntityId: existing[0]!.subjectEntityId,
    predicate: existing[0]!.predicate,
    deltaConfidence: existing[0]!.confidence ? -existing[0]!.confidence : undefined,
    sourceMemoryId: existing[0]!.sourceMemoryId ?? undefined,
    sourceText: existing[0]!.sourceText ?? undefined,
  });
}

export interface UpdateFactConfidenceParams {
  factId: string;
  newConfidence: number;
  reasoning: string;
  actor: Actor;
  reasoningReportId?: string | null;
}

/**
 * Update a fact's confidence and emit a fact_history row with
 * event_type='confidence_raised' or 'confidence_lowered' based on direction.
 * No-op if the new value equals the current one.
 */
export async function updateFactConfidence(params: UpdateFactConfidenceParams): Promise<void> {
  const { factId, newConfidence, reasoning, actor, reasoningReportId = null } = params;

  if (newConfidence < 0 || newConfidence > 1) {
    throw new Error('newConfidence must be between 0 and 1');
  }

  const existing = await db
    .select({ confidence: facts.confidence })
    .from(facts)
    .where(eq(facts.id, factId))
    .limit(1);

  if (!existing[0]) {
    throw new Error(`updateFactConfidence: fact ${factId} not found`);
  }

  const prev = existing[0].confidence ?? 0;
  if (prev === newConfidence) return;

  const eventType = newConfidence > prev ? 'confidence_raised' : 'confidence_lowered';

  await db.transaction(async (tx) => {
    await tx.update(facts).set({ confidence: newConfidence }).where(eq(facts.id, factId));
    await recordFactChange({
      factId,
      eventType,
      previousConfidence: prev,
      newConfidence,
      reasoning,
      actor,
      reasoningReportId,
      tx,
    });
  });
}

export interface RestoreFactParams {
  factId: string;
  reasoning: string;
  actor: Actor;
  reasoningReportId?: string | null;
}

/**
 * Restore a previously expired or invalidated fact. Clears both expired_at
 * and invalid_at and writes a fact_history row with event_type='restored'.
 */
export async function restoreFact(params: RestoreFactParams): Promise<void> {
  const { factId, reasoning, actor, reasoningReportId = null } = params;

  const existing = await db
    .select({
      confidence: facts.confidence,
      invalidAt: facts.invalidAt,
      expiredAt: facts.expiredAt,
    })
    .from(facts)
    .where(eq(facts.id, factId))
    .limit(1);

  if (!existing[0]) {
    throw new Error(`restoreFact: fact ${factId} not found`);
  }
  if (!existing[0].expiredAt && !existing[0].invalidAt) {
    // Nothing to restore — no-op with no audit row.
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(facts)
      .set({ expiredAt: null, expireReason: null, invalidAt: null })
      .where(eq(facts.id, factId));

    await recordFactChange({
      factId,
      eventType: 'restored',
      previousConfidence: existing[0]!.confidence ?? null,
      newConfidence: existing[0]!.confidence ?? null,
      previousInvalidAt: existing[0]!.invalidAt ?? null,
      newInvalidAt: null,
      reasoning,
      actor,
      reasoningReportId,
      tx,
    });
  });
}

/**
 * Get all active facts about an entity
 */
export async function getEntityFacts(
  entityId: string,
  options: { asSubject?: boolean; asObject?: boolean } = {},
): Promise<Fact[]> {
  const { asSubject = true, asObject = true } = options;

  if (asSubject && asObject) {
    return db
      .select()
      .from(facts)
      .where(and(
        or(
          eq(facts.subjectEntityId, entityId),
          eq(facts.objectEntityId, entityId),
        ),
        isNull(facts.expiredAt),
        or(isNull(facts.invalidAt), gt(facts.invalidAt, sql`NOW()`)),
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
        or(isNull(facts.invalidAt), gt(facts.invalidAt, sql`NOW()`)),
      ));
  }

  if (asObject) {
    return db
      .select()
      .from(facts)
      .where(and(
        eq(facts.objectEntityId, entityId),
        isNull(facts.expiredAt),
        or(isNull(facts.invalidAt), gt(facts.invalidAt, sql`NOW()`)),
      ));
  }

  return [];
}

/**
 * Search facts by semantic similarity
 */
export async function searchFacts(
  query: string,
  options: { limit?: number; threshold?: number } = {},
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
    console.warn('Failed to create causal event:', error instanceof Error ? error.message : error);
    return '';
  }
}
