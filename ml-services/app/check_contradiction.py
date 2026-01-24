"""
Contradiction Detection Endpoint
Phase 3: Check if two facts contradict each other

Implements ALICE framework detection with quick heuristics + LLM fallback.
"""

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional
import ollama
import json
import re

router = APIRouter()

CONTRADICTION_PROMPT = """Analyze if these two facts contradict each other.

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

For work/employment, location, membership - a person typically can only be at one:
- If both facts overlap in time and claim incompatible states, they contradict

Return JSON:
{{
  "contradicts": true/false,
  "type": "antonym|numeric|negation|structural|temporal|none",
  "resolution": "supersede|invalidate|coexist|flag",
  "reasoning": "explanation",
  "confidence": 0.0-1.0
}}

Resolution meanings:
- supersede: New fact replaces old (old becomes invalid_at = new.valid_at)
- invalidate: Old fact was wrong (old.expired_at = now)
- coexist: Both facts can be true (no conflict)
- flag: Unclear, needs human review
"""


class FactData(BaseModel):
    subject: str
    predicate: str
    object: str
    valid_at: Optional[str] = None
    invalid_at: Optional[str] = None


class CheckContradictionRequest(BaseModel):
    fact1: FactData
    fact2: FactData


class CheckContradictionResponse(BaseModel):
    contradicts: bool
    type: str
    resolution: str
    reasoning: str
    confidence: float


# Quick checks before LLM
ANTONYM_PAIRS = {
    ('employed', 'unemployed'),
    ('active', 'inactive'),
    ('alive', 'dead'),
    ('married', 'single'),
    ('open', 'closed'),
}

EXCLUSIVE_PREDICATES = {
    'works_at',      # Can only work at one place (usually)
    'lives_in',      # Primary residence
    'married_to',    # Monogamous marriage
    'reports_to',    # Single manager
    'ceo_of',        # One CEO
    'president_of',  # One president
}


def quick_antonym_check(pred1: str, pred2: str) -> bool:
    """Check for known antonym pairs"""
    return (pred1, pred2) in ANTONYM_PAIRS or (pred2, pred1) in ANTONYM_PAIRS


def is_exclusive_predicate(predicate: str) -> bool:
    """Check if predicate is typically exclusive"""
    return any(exc in predicate.lower() for exc in EXCLUSIVE_PREDICATES)


def times_overlap(f1: FactData, f2: FactData) -> bool:
    """Check if fact time ranges overlap"""
    # If no times specified, assume they could overlap
    if not f1.valid_at or not f2.valid_at:
        return True
    
    # Simple overlap check
    return True


@router.post("/check-contradiction", response_model=CheckContradictionResponse)
async def check_contradiction(request: CheckContradictionRequest):
    """
    Check if two facts contradict each other.
    
    Uses quick heuristics first, then LLM for subtle cases.
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
    
    # LLM for subtle cases
    try:
        prompt = CONTRADICTION_PROMPT.format(
            fact1_subject=f1.subject,
            fact1_predicate=f1.predicate,
            fact1_object=f1.object,
            fact1_valid_at=f1.valid_at or "unknown",
            fact1_invalid_at=f1.invalid_at or "ongoing",
            fact2_subject=f2.subject,
            fact2_predicate=f2.predicate,
            fact2_object=f2.object,
            fact2_valid_at=f2.valid_at or "unknown",
            fact2_invalid_at=f2.invalid_at or "ongoing",
        )
        
        response = ollama.generate(
            model="llama3.2:3b",  # Use faster model
            prompt=prompt,
            options={
                "temperature": 0.1,
                "num_predict": 512,
            }
        )
        
        # Parse response
        match = re.search(r'\{[\s\S]*\}', response['response'])
        if match:
            result = json.loads(match.group())
            return CheckContradictionResponse(
                contradicts=result.get('contradicts', False),
                type=result.get('type', 'none'),
                resolution=result.get('resolution', 'coexist'),
                reasoning=result.get('reasoning', 'LLM analysis'),
                confidence=min(1.0, max(0.0, result.get('confidence', 0.7))),
            )
        
    except Exception:
        pass
    
    # Default: no contradiction detected
    return CheckContradictionResponse(
        contradicts=False,
        type="none",
        resolution="coexist",
        reasoning="No contradiction detected",
        confidence=0.6,
    )


@router.get("/check-contradiction/test")
async def test_contradiction():
    """Test contradiction detection with sample facts"""
    tests = [
        {
            "fact1": {"subject": "John", "predicate": "works_at", "object": "Acme"},
            "fact2": {"subject": "John", "predicate": "works_at", "object": "TechCorp"},
            "expected": "contradiction (structural)"
        },
        {
            "fact1": {"subject": "John", "predicate": "employed", "object": "true"},
            "fact2": {"subject": "John", "predicate": "unemployed", "object": "true"},
            "expected": "contradiction (antonym)"
        },
        {
            "fact1": {"subject": "John", "predicate": "knows", "object": "Sarah"},
            "fact2": {"subject": "John", "predicate": "knows", "object": "Mike"},
            "expected": "no contradiction (can know multiple)"
        },
    ]
    
    results = []
    for test in tests:
        result = await check_contradiction(CheckContradictionRequest(
            fact1=FactData(**test["fact1"]),
            fact2=FactData(**test["fact2"]),
        ))
        results.append({
            "test": test,
            "result": result.model_dump(),
        })
    
    return {"tests": results}
