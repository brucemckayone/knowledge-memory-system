import {
  pgTable,
  uuid,
  text,
  timestamp,
  varchar,
  integer,
  jsonb,
  real,
  doublePrecision,
  boolean,
  unique,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

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
// Graph M: Meta Layer Tables
// ============================================

/**
 * Entity Meta
 *
 * Per-entity statistics derived from source vectors and graph structure.
 * Centroid is the mean of all source memory vectors where the entity is mentioned.
 */
export const entityMeta = pgTable('entity_meta', {
  entityId: uuid('entity_id').primaryKey().references(() => entities.id, { onDelete: 'cascade' }),
  mentionCount: integer('mention_count').default(0).notNull(),
  sourceMemoryCount: integer('source_memory_count').default(0).notNull(),
  factCount: integer('fact_count').default(0).notNull(),
  // Note: centroid VECTOR(768) handled directly via SQL (pgvector), not in Drizzle
  spread: real('spread'),
  summary: text('summary'),
  firstMentionedAt: timestamp('first_mentioned_at', { withTimezone: true }),
  lastMentionedAt: timestamp('last_mentioned_at', { withTimezone: true }),
  lastReasonedAt: timestamp('last_reasoned_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Merge Candidates
 *
 * Pairwise entity analysis with three resolution signals.
 * Lifecycle: staging → candidate → provisional → resolved
 */
export const mergeCandidates = pgTable('merge_candidates', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityAId: uuid('entity_a_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  entityBId: uuid('entity_b_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  centroidSimilarity: real('centroid_similarity'),
  memoryOverlap: real('memory_overlap'),
  structuralSimilarity: real('structural_similarity'),
  combinedScore: real('combined_score').notNull(),
  status: varchar('status', { length: 20 }).default('staging').notNull(),
  detectionCount: integer('detection_count').default(1).notNull(),
  firstDetectedAt: timestamp('first_detected_at', { withTimezone: true }).defaultNow().notNull(),
  lastDetectedAt: timestamp('last_detected_at', { withTimezone: true }).defaultNow().notNull(),
  resolution: varchar('resolution', { length: 20 }),
  resolutionReasoning: text('resolution_reasoning'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: varchar('resolved_by', { length: 50 }),
  // Phase 4 — distinguishes 3-signal-scoring rows from cross-cluster-generator
  // rows. ON CONFLICT preserves an existing 'cross_cluster_generator' tag
  // (doc 25 §2.5 R3 B4 lock).
  candidateSource: varchar('candidate_source', { length: 40 }).default('three_signal_scoring').notNull(),
});

export const mergeCandidatesRelations = relations(mergeCandidates, ({ one }) => ({
  entityA: one(entities, { fields: [mergeCandidates.entityAId], references: [entities.id] }),
  entityB: one(entities, { fields: [mergeCandidates.entityBId], references: [entities.id] }),
}));

// ============================================
// Reconciliation Layer Tables
// ============================================

/**
 * Same-As Links
 *
 * Non-destructive identity links between entities that represent the same
 * real-world referent but carry different narrative meaning. Both entities
 * and their facts are preserved — this is a link, not a merge.
 *
 * Example: "the stranger" (described by Walton) ↔ "Victor Frankenstein" (self-narrator)
 */
export const sameAsLinks = pgTable('same_as_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityAId: uuid('entity_a_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  entityBId: uuid('entity_b_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  reasoning: text('reasoning').notNull(),
  sourceEvidence: jsonb('source_evidence').notNull().default([]),
  confidence: real('confidence').default(0.8).notNull(),
  createdBy: varchar('created_by', { length: 50 }).default('reconciliation_agent').notNull(),
  mergeCandidateId: uuid('merge_candidate_id').references(() => mergeCandidates.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniquePair: unique().on(table.entityAId, table.entityBId),
}));

/**
 * Extraction Reports
 *
 * Stored PHASE 6 structured reports from the graph agent.
 * Reconciliation agent reads these to find evidence of cross-entity
 * connections that the extraction agent noted but couldn't act on.
 */
export const extractionReports = pgTable('extraction_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  memoryId: uuid('memory_id').notNull(),
  reportText: text('report_text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Gardening Reports
 *
 * Stored reports from graph gardener agent sessions.
 * Each run explores the graph topology, consolidates entities,
 * and records what actions were taken with full reasoning.
 */
export const gardeningReports = pgTable('gardening_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  triggerType: varchar('trigger_type', { length: 20 }).default('manual').notNull(),
  runsSinceLast: integer('runs_since_last').default(0).notNull(),
  actions: jsonb('actions').default([]).notNull(),
  sameAsCreated: integer('same_as_created').default(0).notNull(),
  mergesExecuted: integer('merges_executed').default(0).notNull(),
  factsCreated: integer('facts_created').default(0).notNull(),
  summariesUpdated: integer('summaries_updated').default(0).notNull(),
  totalEntities: integer('total_entities'),
  totalComponents: integer('total_components'),
  islandsInvestigated: integer('islands_investigated').default(0).notNull(),
  reportText: text('report_text').notNull(),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

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
// ============================================
// Reasoning Reports
// ============================================

/**
 * Reasoning Reports
 *
 * Provenance for the reasoning agent. Each patrol or query pass produces
 * a report linked to the entities, facts, and causal edges it touched.
 * Future passes read prior reports to build on previous reasoning.
 */
export const reasoningReports = pgTable('reasoning_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  mode: varchar('mode', { length: 20 }).notNull(),
  question: text('question'),
  report: text('report').notNull(),
  actionsTaken: jsonb('actions_taken').notNull().default({}),
  entityIds: uuid('entity_ids').array().notNull().default([]),
  factIds: uuid('fact_ids').array().notNull().default([]),
  causalEdgeIds: uuid('causal_edge_ids').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ============================================
// Phase 5: Contradictions (migration 011_contradictions.sql)
// ============================================

/**
 * Contradictions
 *
 * First-class records for flagged conflicts: same-subject/predicate facts
 * with different objects, edges citing expired facts, causal cycles without
 * temporal separation, edges where cause occurs after effect, and (later)
 * agent-detected chain conflicts.
 *
 * Polymorphic: every row touches at least one of facts / causal_edges /
 * entities. The DB CHECK `at_least_one_node` enforces this.
 *
 * Detection populates rows; resolution closes them via the reasoning agent
 * (or user) supplying a resolution_type and reasoning. Resolution can chain
 * into expireFact / invalidateFact via the dispatcher in
 * `src/services/contradictions.ts`.
 */
export const contradictions = pgTable('contradictions', {
  id: uuid('id').primaryKey().defaultRandom(),
  contradictionType: varchar('contradiction_type', { length: 32 }).notNull(),

  // Polymorphic node references (at least one non-null per CHECK)
  factAId: uuid('fact_a_id').references(() => facts.id),
  factBId: uuid('fact_b_id').references(() => facts.id),
  edgeAId: uuid('edge_a_id').references(() => causalEdges.id),
  edgeBId: uuid('edge_b_id').references(() => causalEdges.id),
  entityId: uuid('entity_id').references(() => entities.id),

  // Detection metadata
  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
  detectedBy: varchar('detected_by', { length: 32 }).notNull(),
  detectionReasoning: text('detection_reasoning').notNull(),
  detectionContext: jsonb('detection_context'),
  severity: varchar('severity', { length: 10 }).default('medium').notNull(),

  // Resolution
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: varchar('resolved_by', { length: 32 }),
  resolutionType: varchar('resolution_type', { length: 20 }),
  resolutionReasoning: text('resolution_reasoning'),
  resolutionReportId: uuid('resolution_report_id').references(() => reasoningReports.id),

  // Dismissal / lifecycle
  dismissedReason: text('dismissed_reason'),
});

export type Contradiction = typeof contradictions.$inferSelect;
export type NewContradiction = typeof contradictions.$inferInsert;

// ============================================
// Phase 1: Audit Trail (migration 009_audit_trail.sql)
// ============================================

/**
 * Fact History — append-only log of every mutation to a fact.
 *
 * Every write to `facts` (create / expire / invalidate / confidence change /
 * revise / supersede / restore) emits exactly one row here, within the same
 * transaction. Never rewrite rows — corrections append a new event.
 */
export const factHistory = pgTable('fact_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  factId: uuid('fact_id').notNull().references(() => facts.id),
  eventType: varchar('event_type', { length: 20 }).notNull(),
  previousConfidence: real('previous_confidence'),
  newConfidence: real('new_confidence'),
  previousValidAt: timestamp('previous_valid_at', { withTimezone: true }),
  newValidAt: timestamp('new_valid_at', { withTimezone: true }),
  previousInvalidAt: timestamp('previous_invalid_at', { withTimezone: true }),
  newInvalidAt: timestamp('new_invalid_at', { withTimezone: true }),
  reasoning: text('reasoning').notNull(),
  sourceReferences: jsonb('source_references').notNull().default(sql`'[]'::jsonb`),
  reasoningReportId: uuid('reasoning_report_id').references(() => reasoningReports.id),
  causalEventId: uuid('causal_event_id').references(() => causalEvents.id),
  actor: varchar('actor', { length: 32 }).notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Causal Edge History — append-only log of every mutation to a causal edge.
 *
 * Same contract as `fact_history` scoped to `causal_edges`: create,
 * corroborate, strengthen, weaken, revise, expire, decay.
 */
export const causalEdgeHistory = pgTable('causal_edge_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  edgeId: uuid('edge_id').notNull().references(() => causalEdges.id),
  eventType: varchar('event_type', { length: 20 }).notNull(),
  previousStrength: real('previous_strength'),
  newStrength: real('new_strength'),
  previousReasoning: text('previous_reasoning'),
  newReasoning: text('new_reasoning'),
  addedSourceRefs: jsonb('added_source_refs'),
  reasoning: text('reasoning').notNull(),
  reasoningReportId: uuid('reasoning_report_id').references(() => reasoningReports.id),
  actor: varchar('actor', { length: 32 }).notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================
// Phase 3: Source Reference Indexing (migration 010_source_ref_index.sql)
// ============================================

/**
 * Edge Source Refs — denormalised reverse-lookup index for
 * `causal_edges.source_references`. The JSONB column on `causal_edges`
 * is the authoritative forward-facing format; this table is a derived
 * read index (cascade invalidation, blast radius, contradiction
 * detection, gardener context).
 *
 * No FK to facts/entities/memories — refs may point into Qdrant. Stale
 * refs are acceptable; they just don't match any lookup.
 */
export const edgeSourceRefs = pgTable('edge_source_refs', {
  edgeId: uuid('edge_id').notNull().references(() => causalEdges.id, { onDelete: 'cascade' }),
  refType: varchar('ref_type', { length: 10 }).notNull(),
  refId: uuid('ref_id').notNull(),
  relevance: text('relevance'),
}, (t) => ({
  pk: primaryKey({ columns: [t.edgeId, t.refType, t.refId] }),
  lookupIdx: index('idx_edge_source_refs_lookup').on(t.refType, t.refId),
  edgeIdx: index('idx_edge_source_refs_edge').on(t.edgeId),
}));

/**
 * Graph Stats (singleton)
 *
 * Aggregate graph-level statistics. Singleton enforced by CHECK (id = 1).
 * Phase 1 of cluster-bridging master plan (21). Spec:
 * docs/architecture/truth-graph/22-graph-stats-foundation.md.
 *
 * Cluster columns (embedding_cluster_count, mean_intra_cluster_distance,
 * mean_inter_cluster_distance) stay NULL until Phase 3 HDBSCAN ships.
 * `cluster_columns_version` is bumped by the Phase 3 backfill.
 */
export const graphStats = pgTable('graph_stats', {
  id: integer('id').primaryKey().default(1),

  // Scale
  totalEntities: integer('total_entities').default(0).notNull(),
  totalFacts: integer('total_facts').default(0).notNull(),
  totalActiveFacts: integer('total_active_facts').default(0).notNull(),
  totalMemories: integer('total_memories').default(0).notNull(),

  // Embedding clusters (NULL until Phase 3)
  embeddingClusterCount: integer('embedding_cluster_count'),
  meanIntraClusterDistance: doublePrecision('mean_intra_cluster_distance'),
  meanInterClusterDistance: doublePrecision('mean_inter_cluster_distance'),

  // Centroid distribution (sampled pairwise centroid similarity)
  centroidSimMean: doublePrecision('centroid_sim_mean'),
  centroidSimMedian: doublePrecision('centroid_sim_median'),
  centroidSimP10: doublePrecision('centroid_sim_p10'),
  centroidSimP90: doublePrecision('centroid_sim_p90'),
  centroidSampleSize: integer('centroid_sample_size'),

  // Graph health
  factDensity: doublePrecision('fact_density'),
  orphanRate: doublePrecision('orphan_rate'),
  predicateDiversity: integer('predicate_diversity'),
  mergeCandidatesPending: integer('merge_candidates_pending').default(0).notNull(),

  // Bookkeeping
  computedAt: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
  computedDurationMs: integer('computed_duration_ms'),
  computationVersion: integer('computation_version').default(1).notNull(),
  clusterColumnsVersion: integer('cluster_columns_version'),
});

export type GraphStats = typeof graphStats.$inferSelect;
export type NewGraphStats = typeof graphStats.$inferInsert;

export type Fact = typeof facts.$inferSelect;
export type NewFact = typeof facts.$inferInsert;
export type FactPredicate = typeof factPredicates.$inferSelect;
export type CausalEvent = typeof causalEvents.$inferSelect;
export type NewCausalEvent = typeof causalEvents.$inferInsert;
export type CausalEdge = typeof causalEdges.$inferSelect;
export type NewCausalEdge = typeof causalEdges.$inferInsert;
export type EdgeSourceRef = typeof edgeSourceRefs.$inferSelect;
export type NewEdgeSourceRef = typeof edgeSourceRefs.$inferInsert;
export type CausalPattern = typeof causalPatterns.$inferSelect;
export type NewCausalPattern = typeof causalPatterns.$inferInsert;
export type EntityMeta = typeof entityMeta.$inferSelect;
export type MergeCandidate = typeof mergeCandidates.$inferSelect;
export type SameAsLink = typeof sameAsLinks.$inferSelect;
export type NewSameAsLink = typeof sameAsLinks.$inferInsert;
export type ExtractionReport = typeof extractionReports.$inferSelect;
export type NewExtractionReport = typeof extractionReports.$inferInsert;
export type GardeningReport = typeof gardeningReports.$inferSelect;
export type NewGardeningReport = typeof gardeningReports.$inferInsert;
export type ReasoningReport = typeof reasoningReports.$inferSelect;
export type NewReasoningReport = typeof reasoningReports.$inferInsert;
export type FactHistory = typeof factHistory.$inferSelect;
export type NewFactHistory = typeof factHistory.$inferInsert;
export type CausalEdgeHistory = typeof causalEdgeHistory.$inferSelect;
export type NewCausalEdgeHistory = typeof causalEdgeHistory.$inferInsert;
