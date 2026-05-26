"""
Topology Compute Service — Phase 2 (T0 topology primitives).

Implements docs/architecture/truth-graph/23-topology-primitives.md §2.3 and
§8.1, plus the connected-components contract in 23.1 §3.1-§3.2.

Single endpoint:

    POST /topology/compute

Drives the full Phase 2 unified compute pipeline:

    _acquire_run → _export_graph → compute_components (and siblings) → _write_back → _complete_run

All work runs in one Postgres transaction guarded by a
pg_try_advisory_xact_lock (bead nmemo-2yv.87, see app/core/locks.py). Partial
failure rolls back the entire transaction — the in-progress topology_compute_runs
row is rolled back alongside the rest, so failures leave no row behind. Only
successful completions persist.

Currently shipped (all five Phase 2 features populated):
  - 23.1 compute_components (real implementation, igraph-backed)
  - 23.2 compute_k_core (real implementation, igraph-backed)
  - 23.3 compute_articulation + compute_bridges (real implementation, igraph-backed)
  - 23.4 compute_communities (real implementation, leidenalg-backed)
  - 23.5 compute_centrality — PageRank + sampled betweenness (real;
    igraph.pagerank + networkx.betweenness_centrality with k-pair sampling
    per Riondato-Kornaropoulos KDD 2014; exact igraph fallback for n<=200)

The DP1 (a) decision (full Phase 2 schema in migration 014, NULL-tolerant
columns progressively populated) means migration 014 was sized for all five
features up-front; the sibling write-back contract did not need extending.
"""

from __future__ import annotations

import logging
import os
import random
import time
from typing import Any, Optional

import igraph as ig
import leidenalg
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

# Default to the dev DB on the host; can be overridden via env. The platform
# Node service reads the same URL in src/config.ts.
_DEFAULT_DB_URL = "postgresql://cognitive:cognitive@127.0.0.1:5433/cognitive"


def _conn_str() -> str:
    raw = os.environ.get("DATABASE_URL", _DEFAULT_DB_URL)
    # postgres:// → postgresql:// for psycopg / libpq
    if raw.startswith("postgres://"):
        raw = "postgresql://" + raw[len("postgres://"):]
    return raw


# Bumped here when the algorithm changes; rewritten transactionally on every
# compute. See master §2.6: bookkeeping, not a filter for downstream consumers.
COMPUTATION_VERSION = 1

# A run older than this is considered abandoned; new compute calls clean it up
# and proceed. Master §8.1 step 3.
RUN_TIMEOUT_SECONDS = 300


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------

class TopologyComputeResponse(BaseModel):
    run_id: str
    status: str
    computation_version: int
    elapsed_ms: int
    entities_processed: int
    edge_count: int
    component_count: Optional[int] = None
    largest_component_size: Optional[int] = None
    articulation_point_count: Optional[int] = None
    bridge_count: Optional[int] = None
    community_count: Optional[int] = None
    pagerank_max: Optional[float] = None
    betweenness_max: Optional[float] = None
    notes: Optional[str] = None


