# Design Specification: Learn Schema Hygiene + Test Bootstrap

## 1. Overlay Retention & Compaction

**Policy:** Keep latest 5 versions per (learner, section) + one weekly snapshot.

**Mechanism:**
- Add `isWeeklySnapshot` boolean column to `lesson_overlays` (migration adds column with DEFAULT 0).
- A job runs on-demand via `POST /api/admin/compact-overlays` (or called at boot during orphan-sweep).
- For each (learner, section) pair:
  - Count versions where `isWeeklySnapshot=0`. If > 5, delete oldest such rows until exactly 5 remain (preserving insertion order).
  - For snapshots (isWeeklySnapshot=1), keep newest 4 (roughly one per week over a month).
- SQL (drizzle pseudocode):
  ```typescript
  const toDelete = await db.select({ id: lessonOverlays.id })
    .from(lessonOverlays)
    .where(and(
      eq(lessonOverlays.learnerId, learner),
      eq(lessonOverlays.sectionId, section),
      eq(lessonOverlays.isWeeklySnapshot, 0)
    ))
    .orderBy(asc(lessonOverlays.createdAt))
    .limit(sql`(SELECT COUNT(*) - 5 FROM ${lessonOverlays} WHERE learner_id = ${learner} AND section_id = ${section} AND is_weekly_snapshot = 0)`)
  await db.delete(lessonOverlays).where(inArray(lessonOverlays.id, toDelete.map(r => r.id)))
  ```

**Non-destructive:** Compaction only removes the oldest rows, preserving recent history and snapshots.

---

## 2. Notes Archive

**Schema change:** Add `archivedAt` column to `notes` table (TEXT, nullable).

**Endpoints:**
- `POST /api/notes/:id/archive` — sets `archivedAt` to now, no hard-delete.
- `GET /api/notes?sectionId=…&include_archived=true|false` — default `false`. Filter excludes archived rows unless opt-in.
- Dashboard note-creation surface calls the GET endpoint without `include_archived`, so archived notes are invisible to learners creating new notes.

**Non-destructive:** Archived data stays in the database; if a learner changes their mind, a `POST /api/notes/:id/unarchive` can restore (sets `archivedAt` to NULL).

---

## 3. FK Asymmetry Documentation

**Code:** Add a comment to `lessonOverlays.sectionId` in `schema.ts`:
```typescript
sectionId: text('section_id'),  // NO FK intentional: overlays may outlive sections (v0.3 design invariant)
```

Also document `chat_sessions.sectionId`:
```typescript
sectionId: text('section_id'),  // NO FK intentional: sessions outlive deleted sections per v0.3 lifecycle model
```

**Rationale:** Sections are ephemeral during course redesign; lessons and chat threads are learner assets that survive section edits. This invariant is by design and must not be accidentally "fixed" by adding FKs.

---

## 4. Dead JSON Column: `quizAttempts.nmemoUpdates`

**Grep confirms:** Column is written but never read. (See description.md for evidence.)

**Migration approach (two-phase for safety):**
1. **Phase 1 (this bead):** Add migration that:
   - Creates a new migration file in `learn/src/db/migrations/`.
   - Drizzle approach: Use an ALTER statement to mark the column as deprecated. In practice, since SQLite has limited ALTER support, the migration:
     - Stops all writes to `nmemoUpdates` in code (quiz.ts line 90 → set `nmemoUpdates: null` or omit it).
     - Adds a comment in the route explaining the column is deprecated.
   - **No data loss yet** — column remains in the table for backward compat with any old client code.

2. **Phase 2 (future bead, 2+ releases later):** Drop the column via ALTER TABLE.

**Code changes:**
- `routes/quiz.ts` line 90: change `nmemoUpdates: '[]'` to `nmemoUpdates: null` or remove it entirely (drizzle will use DEFAULT).
- Confirm zero reads via grep (already done).

---

## 5. Test Harness Setup

