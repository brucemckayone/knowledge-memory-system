"""
Entity Extraction Endpoint
Phase 3: LLM-based Named Entity Recognition

Extracts entities from text using Ollama and returns structured mentions.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import json
from .core.llm import llm_client
from .core.concurrency import llm_pool, QueueFullError

router = APIRouter()

ENTITY_EXTRACTION_PROMPT = """Extract named entities from this text. Only extract PROPER NOUNS and SPECIFIC NAMED ENTITIES — real people, organizations, specific geographic places, named works/projects.

Do NOT extract:
- Common nouns or generic words (sailors, vessel, winter, spring, fate, courage)
- Abstract concepts (prudence, safety, enterprise, considerateness, paradise)
- Generic roles or descriptions (the narrator, your poor brother, the captain, sailors)
- Seasons, weather, body parts, emotions, or generic descriptions
- Pronouns or anaphoric references (he, she, they, the old man)
{known_entities_section}
TEXT: "{text}"

For each entity, return:
- mention: The exact text as it appears
- type: One of: {type_list}
- start: Character offset where mention begins
- end: Character offset where mention ends
- confidence: Score using this calibration:
  0.95-1.0: Unambiguous proper noun with full name (e.g., "Victor Frankenstein", "St. Petersburgh")
  0.85-0.94: Clear proper noun, partial name or well-known place (e.g., "Walton", "London", "Margaret")
  0.70-0.84: Probable proper noun but could be generic in some contexts (e.g., "Archangel" as city vs word)
  0.50-0.69: Ambiguous — might be a name or might be a common noun
  Below 0.50: Do not include

Return ONLY a valid JSON array. No markdown fences:
[{{"mention": "exact text", "type": "person", "start": 15, "end": 25, "confidence": 0.95}}]
"""

ENTITY_RESOLUTION_PROMPT = """Determine if these two entity mentions refer to the same entity.

EXISTING ENTITY:
  Name: {existing_name}
  Type: {existing_type}
  Properties: {existing_properties}

NEW MENTION:
  Text: "{new_mention}"
  Context: "{context}"

Decision options:
1. MERGE - Same entity, combine properties
2. LINK - Related but distinct (create relationship)
3. CREATE - Entirely new entity

Return JSON:
{{"decision": "MERGE|LINK|CREATE", "confidence": 0.0-1.0, "reasoning": "..."}}
"""


class KnownEntity(BaseModel):
    name: str
    type: str


class ExtractEntitiesRequest(BaseModel):
    text: str
    include_context: bool = True
    valid_types: Optional[List[str]] = None  # Dynamic types from platform
    known_entities: Optional[List[KnownEntity]] = None  # Prior context from RAG
    context_snippets: Optional[List[str]] = None  # Source text from similar prior memories


class EntityMention(BaseModel):
    mention: str
    type: str
    properties: Dict[str, Any] = {}
    start: int = 0
    end: int = 0
    confidence: float = 0.8


class ExtractEntitiesResponse(BaseModel):
    entities: List[EntityMention]
    text_length: int


class ResolveEntityRequest(BaseModel):
    new_mention: str
    context: str
    existing_entity: Dict[str, Any]


class ResolveEntityResponse(BaseModel):
    decision: str  # MERGE, LINK, CREATE
    confidence: float
    reasoning: str


@router.post("/extract-entities", response_model=ExtractEntitiesResponse)
async def extract_entities(request: ExtractEntitiesRequest):
    """
    Extract named entities from text using LLM.
    
    Returns list of entity mentions with types and positions.
    """
    try:
        type_list = ', '.join(request.valid_types) if request.valid_types else 'person, company, project, concept, place, event, other'

        # Build known entities section for RAG context
        known_entities_section = ""
        if request.known_entities:
            entities_list = "\n".join([
                f'- "{e.name}" ({e.type})' for e in request.known_entities[:30]
            ])
            known_entities_section = (
                f"\n=== KNOWN ENTITIES (from prior documents) ===\n{entities_list}\n\n"
                "When you see mentions that match or refer to these known entities, "
                "use the EXACT canonical name listed above.\n"
            )

        # Add source text snippets from similar prior memories
        if request.context_snippets:
            snippets_text = "\n---\n".join(request.context_snippets[:5])
            known_entities_section += (
                f"\n=== RELATED PRIOR TEXT (from previously ingested documents) ===\n"
                f"{snippets_text}\n\n"
                "Use this context to help identify entities and resolve ambiguous references.\n"
            )

        prompt = ENTITY_EXTRACTION_PROMPT.format(
            text=request.text,
            type_list=type_list,
            known_entities_section=known_entities_section,
        )
        
        # Use LLM service (via work queue)
        entities_raw = await llm_pool.submit(
            llm_client.generate_json,
            prompt,
            None,
            {"task": "extract_entities"},
        )
        
        if not isinstance(entities_raw, list):
            entities_raw = []
        
        # Validate and normalize
        entities = []
        valid_types = request.valid_types or ['person', 'company', 'project', 'concept', 'place', 'event', 'other']
        
        for e in entities_raw:
            entity_type = e.get('type', 'other').lower()
            if entity_type not in valid_types:
                entity_type = 'other'
            
            entities.append(EntityMention(
                mention=e.get('mention', ''),
                type=entity_type,
                properties=e.get('properties', {}),
                start=e.get('start', 0),
                end=e.get('end', 0),
                confidence=min(1.0, max(0.0, e.get('confidence', 0.8))),
            ))
        
        return ExtractEntitiesResponse(
            entities=entities,
            text_length=len(request.text),
        )
        
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Entity extraction LLM request failed: {str(e)}")


@router.post("/resolve-entity", response_model=ResolveEntityResponse)
async def resolve_entity(request: ResolveEntityRequest):
    """
    Determine if new mention matches existing entity.
    
    Uses LLM-as-judge for medium-confidence matches.
    """
    try:
        prompt = ENTITY_RESOLUTION_PROMPT.format(
            existing_name=request.existing_entity.get('name', ''),
            existing_type=request.existing_entity.get('type', ''),
            existing_properties=json.dumps(request.existing_entity.get('properties', {})),
            new_mention=request.new_mention,
            context=request.context[:500],  # Limit context length
        )
        
        result = await llm_pool.submit(
            llm_client.generate_json,
            prompt,
            None,
            {"task": "resolve_entity"},
        )
        
        decision = result.get('decision', 'CREATE').upper()
        if decision not in ['MERGE', 'LINK', 'CREATE']:
            decision = 'CREATE'
        
        return ResolveEntityResponse(
            decision=decision,
            confidence=min(1.0, max(0.0, result.get('confidence', 0.5))),
            reasoning=result.get('reasoning', 'No reasoning provided'),
        )
        
    except Exception as e:
        # Default to CREATE on error
        return ResolveEntityResponse(
            decision='CREATE',
            confidence=0.5,
            reasoning=f'Error during resolution: {str(e)}',
        )