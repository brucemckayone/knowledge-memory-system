"""
Predicate multi-signal scoring — the deterministic, model-free merge decision
for the living predicate ontology (truth-graph doc 42 §4, PC3).

Ported from ml-services/tests/benchmark_ontology_embeddings.py (the 2026-06-01
benchmark that validated this) into a live module. Pure functions: embeddings
are injected by the caller (the resolve-predicate endpoint computes them via the
Ollama pool; unit tests compute them directly), so this module has no Ollama or
DB dependency and is trivially testable.

The merge decision is:
    combined = W_COSINE*cosine + W_TYPE_PAIR*type_pair_overlap
             + W_JARO*jaro_winkler + W_CONCEPTNET*conceptnet
gated by two calibrated thresholds, with TWO hard vetoes applied before scoring:
the inverse-predicate registry, and the polarity/direction/ordinal veto below
(embeddings cannot see negation or direction).

The docstring here previously stated 0.50/0.30/0.10/0.10, which never matched the
code's 0.55/0.30/0.10/0.05. Reference the constants, not a copy of them.
"""

from __future__ import annotations

from typing import Optional

import numpy as np

try:
    from jellyfish import jaro_winkler_similarity as _jw_sim
except ImportError:  # pragma: no cover - jellyfish is a hard dep, see requirements.txt
    _jw_sim = None

# Multi-signal weights + two-threshold calibration. TUNABLE CONFIG, not law: the
# defaults are the benchmark's calibrated values (B3; benchmark_ontology_embeddings.py:732),
# overridable per-deployment via env so the PC6 sweep can lock a different operating
# point WITHOUT a code edit (doc 42 §4, PC6). The PC6 sweep emits the recommended
# env values; PC8 runs the gate at the locked point. Per-request override also exists
# (resolve_predicate.py merge_threshold/distinct_threshold fields).
import os as _os


def _envf(name: str, default: float) -> float:
    try:
        return float(_os.environ[name])
    except (KeyError, ValueError):
        return default


# Defaults: the PC6-recommended operating point (sweep_predicate_thresholds.py,
# 2026-06-20), PROVISIONAL pending the PC8 live A/B vs the old 0.905 point. The
# sweep's B7=0 gate is the curated adversarial pairs AUGMENTED with all same-type
# distinct-canonical pairs (the risky band), and the chosen merge_t keeps a >=0.015
# safety headroom above the worst must-not-merge score (a merge is lossy/
# unrecoverable; over-minting is gardener-recoverable, so we err high). KEY FINDING:
# once that headroom is required, the score threshold can only loosen marginally
# (0.905 -> 0.89) and score-reuse barely rises (0.18 -> 0.19) — the multi-signal
# SCORE is NOT the primary over-minting lever; the alias table (deterministic) and
# the PC5 propose-time reuse hint are. PC8 measures the real net minting effect.
W_COSINE = _envf("PREDICATE_W_COSINE", 0.55)
W_TYPE_PAIR = _envf("PREDICATE_W_TYPE_PAIR", 0.30)
W_JARO = _envf("PREDICATE_W_JARO", 0.10)
W_CONCEPTNET = _envf("PREDICATE_W_CONCEPTNET", 0.05)

MERGE_THRESHOLD = _envf("PREDICATE_MERGE_THRESHOLD", 0.89)
DISTINCT_THRESHOLD = _envf("PREDICATE_DISTINCT_THRESHOLD", 0.84)

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
    signals = {
        "cosine_sim": cos,
        "type_pair_overlap": tov,
        "jaro_winkler": jw,
        "conceptnet": cn,
    }
    signals["combined"] = combine(signals)
    return signals


def combine(signals: dict, weights: Optional[tuple] = None) -> float:
    """Weighted combine of a per-signal breakdown. Defaults to the configured
    weights; pass an explicit (cosine, type_pair, jaro, conceptnet) tuple to score
    a hypothetical weighting WITHOUT re-embedding — the PC6 sweep does exactly this
    over the cached per-signal scores."""
    wc, wt, wj, wn = weights if weights is not None else (W_COSINE, W_TYPE_PAIR, W_JARO, W_CONCEPTNET)
    return (
        wc * signals["cosine_sim"]
        + wt * signals["type_pair_overlap"]
        + wj * signals["jaro_winkler"]
        + wn * signals["conceptnet"]
    )


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

