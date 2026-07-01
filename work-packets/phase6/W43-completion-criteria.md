# W43: Completion Criteria

**Status:** 🆕 New
**Priority:** P1 (High)
**Estimated Time:** 30-45 minutes
**Phase:** 6 Agentic Interface
**Dependencies:** W42 (Sub-Agent System)

---

## Objective

Implement completion criteria logic that determines when agentic tasks are complete, preventing infinite loops while ensuring comprehensive responses. Handles multiple termination signals including max iterations, user confirmation, sub-task completion, blockers, and user feedback.

---

## Prerequisites

- ⏳ **W42:** Sub-Agent System (for testing)
- ✅ Pydantic for data models

---

## Implementation Steps

### Step 1: Define Completion Criteria Data Model (10 minutes)

**File:** `ml-services/app/agents/completion.py`

```python
from pydantic import BaseModel, Field
from typing import List, Tuple, Optional, Literal

class CompletionReason(BaseModel):
    """Reason why task is complete or should continue."""
    is_complete: bool
    reason: str
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)

class CompletionCriteria:
    """
    Determines when agentic tasks are complete.

    Multiple termination signals:
    - Safety: Max iterations reached
    - User: Confirmed completion or requested continuation
    - Task: All sub-tasks completed
    - Blocking: Cannot proceed further
    - Information: Waiting for user input
    """

    def is_complete(
        self,
        iteration: int,
        max_iterations: int,
        results: List[Any],  # SubTaskResult or similar
        user_feedback: Optional[str],
        tool_calls_made: int = 0
    ) -> CompletionReason:
        """
        Check if agentic task is complete.

        Returns:
            CompletionReason with is_complete, reason, and confidence
        """

        # Priority 1: Safety - Max iterations
        if iteration >= max_iterations:
            return CompletionReason(
                is_complete=True,
                reason="maximum_iterations",
                confidence=1.0
            )

        # Priority 2: User confirmed completion
        if user_feedback:
            feedback_lower = user_feedback.lower().strip()

            # Completion signals
            completion_keywords = [
                "done", "complete", "enough", "good", "thanks",
                "that's all", "perfect", "great", "got it"
            ]

            if any(keyword in feedback_lower for keyword in completion_keywords):
                return CompletionReason(
                    is_complete=True,
                    reason=f"user_confirmed: '{user_feedback}'",
                    confidence=0.95
                )

            # Continuation signals
            continuation_keywords = [
                "more", "continue", "keep going", "go on",
                "what else", "keep at it", "don't stop"
            ]

            if any(keyword in feedback_lower for keyword in continuation_keywords):
                return CompletionReason(
                    is_complete=False,
                    reason=f"user_requested_continue: '{user_feedback}'",
                    confidence=0.90
                )

        # Priority 3: Task completion (for sub-tasks)
        if results:
            # All sub-tasks completed successfully
            if all(r.status == "complete" for r in results):
                return CompletionReason(
                    is_complete=True,
                    reason=f"all_subtasks_complete: {len(results)} sub-tasks",
                    confidence=0.95
                )

            # All sub-tasks blocked or failed
            if all(r.status in ["blocked", "failed"] for r in results):
                return CompletionReason(
                    is_complete=True,
                    reason=f"all_blocked_or_failed: {len(results)} sub-tasks",
                    confidence=0.90
                )

            # Some blocked, but some succeeded - partial success
            blocked_count = sum(1 for r in results if r.status == "blocked")
            complete_count = sum(1 for r in results if r.status == "complete")

            if blocked_count > 0 and complete_count > 0:
                # Continue with unblocked tasks if more iterations available
                if iteration < max_iterations - 1:
                    return CompletionReason(
                        is_complete=False,
                        reason=f"partial_success: {complete_count} complete, {blocked_count} blocked",
                        confidence=0.70
                    )
                else:
                    # Last iteration, return what we have
                    return CompletionReason(
                        is_complete=True,
                        reason=f"partial_success_final: {complete_count} complete, {blocked_count} blocked",
                        confidence=0.60
                    )

            # Needs information
            needs_info_count = sum(1 for r in results if r.status == "needs_info")
            if needs_info_count > 0:
                return CompletionReason(
                    is_complete=True,
                    reason=f"awaiting_user_input: {needs_info_count} sub-tasks need info",
                    confidence=1.0
                )

        # Priority 4: No tool calls made (probably shouldn't happen)
        if iteration > 0 and tool_calls_made == 0:
            # LLM didn't call any tools, might be done
            return CompletionReason(
                is_complete=True,
                reason="no_tools_used_in_iteration",
                confidence=0.50
            )

        # Default: Continue execution
        return CompletionReason(
            is_complete=False,
            reason=f"in_progress: iteration {iteration} of {max_iterations}",
            confidence=1.0
        )
```

### Step 2: Add Helper Methods (20 minutes)

**File:** `ml-services/app/agents/completion.py` (continued)

