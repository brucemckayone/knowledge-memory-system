# Truth Graph Pipeline — Findings Report

**Date:** 2026-03-31
**Test:** 10 chunks of Frankenstein (Project Gutenberg) ingested via HTTP API
**Environment:** Windows 11, platform on host, ML services on host (Claude provider), Ollama local, Postgres+Qdrant in Docker

## Results Summary

| Metric | Value |
|--------|-------|
| Chunks ingested | 10 |
| Entities created | 58 (46 unique names) |
| Facts created | 39 |
| Relationships skipped (subject mismatch) | 36 |
| Predicates used | 14 of 47 canonical |
| Duplicate entity names | 7 (15 excess rows) |
| Duplicate facts | 1 (Mrs. Saville lives_in England x2) |
| Avg entity extraction time | 62s |
| Avg relationship extraction time | 14s |
| Total pipeline time (~) | ~15 min for 10 chunks |

---

## Bug 1: Entity Deduplication Not Working

**Severity:** High
**Impact:** 15 duplicate entity rows across 7 unique names

### Evidence

| Entity | Type | Duplicates |
|--------|------|------------|
| Margaret | person | 4 |
| Archangel | place | 3 |
| the pole | place | 2 |
| St. Petersburgh | place | 2 |
| Uncle Thomas | person | 2 |
| Mrs. Saville | person | 2 |
| England | place | 2 |

### Root Cause

`linkEntitiesToMemory()` in `services/entities.ts` creates a new entity row every time, even when the same `canonical_name + entity_type` already exists. Each chunk's entity extraction runs independently and doesn't check for existing entities.

### Impact

- Relationship agent links facts to arbitrary duplicate entity IDs, fragmenting the graph
- Query "Mrs. Saville" may only return facts linked to one of the two rows
- Graph traversal breaks when the same real-world entity has multiple node IDs

### Suggested Fix

Upsert on `(canonical_name, entity_type)` — either `INSERT ... ON CONFLICT DO UPDATE` or a lookup-before-insert pattern. Consider fuzzy matching too: "St. Petersburgh" vs "Petersburgh" should merge.

---

## Bug 2: Relationship Subject Mismatch — 48% Fact Loss

**Severity:** High
**Impact:** 36 of 75 extracted relationships (48%) were discarded

### Evidence

```
Subject mismatches by name:
  23x "narrator"
   4x "I"
   3x "lieutenant"
   1x "captain"
   1x "narrator's father"
   1x "the voyages"
   1x "voyages"
   1x "ignorant carelessness"
   1x "been" (parse error)
```

Per-chunk breakdown (created / skipped):
```
4ad547ed: 1 created, 3 skipped
f4514990: 3 created, 7 skipped
15547f29: 0 created, 9 skipped  ← total loss
050fb8ad: 7 created, 0 skipped
19565e99: 1 created, 4 skipped
83f21294: 1 created, 6 skipped
892e5851: 0 created, 6 skipped  ← total loss
908882cd: 6 created, 0 skipped
ff3eb757: 20 created, 1 skipped
```

### Root Cause

The relationship agent (`relationship.agent.ts:120-125`) does exact case-insensitive string matching:

```ts
const subjectEntity = entities.find(
  e => e.name.toLowerCase() === rel.subject.toLowerCase()
);
```

The ML relationship extraction returns generic references ("narrator", "I", "lieutenant") that don't match entity names ("R. Walton", "Captain Walton"). The entity extraction and relationship extraction prompts aren't coordinated — they independently decide what to call characters.

### Impact

