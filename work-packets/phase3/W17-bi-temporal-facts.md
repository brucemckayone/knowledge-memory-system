# Work Packet W17: Bi-Temporal Facts

**Status:** Ready to Implement  
**Dependencies:** W16 (Entity Schema)  
**Estimated Time:** 3-4 hours

---

## Objective

Create the bi-temporal fact storage system from Graphiti research. Facts are structured knowledge triples (subject → predicate → object) with four timestamps enabling point-in-time queries and proper supersession handling.

---

## Background

### Research Reference
From [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md) lines 90-183:
- Four-timestamp model separates event time from transaction time
- `valid_at` / `invalid_at`: When the fact was true in reality
- `created_at` / `expired_at`: When you recorded/corrected the fact
- Supersession detection marks old facts when new ones arrive

### The Key Insight
When "I work at Acme" arrives after "I work at TechCorp", the system detects these conflict during overlapping time periods and marks the older as superseded.

---

## Database Schema

### Create Migration

Create `platform/src/db/migrations/004_facts.sql`:

```sql
-- Requires btree_gist for temporal exclusion constraint
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ============================================
-- FACTS: Bi-temporal knowledge triples
-- ============================================
CREATE TABLE facts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Triple structure
    subject_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    predicate VARCHAR(255) NOT NULL,  -- e.g., "works_at", "lives_in", "knows"
    object_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,  -- For entity objects
    object_value TEXT,  -- For literal values (numbers, dates, strings)
    
    -- Event time: When the fact was true in reality
    valid_at TIMESTAMPTZ,      -- When it became true
    invalid_at TIMESTAMPTZ,    -- When it stopped being true (NULL = still true)
    
    -- Transaction time: When we recorded/corrected it
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- When we learned it
    expired_at TIMESTAMPTZ,    -- When we learned it was wrong (NULL = not expired)
    
    -- Provenance
    source_memory_id UUID,     -- Link to source memory in Qdrant
    source_text TEXT,          -- Original text that stated the fact
    
    -- Quality
    confidence FLOAT DEFAULT 1.0,
    
    -- Embedding for semantic fact search
    fact_embedding VECTOR(768),
    
    -- Prevent overlapping valid periods for same subject-predicate
    -- (only for non-expired facts)
    CONSTRAINT no_overlapping_facts EXCLUDE USING GIST (
        subject_entity_id WITH =,
        predicate WITH =,
        tstzrange(valid_at, invalid_at) WITH &&
    ) WHERE (expired_at IS NULL AND object_entity_id IS NOT NULL)
);

-- Indexes for efficient queries
CREATE INDEX idx_facts_subject ON facts(subject_entity_id);
CREATE INDEX idx_facts_object ON facts(object_entity_id) WHERE object_entity_id IS NOT NULL;
CREATE INDEX idx_facts_predicate ON facts(predicate);
CREATE INDEX idx_facts_temporal ON facts USING GIST (tstzrange(valid_at, invalid_at));
CREATE INDEX idx_facts_active ON facts(subject_entity_id, predicate) WHERE expired_at IS NULL;
CREATE INDEX idx_facts_embedding ON facts USING ivfflat (fact_embedding vector_cosine_ops);

-- ============================================
-- FACT PREDICATES: Ontology of relationships
-- ============================================
CREATE TABLE fact_predicates (
    predicate VARCHAR(255) PRIMARY KEY,
    description TEXT,
    inverse_predicate VARCHAR(255),  -- e.g., "works_at" <-> "employs"
    predicate_type VARCHAR(50),  -- relation, attribute, temporal
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed common predicates
INSERT INTO fact_predicates (predicate, description, inverse_predicate, predicate_type) VALUES
    ('works_at', 'Employment relationship', 'employs', 'relation'),
    ('employs', 'Employs person', 'works_at', 'relation'),
    ('lives_in', 'Residence location', NULL, 'relation'),
    ('knows', 'Personal acquaintance', 'known_by', 'relation'),
    ('member_of', 'Group membership', 'has_member', 'relation'),
    ('located_in', 'Physical location', 'contains', 'relation'),
    ('part_of', 'Part-whole relationship', 'has_part', 'relation'),
    ('created', 'Creator relationship', 'created_by', 'relation'),
    ('related_to', 'General relationship', 'related_to', 'relation'),
    ('has_role', 'Role or position', NULL, 'attribute'),
    ('has_email', 'Email address', NULL, 'attribute'),
    ('has_phone', 'Phone number', NULL, 'attribute'),
    ('started_at', 'Start date of activity', NULL, 'temporal'),
    ('ended_at', 'End date of activity', NULL, 'temporal')
ON CONFLICT DO NOTHING;

-- ============================================
-- FUNCTIONS
-- ============================================

-- Function to expire a fact (mark as wrong)
CREATE OR REPLACE FUNCTION expire_fact(
    fact_id UUID,
    reason TEXT DEFAULT 'Superseded by new information'
) RETURNS void AS $$
BEGIN
    UPDATE facts
    SET expired_at = NOW()
    WHERE id = fact_id AND expired_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to invalidate a fact (mark as no longer true)
CREATE OR REPLACE FUNCTION invalidate_fact(
    fact_id UUID,
    invalid_time TIMESTAMPTZ DEFAULT NOW()
) RETURNS void AS $$
BEGIN
    UPDATE facts
    SET invalid_at = invalid_time
    WHERE id = fact_id AND invalid_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to query facts at a point in time
CREATE OR REPLACE FUNCTION facts_at_time(
    query_time TIMESTAMPTZ
) RETURNS TABLE (
    id UUID,
    subject_entity_id UUID,
    predicate VARCHAR(255),
    object_entity_id UUID,
    object_value TEXT,
    confidence FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        f.id,
        f.subject_entity_id,
        f.predicate,
        f.object_entity_id,
        f.object_value,
        f.confidence
    FROM facts f
    WHERE 
        -- Transaction time: known at query time
        f.created_at <= query_time
        AND (f.expired_at IS NULL OR f.expired_at > query_time)
        -- Event time: valid at query time
        AND (f.valid_at IS NULL OR f.valid_at <= query_time)
        AND (f.invalid_at IS NULL OR f.invalid_at > query_time);
END;
$$ LANGUAGE plpgsql;

-- Function to find superseded facts
CREATE OR REPLACE FUNCTION find_superseding_facts(
    new_fact_subject UUID,
    new_fact_predicate VARCHAR(255),
    new_fact_valid_at TIMESTAMPTZ,
    new_fact_invalid_at TIMESTAMPTZ
) RETURNS TABLE (
    fact_id UUID,
    old_valid_at TIMESTAMPTZ,
    old_invalid_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        f.id,
        f.valid_at,
        f.invalid_at
    FROM facts f
    WHERE 
        f.subject_entity_id = new_fact_subject
        AND f.predicate = new_fact_predicate
        AND f.expired_at IS NULL  -- Only active facts
        -- Check temporal overlap
        AND tstzrange(f.valid_at, f.invalid_at) && 
            tstzrange(new_fact_valid_at, new_fact_invalid_at);
END;
$$ LANGUAGE plpgsql;
```

