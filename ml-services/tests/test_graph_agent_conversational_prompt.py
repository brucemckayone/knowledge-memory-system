"""
Graph-agent system-prompt tests for bead nmemo-3f9.3 (first-person speaker
resolution / conversational content-type addendum).

Bead 3f9.3 does the prompt surgery so the agent USES the pre-resolved
Participants block (threaded in 3f9.2) to anchor first-person ("I"/"my"/"me")
references to the known speaker entity ids, and so a first-person
conversational source yields SUBJECT-anchored self-facts instead of being
dropped as a generic role.

Per the converged DESIGN (Decision 3, hybrid):
  (1) A shared, behaviour-preserving base edit so the prompt frames pronouns
      as RESOLVED to a speaker/referent, never CREATED as their own named
      entity (already true for the narrative path — this removes the
      contradiction the conversational addendum would otherwise fight).
  (8) A new `conversational` content_type addendum, applied via the existing
      `_system_prompt_for` hook (same mechanism as code-ts / code-sql). The
      `prose` (default) path is UNCHANGED, so the Frankenstein regression
      holds by construction.

These are pure-string assertions on the constructed system prompt — no DB,
no HTTP, no LLM.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make `app` importable when running this file directly via pytest. Mirrors
# the bootstrap pattern from test_graph_agent_prompt.py.
ML_SERVICES_ROOT = Path(__file__).resolve().parent.parent
if str(ML_SERVICES_ROOT) not in sys.path:
    sys.path.insert(0, str(ML_SERVICES_ROOT))

from app.graph_agent import (  # noqa: E402
    CONVERSATIONAL_ADDENDUM,
    GRAPH_AGENT_SYSTEM_PROMPT,
    _system_prompt_for,
)


# --------------------------------------------------------------------------
# Item (8) — the conversational addendum is applied for content_type values
# that name the conversational stream, and ONLY then.
# --------------------------------------------------------------------------

def test_conversational_content_type_appends_addendum():
    """content_type='conversational' → base prompt + conversational addendum."""
    prompt = _system_prompt_for("conversational")
    assert prompt.startswith(GRAPH_AGENT_SYSTEM_PROMPT)
    assert CONVERSATIONAL_ADDENDUM in prompt
    assert prompt == GRAPH_AGENT_SYSTEM_PROMPT + CONVERSATIONAL_ADDENDUM


def test_conversational_content_type_is_case_insensitive():
    """Caller-declared content_type is normalised like code-ts / code-sql."""
    assert CONVERSATIONAL_ADDENDUM in _system_prompt_for("Conversational")
    assert CONVERSATIONAL_ADDENDUM in _system_prompt_for("CONVERSATIONAL")


# --------------------------------------------------------------------------
# Item (8) — the prose / code paths are UNCHANGED. The Frankenstein
# regression runs on content_type=prose; the conversational addendum must
# never leak into it. This is the "holds by construction" guarantee.
# --------------------------------------------------------------------------

def test_prose_path_unchanged_no_conversational_addendum():
    """Default (prose) path is exactly the base prompt — no addendum."""
    assert _system_prompt_for("prose") == GRAPH_AGENT_SYSTEM_PROMPT
    assert CONVERSATIONAL_ADDENDUM not in _system_prompt_for("prose")


def test_none_and_unknown_content_type_fall_back_to_prose():
    """None / unknown values fall back to the unchanged base prompt."""
    assert _system_prompt_for(None) == GRAPH_AGENT_SYSTEM_PROMPT
    assert _system_prompt_for("something-else") == GRAPH_AGENT_SYSTEM_PROMPT
    assert CONVERSATIONAL_ADDENDUM not in _system_prompt_for(None)


def test_code_paths_do_not_pick_up_conversational_addendum():
    """The code-ts / code-sql branches are independent of the new branch."""
    assert CONVERSATIONAL_ADDENDUM not in _system_prompt_for("code-ts")
    assert CONVERSATIONAL_ADDENDUM not in _system_prompt_for("code-sql")


# --------------------------------------------------------------------------
# Item (8) content — the addendum reframes the domain so first-person
# resolves to the pre-resolved Participants speaker, subject-anchors facts,
# and suppresses an assistant self-profile.
# --------------------------------------------------------------------------

def test_addendum_anchors_first_person_to_participants_block():
    """The addendum points the agent at the Participants block for 'I'."""
    text = CONVERSATIONAL_ADDENDUM
    # Names the Participants block as the speaker source.
    assert "Participants" in text
    # First-person markers are explicitly called out.
    for marker in ('"I"', '"my"', '"me"'):
        assert marker in text, f"missing first-person marker {marker}"
    # It must tell the agent NOT to fuzzy-resolve the speaker when the block
    # is present (deterministic ids take precedence).
    low = text.lower()
    assert "do not" in low or "don't" in low


def test_addendum_subject_anchors_and_handles_you_as_addressee():
    """Decision 2 — facts anchor to the SUBJECT, and 'you' → addressee."""
    text = CONVERSATIONAL_ADDENDUM
    low = text.lower()
    assert "subject" in low  # subject-anchoring is the framing
    assert '"you"' in text  # the second-person pronoun is addressed
    assert "addressee" in low  # 'you' resolves to the addressee participant


def test_addendum_suppresses_assistant_self_profile():
    """Decision 2 — assistant utterances kept only as they pertain to the
    user; pure assistant self-opinions are dropped (no self-profile)."""
    low = CONVERSATIONAL_ADDENDUM.lower()
    assert "assistant" in low
    # Anchor-to-user-not-assistant intent is present.
    assert "user" in low


def test_addendum_carries_a_self_fact_example():
    """Decision 1/RELATE — the addendum mirrors the narrative examples with a
    chat-shaped self-fact (e.g. graduated_with), so Haiku has a concrete
    pattern for emitting first-person life facts instead of dropping them."""
    low = CONVERSATIONAL_ADDENDUM.lower()
    assert "graduated_with" in low or "create_fact" in low


# --------------------------------------------------------------------------
# Item (1) — the shared base edit is behaviour-preserving and mode-neutral:
# pronouns are RESOLVED to the speaker/referent, never CREATED as their own
# named entity. This lives in the BASE prompt (applies to every content_type)
# so it must be present in the prose path too — without re-introducing the
# old blanket "never extract first-person facts" contradiction.
# --------------------------------------------------------------------------

def test_base_prompt_frames_pronouns_as_resolved_not_created():
    """The base prompt states pronouns are resolved to a speaker/referent and
    never created as their own entity — present on the prose path as well."""
    base = GRAPH_AGENT_SYSTEM_PROMPT
    low = base.lower()
    # The resolution framing is present.
    assert "resolved to" in low or "resolve" in low
    # And the never-create-an-entity-named-after-a-pronoun rule.
    assert "never" in low

    # The base must NOT claim first-person *facts* are forbidden — only that a
    # pronoun is never created as its own NAMED ENTITY. The narrative path
    # already resolves "I" → narrator and emits first-person facts, so a
    # blanket "do not extract first-person" line would be the contradiction
    # this bead removes.
    assert "never extract first-person" not in low
    assert "drop first-person" not in low
