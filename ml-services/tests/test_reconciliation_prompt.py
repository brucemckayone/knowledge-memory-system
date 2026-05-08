"""
Phase 4 — reconciliation prompt-builder integration test (doc 25 §4.2 W6 lock)

The contract: when the reconciliation_agent's prompt-builder receives a
cross-cluster candidate row (`candidate_source == 'cross_cluster_generator'`),
the resulting prompt must:
  - contain the literal "Cross-Cluster Candidates" section header
  - include both entity names so the LLM can ground its investigation
  - NOT render the NULL 3-signal columns as zeros (which would mislead the
    LLM into thinking those signals fired weakly when they're inapplicable)
  - keep three-signal candidates rendered in their own separate block
  - degrade gracefully on the legacy / unknown candidate_source key

These tests are pure-function — no DB, no HTTP, no LLM. They lock the
prompt-rendering shape against the doc 25 §2.4 / §4.2 contract.
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


def test_system_prompt_carries_cross_cluster_section():
    """The §2.4 lock requires the 'CROSS-CLUSTER CANDIDATES' section to live
    between INVESTIGATION PROCESS and BRIDGE FACTS in the system prompt
    so the LLM has the rules-of-engagement before it encounters the
    candidate block. Lock the ordering."""
    p = RECONCILIATION_AGENT_SYSTEM_PROMPT
    investigation_idx = p.index("=== INVESTIGATION PROCESS ===")
    cross_cluster_idx = p.index("=== CROSS-CLUSTER CANDIDATES ===")
    bridge_facts_idx = p.index("=== BRIDGE FACTS ===")
    assert investigation_idx < cross_cluster_idx < bridge_facts_idx
    # The section must mention the source-tag literal so the LLM can match
    # it to the rendered prompt block downstream.
    assert "cross_cluster_generator" in p


def test_cross_cluster_candidate_renders_with_section_header():
    """§4.2 lock: prompt for a single cross-cluster row contains the
    literal section header AND both entity names."""
    candidates = [make_cross_cluster_candidate()]
    prompt = _build_reconciliation_prompt(candidates, recent_reports=[])
    assert "Cross-Cluster Candidates" in prompt
    assert "Victor Frankenstein" in prompt
    assert "the stranger" in prompt


def test_cross_cluster_candidate_does_not_render_null_signals_as_zeros():
    """§2.5 R3 B3: NULL 3-signal cols on cross-cluster rows must NOT show
    up as 'centroid=0.00 memory_overlap=0.00 structural=0.00' — that would
    teach the LLM that the signals fired weakly when they're inapplicable.
    The cross-cluster block uses a different rendering."""
    candidates = [make_cross_cluster_candidate()]
    prompt = _build_reconciliation_prompt(candidates, recent_reports=[])
    cross_section_start = prompt.index("Cross-Cluster Candidates")
    cross_section = prompt[cross_section_start:]
    assert "centroid=0.00" not in cross_section
    assert "memory_overlap=0.00" not in cross_section
    assert "structural=0.00" not in cross_section
    # The cross-cluster row must say so explicitly.
    assert "NULL" in cross_section


def test_three_signal_candidate_still_renders_in_legacy_block():
    """Three-signal candidates keep their original rendering. Lock the
    block name + the centroid/memory/structural inline shape."""
    candidates = [make_three_signal_candidate()]
    prompt = _build_reconciliation_prompt(candidates, recent_reports=[])
    assert "3-Signal Candidates" in prompt
    assert "centroid=0.81" in prompt
    assert "memory_overlap=0.20" in prompt
    assert "structural=0.50" in prompt
    # No cross-cluster block when none are present.
    assert "Cross-Cluster Candidates" not in prompt


def test_mixed_candidates_split_into_two_blocks():
    """Mixed pool of both classes: each renders in its own section, in
    the correct order (3-signal first, then cross-cluster)."""
    candidates = [
        make_three_signal_candidate(id="ts-A"),
        make_cross_cluster_candidate(id="cc-B"),
        make_three_signal_candidate(id="ts-C", a_name="Bob", b_name="Robert"),
    ]
    prompt = _build_reconciliation_prompt(candidates, recent_reports=[])
    # Both block headers present.
    three_idx = prompt.index("3-Signal Candidates")
    cross_idx = prompt.index("Cross-Cluster Candidates")
    assert three_idx < cross_idx, "3-signal block must come before cross-cluster"
    # Counts in headers reflect the split (2 three-signal, 1 cross-cluster).
    assert "(2 unresolved)" in prompt
    assert "(1 unresolved" in prompt


def test_unknown_or_missing_candidate_source_falls_back_to_three_signal():
    """Backward-compat: a candidate with no candidate_source key (older
    rows, tests, future-source-not-yet-known) renders in the three-signal
    block so the prompt is never broken by an unrecognised source tag."""
    no_source = make_three_signal_candidate()
    no_source.pop("candidate_source")
    unknown_source = make_three_signal_candidate()
    unknown_source["candidate_source"] = "future_unknown_source_v2"

    prompt = _build_reconciliation_prompt(
        [no_source, unknown_source], recent_reports=[]
    )
    # Both end up in the three-signal block — count says so.
    assert "(2 unresolved)" in prompt
    assert "Cross-Cluster Candidates" not in prompt


def test_cross_cluster_reasoning_seed_propagates_through_prompt():
    """The resolution_reasoning JSON (per-signal contributions) is the
    hypothesis seed the LLM uses to focus its investigation. It must
    survive into the rendered prompt so the agent sees which signals
    fired."""
    candidate = make_cross_cluster_candidate()
    prompt = _build_reconciliation_prompt([candidate], recent_reports=[])
    assert "reasoning_seed" in prompt
    assert "cluster" in prompt  # one of the contribution keys
    assert "0.91" in prompt    # the cluster contribution literal


def test_cross_cluster_with_no_resolution_reasoning_renders_placeholder():
    """If the generator wrote no resolution_reasoning (older row, manual
    insert, etc), the prompt should show a placeholder rather than the
    Python 'None' literal which would confuse the LLM."""
    candidate = make_cross_cluster_candidate()
    candidate["resolution_reasoning"] = None
    prompt = _build_reconciliation_prompt([candidate], recent_reports=[])
    assert "(no per-signal seed)" in prompt
    assert "reasoning_seed: None" not in prompt


# Standalone runner — matches the existing ml-services/tests/* convention
# (no pytest in the venv; tests are invoked via `py -m tests.<name>` per
# their docstrings). Each test_* function above is a self-contained
# assertion block; running them in order via the runner gives the same
# behaviour as pytest discovery without the dependency.
TESTS = [
    test_system_prompt_carries_cross_cluster_section,
    test_cross_cluster_candidate_renders_with_section_header,
    test_cross_cluster_candidate_does_not_render_null_signals_as_zeros,
    test_three_signal_candidate_still_renders_in_legacy_block,
    test_mixed_candidates_split_into_two_blocks,
    test_unknown_or_missing_candidate_source_falls_back_to_three_signal,
    test_cross_cluster_reasoning_seed_propagates_through_prompt,
    test_cross_cluster_with_no_resolution_reasoning_renders_placeholder,
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
