from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from .core.llm import llm_client
from .core.concurrency import llm_pool, QueueFullError

router = APIRouter()

# Intent categories with descriptions and examples
INTENT_CATEGORIES = """
CATEGORIES:
- thought: A general idea, reflection, observation, or personal note. No action required.
- link: Contains a URL or references a website/article/video to save.
- task: Something requiring action. ALWAYS classify as task if contains: remind, todo, need to, don't forget, should, must, have to, going to, will do, schedule, call, email, buy, send, finish, complete, submit, review.
- question: Asking for information, seeking answers, or requesting clarification.
- search: Looking for something in existing memories/notes.
- command: A direct bot command starting with /

EXAMPLES (use these to guide classification):

Tasks (action required - primary_intent MUST be "task"):
- "remind me to call John tomorrow" → task
- "Remind me to verify the E2E-TEST tomorrow at 3pm" → task
- "need to finish the report by Friday" → task
- "TODO: review the pull request" → task
- "don't forget to buy milk" → task
- "I should email Sarah about the meeting" → task
- "schedule a dentist appointment" → task
- "have to submit the proposal" → task

Thoughts (no action, just noting - primary_intent MUST be "thought"):
- "I've been thinking about career changes" → thought
- "interesting that AI can write code now" → thought
- "feeling good about the project progress" → thought
- "the weather has been nice lately" → thought

Links (primary_intent MUST be "link"):
- "check out https://example.com" → link
- "this article is great: example.com/article" → link
- "watch this video on YouTube" → link

Questions (primary_intent MUST be "question"):
- "how does the authentication work?" → question
- "what's the best way to handle errors?" → question
- "when is the deadline?" → question

Search (primary_intent MUST be "search"):
- "find my notes about kubernetes" → search
- "what did I write about React hooks?" → search
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

Return ONLY valid JSON in this exact format. Do not wrap in markdown code fences:
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

        # Use shared LLM service (via work queue)
        result_json = await llm_pool.submit(
            llm_client.generate_json, prompt, None, {"task": "classify"},
        )

        # Validate and normalize
        classification = validate_classification(result_json)

        # Strip reasoning if not requested
        if not request.include_reasoning:
            classification.reasoning = None

        print(f"✅ Classified: '{request.text[:50]}...' -> {classification.primary_intent}")

        return classification

    except Exception as e:
        print(f"⚠️ Classification failed: {e}")
        raise HTTPException(status_code=502, detail=f"Classification LLM request failed: {str(e)}")