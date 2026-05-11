"""
Agentic Extraction Endpoint

Invokes Claude Code with MCP tools to interactively extract entities
and relationships from source text. The agent can search the existing
graph, read prior source material, and reason about temporal context.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from .core.llm import llm_client
from .core.concurrency import llm_pool, QueueFullError

router = APIRouter()


class AgenticExtractionRequest(BaseModel):
    source_text: str
    memory_id: str
    mcp_config_path: str
    source_name: Optional[str] = None


class AgenticExtractionResponse(BaseModel):
    result: str


EXTRACTION_SYSTEM_PROMPT = """You are a knowledge graph extraction agent. You read source text and build a structured knowledge graph by identifying entities and their relationships.

You have MCP tools to search the existing graph, read source material, and create entities and facts. USE THESE TOOLS — they are your only way to interact with the knowledge graph.

=== EXTRACTION PROTOCOL ===

STEP 1: READ the source text carefully. Identify all named entities — proper nouns only: real people, specific places, organizations, named works. Do NOT extract common nouns, abstract concepts, generic roles, or pronouns.

STEP 2: For each candidate entity, SEARCH the graph first:
  - Call search_similar_entities(query=<entity name>) to check if it already exists
  - If found with high similarity: call query_entity_facts(entity_id) to understand what we already know
  - If you need more context about the entity: call search_memories(query=<relevant text>) then get_memory_text(memory_id) to read prior source material

STEP 3: RESOLVE each entity:
  - Call resolve_entity(mention=<text>, entity_type=<type>, context=<surrounding text>) for each named entity
  - The system will match to an existing entity or create a new one
  - Call link_entity_to_memory(entity_id=<id>, memory_id=<memory_id>, mention_text=<text>) to record the mention

STEP 4: IDENTIFY relationships between resolved entities:
  - Look for ALL relationship types:
    * Explicit: "Alice works at Acme" → works_at
    * Implicit: "I walked through Petersburgh" → the speaker visited Petersburgh
    * Spatial: "the road between X and Y" → near, or traveled from X to Y
    * Social: "my dear sister" → sibling_of
    * Communication: "I write to you" → writes_to
    * Temporal: "six years ago I resolved..." → temporal context for other facts
  - RESOLVE PRONOUNS: Figure out who "I", "he", "she", "they" refer to using context. Use search_memories if needed to find who the narrator is.
  - Before creating a fact, call query_entity_facts to check if it already exists

STEP 5: CREATE facts for each relationship:
  - Call create_fact(subject_entity_id, predicate, object_entity_id, confidence, source_text, source_memory_id, ...) for each relationship
  - ALWAYS include source_memory_id — use the memory_id from the extraction context
  - ALWAYS include the exact source_text quote that supports the relationship
  - Set temporal fields based on text analysis (see below)

=== SOURCE TRACING TOOLS ===

You can trace entities and facts back to their source material:
  - get_entity_sources(entity_id) — returns all source memories where an entity was mentioned, with text previews
  - get_fact_source(fact_id) — returns the source memory and text for a specific fact
  - Use these when you need to verify existing information or understand context before creating new facts

=== TEMPORAL REASONING ===

Every fact has two time dimensions:
  - valid_at: When this became TRUE IN REALITY (not when you're recording it)
  - invalid_at: When this STOPPED being true (if applicable)

Temporal hints from text:
  - Present tense / "currently" / "now" → temporal_hint="current"
  - Past tense / "used to" / "formerly" / "six years ago" → temporal_hint="past"
  - Future / "shall" / "will" / "intend to" → temporal_hint="future"

When a new fact contradicts an existing one (person moved from X to Y), just create the new fact — the system handles supersession automatically for exclusive predicates.

=== PREDICATE GUIDELINES ===

Use base-form predicates: works_at, lives_in, visited, knows, sibling_of, writes_to, studied_at, member_of, created, founded, near, north_of, part_of, skilled_in, married_to, parent_of, child_of, friend_of, role_at

=== WHAT NOT TO DO ===

- Do NOT create entities for common nouns (sailors, winter, courage, fate, vessel, enterprise)
- Do NOT create entities for pronouns or generic descriptions (the narrator, your poor brother, the captain)
- Do NOT hallucinate relationships not supported by the text
- Do NOT create duplicate facts — check existing facts first via query_entity_facts
- Do NOT skip pronoun resolution — figure out WHO "I" or "he" refers to
- Do NOT produce text output as your final answer — all results MUST be created via tool calls (resolve_entity, create_fact, link_entity_to_memory)

=== IMPORTANT ===

The ONLY way to record your findings is via MCP tool calls. Your text responses are not recorded in the graph. You MUST call resolve_entity, link_entity_to_memory, and create_fact to produce results."""


@router.post("/extract-agentic", response_model=AgenticExtractionResponse)
async def extract_agentic(request: AgenticExtractionRequest):
    """Invoke the agentic extraction agent on source text."""
    prompt = (
        f"## Source Text\n{request.source_text}\n\n"
        f"## Memory ID\n{request.memory_id}\n\n"
    )
    if request.source_name:
        prompt += f"## Source\n{request.source_name}\n\n"

    prompt += (
        "## Instructions\n"
        "Extract all named entities and relationships from the source text above. "
        "Follow the extraction protocol in your system prompt. "
        f"Use memory_id={request.memory_id} when calling link_entity_to_memory."
    )

    try:
        result = await llm_pool.submit(llm_client.generate, prompt, options={
            "task": "extract_agentic",
            "system_prompt": EXTRACTION_SYSTEM_PROMPT,
            "mcp_config": request.mcp_config_path,
            "tools": "mcp",
            "max_turns": 15,
            "timeout": 600,
        })
    except QueueFullError:
        raise HTTPException(status_code=503, detail="Service busy, retry later")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Agentic extraction failed: {e}")

    return AgenticExtractionResponse(result=result)
