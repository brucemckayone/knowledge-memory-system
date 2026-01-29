/**
 * Temporal Tracking Scenario
 *
 * Tests the system's ability to track changes to facts over time,
 * including fact supersedion (newer facts invalidate older ones).
 */

import type { BenchmarkMessage } from '../../utils/message-factory.js';
import { createMessageThread } from '../../utils/message-factory.js';

/**
 * Generate temporal tracking scenario messages
 *
 * Creates a conversation where facts change over time:
 * - Career progression (role changes)
 * - Location changes
 * - Technology stack updates
 */
export function generateTemporalTrackingScenario(): BenchmarkMessage[] {
  const messages: BenchmarkMessage[] = [];
  const baseId = Date.now();
  const chatId = 999997;
  const senderId = 999997;
  const senderName = 'Temporal User';
  const senderUsername = 'temporal';

  // Thread: Career progression over months
  const careerThread = createMessageThread([
    {
      type: 'text',
      content: 'Jane Doe just joined our team as a Junior Developer.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Jane was promoted to Senior Developer after 6 months. Great performance!',
      delaySeconds: 1800, // 30 minutes later (simulating 6 months)
    },
    {
      type: 'text',
      content: 'Jane is now the Tech Lead of the backend team. Well deserved!',
      delaySeconds: 3600, // Another hour later (simulating another year)
    },
    {
      type: 'text',
      content: 'Jane Doe just became the Engineering Manager at Acme Corp.',
      delaySeconds: 5400, // Another promotion
    },
  ], {
    chatId,
    startMessageId: baseId,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 86400 * 30 * 1000), // 30 days ago
  });

  messages.push(...careerThread);

  // Thread: Location changes
  const locationThread = createMessageThread([
    {
      type: 'text',
      content: 'Bob Johnson moved from New York to San Francisco last week.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Bob is now based in Austin, Texas. He relocated for the new job.',
      delaySeconds: 1800,
    },
    {
      type: 'text',
      content: 'Bob moved back to the Bay Area, specifically to Oakland.',
      delaySeconds: 3600,
    },
  ], {
    chatId,
    startMessageId: baseId + 10,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 86400 * 20 * 1000), // 20 days ago
  });

  messages.push(...locationThread);

  // Thread: Technology evolution
  const techThread = createMessageThread([
    {
      type: 'text',
      content: 'Our team uses MongoDB for the primary database.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'We migrated from MongoDB to PostgreSQL. Better relational features.',
      delaySeconds: 1800,
    },
    {
      type: 'text',
      content: 'Now we\'re using PostgreSQL with Citus extension for distributed queries.',
      delaySeconds: 3600,
    },
  ], {
    chatId,
    startMessageId: baseId + 20,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 86400 * 15 * 1000), // 15 days ago
  });

  messages.push(...techThread);

  // Add metadata
  messages.forEach(msg => {
    msg.benchmarkMetadata = {
      scenario: 'temporal-tracking',
      threadId: msg.messageId < baseId + 10 ? 'career' : msg.messageId < baseId + 20 ? 'location' : 'tech',
    };
  });

  return messages;
}

/**
 * Expected ground truth for temporal tracking
 */
export const TEMPORAL_TRACKING_GROUND_TRUTH = {
  scenario: 'temporal-tracking',
  description: 'Test fact supersedion for temporal changes',

  expectedEntities: [
    { name: 'Jane Doe', type: 'person' },
    { name: 'Bob Johnson', type: 'person' },
    { name: 'Acme Corp', type: 'organization' },
    { name: 'MongoDB', type: 'concept' },
    { name: 'PostgreSQL', type: 'concept' },
  ],

  expectedFacts: [
    // Jane's current role (most recent)
    {
      subjectEntity: 'Jane Doe',
      predicate: 'role',
      object: 'Engineering Manager',
      objectType: 'literal',
    },
    {
      subjectEntity: 'Jane Doe',
      predicate: 'works_for',
      object: 'Acme Corp',
      objectType: 'entity',
    },

    // Bob's current location (most recent)
    {
      subjectEntity: 'Bob Johnson',
      predicate: 'location',
      object: 'Oakland',
      objectType: 'literal',
    },

    // Current database (most recent)
    {
      subjectEntity: 'PostgreSQL',
      predicate: 'used_by',
      object: 'team',
      objectType: 'literal',
    },
  ],

  expectedTasks: [],
  expectedMemories: [],

  validationRules: {
    temporalFacts: [
      {
        factKey: 'Jane Doe-role',
        shouldSupersede: 'Jane Doe-role-Junior Developer',
      },
      {
        factKey: 'Jane Doe-role',
        shouldSupersede: 'Jane Doe-role-Senior Developer',
      },
      {
        factKey: 'Jane Doe-role',
        shouldSupersede: 'Jane Doe-role-Tech Lead',
      },
    ],
  },
};
