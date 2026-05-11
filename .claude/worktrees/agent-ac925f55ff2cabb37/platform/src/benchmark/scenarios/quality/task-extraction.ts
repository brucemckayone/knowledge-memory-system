/**
 * Task Extraction Scenario
 *
 * Tests the system's ability to identify action items,
 * reminders, and tasks from natural language.
 */

import type { BenchmarkMessage } from '../../utils/message-factory.js';
import { createMessageThread } from '../../utils/message-factory.js';

/**
 * Generate task extraction scenario messages
 *
 * Creates conversations containing various types of tasks:
 * - Explicit reminders ("remind me to...")
 * - Action items ("need to...")
 * - Deadlines and due dates
 * - Priorities (urgent, important, etc.)
 */
export function generateTaskExtractionScenario(): BenchmarkMessage[] {
  const messages: BenchmarkMessage[] = [];
  const baseId = Date.now();
  const chatId = 999994;
  const senderId = 999994;
  const senderName = 'Task User';
  const senderUsername = 'tasks';

  // Thread 1: Explicit reminders
  const reminderThread = createMessageThread([
    {
      type: 'text',
      content: 'Remind me to call the dentist tomorrow.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Also remind me to pick up groceries on the way home.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'Don\'t forget to remind me about the team meeting at 3pm.',
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

  messages.push(...reminderThread);

  // Thread 2: Action items and commitments
  const actionThread = createMessageThread([
    {
      type: 'text',
      content: 'I need to review the pull request for the authentication feature.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Also need to update the documentation for the new API endpoints.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'Must fix the bug in the payment processing flow by Friday.',
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

  messages.push(...actionThread);

  // Thread 3: Task priorities
  const priorityThread = createMessageThread([
    {
      type: 'text',
      content: 'URGENT: Deploy the hotfix to production ASAP!',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Important: Review and merge the feature branch before the release.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'Low priority: Clean up the test suite when we have time.',
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

  messages.push(...priorityThread);

  // Thread 4: Deadlines and time-sensitive tasks
  const deadlineThread = createMessageThread([
    {
      type: 'text',
      content: 'Submit the quarterly report by end of day Friday.',
      delaySeconds: 0,
    },
    {
      type: 'text',
      content: 'Prepare presentation for Monday\'s client meeting.',
      delaySeconds: 300,
    },
    {
      type: 'text',
      content: 'Renew the SSL certificate before it expires on March 15th.',
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

  messages.push(...deadlineThread);

  // Add metadata
  messages.forEach(msg => {
    const threadNum = Math.floor((msg.messageId - baseId) / 10);
    const threadTypes = ['reminder', 'action', 'priority', 'deadline'];
    msg.benchmarkMetadata = {
      scenario: 'task-extraction',
      threadId: threadTypes[threadNum] || 'unknown',
    };
  });

  return messages;
}

/**
 * Expected ground truth for task extraction
 */
export const TASK_EXTRACTION_GROUND_TRUTH = {
  scenario: 'task-extraction',
  description: 'Test identification of action items and tasks',

  expectedEntities: [
    { name: 'dentist', type: 'organization' },
    { name: 'team', type: 'organization' },
  ],

  expectedFacts: [],

  expectedTasks: [
    // Reminders
    {
      content: 'call the dentist tomorrow',
      priority: 'medium',
    },
    {
      content: 'pick up groceries on the way home',
      priority: 'medium',
    },
    {
      content: 'team meeting at 3pm',
      priority: 'medium',
    },

    // Action items
    {
      content: 'review the pull request for the authentication feature',
      priority: 'high',
    },
    {
      content: 'update the documentation for the new API endpoints',
      priority: 'medium',
    },
    {
      content: 'fix the bug in the payment processing flow by Friday',
      priority: 'high',
      hasDueDate: true,
    },

    // Prioritized tasks
    {
      content: 'deploy the hotfix to production',
      priority: 'high',
    },
    {
      content: 'review and merge the feature branch before the release',
      priority: 'high',
    },
    {
      content: 'clean up the test suite',
      priority: 'low',
    },

    // Deadlines
    {
      content: 'submit the quarterly report by end of day Friday',
      priority: 'high',
      hasDueDate: true,
    },
    {
      content: 'prepare presentation for Monday\'s client meeting',
      priority: 'high',
      hasDueDate: true,
    },
    {
      content: 'renew the SSL certificate before it expires on March 15th',
      priority: 'high',
      hasDueDate: true,
    },
  ],

  expectedMemories: [],
};
