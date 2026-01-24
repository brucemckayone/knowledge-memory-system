# Work Packet W33: Scheduled Contradiction Detection

**Status:** Ready to Implement  
**Dependencies:** W28 (Conflict Resolution Agent)  
**Estimated Time:** 2-3 hours

---

## Objective

Implement scheduled contradiction detection that runs nightly to proactively identify and resolve conflicting facts in the knowledge graph that may have been missed during real-time processing.

---

## Research Reference

From [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md) lines 197-239:
- ALICE-style contradiction detection
- Proactive fact validation
- Confidence decay over time

---

## Implementation

### Contradiction Scanner

Create `platform/src/gardener/agents/contradiction-scanner.ts`:

```typescript
import { GardenerAgent, AgentContext, AgentResult } from './types.js';
import { db } from '../../db/index.js';
import { facts } from '../../db/schema.js';
import { eq, sql, isNull, and, gt } from 'drizzle-orm';
import { config } from '../../config.js';

export interface ContradictionScanJob {
  fullScan?: boolean;
  sinceHours?: number;
}

export interface ScanResult {
  factsScanned: number;
  contradictionsFound: number;
  autoResolved: number;
  flaggedForReview: number;
}

interface FactPair {
  fact1: typeof facts.$inferSelect;
  fact2: typeof facts.$inferSelect;
  type: 'temporal' | 'semantic' | 'value';
}

export const contradictionScanner: GardenerAgent<ContradictionScanJob, ScanResult> = {
  name: 'contradiction-scanner',
  tier: 'background',
  
  async process(
    job: ContradictionScanJob,
    context: AgentContext
  ): Promise<AgentResult<ScanResult>> {
    const startTime = Date.now();
    context.logger.info('Starting contradiction scan');
    
    try {
      // Get facts to scan
      const sinceHours = job.sinceHours || 24;
      const activeFacts = await getActiveFacts(job.fullScan ? null : sinceHours);
      
      let contradictionsFound = 0;
      let autoResolved = 0;
      let flaggedForReview = 0;
      
      // Group facts by subject entity for efficient comparison
      const bySubject = groupFactsBySubject(activeFacts);
      
      for (const [subjectId, subjectFacts] of bySubject.entries()) {
        const pairs = findPotentialContradictions(subjectFacts);
        
        for (const pair of pairs) {
          const isContradiction = await checkContradiction(pair);
          
          if (isContradiction) {
            contradictionsFound++;
            
            const resolution = await resolveContradiction(pair, context);
            
            if (resolution.autoResolved) {
              autoResolved++;
            } else {
              flaggedForReview++;
              await flagForReview(pair);
            }
          }
        }
      }
      
      context.logger.info(
        `Scan complete: ${activeFacts.length} facts, ${contradictionsFound} contradictions`
      );
      
      return {
        success: true,
        data: {
          factsScanned: activeFacts.length,
          contradictionsFound,
          autoResolved,
          flaggedForReview,
        },
        metrics: {
          durationMs: Date.now() - startTime,
          factsScanned: activeFacts.length,
          contradictionsFound,
        },
      };
      
    } catch (error) {
      context.logger.error('Contradiction scan failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        metrics: { durationMs: Date.now() - startTime },
      };
    }
  },
};

/**
 * Get active facts for scanning
 */
async function getActiveFacts(
  sinceHours: number | null
): Promise<Array<typeof facts.$inferSelect>> {
  const query = db
    .select()
    .from(facts)
    .where(isNull(facts.expiredAt));
  
  if (sinceHours !== null) {
    return query.where(
      and(
        isNull(facts.expiredAt),
        gt(facts.createdAt, sql`NOW() - INTERVAL '${sinceHours} hours'`)
      )
    );
  }
  
  return query.limit(10000);
}

/**
 * Group facts by subject entity
 */
function groupFactsBySubject(
  factList: Array<typeof facts.$inferSelect>
): Map<string, Array<typeof facts.$inferSelect>> {
  const grouped = new Map<string, Array<typeof facts.$inferSelect>>();
  
  for (const fact of factList) {
    const existing = grouped.get(fact.subjectEntityId) || [];
    existing.push(fact);
    grouped.set(fact.subjectEntityId, existing);
  }
  
  return grouped;
}

/**
 * Find fact pairs that might contradict
 */
function findPotentialContradictions(
  subjectFacts: Array<typeof facts.$inferSelect>
): FactPair[] {
  const pairs: FactPair[] = [];
  
  // Same predicate, different object (potential contradiction)
  const byPredicate = new Map<string, Array<typeof facts.$inferSelect>>();
  
  for (const fact of subjectFacts) {
    const predicateFacts = byPredicate.get(fact.predicate) || [];
    predicateFacts.push(fact);
    byPredicate.set(fact.predicate, predicateFacts);
  }
  
  const functionalPredicates = [
    'works_at', 'lives_in', 'born_on', 'died_on', 'founded',
    'ceo_of', 'spouse_of', 'capital_of'
  ];
  
  for (const [predicate, predicateFacts] of byPredicate.entries()) {
    if (!functionalPredicates.includes(predicate)) continue;
    if (predicateFacts.length < 2) continue;
    
    // Compare all pairs
    for (let i = 0; i < predicateFacts.length; i++) {
      for (let j = i + 1; j < predicateFacts.length; j++) {
        const fact1 = predicateFacts[i];
        const fact2 = predicateFacts[j];
        
        // Different objects = potential contradiction
        if (fact1.objectEntityId !== fact2.objectEntityId ||
            fact1.objectLiteral !== fact2.objectLiteral) {
          pairs.push({
            fact1,
            fact2,
            type: checkTemporalOverlap(fact1, fact2) ? 'temporal' : 'semantic',
          });
        }
      }
    }
  }
  
  return pairs;
}

/**
 * Check if facts temporally overlap
 */
function checkTemporalOverlap(
  fact1: typeof facts.$inferSelect,
  fact2: typeof facts.$inferSelect
): boolean {
  const v1Start = fact1.validAt?.getTime() || 0;
  const v1End = fact1.invalidAt?.getTime() || Infinity;
  const v2Start = fact2.validAt?.getTime() || 0;
  const v2End = fact2.invalidAt?.getTime() || Infinity;
  
  return v1Start < v2End && v2Start < v1End;
}

/**
 * Check if pair is truly contradictory using LLM
 */
async function checkContradiction(pair: FactPair): Promise<boolean> {
  const response = await fetch(`${config.ML_SERVICES_URL}/check-contradiction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fact1: formatFact(pair.fact1),
      fact2: formatFact(pair.fact2),
    }),
  });
  
  if (!response.ok) return false;
  
  const data = await response.json();
  return data.is_contradiction === true;
}

