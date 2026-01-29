from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timedelta
import re
from .core.llm import llm_client

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

Return ONLY valid JSON:
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


def get_date_context() -> dict:
    """Get date context for LLM prompt"""
    now = datetime.now()
    return {
        "today": now.strftime("%Y-%m-%d %A"),
        "tomorrow": (now + timedelta(days=1)).strftime("%Y-%m-%d"),
    }


def parse_flexible_date(date_str: Optional[str], reference: datetime) -> Optional[str]:
    """Parse natural language dates with enhanced patterns"""
    if not date_str:
        return None

    try:
        # Try parsing ISO format first
        dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
        return dt.isoformat()
    except ValueError:
        pass

    # Common relative date patterns
    lower = date_str.lower()
    now = reference

    # "tomorrow" with optional time
    if 'tomorrow' in lower:
        dt = now + timedelta(days=1)
        # Default to 9am for "tomorrow"
        return dt.replace(hour=9, minute=0, second=0, microsecond=0).isoformat()

    # "today" with optional time
    if 'today' in lower or 'tonight' in lower:
        # Default to 5pm for "today/tonight"
        return now.replace(hour=17, minute=0, second=0, microsecond=0).isoformat()

    # "next [day]" pattern
    next_day_match = re.search(r'next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)', lower)
    if next_day_match:
        day_name = next_day_match.group(1)
        days_of_week = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
        target_day = days_of_week.index(day_name)
        current_day = now.weekday()
        days_ahead = (target_day - current_day + 7) % 7
        if days_ahead == 0:
            days_ahead = 7  # Next week, not today
        dt = now + timedelta(days=days_ahead)
        return dt.replace(hour=9, minute=0, second=0, microsecond=0).isoformat()

    # "in X [days|hours|weeks]"
    in_match = re.search(r'in\s+(\d+)\s+(hour|day|week)s?', lower)
    if in_match:
        amount = int(in_match.group(1))
        unit = in_match.group(2)
        if unit == 'hour':
            dt = now + timedelta(hours=amount)
            return dt.isoformat()
        elif unit == 'day':
            dt = now + timedelta(days=amount)
            return dt.replace(hour=9, minute=0, second=0, microsecond=0).isoformat()
        elif unit == 'week':
            dt = now + timedelta(weeks=amount)
            return dt.replace(hour=9, minute=0, second=0, microsecond=0).isoformat()

    # "by [day]" pattern
    by_match = re.search(r'by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)', lower)
    if by_match:
        day_name = by_match.group(1)
        days_of_week = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
        target_day = days_of_week.index(day_name)
        current_day = now.weekday()
        days_ahead = (target_day - current_day + 7) % 7
        dt = now + timedelta(days=days_ahead)
        return dt.replace(hour=17, minute=0, second=0, microsecond=0).isoformat()

    # "[day] at [time]" pattern
    at_time_match = re.search(r'at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?', lower)
    if at_time_match:
        hour = int(at_time_match.group(1))
        minute = int(at_time_match.group(2)) if at_time_match.group(2) else 0
        meridiem = at_time_match.group(3)

        if meridiem == 'pm' and hour < 12:
            hour += 12
        elif meridiem == 'am' and hour == 12:
            hour = 0

        dt = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        return dt.isoformat()

    return None


def validate_priority(priority: str) -> str:
    """Normalize priority value"""
    priority = priority.lower().strip()
    if priority in ('high', 'urgent', 'critical', 'important'):
        return 'high'
    if priority in ('low', 'eventually', 'someday'):
        return 'low'
    return 'medium'


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

        # Call Ollama via shared service
        result = llm_client.generate_json(
            prompt,
            options={"num_predict": 256}
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


@router.get("/extract-task/test")
async def test_task_extraction():
    """Test task extraction with sample messages"""
    samples = [
        "Remind me to call John tomorrow at 3pm",
        "I need to finish the report by Friday",
        "TODO: update the documentation",
        "Don't forget to buy groceries",
        "URGENT: fix the production bug",
        "Schedule a meeting with the team next Monday",
        # Low-quality tests (should be rejected)
        "verify",
        "check out",
        "https://example.com",
        "what's the best way to do this?",
    ]

    results = []
    for sample in samples:
        try:
            result = await extract_task(ExtractTaskRequest(text=sample))
            results.append({
                "input": sample,
                "action": result.action or "[REJECTED]",
                "due_date": result.due_date,
                "priority": result.priority,
                "confidence": result.confidence,
                "rejection_reason": result.rejection_reason,
            })
        except Exception as e:
            results.append({"input": sample, "error": str(e)})

    return {"test_results": results}
