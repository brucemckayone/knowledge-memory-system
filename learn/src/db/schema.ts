import { sqliteTable, text, real, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const courses = sqliteTable('courses', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  topic: text('topic'),
  sourceType: text('source_type').notNull().default('generated'), // 'paste' | 'generated'
  sourceText: text('source_text'),
  nmemoMemoryId: text('nmemo_memory_id'),
  status: text('status').notNull().default('building'), // 'building' | 'ready'
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const sections = sqliteTable('sections', {
  id: text('id').primaryKey(),
  courseId: text('course_id').notNull().references(() => courses.id),
  title: text('title').notNull(),
  description: text('description'),
  learningObjectives: text('learning_objectives').notNull().default('[]'), // JSON array
  conceptEntityIds: text('concept_entity_ids').notNull().default('[]'),    // JSON array of Nmemo entity IDs
  orderIndex: integer('order_index').notNull().default(0),
  lessonContent: text('lesson_content'),                                   // markdown lesson body, null until generated
  lessonGeneratedAt: text('lesson_generated_at'),                          // ISO timestamp when last generated
  lessonReadMinutes: integer('lesson_read_minutes'),                       // estimated read time in minutes
  lessonKeyTakeaways: text('lesson_key_takeaways'),                        // JSON array of key takeaways
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const questions = sqliteTable('questions', {
  id: text('id').primaryKey(),
  sectionId: text('section_id').notNull().references(() => sections.id),
  questionText: text('question_text').notNull(),
  expectedAnswer: text('expected_answer'),
  explanation: text('explanation'),
  difficulty: integer('difficulty').notNull().default(3), // 1-5
  questionType: text('question_type').notNull().default('static'), // 'static' | 'generated'
  conceptEntityId: text('concept_entity_id'), // Nmemo entity ID this question tests
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const quizAttempts = sqliteTable('quiz_attempts', {
  id: text('id').primaryKey(),
  questionId: text('question_id').notNull().references(() => questions.id),
  learnerId: text('learner_id').notNull().default('default'),
  answerText: text('answer_text').notNull(),
  score: real('score'),                          // 0-1, null until evaluated
  feedback: text('feedback'),                    // evaluator's rich feedback shown to learner
  agentReasoning: text('agent_reasoning'),       // internal - what the agent found
  nmemoUpdates: text('nmemo_updates').notNull().default('[]'), // JSON array of MCP calls made
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const chatSessions = sqliteTable('chat_sessions', {
  id: text('id').primaryKey(),
  courseId: text('course_id').references(() => courses.id),
  learnerId: text('learner_id').notNull().default('default'),
  title: text('title'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const chatMessages = sqliteTable('chat_messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => chatSessions.id),
  role: text('role').notNull(), // 'user' | 'assistant'
  content: text('content').notNull(),
  nmemoUpdates: text('nmemo_updates'), // JSON: what agent recorded to graph (null if nothing)
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const insights = sqliteTable('insights', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),                                              // open vocabulary; patrol agent may invent new types
  title: text('title').notNull(),
  contentMd: text('content_md').notNull(),
  importance: real('importance').notNull().default(0.5),                     // 0..1
  relatedEntityIds: text('related_entity_ids').notNull().default('[]'),      // JSON array
  relatedCourseIds: text('related_course_ids').notNull().default('[]'),      // JSON array
  relatedFactIds: text('related_fact_ids').notNull().default('[]'),          // JSON array
  relatedSectionIds: text('related_section_ids').notNull().default('[]'),    // JSON array
  actionableUrl: text('actionable_url'),
  idempotencyKey: text('idempotency_key'),                                   // sha256(type + '|' + sorted_entity_ids); UNIQUE
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  dismissedAt: text('dismissed_at'),
  viewedAt: text('viewed_at'),
});

export const patrolRuns = sqliteTable('patrol_runs', {
  id: text('id').primaryKey(),
  startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
  finishedAt: text('finished_at'),
  status: text('status').notNull().default('running'),                       // 'running' | 'ok' | 'error'
  insightsProduced: integer('insights_produced').notNull().default(0),
  mcpCalls: integer('mcp_calls').notNull().default(0),
  durationMs: integer('duration_ms'),
  errorText: text('error_text'),
});
