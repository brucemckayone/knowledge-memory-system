"""
Agent history-awareness prompt tests (bead nmemo-2yv.82).

Background
==========

`get_reasoning_history(entity_id, limit?)` is exposed by the unified
graph-mcp tool surface to every connected agent. Prior to nmemo-2yv.82
only the reasoning agent's system prompt mentioned it, so reconciliation
and gardener re-evaluated identity / structural questions from scratch
on each run, blind to prior reasoning conclusions.

These tests lock the prompt-shape contract added by .82:

  - Both reconciliation_agent and gardener_agent system prompts mention
    `get_reasoning_history`.
  - Both prompts cap the read at `limit=3`-ish (scoped, not blanket).
  - Both prompts carry a staleness clause: prior conclusions are "PRIOR
    reasoning at a point in time, not current truth" — hypothesis seed,
    not verdict.
  - Both prompts now carry the PROMPT_SAFETY_SYSTEM_CLAUSE — the
    reasoning_reports.report and .question fields are agent-writable /
    user-controlled respectively, and flow through get_reasoning_history
    into these agents' prompts. The clause is what stops them from
    treating directives inside the persisted reports as instructions.

These are pure prompt-shape tests — no DB, no HTTP, no LLM — consistent
with the existing test_reconciliation_prompt.py pattern.
"""

import sys
from pathlib import Path

ML_SERVICES_ROOT = Path(__file__).resolve().parent.parent
if str(ML_SERVICES_ROOT) not in sys.path:
    sys.path.insert(0, str(ML_SERVICES_ROOT))

from app.gardener_agent import GARDENER_SYSTEM_PROMPT  # noqa: E402
from app.reconciliation_agent import (  # noqa: E402
    RECONCILIATION_AGENT_SYSTEM_PROMPT,
)
from app.reasoning_agent import REASONING_SYSTEM_PROMPT  # noqa: E402
from app.core.prompt_safety import (  # noqa: E402
    PROMPT_SAFETY_SYSTEM_CLAUSE,
)


# --- Reconciliation agent --------------------------------------------------


def test_reconciliation_prompt_mentions_get_reasoning_history():
    """The reconciliation agent must instruct itself to read prior
    reasoning conclusions before deciding on a candidate. Without this
    clause it re-evaluates identity from scratch every run."""
    p = RECONCILIATION_AGENT_SYSTEM_PROMPT
    assert "get_reasoning_history" in p, (
        "Reconciliation prompt must instruct the agent to call "
        "get_reasoning_history before deciding on candidates."
    )


def test_reconciliation_prompt_scopes_history_read_per_entity():
    """Scoped read, not blanket: the prompt names a per-entity limit so
    the agent doesn't pull unbounded history into its context."""
    p = RECONCILIATION_AGENT_SYSTEM_PROMPT
    # Either form of the cap is acceptable — assert at least one is present.
    assert ("limit=3" in p) or ("limit = 3" in p), (
        "Reconciliation prompt must scope get_reasoning_history reads "
        "(documented cap, e.g. limit=3 per entity)."
    )


def test_reconciliation_prompt_frames_prior_reasoning_as_hypothesis():
    """The agent must treat prior conclusions as a hypothesis seed, not
    a verdict — old reports may be wrong (the world changed). Prompt
    framing matters: without this clause the agent could rubber-stamp
    stale conclusions instead of re-verifying against current facts."""
    p = RECONCILIATION_AGENT_SYSTEM_PROMPT
    # Allow the framing to live in either the investigation block or
    # the workflow block — assert on the semantic markers.
    has_point_in_time_marker = (
        "point in time" in p.lower()
        or "not current truth" in p.lower()
    )
    has_hypothesis_marker = (
        "hypothesis" in p.lower() or "not a verdict" in p.lower()
    )
    assert has_point_in_time_marker, (
        "Reconciliation prompt must frame prior reasoning as 'point in "
        "time' / 'not current truth' so the agent re-verifies before "
        "acting on stale conclusions."
    )
    assert has_hypothesis_marker, (
        "Reconciliation prompt must frame prior conclusions as "
        "hypothesis seed / not a verdict — the agent must re-verify."
    )


def test_reconciliation_prompt_carries_prompt_safety_clause():
    """The reconciliation agent now consumes reasoning_reports.report
    (agent-written) and .question (user-controlled) via get_reasoning_
    history. The T8 prompt-safety clause is what tells the agent to
    treat content inside the delimited blocks as DATA, not instructions."""
    assert PROMPT_SAFETY_SYSTEM_CLAUSE in RECONCILIATION_AGENT_SYSTEM_PROMPT


def test_reconciliation_workflow_step_reads_history_before_facts():
    """The WORKFLOW section's per-candidate loop must read prior
    reasoning before querying facts — otherwise the agent investigates
    from scratch even though prior conclusions exist."""
    p = RECONCILIATION_AGENT_SYSTEM_PROMPT
    workflow_idx = p.index("=== WORKFLOW ===")
    rules_idx = p.index("=== RULES ===")
    workflow_block = p[workflow_idx:rules_idx]
    # In the workflow, the history-read step comes BEFORE the facts step.
    history_pos = workflow_block.find("get_reasoning_history")
    facts_pos = workflow_block.find("query_entity_facts")
    assert history_pos != -1, (
        "WORKFLOW block must mention get_reasoning_history in the "
        "per-candidate loop."
    )
    assert facts_pos != -1, "WORKFLOW block must mention query_entity_facts."
    assert history_pos < facts_pos, (
        "WORKFLOW must read prior reasoning BEFORE querying facts."
    )


