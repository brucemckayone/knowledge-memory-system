"""
Enhanced Task Extraction Endpoint

Supports task decomposition, dependency extraction, effort estimation,
and conflict detection using capable LLM.

Phase 5: Task Processing Pipeline Enhancements
"""

import asyncio
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta
from .core.llm import llm_client
from .core.task_utils import get_date_context, parse_flexible_date, validate_priority
import os
import re

router = APIRouter()

# Quality thresholds (same as basic extraction)
MIN_CONFIDENCE = 0.6
MIN_CONTENT_LENGTH = 10

# ================================================================
# Request/Response Models
# ================================================================

class Subtask(BaseModel):
    action: str
    estimated_duration_minutes: Optional[int] = None
    priority: Optional[str] = None
    dependencies: List[str] = Field(default_factory=list)


class ExtractedDependency(BaseModel):
    type: str
    reference: str
    confidence: float


class DetectedConflict(BaseModel):
    type: str
    description: str
    severity: str


class ExtractTaskEnhancedRequest(BaseModel):
    text: str
    context_messages: Optional[List[str]] = None
    existing_tasks: Optional[List[Dict[str, Any]]] = None
    user_preferences: Optional[Dict[str, Any]] = None
    include_reasoning: bool = False


class ExtractTaskEnhancedResponse(BaseModel):
    # Basic extraction (backward compatible)
    action: str
    due_date: Optional[str]
    priority: str
    confidence: float
    raw_due_text: Optional[str]
    rejection_reason: Optional[str]

    # Enhanced fields
    is_composite: bool = False
    subtasks: List[Subtask] = Field(default_factory=list)
    estimated_duration_minutes: Optional[int] = None
    duration_confidence: Optional[float] = None
    dependencies: List[ExtractedDependency] = Field(default_factory=list)
    detected_conflicts: List[DetectedConflict] = Field(default_factory=list)
    suggestions: List[str] = Field(default_factory=list)
    reasoning: Optional[str] = None


# ================================================================
# Prompt Templates
# ================================================================

ENHANCED_TASK_EXTRACTION_PROMPT = """You are an expert task analyst. Extract and enhance task information from the user's message.

USER MESSAGE: "{message}"

{context_section}

{existing_tasks_section}

{preferences_section}

ANALYZE and return JSON with:

{{
  "action": "clean, actionable task description",
  "due_date": "ISO date or null",
  "priority": "high|medium|low",
  "confidence": 0.0-1.0,
  "raw_due_text": "original text mentioning deadline or null",
  "is_composite": true if this can be broken into subtasks,
  "subtasks": [
    {{
      "action": "specific subtask action",
      "estimated_duration_minutes": integer,
      "priority": "high|medium|low",
      "dependencies": ["subtask this depends on (by action text)"]
    }}
  ],
  "estimated_duration_minutes": total minutes for all subtasks or single task,
  "duration_confidence": 0.0-1.0,
  "dependencies": [
    {{
      "type": "blocking|prerequisite|related",
      "reference": "text reference to existing task or description",
      "confidence": 0.0-1.0
    }}
  ],
  "detected_conflicts": [
    {{
      "type": "temporal|resource|priority|logical",
      "description": "human-readable conflict description",
      "severity": "low|medium|high|critical"
    }}
  ],
  "suggestions": ["improvement suggestion 1", "suggestion 2"],
  "reasoning": "brief explanation of your analysis"
}}

QUALITY CRITERIA:
- Only return subtasks if the task is genuinely complex (multi-step, multi-day, or involving multiple people)
- Estimate duration realistically based on the task type (simple: 15-30min, medium: 1-2h, complex: 4-8h)
- Detect dependencies only when clearly implied by language like "after", "once", "depends on"
- Flag conflicts only when they're genuine blockers (same time, competing resources)
- rejection_reason should be null for valid tasks

Urgency indicators:
- high: urgent, asap, critical, important, immediately, today
- medium: tomorrow, soon, this week, next week (default)
- low: when you can, eventually, someday, later

For relative dates (today is {today}):
- "today" = today at 5pm
- "tomorrow" = tomorrow at 9am
- "next [day]" = next occurrence at 9am
- "in 2 days/hours" = add to current time
- "by [day]" = that day at 5pm
- "at [time]" = that time on appropriate day

Respond ONLY with valid JSON."""


def normalize_dependency_type(dep_type: str) -> str:
    """Normalize dependency type"""
    dep_type = dep_type.lower().strip()
    if dep_type in ('blocking', 'block', 'must_complete', 'hard'):
        return 'blocking'
    if dep_type in ('prerequisite', 'prereq', 'soft', 'should_complete'):
        return 'prerequisite'
    return 'related'


def normalize_conflict_type(conflict_type: str) -> str:
    """Normalize conflict type"""
    conflict_type = conflict_type.lower().strip()
    if conflict_type in ('temporal', 'time', 'schedule', 'overlap'):
        return 'temporal'
    if conflict_type in ('resource', 'same_resource'):
        return 'resource'
    if conflict_type in ('priority', 'competing'):
        return 'priority'
    return 'logical'


def normalize_severity(severity: str) -> str:
    """Normalize severity value"""
    severity = severity.lower().strip()
    if severity in ('critical', 'urgent', 'blocking'):
        return 'critical'
    if severity in ('high', 'important'):
        return 'high'
    if severity in ('low', 'minor'):
        return 'low'
    return 'medium'


# ================================================================
# Endpoint Implementation
# ================================================================

