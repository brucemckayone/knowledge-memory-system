/**
 * Fact Extraction Scenario
 *
 * Tests the system's ability to extract structured facts
 * about relationships between entities.
 */

import type { BenchmarkMessage } from '../../utils/message-factory.js';
import { createMessageThread } from '../../utils/message-factory.js';

/**
 * Generate fact extraction scenario messages
 *
 * Creates conversations with various relationship types:
 * - employment (works_for, leads)
 * - family (married_to, parent_of)
 * - skills (knows, uses)
 * - locations (located_in, lives_in)
 */
export function generateFactExtractionScenario(): BenchmarkMessage[] {
  const messages: BenchmarkMessage[] = [];
  const baseId = Date.now();
  const chatId = 999995;
  const senderId = 999995;
  const senderName = 'Fact User';
  const senderUsername = 'facts';

  // Thread 1: Professional relationships
  const professionalThread = createMessageThread([
    {
      type: 'text',
      content: 'Sarah Chen is the VP of Engineering at Stripe.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'She reports directly to Patrick Collison, the CEO.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'Before Stripe, Sarah worked at Google as a Senior Staff Engineer.',
      delaySeconds: 600,
    },
    {
      type: 'text',
      content: 'She specializes in distributed systems and payment infrastructure.',
      delaySeconds: 900,
    },
  ], {
    chatId,
    startMessageId: baseId,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 3600 * 1000),
  });

  messages.push(...professionalThread);

  // Thread 2: Family relationships
  const familyThread = createMessageThread([
    {
      type: 'text',
      content: 'Mike Johnson is married to Lisa Johnson.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'They have two kids: Emma (age 8) and Jake (age 5).',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'The family lives in Austin, Texas.',
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

  messages.push(...familyThread);

  // Thread 3: Technical skills and tools
  const skillsThread = createMessageThread([
    {
      type: 'text',
      content: 'Alex Kim is a full-stack developer who knows React, Node.js, and PostgreSQL.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'He uses TypeScript for all his projects.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'Alex is also learning Rust for systems programming.',
      delaySeconds: 600,
    },
  ], {
    chatId,
    startMessageId: baseId + 20,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 5400 * 1000),
  });

  messages.push(...skillsThread);

  // Thread 4: Location and geography
  const locationThread = createMessageThread([
    {
      type: 'text',
      content: 'The headquarters of Meta is in Menlo Park, California.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Meta also has major offices in New York City and London.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'The data centers are located in Oregon, Iowa, and North Carolina.',
      delaySeconds: 600,
    },
  ], {
    chatId,
    startMessageId: baseId + 30,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 86400 * 1000),
  });

  messages.push(...locationThread);

  // Add metadata
  messages.forEach(msg => {
    const threadNum = Math.floor((msg.messageId - baseId) / 10);
    const threadTypes = ['professional', 'family', 'skills', 'location'];
    msg.benchmarkMetadata = {
      scenario: 'fact-extraction',
      threadId: threadTypes[threadNum] || 'unknown',
    };
  });

  return messages;
}

/**
 * Expected ground truth for fact extraction
 */
export const FACT_EXTRACTION_GROUND_TRUTH = {
  scenario: 'fact-extraction',
  description: 'Test extraction of various relationship types',

  expectedEntities: [
    // People
    { name: 'Sarah Chen', type: 'person' },
    { name: 'Patrick Collison', type: 'person' },
    { name: 'Mike Johnson', type: 'person' },
    { name: 'Lisa Johnson', type: 'person' },
    { name: 'Emma', type: 'person' },
    { name: 'Jake', type: 'person' },
    { name: 'Alex Kim', type: 'person' },

    // Organizations
    { name: 'Stripe', type: 'organization' },
    { name: 'Google', type: 'organization' },
    { name: 'Meta', type: 'organization' },

    // Locations
    { name: 'Austin', type: 'location' },
    { name: 'Texas', type: 'location' },
    { name: 'Menlo Park', type: 'location' },
    { name: 'California', type: 'location' },
    { name: 'New York City', type: 'location' },
    { name: 'London', type: 'location' },
    { name: 'Oregon', type: 'location' },
    { name: 'Iowa', type: 'location' },
    { name: 'North Carolina', type: 'location' },

    // Concepts/Technologies
    { name: 'distributed systems', type: 'concept' },
    { name: 'payment infrastructure', type: 'concept' },
    { name: 'React', type: 'concept' },
    { name: 'Node.js', type: 'concept' },
    { name: 'PostgreSQL', type: 'concept' },
    { name: 'TypeScript', type: 'concept' },
    { name: 'Rust', type: 'concept' },
  ],

  expectedFacts: [
    // Professional facts
    {
      subjectEntity: 'Sarah Chen',
      predicate: 'role',
      object: 'VP of Engineering',
      objectType: 'literal',
    },
    {
      subjectEntity: 'Sarah Chen',
      predicate: 'works_for',
      object: 'Stripe',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Patrick Collison',
      predicate: 'role',
      object: 'CEO',
      objectType: 'literal',
    },
    {
      subjectEntity: 'Sarah Chen',
      predicate: 'reports_to',
      object: 'Patrick Collison',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Sarah Chen',
      predicate: 'formerly_worked_for',
      object: 'Google',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Sarah Chen',
      predicate: 'former_role',
      object: 'Senior Staff Engineer',
      objectType: 'literal',
    },

    // Family facts
    {
      subjectEntity: 'Mike Johnson',
      predicate: 'married_to',
      object: 'Lisa Johnson',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Mike Johnson',
      predicate: 'parent_of',
      object: 'Emma',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Lisa Johnson',
      predicate: 'parent_of',
      object: 'Emma',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Mike Johnson',
      predicate: 'parent_of',
      object: 'Jake',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Lisa Johnson',
      predicate: 'parent_of',
      object: 'Jake',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Emma',
      predicate: 'age',
      object: '8',
      objectType: 'literal',
    },
    {
      subjectEntity: 'Jake',
      predicate: 'age',
      object: '5',
      objectType: 'literal',
    },

    // Skills facts
    {
      subjectEntity: 'Alex Kim',
      predicate: 'role',
      object: 'full-stack developer',
      objectType: 'literal',
    },
    {
      subjectEntity: 'Alex Kim',
      predicate: 'knows',
      object: 'React',
      objectType: 'concept',
    },
    {
      subjectEntity: 'Alex Kim',
      predicate: 'knows',
      object: 'Node.js',
      objectType: 'concept',
    },
    {
      subjectEntity: 'Alex Kim',
      predicate: 'knows',
      object: 'PostgreSQL',
      objectType: 'concept',
    },
    {
      subjectEntity: 'Alex Kim',
      predicate: 'uses',
      object: 'TypeScript',
      objectType: 'concept',
    },
    {
      subjectEntity: 'Alex Kim',
      predicate: 'learning',
      object: 'Rust',
      objectType: 'concept',
    },

    // Location facts
    {
      subjectEntity: 'Meta',
      predicate: 'headquartered_in',
      object: 'Menlo Park',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Meta',
      predicate: 'has_office_in',
      object: 'New York City',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Meta',
      predicate: 'has_office_in',
      object: 'London',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Menlo Park',
      predicate: 'located_in',
      object: 'California',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Austin',
      predicate: 'located_in',
      object: 'Texas',
      objectType: 'entity',
    },
  ],

  expectedTasks: [],
  expectedMemories: [],
};
