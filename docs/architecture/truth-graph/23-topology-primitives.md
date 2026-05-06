# 23 — Topology Primitives (Phase 2 / T0)

**Phase:** 2 (T0 — graph topology, ships after Phase 1)
**Master:** `21-cluster-bridging-master.md`
**Type:** Phase master (lightweight index — feature children carry full Design + Implementation per master §10)
**Status:** Design draft (2026-04-29) — under review
**Bead:** to be created post-review per master §10

**Children (file numbers match ship order — cold-eyes review W9):**
- `23.1-connected-components.md` (ships first; simplest)
- `23.2-k-core.md`
- `23.3-articulation-points.md`
- `23.4-community-detection.md` (Leiden — ships before centrality)
- `23.5-centrality.md` (ships last; betweenness sampling needs care)

---

## 1. Purpose

Phase 2 instruments the graph with **structural awareness**: the system gains a single integer or label per entity that says where it sits in the connectivity, what role it plays, and which natural community it belongs to. None of these signals exist today.

Five primitives, each with its own design doc:

| Feature | Question it answers |
|---|---|
| Connected components (`23.1`) | What islands exist? |
| k-core decomposition (`23.2`) | How embedded is each entity? |
| Articulation points & bridges (`23.3`) | Which entities/edges, if removed, would split the graph? |
| Community detection (`23.4`) | What natural groupings does the graph reveal? |
| Centrality (`23.5`) | Who are the protagonists? Who's the bridge? |

Together they unblock every later phase: cross-cluster candidate generation (Phase 4) iterates components; gardener and reasoning-agent target prioritisation read centrality; the adaptive 3-signal scoring reads community membership; structural-risk warnings read articulation points.

This doc covers the **integration concerns shared across all five features** — the unified schema they write to, the unified computation routine that drives them, the trigger model, and the cross-cutting acceptance criteria. Per-feature designs live in the children.

## 2. Shared design

### 2.1 The `entity_topology` table

All five features write to a single shared table, one row per entity, written together by one computation routine. Splitting into five tables would multiply joins and force five separate triggers; one row keeps the read story simple.

```sql
CREATE TABLE public.entity_topology (
  entity_id              UUID PRIMARY KEY REFERENCES public.entities(id) ON DELETE CASCADE,

  -- 23.1 Connected components
  component_id           INTEGER,                  -- 0..N-1; -1 if not yet computed
  component_size         INTEGER,                  -- size of the component this entity belongs to

  -- 23.2 k-core decomposition
  k_core                 INTEGER,                  -- 0=orphan, 1=leaf, k≥2=embedded

  -- 23.3 Articulation
  is_articulation_point  BOOLEAN NOT NULL DEFAULT FALSE,
  -- Bridges are edge-level; tracked separately (see §2.2)

  -- 23.4 Community detection (Leiden)
  community_id           INTEGER,                  -- -1 if not yet computed
  participation_coef     FLOAT,                    -- Guimerà-Amaral; cross-community edge fraction

  -- 23.5 Centrality
  pagerank               FLOAT,                    -- normalised so column sums to 1
  betweenness_sampled    FLOAT,                    -- sampled approximation, see 23.5

  -- Bookkeeping
  computed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  computation_version    INTEGER NOT NULL DEFAULT 1   -- bookkeeping; rewritten transactionally on every compute
);

-- Indexes serving the queries this schema enables (cold-eyes review B4)
CREATE INDEX IF NOT EXISTS idx_entity_topology_component
  ON public.entity_topology (component_id);
CREATE INDEX IF NOT EXISTS idx_entity_topology_community
  ON public.entity_topology (community_id);
CREATE INDEX IF NOT EXISTS idx_entity_topology_articulation
  ON public.entity_topology (is_articulation_point) WHERE is_articulation_point = TRUE;
CREATE INDEX IF NOT EXISTS idx_entity_topology_pagerank
  ON public.entity_topology (pagerank DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_entity_topology_betweenness
  ON public.entity_topology (betweenness_sampled DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_entity_topology_version
  ON public.entity_topology (computation_version);
```

Children docs may refine column types, add indexes, or split if their feature's data model genuinely requires it — but the default is "fields land here."

### 2.2 The `topology_bridges` table

