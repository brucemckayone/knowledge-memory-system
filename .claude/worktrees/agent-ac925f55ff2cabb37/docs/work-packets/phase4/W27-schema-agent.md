# Work Packet W27: Schema Alignment Agent

**Status:** ✅ Complete
**Dependencies:** W17 (Bi-Temporal Facts), W26 (Relationship Agent)  
**Estimated Time:** 2-3 hours

---

## Objective

Implement the Schema Alignment Agent that normalizes predicates to a consistent ontology, merges similar relationship types, and maintains a predicate dictionary for the knowledge graph.

---

## Research Reference

From [GARDENER_RESEARCH.md](../../research/gardener-research.md) lines 382-393:
- Background tier processing (daily)
- Normalize predicates to ontology
- Merge similar relationships

---

## Implementation

### Predicate Ontology

Create `platform/src/gardener/ontology.ts`:

```typescript
export interface PredicateDefinition {
  name: string;
  category: 'employment' | 'ownership' | 'relation' | 'location' | 'temporal' | 'creation';
  inverseOf?: string;
  aliases: string[];
  description: string;
}

export const PREDICATE_ONTOLOGY: Record<string, PredicateDefinition> = {
  works_at: {
    name: 'works_at',
    category: 'employment',
    inverseOf: 'employs',
    aliases: ['works_for', 'employed_by', 'employee_of'],
    description: 'Person is employed by organization',
  },
  manages: {
    name: 'manages',
    category: 'ownership',
    inverseOf: 'managed_by',
    aliases: ['leads', 'runs', 'heads', 'directs'],
    description: 'Person manages project or team',
  },
  created: {
    name: 'created',
    category: 'creation',
    inverseOf: 'created_by',
    aliases: ['made', 'built', 'authored', 'wrote'],
    description: 'Entity created something',
  },
  knows: {
    name: 'knows',
    category: 'relation',
    aliases: ['met', 'connected_to', 'acquainted_with'],
    description: 'Person knows another person',
  },
  located_in: {
    name: 'located_in',
    category: 'location',
    inverseOf: 'contains',
    aliases: ['in', 'at', 'based_in', 'situated_in'],
    description: 'Entity is located in place',
  },
  part_of: {
    name: 'part_of',
    category: 'ownership',
    inverseOf: 'has_part',
    aliases: ['belongs_to', 'member_of', 'component_of'],
    description: 'Entity is part of larger entity',
  },
  attended: {
    name: 'attended',
    category: 'temporal',
    aliases: ['participated_in', 'was_at', 'joined'],
    description: 'Person attended event',
  },
  mentioned: {
    name: 'mentioned',
    category: 'relation',
    aliases: ['referenced', 'talked_about', 'discussed'],
    description: 'Entity mentioned in context',
  },
};

export function findCanonicalPredicate(input: string): string | null {
  const normalized = input.toLowerCase().replace(/\s+/g, '_');
  
  // Check direct match
  if (PREDICATE_ONTOLOGY[normalized]) {
    return normalized;
  }
  
  // Check aliases
  for (const [name, def] of Object.entries(PREDICATE_ONTOLOGY)) {
    if (def.aliases.includes(normalized)) {
      return name;
    }
  }
  
  return null;
}
```

### Agent Implementation

Create `platform/src/gardener/agents/schema-agent.ts`:

