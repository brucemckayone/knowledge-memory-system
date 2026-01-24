from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import ollama
import json
import re

router = APIRouter()

# Intent categories with descriptions
INTENT_CATEGORIES = """
- thought: A general idea, reflection, observation, or note to remember
- link: Contains a URL or references an article/video/website to save
- task: Something to do, with or without a deadline (remind, todo, need to, don't forget)
- question: Asking for information or seeking answers
- search: Wants to find something in their memory/knowledge base
- command: A direct bot command (starts with /)
"""

CLASSIFICATION_PROMPT = """You are a message intent classifier. Analyze the following message and determine the user's intent(s).

Categories:
{categories}

Message: "{message}"

Rules:
1. A message can have multiple intents (e.g., "remind me to read this link" = task + link)
2. Assign confidence scores (0.0 to 1.0) based on how clear the intent is
3. The primary_intent is the most actionable intent
4. suggested_workflow should be: process-thought, process-link, process-task, process-question, or search

Return ONLY valid JSON in this exact format:
{{
  "intents": [
    {{"type": "thought", "confidence": 0.8}},
    {{"type": "link", "confidence": 0.3}}
  ],
  "primary_intent": "thought",
  "suggested_workflow": "process-thought",
  "reasoning": "Brief explanation"
}}"""


class ClassifyRequest(BaseModel):
    """Request body for classification"""
    text: str
    include_reasoning: bool = False


class Intent(BaseModel):
    """Single intent with confidence"""
    type: str
    confidence: float


class ClassifyResponse(BaseModel):
    """Classification result"""
    intents: List[Intent]
    primary_intent: str
    suggested_workflow: str
    reasoning: Optional[str] = None


def extract_json(text: str) -> dict:
    """Extract JSON from LLM response"""
    # Try to find JSON in the response
    json_match = re.search(r'\{[\s\S]*\}', text)
    if json_match:
        try:
            return json.loads(json_match.group())
        except json.JSONDecodeError:
            pass

    # Fallback: try the whole response
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise ValueError(f"Could not parse JSON from: {text[:200]}")


def validate_classification(data: dict) -> ClassifyResponse:
    """Validate and normalize classification result"""
    valid_intents = {'thought', 'link', 'task', 'question', 'search', 'command'}
    valid_workflows = {
        'process-thought', 'process-link', 'process-task',
        'process-question', 'search'
    }

    # Validate intents
    intents = []
    for intent in data.get('intents', []):
        if intent.get('type') in valid_intents:
            intents.append(Intent(
                type=intent['type'],
                confidence=min(1.0, max(0.0, float(intent.get('confidence', 0.5))))
            ))

    # Fallback if no valid intents
    if not intents:
        intents = [Intent(type='thought', confidence=0.5)]

    # Sort by confidence
    intents.sort(key=lambda x: x.confidence, reverse=True)

    # Determine primary intent
    primary = data.get('primary_intent', intents[0].type)
    if primary not in valid_intents:
        primary = intents[0].type

    # Determine workflow
    workflow = data.get('suggested_workflow', f'process-{primary}')
    if workflow not in valid_workflows:
        workflow = f'process-{primary}' if primary != 'search' else 'search'

    return ClassifyResponse(
        intents=intents,
        primary_intent=primary,
        suggested_workflow=workflow,
        reasoning=data.get('reasoning')
    )


@router.post("/classify", response_model=ClassifyResponse)
async def classify_message(request: ClassifyRequest):
    """
    Classify message intent using LLM.

    Uses llama3.2:3b for fast classification (~1s latency).
    Returns structured intent data with confidence scores.
    """
    try:
        # Build prompt
        prompt = CLASSIFICATION_PROMPT.format(
            categories=INTENT_CATEGORIES,
            message=request.text
        )

        # Call Ollama
        response = ollama.generate(
            model="llama3.2:3b",
            prompt=prompt,
            options={
                "temperature": 0.1,  # Low temperature for consistency
                "num_predict": 256,  # Limit output
            }
        )

        # Parse response
        result_text = response['response']
        result_json = extract_json(result_text)

        # Validate and normalize
        classification = validate_classification(result_json)

        # Strip reasoning if not requested
        if not request.include_reasoning:
            classification.reasoning = None

        print(f"✅ Classified: '{request.text[:50]}...' -> {classification.primary_intent}")

        return classification

    except ollama.ResponseError as e:
        raise HTTPException(
            status_code=503,
            detail=f"LLM service unavailable: {str(e)}"
        )
    except ValueError as e:
        # JSON parsing failed, return safe default
        print(f"⚠️ Classification parsing failed: {e}")
        return ClassifyResponse(
            intents=[Intent(type='thought', confidence=0.5)],
            primary_intent='thought',
            suggested_workflow='process-thought',
            reasoning="Classification parsing failed, defaulting to thought"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Classification failed: {str(e)}"
        )


@router.get("/classify/test")
async def test_classification():
    """Test classification with sample messages"""
    samples = [
        "I've been thinking about how to improve the onboarding flow",
        "Check out this article https://example.com/article",
        "Remind me to call John tomorrow at 3pm",
        "How does the authentication system work?",
        "Find my notes about Kubernetes",
    ]

    results = []
    for sample in samples:
        try:
            result = await classify_message(ClassifyRequest(text=sample, include_reasoning=True))
            results.append({
                "message": sample,
                "primary": result.primary_intent,
                "workflow": result.suggested_workflow,
                "intents": [{"type": i.type, "confidence": i.confidence} for i in result.intents]
            })
        except Exception as e:
            results.append({
                "message": sample,
                "error": str(e)
            })

    return {"test_results": results}
