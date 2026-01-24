import {
  pgTable,
  uuid,
  text,
  timestamp,
  varchar,
  integer,
  jsonb,
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

// Type exports for use in application
export type Epic = typeof epics.$inferSelect;
export type NewEpic = typeof epics.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type ContextSummary = typeof contextSummaries.$inferSelect;
export type NewContextSummary = typeof contextSummaries.$inferInsert;
export type ProcessingState = typeof processingState.$inferSelect;
export type Setting = typeof settings.$inferSelect;