```python
class CompletionCriteria:
    # ... previous methods ...

    def should_request_approval(
        self,
        sub_task_type: str,
        human_checkpoints: List[str],
        iteration: int
    ) -> bool:
        """
        Determine if sub-task requires user approval.

        Args:
            sub_task_type: Type of sub-task
            human_checkpoints: Checkpoints from classification
            iteration: Current iteration number

        Returns:
            True if approval should be requested
        """

        # Require approval for significant actions
        approval_triggers = {
            "approval_needed": True,
            "ambiguous": True,
            "blocked": False,  # Already blocked, no need to ask
        }

        return any(
            checkpoint in human_checkpoints
            for checkpoint in approval_triggers.keys()
        )

    def suggest_iteration_limit(
        self,
        complexity: str,
        estimated_tools: int
    ) -> int:
        """
        Suggest appropriate max iterations based on task complexity.

        Args:
            complexity: Task complexity level
            estimated_tools: Estimated tool count

        Returns:
            Recommended max iterations
        """

        # Simple tasks should complete quickly
        if complexity == "simple":
            return 3

        # Medium tasks get more iterations
        if complexity == "medium":
            return max(5, estimated_tools + 2)

        # Complex tasks get even more
        if complexity == "complex":
            return max(10, estimated_tools + 3)

        # Open-ended tasks get most
        if complexity == "open_ended":
            return 15

        return 10  # Default
```

---

## Testing

### Unit Tests

**File:** `ml-services/app/tests/test_completion.py`

```python
import pytest
from agents.completion import CompletionCriteria, CompletionReason

@pytest.fixture
def criteria():
    return CompletionCriteria()

class MockSubTaskResult:
    def __init__(self, status):
        self.status = status

def test_max_iterations_safety(criteria):
    """Should never exceed max iterations."""
    # Iteration 10 of 10 max
    result = criteria.is_complete(
        iteration=10,
        max_iterations=10,
        results=[],
        user_feedback=None
    )

    assert result.is_complete is True
    assert "maximum_iterations" in result.reason

def test_user_confirmed_completion(criteria):
    """User saying 'done' should complete task."""
    result = criteria.is_complete(
        iteration=5,
        max_iterations=10,
        results=[],
        user_feedback="That's perfect, thanks!"
    )

    assert result.is_complete is True
    assert "user_confirmed" in result.reason
    assert result.confidence >= 0.90

def test_user_requested_continue(criteria):
    """User saying 'continue' should not complete task."""
    result = criteria.is_complete(
        iteration=5,
        max_iterations=10,
        results=[],
        user_feedback="Keep going, find more"
    )

    assert result.is_complete is False
    assert "user_requested_continue" in result.reason

def test_all_subtasks_complete(criteria):
    """All sub-tasks done should complete task."""
    results = [
        MockSubTaskResult("complete"),
        MockSubTaskResult("complete"),
        MockSubTaskResult("complete")
    ]

    result = criteria.is_complete(
        iteration=5,
        max_iterations=10,
        results=results,
        user_feedback=None
    )

    assert result.is_complete is True
    assert "all_subtasks_complete" in result.reason

def test_all_blocked(criteria):
    """All sub-tasks blocked should complete task."""
    results = [
        MockSubTaskResult("blocked"),
        MockSubTaskResult("blocked")
    ]

    result = criteria.is_complete(
        iteration=5,
        max_iterations=10,
        results=results,
        user_feedback=None
    )

    assert result.is_complete is True
    assert "all_blocked_or_failed" in result.reason
```

---

## Success Criteria

- [ ] `CompletionCriteria.is_complete()` implemented with all termination signals
- [ ] Priority order correct (safety → user → task → default)
- [ ] Max iterations safety limit enforced
- [ ] User feedback parsing handles variations ("done", "complete", "continue")
- [ ] Sub-task status checking works correctly
- [ ] Partial success logic allows continuation
- [ ] All unit tests pass

---

## Files to Create

1. `ml-services/app/agents/completion.py` - Completion criteria implementation
2. `ml-services/app/tests/test_completion.py` - Unit tests

---

## Related Work Packets

- **W41:** Agent Controller - uses completion criteria
- **W42:** Sub-Agent System - provides results to check
- **W40:** Task Complexity Classifier - suggests iteration limits

---

## Notes

- **Priority Order:** Safety → User → Task → Default ensures proper handling
- **Confidence Levels:** Use confidence to indicate how certain we are about completion
- **User Feedback:** Must handle various ways users express completion/continuation
- **Sub-task Status:** Status values: "complete", "blocked", "failed", "needs_info"

**Future Enhancements:**
- Adaptive iteration limits based on task type
- Learn from user feedback patterns
- Confidence scoring based on result quality

---

**Created:** 2026-01-29 (Phase 6: Agentic Cognitive Interface)
**Next:** W44: Tool Base & Registry
