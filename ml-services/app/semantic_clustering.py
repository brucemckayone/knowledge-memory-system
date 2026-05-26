"""
Semantic Clustering Compute Service — Phase 3 (T1 semantic-space).

Implements docs/architecture/truth-graph/24.1-hdbscan-clustering.md §3.

Single endpoint:

    POST /clustering/compute

Drives the full Phase 3.1 pipeline:

    _acquire_run -> _export_centroids -> compute_hdbscan -> _write_back ->
    _update_graph_stats -> _complete_run

All work runs in one Postgres transaction guarded by a
pg_try_advisory_xact_lock (bead nmemo-2yv.87, see app/core/locks.py). Partial
failure rolls back the entire transaction — the in-progress clustering_compute_runs
row is rolled back alongside the rest, so failures leave no row behind. Only
successful completions persist.

Algorithm: HDBSCAN (Campello-Moulavi-Sander, PAKDD 2013) via the `hdbscan`
PyPI package, cosine distance metric. min_cluster_size and min_samples are
env-tunable (HDBSCAN_MIN_CLUSTER_SIZE, HDBSCAN_MIN_SAMPLES).

Key contracts (per doc 24.1 §2.3 + master §10 lock B):
- Reads live entity_meta.centroid; writes a stable centroid_snapshot to
  entity_clusters at clustering time. Drift detection (24.2) compares live
  vs snapshot.
- Canonical cluster_id assignment: 0 = largest cluster, 1 = next, etc.
  -1 = noise (HDBSCAN's label, preserved verbatim). Tiebreak by smallest
  member UUID (mirrors topology.py components / communities).
- Input row order enforced via ORDER BY entity_id ASC for determinism
  (§2.4 cold-eyes review W1).
- graph_stats backfill (§2.5) atomic with the entity_clusters write —
  embedding_cluster_count, mean_intra_cluster_distance,
  mean_inter_cluster_distance, cluster_columns_version per doc 22 §7.4.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Optional

import numpy as np
import psycopg
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from psycopg.rows import dict_row

from .core.locks import COMPUTE_LOCK_KEYS

logger = logging.getLogger(__name__)
router = APIRouter()

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

# Default to the dev DB on the host; override via env. Same shape as topology.py.
_DEFAULT_DB_URL = "postgresql://cognitive:cognitive@127.0.0.1:5433/cognitive"


def _conn_str() -> str:
    raw = os.environ.get("DATABASE_URL", _DEFAULT_DB_URL)
    if raw.startswith("postgres://"):
        raw = "postgresql://" + raw[len("postgres://"):]
    return raw


# Bumped here when the algorithm or hyperparameters change.
COMPUTATION_VERSION = 1

# A run older than this is considered abandoned; new compute calls clean it up
# and proceed. Mirrors topology.py.
RUN_TIMEOUT_SECONDS = 300

# Doc 24.1 §2.2 — hyperparameters, env-tunable.
DEFAULT_MIN_CLUSTER_SIZE = 5
DEFAULT_MIN_SAMPLES = 5


def _hdbscan_min_cluster_size() -> int:
    return int(os.environ.get("HDBSCAN_MIN_CLUSTER_SIZE", DEFAULT_MIN_CLUSTER_SIZE))


def _hdbscan_min_samples() -> int:
    return int(os.environ.get("HDBSCAN_MIN_SAMPLES", DEFAULT_MIN_SAMPLES))


# --------------------------------------------------------------------------
# Public API model
# --------------------------------------------------------------------------

class ClusteringComputeResponse(BaseModel):
    run_id: str
    status: str
    computation_version: int
    elapsed_ms: int
    entities_processed: int
    cluster_count: int
    noise_count: int
    mean_intra_cluster_distance: Optional[float] = None
    mean_inter_cluster_distance: Optional[float] = None
    notes: Optional[str] = None


@router.post("/clustering/compute", response_model=ClusteringComputeResponse)
def clustering_compute() -> ClusteringComputeResponse:
    """Run the unified clustering compute routine. See module docstring."""
    start = time.perf_counter()

    with psycopg.connect(_conn_str(), row_factory=dict_row) as conn:
        try:
            # Bead nmemo-2yv.87: race-free gate via pg_try_advisory_xact_lock.
            # See topology.py for the full pattern rationale.
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT pg_try_advisory_xact_lock(%s) AS acquired",
                        (COMPUTE_LOCK_KEYS["semantic_clustering"],),
                    )
                    lock_row = cur.fetchone()
                if not lock_row or not lock_row["acquired"]:
                    raise HTTPException(
                        status_code=409,
                        detail="clustering compute already in progress. Try again after it finishes.",
                    )

                run_id = _acquire_run(conn)

                centroids = _export_centroids(conn)
                assignments = compute_hdbscan(
                    centroids,
                    min_cluster_size=_hdbscan_min_cluster_size(),
                    min_samples=_hdbscan_min_samples(),
                )

                cluster_count, noise_count, intra_mean, inter_mean = _summarise(assignments)

                _write_back(
                    conn,
                    assignments=assignments,
                    computation_version=COMPUTATION_VERSION,
                )

                _update_graph_stats(
                    conn,
                    cluster_count=cluster_count,
                    mean_intra=intra_mean,
                    mean_inter=inter_mean,
                    computation_version=COMPUTATION_VERSION,
                )

                elapsed_ms = int((time.perf_counter() - start) * 1000)

                _complete_run(
                    conn,
                    run_id,
                    status="completed",
                    entities_processed=len(assignments),
                    cluster_count=cluster_count,
                    noise_count=noise_count,
                )

                return ClusteringComputeResponse(
                    run_id=run_id,
                    status="completed",
                    computation_version=COMPUTATION_VERSION,
                    elapsed_ms=elapsed_ms,
                    entities_processed=len(assignments),
                    cluster_count=cluster_count,
                    noise_count=noise_count,
                    mean_intra_cluster_distance=intra_mean,
                    mean_inter_cluster_distance=inter_mean,
                    notes="HDBSCAN cosine clustering per doc 24.1 §3. centroid_snapshot frozen at clustering time per master §10 lock B.",
                )
        except HTTPException:
            raise
        except Exception:  # pragma: no cover — covered via integration
            logger.exception("clustering/compute failed")
            raise HTTPException(status_code=500, detail="clustering compute failed")


# --------------------------------------------------------------------------
# Compute (doc 24.1 §3.1)
# --------------------------------------------------------------------------

class ClusterAssignment:
    """Result of HDBSCAN for a single entity.

    Attributes:
        cluster_id: canonical cluster id (0 = largest, ..., -1 = noise).
        cluster_probability: HDBSCAN soft probability (None for noise).
        snapshot: frozen 768-dim centroid at clustering time (np.ndarray).
    """

    __slots__ = ("cluster_id", "cluster_probability", "snapshot")

    def __init__(
        self,
        cluster_id: int,
        cluster_probability: Optional[float],
        snapshot: np.ndarray,
    ) -> None:
        self.cluster_id = cluster_id
        self.cluster_probability = cluster_probability
        self.snapshot = snapshot


def _canonicalise_cluster_ids(
    raw_labels: list[int],
    entity_ids: list[str],
) -> list[int]:
    """Re-label HDBSCAN's raw ids using doc 24.1 §2.4 canonical ordering.

    - cluster_id 0 = largest cluster
    - cluster_id 1 = next largest, etc.
    - Tiebreak: smallest member UUID (entity_id) ascending.
    - cluster_id -1 (noise) is preserved verbatim — never re-labelled.

    Mirrors topology.py's _canonicalise_community_ids contract.
    """
    buckets: dict[int, list[int]] = {}
    for idx, label in enumerate(raw_labels):
        if label == -1:
            continue
        buckets.setdefault(label, []).append(idx)

    sorted_labels = sorted(
        buckets.keys(),
        key=lambda lbl: (
            -len(buckets[lbl]),
            min(entity_ids[i] for i in buckets[lbl]),
        ),
    )
    relabel = {old: new for new, old in enumerate(sorted_labels)}
    return [relabel[lbl] if lbl != -1 else -1 for lbl in raw_labels]


def compute_hdbscan(
    centroids_by_id: dict[str, np.ndarray],
    min_cluster_size: int = DEFAULT_MIN_CLUSTER_SIZE,
    min_samples: int = DEFAULT_MIN_SAMPLES,
) -> dict[str, ClusterAssignment]:
    """
    Run HDBSCAN over entity centroids.

    Returns: dict mapping entity_id -> ClusterAssignment(cluster_id, prob, snapshot).

    Algorithm: hdbscan.HDBSCAN with cosine distance. The hdbscan package's
    cosine support varies by version — to keep it robust we precompute a
    pairwise cosine distance matrix and pass metric='precomputed'. This also
    sidesteps the boolean-features warning some hdbscan versions emit on
    direct cosine calls (per doc 24.1 §3.1 "defer to doc 24.1 §3" gotcha).

    Edge cases (doc 24.1 §6):
      - 0 entities: return {} (caller writes nothing).
      - <min_cluster_size entities: every entity gets cluster_id=-1 (noise).
      - Identical centroids: HDBSCAN handles via density estimation.

    Determinism (doc 24.1 §2.4 cold-eyes review W1): caller sorts input
    centroids by entity_id ASC; insertion order is preserved here.
    """
    if not centroids_by_id:
        return {}

    # Preserve the caller's iteration order (which the export query
    # canonicalises via ORDER BY entity_id ASC). Doc 24.1 §2.4.
    entity_ids = list(centroids_by_id.keys())
    matrix = np.array([centroids_by_id[eid] for eid in entity_ids], dtype=np.float64)

    if len(entity_ids) < min_cluster_size:
        # Too few entities to form any cluster of the required min size.
        # Each entity gets the noise label and a snapshot of its own centroid.
        return {
            eid: ClusterAssignment(
                cluster_id=-1,
                cluster_probability=None,
                snapshot=matrix[i],
            )
            for i, eid in enumerate(entity_ids)
        }

    # Lazy import — hdbscan brings in numba on first import; we don't want to
    # pay for it when callers only need the canonicalisation helpers.
    import hdbscan  # noqa: PLC0415

    # Precomputed cosine distance matrix. cosine_distance = 1 - cosine_similarity.
    # We L2-normalise first so the dot product equals cosine similarity.
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    # Guard against zero vectors — replace zero norm with 1 so the row stays zero.
    norms[norms == 0] = 1.0
    normalised = matrix / norms
    similarity = normalised @ normalised.T
    # Numerical hygiene: clip to [-1, 1] to absorb float drift.
    similarity = np.clip(similarity, -1.0, 1.0)
    distance = 1.0 - similarity
    # Force exact zero on the diagonal (hdbscan requires zero-diag for precomputed).
    np.fill_diagonal(distance, 0.0)
    # Symmetrise to absorb any numerical asymmetry (X @ X.T is symmetric in
    # exact arithmetic but float drift can break ties); hdbscan asserts symmetry.
    distance = (distance + distance.T) / 2.0
    distance = distance.astype(np.float64)

    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        metric="precomputed",
        # core_dist_n_jobs=1 keeps the run deterministic / single-threaded for
        # reproducible test output.
        core_dist_n_jobs=1,
    )
    raw_labels = [int(x) for x in clusterer.fit_predict(distance)]
    raw_probs = clusterer.probabilities_

    canonical_labels = _canonicalise_cluster_ids(raw_labels, entity_ids)

    return {
        entity_ids[i]: ClusterAssignment(
            cluster_id=canonical_labels[i],
            cluster_probability=(
                float(raw_probs[i]) if canonical_labels[i] != -1 else None
            ),
            snapshot=matrix[i],
        )
        for i in range(len(entity_ids))
    }


# --------------------------------------------------------------------------
# Centroid export (doc 24.1 §2.4)
# --------------------------------------------------------------------------

def _parse_pgvector(raw: Any) -> np.ndarray:
    """Coerce a pgvector return value into a float ndarray.

    psycopg returns pgvector columns as a string '[0.1,0.2,...]' by default
    when no codec is registered. We accept both shapes (string and list) so
    callers can register a codec without breaking this function.
    """
    if isinstance(raw, str):
        s = raw.strip()
        if s.startswith("[") and s.endswith("]"):
            s = s[1:-1]
        if not s:
            return np.zeros(0, dtype=np.float64)
        return np.fromstring(s, sep=",", dtype=np.float64)
    if isinstance(raw, (list, tuple)):
        return np.asarray(raw, dtype=np.float64)
    return np.asarray(raw, dtype=np.float64)


def _export_centroids(conn: psycopg.Connection) -> dict[str, np.ndarray]:
    """Read live entity_meta.centroid for every entity that has one.

    Order: ORDER BY entity_id ASC (doc 24.1 §2.4 cold-eyes review W1) for
    determinism. Returns insertion-ordered dict (Python 3.7+ guarantee).
    """
    out: dict[str, np.ndarray] = {}
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT entity_id::text AS entity_id, centroid
            FROM public.entity_meta
            WHERE centroid IS NOT NULL
            ORDER BY entity_id ASC
            """
        )
        for row in cur:
            vec = _parse_pgvector(row["centroid"])
            if vec.size == 0:
                continue
            out[row["entity_id"]] = vec
    return out