Bridges are an edge-level concept — the entry doesn't fit on `entity_topology` (which is per-entity). A small sibling table:

```sql
CREATE TABLE public.topology_bridges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id         UUID,                              -- if the bridge is a fact edge
  same_as_link_id UUID,                              -- if the bridge is a same_as link
  source_entity_id UUID NOT NULL,
  target_entity_id UUID NOT NULL,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  computation_version INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT topology_bridges_one_kind CHECK (
    (fact_id IS NOT NULL)::int + (same_as_link_id IS NOT NULL)::int = 1
  ),
  -- Canonical ordering enforced (mirrors merge_candidates pattern); prevents duplicate insertion
  -- when compute reruns or runs concurrently. Cold-eyes review S4.
  CONSTRAINT topology_bridges_ordering CHECK (source_entity_id < target_entity_id),
  CONSTRAINT topology_bridges_unique UNIQUE (source_entity_id, target_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_topology_bridges_source
  ON public.topology_bridges (source_entity_id);
CREATE INDEX IF NOT EXISTS idx_topology_bridges_target
  ON public.topology_bridges (target_entity_id);
```

`23.3-articulation-points.md` carries the full design.

### 2.3 The unified compute routine

A single Python sidecar entry point:

```
POST ${ML_SERVICES_URL}/topology/compute
  → exports the active fact graph + same_as links + entities from Postgres via AGE
  → runs all five features in one pass over the in-memory graph (igraph by default)
  → writes results back to entity_topology + topology_bridges in one transaction
  → returns elapsed time + per-feature stats
```

Why one routine, not five:
- All features need the same graph export (entities + active fact edges + same_as edges). Doing it once amortises the export cost.
- Shared export normalises edge weights and direction conventions across all features. Avoids per-feature inconsistency.
- One transaction guarantees that all five features reflect the same graph snapshot. Mid-compute writes by other agents don't fragment the result.

The Python module structure:

```
ml-services/app/
└── topology.py
    ├── _export_graph()                     -- shared (see §2.3.1 for ordering)
    ├── compute_components(g)               -- 23.1
    ├── compute_k_core(g)                   -- 23.2
    ├── compute_articulation(g)             -- 23.3
    ├── compute_communities(g)              -- 23.4 (Leiden)
    ├── compute_centrality(g)               -- 23.5 (PageRank + sampled betweenness)
    └── _write_back(results)                -- shared (see §2.3.2 for canonical upsert)
```

Each feature's design doc spells out its `compute_*` function in detail. The two shared concerns (graph-export ordering and canonical write-back upsert) live here in the master because all five children depend on them.

#### 2.3.1 Graph-export ordering (cross-doc inconsistency CDI-1 lock)

`_export_graph()` produces a deterministic edge list. Edge ordering is locked: **fact edges precede same_as edges; ties broken by primary key UUID ASC.** The export query reads:

```sql
-- Fact edges (active only); ordered by id for determinism
SELECT 'fact' AS edge_kind, id AS edge_id, subject_entity_id AS src, object_entity_id AS dst
FROM public.facts WHERE expired_at IS NULL AND object_entity_id IS NOT NULL
UNION ALL
-- Same_as edges; ordered by id for determinism
SELECT 'same_as' AS edge_kind, id AS edge_id, entity_a_id AS src, entity_b_id AS dst
FROM public.same_as_links
ORDER BY edge_kind, edge_id;
```

Both `23.3` (bridge representative selection) and `23.4` (community membership tiebreak when graph is sensitive to edge order) depend on this. The query also requires the entity table read to be `ORDER BY id` so vertex indices are stable.

#### 2.3.2 The canonical write-back upsert (cross-doc inconsistency CDI-3 lock)

All five features share a single upsert. Each feature contributes its own columns to the same `INSERT ... ON CONFLICT DO UPDATE`:

