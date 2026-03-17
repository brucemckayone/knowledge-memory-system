# Work Packet W26: Relationship Extraction Agent

**Status:** ✅ Complete
**Dependencies:** W25 (Entity Extraction), W17 (Bi-Temporal Facts)  
**Estimated Time:** 3-4 hours

---

## Objective

Implement the Relationship Extraction Agent that identifies relationships between entities and creates bi-temporal facts in the knowledge graph.

---

## Research Reference

From [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md) lines 158-180:
- Extract relationships as subject-predicate-object triples
- Bi-temporal validity tracking
- Confidence scoring

---

## Implementation

### Python Endpoint

Add to `ml-services/main.py`:

```python
@app.post("/extract-relationships")
async def extract_relationships(request: dict):
    """Extract relationships between entities"""
    content = request.get("content", "")
    entities = request.get("entities", [])
    
    entity_list = ", ".join([f"{e['mention']} ({e['type']})" for e in entities])
    
    prompt = f"""Extract relationships between entities in this text.

Entities found: {entity_list}

Text: {content[:2000]}

For each relationship, provide:
- subject: the entity doing the action
- predicate: the relationship type (use: works_at, manages, created, knows, located_in, part_of, attended, mentioned, discussed)
- object: the entity receiving the action
- confidence: 0.0-1.0
- temporal_hint: any time reference for this relationship (or null)

Return JSON array of relationships.
Respond ONLY with valid JSON array."""

    response = ollama.chat(
        model="llama3:8b",
        messages=[{"role": "user", "content": prompt}],
        format="json"
    )
    
    try:
        relationships = json.loads(response["message"]["content"])
        if isinstance(relationships, dict):
            relationships = relationships.get("relationships", [])
        return {"relationships": relationships}
    except json.JSONDecodeError:
        return {"relationships": []}
```

### Agent Implementation

Create `platform/src/gardener/agents/relationship-agent.ts`:

```typescript
import { GardenerAgent, AgentContext, AgentResult } from './types.js';
import { config } from '../../config.js';
import { createFact } from '../../services/facts.js';

export interface RelationshipJob {
  memoryId: string;
  content: string;
  entities: Array<{
    entityId: string;
    mention: string;
    type: string;
  }>;
}

export interface ExtractedRelationship {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  temporalHint?: string;
}

export interface RelationshipResult {
  extracted: number;
  stored: number;
  duplicatesSkipped: number;
}

export const relationshipAgent: GardenerAgent<RelationshipJob, RelationshipResult> = {
  name: 'relationship-extraction',
  tier: 'nearterm',
  
  async process(
    job: RelationshipJob,
    context: AgentContext
  ): Promise<AgentResult<RelationshipResult>> {
    const startTime = Date.now();
    context.logger.info(`Extracting relationships for memory ${job.memoryId}`);
    
    try {
      // Call Python service for relationship extraction
      const response = await fetch(`${config.ML_SERVICES_URL}/extract-relationships`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: job.content,
          entities: job.entities,
        }),
      });
      
      if (!response.ok) {
        throw new Error(`Relationship extraction failed: ${response.status}`);
      }
      
      const data = await response.json();
      const relationships: ExtractedRelationship[] = data.relationships || [];
      
      let stored = 0;
      let duplicatesSkipped = 0;
      
      for (const rel of relationships) {
        // Resolve entity references
        const subjectEntity = job.entities.find(e => 
          e.mention.toLowerCase() === rel.subject.toLowerCase()
        );
        const objectEntity = job.entities.find(e => 
          e.mention.toLowerCase() === rel.object.toLowerCase()
        );
        
        if (!subjectEntity || !objectEntity) {
          context.logger.debug(`Skipping unresolved: ${rel.subject} -> ${rel.object}`);
          continue;
        }
        
        // Create fact
        try {
          const validAt = parseTemporalHint(rel.temporalHint);
          
          await createFact({
            subjectEntityId: subjectEntity.entityId,
            predicate: normalizePredicate(rel.predicate),
            objectEntityId: objectEntity.entityId,
            objectLiteral: null,
            confidence: rel.confidence,
            sourceMemoryId: job.memoryId,
            validAt,
          });
          
          stored++;
        } catch (error: any) {
          if (error.message?.includes('duplicate')) {
            duplicatesSkipped++;
          } else {
            throw error;
          }
        }
      }
      
      // Queue conflict check if we stored new facts
      if (stored > 0) {
        await context.queueJob('conflict-resolution', {
          memoryId: job.memoryId,
          factCount: stored,
        });
      }
      
      return {
        success: true,
        data: {
          extracted: relationships.length,
          stored,
          duplicatesSkipped,
        },
        metrics: {
          durationMs: Date.now() - startTime,
          extracted: relationships.length,
          stored,
        },
      };
      
    } catch (error) {
      context.logger.error('Relationship extraction failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        metrics: { durationMs: Date.now() - startTime },
      };
    }
  },
};

/**
 * Normalize predicate to standard form
 */
function normalizePredicate(predicate: string): string {
  const normalized = predicate.toLowerCase().replace(/\s+/g, '_');
  
  const aliases: Record<string, string> = {
    'works_for': 'works_at',
    'employed_by': 'works_at',
    'runs': 'manages',
    'leads': 'manages',
    'made': 'created',
    'built': 'created',
    'met': 'knows',
    'talked_to': 'knows',
    'in': 'located_in',
    'at': 'located_in',
  };
  
  return aliases[normalized] || normalized;
}

/**
 * Parse temporal hint to date
 */
function parseTemporalHint(hint?: string): Date | null {
  if (!hint) return null;
  
  const now = new Date();
  const lower = hint.toLowerCase();
  
  if (lower === 'today') return now;
  if (lower === 'yesterday') {
    return new Date(now.setDate(now.getDate() - 1));
  }
  if (lower.includes('last week')) {
    return new Date(now.setDate(now.getDate() - 7));
  }
  
  // Try ISO date parse
  const parsed = new Date(hint);
  return isNaN(parsed.getTime()) ? null : parsed;
}
```

---

## Verification

### Automated Tests
Run simple unit tests for relationship extraction.

```bash
# Create platform/src/gardener/agents/__tests__/relationship.test.ts
import { relationshipAgent } from '../relationship-agent.js';
import { describe, it, expect } from 'vitest';

describe('Relationship Agent', () => {
  it('should normalize predicates', () => {
    // Test predicate normalization
  });
});
```

### Manual Verification
```bash
# Test relationship extraction
curl -X POST http://localhost:5001/extract-relationships \
  -H "Content-Type: application/json" \
  -d '{
    "content": "John works at Acme Corp. He manages the Alpha project.",
    "entities": [
      {"mention": "John", "type": "person"},
      {"mention": "Acme Corp", "type": "company"},
      {"mention": "Alpha project", "type": "project"}
    ]
  }'
```

---

## Acceptance Criteria

- [ ] Relationships extracted from text
- [ ] Entity references resolved
- [ ] Facts created with bi-temporal tracking
- [ ] Predicates normalized
- [ ] Duplicates detected and skipped
- [ ] Conflict resolution queued

---

## Next Packet

- [W27: Schema Alignment Agent](./W27-schema-agent.md) - Normalize predicates
