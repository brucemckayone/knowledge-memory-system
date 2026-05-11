"""
Contradiction Detection Endpoint
Phase 4: Check if two facts contradict each other

Implements ALICE framework with:
1. Quick heuristic checks (antonyms, exclusive predicates, temporal overlap)
2. LLM debate protocol for subtle cases (advocate vs defender, then judge)
3. Single LLM call as fallback if debate fails
"""

import asyncio
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from .core.llm import llm_client

logger = logging.getLogger(__name__)

router = APIRouter()


# --- Models ---


class FactData(BaseModel):
    subject: str
    predicate: str
    object: str
    valid_at: Optional[str] = None
    invalid_at: Optional[str] = None


class DebateLog(BaseModel):
    advocate_argument: str
    defender_argument: str
    judge_reasoning: str
    advocate_saw_contradiction: bool
    defender_saw_coexistence: bool


class CheckContradictionRequest(BaseModel):
    fact1: FactData
    fact2: FactData


class CheckContradictionResponse(BaseModel):
    contradicts: bool
    type: str
    resolution: str
    reasoning: str
    confidence: float
    debate: Optional[DebateLog] = None


# --- Heuristic data ---

ANTONYM_PAIRS = {
    ('employed', 'unemployed'),
    ('active', 'inactive'),
    ('alive', 'dead'),
    ('married', 'single'),
    ('open', 'closed'),
}

EXCLUSIVE_PREDICATES = {
    'works_at',
    'lives_in',
    'married_to',
    'reports_to',
    'ceo_of',
    'president_of',
}


# --- Heuristic functions ---


def quick_antonym_check(pred1: str, pred2: str) -> bool:
    """Check for known antonym pairs"""
    return (pred1, pred2) in ANTONYM_PAIRS or (pred2, pred1) in ANTONYM_PAIRS


def is_exclusive_predicate(predicate: str) -> bool:
    """Check if predicate is typically exclusive"""
    return any(exc in predicate.lower() for exc in EXCLUSIVE_PREDICATES)


def times_overlap(f1: FactData, f2: FactData) -> bool:
    """Check if fact time ranges overlap"""
    if not f1.valid_at or not f2.valid_at:
        return True

    try:
        from datetime import datetime

        s1 = datetime.fromisoformat(f1.valid_at)
        s2 = datetime.fromisoformat(f2.valid_at)

        far_future = datetime(9999, 12, 31)
        e1 = datetime.fromisoformat(f1.invalid_at) if f1.invalid_at else far_future
        e2 = datetime.fromisoformat(f2.invalid_at) if f2.invalid_at else far_future

        return s1 < e2 and s2 < e1
    except (ValueError, TypeError):
        return True


# --- Debate prompts ---

ADVOCATE_PROMPT = """You are a contradiction analyst for a personal knowledge graph.
Your role: argue that these two facts CONTRADICT each other.

FACT 1 (Existing):
  Subject: {fact1_subject}
  Predicate: {fact1_predicate}
  Object: {fact1_object}
  Valid from: {fact1_valid_at}
  Valid until: {fact1_invalid_at}

FACT 2 (New):
  Subject: {fact2_subject}
  Predicate: {fact2_predicate}
  Object: {fact2_object}
  Valid from: {fact2_valid_at}
  Valid until: {fact2_invalid_at}

Build the STRONGEST case that these facts cannot both be true.
Consider: semantic opposition, exclusive relationships, temporal overlap, logical incompatibility.
If you genuinely cannot find a contradiction, say so honestly.

Return raw JSON only, no markdown code fences:
{{
  "has_contradiction": true/false,
  "argument": "Your detailed argument (2-3 sentences)",
  "contradiction_type": "antonym|numeric|negation|structural|temporal|none",
  "strength": 0.0-1.0
}}"""

