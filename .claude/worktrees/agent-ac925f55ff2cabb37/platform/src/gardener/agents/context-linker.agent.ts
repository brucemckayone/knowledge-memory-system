/**
 * Context-Linker Agent
 *
 * KARMA agent that processes expired ingestion sessions to detect meaningful
 * relationships between temporally-close items from the same user.
 *
 * For each qualifying session (2+ members):
 * - Computes entity overlap from memory_entities
 * - Generates a context summary via LLM
 * - Re-embeds each member with the context prepended
 * - Cross-links members in Qdrant (related_to payload)
 * - Propagates shared tags across members
 * - Creates CO_TEMPORAL knowledge graph edges
 */

import type { AgentContext, JobResult, GardenerAgent, GardenerJob } from '../controller.js';
import { AgentError } from '../errors.js';
import {
  getExpiredSessions,
  getExpiredSingleMemberSessions,
  getSessionMembers,
  closeSession,
} from '../../services/ingestion-context.js';
import { getMemory, updateVector, updatePayload } from '../../services/qdrant.js';
import { getMemoryEntities } from '../../services/entities.js';
import { createFact } from '../../services/facts.js';
import { ml } from '../../services/ml-client.js';
import { config } from '../../config.js';

export const contextLinkerAgent: GardenerAgent = {
  name: 'context-linker',
  tier: 'frequent',

  async execute(context: AgentContext): Promise<JobResult> {
    const { log } = context;
    const windowMinutes = config.INGESTION_SESSION_WINDOW_MINUTES;

    log('Scanning for expired ingestion sessions...');

    try {
      // Close single-member sessions immediately — no enrichment needed
      const singleMemberIds = await getExpiredSingleMemberSessions(windowMinutes);
      for (const sessionId of singleMemberIds) {
        await closeSession(sessionId);
      }
      if (singleMemberIds.length > 0) {
        log(`Closed ${singleMemberIds.length} single-member sessions`);
      }

      // Find multi-member sessions ready for processing
      const sessions = await getExpiredSessions(windowMinutes);

      if (sessions.length === 0) {
        log('No qualifying sessions to process');
        return {
          success: true,
          metrics: { confidence: 1.0, itemsProcessed: 0 },
        };
      }

      log(`Found ${sessions.length} sessions to process`);

      let totalLinked = 0;
      let totalFacts = 0;
      const allCreatedFactIds: string[] = [];

      for (const session of sessions) {
        try {
          const result = await processSession(session.id, session.memberCount, log);
          totalLinked += result.linked;
          totalFacts += result.facts;
          allCreatedFactIds.push(...result.factIds);
        } catch (error) {
          log(`Failed to process session ${session.id.slice(0, 8)}: ${error}`, 'warn');
          // Close the session anyway to avoid reprocessing
          await closeSession(session.id);
        }
      }

      log(`Processed ${sessions.length} sessions: ${totalLinked} items linked, ${totalFacts} facts created`);

      // Chain to conflict-resolution if we created any facts
      const nextJobs: GardenerJob[] = [];
      if (allCreatedFactIds.length > 0) {
        nextJobs.push({
          type: 'gardener:resolve-conflicts',
          tier: 'periodic',
          payload: { factIds: allCreatedFactIds, checkRecent: true },
        });
      }

      return {
        success: true,
        nextJobs: nextJobs.length > 0 ? nextJobs : undefined,
        outputs: {
          sessionsProcessed: sessions.length,
          singleMemberClosed: singleMemberIds.length,
          itemsLinked: totalLinked,
          factsCreated: totalFacts,
        },
        metrics: {
          confidence: totalLinked > 0 ? 0.85 : 0.6,
          itemsProcessed: totalLinked,
        },
      };
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError(`Context-linker failed: ${error}`, true, error);
    }
  },
};

interface ProcessResult {
  linked: number;
  facts: number;
  factIds: string[];
}

