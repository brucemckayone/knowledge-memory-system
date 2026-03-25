import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  varchar,
  integer,
  jsonb,
  real,
  boolean,
  unique,
  type AnyPgColumn,
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
 * Supports hierarchical decomposition and dependency tracking.
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

  // Hierarchy and decomposition (Migration 010)
  parentTaskId: uuid('parent_task_id').references((): AnyPgColumn => tasks.id, { onDelete: 'set null' }),
  hierarchyLevel: integer('hierarchy_level').default(0).notNull(),
  estimatedDurationMinutes: integer('estimated_duration_minutes'),
  durationConfidence: real('duration_confidence'),
  decompositionReasoning: text('decomposition_reasoning'),
  autoSuggestedDeadline: timestamp('auto_suggested_deadline', { withTimezone: true }),
  autoSuggestedPriority: varchar('auto_suggested_priority', { length: 20 }),
  suggestions: jsonb('suggestions').$type<string[]>().default([]),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  epic: one(epics, {
    fields: [tasks.epicId],
    references: [epics.id],
  }),
  parentTask: one(tasks, {
    fields: [tasks.parentTaskId],
    references: [tasks.id],
    relationName: 'taskHierarchy',
  }),
  subtasks: many(tasks, { relationName: 'taskHierarchy' }),
  dependenciesAsTask: many(taskDependencies, { relationName: 'dependencyTasks' }),
  dependenciesAsDependsOn: many(taskDependencies, { relationName: 'dependencyTargets' }),
  conflictsAsTask1: many(taskConflicts, { relationName: 'conflictTasks1' }),
  conflictsAsTask2: many(taskConflicts, { relationName: 'conflictTasks2' }),
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
 * Tracks per-conversation processing state for batched analysis.
 */
export const processingState = pgTable('processing_state', {
  conversationId: varchar('conversation_id', { length: 255 }).primaryKey().notNull(),
  pendingMessages: jsonb('pending_messages').default([]).notNull(),
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
  // Phase 4 columns for schema alignment
  category: varchar('category', { length: 50 }),
  aliases: text('aliases').array().default([]),
  isCanonical: boolean('is_canonical').default(true),
  usageCount: integer('usage_count').default(0),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  // Staging lifecycle (Phase B)
  status: varchar('status', { length: 20 }).default('canonical'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
  distinctMemoryCount: integer('distinct_memory_count').default(0),
  promotedAt: timestamp('promoted_at', { withTimezone: true }),
  rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
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
// PHASE 5: Task Enhancements Tables
// ============================================

/**
 * Task Dependencies
 *
 * Tracks prerequisite relationships between tasks.
 * A task can depend on another via blocking, prerequisite, or related relationships.
 */
export const taskDependencies = pgTable('task_dependencies', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  dependsOnTaskId: uuid('depends_on_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  dependencyType: varchar('dependency_type', { length: 50 }).notNull(),
  confidence: real('confidence').default(1.0),
  detectedBy: varchar('detected_by', { length: 50 }).default('llm'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueDependency: unique().on(table.taskId, table.dependsOnTaskId, table.dependencyType),
}));

export const taskDependenciesRelations = relations(taskDependencies, ({ one }) => ({
  task: one(tasks, {
    fields: [taskDependencies.taskId],
    references: [tasks.id],
    relationName: 'dependencyTasks',
  }),
  dependsOnTask: one(tasks, {
    fields: [taskDependencies.dependsOnTaskId],
    references: [tasks.id],
    relationName: 'dependencyTargets',
  }),
}));

/**
 * Task Conflicts
 *
 * Tracks detected conflicts between tasks that need resolution.
 * Conflicts can be temporal, resource, priority, or logical.
 */
export const taskConflicts = pgTable('task_conflicts', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId1: uuid('task_id_1').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  taskId2: uuid('task_id_2').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  conflictType: varchar('conflict_type', { length: 50 }).notNull(),
  severity: varchar('severity', { length: 20 }),
  description: text('description'),
  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolutionStatus: varchar('resolution_status', { length: 50 }).default('open'),
  resolutionAction: varchar('resolution_action'),
}, (table) => ({
  uniqueConflict: unique().on(table.taskId1, table.taskId2, table.conflictType),
}));

export const taskConflictsRelations = relations(taskConflicts, ({ one }) => ({
  task1: one(tasks, {
    fields: [taskConflicts.taskId1],
    references: [tasks.id],
    relationName: 'conflictTasks1',
  }),
  task2: one(tasks, {
    fields: [taskConflicts.taskId2],
    references: [tasks.id],
    relationName: 'conflictTasks2',
  }),
}));

/**
 * User Preferences
 *
 * Stores learned user behavior patterns for personalized task management.
 * Each preference has confidence and sample count for quality tracking.
 */
// ============================================
// Ingestion Sessions (Cross-Source Context Linking)
// ============================================

/**
 * Ingestion Sessions
 *
 * Groups temporally-close items from the same user into sessions.
 * Enables the context-linker agent to detect cross-item relationships.
 */
export const ingestionSessions = pgTable('ingestion_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  senderId: text('sender_id').notNull(),
  sessionKey: text('session_key').notNull().unique(),
  openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  memberCount: integer('member_count').default(0).notNull(),
  rawTypes: text('raw_types').array().notNull().default([]),
  platforms: text('platforms').array().notNull().default([]),
  sharedEntities: uuid('shared_entities').array().default([]),
  sharedTags: text('shared_tags').array().default([]),
  contextSummary: text('context_summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const ingestionSessionsRelations = relations(ingestionSessions, ({ many }) => ({
  members: many(ingestionSessionMembers),
}));

/**
 * Ingestion Session Members
 *
 * Links individual memories to their ingestion session.
 */
export const ingestionSessionMembers = pgTable('ingestion_session_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => ingestionSessions.id, { onDelete: 'cascade' }),
  memoryId: uuid('memory_id').notNull(),
  platform: text('platform').notNull(),
  rawType: text('raw_type').notNull(),
  contentPreview: text('content_preview'),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull(),
}, (table) => ({
  uniqueSessionMemory: unique().on(table.sessionId, table.memoryId),
}));

