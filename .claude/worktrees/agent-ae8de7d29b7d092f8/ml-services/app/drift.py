"""
Entity Drift Detection Service — Phase 3 (T1 semantic-space).

Implements docs/architecture/truth-graph/24.2-drift-detection.md §3 and the
master §10 cluster-bridging locks (21-cluster-bridging-master.md lines 427-431).

Endpoints:

    POST /drift/compute               — run the per-entity drift sweep
    POST /reconciliation-agent/drift  — sibling agent endpoint per master §10
                                         lock B1 (existing /reconciliation-agent
                                         is unchanged)

Algorithm:

    For each entity with both a live entity_meta.centroid and an
    entity_clusters.centroid_snapshot, compute cosine distance
    magnitude = clamp(1 - cos(live, snapshot), [0,1]). Feed the magnitude
    into the entity's per-entity ADWIN detector loaded from
    entity_drift_state.adwin_state_blob (pickle bytes). Update state. If
    detector.drift_detected becomes True, emit a row into
    entity_drift_events with target_cluster_id (nearest other cluster to
    centroid_current) and triggered_action='logged_only' /
    'reconciliation_invoked' (action threshold per §2.3, default 0.3).

State persistence:

    river.drift.ADWIN is pickled into BYTEA. river_version persisted
    alongside; unpickle attempts on a mismatched version reset the
    detector with a warning (master §10 lock W3). last_cluster_id
    captures the entity's HDBSCAN cluster at last sweep; reassignment
    resets ADWIN (master §10 lock B2).

Bulk-load pattern (cold-eyes review W4):
    Per-entity pickle round-trip costs ~1-3ms via CPython; at 10k entities
    that's 10-30s of pure pickle overhead and blows the §5 latency budget.
    The compute routine MUST: (a) load all states once at start; (b)
    unpickle into an in-memory dict[entity_id, ADWIN]; (c) mutate state
    objects in-process while iterating; (d) bulk INSERT ... ON CONFLICT
    DO UPDATE once at end.
"""

from __future__ import annotations

import logging
import os
import pickle
import time
from typing import Any, Optional

import numpy as np
import psycopg
from fastapi import APIRouter, HTTPException
from psycopg.rows import dict_row
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

_DEFAULT_DB_URL = "postgresql://cognitive:cognitive@127.0.0.1:5433/cognitive"


def _conn_str() -> str:
    raw = os.environ.get("DATABASE_URL", _DEFAULT_DB_URL)
    if raw.startswith("postgres://"):
        raw = "postgresql://" + raw[len("postgres://"):]
    return raw


# Bumped here when the algorithm or hyperparameters change.
COMPUTATION_VERSION = 1

RUN_TIMEOUT_SECONDS = 300

# Doc 24.2 §2.3.
DEFAULT_DRIFT_DELTA = 0.002
DEFAULT_DRIFT_ACTION_THRESHOLD = 0.3


def _drift_delta() -> float:
    return float(os.environ.get("DRIFT_DELTA", DEFAULT_DRIFT_DELTA))


def _drift_action_threshold() -> float:
    return float(os.environ.get("DRIFT_ACTION_THRESHOLD", DEFAULT_DRIFT_ACTION_THRESHOLD))


def _river_version() -> str:
    import river  # noqa: PLC0415

    return getattr(river, "__version__", "unknown")


# --------------------------------------------------------------------------
# API model
# --------------------------------------------------------------------------


class DriftComputeResponse(BaseModel):
    run_id: str
    status: str
    computation_version: int
    elapsed_ms: int
    entities_processed: int
    drift_events_count: int
    state_resets_cluster: int
    state_resets_river: int
    state_resets_corrupt: int
    skipped_no_snapshot: int
    skipped_zero_norm: int
    notes: Optional[str] = None


# --------------------------------------------------------------------------
# Endpoint
# --------------------------------------------------------------------------


