/**
 * Task Dependencies Service
 *
 * Manages task dependency relationships including:
 * - Creating dependency links
 * - Querying dependency chains
 * - Finding blocking tasks
 * - Dependency validation
 *
 * Phase 5: Task Processing Pipeline Enhancements
 */

import { db } from '../db/index.js';
import { taskDependencies, tasks } from '../db/schema.js';
import { eq, and, sql, or, desc } from 'drizzle-orm';

export interface TaskDependency {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  dependencyType: 'blocking' | 'prerequisite' | 'related';
  confidence: number;
  detectedBy: 'llm' | 'user' | 'pattern';
  createdAt: Date;
}

export interface DependencyWithTask extends TaskDependency {
  dependsOnTask: {
    id: string;
    content: string;
    status: string;
    dueDate: Date | null;
  };
}

export interface DependencyChain {
  taskId: string;
  content: string;
  dependencies: string[];
  dependents: string[];
  level: number; // 0 = no dependencies, higher = deeper in chain
}

/**
 * Create a new task dependency
 */
export async function createDependency(params: {
  taskId: string;
  dependsOnTaskId: string;
  dependencyType: 'blocking' | 'prerequisite' | 'related';
  confidence?: number;
  detectedBy?: 'llm' | 'user' | 'pattern';
}): Promise<TaskDependency | null> {
  try {
    const [dependency] = await db
      .insert(taskDependencies)
      .values({
        taskId: params.taskId,
        dependsOnTaskId: params.dependsOnTaskId,
        dependencyType: params.dependencyType,
        confidence: params.confidence ?? 1.0,
        detectedBy: params.detectedBy ?? 'llm',
      })
      .onConflictDoNothing({
        target: [taskDependencies.taskId, taskDependencies.dependsOnTaskId, taskDependencies.dependencyType],
      })
      .returning();

    return dependency as TaskDependency ?? null;
  } catch (error) {
    console.error(`Failed to create dependency: ${error}`);
    return null;
  }
}

/**
 * Create multiple dependencies at once
 */
export async function createDependencies(
  dependencies: Array<{
    taskId: string;
    dependsOnTaskId: string;
    dependencyType: 'blocking' | 'prerequisite' | 'related';
    confidence?: number;
    detectedBy?: 'llm' | 'user' | 'pattern';
  }>
): Promise<TaskDependency[]> {
  const results: TaskDependency[] = [];

  for (const dep of dependencies) {
    const created = await createDependency(dep);
    if (created) results.push(created);
  }

  return results;
}

/**
 * Get all dependencies for a task (what this task depends on)
 */
export async function getTaskDependencies(taskId: string): Promise<DependencyWithTask[]> {
  const result = await db
    .select({
      id: taskDependencies.id,
      taskId: taskDependencies.taskId,
      dependsOnTaskId: taskDependencies.dependsOnTaskId,
      dependencyType: taskDependencies.dependencyType,
      confidence: taskDependencies.confidence,
      detectedBy: taskDependencies.detectedBy,
      createdAt: taskDependencies.createdAt,
      dependsOnTask: {
        id: tasks.id,
        content: tasks.content,
        status: tasks.status,
        dueDate: tasks.dueDate,
      },
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnTaskId, tasks.id))
    .where(eq(taskDependencies.taskId, taskId));

  return result as DependencyWithTask[];
}

/**
 * Get tasks that depend on this task (what's blocked by this task)
 */
export async function getDependentTasks(taskId: string): Promise<DependencyWithTask[]> {
  const result = await db
    .select({
      id: taskDependencies.id,
      taskId: taskDependencies.taskId,
      dependsOnTaskId: taskDependencies.dependsOnTaskId,
      dependencyType: taskDependencies.dependencyType,
      confidence: taskDependencies.confidence,
      detectedBy: taskDependencies.detectedBy,
      createdAt: taskDependencies.createdAt,
      dependsOnTask: {
        id: tasks.id,
        content: tasks.content,
        status: tasks.status,
        dueDate: tasks.dueDate,
      },
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.taskId, tasks.id))
    .where(eq(taskDependencies.dependsOnTaskId, taskId));

  return result as DependencyWithTask[];
}