@router.post("/topology/compute", response_model=TopologyComputeResponse)
def topology_compute() -> TopologyComputeResponse:
    """Run the unified topology compute routine. See module docstring."""
    start = time.perf_counter()

    with psycopg.connect(_conn_str(), row_factory=dict_row) as conn:
        try:
            # Bead nmemo-2yv.87: race-free gate. pg_try_advisory_xact_lock
            # auto-releases at transaction end (commit, rollback, connection
            # drop). The whole compute happens inside this single
            # transaction so the lock is held for the duration. No stale-
            # in_progress dance needed — a failed run rolls back the
            # acquire INSERT alongside the lock.
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT pg_try_advisory_xact_lock(%s) AS acquired",
                        (COMPUTE_LOCK_KEYS["topology"],),
                    )
                    lock_row = cur.fetchone()
                if not lock_row or not lock_row["acquired"]:
                    raise HTTPException(
                        status_code=409,
                        detail="topology compute already in progress. Try again after it finishes.",
                    )

                run_id = _acquire_run(conn)

                # ------- export -------------------------------------------------
                graph, entity_count, edge_count = _export_graph(conn)

                # ------- compute -----------------------------------------------
                components = compute_components(graph)
                k_core = compute_k_core(graph)
                articulation = compute_articulation(graph)
                bridges = compute_bridges(graph)
                communities = compute_communities(graph, computation_version=COMPUTATION_VERSION)
                centrality = compute_centrality(graph)

                # ------- write-back (single transaction per master §2.3.2) ----
                _write_back(
                    conn,
                    components=components,
                    k_core=k_core,
                    articulation=articulation,
                    communities=communities,
                    centrality=centrality,
                    bridges=bridges,
                    computation_version=COMPUTATION_VERSION,
                )

                elapsed_ms = int((time.perf_counter() - start) * 1000)
                component_count = len(set(cid for cid, _ in components.values())) if components else 0
                largest_component_size = max((sz for _, sz in components.values()), default=0)
                articulation_point_count = sum(1 for v in articulation.values() if v)
                bridge_count = len(bridges)
                community_count = len(set(cid for cid, _ in communities.values())) if communities else 0
                pagerank_max = max((pr for pr, _ in centrality.values()), default=0.0) if centrality else None
                betweenness_max = max((bw for _, bw in centrality.values()), default=0.0) if centrality else None

                _complete_run(conn, run_id, status="completed", entities_processed=entity_count)

                return TopologyComputeResponse(
                    run_id=run_id,
                    status="completed",
                    computation_version=COMPUTATION_VERSION,
                    elapsed_ms=elapsed_ms,
                    entities_processed=entity_count,
                    edge_count=edge_count,
                    component_count=component_count,
                    largest_component_size=largest_component_size,
                    articulation_point_count=articulation_point_count,
                    bridge_count=bridge_count,
                    community_count=community_count,
                    pagerank_max=pagerank_max,
                    betweenness_max=betweenness_max,
                    notes="all five Phase 2 features populated: 23.1 components, 23.2 k_core, 23.3 articulation+bridges, 23.4 communities, 23.5 centrality (PageRank + sampled betweenness).",
                )
        except HTTPException:
            raise
        except Exception:  # pragma: no cover — covered via integration
            logger.exception("topology/compute failed")
            raise HTTPException(status_code=500, detail="topology compute failed")


# --------------------------------------------------------------------------
# Compute functions (one per Phase 2 feature)
# --------------------------------------------------------------------------

def compute_components(g: ig.Graph) -> dict[str, tuple[int, int]]:
    """
    23.1 Connected components.

    Returns {entity_id: (component_id, component_size)}.

    Component IDs are deterministic: sorted by (size desc, smallest member
    UUID asc), then numbered 0..N-1. Per doc 23.1 §2.3.
    """
    if g.vcount() == 0:
        return {}

    raw = g.connected_components()  # mode kw redundant on undirected
    member_lists: list[list[int]] = [list(component) for component in raw]

    # Canonical sort: size desc, smallest member UUID (vertex name) asc
    sorted_components = sorted(
        member_lists,
        key=lambda members: (-len(members), min(g.vs[i]["name"] for i in members)),
    )

    result: dict[str, tuple[int, int]] = {}
    for component_id, members in enumerate(sorted_components):
        size = len(members)
        for vertex_idx in members:
            entity_id = g.vs[vertex_idx]["name"]
            result[entity_id] = (component_id, size)
    return result


def compute_k_core(g: ig.Graph) -> dict[str, int]:
    """
    23.2 k-core decomposition.

    Returns {entity_id: coreness} where coreness is the largest k such that
    the vertex belongs to the k-core (a maximal subgraph in which every
    vertex has degree ≥ k). Per doc 23.2 §3.1.

    Algorithm: Batagelj & Zaveršnik O(n + m) coreness via igraph.Graph.coreness.
    The graph projection (active facts ∪ same_as_links, undirected, no
    self-references) is built upstream by `_export_graph`; this function is
    pure and stateless.

    Edge cases handled:
      - Empty graph → empty dict (igraph 1.0.0's coreness returns [] but
        we guard explicitly to avoid version-dependent surprises).
      - Isolated vertex → k_core=0 (degree 0).
      - Self-references already filtered upstream.
    """
    if g.vcount() == 0:
        return {}

    coreness_values = g.coreness(mode="all")  # 'all' = treat as undirected
    return {
        g.vs[i]["name"]: int(coreness_values[i])
        for i in range(g.vcount())
    }


