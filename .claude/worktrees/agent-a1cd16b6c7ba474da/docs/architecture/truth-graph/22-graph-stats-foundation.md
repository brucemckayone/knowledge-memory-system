# 22 — Graph Stats Foundation

**Phase:** 1 (foundation, ships first)
**Master:** `21-cluster-bridging-master.md`
**Status:** Design draft (2026-04-29) — under review
**Bead:** to be created post-review per master §10

---

## 1. Purpose

The system today is blind to its own aggregate state. There is no answer to questions like:

- How many entities exist?
- How many active facts? How dense is the graph?
- What fraction of entities are orphans?
- How many distinct predicates are in use?
- Is the graph one tight cluster or several distinct cultures?
- Are there merge candidates waiting to be resolved?

Every downstream computation — adaptive merge-candidate scoring, viz dashboards, gardener prompts, reasoning-agent target selection — operates on context-free numbers. A centroid similarity of 0.7 means very different things in a graph where most entities live in one tight semantic neighbourhood vs one spread across multiple cultures, but the system cannot tell the difference today.

`graph_stats` is the singleton table that makes the graph **self-aware at the aggregate level**. It is the cheapest capability on the cluster-bridging menu and unblocks every later phase that depends on context-relative scoring.

This doc operationalises `06-graph-meta-layer.md` lines 150-202 ("Graph-Level Statistics — Phase 2+"), which specified the schema but was never shipped.

## 2. Design

### 2.1 Schema shape

A single-row table (singleton, enforced by `CHECK (id = 1)`) holding the latest aggregate state. Reads are O(1). Writes are an upsert. History is *deferred* (see §2.5) — Phase 1 ships only the singleton.

Columns group into four families:

- **Scale** — total entities, facts, memories. Counted directly.
- **Centroid distribution** — moments and percentiles of pairwise centroid similarity. Computed by sampling.
- **Graph health** — fact density, orphan rate, predicate diversity, pending merge candidates. SQL aggregates.
- **Embedding clusters** — embedding-cluster count and intra/inter cluster distances. *Populated only after Phase 3 ships HDBSCAN clustering.* Phase 1 leaves these `NULL` and the schema is forward-compatible. (Terminology: "embedding cluster" replaces the legacy term "culture" from `06-graph-meta-layer.md`. See master §10 terminology lock.)

### 2.2 Integration

| Consumer | What it reads | When |
|---|---|---|
| Viz dashboard | All columns | On dashboard render |
| Adaptive 3-signal scoring (`graph-meta.ts`, future) | culture_count, centroid_sim_p10, p90 | Per `detectMergeCandidates` invocation |
| Gardener prompt | total_entities, orphan_rate, merge_candidates_pending | Per gardener run |
| Reasoning agent context | All columns (one-line summary) | Patrol prompt header |
| Phase 4 cross-cluster generator | culture_count, mean_inter_distance | Per generator run |

`graph_stats` is read-mostly: tens of writes per day, thousands of reads.

### 2.3 Trigger model

Three triggers, mirroring established platform patterns:

- **On-demand** — `POST /api/graph-stats/compute`. Used by viz, manual debugging.
- **Patrol-time** — every N reasoning-agent runs, mirroring `PATTERN_DETECTION_INTERVAL` from Phase 6 (`pipeline.ts:33-40`). Default `GRAPH_STATS_INTERVAL = 5`.
- **Post-ingest gate** (optional, off by default) — recompute after a bulk-ingest of >50 memories. Configurable.

Recomputation is not on the hot ingest path. Worst-case computation latency is bounded by §5 benchmark.

### 2.4 Compute placement

Per master §5.3: Postgres holds canonical state, Python sidecar runs algorithms. For graph_stats, *all* computations are SQL aggregates. **No Python sidecar work.** This is the lightest possible Phase 1 — pure migration + service module + endpoint.

The Phase 3 backfill (culture_count, intra/inter distance) will run in the Python sidecar and write back to `graph_stats` via SQL. Same singleton row, progressively enriched.

