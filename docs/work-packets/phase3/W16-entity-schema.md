# Work Packet W16: Entity Schema

**Status:** ✅ Complete
**Dependencies:** Phase 2 Complete  
**Estimated Time:** 2-3 hours

---

## Objective

Create the entity tracking system that forms the foundation of the knowledge graph. Entities are the "nouns" in your knowledge base — people, places, projects, concepts, companies.

---

## Background

### Research Reference
From [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md) lines 11-86:
- Entity resolution achieves 87% F1 on benchmarks
- Three-stage pipeline: blocking → similarity → LLM verification
- Threshold approach minimizes LLM calls

### Current State
- Memories stored in Qdrant (free-form text + embeddings)
- No entity tracking
- No deduplication of concepts

### Target State
- Entities extracted from every memory
- Canonical entities with aliases
- Merge audit trail
- Entity embeddings for similarity search

---

## Database Schema

### Create Migration

Create `platform/src/db/migrations/003_entities.sql`:

```sql
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================
-- ENTITIES: Canonical knowledge graph nodes
-- ============================================
CREATE TABLE entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Identity
    canonical_name VARCHAR(500) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,  -- person, company, project, concept, place, event
    
    -- Properties (flexible JSON)
    properties JSONB DEFAULT '{}',
    
    -- Merge tracking
    merged_from UUID[] DEFAULT '{}',  -- IDs of entities merged into this one
    
    -- Quality
    confidence FLOAT DEFAULT 1.0,  -- 0.0 - 1.0
    
    -- Embedding for similarity search
    embedding VECTOR(768),
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT valid_entity_type CHECK (
        entity_type IN ('person', 'company', 'project', 'concept', 'place', 'event', 'other')
    )
);

-- Indexes
CREATE INDEX idx_entities_type ON entities(entity_type);
CREATE INDEX idx_entities_name ON entities USING gin(canonical_name gin_trgm_ops);
CREATE INDEX idx_entities_embedding ON entities USING ivfflat (embedding vector_cosine_ops);

-- ============================================
-- ENTITY ALIASES: Alternative names
-- ============================================
CREATE TABLE entity_aliases (
    id SERIAL PRIMARY KEY,
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    
    -- Alias info
    alias VARCHAR(500) NOT NULL,
    alias_type VARCHAR(50),  -- abbreviation, nickname, typo, former_name
    
    -- When discovered
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Unique constraint
    UNIQUE(entity_id, alias)
);

CREATE INDEX idx_aliases_alias ON entity_aliases(alias);

-- ============================================
-- ENTITY MERGES: Audit trail
-- ============================================
CREATE TABLE entity_merges (
    id SERIAL PRIMARY KEY,
    
    -- What was merged
    source_entity_id UUID NOT NULL,  -- Entity that was merged away
    target_entity_id UUID NOT NULL REFERENCES entities(id),  -- Entity that absorbed it
    
    -- Why
    merge_reason TEXT,
    merge_method VARCHAR(50),  -- auto_high_confidence, llm_verified, manual
    
    -- When
    merged_at TIMESTAMPTZ DEFAULT NOW(),
    merged_by VARCHAR(100) DEFAULT 'system'  -- system, user, llm
);

CREATE INDEX idx_merges_source ON entity_merges(source_entity_id);
CREATE INDEX idx_merges_target ON entity_merges(target_entity_id);

-- ============================================
-- MEMORY ENTITIES: Link memories to entities
-- ============================================
CREATE TABLE memory_entities (
    -- Composite primary key
    memory_id UUID NOT NULL,  -- References Qdrant trace_id
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    
    -- How the entity appears in the memory
    mention_text VARCHAR(500),  -- Original text that mentioned the entity
    relationship VARCHAR(100),  -- mentions, about, by, authored_by
    
    -- Position in text (for highlighting)
    mention_start INT,
    mention_end INT,
    
    -- Confidence of this mention
    confidence FLOAT DEFAULT 1.0,
    
    -- When extracted
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    PRIMARY KEY (memory_id, entity_id, mention_start)
);

CREATE INDEX idx_memory_entities_memory ON memory_entities(memory_id);
CREATE INDEX idx_memory_entities_entity ON memory_entities(entity_id);

-- ============================================
-- FUNCTIONS
-- ============================================

-- Function to merge two entities
CREATE OR REPLACE FUNCTION merge_entities(
    source_id UUID,
    target_id UUID,
    reason TEXT DEFAULT 'Duplicate detected',
    method VARCHAR(50) DEFAULT 'auto'
) RETURNS UUID AS $$
DECLARE
    result UUID;
BEGIN
    -- Record the merge
    INSERT INTO entity_merges (source_entity_id, target_entity_id, merge_reason, merge_method)
    VALUES (source_id, target_id, reason, method);
    
    -- Move aliases from source to target
    INSERT INTO entity_aliases (entity_id, alias, alias_type)
    SELECT target_id, alias, alias_type
    FROM entity_aliases WHERE entity_id = source_id
    ON CONFLICT (entity_id, alias) DO NOTHING;
    
    -- Add source's canonical name as alias of target
    INSERT INTO entity_aliases (entity_id, alias, alias_type)
    SELECT target_id, canonical_name, 'merged_name'
    FROM entities WHERE id = source_id
    ON CONFLICT (entity_id, alias) DO NOTHING;
    
    -- Update memory_entities to point to target
    UPDATE memory_entities 
    SET entity_id = target_id 
    WHERE entity_id = source_id;
    
    -- Update merged_from array on target
    UPDATE entities 
    SET merged_from = merged_from || source_id,
        updated_at = NOW()
    WHERE id = target_id;
    
    -- Delete source entity
    DELETE FROM entities WHERE id = source_id;
    
    RETURN target_id;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_entity_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entities_updated_at
    BEFORE UPDATE ON entities
    FOR EACH ROW
    EXECUTE FUNCTION update_entity_timestamp();
```

