import type { Skill, SkillContext } from '../types.js';
import { tasks } from '../../db/schema.js';

export interface CreateTaskInput {
  action: string;
  due_date?: string | null;
  priority: 'high' | 'medium' | 'low';
  context_id?: string;
  memory_id: string;
}

export interface CreateTaskOutput {
  task_id: string;
  created_at: string;
}

/**
 * Create Task skill - Insert a task into the database
 */
export const createTaskSkill: Skill<CreateTaskInput, CreateTaskOutput> = {
  name: 'create-task',
  description: 'Create a task in the database',
  version: '1.0.0',

  async execute(input: CreateTaskInput, context: SkillContext): Promise<CreateTaskOutput> {
    context.log(`Creating task: "${input.action.slice(0, 50)}..."`);

    const created_at = new Date().toISOString();
    const db = context.services.db as typeof import('../../db/index.js').db;

    const result = await db
      .insert(tasks)
      .values({
        content: input.action,
        dueDate: input.due_date ? new Date(input.due_date) : null,
        priority: input.priority,
        contextId: input.context_id,
        memoryId: input.memory_id,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: tasks.id });

    const task = result[0];
    if (!task) {
      throw new Error('Failed to create task');
    }

    context.log(`Task created: ${task.id}`);

    return {
      task_id: task.id,
      created_at,
    };
  },
};