### 2.5 Out of scope (Phase 1)

- **History** — `graph_stats_history` time-series table. Doc 06 line 146 anticipated it; deferred until we have a concrete need (probably when adaptive weighting needs trend signals).
- **Cluster-related columns population** — depends on Phase 3 (HDBSCAN). Schema includes the columns; values stay NULL until Phase 3.
- **Per-source / per-community sub-aggregates** — covered by future capability docs, not here.

## 3. Implementation

### 3.1 Migration `013_graph_stats.sql`

```sql
-- 013_graph_stats.sql — Singleton table for graph-level aggregate statistics
-- Implements docs/architecture/truth-graph/06-graph-meta-layer.md lines 150-202
-- Phase 1 of cluster-bridging master plan (21).

-- AGE search_path gotcha: use explicit public. qualifiers per CLAUDE.md.

CREATE TABLE IF NOT EXISTS public.graph_stats (
  id                       INTEGER PRIMARY KEY DEFAULT 1,

  -- Scale
  total_entities           INTEGER NOT NULL DEFAULT 0,
  total_facts              INTEGER NOT NULL DEFAULT 0,
  total_active_facts       INTEGER NOT NULL DEFAULT 0,
  total_memories           INTEGER NOT NULL DEFAULT 0,

  -- Embedding clusters (populated by Phase 3 HDBSCAN, NULL initially)
  embedding_cluster_count    INTEGER,
  mean_intra_cluster_distance FLOAT,
  mean_inter_cluster_distance FLOAT,

  -- Centroid distribution (sampled pairwise centroid similarities)
  centroid_sim_mean        FLOAT,
  centroid_sim_median      FLOAT,
  centroid_sim_p10         FLOAT,
  centroid_sim_p90         FLOAT,
  centroid_sample_size     INTEGER,

  -- Graph health
  fact_density             FLOAT,                  -- active_facts / entities
  orphan_rate              FLOAT,                  -- entities with 0 facts / total
  predicate_diversity      INTEGER,                -- distinct predicates in active facts
  merge_candidates_pending INTEGER NOT NULL DEFAULT 0,

  -- Timestamp
  computed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  computed_duration_ms     INTEGER,                -- self-reported compute time
  computation_version      INTEGER NOT NULL DEFAULT 1,  -- bump when computation algorithm changes
  cluster_columns_version  INTEGER,                -- last Phase 3 backfill version; NULL until Phase 3 lands

  CONSTRAINT graph_stats_singleton CHECK (id = 1)
);

-- Seed an empty row so the singleton always exists.
INSERT INTO public.graph_stats (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
```

### 3.2 Service `src/services/graph-stats.ts`

Two exports:

```typescript
export async function computeGraphStats(): Promise<GraphStats>;
export async function getGraphStats(): Promise<GraphStats | null>;
```

`computeGraphStats()` runs the SQL aggregates within a single transaction, builds the row, upserts the singleton, and returns it. `getGraphStats()` is a single SELECT.

Computation strategy:

- **Scale** — `SELECT COUNT(*)` from `entities`, `facts`, `facts WHERE expired_at IS NULL`, `memory_entities` (distinct `memory_id`).
- **Centroid distribution** — single-SQL CROSS JOIN of two random subsamples (each `LIMIT 100`, ORDER BY random() with seeded random for reproducibility), yielding ~10k pairs in one roundtrip. Aggregate the cosine via pgvector `<=>` with PERCENTILE_CONT for p10/p50/p90. No per-pair Postgres roundtrip. The 100×100 sample bound keeps the query under ~50ms even on 10k+-entity graphs. Stored sample size in `centroid_sample_size` (typically 10000). (Cold-eyes review W1 fix — the original "K=10000 single-pair queries" approach would be 5–10s; the CROSS JOIN approach is ~50ms.)
- **fact_density** — `total_active_facts / total_entities` (zero-safe).
- **orphan_rate** — fraction of entities with zero active facts in *either* role (subject or object). Per `06-graph-meta-layer.md:172` an orphan is "an entity with zero facts," not "no outgoing facts." SQL: `(SELECT COUNT(*) FROM entities e WHERE NOT EXISTS (SELECT 1 FROM facts f WHERE f.expired_at IS NULL AND (f.subject_entity_id = e.id OR f.object_entity_id = e.id))) / NULLIF(total_entities, 0)`. (Cold-eyes review B1 fix.)
- **predicate_diversity** — `SELECT COUNT(DISTINCT predicate) FROM facts WHERE expired_at IS NULL`.
- **merge_candidates_pending** — `SELECT COUNT(*) FROM merge_candidates WHERE status IN ('staging', 'candidate')`.