---

## TypeScript Schema

Update `platform/src/db/schema.ts`:

```typescript
import { 
  pgTable, uuid, text, timestamp, varchar, integer, jsonb, 
  real, serial, index, uniqueIndex 
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ... existing tables ...

/**
 * Entities
 * 
 * Canonical knowledge graph nodes representing people, places, concepts, etc.
 */
export const entities = pgTable('entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  canonicalName: varchar('canonical_name', { length: 500 }).notNull(),
  entityType: varchar('entity_type', { length: 100 }).notNull(),
  properties: jsonb('properties').default('{}').notNull(),
  mergedFrom: uuid('merged_from').array().default([]),
  confidence: real('confidence').default(1.0).notNull(),
  // Note: embedding handled directly via SQL, not in Drizzle
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  typeIdx: index('idx_entities_type').on(table.entityType),
}));

export const entitiesRelations = relations(entities, ({ many }) => ({
  aliases: many(entityAliases),
  memoryLinks: many(memoryEntities),
}));

/**
 * Entity Aliases
 * 
 * Alternative names for entities (nicknames, abbreviations, typos)
 */
export const entityAliases = pgTable('entity_aliases', {
  id: serial('id').primaryKey(),
  entityId: uuid('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  alias: varchar('alias', { length: 500 }).notNull(),
  aliasType: varchar('alias_type', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  aliasIdx: index('idx_aliases_alias').on(table.alias),
  uniqueAlias: uniqueIndex('unique_entity_alias').on(table.entityId, table.alias),
}));

export const entityAliasesRelations = relations(entityAliases, ({ one }) => ({
  entity: one(entities, {
    fields: [entityAliases.entityId],
    references: [entities.id],
  }),
}));

/**
 * Entity Merges
 * 
 * Audit trail of entity deduplication
 */
export const entityMerges = pgTable('entity_merges', {
  id: serial('id').primaryKey(),
  sourceEntityId: uuid('source_entity_id').notNull(),
  targetEntityId: uuid('target_entity_id').notNull().references(() => entities.id),
  mergeReason: text('merge_reason'),
  mergeMethod: varchar('merge_method', { length: 50 }),
  mergedAt: timestamp('merged_at', { withTimezone: true }).defaultNow().notNull(),
  mergedBy: varchar('merged_by', { length: 100 }).default('system'),
});

/**
 * Memory Entities
 * 
 * Links between memories (Qdrant) and entities (Postgres)
 */
export const memoryEntities = pgTable('memory_entities', {
  memoryId: uuid('memory_id').notNull(),
  entityId: uuid('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  mentionText: varchar('mention_text', { length: 500 }),
  relationship: varchar('relationship', { length: 100 }),
  mentionStart: integer('mention_start'),
  mentionEnd: integer('mention_end'),
  confidence: real('confidence').default(1.0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  memoryIdx: index('idx_memory_entities_memory').on(table.memoryId),
  entityIdx: index('idx_memory_entities_entity').on(table.entityId),
}));

export const memoryEntitiesRelations = relations(memoryEntities, ({ one }) => ({
  entity: one(entities, {
    fields: [memoryEntities.entityId],
    references: [entities.id],
  }),
}));

// Type exports
export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type EntityAlias = typeof entityAliases.$inferSelect;
export type EntityMerge = typeof entityMerges.$inferSelect;
export type MemoryEntity = typeof memoryEntities.$inferSelect;
```

