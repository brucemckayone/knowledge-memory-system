/**
 * Relationship Agent (W26)
 *
 * KARMA agent that extracts relationships between entities and creates facts.
 * Builds the knowledge graph edges from memory content.
 */

import type { AgentContext, JobResult, GardenerAgent, GardenerJob } from '../controller.js';
import { config } from '../../config.js';
import { createFact } from '../../services/facts.js';
import { normalizePredicate, recordPredicateUsage } from '../../services/predicates.js';
import { getMemoryEntities } from '../../services/entities.js';

interface RelationshipPayload {
  memoryId: string;
  content?: string;
  entities?: Array<{ id: string; name: string; type: string }>;
}

interface ExtractedRelationship {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  temporal_hint?: string;
  source_text?: string;
}

export const relationshipAgent: GardenerAgent = {
  name: 'relationships',
  tier: 'frequent',

  async execute(context: AgentContext): Promise<JobResult> {
    const { job, log } = context;
    const payload = job.data as RelationshipPayload;

    if (!payload.memoryId) {
      log('Missing required field: memoryId', 'error');
      return { success: false };
    }

    log(`Extracting relationships from memory ${payload.memoryId.slice(0, 8)}...`);

    try {
      // Get entities linked to this memory (from entity extraction agent)
      let entities = payload.entities;
      if (!entities || entities.length === 0) {
        const linkedEntities = await getMemoryEntities(payload.memoryId);
        entities = linkedEntities.map(e => ({
          id: e.id,
          name: e.canonicalName,
          type: e.entityType,
        }));
      }

      if (entities.length < 2) {
        log('Not enough entities for relationship extraction');
        return {
          success: true,
          metrics: { confidence: 1.0, itemsProcessed: 0 },
        };
      }

      // Get content if not provided
      let content = payload.content;
      if (!content) {
        content = await fetchMemoryContent(payload.memoryId);
      }

      if (!content) {
        log('No content found', 'warn');
        return {
          success: true,
          metrics: { confidence: 0.5, itemsProcessed: 0 },
        };
      }

      // Call ML service for relationship extraction
      const relationships = await extractRelationships(content, entities);

      log(`Found ${relationships.length} relationships`);

      if (relationships.length === 0) {
        return {
          success: true,
          metrics: { confidence: 0.8, itemsProcessed: 0 },
        };
      }

      // Create facts for each relationship
      let factsCreated = 0;
      let skipped = 0;
      const nextJobs: GardenerJob[] = [];

      for (const rel of relationships) {
        try {
          // Resolve subject and object to entity IDs
          const subjectEntity = entities.find(
            e => e.name.toLowerCase() === rel.subject.toLowerCase()
          );
          const objectEntity = entities.find(
            e => e.name.toLowerCase() === rel.object.toLowerCase()
          );

          if (!subjectEntity) {
            log(`Subject "${rel.subject}" not found in entities, skipping`, 'warn');
            skipped++;
            continue;
          }

          // Normalize predicate to canonical form
          const normalizedPredicate = normalizePredicate(rel.predicate);

          // Determine validity based on temporal hint
          const validAt = getValidAt(rel.temporal_hint);
          const invalidAt = rel.temporal_hint === 'past' ? new Date() : undefined;

          // Create the fact
          const factId = await createFact({
            subjectEntityId: subjectEntity.id,
            predicate: normalizedPredicate,
            objectEntityId: objectEntity?.id,
            objectValue: objectEntity ? undefined : rel.object,
            validAt,
            invalidAt,
            sourceMemoryId: payload.memoryId,
            sourceText: rel.source_text,
            extractionMethod: 'relationship_agent',
            confidence: rel.confidence,
          });

          // Record predicate usage
          await recordPredicateUsage(normalizedPredicate);

          factsCreated++;

          // Queue conflict resolution for new facts
          nextJobs.push({
            type: 'gardener:resolve-conflicts',
            tier: 'periodic',
            payload: {
              factId,
              checkRecent: true,
            },
          });

        } catch (error) {
          log(`Failed to create fact for ${rel.subject} ${rel.predicate} ${rel.object}: ${error}`, 'warn');
          skipped++;
        }
      }

      log(`Created ${factsCreated} facts, skipped ${skipped}`);

      return {
        success: true,
        outputs: {
          relationshipsFound: relationships.length,
          factsCreated,
          skipped,
        },
        nextJobs: nextJobs.length > 0 ? nextJobs : undefined,
        metrics: {
          confidence: factsCreated > 0 ? 0.85 : 0.6,
          itemsProcessed: factsCreated,
        },
      };

    } catch (error) {
      log(`Relationship extraction failed: ${error}`, 'error');
      return { success: false };
    }
  },
};

/**
 * Call ML service for relationship extraction
 */
async function extractRelationships(
  content: string,
  entities: Array<{ name: string; type: string }>
): Promise<ExtractedRelationship[]> {
  try {
    const response = await fetch(`${config.ML_SERVICES_URL}/extract-relationships`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        entities: entities.map(e => ({ name: e.name, type: e.type })),
      }),
    });

    if (!response.ok) {
      console.warn(`Relationship extraction returned ${response.status}`);
      return [];
    }

    const data = await response.json() as {
      relationships?: ExtractedRelationship[];
    };

    return data.relationships || [];

  } catch (error) {
    console.warn('Relationship extraction failed:', error);
    return [];
  }
}

/**
 * Get valid_at date based on temporal hint
 */
function getValidAt(temporalHint?: string): Date {
  switch (temporalHint) {
    case 'past':
      // Past events - default to a year ago
      const pastDate = new Date();
      pastDate.setFullYear(pastDate.getFullYear() - 1);
      return pastDate;
    case 'future':
      // Future events - default to a month from now
      const futureDate = new Date();
      futureDate.setMonth(futureDate.getMonth() + 1);
      return futureDate;
    case 'current':
    case 'unknown':
    default:
      return new Date();
  }
}

/**
 * Fetch memory content from Qdrant
 */
async function fetchMemoryContent(memoryId: string): Promise<string> {
  try {
    const response = await fetch(`${config.QDRANT_URL}/collections/memories/points/${memoryId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      return '';
    }

    const data = await response.json() as {
      result?: { payload?: { content?: string } };
    };

    return data.result?.payload?.content || '';

  } catch (error) {
    console.warn('Failed to fetch from Qdrant:', error);
    return '';
  }
}
