# Implementation Notes & Risk Analysis

## Risks

1. **Overlay compaction causes learner-valued history loss.** A learner may have edited a lesson dozens of times and values the fine-grained revert capability. Compacting to 5 versions erases that history. *Mitigation:* The policy is conservative (5 versions is generous for normal editing); learners can manually snapshot before major changes; future UI can offer "save as snapshot" before compaction runs.

2. **Archived notes *feel* deleted.** Once a note is archived, it disappears from the default note list, which may confuse learners who expect soft-delete to be reversible via UI. *Mitigation:* Document archive semantics clearly in dashboards; offer an "archived notes" section accessible from a tab or filter; ensure unarchive endpoint is discoverable.

3. **Tests freeze incorrect behaviour as canon.** The five representative tests guard against regressions, but if the current implementation has subtle bugs (e.g., lesson-generator personalisation is not deterministic), the snapshot test will canonicalize the bug. *Mitigation:* Review each test's subject (e.g., lesson-generator cold-start) before shipping to ensure it's correct; use visual review + manual QA before snapshot acceptance.

---

## Open Questions

1. **Should overlay compaction be opt-in per learner?** The design assumes a global 5-version policy, but some learners might want fewer or more. Alternative: Add a learner preference (e.g., `maxOverlayVersions` in user prefs) and check it during compaction. *Decision: Start with global policy; add learner prefs as a follow-up if usage data shows demand.*

2. **What's the right weekly-snapshot retention (4 weeks? 12)?** The design suggests keeping 4 snapshots (roughly 1 per week over a month). Is a month enough, or should we keep 12 weeks? *Decision: Start with 4 weeks; monitor storage and adjust post-launch.*

3. **Should archived notes be hard-deletable on a separate user action?** After archiving, should there be a "permanently delete" option after 30 days? Or should archive be the end of the lifecycle? *Decision: Archive is final for v1; permanent deletion is a future bead if GDPR/compliance requires it.*

4. **When should the compaction job run?** On-demand endpoint is safe but requires manual trigger. Should it run automatically on boot, once per day, or on every overlay edit? *Decision: On-demand endpoint + optional daily cron (flagged as follow-up CI bead).*

---

## Alternatives Considered

1. **Leave overlays unbounded, add UI to manually clean.** Puts the burden on learners to manage their own storage. Not acceptable for a launched product.

2. **Archive all promoted notes immediately.** Skip the soft-delete and archive promoted notes automatically. Risk: learners lose the note from search/recall before they realize it's promoted. Current approach (explicit archive action) is safer.

3. **Skip the test harness now, add it in other beads.** Tests are split across separate PRs and not co-located with implementation. Risk: tests lag implementation; regressions slip through. Current approach (bootstrapping a shared harness) is better.

---

## Code Paths & Line Ranges

- **schema.ts:**
  - `lessonOverlays` table definition (lines 146–153): add `isWeeklySnapshot` column in migration.
  - `notes` table definition (lines 158–167): add `archivedAt` column in migration.
  - `chatSessions` table definition (lines 62–72): add FK comment to `sectionId` (line 68).

- **lesson-overlay.ts:**
  - `applyEditOp` function (lines 208–245): insertion point for compaction job integration (call it after successful overlay insert to auto-trigger cleanup if > 5 versions).
  - Migration insertion point: new file `learn/src/db/migrations/001_schema-hygiene-v0.2.ts` with schema alterations.

- **routes/notes.ts:**
  - Add `POST /api/notes/:id/archive` endpoint (new, after current delete handler around line 114).
  - Add `POST /api/notes/:id/unarchive` endpoint (new).
  - Modify `GET /api/notes` query (lines 65–86) to filter on `archivedAt` based on query param.

- **routes/quiz.ts:**
  - Line 90: stop writing `nmemoUpdates` field or set to `null`.

- **routes/lesson-overlays.ts:**
  - Add `POST /api/admin/compact-overlays` endpoint (new admin route).

---

## Follow-ups

1. **CI integration (nmemo-???-ci).** Add GitHub Actions to run `pnpm test` on every PR in the `learn/` directory. Enforce > 80% coverage floor. Block merges on test failures.

2. **Full route coverage.** Current test harness covers 5 high-value paths; expand to cover error cases (400s, 404s, 409s from race conditions).

3. **Integration tests against live Nmemo platform.** Current tests mock Nmemo client; add integration tests that exercise real graph queries (record_fact, get_entity) against a running Nmemo instance.

4. **Learner preference for overlay retention.** Add `maxOverlayVersions` preference in user settings; check it during compaction.

5. **Dashboard archive filter.** UI surface for archived notes (currently no UI, just API).