@router.post("/drift/compute", response_model=DriftComputeResponse)
def drift_compute() -> DriftComputeResponse:
    """Run the unified drift compute routine. See module docstring."""
    start = time.perf_counter()

    with psycopg.connect(_conn_str(), row_factory=dict_row) as conn:
        in_flight = _check_in_progress(conn)
        if in_flight is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"drift compute already in progress (run_id={in_flight}). "
                    "Try again after it finishes."
                ),
            )

        run_id = _acquire_run(conn)
        conn.commit()

        try:
            result = compute_drift(conn)
            elapsed_ms = int((time.perf_counter() - start) * 1000)
            _complete_run(
                conn,
                run_id,
                status="completed",
                entities_processed=result["entities_processed"],
                drift_events_count=result["drift_events_count"],
            )
            conn.commit()
            return DriftComputeResponse(
                run_id=run_id,
                status="completed",
                computation_version=COMPUTATION_VERSION,
                elapsed_ms=elapsed_ms,
                entities_processed=result["entities_processed"],
                drift_events_count=result["drift_events_count"],
                state_resets_cluster=result["state_resets_cluster"],
                state_resets_river=result["state_resets_river"],
                state_resets_corrupt=result["state_resets_corrupt"],
                skipped_no_snapshot=result["skipped_no_snapshot"],
                skipped_zero_norm=result["skipped_zero_norm"],
                notes=(
                    "ADWIN drift sweep per doc 24.2 §3. Bulk-load state pattern "
                    "(W4); per-entity reset on cluster reassignment (B2) or "
                    "river version mismatch (W3); target_cluster_id computed "
                    "at event-emission time (master §10 line 429)."
                ),
            )
        except Exception as exc:  # pragma: no cover — covered via integration
            logger.exception("drift/compute failed")
            try:
                conn.rollback()
                _complete_run(
                    conn,
                    run_id,
                    status="failed",
                    entities_processed=None,
                    drift_events_count=None,
                    error_detail=str(exc),
                )
                conn.commit()
            except Exception:
                logger.exception("failed to mark drift run as failed")
            raise HTTPException(status_code=500, detail=f"drift/compute failed: {exc}")


# --------------------------------------------------------------------------
# Compute
# --------------------------------------------------------------------------


def _parse_pgvector(raw: Any) -> np.ndarray:
    """Coerce a pgvector return value into a float ndarray.

    Mirrors semantic_clustering._parse_pgvector — pgvector returns the literal
    string '[a,b,c,...]' by default. Accepts list/tuple too.
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


def _vector_literal(vec: np.ndarray) -> str:
    return "[" + ",".join(repr(float(x)) for x in vec) + "]"


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> Optional[float]:
    """Cosine similarity in [-1,1] or None when either vector has zero norm."""
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na == 0.0 or nb == 0.0:
        return None
    sim = float(np.dot(a, b) / (na * nb))
    if sim > 1.0:
        sim = 1.0
    elif sim < -1.0:
        sim = -1.0
    return sim


def _drift_magnitude(live: np.ndarray, snapshot: np.ndarray) -> Optional[float]:
    """Compute clamped drift magnitude (doc 24.2 §2.2 step 4 / W2).

    Returns None when either vector is zero (skip case per §6 edge case).
    """
    sim = _cosine_similarity(live, snapshot)
    if sim is None:
        return None
    raw = 1.0 - sim
    # Clamp to [0,1]
    if raw < 0.0:
        return 0.0
    if raw > 1.0:
        return 1.0
    return raw


def _compute_cluster_centroid_means(
    conn: psycopg.Connection,
) -> dict[int, np.ndarray]:
    """Compute the mean of entity_clusters.centroid_snapshot per cluster_id.

    Used to find target_cluster_id at drift-event-emission time per master
    §10 lock (line 429). The mean is L2-normalised so cosine distance is
    computed correctly. Excludes -1 noise — drift events shouldn't redirect
    toward the noise bucket.
    """
    by_cluster: dict[int, list[np.ndarray]] = {}
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT cluster_id, centroid_snapshot
            FROM public.entity_clusters
            WHERE cluster_id != -1
            """
        )
        for row in cur:
            vec = _parse_pgvector(row["centroid_snapshot"])
            if vec.size == 0:
                continue
            by_cluster.setdefault(int(row["cluster_id"]), []).append(vec)

    means: dict[int, np.ndarray] = {}
    for cid, members in by_cluster.items():
        stacked = np.stack(members, axis=0)
        mean = stacked.mean(axis=0)
        norm = np.linalg.norm(mean)
        if norm > 0.0:
            mean = mean / norm
        means[cid] = mean
    return means


