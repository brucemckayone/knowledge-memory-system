/**
 * Ambiguous References Scenario
 *
 * Tests the system's ability to resolve pronouns and
 * ambiguous references in conversation context.
 */

import type { BenchmarkMessage } from '../../utils/message-factory.js';
import { createMessageThread } from '../../utils/message-factory.js';

/**
 * Generate ambiguous references scenario messages
 *
 * Creates conversations with:
 * - Pronoun references (he, she, it, they)
 * - Context-dependent references
 * - Coreference resolution challenges
 */
export function generateAmbiguousReferencesScenario(): BenchmarkMessage[] {
  const messages: BenchmarkMessage[] = [];
  const baseId = Date.now();
  const chatId = 999992;
  const senderId = 999992;
  const senderName = 'Ambiguous User';
  const senderUsername = 'ambiguous';

  // Thread 1: Pronoun resolution
  const pronounThread = createMessageThread([
    {
      type: 'text',
      content: 'Sarah Chen works at Stripe as a software engineer.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'She specializes in payment systems.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'Her team is building a new API for merchants.',
      delaySeconds: 600,
    },
    {
      type: 'text',
      content: 'They expect to launch it next quarter.',
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

  messages.push(...pronounThread);

  // Thread 2: Context-dependent references
  const contextThread = createMessageThread([
    {
      type: 'text',
      content: 'I met with John from Microsoft yesterday.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'He said the new Azure features are impressive.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'The cloud platform is competing with AWS and Google Cloud.',
      delaySeconds: 600,
    },
    {
      type: 'text',
      content: 'It (Azure) has been gaining market share recently.',
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

  messages.push(...contextThread);

  // Thread 3: Multiple entity disambiguation
  const multiEntityThread = createMessageThread([
    {
      type: 'text',
      content: 'Elon Musk is the CEO of Tesla and SpaceX.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Tesla is focusing on electric vehicles and solar energy.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'SpaceX is developing the Starship rocket for Mars missions.',
      delaySeconds: 600,
    },
    {
      type: 'text',
      content: 'Both companies are disrupting their industries.',
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

  messages.push(...multiEntityThread);

  // Add metadata
  messages.forEach(msg => {
    const threadNum = Math.floor((msg.messageId - baseId) / 10);
    const threadTypes = ['pronoun', 'context', 'multi-entity'];
    msg.benchmarkMetadata = {
      scenario: 'ambiguous-references',
      threadId: threadTypes[threadNum] || 'unknown',
    };
  });

  return messages;
}

/**
 * Expected ground truth for ambiguous references
 */
export const AMBIGUOUS_REFERENCES_GROUND_TRUTH = {
  scenario: 'ambiguous-references',
  description: 'Test pronoun and reference resolution in context',

  expectedEntities: [
    { name: 'Sarah Chen', type: 'person' },
    { name: 'Stripe', type: 'organization' },
    { name: 'John', type: 'person' },
    { name: 'Microsoft', type: 'organization' },
    { name: 'Azure', type: 'concept' },
    { name: 'AWS', type: 'concept' },
    { name: 'Google Cloud', type: 'concept' },
    { name: 'Elon Musk', type: 'person' },
    { name: 'Tesla', type: 'organization' },
    { name: 'SpaceX', type: 'organization' },
  ],

  expectedFacts: [
    // Pronoun thread
    {
      subjectEntity: 'Sarah Chen',
      predicate: 'works_for',
      object: 'Stripe',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Sarah Chen',
      predicate: 'role',
      object: 'software engineer',
      objectType: 'literal',
    },
    {
      subjectEntity: 'Sarah Chen',
      predicate: 'specializes_in',
      object: 'payment systems',
      objectType: 'literal',
    },

    // Context thread
    {
      subjectEntity: 'John',
      predicate: 'works_for',
      object: 'Microsoft',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Azure',
      predicate: 'owned_by',
      object: 'Microsoft',
      objectType: 'entity',
    },

    // Multi-entity thread
    {
      subjectEntity: 'Elon Musk',
      predicate: 'ceo_of',
      object: 'Tesla',
      objectType: 'entity',
    },
    {
      subjectEntity: 'Elon Musk',
      predicate: 'ceo_of',
      object: 'SpaceX',
      objectType: 'entity',
    },
  ],

  expectedTasks: [],
  expectedMemories: [],
};
