/**
 * Continuous Benchmark Runner
 *
 * Executes long-running benchmarks that simulate real-world system behavior.
 * Features:
 * - Streaming message injection over time
 * - Periodic checkpoint collection
 * - Graceful shutdown support
 * - Dashboard integration
 */

import type { BenchmarkMessage } from '../../utils/message-factory.js';
import type {
  ContinuousBenchmarkOptions,
  ContinuousBenchmarkResults,
  BenchmarkCheckpoint,
  InjectionSchedule,
} from '../types/continuous.js';
import { generateEntityExtractionScenario } from '../scenarios/quality/entity-extraction.js';
import { generateFactExtractionScenario } from '../scenarios/quality/fact-extraction.js';
import { injectMessages } from '../injection/queue-injector.js';
import {
  createCheckpoint,
  saveCheckpoint,
  loadCheckpoints,
} from '../monitor.js';
import { parseIntervalToMs } from '../../utils/interval-parser.js';
import { initQueue, getQueue } from '../../queue/index.js';
import { startDashboard, updateDashboard, stopDashboard } from '../dashboard/server.js';

/**
 * Generate unique run ID
 */
function generateRunId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = Math.random().toString(36).substring(2, 8);
  return `continuous-${timestamp}-${random}`;
}

/**
 * Calculate injection schedule based on duration and rate
 */
function calculateInjectionSchedule(
  startTime: Date,
  durationMs: number,
  messagesPerMinute: number,
  scenarioMessages: BenchmarkMessage[],
  maxMessages?: number
): InjectionSchedule[] {
  const schedule: InjectionSchedule[] = [];

  // Calculate total minutes and messages
  const totalMinutes = Math.floor(durationMs / 60000);
  const messagesPerBatch = Math.max(1, Math.floor(messagesPerMinute / 2)); // Inject every 30 seconds

  // Limit to max messages if specified
  const totalMessages = maxMessages
    ? Math.min(maxMessages, scenarioMessages.length * Math.ceil(totalMinutes))
    : scenarioMessages.length * Math.ceil(totalMinutes);

  let messagesInjected = 0;
  let batchId = 0;

  for (let minute = 0; minute < totalMinutes; minute++) {
    // Inject twice per minute (every 30 seconds)
    for (const offset of [0, 30000]) {
      if (messagesInjected >= totalMessages) break;

      const injectAt = new Date(startTime.getTime() + minute * 60000 + offset);

      // Select random messages from scenario
      const batchMessages: BenchmarkMessage[] = [];
      const batchSize = Math.min(messagesPerBatch, totalMessages - messagesInjected);

      for (let i = 0; i < batchSize; i++) {
        // Cycle through scenario messages
        const message = scenarioMessages[messagesInjected % scenarioMessages.length];
        batchMessages.push({
          ...message,
          messageId: message.messageId + messagesInjected,
          timestamp: injectAt.toISOString(),
        });
        messagesInjected++;
      }

      schedule.push({
        messages: batchMessages,
        injectAt,
        batchId: `batch-${batchId++}`,
      });
    }

    if (messagesInjected >= totalMessages) break;
  }

  return schedule;
}

/**
 * Run continuous benchmark
 */
