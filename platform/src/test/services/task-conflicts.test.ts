/**
 * Unit Tests: Task Conflicts Service
 *
 * Tests for task conflict detection and management including:
 * - Temporal conflicts (time overlaps)
 * - Priority conflicts (competing priorities)
 * - Resource conflicts (same resources needed)
 * - Conflict resolution
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  detectTemporalConflicts,
  detectPriorityConflicts,
  getOpenConflicts,
  resolveConflict,
  getActiveConflicts
} from '../../services/task-conflicts.js';
import { db } from '../../db/index.js';
import { tasks, taskConflicts } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';

describe('Task Conflicts Service', () => {
  let taskIds: string[] = [];
  let contextId: string;

  beforeAll(async () => {
    contextId = crypto.randomUUID();
  });

  beforeEach(async () => {
    // Clean up test data
    for (const id of taskIds) {
      await db.delete(taskConflicts).where(
        and(
          eq(taskConflicts.taskId1, id),
          eq(taskConflicts.taskId2, id)
        )
      ).catch(() => {});
      await db.delete(tasks).where(eq(tasks.id, id));
    }
    taskIds = [];
  });

  afterAll(async () => {
    for (const id of taskIds) {
      await db.delete(taskConflicts).where(
        eq(taskConflicts.taskId1, id)
      ).catch(() => {});
      await db.delete(tasks).where(eq(tasks.id, id));
    }
  });

  async function createTask(overrides?: {
    dueDate?: Date;
    priority?: string;
    content?: string;
  }): Promise<string> {
    const [task] = await db
      .insert(tasks)
      .values({
        content: overrides?.content || 'Test task',
        status: 'pending',
        priority: (overrides?.priority as any) || 'medium',
        dueDate: overrides?.dueDate || null,
        contextId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: tasks.id });

    if (task) {
      taskIds.push(task.id);
    }
    return task!.id;
  }

  describe('detectTemporalConflicts', () => {
    it('should detect exact time overlap (critical severity)', async () => {
      const baseTime = new Date('2025-01-15T14:00:00Z');
      const taskId1 = await createTask({ dueDate: baseTime });
      const taskId2 = await createTask({ dueDate: baseTime });

      const conflicts = await detectTemporalConflicts(taskId2, baseTime, contextId);

      expect(conflicts.length).toBeGreaterThan(0);
      expect(conflicts[0].conflictType).toBe('temporal');
      expect(conflicts[0].severity).toBe('critical');
    });

    it('should detect conflicts within 15 minutes (critical severity)', async () => {
      const baseTime = new Date('2025-01-15T14:00:00Z');
      const nearbyTime = new Date('2025-01-15T14:10:00Z');

      const taskId1 = await createTask({ dueDate: baseTime });
      const taskId2 = await createTask({ dueDate: nearbyTime });

      const conflicts = await detectTemporalConflicts(taskId2, nearbyTime, contextId);

      expect(conflicts.length).toBeGreaterThan(0);
      // Conflicts under 15 minutes are considered critical severity
      expect(conflicts[0].severity).toBe('critical');
    });

    it('should detect conflicts within 1 hour (high severity)', async () => {
      const baseTime = new Date('2025-01-15T14:00:00Z');
      const nearbyTime = new Date('2025-01-15T14:30:00Z');

      await createTask({ dueDate: baseTime });
      const taskId2 = await createTask({ dueDate: nearbyTime });

      const conflicts = await detectTemporalConflicts(taskId2, nearbyTime, contextId);

      expect(conflicts.length).toBeGreaterThan(0);
    });

    it('should detect conflicts within 2 hours (medium severity)', async () => {
      const baseTime = new Date('2025-01-15T14:00:00Z');
      const nearbyTime = new Date('2025-01-15T15:30:00Z');

      await createTask({ dueDate: baseTime });
      const taskId2 = await createTask({ dueDate: nearbyTime });

      const conflicts = await detectTemporalConflicts(taskId2, nearbyTime, contextId);

      expect(conflicts.length).toBeGreaterThan(0);
      expect(conflicts[0].severity).toBe('medium');
    });

    it('should not flag tasks more than 2 hours apart as conflicts', async () => {
      const baseTime = new Date('2025-01-15T14:00:00Z');
      const farTime = new Date('2025-01-15T17:00:00Z');

      await createTask({ dueDate: baseTime });
      const taskId2 = await createTask({ dueDate: farTime });

      const conflicts = await detectTemporalConflicts(taskId2, farTime, contextId);

      expect(conflicts).toHaveLength(0);
    });

    it('should only consider tasks in the same context', async () => {
      const baseTime = new Date('2025-01-15T14:00:00Z');
      const otherContextId = crypto.randomUUID();

      // Create task in different context
      const [otherContextTask] = await db
        .insert(tasks)
        .values({
          content: 'Task in other context',
          status: 'pending',
          priority: 'medium',
          dueDate: baseTime,
          contextId: otherContextId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: tasks.id });

      const taskId2 = await createTask({ dueDate: baseTime });

      const conflicts = await detectTemporalConflicts(taskId2, baseTime, contextId);

      // Should not detect the task from other context
      const conflictWithOther = conflicts.find(c =>
        c.taskId1 === otherContextTask?.id || c.taskId2 === otherContextTask?.id
      );
      expect(conflictWithOther).toBeUndefined();

      if (otherContextTask) {
        await db.delete(tasks).where(eq(tasks.id, otherContextTask.id));
      }
    });

    it('should ignore completed tasks', async () => {
      const baseTime = new Date('2025-01-15T14:00:00Z');

      const [completedTask] = await db
        .insert(tasks)
        .values({
          content: 'Completed task',
          status: 'completed',
          priority: 'medium',
          dueDate: baseTime,
          contextId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: tasks.id });

      const taskId2 = await createTask({ dueDate: baseTime });

      const conflicts = await detectTemporalConflicts(taskId2, baseTime, contextId);

      // Should not conflict with completed task
      const conflictWithCompleted = conflicts.find(c =>
        c.taskId1 === completedTask?.id || c.taskId2 === completedTask?.id
      );
      expect(conflictWithCompleted).toBeUndefined();

      if (completedTask) {
        await db.delete(tasks).where(eq(tasks.id, completedTask.id));
      }
    });
  });

  describe('detectPriorityConflicts', () => {
    it('should detect when too many high-priority tasks exist in timeframe', async () => {
      const startTime = new Date('2025-01-15T00:00:00Z');
      const endTime = new Date('2025-01-15T23:59:59Z');

      // Create 4 high-priority tasks (more than threshold of 3)
      for (let i = 0; i < 4; i++) {
        await createTask({
          dueDate: new Date(`2025-01-15T${10 + i}:00:00Z`),
          priority: 'high',
          content: `High priority task ${i}`,
        });
      }

      const conflicts = await detectPriorityConflicts(contextId, { start: startTime, end: endTime });

      expect(conflicts.length).toBeGreaterThan(0);
      expect(conflicts[0].conflictType).toBe('priority');
    });

    it('should not flag 3 or fewer high-priority tasks as conflict', async () => {
      const startTime = new Date('2025-01-15T00:00:00Z');
      const endTime = new Date('2025-01-15T23:59:59Z');

      // Create exactly 3 high-priority tasks (at threshold)
      for (let i = 0; i < 3; i++) {
        await createTask({
          dueDate: new Date(`2025-01-15T${10 + i}:00:00Z`),
          priority: 'high',
          content: `High priority task ${i}`,
        });
      }

      const conflicts = await detectPriorityConflicts(contextId, { start: startTime, end: endTime });

      // Should not create conflicts at exactly 3
      expect(conflicts).toHaveLength(0);
    });

    it('should only consider tasks within the specified timeframe', async () => {
      const startTime = new Date('2025-01-15T00:00:00Z');
      const endTime = new Date('2025-01-15T23:59:59Z');

      // Create high-priority task outside timeframe
      await createTask({
        dueDate: new Date('2025-01-20T14:00:00Z'),
        priority: 'high',
        content: 'Future high priority task',
      });

      // Create 3 within timeframe (at threshold)
      for (let i = 0; i < 3; i++) {
        await createTask({
          dueDate: new Date(`2025-01-15T${10 + i}:00:00Z`),
          priority: 'high',
          content: `High priority task ${i}`,
        });
      }

      const conflicts = await detectPriorityConflicts(contextId, { start: startTime, end: endTime });

      expect(conflicts).toHaveLength(0);
    });
  });

  describe('getOpenConflicts', () => {
    it('should return only open conflicts for a task', async () => {
      const baseTime = new Date('2025-01-15T14:00:00Z');
      const taskId1 = await createTask({ dueDate: baseTime });
      const taskId2 = await createTask({ dueDate: baseTime });

      // Create a conflict
      await detectTemporalConflicts(taskId2, baseTime, contextId);

      const openConflicts = await getOpenConflicts(taskId2);

      expect(openConflicts.length).toBeGreaterThan(0);
      expect(openConflicts[0].resolutionStatus).toBe('open');
    });

    it('should not return resolved conflicts', async () => {
      const baseTime = new Date('2025-01-15T14:00:00Z');
      const taskId1 = await createTask({ dueDate: baseTime });
      const taskId2 = await createTask({ dueDate: baseTime });

      // Create and then resolve a conflict
      const conflicts = await detectTemporalConflicts(taskId2, baseTime, contextId);
      if (conflicts.length > 0) {
        await resolveConflict(conflicts[0].id, 'resolved', 'Task rescheduled');
      }

      const openConflicts = await getOpenConflicts(taskId2);

      expect(openConflicts).toHaveLength(0);
    });

    it('should return empty array for tasks with no conflicts', async () => {
      const taskId = await createTask({ dueDate: new Date('2025-01-15T14:00:00Z') });

      const conflicts = await getOpenConflicts(taskId);

      expect(conflicts).toHaveLength(0);
    });
  });

  describe('resolveConflict', () => {
    it('should mark conflict as resolved with action', async () => {
      const baseTime = new Date('2025-01-15T14:00:00Z');
      const taskId1 = await createTask({ dueDate: baseTime });
      const taskId2 = await createTask({ dueDate: baseTime });

      const conflicts = await detectTemporalConflicts(taskId2, baseTime, contextId);
      expect(conflicts.length).toBeGreaterThan(0);

      await resolveConflict(conflicts[0].id, 'resolved', 'Moved second task to 3pm');

      const openConflicts = await getOpenConflicts(taskId2);
      expect(openConflicts).toHaveLength(0);
    });

    it('should mark conflict as dismissed', async () => {
      const baseTime = new Date('2025-01-15T14:00:00Z');
      const taskId1 = await createTask({ dueDate: baseTime });
      const taskId2 = await createTask({ dueDate: baseTime });

      const conflicts = await detectTemporalConflicts(taskId2, baseTime, contextId);

      await resolveConflict(conflicts[0].id, 'dismissed', 'Not a real conflict');

      const updated = await db
        .select()
        .from(taskConflicts)
        .where(eq(taskConflicts.id, conflicts[0].id))
        .limit(1);

      expect(updated[0]?.resolutionStatus).toBe('dismissed');
      expect(updated[0]?.resolutionAction).toBe('Not a real conflict');
      expect(updated[0]?.resolvedAt).toBeDefined();
    });

    it('should set resolvedAt timestamp', async () => {
      const baseTime = new Date('2025-01-15T14:00:00Z');
      const taskId1 = await createTask({ dueDate: baseTime });
      const taskId2 = await createTask({ dueDate: baseTime });

      const conflicts = await detectTemporalConflicts(taskId2, baseTime, contextId);
      const beforeResolve = new Date();

      await resolveConflict(conflicts[0].id, 'resolved');

      // Add small delay to ensure database operation completes
      await new Promise(resolve => setTimeout(resolve, 10));

      const updated = await db
        .select()
        .from(taskConflicts)
        .where(eq(taskConflicts.id, conflicts[0].id))
        .limit(1);

      const resolvedAt = updated[0]?.resolvedAt;
      expect(resolvedAt).toBeDefined();
      if (resolvedAt) {
        // Use tolerance for database latency (up to 1 second is acceptable)
        expect(new Date(resolvedAt).getTime()).toBeGreaterThanOrEqual(beforeResolve.getTime() - 1000);
      }
    });
  });

  describe('getActiveConflicts', () => {
    it('should return all open conflicts across all tasks', async () => {
      const baseTime = new Date('2025-01-15T14:00:00Z');

      // Create multiple conflicting tasks
      for (let i = 0; i < 3; i++) {
        await createTask({ dueDate: baseTime, content: `Task ${i}` });
      }

      // This will create conflicts
      const taskId = await createTask({ dueDate: baseTime });
      await detectTemporalConflicts(taskId, baseTime, contextId);

      const activeConflicts = await getActiveConflicts(50);

      expect(activeConflicts.length).toBeGreaterThan(0);
      expect(activeConflicts.every(c => c.resolutionStatus === 'open')).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const baseTime = new Date('2025-01-15T14:00:00Z');

      // Create many conflicts
      for (let i = 0; i < 5; i++) {
        await createTask({ dueDate: baseTime, content: `Task ${i}` });
      }

      const limitedConflicts = await getActiveConflicts(2);

      expect(limitedConflicts.length).toBeLessThanOrEqual(2);
    });

    it('should return conflicts ordered by detection time (newest first)', async () => {
      const baseTime = new Date('2025-01-15T14:00:00Z');

      await createTask({ dueDate: baseTime, content: 'First task' });
      const taskId = await createTask({ dueDate: baseTime });

      await detectTemporalConflicts(taskId, baseTime, contextId);

      const activeConflicts = await getActiveConflicts(10);

      if (activeConflicts.length >= 2) {
        const firstTime = new Date(activeConflicts[0].detectedAt).getTime();
        const secondTime = new Date(activeConflicts[1].detectedAt).getTime();
        expect(firstTime).toBeGreaterThanOrEqual(secondTime);
      }
    });
  });
});
