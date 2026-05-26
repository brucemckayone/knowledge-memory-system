"""
Reconciliation prompt-builder integration test (bead nmemo-2yv.44 single-block
shape; supersedes doc 25 §2.4's two-block W6 lock).

Post-bead .42 + .44: all candidates go through one scoreMergeCandidates pass
and render through one prompt block. `candidate_source` becomes an enumerator-
origin tag (visible in the prompt's source= field) but no longer drives
prompt branching. The contract:

  - all candidates render in a single "Merge Candidates" block
  - NULL signals appear as the literal "NULL" (not "0.00") so the LLM can
    distinguish "signal not applicable" from "signal fired weakly"
  - the candidate_source value is visible on each row
  - reasoning_seed propagates from resolution_reasoning when present
  - legacy / unknown source values degrade gracefully (still render)

These tests are pure-function — no DB, no HTTP, no LLM. They lock the
prompt-rendering shape against the doc 25 §2.4 / §4.2 contract (revised
under .44 to match the single-block reality post-.42).
"""

import sys
from pathlib import Path

# Make `app` importable when running this file directly via pytest from
# repo root or ml-services. Tests in this dir do not chain through
# conftest.py for path setup, so do it explicitly.
ML_SERVICES_ROOT = Path(__file__).resolve().parent.parent
if str(ML_SERVICES_ROOT) not in sys.path:
    sys.path.insert(0, str(ML_SERVICES_ROOT))

from app.reconciliation_agent import (  # noqa: E402
    _build_reconciliation_prompt,
    RECONCILIATION_AGENT_SYSTEM_PROMPT,
)


def make_three_signal_candidate(**overrides) -> dict:
    base = {
        "id": "ts-001",
        "combined_score": 0.78,
        "status": "candidate",
        "candidate_source": "three_signal_scoring",
        "entity_a_id": "00000000-0000-0000-0000-00000000000a",
        "entity_b_id": "00000000-0000-0000-0000-00000000000b",
        "a_name": "Alice",
        "a_type": "person",
        "b_name": "Alice Margaret",
        "b_type": "person",
        "centroid_similarity": 0.81,
        "memory_overlap": 0.20,
        "structural_similarity": 0.50,
    }
    base.update(overrides)
    return base


def make_cross_cluster_candidate(**overrides) -> dict:
    base = {
        "id": "cc-001",
        "combined_score": 0.42,
        "status": "candidate",
        "candidate_source": "cross_cluster_generator",
        "entity_a_id": "00000000-0000-0000-0000-00000000000c",
        "entity_b_id": "00000000-0000-0000-0000-00000000000d",
        "a_name": "Victor Frankenstein",
        "a_type": "person",
        "b_name": "the stranger",
        "b_type": "person",
        # NULL — by design per §2.5 R3 B3
        "centroid_similarity": None,
        "memory_overlap": None,
        "structural_similarity": None,
        "resolution_reasoning": (
            '{"contributions": {"cluster": 0.91, "drift_a": 0, "drift_b": 0, '
            '"role": 0.42, "centrality": 0.10, "articulation": 0.5}, '
            '"component_a": 3, "component_b": 7, "drift_driven": false}'
        ),
    }
    base.update(overrides)
    return base


def test_system_prompt_carries_interpreting_signals_section():
    """Post-.44 the system prompt has one signal-interpretation section
    (=== INTERPRETING SIGNALS ===) sitting between INVESTIGATION PROCESS
    and BRIDGE FACTS — replacing the old two-block CROSS-CLUSTER section.
    Lock the ordering and the NULL-handling guidance."""
    p = RECONCILIATION_AGENT_SYSTEM_PROMPT
    investigation_idx = p.index("=== INVESTIGATION PROCESS ===")
    interpreting_idx = p.index("=== INTERPRETING SIGNALS ===")
    bridge_facts_idx = p.index("=== BRIDGE FACTS ===")
    assert investigation_idx < interpreting_idx < bridge_facts_idx
    # Must explain how NULL signals are read.
    assert "NULL" in p[interpreting_idx:bridge_facts_idx]
    # Old two-block section must be gone — single-block contract.
    assert "=== CROSS-CLUSTER CANDIDATES ===" not in p


def test_single_block_renders_all_candidates_uniformly():
    """Post-.44 single-block contract: a mix of three_signal +
    cross_cluster candidates renders in one "Merge Candidates" block,
    with the candidate_source tag visible on each row."""
    candidates = [
        make_three_signal_candidate(id="ts-A"),
        make_cross_cluster_candidate(id="cc-B"),
        make_three_signal_candidate(id="ts-C", a_name="Bob", b_name="Robert"),
    ]
    prompt = _build_reconciliation_prompt(candidates, recent_reports=[])
    # One block, not two.
    assert "Merge Candidates" in prompt
    assert "3-Signal Candidates" not in prompt
    assert "Cross-Cluster Candidates" not in prompt
    # Single count covers everything.
    assert "(3 unresolved)" in prompt
    # Each source value visible on its row.
    assert "source=three_signal_scoring" in prompt
    assert "source=cross_cluster_generator" in prompt