def compute_articulation(g: ig.Graph) -> dict[str, bool]:
    """
    23.3 Articulation points.

    Returns {entity_id: is_articulation_point} for every vertex in the graph
    (True for cut vertices; False otherwise — explicit value preserves
    `is_articulation_point NOT NULL DEFAULT FALSE` semantics in
    entity_topology).

    Algorithm: Tarjan's depth-first articulation algorithm via
    igraph.Graph.articulation_points(), O(n + m). Per master §2.4 the
    DFS forest visits one component at a time, so the result naturally
    spans every component in the graph.

    Edge cases (per 23.3 §2.4 + §6):
      - Empty graph → empty dict.
      - Vertex in a component of size 1 → not an articulation point.
      - Vertex in a component of size 2 → not an articulation point.
      - Self-references already filtered in `_export_graph`.
    """
    if g.vcount() == 0:
        return {}

    cut_indices = set(g.articulation_points())
    return {
        g.vs[i]["name"]: (i in cut_indices)
        for i in range(g.vcount())
    }


# A single bridge edge mapped back to a fact_id XOR same_as_link_id.
# Tuple shape: (low_entity_id, high_entity_id, fact_id_or_None, same_as_link_id_or_None).
# `low/high` enforce master §2.3.2 LEAST/GREATEST canonical ordering so the
# `topology_bridges_ordering` CHECK constraint passes on insert.
BridgeRow = tuple[str, str, Optional[str], Optional[str]]


def compute_bridges(g: ig.Graph) -> list[BridgeRow]:
    """
    23.3 Bridge edges.

    Returns a list of canonicalised (low_id, high_id, fact_id, same_as_link_id)
    rows ready for bulk insertion into public.topology_bridges. Exactly one of
    fact_id / same_as_link_id is non-None per row, matching the table's
    `topology_bridges_one_kind` CHECK constraint.

    Algorithm: igraph.Graph.bridges() (Tarjan, O(n + m)). The export-time
    edge attributes `kind` and `edge_id` (set by `_export_graph`) are used to
    map igraph edge indices back to either a fact_id or a same_as_link_id.

    Edge ordering for the canonical column constraint
    (`source_entity_id < target_entity_id`) is enforced row-by-row via Python
    string compare on the entity-id UUIDs — equivalent to PG `LEAST/GREATEST`
    on UUID strings, since UUID textual ordering matches.

    Multi-edge handling (master §2.2): igraph.bridges() inherently won't
    flag an edge whose endpoints are also connected by another edge (the
    parallel edge keeps the graph connected on removal). So a fact + same_as
    on the same vertex pair simply doesn't appear in the result. No special
    deduplication is required here.
    """
    if g.ecount() == 0:
        return []

    bridge_indices = g.bridges()
    rows: list[BridgeRow] = []
    for edge_idx in bridge_indices:
        edge = g.es[edge_idx]
        src_uuid = g.vs[edge.source]["name"]
        dst_uuid = g.vs[edge.target]["name"]
        if src_uuid < dst_uuid:
            low, high = src_uuid, dst_uuid
        else:
            low, high = dst_uuid, src_uuid
        kind = edge["kind"]
        edge_id = edge["edge_id"]
        if kind == "fact":
            rows.append((low, high, edge_id, None))
        elif kind == "same_as":
            rows.append((low, high, None, edge_id))
        else:  # pragma: no cover — defensive; export only emits these two
            raise ValueError(f"unexpected edge kind in bridge result: {kind!r}")
    return rows


