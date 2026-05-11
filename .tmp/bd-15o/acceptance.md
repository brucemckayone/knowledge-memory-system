# Acceptance Criteria

- **Overlay compaction:** After running the compaction job (via `POST /api/admin/compact-overlays`), verify no (learner, section) pair has more than 5 non-snapshot versions + 4 weekly snapshots. Query: `SELECT learner_id, section_id, COUNT(*) as cnt FROM lesson_overlays WHERE is_weekly_snapshot = 0 GROUP BY learner_id, section_id HAVING COUNT(*) > 5` returns zero rows.

- **Overlay retention:** Compaction preserves newest 5 versions and all snapshots. Oldest versions are deleted first (oldest ID removed, newest ID preserved). Verify by comparing row IDs before/after compaction.

- **Notes archive endpoint:** `POST /api/notes/:id/archive` sets `archivedAt` to ISO timestamp and returns 200. Archiving a note not found returns 404. Archiving twice is idempotent (second call returns 200 with the same `archivedAt`).

- **Notes visibility after archive:** `GET /api/notes?sectionId=X` (default `include_archived=false`) returns zero archived notes. Same query with `include_archived=true` includes all archived rows.

- **Notes unarchive endpoint:** `POST /api/notes/:id/unarchive` sets `archivedAt` to NULL and returns 200. Unarchived note reappears in default GET query.

- **FK asymmetry documented:** `schema.ts` lines for `lessonOverlays.sectionId` and `chat_sessions.sectionId` include inline comments explaining why FK is intentionally absent (overlays/sessions outlive sections).

- **Dead column writes stopped:** `routes/quiz.ts` line 90 no longer writes `nmemoUpdates` field (or writes `null`). Grep for `nmemoUpdates` in `learn/src/routes/quiz.ts` returns zero matches on write operations (schema definition and comments only).

- **Dead column reads confirmed zero:** Grep across entire `learn/` codebase for pattern `quizAttempts\.nmemoUpdates|\.nmemoUpdates\s*\)` returns zero matches (no destructuring or direct reads). All four grep-found files are schema definitions or chat-message writes, not quiz-attempt reads.

- **Test harness installed:** `learn/` directory contains `vitest.config.ts` and `src/test/setup.ts`. `package.json` has test scripts: `pnpm test` runs vitest and exits 0. `pnpm test:watch` starts watch mode.

- **Five tests passing:** `pnpm test` in `learn/` exits 0 with at least 5 tests passing:
  - `chat-tutor: parseStructuredBlocks happy path`
  - `lesson-overlay: applyEditOp insert_block version bump`
  - `patrol-agent: parseReport handles missing trailer`
  - `learning-mcp: write_insight idempotency`
  - `lesson-generator: cold-start canonical output`

- **Migrations applied without error:** Running `pnpm db:migrate` in `learn/` executes `001_schema-hygiene-v0.2.ts` and logs success. Rerunning is idempotent (duplicate-column errors are caught and skipped).

- **Schema introspection:** `SELECT sql FROM sqlite_master WHERE type='table' AND name='lesson_overlays'` shows `is_weekly_snapshot INTEGER DEFAULT 0` column. Same for `notes` showing `archived_at TEXT`.

- **No schema FKs added:** Verify `chat_sessions.section_id` still has no FOREIGN KEY constraint. Query: `PRAGMA foreign_key_list(chat_sessions);` shows no constraint on `section_id`.
