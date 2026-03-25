/**
 * Gardener Controller
 *
 * Central controller for the KARMA agent architecture.
 * Manages priority scheduling and job orchestration.
 */

import PgBoss from 'pg-boss';
import { db } from '../db/index.js';
import { rawQuery } from '../db/raw.js';
import { sql } from 'drizzle-orm';
import { config, type Config } from '../config.js';
import { ml } from '../services/ml-client.js';
import { intervalToCron } from '../utils/interval-parser.js';
import { AgentError } from './errors.js';

export interface GardenerJob {
  type: string;
  tier: 'realtime' | 'frequent' | 'periodic';
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

export interface AgentContext {
  job: PgBoss.Job<unknown>;
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  checkpoint: (state: unknown) => Promise<void>;
  restoreCheckpoint: () => Promise<unknown | null>;
  traceId: string | null;
  config: Config;
  services: {
    ml: typeof ml;
    controller: GardenerController;
  };
  signal: AbortSignal;
}

export interface GardenerAgent {
  name: string;
  tier: 'realtime' | 'frequent' | 'periodic';
  execute: (context: AgentContext) => Promise<JobResult>;
}

const TIER_DEFAULTS = {
  realtime: { retryLimit: 2, expireInSeconds: 30 },
  frequent: { retryLimit: 3, expireInSeconds: 120 },
  periodic: { retryLimit: 3, expireInSeconds: 600 },
};

class GardenerController {
  private boss: PgBoss;
  private handlers: Map<string, (context: AgentContext) => Promise<JobResult>> = new Map();
  private tierMap: Map<string, string> = new Map();
  private running = false;

  constructor(boss: PgBoss) {
    this.boss = boss;
  }

  /**
   * Register a job handler
   */
  registerHandler(
    jobType: string,
    handler: (context: AgentContext) => Promise<JobResult>
  ): void {
    this.handlers.set(jobType, handler);
    console.log(`📋 Registered Gardener handler: ${jobType}`);
  }

  /**
   * Register an agent
   */
  registerAgent(agent: GardenerAgent): void {
    const jobType = `gardener:${agent.name}`;
    const handler = async (context: AgentContext) => agent.execute(context);
    this.registerHandler(jobType, handler);
    this.tierMap.set(jobType, agent.tier);
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

    // Set up scheduled jobs
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
    handler: (context: AgentContext) => Promise<JobResult>
  ): Promise<void> {
    const startTime = Date.now();
    const jobId = job.id;

    // Extract traceId from payload (memoryId is the standard correlation key)
    const traceId = (job.data as Record<string, unknown>)?.memoryId as string ?? null;

    // Create AbortController with tier-based timeout
    const tier = (this.tierMap.get(jobType) || 'realtime') as keyof typeof TIER_DEFAULTS;
    const timeoutMs = TIER_DEFAULTS[tier].expireInSeconds * 1000;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);

    // Create context
    const context: AgentContext = {
      job,
      log: (message: string, level = 'info') => {
        const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '📝';
        const tracePrefix = traceId ? `[${traceId.slice(0, 8)}] ` : '';
        console.log(`${prefix} [${jobType}] ${tracePrefix}${message}`);
      },
      checkpoint: async (state: unknown) => {
        await this.checkpoint(jobId, state);
      },
      restoreCheckpoint: async () => {
        return this.restoreCheckpoint(jobId);
      },
      traceId,
      config,
      services: {
        ml,
        controller: this,
      },
      signal: abortController.signal,
    };

    // Record start (with traceId)
    await this.recordJobStart(jobId, jobType, traceId);

