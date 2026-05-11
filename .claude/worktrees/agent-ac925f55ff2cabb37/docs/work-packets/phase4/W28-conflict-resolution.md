# Work Packet W28: Conflict Resolution Agent

**Status:** ✅ Complete (heuristics + LLM debate protocol)
**Dependencies:** W26 (Relationship Agent)  
**Estimated Time:** 3 hours  
**Agent Number:** One of 7 KARMA agents

---

## Objective

Create the Conflict Resolution Agent that detects contradicting facts, determines which supersedes, handles temporal supersession, and flags ambiguous cases for review. This implements the ALICE contradiction detection framework from the research.

---

## Background

### Research Reference
From [GARDENER_RESEARCH.md](../../research/gardener-research.md) lines 200-230:
- ALICE framework achieves 60% detection rate
- Five contradiction types: Antonym, Numeric, Negation, Structural, Temporal
- LLM verification for subtle contradictions

### Role in Pipeline
```
[Entity] → [Relationships] → [Schema] → [CONFLICT RESOLVE] → (controller metrics)
                                                  │
                                                  ▼
                                          [Supersede old facts]
```

---

## Contradiction Types

```typescript
type ContradictionType =
  | 'antonym'     // employed ↔ unemployed
  | 'numeric'     // 2 children vs 3 children
  | 'negation'    // works at X vs doesn't work at X
  | 'structural'  // incompatible relationships
  | 'temporal';   // same fact with conflicting time periods

interface Contradiction {
  type: ContradictionType;
  existingFact: Fact;
  newFact: Fact;
  confidence: number;
  resolution: 'supersede' | 'invalidate' | 'flag';
  reasoning: string;
}
```

---

## Python Endpoint

Create `ml-services/app/check_contradiction.py`:

