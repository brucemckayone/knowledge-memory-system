# Work Packet W21: Central Controller (Gardener Scheduler)

**Status:** Ready to Implement  
**Dependencies:** W16-W20 (Phase 3 Foundation)  
**Estimated Time:** 3-4 hours

---

## Objective

Create the Central Controller agent that orchestrates all Gardener operations. This is Agent #1 in the KARMA architecture — responsible for priority scheduling, resource management, and multi-armed bandit exploration.

---

## Background

### Research Reference
From [GARDENER_RESEARCH.md](../GARDENER_RESEARCH.md) lines 486-500:
- Priority scheduling using multi-armed bandit exploration
- PostgreSQL job queue (pg-boss already in system)
- Checkpointing for long-running operations

### Role in 9-Agent Architecture
```
┌──────────────────────────────────────────────────────────────┐
│                  1. CENTRAL CONTROLLER                        │
│    ┌─────────────────────────────────────────────────────┐   │
│    │  • Priority Queue Management                         │   │
│    │  • Multi-Armed Bandit Exploration                    │   │
│    │  • Resource Allocation                               │   │
│    │  • Health Monitoring                                 │   │
│    │  • Checkpointing                                     │   │
│    └─────────────────────────────────────────────────────┘   │
│         │                                                     │
│         ▼                                                     │
│    [Dispatches jobs to Agents 2-9]                           │
└──────────────────────────────────────────────────────────────┘
```

---

## Architecture

### Job Types

```typescript
type GardenerJobType =
  // Agent 2: Ingestion
  | 'gardener:ingest'
  // Agent 3: Reader
  | 'gardener:read'
  // Agent 4: Summarizer
  | 'gardener:summarize'
  // Agent 5: Entity Extraction
  | 'gardener:extract-entities'
  // Agent 6: Relationship Extraction
  | 'gardener:extract-relationships'
  // Agent 7: Schema Alignment
  | 'gardener:align-schema'
  // Agent 8: Conflict Resolution
  | 'gardener:resolve-conflicts'
  // Agent 9: Evaluator
  | 'gardener:evaluate'
  // Composite jobs
  | 'gardener:full-pipeline'
  | 'gardener:refresh-entity'
  | 'gardener:detect-contradictions';
```

### Tiered Scheduling

```typescript
interface ScheduleConfig {
  tier: 'realtime' | 'frequent' | 'periodic' | 'deep';
  cronExpression?: string;
  maxConcurrency: number;
  timeout: number; // ms
}

const SCHEDULES: Record<string, ScheduleConfig> = {
  'gardener:extract-entities': { tier: 'realtime', maxConcurrency: 5, timeout: 10000 },
  'gardener:summarize': { tier: 'frequent', cronExpression: '*/5 * * * *', maxConcurrency: 2, timeout: 30000 },
  'gardener:align-schema': { tier: 'periodic', cronExpression: '0 * * * *', maxConcurrency: 1, timeout: 60000 },
  'gardener:detect-contradictions': { tier: 'deep', cronExpression: '0 3 * * *', maxConcurrency: 1, timeout: 300000 },
};
```

---

## Database Schema

### Extended Job Queue

Create `platform/src/db/migrations/005_gardener_jobs.sql`:

```sql
-- ============================================
-- GARDENER JOBS: Extended job metadata
-- ============================================
CREATE TABLE gardener_job_meta (
    job_id UUID PRIMARY KEY,  -- References pg-boss job
    
    -- Job categorization
    job_type VARCHAR(100) NOT NULL,
    tier VARCHAR(20) NOT NULL,  -- realtime, frequent, periodic, deep
    
    -- Priority (higher = more urgent)
    priority INTEGER DEFAULT 0,
    
    -- Multi-armed bandit scoring
    exploration_score FLOAT DEFAULT 0.5,  -- Balance exploration vs exploitation
    expected_value FLOAT DEFAULT 0.5,
    
    -- Checkpointing for long-running jobs
    checkpoint JSONB,
    checkpoint_at TIMESTAMPTZ,
    
    -- Execution tracking
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    last_error TEXT,
    
    -- Metrics
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    
    -- Created
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_gardener_jobs_type ON gardener_job_meta(job_type);
CREATE INDEX idx_gardener_jobs_tier ON gardener_job_meta(tier);
CREATE INDEX idx_gardener_jobs_priority ON gardener_job_meta(priority DESC);

-- ============================================
-- JOB METRICS: Performance tracking
-- ============================================
CREATE TABLE gardener_metrics (
    id SERIAL PRIMARY KEY,
    job_type VARCHAR(100) NOT NULL,
    
    -- Execution metrics
    execution_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    
    -- Timing
    avg_duration_ms FLOAT,
    min_duration_ms INTEGER,
    max_duration_ms INTEGER,
    
    -- Quality
    avg_confidence FLOAT,
    
    -- Window
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    
    UNIQUE(job_type, window_start)
);

-- ============================================
-- MAB STATE: Multi-Armed Bandit state
-- ============================================
CREATE TABLE mab_state (
    arm VARCHAR(100) PRIMARY KEY,  -- Job type or strategy
    
    -- UCB1 algorithm state
    pulls INTEGER DEFAULT 0,        -- Number of times selected
    total_reward FLOAT DEFAULT 0,   -- Cumulative reward
    
    -- Computed values (updated periodically)
    avg_reward FLOAT DEFAULT 0,
    ucb_score FLOAT DEFAULT 1.0,    -- Upper confidence bound
    
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Initialize MAB arms for each job type
INSERT INTO mab_state (arm) VALUES
    ('gardener:extract-entities'),
    ('gardener:extract-relationships'),
    ('gardener:summarize'),
    ('gardener:align-schema'),
    ('gardener:resolve-conflicts'),
    ('gardener:evaluate')
ON CONFLICT DO NOTHING;
```

