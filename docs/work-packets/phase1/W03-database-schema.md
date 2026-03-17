# Work Packet W03: Database Schema

**Status:** ✅ COMPLETE  
**Completed:** 2026-01-24  
**Dependencies:** W02 (Docker Setup)  
**Estimated Time:** 30-45 minutes

---

## Implementation Progress

| Item | Status | Notes |
|------|--------|-------|
| drizzle.config.ts | ✅ Done | Uses `driver: 'pg'` format |
| src/db/schema.ts | ✅ Done | 5 tables defined |
| src/db/index.ts | ✅ Done | Client with health check |
| epics table | ✅ Done | |
| tasks table | ✅ Done | |
| context_summaries table | ✅ Done | |
| processing_state table | ✅ Done | |
| settings table | ✅ Done | |
| Migration applied | ✅ Done | Via `drizzle-kit push` |
| Type exports | ✅ Done | Epic, Task, etc. |

### Deviations from Spec
- Used `drizzle-kit push` instead of `drizzle-kit migrate` for faster iteration
- Configuration uses older `driver: 'pg'` format (works fine)

---

## Objective

Create PostgreSQL schema using Drizzle ORM with tables for tasks, epics, context summaries, and processing state.

---

## Prerequisites

- [ ] W02 completed (PostgreSQL running in Docker)
- [ ] `platform/` dependencies installed

---

## Step 1: Install Drizzle Kit

Already included in W01, but verify:

```bash
cd platform
pnpm add drizzle-orm postgres
pnpm add -D drizzle-kit
```

---

## Step 2: Create Drizzle Configuration

### platform/drizzle.config.ts

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgres://cognitive:cognitive@localhost:5432/cognitive',
  },
  verbose: true,
  strict: true,
});
```

---

## Step 3: Create Database Schema

### platform/src/db/schema.ts

```typescript
import {
  pgTable,
  uuid,
  text,
  timestamp,
  varchar,
  integer,
  jsonb,
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

// Type exports for use in application
export type Epic = typeof epics.$inferSelect;
export type NewEpic = typeof epics.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type ContextSummary = typeof contextSummaries.$inferSelect;
export type NewContextSummary = typeof contextSummaries.$inferInsert;
export type ProcessingState = typeof processingState.$inferSelect;
export type Setting = typeof settings.$inferSelect;
```

---

## Step 4: Create Database Client

### platform/src/db/index.ts

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import { config } from '../config.js';

// Create postgres connection
const client = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

// Create drizzle instance with schema
export const db = drizzle(client, { schema });

// Export schema for convenience
export * from './schema.js';

// Health check
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await client`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
```

---

## Step 5: Generate Migration

```bash
cd platform

# Generate migration from schema
pnpm drizzle-kit generate

# This creates a migration file in ./drizzle/
```

Expected output:
```
drizzle/
├── 0000_initial_schema.sql
└── meta/
    ├── 0000_snapshot.json
    └── _journal.json
```

---

## Step 6: Review Generated Migration

The generated SQL should look similar to:

```sql
-- drizzle/0000_initial_schema.sql

CREATE TABLE IF NOT EXISTS "epics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(255) NOT NULL,
  "description" text,
  "status" varchar(20) DEFAULT 'active' NOT NULL,
  "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trace_id" uuid,
  "content" text NOT NULL,
  "due_date" timestamp with time zone,
  "priority" varchar(10) DEFAULT 'medium' NOT NULL,
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "epic_id" uuid,
  "context_id" uuid,
  "memory_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ... more tables

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_epic_id_epics_id_fk" 
  FOREIGN KEY ("epic_id") REFERENCES "epics"("id") ON DELETE set null;
```

---

## Step 7: Run Migration

```bash
# Apply migration to database
pnpm drizzle-kit migrate

# Or use push for development (no migration files)
pnpm drizzle-kit push
```

---

## Step 8: Verify Tables

```bash
# Connect to database
docker compose exec postgres psql -U cognitive -d cognitive

# List tables
\dt

# Expected output:
#            List of relations
#  Schema |       Name        | Type  |  Owner   
# --------+-------------------+-------+----------
#  public | context_summaries | table | cognitive
#  public | epics             | table | cognitive
#  public | processing_state  | table | cognitive
#  public | settings          | table | cognitive
#  public | tasks             | table | cognitive

# Describe a table
\d tasks

# Exit
\q
```

---

## Step 9: Add Database Script

### platform/package.json (add script)

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:push": "drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  }
}
```

Use Drizzle Studio to browse data:
```bash
pnpm db:studio
# Opens browser at https://local.drizzle.studio
```

---

## Acceptance Criteria

- [x] `drizzle.config.ts` exists and is valid
- [x] `src/db/schema.ts` compiles without errors
- [x] `src/db/index.ts` compiles without errors
- [x] `pnpm drizzle-kit generate` creates migration *(used push instead)*
- [x] `pnpm drizzle-kit push` applies to database
- [x] All 5 tables exist in PostgreSQL
- [x] Foreign key constraint exists on tasks.epic_id
- [x] `pnpm drizzle-kit studio` opens successfully

---

## Next Packet

After completing W03, proceed to [W04-core-app.md](./W04-core-app.md).