All within one transaction wrapped in `BEGIN/COMMIT`. Total elapsed time recorded in `computed_duration_ms`.

### 3.3 Endpoint and pipeline wiring

**`POST /api/graph-stats/compute`** — manual trigger. Returns the new row as JSON.

**`GET /api/graph-stats`** — read latest. Returns `null` if singleton hasn't been computed beyond the seeded empty row.

**Pipeline integration** (`src/pipeline.ts`):
- Add `GRAPH_STATS_INTERVAL = 5` env var (alongside existing `PATTERN_DETECTION_INTERVAL`, `GARDENER_RUN_INTERVAL`, `DECAY_RUN_INTERVAL`).
- After successful reasoning agent run, increment a counter; on counter % interval == 0, fire `computeGraphStats()` in try/catch (never throw from the increment).

### 3.4 Viz integration (minimal)

A small dashboard panel rendering the latest stats. One row per family (scale, cultures, centroid, health). Refreshes on `/api/graph-stats` GET. This is a separate body of UI work but should be designed to be a 30-line addition; not blocking Phase 1 close.

## 4. Verification

### 4.1 Manual checks (run by hand on first deploy)

- After migration: `SELECT * FROM graph_stats` returns one row with `id=1`, all numeric columns 0 or NULL.
- After first ingest of a single non-trivial document: `POST /api/graph-stats/compute` returns 200 with non-zero `total_entities`, `total_facts`, `total_memories`. `computed_at` is current. `computed_duration_ms` is populated.
- Numeric correctness audit: for every column except cluster-related, run a parallel SQL query computing the same number; assert equality.
- Idempotency: call `POST /api/graph-stats/compute` twice in a row; assert all numeric columns identical except `computed_at` and `computed_duration_ms`.

### 4.2 Automated tests

Test file `platform/src/test/harness/graph-stats.test.ts`. Test cases:

- **Empty DB:** after migration, getGraphStats returns the seeded row with all-zero counts.
- **Single entity, zero facts:** total_entities=1, total_facts=0, orphan_rate=1.0, fact_density=0, predicate_diversity=0.
- **Two entities, one fact between them:** total_entities=2, total_active_facts=1, fact_density=0.5, orphan_rate=0.5, predicate_diversity=1.
- **Expired fact excluded from active count:** create fact, expire it, recompute; total_facts=1, total_active_facts=0, predicate_diversity=0.
- **Centroid sample size cap:** with >10k entity pairs eligible, centroid_sample_size <= 10000.
- **Centroid columns NULL when no entity has centroid:** every centroid_* column is NULL; centroid_sample_size = 0.
- **Cluster columns stay NULL Phase 1:** culture_count, mean_intra_distance, mean_inter_distance all NULL.
- **Merge candidates counted:** add 3 staging candidates and 2 resolved; `merge_candidates_pending = 3`.
- **Idempotency:** calling computeGraphStats twice produces identical row except timestamps.
- **Singleton invariant:** attempting to insert a second row fails with CHECK violation.

### 4.3 Acceptance criteria for `bd close`

- All 10 automated tests pass on a clean `pnpm test` run
- Manual checks (§4.1) pass on a fresh DB
- `POST /api/graph-stats/compute` returns 200 in under §5 benchmark threshold
- Migration applies cleanly to an existing DB containing pre-Phase 1 state (idempotent up-migration)
- Benchmark report committed (§5)

## 5. Benchmark

