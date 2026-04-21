# 09 — Graph Quality Issues

**Date:** 2026-04-16
**Status:** Analysis complete, implementation pending
**Context:** After running the graph gardener agent and having an LLM analyze the graph for utility, five structural quality issues were identified. Each requires its own branch and careful implementation with tests.

---

## Issue 1: Gardener Cannot Expire Facts

### Problem

The fact expiry mechanism exists and works — but only when a new fact with an **exclusive predicate** is created. `createFact()` in `src/services/facts.ts:52-68` checks `fact_predicates.is_exclusive`, finds temporally overlapping facts for the same subject+predicate, and calls `expireFact()`.

However, the gardener agent has **no tool to expire facts**. When it discovers stale, contradictory, or superseded facts during graph exploration, it cannot act on them. There is also no periodic re-evaluation of facts outside the extraction pipeline.

### What Exists

- `expireFact()` function: `src/services/facts.ts:201-237` — sets `expired_at` and `expire_reason`
- Exclusive predicate supersession: `facts.ts:52-68` — triggered on fact creation
- 12 exclusive predicates seeded: `001_consolidated.sql:158-214` (e.g., `works_at`, `lives_in`, `married_to`, `has_role`)
- `findSupersedingFacts()`: `facts.ts:169-196` — temporal overlap detection

### What's Missing

- No `expire_fact` MCP tool for agent use
- No gardener prompt instruction to look for contradictions or stale facts
- No periodic fact validity re-evaluation
- No mechanism for the gardener to say "this fact is wrong" and expire it with a reason

### Proposed Fix

1. Add `expire_fact` tool to `GRAPH_TOOLS` in `src/services/causal-agent.ts` — takes `fact_id` and `reason`, calls existing `expireFact()`
2. Add gardener prompt instruction: "If you find contradictory or stale facts during investigation, expire the outdated one using expire_fact with a clear reason"
3. Add to gardener Phase 2 investigation: "Check for contradictory facts on the same entity (e.g., two active `lives_in` facts)"

### Files to Modify

- `src/services/causal-agent.ts` — tool definition + handler
- `src/services/facts.ts` — ensure `expireFact` is exported
- `ml-services/app/gardener_agent.py` — prompt update

### Test Strategy

- Unit: call `expire_fact` tool, verify fact has `expired_at` set and `expire_reason` populated
- Integration: create two contradicting facts, run gardener, verify it expires the stale one
- Verify expired facts are excluded from `query_entity_facts` results

---

## Issue 2: Mention Contexts Not Populated

### Problem

The `mention_context` column on `memory_entities` exists and the storage function accepts it, but the `link_entity_to_memory` MCP tool **does not have a context parameter**. Every entity-memory link in the database has `mention_context = NULL`.

This weakens cross-entity inference. When two entities share a source memory, you can't see WHY they were mentioned together without reading the full source text. The context field was designed to carry the surrounding 50-200 characters of text around the entity mention.

### What Exists

- Column: `memory_entities.mention_context` (`schema.ts:97`)
- Storage function: `linkMemoryToEntity()` (`entities.ts:339-353`) — accepts `mention.context` parameter
- Retrieval: `get_entity_sources` tool returns `mentionContext` (`causal-agent.ts:795`)
- Displayed in visualizer detail panel

### What's Missing

- `link_entity_to_memory` tool schema (`causal-agent.ts:326-346`) has no `mention_context` parameter
- Tool handler (`causal-agent.ts:820-827`) only passes `text`, not `context`
- Graph agent prompt doesn't instruct the LLM to include context when linking
- `linkEntitiesToMemory()` batch function (`entities.ts:359-399`) also doesn't pass context

### Proposed Fix

1. Add `mention_context` parameter to `link_entity_to_memory` tool schema in `causal-agent.ts`
2. Pass it through in the tool handler to `linkMemoryToEntity()`
3. Update graph agent prompt (PHASE 2, STEP 5) to instruct: "Include 50-200 characters of surrounding text as mention_context when linking entities to memories"

### Files to Modify

- `src/services/causal-agent.ts` — tool schema + handler
- `ml-services/app/graph_agent.py` — prompt update for PHASE 2

### Test Strategy

- Unit: call `link_entity_to_memory` with context, verify `mention_context` is stored
- Integration: run an ingest, verify new `memory_entities` rows have populated `mention_context`
- Query `get_entity_sources` and verify context appears in results

---

## Issue 3: Predicate Explosion

### Problem