```sql
-- Bulk upsert: one row per entity, all features in one statement
INSERT INTO public.entity_topology
  (entity_id, component_id, component_size, k_core,
   is_articulation_point, community_id, participation_coef,
   pagerank, betweenness_sampled, computed_at, computation_version)
VALUES
  ($1::uuid, $2::int, $3::int, $4::int,
   $5::bool, $6::int, $7::float,
   $8::float, $9::float, NOW(), $10::int)
ON CONFLICT (entity_id) DO UPDATE SET
  component_id = EXCLUDED.component_id,
  component_size = EXCLUDED.component_size,
  k_core = EXCLUDED.k_core,
  is_articulation_point = EXCLUDED.is_articulation_point,
  community_id = EXCLUDED.community_id,
  participation_coef = EXCLUDED.participation_coef,
  pagerank = EXCLUDED.pagerank,
  betweenness_sampled = EXCLUDED.betweenness_sampled,
  computed_at = NOW(),
  computation_version = EXCLUDED.computation_version;
```

Bulk variant uses `unnest()` on parameterised arrays — one statement, N rows. Children docs reference this upsert by name (`master 23 §2.3.2`); they do *not* re-document per-feature UPDATEs. Per-feature UPDATEs are wrong — they would multiply round-trips and could drop columns when one feature fails.

`topology_bridges` rewrites are a separate statement in the same transaction:

```sql
DELETE FROM public.topology_bridges;  -- unconditional; rows are always rewritten
INSERT INTO public.topology_bridges
  (source_entity_id, target_entity_id, fact_id, same_as_link_id, computation_version)
VALUES
  -- Per row: (LEAST(a, b), GREATEST(a, b), ...) to satisfy ordering CHECK
  ...
ON CONFLICT (source_entity_id, target_entity_id) DO NOTHING;
```

The `DELETE` is unconditional (cold-eyes review B1 fix) and the row construction enforces `LEAST/GREATEST` canonicalisation to satisfy `topology_bridges_ordering CHECK (source_entity_id < target_entity_id)`.

#### 2.3.3 Partial-failure semantics (cold-eyes review W9)

The entire compute is one transaction. Any feature raising → full rollback → previous compute's state preserved. The Python sidecar wraps the work in a `BEGIN` / `COMMIT` and writes a `topology_compute_runs` row at start (`status='in_progress'`) and on completion (`status='completed'` or `'failed'` with `error_detail`). On crash, a janitor sweep marks abandoned in-progress rows as failed.

### 2.4 Trigger model

Mirrors graph_stats (Phase 1):

- **On-demand** — `POST /api/topology/compute` for manual / viz / debugging.
- **Patrol-time** — every `TOPOLOGY_COMPUTE_INTERVAL = 5` reasoning-agent runs.
- **After Phase 4 cross-cluster generator runs** — Phase 4 may produce new `same_as` links that reshape topology; trigger a recompute after cross-cluster reconciliation completes.

**Not on the hot ingest path.** Topology computation is O(m + n log n) at best and O(n·m) at worst (betweenness). It runs patrol-time; ingest-time work stays focused on extraction and storage.

### 2.5 Compute placement

Per master §5.3: Postgres holds canonical state, Python sidecar runs algorithms. Phase 2 confirms that direction:

- **Postgres** stores `entity_topology` and `topology_bridges`.
- **Python sidecar** (existing `ml-services/`) gains `topology.py` plus `networkx` and `python-igraph` dependencies. `leidenalg` is added for community detection (`23.5`). No GPU required.

This is the **first** Phase 2+ work that adds Python ML dependencies. From this point forward, `ml-services/` runs both Claude orchestration and numerical graph analysis. `requirements.txt` grows accordingly.

### 2.6 Compute version

All `entity_topology` rows are rewritten transactionally on each compute, so every row reflects the same graph snapshot at the same `computation_version`. The version column is **bookkeeping**, not a filter for downstream consumers — after a successful compute, all rows match the constant in code. The version is useful for audit ("which algorithm produced this number?") and benchmark comparison across versions, but a query like `WHERE computation_version = 3` is *not* the right access pattern.

When a feature changes (e.g. Leiden resolution swap), bump the constant in code; the next compute rewrites every row at the new version. Half-update detection in §4.1 enforces this invariant — if a query finds rows at mixed versions, the system is in an inconsistent state and a recompute is required. (Cold-eyes review B3.)

## 3. Implementation roadmap

The five children ship in file-number order (matched to ship order per cold-eyes review W9):

