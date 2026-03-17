# Work Packet W29: Evaluator Agent

**Status:** 🔀 Replaced
**Dependencies:** W21 (Central Controller), W28 (Conflict Resolution)
**Estimated Time:** 2-3 hours

---

## Successor

The evaluator agent was **deleted** from the codebase. Its responsibilities were absorbed by:

- **Central Controller** (`controller.ts`): Quality metrics are now recorded directly by the controller in the `gardener_metrics` table after each agent job completes (see `recordJobComplete()`). Metrics include `execution_time_ms`, `success`, `quality_score`, `items_processed`, and `agent_specific_metrics`.
- **MAB scheduling was removed** entirely (migration 010 drops `mab_state` table). Scheduling now uses simple priority + tier defaults.
- The `gardener_agent_stats` database view aggregates metrics for observability (migration 012).

The evaluator agent file (`evaluator.agent.ts`) and its test (`evaluator.test.ts`) were deleted.

---

## Original Objective (Historical)

Implement the Evaluator Agent that validates agent outputs, tracks performance metrics, and adjusts Multi-Armed Bandit (MAB) weights for optimal scheduling.

---

## Research Reference

From [GARDENER_RESEARCH.md](../../research/gardener-research.md) lines 394-426:
- Continuous evaluation tier
- Track agent success rates
- Update MAB scores

---

## Implementation

### Agent Implementation

Create `platform/src/gardener/agents/evaluator-agent.ts`:

```typescript
import { GardenerAgent, AgentContext, AgentResult } from './types.js';
import { db } from '../../db/index.js';
import { gardenerMetrics, mabState } from '../../db/schema.js';
import { eq, sql, gte, and } from 'drizzle-orm';

export interface EvaluatorJob {
  agentName: string;
  jobId: string;
  result: {
    success: boolean;
    metrics: Record<string, number>;
    error?: string;
  };
  duration: number;
}

export interface EvaluatorResult {
  qualityScore: number;
  mabUpdated: boolean;
  anomalyDetected: boolean;
}

export const evaluatorAgent: GardenerAgent<EvaluatorJob, EvaluatorResult> = {
  name: 'evaluator',
  tier: 'continuous',
  
  async process(
    job: EvaluatorJob,
    context: AgentContext
  ): Promise<AgentResult<EvaluatorResult>> {
    const startTime = Date.now();
    context.logger.info(`Evaluating ${job.agentName} job ${job.jobId}`);
    
    try {
      // Calculate quality score
      const qualityScore = calculateQualityScore(job);
      
      // Record metrics
      await recordMetrics(job, qualityScore);
      
      // Update MAB state
      const mabUpdated = await updateMABScore(job.agentName, qualityScore);
      
      // Check for anomalies
      const anomalyDetected = await detectAnomalies(job.agentName, qualityScore);
      
      if (anomalyDetected) {
        context.logger.warn(`Anomaly detected for ${job.agentName}`);
        // Could trigger alert or adjust priorities
      }
      
      return {
        success: true,
        data: {
          qualityScore,
          mabUpdated,
          anomalyDetected,
        },
        metrics: {
          durationMs: Date.now() - startTime,
          qualityScore,
        },
      };
      
    } catch (error) {
      context.logger.error('Evaluator failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        metrics: { durationMs: Date.now() - startTime },
      };
    }
  },
};

/**
 * Calculate quality score for agent result
 */
function calculateQualityScore(job: EvaluatorJob): number {
  const baseScore = job.result.success ? 0.8 : 0.2;
  
  // Adjust based on duration (faster = better, up to a point)
  const expectedDuration = getExpectedDuration(job.agentName);
  const durationRatio = job.duration / expectedDuration;
  const durationModifier = durationRatio < 1 ? 0.1 : durationRatio > 2 ? -0.1 : 0;
  
  // Adjust based on metrics
  const metricsModifier = evaluateMetrics(job.agentName, job.result.metrics);
  
  return Math.max(0, Math.min(1, baseScore + durationModifier + metricsModifier));
}

/**
 * Get expected duration for agent type
 */
function getExpectedDuration(agentName: string): number {
  const expectations: Record<string, number> = {
    'ingestion': 1000,
    'reader': 2000,
    'summarizer': 3000,
    'entity-extraction': 2000,
    'relationship-extraction': 2500,
    'conflict-resolution': 1500,
    'schema-alignment': 5000,
  };
  
  return expectations[agentName] || 2000;
}

/**
 * Evaluate agent-specific metrics
 */
function evaluateMetrics(
  agentName: string,
  metrics: Record<string, number>
): number {
  switch (agentName) {
    case 'entity-extraction':
      // More entities = good, but cap it
      const entityCount = metrics.entityCount || 0;
      return entityCount > 0 ? Math.min(entityCount / 10, 0.1) : -0.05;
      
    case 'relationship-extraction':
      const stored = metrics.stored || 0;
      return stored > 0 ? 0.1 : 0;
      
    case 'summarizer':
      const summaryLength = metrics.summaryLength || 0;
      // Good summaries are 50-200 chars
      return summaryLength >= 50 && summaryLength <= 200 ? 0.1 : 0;
      
    default:
      return 0;
  }
}

/**
 * Record metrics to database
 */
async function recordMetrics(
  job: EvaluatorJob,
  qualityScore: number
): Promise<void> {
  await db.insert(gardenerMetrics).values({
    agentName: job.agentName,
    jobId: job.jobId,
    success: job.result.success,
    durationMs: job.duration,
    qualityScore,
    metrics: job.result.metrics,
    error: job.result.error || null,
    createdAt: new Date(),
  });
}

/**
 * Update MAB score with Thompson Sampling
 */
async function updateMABScore(
  agentName: string,
  qualityScore: number
): Promise<boolean> {
  const success = qualityScore >= 0.5 ? 1 : 0;
  
  await db.execute(sql`
    INSERT INTO mab_state (agent_name, alpha, beta, updated_at)
    VALUES (${agentName}, ${1 + success}, ${2 - success}, NOW())
    ON CONFLICT (agent_name) DO UPDATE
    SET alpha = mab_state.alpha + ${success},
        beta = mab_state.beta + ${1 - success},
        updated_at = NOW()
  `);
  
  return true;
}

/**
 * Detect performance anomalies
 */
async function detectAnomalies(
  agentName: string,
  currentScore: number
): Promise<boolean> {
  // Get rolling average
  const recentMetrics = await db
    .select({
      avgScore: sql<number>`AVG(quality_score)`,
      stdDev: sql<number>`STDDEV(quality_score)`,
    })
    .from(gardenerMetrics)
    .where(
      and(
        eq(gardenerMetrics.agentName, agentName),
        gte(gardenerMetrics.createdAt, sql`NOW() - INTERVAL '1 hour'`)
      )
    );
  
  if (recentMetrics.length === 0) return false;
  
  const { avgScore, stdDev } = recentMetrics[0];
  if (!avgScore || !stdDev) return false;
  
  // Anomaly if more than 2 standard deviations from mean
  return Math.abs(currentScore - avgScore) > 2 * stdDev;
}
```

