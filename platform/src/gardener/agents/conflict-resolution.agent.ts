/**
 * Conflict Resolution Agent
 * 
 * KARMA agent that detects and resolves contradictions between facts.
 * Implements ALICE framework for supersession and expiration.
 */

import type { AgentContext, JobResult, GardenerAgent } from '../controller.js';
import { config } from '../../config.js';
import { 
  findSupersedingFacts, 
  expireFact, 
  invalidateFact,
  type Fact 
} from '../../services/facts.js';
import { db } from '../../db/index.js';
import { facts } from '../../db/schema.js';
import { isNull, and, eq } from 'drizzle-orm';

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
      checkAll?: boolean;
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
      
      if (payload.factId) {
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
          const conflict = await checkContradiction(fact, candidate);
          
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
      log(`Conflict resolution failed: ${error}`, 'error');
      
      // Save checkpoint on failure
      await checkpoint({ processedIds: Array.from(processedIds) });
      
      return { success: false };
    }
  },
};

/**
 * Check if two facts contradict via ML service
 */
async function checkContradiction(fact1: Fact, fact2: Fact): Promise<ConflictResult> {
  try {
    const response = await fetch(`${config.ML_SERVICES_URL}/check-contradiction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fact1: {
          subject: fact1.subjectEntityId,
          predicate: fact1.predicate,
          object: fact1.objectEntityId || fact1.objectValue || '',
          valid_at: fact1.validAt?.toISOString(),
          invalid_at: fact1.invalidAt?.toISOString(),
        },
        fact2: {
          subject: fact2.subjectEntityId,
          predicate: fact2.predicate,
          object: fact2.objectEntityId || fact2.objectValue || '',
          valid_at: fact2.validAt?.toISOString(),
          invalid_at: fact2.invalidAt?.toISOString(),
        },
      }),
    });

    if (!response.ok) {
      return {
        contradicts: false,
        type: 'none',
        resolution: 'coexist',
        confidence: 0.5,
        reasoning: 'ML service unavailable',
      };
    }

    return await response.json() as ConflictResult;

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