The predicate normalization system is well-designed but has a leak: `normalizePredicate()` returns non-canonical predicates as-is instead of rejecting or staging them. When the graph agent invents predicates like `hallucinated_technical_constraint`, `has_guardrail`, `requires_future_adjustment`, or `should_merge_identical_names`, they pass through and get stored as facts.

The graph agent prompt lists 20 allowed predicates, but the LLM ignores this constraint — especially for attribute facts (object_value) where it feels unconstrained.

### What Exists

- `CANONICAL_ONTOLOGY`: `predicates.ts:29-234` — 34 canonical predicates across 7 categories with aliases
- `normalizePredicate()`: `predicates.ts:247-263` — checks canonical, checks aliases, returns as-is if unknown
- `fact_predicates` table: staging lifecycle (`staging` → `candidate` → `provisional` → `canonical` or `rejected`)
- `transitionPredicateStatus()`: `predicates.ts:400-439` — enforced state machine
- `findNonCanonicalPredicates()`: `predicates.ts:340-351` — query to identify drift
- `syncOntologyToDb()`: `predicates.ts:300-335` — syncs canonical ontology to DB
- Graph agent prompt: `graph_agent.py:322` — lists 20 allowed predicates

### What's Missing

- `normalizePredicate()` doesn't reject or stage unknown predicates — just passes them through (line 262)
- Non-canonical predicates are never inserted into `fact_predicates` with staging status
- No periodic review of non-canonical predicates
- Graph agent prompt doesn't differentiate between relationship predicates (should be strict) and attribute predicates (can be more flexible)
- Gardener has no instruction to review or normalize predicates

### Proposed Fix

**For relationship facts (object_entity_id set):** Strict — predicate must be canonical or alias. Reject with error message listing allowed predicates.

**For attribute facts (object_value set):** Flexible — allow freeform predicates but auto-insert into `fact_predicates` with `status='staging'` for review.

Implementation:
1. In `normalizePredicate()` or `createFact()`: when predicate is non-canonical, auto-insert into `fact_predicates` with `status='staging'`
2. Tighten graph agent prompt: relationship predicates MUST come from canonical list; attribute predicates can be descriptive but concise
3. Add gardener instruction: "Review staging predicates. Normalize facts to canonical predicates where possible."

### Files to Modify

- `src/services/predicates.ts` — auto-stage non-canonical predicates
- `src/services/facts.ts` — optionally reject non-canonical relationship predicates
- `ml-services/app/graph_agent.py` — tighten PHASE 3 predicate rules
- `ml-services/app/gardener_agent.py` — add predicate review to gardener workflow

### Test Strategy

- Unit: create fact with non-canonical predicate, verify it appears in `fact_predicates` with `status='staging'`
- Unit: create relationship fact with non-canonical predicate, verify rejection (if strict mode chosen)
- Integration: run ingest, verify all new predicates are canonical or staged
- Query `findNonCanonicalPredicates()` before and after to measure drift

---

## Issue 4: Self-Referential Facts

### Problem

There is **zero prevention** of self-referential facts — facts where `subject_entity_id = object_entity_id`. No database constraint, no application validation, no prompt instruction. Facts like `The Gardener --[same_entity_as]--> The Gardener` get created and stored.

These are semantically meaningless and pollute the graph. They typically arise when the graph agent extracts a relationship between an entity and itself (e.g., from text like "The Gardener should merge identical names" → `The Gardener --[should_merge_identical_names]--> The Gardener`).

### What Exists

- `merge_entities()` function (`005_reconciliation.sql:142-145`) cleans up self-referential `same_as_links` after merges — acknowledging they can arise
- No other prevention anywhere in the codebase

### What's Missing

- No CHECK constraint on `facts` table
- No validation in `createFact()` (`facts.ts`)
- No validation in `create_fact` tool handler (`causal-agent.ts`)
- No prompt instruction in graph agent or gardener
- Existing self-referential facts in the database (need cleanup)

### Proposed Fix

Three layers of prevention:

1. **Database constraint** (migration `007_graph_quality.sql`):
   ```sql
   ALTER TABLE public.facts ADD CONSTRAINT no_self_reference
     CHECK (object_entity_id IS NULL OR subject_entity_id != object_entity_id);
   ```
   Allows attribute facts (object_value only) but prevents self-pointing relationships.

