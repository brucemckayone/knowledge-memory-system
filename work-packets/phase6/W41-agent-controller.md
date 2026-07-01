# W41: Agent Controller

**Status:** 🆕 New
**Priority:** P0 (Critical)
**Estimated Time:** 2-3 hours
**Phase:** 6 Agentic Interface
**Dependencies:** W40 (Task Complexity Classifier)

---

## Objective

Implement the main Agent Controller that orchestrates agentic task execution by routing requests to appropriate strategies (direct tool call, multi-turn iteration, or sub-agent delegation) based on complexity classification.

---

## Prerequisites

- ⏳ **W40:** Task Complexity Classifier implemented
- ✅ Z.AI GLM-4.7 LLM client exists
- ✅ Pydantic for data validation
- ⚠️ Need to implement tool executor (W46) before testing end-to-end

---

## Implementation Steps

### Step 1: Define Data Models (20 minutes)

**File:** `ml-services/app/agents/controller.py`

```python
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional
from typing import Tuple

class SimpleResult(BaseModel):
    """Result from direct tool execution."""
    response: str
    strategy: str = "direct"
    tools_used: int = 0
    iterations: int = 1

class MediumResult(BaseModel):
    """Result from multi-turn execution."""
    response: str
    strategy: str = "multi_turn"
    tools_used: int
    iterations: int

class ComplexResult(BaseModel):
    """Result from sub-agent delegation."""
    response: str
    strategy: str = "sub_agents"
    sub_tasks_executed: int
    tools_used: int
    plan: Dict[str, Any]

class AgenticResponse(BaseModel):
    """Unified response from agent execution."""
    response: str
    strategy: str
    tools_used: int
    iterations: int = 1
    sub_tasks_executed: Optional[int] = None
    plan: Optional[Dict[str, Any]] = None
    execution_time_seconds: float
```

### Step 2: Implement Agent Controller Core (60 minutes)

**File:** `ml-services/app/agents/controller.py` (continued)

```python
import time
from .classifier import classify_task, TaskClassification
from .completion import CompletionCriteria

class AgentController:
    """
    Main orchestrator for agentic task execution.

    Routes requests to appropriate strategies based on complexity:
    - Simple → Direct tool call
    - Medium → Multi-turn iteration
    - Complex → Sub-agent delegation
    - Open-Ended → Adaptive with human checkpoints
    """

    def __init__(self):
        # Sub-agents initialized later (W42)
        self.research_agent = None
        self.analysis_agent = None
        self.planning_agent = None
        self.synthesis_agent = None
        self.completion_criteria = CompletionCriteria()

    async def execute(
        self,
        user_message: str,
        context: Dict[str, Any],
        conversation_id: Optional[str] = None,
        max_iterations: int = 10,
        human_in_loop: bool = True
    ) -> AgenticResponse:
        """
        Main entry point for agentic task execution.

        Args:
            user_message: The user's request
            context: Cognitive context with entities, facts, tasks
            conversation_id: Optional conversation identifier
            max_iterations: Safety limit for iterations
            human_in_loop: Whether to ask user for approval

        Returns:
            AgenticResponse with answer and execution metadata
        """

        start_time = time.time()

        # Step 1: Classify task complexity
        print(f"[Agent] Classifying task: {user_message[:50]}...")
        classification = await classify_task(user_message, context)

        print(f"[Agent] Classified as: {classification.complexity} ({classification.strategy})")

        # Step 2: Route to appropriate strategy
        if classification.complexity == "simple":
            result = await self._execute_simple(user_message, context)

        elif classification.complexity == "medium":
            result = await self._execute_medium(
                user_message,
                context,
                max_iterations
            )

        elif classification.complexity in ["complex", "open_ended"]:
            result = await self._execute_complex(
                user_message,
                context,
                classification,
                max_iterations,
                human_in_loop
            )

        else:
            raise ValueError(f"Unknown complexity: {classification.complexity}")

        # Calculate execution time
        execution_time = time.time() - start_time

        return AgenticResponse(
            response=result["response"],
            strategy=result["strategy"],
            tools_used=result.get("tools_used", 0),
            iterations=result.get("iterations", 1),
            sub_tasks_executed=result.get("sub_tasks_executed"),
            plan=result.get("plan"),
            execution_time_seconds=execution_time
        )
```

### Step 3: Implement Simple Execution Strategy (30 minutes)

**File:** `ml-services/app/agents/controller.py` (continued)

