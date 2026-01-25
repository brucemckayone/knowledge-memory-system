/**
 * Evaluator Agent (W29)
 *
 * KARMA agent that validates quality and updates MAB weights.
 * Monitors agent performance and detects anomalies.
 */

import type { AgentContext, JobResult, GardenerAgent } from '../controller.js';
import { db } from '../../db/index.js';
import { sql } from 'drizzle-orm';

interface EvaluatorPayload {
  evaluateAll?: boolean;
  agentName?: string;
  limit?: number;
}

interface AgentMetrics {
  agentName: string;
  totalJobs: number;
  successfulJobs: number;
  avgQualityScore: number;
  qualityStdDev: number;
  avgExecutionTime: number;
  avgItemsProcessed: number;
  lastRun: Date | null;
}

// Expected execution times by agent (ms)
const EXPECTED_DURATIONS: Record<string, number> = {
  'ingestion': 1000,
  'reader': 2000,
  'summarize': 3000,
  'extract-entities': 2000,
  'relationships': 2500,
  'resolve-conflicts': 1500,
  'align-schema': 5000,
  'evaluate': 2000,
};

// Quality score weights
const QUALITY_WEIGHTS = {
  successBase: 0.4,       // Base score for success
  durationWeight: 0.3,    // Weight for duration performance
  itemsWeight: 0.3,       // Weight for items processed
};

export const evaluatorAgent: GardenerAgent = {
  name: 'evaluate',
  tier: 'frequent',

  async execute(context: AgentContext): Promise<JobResult> {
    const { job, log, checkpoint, restoreCheckpoint } = context;
    const payload = job.data as EvaluatorPayload;

    log('Starting evaluation...');

    // Restore checkpoint
    const state = await restoreCheckpoint() as {
      evaluatedJobs?: string[];
    } | null;
    const evaluatedJobs = new Set<string>(state?.evaluatedJobs || []);

    let jobsEvaluated = 0;
    let anomaliesDetected = 0;
    let mabUpdates = 0;

    try {
      // Step 1: Get recent unevaluated job metrics
      const recentJobs = await getRecentJobMetrics(
        payload.limit || 100,
        payload.agentName
      );

      if (recentJobs.length === 0) {
        log('No recent jobs to evaluate');
        return {
          success: true,
          metrics: { confidence: 1.0, itemsProcessed: 0 },
        };
      }

      log(`Evaluating ${recentJobs.length} recent jobs`);

      // Step 2: Calculate quality scores and detect anomalies
      const agentStats = await getAgentStats();

      for (const jobMetric of recentJobs) {
        if (evaluatedJobs.has(jobMetric.jobId)) continue;

        // Calculate quality score
        const qualityScore = calculateQualityScore(jobMetric, agentStats);

        // Check for anomalies
        const isAnomaly = detectAnomaly(jobMetric, agentStats);
        if (isAnomaly) {
          anomaliesDetected++;
          log(`Anomaly detected: ${jobMetric.agentName} job ${jobMetric.jobId.slice(0, 8)}`, 'warn');
        }

        // Record metrics
        await recordMetrics(jobMetric, qualityScore);

        // Update MAB reward
        await updateMabReward(jobMetric.agentName, qualityScore);
        mabUpdates++;

        evaluatedJobs.add(jobMetric.jobId);
        jobsEvaluated++;

        // Checkpoint every 20 jobs
        if (jobsEvaluated % 20 === 0) {
          await checkpoint({ evaluatedJobs: Array.from(evaluatedJobs) });
        }
      }

      // Step 3: Update agent statistics
      await updateAgentStatistics();

      log(`Evaluated ${jobsEvaluated} jobs, ${anomaliesDetected} anomalies, ${mabUpdates} MAB updates`);

      return {
        success: true,
        outputs: {
          jobsEvaluated,
          anomaliesDetected,
          mabUpdates,
        },
        metrics: {
          confidence: 0.95,
          itemsProcessed: jobsEvaluated,
        },
      };

    } catch (error) {
      log(`Evaluation failed: ${error}`, 'error');

      // Save checkpoint on failure
      await checkpoint({ evaluatedJobs: Array.from(evaluatedJobs) });

      return { success: false };
    }
  },
};

/**
 * Calculate quality score for a job
 */
function calculateQualityScore(
  job: JobMetric,
  agentStats: Map<string, AgentMetrics>
): number {
  // Base score from success/failure
  let score = job.success ? 0.8 : 0.2;

  // Duration component
  const expectedDuration = EXPECTED_DURATIONS[job.agentName] || 2000;
  if (job.durationMs) {
    const durationRatio = job.durationMs / expectedDuration;
    // Score higher for faster execution, penalize for slower
    const durationScore = durationRatio <= 1 ? 1.0 : Math.max(0.3, 1.0 - (durationRatio - 1) * 0.2);
    score = score * (1 - QUALITY_WEIGHTS.durationWeight) + durationScore * QUALITY_WEIGHTS.durationWeight;
  }

  // Items processed component
  const stats = agentStats.get(job.agentName);
  if (stats && stats.avgItemsProcessed > 0 && job.itemsProcessed != null) {
    const itemsRatio = job.itemsProcessed / stats.avgItemsProcessed;
    // Score based on how many items processed vs average
    const itemsScore = Math.min(1.0, itemsRatio);
    score = score * (1 - QUALITY_WEIGHTS.itemsWeight) + itemsScore * QUALITY_WEIGHTS.itemsWeight;
  }

  return Math.min(1.0, Math.max(0.0, score));
}

