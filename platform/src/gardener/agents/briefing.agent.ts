/**
 * Briefing Agent (W32)
 *
 * Scheduled KARMA agent that generates the daily morning briefing.
 * Runs at 6AM daily.
 */

import type { AgentContext, JobResult, GardenerAgent } from '../controller.js';
import { generateBriefing, persistBriefing } from '../../services/briefing.js';
import { AgentError } from '../errors.js';

export const briefingAgent: GardenerAgent = {
  name: 'briefing',
  tier: 'periodic',

  async execute(context: AgentContext): Promise<JobResult> {
    const { log } = context;

    try {
      log('Generating morning briefing...');

      const briefing = await generateBriefing();
      const briefingId = await persistBriefing(briefing);

      log(`Briefing generated: ${briefing.taskCount} tasks, ${briefing.insightCount} insights`);

      return {
        success: true,
        outputs: {
          briefingId,
          taskCount: briefing.taskCount,
          insightCount: briefing.insightCount,
          sectionCount: briefing.sections.length,
        },
        metrics: {
          confidence: 1.0,
          itemsProcessed: briefing.taskCount + briefing.insightCount,
        },
      };
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError(`Briefing generation failed: ${error}`, true, error);
    }
  },
};
