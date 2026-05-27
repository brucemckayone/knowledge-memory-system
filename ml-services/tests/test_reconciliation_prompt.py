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


# ---------------------------------------------------------------------------
# Bead nmemo-e8k: extraction-report references as a primary work source.
#
# The graph agent's PHASE 6 report carries ### PRONOUNS RESOLVED and
# ### ALIASES CREATED sections — cross-entity references the agent recorded
# but generic-noun rules prevent it from materialising as entities. The
# reconciliation agent must mine those sections and convert resolved
# references into same_as links (or create missing entities + link them).
# These tests lock that contract: system-prompt section exists and is
# ordered correctly, workflow includes the report-mining step, report
# format includes the processed-references section, and the prompt
# builder renders a per-prompt nudge when reports are present.
# ---------------------------------------------------------------------------


def test_system_prompt_has_extraction_report_references_section():
    """The new EXTRACTION REPORT REFERENCES section must exist between
    ORPHAN ENTITIES and SUMMARY UPDATES — it sits at the same level as
    HANDLING UNCONFIRMED ALIASES and ORPHAN ENTITIES (the other
    secondary-work sections) so the agent treats it as a primary pass."""
    p = RECONCILIATION_AGENT_SYSTEM_PROMPT
    orphan_idx = p.index("=== ORPHAN ENTITIES ===")
    references_idx = p.index("=== EXTRACTION REPORT REFERENCES ===")
    summary_idx = p.index("=== SUMMARY UPDATES ===")
    assert orphan_idx < references_idx < summary_idx, (
        "EXTRACTION REPORT REFERENCES must sit between ORPHAN ENTITIES and SUMMARY UPDATES"
    )


def test_extraction_references_section_names_the_phase6_headers():
    """The section must name the exact graph-agent PHASE 6 headers it
    expects to find — `### PRONOUNS RESOLVED` and `### ALIASES CREATED`.
    Without these literal strings the agent has to guess which sections
    contain the work."""
    p = RECONCILIATION_AGENT_SYSTEM_PROMPT
    start = p.index("=== EXTRACTION REPORT REFERENCES ===")
    end = p.index("=== SUMMARY UPDATES ===")
    section = p[start:end]
    assert "### PRONOUNS RESOLVED" in section
    assert "### ALIASES CREATED" in section
    # Must explicitly name create_same_as_link as the primary action.
    assert "create_same_as_link" in section
    # Must name the missing-entity path (resolve_entity then same_as link).
    assert "resolve_entity" in section


def test_workflow_includes_extraction_reports_pass():
    """The WORKFLOW section must include a step that mines the recent
    extraction reports for reference observations the candidate list did
    not already cover. Without this step the agent might skip the reports
    when the candidate list is non-empty."""
    p = RECONCILIATION_AGENT_SYSTEM_PROMPT
    workflow_idx = p.index("=== WORKFLOW ===")
    report_format_idx = p.index("=== REPORT FORMAT ===")
    workflow = p[workflow_idx:report_format_idx]
    # The workflow must reference the extraction-report mining step.
    assert "extraction report" in workflow.lower()
    # The phase-6 section names must be cited so the agent grep-finds them.
    assert "### PRONOUNS RESOLVED" in workflow
    assert "### ALIASES CREATED" in workflow


def test_report_format_includes_extraction_report_references_processed():
    """The REPORT FORMAT must include a section for the
    reference-processing outcomes so the per-observation actions are
    visible in the report log (and downstream readers can audit them)."""
    p = RECONCILIATION_AGENT_SYSTEM_PROMPT
    assert "### EXTRACTION REPORT REFERENCES PROCESSED" in p


def test_rules_block_forbids_same_as_from_report_alone():
    """The hard rule: the agent must cross-check both entities' facts
    before creating a same_as link sourced from an extraction report.
    This guards against the report being wrong and silently propagating
    a bad identity link into the graph."""
    p = RECONCILIATION_AGENT_SYSTEM_PROMPT
    rules_idx = p.rindex("=== RULES ===")
    rules = p[rules_idx:]
    # The exact rule must mention "extraction report" and "cross-check"
    # (or equivalent) so it's clearly a same-as guardrail.
    assert "extraction report" in rules.lower()
    assert "cross-check" in rules.lower() or "facts" in rules.lower()


def test_prompt_builder_nudges_agent_to_mine_phase6_sections():
    """When recent_reports is non-empty the prompt builder must render a
    leading nudge that tells the agent to scan PRONOUNS RESOLVED and
    ALIASES CREATED. This puts the work in front of the agent at the
    point where the reports appear — the system-prompt EXTRACTION REPORT
    REFERENCES section is the procedure; this nudge is the trigger."""
    sample_report = (
        "### ENTITIES FOUND\n- 'R. Walton' (person) — EXISTING, id=aaa\n"
        "- 'the stranger' (person) — NEW, id=bbb\n\n"
        "### PRONOUNS RESOLVED\n- 'he' / 'him' → the stranger\n"
        "- 'I' / 'my' → R. Walton\n"
    )
    prompt = _build_reconciliation_prompt(
        candidates=[], recent_reports=[sample_report]
    )
    # The nudge must reference both PHASE 6 sections by name.
    assert "### PRONOUNS RESOLVED" in prompt
    assert "### ALIASES CREATED" in prompt
    # And point at the system-prompt section name.
    assert "EXTRACTION REPORT REFERENCES" in prompt


def test_prompt_builder_omits_nudge_when_no_reports():
    """Empty recent_reports — no Recent Extraction Reports header AND no
    nudge. The nudge is gated on the reports actually being present so
    the prompt stays clean for callers that don't pass reports."""
    prompt = _build_reconciliation_prompt(candidates=[], recent_reports=[])
    assert "Recent Extraction Reports" not in prompt
    # The nudge string is only emitted when reports are present.
    assert "Mine each report" not in prompt


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
    # Bead nmemo-e8k — extraction-report references lock-in
    test_system_prompt_has_extraction_report_references_section,
    test_extraction_references_section_names_the_phase6_headers,
    test_workflow_includes_extraction_reports_pass,
    test_report_format_includes_extraction_report_references_processed,
    test_rules_block_forbids_same_as_from_report_alone,
    test_prompt_builder_nudges_agent_to_mine_phase6_sections,
    test_prompt_builder_omits_nudge_when_no_reports,
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
