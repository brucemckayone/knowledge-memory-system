/**
 * Entity Extraction Scenario
 *
 * Tests the system's ability to accurately identify and extract
 * entities from various types of content and contexts.
 */

import type { BenchmarkMessage } from '../../utils/message-factory.js';
import { createMessageThread } from '../../utils/message-factory.js';

/**
 * Generate entity extraction scenario messages
 *
 * Creates diverse messages testing entity recognition:
 * - People with different name formats
 * - Organizations and companies
 * - Locations and places
 * - Technical concepts and technologies
 */
export function generateEntityExtractionScenario(): BenchmarkMessage[] {
  const messages: BenchmarkMessage[] = [];
  const baseId = Date.now();
  const chatId = 999998;
  const senderId = 999998;
  const senderName = 'Test User';
  const senderUsername = 'testuser';

  // Thread 1: Tech industry conversation
  const techThread = createMessageThread([
    {
      type: 'text',
      content: 'Had a great meeting with Elon Musk today. He\'s really excited about the new Starship launch vehicle.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'We discussed how Tesla\'s AI team is making progress with FSD (Full Self-Driving).',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'Also mentioned that SpaceX is planning to establish a Mars base by 2030.',
      delaySeconds: 600,
    },
    {
      type: 'text',
      content: 'The conversation took place at their Hawthorne, California headquarters.',
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

  messages.push(...techThread);

  // Thread 2: Software engineering discussion
  const engineeringThread = createMessageThread([
    {
      type: 'text',
      content: 'The engineering team at Google just announced a new Kubernetes feature.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Sundar Pichai mentioned it during the Cloud Next conference in San Francisco.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'They\'re using machine learning to optimize pod scheduling.',
      delaySeconds: 600,
    },
    {
      type: 'text',
      content: 'The demo showed deployments to GCP regions reducing latency by 40%.',
      delaySeconds: 900,
    },
  ], {
    chatId,
    startMessageId: baseId + 10,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 7200 * 1000),
  });

  messages.push(...engineeringThread);

  // Thread 3: Research context
  const researchThread = createMessageThread([
    {
      type: 'text',
      content: 'Reading a paper from MIT about quantum computing applications.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Researchers at Cambridge are collaborating with IBM on quantum error correction.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'The focus is on making qubits more stable at room temperature.',
      delaySeconds: 600,
    },
    {
      type: 'text',
      content: 'This could revolutionize cryptography and drug discovery.',
      delaySeconds: 900,
    },
  ], {
    chatId,
    startMessageId: baseId + 20,
    senderId,
    senderName,
    senderUsername,
    startTime: new Date(Date.now() - 86400 * 1000),
  });

  messages.push(...researchThread);

  // Add metadata for validation
  messages.forEach(msg => {
    msg.benchmarkMetadata = {
      scenario: 'entity-extraction',
      threadId: msg.messageId < baseId + 10 ? 'tech' : msg.messageId < baseId + 20 ? 'engineering' : 'research',
    };
  });

  return messages;
}

/**
 * Expected ground truth for entity extraction
 */
export const ENTITY_EXTRACTION_GROUND_TRUTH = {
  scenario: 'entity-extraction',
  description: 'Test accurate entity extraction from diverse contexts',

  expectedEntities: [
    // People
    { name: 'Elon Musk', type: 'person' },
    { name: 'Sundar Pichai', type: 'person' },

    // Organizations
    { name: 'Tesla', type: 'organization' },
    { name: 'SpaceX', type: 'organization' },
    { name: 'Google', type: 'organization' },
    { name: 'IBM', type: 'organization' },
    { name: 'MIT', type: 'organization' },
    { name: 'Cambridge', type: 'organization' },

    // Locations
    { name: 'Hawthorne', type: 'location' },
    { name: 'California', type: 'location' },
    { name: 'San Francisco', type: 'location' },

    // Concepts/Technologies
    { name: 'Starship', type: 'concept' },
    { name: 'AI', type: 'concept' },
    { name: 'FSD', type: 'concept' },
    { name: 'Mars', type: 'location' },
    { name: 'Kubernetes', type: 'concept' },
    { name: 'machine learning', type: 'concept' },
    { name: 'GCP', type: 'organization' },
    { name: 'quantum computing', type: 'concept' },
    { name: 'qubits', type: 'concept' },
    { name: 'cryptography', type: 'concept' },
  ],

  expectedFacts: [
    {
      subjectEntity: 'Elon Musk',
      predicate: 'leads',
      object: 'Tesla',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Elon Musk',
      predicate: 'leads',
      object: 'SpaceX',
      objectType: 'entity',
    },
    {
      subjectEntity: 'SpaceX',
      predicate: 'located_in',
      object: 'Hawthorne',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Sundar Pichai',
      predicate: 'leads',
      object: 'Google',
      objectType: 'entity',
    },
  ],

  expectedTasks: [],
  expectedMemories: [],
};