2. **Application validation** — in `createFact()` (`facts.ts`), before insert:
   ```typescript
   if (objectEntityId && objectEntityId === subjectEntityId) {
     throw new Error('Self-referential facts are not allowed');
   }
   ```
   Or return early with a dedup-style "skipped" result. The tool handler in `causal-agent.ts` should catch this and return a clear error message to the agent.

3. **Prompt instruction** — add to graph agent PHASE 3 rules and gardener rules:
   "Subject and object must be DIFFERENT entities. Never create a fact where an entity points to itself."

4. **Cleanup** — expire all existing self-referential facts:
   ```sql
   UPDATE public.facts SET expired_at = NOW(), expire_reason = 'Self-referential fact cleanup'
   WHERE object_entity_id = subject_entity_id AND expired_at IS NULL;
   ```

### Files to Modify

- `src/db/migrations/007_graph_quality.sql` — CHECK constraint + cleanup
- `src/services/facts.ts` — validation in `createFact()`
- `src/services/causal-agent.ts` — error handling in `create_fact` tool handler
- `ml-services/app/graph_agent.py` — PHASE 3 rules update
- `ml-services/app/gardener_agent.py` — rules update

### Test Strategy

- Unit: attempt to create self-referential fact, verify rejection at app level
- Unit: attempt to insert self-referential fact directly in SQL, verify CHECK constraint blocks it
- Integration: run ingest with text that might trigger self-reference, verify none created
- Verify cleanup: query for remaining self-referential facts after migration

---

## Issue 5: Gardener Same-As vs Merge Decision Quality

### Problem

The gardener (and previously the reconciliation agent) created same_as links between entities with identical or near-identical names. This violates the intended semantics: same_as is for entities that represent the same thing from **different perspectives** (e.g., "the stranger" and "Victor Frankenstein"). Identical names should always be merges.

Additionally, the gardener encountered real merge failures due to the `merge_entities()` DB function missing causal_events re-pointing (fixed during this session by re-applying `005_reconciliation.sql`). The gardener correctly reported the FK constraint error but fell back to same_as instead of reporting the failure clearly.

### Current State (post-fix)

- `merge_entities()` function now correctly re-points causal_events, same_as_links, facts, aliases, memory_entities before deletion
- All 3 blocked merges (Claude Code, Gardener, Mnemo) have been executed
- 0 duplicate names remain, 0 same_as links remain
- Gardener prompt already updated with clear merge-vs-same_as criteria

### What May Still Need Attention

- The gardener prompt says "If a merge fails with a constraint error, report it — do not fall back to same_as as a workaround" — this is good
- The `created_by` field on `same_as_links` is hardcoded to `'reconciliation_agent'` (`causal-agent.ts:910`) — should also accept `'gardener_agent'`
- The gardener prompt's merge-vs-same_as criteria should be validated against real test cases
- Consider: should the gardener be able to **delete** incorrect same_as links? Currently no tool for that.

### Proposed Fix

1. Update `created_by` in same_as link handler to use a dynamic value (from tool input or default to calling agent)
2. Add `delete_same_as_link` tool if the gardener needs to clean up incorrect links
3. Write regression test: ingest text with obvious duplicates, run gardener, verify merges (not same_as)
4. Document the criteria clearly in the architecture docs

### Files to Modify

- `src/services/causal-agent.ts` — `created_by` field, possible `delete_same_as_link` tool
- `ml-services/app/gardener_agent.py` — already updated, verify criteria hold up
- Test files for regression testing

### Test Strategy

- Integration: ingest two chunks that create entities with identical names, run gardener, verify merge (not same_as)
- Integration: ingest two chunks that create entities with different names but same referent (narrative shift), run gardener, verify same_as
- Verify: after merge, no orphan same_as links, causal events re-pointed, facts consolidated

---

## Branch Strategy

Each issue should be tackled on its own branch from `feat/sparse-truth-graph`:

| Issue | Branch Name | Priority | Complexity |
|-------|-------------|----------|------------|
| 4. Self-referential facts | `fix/self-referential-facts` | High — data integrity | Low |
| 2. Mention contexts | `fix/mention-context-population` | High — easy win | Low |
| 1. Fact expiry tool | `feat/gardener-expire-facts` | Medium | Medium |
| 3. Predicate explosion | `feat/predicate-staging` | Medium | Medium |
| 5. Merge/same_as quality | `feat/gardener-merge-quality` | Low (mostly done) | Low |

Issues 4 and 2 are quick wins with clear fixes. Issue 1 and 3 require more design thought. Issue 5 is mostly resolved already.