### 5.1 Acceptance thresholds

| Graph size | Target latency | Hard cap |
|---|---|---|
| 100 entities | < 50 ms | 200 ms |
| 1 000 entities | < 200 ms | 1 000 ms |
| 10 000 entities | < 2 000 ms | 10 000 ms |

The dominant cost at scale is the centroid-similarity sampling. The 10k cap on `centroid_sample_size` keeps it bounded.

### 5.2 Baseline report

After ship, run `computeGraphStats` against:

1. Empty DB (sanity)
2. The canonical multi-source test corpus post-ingest
3. A synthetic 10k-entity graph (generator: `platform/src/test/generators/synthetic-graph.ts`, to be created if not present)

Commit results under `platform/src/test/data/phase1-graph-stats/benchmark-reports/`:

```
benchmark-reports/
├── empty-db.json
├── canonical-corpus.json
└── synthetic-10k.json
```

Each JSON: `{computed_at, total_entities, computed_duration_ms, numeric snapshot of every column}`. Future regressions (and future enrichments from Phase 3 cluster work) compare against these baselines.

### 5.3 What we measure over time

- **Latency growth** — does `computed_duration_ms` scale linearly in `total_entities`? Sub-quadratic? If quadratic, the centroid sampling needs revisiting.
- **Numeric stability** — does idempotent recomputation produce identical numbers? (Should, deterministically.)
- **Forward enrichment** — when Phase 3 fills the cluster columns, the same canonical-corpus benchmark grows new fields without changing the existing ones.

## 6. Edge cases

| Case | Expected behaviour |
|---|---|
| Migration applied to a DB with no entities | Seeded singleton returned; all counts 0; centroid_sim columns NULL; cluster columns NULL. |
| Migration applied to a DB with existing entities | First `computeGraphStats()` populates correctly. No data loss. Idempotent. |
| `entity_meta.centroid` is NULL for all entities | Centroid sample size 0, all centroid_sim_* columns NULL. No crash. |
| Single entity in DB | n=1; pairwise sample yields 0 pairs; centroid_sim_* columns NULL; orphan_rate either 0 or 1; division-safe. |
| Expired facts only | total_facts > 0, total_active_facts = 0, predicate_diversity = 0, fact_density = 0. |
| Concurrent `computeGraphStats` calls | Both succeed (one wins last-write-wins on the singleton); no row duplication; no row deletion. |
| `merge_candidates` table empty (no rows ever) | merge_candidates_pending = 0. |
| Migration applied twice (re-run) | `IF NOT EXISTS` + `ON CONFLICT DO NOTHING` make this safe. No data change. |
| Database connection lost mid-compute | Transaction rolls back; previous singleton row preserved. |
| Singleton row deleted (e.g. `deleteFromTables` during testing) | `getGraphStats()` returns null. Callers MUST handle null cleanly. `computeGraphStats()` re-creates the row. (Cold-eyes review W7.) |
| Phase 3 not yet shipped | Cluster columns (`embedding_cluster_count`, `mean_intra_cluster_distance`, `mean_inter_cluster_distance`) stay NULL; `cluster_columns_version` stays NULL. Consumers must check null. |
| Phase 3 backfill mid-flight | `cluster_columns_version` may be NULL or stale while backfill runs. Consumers reading cluster columns must check `cluster_columns_version IS NOT NULL` AND match the latest known version. |

## 7. Iteration cycle

How fixtures and tests evolve over time. Owned by the `test-harden` skill.

### 7.1 Initial fixtures (Phase 1 ship)

Under `platform/src/test/data/phase1-graph-stats/`:

```
fixtures/
├── empty-db.sql              -- no entities, no facts
├── single-entity.sql         -- 1 entity, no facts
├── two-entities-one-fact.sql -- minimal connected graph
├── expired-only.sql          -- entities with only expired facts
├── orphan-cluster.sql        -- entities with no centroids and no facts
└── canonical-multi-source.sql -- representative production-shape graph

expected/
├── empty-db.expected.json
├── single-entity.expected.json
└── ... (one per fixture)
```

