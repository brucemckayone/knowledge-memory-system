"""
Predicate Comparison Endpoint
Compare two knowledge graph predicates to determine if they should be merged.
Used by the ontology evolution agent.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from .core.llm import llm_client
import json
import logging

logger = logging.getLogger(__name__)

router = APIRouter()


class PredicateCompareRequest(BaseModel):
    predicate_a: str
    description_a: str
    predicate_b: str
    description_b: str
    context_examples: Optional[List[str]] = None


class PredicateCompareResponse(BaseModel):
    decision: str  # "merge", "keep_separate", "defer"
    reasoning: str
    confidence: float


COMPARE_PROMPT = """You are evaluating predicates for a knowledge graph ontology.

MERGE when two predicates are genuine synonyms — same meaning, same directionality, interchangeable in any context:
- "works_at" and "employed_at" → MERGE (same employment relationship, same direction)
- "manages" and "supervises" → MERGE (same authority relationship)
- "created" and "authored" → MERGE (both mean the subject produced the object)
- "skilled_in" and "expert_in" → MERGE (both mean competence — degree differences are not predicate-level distinctions)

KEEP SEPARATE when predicates differ in direction, domain, or fundamental meaning:
- "works_at" vs "employs" → SEPARATE (inverse direction)
- "parent_of" vs "child_of" → SEPARATE (inverse direction)
- "knows" vs "knows_about" → SEPARATE (different domain: person↔person vs person↔topic)

KEEP SEPARATE (REJECT) noise predicates with hedging qualifiers:
- "sort_of_works_at" vs "works_at" → KEEP SEPARATE (hedging prefix = noise, not a valid ontology predicate)
- "basically_knows" vs "knows" → KEEP SEPARATE (hedging prefix = noise)
- Any predicate with prefixes like "sort_of_", "basically_", "kind_of_", "maybe_" is NOISE and must be kept separate.

Key principle: ontology predicates must be CLEAN and CANONICAL. Hedging qualifiers disqualify a predicate from being merged — always keep separate.

Now evaluate:
Predicate A: '{predicate_a}' — {description_a}
Predicate B: '{predicate_b}' — {description_b}

Respond with JSON only:
{{"decision": "merge" or "keep_separate" or "defer", "reasoning": "one sentence", "confidence": 0.0-1.0}}"""


@router.post("/compare-predicates", response_model=PredicateCompareResponse)
async def compare_predicates(request: PredicateCompareRequest):
    """Compare two predicates to determine if they should be merged."""
    try:
        prompt = COMPARE_PROMPT.format(
            predicate_a=request.predicate_a,
            description_a=request.description_a,
            predicate_b=request.predicate_b,
            description_b=request.description_b,
        )

        result = llm_client.generate_json(
            prompt,
            options={"task": "ontology"},  # Use ontology task defaults (Sonnet — Haiku scored 40% on synonym approval)
        )

        decision = result.get("decision", "defer")
        reasoning = result.get("reasoning", "No reasoning provided")
        confidence = float(result.get("confidence", 0.5))

        # Validate decision
        if decision not in ("merge", "keep_separate", "defer"):
            decision = "defer"

        logger.info(f"Compared '{request.predicate_a}' vs '{request.predicate_b}': {decision}")

        return PredicateCompareResponse(
            decision=decision,
            reasoning=reasoning,
            confidence=confidence,
        )

    except Exception as e:
        logger.error(f"Predicate comparison failed: {e}")
        raise HTTPException(status_code=502, detail=f"Predicate comparison failed: {str(e)}")
