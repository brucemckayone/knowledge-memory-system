#!/usr/bin/env node
/**
 * E2E Benchmark CLI for Knowledge Memory System
 *
 * This CLI runs comprehensive benchmarks that inject realistic test data
 * through the actual system pipeline and measure performance/quality.
 *
 * Supports two modes:
 * - Batch mode: Complete processing in seconds (default)
 * - Continuous mode: Long-running with streaming injection and checkpoints
 */

import { initQueue, getQueue } from '../queue/index.js';
import { runBenchmark } from './orchestrator.js';
import { runContinuousBenchmark } from './modes/continuous.js';
import { generateReport } from './report/html-generator.js';
import { generateContinuousReport } from './report/continuous-report.js';

interface CliOptions {
  scenario?: string;
  scale?: string;
  timespan?: string;
  volume?: number;
  reportOnly?: boolean;
  history?: number;

  // Continuous mode options
  mode?: 'batch' | 'continuous';
  duration?: string;
  injectionRate?: number;
  checkpoint?: string;
  dashboard?: boolean;
  dashboardPort?: number;
  maxMessages?: number;
}

/**
 * Parse CLI arguments
 */
function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--scenario':
        options.scenario = next;
        i++;
        break;
      case '--scale':
        options.scale = next;
        i++;
        break;
      case '--timespan':
        options.timespan = next;
        i++;
        break;
      case '--volume':
        options.volume = parseInt(next || '0', 10);
        i++;
        break;
      case '--report-only':
        options.reportOnly = true;
        break;
      case '--history':
        options.history = parseInt(next || '0', 10);
        i++;
        break;

      // Continuous mode options
      case '--mode':
        options.mode = next as 'batch' | 'continuous';
        i++;
        break;
      case '--duration':
        options.duration = next;
        i++;
        break;
      case '--injection-rate':
        options.injectionRate = parseInt(next || '0', 10);
        i++;
        break;
      case '--checkpoint':
        options.checkpoint = next;
        i++;
        break;
      case '--dashboard':
        options.dashboard = true;
        break;
      case '--dashboard-port':
        options.dashboardPort = parseInt(next || '3001', 10);
        i++;
        break;
      case '--max-messages':
        options.maxMessages = parseInt(next || '0', 10);
        i++;
        break;
    }
  }

  return options;
}

/**
 * Display usage information
 */
function showUsage(): void {
  console.log(`
📊 E2E Benchmark & Performance Profiling System

Usage:
  pnpm run benchmark [options]

Modes:
  --mode <batch|continuous>  Benchmark mode (default: batch)

Batch Mode Options:
  --scenario <name>     Run specific scenario (e.g., deduplication, conflicts)
  --scale <size>        Dataset scale: light|medium|heavy (default: medium)
  --timespan <period>   Temporal distribution: 1week|1month|3months|6months (default: 1month)
  --volume <count>      Custom message count (overrides --scale)

Continuous Mode Options:
  --duration <time>     Run duration (e.g., 30m, 2h, 24h, 2d)
  --injection-rate <n>  Messages per minute (default: 10)
  --checkpoint <time>   Checkpoint interval (e.g., 5m, 15m, 1h) (default: 15m)
  --dashboard           Enable web dashboard (default: false)
  --dashboard-port <n>  Dashboard port (default: 3001)
  --max-messages <n>    Maximum messages to inject (default: unlimited)

Common Options:
  --report-only         Generate report from existing results
  --history <count>     Show historical comparison (last N runs)

Examples:
  # Batch mode (default)
  pnpm run benchmark                                    # Quick benchmark
  pnpm run benchmark --scenario entity-extraction       # Test entity extraction
  pnpm run benchmark --scale heavy --timespan 6months   # Large dataset

  # Continuous mode
  pnpm run benchmark --mode continuous --duration 30m           # 30 min test
  pnpm run benchmark --mode continuous --duration 2h --injection-rate 20  # 2 hour test
  pnpm run benchmark --mode continuous --duration 4h --dashboard         # With dashboard

  # Fast development cycle (with accelerated gardener)
  GARDENER_FREQUENT_INTERVAL=30s GARDENER_PERIODIC_INTERVAL=2m \\
  pnpm run benchmark --mode continuous --duration 30m --dashboard

Scenarios:
  Quality Benchmarks:
    entity-extraction      Test entity recognition
    deduplication          Test entity merging
    fact-extraction        Test relationship extraction
    temporal-tracking      Test fact supersedion
    task-extraction        Test action item identification

  Edge Cases:
    conflicts              Contradictory facts
    complex-relationships  Multi-hop relationships
    ambiguous-references   Pronoun resolution
    cross-context-entities Same entity across conversations

  Stress Tests:
    high-volume            Thousands of messages
    concurrent-threads     Multiple conversations
    complex-embeddings     Large content processing
`);
}

/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Show help
  if (args.includes('--help') || args.includes('-h')) {
    showUsage();
    process.exit(0);
  }

  const options = parseArgs(args);

  console.log('📊 E2E Benchmark & Performance Profiling System\n');

  try {
    // Initialize queue
    console.log('🔌 Initializing queue...');
    await initQueue();

    // Report-only mode
    if (options.reportOnly) {
      console.log('📈 Generating report from existing results...\n');
      await generateReport();
      console.log('\n✅ Report generated: benchmark-reports/latest.html');
      process.exit(0);
    }

    // Route to appropriate mode
    const mode = options.mode || 'batch';

    if (mode === 'continuous') {
      // Continuous mode
      const results = await runContinuousBenchmark({
        duration: options.duration || '30m',
        injectionRate: options.injectionRate || 10,
        checkpointInterval: options.checkpoint || '15m',
        enableDashboard: options.dashboard || false,
        dashboardPort: options.dashboardPort || 3001,
        scenario: options.scenario,
        maxMessages: options.maxMessages,
      });

      // Generate report
      console.log('\n📈 Generating continuous report...');
      await generateContinuousReport(results);

      console.log('\n✅ Continuous benchmark complete!');
      console.log(`📄 Run ID: ${results.runId}`);
      console.log(`📊 Report: benchmark-reports/${results.runId}.html`);
      console.log(`💾 Results: .benchmark-history/${results.runId}.json`);

    } else {
      // Batch mode (default)
      const results = await runBenchmark({
        scenario: options.scenario,
        scale: options.scale as any,
        timespan: options.timespan as any,
        volume: options.volume,
      });

      // Generate report
      console.log('\n📈 Generating report...');
      await generateReport(results);

      console.log('\n✅ Benchmark complete!');
      console.log(`📄 Report: benchmark-reports/latest.html`);
      console.log(`💾 Results: .benchmark-history/run-${results.runId}.json`);

      // Show summary
      console.log('\n📊 Summary:');
      console.log(`   Messages processed: ${results.metrics.totalMessages}`);
      console.log(`   Processing time: ${(results.metrics.totalProcessingTime / 1000).toFixed(2)}s`);
      console.log(`   Entities extracted: ${results.metrics.entityCount}`);
      console.log(`   Facts extracted: ${results.metrics.factCount}`);
      console.log(`   Tasks created: ${results.metrics.taskCount}`);
      console.log(`   F1 Score: ${results.metrics.f1Score.toFixed(3)}`);
    }

    // Shutdown
    const queue = getQueue();
    await queue.stop();

    process.exit(0);

  } catch (error) {
    console.error('\n❌ Benchmark failed:', error);
    process.exit(1);
  }
}

// Run CLI
main();
