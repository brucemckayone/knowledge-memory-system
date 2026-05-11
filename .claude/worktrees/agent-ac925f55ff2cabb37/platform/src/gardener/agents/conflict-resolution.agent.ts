/**
 * Conflict Resolution Agent
 *
 * KARMA agent that detects and resolves contradictions between facts.
 * Implements ALICE framework for supersession and expiration.
 */

import type { AgentContext, JobResult, GardenerAgent } from '../controller.js';
import { checkContradiction } from '../../services/ml.js';
import {
  findSupersedingFacts,
  expireFact,
  invalidateFact,
} from '../../services/facts.js';
import { db } from '../../db/index.js';
import { facts, type Fact } from '../../db/schema.js';
import { isNull, eq, inArray } from 'drizzle-orm';
import { AgentError } from '../errors.js';

interface FactSummary {
  id: string;
  subjectEntityId: string;
  predicate: string;
  objectEntityId?: string;
  objectValue?: string;
  validAt?: Date;
}

interface ConflictResult {
  contradicts: boolean;
  type: string;
  resolution: 'supersede' | 'invalidate' | 'coexist' | 'flag';
  confidence: number;
  reasoning: string;
}

export const conflictResolutionAgent: GardenerAgent = {
  name: 'resolve-conflicts',
  tier: 'periodic',

  async execute(context: AgentContext): Promise<JobResult> {
    const { job, log, checkpoint, restoreCheckpoint } = context;
    const payload = job.data as {
      factId?: string;
      factIds?: string[];
      factSummaries?: FactSummary[];
      checkAll?: boolean;
      checkRecent?: boolean;
      batchSize?: number;
    };

    // Restore checkpoint if resuming
    const state = await restoreCheckpoint() as { processedIds?: string[] } | null;
    const processedIds = new Set<string>(state?.processedIds || []);

    let conflictsFound = 0;
    let superseded = 0;
    let flagged = 0;

    try {
      // Get facts to check
      let factsToCheck: Fact[];

      if (payload.factIds && payload.factIds.length > 0) {
        // Batch mode: use pre-fetched summaries if available, else fetch from DB
        if (payload.factSummaries && payload.factSummaries.length > 0) {
          // Fetch full facts only for IDs that need them (summaries don't have createdAt etc.)
          factsToCheck = await db
            .select()
            .from(facts)
            .where(inArray(facts.id, payload.factIds));
        } else {
          factsToCheck = [];
          for (const fid of payload.factIds) {
            const result = await db
              .select()
              .from(facts)
              .where(eq(facts.id, fid))
              .limit(1);
            if (result.length > 0) {
              factsToCheck.push(result[0]!);
            }
          }
        }
      } else if (payload.factId) {
        // Check single fact
        const result = await db
          .select()
          .from(facts)
          .where(eq(facts.id, payload.factId))
          .limit(1);
        factsToCheck = result;
      } else {
        // Check recent active facts
        const batchSize = payload.batchSize || 50;
        factsToCheck = await db
          .select()
          .from(facts)
          .where(isNull(facts.expiredAt))
          .orderBy(facts.createdAt)
          .limit(batchSize);
      }

      log(`Checking ${factsToCheck.length} facts for conflicts`);

      for (const fact of factsToCheck) {
        if (processedIds.has(fact.id)) continue;

        // Find potentially conflicting facts
        const candidates = await findSupersedingFacts(
          fact.subjectEntityId,
          fact.predicate,
          fact.validAt || new Date()
        );

        // Check each candidate pair
        for (const candidate of candidates) {
          if (candidate.id === fact.id) continue;

          // Check contradiction via ML service
          const conflict = await checkConflict(fact, candidate);

          if (conflict.contradicts) {
            conflictsFound++;

            switch (conflict.resolution) {
              case 'supersede':
                // Newer fact supersedes older
                const newer = fact.createdAt > candidate.createdAt ? fact : candidate;
                const older = fact.createdAt > candidate.createdAt ? candidate : fact;

                // Expire the older fact
                await expireFact(older.id, `Superseded by fact ${newer.id}`);

                // Invalidate at the time the new fact became valid
                if (newer.validAt) {
                  await invalidateFact(older.id, newer.validAt);
                }

                superseded++;
                log(`Superseded fact ${older.id.slice(0,8)} with ${newer.id.slice(0,8)}`);
                break;

              case 'invalidate':
                // Mark one as wrong
                await expireFact(candidate.id, 'Invalidated due to conflict');
                superseded++;
                break;

              case 'flag':
                // Flag for human review (store in a review queue)
                flagged++;
                log(`Flagged conflict between ${fact.id.slice(0,8)} and ${candidate.id.slice(0,8)}`, 'warn');
                break;

              case 'coexist':
                // No action needed
                break;
            }
          }
        }

        processedIds.add(fact.id);

        // Checkpoint every 10 facts
        if (processedIds.size % 10 === 0) {
          await checkpoint({ processedIds: Array.from(processedIds) });
        }
      }

      log(`Conflicts: ${conflictsFound}, Superseded: ${superseded}, Flagged: ${flagged}`);

      return {
        success: true,
        outputs: {
          conflictsFound,
          superseded,
          flagged,
        },
        metrics: {
          confidence: 0.9,
          itemsProcessed: processedIds.size,
        },
      };

    } catch (error) {
      // Save checkpoint on failure so we can resume
      await checkpoint({ processedIds: Array.from(processedIds) });

      if (error instanceof AgentError) throw error;
      throw new AgentError(`Conflict resolution failed: ${error}`, true, error);
    }
  },
};

/**
 * Check if two facts contradict via ML service
 */
async function checkConflict(fact1: Fact, fact2: Fact): Promise<ConflictResult> {
  try {
    const result = await checkContradiction(
      {
        subject: fact1.subjectEntityId,
        predicate: fact1.predicate,
        object: fact1.objectEntityId || fact1.objectValue || '',
        valid_at: fact1.validAt?.toISOString(),
        invalid_at: fact1.invalidAt?.toISOString(),
      },
      {
        subject: fact2.subjectEntityId,
        predicate: fact2.predicate,
        object: fact2.objectEntityId || fact2.objectValue || '',
        valid_at: fact2.validAt?.toISOString(),
        invalid_at: fact2.invalidAt?.toISOString(),
      }
    );

    // Map response to internal ConflictResult if needed, or use as is
    // The ML service returns CheckContradictionResponse which matches ConflictResult structure closely
    return result as unknown as ConflictResult;

  } catch {
    return {
      contradicts: false,
      type: 'none',
      resolution: 'coexist',
      confidence: 0.5,
      reasoning: 'Error checking contradiction',
    };
  }
}
