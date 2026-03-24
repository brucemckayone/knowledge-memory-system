/**
 * Continuous Benchmark Types
 *
 * Defines types for long-running continuous benchmarks that
 * simulate real-world system behavior over extended periods.
 */

import type { BenchmarkMessage } from '../utils/message-factory.js';

/**
 * Continuous benchmark configuration
 */
export interface ContinuousBenchmarkOptions {
  /** Total duration to run (e.g., "30m", "2h", "24h", "2d") */
  duration: string;

  /** Message injection rate (messages per minute) */
  injectionRate: number;

  /** Checkpoint interval (e.g., "5m", "15m", "1h") */
  checkpointInterval: string;

  /** Whether to start web dashboard */
  enableDashboard: boolean;

  /** Dashboard port (default: 3001) */
  dashboardPort: number;

  /** Scenario to run continuously */
  scenario?: string;

  /** Max messages to inject (0 = unlimited) */
  maxMessages?: number;
}

/**
 * Checkpoint data collected at regular intervals
 */
export interface BenchmarkCheckpoint {
  /** Checkpoint timestamp */
  timestamp: Date;

  /** Elapsed time since start (ms) */
  elapsedMs: number;

  /** Database metrics */
  metrics: {
    /** Total entities in database */
    entityCount: number;

    /** Total facts in database */
    factCount: number;

    /** Total tasks in database */
    taskCount: number;

    /** Total memories in database */
    memoryCount: number;

    /** Pending queue jobs */
    pendingJobs: number;

    /** Completed gardener jobs */
    completedJobs: number;
  };

  /** Quality metrics (if available) */
  quality?: {
    f1Score: number;
    precision: number;
    recall: number;
  };

  /** Performance metrics */
  performance: {
    /** Avg message processing time (ms) */
    avgProcessingTime: number;

    /** Throughput (messages/sec) */
    throughput: number;

    /** Queue depth */
    queueDepth: number;
  };

  /** Gardener agent status */
  gardenerStatus: {
    /** Last run time for each agent */
    lastRunTimes: Record<string, Date>;

    /** Agent execution counts */
    executionCounts: Record<string, number>;
  };
}

/**
 * Continuous benchmark results
 */
export interface ContinuousBenchmarkResults {
  /** Unique run identifier */
  runId: string;

  /** Start timestamp */
  startTime: Date;

  /** End timestamp */
  endTime: Date;

  /** Configuration used */
  config: ContinuousBenchmarkOptions;

  /** All checkpoints collected */
  checkpoints: BenchmarkCheckpoint[];

  /** Total messages injected */
  totalMessages: number;

  /** Final metrics */
  finalMetrics: BenchmarkCheckpoint['metrics'];

  /** Final quality score */
  finalF1Score: number;

  /** Time-series data for charts */
  timeSeries: {
    /** Timestamps for each checkpoint */
    timestamps: Date[];

    /** Entity count over time */
    entityCounts: number[];

    /** Fact count over time */
    factCounts: number[];

    /** Task count over time */
    taskCounts: number[];

    /** F1 score over time */
    f1Scores: number[];
  };
}

/**
 * Message injection schedule
 */
export interface InjectionSchedule {
  /** Messages to inject at this time */
  messages: BenchmarkMessage[];

  /** When to inject (relative to start) */
  injectAt: Date;

  /** Batch identifier */
  batchId: string;
}

/**
 * Continuous benchmark state (for resume capability)
 */
export interface ContinuousBenchmarkState {
  runId: string;
  startTime: Date;
  lastCheckpoint: Date;
  messagesInjected: number;
  checkpoints: BenchmarkCheckpoint[];
}