---

## Entity Service

Create `platform/src/services/entities.ts`:

```typescript
import { db } from '../db/index.js';
import { entities, entityAliases, memoryEntities, EntityAlias } from '../db/schema.js';
import { eq, ilike, or, sql } from 'drizzle-orm';
import { embed } from './ml.js';

export type EntityType = 'person' | 'company' | 'project' | 'concept' | 'place' | 'event' | 'other';

export interface CreateEntityParams {
  name: string;
  type: EntityType;
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

// Thresholds from research
const THRESHOLD_AUTO_MERGE = 0.92;
const THRESHOLD_LLM_VERIFY = 0.75;

/**
 * Create a new entity
 */
export async function createEntity(params: CreateEntityParams): Promise<string> {
  // Generate embedding for similarity search
  const embeddingResult = await embed(params.name);
  
  const [entity] = await db
    .insert(entities)
    .values({
      canonicalName: params.name,
      entityType: params.type,
      properties: params.properties || {},
      confidence: params.confidence || 1.0,
    })
    .returning({ id: entities.id });
  
  // Store embedding via raw SQL (pgvector)
  await db.execute(sql`
    UPDATE entities 
    SET embedding = ${sql.raw(`'[${embeddingResult.vector.join(',')}]'::vector`)}
    WHERE id = ${entity.id}
  `);
  
  // Add aliases
  if (params.aliases?.length) {
    await db.insert(entityAliases).values(
      params.aliases.map(alias => ({
        entityId: entity.id,
        alias,
        aliasType: 'initial',
      }))
    );
  }
  
  return entity.id;
}

/**
 * Find entities by name (exact or fuzzy)
 */
export async function findEntitiesByName(
  name: string,
  options: { fuzzy?: boolean; limit?: number } = {}
): Promise<Entity[]> {
  const { fuzzy = true, limit = 10 } = options;
  
  if (fuzzy) {
    // Trigram similarity search
    return db.execute(sql`
      SELECT *, similarity(canonical_name, ${name}) as sim
      FROM entities
      WHERE canonical_name % ${name}
      ORDER BY sim DESC
      LIMIT ${limit}
    `);
  }
  
  return db
    .select()
    .from(entities)
    .where(ilike(entities.canonicalName, `%${name}%`))
    .limit(limit);
}

/**
 * Find similar entities by embedding
 */
export async function findSimilarEntities(
  embedding: number[],
  options: { limit?: number; threshold?: number } = {}
): Promise<Array<Entity & { similarity: number }>> {
  const { limit = 10, threshold = 0.5 } = options;
  
  const results = await db.execute(sql`
    SELECT 
      e.*,
      1 - (embedding <=> ${sql.raw(`'[${embedding.join(',')}]'::vector`)}) as similarity
    FROM entities e
    WHERE embedding IS NOT NULL
      AND 1 - (embedding <=> ${sql.raw(`'[${embedding.join(',')}]'::vector`)}) > ${threshold}
    ORDER BY embedding <=> ${sql.raw(`'[${embedding.join(',')}]'::vector`)}
    LIMIT ${limit}
  `);
  
  return results.rows as Array<Entity & { similarity: number }>;
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
  const embeddingResult = await embed(`${mention} ${context}`);
  
  // Find similar entities
  const candidates = await findSimilarEntities(embeddingResult.vector, {
    limit: 10,
    threshold: THRESHOLD_LLM_VERIFY,
  });
  
  // High confidence match - auto merge
  const highConfidence = candidates.filter(c => c.similarity > THRESHOLD_AUTO_MERGE);
  if (highConfidence.length === 1) {
    // Add as alias if not already present
    await addAliasIfNew(highConfidence[0].id, mention);
    
    return {
      id: highConfidence[0].id,
      canonicalName: highConfidence[0].canonicalName,
      entityType: highConfidence[0].entityType as EntityType,
      confidence: highConfidence[0].similarity,
      isNew: false,
    };
  }
  
  // Medium confidence - would need LLM verification (simplified for now)
  const mediumConfidence = candidates.filter(
    c => c.similarity > THRESHOLD_LLM_VERIFY && c.similarity <= THRESHOLD_AUTO_MERGE
  );
  if (mediumConfidence.length > 0) {
    // TODO: W25 will implement LLM verification
    // For now, take best match
    const best = mediumConfidence[0];
    return {
      id: best.id,
      canonicalName: best.canonicalName,
      entityType: best.entityType as EntityType,
      confidence: best.similarity,
      isNew: false,
    };
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
    });
  } catch (error) {
    // Ignore duplicate alias errors
  }
}

/**
 * Link a memory to an entity
 */
export async function linkMemoryToEntity(
  memoryId: string,
  entityId: string,
  mention: { text: string; start?: number; end?: number; relationship?: string }
): Promise<void> {
  await db.insert(memoryEntities).values({
    memoryId,
    entityId,
    mentionText: mention.text,
    mentionStart: mention.start,
    mentionEnd: mention.end,
    relationship: mention.relationship || 'mentions',
  });
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
 * Get all memories mentioning an entity
 */
export async function getEntityMemories(entityId: string): Promise<string[]> {
  const results = await db
    .select({ memoryId: memoryEntities.memoryId })
    .from(memoryEntities)
    .where(eq(memoryEntities.entityId, entityId));
  
  return results.map(r => r.memoryId);
}
```

