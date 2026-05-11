## Risks & Considerations

**Snooze UX decay:** Learners may snooze everything repeatedly rather than engage with content. Snooze becomes a soft dismiss if not paired with learner education (e.g., tooltip: "Snooze hides this for a week; if the signal is still true, we'll surface it again").

**Expiry hides useful signals:** A decay_warning for "binary search trees" that is 15 days old is auto-expired even if the learner genuinely needs the refresh. Mitigation: Keep TTLs long (21d for cross-course, 14d for others) and allow learner to manually un-dismiss if needed (e.g., "View archived insights").

**Performance: 3 new MCP tools double patrol run time.** Each tool adds a network round-trip and processing. Mitigate by:
- Running tools in parallel where possible (all three read tools can run concurrently; patrol agent can interleave calls).
- Tuning min_severity and status_filter thresholds to reduce result set size.
- Capping contradictions and patterns returned (e.g., limit=5 each).

**Importance scoring is harder to debug.** Deterministic formula is opaque to learners. If they see a contradiction_detected insight with low importance despite high severity, it's not obvious why. Solution: Add debug endpoint or log line showing deterministic * multiplier = final.

**New columns nullable by default.** Old insights will have snoozedUntil=NULL, dismissalKind=NULL. Queries must handle this explicitly or risk excluding old data. All queries in this design use `isNull(dismissalKind)` as the signal for "active", so old rows (NULL) are treated as active—this is correct and backward-compatible.

---

## Open Questions

1. **Snooze durations fixed or learner-chosen?** This design assumes fixed (7d, 30d). If learners should choose, add a snooze_until_date param to POST /api/insights/:id/dismiss. This adds UI complexity but gives more control.

2. **Auto-expired insights soft-undeletable?** Should learners see an "Archived insights" feed or a checkbox to "Show expired"? Currently, expired insights are hidden but queryable; surfacing them as a separate feed is a v1 follow-up.

3. **Does patrol see expired insights when deciding to re-emit?** This design answers "no" at the idempotency layer—patrol doesn't query old rows, just tries to insert. If the old row is dismissed, it's blocked; if the old row is expired-snooze, a new row is inserted. This is simpler than querying and comparing signals. Alternative: Patrol queries all old rows (expired or not) and decides whether to re-emit based on signal freshness. This design avoids the latter.

4. **Should contradiction insights link to the contradiction's resolution UI?** Currently, write_insight accepts actionable_url, so contradictions can link to /api/contradictions/:id/resolve or similar. Out-of-scope for this bead unless the platform's contradiction resolution UI is already public.

5. **Should find_prereq_gaps be a separate tool or baked into detect?** This design flags it as a follow-up. If learner facts already have predicate='lacks_prerequisite', querying them is cheaper than a new tool; see if the query-in-app approach works first.

---

## Alternatives Considered

**Skip snooze, just dismissal forever:** Simpler implementation (no snoozedUntil column). Trade-off: learners have no escape hatch for "I don't want to see this right now but maybe later". Dismissal becomes too permanent.

**Skip deterministic importance, just tune agent prompt:** Rely on agent prompt tuning ("be conservative with decay_warning importance") rather than formula. Pro: simpler. Con: harder to audit why importance=0.4 was assigned; formulaic approach is more reproducible.

**Expose contradictions/patterns directly as dashboard cards, skip patrol.** Don't emit contradiction_detected/pattern_emerging insights; instead, surface contradictions and patterns as their own dashboard cards (sibling to insights). Pro: decoupled. Con: contradictions/patterns are less integrated into the learner's adaptive flow; patrol-driven synthesis is higher-value.

**Use soft-delete (is_deleted flag) instead of dismissal kinds.** Simpler schema (one boolean). Trade-off: lose the distinction between "dismissed forever" and "snoozed"; can't re-emit after snooze expires unless you track snooze time separately, which adds a column back.

---

## Follow-up Bead Candidates

1. **Insights-as-feed reframe:** Insights currently show up as a card on the dashboard. Spin them out as a dedicated "Insights feed" page where learners can browse, filter by type, snooze in bulk, etc. (out-of-scope for patrol-layer, but natural UX evolution).

2. **Cron schedule expressivity:** PATROL_INTERVAL_MIN is a fixed interval. Allow PATROL_SCHEDULE (cron expression, e.g., "0 9 * * *" for 9am daily) so patrol runs align with learner activity patterns, not just server time.

3. **Per-type insight cap:** Currently 5 insights total per run. Should patrol allow, e.g., max 2 decay_warnings, max 1 pattern_emerging? Prevents decay_warnings from drowning out contradictions.

4. **Contradiction resolution UI:** Platform may not yet expose /api/contradictions/:id/resolve. If needed, bead to surface learner-facing UI for learners to review and mark contradictions as resolved.

5. **Prerequisite gap detection:** Formalize find_prereq_gaps as MCP tool or platform endpoint. Decide: should patrol surface prerequisite_gap insights, or only when learner is actively struggling (surfaced by the tutor)?