# Doc 23.4 §2.4 / cold-eyes review W2 — leidenalg.find_partition() in 0.10.x
# does not accept a `seed=` kwarg (0.11.x does, but we stay version-stable by
# pinning the random source at the igraph level instead). Identical
# computation_version + identical input → identical community assignments.
LEIDEN_SEED_SALT = 0x10c4_ce11  # arbitrary fixed salt; keep stable across versions
# Doc 23.4 §2.3 — modularity formulation default; tuning deferred.
LEIDEN_RESOLUTION = 1.0
# Doc 23.4 §3.1 — leidenalg's recommended n_iterations default for converged
# partitions. Two passes is the published Leiden contract.
LEIDEN_N_ITERATIONS = 2


def _compute_seed(computation_version: int) -> int:
    """Derive the per-run seed from the computation version + a fixed salt.

    Single source of truth so test drivers and benchmark scripts can predict
    the seed without re-deriving the formula.
    """
    return (computation_version * 1_000_003) ^ LEIDEN_SEED_SALT


def _canonicalise_community_ids(membership: list[int], g: ig.Graph) -> list[int]:
    """Re-label membership[i] using doc 23.4 §2.5 canonical ordering.

    Sort communities by (size desc, smallest member UUID asc), then number
    them 0..N-1. Returns a new list parallel to vertex order.
    """
    # Bucket vertices by raw leiden label.
    buckets: dict[int, list[int]] = {}
    for vidx, label in enumerate(membership):
        buckets.setdefault(label, []).append(vidx)

    # Canonical sort: size desc, smallest member UUID asc.
    sorted_labels = sorted(
        buckets.keys(),
        key=lambda lbl: (
            -len(buckets[lbl]),
            min(g.vs[i]["name"] for i in buckets[lbl]),
        ),
    )
    relabel = {old: new for new, old in enumerate(sorted_labels)}
    return [relabel[m] for m in membership]


def _compute_participation(g: ig.Graph, community_ids: list[int]) -> list[Optional[float]]:
    """Guimerà-Amaral participation coefficient (Nature 2005).

    P(v) = 1 - sum_over_communities_c [ (k_v_c / k_v) ** 2 ]

    Returns a list parallel to vertex order. Per doc 23.4 §6:
      - degree-0 vertex → None (NULL on disk; "couldn't compute")
      - degree>0 vertex with all neighbours in same community → 0.0 (computed,
        zero — distinguishes from the NULL case)
    """
    n = g.vcount()
    out: list[Optional[float]] = [None] * n
    if n == 0:
        return out

    degrees = g.degree()  # undirected degree per vertex
    for v in range(n):
        k_v = degrees[v]
        if k_v == 0:
            out[v] = None
            continue
        # Tally neighbour community memberships. Self-loops are filtered
        # upstream (`_export_graph` skips subject==object), but defensively
        # exclude self if it ever slipped in.
        per_comm: dict[int, int] = {}
        for nb in g.neighbors(v):
            cid = community_ids[nb]
            per_comm[cid] = per_comm.get(cid, 0) + 1
        s = 0.0
        for k_v_c in per_comm.values():
            ratio = k_v_c / k_v
            s += ratio * ratio
        out[v] = float(1.0 - s)
    return out


def compute_communities(
    g: ig.Graph,
    computation_version: int = COMPUTATION_VERSION,
) -> dict[str, tuple[int, Optional[float]]]:
    """
    23.4 Community detection — Leiden algorithm via leidenalg.

    Returns {entity_id: (community_id, participation_coef)} where:
      - community_id is canonically assigned (size desc, smallest-member-UUID
        tiebreak), 0..N-1
      - participation_coef is the Guimerà-Amaral coefficient, or None for
        zero-degree (isolated) vertices

    Algorithm: leidenalg.find_partition with ModularityVertexPartition,
    n_iterations=2. Determinism is enforced at the igraph level via
    igraph.set_random_number_generator() — leidenalg 0.10.x does not accept a
    `seed=` kwarg (cold-eyes review W2 in doc 23.4 §2.4). Identical
    computation_version + identical input → identical assignments.

    Edge cases (per doc 23.4 §6):
      - Empty graph → {}
      - Single entity → community_id=0, participation_coef=None
      - Two disconnected entities → two communities of size 1 each
      - Disconnected components → communities never span components
      - Vertex with all neighbours in same community → 0.0 (not None)
    """
    if g.vcount() == 0:
        return {}

    # Pin igraph's random source for determinism. Doc 23.4 §2.4.
    seed = _compute_seed(computation_version)
    rng = random.Random(seed)
    ig.set_random_number_generator(rng)

    partition = leidenalg.find_partition(
        g,
        leidenalg.ModularityVertexPartition,
        n_iterations=LEIDEN_N_ITERATIONS,
    )
    raw_membership: list[int] = list(partition.membership)
    canonical_ids = _canonicalise_community_ids(raw_membership, g)
    participation = _compute_participation(g, canonical_ids)

    return {
        g.vs[i]["name"]: (canonical_ids[i], participation[i])
        for i in range(g.vcount())
    }


