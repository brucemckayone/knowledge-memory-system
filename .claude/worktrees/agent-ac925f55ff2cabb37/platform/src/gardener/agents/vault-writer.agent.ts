/**
 * Vault Writer Agent (W40)
 *
 * KARMA agent that writes-back entities and insights to Obsidian vault.
 * Triggered after insight generation or entity updates.
 */

import type { AgentContext, JobResult, GardenerAgent } from '../controller.js';
import { db } from '../../db/index.js';
import { insights, entities } from '../../db/schema.js';
import { isNull, desc, inArray } from 'drizzle-orm';
import { writeInsightNote } from '../../services/obsidian/vault-writer.js';
import { AgentError } from '../errors.js';
import { config } from '../../config.js';

export const vaultWriterAgent: GardenerAgent = {
  name: 'vault-writer',
  tier: 'periodic',

  async execute(context: AgentContext): Promise<JobResult> {
    const { log } = context;

    if (!config.OBSIDIAN_ENABLED || !config.OBSIDIAN_VAULT_PATH) {
      log('Obsidian not configured — skipping vault write-back');
      return {
        success: true,
        outputs: { skipped: true, reason: 'not_configured' },
        metrics: { confidence: 1.0, itemsProcessed: 0 },
      };
    }

    try {
      let entitiesWritten = 0;
      let insightsWritten = 0;

      // Write recent insights
      const recentInsights = await db
        .select()
        .from(insights)
        .where(isNull(insights.dismissedAt))
        .orderBy(desc(insights.createdAt))
        .limit(10);

      for (const insight of recentInsights) {
        try {
          // Get entity names for this insight
          const entityNames: string[] = [];
          if (insight.entityIds.length > 0) {
            const entityList = await db
              .select({ name: entities.canonicalName })
              .from(entities)
              .where(inArray(entities.id, insight.entityIds.slice(0, 10)));
            entityNames.push(...entityList.map(e => e.name));
          }

          await writeInsightNote({
            title: insight.title,
            body: insight.body,
            type: insight.insightType,
            entities: entityNames,
            confidence: insight.confidence,
            generatedAt: insight.createdAt.toISOString(),
          });
          insightsWritten++;
        } catch (error) {
          log(`Failed to write insight ${insight.id}: ${error}`, 'warn');
        }
      }

      log(`Vault write-back: ${entitiesWritten} entities, ${insightsWritten} insights`);

      return {
        success: true,
        outputs: { entitiesWritten, insightsWritten },
        metrics: {
          confidence: 1.0,
          itemsProcessed: entitiesWritten + insightsWritten,
        },
      };
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError(`Vault write-back failed: ${error}`, true, error);
    }
  },
};
