/**
 * Cross-Context Entities Scenario
 *
 * Tests the system's ability to recognize the same entity
 * appearing across different conversation contexts.
 */

import type { BenchmarkMessage } from '../../utils/message-factory.js';
import { createMessageThread } from '../../utils/message-factory.js';

/**
 * Generate cross-context entities scenario messages
 *
 * Creates multiple conversation threads where the same entities
 * appear in different contexts, testing cross-thread deduplication.
 */
export function generateCrossContextEntitiesScenario(): BenchmarkMessage[] {
  const messages: BenchmarkMessage[] = [];
  const baseId = Date.now();
  const chatId = 999991;
  const senderId = 999991;
  const senderName = 'CrossContext User';
  const senderUsername = 'crosscontext';

  // Thread 1: Work conversation
  const workThread = createMessageThread([
    {
      type: 'text',
      content: 'Mike Johnson is leading the Kubernetes migration project.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'He mentioned the team needs more training on containers.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'The migration is scheduled for Q2.',
      delaySeconds: 600,
    },
  ], {
    chatId,
    startMessageId: baseId,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 86400 * 1000), // Yesterday
  });

  messages.push(...workThread);

  // Thread 2: Social conversation (same day, different context)
  const socialThread = createMessageThread([
    {
      type: 'text',
      content: 'Had coffee with Mike Johnson this morning.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Mike said his weekend trip to the mountains was great.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'He loves hiking and outdoor activities.',
      delaySeconds: 600,
    },
  ], {
    chatId,
    startMessageId: baseId + 10,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 43200 * 1000), // 12 hours ago
  });

  messages.push(...socialThread);

  // Thread 3: Technical discussion (different day, same entity)
  const techThread = createMessageThread([
    {
      type: 'text',
      content: 'Mike Johnson shared an interesting article about microservices.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'The article discussed service mesh patterns with Istio.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'We should consider adopting some of these ideas.',
      delaySeconds: 600,
    },
  ], {
    chatId,
    startMessageId: baseId + 20,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 172800 * 1000), // 2 days ago
  });

  messages.push(...techThread);

  // Thread 4: Another entity appearing in multiple contexts
  const companyThread1 = createMessageThread([
    {
      type: 'text',
      content: 'Acme Corp just announced a new funding round.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'They raised $50M in Series C funding.',
      delaySeconds: 300,
    },
  ], {
    chatId,
    startMessageId: baseId + 30,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 259200 * 1000), // 3 days ago
  });

  messages.push(...companyThread1);

  const companyThread2 = createMessageThread([
    {
      type: 'text',
      content: 'I\'m applying to Acme Corp for a senior engineer position.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Their office is in downtown San Francisco.',
      delaySeconds: 300,
    },
  ], {
    chatId,
    startMessageId: baseId + 40,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 43200 * 1000), // 12 hours ago
  });

  messages.push(...companyThread2);

  // Add metadata
  messages.forEach(msg => {
    const idOffset = msg.messageId - baseId;
    let threadType = 'unknown';

    if (idOffset < 10) threadType = 'work';
    else if (idOffset < 20) threadType = 'social';
    else if (idOffset < 30) threadType = 'tech';
    else if (idOffset < 40) threadType = 'company-1';
    else threadType = 'company-2';

    msg.benchmarkMetadata = {
      scenario: 'cross-context-entities',
      threadId: threadType,
      expectedEntities: ['Mike Johnson', 'Kubernetes', 'Acme Corp'].filter(() => Math.random() > 0.3),
    };
  });

  return messages;
}

/**
 * Expected ground truth for cross-context entities
 */
export const CROSS_CONTEXT_ENTITIES_GROUND_TRUTH = {
  scenario: 'cross-context-entities',
  description: 'Test entity recognition across different conversation contexts',

  expectedEntities: [
    {
      name: 'Mike Johnson',
      type: 'person',
      // Should be deduplicated across work, social, and tech threads
      aliases: ['Mike', 'M. Johnson'],
    },
    {
      name: 'Acme Corp',
      type: 'organization',
      // Should be deduplicated across company threads
      aliases: ['Acme', 'Acme Corporation'],
    },
    { name: 'Kubernetes', type: 'concept' },
    { name: 'microservices', type: 'concept' },
    { name: 'Istio', type: 'concept' },
    { name: 'San Francisco', type: 'location' },
  ],

  expectedFacts: [
    // Mike - work context
    {
      subjectEntity: 'Mike Johnson',
      predicate: 'leading',
      object: 'Kubernetes migration project',
      objectType: 'literal',
    },
    {
      subjectEntity: 'Mike Johnson',
      predicate: 'mentioned',
      object: 'containers',
      objectType: 'concept',
    },

    // Mike - social context
    {
      subjectEntity: 'Mike Johnson',
      predicate: 'enjoys',
      object: 'hiking',
      objectType: 'literal',
    },
    {
      subjectEntity: 'Mike Johnson',
      predicate: 'enjoys',
      object: 'outdoor activities',
      objectType: 'literal',
    },

    // Mike - tech context
    {
      subjectEntity: 'Mike Johnson',
      predicate: 'shared',
      object: 'article about microservices',
      objectType: 'literal',
    },

    // Acme Corp - funding context
    {
      subjectEntity: 'Acme Corp',
      predicate: 'raised',
      object: '$50M',
      objectType: 'literal',
    },
    {
      subjectEntity: 'Acme Corp',
      predicate: 'funding_round',
      object: 'Series C',
      objectType: 'literal',
    },

    // Acme Corp - location context
    {
      subjectEntity: 'Acme Corp',
      predicate: 'located_in',
      object: 'San Francisco',
      objectType: 'entity',
    },
  ],

  expectedTasks: [],
  expectedMemories: [],

  validationRules: {
    deduplicatedEntities: [
      {
        canonical: 'Mike Johnson',
        aliases: ['Mike', 'M. Johnson'],
        contexts: ['work', 'social', 'tech'],
      },
      {
        canonical: 'Acme Corp',
        aliases: ['Acme', 'Acme Corporation'],
        contexts: ['company-1', 'company-2'],
      },
    ],
  },
};