```python
    async def _execute_simple(
        self,
        message: str,
        context: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Direct tool execution for simple queries (1-2 tool calls)."""

        # Import tool registry and executor (created in W46)
        from ..tools.executor import tool_executor
        from ..tools.base import tool_registry

        # Build system prompt with context
        system_prompt = self._build_system_prompt(context)

        # Import LLM client
        from ..core.llm import llm_client

        # Single LLM call with tools
        llm_response = await llm_client.chat_with_tools(
            prompt=message,
            tools=tool_registry.to_openai_format(),
            system_prompt=system_prompt,
            tool_choice="auto"
        )

        # If no tools needed, return direct response
        if not llm_response["tool_calls"]:
            return {
                "response": llm_response["content"],
                "strategy": "direct",
                "tools_used": 0,
                "iterations": 1
            }

        # Execute tools
        tool_results = await tool_executor.execute_tool_calls(
            llm_response["tool_calls"]
        )

        # Get final response with tool results
        final = await self._synthesize_with_tool_results(
            message=message,
            system_prompt=system_prompt,
            tool_calls=llm_response["tool_calls"],
            tool_results=tool_results
        )

        return {
            "response": final,
            "strategy": "direct",
            "tools_used": len(llm_response["tool_calls"]),
            "iterations": 1
        }

    def _build_system_prompt(self, context: Dict[str, Any]) -> str:
        """Build system prompt with cognitive context."""

        prompt = "You are an intelligent cognitive assistant with access to a knowledge management system.\n\n"

        # Add recent facts
        if context.get("recent_facts"):
            prompt += "## Recent Facts (Last 7 Days)\n\n"
            for fact in context["recent_facts"][:10]:
                prompt += f"- {fact['subject']} {fact['predicate']} {fact['object']}\n"
            prompt += "\n"

        # Add active entities
        if context.get("active_entities"):
            prompt += "## Active Entities\n\n"
            for entity in context["active_entities"][:5]:
                prompt += f"- **{entity['name']}** ({entity['type']})\n"
            prompt += "\n"

        # Add today's tasks
        if context.get("today_tasks"):
            prompt += "## Today's Schedule\n\n"
            for task in context["today_tasks"][:5]:
                prompt += f"- {task['title']} (Priority: {task['priority']})\n"
            prompt += "\n"

        prompt += """When responding:
1. Use tools to retrieve accurate information
2. Reference temporal context (what was true when)
3. Be concise and direct
"""

        return prompt

    async def _synthesize_with_tool_results(
        self,
        user_message: str,
        system_prompt: str,
        tool_calls: List[Dict],
        tool_results: List[Dict]
    ) -> str:
        """Synthesize final response from tool results."""

        from ..core.llm import llm_client

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
            {"role": "assistant", "tool_calls": tool_calls}
        ]

        for result in tool_results:
            messages.append({
                "role": "tool",
                "tool_call_id": result["tool_call_id"],
                "content": result["content"]
            })

        response = await llm_client.client.chat.completions.create(
            model=llm_client.model,
            messages=messages
        )

        return response.choices[0].message.content
```

### Step 4: Implement Medium-Turn Execution Strategy (45 minutes)

**File:** `ml-services/app/agents/controller.py` (continued)

```python
    async def _execute_medium(
        self,
        message: str,
        context: Dict[str, Any],
        max_iterations: int
    ) -> Dict[str, Any]:
        """Multi-turn execution for medium complexity tasks (3-5 tool calls)."""

        from ..tools.executor import tool_executor
        from ..tools.base import tool_registry
        from ..core.llm import llm_client

        system_prompt = self._build_system_prompt(context)
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": message}
        ]

        tools_used = 0

        for iteration in range(max_iterations):
            print(f"[Agent] Multi-turn iteration {iteration + 1}/{max_iterations}")

            # LLM decides on tools
            response = await llm_client.chat_with_tools(
                prompt=message,
                tools=tool_registry.to_openai_format(),
                system_prompt=system_prompt,
                tool_choice="auto"
            )

            # If no tools called, we're done
            if not response["tool_calls"]:
                return {
                    "response": response["content"],
                    "strategy": "multi_turn",
                    "tools_used": tools_used,
                    "iterations": iteration + 1
                }

            # Execute tools
            tool_results = await tool_executor.execute_tool_calls(
                response["tool_calls"]
            )
            tools_used += len(response["tool_calls"])

            print(f"[Agent]   Executed {len(response['tool_calls'])} tools")

            # Add tool results to conversation
            messages.append({
                "role": "assistant",
                "tool_calls": response["tool_calls"]
            })
            for result in tool_results:
                messages.append({
                    "role": "tool",
                    "tool_call_id": result["tool_call_id"],
                    "content": result["content"]
                })

            # Check if we're done
            complete, reason = self.completion_criteria.is_complete(
                iteration=iteration,
                results=[],  # TODO: pass tool results as SubTaskResults
                user_feedback=None
            )

            if complete:
                print(f"[Agent]   Complete: {reason}")
                # Get final synthesis
                final_response = await llm_client.client.chat.completions.create(
                    model=llm_client.model,
                    messages=messages
                )

                return {
                    "response": final_response.choices[0].message.content,
                    "strategy": "multi_turn",
                    "tools_used": tools_used,
                    "iterations": iteration + 1
                }

        # Max iterations reached
        print(f"[Agent]   Max iterations ({max_iterations}) reached")
        final_response = await llm_client.client.chat.completions.create(
            model=llm_client.model,
            messages=messages
        )

        return {
            "response": final_response.choices[0].message.content,
            "strategy": "multi_turn",
            "tools_used": tools_used,
            "iterations": max_iterations
        }
```

