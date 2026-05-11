# 24 — Centroid Clustering & Drift (Phase 3 / T1)

**Phase:** 3 (T1 — semantic-space layer, ships after Phase 2)
**Master:** `21-cluster-bridging-master.md`
**Type:** Phase master (lightweight index — children carry full per-feature contracts)
**Status:** Design draft (2026-04-29) — under review
**Bead:** to be created post-review

**Children:**
- `24.1-hdbscan-clustering.md`
- `24.2-drift-detection.md`

---

## 1. Purpose

Phase 3 instruments the graph with **semantic-space awareness**, complementing Phase 2's edge-based topology. The two are orthogonal — communities (`23.4`) are graph-edge groupings; embedding clusters (`24.1`) are positions in 768-dim meaning-space. When the two disagree, that mismatch is itself signal: an entity in graph-community A but embedding-cluster B sits at the boundary between graph structure and semantic context.

Two features:

| Feature | Question it answers |
|---|---|
| HDBSCAN clustering (`24.1`) | Which entities live in similar parts of meaning-space? |
| Drift detection (`24.2`) | Has an entity's meaning-space position shifted over time? |

Together they unblock the most-anticipated capability in the master plan: detecting when an entity's mention distribution shifts from one semantic neighbourhood to another, signalling a possible identity transition (the canonical "stranger → Victor Frankenstein" case from the `06-graph-meta-layer.md` line 209 vision).

This doc covers the **shared concerns** across both features — the new tables, the unified trigger, and the cross-feature integration where drift reads the cluster's centroid snapshot.

## 2. Shared design

### 2.1 The `entity_clusters` table

`24.1` writes here. One row per entity, one current cluster assignment plus the centroid snapshot used at clustering time. Per master §10 centroid-lifecycle lock: HDBSCAN reads the **live** `entity_meta.centroid` but writes a **stable snapshot** to this table. Drift detection (`24.2`) compares the live centroid against the snapshot to detect movement.

```sql
CREATE TABLE public.entity_clusters (
  entity_id            UUID PRIMARY KEY REFERENCES public.entities(id) ON DELETE CASCADE,
  cluster_id           INTEGER NOT NULL,                -- HDBSCAN label; -1 = noise
  centroid_snapshot    VECTOR(768) NOT NULL,            -- live centroid value at clustering time
  cluster_probability  FLOAT,                            -- HDBSCAN soft-cluster membership; NULL for noise
  cluster_size         INTEGER,                          -- entity count in this cluster; NULL for noise (cold-eyes review W5)
  computed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  computation_version  INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_entity_clusters_cluster
  ON public.entity_clusters (cluster_id);
CREATE INDEX IF NOT EXISTS idx_entity_clusters_version
  ON public.entity_clusters (computation_version);
```

`cluster_id = -1` is HDBSCAN's "noise" label — entities not in any dense cluster. Important signal in its own right (semantic outliers are interesting).

### 2.2 The `entity_drift_events` table

`24.2` writes here. One row per detected drift event per entity. History is preserved (rows are append-only).

```sql
CREATE TABLE public.entity_drift_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           UUID NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  drift_magnitude     FLOAT NOT NULL,                   -- clamp(1 - cosine, [0, 1]); cold-eyes review W2
  centroid_snapshot   VECTOR(768) NOT NULL,             -- snapshot at last clustering
  centroid_current    VECTOR(768) NOT NULL,             -- live centroid at detection time
  source_cluster_id   INTEGER,                           -- entity's cluster at last clustering (snapshot's owner)
  target_cluster_id   INTEGER,                           -- nearest cluster centroid to centroid_current; cold-eyes review (R3 B2)
  triggered_action    VARCHAR(50),                      -- e.g. 'reconciliation_invoked', 'logged_only'
  reconciliation_run_id UUID                            -- FK if reconciliation was invoked
);

CREATE INDEX IF NOT EXISTS idx_drift_events_entity
  ON public.entity_drift_events (entity_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_drift_events_recent
  ON public.entity_drift_events (detected_at DESC);
```

Each drift event optionally triggers a reconciliation agent invocation specifically scoped to the drifted entity. The `triggered_action` column records what happened.

### 2.3 The unified compute routine

