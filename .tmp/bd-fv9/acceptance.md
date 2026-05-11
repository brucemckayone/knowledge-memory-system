- Dismissal forever: POST /api/insights/:id/dismiss?kind=dismiss_forever sets dismissalKind='dismissed' and dismissedAt=now(); subsequent patrol runs do NOT re-emit this insight even if the underlying signal refreshes (idempotency check blocks it).

- Snooze 7d: POST /api/insights/:id/dismiss?kind=snooze_7d sets dismissalKind='snoozed', snoozedUntil=now()+7d; insight is hidden from GET /api/dashboard. After 7d, snooze expires, insight reappears on dashboard (if not yet auto-expired by type TTL).

- Snooze 30d: Same as above, with snoozedUntil=now()+30d.

- Dashboard snooze window filter: GET /api/dashboard excludes insights where dismissalKind='snoozed' AND snoozedUntil > now(). Also excludes auto-expired insights (createdAt < now() - INSIGHT_TTL_DAYS[type] AND dismissalKind is NULL).

- Type-based TTL: An insight of type decay_warning created at t=0 is automatically hidden from dashboard at t=+14d (past TTL), even if dismissalKind is NULL. Patrol can re-emit a fresh version at t=+15d with a new id and reset dismissalKind/snoozedUntil.

- Patrol idempotency with snooze expiry: When patrol calls write_insight with (type, entity_ids) and an existing insight with the same key has dismissalKind='snoozed' with snoozedUntil <= now(), insert a new row (do NOT return the old id); the old row remains hidden, the new row is visible.

- find_contradictions tool: Agent calls find_contradictions(min_severity=0.5) and receives { contradictions: [...] } with ≥1 entries; for each with severity >= 0.6, agent emits contradiction_detected insight (subject to 5-insight cap).

- find_active_patterns tool: Agent calls find_active_patterns(status_filter='canonical') and receives { patterns: [...] } with high-confidence patterns; for each with confidence >= 0.8, agent emits pattern_emerging insight (subject to 5-insight cap).

- Importance deterministic formula (decay): Peak confidence 0.9, days since last reinforcement 30 → deterministic_importance = 0.9 * (1 - exp(-30/30)) ≈ 0.9 * 0.632 ≈ 0.57.

- Importance deterministic formula (cluster): Cluster with 25 edges → deterministic_importance = min(1.0, 25/10) = 1.0.

- Importance deterministic formula (contradiction): Platform returns severity=0.75 → deterministic_importance = 0.75.

- write_insight with deterministic & judgment: Tool call { type: "decay_warning", ..., deterministic_importance: 0.57, judgement_multiplier: 1.2 } → stored importance = clamp(0.57 * 1.2, 0, 1) = 0.684.

- write_insight rejects out-of-range values: Call with importance=1.5 or importance=-0.1 returns a clear error. (Alternative: clamp server-side with logged warning.)

- Backward compat: Existing insights with snoozedUntil=NULL, dismissalKind=NULL are queryable, not hidden, and do not break /api/dashboard or /api/insights.

- Dashboard aggregate: Dashboard returns { insights: [...], total: N } where N counts non-dismissed, non-snoozed, non-expired insights. Older snapshots (before this design) saw all insights in the count—no change in semantic as long as filtering is consistent.
