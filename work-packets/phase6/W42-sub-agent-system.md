# W42: Sub-Agent System

**Status:** 🆕 New
**Priority:** P0 (Critical)
**Estimated Time:** 3-4 hours
**Phase:** 6 Agentic Interface
**Dependencies:** W40 (Task Complexity Classifier), W43 (Completion Criteria)

---

## Objective

Implement specialized sub-agents (Research, Analysis, Planning, Synthesis) that use the same GLM-4.7 model with different system prompts to handle complex tasks through delegation and coordination.

---

## Prerequisites

- ⏳ **W40:** Task Complexity Classifier
- ⏳ **W43:** Completion Criteria
- ✅ Z.AI GLM-4.7 LLM client
- ✅ Pydantic for data models
- ⚠️ Tool system must be functional (W44-W46)

---

## Implementation Steps

### Step 1: Define Sub-Task Data Models (15 minutes)

**File:** `ml-services/app/agents/sub_agents.py`

```python
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional

class SubTask(BaseModel):
    """A sub-task in an execution plan."""
    id: str
    type: Literal["research", "analysis", "planning", "synthesis"]
    description: str
    expected_outcome: str
    tools_needed: List[str]
    estimated_duration: str  # "2-5 minutes"
    dependencies: List[str] = Field(default_factory=list)

class ExecutionPlan(BaseModel):
    """Plan for executing a complex task with sub-tasks."""
    original_request: str
    sub_tasks: List[SubTask]
    estimated_total_duration: str
    requires_human_input: bool
    strategy_used: str  # From TaskClassification

class SubTaskResult(BaseModel):
    """Result from executing a sub-task."""
    sub_task_id: str
    status: Literal["complete", "blocked", "failed", "needs_info"]
    findings: Dict[str, Any]
    tools_used: int
    blocker: Optional[str] = None
    execution_time_seconds: float
```

### Step 2: Implement Research Agent (45 minutes)

**File:** `ml-services/app/agents/sub_agents.py` (continued)

```python
from ..core.llm import LLMClient
from ..tools.executor import tool_executor
from ..tools.base import tool_registry

llm_client = LLM_client()

class ResearchAgent:
    """
    Deep information gathering agent.

    Purpose: Exhaustively search for all relevant information
    Tools: hybrid_search, get_entity_facts, find_connected_entities
    Behavior: Casts wide net, returns comprehensive findings with sources
    """

    async def execute(
        self,
        sub_task: SubTask,
        context: Dict[str, Any]
    ) -> SubTaskResult:
        """
        Execute research task with exhaustive information gathering.
        """

        import time
        start_time = time.time()

        system_prompt = """You are a research agent. Your job is to gather comprehensive information from the knowledge graph.

Use tools to:
- Search entities by name or type
- Get all facts about entities (with temporal context)
- Search memories semantically
- Find connected entities through relationships

Be exhaustive - find ALL relevant information.
Return detailed findings with sources.
"""

        prompt = f"""Research Task: {sub_task.description}

Expected outcome: {sub_task.expected_outcome}

Context:
- Active entities: {[e['name'] for e in context.get('active_entities', [])[:5]]}
- Recent facts: {len(context.get('recent_facts', []))} facts available

Conduct thorough research using available tools:
1. Search for relevant entities
2. Get detailed facts about entities
3. Search memories for related information
4. Find connected entities

Be exhaustive - find ALL relevant information.
"""

        # Execute with multi-turn tool calling
        llm_response = await llm_client.chat_with_tools(
            prompt=prompt,
            tools=tool_registry.to_openai_format(),
            system_prompt=system_prompt,
            tool_choice="auto"
        )

        tools_used = 0
        findings = {"entities_found": [], "facts_retrieved": [], "memories_searched": []}

        if llm_response["tool_calls"]:
            tool_results = await tool_executor.execute_tool_calls(
                llm_response["tool_calls"]
            )
            tools_used = len(llm_response["tool_calls"])

            # Parse tool results into findings
            findings = self._parse_research_findings(tool_results)

        return SubTaskResult(
            sub_task_id=sub_task.id,
            status="complete",
            findings=findings,
            tools_used=tools_used,
            execution_time_seconds=time.time() - start_time
        )

    def _parse_research_findings(
        self,
        tool_results: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """Parse tool results into structured findings."""
        # Extract data from tool_results
        entities = set()
        facts = []
        sources = []

        for result in tool_results:
            content = result.get("content", "")
            if "entities" in content.lower():
                # Parse entities from response
                pass
            sources.append(result.get("tool_call_id", ""))

        return {
            "entities_found": list(entities),
            "facts_retrieved": facts,
            "memories_searched": len(tool_results),
            "sources": sources
        }
```

### Step 3: Implement Other Agents (60 minutes)

**File:** `ml-services/app/agents/sub_agents.py` (continued)