@router.post("/extract-task-enhanced", response_model=ExtractTaskEnhancedResponse)
async def extract_task_enhanced(request: ExtractTaskEnhancedRequest):
    """
    Enhanced task extraction with decomposition and intelligence.

    Features:
    - Task decomposition into subtasks for complex work
    - Dependency detection between tasks
    - Effort estimation in minutes
    - Conflict detection for temporal/priority issues
    - Suggestions for task improvement
    """
    try:
        # Build context sections
        context_section = ""
        if request.context_messages:
            context_section = "RECENT CONVERSATION:\n" + "\n".join([
                f"- {msg}" for msg in request.context_messages[-5:]
            ])

        existing_tasks_section = ""
        if request.existing_tasks:
            tasks_list = "\n".join([
                f"- {t.get('content', '')}" for t in request.existing_tasks[:10]
            ])
            existing_tasks_section = f"EXISTING TASKS IN CONTEXT:\n{tasks_list}"

        preferences_section = ""
        if request.user_preferences:
            prefs = []
            for key, value in request.user_preferences.items():
                if isinstance(value, dict) and 'value' in value:
                    prefs.append(f"- {key}: {value['value']}")
                else:
                    prefs.append(f"- {key}: {value}")
            preferences_section = f"LEARNED USER PREFERENCES:\n" + "\n".join(prefs)

        # Build prompt
        date_ctx = get_date_context()
        prompt = ENHANCED_TASK_EXTRACTION_PROMPT.format(
            message=request.text,
            context_section=context_section,
            existing_tasks_section=existing_tasks_section,
            preferences_section=preferences_section,
            today=date_ctx["today"]
        )

        # Call LLM with enhanced model (offload blocking call to thread pool)
        result = await asyncio.to_thread(
            llm_client.generate_json, prompt, None, {"task": "extract_task_enhanced"},
        )

        # Extract action
        action = result.get('action', '').strip()

        # Check for rejection (empty action or too short)
        if not action or len(action) < MIN_CONTENT_LENGTH:
            rejection_reason = result.get('reason', result.get('rejection_reason', 'Task rejected: insufficient content or not a valid task'))
            print(f"⚠️ Enhanced task rejected: '{request.text[:50]}...' - {rejection_reason}")
            return ExtractTaskEnhancedResponse(
                action="",
                due_date=None,
                priority="low",
                confidence=0.0,
                raw_due_text=None,
                rejection_reason=rejection_reason
            )

        # Validate and normalize fields
        due_date = parse_flexible_date(result.get('due_date'), datetime.now())
        priority = validate_priority(result.get('priority', 'medium'))
        confidence = min(1.0, max(0.0, float(result.get('confidence', 0.8))))

        # Apply confidence threshold
        if confidence < MIN_CONFIDENCE:
            print(f"⚠️ Enhanced task blocked: low confidence ({confidence:.2f} < {MIN_CONFIDENCE})")
            return ExtractTaskEnhancedResponse(
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

        # Process subtasks
        subtasks = []
        for st in result.get('subtasks', []):
            subtasks.append(Subtask(
                action=st.get('action', ''),
                estimated_duration_minutes=st.get('estimated_duration_minutes'),
                priority=st.get('priority') or priority,
                dependencies=st.get('dependencies', [])
            ))

        # Process dependencies
        dependencies = []
        for dep in result.get('dependencies', []):
            dependencies.append(ExtractedDependency(
                type=normalize_dependency_type(dep.get('type', 'related')),
                reference=dep.get('reference', ''),
                confidence=float(dep.get('confidence', 0.8))
            ))

        # Process conflicts
        detected_conflicts = []
        for conflict in result.get('detected_conflicts', []):
            detected_conflicts.append(DetectedConflict(
                type=normalize_conflict_type(conflict.get('type', 'logical')),
                description=conflict.get('description', ''),
                severity=normalize_severity(conflict.get('severity', 'medium'))
            ))

        # Extract suggestions
        suggestions = result.get('suggestions', [])

        print(f"✅ Enhanced extracted task: '{action}' (composite: {result.get('is_composite', False)}, priority: {priority}, due: {due_date or 'none'}, confidence: {confidence:.2f})")

        return ExtractTaskEnhancedResponse(
            action=action,
            due_date=due_date,
            priority=priority,
            confidence=confidence,
            raw_due_text=raw_due,
            rejection_reason=None,
            is_composite=result.get('is_composite', False),
            subtasks=subtasks,
            estimated_duration_minutes=result.get('estimated_duration_minutes'),
            duration_confidence=result.get('duration_confidence'),
            dependencies=dependencies,
            detected_conflicts=detected_conflicts,
            suggestions=suggestions,
            reasoning=result.get('reasoning') if request.include_reasoning else None
        )

    except ValueError as e:
        # JSON parsing failed - treat as low-quality task
        print(f"⚠️ Enhanced task extraction JSON error: {e}")
        return ExtractTaskEnhancedResponse(
            action="",
            due_date=None,
            priority="low",
            confidence=0.0,
            raw_due_text=None,
            rejection_reason=f"Extraction failed: {str(e)}"
        )
    except Exception as e:
        # Fallback: treat as low-quality task
        print(f"⚠️ Enhanced task extraction fallback: {e}")
        return ExtractTaskEnhancedResponse(
            action="",
            due_date=None,
            priority="low",
            confidence=0.0,
            raw_due_text=None,
            rejection_reason=f"Extraction failed: {str(e)}"
        )