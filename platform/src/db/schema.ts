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
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/**
 * Epics / Projects
 * 
 * High-level containers for related tasks and memories.
 * Auto-inferred from context or explicitly created.
 */
export const epics = pgTable('epics', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  status: varchar('status', { length: 20 }).default('active').notNull(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const epicsRelations = relations(epics, ({ many }) => ({
  tasks: many(tasks),
}));

/**
 * Tasks
 * 
 * Action items extracted from messages.
 * Linked to epics and source memories.
 */
export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  traceId: uuid('trace_id'),
  content: text('content').notNull(),
  dueDate: timestamp('due_date', { withTimezone: true }),
  priority: varchar('priority', { length: 10 }).default('medium').notNull(),
  status: varchar('status', { length: 20 }).default('pending').notNull(),
  epicId: uuid('epic_id').references(() => epics.id, { onDelete: 'set null' }),
  contextId: uuid('context_id'),  // References Qdrant context entity
  memoryId: uuid('memory_id'),    // References Qdrant memory
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const tasksRelations = relations(tasks, ({ one }) => ({
  epic: one(epics, {
    fields: [tasks.epicId],
    references: [epics.id],
  }),
}));

/**
 * Context Summaries
 * 
 * Living summaries of conversations.
 * Mirrors data in Qdrant for structured queries.
 */
export const contextSummaries = pgTable('context_summaries', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: varchar('conversation_id', { length: 255 }).unique().notNull(),
  platform: varchar('platform', { length: 50 }).notNull(),
  name: varchar('name', { length: 255 }),
  summary: text('summary'),
  messageCount: integer('message_count').default(0).notNull(),
  participantsJson: jsonb('participants_json').default('[]').notNull(),
  lastAnalyzedAt: timestamp('last_analyzed_at', { withTimezone: true }),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Processing State
 * 
 * Tracks message batching and processing status per conversation.
 * Used by the Context Updater background job.
 */
export const processingState = pgTable('processing_state', {
  conversationId: varchar('conversation_id', { length: 255 }).primaryKey(),
  pendingMessages: jsonb('pending_messages').default('[]').notNull(),
  messagesSinceUpdate: integer('messages_since_update').default(0).notNull(),
  lastProcessedAt: timestamp('last_processed_at', { withTimezone: true }),
  nextAnalysisAt: timestamp('next_analysis_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Settings
 * 
 * User configuration and preferences.
 */
export const settings = pgTable('settings', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ============================================
// PHASE 3: Knowledge Graph Tables
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
});

export const entityAliasesRelations = relations(entityAliases, ({ one }) => ({
  entity: one(entities, {
    fields: [entityAliases.entityId],
    references: [entities.id],
  }),
}));

/**
 * Entity Merges
 * 
 * Audit trail of entity deduplication operations
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
  // Phase 4 columns for schema alignment
  category: varchar('category', { length: 50 }),
  aliases: text('aliases').array().default([]),
  isCanonical: boolean('is_canonical').default(true),
  usageCount: integer('usage_count').default(0),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Context UUID Audit
 *
 * Tracks deterministic UUID usage for auditing and drift detection.
 * Maps generated context UUIDs back to their source platform + conversation_id.
 */
export const contextUuidAudit = pgTable('context_uuid_audit', {
  contextUuid: uuid('context_uuid').primaryKey(),
  platform: varchar('platform', { length: 50 }).notNull(),
  conversationId: varchar('conversation_id', { length: 255 }).notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow(),
});

// Type exports for use in application
export type Epic = typeof epics.$inferSelect;
export type NewEpic = typeof epics.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type ContextSummary = typeof contextSummaries.$inferSelect;
export type NewContextSummary = typeof contextSummaries.$inferInsert;
export type ProcessingState = typeof processingState.$inferSelect;
export type Setting = typeof settings.$inferSelect;

// Phase 3 types
export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type EntityAlias = typeof entityAliases.$inferSelect;
export type NewEntityAlias = typeof entityAliases.$inferInsert;
export type EntityMerge = typeof entityMerges.$inferSelect;
export type MemoryEntity = typeof memoryEntities.$inferSelect;
export type NewMemoryEntity = typeof memoryEntities.$inferInsert;
export type Fact = typeof facts.$inferSelect;
export type NewFact = typeof facts.$inferInsert;
export type FactPredicate = typeof factPredicates.$inferSelect;
export type ContextUuidAudit = typeof contextUuidAudit.$inferSelect;


