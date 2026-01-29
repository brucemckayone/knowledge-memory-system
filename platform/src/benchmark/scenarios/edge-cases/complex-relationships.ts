/**
 * Complex Relationships Scenario
 *
 * Tests the system's ability to handle multi-hop relationships
 * and complex connection patterns.
 */

import type { BenchmarkMessage } from '../../utils/message-factory.js';
import { createMessageThread } from '../../utils/message-factory.js';

/**
 * Generate complex relationships scenario messages
 *
 * Creates conversations with:
 * - Transitive relationships (A -> B -> C)
 * - Multi-hop connections
 * - Complex organizational hierarchies
 */
export function generateComplexRelationshipsScenario(): BenchmarkMessage[] {
  const messages: BenchmarkMessage[] = [];
  const baseId = Date.now();
  const chatId = 999993;
  const senderId = 999993;
  const senderName = 'Complex User';
  const senderUsername = 'complex';

  // Thread 1: Multi-hop professional chain
  const orgChainThread = createMessageThread([
    {
      type: 'text',
      content: 'John works in the Engineering department at Acme Corp.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'The Engineering department is led by Sarah, who reports to the CTO.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'The CTO, Mike, reports directly to the CEO, Lisa.',
      delaySeconds: 600,
    },
  ], {
    chatId,
    startMessageId: baseId,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 3600 * 1000),
  });

  messages.push(...orgChainThread);

  // Thread 2: Transitive ownership
  const ownershipThread = createMessageThread([
    {
      type: 'text',
      content: 'Google owns YouTube.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Alphabet owns Google.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'Therefore, Alphabet indirectly owns YouTube through Google.',
      delaySeconds: 600,
    },
  ], {
    chatId,
    startMessageId: baseId + 10,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 7200 * 1000),
  });

  messages.push(...ownershipThread);

  // Thread 3: Geographic hierarchy
  const geoThread = createMessageThread([
    {
      type: 'text',
      content: 'Soho is a neighborhood in Manhattan.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Manhattan is one of the boroughs of New York City.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'New York City is in New York State.',
      delaySeconds: 600,
    },
    {
      type: 'text',
      content: 'New York State is on the East Coast of the United States.',
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

  messages.push(...geoThread);

  // Add metadata
  messages.forEach(msg => {
    const threadNum = Math.floor((msg.messageId - baseId) / 10);
    const threadTypes = ['org-chain', 'ownership', 'geographic'];
    msg.benchmarkMetadata = {
      scenario: 'complex-relationships',
      threadId: threadTypes[threadNum] || 'unknown',
    };
  });

  return messages;
}

/**
 * Expected ground truth for complex relationships
 */
export const COMPLEX_RELATIONSHIPS_GROUND_TRUTH = {
  scenario: 'complex-relationships',
  description: 'Test handling of multi-hop and transitive relationships',

  expectedEntities: [
    { name: 'John', type: 'person' },
    { name: 'Sarah', type: 'person' },
    { name: 'Mike', type: 'person' },
    { name: 'Lisa', type: 'person' },
    { name: 'Acme Corp', type: 'organization' },
    { name: 'Engineering', type: 'organization' },
    { name: 'Google', type: 'organization' },
    { name: 'YouTube', type: 'organization' },
    { name: 'Alphabet', type: 'organization' },
    { name: 'Soho', type: 'location' },
    { name: 'Manhattan', type: 'location' },
    { name: 'New York City', type: 'location' },
    { name: 'New York State', type: 'location' },
    { name: 'United States', type: 'location' },
    { name: 'East Coast', type: 'location' },
  ],

  expectedFacts: [
    // Organizational chain
    {
      subjectEntity: 'John',
      predicate: 'works_in',
      object: 'Engineering',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Engineering',
      predicate: 'part_of',
      object: 'Acme Corp',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Sarah',
      predicate: 'leads',
      object: 'Engineering',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Sarah',
      predicate: 'reports_to',
      object: 'Mike',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Mike',
      predicate: 'role',
      object: 'CTO',
      objectType: 'literal',
    },
    {
      subjectEntity: 'Mike',
      predicate: 'reports_to',
      object: 'Lisa',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Lisa',
      predicate: 'role',
      object: 'CEO',
      objectType: 'literal',
    },

    // Ownership chain
    {
      subjectEntity: 'Google',
      predicate: 'owns',
      object: 'YouTube',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Alphabet',
      predicate: 'owns',
      object: 'Google',
      objectType: 'entity',
    },

    // Geographic hierarchy
    {
      subjectEntity: 'Soho',
      predicate: 'located_in',
      object: 'Manhattan',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Manhattan',
      predicate: 'part_of',
      object: 'New York City',
      objectType: 'entity',
    },
    {
      subjectEntity: 'New York City',
      predicate: 'located_in',
      object: 'New York State',
      objectType: 'entity',
    },
    {
      subjectEntity: 'New York State',
      predicate: 'located_on',
      object: 'East Coast',
      objectType: 'entity',
    },
    {
      subjectEntity: 'East Coast',
      predicate: 'part_of',
      object: 'United States',
      objectType: 'entity',
    },
  ],

  expectedTasks: [],
  expectedMemories: [],
};
