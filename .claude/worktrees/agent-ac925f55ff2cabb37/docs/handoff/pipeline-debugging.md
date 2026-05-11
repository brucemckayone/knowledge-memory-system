# Pipeline Debugging Handoff

## Problem

Real data ingestion test (50 Frankenstein chunks) exposed multiple cascading failures in the message processing pipeline. The system extracts entities and facts too slowly, services crash under load, and old pg-boss jobs retain stale timeout configurations.

## Current State

- **Platform**: Running in Docker on port 3001
- **PostgreSQL**: Running in Docker on port 5433
- **Qdrant**: Running in Docker on port 6335
- **ML Services**: CRASHED (was on host port 8000, Python/FastAPI with Ollama)
- **Ollama**: STOPPED (was on host port 11434)

### Data Extracted So Far

- 23 entities (6 from Frankenstein: Captain Walton, Margaret, the stranger, nature, serpent, knowledge and wisdom)
- 11 facts (all from test messages, none from Frankenstein)
- 36 messages completed, ~19 still pending/failed
- 0 Frankenstein relationship facts extracted

## Root Causes Identified

### 1. Agent Execution Timeouts (FIXED but stale jobs remain)

**File**: `platform/src/gardener/controller.ts` line 59-63

Old values: realtime 30s, frequent 120s, periodic 600s
New values: realtime 300s, frequent 600s, periodic 1800s

**Problem**: pg-boss bakes the expireIn value into the job at creation time. Old jobs still have 30s timeout. Requeuing them (`SET state = 'created'`) doesn't update the timeout — they fail again with "handler execution exceeded 30000ms".

**Fix needed**: When requeuing failed jobs, also update the `expireIn` field, OR delete and re-insert them with new options.

### 2. ML Service Embed Timeout (FIXED)

**File**: `ml-services/app/embed.py` line 14 — Ollama timeout changed from 10s to 1200s
**File**: `platform/src/services/ml-client.ts` line 240 — embed timeout changed from 10s to 120s

### 3. ML Service Crashes Under Load

The ML service (uvicorn) crashes when processing multiple concurrent requests, especially when Ollama is slow. No process supervisor — when it dies, it stays dead.

**Fix needed**: Run ML service with auto-restart, or add a health check that restarts it.

### 4. Ollama Cold Start / Memory Pressure

Ollama loads the nomic-embed-text model on first request (~274MB). Under concurrent embed requests, it can run out of memory or timeout. On Windows, the Ollama process sometimes stops.

**Fix needed**: Warm up Ollama on startup, monitor process health.

### 5. Message Processing Pipeline Is Synchronous Per-Message

Each message goes through: classify → embed → store → (gardener: reader, entity extraction, summarizer, relationship extraction). Entity extraction calls Claude CLI which takes 5-15s. With concurrency 2, throughput is ~3-4 messages/minute.

**Fix needed**: This is architectural — the pipeline is designed correctly (queue-based) but the LLM calls are the bottleneck. Options:
- Increase queue concurrency (QUEUE_CONCURRENCY env var)
- Use batch endpoints where available
- Accept that LLM-heavy processing is slow and design tests accordingly

### 6. pg-boss Job Requeue Doesn't Reset Timeout

When we do `UPDATE pgboss.job SET state = 'created'` to requeue a failed job, the job retains its original `expireIn` value. Jobs created when the timeout was 30s will always timeout at 30s.

**Fix needed**: Either:
- DELETE failed jobs and re-INSERT them (new timeout applied)
- Update the `expireIn` column when requeuing: `SET state = 'created', expireIn = 300`
- Clear the entire queue and re-ingest

## What Needs to Happen

### Phase 1: Fix Infrastructure

1. Restart Ollama: `ollama serve` (or start from system tray)
2. Restart ML services: `cd ml-services && PYTHONIOENCODING=utf-8 uvicorn app.main:app --host 0.0.0.0 --port 8000 --http h11`
3. Clear the stale pg-boss queue: DELETE all failed/created jobs and re-ingest
4. Verify platform health shows all services OK

### Phase 2: Fix Requeue Logic

Create a helper script or SQL that properly requeues jobs with updated timeouts:
```sql
-- Delete stale jobs (they have wrong timeout baked in)
DELETE FROM pgboss.job WHERE name = 'message-processing' AND state IN ('failed', 'created');
DELETE FROM pgboss.job WHERE name LIKE 'gardener:%' AND state IN ('failed', 'created');
```

Then re-ingest the Frankenstein chunks.

### Phase 3: Design Tests That Don't Require Full Pipeline

The integration tests should NOT depend on:
- Ollama being running
- ML services being running
- Claude CLI being available
- 5-15 second LLM calls per extraction

Instead, create:
- **Unit tests** for each pipeline stage with mocked ML responses
- **Fixture-based integration tests** that pre-populate DB with known entities/facts
- **Smoke tests** that test one message end-to-end (not 50)
- **Load tests** that run separately with proper timeouts and monitoring

### Phase 4: Add Process Supervision

- ML services: run with `--workers 2` or behind a process manager
- Ollama: ensure it auto-starts and stays running
- Health check script that restarts crashed services
- Consider dockerizing ML services (currently runs on host)

## Files Changed This Session

| File | Change |
|------|--------|
| `platform/src/gardener/controller.ts` | Tier timeouts: 30→300s, 120→600s, 600→1800s |
| `platform/src/services/ml-client.ts` | Embed timeout: 10s→120s |
| `ml-services/app/embed.py` | Ollama timeout: 10s→1200s |
| `ml-services/app/compare_predicates.py` | Strengthened noise rejection prompt |
| `test-data/ingest-frankenstein.py` | Ingestion script for real data test |

## Beads Status

```
mnemo-519: Living Ontology Hardening — 11/12 closed
  Only mnemo-519.12 (Test 6: Concurrent operations, P3) remains open
```