### Integration with Controller

Update `platform/src/gardener/controller.ts` to automatically evaluate:

```typescript
// After agent completion
await this.queueJob('evaluator', {
  agentName: agent.name,
  jobId: result.jobId,
  result: {
    success: result.success,
    metrics: result.metrics || {},
    error: result.error,
  },
  duration: result.durationMs,
});
```

---

## Verification

### Automated Tests
Run simple unit tests for evaluator.

```bash
# Create platform/src/gardener/agents/__tests__/evaluator.test.ts
import { evaluatorAgent } from '../evaluator-agent.js';
import { describe, it, expect } from 'vitest';

describe('Evaluator Agent', () => {
  it('should calculate quality score', () => {
     // Test scoring logic
  });
});
```

### Manual Verification
```bash
# Check MAB state
psql -d cognitive -c "SELECT * FROM mab_state;"

# View recent metrics
psql -d cognitive -c "
  SELECT agent_name, AVG(quality_score), COUNT(*) 
  FROM gardener_metrics 
  WHERE created_at > NOW() - INTERVAL '1 hour'
  GROUP BY agent_name;
"
```

---

## Acceptance Criteria

- [ ] Quality scores calculated
- [ ] Metrics recorded to database
- [ ] MAB scores updated via Thompson Sampling
- [ ] Anomalies detected
- [ ] Auto-evaluation after each job
- [ ] Continuous tier execution

---

## Next Packet (Phase 5)

- [W30: Community Detection](../phase5/W30-community-detection.md) - Graph clustering
