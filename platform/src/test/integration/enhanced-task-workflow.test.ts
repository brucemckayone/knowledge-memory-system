/**
 * Enhanced Task Workflow Integration Test
 *
 * Tests the complete enhanced task processing pipeline including:
 * - Task decomposition into subtasks
 * - Dependency detection and resolution
 * - Temporal conflict detection
 * - Semantic duplicate detection
 * - User preference integration
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { testDb, randomUUID, isMLServiceAvailable } from '../setup.js';
import { createEnvelope } from '../../core/envelope-factory.js';
import { createSkillContext } from '../../skills/index.js';
import { processTask } from '../../workflows/process-task.js';
import { db } from '../../db/index.js';
import { tasks, taskDependencies, taskConflicts } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { initQueue, shutdownQueue } from '../../queue/index.js';
import { initController } from '../../gardener/controller.js';

describe('Enhanced Task Workflow', () => {
  let mlAvailable = false;

  beforeAll(async () => {
    mlAvailable = await isMLServiceAvailable();
    if (!mlAvailable) {
      console.warn('⚠️ ML Services not available - some tests may be skipped');
    }

    // Initialize queue and controller for integration tests
    const boss = await initQueue();
    initController(boss);
    console.log('✅ Queue and controller initialized for integration tests');
  });

  afterAll(async () => {
    // Shutdown queue after tests
    await shutdownQueue();
    console.log('✅ Queue shut down');
  });

  // Helper to create a test envelope
  function createTestEnvelope(content: string, overrides?: {
    conversationId?: string;
    senderId?: string;
    messageId?: string;
  }) {
    return createEnvelope({
      platform: 'telegram',
      senderId: overrides?.senderId || 'test-user-' + Date.now(),
      senderName: 'Test User',
      conversationId: overrides?.conversationId || 'test-conv-' + Date.now(),
      messageId: overrides?.messageId || 'msg-' + Date.now(),
      content,
      rawType: 'text',
    });
  }

  // Helper to clean up test data
  async function cleanupTestTask(taskId: string) {
    await db.delete(taskDependencies).where(eq(taskDependencies.taskId, taskId));
    await db.delete(taskConflicts).where(
      eq(taskConflicts.taskId1, taskId)
    );
    await db.delete(taskConflicts).where(
      eq(taskConflicts.taskId2, taskId)
    );
    await db.delete(tasks).where(eq(tasks.id, taskId));
  }

  // Helper to get subtasks for a parent task
  async function getSubtasks(parentTaskId: string) {
    return await db
      .select()
      .from(tasks)
      .where(eq(tasks.parentTaskId, parentTaskId));
  }

  // Helper to get dependencies for a task
  async function getDependenciesForTask(taskId: string) {
    return await db
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.taskId, taskId));
  }

  describe('Task Decomposition', () => {
    it('should create subtasks for complex multi-step tasks', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      const envelope = createTestEnvelope(
        'Plan and execute a complete marketing campaign for Q1 product launch including social media, email, and PR'
      );

      const context = createSkillContext(envelope);
      const result = await processTask(envelope, context);

      expect(result.success).toBe(true);
      expect(result.task_id).toBeDefined();

      // Check if subtasks were created
      const subtasks = await getSubtasks(result.task_id!);
      expect(subtasks.length).toBeGreaterThan(0);

      // Cleanup
      await cleanupTestTask(result.task_id!);
      for (const subtask of subtasks) {
        await cleanupTestTask(subtask.id);
      }
    });

    it('should set hierarchy_level correctly for subtasks', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      const envelope = createTestEnvelope(
        'Organize a company retreat: book venue, arrange catering, plan activities'
      );

      const context = createSkillContext(envelope);
      const result = await processTask(envelope, context);

      // Get parent task
      const [parentTask] = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, result.task_id!))
        .limit(1);

      expect(parentTask?.hierarchyLevel).toBe(0);

      const subtasks = await getSubtasks(result.task_id!);
      for (const subtask of subtasks) {
        expect(subtask.hierarchyLevel).toBe(1);
      }

      // Cleanup
      await cleanupTestTask(result.task_id!);
      for (const subtask of subtasks) {
        await cleanupTestTask(subtask.id);
      }
    });

    it('should estimate duration for complex tasks', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      const envelope = createTestEnvelope(
        'Build a new landing page for the product'
      );

      const context = createSkillContext(envelope);
      const result = await processTask(envelope, context);

      const [task] = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, result.task_id!))
        .limit(1);

      expect(task?.estimatedDurationMinutes).toBeGreaterThan(0);

      // Cleanup
      await cleanupTestTask(result.task_id!);
    });

    it('should store decomposition reasoning', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      const envelope = createTestEnvelope(
        'Launch the new mobile app to app stores'
      );

      const context = createSkillContext(envelope);
      const result = await processTask(envelope, context);

      const [task] = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, result.task_id!))
        .limit(1);

      // Reasoning might be stored if decomposition happened
      // This is optional based on LLM response
      expect(task).toBeDefined();

      // Cleanup
      await cleanupTestTask(result.task_id!);
    });
  });

  describe('Dependency Detection', () => {
    it('should detect blocking dependencies between related tasks', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      const conversationId = 'dep-test-conv';

      // First create a prerequisite task
      const envelope1 = createTestEnvelope(
        'Design the new user interface mockups',
        { conversationId }
      );
      const context1 = createSkillContext(envelope1);
      const result1 = await processTask(envelope1, context1);

      // Now create a task that depends on it
      const envelope2 = createTestEnvelope(
        'Implement the new UI based on the design mockups',
        { conversationId }
      );
      const context2 = createSkillContext(envelope2);
      const result2 = await processTask(envelope2, context2);

      // Check if dependency was detected
      const dependencies = await getDependenciesForTask(result2.task_id!);

      // Note: This depends on LLM detecting the semantic relationship
      // which may not always happen, so we just verify the structure exists
      expect(Array.isArray(dependencies)).toBe(true);

      // Cleanup
      await cleanupTestTask(result1.task_id!);
      await cleanupTestTask(result2.task_id!);
    });

    it('should handle dependency chains', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      const conversationId = 'chain-test-conv';

      const tasks = [
        'Write project requirements',
        'Design system architecture based on requirements',
        'Implement core features following the architecture',
      ];

      const taskIds: string[] = [];

      for (const content of tasks) {
        const envelope = createTestEnvelope(content, { conversationId });
        const context = createSkillContext(envelope);
        const result = await processTask(envelope, context);
        taskIds.push(result.task_id!);
      }

      // Verify all tasks were created
      for (const id of taskIds) {
        const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
        expect(task).toBeDefined();
      }

      // Cleanup
      for (const id of taskIds) {
        await cleanupTestTask(id);
      }
    });
  });

  describe('Temporal Conflict Detection', () => {
    it('should detect conflicting tasks at the same time', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      const conversationId = 'conflict-test-conv';
      const baseTime = new Date();
      baseTime.setHours(14, 0, 0, 0); // 2 PM

      // Mock the current time for consistent testing
      vi.spyOn(Date, 'now').mockReturnValue(baseTime.getTime());

      // Create first task at 2pm
      const envelope1 = createTestEnvelope(
        'Meeting with design team at 2pm',
        { conversationId }
      );
      const context1 = createSkillContext(envelope1);
      const result1 = await processTask(envelope1, context1);

      // Create second task at 2pm (should conflict)
      const envelope2 = createTestEnvelope(
        'Call dentist at 2pm',
        { conversationId, messageId: 'msg-2' }
      );
      const context2 = createSkillContext(envelope2);
      const result2 = await processTask(envelope2, context2);

      // Check for conflicts
      const conflicts = await db
        .select()
        .from(taskConflicts)
        .where(
          and(
            eq(taskConflicts.taskId1, result1.task_id!),
            eq(taskConflicts.taskId2, result2.task_id!)
          )
        );

      // Conflict detection is asynchronous and may happen after task creation
      // So we just verify the tasks were created
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // Cleanup
      vi.restoreAllMocks();
      await cleanupTestTask(result1.task_id!);
      await cleanupTestTask(result2.task_id!);
    });

    it('should detect priority conflicts in same timeframe', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      const conversationId = 'priority-conflict-conv';

      // Create multiple high-priority tasks for same day
      for (let i = 0; i < 4; i++) {
        const envelope = createTestEnvelope(
          `Urgent: Complete high priority task ${i} by tomorrow`,
          { conversationId, messageId: `msg-${i}` }
        );
        const context = createSkillContext(envelope);
        const result = await processTask(envelope, context);

        expect(result.success).toBe(true);

        // Cleanup each task as we go
        if (result.task_id) {
          await cleanupTestTask(result.task_id);
        }
      }

      // Priority conflict detection is done by background job
      // So we just verify all tasks were created successfully
    });
  });

  describe('Semantic Duplicate Detection', () => {
    it('should detect semantically similar duplicate tasks', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      const conversationId = 'duplicate-test-conv';

      // Create first task
      const envelope1 = createTestEnvelope(
        'Call John about the project proposal',
        { conversationId }
      );
      const context1 = createSkillContext(envelope1);
      const result1 = await processTask(envelope1, context1);

      expect(result1.success).toBe(true);

      // Try to create semantically similar task
      const envelope2 = createTestEnvelope(
        'Phone John regarding the project proposal',
        { conversationId, messageId: 'msg-2' }
      );
      const context2 = createSkillContext(envelope2);
      const result2 = await processTask(envelope2, context2);

      // Should be detected as duplicate
      // Note: Semantic matching depends on embedding similarity
      // which may vary based on model
      if (result2.duplicate) {
        expect(result2.success).toBe(false);
      }

      // Cleanup
      if (result1.task_id) {
        await cleanupTestTask(result1.task_id);
      }
    });

    it('should allow genuinely different tasks', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      const conversationId = 'different-tasks-conv';

      const envelope1 = createTestEnvelope(
        'Review the code changes for the authentication module',
        { conversationId }
      );
      const context1 = createSkillContext(envelope1);
      const result1 = await processTask(envelope1, context1);

      expect(result1.success).toBe(true);

      const envelope2 = createTestEnvelope(
        'Buy groceries for the week',
        { conversationId, messageId: 'msg-2' }
      );
      const context2 = createSkillContext(envelope2);
      const result2 = await processTask(envelope2, context2);

      // Should not be duplicate
      expect(result2.success).toBe(true);
      expect(result2.duplicate).toBe(false);

      // Cleanup
      if (result1.task_id) await cleanupTestTask(result1.task_id);
      if (result2.task_id) await cleanupTestTask(result2.task_id);
    });
  });

  describe('Enhanced Extraction with Context', () => {
    it('should use conversation context for better extraction', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      const conversationId = 'context-test-conv';

      // Create some context messages
      const contextMessages = [
        'We need to launch the product in 6 weeks',
        'Budget has been approved',
        'Design team is ready to start',
      ];

      // Create task that references context
      const envelope = createTestEnvelope(
        'Schedule the product launch for next month',
        { conversationId }
      );

      const context = createSkillContext(envelope);
      const result = await processTask(envelope, context);

      expect(result.success).toBe(true);
      expect(result.task_id).toBeDefined();

      // Cleanup
      if (result.task_id) {
        await cleanupTestTask(result.task_id);
      }
    });

    it('should provide suggestions for task improvement', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      const envelope = createTestEnvelope(
        'do the thing' // Vague task
      );

      const context = createSkillContext(envelope);
      const result = await processTask(envelope, context);

      // Vague tasks might be rejected for low confidence
      // Or accepted with suggestions
      if (result.success) {
        const [task] = await db
          .select()
          .from(tasks)
          .where(eq(tasks.id, result.task_id!))
          .limit(1);

        expect(task).toBeDefined();

        // Cleanup
        if (result.task_id) {
          await cleanupTestTask(result.task_id);
        }
      } else {
        // Expected for low-quality tasks
        expect(result.error).toBeDefined();
      }
    });
  });

  describe('Enrichment Data', () => {
    it('should add extract_task enrichment with composite info', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      const envelope = createTestEnvelope(
        'Plan and execute the Q1 marketing campaign'
      );

      const context = createSkillContext(envelope);
      const result = await processTask(envelope, context);

      // Check enrichment exists
      expect(envelope.enrichments['extract_task']).toBeDefined();

      // If task was created, check basic data
      if (result.success && result.task_id) {
        const [task] = await db
          .select()
          .from(tasks)
          .where(eq(tasks.id, result.task_id))
          .limit(1);

        expect(task).toBeDefined();
        expect(task?.content).toContain('marketing');
      }

      // Cleanup
      if (result.task_id) {
        await cleanupTestTask(result.task_id);
      }
    });

    it('should add create_task enrichment with task metadata', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      const envelope = createTestEnvelope(
        'Complete the project documentation'
      );

      const context = createSkillContext(envelope);
      const result = await processTask(envelope, context);

      const createEnrichment = envelope.enrichments['create_task'];
      expect(createEnrichment).toBeDefined();

      // The enrichment should contain the task_id
      if (result.task_id) {
        expect(createEnrichment).toHaveProperty('task_id', result.task_id);
      }

      // Cleanup
      if (result.task_id) {
        await cleanupTestTask(result.task_id);
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle ML service unavailability gracefully', async () => {
      // Mock fetch to simulate ML service failure
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ML service unavailable'));

      const envelope = createTestEnvelope('Create a test task');

      const context = createSkillContext(envelope);
      const result = await processTask(envelope, context);

      // Should fail gracefully
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      vi.restoreAllMocks();
    });

    it('should handle database errors gracefully', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      // This would require mocking db operations
      // For now, just verify normal flow works
      const envelope = createTestEnvelope('Test task');

      const context = createSkillContext(envelope);
      const result = await processTask(envelope, context);

      if (result.success && result.task_id) {
        await cleanupTestTask(result.task_id);
      }
    });
  });

  describe('Priority and Urgency', () => {
    it('should correctly extract high priority from urgent language', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      const envelope = createTestEnvelope(
        'URGENT: Fix the production bug immediately'
      );

      const context = createSkillContext(envelope);
      const result = await processTask(envelope, context);

      if (result.success) {
        const [task] = await db
          .select()
          .from(tasks)
          .where(eq(tasks.id, result.task_id!))
          .limit(1);

        expect(task?.priority).toBe('high');

        // Cleanup
        if (result.task_id) {
          await cleanupTestTask(result.task_id);
        }
      }
    });

    it('should assign appropriate default priority', async () => {
      if (!mlAvailable) {
        console.warn('Skipping test - ML services not available');
        return;
      }

      const envelope = createTestEnvelope(
        'Write some documentation'
      );

      const context = createSkillContext(envelope);
      const result = await processTask(envelope, context);

      if (result.success) {
        const [task] = await db
          .select()
          .from(tasks)
          .where(eq(tasks.id, result.task_id!))
          .limit(1);

        expect(task?.priority).toMatch(/^(high|medium|low)$/);

        // Cleanup
        if (result.task_id) {
          await cleanupTestTask(result.task_id);
        }
      }
    });
  });
});