# ===========================================================================
# The semantic-reachability invariant (bead nmemo-4g9)
# ===========================================================================
#
# THE DEFECT THIS MAKES DETECTABLE. With the shipped weights (cosine 0.55,
# type_pair 0.30, jaro 0.10, conceptnet 0.05) and MERGE_THRESHOLD 0.89, a pair
# with a PERFECT semantic score - cosine 1.0, type_pair 1.0 - and no ConceptNet
# entry (which fired 0 of 88 times; it is a 21-entry personal-domain stub) maxes
# out at 0.85 < 0.89. So the weight-0.10 jaro-winkler term was ARITHMETICALLY
# NECESSARY for any merge: every merge had to satisfy
# jw >= (MERGE_THRESHOLD - W_COSINE*cos - W_TYPE_PAIR*tov) / W_JARO. Over 88 real
# merges the minimum observed jw was 0.677 and the median 0.896.
#
# The consequence is not a tuning nit. The merge region WAS "near-identical
# surface string AND high cosine" - a string-edit matcher with a semantic gate -
# and negation, polarity, direction and ordinal distinctions ride on a single
# token, so they MAXIMISE jaro-winkler while barely moving cosine. Adjudicated
# merge precision was 0.43 on the decidable subset, with a 25-of-88 indefensible
# floor (doc 41 sections 3.1c and 5).
#
# These functions do NOT pick new weights - that needs its own pre-registered
# sweep, and merges are lossy and unrecoverable. They make the bad configuration
# DETECTABLE, so a deployment can never again silently run one in which a
# surface-string term is load-bearing.


def semantic_legs_can_merge(
    w_cosine: Optional[float] = None,
    w_type_pair: Optional[float] = None,
    merge_threshold: Optional[float] = None,
) -> bool:
    """True when a perfect semantic pair (cosine 1.0, type_pair 1.0) reaches
    MERGE_THRESHOLD on the semantic legs ALONE - without help from jaro-winkler
    or the ConceptNet stub.

    False means the surface-string term is arithmetically necessary for every
    merge, which is the nmemo-4g9 defect."""
    wc = W_COSINE if w_cosine is None else w_cosine
    wt = W_TYPE_PAIR if w_type_pair is None else w_type_pair
    mt = MERGE_THRESHOLD if merge_threshold is None else merge_threshold
    return (wc + wt) >= mt


def semantic_reachability_report() -> dict:
    """Diagnostic for tests and startup logs: can the semantic legs carry a merge
    in this configuration, and if not, by how much do they fall short?"""
    headroom = (W_COSINE + W_TYPE_PAIR) - MERGE_THRESHOLD
    return {
        "w_cosine": W_COSINE,
        "w_type_pair": W_TYPE_PAIR,
        "w_jaro": W_JARO,
        "w_conceptnet": W_CONCEPTNET,
        "merge_threshold": MERGE_THRESHOLD,
        "semantic_max": W_COSINE + W_TYPE_PAIR,
        "headroom": headroom,
        "semantic_legs_can_merge": headroom >= 0.0,
        # The jaro-winkler value a PERFECT semantic pair must still reach.
        "required_jw_at_perfect_semantics": (
            max(0.0, -headroom / W_JARO) if W_JARO > 0 else float("inf")
        ),
    }


# ===========================================================================
# Polarity / direction / ordinal veto (bead nmemo-4g9)
# ===========================================================================
#
# A deterministic, model-free HARD veto, analogous to the inverse-predicate
# registry and applied the same way: before scoring, regardless of score.
#
# It exists because the damage was concentrated and structural. Of the 25-merge
# indefensible floor in doc 41 section 5, twelve were exactly this shape - 2
# negation, 3 polarity, 1 direction, 6 ordinal - plus 1 relation-inverse. These
# pairs differ by ONE token that inverts the claim, which is the worst case for
# both signals the scorer trusts: jaro-winkler is maximised (0.87-0.97 observed)
# while cosine barely moves (0.95-0.98 observed).
#
# SCOPE, stated so this is not read as a fix for merge precision generally: the
# veto addresses truth-conditional inversions ONLY. The other 12 floor merges are
# REFERENTIAL - different dataset, task, metric or modality, e.g.
# metric_fid_score_on_coco vs metric_fid_score_on_cc3m - and cannot be decided
# from token polarity without a domain vocabulary. This veto does not fire on
# those, and should not.