def test_null_signals_render_as_literal_NULL_not_zero():
    """Cross-component pairs leave centroid/memory_overlap/structural NULL
    (inputs absent). The prompt must render the literal "NULL" so the LLM
    can distinguish "signal not applicable" from "signal fired weakly".
    Rendering as 0.00 would mislead the agent."""
    candidates = [make_cross_cluster_candidate()]
    prompt = _build_reconciliation_prompt(candidates, recent_reports=[])
    # Both entity names appear so the LLM can ground its investigation.
    assert "Victor Frankenstein" in prompt
    assert "the stranger" in prompt
    # NULL signals stay NULL — no silent zeros.
    assert "centroid=NULL" in prompt
    assert "memory_overlap=NULL" in prompt
    assert "structural=NULL" in prompt
    assert "centroid=0.00" not in prompt
    assert "memory_overlap=0.00" not in prompt
    assert "structural=0.00" not in prompt


def test_populated_signals_still_render_numerically():
    """When the 3-signal columns are populated (typical for within-component
    pairs from three_signal_scoring), they render numerically. Lock the
    centroid/memory/structural inline shape."""
    candidates = [make_three_signal_candidate()]
    prompt = _build_reconciliation_prompt(candidates, recent_reports=[])
    assert "centroid=0.81" in prompt
    assert "memory_overlap=0.20" in prompt
    assert "structural=0.50" in prompt
    # Source tag visible.
    assert "source=three_signal_scoring" in prompt


def test_unknown_or_missing_candidate_source_renders_gracefully():
    """Backward-compat: a candidate with no candidate_source key (older
    rows, tests, future-source-not-yet-known) still renders. The source=
    field shows 'unknown' for missing keys; explicit unknown values come
    through verbatim so they're visible for triage."""
    no_source = make_three_signal_candidate()
    no_source.pop("candidate_source")
    unknown_source = make_three_signal_candidate()
    unknown_source["candidate_source"] = "future_unknown_source_v2"

    prompt = _build_reconciliation_prompt(
        [no_source, unknown_source], recent_reports=[]
    )
    # Both render in the same block.
    assert "(2 unresolved)" in prompt
    # The unknown source tag passes through, and missing keys default to 'unknown'.
    assert "source=future_unknown_source_v2" in prompt
    assert "source=unknown" in prompt


def test_reasoning_seed_propagates_through_prompt():
    """The resolution_reasoning JSON (per-signal contributions) is the
    hypothesis seed the LLM uses to focus its investigation. It must
    survive into the rendered prompt so the agent sees which signals
    fired — applies to every candidate that has one."""
    candidate = make_cross_cluster_candidate()
    prompt = _build_reconciliation_prompt([candidate], recent_reports=[])
    assert "reasoning_seed" in prompt
    assert "cluster" in prompt  # one of the contribution keys
    assert "0.91" in prompt    # the cluster contribution literal


def test_missing_resolution_reasoning_renders_placeholder():
    """If no resolution_reasoning was written (older row, manual insert,
    etc), the prompt shows a placeholder rather than the Python 'None'
    literal which would confuse the LLM."""
    candidate = make_cross_cluster_candidate()
    candidate["resolution_reasoning"] = None
    prompt = _build_reconciliation_prompt([candidate], recent_reports=[])
    assert "(no per-signal seed)" in prompt
    assert "reasoning_seed: None" not in prompt


def test_no_candidates_renders_empty_marker():
    """Sanity: empty candidate list renders the no-candidates marker
    rather than an empty Merge Candidates header."""
    prompt = _build_reconciliation_prompt([], recent_reports=[])
    assert "No merge candidates" in prompt
    assert "Merge Candidates (" not in prompt


# Standalone runner — matches the existing ml-services/tests/* convention
# (no pytest in the venv; tests are invoked via `py -m tests.<name>` per
# their docstrings). Each test_* function above is a self-contained
# assertion block; running them in order via the runner gives the same
# behaviour as pytest discovery without the dependency.
TESTS = [
    test_system_prompt_carries_interpreting_signals_section,
    test_single_block_renders_all_candidates_uniformly,
    test_null_signals_render_as_literal_NULL_not_zero,
    test_populated_signals_still_render_numerically,
    test_unknown_or_missing_candidate_source_renders_gracefully,
    test_reasoning_seed_propagates_through_prompt,
    test_missing_resolution_reasoning_renders_placeholder,
    test_no_candidates_renders_empty_marker,
]


def run_tests() -> bool:
    print("=" * 70)
    print("Reconciliation prompt-builder tests (doc 25 §4.2)")
    print("=" * 70)
    passed = 0
    failed = []
    for fn in TESTS:
        name = fn.__name__
        try:
            fn()
            print(f"  PASS  {name}")
            passed += 1
        except AssertionError as e:
            print(f"  FAIL  {name}: {e}")
            failed.append((name, str(e)))
        except Exception as e:  # noqa: BLE001
            print(f"  ERR   {name}: {type(e).__name__}: {e}")
            failed.append((name, f"{type(e).__name__}: {e}"))
    print("-" * 70)
    print(f"Result: {passed}/{len(TESTS)} passed")
    if failed:
        print("Failures:")
        for name, msg in failed:
            print(f"  - {name}: {msg}")
    print("=" * 70)
    return len(failed) == 0


if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)
