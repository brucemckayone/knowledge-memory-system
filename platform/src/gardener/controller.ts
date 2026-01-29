/**
 * Gardener Controller
 * 
 * Central controller for the KARMA agent architecture.
 * Manages priority scheduling, MAB-based exploration, and job orchestration.
 */

import PgBoss from 'pg-boss';
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { config } from '../config.js';
import { intervalToCron } from '../utils/interval-parser.js';

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

export interface AgentContext {
  job: PgBoss.Job<unknown>;
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  checkpoint: (state: unknown) => Promise<void>;
  restoreCheckpoint: () => Promise<unknown | null>;
}

export interface GardenerAgent {
  name: string;
  tier: 'realtime' | 'frequent' | 'periodic' | 'deep';
  execute: (context: AgentContext) => Promise<JobResult>;
}

const TIER_DEFAULTS = {
  realtime: { retryLimit: 2, expireInSeconds: 30 },
  frequent: { retryLimit: 3, expireInSeconds: 120 },
  periodic: { retryLimit: 3, expireInSeconds: 600 },
  deep: { retryLimit: 1, expireInSeconds: 3600 },
};

class GardenerController {
  private boss: PgBoss;
  private handlers: Map<string, (context: AgentContext) => Promise<JobResult>> = new Map();
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
    const handler = async (context: AgentContext) => agent.execute(context);
    this.registerHandler(`gardener:${agent.name}`, handler);
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
    
    // Create context
    const context: AgentContext = {
      job,
      log: (message: string, level = 'info') => {
        const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '📝';
        console.log(`${prefix} [${jobType}] ${message}`);
      },
      checkpoint: async (state: unknown) => {
        await this.checkpoint(jobId, state);
      },
      restoreCheckpoint: async () => {
        return this.restoreCheckpoint(jobId);
      },
    };
    
    // Record start
    await this.recordJobStart(jobId, jobType);
    
    try {
      // Execute handler
      const result = await handler(context);
      
      // Record completion
      const duration = Date.now() - startTime;
      await this.recordJobComplete(jobId, duration, result);
      
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
      await this.recordJobError(jobId, duration, String(error));
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
   * Get MAB score for job type (UCB1 algorithm)
   */
  private async getMabScore(jobType: string): Promise<number> {
    try {
      const result = await db.execute(sql`
        SELECT ucb_score FROM mab_state WHERE arm = ${jobType}
      `);
      const rows = (result as unknown as { rows: Array<{ ucb_score: number }> }).rows;
      return rows[0]?.ucb_score || 1.0;
    } catch {
      return 1.0;
    }
  }

  /**
   * Update MAB reward after job completion
   */
  private async updateMabReward(jobType: string, reward: number): Promise<void> {
    try {
      await db.execute(sql`
        SELECT update_mab_reward(${jobType}, ${reward})
      `);
    } catch {
      // Ignore errors
    }
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
      const deepCron = intervalToCron(config.GARDENER_DEEP_INTERVAL);

      console.log(`📅 Configuring gardener schedules:`);
      console.log(`   Frequent: ${config.GARDENER_FREQUENT_INTERVAL} (${frequentCron})`);
      console.log(`   Periodic: ${config.GARDENER_PERIODIC_INTERVAL} (${periodicCron})`);
      console.log(`   Deep: ${config.GARDENER_DEEP_INTERVAL} (${deepCron})`);

      // Frequent tier: summarizer and evaluator
      await this.boss.schedule('gardener:summarize', frequentCron, {});
      await this.boss.schedule('gardener:evaluate', frequentCron, {});

      // Periodic tier: schema alignment and conflict resolution
      await this.boss.schedule('gardener:align-schema', periodicCron, {});
      await this.boss.schedule('gardener:resolve-conflicts', periodicCron, {});

      // Deep tier: community detection and insight generation
      // Note: These use fixed times (3am and 4am) regardless of interval
      await this.boss.schedule('gardener:community-detection', '0 3 * * *', {});
      await this.boss.schedule('gardener:insight-generation', '0 4 * * *', {});

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
    } catch {
      // Ignore errors
    }
  }

  /**
   * Restore checkpoint for a job
   */
  async restoreCheckpoint(jobId: string): Promise<unknown | null> {
    try {
      const result = await db.execute(sql`
        SELECT checkpoint FROM gardener_job_meta WHERE job_id = ${jobId}::uuid
      `);
      const rows = (result as unknown as { rows: Array<{ checkpoint: unknown }> }).rows;
      return rows[0]?.checkpoint || null;
    } catch {
      return null;
    }
  }

  // Recording methods
  private async recordJobMeta(jobId: string, job: GardenerJob): Promise<void> {
    try {
      await db.execute(sql`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, priority)
        VALUES (${jobId}::uuid, ${job.type}, ${job.tier}, ${job.priority || 0})
        ON CONFLICT (job_id) DO NOTHING
      `);
    } catch {
      // Ignore errors
    }
  }

  private async recordJobStart(jobId: string, jobType: string): Promise<void> {
    try {
      await db.execute(sql`
        INSERT INTO gardener_job_meta (job_id, job_type, tier, started_at, attempts)
        VALUES (${jobId}::uuid, ${jobType}, 'realtime', NOW(), 1)
        ON CONFLICT (job_id) DO UPDATE
        SET started_at = NOW(), attempts = gardener_job_meta.attempts + 1
      `);
    } catch {
      // Ignore errors
    }
  }

  private async recordJobComplete(jobId: string, durationMs: number, _result: JobResult): Promise<void> {
    try {
      await db.execute(sql`
        UPDATE gardener_job_meta
        SET completed_at = NOW(), duration_ms = ${durationMs}
        WHERE job_id = ${jobId}::uuid
      `);
    } catch {
      // Ignore errors
    }
  }

  private async recordJobError(jobId: string, durationMs: number, error: string): Promise<void> {
    try {
      await db.execute(sql`
        UPDATE gardener_job_meta
        SET duration_ms = ${durationMs}, last_error = ${error}
        WHERE job_id = ${jobId}::uuid
      `);
    } catch {
      // Ignore errors
    }
  }

  /**
   * Get controller stats
   */
  async getStats(): Promise<{
    jobsByTier: Record<string, number>;
    mabState: Array<{ arm: string; pulls: number; avgReward: number; ucbScore: number }>;
    recentJobs: Array<{ type: string; status: string; duration: number }>;
  }> {
    try {
      const mabResult = await db.execute(sql`
        SELECT arm, pulls, avg_reward, ucb_score FROM mab_state ORDER BY ucb_score DESC
      `);
      
      const tierResult = await db.execute(sql`
        SELECT tier, COUNT(*) as count FROM gardener_job_meta GROUP BY tier
      `);

      return {
        jobsByTier: Object.fromEntries(
          (tierResult as unknown as { rows: Array<{ tier: string; count: number }> }).rows
            .map(r => [r.tier, r.count])
        ),
        mabState: (mabResult as unknown as { rows: Array<{ arm: string; pulls: number; avg_reward: number; ucb_score: number }> }).rows
          .map(r => ({
            arm: r.arm,
            pulls: r.pulls,
            avgReward: r.avg_reward,
            ucbScore: r.ucb_score,
          })),
        recentJobs: [],
      };
    } catch {
      return { jobsByTier: {}, mabState: [], recentJobs: [] };
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