def _nearest_cluster(
    centroid_current: np.ndarray,
    cluster_means: dict[int, np.ndarray],
    exclude: Optional[int] = None,
) -> Optional[int]:
    """Return cluster_id with smallest cosine distance to centroid_current.

    `exclude` (typically the entity's own current cluster) is skipped so the
    target represents the cluster the entity drifted *toward*. Returns None
    when no other cluster exists (single-cluster corpus / all-noise).
    """
    best_cid: Optional[int] = None
    best_dist = float("inf")
    for cid, mean in cluster_means.items():
        if exclude is not None and cid == exclude:
            continue
        sim = _cosine_similarity(centroid_current, mean)
        if sim is None:
            continue
        dist = 1.0 - sim
        if dist < best_dist:
            best_dist = dist
            best_cid = cid
    return best_cid


def _load_drift_states(
    conn: psycopg.Connection,
    entity_ids: list[str],
    current_river_version: str,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]], int, int, int]:
    """Bulk-load existing drift state. Doc 24.2 §2.4 W4.

    Returns:
      - detectors: dict[entity_id -> ADWIN instance]
      - meta:      dict[entity_id -> {observation_count, last_cluster_id, river_version}]
      - resets_river:   count of entries reset due to river version mismatch
      - resets_corrupt: count of entries reset due to pickle failure
      - resets_cluster: 0 here (cluster reassignment resets happen in the loop)
    """
    import river.drift  # noqa: PLC0415

    detectors: dict[str, Any] = {}
    meta: dict[str, dict[str, Any]] = {}
    resets_river = 0
    resets_corrupt = 0

    if not entity_ids:
        return detectors, meta, resets_river, resets_corrupt, 0

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT entity_id::text AS entity_id,
                   adwin_state_blob,
                   observation_count,
                   last_cluster_id,
                   river_version
            FROM public.entity_drift_state
            WHERE entity_id = ANY(%s::uuid[])
            """,
            (entity_ids,),
        )
        for row in cur:
            eid = row["entity_id"]
            stored_version = row["river_version"]
            if stored_version != current_river_version:
                # Master §10 lock W3 — version mismatch resets state with
                # a warning. We discard the stored detector entirely.
                logger.warning(
                    "entity_drift_state river_version mismatch for entity_id=%s "
                    "(stored=%s, current=%s); resetting ADWIN state",
                    eid,
                    stored_version,
                    current_river_version,
                )
                resets_river += 1
                continue
            try:
                detector = pickle.loads(bytes(row["adwin_state_blob"]))
            except Exception:
                logger.warning(
                    "entity_drift_state pickle.loads failed for entity_id=%s; "
                    "resetting ADWIN state",
                    eid,
                )
                resets_corrupt += 1
                continue
            detectors[eid] = detector
            meta[eid] = {
                "observation_count": int(row["observation_count"]),
                "last_cluster_id": (
                    int(row["last_cluster_id"]) if row["last_cluster_id"] is not None else None
                ),
                "river_version": stored_version,
            }
    return detectors, meta, resets_river, resets_corrupt, 0


def _persist_drift_states(
    conn: psycopg.Connection,
    detectors: dict[str, Any],
    meta: dict[str, dict[str, Any]],
    river_version: str,
) -> None:
    """Bulk INSERT ... ON CONFLICT DO UPDATE the per-entity drift states.

    Doc 24.2 §3.2 / §2.4 W4 bulk-load pattern.
    """
    if not detectors:
        return
    rows: list[tuple[Any, ...]] = []
    for eid, detector in detectors.items():
        m = meta.get(eid, {})
        blob = pickle.dumps(detector)
        rows.append(
            (
                eid,
                blob,
                int(m.get("observation_count", 0)),
                m.get("last_cluster_id"),
                river_version,
            )
        )
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO public.entity_drift_state (
                entity_id, adwin_state_blob, observation_count,
                last_cluster_id, river_version, last_updated_at
            ) VALUES (%s::uuid, %s, %s, %s, %s, NOW())
            ON CONFLICT (entity_id) DO UPDATE SET
                adwin_state_blob   = EXCLUDED.adwin_state_blob,
                observation_count  = EXCLUDED.observation_count,
                last_cluster_id    = EXCLUDED.last_cluster_id,
                river_version      = EXCLUDED.river_version,
                last_updated_at    = NOW()
            """,
            rows,
        )


