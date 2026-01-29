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
import { entities, entityAliases, memoryEntities, type Entity } from '../db/schema.js';
import { eq, ilike, sql, and } from 'drizzle-orm';
import { config } from '../config.js';

export type EntityType = 'person' | 'company' | 'project' | 'concept' | 'place' | 'event' | 'other';

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
export async function createEntity(params: CreateEntityParams): Promise<string> {
  // Generate embedding for similarity search
  const embedding = await generateEmbedding(params.name);
  
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
  
  return entity.id;
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
    const results = await db.execute(sql`
      SELECT *, similarity(canonical_name, ${name}) as sim
      FROM entities
      WHERE canonical_name % ${name}
      ${type ? sql`AND entity_type = ${type}` : sql``}
      ORDER BY sim DESC
      LIMIT ${limit}
    `);
    
    // Safely handle result structure (postgres vs drizzle types)
    const rows = (results as unknown as { rows: Array<Entity & { similarity: number }> }).rows || results;
    return rows as Array<Entity & { similarity?: number }>;
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
  
  const results = await db.execute(sql`
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
  
  // Safely handle result structure
  const rows = (results as unknown as { rows: Array<Entity & { similarity: number }> }).rows || results;
  return rows as Array<Entity & { similarity: number }>;
}

/**
 * Resolve an entity mention - find existing or create new
 */
export async function resolveEntity(
  mention: string,
  context: string,
  type?: EntityType
): Promise<ResolvedEntity> {
  // Generate embedding for the mention with context
  const combinedText = context ? `${mention} ${context.slice(0, 200)}` : mention;
  const embedding = await generateEmbedding(combinedText);
  
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
    
    // High confidence match - auto merge
    const highConfidence = candidates.filter(c => c.similarity > THRESHOLD_AUTO_MERGE);
    if (highConfidence.length === 1) {
      const match = highConfidence[0]!;
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
  
  // No match - create new entity
  const entityId = await createEntity({
    name: mention,
    type: type || 'other',
    confidence: 0.8,  // Lower confidence for auto-created
  });
  
  return {
    id: entityId,
    canonicalName: mention,
    entityType: type || 'other',
    confidence: 0.8,
    isNew: true,
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
  } catch {
    // Ignore duplicate alias errors
  }
}

/**
 * Update entity last_seen_at timestamp
 */
async function updateLastSeen(entityId: string): Promise<void> {
  await db.execute(sql`
    UPDATE entities SET last_seen_at = NOW() WHERE id = ${entityId}
  `);
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
 * Link multiple entities to a memory
 */
export async function linkEntitiesToMemory(
  memoryId: string,
  extractedEntities: Array<{
    mention: string;
    type: string;
    start?: number;
    end?: number;
    confidence?: number;
  }>
): Promise<number> {
  let linkedCount = 0;
  
  for (const entity of extractedEntities) {
    try {
      // Resolve to canonical entity
      const resolved = await resolveEntity(
        entity.mention,
        '',  // No additional context
        entity.type as EntityType
      );
      
      // Link to memory
      await linkMemoryToEntity(memoryId, resolved.id, {
        text: entity.mention,
        start: entity.start,
        end: entity.end,
      });
      
      linkedCount++;
    } catch (error) {
      console.error(`Failed to link entity "${entity.mention}":`, error);
    }
  }
  
  return linkedCount;
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
 * Get all memory IDs mentioning an entity
 */
export async function getEntityMemories(entityId: string): Promise<string[]> {
  const results = await db
    .select({ memoryId: memoryEntities.memoryId })
    .from(memoryEntities)
    .where(eq(memoryEntities.entityId, entityId));
  
  return results.map(r => r.memoryId);
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
      console.warn('Embedding generation failed:', response.status);
      return [];
    }
    
    const data = await response.json() as { embedding?: number[]; vector?: number[] };
    return data.embedding || data.vector || [];
  } catch (error) {
    console.warn('Embedding generation error:', error);
    return [];
  }
}
