# Predicate Explosion

**Priority:** Medium
**Complexity:** Medium
**Branch:** `feat/predicate-staging`
**Date:** 2026-04-16

---

## Problem

The predicate normalization system is well-designed but has a leak: `normalizePredicate()` returns non-canonical predicates as-is instead of rejecting or staging them. When the graph agent invents predicates like `hallucinated_technical_constraint`, `has_guardrail`, `requires_future_adjustment`, or `should_merge_identical_names`, they pass through unchecked and get stored as facts.

The graph agent prompt lists 20 allowed predicates (`graph_agent.py:322`), but the LLM ignores this constraint — especially for attribute facts (using `object_value`) where it feels free to invent descriptive predicates.

Over time, this creates an unpredictable ontology that makes graph queries unreliable. You can't query "all employment relationships" if some are `works_at`, others are `employed_by`, and others are `has_role_at`.

---

## What Exists

### Normalization infrastructure (well-designed)

- `CANONICAL_ONTOLOGY`: `src/services/predicates.ts:29-234` — 34 canonical predicates across 7 categories:
  - Professional: `works_at`, `has_role`, `reports_to`, `colleague_of`, `manages`
  - Personal: `knows`, `friend_of`, `sibling_of`, `parent_of`, `child_of`, `married_to`, `partner_of`
  - Location: `lives_in`, `visited`, `near`, `north_of`, `south_of`, `east_of`, `west_of`, `part_of`
  - Education: `studied_at`, `has_degree`, `has_certification`
  - Creation: `founded`, `created`, `member_of`, `contributes_to`
  - Skills: `skilled_in`, `interested_in`, `speaks`
  - Events: `attended`, `participated_in`, `organized`

- Each canonical predicate has: description, optional inverse, type, exclusivity flag, category, and aliases

- `normalizePredicate()`: `predicates.ts:247-263` — lowercase + underscore, check canonical, check aliases, return as-is if unknown

- Alias map: `predicates.ts:237-242` — e.g., `employed_at` → `works_at`, `worked_at` → `works_at`

- `fact_predicates` table: `schema.ts:158-177` — staging lifecycle with status field:
  - `staging` → `candidate` → `provisional` → `canonical` (or `rejected`)
  - Tracks: `usageCount`, `distinctMemoryCount`, `firstSeenAt`, `promotedAt`, `rejectedAt`, `rejectionReason`

- `transitionPredicateStatus()`: `predicates.ts:400-439` — enforced state machine for lifecycle transitions

- `findNonCanonicalPredicates()`: `predicates.ts:340-351` — query to identify predicates in `facts` not in canonical set

- `syncOntologyToDb()`: `predicates.ts:300-335` — syncs canonical ontology to DB on startup

### The leak

`normalizePredicate()` line 262:
```typescript
// Return as-is if not found (will be flagged for review)
return normalized;
```

Non-canonical predicates pass through silently. They're not inserted into `fact_predicates` with staging status. They're not flagged at creation time. The "flagged for review" comment refers to `findNonCanonicalPredicates()`, which must be called manually.

### Graph agent prompt constraint

`graph_agent.py:322`:
```
Predicates MUST be base form only: works_at, lives_in, knows, writes_to, visited, sibling_of, near, parent_of, child_of, married_to, friend_of, member_of, skilled_in, founded, created, studied_at, role_at, north_of, part_of
```

This lists 20 predicates. But the LLM treats this as guidance, not enforcement, especially for attribute facts.

---

## Proposed Fix

### Design decision: strict vs staging

**For relationship facts** (entity-to-entity, `object_entity_id` set):
Strict — predicate must be canonical or alias. Non-canonical predicates return an error with the list of allowed predicates. This forces the LLM to map its intent to the ontology.

**For attribute facts** (entity-to-value, `object_value` set):
Flexible — allow freeform predicates but auto-insert into `fact_predicates` with `status='staging'`. Attribute predicates like `has_capability` or `has_feature` are genuinely useful and hard to enumerate upfront.

### Implementation

#### 1. Auto-stage non-canonical predicates

In `src/services/predicates.ts`, add a function called from `normalizePredicate()` or `createFact()`:

```typescript
async function ensurePredicateTracked(predicate: string): Promise<void> {
  // Insert with staging status if not already in fact_predicates
  await db.insert(factPredicates).values({
    predicate,
    status: 'staging',
    firstSeenAt: new Date(),
    distinctMemoryCount: 1,
  }).onConflictDoNothing();

  // Increment usage count
  await db.execute(sql`
    UPDATE fact_predicates
    SET usage_count = usage_count + 1, last_used_at = NOW()
    WHERE predicate = ${predicate}
  `);
}
```

Call this from `createFact()` after normalization but before insert.

#### 2. Optional: reject non-canonical relationship predicates

In `createFact()`, after normalization:

```typescript
const predicateInfo = getPredicateInfo(predicate);
if (objectEntityId && !predicateInfo) {
  throw new Error(`Non-canonical relationship predicate "${predicate}". Use one of: ${Object.keys(CANONICAL_ONTOLOGY).join(', ')}`);
}
```

This only blocks relationship facts. Attribute facts pass through with staging.

#### 3. Tighten graph agent prompt

In `ml-services/app/graph_agent.py`, PHASE 3 rules:

```
For RELATIONSHIP facts (entity-to-entity):
  Predicates MUST come from this list: works_at, lives_in, knows, writes_to, visited, sibling_of, near, parent_of, child_of, married_to, friend_of, member_of, skilled_in, founded, created, studied_at, role_at, north_of, part_of, attended, organized, manages, reports_to
  If none fit, use the closest match. Do NOT invent new relationship predicates.

For ATTRIBUTE facts (entity-to-value):
  Use concise, descriptive snake_case predicates. Examples: has_feature, has_capability, description, port, version
  Keep them short and reusable across entities.
```

#### 4. Gardener predicate review

Add to gardener prompt:

```
**For predicate hygiene:**
1. Review entities with non-standard predicates
2. If a staging predicate is equivalent to a canonical one, update the fact to use the canonical predicate
3. If a staging predicate is genuinely useful and used by multiple entities, note it for promotion
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/services/predicates.ts` | Add `ensurePredicateTracked()`, call from `normalizePredicate()` or integration point |
| `src/services/facts.ts` | Optional: reject non-canonical relationship predicates |
| `ml-services/app/graph_agent.py` | Differentiate relationship vs attribute predicate rules |
| `ml-services/app/gardener_agent.py` | Add predicate review to gardener workflow |

---

## Test Strategy

1. **Unit:** Create fact with non-canonical predicate, verify it appears in `fact_predicates` with `status='staging'`
2. **Unit:** Create relationship fact with non-canonical predicate, verify rejection (if strict mode)
3. **Unit:** Create attribute fact with non-canonical predicate, verify it passes (staging, not rejected)
4. **Integration:** Run ingest, verify all new predicates are canonical or properly staged
5. **Query:** `findNonCanonicalPredicates()` before and after to measure improvement
6. **Gardener:** Run gardener, verify it reviews staging predicates in its report

---

## Current State

To see current predicate drift:
```sql
SELECT f.predicate, count(*)::int as usage, bool_or(fp.is_canonical) as canonical
FROM facts f
LEFT JOIN fact_predicates fp ON f.predicate = fp.predicate
WHERE f.expired_at IS NULL
GROUP BY f.predicate
ORDER BY canonical NULLS FIRST, usage DESC;
```
