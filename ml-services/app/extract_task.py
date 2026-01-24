from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timedelta
import ollama
import json
import re

router = APIRouter()

EXTRACT_TASK_PROMPT = """Extract task details from this message. Today is {today}.

Message: "{message}"

Parse the following:
1. action: What needs to be done (verb + object)
2. due_date: When it should be done (ISO format or null if not specified)
3. priority: high, medium, or low based on urgency words

Urgency indicators:
- high: urgent, asap, critical, important, immediately
- medium: tomorrow, soon, this week (default)
- low: when you can, eventually, someday

For relative dates:
- "tomorrow" = {tomorrow}
- "next Monday" = parse to actual date
- "in 2 hours" = add to current time
- "by Friday" = that Friday at 5pm
- No date mentioned = null

Return ONLY valid JSON:
{{
  "action": "the task to do",
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


def get_date_context() -> dict:
    """Get date context for LLM prompt"""
    now = datetime.now()
    return {
        "today": now.strftime("%Y-%m-%d %A"),
        "tomorrow": (now + timedelta(days=1)).strftime("%Y-%m-%d"),
    }


def extract_json(text: str) -> dict:
    """Extract JSON from LLM response"""
    json_match = re.search(r'\{[\s\S]*\}', text)
    if json_match:
        try:
            return json.loads(json_match.group())
        except json.JSONDecodeError:
            pass
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise ValueError(f"Could not parse JSON from: {text[:200]}")


def validate_date(date_str: Optional[str]) -> Optional[str]:
    """Validate and normalize date string"""
    if not date_str:
        return None

    try:
        # Try parsing ISO format
        dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
        return dt.isoformat()
    except ValueError:
        pass

    # Common relative date patterns
    lower = date_str.lower()
    now = datetime.now()

    if 'tomorrow' in lower:
        dt = now + timedelta(days=1)
        # Default to 9am for "tomorrow"
        return dt.replace(hour=9, minute=0, second=0, microsecond=0).isoformat()

    if 'today' in lower:
        return now.replace(hour=17, minute=0, second=0, microsecond=0).isoformat()

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
    """
    try:
        # Build prompt with date context
        date_ctx = get_date_context()
        prompt = EXTRACT_TASK_PROMPT.format(
            message=request.text,
            **date_ctx
        )

        # Call Ollama
        response = ollama.generate(
            model="llama3.2:3b",
            prompt=prompt,
            options={
                "temperature": 0.1,
                "num_predict": 256,
            }
        )

        # Parse response
        result = extract_json(response['response'])

        # Validate and normalize
        action = result.get('action', request.text.strip())
        due_date = validate_date(result.get('due_date'))
        priority = validate_priority(result.get('priority', 'medium'))
        confidence = min(1.0, max(0.0, float(result.get('confidence', 0.8))))

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

        print(f"✅ Extracted task: '{action}' (priority: {priority}, due: {due_date or 'none'})")

        return ExtractTaskResponse(
            action=action,
            due_date=due_date,
            priority=priority,
            confidence=confidence,
            raw_due_text=raw_due
        )

    except Exception as e:
        # Fallback: treat entire message as action
        print(f"⚠️ Task extraction fallback: {e}")
        return ExtractTaskResponse(
            action=request.text.strip(),
            due_date=None,
            priority="medium",
            confidence=0.5,
            raw_due_text=None
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
    ]

    results = []
    for sample in samples:
        try:
            result = await extract_task(ExtractTaskRequest(text=sample))
            results.append({
                "input": sample,
                "action": result.action,
                "due_date": result.due_date,
                "priority": result.priority,
            })
        except Exception as e:
            results.append({"input": sample, "error": str(e)})

    return {"test_results": results}
