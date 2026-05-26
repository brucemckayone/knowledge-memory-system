/**
 * Entity Service
 * 
 * Manages entities in the knowledge graph with resolution and deduplication.
 * Uses threshold-based matching from GARDENER_RESEARCH.md:
 * - > 0.92: Auto-merge without LLM verification
 * - 0.75-0.92: Needs LLM verification (W25 implements this)
 * - < 0.75: Create new entity
 */

import { db, type Tx } from '../db/index.js';
import { rawQuery } from '../db/raw.js';
import { entities, entityAliases, memoryEntities, entityTypes, type Entity } from '../db/schema.js';
import { eq, ilike, sql, and, or } from 'drizzle-orm';
import { ml } from './ml-client.js';
import { recordFactChange, unwrapRows, type Actor } from './audit.js';

// EntityType is now loaded dynamically from entity_types table.
// This string type allows any value — runtime validation happens via getValidEntityTypes().
export type EntityType = string;

let _cachedEntityTypes: string[] | null = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Get valid entity types from the entity_types table.
 * Cached for 1 minute to avoid per-extraction DB queries.
 */
export async function getValidEntityTypes(): Promise<string[]> {
  const now = Date.now();
  if (_cachedEntityTypes && now - _cacheTime < CACHE_TTL_MS) {
    return _cachedEntityTypes;
  }

  const rows = await db
    .select({ name: entityTypes.name })
    .from(entityTypes)
    .where(
      or(
        eq(entityTypes.status, 'canonical'),
        eq(entityTypes.status, 'provisional')
      )
    );

  _cachedEntityTypes = rows.map(r => r.name);
  _cacheTime = now;
  return _cachedEntityTypes;
}

/**
 * Invalidate the entity type cache.
 * Call after promoting a new entity type so extraction agents pick it up immediately.
 */
export function invalidateEntityTypeCache(): void {
  _cachedEntityTypes = null;
  _cacheTime = 0;
}

export interface CreateEntityParams {
  name: string;
  type: EntityType;
  description?: string;
  properties?: Record<string, unknown>;
  aliases?: string[];
  confidence?: number;
}

export interface ResolvedEntity {
  id: string;
  canonicalName: string;
  entityType: EntityType;
  confidence: number;
  isNew: boolean;
  mergedInto?: string;
}

export interface LinkMemoryParams {
  text: string;
  start?: number;
  end?: number;
  relationship?: string;
  context?: string;
}

// Thresholds from research
const THRESHOLD_AUTO_MERGE = 0.92;
const THRESHOLD_LLM_VERIFY = 0.75;

/**
 * Create a new entity with embedding
 */