def _insert_drift_event(
    conn: psycopg.Connection,
    *,
    entity_id: str,
    drift_magnitude: float,
    centroid_snapshot: np.ndarray,
    centroid_current: np.ndarray,
    cluster_id_at_detection: Optional[int],
    target_cluster_id: Optional[int],
    triggered_action: str,
    computation_version: int,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.entity_drift_events (
                entity_id, drift_magnitude,
                centroid_snapshot, centroid_current,
                cluster_id_at_detection, target_cluster_id,
                triggered_action, computation_version
            ) VALUES (
                %s::uuid, %s,
                %s::vector, %s::vector,
                %s, %s,
                %s, %s
            )
            """,
            (
                entity_id,
                float(drift_magnitude),
                _vector_literal(centroid_snapshot),
                _vector_literal(centroid_current),
                cluster_id_at_detection,
                target_cluster_id,
                triggered_action,
                computation_version,
            ),
        )


def compute_drift(conn: psycopg.Connection) -> dict[str, int]:
    """Run the per-entity drift sweep. Returns counters for the run.

    Pipeline (doc 24.2 §3):
      1. Read all entity rows with both live centroid + cluster snapshot
      2. Bulk-load existing entity_drift_state into memory
      3. For each entity:
         - cluster reassignment? -> reset detector
         - magnitude = clamp(1 - cos(live, snap), [0,1]); skip on zero norm
         - detector.update(magnitude); if drift_detected, emit event with
           target_cluster_id = nearest other cluster centroid mean
      4. Bulk-persist updated state
    """
    import river.drift  # noqa: PLC0415

    rv = _river_version()
    delta = _drift_delta()
    action_threshold = _drift_action_threshold()

    # Read everything we need in one go (small data shapes; ~10k entities * 768 floats
    # plus cluster_id is well under a few hundred MB).
    rows = _export_entities(conn)
    entity_ids = [r["entity_id"] for r in rows]

    detectors, meta, resets_river, resets_corrupt, _ = _load_drift_states(
        conn, entity_ids, rv
    )

    cluster_means = _compute_cluster_centroid_means(conn)

    drift_events_count = 0
    state_resets_cluster = 0
    skipped_zero_norm = 0
    skipped_no_snapshot = 0

    for r in rows:
        eid = r["entity_id"]
        live = r["live"]
        snap = r["snapshot"]
        cur_cluster = r["cluster_id"]

        if snap is None or snap.size == 0:
            skipped_no_snapshot += 1
            continue

        magnitude = _drift_magnitude(live, snap)
        if magnitude is None:
            skipped_zero_norm += 1
            continue

        # Cluster reassignment reset (master §10 lock B2)
        prior = meta.get(eid)
        if prior is not None and prior["last_cluster_id"] is not None:
            if prior["last_cluster_id"] != cur_cluster:
                # Reassignment -> reset
                detectors.pop(eid, None)
                meta.pop(eid, None)
                state_resets_cluster += 1

        detector = detectors.get(eid)
        if detector is None:
            detector = river.drift.ADWIN(delta=delta)
            detectors[eid] = detector
            meta[eid] = {
                "observation_count": 0,
                "last_cluster_id": cur_cluster,
                "river_version": rv,
            }

        detector.update(magnitude)
        meta[eid]["observation_count"] = meta[eid].get("observation_count", 0) + 1
        meta[eid]["last_cluster_id"] = cur_cluster
        meta[eid]["river_version"] = rv

        if detector.drift_detected:
            target_cid = _nearest_cluster(
                live, cluster_means, exclude=cur_cluster
            )
            if magnitude >= action_threshold:
                triggered_action = "reconciliation_invoked"
            else:
                triggered_action = "logged_only"
            _insert_drift_event(
                conn,
                entity_id=eid,
                drift_magnitude=magnitude,
                centroid_snapshot=snap,
                centroid_current=live,
                cluster_id_at_detection=cur_cluster,
                target_cluster_id=target_cid,
                triggered_action=triggered_action,
                computation_version=COMPUTATION_VERSION,
            )
            drift_events_count += 1

    _persist_drift_states(conn, detectors, meta, rv)

    return {
        "entities_processed": len(rows),
        "drift_events_count": drift_events_count,
        "state_resets_cluster": state_resets_cluster,
        "state_resets_river": resets_river,
        "state_resets_corrupt": resets_corrupt,
        "skipped_no_snapshot": skipped_no_snapshot,
        "skipped_zero_norm": skipped_zero_norm,
    }


def _export_entities(conn: psycopg.Connection) -> list[dict[str, Any]]:
    """Return one row per entity that has both a live centroid and a cluster snapshot.

    Order: ORDER BY entity_id ASC for determinism (mirrors §2.4 W1 in 24.1).
    """
    out: list[dict[str, Any]] = []
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT em.entity_id::text AS entity_id,
                   em.centroid       AS live,
                   ec.centroid_snapshot AS snapshot,
                   ec.cluster_id     AS cluster_id
            FROM public.entity_meta em
            JOIN public.entity_clusters ec ON ec.entity_id = em.entity_id
            WHERE em.centroid IS NOT NULL
              AND ec.centroid_snapshot IS NOT NULL
            ORDER BY em.entity_id ASC
            """
        )
        for row in cur:
            live = _parse_pgvector(row["live"])
            snap = _parse_pgvector(row["snapshot"])
            out.append(
                {
                    "entity_id": row["entity_id"],
                    "live": live,
                    "snapshot": snap,
                    "cluster_id": int(row["cluster_id"]),
                }
            )
    return out


