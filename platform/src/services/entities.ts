/**
 * Entity Service
 * 
 * Manages entities in the knowledge graph with resolution and deduplication.
 * Uses threshold-based matching from GARDENER_RESEARCH.md:
 * - > 0.92: Auto-merge without LLM verification
 * - 0.75-0.92: Needs LLM verification (W25 implements this)
 * - < 0.75: Create new entity
 */

import { db } from '../db/index.js';
import { rawQuery } from '../db/raw.js';
import { entities, entityAliases, memoryEntities, entityTypes, type Entity } from '../db/schema.js';
import { eq, ilike, sql, and, or } from 'drizzle-orm';
import { ml } from './ml-client.js';

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
  try {
    await db.insert(entityAliases).values({
      entityId,
      alias,
      aliasType: 'mention',
      source: 'extraction',
    });
  } catch (error: unknown) {
    // Only ignore unique constraint violations (23505)
    const pgCode = (error as { code?: string }).code;
    if (pgCode !== '23505') {
      throw error;
    }
  }
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
  try {
    await db.insert(memoryEntities).values({
      memoryId,
      entityId,
      mentionText: mention.text,
      mentionStart: mention.start,
      mentionEnd: mention.end,
      relationship: mention.relationship || 'mentions',
      mentionContext: mention.context,
    });
  } catch {
    // Ignore duplicates (same memory-entity-position combo)
  }
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