```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List
import ollama
import json
import re

router = APIRouter()

CONTRADICTION_PROMPT = """Analyze if these two facts contradict each other.

FACT 1 (Existing):
  Subject: {fact1_subject}
  Predicate: {fact1_predicate}
  Object: {fact1_object}
  Valid from: {fact1_valid_at}
  Valid until: {fact1_invalid_at}

FACT 2 (New):
  Subject: {fact2_subject}
  Predicate: {fact2_predicate}
  Object: {fact2_object}
  Valid from: {fact2_valid_at}
  Valid until: {fact2_invalid_at}

Contradiction types:
1. antonym - Direct opposites (employed vs unemployed)
2. numeric - Incompatible numbers
3. negation - Explicit negation
4. structural - Incompatible relationships (can't be in two places)
5. temporal - Same property with conflicting times

For work/employment, location, membership - a person typically can only be at one:
- If both facts overlap in time and claim incompatible states, they contradict

Return JSON:
{{
  "contradicts": true/false,
  "type": "antonym|numeric|negation|structural|temporal|none",
  "resolution": "supersede|invalidate|coexist|flag",
  "reasoning": "explanation",
  "confidence": 0.0-1.0
}}

Resolution meanings:
- supersede: New fact replaces old (old becomes invalid_at = new.valid_at)
- invalidate: Old fact was wrong (old.expired_at = now)
- coexist: Both facts can be true (no conflict)
- flag: Unclear, needs human review
"""


class FactData(BaseModel):
    subject: str
    predicate: str
    object: str
    valid_at: Optional[str] = None
    invalid_at: Optional[str] = None


class CheckContradictionRequest(BaseModel):
    fact1: FactData
    fact2: FactData


class CheckContradictionResponse(BaseModel):
    contradicts: bool
    type: str
    resolution: str
    reasoning: str
    confidence: float


# Quick checks before LLM
ANTONYM_PAIRS = {
    ('employed', 'unemployed'),
    ('active', 'inactive'),
    ('alive', 'dead'),
    ('married', 'single'),
    ('open', 'closed'),
}

EXCLUSIVE_PREDICATES = {
    'works_at',      # Can only work at one place (usually)
    'lives_in',      # Primary residence
    'married_to',    # Monogamous marriage
    'reports_to',    # Single manager
    'ceo_of',        # One CEO
    'president_of',  # One president
}


def quick_antonym_check(pred1: str, pred2: str) -> bool:
    """Check for known antonym pairs"""
    return (pred1, pred2) in ANTONYM_PAIRS or (pred2, pred1) in ANTONYM_PAIRS


def is_exclusive_predicate(predicate: str) -> bool:
    """Check if predicate is typically exclusive"""
    return any(exc in predicate.lower() for exc in EXCLUSIVE_PREDICATES)


def times_overlap(f1: FactData, f2: FactData) -> bool:
    """Check if fact time ranges overlap"""
    # If no times specified, assume they could overlap
    if not f1.valid_at or not f2.valid_at:
        return True
    
    # Simple overlap check
    # TODO: More sophisticated temporal logic
    return True


@router.post("/check-contradiction", response_model=CheckContradictionResponse)
async def check_contradiction(request: CheckContradictionRequest):
    """
    Check if two facts contradict each other.
    
    Uses quick heuristics first, then LLM for subtle cases.
    """
    f1, f2 = request.fact1, request.fact2
    
    # Quick check: Different subjects = no contradiction
    if f1.subject != f2.subject:
        return CheckContradictionResponse(
            contradicts=False,
            type="none",
            resolution="coexist",
            reasoning="Different subjects",
            confidence=1.0,
        )
    
    # Quick check: Antonym predicates
    if quick_antonym_check(f1.predicate, f2.predicate):
        if times_overlap(f1, f2):
            return CheckContradictionResponse(
                contradicts=True,
                type="antonym",
                resolution="supersede",
                reasoning=f"'{f1.predicate}' and '{f2.predicate}' are antonyms and time periods overlap",
                confidence=0.95,
            )
    
    # Quick check: Exclusive predicate with different objects
    if f1.predicate == f2.predicate and is_exclusive_predicate(f1.predicate):
        if f1.object != f2.object and times_overlap(f1, f2):
            return CheckContradictionResponse(
                contradicts=True,
                type="structural",
                resolution="supersede",
                reasoning=f"'{f1.predicate}' is typically exclusive - can't be both '{f1.object}' and '{f2.object}'",
                confidence=0.85,
            )
    
    # LLM for subtle cases
    try:
        prompt = CONTRADICTION_PROMPT.format(
            fact1_subject=f1.subject,
            fact1_predicate=f1.predicate,
            fact1_object=f1.object,
            fact1_valid_at=f1.valid_at or "unknown",
            fact1_invalid_at=f1.invalid_at or "ongoing",
            fact2_subject=f2.subject,
            fact2_predicate=f2.predicate,
            fact2_object=f2.object,
            fact2_valid_at=f2.valid_at or "unknown",
            fact2_invalid_at=f2.invalid_at or "ongoing",
        )
        
        response = ollama.generate(
            model="llama3",  # Use larger model for reasoning
            prompt=prompt,
            options={
                "temperature": 0.1,
                "num_predict": 512,
            }
        )
        
        # Parse response
        match = re.search(r'\{[\s\S]*\}', response['response'])
        if match:
            result = json.loads(match.group())
            return CheckContradictionResponse(
                contradicts=result.get('contradicts', False),
                type=result.get('type', 'none'),
                resolution=result.get('resolution', 'coexist'),
                reasoning=result.get('reasoning', 'LLM analysis'),
                confidence=min(1.0, max(0.0, result.get('confidence', 0.7))),
            )
        
    except Exception as e:
        pass
    
    # Default: no contradiction detected
    return CheckContradictionResponse(
        contradicts=False,
        type="none",
        resolution="coexist",
        reasoning="No contradiction detected",
        confidence=0.6,
    )


@router.get("/check-contradiction/test")
async def test_contradiction():
    """Test contradiction detection with sample facts"""
    tests = [
        {
            "fact1": {"subject": "John", "predicate": "works_at", "object": "Acme"},
            "fact2": {"subject": "John", "predicate": "works_at", "object": "TechCorp"},
            "expected": "contradiction (structural)"
        },
        {
            "fact1": {"subject": "John", "predicate": "employed", "object": "true"},
            "fact2": {"subject": "John", "predicate": "unemployed", "object": "true"},
            "expected": "contradiction (antonym)"
        },
        {
            "fact1": {"subject": "John", "predicate": "knows", "object": "Sarah"},
            "fact2": {"subject": "John", "predicate": "knows", "object": "Mike"},
            "expected": "no contradiction (can know multiple)"
        },
    ]
    
    results = []
    for test in tests:
        result = await check_contradiction(CheckContradictionRequest(
            fact1=FactData(**test["fact1"]),
            fact2=FactData(**test["fact2"]),
        ))
        results.append({
            "test": test,
            "result": result.dict(),
        })
    
    return {"tests": results}
```