DEFENDER_PROMPT = """You are a compatibility analyst for a personal knowledge graph.
Your role: argue that these two facts CAN COEXIST.

FACT 1 (Existing):
  Subject: {fact1_subject}
  Predicate: {fact1_predicate}
  Object: {fact1_object}
  Valid from: {fact1_valid_at}
  Valid until: {fact1_invalid_at}

FACT 2 (New):
  Subject: {fact2_subject}
  Predicate: {fact2_predicate}
  Object: {fact2_object}
  Valid from: {fact2_valid_at}
  Valid until: {fact2_invalid_at}

Build the STRONGEST case that both facts can be true simultaneously.
Consider: different time periods, different contexts/roles, non-exclusive interpretations, complementary meanings.
If they genuinely cannot coexist, say so honestly.

Return raw JSON only, no markdown code fences:
{{
  "can_coexist": true/false,
  "argument": "Your detailed argument (2-3 sentences)",
  "coexistence_type": "temporal_separation|different_context|non_exclusive|complementary|none",
  "strength": 0.0-1.0
}}"""

JUDGE_PROMPT = """You are an impartial judge for a knowledge graph contradiction system.
Two analysts examined whether these facts contradict. Evaluate their arguments and decide.

FACTS:
  Fact 1: {fact1_subject} -- {fact1_predicate} -- {fact1_object} (valid: {fact1_valid_at} to {fact1_invalid_at})
  Fact 2: {fact2_subject} -- {fact2_predicate} -- {fact2_object} (valid: {fact2_valid_at} to {fact2_invalid_at})

ARGUMENT FOR CONTRADICTION:
{advocate_argument}

ARGUMENT FOR COEXISTENCE:
{defender_argument}

Evaluate carefully:
1. Which argument is more compelling for these specific facts?
2. Are there unsupported assumptions in either argument?
3. What is the most likely real-world interpretation?

Return raw JSON only, no markdown code fences:
{{
  "contradicts": true/false,
  "type": "antonym|numeric|negation|structural|temporal|none",
  "resolution": "supersede|invalidate|coexist|flag",
  "reasoning": "Your synthesis (2-3 sentences)",
  "confidence": 0.0-1.0
}}

Resolution meanings:
- supersede: New fact replaces old (temporal update)
- invalidate: Old fact was wrong (correction)
- coexist: Both can be true (no conflict)
- flag: Arguments are close in strength -- needs human review"""

SINGLE_CALL_PROMPT = """Analyze if these two facts contradict each other.

FACT 1 (Existing):
  Subject: {fact1_subject}
  Predicate: {fact1_predicate}
  Object: {fact1_object}
  Valid from: {fact1_valid_at}
  Valid until: {fact1_invalid_at}

FACT 2 (New):
  Subject: {fact2_subject}
  Predicate: {fact2_predicate}
  Object: {fact2_object}
  Valid from: {fact2_valid_at}
  Valid until: {fact2_invalid_at}

Contradiction types:
1. antonym - Direct opposites (employed vs unemployed)
2. numeric - Incompatible numbers
3. negation - Explicit negation
4. structural - Incompatible relationships (can't be in two places)
5. temporal - Same property with conflicting times

Return raw JSON only, no markdown code fences:
{{
  "contradicts": true/false,
  "type": "antonym|numeric|negation|structural|temporal|none",
  "resolution": "supersede|invalidate|coexist|flag",
  "reasoning": "explanation",
  "confidence": 0.0-1.0
}}"""


# --- Debate implementation ---


def _build_fact_context(f1: FactData, f2: FactData) -> dict:
    return {
        "fact1_subject": f1.subject,
        "fact1_predicate": f1.predicate,
        "fact1_object": f1.object,
        "fact1_valid_at": f1.valid_at or "unknown",
        "fact1_invalid_at": f1.invalid_at or "ongoing",
        "fact2_subject": f2.subject,
        "fact2_predicate": f2.predicate,
        "fact2_object": f2.object,
        "fact2_valid_at": f2.valid_at or "unknown",
        "fact2_invalid_at": f2.invalid_at or "ongoing",
    }


def _call_advocate(context: dict) -> dict:
    return llm_client.generate_json(
        ADVOCATE_PROMPT.format(**context),
        options={"task": "check_contradiction"}
    )


def _call_defender(context: dict) -> dict:
    return llm_client.generate_json(
        DEFENDER_PROMPT.format(**context),
        options={"task": "check_contradiction"}
    )


def _call_judge(context: dict, advocate_arg: str, defender_arg: str) -> dict:
    judge_context = {
        **context,
        "advocate_argument": advocate_arg,
        "defender_argument": defender_arg,
    }
    return llm_client.generate_json(
        JUDGE_PROMPT.format(**judge_context),
        options={"task": "judge"}
    )


