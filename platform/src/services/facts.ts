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

import { db, type Tx } from '../db/index.js';
import { rawQuery } from '../db/raw.js';
import { facts, factPredicates, entities, causalEvents, factSources, type Fact, type FactSource } from '../db/schema.js';
import { eq, and, or, gt, isNull, sql, desc } from 'drizzle-orm';
import { ml } from './ml-client.js';
import { recordPredicateUsage } from './predicates.js';
import { recordFactChange, type Actor } from './audit.js';
import { cascadeFactExpiry } from './causal.js';
import type { SeveritySummary } from './impact.js';

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
 * Result of a recordFactSource() upsert. `added=true` means the row was
 * newly inserted (this memory had not been associated with this fact
 * before); `refreshed=true` means the row already existed and only the
 * observation_count + observed_at were bumped. Mutually exclusive when
 * a memoryId was supplied; both false on the memoryId=null no-op path.
 */
export interface RecordFactSourceResult {
  added: boolean;
  refreshed: boolean;
}

/**
 * Upsert a (fact, memory) pair into fact_sources. Returns whether the
 * pair was newly added (true) or already existed (in which case the row's
 * observation_count was incremented and observed_at refreshed to now).
 *
 * Always operates inside the supplied tx so corroboration audit emission
 * stays atomic with the source-side write (bead nmemo-2yv.32). No-op when
 * memoryId is null — facts without a source memory have no per-source row
 * to write.
 *
 * The RETURNING xmax = 0 trick distinguishes "fresh INSERT" from "DO
 * UPDATE on existing row" — xmax is 0 for a brand-new tuple and non-zero
 * when an existing row was updated. This is the canonical postgres
 * idiom for upsert detection in a single round trip.
 */