# --- Gardener agent --------------------------------------------------------


def test_gardener_prompt_mentions_get_reasoning_history():
    """The gardener also has access to get_reasoning_history via the
    unified MCP. Without prompting, it never calls the tool and
    re-investigates structural questions the reasoning agent already
    closed."""
    p = GARDENER_SYSTEM_PROMPT
    assert "get_reasoning_history" in p, (
        "Gardener prompt must instruct the agent to call "
        "get_reasoning_history during investigation."
    )


def test_gardener_prompt_scopes_history_read():
    """Gardener investigates whole neighbourhoods; the read still needs
    a cap so a single gardening session doesn't pull unbounded history."""
    p = GARDENER_SYSTEM_PROMPT
    assert ("limit=3" in p) or ("limit = 3" in p), (
        "Gardener prompt must scope get_reasoning_history reads "
        "(documented cap, e.g. limit=3 per central entity)."
    )


def test_gardener_prompt_frames_prior_reasoning_as_hypothesis():
    """Same staleness framing as reconciliation: don't rubber-stamp
    stale conclusions; re-verify against current graph state."""
    p = GARDENER_SYSTEM_PROMPT
    has_point_in_time_marker = (
        "point in time" in p.lower()
        or "not current truth" in p.lower()
    )
    has_reverify_marker = "re-verify" in p.lower() or "verify against" in p.lower()
    assert has_point_in_time_marker, (
        "Gardener prompt must frame prior reasoning as 'point in time' "
        "/ 'not current truth'."
    )
    assert has_reverify_marker, (
        "Gardener prompt must require re-verification against current "
        "graph state before acting on a prior conclusion."
    )


def test_gardener_prompt_carries_prompt_safety_clause():
    """Gardener now consumes reasoning_reports.report / .question via
    get_reasoning_history. T8 surface — the clause is mandatory."""
    assert PROMPT_SAFETY_SYSTEM_CLAUSE in GARDENER_SYSTEM_PROMPT


def test_gardener_islands_subroutine_reads_history_first():
    """The islands investigation subroutine should read prior reasoning
    before traversing facts / sources. Locked-in ordering: history
    appears at or before step 1 of the subroutine."""
    p = GARDENER_SYSTEM_PROMPT
    islands_idx = p.index("For islands (disconnected components):")
    # Next section header bound — keep the slice tight to the subroutine.
    name_variants_idx = p.index(
        "For name variants and obvious duplicates:"
    )
    block = p[islands_idx:name_variants_idx]
    assert "get_reasoning_history" in block, (
        "Islands subroutine must include a get_reasoning_history step."
    )
    history_pos = block.find("get_reasoning_history")
    facts_pos = block.find("query_entity_facts")
    assert history_pos < facts_pos, (
        "Islands subroutine: get_reasoning_history must appear before "
        "query_entity_facts."
    )


def test_gardener_name_variants_subroutine_reads_history_for_both_sides():
    """The name-variants subroutine investigates pairs — history should
    be read for BOTH candidate entities before the lexical comparison."""
    p = GARDENER_SYSTEM_PROMPT
    name_variants_idx = p.index(
        "For name variants and obvious duplicates:"
    )
    # Bound on next subroutine header.
    sparse_leaves_idx = p.index(
        "For sparse leaves (PRIORITY"
    )
    block = p[name_variants_idx:sparse_leaves_idx]
    assert "get_reasoning_history" in block, (
        "Name-variants subroutine must include a get_reasoning_history step."
    )
    # Both entity_a_id and entity_b_id wired to history reads — locks the
    # both-sides intent against accidental future trimming to one side.
    assert "entity_a_id" in block and "entity_b_id" in block, (
        "Name-variants subroutine must read history for BOTH candidate "
        "entities (entity_a_id AND entity_b_id)."
    )


# --- Reasoning agent (regression guard) -----------------------------------


def test_reasoning_prompt_still_mentions_get_reasoning_history():
    """The reasoning agent has been reading its own history since
    inception. This is a regression guard — we don't want the .82
    cross-agent changes to accidentally trim the reasoning agent's
    self-history-read."""
    assert "get_reasoning_history" in REASONING_SYSTEM_PROMPT


# --- Standalone runner (matches the existing convention) -----------------

TESTS = [
    test_reconciliation_prompt_mentions_get_reasoning_history,
    test_reconciliation_prompt_scopes_history_read_per_entity,
    test_reconciliation_prompt_frames_prior_reasoning_as_hypothesis,
    test_reconciliation_prompt_carries_prompt_safety_clause,
    test_reconciliation_workflow_step_reads_history_before_facts,
    test_gardener_prompt_mentions_get_reasoning_history,
    test_gardener_prompt_scopes_history_read,
    test_gardener_prompt_frames_prior_reasoning_as_hypothesis,
    test_gardener_prompt_carries_prompt_safety_clause,
    test_gardener_islands_subroutine_reads_history_first,
    test_gardener_name_variants_subroutine_reads_history_for_both_sides,
    test_reasoning_prompt_still_mentions_get_reasoning_history,
]


def run_tests() -> bool:
    print("=" * 70)
    print("Agent history-awareness prompt tests (bead nmemo-2yv.82)")
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