# --------------------------------------------------------------------------
# Summary statistics for graph_stats backfill (doc 24.1 §2.5 + 22 §7.4)
# --------------------------------------------------------------------------

def _summarise(
    assignments: dict[str, ClusterAssignment],
) -> tuple[int, int, Optional[float], Optional[float]]:
    """Compute (cluster_count, noise_count, mean_intra, mean_inter).

    - cluster_count: COUNT(DISTINCT cluster_id) WHERE cluster_id != -1
    - noise_count: number of entities with cluster_id = -1
    - mean_intra_cluster_distance: average cosine distance of each non-noise
      entity to its cluster's centroid (NULL when no clusters exist).
    - mean_inter_cluster_distance: average pairwise cosine distance between
      cluster centroids (NULL when fewer than 2 clusters exist).

    Returns Python-native ints / floats / None for psycopg compatibility.
    """
    if not assignments:
        return 0, 0, None, None

    by_cluster: dict[int, list[np.ndarray]] = {}
    noise = 0
    for a in assignments.values():
        if a.cluster_id == -1:
            noise += 1
            continue
        by_cluster.setdefault(a.cluster_id, []).append(a.snapshot)

    cluster_count = len(by_cluster)

    if cluster_count == 0:
        return 0, noise, None, None

    # Cluster centroids (mean of member snapshots, then L2-normalise so cosine
    # distance is a proper [0,2] quantity).
    centroids: dict[int, np.ndarray] = {}
    intra_pairs: list[float] = []
    for cid, members in by_cluster.items():
        stacked = np.stack(members, axis=0)
        centroid = stacked.mean(axis=0)
        norm = np.linalg.norm(centroid)
        if norm == 0.0:
            normalised_centroid = centroid
        else:
            normalised_centroid = centroid / norm
        centroids[cid] = normalised_centroid

        # cosine distance from each member to the cluster centroid
        member_norms = np.linalg.norm(stacked, axis=1, keepdims=True)
        member_norms[member_norms == 0] = 1.0
        normed_members = stacked / member_norms
        sims = np.clip(normed_members @ normalised_centroid, -1.0, 1.0)
        intra_pairs.extend((1.0 - sims).tolist())

    mean_intra = float(np.mean(intra_pairs)) if intra_pairs else None

    if cluster_count < 2:
        return cluster_count, noise, mean_intra, None

    cids = sorted(centroids.keys())
    cmat = np.stack([centroids[c] for c in cids], axis=0)
    sim_mat = np.clip(cmat @ cmat.T, -1.0, 1.0)
    dist_mat = 1.0 - sim_mat
    n = len(cids)
    pairs: list[float] = []
    for i in range(n):
        for j in range(i + 1, n):
            pairs.append(float(dist_mat[i, j]))
    mean_inter = float(np.mean(pairs)) if pairs else None

    return cluster_count, noise, mean_intra, mean_inter


