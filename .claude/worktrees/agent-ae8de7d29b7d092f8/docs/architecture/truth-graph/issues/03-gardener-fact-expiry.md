# Gardener Fact Expiry

**Priority:** Medium
**Complexity:** Medium
**Branch:** `feat/gardener-expire-facts`
**Date:** 2026-04-16

---

## Problem

The fact expiry mechanism exists and works — but only when a new fact with an exclusive predicate is created during extraction. `createFact()` in `src/services/facts.ts:52-68` checks `fact_predicates.is_exclusive`, finds temporally overlapping facts, and expires them.

The gardener agent has no tool to expire facts it discovers are stale, contradictory, or superseded during graph exploration. There is no periodic re-evaluation of facts outside the extraction pipeline. If the gardener finds "Robert Walton lives_in London" and "Robert Walton lives_in Archangel" both active, it cannot expire the older one.

---

## What Exists

### Expiry infrastructure (fully functional)

- `expireFact(factId, reason)`: `src/services/facts.ts:201-237` — sets `expired_at` and `expire_reason`
- Exclusive predicate supersession: `facts.ts:52-68` — auto-triggered on new exclusive-predicate fact creation
- `findSupersedingFacts()`: `facts.ts:169-196` — temporal overlap detection for same subject+predicate
- 12 exclusive predicates seeded: `001_consolidated.sql:158-214` (e.g., `works_at`, `lives_in`, `married_to`, `has_role`)
- `getEntityFacts()`: `facts.ts` — already filters `expired_at IS NULL` when returning active facts
- All queries in pipeline and visualizer respect `expired_at IS NULL`

### What's missing

- No `expire_fact` MCP tool — agents can create facts but cannot expire them
- Gardener prompt has no instruction to look for contradictions or stale facts
- No mechanism for fact validity re-evaluation outside of new-fact-creation
- Graph agent also cannot expire facts (only creates new ones, relies on supersession)

---

## Proposed Fix

### 1. New MCP tool: `expire_fact`

Add to `GRAPH_TOOLS` in `src/services/causal-agent.ts`:

```typescript
{
  name: 'expire_fact',
  description: 'Expire an active fact that is stale, contradictory, or superseded. The fact is soft-deleted (expired_at set, not removed from DB). Use this when investigation reveals a fact is no longer true or contradicts newer information.',
  inputSchema: {
    type: 'object',
    properties: {
      fact_id: {
        type: 'string',
        description: 'UUID of the fact to expire',
      },
      reason: {
        type: 'string',
        description: 'Why this fact is being expired (e.g., "Contradicted by newer fact X", "Entity no longer exists", "Stale information from outdated source")',
      },
    },
    required: ['fact_id', 'reason'],
  },
}
```

Handler calls existing `expireFact()` from `facts.ts`.

### 2. Gardener prompt additions

Add to Phase 2 (INVESTIGATE) in `ml-services/app/gardener_agent.py`:

```
**For fact contradictions:**
1. When querying entity facts, look for contradictory active facts:
   - Two active facts with the same exclusive predicate (e.g., two lives_in facts)
   - Facts that directly contradict each other (e.g., "is alive" and "is dead")
   - Facts from old sources that are clearly superseded by newer information
2. For each contradiction: expire_fact the older/less confident one with a clear reason
3. Note: non-exclusive predicates can have multiple active facts (e.g., multiple knows relationships). Only expire if genuinely contradictory.
```

Add to Phase 3 (ACT):

```
**EXPIRE FACTS — when investigation reveals contradictions or stale information**
-> expire_fact with fact_id and clear reason
Only expire facts you can justify. When in doubt, leave active — false expiry is worse than keeping a stale fact.
```

### 3. Export `expireFact` from facts.ts

Verify `expireFact` is exported (it may be module-private currently). If not exported, add export.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/services/causal-agent.ts` | Add `expire_fact` tool definition + handler |
| `src/services/facts.ts` | Ensure `expireFact()` is exported |
| `ml-services/app/gardener_agent.py` | Add contradiction detection + expiry instructions |

---

## Test Strategy

1. **Unit:** Call `expire_fact` tool with a valid fact_id, verify `expired_at` is set and `expire_reason` matches
2. **Unit:** Call `expire_fact` on already-expired fact, verify graceful handling (no error, or clear message)
3. **Unit:** Call `expire_fact` with non-existent fact_id, verify error message
4. **Integration:** Create two contradicting exclusive-predicate facts manually, run gardener, verify it expires the stale one
5. **Verify:** Expired facts excluded from `query_entity_facts` results
6. **Verify:** Expired facts still visible in DB for audit (not deleted)

---

## Design Considerations

- **Soft delete only:** Facts are never hard-deleted. `expired_at` + `expire_reason` preserve the audit trail.
- **Causal events persist:** When a fact is expired, its associated `causal_event` remains. The causal history shows that the fact existed and was later expired.
- **Agent discretion:** The gardener should be conservative. Expiring a fact that's actually true is harder to recover from than leaving a stale fact active. The prompt should emphasize "when in doubt, don't expire."
- **No auto-expiry agent:** This proposal adds expiry as a gardener capability, not a separate agent. A dedicated fact-validity agent could be added later if the gardener's workload grows.
