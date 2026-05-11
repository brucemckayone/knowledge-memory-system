/**
 * Benchmark Orchestrator
 *
 * Coordinates the entire benchmark lifecycle:
 * 1. Generate scenarios
 * 2. Inject messages into queue
 * 3. Wait for processing
 * 4. Collect results
 * 5. Validate against ground truth
 * 6. Return metrics
 */

import type { BenchmarkOptions } from './config.js';
import { buildConfig } from './config.js';
import { injectMessages, waitForQueueCompletion } from './injection/queue-injector.js';
import { collectResults } from './collector/result-collector.js';
import { getGroundTruth, generateGroundTruthFromMessages } from './collector/ground-truth.js';
import { validateResults } from './collector/validator.js';
import { generateDeduplicationScenario } from './scenarios/quality/deduplication.js';
import { generateEntityExtractionScenario } from './scenarios/quality/entity-extraction.js';
import { generateTemporalTrackingScenario } from './scenarios/quality/temporal-tracking.js';
import { generateConflictsScenario } from './scenarios/edge-cases/conflicts.js';
import { generateFactExtractionScenario } from './scenarios/quality/fact-extraction.js';
import { generateTaskExtractionScenario } from './scenarios/quality/task-extraction.js';
import { generateComplexRelationshipsScenario } from './scenarios/edge-cases/complex-relationships.js';
import { generateAmbiguousReferencesScenario } from './scenarios/edge-cases/ambiguous-references.js';
import { generateCrossContextEntitiesScenario } from './scenarios/edge-cases/cross-context-entities.js';
import { generateHighVolumeScenario } from './scenarios/stress/high-volume.js';
import { generateConcurrentThreadsScenario } from './scenarios/stress/concurrent-threads.js';
import { generateComplexEmbeddingsScenario } from './scenarios/stress/complex-embeddings.js';
import type { BenchmarkMessage } from './utils/message-factory.js';

/**
 * Benchmark run results
 */
export interface BenchmarkRun {
  runId: string;
  timestamp: Date;
  config: BenchmarkOptions;
  injectedMessages: number;
  processingTime: number;
  metrics: BenchmarkMetrics;
  validation: any;
}

export interface BenchmarkMetrics {
  totalMessages: number;
  totalProcessingTime: number;
  avgProcessingTime: number;
  entityCount: number;
  factCount: number;
  taskCount: number;
  memoryCount: number;
  f1Score: number;
}

/**
 * Generate unique run ID
 */
function generateRunId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = Math.random().toString(36).substring(2, 8);
  return `run-${timestamp}-${random}`;
}

/**
 * Run benchmark
 */
export async function runBenchmark(
  options: BenchmarkOptions = {}
): Promise<BenchmarkRun> {
  const runId = generateRunId();
  const startTime = Date.now();

  console.log(`🚀 Starting benchmark run: ${runId}`);
  console.log(`📊 Configuration: ${JSON.stringify(options, null, 2)}\n`);

  const config = buildConfig(options);

  // Step 1: Generate scenario
  console.log('📝 Step 1: Generating scenario...');
  const scenarioStart = Date.now();

  let messages: BenchmarkMessage[] = [];

  // Select scenario based on options
  switch (options.scenario) {
    // Quality benchmarks
    case 'deduplication':
      messages = generateDeduplicationScenario();
      break;

    case 'entity-extraction':
      messages = generateEntityExtractionScenario();
      break;

    case 'temporal-tracking':
      messages = generateTemporalTrackingScenario();
      break;

    case 'fact-extraction':
      messages = generateFactExtractionScenario();
      break;

    case 'task-extraction':
      messages = generateTaskExtractionScenario();
      break;

    // Edge cases
    case 'conflicts':
      messages = generateConflictsScenario();
      break;

    case 'complex-relationships':
      messages = generateComplexRelationshipsScenario();
      break;

    case 'ambiguous-references':
      messages = generateAmbiguousReferencesScenario();
      break;

    case 'cross-context-entities':
      messages = generateCrossContextEntitiesScenario();
      break;

    // Stress tests
    case 'high-volume':
      messages = generateHighVolumeScenario(config.messageCount);
      break;

    case 'concurrent-threads':
      messages = generateConcurrentThreadsScenario(20);
      break;

    case 'complex-embeddings':
      messages = generateComplexEmbeddingsScenario(config.messageCount);
      break;

    default:
      // Default: generate mixed messages
      messages = await generateDefaultScenario(config);
      break;
  }

  const scenarioTime = Date.now() - scenarioStart;
  console.log(`✅ Generated ${messages.length} messages (${scenarioTime}ms)\n`);

  // Step 2: Inject into queue
  console.log('📤 Step 2: Injecting messages into queue...');
  const injectionStart = Date.now();

  await injectMessages(messages, {
    rateLimit: config.injectionRate,
    onProgress: (injected, total) => {
      if (injected % 50 === 0 || injected === total) {
        console.log(`   Progress: ${injected}/${total} messages injected`);
      }
    },
  });

  const injectionTime = Date.now() - injectionStart;
  console.log(`✅ Injection complete (${injectionTime}ms)\n`);

  // Step 3: Wait for processing
  console.log('⏳ Step 3: Waiting for message processing...');
  const processingStart = Date.now();

  await waitForQueueCompletion(300000); // 5 minute timeout

  const processingTime = Date.now() - processingStart;
  console.log(`✅ Processing complete (${processingTime}ms)\n`);

  // Step 4: Collect results
  console.log('📊 Step 4: Collecting results...');
  const collectionStart = Date.now();

  const results = await collectResults({
    afterTimestamp: new Date(startTime),
    maxMemories: config.messageCount,
  });

  results.injectedMessages = messages.length;

  const collectionTime = Date.now() - collectionStart;
  console.log(`✅ Collection complete (${collectionTime}ms)\n`);

  // Step 5: Validate against ground truth
  console.log('🔍 Step 5: Validating against ground truth...');
  const validationStart = Date.now();

  const groundTruth = getGroundTruth(options.scenario || 'default')
    || generateGroundTruthFromMessages(options.scenario || 'default', messages);

  const validation = validateResults(groundTruth, results);

  const validationTime = Date.now() - validationStart;
  console.log(`✅ Validation complete (${validationTime}ms)\n`);

  // Step 6: Compile metrics
  const totalTime = Date.now() - startTime;

  const metrics: BenchmarkMetrics = {
    totalMessages: messages.length,
    totalProcessingTime: totalTime,
    avgProcessingTime: totalTime / messages.length,
    entityCount: results.entities.length,
    factCount: results.facts.length,
    taskCount: results.tasks.length,
    memoryCount: results.memories.length,
    f1Score: validation.overallF1,
  };

  const runResult: BenchmarkRun = {
    runId,
    timestamp: new Date(),
    config: options,
    injectedMessages: messages.length,
    processingTime: totalTime,
    metrics,
    validation,
  };

  // Save results to disk
  await saveResults(runResult);

  console.log(`📊 Benchmark ${runId} complete!`);
  console.log(`   Total time: ${(totalTime / 1000).toFixed(2)}s`);
  console.log(`   Throughput: ${(messages.length / (totalTime / 1000)).toFixed(2)} msg/sec`);
  console.log(`   Overall F1: ${validation.overallF1.toFixed(3)}\n`);

  return runResult;
}

