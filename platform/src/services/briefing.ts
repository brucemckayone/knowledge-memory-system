/**
 * Briefing Service (W32)
 *
 * Generates daily morning briefings by aggregating recent insights,
 * pending tasks, and notable memories.
 */

import { db } from '../db/index.js';
import { briefings, tasks } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { ml } from './ml-client.js';
import { getActiveInsights } from './insights.js';

export interface BriefingSection {
  title: string;
  content: string;
  type: 'insights' | 'tasks' | 'memories' | 'summary';
}

export interface GeneratedBriefing {
  summary: string;
  sections: BriefingSection[];
  insightCount: number;
  taskCount: number;
  memoryCount: number;
}

/**
 * Generate today's morning briefing.
 */
export async function generateBriefing(): Promise<GeneratedBriefing> {
  const sections: BriefingSection[] = [];

  // 1. Gather pending tasks
  const pendingTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.status, 'pending'))
    .orderBy(desc(tasks.createdAt))
    .limit(10);

  if (pendingTasks.length > 0) {
    const taskList = pendingTasks
      .map(t => `- [${t.priority}] ${t.content}${t.dueDate ? ` (due: ${t.dueDate.toLocaleDateString()})` : ''}`)
      .join('\n');

    sections.push({
      title: 'Pending Tasks',
      content: taskList,
      type: 'tasks',
    });
  }

  // 2. Gather recent insights
  const recentInsights = await getActiveInsights(5);

  if (recentInsights.length > 0) {
    const insightList = recentInsights
      .map(i => `- **${i.title}**: ${i.body.slice(0, 200)}`)
      .join('\n');

    sections.push({
      title: 'Recent Insights',
      content: insightList,
      type: 'insights',
    });
  }

  // 3. Try to get project context (W45 graceful degradation)
  try {
    const { getActiveProjects } = await import('./project-association.js');
    const projects = await getActiveProjects();
    if (projects.length > 0) {
      const projectList = projects
        .slice(0, 5)
        .map((p) => `- ${p.name}: ${p.description || 'No description'}`)
        .join('\n');

      sections.push({
        title: 'Active Projects',
        content: projectList,
        type: 'summary',
      });
    }
  } catch {
    // W45 not yet implemented — degrade gracefully
  }

  // 4. Generate summary via LLM
  let summary = `Good morning! You have ${pendingTasks.length} pending tasks and ${recentInsights.length} new insights.`;

  try {
    const prompt = `Generate a concise morning briefing summary (2-3 sentences) based on:
- ${pendingTasks.length} pending tasks
- ${recentInsights.length} new insights
- Top tasks: ${pendingTasks.slice(0, 3).map(t => t.content).join('; ')}

Be encouraging and actionable.`;

    const result = await ml.chat(prompt, 'You are a personal productivity assistant. Be concise and warm.');
    summary = result.response;
  } catch {
    // LLM unavailable — use default summary
  }

  sections.unshift({
    title: 'Summary',
    content: summary,
    type: 'summary',
  });

  return {
    summary,
    sections,
    insightCount: recentInsights.length,
    taskCount: pendingTasks.length,
    memoryCount: 0,
  };
}

/**
 * Persist a generated briefing.
 */
export async function persistBriefing(briefing: GeneratedBriefing): Promise<string> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = await db
    .insert(briefings)
    .values({
      briefingDate: today,
      summary: briefing.summary,
      sections: briefing.sections as unknown as Record<string, unknown>[],
      insightCount: briefing.insightCount,
      taskCount: briefing.taskCount,
      memoryCount: briefing.memoryCount,
    })
    .onConflictDoUpdate({
      target: briefings.briefingDate,
      set: {
        summary: briefing.summary,
        sections: briefing.sections as unknown as Record<string, unknown>[],
        insightCount: briefing.insightCount,
        taskCount: briefing.taskCount,
        generatedAt: new Date(),
      },
    })
    .returning({ id: briefings.id });

  return result[0]!.id;
}

/**
 * Get the most recent briefing.
 */
export async function getLatestBriefing() {
  const result = await db
    .select()
    .from(briefings)
    .orderBy(desc(briefings.briefingDate))
    .limit(1);

  return result[0] || null;
}

/**
 * Get briefing for a specific date.
 */
export async function getBriefingByDate(date: Date) {
  const targetDate = new Date(date);
  targetDate.setHours(0, 0, 0, 0);

  const result = await db
    .select()
    .from(briefings)
    .where(eq(briefings.briefingDate, targetDate))
    .limit(1);

  return result[0] || null;
}
