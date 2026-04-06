"""
Relationship Extraction Endpoint
Phase 4: Extract subject-predicate-object triples from content

W26 Relationship Agent uses this to build the knowledge graph.
"""

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional, List
from .core.llm import llm_client
import asyncio
import json
import re

router = APIRouter()

EXTRACT_RELATIONSHIPS_PROMPT = """You are extracting relationships from text. You MUST only use entity names from the ALLOWED ENTITIES list below.

=== ALLOWED ENTITIES ===
{entities}

=== RULES (STRICT) ===
1. The "subject" and "object" of every relationship MUST be an exact string from the ALLOWED ENTITIES list above. Copy the name exactly — do not paraphrase, abbreviate, or use pronouns.
2. Do NOT use pronouns (I, he, she, they, it, we, you), titles (the narrator, the lieutenant), descriptions (the voyages, his friend), or any other text that is not in the ALLOWED ENTITIES list.
3. If a sentence describes a relationship involving someone/something NOT in the ALLOWED ENTITIES list, SKIP that relationship entirely.
4. Extract factual relationships, not opinions or speculation.
5. Predicates must be BASE FORM only (works_at, lives_in, knows, writes_to). Do NOT use past tense (worked_at, lived_in). Use temporal_hint for tense instead.
6. Include temporal hints when available.
7. Rate confidence based on how explicit the relationship is in the text.
{predicate_guidance}

=== TEXT ===
{content}

=== OUTPUT FORMAT ===
Return a raw JSON array only. No markdown fences, no explanation.
[
  {{
    "subject": "<exact entity name from ALLOWED ENTITIES>",
    "predicate": "relationship_type",
    "object": "<exact entity name from ALLOWED ENTITIES>",
    "confidence": 0.0-1.0,
    "temporal_hint": "currently|past|future|unknown",
    "source_text": "exact quote from text"
  }}
]

=== EXAMPLES ===
Given ALLOWED ENTITIES: ["John Smith", "Acme Corp", "New York"]

CORRECT:
- Text: "John works at Acme" -> {{"subject": "John Smith", "predicate": "works_at", "object": "Acme Corp", "confidence": 0.9}}
- Text: "He moved to New York" -> {{"subject": "John Smith", "predicate": "lives_in", "object": "New York", "temporal_hint": "currently", "confidence": 0.8}}

WRONG (do NOT do these):
- {{"subject": "He", ...}} <- pronoun, not in ALLOWED ENTITIES
- {{"subject": "John", ...}} <- partial name, use exact "John Smith"
- {{"subject": "the employee", ...}} <- description, not in ALLOWED ENTITIES

Return [] if no relationships can be formed using only the allowed entities.
"""

# Common relationship patterns for quick extraction
RELATIONSHIP_PATTERNS = [
    # Employment
    (r'(\w+(?:\s+\w+)?)\s+works?\s+(?:at|for)\s+(\w+(?:\s+\w+)*)', 'works_at', 'current'),
    (r'(\w+(?:\s+\w+)?)\s+is\s+(?:employed|working)\s+(?:at|by)\s+(\w+(?:\s+\w+)*)', 'works_at', 'current'),
    (r'(\w+(?:\s+\w+)?)\s+(?:used\s+to\s+work|worked|formerly)\s+(?:at|for)\s+(\w+(?:\s+\w+)*)', 'works_at', 'past'),

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
    valid_predicates: Optional[List[str]] = None  # Dynamic predicates from platform


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
    """Map relationship subjects/objects to known entities via fuzzy matching"""
    if not entities:
        return relationships

    entity_names = [e.name for e in entities]
    # Build lookup: lowercase -> canonical name
    entity_map = {e.name.lower(): e.name for e in entities}
    # Also map partial last-name or first-name matches for multi-word entities
    for e in entities:
        parts = e.name.split()
        if len(parts) > 1:
            for part in parts:
                # Only add if unambiguous (not already mapped to a different entity)
                lower_part = part.lower()
                if lower_part not in entity_map:
                    entity_map[lower_part] = e.name

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


def filter_to_known_entities(relationships: List[Relationship], entities: List[ExtractedEntity]) -> List[Relationship]:
    """Drop relationships where subject or object is not a known entity.

    This is the strict gate: after resolve_to_entities has done its best to map
    names, any relationship that still references an unknown entity is dropped.
    """
    if not entities:
        return relationships

    known = {e.name.lower() for e in entities}

    filtered = []
    for rel in relationships:
        if rel.subject.lower() in known and rel.object.lower() in known:
            filtered.append(rel)

    return filtered


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
        final_rels = filter_to_known_entities(final_rels, entities)
        return ExtractRelationshipsResponse(
            relationships=deduplicate_relationships(final_rels),
            source_content_hash=str(hash(content))[:12],
            used_fallback=True,
        )

    # Use LLM for richer extraction
    try:
        if entities:
            entity_list = "\n".join([f'- "{e.name}" ({e.type or "unknown"})' for e in entities])
        else:
            entity_list = "(none provided)"

        # Build predicate guidance for prompt
        if request.valid_predicates:
            predicate_list = ', '.join(request.valid_predicates)
            predicate_guidance = f"\nPreferred predicates (use these when applicable): {predicate_list}\n"
        else:
            predicate_guidance = ""

        prompt = EXTRACT_RELATIONSHIPS_PROMPT.format(
            content=content[:2000],
            entities=entity_list,
            predicate_guidance=predicate_guidance,
        )

        raw_rels = await asyncio.to_thread(
            llm_client.generate_json,
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
            final_rels = filter_to_known_entities(final_rels, entities)

            return ExtractRelationshipsResponse(
                relationships=deduplicate_relationships(final_rels),
                source_content_hash=str(hash(content))[:12],
                used_fallback=False,
            )

    except Exception as e:
        print(f"LLM relationship extraction failed: {e}")

    # Return quick results as fallback
    final_rels = resolve_to_entities(quick_rels, entities)
    final_rels = filter_to_known_entities(final_rels, entities)
    return ExtractRelationshipsResponse(
        relationships=deduplicate_relationships(final_rels),
        source_content_hash=str(hash(content))[:12],
        used_fallback=True,
    )