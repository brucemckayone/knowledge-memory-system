/**
 * Insight Generation Agent (W31)
 *
 * Scheduled KARMA agent that generates insights from community analysis.
 * Runs nightly at 2AM after community detection completes.
 */

import type { AgentContext, JobResult, GardenerAgent } from '../controller.js';
import { generateInsights, persistInsights } from '../../services/insights.js';
import { AgentError } from '../errors.js';

export const insightGenerationAgent: GardenerAgent = {
  name: 'generate-insights',
  tier: 'periodic',

  async execute(context: AgentContext): Promise<JobResult> {
    const { job, log } = context;
    const payload = job.data as {
      maxPerCommunity?: number;
    };

    try {
      log('Starting insight generation from community analysis...');

      const generated = await generateInsights({
        maxPerCommunity: payload.maxPerCommunity || 3,
      });

      if (generated.length === 0) {
        log('No insights generated (no communities or too few entities)');
        return {
          success: true,
          outputs: { insightsGenerated: 0, insightsStored: 0 },
          metrics: { confidence: 1.0, itemsProcessed: 0 },
        };
      }

      const stored = await persistInsights(generated);
      log(`Generated ${generated.length} insights, stored ${stored}`);

      const avgConfidence = generated.reduce((s, i) => s + i.confidence, 0) / generated.length;

      return {
        success: true,
        outputs: { insightsGenerated: generated.length, insightsStored: stored },
        metrics: {
          confidence: avgConfidence,
          itemsProcessed: generated.length,
        },
      };
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError(`Insight generation failed: ${error}`, true, error);
    }
  },
};