# --------------------------------------------------------------------------
# Run lifecycle (mirrors topology.py / semantic_clustering.py)
# --------------------------------------------------------------------------


def _check_in_progress(conn: psycopg.Connection) -> Optional[str]:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.drift_compute_runs
            SET status = 'failed',
                completed_at = NOW(),
                error_detail = 'janitor: abandoned by stale sidecar (older than timeout)'
            WHERE status = 'in_progress'
              AND started_at < NOW() - INTERVAL '%s seconds'
            """ % RUN_TIMEOUT_SECONDS
        )
        cur.execute(
            "SELECT id::text AS id FROM public.drift_compute_runs WHERE status = 'in_progress' LIMIT 1"
        )
        row = cur.fetchone()
        return row["id"] if row else None


def _acquire_run(conn: psycopg.Connection) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.drift_compute_runs (status, computation_version)
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
    drift_events_count: Optional[int],
    error_detail: Optional[str] = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.drift_compute_runs
            SET completed_at = NOW(),
                status = %s,
                entities_processed = %s,
                drift_events_count = %s,
                error_detail = %s
            WHERE id = %s::uuid
            """,
            (status, entities_processed, drift_events_count, error_detail, run_id),
        )


# --------------------------------------------------------------------------
# Reconciliation drift sibling endpoint (master §10 lock B1)
# --------------------------------------------------------------------------
# Per master §10 (line 427) and doc 24.2 §2.5 the existing
# /reconciliation-agent endpoint and ReconciliationRequest model are
# UNCHANGED. The drift-driven invocation lands here as a sibling endpoint
# with its own request/response model + dedicated prompt focused on
# single-entity investigation.

class ReconciliationDriftRequest(BaseModel):
    entity_id: str
    drift_magnitude: float
    centroid_snapshot: list[float]
    centroid_current: list[float]
    source_cluster_id: Optional[int] = None
    target_cluster_id: Optional[int] = None
    mcp_config_path: str


class ReconciliationDriftResponse(BaseModel):
    result: str