export const ingestionSessionMembersRelations = relations(ingestionSessionMembers, ({ one }) => ({
  session: one(ingestionSessions, {
    fields: [ingestionSessionMembers.sessionId],
    references: [ingestionSessions.id],
  }),
}));

// ============================================
// PHASE 3: Gardener Infrastructure (W22-W29)
// ============================================

/**
 * Gardener Job Meta
 *
 * Metadata and checkpointing for KARMA agent jobs.
 */
export const gardenerJobMeta = pgTable('gardener_job_meta', {
  jobId: uuid('job_id').primaryKey(),
  jobType: varchar('job_type', { length: 100 }),
  tier: varchar('tier', { length: 20 }),
  priority: integer('priority').default(0),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  attempts: integer('attempts').default(0),
  checkpoint: jsonb('checkpoint'),
  checkpointAt: timestamp('checkpoint_at', { withTimezone: true }),
  lastError: text('last_error'),
  traceId: text('trace_id'),
  outputs: jsonb('outputs'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Gardener Metrics
 *
 * Agent execution metrics for quality tracking and the evaluator agent.
 */
export const gardenerMetrics = pgTable('gardener_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id'),
  agentName: varchar('agent_name', { length: 100 }).notNull(),
  executionTimeMs: integer('execution_time_ms'),
  success: boolean('success'),
  qualityScore: real('quality_score'),
  itemsProcessed: integer('items_processed').default(0),
  errorMessage: text('error_message'),
  agentSpecificMetrics: jsonb('agent_specific_metrics').default({}),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow(),
});

/**
 * Memory Chunks
 *
 * Chunked content for processing long memories (ingestion agent W22).
 */
export const memoryChunks = pgTable('memory_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  memoryId: text('memory_id').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  content: text('content').notNull(),
  charCount: integer('char_count').notNull(),
  tokenEstimate: integer('token_estimate'),
  overlapChars: integer('overlap_chars').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, (table) => ({
  uniqueMemoryChunk: unique().on(table.memoryId, table.chunkIndex),
}));

/**
 * Memory Metadata
 *
 * Parsed content metadata from the reader agent (W23).
 */
export const memoryMetadata = pgTable('memory_metadata', {
  id: uuid('id').primaryKey().defaultRandom(),
  memoryId: text('memory_id').notNull().unique(),
  contentType: varchar('content_type', { length: 50 }),
  title: varchar('title', { length: 500 }),
  summary: text('summary'),
  extractedDates: jsonb('extracted_dates').default([]),
  extractedLinks: jsonb('extracted_links').default([]),
  extractedTags: text('extracted_tags').array().default([]),
  mentionedEntities: text('mentioned_entities').array().default([]),
  wordCount: integer('word_count'),
  language: varchar('language', { length: 10 }),
  sentiment: varchar('sentiment', { length: 20 }),
  parsedAt: timestamp('parsed_at', { withTimezone: true }).defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/**
 * Memory Summaries
 *
 * Generated summaries from the summarizer agent (W24).
 */
export const memorySummaries = pgTable('memory_summaries', {
  id: uuid('id').primaryKey().defaultRandom(),
  memoryId: text('memory_id').notNull(),
  summaryType: varchar('summary_type', { length: 50 }).default('standard'),
  summary: text('summary').notNull(),
  keyPoints: jsonb('key_points').default([]),
  embeddingUpdated: boolean('embedding_updated').default(false),
  modelUsed: varchar('model_used', { length: 100 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ============================================
// PHASE 6: Source Adapter Framework (W34)
// ============================================

/**
 * Content Hashes
 *
 * Deduplication table for ingested content.
 * Stores SHA-256 hashes to prevent reprocessing identical content.
 */
export const contentHashes = pgTable('content_hashes', {
  id: uuid('id').primaryKey().defaultRandom(),
  hash: varchar('hash', { length: 64 }).notNull().unique(),
  source: varchar('source', { length: 50 }).notNull(),
  itemId: varchar('item_id', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Ingest Sources
 *
 * Tracks active source adapters and their channels.
 * Used for monitoring which sources are feeding the system.
 */
export const ingestSources = pgTable('ingest_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceName: varchar('source_name', { length: 50 }).notNull(),
  channelId: varchar('channel_id', { length: 255 }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  itemCount: integer('item_count').notNull().default(0),
  config: jsonb('config').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueSourceChannel: unique().on(table.sourceName, table.channelId),
}));

// ============================================
// PHASE 5: Briefings & Memory Meta (W32)
// ============================================

/**
 * Briefings
 *
 * Daily briefing digests generated for the user.
 */
export const briefings = pgTable('briefings', {
  id: uuid('id').primaryKey().defaultRandom(),
  briefingDate: date('briefing_date', { mode: 'date' }).notNull().unique(),
  summary: text('summary').notNull(),
  sections: jsonb('sections').notNull().default([]),
  insightCount: integer('insight_count').notNull().default(0),
  taskCount: integer('task_count').notNull().default(0),
  memoryCount: integer('memory_count').notNull().default(0),
  generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Memories Meta
 *
 * Importance scoring and access tracking for memories.
 */
export const memoriesMeta = pgTable('memories_meta', {
  memoryId: uuid('memory_id').primaryKey(),
  importanceScore: real('importance_score').default(0.5),
  accessCount: integer('access_count').default(0),
  lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
  decayFactor: real('decay_factor').default(1.0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ============================================
// PHASE 6: Conversation Context (W44)
// ============================================

/**
 * Conversation State
 *
 * Tracks adaptive conversation windows for stream sources.
 * Each active conversation has one state record; closed on topic drift or timeout.
 */
export const conversationState = pgTable('conversation_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: varchar('source', { length: 50 }).notNull(),
  channelId: varchar('channel_id', { length: 255 }).notNull(),
  messageCount: integer('message_count').notNull().default(0),
  windowStart: timestamp('window_start', { withTimezone: true }).defaultNow().notNull(),
  windowEnd: timestamp('window_end', { withTimezone: true }),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow().notNull(),
  topicDriftScore: real('topic_drift_score').default(0.0),
  active: boolean('active').notNull().default(true),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueActiveConversation: unique().on(table.source, table.channelId, table.active),
}));

/**
 * Conversation Summaries
 *
 * Rolling summaries of conversation windows.
 * Generated when a conversation window closes.
 */
export const conversationSummaries = pgTable('conversation_summaries', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationStateId: uuid('conversation_state_id').notNull().references(() => conversationState.id, { onDelete: 'cascade' }),
  summary: text('summary').notNull(),
  keyTopics: text('key_topics').array().notNull().default([]),
  participantCount: integer('participant_count').default(1),
  messageCount: integer('message_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ============================================
// PHASE 6: Obsidian Sync State (W39)
// ============================================

/**
 * Obsidian Sync State
 *
 * Tracks which vault files have been synced and their content hashes.
 * Prevents re-ingesting unchanged files.
 */
export const obsidianSyncState = pgTable('obsidian_sync_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  vaultPath: text('vault_path').notNull(),
  filePath: text('file_path').notNull(),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).defaultNow().notNull(),
  memoryId: uuid('memory_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueVaultFile: unique().on(table.vaultPath, table.filePath),
}));

// ============================================
// PHASE 6: Channel Profiles (W43)
// ============================================

/**
 * Channel Profiles
 *
 * Per-channel/source processing configuration.
 * Controls chunking, extraction, and priority for each ingest channel.
 */
export const channelProfiles = pgTable('channel_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: varchar('source', { length: 50 }).notNull(),
  channelId: varchar('channel_id', { length: 255 }).notNull(),
  profileName: varchar('profile_name', { length: 100 }).notNull().default('default'),
  config: jsonb('config').notNull().default({}),
  extractionStrategy: varchar('extraction_strategy', { length: 50 }).notNull().default('standard'),
  chunkingEnabled: boolean('chunking_enabled').notNull().default(true),
  chunkSize: integer('chunk_size').notNull().default(4000),
  chunkOverlap: integer('chunk_overlap').notNull().default(200),
  entityExtraction: boolean('entity_extraction').notNull().default(true),
  relationshipExtraction: boolean('relationship_extraction').notNull().default(true),
  taskExtraction: boolean('task_extraction').notNull().default(true),
  priority: varchar('priority', { length: 20 }).notNull().default('normal'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueSourceChannel: unique().on(table.source, table.channelId),
}));

// ============================================
// PHASE 5: Communities (W30)
// ============================================

/**
 * Communities
 *
 * Clusters of related entities detected via Louvain community detection.
 * Used for insight generation and knowledge landscape mapping.
 */
export const communities = pgTable('communities', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }),
  description: text('description'),
  entityIds: uuid('entity_ids').array().notNull().default([]),
  coherenceScore: real('coherence_score').default(0.0),
  size: integer('size').notNull().default(0),
  metadata: jsonb('metadata').default({}),
  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ============================================
// PHASE 5: Insights (W31)
// ============================================

/**
 * Insights
 *
 * AI-generated insights from community analysis and pattern detection.
 */
export const insights = pgTable('insights', {
  id: uuid('id').primaryKey().defaultRandom(),
  communityId: uuid('community_id').references(() => communities.id, { onDelete: 'set null' }),
  insightType: varchar('insight_type', { length: 50 }).notNull(),
  title: varchar('title', { length: 500 }).notNull(),
  body: text('body').notNull(),
  entityIds: uuid('entity_ids').array().notNull().default([]),
  confidence: real('confidence').notNull().default(0.5),
  relevanceScore: real('relevance_score').notNull().default(0.5),
  metadata: jsonb('metadata').default({}),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ============================================
// PHASE 5: Contradiction Reviews (W33)
// ============================================

/**
 * Contradiction Reviews
 *
 * Records results of scheduled contradiction scanning.
 * Tracks which fact pairs were reviewed, the type of contradiction,
 * and the resolution applied or pending human review.
 */
export const contradictionReviews = pgTable('contradiction_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  factId1: uuid('fact_id_1').notNull().references(() => facts.id, { onDelete: 'cascade' }),
  factId2: uuid('fact_id_2').notNull().references(() => facts.id, { onDelete: 'cascade' }),
  contradictionType: varchar('contradiction_type', { length: 50 }).notNull(),
  resolution: varchar('resolution', { length: 50 }).notNull(),
  confidence: real('confidence').notNull().default(0.5),
  reasoning: text('reasoning'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: varchar('resolved_by', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ============================================
// PHASE 6: Project Associations (W45)
// ============================================

/**
 * Project Associations
 *
 * Auto-detected or user-defined project groupings.
 * Binds related entities, tags, and source channels together.
 */
export const projectAssociations = pgTable('project_associations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 500 }).notNull(),
  description: text('description'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  entityIds: uuid('entity_ids').array().notNull().default([]),
  tagPatterns: text('tag_patterns').array().notNull().default([]),
  autoDetected: boolean('auto_detected').notNull().default(true),
  confidence: real('confidence').notNull().default(0.5),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Source Bindings
 *
 * Links projects to specific source/channel pairs.
 */
export const sourceBindings = pgTable('source_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projectAssociations.id, { onDelete: 'cascade' }),
  source: varchar('source', { length: 50 }).notNull(),
  channelId: varchar('channel_id', { length: 255 }).notNull(),
  bindingType: varchar('binding_type', { length: 50 }).notNull().default('auto'),
  confidence: real('confidence').notNull().default(0.5),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueProjectSourceChannel: unique().on(table.projectId, table.source, table.channelId),
}));

/**
 * Association Ambiguities
 *
 * Records cases where a memory could belong to multiple projects.
 * Surfaced for user resolution.
 */
export const associationAmbiguities = pgTable('association_ambiguities', {
  id: uuid('id').primaryKey().defaultRandom(),
  memoryId: uuid('memory_id').notNull(),
  candidateProjectIds: uuid('candidate_project_ids').array().notNull().default([]),
  scores: jsonb('scores').notNull().default({}),
  resolvedProjectId: uuid('resolved_project_id').references(() => projectAssociations.id, { onDelete: 'set null' }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: varchar('resolved_by', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const userPreferences = pgTable('user_preferences', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: varchar('user_id', { length: 255 }).notNull(),
  preferenceKey: varchar('preference_key', { length: 100 }).notNull(),
  preferenceValue: jsonb('preference_value').notNull(),
  confidence: real('confidence').default(0.5),
  lastObservedAt: timestamp('last_observed_at', { withTimezone: true }).defaultNow().notNull(),
  sampleCount: integer('sample_count').default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueUserPreference: unique().on(table.userId, table.preferenceKey),
}));

// Type exports for use in application
export type Epic = typeof epics.$inferSelect;
export type NewEpic = typeof epics.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type ContextSummary = typeof contextSummaries.$inferSelect;
export type NewContextSummary = typeof contextSummaries.$inferInsert;
export type Setting = typeof settings.$inferSelect;

// Phase 3 types
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
export type ContextUuidAudit = typeof contextUuidAudit.$inferSelect;

// Gardener types
export type GardenerJobMeta = typeof gardenerJobMeta.$inferSelect;
export type GardenerMetric = typeof gardenerMetrics.$inferSelect;
export type MemoryChunk = typeof memoryChunks.$inferSelect;
export type NewMemoryChunk = typeof memoryChunks.$inferInsert;
export type MemoryMetadataRecord = typeof memoryMetadata.$inferSelect;
export type MemorySummary = typeof memorySummaries.$inferSelect;
export type NewMemorySummary = typeof memorySummaries.$inferInsert;

// Phase 5 types
export type TaskDependency = typeof taskDependencies.$inferSelect;
export type NewTaskDependency = typeof taskDependencies.$inferInsert;
export type TaskConflict = typeof taskConflicts.$inferSelect;
export type NewTaskConflict = typeof taskConflicts.$inferInsert;
export type UserPreference = typeof userPreferences.$inferSelect;
export type NewUserPreference = typeof userPreferences.$inferInsert;

// Briefing types
export type Briefing = typeof briefings.$inferSelect;
export type NewBriefing = typeof briefings.$inferInsert;
export type MemoryMeta = typeof memoriesMeta.$inferSelect;
export type NewMemoryMeta = typeof memoriesMeta.$inferInsert;

// Conversation context types
export type ConversationState = typeof conversationState.$inferSelect;
export type NewConversationState = typeof conversationState.$inferInsert;
export type ConversationSummaryRecord = typeof conversationSummaries.$inferSelect;
export type NewConversationSummaryRecord = typeof conversationSummaries.$inferInsert;

// Obsidian sync types
export type ObsidianSyncState = typeof obsidianSyncState.$inferSelect;
export type NewObsidianSyncState = typeof obsidianSyncState.$inferInsert;

// Channel profile types
export type ChannelProfile = typeof channelProfiles.$inferSelect;
export type NewChannelProfile = typeof channelProfiles.$inferInsert;

// Community types
export type Community = typeof communities.$inferSelect;
export type NewCommunity = typeof communities.$inferInsert;

// Source adapter types
export type ContentHash = typeof contentHashes.$inferSelect;
export type NewContentHash = typeof contentHashes.$inferInsert;
export type IngestSource = typeof ingestSources.$inferSelect;
export type NewIngestSource = typeof ingestSources.$inferInsert;

// Insight types
export type Insight = typeof insights.$inferSelect;
export type NewInsight = typeof insights.$inferInsert;

// Contradiction review types
export type ContradictionReview = typeof contradictionReviews.$inferSelect;
export type NewContradictionReview = typeof contradictionReviews.$inferInsert;

// Project association types
export type ProjectAssociation = typeof projectAssociations.$inferSelect;
export type NewProjectAssociation = typeof projectAssociations.$inferInsert;
export type SourceBinding = typeof sourceBindings.$inferSelect;
export type NewSourceBinding = typeof sourceBindings.$inferInsert;
export type AssociationAmbiguity = typeof associationAmbiguities.$inferSelect;
export type NewAssociationAmbiguity = typeof associationAmbiguities.$inferInsert;

// Ingestion session types
export type IngestionSession = typeof ingestionSessions.$inferSelect;
export type NewIngestionSession = typeof ingestionSessions.$inferInsert;
export type IngestionSessionMember = typeof ingestionSessionMembers.$inferSelect;
export type NewIngestionSessionMember = typeof ingestionSessionMembers.$inferInsert;