/**
 * Detect if a job is anomalous (>2 std dev from mean)
 */
function detectAnomaly(
  job: JobMetric,
  agentStats: Map<string, AgentMetrics>
): boolean {
  const stats = agentStats.get(job.agentName);
  if (!stats || stats.totalJobs < 10) {
    return false; // Not enough data
  }

  // Check execution time anomaly
  if (job.durationMs && stats.avgExecutionTime > 0) {
    const zScore = Math.abs(job.durationMs - stats.avgExecutionTime) /
      (stats.avgExecutionTime * 0.5); // Rough std dev estimate
    if (zScore > 2) {
      return true;
    }
  }

  // Check quality score anomaly
  if (stats.qualityStdDev > 0) {
    const expectedScore = calculateQualityScore(job, agentStats);
    const zScore = Math.abs(expectedScore - stats.avgQualityScore) / stats.qualityStdDev;
    if (zScore > 2) {
      return true;
    }
  }

  return false;
}

interface JobMetric {
  jobId: string;
  agentName: string;
  success: boolean;
  durationMs: number | null;
  itemsProcessed: number | null;
  errorMessage: string | null;
  recordedAt: Date;
}

/**
 * Get recent job metrics from gardener_job_meta
 */
async function getRecentJobMetrics(
  limit: number,
  agentName?: string
): Promise<JobMetric[]> {
  try {
    const result = await db.execute(sql`
      SELECT
        job_id as "jobId",
        job_type as "agentName",
        completed_at IS NOT NULL as success,
        duration_ms as "durationMs",
        last_error as "errorMessage",
        started_at as "recordedAt"
      FROM gardener_job_meta
      WHERE started_at > NOW() - INTERVAL '1 hour'
        ${agentName ? sql`AND job_type LIKE ${'%' + agentName + '%'}` : sql``}
      ORDER BY started_at DESC
      LIMIT ${limit}
    `);

    return (result as unknown as { rows: JobMetric[] }).rows.map(r => ({
      ...r,
      agentName: r.agentName.replace('gardener:', ''),
      itemsProcessed: null, // Will be populated from gardener_metrics if available
    }));
  } catch (error) {
    console.warn('Failed to get job metrics:', error);
    return [];
  }
}

/**
 * Get aggregate statistics per agent
 */
async function getAgentStats(): Promise<Map<string, AgentMetrics>> {
  const stats = new Map<string, AgentMetrics>();

  try {
    const result = await db.execute(sql`
      SELECT
        agent_name as "agentName",
        COUNT(*) as "totalJobs",
        SUM(CASE WHEN success THEN 1 ELSE 0 END) as "successfulJobs",
        AVG(quality_score) as "avgQualityScore",
        STDDEV(quality_score) as "qualityStdDev",
        AVG(execution_time_ms) as "avgExecutionTime",
        AVG(items_processed) as "avgItemsProcessed",
        MAX(recorded_at) as "lastRun"
      FROM gardener_metrics
      WHERE recorded_at > NOW() - INTERVAL '7 days'
      GROUP BY agent_name
    `);

    for (const row of (result as unknown as { rows: AgentMetrics[] }).rows) {
      stats.set(row.agentName, row);
    }
  } catch (error) {
    console.warn('Failed to get agent stats:', error);
  }

  return stats;
}

/**
 * Record metrics for a job
 */
async function recordMetrics(job: JobMetric, qualityScore: number): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO gardener_metrics (
        job_id, agent_name, execution_time_ms, success,
        quality_score, items_processed, error_message
      ) VALUES (
        ${job.jobId}::uuid,
        ${job.agentName},
        ${job.durationMs},
        ${job.success},
        ${qualityScore},
        ${job.itemsProcessed || 0},
        ${job.errorMessage}
      )
      ON CONFLICT DO NOTHING
    `);
  } catch (error) {
    console.warn('Failed to record metrics:', error);
  }
}

/**
 * Update MAB reward for agent using Thompson Sampling
 */
async function updateMabReward(agentName: string, reward: number): Promise<void> {
  const fullName = `gardener:${agentName}`;

  try {
    await db.execute(sql`
      SELECT update_mab_reward(${fullName}, ${reward})
    `);
  } catch (error) {
    // Function may not exist yet
    console.warn('Failed to update MAB reward:', error);
  }
}

/**
 * Update aggregate statistics view
 */
async function updateAgentStatistics(): Promise<void> {
  // The view is automatically updated, but we can refresh materialized views if needed
  // For now, just verify the view is accessible
  try {
    await db.execute(sql`
      SELECT COUNT(*) FROM gardener_agent_stats
    `);
  } catch {
    // View may not exist - that's okay
  }
}