    try {
      // Execute handler
      const result = await handler(context);

      // Record completion (with real metrics)
      const duration = Date.now() - startTime;
      await this.recordJobComplete(jobId, duration, result, jobType);

      // Queue follow-up jobs
      if (result.nextJobs?.length) {
        for (const nextJob of result.nextJobs) {
          await this.enqueue(nextJob);
        }
      }

    } catch (error) {
      const duration = Date.now() - startTime;
      const isRetryable = error instanceof AgentError ? error.retryable : true;
      await this.recordJobError(jobId, duration, String(error));

      if (!isRetryable) {
        context.log(`Terminal error — will not retry: ${error}`, 'error');
        return; // pg-boss marks job complete, no retry
      }
      throw error; // pg-boss retries
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Enqueue a new job
   */
  async enqueue(job: GardenerJob): Promise<string> {
    const adjustedPriority = job.priority || 0;

    // Map tier to pg-boss options
    const tierDefaults = TIER_DEFAULTS[job.tier];
    const opts = { ...tierDefaults, ...job.opts };

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
   * Set up scheduled jobs
   * Uses configurable intervals from environment variables
   */
  private async setupSchedules(): Promise<void> {
    try {
      // Convert interval strings to cron expressions
      const frequentCron = intervalToCron(config.GARDENER_FREQUENT_INTERVAL);
      const periodicCron = intervalToCron(config.GARDENER_PERIODIC_INTERVAL);

      console.log(`📅 Configuring gardener schedules:`);
      console.log(`   Frequent: ${config.GARDENER_FREQUENT_INTERVAL} (${frequentCron})`);
      console.log(`   Periodic: ${config.GARDENER_PERIODIC_INTERVAL} (${periodicCron})`);

      // Frequent tier: summarizer, relationship catch-up, and context linking
      await this.boss.schedule('gardener:summarize', frequentCron, {});
      await this.boss.schedule('gardener:relationships', frequentCron, {});
      await this.boss.schedule('gardener:context-linker', frequentCron, {});

      // Periodic tier: schema alignment and conflict resolution
      await this.boss.schedule('gardener:align-schema', periodicCron, {});
      await this.boss.schedule('gardener:resolve-conflicts', periodicCron, {});

      // Nightly: community detection (midnight), contradiction scanner (1 AM), ontology evolution (2 AM), insights (3 AM)
      await this.boss.schedule('gardener:community-detection', '0 0 * * *', {});
      await this.boss.schedule('gardener:contradiction-scanner', '0 1 * * *', {});
      await this.boss.schedule('gardener:ontology-evolution', '0 2 * * *', {});
      await this.boss.schedule('gardener:generate-insights', '0 3 * * *', {});

      // Daily: morning briefing (6 AM)
      await this.boss.schedule('gardener:briefing', '0 6 * * *', {});

      console.log('✅ Gardener schedules configured successfully');
    } catch (error) {
      console.warn('⚠️  Failed to set up schedules:', error);
    }
  }

  /**
   * Checkpoint a long-running job
   */
  async checkpoint(jobId: string, state: unknown): Promise<void> {
    try {
      await db.execute(sql`
        UPDATE gardener_job_meta
        SET checkpoint = ${JSON.stringify(state)}::jsonb,
            checkpoint_at = NOW()
        WHERE job_id = ${jobId}::uuid
      `);
    } catch (error) {
      console.warn('Failed to save checkpoint:', error);
    }
  }

  /**
   * Restore checkpoint for a job
   */
  async restoreCheckpoint(jobId: string): Promise<unknown | null> {
    try {
      const rows = await rawQuery<{ checkpoint: unknown }>(sql`
        SELECT checkpoint FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `);
      return rows[0]?.checkpoint || null;
    } catch (error) {
      console.warn('Failed to restore checkpoint:', error);
      return null;
    }
  }

  // Recording methods
  private async recordJobMeta(jobId: string, job: GardenerJob): Promise<void> {
    try {
      const traceId = (job.payload.memoryId as string) ?? null;
      await db.execute(sql`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, priority, trace_id)
        VALUES (${jobId}::uuid, ${job.type}, ${job.tier}, ${job.priority || 0}, ${traceId})
        ON CONFLICT (job_id) DO NOTHING
      `);
    } catch (error) {
      console.warn('Failed to record job meta:', error);
    }
  }

  private async recordJobStart(jobId: string, jobType: string, traceId: string | null): Promise<void> {
    const tier = this.tierMap.get(jobType) || 'realtime';
    try {
      await db.execute(sql`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, started_at, attempts, trace_id)
        VALUES (${jobId}::uuid, ${jobType}, ${tier}, NOW(), 1, ${traceId})
        ON CONFLICT (job_id) DO UPDATE
        SET started_at = NOW(), attempts = gardener_job_meta.attempts + 1
      `);
    } catch (error) {
      console.warn('Failed to record job start:', error);
    }
  }

  private async recordJobComplete(jobId: string, durationMs: number, result: JobResult, jobType: string): Promise<void> {
    try {
      // Update job_meta with outputs
      await db.execute(sql`
        UPDATE gardener_job_meta
        SET completed_at = NOW(), duration_ms = ${durationMs},
            outputs = ${JSON.stringify(result.outputs || {})}::jsonb
        WHERE job_id = ${jobId}::uuid
      `);

      // Write to gardener_metrics for aggregate stats
      const agentName = jobType.replace('gardener:', '');
      await db.execute(sql`
        INSERT INTO gardener_metrics (
          job_id, agent_name, execution_time_ms, success,
          quality_score, items_processed, agent_specific_metrics
        ) VALUES (
          ${jobId}::uuid, ${agentName}, ${durationMs}, ${result.success},
          ${result.metrics?.confidence ?? null},
          ${result.metrics?.itemsProcessed ?? 0},
          ${JSON.stringify(result.outputs || {})}::jsonb
        )
      `);
    } catch (error) {
      console.warn('Failed to record job completion:', error);
    }
  }

  private async recordJobError(jobId: string, durationMs: number, error: string): Promise<void> {
    try {
      await db.execute(sql`
        UPDATE gardener_job_meta
        SET duration_ms = ${durationMs}, last_error = ${error}
        WHERE job_id = ${jobId}::uuid
      `);
    } catch (dbError) {
      console.warn('Failed to record job error:', dbError);
    }
  }

  /**
   * Get controller stats
   */
  async getStats(): Promise<{
    jobsByTier: Record<string, number>;
    recentJobs: Array<{ type: string; status: string; duration: number }>;
  }> {
    try {
      const tierRows = await rawQuery<{ tier: string; count: number }>(sql`
        SELECT tier, COUNT(*) as count FROM gardener_job_meta GROUP BY tier
      `);

      return {
        jobsByTier: Object.fromEntries(
          tierRows.map(r => [r.tier, r.count])
        ),
        recentJobs: [],
      };
    } catch (error) {
      console.warn('Failed to get stats:', error);
      return { jobsByTier: {}, recentJobs: [] };
    }
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

export type { GardenerController };