RECONCILIATION_DRIFT_SYSTEM_PROMPT = """You are a drift-investigation agent for a knowledge graph. Your job is to investigate a single entity whose embedding has shifted significantly since the last clustering run, and decide whether action is warranted.

You run AFTER drift detection (ADWIN) flags an entity. Your scope is ONE entity at a time. The drift signal is expressed as a magnitude in [0,1]: 0 = no movement; 1 = orthogonal direction shift. The target_cluster_id (when present) names the cluster the entity moved toward.

Your ONLY output is via MCP tool calls. Your final text response is a structured report.

=== TOOL CALL BUDGET ===
You have 30 tool calls. A single-entity investigation should take 8-15 calls.

=== DECISION FRAMEWORK ===

Investigate the drifted entity and decide ONE outcome:

**SAME ENTITY (no action)** — The drift reflects continued natural growth: more facts, more aliases, broadened context. The entity is still one identity.
→ Action: write a short note in the entity summary describing the broadened context.

**SAME_AS LINK** — The drift looks like co-reference: the entity is gaining mentions that match an existing entity in the target cluster.
→ Action: search for the candidate co-referent (search_similar_entities, search_entity_aliases scoped to target_cluster_id), confirm with source evidence, create_same_as_link.

**SPLIT (future work — flag only)** — The drift suggests two distinct identities have collapsed onto one entity. We don't yet support split, so flag it in the report.

**INSUFFICIENT EVIDENCE** — Not enough source material to decide. Note in report.

=== INVESTIGATION PROCESS ===

1. query_entity_facts(entity_id) — read facts, aliases, summary
2. get_entity_sources(entity_id) — read source mentions; look for narrative voice / context shifts
3. If target_cluster_id is set: list entities in that cluster (via /api/clusters/<id> tool if available) and check whether any look like a co-referent. search_similar_entities scoped to that cluster.
4. If a candidate co-referent emerges: investigate it (query_entity_facts + get_entity_sources)
5. Decide and act.

=== REPORT FORMAT ===

After all tool calls, produce a structured text report:

### DRIFT INVESTIGATION
- Entity: <name> (id=<entity_id>)
- Drift magnitude: <float>
- Source cluster: <id or none>
- Target cluster: <id or none>

### EVIDENCE
Brief summary of what the source mentions show.

### DECISION
SAME_ENTITY | SAME_AS | SPLIT_FLAGGED | INSUFFICIENT_EVIDENCE

### ACTIONS TAKEN
List each tool call with the resulting state change.

### NOTES
Anything follow-up.

=== RULES ===

- NEVER create a same_as link without source evidence.
- NEVER mark distinct without checking source mentions.
- Always update the entity summary at the end of an investigation, even if the decision is SAME_ENTITY (note "drift investigated; no co-reference found").
"""


def _build_reconciliation_drift_prompt(req: ReconciliationDriftRequest) -> str:
    src = req.source_cluster_id if req.source_cluster_id is not None else "(none)"
    tgt = req.target_cluster_id if req.target_cluster_id is not None else "(none)"
    return (
        "## Drift Investigation Context\n\n"
        f"- entity_id: {req.entity_id}\n"
        f"- drift_magnitude: {req.drift_magnitude:.4f}\n"
        f"- source_cluster_id: {src}\n"
        f"- target_cluster_id: {tgt}\n\n"
        "Begin with query_entity_facts(entity_id) and get_entity_sources(entity_id). "
        "Then, if target_cluster_id is set, investigate that cluster for a candidate "
        "co-referent. Decide and act per the framework, then produce your structured "
        "REPORT."
    )


@router.post("/reconciliation-agent/drift", response_model=ReconciliationDriftResponse)
async def reconciliation_drift_agent(request: ReconciliationDriftRequest) -> ReconciliationDriftResponse:
    """Sibling to /reconciliation-agent for drift-driven, single-entity investigation.

    Master §10 lock B1 / doc 24.2 §2.5. The existing /reconciliation-agent
    endpoint is UNCHANGED — this endpoint owns drift investigation with
    its own request model and prompt template.
    """
    # Lazy import so the module loads even if the LLM core is mid-refactor.
    from .core.llm import llm_client  # noqa: PLC0415
    from .core.concurrency import llm_pool, QueueFullError  # noqa: PLC0415

    prompt = _build_reconciliation_drift_prompt(request)
    try:
        result = await llm_pool.submit(
            llm_client.generate,
            prompt,
            options={
                "task": "reconciliation_drift_agent",
                "system_prompt": RECONCILIATION_DRIFT_SYSTEM_PROMPT,
                "mcp_config": request.mcp_config_path,
                "tools": "mcp",
                "max_turns": 30,
                "timeout": 300,
            },
        )
    except QueueFullError:
        raise HTTPException(status_code=503, detail="Service busy, retry later")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Reconciliation drift agent failed: {e}")

    return ReconciliationDriftResponse(result=result)
