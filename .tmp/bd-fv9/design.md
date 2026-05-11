## 1. Dismissal/Snooze Model

### Schema Change
Add two columns to `insights` table:
```sql
snoozedUntil TEXT DEFAULT NULL,          -- ISO timestamp; null=never snoozed or snooze expired
dismissalKind TEXT DEFAULT 'dismissed'   -- enum: 'dismissed' | 'snoozed' | null
```

Existing `dismissedAt` is repurposed:
- If `dismissalKind='dismissed'`, this insight is permanently hidden; patrol will NOT re-emit even if signal refreshes.
- If `dismissalKind='snoozed'` and `snoozedUntil > now()`, hidden until that timestamp; patrol skips it in the 5-insight cap.
- If `dismissalKind='snoozed'` and `snoozedUntil <= now()`, treat as expired snooze (not dismissed): it is hidden from dashboard, but patrol can re-emit a fresh version of the same insight (same idempotencyKey) as a new row.
- If `dismissalKind=null` and `dismissedAt=null`, insight is active.

### Lookup Logic (in write_insight MCP tool)
When patrol calls write_insight with (type, sorted_entity_ids):
1. Compute idempotencyKey as before.
2. Check for existing row with this key.
3. If existing row is `dismissalKind='dismissed'`: return inserted=false (block forever).
4. If existing row is `dismissalKind='snoozed'` and `snoozedUntil > now()`: return inserted=false (block until snooze expires).
5. If existing row is `dismissalKind='snoozed'` and `snoozedUntil <= now()`: allow re-insert as new row (create fresh id, reset dismissalKind=null, snoozedUntil=null).
6. Otherwise (no row or dismissalKind=null and dismissedAt=null is expired by TTL): insert normally.

### API Change
POST /api/insights/:id/dismiss (update):
- Takes optional `kind` param: 'dismiss_forever' | 'snooze_7d' | 'snooze_30d'.
- If 'dismiss_forever' (default for backward compat): set dismissalKind='dismissed', dismissedAt=now().
- If 'snooze_7d': set dismissalKind='snoozed', snoozedUntil=now()+7d.
- If 'snooze_30d': set dismissalKind='snoozed', snoozedUntil=now()+30d.

### UI Update
Insights card action button becomes a dropdown or split-button (dismiss/snooze options). Each option POSTs to /api/insights/:id/dismiss?kind=....

---

## 2. Expiry (Per-Type TTL)

### Constants
Add to patrol-agent.ts near line 26:
```typescript
const INSIGHT_TTL_DAYS = {
  decay_warning: 14,
  cross_course_link: 21,
  synthesis_candidate: 21,
  prerequisite_gap: 14,
  contradiction_detected: 14,
  pattern_emerging: 14,
} as const;
```

### Dashboard Filter
In insights.ts (routes), add optional `include_expired=true` query param. Default: exclude insights where:
```
createdAt < now() - INSIGHT_TTL_DAYS[type] AND dismissalKind IS NULL
```
i.e., exclude auto-expired insights (those without explicit dismissal, just aged out).

In dashboard.ts buildInsights() (line 277–307):
```typescript
const where = and(
  isNull(insights.dismissalKind),  // not permanently dismissed
  or(
    sql`${insights.snoozedUntil} > datetime('now')`,  // still snoozed
    and(
      or(
        isNull(insights.snoozedUntil),  // never snoozed
        sql`${insights.snoozedUntil} <= datetime('now')`  // snooze expired
      ),
      sql`${insights.createdAt} > datetime('now', '-14 days')`  // within max TTL (14d for demo; adjust as needed)
    )
  )
);
```
(Alternatively, compute per-type TTL in app code rather than query.)

### Mechanism
- Patrol can re-insert insights with the same idempotencyKey if the snooze has expired.
- Dashboard does NOT show insights older than their type's TTL (unless query-param override).
- No hard delete; old insights stay in the table for audit trail.

---

## 3. Broader Detection Toolbelt

### New MCP Tools

**find_contradictions(min_severity?: number)**
- Wraps nmemo-client's `getContradictions()` (line 50–51 of nmemo-client.ts).
- Returns contradictions with severity >= min_severity (default 0.5).
- Schema: `{ contradictions: Array<{ id, severity: 0..1, concept_a, concept_b, evidence, resolution_status }> }` (adapt to actual Nmemo shape).

**find_active_patterns(status_filter?: 'canonical'|'provisional')**
- Wraps nmemo-client's `getActivePatterns()` (line 54–56).
- Returns patterns with status matching filter (default: both).
- Schema: `{ patterns: Array<{ id, name, confidence: 0..1, description, status, supportingFacts }> }`.

