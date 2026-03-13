# Work Packet W25: Entity Extraction Agent

**Status:** Ready to Implement  
**Dependencies:** W21 (Central Controller)  
**Estimated Time:** 3 hours  
**Agent Number:** 5 of 9

---

## Objective

Create the Entity Extraction Agent that uses LLM-based NER to extract named entities from text, classify them by type, and resolve them to canonical forms with deduplication.

---

## Background

### Research Reference
From [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md) lines 494-500:
- Agent 5: Entity Extraction - LLM-based NER with ontology filtering
- Achieves 87% F1 on entity resolution benchmarks
- Three-stage pipeline: blocking → similarity → LLM verification

### Role in Pipeline
```
[2.Ingestion] → [3.Reader] → [4.Summarizer] → [5.ENTITY EXTRACT] → [6.Relationships]
                                                      │
                                                      ▼
                                              [7.Schema Align]
```

---

## Architecture

### Entity Types

```typescript
type EntityType = 
  | 'person'    // John Smith, Dr. Jane Doe
  | 'company'   // Acme Corp, Google
  | 'project'   // Project X, Alpha Initiative
  | 'concept'   // Machine Learning, Agile
  | 'place'     // San Francisco, Building 4
  | 'event'     // All Hands 2026, Q4 Review
  | 'other';    // Fallback
```

### Extraction Result

```typescript
interface ExtractedEntity {
  mention: string;         // Original text: "J. Smith"
  canonicalName: string;   // Resolved: "John Smith"
  type: EntityType;
  properties: Record<string, unknown>;
  position: { start: number; end: number };
  confidence: number;
}
```

---

## Python Endpoint

Create `ml-services/app/extract_entities.py`:

```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
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
        for e in entities_raw:
            # Validate type
            valid_types = ['person', 'company', 'project', 'concept', 'place', 'event', 'other']
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
            model="llama3",  # Use larger model for resolution
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
        "entities": [e.dict() for e in result.entities],
    }
```

---

## TypeScript Agent

Create `platform/src/gardener/agents/entity-extraction.agent.ts`:

```typescript
import { GardenerAgent, AgentContext, AgentResult } from './types.js';
import { db } from '../../db/index.js';
import { resolveEntity, linkMemoryToEntity, createEntity } from '../../services/entities.js';
import { config } from '../../config.js';

interface ExtractedEntity {
  mention: string;
  type: string;
  properties: Record<string, unknown>;
  start: number;
  end: number;
  confidence: number;
}

interface ExtractionInput {
  memoryId: string;
  text: string;
}

export const entityExtractionAgent: GardenerAgent = {
  name: 'entity-extraction',
  tier: 'realtime',
  
  async execute(context: AgentContext): Promise<AgentResult> {
    const input = context.job.data as ExtractionInput;
    const { memoryId, text } = input;
    
    context.log(`Extracting entities from memory ${memoryId.slice(0, 8)}...`);
    
    try {
      // Call Python extraction endpoint
      const response = await fetch(`${config.ML_SERVICES_URL}/extract-entities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      
      if (!response.ok) {
        throw new Error(`Extraction failed: ${response.statusText}`);
      }
      
      const result = await response.json() as { entities: ExtractedEntity[] };
      
      context.log(`Found ${result.entities.length} entity mentions`);
      
      // Process each entity
      const resolvedEntities: string[] = [];
      const newEntities: string[] = [];
      
      for (const entity of result.entities) {
        // Resolve to canonical entity
        const resolved = await resolveEntity(
          entity.mention,
          text,  // Full text as context
          entity.type as any
        );
        
        // Link memory to entity
        await linkMemoryToEntity(memoryId, resolved.id, {
          text: entity.mention,
          start: entity.start,
          end: entity.end,
          relationship: 'mentions',
        });
        
        resolvedEntities.push(resolved.id);
        if (resolved.isNew) {
          newEntities.push(resolved.id);
        }
      }
      
      context.log(`Resolved ${resolvedEntities.length} entities (${newEntities.length} new)`);
      
      return {
        success: true,
        outputs: {
          memoryId,
          entityCount: resolvedEntities.length,
          newEntityCount: newEntities.length,
          entityIds: resolvedEntities,
        },
        // Queue relationship extraction for new entities
        nextJobs: newEntities.length > 0 ? [{
          type: 'gardener:extract-relationships',
          tier: 'frequent',
          payload: { memoryId, entityIds: resolvedEntities },
        }] : undefined,
        metrics: {
          confidence: result.entities.reduce((sum, e) => sum + e.confidence, 0) / (result.entities.length || 1),
          itemsProcessed: result.entities.length,
        },
      };
      
    } catch (error) {
      context.log(`Entity extraction failed: ${error}`, 'error');
      return {
        success: false,
        outputs: { error: String(error) },
      };
    }
  },
};
```

---

## Integration with Message Processor

Update `platform/src/workers/message-processor.ts` to queue entity extraction:

```typescript
import { getController } from '../gardener/controller.js';

// After storing memory, queue entity extraction
const controller = getController();
await controller.enqueue({
  type: 'gardener:extract-entities',
  tier: 'realtime',
  payload: {
    memoryId: envelope.trace_id,
    text: textToEmbed,
  },
});
```

---

## Register Agent

Update `platform/src/gardener/agents/index.ts`:

```typescript
import { entityExtractionAgent } from './entity-extraction.agent.js';
import { GardenerController } from '../controller.js';

export async function registerGardenerAgents(controller: GardenerController): Promise<void> {
  // Agent 5: Entity Extraction
  controller.registerHandler('gardener:extract-entities', async (job) => {
    return entityExtractionAgent.execute({ job, services: getServices() });
  });
  
  // ... other agents
  
  console.log('✅ All Gardener agents registered');
}
```

---

## Verification

### Automated Tests
Run simple unit tests for extraction agent.

```bash
# Create platform/src/gardener/agents/__tests__/entity-extraction.test.ts
import { entityExtractionAgent } from '../entity-extraction.agent.js';
import { describe, it, expect, vi } from 'vitest';

describe('Entity Extraction Agent', () => {
  it('should consume job and call service', async () => {
     // Mock context and services
     // Assert outputs
  });
});
```

### Manual Verification
```bash
# Test extraction endpoint
curl -X POST http://localhost:8000/extract-entities \
  -H "Content-Type: application/json" \
  -d '{
    "text": "John Smith from Acme Corp met with Dr. Sarah Chen to discuss the Alpha Project."
  }'
```

---

## Acceptance Criteria

- [ ] `/extract-entities` Python endpoint works
- [ ] `/resolve-entity` Python endpoint works
- [ ] Agent registered with controller
- [ ] Entity extraction queued on message save
- [ ] Entities resolved to canonical forms
- [ ] Memory-entity links created
- [ ] New entities trigger relationship extraction
- [ ] Confidence metrics tracked

---

## Next Packet

- [W26: Relationship Extraction Agent](./W26-relationship-agent.md) - Extract relations between entities
- [W27: Schema Alignment Agent](./W27-schema-alignment.md) - Map to ontology
