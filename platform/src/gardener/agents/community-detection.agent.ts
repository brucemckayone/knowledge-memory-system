/**
 * Community Detection Agent (W30)
 *
 * Scheduled KARMA agent that runs Louvain community detection
 * on the entity graph. Detects clusters of related entities
 * and persists them for insight generation.
 */

import type { AgentContext, JobResult, GardenerAgent } from '../controller.js';
import { detectCommunities, persistCommunities } from '../../services/communities.js';
import { AgentError } from '../errors.js';

export const communityDetectionAgent: GardenerAgent = {
  name: 'community-detection',
  tier: 'periodic',

  async execute(context: AgentContext): Promise<JobResult> {
    const { job, log } = context;
    const payload = job.data as {
      minSize?: number;
      maxCommunities?: number;
    };

    try {
      log('Starting community detection...');

      const detected = await detectCommunities({
        minSize: payload.minSize || 2,
        maxCommunities: payload.maxCommunities || 50,
      });

      log(`Detected ${detected.length} communities`);

      if (detected.length === 0) {
        return {
          success: true,
          outputs: { communitiesDetected: 0, communitiesStored: 0 },
          metrics: { confidence: 1.0, itemsProcessed: 0 },
        };
      }

      const stored = await persistCommunities(detected);
      log(`Persisted ${stored} communities`);

      const avgSize = detected.reduce((sum, c) => sum + c.entityIds.length, 0) / detected.length;
      const avgCoherence = detected.reduce((sum, c) => sum + c.coherenceScore, 0) / detected.length;

      return {
        success: true,
        outputs: {
          communitiesDetected: detected.length,
          communitiesStored: stored,
          avgSize: Math.round(avgSize * 10) / 10,
          avgCoherence: Math.round(avgCoherence * 100) / 100,
        },
        metrics: {
          confidence: avgCoherence,
          itemsProcessed: detected.reduce((sum, c) => sum + c.entityIds.length, 0),
        },
      };
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError(`Community detection failed: ${error}`, true, error);
    }
  },
};
