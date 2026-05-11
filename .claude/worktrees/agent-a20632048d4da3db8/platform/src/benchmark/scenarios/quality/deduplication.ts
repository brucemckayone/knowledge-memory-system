/**
 * Entity Deduplication Scenario
 *
 * Tests the system's ability to recognize that different name variations
 * refer to the same entity and merge them appropriately.
 */

import type { BenchmarkMessage } from '../../utils/message-factory.js';
import { createMessageThread } from '../../utils/message-factory.js';

/**
 * Generate deduplication scenario messages
 *
 * Creates a conversation thread where the same entity is mentioned
 * with different name variations, testing deduplication logic.
 */
export function generateDeduplicationScenario(): BenchmarkMessage[] {
  const messages: BenchmarkMessage[] = [];
  const baseId = Date.now();
  const chatId = 999999;
  const senderId = 999999;
  const senderName = 'Benchmark User';
  const senderUsername = 'benchmark';

  // Conversation about John Smith with various name references
  const conversation = createMessageThread([
    {
      type: 'text',
      content: 'Had lunch with John Smith today. He\'s the CTO at Acme Corp.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Jon mentioned they\'re scaling their Kubernetes cluster to 100 nodes.',
      delaySeconds: 300, // 5 minutes later
    },
    {
      type: 'text',
      content: 'J. Smith says the new microservices architecture is working well.',
      delaySeconds: 600, // 10 minutes later
    },
    {
      type: 'text',
      content: 'Johnny just texted me - they\'re hiring more DevOps engineers.',
      delaySeconds: 1800, // 30 minutes later
    },
    {
      type: 'text',
      content: 'John Smith (the CTO) suggested we should use ArgoCD for deployments.',
      delaySeconds: 3600, // 1 hour later
    },
  ], {
    chatId,
    startMessageId: baseId,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 3600 * 1000),
  });

  messages.push(...conversation);

  // Add metadata for ground truth
  conversation.forEach(msg => {
    msg.benchmarkMetadata = {
      scenario: 'deduplication',
      expectedEntities: ['John Smith', 'Acme Corp', 'Kubernetes', 'ArgoCD'],
      threadId: 'thread-1',
    };
  });

  // Second conversation thread with same entities (cross-context deduplication)
  const conversation2 = createMessageThread([
    {
      type: 'text',
      content: 'Meeting with Jon from Acme Corp tomorrow.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Need to prepare the Kubernetes demo for J. Smith.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'Johnny asked about our CI/CD pipeline setup.',
      delaySeconds: 600,
    },
  ], {
    chatId,
    startMessageId: baseId + 10,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 86400 * 1000), // Yesterday
  });

  messages.push(...conversation2);

  // Add metadata
  conversation2.forEach(msg => {
    msg.benchmarkMetadata = {
      scenario: 'deduplication',
      expectedEntities: ['John Smith', 'Acme Corp', 'Kubernetes'],
      threadId: 'thread-2',
    };
  });

  return messages;
}

/**
 * Expected ground truth for this scenario
 */
export const DEDUPLICATION_GROUND_TRUTH = {
  scenario: 'deduplication',
  description: 'Test entity deduplication across name variations and conversation threads',

  expectedEntities: [
    {
      name: 'John Smith',
      type: 'person',
      aliases: ['Jon', 'J. Smith', 'Johnny'],
      confidence: 0.95,
    },
    {
      name: 'Acme Corp',
      type: 'organization',
      aliases: ['Acme Corporation', 'Acme'],
      confidence: 0.90,
    },
  ],

  expectedFacts: [
    {
      subjectEntity: 'John Smith',
      predicate: 'role',
      object: 'CTO',
      objectType: 'literal',
    },
    {
      subjectEntity: 'John Smith',
      predicate: 'works_for',
      object: 'Acme Corp',
      objectType: 'entity',
    },
    {
      subjectEntity: 'John Smith',
      predicate: 'mentioned',
      object: 'Kubernetes',
      objectType: 'concept',
    },
    {
      subjectEntity: 'Acme Corp',
      predicate: 'uses',
      object: 'Kubernetes',
      objectType: 'concept',
    },
  ],

  expectedTasks: [],

  expectedMemories: [
    {
      type: 'thought',
      contentType: 'text',
      contentContains: ['John Smith', 'Acme Corp', 'CTO'],
    },
    {
      type: 'thought',
      contentType: 'text',
      contentContains: ['Jon', 'Kubernetes', 'scaling'],
    },
  ],

  validationRules: {
    deduplicatedEntities: [
      {
        canonical: 'John Smith',
        aliases: ['Jon', 'J. Smith', 'Johnny'],
      },
      {
        canonical: 'Acme Corp',
        aliases: ['Acme Corporation', 'Acme'],
      },
    ],
  },
};
