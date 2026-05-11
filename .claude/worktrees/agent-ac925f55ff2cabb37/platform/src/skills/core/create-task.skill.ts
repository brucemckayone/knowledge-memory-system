import type { Skill, SkillContext } from '../types.js';
import { tasks } from '../../db/schema.js';
import { createDependencies } from '../../services/task-dependencies.js';

export interface CreateTaskInput {
  action: string;
  due_date?: string | null;
  priority: 'high' | 'medium' | 'low';
  context_id?: string;
  memory_id: string;

  // Enhanced fields for Phase 5
  parent_task_id?: string;
  subtasks?: Array<{
    action: string;
    priority?: 'high' | 'medium' | 'low';
    estimated_duration_minutes?: number;
  }>;
  dependencies?: Array<{
    type: 'blocking' | 'prerequisite' | 'related';
    reference: string;
    confidence: number;
  }>;
  estimated_duration_minutes?: number;
  duration_confidence?: number;
  decomposition_reasoning?: string;
  suggestions?: string[];
}

export interface CreateTaskOutput {
  task_id: string;
  subtask_ids?: string[];
  dependency_ids?: string[];
  created_at: string;
}

/**
 * Create Task skill - Insert a task into the database
 *
 * Enhanced version supports:
 * - Parent-child relationships (task hierarchy)
 * - Subtask creation with automatic dependencies
 * - Dependency linking to existing tasks
 * - Duration estimation
 * - Suggestions storage
 */
export const createTaskSkill: Skill<CreateTaskInput, CreateTaskOutput> = {
  name: 'create-task',
  description: 'Create a task in the database with optional subtasks and dependencies',
  version: '2.0.0',

  async execute(input: CreateTaskInput, context: SkillContext): Promise<CreateTaskOutput> {
    const subtaskCount = input.subtasks?.length || 0;
    const depCount = input.dependencies?.length || 0;
    context.log(`Creating task: "${input.action.slice(0, 50)}..."${subtaskCount > 0 ? ` with ${subtaskCount} subtasks` : ''}${depCount > 0 ? ` with ${depCount} dependencies` : ''}`);

    const created_at = new Date().toISOString();
    const db = context.services.db as typeof import('../../db/index.js').db;

    // Calculate hierarchy level
    let hierarchyLevel = 0;
    if (input.parent_task_id) {
      // Parent task has level 0, so child is level 1
      // If parent is also a child (has its own parent), increment accordingly
      const [parent] = await db
        .select({ hierarchyLevel: tasks.hierarchyLevel })
        .from(tasks)
        .where(eq(tasks.id, input.parent_task_id))
        .limit(1);

      if (parent) {
        hierarchyLevel = parent.hierarchyLevel + 1;
      } else {
        hierarchyLevel = 1;
      }
    }

    // Create parent task
    const [task] = await db
      .insert(tasks)
      .values({
        content: input.action,
        dueDate: input.due_date ? new Date(input.due_date) : null,
        priority: input.priority,
        contextId: input.context_id,
        memoryId: input.memory_id,
        parentTaskId: input.parent_task_id,
        hierarchyLevel,
        estimatedDurationMinutes: input.estimated_duration_minutes,
        durationConfidence: input.duration_confidence,
        decompositionReasoning: input.decomposition_reasoning,
        suggestions: input.suggestions || [],
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: tasks.id });

    if (!task) {
      throw new Error('Failed to create task');
    }

    const result: CreateTaskOutput = {
      task_id: task.id,
      created_at,
    };

    // Create subtasks if provided
    if (input.subtasks && input.subtasks.length > 0) {
      const subtaskIds: string[] = [];

      for (const subtask of input.subtasks) {
        const [st] = await db
          .insert(tasks)
          .values({
            content: subtask.action,
            dueDate: input.due_date ? new Date(input.due_date) : null,
            priority: subtask.priority || input.priority,
            contextId: input.context_id,
            memoryId: input.memory_id,
            parentTaskId: task.id,
            hierarchyLevel: hierarchyLevel + 1,
            estimatedDurationMinutes: subtask.estimated_duration_minutes,
            status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .returning({ id: tasks.id });

        if (st) subtaskIds.push(st.id);
      }

      result.subtask_ids = subtaskIds;

      // Create dependencies between subtasks if specified
      if (subtaskIds.length > 1) {
        const subtaskDeps: Array<{
          taskId: string;
          dependsOnTaskId: string;
          dependencyType: 'blocking' | 'prerequisite' | 'related';
          confidence?: number;
        }> = [];

        for (let i = 1; i < subtaskIds.length; i++) {
          subtaskDeps.push({
            taskId: subtaskIds[i]!,
            dependsOnTaskId: subtaskIds[i - 1]!,
            dependencyType: 'prerequisite',
            confidence: 0.8,
          });
        }

        if (subtaskDeps.length > 0) {
          await createDependencies(subtaskDeps);
        }
      }
    }

    // Create dependencies if provided
    // Note: These need to be resolved to actual task IDs
    // The workflow layer should handle this resolution
    if (input.dependencies && input.dependencies.length > 0) {
      // Dependencies are resolved at workflow level where we have access
      // to context and can resolve references to task IDs
      // For now, we'll just note this in the result
      context.log(`Note: ${input.dependencies.length} dependencies need resolution at workflow level`);
    }

    context.log(`Task created: ${task.id}${result.subtask_ids ? ` with ${result.subtask_ids.length} subtasks` : ''}`);

    return result;
  },
};

// Import eq for the query above
import { eq } from 'drizzle-orm';
