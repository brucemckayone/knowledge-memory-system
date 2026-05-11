/**
 * Conflict Detection Scenario
 *
 * Tests the system's ability to detect and handle conflicting facts
 * that are mutually exclusive or contradictory.
 */

import type { BenchmarkMessage } from '../../utils/message-factory.js';
import { createMessageThread } from '../../utils/message-factory.js';

/**
 * Generate conflict detection scenario messages
 *
 * Creates conversations with contradictory information:
 * - Conflicting locations
 * - Mutually exclusive roles
 * - Contradictory preferences
 */
export function generateConflictsScenario(): BenchmarkMessage[] {
  const messages: BenchmarkMessage[] = [];
  const baseId = Date.now();
  const chatId = 999996;
  const senderId = 999996;
  const senderName = 'Conflict User';
  const senderUsername = 'conflict';

  // Thread 1: Location contradiction
  const locationConflict = createMessageThread([
    {
      type: 'text',
      content: 'Alice lives in New York City.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Alice just moved to San Francisco. She\'s no longer in NYC.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'Wait, Alice actually lives in London now. She moved abroad last month.',
      delaySeconds: 600,
    },
    {
      type: 'text',
      content: 'Correction: Alice is back in New York. London was only temporary.',
      delaySeconds: 900,
    },
  ], {
    chatId,
    startMessageId: baseId,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 7200 * 1000),
  });

  messages.push(...locationConflict);

  // Thread 2: Employment contradiction
  const employmentConflict = createMessageThread([
    {
      type: 'text',
      content: 'Charlie works at Google as a Software Engineer.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Actually, Charlie works at Microsoft, not Google. My mistake.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'Charlie just joined Amazon as a Principal Engineer.',
      delaySeconds: 600,
    },
    {
      type: 'text',
      content: 'I was wrong again - Charlie is still at Microsoft. The Amazon thing didn\'t happen.',
      delaySeconds: 900,
    },
  ], {
    chatId,
    startMessageId: baseId + 10,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 3600 * 1000),
  });

  messages.push(...employmentConflict);

  // Thread 3: Mutually exclusive states
  const stateConflict = createMessageThread([
    {
      type: 'text',
      content: 'The server is running and healthy.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Alert: The server is down! All services are unavailable.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'Server is back online after the restart.',
      delaySeconds: 600,
    },
    {
      type: 'text',
      content: 'Server crashed again. It\'s currently offline.',
      delaySeconds: 900,
    },
  ], {
    chatId,
    startMessageId: baseId + 20,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 5400 * 1000),
  });

  messages.push(...stateConflict);

  // Thread 4: Preference contradictions
  const preferenceConflict = createMessageThread([
    {
      type: 'text',
      content: 'David prefers Python over JavaScript for backend development.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Actually, David now prefers TypeScript. He switched from Python last year.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'David told me he hates TypeScript and only uses Go now.',
      delaySeconds: 600,
    },
    {
      type: 'text',
      content: 'Final update: David uses Python, TypeScript, and Go depending on the project. No strong preference.',
      delaySeconds: 900,
    },
  ], {
    chatId,
    startMessageId: baseId + 30,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 1800 * 1000),
  });

  messages.push(...preferenceConflict);

  // Add metadata
  messages.forEach(msg => {
    const threadNum = Math.floor((msg.messageId - baseId) / 10);
    const threadTypes = ['location', 'employment', 'state', 'preference'];
    msg.benchmarkMetadata = {
      scenario: 'conflicts',
      threadId: threadTypes[threadNum] || 'unknown',
    };
  });

  return messages;
}

/**
 * Expected ground truth for conflict detection
 */
export const CONFLICTS_GROUND_TRUTH = {
  scenario: 'conflicts',
  description: 'Test detection and resolution of contradictory facts',

  expectedEntities: [
    { name: 'Alice', type: 'person' },
    { name: 'Charlie', type: 'person' },
    { name: 'David', type: 'person' },
    { name: 'Google', type: 'organization' },
    { name: 'Microsoft', type: 'organization' },
    { name: 'Amazon', type: 'organization' },
  ],

  expectedFacts: [
    // Alice's most recent location
    {
      subjectEntity: 'Alice',
      predicate: 'location',
      object: 'New York',
      objectType: 'literal',
    },

    // Charlie's most recent employment
    {
      subjectEntity: 'Charlie',
      predicate: 'works_for',
      object: 'Microsoft',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Charlie',
      predicate: 'role',
      object: 'Software Engineer',
      objectType: 'literal',
    },

    // David's current preferences (most recent)
    {
      subjectEntity: 'David',
      predicate: 'uses',
      object: 'Python',
      objectType: 'literal',
    },
    {
      subjectEntity: 'David',
      predicate: 'uses',
      object: 'TypeScript',
      objectType: 'literal',
    },
    {
      subjectEntity: 'David',
      predicate: 'uses',
      object: 'Go',
      objectType: 'literal',
    },
  ],

  expectedTasks: [],
  expectedMemories: [],

  validationRules: {
    conflictingFacts: [
      {
        fact1: 'Alice-location-San Francisco',
        fact2: 'Alice-location-London',
        conflictType: 'contradiction',
      },
      {
        fact1: 'Alice-location-London',
        fact2: 'Alice-location-New York',
        conflictType: 'contradiction',
      },
      {
        fact1: 'Charlie-works_for-Google',
        fact2: 'Charlie-works_for-Microsoft',
        conflictType: 'mutually_exclusive',
      },
      {
        fact1: 'server status-running',
        fact2: 'server status-down',
        conflictType: 'contradiction',
      },
    ],
  },
};
