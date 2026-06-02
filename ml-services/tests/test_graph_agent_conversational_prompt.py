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
    GRAPH_AGENT_CONVERSATIONAL_SYSTEM_PROMPT,
    GRAPH_AGENT_SYSTEM_PROMPT,
    _system_prompt_for,
)


# --------------------------------------------------------------------------
# Item (8) / nmemo-hms — the conversational content_type uses a SEPARATE base
# prompt (the conversational segment variants), NOT base+appended-override.
# The append-then-override structure was proven ineffective on Haiku (it obeyed
# the proper-noun gate that physically preceded the override), so the gate is
# now ABSENT from the conversational base and the addendum only adds positive
# subject-anchoring guidance + worked examples.
# --------------------------------------------------------------------------

def test_conversational_uses_conversational_base_plus_addendum():
    """content_type='conversational' → conversational base + addendum (NOT the
    narrative base + an override)."""
    prompt = _system_prompt_for("conversational")
    assert prompt == GRAPH_AGENT_CONVERSATIONAL_SYSTEM_PROMPT + CONVERSATIONAL_ADDENDUM
    # It must NOT be built from the narrative base.
    assert not prompt.startswith(GRAPH_AGENT_SYSTEM_PROMPT)
    assert CONVERSATIONAL_ADDENDUM in prompt


def test_conversational_base_omits_the_proper_noun_gate():
    """The whole point of nmemo-hms: the conversational base has NOTHING to
    override — the PHASE 2 proper-noun-only gate and the WORKFLOW 3 narrator-
    inference recipe are simply NOT PRESENT."""
    conv = GRAPH_AGENT_CONVERSATIONAL_SYSTEM_PROMPT
    # The narrative base gates entity creation on proper nouns; the
    # conversational base must not.
    assert "PROPER NOUNS ONLY" in GRAPH_AGENT_SYSTEM_PROMPT
    assert "PROPER NOUNS ONLY" not in conv
    # The narrator-inference recipe ("figuring out who 'I' is" by searching) is
    # gone — the speaker is given by the Participants block.
    assert "figuring out who" in GRAPH_AGENT_SYSTEM_PROMPT
    assert "figuring out who" not in conv
    # The conversational base still mentions the Participants block + forbids
    # dropping unnamed-user facts.
    assert "Participants" in conv
    low = conv.lower()
    assert "unnamed" in low
    assert "do not need a proper noun" in low or "no proper-noun requirement" in low


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
# nmemo-hms — the FIX that worked on the real Haiku agent: stop fighting the
# proper-noun gate with an end-positioned override (Haiku obeyed the gate that
# physically preceded the override and refused unnamed-user facts). Instead the
# conversational prompt is COMPOSED from segment variants where the gate and
# the narrator-inference recipe DO NOT EXIST. These assertions lock in that
# compose-not-override structure so a future regression to base+addendum is
# caught at the prompt-shape level.
# --------------------------------------------------------------------------

def test_conversational_phase2_replaced_not_appended_with_override():
    """The conversational base REPLACES the PHASE 2 entity policy rather than
    leaving the narrative gate in place and appending a counter-instruction.
    There must be exactly one PHASE 2 EXTRACT header and it must not contain the
    proper-noun-only gate."""
    conv = GRAPH_AGENT_CONVERSATIONAL_SYSTEM_PROMPT
    # The narrative 'NEVER EXTRACT ... the narrator' line is the gate that made
    # Haiku refuse unnamed-user facts — it must be gone from the conv base.
    assert "Generic roles or descriptions: the narrator" not in conv
    # And the positive replacement is present: the speaker is pre-resolved and
    # needs no proper noun.
    low = conv.lower()
    assert "pre-resolved" in low
    assert "do not need a proper noun" in low


def test_conversational_base_workflow3_is_given_not_discovered():
    """WORKFLOW 3 in the conversational base says the speaker is ALREADY DECIDED
    (given by the Participants block), not discovered by searching."""
    conv = GRAPH_AGENT_CONVERSATIONAL_SYSTEM_PROMPT
    low = conv.lower()
    assert "already been decided" in low or "already decided" in low
    # The narrative recipe to search prior chunks to discover the narrator is
    # gone.
    assert "find similar prior chunks" not in conv


def test_conversational_base_forbids_dropping_unnamed_user_facts():
    """The core failure mode (drop user facts because the speaker is unnamed) is
    explicitly forbidden IN THE BASE, so Haiku stops citing 'narrator unnamed'."""
    low = GRAPH_AGENT_CONVERSATIONAL_SYSTEM_PROMPT.lower()
    assert "unnamed" in low
    assert "zero facts" in low or "never drop" in low or "do not drop" in low


def test_addendum_no_longer_needs_override_framing():
    """The addendum is now positive guidance only — it explicitly says it does
    NOT override (there is nothing to override; the gate is absent)."""
    low = CONVERSATIONAL_ADDENDUM.lower()
    assert "does not override" in low or "nothing to override" in low


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
