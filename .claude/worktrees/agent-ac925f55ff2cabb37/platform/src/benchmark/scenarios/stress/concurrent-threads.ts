/**
 * Concurrent Threads Stress Test Scenario
 *
 * Tests system performance with multiple concurrent conversation threads.
 */

import type { BenchmarkMessage } from '../../utils/message-factory.js';

/**
 * Generate concurrent threads stress test messages
 *
 * Creates multiple conversation threads happening in parallel,
 * testing the system's ability to handle concurrent context.
 */
export function generateConcurrentThreadsScenario(threadCount: number = 20): BenchmarkMessage[] {
  const messages: BenchmarkMessage[] = [];
  const baseId = Date.now();
  const baseChatId = 999900;

  // Thread topics
  const threadTopics = [
    { topic: 'kubernetes', entities: ['Kubernetes', 'Docker', 'containers', 'pods'] },
    { topic: 'ml', entities: ['machine learning', 'TensorFlow', 'PyTorch', 'models'] },
    { topic: 'database', entities: ['PostgreSQL', 'MongoDB', 'Redis', 'queries'] },
    { topic: 'frontend', entities: ['React', 'Vue.js', 'TypeScript', 'components'] },
    { topic: 'security', entities: ['OAuth', 'JWT', 'encryption', 'authentication'] },
    { topic: 'cloud', entities: ['AWS', 'Azure', 'GCP', 'deployment'] },
    { topic: 'monitoring', entities: ['Prometheus', 'Grafana', 'logs', 'metrics'] },
    { topic: 'testing', entities: ['Jest', 'Cypress', 'unit tests', 'integration'] },
    { topic: 'api', entities: ['REST', 'GraphQL', 'gRPC', 'endpoints'] },
    { topic: 'devops', entities: ['CI/CD', 'Jenkins', 'GitLab', 'pipelines'] },
  ];

  // Generate concurrent threads
  for (let t = 0; t < threadCount; t++) {
    const topicIndex = t % threadTopics.length;
    const topic = threadTopics[topicIndex];
    const chatId = baseChatId + t;
    const senderId = chatId;
    const senderName = `User ${t}`;
    const senderUsername = `user${t}`;

    // Messages per thread (varied)
    const messagesInThread = 5 + Math.floor(Math.random() * 15); // 5-20 messages per thread
    const threadStartTime = Date.now() - Math.random() * 3600 * 1000; // Random start within last hour

    for (let m = 0; m < messagesInThread; m++) {
      const delayMinutes = m * (2 + Math.random() * 10); // 2-12 minutes between messages
      const timestamp = new Date(threadStartTime + delayMinutes * 60 * 1000);
      const messageId = baseId + (t * 100) + m;

      // Generate message based on thread topic
      const entities = topic?.entities || ['system', 'component', 'service'];
      const entity = entities[Math.floor(Math.random() * entities.length)] || entities[0];
      const messageTypes = [
        `Working on ${entity} integration.`,
        `${entity} is giving me some issues.`,
        `Just deployed ${entity} to staging.`,
        `Need to refactor the ${entity} module.`,
        `Great documentation on ${entity}!`,
        `${entity} performance is looking good.`,
        `Debugging ${entity} production issue.`,
        `Meeting about ${entity} architecture.`,
        `Learning more about ${entity}.`,
        `${entity} best practices discussion.`,
      ];

      const text = messageTypes[Math.floor(Math.random() * messageTypes.length)] || messageTypes[0];

      messages.push({
        chatId,
        messageId,
        senderId,
        senderName,
        senderUsername,
        text,
        timestamp: timestamp.toISOString(),
        benchmarkMetadata: {
          scenario: 'concurrent-threads',
          threadId: `thread-${t}`,
        },
      });
    }
  }

  // Sort by timestamp (threads are interleaved in time)
  messages.sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return messages;
}

/**
 * Expected ground truth for concurrent threads scenario
 */
export const CONCURRENT_THREADS_GROUND_TRUTH = {
  scenario: 'concurrent-threads',
  description: 'Stress test with multiple concurrent conversation threads',

  expectedEntities: [], // Not validated - focus on performance
  expectedFacts: [],
  expectedTasks: [],
  expectedMemories: [],

  // For concurrent threads, we measure:
  // - Thread isolation (entities from thread A don't leak to thread B)
  // - Concurrent processing performance
  // - Memory efficiency with multiple contexts
};