# Doc 23.5 §2.1 — PageRank damping factor. The historical Page-Brin default
# 0.85; well-tuned for web-scale graphs and equally reasonable here.
PAGERANK_DAMPING = 0.85
# Doc 23.5 §2.1 — power-iteration convergence tolerance on L1 norm.
PAGERANK_EPS = 1e-6
# Doc 23.5 §2.4 — sampled betweenness pair count (Riondato-Kornaropoulos).
# k=500 keeps top-100 entity ranking stability per doc 23.5 §5.3 while fitting
# this hardware's CPython under master 23 §5.1's 30s end-to-end hard cap on
# synthetic-10k (k=1000 measured at 18-27s component-only on this machine,
# pushing total wall-clock to 35-39s; k=500 cuts component time roughly in
# half). Override via env BETWEENNESS_SAMPLE_SIZE for tuning.
BETWEENNESS_SAMPLE_SIZE_DEFAULT = 500
# Doc 23.5 §2.4 — exact-betweenness fallback threshold. For n <= 200,
# igraph's full O(n*m) betweenness is feasible and gives perfect fidelity.
BETWEENNESS_EXACT_THRESHOLD = 200
# Doc 23.5 §3.1 — deterministic seed for NetworkX's pair sampler.
BETWEENNESS_SEED = 42


def compute_pagerank(g: ig.Graph, damping: float = PAGERANK_DAMPING) -> dict[str, float]:
    """
    23.5 PageRank — whole-graph, undirected projection.

    Returns {entity_id: pagerank_value} with values that sum to 1.0 (within
    convergence tolerance of PAGERANK_EPS = 1e-6 — the algorithm's own
    convergence threshold; tighter test tolerances would fail spuriously per
    doc 23.5 §4.2 cold-eyes review W1).

    Algorithm: power-iteration via igraph.Graph.pagerank with damping=0.85
    (doc 23.5 §2.1) and convergence eps=1e-6. Damping handles disconnected
    components naturally — every vertex receives mass via the teleport
    probability regardless of its component.

    Edge cases (per doc 23.5 §6):
      - Empty graph → empty dict.
      - Single vertex → {only_id: 1.0}.
      - Two disconnected entities → each 0.5 (uniform stationary distribution).
    """
    if g.vcount() == 0:
        return {}
    # igraph 1.0.0's pagerank uses the PRPACK implementation by default which
    # converges to machine precision well below PAGERANK_EPS — there is no
    # `eps=` kwarg to pass through. PAGERANK_EPS is the assertion tolerance
    # we expose to test code (doc 23.5 §4.2 cold-eyes review W1).
    pr = g.pagerank(damping=damping, directed=False)
    return {g.vs[i]["name"]: float(pr[i]) for i in range(g.vcount())}


