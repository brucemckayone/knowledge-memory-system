"""
Predicate multi-signal scoring — the deterministic, model-free merge decision
for the living predicate ontology (truth-graph doc 42 §4, PC3).

Ported from ml-services/tests/benchmark_ontology_embeddings.py (the 2026-06-01
benchmark that validated this) into a live module. Pure functions: embeddings
are injected by the caller (the resolve-predicate endpoint computes them via the
Ollama pool; unit tests compute them directly), so this module has no Ollama or
DB dependency and is trivially testable.

The merge decision is:
    combined = 0.50*cosine + 0.30*type_pair_overlap + 0.10*jaro_winkler + 0.10*conceptnet
gated by two calibrated thresholds, with the inverse-predicate registry as a
HARD veto applied before scoring (embeddings cannot see direction).
"""

from __future__ import annotations

from typing import Optional

import numpy as np

try:
    from jellyfish import jaro_winkler_similarity as _jw_sim
except ImportError:  # pragma: no cover - jellyfish is a hard dep, see requirements.txt
    _jw_sim = None

# Multi-signal weights (benchmark_ontology_embeddings.py:732). Sum to 1.0.
W_COSINE = 0.50
W_TYPE_PAIR = 0.30
W_JARO = 0.10
W_CONCEPTNET = 0.10

# Two-threshold calibration (benchmark B3; doc 42 §4). Config, not law — PC6
# re-derives these on corpus10/corpus20 and PC8 runs at that operating point.
MERGE_THRESHOLD = 0.905
DISTINCT_THRESHOLD = 0.848

# Static lexical prior. Ported from ontology_test_data.py::CONCEPTNET_SYNONYMS
# with the `employs -> works_at` entry REMOVED: that pair is an inverse, not a
# synonym (doc 42 §4, §12-R2), and rewarding it would fight the inverse guard.
# A curated stub, not live ConceptNet.
CONCEPTNET_SYNONYMS: dict[str, str] = {
    "supervises": "manages",
    "leads": "manages",
    "directs": "manages",
    "oversees": "manages",
    "resides_in": "lives_in",
    "based_in": "lives_in",
    "authored": "created",
    "built": "created",
    "developed": "created",
    "wrote": "created",
    "designed": "created",
    "possesses": "owns",
    "acquainted_with": "knows",
    "friends_with": "friend_of",
    "graduated_from": "studied_at",
    "enrolled_at": "studied_at",
    "presented_at": "spoke_at",
    "traveled_to": "visited",
    "hosted": "organized",
    "expert_in": "skilled_in",
    "proficient_in": "skilled_in",
}


def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity of two vectors."""
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0.0:
        return 0.0
    return float(np.dot(a, b) / denom)


def type_pair_overlap(tp_a: tuple, tp_b: tuple) -> float:
    """1.0 if both (subject_type, object_type) match, 0.5 if one matches, else 0.0.
    A NULL/unknown side counts as a wildcard-miss for that position, so a fully
    unknown pair scores 0.0 against a known pair and 1.0 only against another
    fully-unknown pair — callers should pass the staged fact's resolved entity
    types where available (doc 42 §4)."""
    if tp_a == tp_b:
        return 1.0
    if tp_a[0] == tp_b[0] or tp_a[1] == tp_b[1]:
        return 0.5
    return 0.0


def conceptnet_relatedness(pred_a: str, pred_b: str) -> float:
    """1.0 if the synonym map links one predicate to the other, else 0.0."""
    if CONCEPTNET_SYNONYMS.get(pred_a) == pred_b:
        return 1.0
    if CONCEPTNET_SYNONYMS.get(pred_b) == pred_a:
        return 1.0
    canon_a = CONCEPTNET_SYNONYMS.get(pred_a, pred_a)
    canon_b = CONCEPTNET_SYNONYMS.get(pred_b, pred_b)
    if canon_a == canon_b and (pred_a in CONCEPTNET_SYNONYMS or pred_b in CONCEPTNET_SYNONYMS):
        return 1.0
    return 0.0


def jaro_winkler(pred_a: str, pred_b: str) -> float:
    """Surface string similarity. 0.0 if jellyfish is unavailable (the 0.10 jaro
    term then drops out — jellyfish is a hard requirement, see requirements.txt)."""
    return float(_jw_sim(pred_a, pred_b)) if _jw_sim is not None else 0.0


def multi_signal_score(
    pred_a: str,
    type_pair_a: tuple,
    emb_a: np.ndarray,
    pred_b: str,
    type_pair_b: tuple,
    emb_b: np.ndarray,
) -> dict:
    """Weighted multi-signal similarity between two predicates. Embeddings are
    required (inject mean-centered enriched vectors). Returns the per-signal
    breakdown plus the combined score."""
    cos = cosine_sim(emb_a, emb_b)
    tov = type_pair_overlap(type_pair_a, type_pair_b)
    jw = jaro_winkler(pred_a, pred_b)
    cn = conceptnet_relatedness(pred_a, pred_b)
    combined = W_COSINE * cos + W_TYPE_PAIR * tov + W_JARO * jw + W_CONCEPTNET * cn
    return {
        "cosine_sim": cos,
        "type_pair_overlap": tov,
        "jaro_winkler": jw,
        "conceptnet": cn,
        "combined": combined,
    }


def is_inverse(
    query: str,
    candidate: str,
    candidate_inverse: Optional[str],
    query_inverse: Optional[str] = None,
) -> bool:
    """Hard guard: the query and a candidate are a registered inverse pair.
    Embeddings cannot see direction (works_at vs employs), so a registered
    inverse must never merge regardless of score (doc 42 §4; benchmark B12).
    Checks both directions: the candidate's registered inverse names the query,
    or the query's (when it resolves to a canonical) names the candidate."""
    if candidate_inverse is not None and candidate_inverse == query:
        return True
    if query_inverse is not None and query_inverse == candidate:
        return True
    return False