The orchestration is **pure Python** (in `ml-services/app/semantic_clustering.py`); the platform side calls it via HTTP. The TypeScript snippets in `24.2` are **illustrative platform-side wrappers** — *not* part of the sidecar implementation. Language boundary: Python owns compute and DB writes; TypeScript owns HTTP wiring and patrol-time invocation. (Cold-eyes review CDI-5.)

`POST ${ML_SERVICES_URL}/semantic-clustering/compute` runs both features in one pass:

1. Read all `entity_meta` rows where `centroid IS NOT NULL`
2. Run HDBSCAN over the centroid matrix, produce cluster labels + soft probabilities
3. For each entity: compute drift between the new `centroid` and any prior `entity_clusters.centroid_snapshot`. If drift exceeds threshold AND the entity had a prior cluster assignment, emit a drift event
4. Write back to `entity_clusters` (rewrite the row) and `entity_drift_events` (append)
5. Backfill `graph_stats.embedding_cluster_count`, `mean_intra_cluster_distance`, `mean_inter_cluster_distance` (per `22` §7.4)
6. Bump `graph_stats.cluster_columns_version`
7. For each drift event above the action threshold: invoke reconciliation_agent (in a separate try/catch — failures don't break compute)

Why one routine, not two: drift detection requires the snapshot from clustering. Splitting them into separate endpoints would force two graph reads and inconsistent timing.

### 2.4 Trigger model

Patrol-time only, per master §10 W6 lock (drift moved off the hot ingest path):

- **On-demand:** `POST /api/semantic-clustering/compute` for manual / viz / debugging
- **Patrol-time:** `SEMANTIC_CLUSTERING_INTERVAL = 5` reasoning-agent runs (consistent with topology + graph_stats intervals from master §5.4)

No inline path. Drift detected at patrol time, with at most 5 patrols of latency. For Mnemo's typical patrol cadence this is minutes-to-hours, well within the latency budget for "an identity transition has happened."

#### 2.4.1 Compute-runs status table (cold-eyes review B4)

Phase 3 gets its own status table mirroring `topology_compute_runs` (Phase 2). Independent lifecycle — Phase 3 ships independently of Phase 2:

```sql
CREATE TABLE public.semantic_clustering_compute_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  status              VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  computation_version INTEGER NOT NULL,
  entities_processed  INTEGER,
  drift_events_emitted INTEGER,
  error_detail        TEXT,

  CONSTRAINT semantic_clustering_runs_status CHECK (status IN ('in_progress', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_semantic_clustering_runs_status
  ON public.semantic_clustering_compute_runs (status, started_at DESC);
```

Same start/complete/janitor pattern as `23` §8.1.

### 2.5 Compute placement

Python sidecar gets two new dependencies on top of Phase 2:

- `hdbscan` (the canonical HDBSCAN package; `pip install hdbscan`)
- `river` (online learning library that includes ADWIN — used by `24.2`)

Both are CPU-only. No GPU required. Total dependency add ~50 MB to the `ml-services/` image.

Module: `ml-services/app/semantic_clustering.py`. Two functions: `compute_hdbscan()` and `detect_drift()`, plus the orchestration endpoint.

### 2.6 Cross-feature integration

The drift detector reads `entity_clusters.centroid_snapshot` to know "where this entity used to live." If the entity has no prior cluster assignment (first compute, or just-created entity), drift detection skips it — there's nothing to compare against.

After Phase 4 (cross-cluster generator) ships, drift events are also a candidate-generation signal. An entity drifting from cluster A to cluster B is a hint that it might be co-referent with entities currently in cluster B. Phase 4's design doc references this.

### 2.7 Out of scope (Phase 3)

- **Embedding-cluster hierarchy** (HDBSCAN's hierarchical tree). We store leaf-level only.
- **Cluster-level statistics** beyond size and distance — predicate diversity, fact density per cluster. Future work.
- **Per-entity centroid history before this phase** — we don't backfill drift events for pre-Phase-3 ingest. Drift detection starts at the first compute.
- **Predictive drift** — anticipating drift before it happens via centroid-trajectory analysis. Future work; ADWIN is reactive, not predictive.

## 3. Implementation roadmap

The two children ship in this order:

1. **`24.1` HDBSCAN clustering** — produces the `entity_clusters` table and `centroid_snapshot` values. Without this, drift has nothing to compare against.
2. **`24.2` Drift detection** — reads the snapshots, runs ADWIN per entity.

Each child docs its own benchmark; the **Phase 3 acceptance benchmark** is end-to-end: against `synthetic-10k`, run two consecutive `semantic-clustering/compute` calls (between which we artificially perturb a few entities' centroids to simulate drift), assert clusters stable on unchanged entities and drift events emitted only for perturbed entities.

## 4. Verification

### 4.1 Phase-level checks

- Migration `015_entity_clusters.sql` + `016_entity_drift_events.sql` apply cleanly
- Single `POST /api/semantic-clustering/compute` populates both tables
- All cluster columns (`24.1`) populated for every entity with a non-NULL centroid
- Drift events emitted only when drift_magnitude > threshold AND the entity has a prior cluster assignment
- `graph_stats.embedding_cluster_count` matches `COUNT(DISTINCT cluster_id) WHERE cluster_id != -1`
- `cluster_columns_version` bumped after each successful compute

### 4.2 Phase-level acceptance for `bd close`

- All children docs' acceptance criteria met
- Phase-level §4.1 checks pass
- Phase 3 benchmark §5.1 thresholds met
- Cross-feature integration test green: simulate drift on 10 entities of `synthetic-10k`, verify exactly 10 drift events emitted, clusters of unchanged entities are stable

## 5. Benchmark

End-to-end `POST /api/semantic-clustering/compute` against `synthetic-10k`:

| Operation | Target | Hard cap |
|---|---|---|
| Read entity_meta centroids | < 500 ms | 2 s |
| HDBSCAN | < 5 s | 15 s |
| Drift detection (per-entity ADWIN update) | < 1 s | 5 s |
| Write-back | < 2 s | 5 s |
| graph_stats backfill | < 500 ms | 2 s |
| **Total wall clock** | **< 10 s** | **30 s** |

Per-feature thresholds in children docs.

## 6. Edge cases (phase-level)

| Case | Expected behaviour |
|---|---|
| Empty graph | No rows in either table; no error. |
| All entity_meta.centroid IS NULL | HDBSCAN skipped; entity_clusters empty; no drift events. |
| Single entity with centroid | One row in entity_clusters with cluster_id = -1 (noise; can't form a cluster of 1 unless min_cluster_size = 1). |
| Two entities very close in embedding space | One cluster of size 2 (assuming min_cluster_size ≤ 2). |
| Concurrent compute | Rejected via the `topology_compute_runs`-style status pattern (extended to semantic clustering). |
| Drift event for an entity since deleted (cascade) | The drift event's FK is invalidated by ON DELETE CASCADE; the row is removed. |
| HDBSCAN fails (rare; bad numerical state) | Wrapped in try/catch; the failure is recorded in `topology_compute_runs.error_detail`; previous snapshots persist. |
| Reconciliation agent invocation fails on a drift event | `triggered_action='reconciliation_failed'`; `error_detail` captures; the drift event is preserved for retry. |

Per-feature edge cases in children.

## 7. Iteration cycle

Per-feature iteration cycles in children. Phase-level concerns:

- **HDBSCAN parameter changes** (min_cluster_size, min_samples) bump `computation_version`. Backfill happens on the next periodic compute.
- **Drift threshold changes** trigger a re-evaluation: existing drift events older than the new threshold are not retroactively expired; new compute uses the new threshold.
- **New corpora that produce unusual cluster shape** (e.g. all noise, or one mega-cluster) extend fixtures and the parameter sweep.

## 8. References

### Existing docs
- `21-cluster-bridging-master.md` — master plan
- `22-graph-stats-foundation.md` §7.4 — Phase 1 forward reference, cluster column backfill
- `23-topology-primitives.md` — sibling phase; topology and clustering compose
- `06-graph-meta-layer.md` lines 204-211 — original Phase 3+ vision (embedding drift, identity transitions)
- `28-test-data-snapshots.md` — provides snapshots for benchmarks

### Per-feature docs
- `24.1-hdbscan-clustering.md`
- `24.2-drift-detection.md`

### Libraries
- HDBSCAN — https://hdbscan.readthedocs.io
- river (ADWIN) — https://riverml.xyz

---

*Phase 3 master. Children carry per-feature contracts; this doc owns integration concerns. Bead structure: one phase task, two implementation tasks (one per child).*
