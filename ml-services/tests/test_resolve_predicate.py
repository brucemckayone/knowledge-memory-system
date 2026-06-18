"""
PC3 (nmemo-213.3) acceptance tests — the live predicate-scoring modules
(app/predicate_scoring.py, app/predicate_normalization.py) reproduce the
benchmark's multi-signal results:

  - B7/B18: 0 adversarial false-merges under multi-signal.
  - B12: every inverse pair is blocked by the inverse hard guard.
  - B9/B19: NL-phrase -> canonical mapping accuracy >= 85% under multi-signal.

These are pure-function tests: they embed the curated corpus directly via Ollama
(the same uncentered enriched recipe the benchmark validated) and call the LIVE
ported scoring functions — no DB, no endpoint. Requires Ollama (nomic-embed-text).

Run standalone (no pytest needed):  python -m tests.test_resolve_predicate
Or under pytest:                    pytest tests/test_resolve_predicate.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.error

import numpy as np

# Live modules under test.
from app.predicate_scoring import multi_signal_score, is_inverse, MERGE_THRESHOLD
from app.predicate_normalization import normalize_tense, lemmatize_predicate

# Curated corpus (the benchmark's ground truth).
from tests.ontology_test_data import (
    ONTOLOGY,
    PREDICATE_TYPE_PAIRS,
    ADVERSARIAL_PAIRS,
    INVERSE_PAIRS,
    NATURAL_LANGUAGE_PREDICATES,
)

import ollama

_OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
_client = ollama.Client(host=_OLLAMA_HOST, timeout=120.0)
_EMBED_MODEL = "nomic-embed-text"


def _ollama_available() -> bool:
    try:
        _client.embeddings(model=_EMBED_MODEL, prompt="ping")
        return True
    except Exception:
        return False


OLLAMA_OK = _ollama_available()

# pytest skip (harmless when run standalone).
try:
    import pytest
    pytestmark = pytest.mark.skipif(not OLLAMA_OK, reason="Ollama unavailable")
except ImportError:  # pragma: no cover
    pytest = None


def embed_enriched(label: str, description: str) -> np.ndarray:
    """Uncentered enriched embedding — matches benchmark_ontology_embeddings.py
    and app code (predicate-embeddings.ts / resolve_predicate.enriched_text)."""
    prompt = f"clustering: The relationship '{label}' describes {description.lower()}"
    resp = _client.embeddings(model=_EMBED_MODEL, prompt=prompt)
    return np.array(resp["embedding"], dtype=float)


def _get_type_pair(pred: str) -> tuple:
    if pred in PREDICATE_TYPE_PAIRS:
        return PREDICATE_TYPE_PAIRS[pred]
    for canonical, info in ONTOLOGY.items():
        if pred in info.get("aliases", []):
            return PREDICATE_TYPE_PAIRS.get(canonical, ("unknown", "unknown"))
    return ("unknown", "unknown")


def test_b18_adversarial_zero_false_merges() -> int:
    """B7/B18: multi-signal scores 0 adversarial pairs at/above the merge line."""
    false_merges = []
    for pred_a, pred_b, desc_a, desc_b, _reason in ADVERSARIAL_PAIRS:
        emb_a = embed_enriched(pred_a, desc_a)
        emb_b = embed_enriched(pred_b, desc_b)
        sig = multi_signal_score(pred_a, _get_type_pair(pred_a), emb_a,
                                 pred_b, _get_type_pair(pred_b), emb_b)
        if sig["combined"] >= MERGE_THRESHOLD:
            false_merges.append((pred_a, pred_b, round(sig["combined"], 4)))
    assert not false_merges, f"adversarial false-merges: {false_merges}"
    return len(ADVERSARIAL_PAIRS)


def test_b12_inverse_pairs_blocked() -> int:
    """B12: with the inverse registry, the hard guard blocks every inverse pair."""
    inv: dict[str, str] = {}
    for a, b in INVERSE_PAIRS:
        inv[a] = b
        inv[b] = a
    unblocked = []
    for a, b in INVERSE_PAIRS:
        # query=a, candidate=b: candidate's registered inverse is inv[b]==a, so the
        # guard fires. Check both directions.
        if not is_inverse(a, b, candidate_inverse=inv.get(b), query_inverse=inv.get(a)):
            unblocked.append((a, b))
        if not is_inverse(b, a, candidate_inverse=inv.get(a), query_inverse=inv.get(b)):
            unblocked.append((b, a))
    assert not unblocked, f"inverse pairs NOT blocked: {unblocked}"
    return len(INVERSE_PAIRS)


def test_b19_nl_mapping_accuracy() -> float:
    """B9/B19: NL-phrase -> canonical accuracy >= 85% under multi-signal.

    Mirrors benchmark b19, including its answer-aware type pair
    (`_get_type_pair(expected)`). The honest live number (query type pair derived
    from the staged fact, not the gold answer) is measured at PC8 (doc 42 §12-R1-B1)."""
    canonicals = list(ONTOLOGY.keys())
    canon_emb = {c: embed_enriched(c, ONTOLOGY[c]["description"]) for c in canonicals}
    correct = 0
    for phrase, expected in NATURAL_LANGUAGE_PREDICATES:
        nl_emb = embed_enriched(phrase, phrase)
        nl_tp = _get_type_pair(expected)
        best = max(
            canonicals,
            key=lambda c: multi_signal_score(phrase, nl_tp, nl_emb, c, _get_type_pair(c), canon_emb[c])["combined"],
        )
        if best == expected:
            correct += 1
    acc = correct / len(NATURAL_LANGUAGE_PREDICATES)
    assert acc >= 0.85, f"NL mapping accuracy {acc:.3f} < 0.85 ({correct}/{len(NATURAL_LANGUAGE_PREDICATES)})"
    return acc


def test_normalization_pure() -> None:
    """Tense + lemma normalization (no Ollama needed)."""
    alias_map = {}
    canon = set(ONTOLOGY.keys())
    for c, info in ONTOLOGY.items():
        for a in info.get("aliases", []):
            alias_map[a] = c
    # past-tense alias -> base + "past"
    base, hint = normalize_tense("worked_at", alias_map, canon)
    assert base == "works_at" and hint == "past", (base, hint)
    # canonical -> "current"
    base, hint = normalize_tense("manages", alias_map, canon)
    assert base == "manages" and hint == "current", (base, hint)
    # ambiguous canonical -> None
    _, hint = normalize_tense("founded", alias_map, canon)
    assert hint is None
    # lemmatization
    assert lemmatize_predicate("managing") == "manage"
    assert lemmatize_predicate("supervised") == "supervise"


_RESOLVE_BASE = os.getenv("RESOLVE_PREDICATE_URL", "http://127.0.0.1:8001")
# Canonicals (with inverse) used to build the endpoint candidate set.
_SMOKE_INVERSE = {"works_at": "employs", "manages": "reports_to", "parent_of": "child_of"}


def _endpoint_available() -> bool:
    try:
        with urllib.request.urlopen(f"{_RESOLVE_BASE}/health", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def _build_candidates(names: list[str]) -> list[dict]:
    cands = []
    for c in names:
        info = ONTOLOGY[c]
        tp = _get_type_pair(c)
        cands.append({
            "predicate": c,
            "description": info["description"],
            "embedding": embed_enriched(c, info["description"]).tolist(),
            "subject_type": tp[0],
            "object_type": tp[1],
            "inverse_predicate": _SMOKE_INVERSE.get(c),
            "aliases": info.get("aliases", []),
        })
    return cands


def _post_resolve(payload: dict) -> dict:
    req = urllib.request.Request(
        f"{_RESOLVE_BASE}/resolve-predicate",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def test_endpoint_smoke() -> None:
    """The live /resolve-predicate endpoint: alias -> canonical, novel -> mint,
    inverse -> keep-separate. Skipped if the endpoint is unreachable."""
    names = ["works_at", "manages", "lives_in", "married_to", "created", "knows", "founded"]
    candidates = _build_candidates(names)

    # 1. Known alias -> merge to canonical.
    r = _post_resolve({"predicate": "employed_at", "subject_type": "person", "object_type": "company", "candidates": candidates})
    assert r["decision"] == "merge" and r["canonical"] == "works_at", r

    # 2. Genuinely novel -> mint (distinct).
    r = _post_resolve({"predicate": "enjoys_hiking_with", "subject_type": "person", "object_type": "person", "candidates": candidates})
    assert r["decision"] == "distinct" and r["canonical"] is None, r

    # 3. Inverse of works_at -> must NOT merge into works_at (hard guard).
    #    Assert the guard ACTUALLY fired (works_at.inverse_blocked) rather than
    #    relying on the embedding signal happening to fall short — the latter is
    #    exactly the false-confidence the guard exists to remove (B12).
    inv_candidates = _build_candidates(["works_at", "manages", "created"])
    r = _post_resolve({"predicate": "employs", "subject_type": "company", "object_type": "person", "candidates": inv_candidates})
    assert r["canonical"] != "works_at", r
    assert r["decision"] in ("distinct", "ambiguous"), r
    works = next((c for c in r["top"] if c["predicate"] == "works_at"), None)
    assert works is not None and works["inverse_blocked"] is True, f"guard did not fire: {r}"


def main() -> int:
    if not OLLAMA_OK:
        print("SKIP: Ollama unavailable at", _OLLAMA_HOST)
        return 0
    print("=" * 70)
    print("PC3 resolve-predicate acceptance (B7/B12/B9 under multi-signal)")
    print("=" * 70)
    test_normalization_pure()
    print("  [PASS] normalization (tense + lemma)")
    n_adv = test_b18_adversarial_zero_false_merges()
    print(f"  [PASS] B7/B18: 0 adversarial false-merges over {n_adv} pairs")
    n_inv = test_b12_inverse_pairs_blocked()
    print(f"  [PASS] B12: {n_inv} inverse pairs blocked by the guard")
    acc = test_b19_nl_mapping_accuracy()
    print(f"  [PASS] B9/B19: NL mapping accuracy {acc:.1%} (>= 85%)")
    if _endpoint_available():
        test_endpoint_smoke()
        print(f"  [PASS] endpoint smoke: alias->canonical, novel->mint, inverse->keep-separate ({_RESOLVE_BASE})")
    else:
        print(f"  [SKIP] endpoint smoke: {_RESOLVE_BASE} unreachable")
    print("=" * 70)
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AssertionError as e:
        print(f"  [FAIL] {e}")
        sys.exit(1)
