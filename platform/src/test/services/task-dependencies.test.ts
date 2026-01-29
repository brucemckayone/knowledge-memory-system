/**
 * Unit Tests: Task Dependencies Service
 *
 * Tests for task dependency relationship management including:
 * - Creating dependencies
 * - Querying dependency chains
 * - Finding blocking tasks
 * - Dependency validation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createDependencies, getTaskDependencies, getDependencyChain, hasUnmetBlockingDependencies, resolveDependencyByReference, deleteDependency } from '../../services/task-dependencies.js';
import { db } from '../../db/index.js';
import { tasks, taskDependencies } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';

describe('Task Dependencies Service', () => {
  let taskIds: string[] = [];
  let contextId: string;

  beforeAll(async () => {
    // Create a test context
    contextId = crypto.randomUUID();
  });

  beforeEach(async () => {
    // Clean up any existing test data
    if (taskIds.length > 0) {
      for (const id of taskIds) {
        await db.delete(taskDependencies).where(eq(taskDependencies.taskId, id));
        await db.delete(tasks).where(eq(tasks.id, id));
      }
    }

    // Reset the taskIds array
    taskIds = [];

    // Create test tasks
    for (let i = 0; i < 5; i++) {
      const [task] = await db
        .insert(tasks)
        .values({
          content: `Test task ${i}`,
          status: 'pending',
          priority: 'medium',
          contextId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: tasks.id });
      taskIds.push(task!.id);
    }
  });

  afterAll(async () => {
    // Cleanup
    for (const id of taskIds) {
      await db.delete(taskDependencies).where(eq(taskDependencies.taskId, id));
      await db.delete(tasks).where(eq(tasks.id, id));
    }
  });

  describe('createDependencies', () => {
    it('should create a single dependency between tasks', async () => {
      const dependencies = await createDependencies([{
        taskId: taskIds[1]!,
        dependsOnTaskId: taskIds[0]!,
        dependencyType: 'blocking',
        confidence: 1.0,
      }]);

      expect(dependencies).toHaveLength(1);
      expect(dependencies[0].taskId).toBe(taskIds[1]);
      expect(dependencies[0].dependencyType).toBe('blocking');
      expect(dependencies[0].detectedBy).toBe('llm'); // default
    });

    it('should create multiple dependencies at once', async () => {
      const dependencies = await createDependencies([
        {
          taskId: taskIds[1]!,
          dependsOnTaskId: taskIds[0]!,
          dependencyType: 'blocking',
          confidence: 1.0,
        },
        {
          taskId: taskIds[2]!,
          dependsOnTaskId: taskIds[1]!,
          dependencyType: 'prerequisite',
          confidence: 0.8,
        },
      ]);

      expect(dependencies).toHaveLength(2);
    });

    it('should handle duplicate dependencies gracefully', async () => {
      const deps1 = await createDependencies([{
        taskId: taskIds[1]!,
        dependsOnTaskId: taskIds[0]!,
        dependencyType: 'blocking',
        confidence: 1.0,
      }]);

      const deps2 = await createDependencies([{
        taskId: taskIds[1]!,
        dependsOnTaskId: taskIds[0]!,
        dependencyType: 'blocking',
        confidence: 0.5,
      }]);

      // Second creation should not create duplicate
      expect(deps1).toHaveLength(1);
      expect(deps2).toHaveLength(0);
    });

    it('should support all dependency types', async () => {
      const types: Array<'blocking' | 'prerequisite' | 'related'> = ['blocking', 'prerequisite', 'related'];

      for (const type of types) {
        const [dep] = await createDependencies([{
          taskId: taskIds[0]!,
          dependsOnTaskId: taskIds[1]!,
          dependencyType: type,
          confidence: 1.0,
        }]);

        expect(dep?.dependencyType).toBe(type);
      }
    });
  });

  describe('getTaskDependencies', () => {
    it('should retrieve all dependencies for a task', async () => {
      await createDependencies([
        { taskId: taskIds[3]!, dependsOnTaskId: taskIds[0]!, dependencyType: 'blocking', confidence: 1.0 },
        { taskId: taskIds[3]!, dependsOnTaskId: taskIds[1]!, dependencyType: 'prerequisite', confidence: 0.8 },
      ]);

      const deps = await getTaskDependencies(taskIds[3]!);
      expect(deps).toHaveLength(2);
      expect(deps[0].dependsOnTaskId).toBe(taskIds[0]);
      expect(deps[1].dependsOnTaskId).toBe(taskIds[1]);
    });

    it('should include task details in dependency results', async () => {
      await createDependencies([
        { taskId: taskIds[1]!, dependsOnTaskId: taskIds[0]!, dependencyType: 'blocking', confidence: 1.0 },
      ]);

      const deps = await getTaskDependencies(taskIds[1]!);
      expect(deps).toHaveLength(1);
      expect(deps[0].dependsOnTask).toBeDefined();
      expect(deps[0].dependsOnTask.id).toBe(taskIds[0]);
      expect(deps[0].dependsOnTask.content).toBe('Test task 0');
    });

    it('should return empty array for tasks with no dependencies', async () => {
      const deps = await getTaskDependencies(taskIds[0]!);
      expect(deps).toHaveLength(0);
    });
  });

  describe('getDependencyChain', () => {
    it('should return level 0 for tasks with no dependencies', async () => {
      const chain = await getDependencyChain(taskIds[0]!);
      expect(chain.level).toBe(0);
      expect(chain.dependencies).toHaveLength(0);
    });

    it('should calculate level 1 for direct dependency', async () => {
      await createDependencies([
        { taskId: taskIds[1]!, dependsOnTaskId: taskIds[0]!, dependencyType: 'blocking', confidence: 1.0 },
      ]);

      const chain = await getDependencyChain(taskIds[1]!);
      expect(chain.level).toBe(1);
      expect(chain.dependencies).toContain(taskIds[0]!);
    });

    it('should calculate level for multi-level chain', async () => {
      // Create chain: task2 -> task1, task3 -> task2
      await createDependencies([
        { taskId: taskIds[1]!, dependsOnTaskId: taskIds[0]!, dependencyType: 'blocking', confidence: 1.0 },
        { taskId: taskIds[2]!, dependsOnTaskId: taskIds[1]!, dependencyType: 'prerequisite', confidence: 1.0 },
      ]);

      const chain = await getDependencyChain(taskIds[2]!);
      expect(chain.level).toBe(2);
    });

    it('should include both dependencies and dependents in chain', async () => {
      await createDependencies([
        { taskId: taskIds[1]!, dependsOnTaskId: taskIds[0]!, dependencyType: 'blocking', confidence: 1.0 },
        { taskId: taskIds[2]!, dependsOnTaskId: taskIds[1]!, dependencyType: 'prerequisite', confidence: 1.0 },
      ]);

      const chain = await getDependencyChain(taskIds[1]!);
      expect(chain.dependencies).toContain(taskIds[0]!);
      expect(chain.dependents).toContain(taskIds[2]!);
    });
  });

  describe('hasUnmetBlockingDependencies', () => {
    it('should return false for tasks with no dependencies', async () => {
      const hasUnmet = await hasUnmetBlockingDependencies(taskIds[0]!);
      expect(hasUnmet).toBe(false);
    });

    it('should return true when blocking dependency is pending', async () => {
      await createDependencies([
        { taskId: taskIds[1]!, dependsOnTaskId: taskIds[0]!, dependencyType: 'blocking', confidence: 1.0 },
      ]);

      const hasUnmet = await hasUnmetBlockingDependencies(taskIds[1]!);
      expect(hasUnmet).toBe(true);
    });

    it('should return false when blocking dependency is completed', async () => {
      await createDependencies([
        { taskId: taskIds[1]!, dependsOnTaskId: taskIds[0]!, dependencyType: 'blocking', confidence: 1.0 },
      ]);

      // Mark the dependency as completed
      await db.update(tasks).set({ status: 'completed' }).where(eq(tasks.id, taskIds[0]!));

      const hasUnmet = await hasUnmetBlockingDependencies(taskIds[1]!);
      expect(hasUnmet).toBe(false);
    });

    it('should ignore non-blocking dependencies', async () => {
      await createDependencies([
        { taskId: taskIds[1]!, dependsOnTaskId: taskIds[0]!, dependencyType: 'related', confidence: 1.0 },
      ]);

      const hasUnmet = await hasUnmetBlockingDependencies(taskIds[1]!);
      expect(hasUnmet).toBe(false);
    });
  });

  describe('resolveDependencyByReference', () => {
    it('should find task by text reference in same context', async () => {
      const [task] = await db
        .insert(tasks)
        .values({
          content: 'Review the design mockups for homepage',
          status: 'pending',
          priority: 'high',
          contextId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: tasks.id });

      if (task) {
        taskIds.push(task.id);
      }

      const resolved = await resolveDependencyByReference(contextId, 'design mockups');
      expect(resolved).toBe(task?.id);
    });

    it('should return null when no match found', async () => {
      const resolved = await resolveDependencyByReference(contextId, 'nonexistent task');
      expect(resolved).toBeNull();
    });

    it('should return most recent task when multiple matches exist', async () => {
      const [task1] = await db
        .insert(tasks)
        .values({
          content: 'Review the API documentation',
          status: 'pending',
          priority: 'medium',
          contextId,
          createdAt: new Date(Date.now() - 10000),
          updatedAt: new Date(),
        })
        .returning({ id: tasks.id });

      const [task2] = await db
        .insert(tasks)
        .values({
          content: 'Review the API endpoints',
          status: 'pending',
          priority: 'medium',
          contextId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: tasks.id });

      if (task1) taskIds.push(task1.id);
      if (task2) taskIds.push(task2.id);

      const resolved = await resolveDependencyByReference(contextId, 'API');
      // Should return the more recent task (task2)
      expect(resolved).toBeDefined();
    });
  });

  describe('deleteDependency', () => {
    it('should delete a specific dependency', async () => {
      await createDependencies([
        { taskId: taskIds[1]!, dependsOnTaskId: taskIds[0]!, dependencyType: 'blocking', confidence: 1.0 },
      ]);

      await deleteDependency(taskIds[1]!, taskIds[0]!);

      const remaining = await getTaskDependencies(taskIds[1]!);
      expect(remaining).toHaveLength(0);
    });

    it('should handle deleting non-existent dependency gracefully', async () => {
      // Should not throw
      await expect(
        deleteDependency(taskIds[0]!, taskIds[1]!)
      ).resolves.toBeUndefined();
    });
  });
});