**find_prereq_gaps() — follow-up, scope TBD**
- Scans learner facts for predicate='lacks_prerequisite' (currently in learning-mcp.ts flag_prerequisite_gap, line 431–455).
- Groups by missing concept; returns top N with counts.
- OR: Platform exposes a /api/gaps endpoint; tool calls that instead (flag as out-of-scope if endpoint doesn't exist).

### Patrol System Prompt Update
Replace lines 26–94 of patrol-agent.ts. Add two new required passes (4th and 5th):

```
## Required passes (each run) — now 5

1. **Decay pass** — [existing: get_decay_candidates]
2. **Cross-course pass** — [existing: find_cross_course_overlaps]
3. **Cluster pass** — [existing: find_dense_clusters]
4. **Contradictions pass** — call find_contradictions(min_severity=0.5). Emit contradiction_detected insight for each with severity >= 0.6.
5. **Patterns pass** — call find_active_patterns(). Emit pattern_emerging insight for each high-confidence pattern (confidence >= 0.8).

Each pass is independent. 5-insight cap and 12-turn budget apply across all passes.
```

Importance guidelines:
- Decay: use deterministic_importance (see section 4).
- Cross-course: 0.6–0.7 (existing formula).
- Cluster: deterministic_importance (see section 4).
- Contradiction: severity from platform.
- Pattern: confidence from platform.

---

## 4. Hybrid Importance Scoring

### Deterministic Formula (per detection tool)

Each detection tool computes a `deterministic_importance` (0..1):

- **Decay candidate:** `peak_confidence * (1 - exp(-days_since / 30))`, capped at 1.0.
  - Example: peak=0.9, days_since=30 → 0.9 * (1 - e^(-1)) = 0.9 * 0.632 ≈ 0.57.
  
- **Cross-course overlap:** 
  - Direct: 0.5.
  - Same_as: confidence_score * 0.7 (from the same_as link's confidence).
  
- **Dense cluster:** min(1.0, edge_count / 10).
  - Example: 25 edges → min(1.0, 2.5) = 1.0 (saturates at 10 edges).
  
- **Contradiction:** severity field from platform (0..1), as-is.
  
- **Pattern:** confidence field from platform (0..1), as-is.

### Schema Update
`write_insight` MCP tool (learning-mcp.ts:527–586) now accepts:
```typescript
deterministic_importance?: number  // 0..1, computed by the detection tool
judgement_multiplier?: number       // 0.5..1.5, agent's judgment of how important this is
```

Final stored importance (in schema) = clamp(deterministic * multiplier, 0, 1), where multiplier defaults to 1.0.

Alternatively, compute server-side: agent passes deterministic_importance; server auto-multiplies by a configurable calibration factor (e.g., 1.0 initially).

### Agent Behavior
Agent still has discretion: it can set importance high (e.g., multiplier=1.5) if the signal aligns with learner context, or low (e.g., multiplier=0.7) if it's borderline. But the deterministic baseline is logged, so auditing and tuning become easier.

---

## 5. Backfill / Migration Story

New columns (snoozedUntil, dismissalKind) default to NULL / null.

**No destructive migration needed.** Old insights:
- Have `dismissalKind=NULL`, so they are treated as active (if not expired by TTL).
- Have `snoozedUntil=NULL`, so they are treated as never-snoozed.
- Queries are backward-compatible: `isNull(dismissalKind)` matches old rows.

**Visual difference for a transition period:**
- Old insights: importance is a scalar value, no per-type TTL filter applied (they live until dismissed).
- New insights: importance is deterministic * multiplier, TTL filter applied per type.

This is acceptable—old and new coexist gracefully.

---

## 6. Tests (5–7 cases)

1. **Snooze re-surfaces:** Create insight at t=0, snooze until t=+7d, verify hidden from dashboard; at t=+8d verify it reappears if not subsequently dismissed.
2. **Dismissed forever stays blocked:** Create insight, dismiss forever, run patrol with same signal again, verify no duplicate inserted.
3. **Expired insights hidden from dashboard:** Create insight of type decay_warning at t=0, verify hidden at t=+15d (past TTL).
4. **New MCP tools work end-to-end:** Mock Nmemo platform responses; call find_contradictions, find_active_patterns; verify tool returns structured data.
5. **Deterministic importance computed correctly:** Mock decay candidates with peak=0.9, days_since=30; verify final importance matches formula.
6. **Expiry TTL per type:** Create three insights (decay_warning, cross_course_link, synthesis_candidate) at t=0; at t=+20d, verify only synthesis_candidate still visible (its TTL is 21d).
7. **Backward compat:** Existing insights without new columns are queryable and don't break dashboard.

---

## 7. Code Paths

- **patrol-agent.ts:26–94** — system prompt; add 4th and 5th passes, update importance rules.
- **learning-mcp.ts:161–211** — tool definitions; add find_contradictions, find_active_patterns, optionally find_prereq_gaps.
- **learning-mcp.ts:471–525** — tool handlers; implement the three new tools.
- **schema.ts:84–99** — insights table; add snoozedUntil, dismissalKind columns.
- **insights.ts:68–76** — dismiss endpoint; parse kind param, set snoozedUntil.
- **dashboard.ts:277–307** — buildInsights(); add TTL and snooze logic to WHERE clause.
- **learning-mcp.ts:527–586** — write_insight; implement idempotency logic for snooze expiry + deterministic importance.
