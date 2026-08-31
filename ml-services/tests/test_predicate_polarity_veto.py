"""Polarity/direction/ordinal veto and the semantic-reachability invariant
(bead nmemo-4g9).

Deterministic: pure token comparison, no embedding, no LLM, no network, no DB.

The expected outcomes below are taken from the doc-41 section-5 adjudication,
which was performed by a blind adversary on all 88 real score merges BEFORE this
veto existed. Its "indefensible floor, robust to any rule" is 25 of 88:
2 negation, 3 polarity, 1 direction, 1 relation-inverse, 6 ordinal, and 12
referential (different dataset/task/modality/metric). The first 13 are what this
veto claims; the 12 referential ones are explicitly out of scope, and two of them
are asserted NOT to fire so that scope cannot quietly drift.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.predicate_scoring import (  # noqa: E402
    MERGE_THRESHOLD,
    W_COSINE,
    W_JARO,
    W_TYPE_PAIR,
    polarity_veto,
    semantic_legs_can_merge,
    semantic_reachability_report,
)


# --------------------------------------------------------------------------
# The arithmetic defect
# --------------------------------------------------------------------------

def test_shipped_config_cannot_merge_on_semantics_alone():
    """The nmemo-4g9 defect, as an executable statement rather than prose.

    A pair with a PERFECT semantic score (cosine 1.0, type_pair 1.0) and no
    ConceptNet entry cannot reach MERGE_THRESHOLD. This test asserts the defect
    is still present, so that when the weights are eventually recalibrated under
    their own pre-registration, this test FAILS and has to be updated
    deliberately - it cannot be fixed by accident and go unnoticed.
    """
    assert not semantic_legs_can_merge()
    r = semantic_reachability_report()
    assert r["semantic_max"] == W_COSINE + W_TYPE_PAIR
    assert r["headroom"] < 0
    # A perfect semantic pair must STILL score jw >= 0.40 to merge.
    assert r["required_jw_at_perfect_semantics"] > 0.39


def test_invariant_detects_a_healthy_configuration():
    """The invariant is not vacuously false - it returns True when the semantic
    legs really can carry a merge."""
    assert semantic_legs_can_merge(w_cosine=0.60, w_type_pair=0.30, merge_threshold=0.89)
    assert semantic_legs_can_merge(w_cosine=0.55, w_type_pair=0.30, merge_threshold=0.85)
    assert not semantic_legs_can_merge(w_cosine=0.55, w_type_pair=0.29, merge_threshold=0.89)


def test_required_jw_matches_the_observed_merge_floor():
    """Sanity-check the arithmetic against the observed data: doc 41 reports a
    minimum jaro-winkler of 0.677 over 88 real merges. The formula's floor at
    perfect semantics is 0.40, so 0.677 must sit above it."""
    assert semantic_reachability_report()["required_jw_at_perfect_semantics"] <= 0.677


# --------------------------------------------------------------------------
# The veto: pairs it MUST block (doc 41 section 5 floor examples)
# --------------------------------------------------------------------------

MUST_VETO = [
    # (a, b, expected reason prefix)
    ("requires_fine_tuning", "requires_no_fine_tuning", "negation"),
    ("can_solve_task_with", "can_solve_task_without", "polarity"),
    ("performs_worse_at", "performs_better_at", "polarity"),
    ("produces_more_of", "produces_less_of", "polarity"),
    ("evaluated_on_external_tasks", "evaluated_on_internal_tasks", "polarity"),
    ("adapts_from_domain", "adapts_to_domain", "direction"),
    ("has_lightweight_variant", "is_lightweight_variant_of", "relation_inverse"),
    ("learning_stage_2", "learning_stage_1", "ordinal"),
    ("pipeline_step_2", "pipeline_step_1", "ordinal"),
    ("achieves_baseline_f1_score", "achieves_optimized_f1_score", "polarity"),
]


def test_vetoes_every_truth_conditional_floor_example():
    failures = []
    for a, b, expected in MUST_VETO:
        reason = polarity_veto(a, b)
        if reason is None or not reason.startswith(expected):
            failures.append(f"{a} -> {b}: expected {expected}, got {reason}")
    assert not failures, "\n".join(failures)


def test_veto_is_symmetric():
    for a, b, _ in MUST_VETO:
        assert (polarity_veto(a, b) is None) == (polarity_veto(b, a) is None)


# --------------------------------------------------------------------------
# The veto: pairs it MUST NOT block
# --------------------------------------------------------------------------

MUST_NOT_VETO = [
    # Referential, not truth-conditional. Real floor merges that this veto
    # explicitly does not claim - asserted so the scope cannot drift.
    ("metric_fid_score_on_coco", "metric_fid_score_on_cc3m"),
    ("performance_on_pancreas_segmentation", "performance_on_kidney_segmentation"),
    # Genuine synonyms/near-synonyms: vetoing these would make the veto a blunt
    # instrument that blocks the merges the ontology is FOR.
    ("addresses_challenge", "addresses_problem"),
    ("performance_depends_on", "performance_affected_by"),
    ("supervises", "manages"),
    ("resides_in", "lives_in"),
    ("evaluated_on_dataset", "evaluated_on_benchmark"),
    # Identical input is not an inversion.
    ("uses_technique", "uses_technique"),
    # A token merely CONTAINING a digit is not an ordinal.
    ("trained_on_gpt4", "trained_on_gpt3"),
]


def test_does_not_veto_referential_or_synonym_pairs():
    fired = [(a, b, polarity_veto(a, b)) for a, b in MUST_NOT_VETO if polarity_veto(a, b)]
    assert not fired, f"veto fired where it must not: {fired}"


def test_ordinal_rule_ignores_tokens_that_merely_contain_digits():
    # cc3m / coco differ in one position but neither is a number.
    assert polarity_veto("metric_on_cc3m", "metric_on_coco") is None
    # ...whereas bare digits are ordinals.
    assert polarity_veto("stage_1", "stage_2") is not None


def test_negation_rule_requires_the_rest_to_match():
    # Same negation token, but the remaining tokens differ -> not this rule's call.
    assert polarity_veto("requires_no_fine_tuning", "requires_no_pretraining") is None


def test_two_token_differences_are_not_vetoed():
    """The rule is deliberately narrow: exactly one differing position. Two
    differences are not a clean inversion and are left to scoring."""
    assert polarity_veto("performs_better_at_task_a", "performs_worse_at_task_b") is None