export async function recordFactSource(
  tx: Tx,
  factId: string,
  memoryId: string | null | undefined,
  sourceText: string | null | undefined,
  observedConfidence: number | null | undefined,
): Promise<RecordFactSourceResult> {
  if (!memoryId) return { added: false, refreshed: false };

  const result = await tx.execute(sql`
    INSERT INTO public.fact_sources (
      fact_id, memory_id, source_text, observed_confidence, observed_at, observation_count
    ) VALUES (
      ${factId}::uuid, ${memoryId}::uuid, ${sourceText ?? null},
      ${observedConfidence ?? null}, NOW(), 1
    )
    ON CONFLICT (fact_id, memory_id) DO UPDATE
      SET observation_count = public.fact_sources.observation_count + 1,
          observed_at       = NOW(),
          observed_confidence = COALESCE(EXCLUDED.observed_confidence,
                                         public.fact_sources.observed_confidence),
          source_text       = COALESCE(EXCLUDED.source_text,
                                        public.fact_sources.source_text)
    RETURNING (xmax = 0) AS inserted
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<{ inserted: boolean }>;
  const inserted = rows[0]?.inserted === true;
  return { added: inserted, refreshed: !inserted };
}

/**
 * Return all supporting memories for a fact, ordered most-recent first.
 * The fact_sources table replaces the singleton facts.source_memory_id
 * (which is preserved during the migration window per bead nmemo-2yv.32
 * step 5(a)).
 */
export async function getFactSources(factId: string): Promise<FactSource[]> {
  return db
    .select()
    .from(factSources)
    .where(eq(factSources.factId, factId))
    .orderBy(desc(factSources.observedAt));
}

/**
 * Create a new fact with supersession detection.
 *
 * Writes a fact_history row with event_type='created' in the same transaction
 * as the INSERT. If supersession fires, each superseded fact gets its own
 * fact_history row with event_type='superseded' attributed to actor='cascade'
 * (bead nmemo-2yv.31 — kept distinct from 'expired' so audit consumers can
 * tell "replaced by a newer specific assertion" apart from "genuine expiry").
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
    // string pointing at the parent mutation. Tag the fact_history row as
    // event_type='superseded' (bead nmemo-2yv.31) so downstream consumers can
    // tell "replaced by a newer specific assertion" apart from "genuine
    // expiry" — both flowed through expireFact previously and collapsed onto
    // the same 'expired' label.
    for (const oldFact of superseded) {
      await expireFact({
        factId: oldFact.id,
        reasoning: `Cascade: superseded by new fact for (${subjectEntityId}, ${predicate})`,
        actor: 'cascade',
        eventType: 'superseded',
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
    // Exact match exists — corroborating observation. Don't overwrite the
    // singleton sourceMemoryId (bead nmemo-2yv.32): instead append to the
    // fact_sources one-to-many table, then emit an audit row when either
    // (a) a brand-new source memory was added, OR (b) confidence rose.
    //
    // Audit semantics:
    //   - confidence rose only           → 'confidence_raised'
    //   - new source added, no Δconf     → 'revised' (evidence widened)
    //   - both                           → 'confidence_raised' (the higher
    //                                       signal — the new source is
    //                                       captured in source_references)
    //   - same source, same confidence   → fact_sources observation_count
    //                                       bumps; no fact_history row
    //                                       (no semantic change)
    //
    // Bead nmemo-2yv.29 atomicity property is preserved: a failed audit
    // insert (e.g. CHECK violation on actor) rolls back the entire branch
    // — both the confidence UPDATE and the fact_sources upsert.
    const existing = existingMatch[0];
    const prevConfidence = existing.confidence ?? 0;
    const nextConfidence = Math.max(prevConfidence, confidence);

    await db.transaction(async (tx) => {
      const { added: sourceAdded } = await recordFactSource(
        tx,
        existing.id,
        sourceMemoryId,
        sourceText,
        confidence,
      );

      const confidenceChanged = nextConfidence > prevConfidence;
      if (confidenceChanged) {
        await tx
          .update(facts)
          .set({ confidence: nextConfidence })
          .where(eq(facts.id, existing.id));
      }

      if (sourceAdded || confidenceChanged) {
        const eventType = confidenceChanged ? 'confidence_raised' : 'revised';
        const defaultReasoning = confidenceChanged
          ? 'Corroborating observation raised confidence on existing fact'
          : 'New source memory added as evidence for existing fact';
        await recordFactChange({
          factId: existing.id,
          eventType,
          previousConfidence: prevConfidence,
          newConfidence: nextConfidence,
          reasoning: reasoning ?? defaultReasoning,
          sourceReferences: sourceMemoryId
            ? [{ type: 'memory', id: sourceMemoryId, relevance: sourceText ?? '' }]
            : [],
          actor,
          reasoningReportId,
          tx,
        });
      }
    });
    return existing.id;
  }

  // Generate embedding for fact text
  const factText = sourceText || `${predicate} ${objectValue || ''}`.trim();
  const embedding = await generateEmbedding(factText);

  // Insert the new fact + audit row atomically. The causal_event insert and
  // embedding update sit outside the transaction to keep the hot path short;
  // they're non-blocking best-effort on failure.
  //
  // Bead nmemo-2yv.32 — also write the initial fact_sources row inside the
  // same tx so the supporting-memory record exists from t=0. The created
  // fact_history row's source_references array already captures the first
  // source memory; the fact_sources row exists to support subsequent
  // corroborations (where source_memory_id would have been overwritten
  // under the old singleton schema).
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

    await recordFactSource(tx, row.id, sourceMemoryId, sourceText, confidence);

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

  // Bead nmemo-2yv.84 — post-ingest counter trigger. The 024 migration's
  // AFTER INSERT trigger has already bumped facts_since_compute inside this
  // transaction; here we read-and-fire if the threshold is crossed. Lazy
  // import + outer try/catch so a missing/broken helper can't perturb the
  // caller, and so the fact-insert success path stays the contract here.
  void (async () => {
    try {
      const { maybeFireFactThresholdCompute } = await import('./derived-freshness.js');
      await maybeFireFactThresholdCompute();
    } catch (err) {
      console.warn('[createFact] post-ingest counter trigger failed:', err instanceof Error ? err.message : err);
    }
  })();

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
  /**
   * Optional outer transaction. When supplied, the UPDATE + fact_history
   * write run on this tx; when omitted, expireFact opens its own
   * transaction (existing behaviour). createCausalEvent and
   * cascadeFactExpiry remain best-effort post-mutation work outside the
   * supplied tx — see bead nmemo-2yv.38 for the rationale.
   */
  tx?: Tx;
  /**
   * Pre-mutation blast-radius severitySummary captured at the policy
   * boundary (handleToolCall for agent-initiated expiry, resolveContradiction
   * for mutating resolutions). Persisted onto the fact_history row. NULL for
   * cascade-internal callers (e.g. createFact superseder path). See bead
   * nmemo-2yv.102.
   */
  preExpireBlastRadius?: SeveritySummary | null;
  /**
   * Distinguishes "genuine expiry" (fact no longer true in the world; the
   * default) from "supersession" (replaced by a newer, more specific
   * assertion on an exclusive predicate; emitted by createFact's cascade
   * loop). Both write a fact_history row, but the event_type label drives
   * how downstream consumers — contradiction triage, blast-radius, pattern
   * lifecycle — interpret why the fact ended. See bead nmemo-2yv.31.
   */
  eventType?: 'expired' | 'superseded';
}

/**
 * Expire a fact (mark as incorrect in our records).
 *
 * Writes a fact_history row in the same transaction as the UPDATE. The event
 * type defaults to 'expired' (genuine expiry) but callers can pass
 * `eventType: 'superseded'` for the createFact cascade path (bead
 * nmemo-2yv.31). Also emits a causal_event of transition_type='expired'.
 *
 * NOTE — outer-tx callers (nmemo-2yv.38): when `params.tx` is supplied, the
 * UPDATE + fact_history write run on that tx, but `createCausalEvent` and
 * `cascadeFactExpiry` still run on the module-level `db` pool (independent
 * connection). If the outer tx rolls back after expireFact returns, the
 * causal_event row and cascade-expired edges remain — they did not
 * participate in the rollback. Plumbing tx into those two delegations is
 * tracked as the "broader improvement" follow-up to nmemo-2yv.38.
 */
export async function expireFact(params: ExpireFactParams): Promise<void> {
  const {
    factId,
    reasoning,
    actor,
    reasoningReportId = null,
    expireReason,
    tx: outerTx,
    preExpireBlastRadius = null,
    eventType = 'expired',
  } = params;
  const reader = outerTx ?? db;

  // Fetch fact metadata BEFORE expiring — we need the pre-mutation state for
  // the history row and for the causal event context. When an outer tx is
  // supplied, the read sees that tx's snapshot so the no-op check is
  // consistent with the UPDATE that follows.
  const existing = await reader
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

  // Doc 23.3 §3.4 — structural-impact warning: if this fact is currently a
  // bridge (its removal would split a component), surface that. Non-blocking;
  // proceed regardless. Best-effort: a missing topology_bridges row simply
  // means topology hasn't been computed yet, which is not an error here.
  try {
    const bridgeRows = (await reader.execute(sql`
      SELECT source_entity_id::text AS source_entity_id,
             target_entity_id::text AS target_entity_id
      FROM public.topology_bridges
      WHERE fact_id = ${factId}::uuid
      LIMIT 1
    `)) as unknown as Array<{ source_entity_id: string; target_entity_id: string }>;
    if (bridgeRows.length > 0) {
      const b = bridgeRows[0]!;
      console.warn(
        `[topology] expireFact: factId=${factId} is a current BRIDGE between ` +
          `entities ${b.source_entity_id} and ${b.target_entity_id}; ` +
          `expiry will fragment this component. Reason: ${reasoning}`,
      );
    }
  } catch (err) {
    // Topology schema may be absent in some test contexts — never block.
    if (process.env.NODE_ENV !== 'test') {
      console.warn(
        '[topology] expireFact: bridge check failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }
  }

  const runUpdate = async (tx: Tx): Promise<void> => {
    await tx
      .update(facts)
      .set({
        expiredAt: new Date(),
        expireReason: expireReason ?? reasoning,
      })
      .where(and(eq(facts.id, factId), isNull(facts.expiredAt)));

    await recordFactChange({
      factId,
      eventType,
      previousConfidence: existing[0]!.confidence ?? null,
      newConfidence: existing[0]!.confidence ?? null,
      reasoning,
      actor,
      reasoningReportId,
      tx,
      preExpireBlastRadius,
    });
  };

  if (outerTx) {
    await runUpdate(outerTx);
  } else {
    await db.transaction(runUpdate);
  }

  await createCausalEvent({
    factId,
    transitionType: 'expired',
    subjectEntityId: existing[0]!.subjectEntityId,
    predicate: existing[0]!.predicate,
    deltaConfidence: existing[0]!.confidence ? -existing[0]!.confidence : undefined,
    sourceMemoryId: existing[0]!.sourceMemoryId ?? undefined,
    sourceText: existing[0]!.sourceText ?? undefined,
  });

  await cascadeFactExpiry(factId, { reasoningReportId });
}

export interface InvalidateFactParams {
  factId: string;
  reasoning: string;
  actor: Actor;
  /** When the fact stopped being true in reality (defaults to now). */
  invalidAt?: Date;
  reasoningReportId?: string | null;
  /** Optional outer transaction; see ExpireFactParams.tx for rationale. */
  tx?: Tx;
  /** Pre-mutation blast-radius severitySummary; see ExpireFactParams. */
  preExpireBlastRadius?: SeveritySummary | null;
}

/**
 * Invalidate a fact (mark as no longer true in reality, though it was once true).
 *
 * Writes a fact_history row with event_type='invalidated' in the same
 * transaction as the UPDATE.
 *
 * NOTE — outer-tx callers: see expireFact's outer-tx note; the same
 * post-mutation delegation pattern applies here.
 */
export async function invalidateFact(params: InvalidateFactParams): Promise<void> {
  const {
    factId,
    reasoning,
    actor,
    invalidAt,
    reasoningReportId = null,
    tx: outerTx,
    preExpireBlastRadius = null,
  } = params;
  const effectiveInvalidAt = invalidAt ?? new Date();
  const reader = outerTx ?? db;

  const existing = await reader
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

  const runUpdate = async (tx: Tx): Promise<void> => {
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
      preExpireBlastRadius,
    });
  };

  if (outerTx) {
    await runUpdate(outerTx);
  } else {
    await db.transaction(runUpdate);
  }

  await createCausalEvent({
    factId,
    transitionType: 'invalidated',
    subjectEntityId: existing[0]!.subjectEntityId,
    predicate: existing[0]!.predicate,
    deltaConfidence: existing[0]!.confidence ? -existing[0]!.confidence : undefined,
    sourceMemoryId: existing[0]!.sourceMemoryId ?? undefined,
    sourceText: existing[0]!.sourceText ?? undefined,
  });

  await cascadeFactExpiry(factId, { reasoningReportId });
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
 * Get fact by ID with entity names and (per bead nmemo-2yv.32) the full
 * fact_sources array alongside the legacy facts.source_memory_id /
 * facts.source_text singletons. The singletons remain readable during
 * the migration window so callers can adopt `sources` gradually before
 * the singleton columns are dropped in a follow-up bead.
 */
export async function getFactById(factId: string): Promise<(Fact & {
  subjectName?: string;
  objectName?: string;
  sources: FactSource[];
}) | null> {
  const result = await db
    .select()
    .from(facts)
    .where(eq(facts.id, factId))
    .limit(1);

  if (!result[0]) return null;

  const fact = result[0];

  const [subjectResult, sources] = await Promise.all([
    db
      .select({ name: entities.canonicalName })
      .from(entities)
      .where(eq(entities.id, fact.subjectEntityId))
      .limit(1),
    getFactSources(factId),
  ]);

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
    sources,
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