async function processSession(
  sessionId: string,
  _memberCount: number,
  log: (msg: string, level?: 'info' | 'warn' | 'error') => void,
): Promise<ProcessResult> {
  const members = await getSessionMembers(sessionId);

  if (members.length < 2) {
    await closeSession(sessionId);
    return { linked: 0, facts: 0, factIds: [] };
  }

  log(`Processing session ${sessionId.slice(0, 8)} with ${members.length} members`);

  // Fetch content from Qdrant for each member
  const memberContents: Array<{
    memoryId: string;
    content: string;
    platform: string;
    rawType: string;
    tags: string[];
  }> = [];

  for (const member of members) {
    const memory = await getMemory(member.memoryId);
    if (memory?.payload) {
      memberContents.push({
        memoryId: member.memoryId,
        content: (memory.payload.content as string) || member.contentPreview || '',
        platform: member.platform,
        rawType: member.rawType,
        tags: (memory.payload.tags as string[]) || [],
      });
    }
  }

  if (memberContents.length < 2) {
    await closeSession(sessionId);
    return { linked: 0, facts: 0, factIds: [] };
  }

  // Compute entity overlap across members
  const entityCountMap = new Map<string, { id: string; name: string; count: number }>();
  for (const member of memberContents) {
    const entities = await getMemoryEntities(member.memoryId);
    for (const entity of entities) {
      const existing = entityCountMap.get(entity.id);
      if (existing) {
        existing.count++;
      } else {
        entityCountMap.set(entity.id, { id: entity.id, name: entity.canonicalName, count: 1 });
      }
    }
  }

  const sharedEntities = Array.from(entityCountMap.values())
    .filter(e => e.count > 1);
  const sharedEntityIds = sharedEntities.map(e => e.id);

  // Generate context summary via LLM
  const itemDescriptions = memberContents
    .map((m, i) => `[Item ${i + 1} (${m.rawType}/${m.platform}): ${m.content.slice(0, 300)}]`)
    .join('\n');

  const sharedEntityNames = sharedEntities.map(e => e.name);

  const summaryPrompt =
    `These items were captured within a 15-minute window by the same person.` +
    (sharedEntityNames.length > 0 ? ` They share these entities: ${sharedEntityNames.join(', ')}.` : '') +
    `\nSummarize what connects them in 1-2 sentences:\n${itemDescriptions}`;

  let contextSummary = '';
  try {
    const chatResult = await ml.chat(
      summaryPrompt,
      'You are a concise analyst. Output only the connecting summary, no preamble.',
    );
    contextSummary = chatResult.response.trim();
  } catch (error) {
    log(`LLM summary failed, using fallback: ${error}`, 'warn');
    contextSummary = sharedEntityNames.length > 0
      ? `Items share context around: ${sharedEntityNames.join(', ')}`
      : 'Items captured in the same time window';
  }

  // Collect all member IDs and shared tags
  const allMemoryIds = memberContents.map(m => m.memoryId);
  const allTags = new Set<string>();
  for (const m of memberContents) {
    for (const tag of m.tags) {
      allTags.add(tag);
    }
  }
  const sharedTags = Array.from(allTags);

  // Re-embed each member with context prepended and update Qdrant
  for (const member of memberContents) {
    const contextualText = `[Context: ${contextSummary}] ${member.content}`;

    try {
      const embedResult = await ml.embed(contextualText);

      // Update vector with enriched embedding
      await updateVector(member.memoryId, embedResult.vector);

      // Update payload with cross-links
      const relatedTo = allMemoryIds.filter(id => id !== member.memoryId);
      await updatePayload(member.memoryId, {
        related_to: relatedTo,
        ingestion_session_id: sessionId,
        tags: sharedTags,
        context_summary: contextSummary,
      });
    } catch (error) {
      log(`Failed to re-embed member ${member.memoryId.slice(0, 8)}: ${error}`, 'warn');
    }
  }

  // Create CO_TEMPORAL facts for each pair of members
  let factsCreated = 0;
  const createdFactIds: string[] = [];

  // We need entities linked to each memory to create facts
  // Only create facts if there are shared entities to act as subjects/objects
  const primarySharedEntity = sharedEntities[0];
  if (primarySharedEntity) {
    for (let i = 0; i < allMemoryIds.length; i++) {
      for (let j = i + 1; j < allMemoryIds.length; j++) {
        const memIdI = allMemoryIds[i];
        const memIdJ = allMemoryIds[j];
        if (!memIdI || !memIdJ) continue;
        try {
          const factId = await createFact({
            subjectEntityId: primarySharedEntity.id,
            predicate: 'CO_TEMPORAL',
            objectValue: `Mentioned in items ${memIdI.slice(0, 8)} and ${memIdJ.slice(0, 8)} within the same session`,
            sourceMemoryId: memIdI,
            sourceText: contextSummary,
            extractionMethod: 'context_linker_agent',
            confidence: 0.8,
          });
          factsCreated++;
          createdFactIds.push(factId);
        } catch (error) {
          log(`Failed to create CO_TEMPORAL fact: ${error}`, 'warn');
        }
      }
    }
  }

  // Close session with computed aggregates
  await closeSession(sessionId, contextSummary, sharedEntityIds, sharedTags);

  log(`Session ${sessionId.slice(0, 8)}: linked ${memberContents.length} items, ${factsCreated} facts, summary: "${contextSummary.slice(0, 80)}..."`);

  return { linked: memberContents.length, facts: factsCreated, factIds: createdFactIds };
}
