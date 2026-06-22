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
 * Fact Sources
 *
 * One-to-many supporting memories per fact. Replaces the
 * facts.source_memory_id / facts.source_text singletons (which stay
 * readable during the migration window per bead nmemo-2yv.32 step 5(a),
 * but are now write-deprecated — every new corroboration appends a row
 * here instead of overwriting the singleton).
 *
 * observation_count increments on a repeat-observation of the same
 * (fact, memory) pair via INSERT ... ON CONFLICT DO UPDATE;
 * observed_at refreshes to the latest sighting.
 *
 * Defined in mig 029_fact_sources.sql.
 */
export const factSources = pgTable('fact_sources', {
  factId: uuid('fact_id').notNull().references(() => facts.id, { onDelete: 'cascade' }),
  memoryId: uuid('memory_id').notNull(),
  sourceText: text('source_text'),
  observedConfidence: real('observed_confidence'),
  observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow().notNull(),
  observationCount: integer('observation_count').default(1).notNull(),
});

export type FactSource = typeof factSources.$inferSelect;
export type NewFactSource = typeof factSources.$inferInsert;

/**
 * Fact Units (nmemo-yxj.6)
 *
 * ADDITIVE evidentiary index: links a fact to the small embedding unit(s)
 * (epic nmemo-yxj / yxj.2) whose char offsets cover the fact's source_text
 * span within its parent window. A SECOND, finer grain on top of the canonical
 * provenance — facts.source_memory_id STAYS the parent window and is never
 * moved onto units (the satellite invariant). Resolved persistence target per
 * design doc 38 §7 (graph-anchored fallback retrieval).
 *
 * unit_point_id is a STORED REFERENCE to a Qdrant unit satellite point id, NOT
 * an FK — units live in the Qdrant 'memories' collection, not Postgres. The
 * fallback join is fact_units -> unit_point_id -> Qdrant retrieve. Unit ids are
 * deterministic (uuidv5(memoryId, unitIndex) — see unitPointId in pipeline.ts)
 * so extract() reconstructs them from the window text alone (zero Qdrant reads).
 *
 * match_kind: 'offset_overlap' when the source_text span was located verbatim
 * in the window and mapped to overlapping unit(s); 'window_fallback' (a single
 * row keyed on the parent window id) when the span is not verbatim or repeats.
 *
 * Defined in mig 038_fact_units.sql.
 */
export const factUnits = pgTable('fact_units', {
  factId: uuid('fact_id').notNull().references(() => facts.id, { onDelete: 'cascade' }),
  unitPointId: text('unit_point_id').notNull(),
  charStart: integer('char_start'),
  charEnd: integer('char_end'),
  matchKind: varchar('match_kind', { length: 20 }).default('offset_overlap').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.factId, t.unitPointId] }),
  byFact: index('idx_fact_units_fact').on(t.factId),
  byUnit: index('idx_fact_units_unit').on(t.unitPointId),
}));

export type FactUnit = typeof factUnits.$inferSelect;
export type NewFactUnit = typeof factUnits.$inferInsert;

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
  // Per-predicate type pair for the multi-signal type-pair-overlap (doc 42 §4).
  subjectType: varchar('subject_type', { length: 50 }),
  objectType: varchar('object_type', { length: 50 }),
  // Note: embedding VECTOR(768) handled directly via SQL (pgvector), not in Drizzle (migration 045)
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

/**
 * Stream Participants (nmemo-3f9.1)
 *
 * Stream-scoped speaker identity: maps a (stream_id, speaker_key) to a single
 * entity deterministically, WITHOUT names or embeddings. Lets two streams that
 * both call their speaker "User" resolve to distinct entities — findOrCreateSpeaker
 * keys only on (stream_id, speaker_key), bypassing resolveEntity auto-merge and
 * createEntity name dedup. entity_id is an FK (a future merge re-points it).
 */