1. **`23.1` Connected components** — simplest, unblocks Phase 4
2. **`23.2` k-core** — also simple, replaces gardener's hand-rolled sparse-leaf detection
3. **`23.3` Articulation points & bridges** — depends on at least one bridge to test against; ship after `23.1`
4. **`23.4` Community detection** — Leiden is more involved; needs `leidenalg` + parameter tuning
5. **`23.5` Centrality** — last because betweenness sampling requires careful choice of sample size and tolerance

Each child docs its own benchmark; the **Phase 2 acceptance benchmark** is end-to-end: run `topology/compute` against the `synthetic-10k` snapshot (per `28-test-data-snapshots.md`), assert all five features return populated rows for every entity within the §5 latency budget.

## 4. Verification

### 4.1 Phase-level checks (in addition to per-feature checks in children)

- **Migration `014_entity_topology.sql`** applies cleanly; both tables exist with expected schemas
- **Single `POST /api/topology/compute`** populates rows for every entity with no gaps after a fresh ingest
- **All five feature columns** non-NULL after compute — no feature silently fails and leaves NULLs
- **`computation_version`** matches across all rows (no half-updates after a version bump)
- **Cross-feature consistency** — a vertex flagged `is_articulation_point` is reachable from at least two `component_id` values *via* the graph minus that vertex (sanity check that articulation logic respects component logic)
- **Idempotency** — running compute twice produces identical rows except `computed_at`

### 4.2 Phase-level acceptance for `bd close`

- All children docs' acceptance criteria met
- Phase-level §4.1 checks pass
- Phase 2 benchmark §5.1 thresholds met
- Cross-feature integration test green: load `synthetic-10k`, run compute, assert every column on every entity is populated and consistent

## 5. Benchmark

### 5.1 Acceptance thresholds

End-to-end `topology/compute` against `synthetic-10k`:

| Operation | Target | Hard cap |
|---|---|---|
| Graph export from Postgres | < 1 s | 3 s |
| All-five compute pass (in-memory) | < 8 s | 20 s |
| Write-back into entity_topology | < 2 s | 5 s |
| **Total wall clock** | **< 12 s** | **30 s** |

Per-feature thresholds in children docs.

**Targets assume the heavy operations (sampled betweenness, Leiden) run via `python-igraph` or `igraph`-backed leidenalg, not pure NetworkX.** NetworkX implementations of betweenness and Leiden are 2–4× slower at this scale. The `topology.py` module imports igraph for the heavy ops by default; NetworkX is used only for primitives where they're equivalent in speed (components, k-core, articulation). (Cold-eyes review W2.)

### 5.2 Baseline reports

Committed under `platform/src/test/data/phase2-topology/benchmark-reports/`:

- `synthetic-1k.json`
- `synthetic-10k.json`
- `frankenstein-10chunks.json` (correctness, not perf)
- `mixed-narrative-technical-1k.json` (correctness on real-shape graph)

Each captures: per-feature elapsed time, per-feature output size, plus the integration row.

## 6. Edge cases (phase-level)

| Case | Expected behaviour |
|---|---|
| Empty graph (no entities) | Compute returns immediately; all tables remain empty; no error |
| Single-entity graph | component_id=0, component_size=1, k_core=0, no articulation, pagerank=1.0, no community (or community_id=0) |
| Disconnected pair (two entities, no edge) | Two components; each entity k_core=0; no articulation; pagerank=0.5 each |
| Star graph (one hub, N leaves) | One component; hub k_core=1, leaves k_core=1; hub is articulation if N≥2; hub centralities high |
| Concurrent compute calls | Second call short-circuits with "compute in progress" or queues; do not corrupt state |
| Compute called mid-ingest | Graph snapshot is taken at export time; concurrent inserts after that point are not reflected — recomputed next cycle |
| `same_as` links present | They count as edges in the topology graph (so two same_as-linked entities are in one component) |
| Expired facts | Excluded from topology graph (only `expired_at IS NULL` facts contribute) |

Per-feature edge cases in children.

## 7. Iteration cycle

Per-feature iteration cycles in children. Phase-level concerns:

- **Algorithm parameter changes** bump `computation_version`. Backfill happens on the next periodic compute or via manual trigger
- **New corpora** that surface unusual topology (e.g. tightly-connected hub-and-spoke, or entirely-disconnected mass) extend the snapshot roster (`28`) and the Phase 2 benchmark grows accordingly
- **Performance regression** detected via baseline benchmark comparison triggers test-harden review

