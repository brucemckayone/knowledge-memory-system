# Merge vs Same-As Decision Quality

**Priority:** Low (mostly resolved)
**Complexity:** Low
**Branch:** `feat/gardener-merge-quality`
**Date:** 2026-04-16

---

## Problem

The gardener and reconciliation agent created same_as links between entities with identical or near-identical names. This violated the intended semantics:

- **Same_as:** entities that represent the same real-world thing from different perspectives, where each carries distinct facts worth preserving (e.g., "the stranger" and "Victor Frankenstein")
- **Merge:** entities that are duplicates with no distinct value in keeping both (e.g., "Claude Code" [project] and "Claude Code" [company])

Four same_as links were created for what should have been merges:
- Claude Code [project] <=> Claude Code [company] — identical name
- Gardener [concept] <=> The Gardener [project] — trivial "The" prefix
- Mnemo Platform <=> Mnemo — abbreviated variant
- MCP [project] <=> MCP [concept] — identical name

Additionally, the gardener encountered real merge failures due to the `merge_entities()` DB function missing causal_events re-pointing. This was fixed during this session by re-applying `005_reconciliation.sql`.

---

## Current State (post-fix)

- `merge_entities()` function now correctly re-points: facts, aliases, memory_entities, entity_merges, causal_events, same_as_links — then deletes source entity
- All 4 pairs have been merged (MCP by gardener, other 3 manually after DB function fix)
- 0 duplicate names remain
- 0 same_as links remain
- Gardener prompt already updated with clear criteria:
  - "Same name = merge, not same_as. Always."
  - "Same_as is ONLY for entities with different names that represent the same real-world thing from different perspectives"
  - "If a merge fails with a constraint error, report it — do not fall back to same_as"

---

## What May Still Need Attention

### 1. `created_by` field hardcoded — RESOLVED 2026-05-26 (bead nmemo-2yv.66)

`src/services/causal-agent.ts` `create_same_as_link` handler now threads
the dispatcher's resolved `ToolCallContext.agent` (set by
`MNEMO_AGENT_ACTOR` env / explicit caller context) through to the INSERT.
The same fix landed on `execute_merge` (mergeEntities `actor`/`method` +
merge_candidates `resolved_by`) and `resolve_candidate` (`resolved_by`).
Migration `027_same_as_created_by_default.sql` relaxes the SQL default
to `'unknown'` so a missing explicit value surfaces in audit queries
rather than silently attributing to `reconciliation_agent`.

Backfill note: rows created before this fix are NOT retroactively
re-attributed; forensic queries against pre-fix rows cannot reliably
distinguish gardener-driven from reconciliation-driven attribution.

### 2. No tool to delete incorrect same_as links

If the gardener finds an incorrect same_as link (one that should be a merge), it can execute the merge — which will clean up the same_as link via the merge function. But it cannot directly delete a same_as link that's simply wrong (e.g., two entities that are actually distinct but were incorrectly linked).

Consider adding a `delete_same_as_link` tool.

### 3. Regression testing

Need integration tests that verify:
- Ingest two chunks creating entities with identical names → gardener merges (not same_as)
- Ingest two chunks creating entities with different names but same referent (narrative perspective shift) → gardener creates same_as
- After merge: no orphan same_as links, causal events re-pointed, facts consolidated, entity_merges audit trail

---

## The Criteria (documented for reference)

**The key test: "Would merging lose information that matters?"**

### MERGE when ALL true:
- Same name (case-insensitive) or trivial variant ("The X"/"X", abbreviations, typos)
- Same or compatible entity types
- Facts don't contradict
- No distinct perspective worth preserving — duplicates from different extraction runs

### SAME_AS when ALL true:
- Different names describing the same referent from different viewpoints
- Each has its own fact cluster with unique information
- Merging would lose the distinct framing each node provides
- Example: "the stranger" (Walton's perspective) and "Victor Frankenstein" (self-narrator)

---

## Root Cause of Original Failures

The `merge_entities()` function stored in the database was the **old version** from `001_consolidated.sql`. The updated version from `005_reconciliation.sql` (which added causal_events and same_as_links re-pointing) was either never applied or was applied before those tables existed.

The fix was re-running `005_reconciliation.sql`, which uses `CREATE OR REPLACE FUNCTION` to update the function in-place. The function now handles:
1. Record merge in `entity_merges` audit table
2. Copy aliases from source to target
3. Add source's canonical name as merged_name alias
4. Re-point `facts` (both subject and object)
5. Deduplicate exact-match facts after re-pointing
6. Re-point `entity_merges` (transitive chains)
7. De-dupe and re-point `memory_entities`
8. Delete source aliases
9. Re-point `causal_events.subject_entity_id`
10. Re-point `same_as_links` (both entity_a and entity_b)
11. Clean up self-referential same_as links
12. Update target's `merged_from` array
13. Delete source entity

---

## Files to Modify

| File | Change |
|------|--------|
| `src/services/causal-agent.ts` | Fix `created_by` in same_as handler; optionally add `delete_same_as_link` tool |
| `ml-services/app/gardener_agent.py` | Already updated — verify criteria hold up in testing |
| Test files | Regression tests for merge vs same_as decisions |

---

## Test Strategy

1. **Integration:** Ingest text creating "Robert Walton" and "R. Walton" entities, run gardener, verify merge
2. **Integration:** Ingest text creating "the stranger" (Walton's POV) and "Victor Frankenstein" (self-narrator), run gardener, verify same_as
3. **Regression:** After merge, verify:
   - Source entity deleted
   - All facts re-pointed to target
   - Causal events re-pointed
   - No orphan same_as links
   - `entity_merges` audit row exists
   - Target's `merged_from` array includes source ID
4. **Edge case:** Merge two entities where both have causal history — verify causal events all re-pointed correctly