_NEGATION_TOKENS = frozenset(
    {"no", "not", "non", "never", "without", "absent", "lacks", "lacking"}
)

# Antonym pairs, stored as frozensets so lookup is order-free.
_ANTONYM_PAIRS = frozenset(
    frozenset(p)
    for p in [
        ("with", "without"),
        ("better", "worse"), ("best", "worst"), ("improved", "degraded"),
        ("more", "less"), ("higher", "lower"), ("upper", "lower"),
        ("increase", "decrease"), ("increased", "decreased"),
        ("increases", "decreases"), ("gain", "loss"), ("gains", "losses"),
        ("faster", "slower"), ("larger", "smaller"), ("bigger", "smaller"),
        ("longer", "shorter"), ("stronger", "weaker"), ("strong", "weak"),
        ("max", "min"), ("maximum", "minimum"), ("maximise", "minimise"),
        ("internal", "external"), ("positive", "negative"),
        ("supported", "unsupported"), ("enabled", "disabled"),
        ("before", "after"), ("pre", "post"), ("prior", "post"),
        ("baseline", "optimized"), ("baseline", "optimised"),
        ("in", "out"), ("input", "output"), ("inbound", "outbound"),
        ("up", "down"), ("upstream", "downstream"),
        ("success", "failure"), ("succeeds", "fails"),
        ("presence", "absence"), ("present", "absent"),
    ]
)

# Direction-flipping tokens: swapping these reverses a directed edge.
_DIRECTION_PAIRS = frozenset(
    frozenset(p)
    for p in [
        ("from", "to"), ("source", "target"), ("src", "dst"),
        ("forward", "backward"), ("sender", "receiver"),
        ("parent", "child"), ("ancestor", "descendant"),
        ("cause", "effect"), ("subject", "object"),
    ]
)

_ORDINAL_WORDS = {
    "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5,
    "sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10,
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}


def _ordinal_value(token: str) -> Optional[int]:
    """The numeric value a token denotes, or None. Digits and small number words
    only - deliberately narrow, so a token that merely CONTAINS a digit
    (cc3m, gpt4, coco) is not treated as an ordinal."""
    if token.isdigit():
        return int(token)
    return _ORDINAL_WORDS.get(token)


def polarity_veto(pred_a: str, pred_b: str) -> Optional[str]:
    """Hard veto on a truth-conditional inversion. Returns a reason string when
    the two predicates must NOT merge, else None.

    Deterministic and model-free: pure token comparison, no embedding, no LLM, no
    network. Symmetric in its arguments."""
    if pred_a == pred_b:
        return None
    a = [t for t in pred_a.split("_") if t]
    b = [t for t in pred_b.split("_") if t]
    if not a or not b:
        return None

    # (1) has_X / is_X_of - a relation merged with its own inverse. This is the
    # class the inverse registry exists to stop and structurally cannot reach: it
    # fires only when the query base equals one of 9 registered seed names, and
    # only 2 of 2,240 corpus predicate strings are within its reach at all.
    for first, second in ((a, b), (b, a)):
        if first[0] == "has" and second[0] == "is" and second[-1] == "of":
            if set(first[1:]) == set(second[1:-1]):
                return "relation_inverse:has_X/is_X_of"

    # (2) One side carries a negation token the other does not, and the two are
    # otherwise the same tokens: requires_fine_tuning vs requires_no_fine_tuning.
    sa, sb = set(a), set(b)
    neg_only_a = (sa & _NEGATION_TOKENS) - sb
    neg_only_b = (sb & _NEGATION_TOKENS) - sa
    if (neg_only_a or neg_only_b) and (sa - _NEGATION_TOKENS) == (sb - _NEGATION_TOKENS):
        tok = sorted(neg_only_a | neg_only_b)[0]
        return "negation:" + tok

    # (3) Same length, differing in exactly one position: check that token pair
    # for antonymy, direction reversal, or a differing ordinal.
    if len(a) == len(b):
        diffs = [(x, y) for x, y in zip(a, b) if x != y]
        if len(diffs) == 1:
            x, y = diffs[0]
            pair = frozenset((x, y))
            if pair in _ANTONYM_PAIRS:
                return "polarity:" + x + "/" + y
            if pair in _DIRECTION_PAIRS:
                return "direction:" + x + "/" + y
            va, vb = _ordinal_value(x), _ordinal_value(y)
            if va is not None and vb is not None and va != vb:
                return "ordinal:" + x + "/" + y

    return None

