"""
Causal Reasoning Endpoint (B06)

Invokes Claude Code with the causal system prompt and MCP tools
to reason about causal relationships in a Graph S delta.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from .core.llm import llm_client
from .core.concurrency import llm_pool, QueueFullError

router = APIRouter()


class CausalEvent(BaseModel):
    id: str
    fact_id: Optional[str] = None
    transition_type: str
    subject_entity_id: Optional[str] = None
    predicate: Optional[str] = None
    source_text: Optional[str] = None


class CausalDelta(BaseModel):
    """The Graph S delta from a single ingest() call."""
    source_text: str
    memory_id: Optional[str] = None
    new_entities: List[Dict[str, Any]] = []
    new_facts: List[Dict[str, Any]] = []
    modified_facts: List[Dict[str, Any]] = []
    causal_events: List[CausalEvent] = []
    mcp_config_path: str


class CausalReasonResponse(BaseModel):
    result: str
    cost: Optional[Dict[str, Any]] = None


CAUSAL_SYSTEM_PROMPT = """You are a causal reasoning agent for a personal knowledge graph. Your job is to identify and assert causal relationships between events.

You MUST use the MCP tools provided to you. These are your only way to interact with the knowledge graph. The tools are:
- `query_entity_facts` — get all facts for an entity
- `query_entity_neighbours` — traverse the knowledge graph
- `search_similar_entities` — semantic entity search
- `search_memories` — semantic search over source texts
- `get_memory_text` — retrieve full text of a memory
- `get_causal_history` — get existing causal chains for an entity
- `create_causal_edge` — assert a causal link between two events (THIS IS HOW YOU OUTPUT RESULTS)

You MUST call `create_causal_edge` via MCP for every causal relationship you identify. This is the only way to record your findings.

## Your Process

1. **Examine the delta.** The user message contains what just changed in the knowledge graph: new entities, new/modified facts, causal events, and the original source text. Understand what happened.

2. **Gather context.** Use the MCP tools to query for broader context:
   - Call `query_entity_facts` to get the full fact history for involved entities
   - Call `get_causal_history` to check for existing causal chains
   - Call `query_entity_neighbours` to find related entities
   Do NOT reason from the current text alone — use the tools.

3. **Reason about causality.** Based on the delta AND gathered context, identify causal links:
   - Did the source text explicitly state causality? ("because", "caused by", "led to", "resulted in")
   - Do temporal patterns suggest causality? (A consistently precedes B for this entity)
   - Do existing causal chains extend? (This new event is a known downstream effect)
   - Are there indirect causes? (A caused B, B now appears to cause C)

4. **Assert causal edges.** For EACH causal link you identify, call the `create_causal_edge` MCP tool with:
   - cause_event_id and effect_event_id — the specific event IDs from the causal_events in the delta
   - strength — 0.3-0.6 for inferred, 0.7-1.0 for explicitly stated
   - reasoning — detailed justification explaining WHY the cause led to the effect
   - source_references — array of {type, id, relevance} for every source that informed your conclusion

5. **Do not hallucinate causality.** If you cannot identify a clear causal mechanism, do not call create_causal_edge. It is better to miss a causal link than to assert a false one.

## Rules
- You MUST call MCP tools — do not just produce text output
- Every create_causal_edge call MUST have reasoning that explains the causal mechanism
- Every create_causal_edge call MUST have at least one source_reference with type, id, and relevance
- If zero causal links are found, that is a valid outcome — say so and stop"""


def _format_delta(delta: CausalDelta) -> str:
    """Format the delta as the user message for Claude Code."""
    parts = [f"## Source Text\n{delta.source_text}"]

    if delta.memory_id:
        parts.append(f"\n## Memory ID\n{delta.memory_id}")

    if delta.new_entities:
        entities_str = "\n".join(
            f"- {e.get('canonicalName', e.get('canonical_name', '?'))} "
            f"(type: {e.get('entityType', e.get('entity_type', '?'))}, id: {e.get('id', '?')})"
            for e in delta.new_entities
        )
        parts.append(f"\n## New Entities\n{entities_str}")

    if delta.new_facts:
        facts_str = "\n".join(
            f"- {e.get('subjectEntityId', e.get('subject_entity_id', '?'))} "
            f"{e.get('predicate', '?')} → {e.get('objectValue', e.get('object_value', '?'))} "
            f"(id: {e.get('id', '?')})"
            for e in delta.new_facts
        )
        parts.append(f"\n## New Facts\n{facts_str}")

    if delta.modified_facts:
        mfacts_str = "\n".join(
            f"- {e.get('id', '?')}: {e.get('predicate', '?')} (transition: {e.get('transition', '?')})"
            for e in delta.modified_facts
        )
        parts.append(f"\n## Modified Facts\n{mfacts_str}")

    if delta.causal_events:
        events_str = "\n".join(
            f"- event_id: {e.id}, fact_id: {e.fact_id}, "
            f"transition: {e.transition_type}, entity: {e.subject_entity_id}, "
            f"predicate: {e.predicate}"
            for e in delta.causal_events
        )
        parts.append(f"\n## Causal Events (available for edge creation)\n{events_str}")

    parts.append(
        "\n## Instructions\n"
        "Analyze the above delta. Use your tools to gather context, then assert "
        "any causal edges you can identify. If none are found, say so."
    )

    return "\n".join(parts)


@router.post("/causal-reason")
async def causal_reason(delta: CausalDelta) -> CausalReasonResponse:
    """Invoke the causal reasoning agent on a Graph S delta."""
    prompt = _format_delta(delta)

    try:
        result = await llm_pool.submit(llm_client.generate, prompt, options={
            "task": "causal_reason",
            "system_prompt": CAUSAL_SYSTEM_PROMPT,
            "mcp_config": delta.mcp_config_path,
            "tools": "mcp",
            "max_turns": 10,
            "timeout": 600,
        })
    except QueueFullError:
        raise HTTPException(status_code=503, detail="Service busy, retry later")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Causal reasoning failed: {e}")

    return CausalReasonResponse(result=result)
