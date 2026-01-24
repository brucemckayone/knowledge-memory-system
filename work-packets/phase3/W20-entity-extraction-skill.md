# Work Packet W20: Entity Extraction Skill

**Status:** Ready to Implement  
**Dependencies:** W08 (Skill Framework), W16 (Entity Schema), W25 (Entity Agent)  
**Estimated Time:** 2-3 hours

---

## Objective

Integrate entity extraction into the Phase 2 message processing pipeline as a skill. This bridges Phase 2 and Phase 3 by enabling automatic entity extraction for every incoming memory.

---

## Research Reference

From [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md) lines 107-138:
- Extract entities during ingestion
- Entity types: person, company, project, concept, place, event
- Store entity-memory links

---

## Implementation

### Entity Extraction Skill

Create `platform/src/skills/extract-entities.ts`:

```typescript
import { Skill, SkillContext, SkillResult } from './types.js';
import { config } from '../config.js';

export interface ExtractedEntity {
  mention: string;
  type: 'person' | 'company' | 'project' | 'concept' | 'place' | 'event' | 'other';
  startIndex: number;
  endIndex: number;
  confidence: number;
}

export interface ExtractEntitiesInput {
  text: string;
  memoryId: string;
}

export interface ExtractEntitiesOutput {
  entities: ExtractedEntity[];
  linkedCount: number;
}

export const extractEntitiesSkill: Skill<ExtractEntitiesInput, ExtractEntitiesOutput> = {
  name: 'extract-entities',
  description: 'Extract and link entities from text to memory',
  
  async execute(
    input: ExtractEntitiesInput,
    context: SkillContext
  ): Promise<SkillResult<ExtractEntitiesOutput>> {
    const startTime = Date.now();
    
    try {
      // Call Python ML service for entity extraction
      const response = await fetch(`${config.ML_SERVICES_URL}/extract-entities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input.text }),
      });
      
      if (!response.ok) {
        throw new Error(`Entity extraction failed: ${response.status}`);
      }
      
      const data = await response.json();
      const entities: ExtractedEntity[] = data.entities || [];
      
      // Link entities to memory
      const { linkEntitiesToMemory } = await import('../services/entities.js');
      const linkedCount = await linkEntitiesToMemory(input.memoryId, entities);
      
      context.logger.info(`Extracted ${entities.length} entities, linked ${linkedCount}`);
      
      return {
        success: true,
        data: { entities, linkedCount },
        metrics: {
          durationMs: Date.now() - startTime,
          entityCount: entities.length,
        },
      };
      
    } catch (error) {
      context.logger.error('Entity extraction failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        metrics: { durationMs: Date.now() - startTime },
      };
    }
  },
};
```

### Register Skill

Update `platform/src/skills/registry.ts`:

```typescript
import { extractEntitiesSkill } from './extract-entities.js';

// In skill registry initialization
registry.register(extractEntitiesSkill);
```

### Update Message Processor

Add entity extraction to memory workflow in `platform/src/services/message-processor.ts`:

```typescript
// After storing memory
if (storedMemory?.id) {
  // Queue entity extraction (non-blocking)
  skillContext.runAsync('extract-entities', {
    text: content,
    memoryId: storedMemory.id,
  });
}
```

---

## Verification

### Automated Tests
Run simple unit tests for extraction skill.

```bash
# Create platform/src/skills/__tests__/extract-entities.test.ts
import { extractEntitiesSkill } from '../extract-entities.js';
import { describe, it, expect, vi } from 'vitest';

describe('Entity Extraction Skill', () => {
  it('should extract entities', async () => {
     // Mock fetch to ML service
     global.fetch = vi.fn().mockResolvedValue({
       ok: true,
       json: async () => ({ entities: [] })
     });
     // Assert execution result
  });
});
```

### Manual Verification
```bash
# Test skill directly
curl -X POST http://localhost:3001/api/test-skill \
  -H "Content-Type: application/json" \
  -d '{
    "skill": "extract-entities",
    "input": {
      "text": "Meeting with John about the Alpha project",
      "memoryId": "test-123"
    }
  }'
```

---

## Acceptance Criteria

- [ ] Skill registered in registry
- [ ] Extracts entities from text
- [ ] Links entities to memory
- [ ] Non-blocking execution in pipeline
- [ ] Metrics logged

---

## Next Packet

- [W22: Ingestion Agent](./W22-ingestion-agent.md) - Full KARMA ingestion
