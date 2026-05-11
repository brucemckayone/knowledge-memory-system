/**
 * Benchmark Monitoring System
 *
 * Collects metrics at regular intervals during continuous benchmarks.
 * Provides real-time visibility into system performance and evolution.
 */

import type { BenchmarkCheckpoint } from './types/continuous.js';
import { rawQuery } from '../db/raw.js';
import { sql } from 'drizzle-orm';
import { getQueue } from '../queue/index.js';

/**
 * Collect current database and system metrics
 */
export async function collectMetrics(): Promise<BenchmarkCheckpoint['metrics']> {
  try {
    const countQuery = async (table: string, where: string) => {
      const rows = await rawQuery<{ count: number }>(sql.raw(`SELECT COUNT(*) as count FROM ${table} WHERE ${where}`));
      return rows[0]?.count || 0;
    };

    const entityCount = await countQuery('entities', 'deleted_at IS NULL');
    const factCount = await countQuery('facts', 'deleted_at IS NULL');
    const taskCount = await countQuery('tasks', 'deleted_at IS NULL');
    const memoryCount = await countQuery('memories', 'deleted_at IS NULL');

    // Get queue stats
    const queue = getQueue();
    const pendingJobs = await (queue as unknown as { count(): Promise<number> }).count();

    const completedJobs = await countQuery('gardener_job_meta', 'completed_at IS NOT NULL');

    return {
      entityCount,
      factCount,
      taskCount,
      memoryCount,
      pendingJobs,
      completedJobs,
    };
  } catch (error) {
    console.error('Error collecting metrics:', error);
    return {
      entityCount: 0,
      factCount: 0,
      taskCount: 0,
      memoryCount: 0,
      pendingJobs: 0,
      completedJobs: 0,
    };
  }
}

/**
 * Collect gardener agent status
 */
export async function collectGardenerStatus(): Promise<BenchmarkCheckpoint['gardenerStatus']> {
  try {
    const rows = await rawQuery<{
      jobType: string;
      lastRun: Date;
      executionCount: number;
    }>(sql`
      SELECT
        job_type,
        MAX(started_at) as last_run,
        COUNT(*) as execution_count
      FROM gardener_job_meta
      WHERE started_at IS NOT NULL
      GROUP BY job_type
      ORDER BY job_type
    `);

    const lastRunTimes: Record<string, Date> = {};
    const executionCounts: Record<string, number> = {};

    for (const row of rows) {
      if (row.lastRun) {
        lastRunTimes[row.jobType] = row.lastRun;
      }
      executionCounts[row.jobType] = row.executionCount;
    }

    return {
      lastRunTimes,
      executionCounts,
    };
  } catch (error) {
    console.error('Error collecting gardener status:', error);
    return {
      lastRunTimes: {},
      executionCounts: {},
    };
  }
}

/**
 * Calculate performance metrics
 */
export function calculatePerformanceMetrics(
  startTime: Date,
  currentTime: Date,
  totalMessages: number,
  metrics: BenchmarkCheckpoint['metrics']
): BenchmarkCheckpoint['performance'] {
  const elapsedMs = currentTime.getTime() - startTime.getTime();
  const elapsedSec = elapsedMs / 1000;

  // Estimate average processing time based on completed jobs
  const avgProcessingTime = metrics.completedJobs > 0
    ? (elapsedMs / metrics.completedJobs)
    : 0;

  // Calculate throughput (messages/sec)
  const throughput = elapsedSec > 0 ? (totalMessages / elapsedSec) : 0;

  return {
    avgProcessingTime,
    throughput,
    queueDepth: metrics.pendingJobs,
  };
}

/**
 * Create a checkpoint with current metrics
 */
export async function createCheckpoint(
  startTime: Date,
  currentTime: Date,
  totalMessages: number
): Promise<BenchmarkCheckpoint> {
  const elapsedMs = currentTime.getTime() - startTime.getTime();

  const metrics = await collectMetrics();
  const gardenerStatus = await collectGardenerStatus();
  const performance = calculatePerformanceMetrics(startTime, currentTime, totalMessages, metrics);

  return {
    timestamp: currentTime,
    elapsedMs,
    metrics,
    performance,
    gardenerStatus,
  };
}

/**
 * Save checkpoint to disk
 */
export async function saveCheckpoint(
  runId: string,
  checkpoint: BenchmarkCheckpoint
): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');

  const checkpointDir = path.join(process.cwd(), '.benchmark-history', runId, 'checkpoints');
  const timestamp = checkpoint.timestamp.toISOString().replace(/[:.]/g, '-');
  const filepath = path.join(checkpointDir, `checkpoint-${timestamp}.json`);

  await fs.mkdir(checkpointDir, { recursive: true });
  await fs.writeFile(filepath, JSON.stringify(checkpoint, null, 2));
}

/**
 * Load all checkpoints for a run
 */
export async function loadCheckpoints(runId: string): Promise<BenchmarkCheckpoint[]> {
  const fs = await import('fs/promises');
  const path = await import('path');

  const checkpointDir = path.join(process.cwd(), '.benchmark-history', runId, 'checkpoints');

  try {
    const files = await fs.readdir(checkpointDir);
    const checkpointFiles = files
      .filter(f => f.startsWith('checkpoint-') && f.endsWith('.json'))
      .sort();

    const checkpoints: BenchmarkCheckpoint[] = [];

    for (const file of checkpointFiles) {
      const filepath = path.join(checkpointDir, file);
      const content = await fs.readFile(filepath, 'utf-8');
      const checkpoint = JSON.parse(content) as BenchmarkCheckpoint;
      // Convert timestamp strings back to Date objects
      checkpoint.timestamp = new Date(checkpoint.timestamp);
      checkpoints.push(checkpoint);
    }

    return checkpoints;
  } catch (error) {
    console.warn(`No checkpoints found for run ${runId}`);
    return [];
  }
}
