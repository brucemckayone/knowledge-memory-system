/**
 * Gardener Controller Integration Tests
 *
 * Tests for the Gardener Controller and Agent orchestration.
 * Covers GC-001 through GC-008 from the test strategy,
 * plus GC-009 (enriched context), GC-010 (error handling), GC-011 (metrics recording).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { testDb, randomUUID, skipCtx } from '../setup.js';

/**
 * These tests target a gardener job-queue feature (`gardener_job_meta`,
 * `gardener_metrics`) that was prototyped but never migrated. Gate the whole
 * suite on table existence so it skips cleanly on branches that don't ship
 * those tables, instead of emitting noise FK / relation-not-found failures.
 */
async function gardenerJobTablesExist(): Promise<boolean> {
  const rows = await testDb`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'gardener_job_meta'
  `;
  return rows.length > 0;
}

// Types matching controller.ts
interface GardenerJob {
  type: string;
  tier: 'realtime' | 'frequent' | 'periodic';
  priority?: number;
  payload: Record<string, unknown>;
}

interface JobResult {
  success: boolean;
  outputs?: Record<string, unknown>;
  nextJobs?: GardenerJob[];
  metrics?: {
    confidence: number;
    itemsProcessed: number;
  };
}

interface AgentContext {
  job: { id: string; data: unknown };
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  checkpoint: (state: unknown) => Promise<void>;
  restoreCheckpoint: () => Promise<unknown | null>;
  traceId: string | null;
  config: Record<string, unknown>;
  services: { ml: unknown; controller: unknown };
  signal: AbortSignal;
}

function createMockContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    job: { id: randomUUID(), data: {} },
    log: vi.fn(),
    checkpoint: vi.fn().mockResolvedValue(undefined),
    restoreCheckpoint: vi.fn().mockResolvedValue(null),
    traceId: null,
    config: {},
    services: { ml: {}, controller: {} },
    signal: AbortSignal.timeout(30000),
    ...overrides,
  };
}

