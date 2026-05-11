# Learn Schema + Test Housekeeping

Five concrete debt items identified in the learn platform, with confirmed-dead status on `quizAttempts.nmemoUpdates` via codebase grep:

## 1. Unbounded Overlay Growth (~100–500 rows/learner/year)
`lesson_overlays` table grows without compaction policy. Every `applyEditOp` call creates a new row. A learner actively editing lessons will accumulate hundreds of rows per section over months. Schema has UNIQUE(learner_id, section_id, version) and indexes, but no retention logic. Current footprint: negligible for POC (< 10K rows), but will scale into a scaling bottleneck post-launch.

**Status: Active debt. Requires policy + compaction job.**

## 2. Notes Archive Gap (~100–1000 rows/learner/year)  
`notes` table has no soft-delete or archive flag. Once `promoted_to_graph=1`, rows are essentially zombie data—shown in API calls, taking storage, but no user action can remove them. Dashboard has no filter to hide promoted notes from the note-creation surface. 

**Status: Active design debt. Functional but poor UX.**

## 3. chat_sessions FK Asymmetry (Documentation)
`chat_sessions.sectionId` is NOT foreign-keyed to `sections.id` (intentional per v0.3 design: sessions outlive sections). But this asymmetry—courseId *has* an FK, sectionId does *not*—is undocumented in the schema. Future maintainers will puzzle over it or accidentally add an FK, breaking the invariant.

**Status: Design hygiene issue. No code change needed, schema comment only.**

## 4. Dead JSON Column: `quizAttempts.nmemoUpdates` — CONFIRMED DEAD
Grep result: found 4 file matches, all writes-only:
- `schema.ts` line 58: column definition with `DEFAULT '[]'`
- `agents/chat-tutor.ts` lines 155, 316, 327, 336: populated inside structures built for chat messages (not quiz attempts)
- `routes/quiz.ts` line 90: written as `'[]'` but **never read**
- `routes/chat.ts` line 145: written if `result.nmemoUpdates.length > 0` (for *chat* message rows, not quiz attempts)

**Zero reads across the entire learn/ codebase.** Column serves no purpose. Migration will mark it for deprecation (set DEFAULT '[]', stop all writes) in this release; physical drop after a cooldown release.

**Status: Confirmed dead. Safe to deprecate now.**

## 5. No Learn-Side Test Harness (0 tests)
`learn/` package has zero test files. `package.json` has no vitest / test scripts. Platform has comprehensive tests (factories, setup.ts helpers, snapshot support), but every learn route and agent is untested. As graph-aware features (lesson generation, gap analysis, patrol) land, regressions are invisible.

**Status: Critical debt. Blocks safe refactoring and feature expansion.**

## Summary
- 4/5 items confirmed actionable (overlay compaction policy, notes archive route, FK comment, quizAttempts deprecation).
- 1/5 item is foundational (test harness).
- All fit within a single bead for schema hygiene + test bootstrap.