def compute_betweenness(
    g: ig.Graph,
    sample_size: Optional[int] = None,
) -> dict[str, float]:
    """
    23.5 Sampled betweenness centrality — bridge-ness.

    Returns {entity_id: betweenness_normalised} with values in [0, 1]. For
    each vertex, captures how often it sits on shortest paths between pairs
    of other vertices (or a sampled subset thereof).

    Algorithm (doc 23.5 §3.1, cold-eyes review B3):
      - n <= BETWEENNESS_EXACT_THRESHOLD (200) → exact via igraph
        (O(n*m) Brandes 2001), then normalised by dividing by the maximum
        possible betweenness (n-1)(n-2)/2.
      - n > 200 → sampled via NetworkX betweenness_centrality(k=sample_size)
        which implements Riondato-Kornaropoulos KDD 2014 source-vertex
        sampling. NetworkX's `normalized=True` returns values already in
        [0, 1]; the deterministic `seed=42` makes the sample reproducible.

    igraph's own betweenness() does NOT accept a sample_size kwarg — that's
    why this function delegates to NetworkX for the sampled branch (per doc
    23.5 §3.1 / cold-eyes review B3).

    The sample size source-of-truth (doc 23.5 §2.4):
      - explicit kwarg overrides everything
      - env BETWEENNESS_SAMPLE_SIZE if set
      - BETWEENNESS_SAMPLE_SIZE_DEFAULT (1000) otherwise

    Edge cases (per doc 23.5 §6):
      - Empty graph → {}.
      - Single / two-vertex graphs → all betweenness = 0.0 (no shortest path
        of length >= 2 exists).
      - Vertices in components of size < 3 → 0.0 (no shortest paths through them).
      - sample_size 0 → ValueError.
      - sample_size > n (more pairs than vertices) → falls back to exact.
    """
    n = g.vcount()
    if n == 0:
        return {}

    if sample_size is None:
        env = os.environ.get("BETWEENNESS_SAMPLE_SIZE")
        sample_size = int(env) if env else BETWEENNESS_SAMPLE_SIZE_DEFAULT
    if sample_size <= 0:
        raise ValueError(
            f"BETWEENNESS_SAMPLE_SIZE must be > 0; got {sample_size}"
        )

    # Trivial cases: no shortest paths of length >= 2 exist.
    if n < 3:
        return {g.vs[i]["name"]: 0.0 for i in range(n)}

    use_exact = (n <= BETWEENNESS_EXACT_THRESHOLD) or (sample_size >= n)

    if use_exact:
        # igraph: full Brandes; normalise by max possible.
        bw = g.betweenness(directed=False)
        max_bw = (n - 1) * (n - 2) / 2.0
        return {
            g.vs[i]["name"]: float(bw[i]) / max_bw if max_bw > 0 else 0.0
            for i in range(n)
        }

    # Sampled branch via NetworkX. We import here so the import only fires on
    # graphs large enough to need it.
    import networkx as nx  # noqa: PLC0415 — lazy by design
    nx_g = g.to_networkx().to_undirected()
    # NetworkX dict keys are igraph vertex indices (0..n-1), per
    # g.to_networkx() convention; map back via igraph's vertex sequence.
    bw_dict = nx.betweenness_centrality(
        nx_g,
        k=sample_size,
        normalized=True,
        seed=BETWEENNESS_SEED,
    )
    return {
        g.vs[i]["name"]: float(bw_dict.get(i, 0.0))
        for i in range(n)
    }


def compute_centrality(g: ig.Graph) -> dict[str, tuple[float, float]]:
    """
    23.5 Centrality — orchestrates compute_pagerank + compute_betweenness.

    Returns {entity_id: (pagerank, betweenness_sampled)} for every vertex.
    Both values are pre-normalised; pagerank sums to 1.0 globally, betweenness
    is in [0, 1].

    Empty graph → {}. Otherwise every vertex appears in the result with both
    values populated (zero is a legitimate value, not a missing one).
    """
    if g.vcount() == 0:
        return {}
    pr = compute_pagerank(g)
    bw = compute_betweenness(g)
    return {
        eid: (pr.get(eid, 0.0), bw.get(eid, 0.0))
        for eid in pr.keys()
    }


# --------------------------------------------------------------------------
# Run lifecycle (master §8.1)
# --------------------------------------------------------------------------