export const streamParticipants = pgTable('stream_participants', {
  streamId: text('stream_id').notNull(),
  speakerKey: text('speaker_key').notNull(),
  entityId: uuid('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  role: text('role'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.streamId, t.speakerKey] }),
  entityIdx: index('idx_stream_participants_entity').on(t.entityId),
}));

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
  // E6 (doc 41 §6, §12 #5): set by causal-promotion when a promoted edge cites an
  // INVALIDATED fact — the edge is kept (never auto-repointed) but flagged so the
  // next delta pass re-grounds or expires it. A superseded cited fact is NOT flagged.
  staleCitation: boolean('stale_citation').default(false).notNull(),
  staleCitationReason: text('stale_citation_reason'),
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
  // nmemo-2yv.52 — summary-specific staleness signal. Separate from updated_at
  // which is touched by every column writer (mention count, centroid, etc).
  // Read by /api/viz/unified + the viz entity-detail panel; written by the
  // causal agent's update_entity_summary tool alongside summary.
  summaryUpdatedAt: timestamp('summary_updated_at', { withTimezone: true }),
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
  // Bead nmemo-2yv.66: default relaxed to 'unknown' (mig 027). The handler
  // always supplies the actual caller actor; this default exists only so a
  // missing explicit value surfaces as 'unknown' in audit queries rather
  // than silently attributing to reconciliation_agent.
  createdBy: varchar('created_by', { length: 50 }).default('unknown').notNull(),
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
  // Freeform JSONB — consumer-defined, no canonical shape enforced anywhere.
  actionsTaken: jsonb('actions_taken').notNull().default({}),
  entityIds: uuid('entity_ids').array().notNull().default([]),
  factIds: uuid('fact_ids').array().notNull().default([]),
  causalEdgeIds: uuid('causal_edge_ids').array().notNull().default([]),
  // Server-side idempotency key (nmemo-2yv.77). One value per /api/reason
  // invocation, generated by the platform and forwarded to the python agent;
  // duplicate save_reasoning_report calls within the same pass UPSERT on this
  // column. Nullable for legacy callers that don't thread the id; uniqueness
  // is enforced by a partial index (WHERE invocation_id IS NOT NULL).
  invocationId: uuid('invocation_id'),
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

  // nmemo-2yv.102 — pre-mutation blast-radius severitySummary for the
  // fact/edge targeted by the resolution. For expire_both / expire_both_edges,
  // a record keyed by fact_a / fact_b / edge_a / edge_b. NULL on non-mutating
  // resolutions and legacy rows. Migration 023.
  preResolveBlastRadius: jsonb('pre_resolve_blast_radius'),
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

  // nmemo-2yv.102 — pre-mutation blast-radius severitySummary captured at the
  // moment of expire/invalidate. NULL for cascade-internal mutations and
  // legacy rows. Migration 023.
  preExpireBlastRadius: jsonb('pre_expire_blast_radius'),
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

  // nmemo-2yv.102 — pre-mutation blast-radius severitySummary captured at the
  // moment of edge expiry. NULL for cascade-internal mutations and legacy
  // rows. Migration 023.
  preExpireBlastRadius: jsonb('pre_expire_blast_radius'),
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

// ============================================
// Epoch v2: Propose/Promote staging buffer (doc 41 §3, §8a.4)
// ============================================

/**
 * Staging — proposed entities.
 *
 * Candidate entities written by extraction proposers (Phase 2) in per-epoch
 * isolation. NOT canonical: no AGE sync, no audit. `handle` is the server-minted
 * epoch-local id that proposedFacts reference; `anchorCanonicalId` is set when
 * the proposer anchored to a known entity (doc 41 §4). Promotion (E3) reads one
 * epoch's rows, resolves handles → canonical ids, and writes canonical once.
 * See migration 040_staging_proposals.sql.
 */