/**
 * Format fact for display
 */
function formatFact(fact: typeof facts.$inferSelect): string {
  const object = fact.objectEntityId || fact.objectLiteral || 'unknown';
  return `${fact.subjectEntityId} ${fact.predicate} ${object}`;
}

/**
 * Attempt to resolve contradiction
 */
async function resolveContradiction(
  pair: FactPair,
  context: AgentContext
): Promise<{ autoResolved: boolean }> {
  // Auto-resolve if one fact is clearly older/lower confidence
  if (pair.fact1.confidence && pair.fact2.confidence) {
    const diff = Math.abs(pair.fact1.confidence - pair.fact2.confidence);
    
    if (diff > 0.3) {
      // Keep higher confidence, expire lower
      const [keep, expire] = pair.fact1.confidence > pair.fact2.confidence
        ? [pair.fact1, pair.fact2]
        : [pair.fact2, pair.fact1];
      
      await db
        .update(facts)
        .set({ 
          expiredAt: new Date(),
          supersededBy: keep.id,
        })
        .where(eq(facts.id, expire.id));
      
      context.logger.info(`Auto-resolved: kept ${keep.id}, expired ${expire.id}`);
      return { autoResolved: true };
    }
  }
  
  // Cannot auto-resolve
  return { autoResolved: false };
}

/**
 * Flag fact pair for human review
 */
async function flagForReview(pair: FactPair): Promise<void> {
  await db.execute(sql`
    INSERT INTO contradiction_reviews (fact1_id, fact2_id, status, created_at)
    VALUES (${pair.fact1.id}, ${pair.fact2.id}, 'pending', NOW())
    ON CONFLICT (fact1_id, fact2_id) DO NOTHING
  `);
}
```

### Schema Addition

Create `platform/src/db/migrations/012_contradiction_reviews.sql`:

```sql
CREATE TABLE IF NOT EXISTS contradiction_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact1_id UUID NOT NULL REFERENCES facts(id),
  fact2_id UUID NOT NULL REFERENCES facts(id),
  status TEXT NOT NULL DEFAULT 'pending', -- pending, resolved, dismissed
  resolution TEXT,
  resolved_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(fact1_id, fact2_id)
);

CREATE INDEX idx_contradiction_reviews_status ON contradiction_reviews(status);
```

### Scheduler Configuration

Update scheduler in `platform/src/gardener/controller.ts`:

```typescript
// Schedule nightly contradiction scan at 1:00 AM
this.scheduleDaily('contradiction-scanner', '0 1 * * *', async () => {
  await this.queueJob('contradiction-scanner', {
    sinceHours: 24,
  });
});

// Weekly full scan on Sundays at 2:00 AM
this.scheduleWeekly('full-contradiction-scan', '0 2 * * 0', async () => {
  await this.queueJob('contradiction-scanner', {
    fullScan: true,
  });
});
```

---

## Testing

```bash
# Run manual scan
curl -X POST http://localhost:3001/api/gardener/queue \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "contradiction-scanner",
    "job": { "sinceHours": 168 }
  }'

# View pending reviews
psql -d cognitive -c "
  SELECT cr.*, f1.predicate, f1.object_literal
  FROM contradiction_reviews cr
  JOIN facts f1 ON cr.fact1_id = f1.id
  WHERE cr.status = 'pending';
"
```

---

## Acceptance Criteria

- [ ] Facts grouped by subject for comparison
- [ ] Potential contradictions identified
- [ ] LLM verification of contradictions
- [ ] Auto-resolution for clear cases
- [ ] Human review queue populated
- [ ] Nightly schedule configured
- [ ] Weekly full scan scheduled

---

## Summary

This completes the Phase 5 work packets. The intelligence layer provides:
- **W30**: Community detection for knowledge clustering
- **W31**: Insight generation from patterns
- **W32**: Morning briefing compilation and delivery
- **W33**: Proactive contradiction detection and resolution
