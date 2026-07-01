# W40: Task Complexity Classifier

**Status:** 🆕 New
**Priority:** P0 (Critical)
**Estimated Time:** 45-60 minutes
**Phase:** 6 Agentic Interface
**Dependencies:** None (blocks all other agentic work)

---

## Objective

Implement a task complexity classifier that uses the LLM to analyze user requests and determine the appropriate agentic strategy (direct/multi-turn/sub-agents/adaptive) based on complexity, estimated tool count, and required human checkpoints.

---

## Prerequisites

- ✅ Z.AI GLM-4.7 LLM client exists (`ml-services/app/core/llm.py`)
- ✅ Pydantic for schema validation
- ⚠️ Need to create `ml-services/app/agents/` directory structure

---

## Implementation Steps

### Step 1: Create Agents Directory Structure (5 minutes)

**Command:**
```bash
mkdir -p ml-services/app/agents
touch ml-services/app/agents/__init__.py
```

### Step 2: Implement Classification Schema (15 minutes)

**File:** `ml-services/app/agents/classifier.py`

```python
from pydantic import BaseModel, Field
from typing import List, Literal

class TaskClassification(BaseModel):
    """Result of task complexity analysis."""

    complexity: Literal["simple", "medium", "complex", "open_ended"] = Field(
        description="How complex the task is"
    )

    strategy: Literal["direct", "multi_turn", "sub_agents", "adaptive"] = Field(
        description="Which execution strategy to use"
    )

    estimated_tools: int = Field(
        ge=0,
        le=20,
        description="Estimated number of tool calls needed"
    )

    requires_decomposition: bool = Field(
        description="Whether task needs to be broken into sub-tasks"
    )

    human_checkpoints: List[str] = Field(
        default_factory=list,
        description="When to ask for human input: ['approval_needed', 'ambiguous', 'blocked']"
    )

    reasoning: str = Field(
        description="Why this complexity level was chosen"
    )
```

### Step 3: Implement Classification Function (30 minutes)

**File:** `ml-services/app/agents/classifier.py` (continued)

```python
from ..core.llm import LLMClient

llm_client = LLMClient()

CLASSIFICATION_PROMPT = """You are a task classifier for an AI agent with access to a knowledge management system.

Analyze the user's request and classify it by complexity level.

**Context:**
- Active entities: {active_entities_count}
- Recent facts: {recent_facts_count}
- Today's tasks: {today_tasks_count}

**Complexity Levels:**

1. **simple** (1-2 tool calls):
   - Single information retrieval
   - Direct lookup in knowledge graph
   - Examples: "What do we know about X?", "Who works at Y?"

2. **medium** (3-5 tool calls):
   - Multiple information sources
   - Light synthesis needed
   - Examples: "Compare project A and B", "Summarize this week's tasks"

3. **complex** (5+ tool calls):
   - Requires task decomposition
   - Multiple sub-tasks with dependencies
   - Examples: "Analyze why the database is slow", "Research competitors"

4. **open_ended** (unknown complexity):
   - Exploratory research
   - Iterative refinement
   - Examples: "Help me understand this codebase", "What should I work on?"

**User Message:**
{user_message}

**Return JSON:**
{{
    "complexity": "simple|medium|complex|open_ended",
    "strategy": "direct|multi_turn|sub_agents|adaptive",
    "estimated_tools": <number 0-20>,
    "requires_decomposition": <boolean>,
    "human_checkpoints": ["approval_needed", "ambiguous", "blocked"],
    "reasoning": "<brief explanation>"
}}
"""

async def classify_task(
    user_message: str,
    context: dict  # CognitiveContext
) -> TaskClassification:
    """
    Classify task complexity using LLM.

    Args:
        user_message: The user's request
        context: Cognitive context with active_entities, recent_facts, today_tasks

    Returns:
        TaskClassification with strategy and metadata
    """

    # Format context for prompt
    prompt = CLASSIFICATION_PROMPT.format(
        user_message=user_message,
        active_entities_count=len(context.get("active_entities", [])),
        recent_facts_count=len(context.get("recent_facts", [])),
        today_tasks_count=len(context.get("today_tasks", []))
    )

    # Call LLM
    response = await llm_client.generate(
        prompt=prompt,
        temperature=0.1,  # Low temperature for consistent classification
        max_tokens=512
    )

    # Extract JSON from response
    import json
    import re

    # Try to find JSON in response
    json_match = re.search(r'\{[^{}]*\}', response)
    if not json_match:
        raise ValueError(f"No JSON found in LLM response: {response}")

    classification_data = json.loads(json_match.group(0))

    return TaskClassification(**classification_data)
```