export async function createEntity(params: CreateEntityParams): Promise<{ id: string; existed: boolean }> {
  // Generate embedding for similarity search
  const embedding = await generateEmbedding(params.name);

  // Advisory lock on (canonical_name, entity_type) to prevent concurrent duplicates.
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${params.name.toLowerCase() + '||' + params.type}))`);

  // Check if entity already exists (inside the lock)
  const existing = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(
      sql`lower(canonical_name) = ${params.name.toLowerCase()}`,
      eq(entities.entityType, params.type),
    ))
    .limit(1);

  if (existing[0]) {
    // Entity already exists — update last_seen_at and return existing ID
    await updateLastSeen(existing[0].id);
    if (params.aliases?.length) {
      for (const alias of params.aliases) {
        await addAliasIfNew(existing[0].id, alias);
      }
    }
    return { id: existing[0].id, existed: true };
  }

  const result = await db
    .insert(entities)
    .values({
      canonicalName: params.name,
      entityType: params.type,
      description: params.description,
      properties: params.properties || {},
      confidence: params.confidence || 1.0,
    })
    .returning({ id: entities.id });

  const entity = result[0];
  if (!entity) {
    throw new Error('Failed to create entity');
  }

  // Store embedding via raw SQL (pgvector)
  if (embedding && embedding.length > 0) {
    await db.execute(sql`
      UPDATE entities
      SET embedding = ${sql.raw(`'[${embedding.join(',')}]'::vector`)}
      WHERE id = ${entity.id}
    `);
  }

  // Add aliases
  if (params.aliases?.length) {
    await db.insert(entityAliases).values(
      params.aliases.map(alias => ({
        entityId: entity.id,
        alias,
        aliasType: 'initial',
        source: 'user_input',
      }))
    );
  }

  return { id: entity.id, existed: false };
}

/**
 * Find entities by name (exact or fuzzy via trigram)
 */
export async function findEntitiesByName(
  name: string,
  options: { fuzzy?: boolean; limit?: number; type?: EntityType } = {}
): Promise<Array<Entity & { similarity?: number }>> {
  const { fuzzy = true, limit = 10, type } = options;
  
  if (fuzzy) {
    // Trigram similarity search
    return rawQuery<Entity & { sim: number }>(sql`
      SELECT *, similarity(canonical_name, ${name}) as sim
      FROM entities
      WHERE canonical_name % ${name}
      ${type ? sql`AND entity_type = ${type}` : sql``}
      ORDER BY sim DESC
      LIMIT ${limit}
    `);
  }
  
  // Simple ILIKE search
  if (type) {
    return db
      .select()
      .from(entities)
      .where(and(ilike(entities.canonicalName, `%${name}%`), eq(entities.entityType, type)))
      .limit(limit);
  }
  
  return db
    .select()
    .from(entities)
    .where(ilike(entities.canonicalName, `%${name}%`))
    .limit(limit);
}

/**
 * Find similar entities by embedding vector
 */
export async function findSimilarEntities(
  embedding: number[],
  options: { limit?: number; threshold?: number; type?: EntityType } = {}
): Promise<Array<Entity & { similarity: number }>> {
  const { limit = 10, threshold = 0.5, type } = options;
  
  return rawQuery<Entity & { similarity: number }>(sql`
    SELECT
      e.*,
      1 - (embedding <=> ${sql.raw(`'[${embedding.join(',')}]'::vector`)}) as similarity
    FROM entities e
    WHERE embedding IS NOT NULL
      AND 1 - (embedding <=> ${sql.raw(`'[${embedding.join(',')}]'::vector`)}) > ${threshold}
      ${type ? sql`AND entity_type = ${type}` : sql``}
    ORDER BY embedding <=> ${sql.raw(`'[${embedding.join(',')}]'::vector`)}
    LIMIT ${limit}
  `);
}

/**
 * Resolve an entity mention - find existing or create new
 */
export async function resolveEntity(
  mention: string,
  context: string,
  type?: EntityType,
  position?: { start?: number; end?: number }
): Promise<ResolvedEntity> {
  // Generate embedding from mention + context window centred on position
  const contextWindow = computeContextWindow(mention, context, position);
  const embedding = await generateEmbedding(contextWindow);
  
  if (!embedding || embedding.length === 0) {
    // No embedding, fall back to name matching
    const nameMatches = await findEntitiesByName(mention, { limit: 5, type });
    if (nameMatches.length > 0) {
      const bestMatch = nameMatches[0]!;
      const similarity = (bestMatch as { sim?: number }).sim || bestMatch.similarity || 0;
      if (similarity > THRESHOLD_AUTO_MERGE) {
        await addAliasIfNew(bestMatch.id, mention);

        return {
          id: bestMatch.id,
          canonicalName: bestMatch.canonicalName,
          entityType: bestMatch.entityType as EntityType,
          confidence: similarity,
          isNew: false,
        };
      }
    }
  } else {
    // Find similar entities by embedding
    const candidates = await findSimilarEntities(embedding, {
      limit: 10,
      threshold: THRESHOLD_LLM_VERIFY,
      type,
    });
    
    // High confidence match - auto merge (pick best if multiple)
    const highConfidence = candidates.filter(c => c.similarity > THRESHOLD_AUTO_MERGE);
    if (highConfidence.length >= 1) {
      const match = highConfidence[0]!; // Already sorted by similarity DESC
      await addAliasIfNew(match.id, mention);
      await updateLastSeen(match.id);

      return {
        id: match.id,
        canonicalName: match.canonicalName,
        entityType: match.entityType as EntityType,
        confidence: match.similarity,
        isNew: false,
      };
    }
    
    // Medium confidence - would need LLM verification (W25 implements full logic)
    // For now, take best match if above threshold
    const mediumConfidence = candidates.filter(
      c => c.similarity > THRESHOLD_LLM_VERIFY && c.similarity <= THRESHOLD_AUTO_MERGE
    );
    if (mediumConfidence.length > 0) {
      const best = mediumConfidence[0]!;
      await addAliasIfNew(best.id, mention);
      await updateLastSeen(best.id);

      return {
        id: best.id,
        canonicalName: best.canonicalName,
        entityType: best.entityType as EntityType,
        confidence: best.similarity,
        isNew: false,
      };
    }
  }
  
  // No match - create new entity (advisory lock prevents duplicates)
  const { id: entityId, existed } = await createEntity({
    name: mention,
    type: type || 'other',
    confidence: 0.8,
  });

  if (existed) {
    await addAliasIfNew(entityId, mention);
  }

  return {
    id: entityId,
    canonicalName: mention,
    entityType: type || 'other',
    confidence: 0.8,
    isNew: !existed,
  };
}

/**
 * Add alias if not already present
 */
async function addAliasIfNew(entityId: string, alias: string): Promise<void> {
  await db.insert(entityAliases).values({
    entityId,
    alias,
    aliasType: 'mention',
    source: 'extraction',
  }).onConflictDoNothing();
}

/**
 * Update entity last_seen_at timestamp
 */
async function updateLastSeen(entityId: string): Promise<void> {
  await db
    .update(entities)
    .set({ lastSeenAt: new Date() })
    .where(eq(entities.id, entityId));
}

/**
 * Link a memory to an entity
 */
export async function linkMemoryToEntity(
  memoryId: string,
  entityId: string,
  mention: LinkMemoryParams
): Promise<void> {
  await db.insert(memoryEntities).values({
    memoryId,
    entityId,
    mentionText: mention.text,
    mentionStart: mention.start,
    mentionEnd: mention.end,
    relationship: mention.relationship || 'mentions',
    mentionContext: mention.context,
  }).onConflictDoNothing();
}

/**
 * Link multiple entities to a memory.
 * Returns the resolved entity details so downstream agents don't need to re-fetch.
 */
export async function linkEntitiesToMemory(
  memoryId: string,
  extractedEntities: Array<{
    mention: string;
    type: string;
    start?: number;
    end?: number;
    confidence?: number;
  }>,
  context = ''
): Promise<Array<{ id: string; name: string; type: string }>> {
  const linked: Array<{ id: string; name: string; type: string }> = [];

  for (const entity of extractedEntities) {
    try {
      // Resolve to canonical entity (context improves disambiguation)
      const resolved = await resolveEntity(
        entity.mention,
        context,
        entity.type as EntityType
      );

      // Link to memory
      await linkMemoryToEntity(memoryId, resolved.id, {
        text: entity.mention,
        start: entity.start,
        end: entity.end,
      });

      linked.push({
        id: resolved.id,
        name: resolved.canonicalName,
        type: resolved.entityType,
      });
    } catch (error) {
      console.error(`Failed to link entity "${entity.mention}":`, error);
    }
  }

  return linked;
}

/**
 * Get all entities mentioned in a memory
 */
export async function getMemoryEntities(memoryId: string): Promise<Entity[]> {
  const results = await db
    .select({ entity: entities })
    .from(memoryEntities)
    .innerJoin(entities, eq(memoryEntities.entityId, entities.id))
    .where(eq(memoryEntities.memoryId, memoryId));
  
  return results.map(r => r.entity);
}

/**
 * Get entity by ID with aliases
 */
export async function getEntityById(entityId: string): Promise<(Entity & { aliases: string[] }) | null> {
  const entityResult = await db
    .select()
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  
  if (!entityResult[0]) return null;
  
  const aliasResults = await db
    .select({ alias: entityAliases.alias })
    .from(entityAliases)
    .where(eq(entityAliases.entityId, entityId));
  
  return {
    ...entityResult[0],
    aliases: aliasResults.map(a => a.alias),
  };
}

/**
 * Compute context window for entity embedding.
 * When start/end positions are available, centre the window on the mention.
 * Otherwise fall back to mention + first 200 chars of context.
 */
function computeContextWindow(
  mention: string,
  context: string,
  position?: { start?: number; end?: number }
): string {
  if (!context) return mention;

  if (position?.start != null) {
    const windowRadius = 100;
    const windowStart = Math.max(0, position.start - windowRadius);
    const mentionEnd = position.end ?? (position.start + mention.length);
    const windowEnd = Math.min(context.length, mentionEnd + windowRadius);
    return context.slice(windowStart, windowEnd);
  }

  // Fallback: mention + first 200 chars
  return `${mention} ${context.slice(0, 200)}`;
}

/**
 * Generate embedding via ML service
 */
async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const data = await ml.embed(text);
    return data.vector || [];
  } catch (error) {
    console.warn('Embedding generation error:', error);
    return [];
  }
}

// ============================================
// Entity merge (audited replacement for PL/pgSQL entity-merge function)
// ============================================

/**
 * Parameters for {@link mergeEntities}. Mirrors the old PL/pgSQL function's
 * 5-argument signature with the addition of `actor` (required) — every fact
 * mutation MUST carry an actor for the audit trail (mig 009 valid_fact_actor
 * CHECK).
 *
 * Bead nmemo-2yv.30.
 */
export interface MergeEntitiesParams {
  /** Source entity to be merged away. Deleted at the end of the merge. */
  sourceId: string;
  /** Target entity that absorbs the source's facts, aliases, and edges. */
  targetId: string;
  /** Human/agent-readable explanation for the merge (recorded in entity_merges.merge_reason). */
  reason?: string;
  /** Tagged source of the merge decision (auto, llm_verified, manual, …). */
  method?: string;
  /** Optional similarity score that drove the merge. */
  score?: number | null;
  /**
   * Actor recorded on every fact_history row emitted by this merge.
   * Defaults to 'reconciliation_agent' — the production caller. Other actors
   * (system_trigger, user) are valid but rare.
   */
  actor?: Actor;
  /**
   * Optional outer transaction. Pass when the caller already owns a tx and
   * needs the merge to land atomically with surrounding work. When omitted,
   * the function opens its own transaction.
   */
  tx?: Tx;
}

export interface MergeEntitiesResult {
  /** ID of the surviving entity (always the supplied targetId on success). */
  survivorId: string;
}

/**
 * Audited replacement for the PL/pgSQL entity-merge function
 * (originally mig 005, extended by mig 020 for contradictions). Bead
 * nmemo-2yv.30.
 *
 * Subsumes every behaviour of the old SQL function:
 *   - INSERT entity_merges row (audit of the merge action itself)
 *   - Copy entity_aliases from source to target (dedup via ON CONFLICT)
 *   - Add source.canonical_name as an alias on target
 *   - Re-point facts.subject_entity_id and facts.object_entity_id
 *   - Expire duplicate facts after re-pointing (same predicate + object)
 *   - Re-point entity_merges where source was the target of an earlier merge
 *   - Reconcile memory_entities (unique-collapse + re-point)
 *   - Delete remaining source aliases
 *   - Re-point causal_events.subject_entity_id
 *   - Re-point same_as_links (a/b sides, with canonical ordering preserved)
 *   - Re-point contradictions (per mig 020 dedup + re-point)
 *   - Append source.id to target.merged_from, update last_seen_at
 *   - Delete the source entity
 *
 * Crucial difference from the SQL function: every fact mutation emits exactly
 * one `fact_history` row with `event_type = 'merged'` and `actor` threaded
 * from the caller (default `reconciliation_agent`). The whole merge runs in
 * a single transaction — any audit-write failure rolls the entire merge back
 * (the audit invariant, doc 12).
 *
 * @throws if `sourceId` does not exist (NotFoundError-like — preserves the
 *         old function's "Source entity not found" semantic).
 * @returns `{ survivorId }` — always the supplied `targetId` on success.
 */
export async function mergeEntities(params: MergeEntitiesParams): Promise<MergeEntitiesResult> {
  const {
    sourceId,
    targetId,
    reason = 'Duplicate detected',
    method = 'auto',
    score = null,
    actor = 'reconciliation_agent',
    tx: outerTx,
  } = params;

  // Whole-merge atomicity. If the caller passed an outer tx, use it; else
  // open our own. Same shape as the rest of the service layer (facts.ts).
  const runMerge = async (tx: Tx): Promise<MergeEntitiesResult> => {
    // ── 1. Verify source exists; capture its canonical_name for the
    //       alias row added to target.
    const sourceRows = unwrapRows<{ canonical_name: string }>(await tx.execute(sql`
      SELECT canonical_name FROM public.entities WHERE id = ${sourceId}::uuid
    `));
    if (sourceRows.length === 0) {
      throw new Error(`Source entity ${sourceId} not found`);
    }
    const sourceName = sourceRows[0]!.canonical_name;

    // ── 2. entity_merges audit row (audit of the merge itself, not of
    //       individual fact mutations — distinct from fact_history).
    await tx.execute(sql`
      INSERT INTO public.entity_merges (
        source_entity_id, target_entity_id, merge_reason, merge_method, similarity_score
      )
      VALUES (
        ${sourceId}::uuid, ${targetId}::uuid, ${reason}, ${method}, ${score}
      )
    `);

    // ── 3. Copy source aliases onto target, then add source canonical_name
    //       as an alias on target. Dedup via ON CONFLICT.
    await tx.execute(sql`
      INSERT INTO public.entity_aliases (entity_id, alias, alias_type, source)
      SELECT ${targetId}::uuid, alias, alias_type, 'merge'
      FROM public.entity_aliases
      WHERE entity_id = ${sourceId}::uuid
      ON CONFLICT (entity_id, alias) DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO public.entity_aliases (entity_id, alias, alias_type, source)
      VALUES (${targetId}::uuid, ${sourceName}, 'merged_name', 'merge')
      ON CONFLICT (entity_id, alias) DO NOTHING
    `);

    // ── 4. Re-point facts where source is the SUBJECT. UPDATE ... RETURNING
    //       so the audit set EXACTLY matches the mutation set — a SELECT-then-
    //       UPDATE pair would race with concurrent inserters (the platform's
    //       READ COMMITTED default isolation lets a fact with
    //       subject_entity_id = sourceId land between the two statements
    //       and slip an UPDATE without an audit row).
    const subjectFactRows = unwrapRows<{ id: string }>(await tx.execute(sql`
      UPDATE public.facts SET subject_entity_id = ${targetId}::uuid
      WHERE subject_entity_id = ${sourceId}::uuid
      RETURNING id::text AS id
    `));
    if (subjectFactRows.length > 0) {
      const subjectReasoning = `Entity merge: subject_entity_id re-pointed from ${sourceId} to ${targetId}. Merge reason: ${reason}`;
      for (const row of subjectFactRows) {
        await recordFactChange({
          factId: row.id,
          eventType: 'merged',
          reasoning: subjectReasoning,
          actor,
          tx,
        });
      }
    }

    // ── 5. Re-point facts where source is the OBJECT. Same UPDATE...RETURNING
    //       shape — see step 4 comment for the race-window rationale.
    const objectFactRows = unwrapRows<{ id: string }>(await tx.execute(sql`
      UPDATE public.facts SET object_entity_id = ${targetId}::uuid
      WHERE object_entity_id = ${sourceId}::uuid
      RETURNING id::text AS id
    `));
    if (objectFactRows.length > 0) {
      const objectReasoning = `Entity merge: object_entity_id re-pointed from ${sourceId} to ${targetId}. Merge reason: ${reason}`;
      for (const row of objectFactRows) {
        await recordFactChange({
          factId: row.id,
          eventType: 'merged',
          reasoning: objectReasoning,
          actor,
          tx,
        });
      }
    }

    // ── 6. Deduplicate exact-match facts after re-pointing. UPDATE...RETURNING
    //       on a ranked CTE — keep the highest-confidence / latest-created
    //       row, expire the rest. RETURNING gives the exact mutation set so
    //       the audit emission can't drift from it (same race-rationale as
    //       step 4).
    const duplicateRows = unwrapRows<{ id: string }>(await tx.execute(sql`
      WITH ranked AS (
        SELECT f.id, ROW_NUMBER() OVER (
          PARTITION BY f.subject_entity_id, f.predicate,
            COALESCE(f.object_entity_id::text, ''), COALESCE(f.object_value, '')
          ORDER BY f.confidence DESC NULLS LAST, f.created_at DESC
        ) AS rn
        FROM public.facts f
        WHERE (f.subject_entity_id = ${targetId}::uuid OR f.object_entity_id = ${targetId}::uuid)
          AND f.expired_at IS NULL
      )
      UPDATE public.facts
      SET expired_at = NOW(),
          expire_reason = 'Duplicate removed during entity merge'
      WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
      RETURNING id::text AS id
    `));
    if (duplicateRows.length > 0) {
      const dedupReasoning = `Entity merge: duplicate fact expired after subject/object re-point to ${targetId}. Merge reason: ${reason}`;
      for (const row of duplicateRows) {
        await recordFactChange({
          factId: row.id,
          eventType: 'merged',
          reasoning: dedupReasoning,
          actor,
          tx,
        });
      }
    }

    // ── 7. Re-point entity_merges where source was the target of an
    //       earlier merge (transitive merge bookkeeping). No audit needed —
    //       entity_merges is itself an audit table.
    await tx.execute(sql`
      UPDATE public.entity_merges SET target_entity_id = ${targetId}::uuid
      WHERE target_entity_id = ${sourceId}::uuid
    `);

    // ── 8. Reconcile memory_entities. Delete source rows that would
    //       collide with existing target rows for the same memory_id, then
    //       re-point the rest. No audit — memory_entities has no history.
    await tx.execute(sql`
      DELETE FROM public.memory_entities
      WHERE entity_id = ${sourceId}::uuid
        AND memory_id IN (
          SELECT memory_id FROM public.memory_entities WHERE entity_id = ${targetId}::uuid
        )
    `);
    await tx.execute(sql`
      UPDATE public.memory_entities SET entity_id = ${targetId}::uuid
      WHERE entity_id = ${sourceId}::uuid
    `);

    // ── 9. Delete the source's now-redundant alias rows (their canonical
    //       text was copied onto target in step 3).
    await tx.execute(sql`
      DELETE FROM public.entity_aliases WHERE entity_id = ${sourceId}::uuid
    `);

    // ── 10. Re-point causal_events. Same step the SQL function had — the
    //        bead nmemo-2yv.30 spec calls these out as non-fact tables that
    //        don't need fact_history rows.
    await tx.execute(sql`
      UPDATE public.causal_events SET subject_entity_id = ${targetId}::uuid
      WHERE subject_entity_id = ${sourceId}::uuid
    `);

    // ── 11. Re-point same_as_links preserving the canonical (a < b)
    //        ordering, then drop links that became self-referential or
    //        duplicate.
    await tx.execute(sql`
      UPDATE public.same_as_links SET entity_a_id = ${targetId}::uuid
      WHERE entity_a_id = ${sourceId}::uuid AND ${targetId}::uuid < entity_b_id
    `);
    await tx.execute(sql`
      UPDATE public.same_as_links SET entity_b_id = ${targetId}::uuid
      WHERE entity_b_id = ${sourceId}::uuid AND entity_a_id < ${targetId}::uuid
    `);
    await tx.execute(sql`
      DELETE FROM public.same_as_links
      WHERE entity_a_id = entity_b_id
         OR (entity_a_id = ${targetId}::uuid AND entity_b_id = ${targetId}::uuid)
    `);

    // ── 12. Re-point contradictions (mig 020 / nmemo-2yv.63). Dedup against
    //        the partial UNIQUE INDEX idx_contradictions_unique_active —
    //        same COALESCE sentinel UUID + column tuple shape as the SQL
    //        function (any drift here would either over-delete or fail the
    //        UPDATE).
    await tx.execute(sql`
      DELETE FROM public.contradictions src
      WHERE src.entity_id = ${sourceId}::uuid
        AND src.resolved_at IS NULL
        AND EXISTS (
          SELECT 1 FROM public.contradictions tgt
          WHERE tgt.entity_id = ${targetId}::uuid
            AND tgt.resolved_at IS NULL
            AND tgt.contradiction_type = src.contradiction_type
            AND COALESCE(tgt.fact_a_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = COALESCE(src.fact_a_id, '00000000-0000-0000-0000-000000000000'::uuid)
            AND COALESCE(tgt.fact_b_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = COALESCE(src.fact_b_id, '00000000-0000-0000-0000-000000000000'::uuid)
            AND COALESCE(tgt.edge_a_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = COALESCE(src.edge_a_id, '00000000-0000-0000-0000-000000000000'::uuid)
            AND COALESCE(tgt.edge_b_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = COALESCE(src.edge_b_id, '00000000-0000-0000-0000-000000000000'::uuid)
        )
    `);
    await tx.execute(sql`
      UPDATE public.contradictions SET entity_id = ${targetId}::uuid
      WHERE entity_id = ${sourceId}::uuid
    `);

    // ── 13. Append source to target.merged_from, update target.last_seen_at
    //        to the GREATEST of source and target. No audit — entities has
    //        no history table.
    await tx.execute(sql`
      UPDATE public.entities
      SET merged_from = merged_from || ${sourceId}::uuid,
          last_seen_at = GREATEST(
            last_seen_at,
            (SELECT last_seen_at FROM public.entities WHERE id = ${sourceId}::uuid)
          ),
          updated_at = NOW()
      WHERE id = ${targetId}::uuid
    `);

    // ── 14. Finally, delete the source. All FK-bearing tables have either
    //        been re-pointed (steps 4-12) or cascade-cleared (entity_aliases
    //        step 9). With contradictions re-pointed in step 12, the FK in
    //        mig 011 no longer blocks this DELETE.
    await tx.execute(sql`
      DELETE FROM public.entities WHERE id = ${sourceId}::uuid
    `);

    return { survivorId: targetId };
  };

  if (outerTx) {
    return runMerge(outerTx);
  }
  return db.transaction(runMerge);
}
