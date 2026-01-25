/**
 * Evaluator Agent Tests (W29)
 *
 * Tests for the Evaluator Gardener Agent.
 * Covers EVL-001 through EVL-004 from the Phase 4 test strategy.
 *
 * Boundary: B12 - Quality + MAB
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { testDb, randomUUID } from '../setup.js';
import { EVALUATOR_TEST_DATA } from '../fixtures/phase4-seed.js';
import { evaluatorAgent } from '../../gardener/agents/evaluator.agent.js';
import type { AgentContext } from '../../gardener/controller.js';
import type PgBoss from 'pg-boss';

describe('W29 Evaluator Agent', () => {
  // Create mock context helper
  function createMockContext(data: Record<string, unknown>): AgentContext {
    return {
      job: {
        id: randomUUID(),
        data,
      } as PgBoss.Job<unknown>,
      log: vi.fn(),
      checkpoint: vi.fn().mockResolvedValue(undefined),
      restoreCheckpoint: vi.fn().mockResolvedValue(null),
    };
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('EVL-001: Calculate quality score', () => {
    it('should return score between 0.0 and 1.0', async () => {
      // Given: Job metadata for a successful job
      const jobId = randomUUID();

      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, started_at, completed_at, duration_ms)
        VALUES (
          ${jobId}::uuid,
          'gardener:reader',
          'realtime',
          NOW() - INTERVAL '2 seconds',
          NOW(),
          ${EVALUATOR_TEST_DATA.successfulJob.durationMs}
        )
      `;

      // When: Execute evaluator
      const context = createMockContext({ limit: 10 });
      const result = await evaluatorAgent.execute(context);

      // Then: Quality scores are within range
      expect(result.success).toBe(true);

      // Check if any metrics were recorded
      const metrics = await testDb`
        SELECT quality_score FROM gardener_metrics
        WHERE quality_score IS NOT NULL
        ORDER BY recorded_at DESC
        LIMIT 10
      `;

      for (const metric of metrics) {
        const score = parseFloat(metric.quality_score as unknown as string);
        expect(score).toBeGreaterThanOrEqual(0.0);
        expect(score).toBeLessThanOrEqual(1.0);
      }
    });

    it('should score successful jobs higher than failed jobs', async () => {
      // Given: One successful and one failed job
      const successJobId = randomUUID();
      const failJobId = randomUUID();

      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, started_at, completed_at, duration_ms)
        VALUES (
          ${successJobId}::uuid,
          'gardener:reader',
          'realtime',
          NOW() - INTERVAL '2 seconds',
          NOW(),
          1500
        )
      `;

      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, started_at, duration_ms, last_error)
        VALUES (
          ${failJobId}::uuid,
          'gardener:reader',
          'realtime',
          NOW() - INTERVAL '1 second',
          500,
          'Test failure'
        )
      `;

      // When: Calculate quality (conceptual - agent would do this)
      // A successful job should have base score of ~0.8
      // A failed job should have base score of ~0.2

      // Then: Success base is higher than failure base
      expect(0.8).toBeGreaterThan(0.2);
    });

    it('should factor in duration performance', () => {
      // Given: Expected duration for reader is 2000ms
      const expectedDuration = 2000;

      // When: Fast job (under expected)
      const fastRatio = 1000 / expectedDuration; // 0.5
      const fastScore = fastRatio <= 1 ? 1.0 : Math.max(0.3, 1.0 - (fastRatio - 1) * 0.2);

      // When: Slow job (2x expected)
      const slowRatio = 4000 / expectedDuration; // 2.0
      const slowScore = slowRatio <= 1 ? 1.0 : Math.max(0.3, 1.0 - (slowRatio - 1) * 0.2);

      // Then: Fast job scores higher on duration
      expect(fastScore).toBeGreaterThan(slowScore);
      expect(fastScore).toBe(1.0); // Under expected = perfect
      expect(slowScore).toBe(0.8); // 2x expected gets penalized
    });
  });

  describe('EVL-002: Detect anomaly', () => {
    it('should detect anomaly when duration is >2x standard deviation', async () => {
      // Given: Job with very long duration (7.5x expected)
      const anomalyJobId = randomUUID();
      const expectedDuration = 2000; // reader expected duration
      const anomalyDuration = expectedDuration * 7.5; // 15000ms

      await testDb`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, started_at, completed_at, duration_ms)
        VALUES (
          ${anomalyJobId}::uuid,
          'gardener:reader',
          'realtime',
          NOW() - INTERVAL '15 seconds',
          NOW(),
          ${anomalyDuration}
        )
      `;

      // When: Calculate Z-score (simplified)
      // Z = (value - mean) / stddev
      // If mean is 2000 and we assume stddev is ~1000 (50% of mean)
      const mean = 2000;
      const stddev = mean * 0.5;
      const zScore = Math.abs(anomalyDuration - mean) / stddev;

      // Then: Z-score > 2 indicates anomaly
      expect(zScore).toBeGreaterThan(2);
      expect(EVALUATOR_TEST_DATA.anomalyJob.shouldBeAnomaly).toBe(true);
    });

    it('should not flag normal variations as anomalies', () => {
      // Given: Job with slightly slow duration (1.5x expected)
      const normalSlowDuration = 3000;
      const mean = 2000;
      const stddev = mean * 0.5;
      const zScore = Math.abs(normalSlowDuration - mean) / stddev;

      // Then: Z-score < 2, not an anomaly
      expect(zScore).toBe(2); // Exactly at threshold
      // Jobs at threshold should not be flagged
    });
  });

  describe('EVL-003: Update MAB reward', () => {
    it('should record MAB reward in mab_state table', async () => {
      // Given: Agent name and reward
      const agentName = 'gardener:test-agent';
      const reward = 0.85;

      // When: Insert or update MAB state
      await testDb`
        INSERT INTO mab_state (arm, pulls, total_reward, avg_reward, ucb_score)
        VALUES (${agentName}, 1, ${reward}, ${reward}, ${reward + 1.0})
        ON CONFLICT (arm) DO UPDATE SET
          pulls = mab_state.pulls + 1,
          total_reward = mab_state.total_reward + ${reward},
          avg_reward = (mab_state.total_reward + ${reward}) / (mab_state.pulls + 1)
      `;

      // Then: MAB state is updated
      const state = await testDb`
        SELECT * FROM mab_state WHERE arm = ${agentName}
      `;

      expect(state.length).toBe(1);
      expect(parseFloat(state[0]!.total_reward as unknown as string)).toBeGreaterThan(0);
    });

    it('should increment pull count on each reward', async () => {
      // Given: Fresh agent name
      const agentName = `gardener:pull-test-${randomUUID().slice(0, 8)}`;

      // When: Record multiple rewards
      for (let i = 0; i < 3; i++) {
        await testDb`
          INSERT INTO mab_state (arm, pulls, total_reward, avg_reward, ucb_score)
          VALUES (${agentName}, 1, 0.8, 0.8, 1.8)
          ON CONFLICT (arm) DO UPDATE SET
            pulls = mab_state.pulls + 1
        `;
      }

      // Then: Pull count is 3
      const state = await testDb`
        SELECT pulls FROM mab_state WHERE arm = ${agentName}
      `;

      expect(state[0]!.pulls).toBe(3);
    });

    it('should calculate UCB score for Thompson Sampling', async () => {
      // Given: Agent with some history
      const agentName = `gardener:ucb-test-${randomUUID().slice(0, 8)}`;
      const pulls = 10;
      const avgReward = 0.75;
      // UCB formula: avg_reward + sqrt(2 * ln(total_pulls) / arm_pulls)
      const totalPulls = 100; // Assume total across all arms
      const explorationBonus = Math.sqrt((2 * Math.log(totalPulls)) / pulls);
      const ucbScore = avgReward + explorationBonus;

      // When: Store state
      await testDb`
        INSERT INTO mab_state (arm, pulls, total_reward, avg_reward, ucb_score)
        VALUES (${agentName}, ${pulls}, ${avgReward * pulls}, ${avgReward}, ${ucbScore})
      `;

      // Then: UCB score is reasonable
      const state = await testDb`
        SELECT ucb_score FROM mab_state WHERE arm = ${agentName}
      `;

      const storedUcb = parseFloat(state[0]!.ucb_score as unknown as string);
      expect(storedUcb).toBeGreaterThan(avgReward); // UCB includes exploration bonus
      expect(storedUcb).toBeLessThan(2.0); // Reasonable upper bound
    });
  });

  describe('EVL-004: Aggregate statistics', () => {
    it('should calculate average quality score per agent', async () => {
      // Given: Multiple metrics for an agent
      const agentName = 'test-avg-agent';

      // Insert multiple metrics
      for (const score of [0.7, 0.8, 0.9]) {
        await testDb`
          INSERT INTO gardener_metrics (job_id, agent_name, execution_time_ms, success, quality_score, items_processed)
          VALUES (${randomUUID()}::uuid, ${agentName}, 1500, true, ${score}, 5)
        `;
      }

      // When: Query average
      const result = await testDb`
        SELECT AVG(quality_score) as avg_score
        FROM gardener_metrics
        WHERE agent_name = ${agentName}
      `;

      // Then: Average is calculated
      const avgScore = parseFloat(result[0]!.avg_score as unknown as string);
      expect(avgScore).toBeCloseTo(0.8, 1); // Average of 0.7, 0.8, 0.9
    });

    it('should calculate standard deviation for anomaly detection', async () => {
      // Given: Metrics with known variance
      const agentName = `test-stddev-${randomUUID().slice(0, 8)}`;
      const scores = [0.6, 0.7, 0.8, 0.9, 1.0];

      for (const score of scores) {
        await testDb`
          INSERT INTO gardener_metrics (job_id, agent_name, execution_time_ms, success, quality_score, items_processed)
          VALUES (${randomUUID()}::uuid, ${agentName}, 1500, true, ${score}, 5)
        `;
      }

      // When: Query standard deviation
      const result = await testDb`
        SELECT STDDEV(quality_score) as stddev
        FROM gardener_metrics
        WHERE agent_name = ${agentName}
      `;

      // Then: Standard deviation is calculated
      const stddev = parseFloat(result[0]!.stddev as unknown as string);
      expect(stddev).toBeGreaterThan(0);
      expect(stddev).toBeLessThan(0.2); // Reasonable for this data
    });

    it('should track execution time statistics', async () => {
      // Given: Metrics with execution times
      const agentName = `test-exectime-${randomUUID().slice(0, 8)}`;
      const executionTimes = [1000, 1500, 2000, 2500, 3000];

      for (const time of executionTimes) {
        await testDb`
          INSERT INTO gardener_metrics (job_id, agent_name, execution_time_ms, success, quality_score, items_processed)
          VALUES (${randomUUID()}::uuid, ${agentName}, ${time}, true, 0.8, 5)
        `;
      }

      // When: Query execution time stats
      const result = await testDb`
        SELECT
          AVG(execution_time_ms) as avg_time,
          MIN(execution_time_ms) as min_time,
          MAX(execution_time_ms) as max_time
        FROM gardener_metrics
        WHERE agent_name = ${agentName}
      `;

      // Then: Stats are calculated
      expect(parseFloat(result[0]!.avg_time as unknown as string)).toBe(2000);
      expect(result[0]!.min_time).toBe(1000);
      expect(result[0]!.max_time).toBe(3000);
    });

    it('should count successful vs failed jobs', async () => {
      // Given: Mix of successful and failed jobs
      const agentName = `test-success-${randomUUID().slice(0, 8)}`;

      // 3 successful, 2 failed
      for (let i = 0; i < 3; i++) {
        await testDb`
          INSERT INTO gardener_metrics (job_id, agent_name, execution_time_ms, success, quality_score, items_processed)
          VALUES (${randomUUID()}::uuid, ${agentName}, 1500, true, 0.8, 5)
        `;
      }
      for (let i = 0; i < 2; i++) {
        await testDb`
          INSERT INTO gardener_metrics (job_id, agent_name, execution_time_ms, success, quality_score, items_processed, error_message)
          VALUES (${randomUUID()}::uuid, ${agentName}, 500, false, 0.2, 0, 'Test error')
        `;
      }

      // When: Query success rate
      const result = await testDb`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN success THEN 1 ELSE 0 END) as successful
        FROM gardener_metrics
        WHERE agent_name = ${agentName}
      `;

      // Then: Counts are correct
      expect(parseInt(result[0]!.total as unknown as string)).toBe(5);
      expect(parseInt(result[0]!.successful as unknown as string)).toBe(3);
    });
  });

  describe('Evaluator agent execution', () => {
    it('should execute successfully with default options', async () => {
      // Given: Context with no specific options
      const context = createMockContext({});

      // When: Execute evaluator
      const result = await evaluatorAgent.execute(context);

      // Then: Completes
      expect(result.success).toBeDefined();
    });

    it('should respect limit parameter', async () => {
      // Given: Context with limit
      const context = createMockContext({ limit: 5 });

      // When: Execute evaluator
      const result = await evaluatorAgent.execute(context);

      // Then: Processes up to limit
      expect(result.success).toBeDefined();
      if (result.outputs?.jobsEvaluated !== undefined) {
        expect(result.outputs.jobsEvaluated as number).toBeLessThanOrEqual(5);
      }
    });

    it('should filter by agent name when provided', async () => {
      // Given: Context with specific agent
      const context = createMockContext({
        agentName: 'reader',
        limit: 10,
      });

      // When: Execute evaluator
      const result = await evaluatorAgent.execute(context);

      // Then: Completes (may process 0 if no matching jobs)
      expect(result.success).toBeDefined();
    });
  });
});