### Step 4: Add Validation & Tests (15 minutes)

**File:** `ml-services/app/tests/test_classifier.py`

```python
import pytest
from agents.classifier import classify_task, TaskClassification

@pytest.mark.asyncio
async def test_classify_simple_query():
    """Simple direct lookup should be classified correctly."""
    context = {
        "active_entities": [],
        "recent_facts": [],
        "today_tasks": []
    }

    result = await classify_task("What do we know about John?", context)

    assert result.complexity == "simple"
    assert result.strategy == "direct"
    assert result.estimated_tools <= 2
    assert result.requires_decomposition is False

@pytest.mark.asyncio
async def test_classify_medium_complexity():
    """Comparison tasks should be medium complexity."""
    context = {
        "active_entities": [],
        "recent_facts": [],
        "today_tasks": []
    }

    result = await classify_task("Compare project A and project B", context)

    assert result.complexity == "medium"
    assert result.strategy == "multi_turn"
    assert 3 <= result.estimated_tools <= 5
    assert result.requires_decomposition is False

@pytest.mark.asyncio
async def test_classify_complex_task():
    """Analysis tasks should trigger sub-agent delegation."""
    context = {
        "active_entities": [{"name": "database"}],
        "recent_facts": [],
        "today_tasks": []
    }

    result = await classify_task("Analyze why the database is slow", context)

    assert result.complexity == "complex"
    assert result.strategy == "sub_agents"
    assert result.estimated_tools >= 5
    assert result.requires_decomposition is True

@pytest.mark.asyncio
async def test_classify_open_ended():
    """Exploratory requests should be open-ended."""
    context = {
        "active_entities": [],
        "recent_facts": [],
        "today_tasks": []
    }

    result = await classify_task("Help me understand this codebase", context)

    assert result.complexity == "open_ended"
    assert result.strategy == "adaptive"
    assert "human_checkpoints" in result.model_dump()
```

---

## Testing

### Manual Testing Scenarios

**Test 1: Simple Query**
```bash
# Input: "What do we know about the database project?"
# Expected: complexity=simple, strategy=direct, tools=1-2
```

**Test 2: Medium Complexity**
```bash
# Input: "Summarize my tasks for this week"
# Expected: complexity=medium, strategy=multi_turn, tools=3-5
```

**Test 3: Complex Task**
```bash
# Input: "Research and analyze the database performance issues"
# Expected: complexity=complex, strategy=sub_agents, tools=5+
```

**Test 4: Open-Ended**
```bash
# Input: "What should I focus on this week?"
# Expected: complexity=open_ended, strategy=adaptive, human_checkpoints=['ambiguous']
```

### Validation Criteria

- [ ] Classifier correctly distinguishes between 4 complexity levels
- [ ] Estimated tool count is reasonable (±2 from actual)
- [ ] Strategy selection matches complexity level
- [ ] Human checkpoints identified for complex/ambiguous tasks
- [ ] Response time < 3 seconds
- [ ] All tests pass

---

## Success Criteria

- [ ] `classify_task()` function implemented and working
- [ ] Returns valid `TaskClassification` objects
- [ ] Correctly classifies simple/medium/complex/open_ended tasks
- [ ] Reasoning field provides useful explanation
- [ ] Integration tests cover all complexity levels
- [ ] Average classification time < 2 seconds

---

## Files to Create

1. `ml-services/app/agents/__init__.py` - Empty init file
2. `ml-services/app/agents/classifier.py` - Classification logic
3. `ml-services/app/tests/test_classifier.py` - Unit tests

---

## Related Work Packets

- **W41: Agent Controller** - Uses this classifier to route tasks
- **W42: Sub-Agent System** - Activated for complex tasks
- **W43: Completion Criteria** - Uses classification for timeout estimation

---

## Notes

- **Temperature Settings:** Use low temperature (0.1-0.2) for consistent classification
- **Fallback Strategy:** If classification fails, default to "medium" with "multi_turn" strategy
- **Context Importance:** Active entities and recent facts help classifier make better decisions
- **Human Checkpoints:** Add 'ambiguous' checkpoint when classifier confidence < 0.7

**Future Enhancement:** Track classification accuracy over time and adjust prompts based on actual tool usage.

---

**Created:** 2026-01-29 (Phase 6: Agentic Cognitive Interface)
**Next:** W41: Agent Controller Implementation