### Step 5: Stub Complex Execution Strategy (15 minutes)

**File:** `ml-services/app/agents/controller.py` (continued)

```python
    async def _execute_complex(
        self,
        message: str,
        context: Dict[str, Any],
        classification: TaskClassification,
        max_iterations: int,
        human_in_loop: bool
    ) -> Dict[str, Any]:
        """Sub-agent delegation for complex tasks (5+ tool calls).

        NOTE: Full implementation in W42 (Sub-Agent System).
        This stub provides basic structure.
        """

        print(f"[Agent] Complex task - delegating to sub-agents")

        # TODO: Import sub-agents when W42 is complete
        # from .sub_agents import PlanningAgent, SynthesisAgent

        # For now, fall back to multi-turn with higher iteration limit
        print(f"[Agent]   Falling back to multi-turn (W42 not yet implemented)")

        return await self._execute_medium(
            message,
            context,
            max_iterations=max_iterations
        )
```

---

## Testing

### Unit Tests

**File:** `ml-services/app/tests/test_controller.py`

```python
import pytest
from agents.controller import AgentController

@pytest.mark.asyncio
async def test_execute_simple_task():
    """Simple direct lookup should work in one iteration."""
    controller = AgentController()

    context = {
        "active_entities": [],
        "recent_facts": [],
        "today_tasks": []
    }

    # Mock tools and LLM client
    # ... mock setup ...

    result = await controller.execute(
        user_message="What do we know about John?",
        context=context
    )

    assert result.strategy == "direct"
    assert result.iterations == 1
    assert result.execution_time_seconds < 5.0

@pytest.mark.asyncio
async def test_execute_medium_task():
    """Medium complexity should use multi-turn."""
    controller = AgentController()

    context = {
        "active_entities": [],
        "recent_facts": [],
        "today_tasks": []
    }

    # ... mock setup ...

    result = await controller.execute(
        user_message="Compare project A and B",
        context=context,
        max_iterations=5
    )

    assert result.strategy == "multi_turn"
    assert result.iterations >= 2
    assert result.execution_time_seconds < 15.0

@pytest.mark.asyncio
async def test_max_iterations_safety():
    """Should never exceed max_iterations."""
    controller = AgentController()

    # ... mock infinite tool calling scenario ...

    result = await controller.execute(
        user_message="Keep searching",
        context=context,
        max_iterations=3
    )

    assert result.iterations <= 3
```

### Manual Testing Scenarios

**Test 1: Simple Query Classification**
```bash
# Request: "What do we know about the database?"
# Expected: strategy=direct, 1 iteration, 1-2 tools
```

**Test 2: Medium Multi-Turn**
```bash
# Request: "Compare the database projects from January and February"
# Expected: strategy=multi_turn, 2-4 iterations, 3-5 tools
```

**Test 3: Max Iterations Safety**
```bash
# Request: Something that would cause infinite tool calling
# Expected: Stops at max_iterations, returns partial result
```

---

## Success Criteria

- [ ] `AgentController.execute()` implemented with all 3 strategies
- [ ] Simple tasks complete in 1 iteration
- [ ] Medium tasks use multi-turn with proper completion detection
- [ ] Complex tasks fall back to multi-turn until W42 is complete
- [ ] Max iterations safety limit enforced
- [ ] Execution time tracked and returned
- [ ] System prompt includes cognitive context
- [ ] All unit tests pass

---

## Files to Create

1. `ml-services/app/agents/controller.py` - Main controller implementation
2. `ml-services/app/tests/test_controller.py` - Unit tests

---

## Related Work Packets

- **W40:** Task Complexity Classifier - prerequisite for routing
- **W42:** Sub-Agent System - completes complex task execution
- **W43:** Completion Criteria - used for multi-turn termination
- **W46:** Tool Executor - required before integration testing

---

## Notes

- **Fallback Strategy:** If classification fails, default to medium complexity
- **Logging:** Add comprehensive logging for debugging agentic flows
- **Error Handling:** Graceful degradation if LLM calls fail
- **Metrics:** Track execution time, tool usage, iteration counts by complexity level
- **Context Injection:** System prompt must include relevant context (facts, entities, tasks)

**Future Enhancement:** Once W42 is complete, remove stub from `_execute_complex()` and implement full sub-agent delegation.

---

**Created:** 2026-01-29 (Phase 6: Agentic Cognitive Interface)
**Next:** W42: Sub-Agent System (completes complex task execution)
