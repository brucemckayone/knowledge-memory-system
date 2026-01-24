"""
Entity Extraction Endpoint
Phase 3: LLM-based Named Entity Recognition

Extracts entities from text using Ollama and returns structured mentions.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import ollama
import json
import re

router = APIRouter()

ENTITY_EXTRACTION_PROMPT = """Extract all named entities from this text.

TEXT: "{text}"

For each entity found, determine:
- mention: The exact text that refers to the entity
- type: One of: person, company, project, concept, place, event, other
- properties: Any attributes mentioned (role, title, location, etc.)
- confidence: How confident you are (0.0-1.0)

Return ONLY valid JSON array:
[
  {{
    "mention": "exact text",
    "type": "person",
    "properties": {{"role": "CEO"}},
    "start": 15,
    "end": 25,
    "confidence": 0.95
  }}
]

Rules:
- Include people, companies, projects, places, concepts
- Skip common words and pronouns
- Note positions (character indices)
- For ambiguous types, choose most specific
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


class ExtractEntitiesRequest(BaseModel):
    text: str
    include_context: bool = True


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


def parse_entities_json(text: str) -> List[dict]:
    """Parse JSON array from LLM response"""
    # Find JSON array in response
    match = re.search(r'\[[\s\S]*\]', text)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass
    return []


@router.post("/extract-entities", response_model=ExtractEntitiesResponse)
async def extract_entities(request: ExtractEntitiesRequest):
    """
    Extract named entities from text using LLM.
    
    Returns list of entity mentions with types and positions.
    """
    try:
        prompt = ENTITY_EXTRACTION_PROMPT.format(text=request.text)
        
        response = ollama.generate(
            model="llama3.2:3b",  # Fast model for extraction
            prompt=prompt,
            options={
                "temperature": 0.1,
                "num_predict": 1024,
            }
        )
        
        entities_raw = parse_entities_json(response['response'])
        
        # Validate and normalize
        entities = []
        valid_types = ['person', 'company', 'project', 'concept', 'place', 'event', 'other']
        
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
        raise HTTPException(status_code=500, detail=f"Extraction failed: {str(e)}")


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
        
        response = ollama.generate(
            model="llama3.2:3b",  # Use faster model
            prompt=prompt,
            options={
                "temperature": 0.1,
                "num_predict": 256,
            }
        )
        
        # Parse JSON response
        result = {}
        match = re.search(r'\{[\s\S]*\}', response['response'])
        if match:
            result = json.loads(match.group())
        
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


@router.get("/extract-entities/test")
async def test_extraction():
    """Test entity extraction with sample text"""
    sample = """
    John Smith, the CEO of Acme Corp, announced the new Alpha Project yesterday.
    He mentioned that Dr. Sarah Chen from the R&D team in San Francisco will lead the initiative.
    The Q4 Review meeting is scheduled for next week.
    """
    
    result = await extract_entities(ExtractEntitiesRequest(text=sample))
    return {
        "input": sample,
        "entities": [e.model_dump() for e in result.entities],
    }