# --------------------------------------------------------------------------
# Write-back (doc 24.1 §3.2)
# --------------------------------------------------------------------------

def _vector_literal(vec: np.ndarray) -> str:
    """Format a float ndarray as a pgvector literal string '[a,b,c,...]'."""
    return "[" + ",".join(repr(float(x)) for x in vec) + "]"


def _write_back(
    conn: psycopg.Connection,
    *,
    assignments: dict[str, ClusterAssignment],
    computation_version: int,
) -> None:
    """Upsert one row per entity into entity_clusters (doc 24.1 §3.2).

    cluster_size is denormalised: count of entities sharing the same
    cluster_id within this run. Computed in Python and passed per-row.
    """
    if not assignments:
        # Wipe stale rows so the "0 centroids -> empty entity_clusters"
        # contract holds across re-runs.
        with conn.cursor() as cur:
            cur.execute("DELETE FROM public.entity_clusters")
        return

    size_by_cluster: dict[int, int] = {}
    for a in assignments.values():
        size_by_cluster[a.cluster_id] = size_by_cluster.get(a.cluster_id, 0) + 1

    rows: list[tuple[Any, ...]] = []
    for entity_id, a in assignments.items():
        rows.append((
            entity_id,
            a.cluster_id,
            _vector_literal(a.snapshot),
            a.cluster_probability,
            size_by_cluster[a.cluster_id],
            computation_version,
        ))

    with conn.cursor() as cur:
        # Remove rows for entities no longer in the assignment set (deleted
        # entities; centroid became NULL; etc.).
        cur.execute(
            """
            DELETE FROM public.entity_clusters
            WHERE entity_id NOT IN (
                SELECT entity_id FROM public.entity_meta WHERE centroid IS NOT NULL
            )
            """
        )
        cur.executemany(
            """
            INSERT INTO public.entity_clusters (
                entity_id, cluster_id, centroid_snapshot, cluster_probability,
                cluster_size, computed_at, computation_version
            ) VALUES (%s::uuid, %s, %s::vector, %s, %s, NOW(), %s)
            ON CONFLICT (entity_id) DO UPDATE SET
                cluster_id          = EXCLUDED.cluster_id,
                centroid_snapshot   = EXCLUDED.centroid_snapshot,
                cluster_probability = EXCLUDED.cluster_probability,
                cluster_size        = EXCLUDED.cluster_size,
                computed_at         = NOW(),
                computation_version = EXCLUDED.computation_version
            """,
            rows,
        )


