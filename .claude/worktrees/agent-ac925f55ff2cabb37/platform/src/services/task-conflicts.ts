/**
 * Task Conflicts Service
 *
 * Detects and manages task conflicts including:
 * - Temporal conflicts (time overlaps)
 * - Resource conflicts (same resources needed)
 * - Priority conflicts (competing high-priority tasks)
 * - Logical conflicts (contradictory actions)
 *
 * Phase 5: Task Processing Pipeline Enhancements
 */

import { db } from '../db/index.js';
import { taskConflicts, tasks } from '../db/schema.js';
import { eq, and, or, sql, gte, lte, ne, isNotNull, desc } from 'drizzle-orm';

export interface TaskConflict {
  id: string;
  taskId1: string;
  taskId2: string;
  conflictType: 'temporal' | 'resource' | 'priority' | 'logical';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  detectedAt: Date;
  resolvedAt: Date | null;
  resolutionStatus: 'open' | 'resolved' | 'dismissed';
  resolutionAction: string | null;
}

export interface ConflictDetectionResult {
  hasConflicts: boolean;
  conflicts: Array<{
    taskId: string;
    conflictType: string;
    severity: string;
    description: string;
    withTask: {
      id: string;
      content: string;
      dueDate: Date | null;
    };
  }>;
}

/**
 * Detect temporal conflicts for a task
 */
export async function detectTemporalConflicts(
  taskId: string,
  dueDate: Date,
  contextId?: string
): Promise<TaskConflict[]> {
  // Find tasks with due dates within 2 hours of this task
  const timeWindow = 2 * 60 * 60 * 1000; // 2 hours in ms
  const startTime = new Date(dueDate.getTime() - timeWindow);
  const endTime = new Date(dueDate.getTime() + timeWindow);

  const conflictingTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        ne(tasks.id, taskId),
        eq(tasks.status, 'pending'),
        isNotNull(tasks.dueDate),
        contextId ? eq(tasks.contextId, contextId) : sql`1=1`,
        or(
          and(
            gte(tasks.dueDate, startTime),
            lte(tasks.dueDate, endTime)
          ),
          // Check if task with estimated duration would overlap
          and(
            sql`(${tasks.dueDate}::timestamp + (${tasks.estimatedDurationMinutes} || ' minutes')::interval) >= ${startTime}`,
            lte(tasks.dueDate, endTime)
          )
        )
      )
    )
    .limit(10);

  const conflicts: TaskConflict[] = [];

  for (const other of conflictingTasks) {
    // Skip if conflict already exists
    const existing = await db
      .select()
      .from(taskConflicts)
      .where(
        and(
          eq(taskConflicts.taskId1, taskId),
          eq(taskConflicts.taskId2, other.id),
          eq(taskConflicts.conflictType, 'temporal')
        )
      )
      .limit(1);

    if (existing.length > 0) continue;

    const severity = calculateTemporalSeverity(dueDate, other.dueDate!);
    const description = `Temporal conflict: "${other.content}" is scheduled at the same time`;

    const [conflict] = await db
      .insert(taskConflicts)
      .values({
        taskId1: taskId,
        taskId2: other.id,
        conflictType: 'temporal',
        severity,
        description,
      })
      .returning();

    if (conflict) conflicts.push(conflict as TaskConflict);
  }

  return conflicts;
}

/**
 * Detect priority conflicts (too many high-priority tasks in same timeframe)
 */
