"""
Relationship Extraction Endpoint
Phase 4: Extract subject-predicate-object triples from content

W26 Relationship Agent uses this to build the knowledge graph.
"""

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional, List
from .core.llm import llm_client
import json
import re

router = APIRouter()

EXTRACT_RELATIONSHIPS_PROMPT = """Extract relationships from this text as subject-predicate-object triples.

TEXT:
{content}

KNOWN ENTITIES (use these exact names when they match):
{entities}

Rules:
1. Extract factual relationships, not opinions
2. Use entities from the known list when they match mentions
3. Predicates should be lowercase verbs/verb phrases (works_at, knows, manages, created, etc.)
4. Include temporal hints when available (currently, used to, since 2020)
5. Rate confidence based on how explicit the relationship is

Return raw JSON array only. Do not wrap in markdown code fences:
[
  {{
    "subject": "Person or entity name",
    "predicate": "relationship_type",
    "object": "Other entity or value",
    "confidence": 0.0-1.0,
    "temporal_hint": "currently|past|future|unknown",
    "source_text": "exact text that mentions this relationship"
  }}
]

Example relationships:
- "John works at Acme Corp" -> {{"subject": "John", "predicate": "works_at", "object": "Acme Corp", "confidence": 0.9}}
- "She used to live in NYC" -> {{"subject": "She", "predicate": "lived_in", "object": "NYC", "temporal_hint": "past"}}
- "The project was created by the team" -> {{"subject": "team", "predicate": "created", "object": "project"}}

Return [] if no relationships found.
"""

# Common relationship patterns for quick extraction
RELATIONSHIP_PATTERNS = [
    # Employment
    (r'(\w+(?:\s+\w+)?)\s+works?\s+(?:at|for)\s+(\w+(?:\s+\w+)*)', 'works_at', 'current'),
    (r'(\w+(?:\s+\w+)?)\s+is\s+(?:employed|working)\s+(?:at|by)\s+(\w+(?:\s+\w+)*)', 'works_at', 'current'),
    (r'(\w+(?:\s+\w+)?)\s+(?:used\s+to\s+work|worked|formerly)\s+(?:at|for)\s+(\w+(?:\s+\w+)*)', 'worked_at', 'past'),

    # Roles
    (r'(\w+(?:\s+\w+)?)\s+is\s+(?:the\s+)?(?:CEO|ceo|founder|CTO|manager)\s+(?:of|at)\s+(\w+(?:\s+\w+)*)', 'role_at', 'current'),
    (r'(\w+(?:\s+\w+)?)\s+(?:manages|leads|supervises)\s+(\w+(?:\s+\w+)*)', 'manages', 'current'),
    (r'(\w+(?:\s+\w+)?)\s+reports\s+to\s+(\w+(?:\s+\w+)*)', 'reports_to', 'current'),

    # Location
    (r'(\w+(?:\s+\w+)?)\s+lives?\s+in\s+(\w+(?:\s+\w+)*)', 'lives_in', 'current'),
    (r'(\w+(?:\s+\w+)?)\s+is\s+(?:based|located)\s+in\s+(\w+(?:\s+\w+)*)', 'lives_in', 'current'),
    (r'(\w+(?:\s+\w+)?)\s+(?:moved|relocated)\s+to\s+(\w+(?:\s+\w+)*)', 'lives_in', 'current'),

    # Social
    (r'(\w+(?:\s+\w+)?)\s+knows?\s+(\w+(?:\s+\w+)*)', 'knows', 'unknown'),
    (r'(\w+(?:\s+\w+)?)\s+(?:is\s+)?friends?\s+(?:with|of)\s+(\w+(?:\s+\w+)*)', 'friend_of', 'current'),
    (r'(\w+(?:\s+\w+)?)\s+(?:met|introduced\s+to)\s+(\w+(?:\s+\w+)*)', 'knows', 'unknown'),

    # Family
    (r'(\w+(?:\s+\w+)?)\s+is\s+married\s+to\s+(\w+(?:\s+\w+)*)', 'married_to', 'current'),
    (r"(\w+(?:\s+\w+)?)'s\s+(?:wife|husband|spouse)\s+(\w+(?:\s+\w+)*)", 'married_to', 'current'),

    # Creation
    (r'(\w+(?:\s+\w+)?)\s+(?:created|built|made|developed|wrote)\s+(\w+(?:\s+\w+)*)', 'created', 'past'),
    (r'(\w+(?:\s+\w+)?)\s+(?:founded|started)\s+(\w+(?:\s+\w+)*)', 'founded', 'past'),

    # Education
    (r'(\w+(?:\s+\w+)?)\s+(?:studied|went|graduated)\s+(?:at|from)\s+(\w+(?:\s+\w+)*)', 'studied_at', 'past'),
    (r'(\w+(?:\s+\w+)?)\s+(?:attends?|is\s+studying\s+at)\s+(\w+(?:\s+\w+)*)', 'studies_at', 'current'),
]