def _check_in_progress(conn: psycopg.Connection) -> Optional[str]:
    """Return run_id of a fresh-enough in-progress row, else None.

    Stale in-progress rows older than RUN_TIMEOUT_SECONDS are auto-marked
    'failed' here so a crashed sidecar doesn't block forever.
    """
    with conn.cursor() as cur:
        # Mark abandoned in-progress rows as failed.
        cur.execute(
            """
            UPDATE public.topology_compute_runs
            SET status = 'failed',
                completed_at = NOW(),
                error_detail = 'janitor: abandoned by stale sidecar (older than timeout)'
            WHERE status = 'in_progress'
              AND started_at < NOW() - INTERVAL '%s seconds'
            """ % RUN_TIMEOUT_SECONDS
        )
        cur.execute(
            "SELECT id::text AS id FROM public.topology_compute_runs WHERE status = 'in_progress' LIMIT 1"
        )
        row = cur.fetchone()
        return row["id"] if row else None


def _acquire_run(conn: psycopg.Connection) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.topology_compute_runs (status, computation_version)
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
    error_detail: Optional[str] = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.topology_compute_runs
            SET completed_at = NOW(),
                status = %s,
                entities_processed = %s,
                error_detail = %s
            WHERE id = %s::uuid
            """,
            (status, entities_processed, error_detail, run_id),
        )


# --------------------------------------------------------------------------
# Graph export (master §2.3.1 — deterministic ordering lock)
# --------------------------------------------------------------------------

def _export_graph(conn: psycopg.Connection) -> tuple[ig.Graph, int, int]:
    """
    Build the in-memory igraph from current Postgres state.

    Vertex set = entities (ORDER BY id) → vertex.name = entity_id (str).
    Edge set = active facts where object_entity_id IS NOT NULL (excluding
    self-references) ∪ same_as_links. Edge ordering: fact edges first,
    then same_as edges, ties broken by edge_id ASC. Per master §2.3.1.

    Self-referential facts (subject = object) are excluded — per 23.1 §2.1
    they don't affect connectivity.

    Returns (graph, entity_count, edge_count).
    """
    with conn.cursor() as cur:
        cur.execute("SELECT id::text AS id FROM public.entities ORDER BY id")
        entity_rows = cur.fetchall()
        entity_ids = [row["id"] for row in entity_rows]
        idx_of = {eid: i for i, eid in enumerate(entity_ids)}

        cur.execute(
            """
            SELECT 'fact' AS edge_kind, id::text AS edge_id,
                   subject_entity_id::text AS src, object_entity_id::text AS dst
            FROM public.facts
            WHERE expired_at IS NULL
              AND object_entity_id IS NOT NULL
              AND subject_entity_id <> object_entity_id
            UNION ALL
            SELECT 'same_as' AS edge_kind, id::text AS edge_id,
                   entity_a_id::text AS src, entity_b_id::text AS dst
            FROM public.same_as_links
            ORDER BY edge_kind, edge_id
            """
        )
        edge_rows = cur.fetchall()

    g = ig.Graph(directed=False)
    g.add_vertices(len(entity_ids))
    g.vs["name"] = entity_ids

    edges: list[tuple[int, int]] = []
    edge_kinds: list[str] = []
    edge_ids: list[str] = []
    for row in edge_rows:
        src_idx = idx_of.get(row["src"])
        dst_idx = idx_of.get(row["dst"])
        if src_idx is None or dst_idx is None:
            # Endpoint missing from entities — defensive skip; shouldn't happen
            # given FK cascade, but cheap insurance.
            continue
        edges.append((src_idx, dst_idx))
        edge_kinds.append(row["edge_kind"])
        edge_ids.append(row["edge_id"])

    if edges:
        g.add_edges(edges)
        # Edge attributes parallel the vertex `name` attribute pattern: they
        # ride alongside igraph's edge index so 23.3 can map bridge indices
        # back to the originating fact_id / same_as_link_id without
        # reconstructing edge ordering.
        g.es["kind"] = edge_kinds
        g.es["edge_id"] = edge_ids

    return g, len(entity_ids), len(edges)


# --------------------------------------------------------------------------
# Write-back (master §2.3.2 — canonical upsert)
# --------------------------------------------------------------------------

def _write_back(
    conn: psycopg.Connection,
    *,
    components: dict[str, tuple[int, int]],
    k_core: dict[str, int],
    articulation: dict[str, bool],
    communities: dict[str, tuple[int, Optional[float]]],
    centrality: dict[str, tuple[float, float]],
    bridges: Optional[list[BridgeRow]] = None,
    computation_version: int,
) -> None:
    """
    Single bulk upsert covering every entity in the graph that any compute_*
    function returned a result for. Master §2.3.2.

    Each feature contributes its own columns; absent results stay NULL on
    INSERT (default) and are not overwritten on UPDATE either (we explicitly
    only SET feature columns whose dict has the entity_id).

    Implementation note: master §2.3.2 specifies one upsert across all five
    features. Until the siblings ship, only `components` populates entries,
    so the unioned key set equals components.keys(). When siblings light up
    they extend the key union without changing the SQL shape — that's the
    DP1/DP2 (a) story.
    """
    all_entity_ids: set[str] = (
        set(components.keys())
        | set(k_core.keys())
        | set(articulation.keys())
        | set(communities.keys())
        | set(centrality.keys())
    )

    rows: list[tuple[Any, ...]] = []
    for entity_id in all_entity_ids:
        comp = components.get(entity_id)
        comm = communities.get(entity_id)
        cent = centrality.get(entity_id)
        rows.append((
            entity_id,
            comp[0] if comp else None,                          # component_id
            comp[1] if comp else None,                          # component_size
            k_core.get(entity_id),                              # k_core
            articulation.get(entity_id, False),                 # is_articulation_point
            comm[0] if comm else None,                          # community_id
            comm[1] if comm else None,                          # participation_coef
            cent[0] if cent else None,                          # pagerank
            cent[1] if cent else None,                          # betweenness_sampled
            computation_version,
        ))

    with conn.cursor() as cur:
        if rows:
            # executemany is fine here; entity counts are bounded by the graph
            # export at sub-second speeds even for 10k. For the 100k+ horizon,
            # a COPY-based path would be added.
            cur.executemany(
                """
                INSERT INTO public.entity_topology (
                    entity_id, component_id, component_size, k_core,
                    is_articulation_point, community_id, participation_coef,
                    pagerank, betweenness_sampled,
                    computed_at, computation_version
                ) VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, NOW(), %s)
                ON CONFLICT (entity_id) DO UPDATE SET
                    component_id          = EXCLUDED.component_id,
                    component_size        = EXCLUDED.component_size,
                    k_core                = EXCLUDED.k_core,
                    is_articulation_point = EXCLUDED.is_articulation_point,
                    community_id          = EXCLUDED.community_id,
                    participation_coef    = EXCLUDED.participation_coef,
                    pagerank              = EXCLUDED.pagerank,
                    betweenness_sampled   = EXCLUDED.betweenness_sampled,
                    computed_at           = NOW(),
                    computation_version   = EXCLUDED.computation_version
                """,
                rows,
            )

        # ---------- 23.3 §3.2: rewrite topology_bridges ----------
        # `bridges=None` is the legacy call shape (used by the .2.1 / .2.2 test
        # drivers that don't yet exercise this feature) — leave the table
        # untouched in that case. When .2.3 ships, callers always pass a list
        # (possibly empty) and we DELETE-then-INSERT in the same transaction
        # per master §2.3.2 / cold-eyes review B1 (unconditional DELETE,
        # canonical ordering enforced by `compute_bridges`).
        if bridges is not None:
            cur.execute("DELETE FROM public.topology_bridges")
            if bridges:
                bridge_rows = [
                    (low, high, fact_id, same_as_link_id, computation_version)
                    for (low, high, fact_id, same_as_link_id) in bridges
                ]
                cur.executemany(
                    """
                    INSERT INTO public.topology_bridges
                        (source_entity_id, target_entity_id, fact_id, same_as_link_id, computation_version)
                    VALUES
                        (%s::uuid, %s::uuid, %s::uuid, %s::uuid, %s)
                    ON CONFLICT (source_entity_id, target_entity_id) DO NOTHING
                    """,
                    bridge_rows,
                )