/**
 * Generate default mixed scenario
 */
async function generateDefaultScenario(config: any): Promise<BenchmarkMessage[]> {
  const messages: BenchmarkMessage[] = [];
  const baseId = Date.now();
  const chatId = 999999; // Test chat ID
  const senderId = 999999;
  const senderName = 'Benchmark User';
  const senderUsername = 'benchmark';

  // Generate realistic message distribution
  for (let i = 0; i < config.messageCount; i++) {
    const timestamp = new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000); // Random within 30 days
    const messageId = baseId + i;

    // Random message type
    const rand = Math.random();
    let text: string;

    if (rand < 0.6) {
      // Regular text
      text = generateRandomThought();
    } else if (rand < 0.75) {
      // Link
      text = `Check out this article: https://example.com/article-${i}`;
    } else if (rand < 0.85) {
      // Question
      text = `? What's the best way to implement feature ${i}?`;
    } else {
      // Task
      text = `Remind me to review pull request #${i}`;
    }

    messages.push({
      chatId,
      messageId,
      senderId,
      senderName,
      senderUsername,
      text,
      timestamp: timestamp.toISOString(),
      benchmarkMetadata: {
        scenario: 'default',
      },
    });
  }

  return messages;
}

/**
 * Generate random thought text
 */
function generateRandomThought(): string {
  const templates = [
    "I've been thinking about implementing a new feature for {concept}.",
    "Had a great discussion with {person} about {concept}.",
    "The {organization} team is making good progress on {concept}.",
    "Need to investigate {concept} further.",
    "Interesting perspective from {person} about {concept}.",
  ];

  const concepts = ['Kubernetes', 'machine learning', 'database optimization', 'API design', 'testing'];
  const people = ['John', 'Sarah', 'Mike', 'Emily', 'David'];
  const organizations = ['Engineering', 'Product', 'DevOps', 'Research'];

  const template = templates[Math.floor(Math.random() * templates.length)];
  if (!template) return 'Random thought about system architecture.';

  const concept = concepts[Math.floor(Math.random() * concepts.length)] || 'Kubernetes';
  const person = people[Math.floor(Math.random() * people.length)] || 'John';
  const organization = organizations[Math.floor(Math.random() * organizations.length)] || 'Engineering';

  return template
    .replace('{concept}', concept)
    .replace('{person}', person)
    .replace('{organization}', organization);
}

/**
 * Save benchmark results to disk
 */
async function saveResults(run: BenchmarkRun): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');

  const resultsDir = path.join(process.cwd(), '.benchmark-history');
  const filepath = path.join(resultsDir, `${run.runId}.json`);

  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(filepath, JSON.stringify(run, null, 2));

  console.log(`💾 Results saved to: ${filepath}`);
}
