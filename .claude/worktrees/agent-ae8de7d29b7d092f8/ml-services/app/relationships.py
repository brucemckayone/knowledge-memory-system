"""
Relationship Extraction Endpoint
Phase 4: Extract subject-predicate-object triples from content

W26 Relationship Agent uses this to build the knowledge graph.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from .core.llm import llm_client
from .core.concurrency import llm_pool, QueueFullError
import json
import re

router = APIRouter()

EXTRACT_RELATIONSHIPS_PROMPT = """Extract ALL relationships between entities from this text. Be thorough — extract every relationship you can find.

=== ALLOWED ENTITIES ===
{entities}

=== RULES ===
1. Subject and object MUST be exact names from the ALLOWED ENTITIES list. Copy names exactly.
2. Do NOT use pronouns (I, he, she, they). Instead, figure out WHO the pronoun refers to and use their entity name.
3. Extract ALL types of relationships:
   - Explicit: "Alice works at Acme" → works_at
   - Implicit: "I walked through Petersburgh" → the speaker visited Petersburgh
   - Spatial: "the road between X and Y" → X near Y, or person traveled from X to Y
   - Social: "my dear sister" → sibling_of
   - Communication: "I write to you" → writes_to
   - Location: "arrived at Archangel" → visited / lives_in
4. Predicates must be base form (works_at, lives_in, knows, writes_to, visited, sibling_of, near).
5. Include temporal_hint: "currently" for present, "past" for past events, "future" for plans.
6. Include source_text: the exact quote supporting the relationship.
7. Confidence: 0.9+ for explicit statements, 0.7-0.9 for clear implications, 0.5-0.7 for inferences.
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
Given ALLOWED ENTITIES: ["R. Walton" (person), "Margaret" (person), "Petersburgh" (place), "Archangel" (place)]

Text: "I am already far north of London, and as I walk in the streets of Petersburgh"
-> {{"subject": "R. Walton", "predicate": "visited", "object": "Petersburgh", "confidence": 0.9, "temporal_hint": "currently", "source_text": "I walk in the streets of Petersburgh"}}

Text: "You will rejoice to hear that no disaster has accompanied my dear sister"
-> {{"subject": "R. Walton", "predicate": "sibling_of", "object": "Margaret", "confidence": 0.85, "temporal_hint": "currently", "source_text": "my dear sister"}}

Text: "I shall depart for Archangel in a fortnight"
-> {{"subject": "R. Walton", "predicate": "visited", "object": "Archangel", "confidence": 0.8, "temporal_hint": "future", "source_text": "I shall depart for Archangel"}}

Return [] ONLY if absolutely no relationships exist between the allowed entities.
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


class KnownFact(BaseModel):
    subject: str
    predicate: str
    object: str


class ExtractRelationshipsRequest(BaseModel):
    content: str
    entities: List[ExtractedEntity] = []
    valid_predicates: Optional[List[str]] = None  # Dynamic predicates from platform
    known_facts: Optional[List[KnownFact]] = None  # Prior context from RAG
    context_snippets: Optional[List[str]] = None  # Source text from similar prior memories


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


@router.post("/extract-relationships", response_model=ExtractRelationshipsResponse)
async def extract_relationships(request: ExtractRelationshipsRequest):
    """
    Extract relationships from content.

    Uses LLM for extraction, supplemented by regex pattern matching.
    Filtering/resolution of entity names is handled by the TypeScript pipeline
    (multi-tier matching: exact → substring → embedding similarity).
    """
    content = request.content
    entities = request.entities

    # Quick pattern extraction (supplementary)
    quick_rels = quick_extract(content)

    # Always use LLM for richer extraction
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

        # Include known facts context if provided
        known_facts_section = ""
        if request.known_facts:
            facts_list = "\n".join([
                f'- {f.subject} --[{f.predicate}]--> {f.object}'
                for f in request.known_facts[:20]
            ])
            known_facts_section = f"\n=== EXISTING RELATIONSHIPS (from prior documents) ===\n{facts_list}\n\nBuild on these existing relationships. Do not re-extract identical relationships.\n"

        # Add source text snippets from similar prior memories
        if request.context_snippets:
            snippets_text = "\n---\n".join(request.context_snippets[:5])
            known_facts_section += (
                f"\n=== RELATED PRIOR TEXT (from previously ingested documents) ===\n"
                f"{snippets_text}\n\n"
                "Use this context to understand entity references and relationships.\n"
            )

        prompt = EXTRACT_RELATIONSHIPS_PROMPT.format(
            content=content[:2000],
            entities=entity_list,
            predicate_guidance=predicate_guidance + known_facts_section,
        )

        raw_rels = await llm_pool.submit(
            llm_client.generate_json,
            prompt,
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

            # Combine LLM + regex results, deduplicate
            all_rels = llm_rels + quick_rels
            return ExtractRelationshipsResponse(
                relationships=deduplicate_relationships(all_rels),
                source_content_hash=str(hash(content))[:12],
                used_fallback=False,
            )

    except Exception as e:
        print(f"LLM relationship extraction failed: {e}")

    # Return quick results as fallback (no filtering — TS pipeline handles resolution)
    return ExtractRelationshipsResponse(
        relationships=deduplicate_relationships(quick_rels),
        source_content_hash=str(hash(content))[:12],
        used_fallback=True,
    )