export async function runContinuousBenchmark(
  options: ContinuousBenchmarkOptions
): Promise<ContinuousBenchmarkResults> {
  const runId = generateRunId();
  const startTime = new Date();

  console.log(`🚀 Starting continuous benchmark: ${runId}`);
  console.log(`⏱️  Duration: ${options.duration}`);
  console.log(`💬 Injection rate: ${options.injectionRate} messages/minute`);
  console.log(`📊 Checkpoint interval: ${options.checkpointInterval}\n`);

  // Initialize queue
  await initQueue();
  const queue = getQueue();

  // Parse intervals
  const durationMs = parseIntervalToMs(options.duration);
  const checkpointIntervalMs = parseIntervalToMs(options.checkpointInterval);
  const endTime = new Date(startTime.getTime() + durationMs);

  console.log(`📅 Start time: ${startTime.toISOString()}`);
  console.log(`📅 End time: ${endTime.toISOString()}`);
  console.log(`⏱️  Total duration: ${(durationMs / 1000 / 60).toFixed(1)} minutes\n`);

  // Start dashboard if enabled
  let dashboardServer: Awaited<ReturnType<typeof startDashboard>> | undefined;
  if (options.enableDashboard) {
    try {
      dashboardServer = await startDashboard({
        port: options.dashboardPort,
        runId,
      });
    } catch (error) {
      console.warn('⚠️  Failed to start dashboard:', error);
      console.log('   Continuing without dashboard...\n');
    }
  }

  // Generate or load scenario messages
  const scenarioMessages = options.scenario === 'entity-extraction'
    ? generateEntityExtractionScenario()
    : options.scenario === 'fact-extraction'
    ? generateFactExtractionScenario()
    : generateEntityExtractionScenario(); // Default

  console.log(`📝 Generated ${scenarioMessages.length} unique scenario messages`);

  // Calculate injection schedule
  const injectionSchedule = calculateInjectionSchedule(
    startTime,
    durationMs,
    options.injectionRate,
    scenarioMessages,
    options.maxMessages
  );

  const totalMessagesToInject = injectionSchedule.reduce((sum, batch) => sum + batch.messages.length, 0);
  console.log(`📅 Scheduled ${totalMessagesToInject} message injections across ${injectionSchedule.length} batches\n`);

  // State
  const checkpoints: BenchmarkCheckpoint[] = [];
  let messagesInjected = 0;
  let lastCheckpointTime = startTime;
  let shutdownRequested = false;

  // Setup graceful shutdown
  const shutdownHandler = async () => {
    console.log('\n🛑 Shutdown requested, finishing current batch...');
    shutdownRequested = true;
  };

  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);

  try {
    console.log('▶️  Starting continuous execution...\n');

    // Main execution loop
    let scheduleIndex = 0;
    const initialCheckpoint = await createCheckpoint(startTime, startTime, 0);
    checkpoints.push(initialCheckpoint);
    await saveCheckpoint(runId, initialCheckpoint);

    console.log('📊 Initial checkpoint collected');
    console.log(`   Entities: ${initialCheckpoint.metrics.entityCount}`);
    console.log(`   Facts: ${initialCheckpoint.metrics.factCount}`);
    console.log(`   Tasks: ${initialCheckpoint.metrics.taskCount}`);
    console.log(`   Memories: ${initialCheckpoint.metrics.memoryCount}\n`);

    while (scheduleIndex < injectionSchedule.length && !shutdownRequested) {
      const batch = injectionSchedule[scheduleIndex];
      const now = new Date();

      // Check if we should wait for the batch time
      if (now < batch.injectAt) {
        const waitTime = batch.injectAt.getTime() - now.getTime();
        if (waitTime > 0) {
          await sleep(Math.min(waitTime, 5000)); // Sleep in 5s chunks to check for shutdown
        }
        continue;
      }

      // Inject messages
      console.log(`💬 Injecting batch ${batch.batchId}: ${batch.messages.length} messages`);
      await injectMessages(batch.messages, {
        rateLimit: 10, // Inject at 10 msg/sec per batch
        onProgress: (injected, total) => {
          // Silent progress
        },
      });

      messagesInjected += batch.messages.length;
      console.log(`✅ Batch complete (${messagesInjected}/${totalMessagesToInject} total)\n`);

      // Check if it's time for a checkpoint
      const timeSinceLastCheckpoint = now.getTime() - lastCheckpointTime.getTime();
      if (timeSinceLastCheckpoint >= checkpointIntervalMs) {
        console.log('📊 Collecting checkpoint...');
        const checkpoint = await createCheckpoint(startTime, now, messagesInjected);
        checkpoints.push(checkpoint);
        await saveCheckpoint(runId, checkpoint);

        // Update dashboard if enabled
        if (dashboardServer) {
          updateDashboard(dashboardServer, checkpoint);
        }

        console.log(`   Elapsed: ${(checkpoint.elapsedMs / 1000 / 60).toFixed(1)} minutes`);
        console.log(`   Entities: ${checkpoint.metrics.entityCount} (+${checkpoint.metrics.entityCount - checkpoints[checkpoints.length - 2].metrics.entityCount})`);
        console.log(`   Facts: ${checkpoint.metrics.factCount} (+${checkpoint.metrics.factCount - checkpoints[checkpoints.length - 2].metrics.factCount})`);
        console.log(`   Tasks: ${checkpoint.metrics.taskCount} (+${checkpoint.metrics.taskCount - checkpoints[checkpoints.length - 2].metrics.taskCount})`);
        console.log(`   Queue depth: ${checkpoint.performance.queueDepth}`);
        console.log(`   Throughput: ${checkpoint.performance.throughput.toFixed(2)} msg/sec\n`);

        lastCheckpointTime = now;
      }

      scheduleIndex++;
    }

    // Final checkpoint
    console.log('📊 Collecting final checkpoint...');
    const finalCheckpoint = await createCheckpoint(startTime, new Date(), messagesInjected);
    checkpoints.push(finalCheckpoint);
    await saveCheckpoint(runId, finalCheckpoint);

    console.log(`\n✅ Continuous benchmark complete!`);
    console.log(`   Total duration: ${((finalCheckpoint.elapsedMs) / 1000 / 60).toFixed(1)} minutes`);
    console.log(`   Messages injected: ${messagesInjected}`);
    console.log(`   Checkpoints collected: ${checkpoints.length}`);
    console.log(`   Final entities: ${finalCheckpoint.metrics.entityCount}`);
    console.log(`   Final facts: ${finalCheckpoint.metrics.factCount}`);
    console.log(`   Final tasks: ${finalCheckpoint.metrics.taskCount}`);

    // Compile results
    const results: ContinuousBenchmarkResults = {
      runId,
      startTime,
      endTime: new Date(),
      config: options,
      checkpoints,
      totalMessages: messagesInjected,
      finalMetrics: finalCheckpoint.metrics,
      finalF1Score: finalCheckpoint.quality?.f1Score || 0,
      timeSeries: {
        timestamps: checkpoints.map(c => c.timestamp),
        entityCounts: checkpoints.map(c => c.metrics.entityCount),
        factCounts: checkpoints.map(c => c.metrics.factCount),
        taskCounts: checkpoints.map(c => c.metrics.taskCount),
        f1Scores: checkpoints.map(c => c.quality?.f1Score || 0),
      },
    };

    // Save results
    await saveResults(runId, results);

    return results;

  } finally {
    // Cleanup
    process.off('SIGINT', shutdownHandler);
    process.off('SIGTERM', shutdownHandler);

    // Stop dashboard
    if (dashboardServer) {
      await stopDashboard(dashboardServer.server);
    }

    // Stop queue
    await queue.stop();
  }
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Save benchmark results to disk
 */
async function saveResults(runId: string, results: ContinuousBenchmarkResults): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');

  const resultsDir = path.join(process.cwd(), '.benchmark-history');
  const filepath = path.join(resultsDir, `${runId}.json`);

  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(filepath, JSON.stringify(results, null, 2));

  console.log(`💾 Results saved to: ${filepath}`);
}

/**
 * Load previous continuous benchmark results
 */
export async function loadContinuousResults(runId: string): Promise<ContinuousBenchmarkResults | null> {
  const fs = await import('fs/promises');
  const path = await import('path');

  const filepath = path.join(process.cwd(), '.benchmark-history', `${runId}.json`);

  try {
    const content = await fs.readFile(filepath, 'utf-8');
    const results = JSON.parse(content) as ContinuousBenchmarkResults;

    // Convert date strings back to Date objects
    results.startTime = new Date(results.startTime);
    results.endTime = new Date(results.endTime);
    results.checkpoints.forEach(c => {
      c.timestamp = new Date(c.timestamp);
    });
    results.timeSeries.timestamps.forEach((t, i) => {
      results.timeSeries.timestamps[i] = new Date(t as unknown as string);
    });

    return results;
  } catch (error) {
    console.error(`Failed to load results for ${runId}:`, error);
    return null;
  }
}
