import asyncio
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import re
from .core.llm import llm_client
from .core.task_utils import get_date_context, parse_flexible_date, validate_priority

router = APIRouter()

# Quality thresholds
MIN_CONFIDENCE = 0.6
MIN_CONTENT_LENGTH = 10

EXTRACT_TASK_PROMPT = """Analyze if this is an ACTIONABLE task or should be REJECTED.

Today is {today}.

Message: "{message}"

REJECT if ANY of these apply:
- Not specific (e.g., "verify", "check out", "look at")
- Is a question (e.g., "what's the best way...", "how do I...")
- Just a URL (e.g., "https://example.com")
- Content < 10 characters
- Vague intent (e.g., "something", "stuff", "things")

If REJECTED, return ONLY:
{{
  "action": "",
  "reason": "explain why not a task"
}}

If VALID, extract the task:
1. action: Specific action (min 10 chars, verb + object)
2. due_date: ISO format or null
3. priority: high/medium/low based on urgency
4. confidence: 0.0-1.0 (how certain this is a real task)

Urgency indicators:
- high: urgent, asap, critical, important, immediately
- medium: tomorrow, soon, this week (default)
- low: when you can, eventually, someday

For relative dates:
- "today" = today at 5pm
- "tomorrow" = tomorrow at 9am
- "next [day]" = next occurrence at 9am
- "in 2 days/hours" = add to current time
- "by [day]" = that day at 5pm
- "at [time]" = that time on appropriate day

Return ONLY valid raw JSON, no markdown code fences:
{{
  "action": "specific action (min 10 chars)",
  "due_date": "2026-01-25T15:00:00" or null,
  "priority": "medium",
  "confidence": 0.9
}}"""


class ExtractTaskRequest(BaseModel):
    """Request body for task extraction"""
    text: str


class ExtractTaskResponse(BaseModel):
    """Extracted task details"""
    action: str
    due_date: Optional[str] = None
    priority: str = "medium"
    confidence: float = 0.8
    raw_due_text: Optional[str] = None  # Original date phrase
    rejection_reason: Optional[str] = None  # Why task was rejected


@router.post("/extract-task", response_model=ExtractTaskResponse)
async def extract_task(request: ExtractTaskRequest):
    """
    Extract task details from text using LLM.

    Returns structured task data with action, due date, and priority.
    Low-quality or invalid tasks will have empty action field.
    """
    try:
        # Build prompt with date context
        date_ctx = get_date_context()
        prompt = EXTRACT_TASK_PROMPT.format(
            message=request.text,
            **date_ctx
        )

        # Call LLM via shared service (offload blocking call to thread pool)
        result = await asyncio.to_thread(
            llm_client.generate_json, prompt, None, {"task": "extract_task"},
        )

        # Extract action
        action = result.get('action', '').strip()

        # Check for rejection (empty action)
        if not action or len(action) < MIN_CONTENT_LENGTH:
            rejection_reason = result.get('reason', 'Task rejected: insufficient content or not a valid task')
            print(f"⚠️ Task rejected: '{request.text[:50]}...' - {rejection_reason}")
            return ExtractTaskResponse(
                action="",
                due_date=None,
                priority="low",
                confidence=0.0,
                raw_due_text=None,
                rejection_reason=rejection_reason
            )

        # Validate and normalize other fields
        due_date = parse_flexible_date(result.get('due_date'), datetime.now())
        priority = validate_priority(result.get('priority', 'medium'))
        confidence = min(1.0, max(0.0, float(result.get('confidence', 0.8))))

        # Apply confidence threshold
        if confidence < MIN_CONFIDENCE:
            print(f"⚠️ Task blocked: low confidence ({confidence:.2f} < {MIN_CONFIDENCE})")
            return ExtractTaskResponse(
                action="",
                due_date=None,
                priority="low",
                confidence=confidence,
                raw_due_text=None,
                rejection_reason=f"Confidence too low: {confidence:.2f} < {MIN_CONFIDENCE}"
            )

        # Extract raw date phrase for display
        raw_due = None
        date_patterns = [
            r'(tomorrow|today|tonight)',
            r'(next\s+\w+day)',
            r'(in\s+\d+\s+(?:hour|day|week)s?)',
            r'(by\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))',
            r'(at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)',
        ]
        for pattern in date_patterns:
            match = re.search(pattern, request.text, re.IGNORECASE)
            if match:
                raw_due = match.group(1)
                break

        print(f"✅ Extracted task: '{action}' (priority: {priority}, due: {due_date or 'none'}, confidence: {confidence:.2f})")

        return ExtractTaskResponse(
            action=action,
            due_date=due_date,
            priority=priority,
            confidence=confidence,
            raw_due_text=raw_due,
            rejection_reason=None
        )

    except Exception as e:
        # Fallback: treat as low-quality task
        print(f"⚠️ Task extraction fallback: {e}")
        return ExtractTaskResponse(
            action="",
            due_date=None,
            priority="low",
            confidence=0.0,
            raw_due_text=None,
            rejection_reason=f"Extraction failed: {str(e)}"
        )