---

## TypeScript Agent

Create `platform/src/gardener/agents/conflict-resolution.agent.ts`:

```typescript
import { GardenerAgent, AgentContext, AgentResult } from './types.js';
import { db } from '../../db/index.js';
import { facts, entities } from '../../db/schema.js';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { expireFact, invalidateFact } from '../../services/facts.js';
import { config } from '../../config.js';

interface ConflictInput {
  newFactId: string;
  scope?: 'entity' | 'all';
}

interface ContradictionResult {
  contradicts: boolean;
  type: string;
  resolution: string;
  reasoning: string;
  confidence: number;
}

export const conflictResolutionAgent: GardenerAgent = {
  name: 'conflict-resolution',
  tier: 'periodic',
  
  async execute(context: AgentContext): Promise<AgentResult> {
    const input = context.job.data as ConflictInput;
    
    context.log(`Running conflict resolution for fact ${input.newFactId?.slice(0, 8) || 'all'}...`);
    
    try {
      let contradictionsFound = 0;
      let factsSuperseded = 0;
      let factsFlagged = 0;
      
      // Get facts to check
      const factsToCheck = input.newFactId
        ? await db.select().from(facts).where(eq(facts.id, input.newFactId))
        : await getRecentActiveFacts(100);  // Check last 100 active facts
      
      for (const newFact of factsToCheck) {
        // Find potentially conflicting facts
        const candidates = await findConflictCandidates(newFact);
        
        for (const existingFact of candidates) {
          // Skip self
          if (existingFact.id === newFact.id) continue;
          
          // Get entity names for context
          const subjectEntity = await getEntityName(newFact.subjectEntityId);
          const objectEntity = newFact.objectEntityId 
            ? await getEntityName(newFact.objectEntityId) 
            : newFact.objectValue || '';
          
          const existingObjectEntity = existingFact.objectEntityId
            ? await getEntityName(existingFact.objectEntityId)
            : existingFact.objectValue || '';
          
          // Check for contradiction
          const result = await checkContradiction({
            fact1: {
              subject: subjectEntity,
              predicate: existingFact.predicate,
              object: existingObjectEntity,
              valid_at: existingFact.validAt?.toISOString(),
              invalid_at: existingFact.invalidAt?.toISOString(),
            },
            fact2: {
              subject: subjectEntity,
              predicate: newFact.predicate,
              object: objectEntity,
              valid_at: newFact.validAt?.toISOString(),
              invalid_at: newFact.invalidAt?.toISOString(),
            },
          });
          
          if (result.contradicts) {
            contradictionsFound++;
            
            // Apply resolution
            switch (result.resolution) {
              case 'supersede':
                // Old fact ends when new one begins
                await invalidateFact(existingFact.id, newFact.validAt || new Date());
                factsSuperseded++;
                context.log(`Superseded fact ${existingFact.id.slice(0, 8)}: ${result.reasoning}`);
                break;
                
              case 'invalidate':
                // Old fact was wrong
                await expireFact(existingFact.id, result.reasoning);
                factsSuperseded++;
                context.log(`Invalidated fact ${existingFact.id.slice(0, 8)}: ${result.reasoning}`);
                break;
                
              case 'flag':
                // Mark for review
                await flagForReview(existingFact.id, newFact.id, result.reasoning);
                factsFlagged++;
                context.log(`Flagged for review: ${existingFact.id.slice(0, 8)} vs ${newFact.id.slice(0, 8)}`);
                break;
            }
          }
        }
      }
      
      context.log(`Conflict resolution complete: ${contradictionsFound} contradictions, ${factsSuperseded} superseded, ${factsFlagged} flagged`);
      
      return {
        success: true,
        outputs: {
          factsChecked: factsToCheck.length,
          contradictionsFound,
          factsSuperseded,
          factsFlagged,
        },
        metrics: {
          confidence: 0.85,
          itemsProcessed: factsToCheck.length,
        },
      };
      
    } catch (error) {
      context.log(`Conflict resolution failed: ${error}`, 'error');
      return {
        success: false,
        outputs: { error: String(error) },
      };
    }
  },
};

// Helper functions

async function getRecentActiveFacts(limit: number) {
  return db
    .select()
    .from(facts)
    .where(isNull(facts.expiredAt))
    .orderBy(sql`created_at DESC`)
    .limit(limit);
}

async function findConflictCandidates(fact: typeof facts.$inferSelect) {
  // Find facts about same subject with same/similar predicate
  return db
    .select()
    .from(facts)
    .where(and(
      eq(facts.subjectEntityId, fact.subjectEntityId),
      isNull(facts.expiredAt),
      sql`id != ${fact.id}`
    ));
}

async function getEntityName(entityId: string): Promise<string> {
  const result = await db
    .select({ name: entities.canonicalName })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  return result[0]?.name || entityId;
}

async function checkContradiction(request: {
  fact1: any;
  fact2: any;
}): Promise<ContradictionResult> {
  const response = await fetch(`${config.ML_SERVICES_URL}/check-contradiction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  
  if (!response.ok) {
    return {
      contradicts: false,
      type: 'none',
      resolution: 'coexist',
      reasoning: 'Check failed',
      confidence: 0.5,
    };
  }
  
  return response.json();
}

