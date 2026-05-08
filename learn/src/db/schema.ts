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
  lessonBlocks: text('lesson_blocks'),                                     // JSON LessonBlock[] for v0.2 structured lessons; preferred over lessonContent when present
  lessonGeneratedAt: text('lesson_generated_at'),                          // ISO timestamp when last generated
  lessonReadMinutes: integer('lesson_read_minutes'),                       // estimated read time in minutes
  lessonKeyTakeaways: text('lesson_key_takeaways'),                        // JSON array of key takeaways
  // Async lesson-generation tracking. NULL on rows that have never been generated.
  lessonStatus: text('lesson_status'),                                     // 'building' | 'ready' | 'error'
  lessonStage: text('lesson_stage'),                                       // 'outlining' | 'writing_prose' | 'building_artifacts' | 'composing'
  lessonStartedAt: text('lesson_started_at'),                              // ISO timestamp when current/last generation started
  lessonError: text('lesson_error'),                                       // last failure message when status='error'
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
  // Section-scoped threads are the primary chat surface. One thread per
  // (learner, section); other surfaces (e.g. dashboard) may still create
  // section-less sessions where it makes sense.
  sectionId: text('section_id'),
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
  responseBlocks: text('response_blocks'), // JSON LessonBlock[] for structured tutor responses; null for plain-string responses
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
  // Patrol+insights lifecycle (nmemo-fv9). dismissalKind classifies how an
  // insight became inactive; null = active. snoozedUntil is set only when
  // dismissalKind='snoozed'.
  deterministicImportance: real('deterministic_importance'),                 // 0..1; null on legacy rows
  dismissalKind: text('dismissal_kind'),                                     // 'dismissed' | 'snoozed' | 'auto_expired' | null
  snoozedUntil: text('snoozed_until'),                                       // ISO timestamp; null when not snoozed
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

export const flashcards = sqliteTable('flashcards', {
  id: text('id').primaryKey(),
  conceptEntityId: text('concept_entity_id').notNull(),                      // Nmemo entity ID (no FK — external)
  courseId: text('course_id'),                                               // optional learn course scope
  frontText: text('front_text').notNull(),
  backText: text('back_text').notNull(),
  hintText: text('hint_text'),
  generatedAt: text('generated_at').notNull().default(sql`(datetime('now'))`),
  generationSource: text('generation_source').notNull(),                     // e.g. 'flashcard-generator', 'manual', 'imported'
});

export const flashcardReviews = sqliteTable('flashcard_reviews', {
  id: text('id').primaryKey(),
  flashcardId: text('flashcard_id').notNull(),                               // references flashcards.id; no FK so reviews survive card deletion
  learnerId: text('learner_id').notNull().default('default'),
  knew: integer('knew').notNull(),                                           // 1 = knew it, 0 = didn't
  reviewedAt: text('reviewed_at').notNull().default(sql`(datetime('now'))`),
});

export const articles = sqliteTable('articles', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),                                              // 'synthesis' | 'cross_course_summary'
  title: text('title').notNull(),
  contentMd: text('content_md').notNull(),
  relatedEntityIds: text('related_entity_ids').notNull().default('[]'),      // JSON array
  relatedCourseIds: text('related_course_ids').notNull().default('[]'),      // JSON array
  generatedAt: text('generated_at').notNull().default(sql`(datetime('now'))`),
  viewedAt: text('viewed_at'),
});

// v0.2 Lesson Evolution — per-learner overlays on top of section.lessonBlocks.
// Each (learner, section, version) triple is unique; the version column itself
// carries the history, so reverts read prior versions directly from this table.
// (No separate lesson_versions table — see migrate.ts decision note.)
export const lessonOverlays = sqliteTable('lesson_overlays', {
  id: text('id').primaryKey(),
  learnerId: text('learner_id').notNull().default('default'),
  sectionId: text('section_id').notNull(),                                   // references sections.id (no FK — overlays may outlive sections)
  blocks: text('blocks').notNull().default('[]'),                            // JSON LessonBlock[]
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// v0.2 Lesson Evolution — learner notes anchored to lesson excerpts.
// promotedToGraph = 1 once the note has been promoted into Nmemo as a fact;
// factId then carries the Nmemo fact id for traceability.
export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  learnerId: text('learner_id').notNull().default('default'),
  sectionId: text('section_id').notNull(),                                   // references sections.id (no FK — notes may outlive sections)
  anchorText: text('anchor_text').notNull(),                                 // the highlighted excerpt
  contentMd: text('content_md').notNull(),                                   // learner's note (markdown)
  promotedToGraph: integer('promoted_to_graph').notNull().default(0),        // SQLite boolean (0/1)
  factId: text('fact_id'),                                                   // Nmemo fact id once promoted; NULL otherwise
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});