- Nearly half of all discovered relationships are lost
- First-person narrated text (like Frankenstein's letters) is especially affected
- Chunks with no named characters produce zero facts

### Suggested Fixes

1. **Pass entity names to relationship extraction** — already done (entities are passed), but the ML prompt should be told "use ONLY these entity names as subjects/objects"
2. **Fuzzy entity matching** — partial/substring match, or embed both and compare similarity
3. **Coreference resolution** — resolve "narrator" / "I" / "the captain" to the actual entity before relationship extraction
4. **Two-pass extraction** — first extract entities, then extract relationships constrained to those entity names

---

## Bug 3: Vague/Generic Entities Pollute the Graph

**Severity:** Medium
**Impact:** ~15 entities that are descriptions, not proper entities

### Evidence

These should not be standalone entities:
- `dauntless courage` (concept) — this is an attribute, not an entity
- `frost`, `snow`, `spring`, `winter` (concept) — weather descriptions
- `the needle`, `the magnet` (concept) — compass parts mentioned in passing
- `a lady`, `her lover`, `his rival`, `the old man` (person) — anaphoric references, not identifiable people
- `the father of the girl` (person) — relationship descriptor
- `Englishman`, `June`, `vessel` (other) — too generic
- `enterprise` (project) — refers to Walton's voyage, not a proper project

### Root Cause

The entity extraction ML prompt accepts too many types and doesn't filter for specificity. Generic nouns and descriptive phrases pass through as entities.

### Suggested Fixes

1. **Minimum specificity threshold** — reject entities that are common nouns or descriptions
2. **Entity type constraints** — "concept" type is too broad; restrict to domain-specific concepts
3. **Post-extraction filter** — reject entities below a character count or matching a stopword list
4. **Prompt engineering** — tell the ML to only extract named entities, proper nouns, and specific concepts

---

## Bug 4: Fact Duplication

**Severity:** Low (only 1 case found)
**Impact:** `Mrs. Saville lives_in England` appears twice with different confidence (0.95 and 0.99)

### Root Cause

Two different chunks both mention Mrs. Saville living in England. The `createFact()` function doesn't check for existing identical triples before inserting.

### Suggested Fix

Upsert on `(subject_entity_id, predicate, object_entity_id/object_value)` — update confidence to max, or keep both with different `source_memory_id` for provenance tracking. The conflict resolution agent should handle this, but it didn't flag these as duplicates.

---

## Bug 5: Semantic Duplicates in Facts

**Severity:** Medium
**Impact:** Same meaning expressed differently

### Evidence

- `Uncle Thomas owns "books of voyages"` AND `Uncle Thomas owns "library of voyage histories"` — same thing
- `master has_description "dauntless courage"` AND `sailors has_description "dauntless courage"` — possibly about same crew

### Root Cause

Different chunks describe the same fact with different wording. The object is a free-text `object_value` string, not an entity ID, so there's no dedup.

### Suggested Fix

This is what the ontology evolution and conflict resolution agents should handle long-term. Short-term: normalize object values or use embedding similarity to detect near-duplicate facts.

---

## Performance Issue 1: Entity Extraction Bottleneck (62s avg)

**Severity:** High (blocks throughput)

### Evidence

| Stage | Avg Time | Max Time | Concurrency |
|-------|----------|----------|-------------|
| Message processing (embed) | ~5s | ~45s (cold) | 2 |
| Entity extraction (Claude) | 62s | 91s | 1 |
| Relationship extraction (Claude) | 14s | 133s | 1 |

### Root Cause

- Entity extraction uses Claude API via ML services (~27-47s per call)
- Gardener controller runs entity extraction jobs with concurrency=1 (default `boss.work()`)
- With 10 chunks, entity extraction alone takes ~10 minutes serialized

### Impact

At current throughput: 351 Frankenstein chunks would take **~6 hours** for entity extraction alone.

### Suggested Fixes

1. **Increase gardener concurrency** — `boss.work(jobType, { teamSize: 3 }, handler)` for realtime tier
2. **Batch entity extraction** — send multiple chunks in one ML call
3. **Use faster model** — Haiku/smaller model for extraction (quality tradeoff)
4. **Local model** — run entity extraction on Ollama with a fine-tuned model instead of Claude API

---

## Performance Issue 2: Ollama Embedding Overload

**Severity:** Medium

### Evidence

With `QUEUE_CONCURRENCY=5`, multiple concurrent embedding requests to Ollama caused timeouts (120s). Ollama serializes requests internally, so 5 concurrent requests queue up. Under load, later requests exceed the timeout.

Reduced to `QUEUE_CONCURRENCY=2` which is stable but slow.

### Suggested Fix

- Keep message processing concurrency at 2-3 for Ollama stability
- Or use a dedicated embedding service that handles concurrency better
- Or pre-warm Ollama and increase its thread count

---

## Performance Issue 3: Scheduled Cron Jobs Run With Empty Payloads

**Severity:** Low (noise, not data loss)

### Evidence

`gardener:relationships` was scheduled on a 5-minute cron with `{}` payload, causing repeated `PayloadError: Missing required field: memoryId` errors in logs.

### Fix Applied

Removed the `gardener:relationships` cron schedule in `controller.ts`. Relationship extraction should only run when chained from entity extraction, not on a schedule.

---

## Configuration Changes Made This Session

| File | Change | Why |
|------|--------|-----|
| `docker-compose.yml` | Added `MNEMO_API_KEY` env var | API auth wasn't configured, ingest endpoint returned 503 |
| `platform/.env` | Added `MNEMO_API_KEY=test-api-key-dev` | Same — needed for host-mode platform |
| `services/ml-client.ts` | All LLM timeouts 30s → 90s | Claude provider takes ~47s per call; 30s always times out |
| `workers/message-processor.ts` | Skipped LLM classification | Hardcoded `thought` workflow — saves ~47s per message |
| `gardener/agents/index.ts` | Disabled 9 of 15 agents | Only truth graph agents needed for testing |
| `gardener/controller.ts` | Disabled most cron schedules | Reduced noise; fixed empty-payload relationship cron |
| `index.ts` | Added `teamSize` to pg-boss worker | Enable actual concurrency for message processing |

---

## Architecture Observation: Docker→Host Networking Broken

ML services run on the host (via `make ml`). When the platform runs inside Docker, it uses `host.docker.internal` to reach ML services. On this Windows 11 + Docker Desktop (WSL2) setup, `host.docker.internal` resolves to `192.168.65.254` but connections time out intermittently. Running the platform on the host (via `pnpm dev`) bypasses this entirely.

This is a Windows Docker Desktop networking issue, not a code bug, but it means the Docker-based dev workflow is unreliable when ML services run on the host.
