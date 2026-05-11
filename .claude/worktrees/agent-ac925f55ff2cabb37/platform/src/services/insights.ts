/**
 * Insight Generation Service (W31)
 *
 * Generates insights from community analysis and entity patterns.
 * Uses LLM to synthesize connections across entity clusters.
 */

import { db } from '../db/index.js';
import { insights, entities } from '../db/schema.js';
import { eq, isNull, inArray, desc } from 'drizzle-orm';
import { ml } from './ml-client.js';
import { getActiveCommunities } from './communities.js';

export interface GeneratedInsight {
  communityId: string;
  insightType: string;
  title: string;
  body: string;
  entityIds: string[];
  confidence: number;
}

/**
 * Generate insights from detected communities.
 */
export async function generateInsights(
  options: { maxPerCommunity?: number } = {}
): Promise<GeneratedInsight[]> {
  const { maxPerCommunity = 3 } = options;
  const activeCommunities = await getActiveCommunities();
  const generated: GeneratedInsight[] = [];

  for (const community of activeCommunities) {
    if (community.size < 2) continue;

    // Get entity names for this community
    const entityList = community.entityIds.length > 0
      ? await db
          .select({ id: entities.id, name: entities.canonicalName, type: entities.entityType })
          .from(entities)
          .where(inArray(entities.id, community.entityIds.slice(0, 20)))
      : [];

    if (entityList.length < 2) continue;

    const entitySummary = entityList.map(e => `${e.name} (${e.type})`).join(', ');

    try {
      const prompt = `You are analyzing a cluster of related entities in a personal knowledge graph.

Entities in this cluster: ${entitySummary}

Generate 1-${maxPerCommunity} insights about this cluster. Each insight should reveal a non-obvious connection, pattern, or actionable observation.

Return JSON:
{"insights": [{"type": "connection|pattern|action|trend", "title": "...", "body": "...", "confidence": 0.0-1.0}]}`;

      const result = await ml.chat(prompt, 'You are an insight generation engine. Return only valid JSON.');

      let parsed;
      try {
        parsed = JSON.parse(result.response);
      } catch {
        continue;
      }

      const insightList = parsed.insights || [];
      for (const insight of insightList.slice(0, maxPerCommunity)) {
        generated.push({
          communityId: community.id,
          insightType: insight.type || 'connection',
          title: insight.title || 'Untitled insight',
          body: insight.body || '',
          entityIds: community.entityIds,
          confidence: insight.confidence || 0.5,
        });
      }
    } catch (error) {
      console.warn(`Failed to generate insights for community ${community.id}:`, error);
    }
  }

  return generated;
}

/**
 * Persist generated insights.
 */
export async function persistInsights(generated: GeneratedInsight[]): Promise<number> {
  let stored = 0;
  for (const insight of generated) {
    await db.insert(insights).values({
      communityId: insight.communityId,
      insightType: insight.insightType,
      title: insight.title,
      body: insight.body,
      entityIds: insight.entityIds,
      confidence: insight.confidence,
      relevanceScore: insight.confidence,
    });
    stored++;
  }
  return stored;
}

/**
 * Get active (non-dismissed) insights, newest first.
 */
export async function getActiveInsights(limit = 20) {
  return db
    .select()
    .from(insights)
    .where(isNull(insights.dismissedAt))
    .orderBy(desc(insights.createdAt))
    .limit(limit);
}

/**
 * Dismiss an insight.
 */
export async function dismissInsight(insightId: string): Promise<void> {
  await db
    .update(insights)
    .set({ dismissedAt: new Date() })
    .where(eq(insights.id, insightId));
}