```python
class AnalysisAgent:
    """Process and synthesize information."""

    async def execute(
        self,
        sub_task: SubTask,
        context: Dict[str, Any]
    ) -> SubTaskResult:
        """
        Execute analysis task with pattern identification and insights.
        """

        import time
        start_time = time.time()

        system_prompt = """You are an analysis agent. Your job is to process information and provide insights.

Use tools to:
- Query relevant data
- Search for patterns
- Compare and contrast
- Identify trends

Return analytical findings with:
- Key insights
- Supporting evidence
- Implications
- Recommendations if applicable
"""

        prompt = f"""Analysis Task: {sub_task.description}

Expected outcome: {sub_task.expected_outcome}

Analyze the information to identify:
- Patterns and trends
- Relationships and connections
- Insights and implications
- Comparisons and contrasts

Use tools to gather data, then provide analytical insights.
"""

        # Execute with tools
        llm_response = await llm_client.chat_with_tools(
            prompt=prompt,
            tools=tool_registry.to_openai_format(),
            system_prompt=system_prompt,
            tool_choice="auto"
        )

        tools_used = 0
        findings = {}

        if llm_response["tool_calls"]:
            tool_results = await tool_executor.execute_tool_calls(
                llm_response["tool_calls"]
            )
            tools_used = len(llm_response["tool_calls"])

            # Parse analysis results
            findings = {"analysis": llm_response.get("content", "")}

        return SubTaskResult(
            sub_task_id=sub_task.id,
            status="complete",
            findings=findings,
            tools_used=tools_used,
            execution_time_seconds=time.time() - start_time
        )


class PlanningAgent:
    """Break down complex tasks."""

    async def create_plan(
        self,
        user_message: str,
        context: Dict[str, Any],
        classification: Dict[str, Any]
    ) -> ExecutionPlan:
        """
        Create an execution plan for complex tasks.
        """

        import json
        import time

        prompt = f"""Break down this complex task into sub-tasks:

User request: "{user_message}"

Complexity: {classification['complexity']}
Estimated tools needed: {classification['estimated_tools']}

Context:
- Active entities: {[e['name'] for e in context.get('active_entities', [])[:5]]}
- Today's tasks: {[t['title'] for t in context.get('today_tasks', [])[:3]]}

Create a detailed execution plan with:
1. 3-7 sub-tasks
2. Clear dependencies between sub-tasks
3. Tools needed for each sub-task
4. Expected outcome for each sub-task
5. Estimated duration

Sub-task types:
- research: Information gathering
- analysis: Processing and insights
- comparison: Comparing multiple items
- synthesis: Combining findings

Return JSON:
{{
    "sub_tasks": [
        {{
            "id": "task_1",
            "type": "research|analysis|comparison|synthesis",
            "description": "Clear description",
            "expected_outcome": "What this will accomplish",
            "tools_needed": ["tool1", "tool2"],
            "estimated_duration": "2-5 minutes",
            "dependencies": []
        }}
    ],
    "estimated_total_duration": "10-20 minutes",
    "requires_human_input": true/false
}}
"""

        response = await llm_client.generate(prompt)
        plan_data = json.loads(response)

        # Create sub-task objects
        sub_tasks = [
            SubTask(**st, id=f"{i}_{st['type']}")
            for i, st in enumerate(plan_data["sub_tasks"])
        ]

        return ExecutionPlan(
            original_request=user_message,
            sub_tasks=sub_tasks,
            estimated_total_duration=plan_data["estimated_total_duration"],
            requires_human_input=plan_data["requires_human_input"],
            strategy_used=classification.get("strategy", "sub_agents")
        )

    async def adjust_plan(
        self,
        current_plan: ExecutionPlan,
        blocker: SubTaskResult
    ) -> ExecutionPlan:
        """Adjust plan based on blocker."""

        prompt = f"""Adjust this plan based on a blocker:

Current plan:
{current_plan.json()}

Blocker:
- Sub-task: {blocker.sub_task_id}
- Issue: {blocker.blocker}

Adjust the plan to:
1. Address the blocker
2. Modify affected sub-tasks
3. Add new sub-tasks if needed
4. Update dependencies

Return updated plan in same JSON format.
"""

        response = await llm_client.generate(prompt)
        plan_data = json.loads(response)

        # Recreate sub-tasks
        sub_tasks = [
            SubTask(**st, id=f"{i}_{st['type']}")
            for i, st in enumerate(plan_data["sub_tasks"])
        ]

        return ExecutionPlan(
            original_request=current_plan.original_request,
            sub_tasks=sub_tasks,
            estimated_total_duration=plan_data["estimated_total_duration"],
            requires_human_input=plan_data["requires_human_input"],
            strategy_used=current_plan.strategy_used
        )


class SynthesisAgent:
    """Combine results from multiple sub-agents."""

    async def synthesize(
        self,
        original_request: str,
        plan: ExecutionPlan,
        results: List[SubTaskResult],
        context: Dict[str, Any]
    ) -> str:
        """
        Synthesize results into coherent final response.
        """

        # Build synthesis prompt with all findings
        findings_summary = "\n\n".join([
            f"**Sub-task {r.sub_task_id}:**\n{json.dumps(r.findings, indent=2)}"
            for r in results
        ])

        prompt = f"""Synthesize these findings into a comprehensive response:

Original request: {original_request}

Plan:
{plan.json()}

Findings from {len(results)} sub-tasks:
{findings_summary}

Create a coherent response that:
1. Directly answers the original request
2. Incorporates key findings from all sub-tasks
3. Provides insights and conclusions
4. Notes any limitations or areas needing further investigation

Be thorough but concise. Use clear structure with headings if helpful.
"""

        system_prompt = """You are a synthesis agent. Your job is to combine findings from multiple sub-agents into a coherent, comprehensive response.

Integrate information from:
- Research findings
- Analytical insights
- Comparisons and patterns
- Temporal context

Provide a well-structured response that directly addresses the user's request.
"""

        response = await llm_client.generate(
            prompt=prompt,
            system_prompt=system_prompt
        )

        return response
```

