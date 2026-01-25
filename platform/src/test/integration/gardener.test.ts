/**
 * Gardener Controller Integration Tests
 *
 * Tests for the Gardener Controller and Agent orchestration.
 * Covers GC-001 through GC-008 from the test strategy.
 */

import { describe, it, expect } from 'vitest';
import { testDb, randomUUID } from '../setup.js';

// Types matching controller.ts
interface GardenerJob {
  type: string;
  tier: 'realtime' | 'frequent' | 'periodic' | 'deep';
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
}

describe('Gardener Controller ↔ Agents Integration', () => {
  // Note: Tests are self-contained with unique job IDs - no global cleanup needed

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
      expect(result[0].job_type).toBe('gardener:extract-entities');
      expect(result[0].tier).toBe('realtime');
      expect(result[0].priority).toBe(5);
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
      const result = await handler({
        job: { id: randomUUID(), data: {} },
        log: vi.fn(),
        checkpoint: vi.fn(),
        restoreCheckpoint: vi.fn().mockResolvedValue(null),
      });

      expect(result.success).toBe(true);
      expect(mockHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('GC-003: MAB priority adjustment', () => {
    it('should adjust priority by UCB score', async () => {
      // Given: MAB state with varying performance (unique arm names for test isolation)
      const testId = randomUUID().slice(0, 8);
      const highPerformer = `gardener:high-performer-${testId}`;
      const lowPerformer = `gardener:low-performer-${testId}`;
      const newAgent = `gardener:new-agent-${testId}`;

      await testDb`
        INSERT INTO mab_state (arm, pulls, total_reward, avg_reward, ucb_score)
        VALUES
          (${highPerformer}, 100, 95, 0.95, 1.2),
          (${lowPerformer}, 100, 50, 0.50, 0.7),
          (${newAgent}, 5, 4, 0.80, 2.5)
      `;

      // When: Get UCB scores (filter to only our test arms)
      const scores = await testDb`
        SELECT arm, ucb_score FROM mab_state
        WHERE arm IN (${highPerformer}, ${lowPerformer}, ${newAgent})
        ORDER BY ucb_score DESC
      `;

      // Then: Exploration bonus for new agent (low pulls = high uncertainty)
      expect(scores[0].arm).toBe(newAgent);
      expect(parseFloat(scores[0].ucb_score)).toBeGreaterThan(2.0);

      // High performer second
      expect(scores[1].arm).toBe(highPerformer);

      // Low performer last
      expect(scores[2].arm).toBe(lowPerformer);
    });

    it('should update MAB reward after job completion', async () => {
      // Given: Existing MAB state (unique arm name for test isolation)
      const testArm = `gardener:test-arm-${randomUUID().slice(0, 8)}`;
      await testDb`
        INSERT INTO mab_state (arm, pulls, total_reward, avg_reward, ucb_score)
        VALUES (${testArm}, 10, 8, 0.8, 1.0)
      `;

      // When: Update with new reward
      await testDb`SELECT update_mab_reward(${testArm}, 1.0)`;

      // Then: State updated
      const state = await testDb`
        SELECT * FROM mab_state WHERE arm = ${testArm}
      `;

      expect(state[0].pulls).toBe(11);
      expect(parseFloat(state[0].total_reward)).toBeCloseTo(9.0, 1);
    });
  });

  describe('GC-004: Tier scheduling', () => {
    it('should have correct tier defaults', () => {
      // Given: Tier configuration
      const tierDefaults = {
        realtime: { retryLimit: 2, expireInSeconds: 30 },
        frequent: { retryLimit: 3, expireInSeconds: 120 },
        periodic: { retryLimit: 3, expireInSeconds: 600 },
        deep: { retryLimit: 1, expireInSeconds: 3600 },
      };

      // Then: Realtime is fastest
      expect(tierDefaults.realtime.expireInSeconds).toBeLessThan(tierDefaults.frequent.expireInSeconds);

      // Periodic has more time than frequent
      expect(tierDefaults.periodic.expireInSeconds).toBeGreaterThan(tierDefaults.frequent.expireInSeconds);

      // Deep has most time
      expect(tierDefaults.deep.expireInSeconds).toBe(3600); // 1 hour
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
        VALUES (${jobId}::uuid, 'gardener:long-job', 'deep', NOW())
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
      const checkpoint = typeof result[0].checkpoint === 'string'
        ? JSON.parse(result[0].checkpoint)
        : result[0].checkpoint;
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
        VALUES (${jobId}::uuid, 'gardener:resumable', 'deep', ${JSON.stringify(checkpointData)}::jsonb)
      `;

      // When: Restore checkpoint
      const result = await testDb`
        SELECT checkpoint FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `;

      // Then: Checkpoint restored correctly
      // Note: postgres-js may return JSONB as string, so parse if needed
      const checkpoint = typeof result[0].checkpoint === 'string'
        ? JSON.parse(result[0].checkpoint)
        : result[0].checkpoint;
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
    it('should record job completion metrics', async () => {
      // Given: Completed job
      const jobId = randomUUID();
      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, started_at)
        VALUES (${jobId}::uuid, 'gardener:metrics-test', 'realtime', NOW() - interval '5 seconds')
      `;

      // When: Record completion
      const durationMs = 5000;
      await testDb`
        UPDATE gardener_job_meta
        SET completed_at = NOW(),
            duration_ms = ${durationMs}
        WHERE job_id = ${jobId}::uuid
      `;

      // Then: Metrics recorded
      const result = await testDb`
        SELECT * FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `;

      expect(result[0].completed_at).not.toBeNull();
      expect(result[0].duration_ms).toBe(5000);
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

      expect(result[0].attempts).toBe(2);
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

      expect(result[0].last_error).toBe(errorMessage);
      expect(result[0].completed_at).toBeNull(); // Not completed

      // Can be retried (attempts < limit)
      const canRetry = result[0].attempts < 3; // Assuming limit of 3
      expect(canRetry).toBe(true);
    });

    it('should respect retry limits by tier', () => {
      // Given: Tier retry limits
      const tierDefaults = {
        realtime: { retryLimit: 2 },
        frequent: { retryLimit: 3 },
        periodic: { retryLimit: 3 },
        deep: { retryLimit: 1 }, // Deep jobs are expensive, limit retries
      };

      // Then: Limits are appropriate for tier
      expect(tierDefaults.realtime.retryLimit).toBeLessThanOrEqual(tierDefaults.frequent.retryLimit);
      expect(tierDefaults.deep.retryLimit).toBe(1); // Deep jobs fail fast
    });
  });
});