Each `expected.json` lists the assertions in `simple-mutations.expected.json` format (see Phase 1 audit-trail tests for the schema). The `loadFixture()` helper from `src/test/setup.ts` (per `feedback_test-harden_skill` memory) drives the test runner.

### 7.2 Evolution signals

The `test-harden` Test-Data Evolver subagent watches for:

- **Real-world ingests producing graph_stats values outside the fixture range** — propose a new fixture covering that distribution.
- **Phase 3 wiring up culture columns** — fixture set extends to include cluster-rich and cluster-poor variants.
- **Performance regression on `synthetic-10k`** — fixture extended with synthetic 50k, 100k variants to localise the scaling break.
- **New downstream consumer (e.g. adaptive weighting)** — fixture extended to exercise the consumer's input requirements.

### 7.3 "Done enough"

Phase 1 graph_stats is "done enough" when:

- All 10 §4.2 tests pass without skips
- Benchmark report committed for all three baselines
- One real-world ingest (any non-trivial corpus) produces a `graph_stats` row whose every column is interpretable and within the §6 expected ranges
- No regressions in audit-trail, edge-lifecycle, source-refs, blast-radius, contradictions, or pattern test suites

The bead's acceptance criteria mirror this list.

### 7.4 Future evolution into Phase 3

When Phase 3 (HDBSCAN clustering) ships, it adds a `backfillClusterColumns()` routine that reads HDBSCAN labels from `entity_clusters` (Phase 3-introduced table; see master §10 centroid-lifecycle lock) and writes `embedding_cluster_count`, `mean_intra_cluster_distance`, `mean_inter_cluster_distance` back into the singleton row, bumping `cluster_columns_version`. Phase 1 fixtures gain optional cluster-column expectations. Phase 3 fixtures become a strict superset of Phase 1's.

The Phase 3 read pattern is: HDBSCAN clusters over the live `entity_meta.centroid` value, then Phase 3 writes both the cluster ID *and* a `centroid_snapshot VECTOR(768)` capturing the centroid at clustering time. This stable snapshot is what drift detection (Phase 3 sibling) compares against on subsequent runs. `graph_stats` cluster columns are *summaries* of the snapshot state, not a dependency on the live centroids.

### 7.5 Operational concerns (cold-eyes review coverage gap 5)

**Auth.** `POST /api/graph-stats/compute` is currently public (no auth middleware). Compute is bounded but non-trivial. For solo dev this is fine; for multi-user deployment, add a rate-limit or auth check (mirrors the gap on `/api/topology/compute` in `23` §2.4). Tracked separately from this phase.

**Reasoning report integration.** `computeGraphStats()` does not currently write a `reasoning_reports` row. The test-harden skill consumes those reports. Phase 1 ships without it; if the iteration cycle in §7 needs report-driven evolution, this is the obvious next addition. Tracked as a follow-up.

## 8. References

### Existing docs

- `21-cluster-bridging-master.md` — master plan; this is its Phase 1 child
- `06-graph-meta-layer.md` lines 150-202 — original `graph_stats` spec
- `20-test-harden-skill-design.md` — recursive verification skill leveraged for §7

### Existing code

- `src/services/graph-meta.ts` — sibling service computing per-entity stats and merge candidates
- `src/pipeline.ts:33-40` — established pattern for periodic counters (`PATTERN_DETECTION_INTERVAL` etc.)
- `src/test/setup.ts` — `loadFixture()` helper and shared test infrastructure
- Migration `003_graph_meta.sql` — established style for graph-meta migrations
- Migration `012_pattern_rejected.sql` — most recent migration; example of the `public.` qualifier pattern

### Libraries

- pgvector — distance operator `<=>` used in centroid similarity sampling. https://github.com/pgvector/pgvector
- Drizzle ORM — schema definition. https://orm.drizzle.team

---

*This is the Phase 1 design contract. The bead created from this doc must inherit acceptance criteria from §4.3 verbatim. Benchmark report (§5.2) is a hard requirement before `bd close`.*