async def debate_contradiction(
    f1: FactData, f2: FactData
) -> CheckContradictionResponse:
    """
    Adversarial debate protocol for subtle contradictions.

    Runs advocate (argues contradiction) and defender (argues coexistence)
    concurrently, then a judge evaluates both arguments.
    """
    context = _build_fact_context(f1, f2)

    # Advocate and defender run concurrently
    advocate_result, defender_result = await asyncio.gather(
        asyncio.to_thread(_call_advocate, context),
        asyncio.to_thread(_call_defender, context),
    )

    advocate_arg = advocate_result.get("argument", "No argument provided")
    defender_arg = defender_result.get("argument", "No argument provided")

    # Judge evaluates both
    verdict = await asyncio.to_thread(
        _call_judge, context, advocate_arg, defender_arg
    )

    debate_log = DebateLog(
        advocate_argument=advocate_arg,
        defender_argument=defender_arg,
        judge_reasoning=verdict.get("reasoning", ""),
        advocate_saw_contradiction=advocate_result.get("has_contradiction", False),
        defender_saw_coexistence=defender_result.get("can_coexist", False),
    )

    return CheckContradictionResponse(
        contradicts=verdict.get("contradicts", False),
        type=verdict.get("type", "none"),
        resolution=verdict.get("resolution", "coexist"),
        reasoning=verdict.get("reasoning", "Debate analysis"),
        confidence=min(1.0, max(0.0, verdict.get("confidence", 0.7))),
        debate=debate_log,
    )


async def _single_call_fallback(
    f1: FactData, f2: FactData
) -> CheckContradictionResponse:
    """Fallback to single LLM call if debate fails."""
    context = _build_fact_context(f1, f2)
    result = await asyncio.to_thread(
        llm_client.generate_json,
        SINGLE_CALL_PROMPT.format(**context),
        None,
        {"task": "check_contradiction"},
    )

    return CheckContradictionResponse(
        contradicts=result.get("contradicts", False),
        type=result.get("type", "none"),
        resolution=result.get("resolution", "coexist"),
        reasoning=result.get("reasoning", "LLM analysis"),
        confidence=min(1.0, max(0.0, result.get("confidence", 0.7))),
    )


# --- Endpoint ---


@router.post("/check-contradiction", response_model=CheckContradictionResponse)
async def check_contradiction(request: CheckContradictionRequest):
    """
    Check if two facts contradict each other.

    Pipeline:
    1. Quick heuristics (antonyms, exclusive predicates, temporal overlap)
    2. LLM debate protocol for subtle/ambiguous cases
    3. Single LLM call as fallback if debate fails
    """
    f1, f2 = request.fact1, request.fact2

    # Quick check: Different subjects = no contradiction
    if f1.subject != f2.subject:
        return CheckContradictionResponse(
            contradicts=False,
            type="none",
            resolution="coexist",
            reasoning="Different subjects",
            confidence=1.0,
        )

    # Quick check: Antonym predicates
    if quick_antonym_check(f1.predicate, f2.predicate):
        if times_overlap(f1, f2):
            return CheckContradictionResponse(
                contradicts=True,
                type="antonym",
                resolution="supersede",
                reasoning=f"'{f1.predicate}' and '{f2.predicate}' are antonyms and time periods overlap",
                confidence=0.95,
            )

    # Quick check: Exclusive predicate with different objects
    if f1.predicate == f2.predicate and is_exclusive_predicate(f1.predicate):
        if f1.object != f2.object and times_overlap(f1, f2):
            return CheckContradictionResponse(
                contradicts=True,
                type="structural",
                resolution="supersede",
                reasoning=f"'{f1.predicate}' is typically exclusive - can't be both '{f1.object}' and '{f2.object}'",
                confidence=0.85,
            )

    # Subtle case: LLM debate protocol
    try:
        return await debate_contradiction(f1, f2)
    except Exception as e:
        logger.warning(f"Debate protocol failed, falling back to single call: {e}")

    # Fallback: single LLM call (legacy behavior)
    try:
        return await _single_call_fallback(f1, f2)
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Contradiction check failed: {str(e)}",
        )