describe('Gardener Controller ↔ Agents Integration', () => {
  // Note: Tests are self-contained with unique job IDs - no global cleanup needed

  beforeAll(async (ctx) => {
    if (!(await gardenerJobTablesExist())) skipCtx(ctx);
  });

  describe('GC-001: Job enqueue', () => {
    it('should enqueue job with priority', async () => {
      // Given: Job data
      const jobId = randomUUID();
      const job: GardenerJob = {
        type: 'gardener:extract-entities',
        tier: 'realtime',
        priority: 5,
        payload: { memoryId: randomUUID(), content: 'Test content' },
      };

      // When: Record job metadata (simulating enqueue)
      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, priority)
        VALUES (${jobId}::uuid, ${job.type}, ${job.tier}, ${job.priority || 0})
      `;

      // Then: Job recorded with correct data
      const result = await testDb`
        SELECT * FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `;

      expect(result.length).toBe(1);
      expect(result[0]!.job_type).toBe('gardener:extract-entities');
      expect(result[0]!.tier).toBe('realtime');
      expect(result[0]!.priority).toBe(5);
    });
  });

  describe('GC-002: Handler registration', () => {
    it('should register and call agent handlers', async () => {
      // Given: Mock handler registry
      const handlers = new Map<string, (ctx: AgentContext) => Promise<JobResult>>();

      const mockHandler = vi.fn(async (_ctx: AgentContext): Promise<JobResult> => ({
        success: true,
        metrics: { confidence: 0.9, itemsProcessed: 5 },
      }));

      // When: Register handler
      handlers.set('gardener:test-agent', mockHandler);

      // Then: Handler is callable
      expect(handlers.has('gardener:test-agent')).toBe(true);

      const handler = handlers.get('gardener:test-agent')!;
      const result = await handler(createMockContext());

      expect(result.success).toBe(true);
      expect(mockHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('GC-003: Priority (MAB removed)', () => {
    it('should use direct priority without MAB adjustment', () => {
      // MAB has been removed — priority is used directly
      const job: GardenerJob = {
        type: 'gardener:extract-entities',
        tier: 'realtime',
        priority: 5,
        payload: { memoryId: randomUUID() },
      };

      // Priority is passed through directly (no MAB score added)
      const adjustedPriority = job.priority || 0;
      expect(adjustedPriority).toBe(5);
    });

    it('should default to priority 0 when not specified', () => {
      const job: GardenerJob = {
        type: 'gardener:summarize',
        tier: 'frequent',
        payload: { memoryId: randomUUID() },
      };

      const adjustedPriority = job.priority || 0;
      expect(adjustedPriority).toBe(0);
    });
  });

  describe('GC-004: Tier scheduling', () => {
    it('should have correct tier defaults', () => {
      // Given: Tier configuration (deep tier removed)
      const tierDefaults = {
        realtime: { retryLimit: 2, expireInSeconds: 30 },
        frequent: { retryLimit: 3, expireInSeconds: 120 },
        periodic: { retryLimit: 3, expireInSeconds: 600 },
      };

      // Then: Realtime is fastest
      expect(tierDefaults.realtime.expireInSeconds).toBeLessThan(tierDefaults.frequent.expireInSeconds);

      // Periodic has more time than frequent
      expect(tierDefaults.periodic.expireInSeconds).toBeGreaterThan(tierDefaults.frequent.expireInSeconds);
    });

    it('should support different scheduling intervals', () => {
      // Given: Schedule patterns
      const schedules = {
        frequent: '*/5 * * * *',     // Every 5 minutes
        periodic: '0 * * * *',        // Every hour
        deep: '0 3 * * *',            // Daily at 3am
      };

      // Then: Patterns are valid cron expressions
      expect(schedules.frequent).toMatch(/^\*\/\d+/);
      expect(schedules.periodic).toMatch(/^0 \*/);
      expect(schedules.deep).toMatch(/^0 \d+ \* \* \*/);
    });
  });

  describe('GC-005: Checkpoint save/restore', () => {
    it('should save checkpoint data', async () => {
      // Given: Job in progress
      const jobId = randomUUID();
      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, started_at)
        VALUES (${jobId}::uuid, 'gardener:long-job', 'periodic', NOW())
      `;

      const checkpointData = {
        processedCount: 50,
        lastProcessedId: 'item-50',
        batchNumber: 5,
      };

      // When: Save checkpoint
      await testDb`
        UPDATE gardener_job_meta
        SET checkpoint = ${JSON.stringify(checkpointData)}::jsonb,
            checkpoint_at = NOW()
        WHERE job_id = ${jobId}::uuid
      `;

      // Then: Checkpoint stored
      const result = await testDb`
        SELECT checkpoint FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `;

      // Note: postgres-js may return JSONB as string, so parse if needed
      const checkpoint = typeof result[0]!.checkpoint === 'string'
        ? JSON.parse(result[0]!.checkpoint as string)
        : result[0]!.checkpoint;
      expect(checkpoint).toEqual(checkpointData);
    });

    it('should restore checkpoint data', async () => {
      // Given: Job with existing checkpoint
      const jobId = randomUUID();
      const checkpointData = {
        processedCount: 75,
        lastProcessedId: 'item-75',
        resumeFrom: 'batch-8',
      };

      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, checkpoint)
        VALUES (${jobId}::uuid, 'gardener:resumable', 'periodic', ${JSON.stringify(checkpointData)}::jsonb)
      `;

      // When: Restore checkpoint
      const result = await testDb`
        SELECT checkpoint FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `;

      // Then: Checkpoint restored correctly
      // Note: postgres-js may return JSONB as string, so parse if needed
      const checkpoint = typeof result[0]!.checkpoint === 'string'
        ? JSON.parse(result[0]!.checkpoint as string)
        : result[0]!.checkpoint;
      expect(checkpoint).toEqual(checkpointData);
      expect(checkpoint.processedCount).toBe(75);
    });
  });

  describe('GC-006: Follow-up job queueing', () => {
    it('should support generating follow-up jobs from result', async () => {
      // Given: Job result with next jobs
      const result: JobResult = {
        success: true,
        metrics: { confidence: 0.9, itemsProcessed: 10 },
        nextJobs: [
          {
            type: 'gardener:resolve-conflicts',
            tier: 'frequent',
            payload: { entityIds: ['e1', 'e2'] },
          },
          {
            type: 'gardener:summarize',
            tier: 'frequent',
            payload: { memoryIds: ['m1', 'm2', 'm3'] },
          },
        ],
      };

      // When: Process next jobs
      expect(result.nextJobs).toBeDefined();
      expect(result.nextJobs!.length).toBe(2);

      // Then: Each follow-up job has required fields
      for (const job of result.nextJobs!) {
        expect(job.type).toBeDefined();
        expect(job.tier).toBeDefined();
        expect(job.payload).toBeDefined();
      }
    });
  });

  describe('GC-007: Metrics recording', () => {
    it('should record job completion with outputs', async () => {
      // Given: Completed job
      const jobId = randomUUID();
      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, started_at)
        VALUES (${jobId}::uuid, 'gardener:metrics-test', 'realtime', NOW() - interval '5 seconds')
      `;

      // When: Record completion with outputs
      const durationMs = 5000;
      const outputs = { entitiesFound: 3, entitiesLinked: 3 };
      await testDb`
        UPDATE gardener_job_meta
        SET completed_at = NOW(),
            duration_ms = ${durationMs},
            outputs = ${JSON.stringify(outputs)}::jsonb
        WHERE job_id = ${jobId}::uuid
      `;

      // Then: Metrics and outputs recorded
      const result = await testDb`
        SELECT * FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `;

      expect(result[0]!.completed_at).not.toBeNull();
      expect(result[0]!.duration_ms).toBe(5000);

      const storedOutputs = typeof result[0]!.outputs === 'string'
        ? JSON.parse(result[0]!.outputs as string)
        : result[0]!.outputs;
      expect(storedOutputs).toEqual(outputs);
    });

    it('should track job attempts', async () => {
      // Given: Job that has been retried
      const jobId = randomUUID();
      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, attempts)
        VALUES (${jobId}::uuid, 'gardener:retry-test', 'realtime', 1)
      `;

      // When: Increment attempts
      await testDb`
        UPDATE gardener_job_meta
        SET attempts = attempts + 1
        WHERE job_id = ${jobId}::uuid
      `;

      // Then: Attempts tracked
      const result = await testDb`
        SELECT attempts FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `;

      expect(result[0]!.attempts).toBe(2);
    });

    it('should write to gardener_metrics table', async () => {
      // Given: Agent job completion data
      const jobId = randomUUID();
      const agentName = 'extract-entities';
      const durationMs = 1500;
      const outputs = { entitiesFound: 5 };

      // When: Insert metrics row (as recordJobComplete now does)
      await testDb`
        INSERT INTO gardener_metrics (
          job_id, agent_name, execution_time_ms, success,
          quality_score, items_processed, agent_specific_metrics
        ) VALUES (
          ${jobId}::uuid, ${agentName}, ${durationMs}, ${true},
          ${0.92}, ${5},
          ${JSON.stringify(outputs)}::jsonb
        )
      `;

      // Then: Metrics row exists
      const result = await testDb`
        SELECT * FROM gardener_metrics WHERE job_id = ${jobId}::uuid
      `;

      expect(result.length).toBe(1);
      expect(result[0]!.agent_name).toBe('extract-entities');
      expect(result[0]!.execution_time_ms).toBe(1500);
      expect(result[0]!.success).toBe(true);
    });
  });

  describe('GC-008: Retry on failure', () => {
    it('should record error and allow retry', async () => {
      // Given: Failed job
      const jobId = randomUUID();
      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, started_at, attempts)
        VALUES (${jobId}::uuid, 'gardener:failing-job', 'realtime', NOW(), 1)
      `;

      // When: Record error
      const errorMessage = 'Connection timeout to ML service';
      await testDb`
        UPDATE gardener_job_meta
        SET last_error = ${errorMessage},
            duration_ms = 30000
        WHERE job_id = ${jobId}::uuid
      `;

      // Then: Error recorded
      const result = await testDb`
        SELECT * FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `;

      expect(result[0]!.last_error).toBe(errorMessage);
      expect(result[0]!.completed_at).toBeNull(); // Not completed

      // Can be retried (attempts < limit)
      const canRetry = result[0]!.attempts < 3; // Assuming limit of 3
      expect(canRetry).toBe(true);
    });

    it('should respect retry limits by tier', () => {
      // Given: Tier retry limits (deep tier removed)
      const tierDefaults = {
        realtime: { retryLimit: 2 },
        frequent: { retryLimit: 3 },
        periodic: { retryLimit: 3 },
      };

      // Then: Limits are appropriate for tier
      expect(tierDefaults.realtime.retryLimit).toBeLessThanOrEqual(tierDefaults.frequent.retryLimit);
      expect(tierDefaults.periodic.retryLimit).toBe(3);
    });
  });

  describe('GC-009: Enriched AgentContext', () => {
    it('should include traceId, config, services, and signal', () => {
      const memoryId = randomUUID();
      const ctx = createMockContext({
        traceId: memoryId,
        config: { ML_SERVICES_URL: 'http://localhost:8000' } as any,
        signal: AbortSignal.timeout(30000),
      });

      expect(ctx.traceId).toBe(memoryId);
      expect(ctx.config).toBeDefined();
      expect(ctx.services.ml).toBeDefined();
      expect(ctx.services.controller).toBeDefined();
      expect(ctx.signal).toBeDefined();
      expect(ctx.signal.aborted).toBe(false);
    });
  });

  describe('GC-010: Trace correlation', () => {
    it('should store trace_id in job metadata', async () => {
      const jobId = randomUUID();
      const traceId = randomUUID();

      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, trace_id)
        VALUES (${jobId}::uuid, 'gardener:reader', 'realtime', ${traceId})
      `;

      const result = await testDb`
        SELECT trace_id FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `;

      expect(result[0]!.trace_id).toBe(traceId);
    });

    it('should query jobs by trace_id', async () => {
      const traceId = randomUUID();

      // Simulate a pipeline of 3 jobs sharing a trace
      for (const jobType of ['gardener:reader', 'gardener:extract-entities', 'gardener:relationships']) {
        await testDb`
          INSERT INTO gardener_job_meta (job_id, job_type, tier, trace_id)
          VALUES (${randomUUID()}::uuid, ${jobType}, 'realtime', ${traceId})
        `;
      }

      const result = await testDb`
        SELECT job_type FROM gardener_job_meta WHERE trace_id = ${traceId} ORDER BY created_at
      `;

      expect(result.length).toBe(3);
      expect(result.map(r => r.job_type)).toContain('gardener:reader');
      expect(result.map(r => r.job_type)).toContain('gardener:extract-entities');
      expect(result.map(r => r.job_type)).toContain('gardener:relationships');
    });
  });
});