---

## Central Controller Service

Create `platform/src/gardener/controller.ts`:

```typescript
import PgBoss from 'pg-boss';
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

export interface GardenerJob {
  type: string;
  tier: 'realtime' | 'frequent' | 'periodic' | 'deep';
  priority?: number;
  payload: Record<string, unknown>;
  opts?: {
    retryLimit?: number;
    expireInSeconds?: number;
    startAfter?: Date;
  };
}

export interface JobResult {
  success: boolean;
  outputs?: Record<string, unknown>;
  nextJobs?: GardenerJob[];
  metrics?: {
    confidence: number;
    itemsProcessed: number;
  };
}

class GardenerController {
  private boss: PgBoss;
  private handlers: Map<string, (job: any) => Promise<JobResult>> = new Map();
  private running = false;

  constructor(boss: PgBoss) {
    this.boss = boss;
  }

  /**
   * Register a job handler
   */
  registerHandler(jobType: string, handler: (job: any) => Promise<JobResult>): void {
    this.handlers.set(jobType, handler);
    console.log(`📋 Registered Gardener handler: ${jobType}`);
  }

  /**
   * Start the controller
   */
  async start(): Promise<void> {
    if (this.running) return;
    
    console.log('🌱 Starting Gardener Controller...');
    
    // Subscribe to all registered job types
    for (const [jobType, handler] of this.handlers) {
      await this.boss.work(jobType, async (job) => {
        return this.executeJob(jobType, job, handler);
      });
    }
    
    // Start scheduled jobs
    await this.setupSchedules();
    
    this.running = true;
    console.log('✅ Gardener Controller started');
  }

  /**
   * Execute a job with metrics and checkpointing
   */
  private async executeJob(
    jobType: string,
    job: PgBoss.Job<unknown>,
    handler: (job: any) => Promise<JobResult>
  ): Promise<void> {
    const startTime = Date.now();
    
    // Record start
    await this.recordJobStart(job.id, jobType);
    
    try {
      // Execute handler
      const result = await handler(job);
      
      // Record completion
      const duration = Date.now() - startTime;
      await this.recordJobComplete(job.id, duration, result);
      
      // Update MAB reward
      if (result.success) {
        await this.updateMabReward(jobType, result.metrics?.confidence || 1.0);
      }
      
      // Queue follow-up jobs
      if (result.nextJobs?.length) {
        for (const nextJob of result.nextJobs) {
          await this.enqueue(nextJob);
        }
      }
      
    } catch (error) {
      const duration = Date.now() - startTime;
      await this.recordJobError(job.id, duration, String(error));
      throw error;
    }
  }

  /**
   * Enqueue a new job with MAB-based priority
   */
  async enqueue(job: GardenerJob): Promise<string> {
    // Get MAB-adjusted priority
    const mabScore = await this.getMabScore(job.type);
    const adjustedPriority = (job.priority || 0) + Math.floor(mabScore * 10);
    
    // Map tier to pg-boss options
    const opts = this.getTierOptions(job.tier, job.opts);
    
    // Enqueue
    const jobId = await this.boss.send(job.type, job.payload, {
      ...opts,
      priority: adjustedPriority,
    });
    
    // Record metadata
    if (jobId) {
      await this.recordJobMeta(jobId, job);
    }
    
    return jobId || '';
  }

  /**
   * Get MAB score for job type (UCB1 algorithm)
   */
  private async getMabScore(jobType: string): Promise<number> {
    const result = await db.execute(sql`
      SELECT ucb_score FROM mab_state WHERE arm = ${jobType}
    `);
    return result.rows[0]?.ucb_score || 1.0;
  }

  /**
   * Update MAB reward after job completion
   */
  private async updateMabReward(jobType: string, reward: number): Promise<void> {
    await db.execute(sql`
      UPDATE mab_state
      SET 
        pulls = pulls + 1,
        total_reward = total_reward + ${reward},
        avg_reward = (total_reward + ${reward}) / (pulls + 1),
        updated_at = NOW()
      WHERE arm = ${jobType}
    `);
    
    // Recalculate UCB scores
    await this.recalculateUcbScores();
  }

  /**
   * Recalculate UCB1 scores for all arms
   */
  private async recalculateUcbScores(): Promise<void> {
    await db.execute(sql`
      WITH total AS (
        SELECT SUM(pulls) as total_pulls FROM mab_state
      )
      UPDATE mab_state
      SET ucb_score = CASE 
        WHEN pulls = 0 THEN 1.0
        ELSE avg_reward + SQRT(2 * LN(total.total_pulls + 1) / pulls)
      END
      FROM total
    `);
  }

  /**
   * Set up scheduled jobs
   */
  private async setupSchedules(): Promise<void> {
    // Frequent tier: every 5 minutes
    await this.boss.schedule('gardener:summarize', '*/5 * * * *', {});
    await this.boss.schedule('gardener:evaluate', '*/5 * * * *', {});
    
    // Periodic tier: every hour
    await this.boss.schedule('gardener:align-schema', '0 * * * *', {});
    await this.boss.schedule('gardener:resolve-conflicts', '0 * * * *', {});
    
    // Deep tier: daily at 3am
    await this.boss.schedule('gardener:community-detection', '0 3 * * *', {});
    await this.boss.schedule('gardener:insight-generation', '0 4 * * *', {});
    
    console.log('📅 Gardener schedules configured');
  }

  /**
   * Map tier to pg-boss options
   */
  private getTierOptions(tier: string, customOpts?: GardenerJob['opts']) {
    const tierDefaults = {
      realtime: { retryLimit: 2, expireInSeconds: 30 },
      frequent: { retryLimit: 3, expireInSeconds: 120 },
      periodic: { retryLimit: 3, expireInSeconds: 600 },
      deep: { retryLimit: 1, expireInSeconds: 3600 },
    };
    
    return { ...tierDefaults[tier], ...customOpts };
  }

  /**
   * Checkpoint a long-running job
   */
  async checkpoint(jobId: string, state: unknown): Promise<void> {
    await db.execute(sql`
      UPDATE gardener_job_meta
      SET checkpoint = ${JSON.stringify(state)}::jsonb,
          checkpoint_at = NOW()
      WHERE job_id = ${jobId}::uuid
    `);
  }

  /**
   * Restore checkpoint for a job
   */
  async restoreCheckpoint(jobId: string): Promise<unknown | null> {
    const result = await db.execute(sql`
      SELECT checkpoint FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
    `);
    return result.rows[0]?.checkpoint || null;
  }

  // Recording methods
  private async recordJobMeta(jobId: string, job: GardenerJob): Promise<void> {
    await db.execute(sql`
      INSERT INTO gardener_job_meta (job_id, job_type, tier, priority)
      VALUES (${jobId}::uuid, ${job.type}, ${job.tier}, ${job.priority || 0})
    `);
  }

  private async recordJobStart(jobId: string, jobType: string): Promise<void> {
    await db.execute(sql`
      UPDATE gardener_job_meta
      SET started_at = NOW(), attempts = attempts + 1
      WHERE job_id = ${jobId}::uuid
    `);
  }

  private async recordJobComplete(jobId: string, durationMs: number, result: JobResult): Promise<void> {
    await db.execute(sql`
      UPDATE gardener_job_meta
      SET completed_at = NOW(), duration_ms = ${durationMs}
      WHERE job_id = ${jobId}::uuid
    `);
  }

  private async recordJobError(jobId: string, durationMs: number, error: string): Promise<void> {
    await db.execute(sql`
      UPDATE gardener_job_meta
      SET duration_ms = ${durationMs}, last_error = ${error}
      WHERE job_id = ${jobId}::uuid
    `);
  }

  /**
   * Get controller stats
   */
  async getStats(): Promise<{
    jobsByTier: Record<string, number>;
    mabState: Array<{ arm: string; pulls: number; avgReward: number; ucbScore: number }>;
    recentJobs: Array<{ type: string; status: string; duration: number }>;
  }> {
    // Implementation
    return {
      jobsByTier: {},
      mabState: [],
      recentJobs: [],
    };
  }
}

// Singleton
let controller: GardenerController | null = null;

export function getController(): GardenerController {
  if (!controller) {
    throw new Error('Controller not initialized. Call initController first.');
  }
  return controller;
}

export function initController(boss: PgBoss): GardenerController {
  controller = new GardenerController(boss);
  return controller;
}
```

---

## Integration with Main Application

Update `platform/src/index.ts`:

```typescript
import { initController } from './gardener/controller.js';
import { registerGardenerAgents } from './gardener/agents/index.js';

async function start() {
  // ... existing startup ...
  
  // Initialize Gardener Controller
  const gardenerController = initController(boss);
  
  // Register all Gardener agents
  await registerGardenerAgents(gardenerController);
  
  // Start the controller
  await gardenerController.start();
  
  // ... rest of startup ...
}
```

---

## Acceptance Criteria

- [ ] `gardener_job_meta` table created
- [ ] `gardener_metrics` table created
- [ ] `mab_state` table created and seeded
- [ ] Controller class implemented
- [ ] Job handlers can be registered
- [ ] MAB scoring adjusts priorities
- [ ] Scheduled jobs configured
- [ ] Checkpointing works
- [ ] Controller starts with application

---

## Next Packet

After completing W21, proceed to:
- [W22: Ingestion Agent](./W22-ingestion-agent.md) - First processing agent
- [W29: Evaluator Agent](./W29-evaluator-agent.md) - Quality scoring