---

## TypeScript Schema

Add to `platform/src/db/schema.ts`:

```typescript
/**
 * Facts
 * 
 * Bi-temporal knowledge triples with four timestamps.
 * Subject → Predicate → Object
 */
export const facts = pgTable('facts', {
  id: uuid('id').primaryKey().defaultRandom(),
  
  // Triple
  subjectEntityId: uuid('subject_entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  predicate: varchar('predicate', { length: 255 }).notNull(),
  objectEntityId: uuid('object_entity_id').references(() => entities.id, { onDelete: 'set null' }),
  objectValue: text('object_value'),
  
  // Event time (when true in reality)
  validAt: timestamp('valid_at', { withTimezone: true }),
  invalidAt: timestamp('invalid_at', { withTimezone: true }),
  
  // Transaction time (when recorded)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiredAt: timestamp('expired_at', { withTimezone: true }),
  
  // Provenance
  sourceMemoryId: uuid('source_memory_id'),
  sourceText: text('source_text'),
  
  // Quality
  confidence: real('confidence').default(1.0),
}, (table) => ({
  subjectIdx: index('idx_facts_subject').on(table.subjectEntityId),
  predicateIdx: index('idx_facts_predicate').on(table.predicate),
}));

export const factsRelations = relations(facts, ({ one }) => ({
  subject: one(entities, {
    fields: [facts.subjectEntityId],
    references: [entities.id],
  }),
  object: one(entities, {
    fields: [facts.objectEntityId],
    references: [entities.id],
  }),
}));

/**
 * Fact Predicates
 * 
 * Ontology of relationship types
 */
export const factPredicates = pgTable('fact_predicates', {
  predicate: varchar('predicate', { length: 255 }).primaryKey(),
  description: text('description'),
  inversePredicate: varchar('inverse_predicate', { length: 255 }),
  predicateType: varchar('predicate_type', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Type exports
export type Fact = typeof facts.$inferSelect;
export type NewFact = typeof facts.$inferInsert;
export type FactPredicate = typeof factPredicates.$inferSelect;
```

---

## Facts Service

Create `platform/src/services/facts.ts`:

```typescript
import { db } from '../db/index.js';
import { facts, entities } from '../db/schema.js';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { embed } from './ml.js';

export interface CreateFactParams {
  subjectEntityId: string;
  predicate: string;
  objectEntityId?: string;
  objectValue?: string;
  validAt?: Date;
  invalidAt?: Date;
  sourceMemoryId?: string;
  sourceText?: string;
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
    confidence = 1.0,
  } = params;

  // Check for superseding facts
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

  // Generate embedding for fact text
  const factText = `${predicate} ${objectValue || ''}`.trim();
  const embeddingResult = await embed(factText);

  // Insert new fact
  const [fact] = await db
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
      confidence,
    })
    .returning({ id: facts.id });

  // Store embedding
  await db.execute(sql`
    UPDATE facts 
    SET fact_embedding = ${sql.raw(`'[${embeddingResult.vector.join(',')}]'::vector`)}
    WHERE id = ${fact.id}
  `);

  return fact.id;
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
  const result = await db.execute(sql`
    SELECT * FROM find_superseding_facts(
      ${subjectId}::uuid,
      ${predicate},
      ${validAt}::timestamptz,
      ${invalidAt || null}::timestamptz
    )
  `);

  // Fetch full fact records
  const factIds = result.rows.map((r: any) => r.fact_id);
  if (factIds.length === 0) return [];

  return db
    .select()
    .from(facts)
    .where(sql`id = ANY(${factIds})`);
}

/**
 * Expire a fact (mark as incorrect)
 */
export async function expireFact(factId: string, reason?: string): Promise<void> {
  await db
    .update(facts)
    .set({ expiredAt: new Date() })
    .where(and(
      eq(facts.id, factId),
      isNull(facts.expiredAt)
    ));
}

/**
 * Invalidate a fact (mark as no longer true)
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

  const conditions = [];
  if (asSubject) conditions.push(eq(facts.subjectEntityId, entityId));
  if (asObject) conditions.push(eq(facts.objectEntityId, entityId));

  return db
    .select()
    .from(facts)
    .where(and(
      sql`(${conditions.map(c => sql`${c}`).join(' OR ')})`,
      isNull(facts.expiredAt),
      sql`(invalid_at IS NULL OR invalid_at > NOW())`
    ));
}

/**
 * Query facts at a specific point in time
 */
export async function getFactsAtTime(queryTime: Date): Promise<Fact[]> {
  const result = await db.execute(sql`
    SELECT * FROM facts_at_time(${queryTime}::timestamptz)
  `);
  return result.rows as Fact[];
}

/**
 * Search facts by semantic similarity
 */
export async function searchFacts(
  query: string,
  options: { limit?: number; threshold?: number } = {}
): Promise<FactSearchResult[]> {
  const { limit = 10, threshold = 0.5 } = options;

  const embeddingResult = await embed(query);

  const results = await db.execute(sql`
    SELECT 
      f.*,
      1 - (fact_embedding <=> ${sql.raw(`'[${embeddingResult.vector.join(',')}]'::vector`)}) as similarity
    FROM facts f
    WHERE fact_embedding IS NOT NULL
      AND expired_at IS NULL
      AND 1 - (fact_embedding <=> ${sql.raw(`'[${embeddingResult.vector.join(',')}]'::vector`)}) > ${threshold}
    ORDER BY fact_embedding <=> ${sql.raw(`'[${embeddingResult.vector.join(',')}]'::vector`)}
    LIMIT ${limit}
  `);

  return results.rows.map((row: any) => ({
    fact: row as Fact,
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
```

---

## Temporal Extraction Prompt

For the LLM to extract temporal information:

```python
TEMPORAL_EXTRACTION_PROMPT = """
REFERENCE TIMESTAMP: {reference_timestamp}
MESSAGE: "{message}"

Extract temporal information for facts in this message.
Use the reference timestamp for relative dates.

For each fact found, determine:
- valid_at: When the relationship became true
- invalid_at: When it stopped being true (null if ongoing)

Examples:
- "I started at Acme two weeks ago" → valid_at = reference - 14 days, invalid_at = null
- "I used to work at TechCorp" → valid_at = unknown, invalid_at = some past date
- "I'm meeting John tomorrow" → valid_at = reference + 1 day, invalid_at = reference + 1 day

Output as JSON array:
[
  {
    "subject": "entity name",
    "predicate": "relationship",
    "object": "entity name or value",
    "valid_at": "ISO date or null",
    "invalid_at": "ISO date or null",
    "confidence": 0.0-1.0
  }
]
"""
```

---

## Testing

```typescript
// Test fact creation
const factId = await createFact({
  subjectEntityId: johnId,
  predicate: 'works_at',
  objectEntityId: acmeId,
  validAt: new Date('2024-01-15'),
  sourceText: 'I started at Acme in January',
});

// Test supersession
const newFactId = await createFact({
  subjectEntityId: johnId,
  predicate: 'works_at',
  objectEntityId: techCorpId,
  validAt: new Date('2025-01-01'),
  sourceText: 'I joined TechCorp this year',
});
// Old fact should be expired

// Test point-in-time query
const factsIn2024 = await getFactsAtTime(new Date('2024-06-01'));
// Should show John at Acme

// Test timeline
const timeline = await getEntityTimeline(johnId);
// Shows chronological fact history
```

---

## Acceptance Criteria

- [ ] `facts` table created with bi-temporal columns
- [ ] `fact_predicates` table seeded with common predicates
- [ ] `expire_fact()` function works
- [ ] `invalidate_fact()` function works
- [ ] `facts_at_time()` function works
- [ ] `find_superseding_facts()` function works
- [ ] Temporal exclusion constraint prevents overlaps
- [ ] TypeScript schema updated
- [ ] Facts service implements CRUD
- [ ] Supersession detection works
- [ ] Fact embeddings stored for similarity search

---

## Next Packet

After completing W17, proceed to:
- [W18: Apache AGE Graph](./W18-apache-age.md) - Graph traversal
- [W28: Conflict Resolution Agent](./W28-conflict-resolution.md) - Uses supersession