export async function detectPriorityConflicts(
  contextId: string,
  timeframe: { start: Date; end: Date }
): Promise<TaskConflict[]> {
  // Count high-priority tasks in timeframe
  const highPriorityTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.contextId, contextId),
        eq(tasks.status, 'pending'),
        sql`LOWER(${tasks.priority}) = 'high'`,
        isNotNull(tasks.dueDate),
        gte(tasks.dueDate, timeframe.start),
        lte(tasks.dueDate, timeframe.end)
      )
    )
    .orderBy(desc(tasks.dueDate))
    .limit(10);

  const conflicts: TaskConflict[] = [];

  // More than 3 high-priority tasks in a short timeframe is a conflict
  if (highPriorityTasks.length > 3) {
    // Create pairwise conflicts
    for (let i = 0; i < highPriorityTasks.length; i++) {
      for (let j = i + 1; j < highPriorityTasks.length; j++) {
        // Skip if conflict already exists
        const existing = await db
          .select()
          .from(taskConflicts)
          .where(
            and(
              or(
                and(
                  eq(taskConflicts.taskId1, highPriorityTasks[i]!.id),
                  eq(taskConflicts.taskId2, highPriorityTasks[j]!.id)
                ),
                and(
                  eq(taskConflicts.taskId1, highPriorityTasks[j]!.id),
                  eq(taskConflicts.taskId2, highPriorityTasks[i]!.id)
                )
              ),
              eq(taskConflicts.conflictType, 'priority')
            )
          )
          .limit(1);

        if (existing.length > 0) continue;

        const [conflict] = await db
          .insert(taskConflicts)
          .values({
            taskId1: highPriorityTasks[i]!.id,
            taskId2: highPriorityTasks[j]!.id,
            conflictType: 'priority',
            severity: 'medium',
            description: `${highPriorityTasks.length} high-priority tasks in same timeframe. Consider prioritizing.`,
          })
          .returning();

        if (conflict) conflicts.push(conflict as TaskConflict);
      }
    }
  }

  return conflicts;
}

/**
 * Get all open conflicts for a task
 */
export async function getOpenConflicts(taskId: string): Promise<TaskConflict[]> {
  return await db
    .select()
    .from(taskConflicts)
    .where(
      and(
        or(eq(taskConflicts.taskId1, taskId), eq(taskConflicts.taskId2, taskId)),
        eq(taskConflicts.resolutionStatus, 'open')
      )
    ) as TaskConflict[];
}

/**
 * Get all conflicts that need user attention
 */
export async function getActiveConflicts(limit: number = 50): Promise<TaskConflict[]> {
  return await db
    .select()
    .from(taskConflicts)
    .where(eq(taskConflicts.resolutionStatus, 'open'))
    .orderBy(desc(taskConflicts.detectedAt))
    .limit(limit) as TaskConflict[];
}

/**
 * Get conflicts with full task information
 */
export async function getConflictsWithDetails(
  taskId: string
): Promise<Array<{
  conflict: TaskConflict;
  otherTask: {
    id: string;
    content: string;
    dueDate: Date | null;
    priority: string;
  };
}>> {
  const conflicts = await getOpenConflicts(taskId);

  const results = [];

  for (const conflict of conflicts) {
    // Determine which task is the "other" task
    const otherTaskId = conflict.taskId1 === taskId
      ? conflict.taskId2
      : conflict.taskId1;

    const [otherTask] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, otherTaskId))
      .limit(1);

    if (otherTask) {
      results.push({
        conflict,
        otherTask: {
          id: otherTask.id,
          content: otherTask.content,
          dueDate: otherTask.dueDate,
          priority: otherTask.priority,
        },
      });
    }
  }

  return results;
}

/**
 * Resolve a conflict
 */
export async function resolveConflict(
  conflictId: string,
  resolution: 'resolved' | 'dismissed',
  action?: string
): Promise<void> {
  await db
    .update(taskConflicts)
    .set({
      resolutionStatus: resolution,
      resolvedAt: new Date(),
      resolutionAction: action || null,
    })
    .where(eq(taskConflicts.id, conflictId));
}

/**
 * Dismiss all conflicts for a task
 */
export async function dismissConflictsForTask(taskId: string): Promise<void> {
  await db
    .update(taskConflicts)
    .set({
      resolutionStatus: 'dismissed',
      resolvedAt: new Date(),
    })
    .where(
      and(
        or(eq(taskConflicts.taskId1, taskId), eq(taskConflicts.taskId2, taskId)),
        eq(taskConflicts.resolutionStatus, 'open')
      )
    );
}

/**
 * Calculate severity of temporal conflict
 */
function calculateTemporalSeverity(
  date1: Date,
  date2: Date
): 'low' | 'medium' | 'high' | 'critical' {
  const diff = Math.abs(date1.getTime() - date2.getTime());
  const minutes = diff / (1000 * 60);

  if (minutes < 15) return 'critical';  // Exact or near-exact overlap
  if (minutes < 60) return 'high';      // Within 1 hour
  if (minutes < 120) return 'medium';   // Within 2 hours
  return 'low';                         // Beyond 2 hours
}