---

## Run Migration

```bash
# Apply migration
cd platform
pnpm drizzle-kit push

# Or manually
psql -d cognitive -f src/db/migrations/003_entities.sql
```

---

## Verification

### Automated Tests
Run simple unit tests for entity service.

```bash
# Create platform/src/services/__tests__/entities.test.ts
import { createEntity, resolveEntity } from '../entities.js';
import { describe, it, expect, vi } from 'vitest';

describe('Entity Service', () => {
    it('resolveEntity should return existing entity for high similarity', async () => {
        // Mock DB and ML calls
        global.embed = vi.fn().mockResolvedValue({ vector: [0.1, 0.2] }); 
        // ... mocked implementation
    });
});
```

### Manual Verification

```typescript
// Test entity creation
const entityId = await createEntity({
  name: 'John Smith',
  type: 'person',
  properties: { role: 'engineer' },
});

// Test entity resolution
const resolved = await resolveEntity('J. Smith', 'working on the project');
console.log(resolved);
// { id: '...', canonicalName: 'John Smith', isNew: false, confidence: 0.95 }

// Test memory linking
await linkMemoryToEntity(
  'memory-trace-id',
  resolved.id,
  { text: 'J. Smith', start: 10, end: 18 }
);
```

---

## Acceptance Criteria

- [ ] `entities` table created with all columns
- [ ] `entity_aliases` table created
- [ ] `entity_merges` table created  
- [ ] `memory_entities` table created
- [ ] `merge_entities()` SQL function works
- [ ] pgvector extension installed
- [ ] TypeScript schema updated
- [ ] Entity service implemented
- [ ] `createEntity()` generates embedding
- [ ] `resolveEntity()` uses threshold logic
- [ ] `linkMemoryToEntity()` works

---

## Next Packet

After completing W16, proceed to:
- [W17: Bi-Temporal Facts](./W17-bi-temporal-facts.md) - Structured knowledge triples
- [W20: Entity Extraction](./W20-entity-extraction.md) - Extract entities from text