export const stagingProposedEntities = pgTable('staging_proposed_entities', {
  handle: uuid('handle').primaryKey().defaultRandom(),
  epochId: uuid('epoch_id').notNull(),
  sourceId: uuid('source_id'),
  name: text('name').notNull(),
  entityType: text('entity_type').notNull(),
  summary: text('summary'),
  anchorCanonicalId: uuid('anchor_canonical_id'),
  mentionText: text('mention_text'),
  proposedBy: varchar('proposed_by', { length: 32 }).default('extraction_proposer').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Staging — proposed facts.
 *
 * Entity refs are HANDLES, not canonical ids (doc 41 §3) — promotion rewrites
 * them after identity settles. `exclusiveGroup` is resolved at propose time from
 * the E1 shared ontology so promotion's group-aware supersession reuses it.
 * `undated` true ⟺ `validAt` null (DB CHECK). See migration 040.
 */
export const stagingProposedFacts = pgTable('staging_proposed_facts', {
  stagedFactId: uuid('staged_fact_id').primaryKey().defaultRandom(),
  epochId: uuid('epoch_id').notNull(),
  sourceId: uuid('source_id'),
  subjectHandle: uuid('subject_handle').notNull(),
  predicate: text('predicate').notNull(),
  objectHandle: uuid('object_handle'),
  objectValue: text('object_value'),
  validAt: timestamp('valid_at', { withTimezone: true }),
  undated: boolean('undated').default(false).notNull(),
  chunkIndex: integer('chunk_index'),
  confidence: real('confidence'),
  reasoning: text('reasoning'),
  exclusiveGroup: text('exclusive_group'),
  // VERIFY-phase supersession hint (E4, doc 41 §4): a prior-canonical fact id
  // this fact claims to supersede. Advisory — promotion cross-checks it against
  // its deterministic valid_at ordering. No FK (agent-supplied, may be stale).
  // See migration 042_staging_supersedes_hint.sql.
  supersedesFactId: uuid('supersedes_fact_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Arbiter verdicts (E5, doc 41 §8a.5, §12 #4) — the promotion-escalation arbiter's
 * disposal of an escalation, recorded against its dossier for replay reuse.
 *
 * Promotion pre-records the dossier (verdict null) keyed by (epochId, escalationKey);
 * a verdict tool (propose_identity_verdict / propose_conflict_resolution) fills the
 * verdict. escalationKey is the value-derived stable id of the escalation
 * (promotion-plan.ts) so a replayed promotion reuses the recorded verdict without
 * re-invoking the LLM. See migration 043_arbiter_verdicts.sql.
 */
export const arbiterVerdicts = pgTable(
  'arbiter_verdicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    epochId: uuid('epoch_id').notNull(),
    escalationKey: text('escalation_key').notNull(),
    kind: text('kind').notNull(),
    dossier: jsonb('dossier').notNull(),
    verdict: jsonb('verdict'),
    decidedBy: varchar('decided_by', { length: 32 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => ({
    epochKeyUniq: unique('arbiter_verdict_epoch_key_uniq').on(t.epochId, t.escalationKey),
    epochIdx: index('idx_arbiter_verdicts_epoch').on(t.epochId),
  }),
);

/**
 * Staging — proposed causal edges (E6, doc 41 §6, §8a.6).
 *
 * The post-promotion causal pass's propose_causal_edge buffer: the causal agent
 * reads SETTLED canonical and proposes edges between SETTLED causal events (minted
 * by promotion, §12 #5), writing HERE — never canonical. A deterministic
 * causal-promotion step disposes these into `causalEdges` (ref-resolve, self-loop
 * drop, dedup, cited-fact branch). Event ids are plain uuids (NOT FK) — ref-resolve
 * is a disposal step. The doc-01 invariant (non-empty reasoning + source_references)
 * is enforced structurally (migration 044_causal_pass.sql CHECKs).
 */
export const stagingCausalEdges = pgTable(
  'staging_causal_edges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    epochId: uuid('epoch_id').notNull(),
    causeEventId: uuid('cause_event_id').notNull(),
    effectEventId: uuid('effect_event_id').notNull(),
    reasoning: text('reasoning').notNull(),
    sourceReferences: jsonb('source_references').notNull(),
    proposedBy: varchar('proposed_by', { length: 32 }).default('causal_agent').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    epochIdx: index('idx_staging_causal_edges_epoch').on(t.epochId),
  }),
);

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
export type StagingProposedEntity = typeof stagingProposedEntities.$inferSelect;
export type NewStagingProposedEntity = typeof stagingProposedEntities.$inferInsert;
export type StagingProposedFact = typeof stagingProposedFacts.$inferSelect;
export type NewStagingProposedFact = typeof stagingProposedFacts.$inferInsert;
export type ArbiterVerdictRow = typeof arbiterVerdicts.$inferSelect;
export type NewArbiterVerdictRow = typeof arbiterVerdicts.$inferInsert;
export type StagingCausalEdge = typeof stagingCausalEdges.$inferSelect;
export type NewStagingCausalEdge = typeof stagingCausalEdges.$inferInsert;
