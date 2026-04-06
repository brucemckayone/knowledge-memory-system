import {
  pgTable,
  uuid,
  text,
  timestamp,
  varchar,
  integer,
  jsonb,
  real,
  boolean,
  unique,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ============================================
// Graph S: Knowledge Graph Tables
// ============================================

/**
 * Entities
 *
 * Canonical knowledge graph nodes representing people, places, concepts, etc.
 * Core of the knowledge graph with deduplication via aliases and merges.
 */
export const entities = pgTable('entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  canonicalName: varchar('canonical_name', { length: 500 }).notNull(),
  entityType: varchar('entity_type', { length: 100 }).notNull(),
  description: text('description'),
  properties: jsonb('properties').default({}).notNull(),
  mergedFrom: uuid('merged_from').array().default([]),
  confidence: real('confidence').default(1.0).notNull(),
  // Note: embedding handled directly via SQL (pgvector), not in Drizzle
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const entitiesRelations = relations(entities, ({ many }) => ({
  aliases: many(entityAliases),
  memoryLinks: many(memoryEntities),
}));

/**
 * Entity Aliases
 *
 * Alternative names for entities (nicknames, abbreviations, typos, merged names)
 */
export const entityAliases = pgTable('entity_aliases', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  alias: varchar('alias', { length: 500 }).notNull(),
  aliasType: varchar('alias_type', { length: 50 }),
  source: varchar('source', { length: 100 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueEntityAlias: unique().on(table.entityId, table.alias),
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
 * Audit trail for entity deduplication/merging operations.
 */
export const entityMerges = pgTable('entity_merges', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceEntityId: uuid('source_entity_id').notNull(),
  targetEntityId: uuid('target_entity_id').notNull().references(() => entities.id),
  mergeReason: text('merge_reason'),
  mergeMethod: varchar('merge_method', { length: 50 }),
  similarityScore: real('similarity_score'),
  mergedAt: timestamp('merged_at', { withTimezone: true }).defaultNow().notNull(),
  mergedBy: varchar('merged_by', { length: 100 }).default('system'),
});

/**
 * Memory Entities
 *
 * Links between memories (Qdrant) and entities (Postgres)
 */
export const memoryEntities = pgTable('memory_entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  memoryId: uuid('memory_id').notNull(),
  entityId: uuid('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  mentionText: varchar('mention_text', { length: 500 }),
  relationship: varchar('relationship', { length: 100 }).default('mentions'),
  mentionStart: integer('mention_start'),
  mentionEnd: integer('mention_end'),
  mentionContext: text('mention_context'),
  confidence: real('confidence').default(1.0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const memoryEntitiesRelations = relations(memoryEntities, ({ one }) => ({
  entity: one(entities, {
    fields: [memoryEntities.entityId],
    references: [entities.id],
  }),
}));

/**
 * Facts
 *
 * Bi-temporal knowledge triples with four timestamps.
 * Subject -> Predicate -> Object
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
  expireReason: text('expire_reason'),

  // Provenance
  sourceMemoryId: uuid('source_memory_id'),
  sourceText: text('source_text'),
  extractionMethod: varchar('extraction_method', { length: 100 }),

  // Quality
  confidence: real('confidence').default(1.0),
});

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
  isExclusive: boolean('is_exclusive').default(false),
  category: varchar('category', { length: 50 }),
  aliases: text('aliases').array().default([]),
  isCanonical: boolean('is_canonical').default(true),
  usageCount: integer('usage_count').default(0),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  // Staging lifecycle
  status: varchar('status', { length: 20 }).default('canonical'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
  distinctMemoryCount: integer('distinct_memory_count').default(0),
  promotedAt: timestamp('promoted_at', { withTimezone: true }),
  rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
});

/**
 * Entity Types Registry
 *
 * Dynamic entity type catalog — replaces the hardcoded CHECK constraint.
 * Types can be canonical, provisional (probation), or deprecated.
 */
export const entityTypes = pgTable('entity_types', {
  name: varchar('name', { length: 100 }).primaryKey(),
  description: text('description'),
  status: varchar('status', { length: 20 }).default('canonical').notNull(),
  promotedAt: timestamp('promoted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Entity Type History
 *
 * Tracks entity type changes for bi-temporal typing.
 * When an entity is reclassified, the old type is preserved here.
 */
export const entityTypeHistory = pgTable('entity_type_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  previousType: varchar('previous_type', { length: 100 }).notNull(),
  newType: varchar('new_type', { length: 100 }).notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow().notNull(),
  changedBy: varchar('changed_by', { length: 50 }).default('system'),
  reason: text('reason'),
});

// ============================================
// Graph C: Causal Graph Tables
// ============================================

/**
 * Causal Patterns
 *
 * Recurring causal chain archetypes detected from Graph C edges.
 * Lifecycle: staging → candidate → provisional → canonical
 */
export const causalPatterns = pgTable('causal_patterns', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }),
  description: text('description'),
  templateStructure: jsonb('template_structure').notNull(),
  templateLength: integer('template_length').notNull(),
  topologyType: varchar('topology_type', { length: 20 }),
  // Note: pattern_embedding handled directly via SQL (pgvector), not in Drizzle
  status: varchar('status', { length: 20 }).default('staging').notNull(),
  instanceCount: integer('instance_count').default(0).notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  promotedAt: timestamp('promoted_at', { withTimezone: true }),
  rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  avgTemporalSpan: text('avg_temporal_span'), // INTERVAL stored as text in Drizzle
  avgStrength: real('avg_strength'),
  activationCount30d: integer('activation_count_30d').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Causal Events
 *
 * State transitions in Graph S — the node type of Graph C.
 * Each fact change creates a causal event.
 */
export const causalEvents = pgTable('causal_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  factId: uuid('fact_id').references(() => facts.id),
  transitionType: varchar('transition_type', { length: 20 }).notNull(),
  subjectEntityId: uuid('subject_entity_id').references(() => entities.id),
  predicate: varchar('predicate', { length: 255 }),
  deltaConfidence: real('delta_confidence'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  // Note: event_embedding handled directly via SQL (pgvector), not in Drizzle
  sourceMemoryId: uuid('source_memory_id'),
  sourceText: text('source_text'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const causalEventsRelations = relations(causalEvents, ({ one }) => ({
  fact: one(facts, {
    fields: [causalEvents.factId],
    references: [facts.id],
  }),
  subjectEntity: one(entities, {
    fields: [causalEvents.subjectEntityId],
    references: [entities.id],
  }),
}));

/**
 * Causal Edges
 *
 * Directed causal links between transitions.
 * Every edge has reasoning (TEXT NOT NULL) and source_references (JSONB NOT NULL).
 */
export const causalEdges = pgTable('causal_edges', {
  id: uuid('id').primaryKey().defaultRandom(),
  causeEventId: uuid('cause_event_id').notNull().references(() => causalEvents.id),
  effectEventId: uuid('effect_event_id').notNull().references(() => causalEvents.id),
  strength: real('strength').default(0.5).notNull(),
  temporalSpan: text('temporal_span'), // INTERVAL stored as text in Drizzle
  extractionMethod: varchar('extraction_method', { length: 20 }).notNull(),
  reasoning: text('reasoning').notNull(),
  sourceReferences: jsonb('source_references').notNull(),
  pathwayEventIds: uuid('pathway_event_ids').array(),
  sourceMemoryId: uuid('source_memory_id'),
  sourceText: text('source_text'),
  corroborationCount: integer('corroboration_count').default(1).notNull(),
  lastCorroborated: timestamp('last_corroborated', { withTimezone: true }).defaultNow().notNull(),
  initialStrength: real('initial_strength').notNull(),
  decayApplied: boolean('decay_applied').default(false).notNull(),
  patternId: uuid('pattern_id').references(() => causalPatterns.id),
  patternPosition: integer('pattern_position'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiredAt: timestamp('expired_at', { withTimezone: true }),
  expireReason: text('expire_reason'),
});

export const causalEdgesRelations = relations(causalEdges, ({ one }) => ({
  causeEvent: one(causalEvents, {
    fields: [causalEdges.causeEventId],
    references: [causalEvents.id],
  }),
  effectEvent: one(causalEvents, {
    fields: [causalEdges.effectEventId],
    references: [causalEvents.id],
  }),
  pattern: one(causalPatterns, {
    fields: [causalEdges.patternId],
    references: [causalPatterns.id],
  }),
}));

// ============================================
// Type exports
// ============================================

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type EntityAlias = typeof entityAliases.$inferSelect;
export type NewEntityAlias = typeof entityAliases.$inferInsert;
export type EntityMerge = typeof entityMerges.$inferSelect;
export type NewEntityMerge = typeof entityMerges.$inferInsert;
export type MemoryEntity = typeof memoryEntities.$inferSelect;
export type NewMemoryEntity = typeof memoryEntities.$inferInsert;
export type Fact = typeof facts.$inferSelect;
export type NewFact = typeof facts.$inferInsert;
export type FactPredicate = typeof factPredicates.$inferSelect;
export type CausalEvent = typeof causalEvents.$inferSelect;
export type NewCausalEvent = typeof causalEvents.$inferInsert;
export type CausalEdge = typeof causalEdges.$inferSelect;
export type NewCausalEdge = typeof causalEdges.$inferInsert;
export type CausalPattern = typeof causalPatterns.$inferSelect;
export type NewCausalPattern = typeof causalPatterns.$inferInsert;