```typescript
import { GardenerAgent, AgentContext, AgentResult } from './types.js';
import { db } from '../../db/index.js';
import { facts, factPredicates } from '../../db/schema.js';
import { eq, sql, isNull } from 'drizzle-orm';
import { findCanonicalPredicate, PREDICATE_ONTOLOGY } from '../ontology.js';

export interface SchemaJob {
  fullScan?: boolean;
  sinceLastRun?: boolean;
}

export interface SchemaResult {
  predicatesNormalized: number;
  newPredicatesAdded: number;
  aliasesMerged: number;
}

export const schemaAgent: GardenerAgent<SchemaJob, SchemaResult> = {
  name: 'schema-alignment',
  tier: 'background',
  
  async process(
    job: SchemaJob,
    context: AgentContext
  ): Promise<AgentResult<SchemaResult>> {
    const startTime = Date.now();
    context.logger.info('Running schema alignment');
    
    try {
      let predicatesNormalized = 0;
      let aliasesMerged = 0;
      
      // Find non-canonical predicates
      const nonCanonicalFacts = await db
        .select()
        .from(facts)
        .where(isNull(facts.expiredAt))
        .limit(1000);
      
      for (const fact of nonCanonicalFacts) {
        const canonical = findCanonicalPredicate(fact.predicate);
        
        if (canonical && canonical !== fact.predicate) {
          // Update to canonical form
          await db
            .update(facts)
            .set({ predicate: canonical })
            .where(eq(facts.id, fact.id));
          
          predicatesNormalized++;
        }
      }
      
      // Ensure all ontology predicates exist in dictionary
      const newPredicatesAdded = await syncPredicateDictionary();
      
      // Find and merge duplicate/similar predicates
      aliasesMerged = await mergeAliases();
      
      return {
        success: true,
        data: {
          predicatesNormalized,
          newPredicatesAdded,
          aliasesMerged,
        },
        metrics: {
          durationMs: Date.now() - startTime,
          predicatesNormalized,
          newPredicatesAdded,
        },
      };
      
    } catch (error) {
      context.logger.error('Schema alignment failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        metrics: { durationMs: Date.now() - startTime },
      };
    }
  },
};

/**
 * Sync predicate ontology to database
 */
async function syncPredicateDictionary(): Promise<number> {
  let added = 0;
  
  for (const [name, def] of Object.entries(PREDICATE_ONTOLOGY)) {
    const existing = await db
      .select()
      .from(factPredicates)
      .where(eq(factPredicates.name, name))
      .limit(1);
    
    if (existing.length === 0) {
      await db.insert(factPredicates).values({
        name,
        category: def.category,
        inverseOf: def.inverseOf || null,
        description: def.description,
      });
      added++;
    }
  }
  
  return added;
}

/**
 * Merge alias predicates to canonical
 */
async function mergeAliases(): Promise<number> {
  let merged = 0;
  
  for (const [canonical, def] of Object.entries(PREDICATE_ONTOLOGY)) {
    for (const alias of def.aliases) {
      const updated = await db
        .update(facts)
        .set({ predicate: canonical })
        .where(eq(facts.predicate, alias));
      
      if (updated.rowCount && updated.rowCount > 0) {
        merged += updated.rowCount;
      }
    }
  }
  
  return merged;
}
```

### Schema Addition

Add to `platform/src/db/migrations/008_fact_predicates.sql`:

```sql
-- Already in W17, but ensure index
CREATE INDEX IF NOT EXISTS idx_fact_predicates_category 
  ON fact_predicates(category);

-- Add inverse relationship support
ALTER TABLE fact_predicates 
  ADD COLUMN IF NOT EXISTS inverse_of TEXT REFERENCES fact_predicates(name);
```

---

## Verification

### Automated Tests
Run simple unit tests for schema alignment.

```bash
# Create platform/src/gardener/agents/__tests__/schema.test.ts
import { schemaAgent } from '../schema-agent.js';
import { describe, it, expect } from 'vitest';

describe('Schema Agent', () => {
  it('should find canonical predicate', () => {
     // Test predicate dictionary lookup
  });
});
```

### Manual Verification
```bash
# Run schema alignment
curl -X POST http://localhost:3001/api/gardener/queue \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "schema-alignment",
    "job": { "fullScan": true }
  }'

# Check predicate dictionary
psql -d cognitive -c "SELECT * FROM fact_predicates;"
```

---

## Acceptance Criteria

- [ ] Predicate ontology defined
- [ ] Non-canonical predicates normalized
- [ ] Dictionary synced to database
- [ ] Aliases merged correctly
- [ ] Inverse relationships tracked
- [ ] Runs on daily schedule

---

## Next Packet

- [W29: Evaluator Agent](./W29-evaluator-agent.md) - Quality metrics