class ExtractedEntity(BaseModel):
    name: str
    type: Optional[str] = None


class ExtractRelationshipsRequest(BaseModel):
    content: str
    entities: List[ExtractedEntity] = []


class Relationship(BaseModel):
    subject: str
    predicate: str
    object: str
    confidence: float
    temporal_hint: str = "unknown"
    source_text: Optional[str] = None


class ExtractRelationshipsResponse(BaseModel):
    relationships: List[Relationship]
    source_content_hash: str
    used_fallback: bool = False


def quick_extract(content: str) -> List[Relationship]:
    """Extract relationships using regex patterns"""
    relationships = []

    for pattern, predicate, temporal in RELATIONSHIP_PATTERNS:
        matches = re.finditer(pattern, content, re.IGNORECASE)
        for match in matches:
            subject = match.group(1).strip()
            obj = match.group(2).strip()

            # Skip if too short or just pronouns
            if len(subject) < 2 or len(obj) < 2:
                continue
            if subject.lower() in ['i', 'we', 'you', 'he', 'she', 'it', 'they']:
                continue

            relationships.append(Relationship(
                subject=subject,
                predicate=predicate,
                object=obj,
                confidence=0.7,  # Pattern-based has lower confidence
                temporal_hint=temporal,
                source_text=match.group(0)[:100],
            ))

    return relationships


def deduplicate_relationships(rels: List[Relationship]) -> List[Relationship]:
    """Remove duplicate relationships, keeping highest confidence"""
    seen = {}
    for rel in rels:
        key = (rel.subject.lower(), rel.predicate, rel.object.lower())
        if key not in seen or rel.confidence > seen[key].confidence:
            seen[key] = rel
    return list(seen.values())


def resolve_to_entities(relationships: List[Relationship], entities: List[ExtractedEntity]) -> List[Relationship]:
    """Map relationship subjects/objects to known entities"""
    entity_map = {e.name.lower(): e.name for e in entities}

    resolved = []
    for rel in relationships:
        # Try to match subject
        subject = entity_map.get(rel.subject.lower(), rel.subject)
        # Try to match object
        obj = entity_map.get(rel.object.lower(), rel.object)

        resolved.append(Relationship(
            subject=subject,
            predicate=rel.predicate,
            object=obj,
            confidence=rel.confidence,
            temporal_hint=rel.temporal_hint,
            source_text=rel.source_text,
        ))

    return resolved


@router.post("/extract-relationships", response_model=ExtractRelationshipsResponse)
async def extract_relationships(request: ExtractRelationshipsRequest):
    """
    Extract relationships from content.

    Uses pattern matching first, then LLM for complex cases.
    """
    content = request.content
    entities = request.entities

    # Quick pattern extraction
    quick_rels = quick_extract(content)

    # For short content or if we found patterns, might be enough
    if len(content) < 100 or len(quick_rels) >= 3:
        final_rels = resolve_to_entities(quick_rels, entities)
        return ExtractRelationshipsResponse(
            relationships=deduplicate_relationships(final_rels),
            source_content_hash=str(hash(content))[:12],
            used_fallback=True,
        )

    # Use LLM for richer extraction
    try:
        entity_list = ", ".join([e.name for e in entities]) if entities else "none known"

        prompt = EXTRACT_RELATIONSHIPS_PROMPT.format(
            content=content[:2000],
            entities=entity_list,
        )

        raw_rels = llm_client.generate_json(
            prompt=prompt,
            options={"task": "extract_relationships"}
        )

        if isinstance(raw_rels, list):
            llm_rels = []
            for r in raw_rels:
                if isinstance(r, dict) and 'subject' in r and 'predicate' in r and 'object' in r:
                    llm_rels.append(Relationship(
                        subject=r['subject'],
                        predicate=r['predicate'].lower().replace(' ', '_'),
                        object=r['object'],
                        confidence=min(1.0, max(0.0, r.get('confidence', 0.8))),
                        temporal_hint=r.get('temporal_hint', 'unknown'),
                        source_text=r.get('source_text'),
                    ))

            # Combine with quick extractions
            all_rels = quick_rels + llm_rels
            final_rels = resolve_to_entities(all_rels, entities)

            return ExtractRelationshipsResponse(
                relationships=deduplicate_relationships(final_rels),
                source_content_hash=str(hash(content))[:12],
                used_fallback=False,
            )

    except Exception as e:
        print(f"LLM relationship extraction failed: {e}")

    # Return quick results as fallback
    final_rels = resolve_to_entities(quick_rels, entities)
    return ExtractRelationshipsResponse(
        relationships=deduplicate_relationships(final_rels),
        source_content_hash=str(hash(content))[:12],
        used_fallback=True,
    )