## 8. Operational concerns

These cover the cross-cutting coverage gaps surfaced by the cold-eyes review (gaps 3, 6, 7).

### 8.1 Compute progress tracking

A sibling table records compute runs and their state, so we can detect stuck/failed runs and prevent overlap:

```sql
CREATE TABLE public.topology_compute_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  status              VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  computation_version INTEGER NOT NULL,
  entities_processed  INTEGER,
  error_detail        TEXT,

  CONSTRAINT topology_runs_status CHECK (status IN ('in_progress', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_topology_runs_status
  ON public.topology_compute_runs (status, started_at DESC);
```

The `topology/compute` endpoint:
1. Inserts a row with `status='in_progress'` before starting work
2. On success: updates `completed_at` + `status='completed'` + `entities_processed`
3. On crash / exception: caller (or a periodic janitor) marks abandoned in-progress rows older than a timeout as `status='failed'` with `error_detail`
4. New compute calls check for an in-progress row younger than the timeout and short-circuit with "compute in progress" rather than starting a parallel run

This closes the "Python sidecar crashed mid-compute, no one knows" gap surfaced by the review.

### 8.2 Reasoning report integration

Each successful compute writes a `reasoning_reports` row capturing what changed:

```typescript
await db.insert(reasoningReports).values({
  mode: 'topology_compute',
  report: JSON.stringify({
    computation_version,
    entity_count,
    component_count,
    community_count,
    articulation_point_count,
    bridge_count,
    elapsed_ms,
  }),
  // No entity_id / fact_id / edge_id — this is a graph-level event
});
```

The `test-harden` skill (`20-test-harden-skill-design.md`) consumes these reports. Without this hook, no agent-feedback signal is available to drive iteration cycle (§7) evolution.

The same pattern applies to `graph_stats` (Phase 1) — see `22` §7.5.

### 8.3 Concurrency with `merge_entities()`

The `merge_entities()` SQL function (`005_reconciliation.sql:90-155`) deletes the source entity at the end of a merge. The `entity_topology` row's `ON DELETE CASCADE` removes the corresponding topology row automatically — but a compute running mid-merge may already have computed and be about to write a row for the soon-to-be-deleted entity.

**Resolution:** The CASCADE is the source of truth. If a compute writes a row for an entity that has just been deleted, the CASCADE will remove that row when the entity DELETE commits — net state is consistent. The brief window where a stale row exists is bounded by the compute's own write-back transaction.

We do **not** add explicit locking between compute and merge — the cost would dominate normal-case latency. The next compute cycle resyncs.

Mirror concern for `topology_bridges`: if a fact or same_as_link referenced by a bridge row is deleted, the bridge row is orphaned. Recomputed next cycle. The schema does not FK-reference fact/same_as_link IDs (they're nullable text; FKs would force CASCADE chains that break compute reliability). The next compute cycle removes orphan bridges.

### 8.4 Auth on `/api/topology/compute`

Currently public; mirrors `graph_stats` Phase 1. Compute is non-trivial (multi-second CPU work). For solo dev, no auth is fine. For multi-user / public deployment, add rate-limit or auth before exposure. Tracked separately from this phase. (Cold-eyes review coverage gap 5.)

## 9. References

### Existing docs
- `21-cluster-bridging-master.md` — master plan
- `22-graph-stats-foundation.md` — Phase 1 sibling that runs in similar shape (singleton recomputed by trigger)
- `28-test-data-snapshots.md` — provides `synthetic-10k` and labelled corpora for benchmarks

### Per-feature docs (file numbers match ship order)
- `23.1-connected-components.md`
- `23.2-k-core.md`
- `23.3-articulation-points.md`
- `23.4-community-detection.md`
- `23.5-centrality.md`

### Libraries
- NetworkX — https://networkx.org
- python-igraph — https://igraph.org/python/
- leidenalg (used by `23.5`) — https://github.com/vtraag/leidenalg

### External primary sources cited in children
Per-feature; see each child's References section.

---

*This is the Phase 2 master. The five children carry the per-feature contracts; this doc owns only the integration concerns. Bead structure mirrors: one phase task, five implementation tasks (one per child), each with verification + benchmark sub-tasks per master §10 lock.*