/**
 * Get full dependency chain for a task
 * Calculates the depth of dependencies (how many levels deep)
 */
export async function getDependencyChain(taskId: string): Promise<DependencyChain> {
  const task = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
    .then(rows => rows[0]);

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const dependencies = await getTaskDependencies(taskId);
  const dependents = await getDependentTasks(taskId);

  // Calculate dependency level (depth of dependency chain)
  let level = 0;
  const visited = new Set<string>();
  let currentTaskIds = [taskId];

  while (currentTaskIds.length > 0 && level < 10) {
    const nextLevelIds: string[] = [];
    for (const tid of currentTaskIds) {
      if (visited.has(tid)) continue;
      visited.add(tid);

      const deps = await getTaskDependencies(tid);
      for (const dep of deps) {
        if (!visited.has(dep.dependsOnTaskId)) {
          nextLevelIds.push(dep.dependsOnTaskId);
        }
      }
    }

    if (nextLevelIds.length > 0) {
      level++;
    }
    currentTaskIds = nextLevelIds;
  }

  return {
    taskId: task.id,
    content: task.content,
    dependencies: dependencies.map(d => d.dependsOnTaskId),
    dependents: dependents.map(d => d.taskId),
    level,
  };
}

/**
 * Check if a task has unmet blocking dependencies
 */
export async function hasUnmetBlockingDependencies(taskId: string): Promise<boolean> {
  const blockingDeps = await getTaskDependencies(taskId);
  const unmet = blockingDeps.filter(
    dep => dep.dependencyType === 'blocking' && dep.dependsOnTask.status !== 'completed'
  );
  return unmet.length > 0;
}

/**
 * Resolve dependencies by text reference (for LLM-detected dependencies)
 *
 * When LLM says "depends on the design review task", we need to find that task
 * by searching for similar content within the same context.
 */
export async function resolveDependencyByReference(
  contextId: string,
  reference: string
): Promise<string | null> {
  // Search for tasks in same context that match the reference
  const referenceLower = reference.toLowerCase();

  const candidates = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.contextId, contextId),
        eq(tasks.status, 'pending'),
        sql`LOWER(${tasks.content}) LIKE ${`%${referenceLower}%`}`
      )
    )
    .limit(5);

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.id;

  // Multiple matches - return most recent
  return candidates
    .sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime())
    [0]!.id;
}

/**
 * Find candidate tasks for dependency matching
 * Returns all pending tasks in a context sorted by recency
 */
export async function getCandidateTasksForDependency(
  contextId: string,
  limit: number = 20
): Promise<Array<{ id: string; content: string; createdAt: Date }>> {
  const candidates = await db
    .select({
      id: tasks.id,
      content: tasks.content,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.contextId, contextId),
        eq(tasks.status, 'pending')
      )
    )
    .orderBy(desc(tasks.createdAt))
    .limit(limit);

  return candidates;
}

/**
 * Delete a dependency
 */
export async function deleteDependency(
  taskId: string,
  dependsOnTaskId: string
): Promise<void> {
  await db
    .delete(taskDependencies)
    .where(
      and(
        eq(taskDependencies.taskId, taskId),
        eq(taskDependencies.dependsOnTaskId, dependsOnTaskId)
      )
    );
}

/**
 * Delete all dependencies for a task (both incoming and outgoing)
 */
export async function deleteAllDependenciesForTask(taskId: string): Promise<void> {
  await db
    .delete(taskDependencies)
    .where(
      or(
        eq(taskDependencies.taskId, taskId),
        eq(taskDependencies.dependsOnTaskId, taskId)
      )
    );
}
