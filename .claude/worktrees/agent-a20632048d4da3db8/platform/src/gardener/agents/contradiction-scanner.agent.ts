/**
 * Contradiction Scanner Agent (W33)
 *
 * Scheduled KARMA agent that scans active facts for contradictions.
 * Runs nightly, checks recent facts against their subject's existing
 * fact set, records reviews, and auto-resolves high-confidence cases.
 */

import type { AgentContext, JobResult, GardenerAgent } from '../controller.js';
import { db } from '../../db/index.js';
import { facts, contradictionReviews } from '../../db/schema.js';
import { isNull, desc, sql } from 'drizzle-orm';
import { findSupersedingFacts, expireFact } from '../../services/facts.js';
import { AgentError, MlServiceError } from '../errors.js';

const DEFAULT_BATCH_SIZE = 100;
const AUTO_RESOLVE_THRESHOLD = 0.85;

export const contradictionScannerAgent: GardenerAgent = {
  name: 'contradiction-scanner',
  tier: 'periodic',

  async execute(context: AgentContext): Promise<JobResult> {
    const { job, log, checkpoint, restoreCheckpoint } = context;
    const payload = job.data as {
      batchSize?: number;
      sinceHours?: number;
    };

    const batchSize = payload.batchSize || DEFAULT_BATCH_SIZE;
    const sinceHours = payload.sinceHours || 24;

    // Restore progress if resuming
    const state = await restoreCheckpoint() as { processedPairs?: string[] } | null;
    const processedPairs = new Set<string>(state?.processedPairs || []);

    let reviewsCreated = 0;
    let autoResolved = 0;
    let flaggedForReview = 0;

    try {
      // Get recently created active facts
      const cutoff = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
      const recentFacts = await db
        .select()
        .from(facts)
        .where(isNull(facts.expiredAt))
        .orderBy(desc(facts.createdAt))
        .limit(batchSize);

      const factsToScan = recentFacts.filter(f => f.createdAt >= cutoff);
      log(`Scanning ${factsToScan.length} facts from last ${sinceHours}h`);

      for (const fact of factsToScan) {
        // Find candidate conflicts: same subject, same predicate, still active
        const candidates = await findSupersedingFacts(
          fact.subjectEntityId,
          fact.predicate,
          fact.validAt || new Date()
        );

        for (const candidate of candidates) {
          if (candidate.id === fact.id) continue;

          // Deduplicate ordered pair
          const pairKey = [fact.id, candidate.id].sort().join(':');
          if (processedPairs.has(pairKey)) continue;
          processedPairs.add(pairKey);

          // Check via ML service
          let result;
          try {
            result = await context.services.ml.checkContradiction(
              {
                subject: fact.subjectEntityId,
                predicate: fact.predicate,
                object: fact.objectEntityId || fact.objectValue || '',
                valid_at: fact.validAt?.toISOString(),
              },
              {
                subject: candidate.subjectEntityId,
                predicate: candidate.predicate,
                object: candidate.objectEntityId || candidate.objectValue || '',
                valid_at: candidate.validAt?.toISOString(),
              }
            );
          } catch (error) {
            throw new MlServiceError(`ML contradiction check failed: ${error}`, error);
          }

          if (!result.contradicts) continue;

          // Record the review
          await db.insert(contradictionReviews).values({
            factId1: fact.id,
            factId2: candidate.id,
            contradictionType: result.type,
            resolution: result.resolution,
            confidence: result.confidence,
            reasoning: result.reasoning,
          });
          reviewsCreated++;

          // Auto-resolve high-confidence supersessions
          if (result.confidence >= AUTO_RESOLVE_THRESHOLD && result.resolution === 'supersede') {
            const newer = fact.createdAt > candidate.createdAt ? fact : candidate;
            const older = fact.createdAt > candidate.createdAt ? candidate : fact;
            await expireFact(older.id, `Auto-superseded by ${newer.id}`);

            // Mark review as resolved
            await db.execute(sql`
              UPDATE contradiction_reviews
              SET resolved_at = NOW(), resolved_by = 'contradiction-scanner'
              WHERE fact_id_1 = ${fact.id} AND fact_id_2 = ${candidate.id}
                AND resolved_at IS NULL
            `);

            autoResolved++;
            log(`Auto-superseded fact ${older.id.slice(0, 8)} (conf: ${result.confidence.toFixed(2)})`);
          } else {
            flaggedForReview++;
          }
        }

        // Checkpoint periodically
        if (processedPairs.size % 20 === 0) {
          await checkpoint({ processedPairs: Array.from(processedPairs) });
        }
      }

      log(`Reviews: ${reviewsCreated}, Auto-resolved: ${autoResolved}, Flagged: ${flaggedForReview}`);

      return {
        success: true,
        outputs: { reviewsCreated, autoResolved, flaggedForReview, factsScanned: factsToScan.length },
        metrics: {
          confidence: 0.9,
          itemsProcessed: factsToScan.length,
        },
      };
    } catch (error) {
      await checkpoint({ processedPairs: Array.from(processedPairs) });
      if (error instanceof AgentError) throw error;
      throw new AgentError(`Contradiction scan failed: ${error}`, true, error);
    }
  },
};
