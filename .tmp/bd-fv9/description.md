## Problem Statement

The patrol agent currently emits at most 5 insights per cycle (decay_warning, cross_course_link, synthesis_candidate) but lacks:

1. **Dismissal + snooze:** Learners cannot snooze insights; dismissal is permanent but not surfaced in the UI. The schema has `dismissedAt` and `viewedAt`, but snooze durations do not exist. Once dismissed, an insight never re-appears even if underlying signals refresh.

2. **Per-type expiry:** Insights decay logically (a decay_warning for "binary search trees" remains visible forever). Need per-type TTLs: decay_warning (14d), cross_course_link (21d), synthesis_candidate (21d), prerequisite_gap (14d).

3. **Broader detection toolbelt:** The agent can call only 3 read tools. Platform exposes `getContradictions` and `getActivePatterns` in nmemo-client but these are NOT exposed as MCP tools. Prerequisite gaps exist in learner facts (predicate='lacks_prerequisite') but are not surfaced.

4. **Importance scoring:** Current agent prompt uses heuristic rules ("0.7 for well-established concepts", "0.5–0.7 for cross-course"). No deterministic formula; harder to audit and tune.

## Current State

- Schema: `insights` table has `dismissedAt`, `viewedAt`, `idempotencyKey` columns (line 84–99 of schema.ts).
- API: `/api/insights/:id/dismiss` sets dismissedAt; `/api/insights/:id/viewed` sets viewedAt (insights.ts:68–96).
- Dashboard filter: Excludes dismissed insights by default (dashboard.ts:279).
- MCP tools: 4 read tools exposed (get_decay_candidates, find_cross_course_overlaps, find_dense_clusters, write_insight).
- UI: Dashboard shows up to 5 insights (INSIGHTS_LIMIT=5, dashboard.ts:16); no dismiss/snooze button visible yet (examined Dashboard.js through line 299).
- Patrol cron: Drives agent every PATROL_INTERVAL_MIN minutes (patrol-cron.ts:119–129).

## Desired End-State

1. **Dismissal/snooze model:** Insights can be dismissed forever OR snoozed 7/30 days. Dashboard filter respects snooze window. Patrol can re-emit expired snoozes as fresh insights.
2. **Expiry:** Dashboard excludes insights older than their type's TTL. Old insights not shown, but can be re-emitted if the underlying signal still holds.
3. **Detection toolbelt:** Patrol agent can call 5 tools (add find_contradictions, find_active_patterns; prerequisite_gaps optional follow-up).
4. **Importance scoring:** Deterministic formula per detection type, stored separately from agent judgment. Final importance = clamp(deterministic * judgment_multiplier, 0, 1).
5. **Backwards compat:** Existing insights (with nullable new columns) remain queryable; no destructive migration.