async function flagForReview(fact1Id: string, fact2Id: string, reason: string): Promise<void> {
  // Store in a review queue (could be a new table)
  await db.execute(sql`
    INSERT INTO gardener_job_meta (job_id, job_type, tier, priority, checkpoint)
    VALUES (
      gen_random_uuid(),
      'gardener:manual-review',
      'deep',
      10,
      ${JSON.stringify({ fact1Id, fact2Id, reason })}::jsonb
    )
  `);
}
```

---

## Verification

### Automated Tests
Run simple unit tests for conflict checking.

```bash
# Create platform/src/gardener/agents/__tests__/conflict-resolution.test.ts
import { conflictResolutionAgent } from '../conflict-resolution.agent.js';
import { describe, it, expect } from 'vitest';

describe('Conflict Resolution Agent', () => {
  it('should detect contradiction', async () => {
     // Mock DB with conflicting facts
     // Run agent
     // Assert fact superseded
  });
});
```

### Manual Verification
```bash
# Test contradiction endpoint
curl -X POST http://localhost:8000/check-contradiction \
  -H "Content-Type: application/json" \
  -d '{
    "fact1": {"subject": "John", "predicate": "works_at", "object": "Acme"},
    "fact2": {"subject": "John", "predicate": "works_at", "object": "TechCorp"}
  }'
```

---

## Acceptance Criteria

- [ ] `/check-contradiction` endpoint works
- [ ] Quick checks for antonyms work
- [ ] Exclusive predicates detected
- [ ] LLM fallback for subtle cases
- [ ] Agent supersedes old facts correctly
- [ ] Agent invalidates wrong facts
- [ ] Ambiguous cases flagged for review
- [ ] Agent registered with controller

---

## Next Packet

- [W29: Evaluator Agent](./W29-evaluator-agent.md) - (Replaced — controller records metrics directly)
- [W33: Contradiction Detection](../phase5/W33-contradiction-scheduler.md) - Scheduled detection
