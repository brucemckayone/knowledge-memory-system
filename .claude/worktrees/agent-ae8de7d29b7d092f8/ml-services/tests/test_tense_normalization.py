"""
Tense Normalization Test (B-S1)
================================

Validates that tense variants of predicates normalize to their base (present-tense)
canonical form with the correct temporal_hint.

Design principle: tense is NOT a predicate distinction — it's handled by
valid_at/invalid_at timestamps on facts. "worked_at" and "works_at" are the
SAME predicate; the past-ness is metadata, not a separate ontology entry.

Run: py -m tests.test_tense_normalization
No external dependencies required — pure logic test.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests.ontology_test_data import ONTOLOGY


# ============================================================================
# TENSE ALIAS REGISTRY
#
# Explicit mapping of tense-variant aliases to their temporal hint.
# These are predicates that the ONTOLOGY folds as aliases of a present-tense
# base form. The mapping is intentional: we list them here so the system can
# attach temporal_hint metadata when it normalizes.
#
# Predicates NOT in this set default to "current" if they resolve to a known
# canonical predicate, or None if ambiguous.
# ============================================================================

TENSE_ALIASES: dict[str, str] = {
    # Employment tense variants -> "past"
    "worked_at": "past",
    "formerly_at": "past",
    "ex_employee_of": "past",
    "used_to_work_at": "past",
    # Residence tense variants -> "past"
    "lived_in": "past",
    "formerly_in": "past",
    "used_to_live_in": "past",
}

# Predicates where tense is genuinely ambiguous — they look past-tense
# grammatically but are the canonical form (e.g., "created" is a predicate,
# not just past tense of "create").
AMBIGUOUS_PREDICATES: set[str] = {
    "created",
    "founded",
    "visited",
    "organized",
    "studied_at",
    "attended_event",
    "spoke_at",
}


def _build_alias_to_canonical() -> dict[str, str]:
    """Build reverse lookup: alias -> canonical predicate from ONTOLOGY."""
    lookup: dict[str, str] = {}
    for canonical, info in ONTOLOGY.items():
        for alias in info.get("aliases", []):
            lookup[alias.lower()] = canonical
    return lookup


_ALIAS_TO_CANONICAL = _build_alias_to_canonical()


def normalize_tense(predicate: str) -> tuple[str, str | None]:
    """
    Normalize a predicate to its base (present-tense) canonical form.

    Returns:
        (base_predicate, temporal_hint) where temporal_hint is:
        - "past"    — the input is a known past-tense alias
        - "current" — the input is a known canonical predicate (present-tense)
        - None      — the predicate is ambiguous or atemporal
    """
    normalized = predicate.lower().strip().replace(" ", "_")

    # 1. Check if it's a known tense alias — resolve to base + "past"
    if normalized in TENSE_ALIASES:
        base = _ALIAS_TO_CANONICAL.get(normalized)
        if base is not None:
            return (base, TENSE_ALIASES[normalized])

    # 2. Check if it's already a canonical predicate
    if normalized in ONTOLOGY:
        # Ambiguous predicates: grammatically past-tense but serve as the
        # canonical form (e.g., "created", "founded"). We cannot infer
        # temporality from the predicate name alone.
        if normalized in AMBIGUOUS_PREDICATES:
            return (normalized, None)
        return (normalized, "current")

    # 3. Check if it's a non-tense alias — resolve to base + "current"
    canonical = _ALIAS_TO_CANONICAL.get(normalized)
    if canonical is not None:
        # Even non-tense aliases might resolve to an ambiguous canonical
        if canonical in AMBIGUOUS_PREDICATES:
            return (canonical, None)
        return (canonical, "current")

    # 4. Unknown predicate — pass through with "current" default
    return (normalized, "current")


# ============================================================================
# TEST CASES
# ============================================================================

TENSE_PAIRS: list[tuple[str, str, str | None]] = [
    # (input_predicate, expected_base, expected_temporal_hint)

    # --- Past-tense aliases that must normalize to present-tense base ---
    ("worked_at", "works_at", "past"),
    ("lived_in", "lives_in", "past"),
    ("formerly_at", "works_at", "past"),
    ("ex_employee_of", "works_at", "past"),
    ("used_to_work_at", "works_at", "past"),
    ("used_to_live_in", "lives_in", "past"),
    ("formerly_in", "lives_in", "past"),

    # --- Base (present-tense) forms pass through unchanged ---
    ("works_at", "works_at", "current"),
    ("lives_in", "lives_in", "current"),
    ("manages", "manages", "current"),
    ("knows", "knows", "current"),

    # --- Non-tense predicates pass through ---
    ("mentors", "mentors", "current"),

    # --- Ambiguous predicates: past-tense grammar but canonical form ---
    ("created", "created", None),
]


def run_tests() -> bool:
    """Run all tense normalization tests. Returns True if all pass."""
    print("=" * 70)
    print("TENSE NORMALIZATION TESTS (B-S1)")
    print("=" * 70)
    print()

    passed = 0
    failed = 0
    total = len(TENSE_PAIRS)

    for input_pred, expected_base, expected_hint in TENSE_PAIRS:
        actual_base, actual_hint = normalize_tense(input_pred)
        ok = (actual_base == expected_base) and (actual_hint == expected_hint)

        if ok:
            passed += 1
            status = "PASS"
        else:
            failed += 1
            status = "FAIL"

        # Align output for readability
        input_col = f'"{input_pred}"'
        print(f"  [{status}] {input_col:<25} -> ({actual_base}, {actual_hint})", end="")
        if not ok:
            print(f"  EXPECTED ({expected_base}, {expected_hint})")
        else:
            print()

    print()
    print("-" * 70)

    # --- Extra: verify tense aliases are actually present in ONTOLOGY ---
    print()
    print("CONSISTENCY CHECKS:")
    alias_issues = 0
    for alias, hint in TENSE_ALIASES.items():
        canonical = _ALIAS_TO_CANONICAL.get(alias)
        if canonical is None:
            print(f"  [FAIL] Tense alias '{alias}' not found in ONTOLOGY aliases")
            alias_issues += 1
        else:
            print(f"  [PASS] '{alias}' -> '{canonical}' (hint={hint})")

    print()
    print("=" * 70)
    print(f"RESULTS: {passed}/{total} test cases passed, {failed} failed")
    if alias_issues > 0:
        print(f"         {alias_issues} consistency issue(s) found")
    print("=" * 70)

    return failed == 0 and alias_issues == 0


if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)