def _update_graph_stats(
    conn: psycopg.Connection,
    *,
    cluster_count: int,
    mean_intra: Optional[float],
    mean_inter: Optional[float],
    computation_version: int,
) -> None:
    """Backfill graph_stats cluster columns per doc 22 §7.4 + doc 24.1 §2.5.

    Atomic with the entity_clusters write — they share the caller's
    transaction. If clustering rolls back, this update rolls back too.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.graph_stats SET
                embedding_cluster_count     = %s,
                mean_intra_cluster_distance = %s,
                mean_inter_cluster_distance = %s,
                cluster_columns_version     = %s
            WHERE id = 1
            """,
            (cluster_count, mean_intra, mean_inter, computation_version),
        )


# --------------------------------------------------------------------------
# Run lifecycle (mirrors topology.py)
# --------------------------------------------------------------------------

def _check_in_progress(conn: psycopg.Connection) -> Optional[str]:
    """Return run_id of a fresh-enough in-progress row, else None.

    Stale in-progress rows older than RUN_TIMEOUT_SECONDS auto-fail so a
    crashed sidecar doesn't block forever.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.clustering_compute_runs
            SET status = 'failed',
                completed_at = NOW(),
                error_detail = 'janitor: abandoned by stale sidecar (older than timeout)'
            WHERE status = 'in_progress'
              AND started_at < NOW() - INTERVAL '%s seconds'
            """ % RUN_TIMEOUT_SECONDS
        )
        cur.execute(
            "SELECT id::text AS id FROM public.clustering_compute_runs WHERE status = 'in_progress' LIMIT 1"
        )
        row = cur.fetchone()
        return row["id"] if row else None


def _acquire_run(conn: psycopg.Connection) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.clustering_compute_runs (status, computation_version)
            VALUES ('in_progress', %s)
            RETURNING id::text AS id
            """,
            (COMPUTATION_VERSION,),
        )
        row = cur.fetchone()
        assert row is not None
        return row["id"]


def _complete_run(
    conn: psycopg.Connection,
    run_id: str,
    *,
    status: str,
    entities_processed: Optional[int],
    cluster_count: Optional[int],
    noise_count: Optional[int],
    error_detail: Optional[str] = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.clustering_compute_runs
            SET completed_at = NOW(),
                status = %s,
                entities_processed = %s,
                cluster_count = %s,
                noise_count = %s,
                error_detail = %s
            WHERE id = %s::uuid
            """,
            (status, entities_processed, cluster_count, noise_count, error_detail, run_id),
        )
