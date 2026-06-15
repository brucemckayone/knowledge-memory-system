"""
Proposer prompt-builder test for Epoch v2 E4 (bead nmemo-vpz.4, doc 41 §4).

Asserts the propose/promote PROPOSER prompt contract WITHOUT an LLM, DB, or HTTP:
  - "chunk N of M" narration position (chunk_index is 0-based -> displayed 1-based);
  - the propose_* tool surface (resolve_anchor / propose_entity / propose_fact);
  - no CAUSE phase in the workflow;
  - the mandatory valid_at-or-undated rule (no silent omission);
  - the VERIFY supersession-hint instruction (supersedesFactId).

Imports the REAL builder + system prompt from app.graph_agent (not a mirror), so
a drift between the prompt and this contract surfaces as a test failure rather
than a silent behaviour change. The corpus-level check (undated flags actually
appear in extraction output) is a LIVE run, deferred to E8.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make `app` importable when running this file directly via pytest. Mirrors the
# bootstrap pattern from test_graph_agent_prompt.py.
ML_SERVICES_ROOT = Path(__file__).resolve().parent.parent
if str(ML_SERVICES_ROOT) not in sys.path:
    sys.path.insert(0, str(ML_SERVICES_ROOT))

from app.graph_agent import (  # noqa: E402
    GraphAgentRequest,
    PROPOSER_SYSTEM_PROMPT,
    _build_proposer_user_prompt,
    _system_prompt_for,
)


def _req(**kw) -> GraphAgentRequest:
    base = dict(
        source_text="Helix relocated to Austin in 2023.",
        memory_id="mem-1",
        mcp_config_path="/tmp/cfg.json",
        actor="extraction_proposer",
    )
    base.update(kw)
    return GraphAgentRequest(**base)


def test_proposer_actor_selects_proposer_system_prompt():
    assert _system_prompt_for("prose", "extraction_proposer") is PROPOSER_SYSTEM_PROMPT
    # Legacy actors keep the create_fact-centric base prompt.
    assert _system_prompt_for("prose", "graph_agent") is not PROPOSER_SYSTEM_PROMPT
    assert _system_prompt_for("prose", None) is not PROPOSER_SYSTEM_PROMPT


def test_system_prompt_is_propose_only():
    sp = PROPOSER_SYSTEM_PROMPT
    assert "propose_entity" in sp
    assert "propose_fact" in sp
    assert "resolve_anchor" in sp
    # Canonical writes are explicitly absent from the proposer's surface.
    assert "NO canonical-write tools" in sp
    assert "absent BY DESIGN" in sp


def test_user_prompt_chunk_position_one_based():
    up = _build_proposer_user_prompt(_req(chunk_index=2, total_chunks=5))
    assert "chunk 3 of 5" in up  # 0-based index 2 -> displayed 3 of 5
    assert "narration order" in up


def test_user_prompt_chunk_position_omitted_without_total():
    up = _build_proposer_user_prompt(_req(chunk_index=0, total_chunks=None))
    assert "## Chunk Position" not in up


def test_user_prompt_requires_valid_at_or_undated():
    up = _build_proposer_user_prompt(_req())
    assert "validAt" in up
    assert "undated=true" in up
    assert "NEVER omit the date silently" in up


def test_user_prompt_verify_supersession_hint():
    up = _build_proposer_user_prompt(_req())
    assert "VERIFY" in up
    assert "supersedesFactId" in up
    assert "priorCanonicalActiveInGroup" in up


def test_user_prompt_workflow_has_no_cause_phase():
    up = _build_proposer_user_prompt(_req())
    assert "ORIENT -> EXTRACT -> RELATE -> VERIFY" in up
    assert "RELATE -> CAUSE" not in up
    assert "NO CAUSE phase" in up


def test_user_prompt_uses_propose_tools():
    up = _build_proposer_user_prompt(_req())
    assert "propose_entity" in up
    assert "propose_fact" in up
    assert "resolve_anchor" in up