**Structure:**
```
learn/
├── vitest.config.ts (new)
├── src/
│   ├── test/
│   │   ├── setup.ts (new, mirrors platform/src/test/setup.ts)
│   │   └── fixtures/
│   │       ├── lesson-overlay.test.ts
│   │       ├── chat-tutor.test.ts
│   │       ├── patrol-agent.test.ts
│   │       ├── learning-mcp.test.ts
│   │       └── lesson-generator.test.ts
```

**vitest.config.ts:**
```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});
```

**setup.ts:** (simplified version of platform pattern)
- `testDb`: LibSQL client connection to an ephemeral test database.
- `beforeEach`/`afterEach` hooks to truncate tables.
- Factory helpers: `createTestSection()`, `createTestQuestion()`, `createTestChatSession()`.
- Mock helpers for Nmemo client calls.

**Five representative tests:**

1. **chat-tutor: parseStructuredBlocks happy path + fallback wrapper**
   - Test that tutor correctly parses LessonBlock[] responses.
   - Fallback: if Nmemo returns plain markdown, wrap it as `{ type: 'markdown', content: ... }`.

2. **lesson-overlay: applyEditOp insert_block + version bump**
   - Insert a markdown block into an empty overlay.
   - Assert version increments from 0 → 1 → 2.
   - Verify UNIQUE(learner, section, version) race detection (concurrent write → 409).

3. **patrol-agent: parseReport handles missing trailer**
   - Patrol agent generates a report ending with a trailer line (e.g., "---").
   - Test that parser handles missing trailer gracefully (doesn't crash, extracts metadata).

4. **learning-mcp: write_insight idempotency on duplicate (type, entities)**
   - Write the same insight twice with identical type and entities.
   - Assert second write returns the same `id` (idempotency via `idempotencyKey` hash).

5. **lesson-generator: cold-start (no learner facts) produces canonical output**
   - Generate a lesson for a learner with zero prior facts.
   - Assert output is deterministic and matches a canonical snapshot.
   - Guards against accidental personalisation drift once nmemo-7si lands.

**package.json additions:**
```json
{
  "scripts": {
    "test": "vitest",
    "test:watch": "vitest --watch",
    "test:coverage": "vitest --coverage"
  },
  "devDependencies": {
    "@vitest/coverage-v8": "^1.0.0",
    "vitest": "^1.0.0"
  }
}
```

---

## 6. Migration Mechanics

**Drizzle approach:**
- New file: `learn/src/db/migrations/001_schema-hygiene-v0.2.ts`
- Exports an async `migrate()` function.
- Calls are sequenced in `migrate.ts`:
  ```typescript
  const migrations = [
    { name: '001_schema-hygiene-v0.2', fn: import('./migrations/001_schema-hygiene-v0.2.ts') }
  ];
  for (const m of migrations) {
    await m.fn.migrate();
    console.log(`Migration ${m.name} applied.`);
  }
  ```

**Migration contents:**
```typescript
export async function migrate() {
  const client = createClient({ url: `file:${config.DB_PATH}` });
  
  // Add isWeeklySnapshot to lesson_overlays
  await client.execute(`
    ALTER TABLE lesson_overlays ADD COLUMN is_weekly_snapshot INTEGER DEFAULT 0
  `).catch(err => {
    if (err.message.includes('duplicate column')) {
      console.log('Column already exists, skipping.');
    } else throw err;
  });

  // Add archivedAt to notes
  await client.execute(`
    ALTER TABLE notes ADD COLUMN archived_at TEXT
  `).catch(err => {
    if (err.message.includes('duplicate column')) {
      console.log('Column already exists, skipping.');
    } else throw err;
  });

  console.log('Schema hygiene migration complete.');
  await client.close();
}
```

---

## 7. CI Integration

**Out of scope for v1.** Flag as follow-up bead: "Learn platform CI: run tests on PR, enforce coverage floor."