---

## Testing

### Integration Tests

**File:** `ml-services/app/tests/test_sub_agents.py`

```python
import pytest
from agents.sub_agents import ResearchAgent, AnalysisAgent, PlanningAgent, SynthesisAgent
from agents.sub_agents import SubTask, ExecutionPlan

@pytest.mark.asyncio
async def test_research_agent():
    """Research agent should gather comprehensive information."""
    agent = ResearchAgent()

    sub_task = SubTask(
        id="research_1",
        type="research",
        description="Find information about the database project",
        expected_outcome="List of entities and facts related to database",
        tools_needed=["search_entities", "get_entity_facts"],
        estimated_duration="3-5 minutes"
    )

    context = {
        "active_entities": [{"name": "database"}],
        "recent_facts": [],
        "today_tasks": []
    }

    # Mock tool executor
    # ... mock setup ...

    result = await agent.execute(sub_task=sub_task, context=context)

    assert result.status == "complete"
    assert result.tools_used >= 1
    assert "findings" in result

@pytest.mark.asyncio
async def test_planning_agent():
    """Planning agent should create executable plans."""
    agent = PlanningAgent()

    user_message = "Analyze the database performance issues"
    context = {
        "active_entities": [],
        "recent_facts": [],
        "today_tasks": []
    }
    classification = {
        "complexity": "complex",
        "estimated_tools": 8
    }

    # Mock LLM client
    # ... mock setup ...

    plan = await agent.create_plan(
        user_message=user_message,
        context=context,
        classification=classification
    )

    assert len(plan.sub_tasks) >= 3
    assert len(plan.sub_tasks) <= 7
    assert all(st.type in ["research", "analysis", "comparison", "synthesis"] for st in plan.sub_tasks)

@pytest.mark.asyncio
async def test_synthesis_agent():
    """Synthesis agent should combine findings coherently."""
    agent = SynthesisAgent()

    plan = ExecutionPlan(
        original_request="Tell me about the database",
        sub_tasks=[],
        estimated_total_duration="10-20 minutes",
        requires_human_input=False,
        strategy_used="sub_agents"
    )

    results = [
        SubTaskResult(
            sub_task_id="research_1",
            status="complete",
            findings={"entities": ["database", "postgres"]},
            tools_used=2,
            execution_time_seconds=5.0
        ),
        SubTaskResult(
            sub_task_id="analysis_1",
            status="complete",
            findings={"insights": "database is slow"},
            tools_used=1,
            execution_time_seconds=3.0
        )
    ]

    # Mock LLM client
    # ... mock setup ...

    response = await agent.synthesize(
        original_request="Tell me about the database",
        plan=plan,
        results=results,
        context={}
    )

    assert isinstance(response, str)
    assert len(response) > 0
```

---

## Success Criteria

- [ ] ResearchAgent exhaustively gathers information
- [ ] AnalysisAgent provides insights and patterns
- [ ] PlanningAgent creates executable 3-7 sub-task plans
- [ ] SynthesisAgent combines findings coherently
- [ ] All agents use tool system correctly
- [ ] Agents return properly structured SubTaskResults
- [ ] PlanningAgent can adjust plans based on blockers
- [ ] Integration tests pass

---

## Files to Create

1. `ml-services/app/agents/sub_agents.py` - All sub-agent implementations
2. `ml-services/app/tests/test_sub_agents.py` - Integration tests

---

## Related Work Packets

- **W40:** Task Complexity Classifier - determines when to use sub-agents
- **W41:** Agent Controller - orchestrates sub-agent execution
- **W43:** Completion Criteria - determines when sub-agent work is complete
- **W44-W46:** Tool System - provides tools for agents to use

---

## Notes

- **Same Model, Different Prompts:** All agents use GLM-4.7, differentiated by system prompts
- **Tool Reuse:** All agents have access to the same tool registry
- **Error Handling:** If a sub-task fails, return status="blocked" with blocker description
- **Parallel Execution:** Future enhancement: run independent sub-tasks in parallel
- **Plan Adjustment:** Planning agent can revise plan when sub-tasks hit blockers

**Future Enhancements:**
- Parallel sub-task execution for independent tasks
- Sub-agent specialization (domain-specific agents)
- Agent memory and learning
- Dynamic tool selection based on sub-task type

---

**Created:** 2026-01-29 (Phase 6: Agentic Cognitive Interface)
**Next:** W44: Tool Base & Registry
