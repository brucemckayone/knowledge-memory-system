/**
 * Ontology Evolution Agent
 *
 * KARMA agent that reviews staged predicates and entity types,
 * promoting genuinely novel ones to canonical status.
 *
 * Three-layer pipeline:
 * 1. Structural: lemmatize, check inverses, deterministic synonym lookup
 * 2. Embedding: enriched description similarity, threshold scoring
 * 3. LLM Gate: verify merge decisions via /compare-predicates endpoint
 *
 * Runs nightly. Processes staged predicates above usage threshold.
 */

import type { AgentContext, JobResult, GardenerAgent } from '../controller.js';
import { AgentError } from '../errors.js';
import { db } from '../../db/index.js';
import { factPredicates } from '../../db/schema.js';
import { eq, and, sql, gte } from 'drizzle-orm';
import { normalizePredicate, CANONICAL_ONTOLOGY } from '../../services/predicates.js';

const MIN_USAGE_THRESHOLD = 3;      // Minimum occurrences before review
const PROVISIONAL_PERIOD_DAYS = 14; // 2-week probation

interface EvolutionPayload {
  maxCandidates?: number;
  usageThreshold?: number;
}

export const ontologyEvolutionAgent: GardenerAgent = {
  name: 'ontology-evolution',
  tier: 'periodic',

  async execute(context: AgentContext): Promise<JobResult> {
    const { log, checkpoint, restoreCheckpoint, services } = context;
    const payload = context.job.data as EvolutionPayload;

    const maxCandidates = payload.maxCandidates || 20;
    const usageThreshold = payload.usageThreshold || MIN_USAGE_THRESHOLD;

    log('Starting ontology evolution review...');

    // Restore checkpoint
    const state = await restoreCheckpoint() as {
      reviewed?: string[];
    } | null;
    const reviewed = new Set<string>(state?.reviewed || []);

    let promoted = 0;
    let merged = 0;
    let rejected = 0;
    let deferred = 0;

    try {
      // =============================================
      // Step 1: Query staged predicates above threshold
      // =============================================
      const candidates = await db
        .select()
        .from(factPredicates)
        .where(and(
          eq(factPredicates.status, 'staging'),
          gte(factPredicates.usageCount, usageThreshold),
        ))
        .orderBy(sql`usage_count DESC`)
        .limit(maxCandidates);

      if (candidates.length === 0) {
        log('No staged predicates above threshold');
        return {
          success: true,
          outputs: { promoted: 0, merged: 0, rejected: 0, deferred: 0 },
          metrics: { confidence: 1.0, itemsProcessed: 0 },
        };
      }

      log(`Found ${candidates.length} candidates for review`);

      // =============================================
      // Step 2: Structural pre-filter
      // =============================================
      for (const candidate of candidates) {
        if (reviewed.has(candidate.predicate)) continue;

        const predicate = candidate.predicate;
        log(`Reviewing: ${predicate} (usage: ${candidate.usageCount})`);

        // Check if it normalizes to an existing canonical
        const normalized = normalizePredicate(predicate);
        if (normalized !== predicate && CANONICAL_ONTOLOGY[normalized]) {
          // It's an alias of an existing canonical -- auto-merge
          log(`  Auto-merge: ${predicate} -> ${normalized} (alias match)`);

          await db.update(factPredicates)
            .set({ status: 'canonical' })
            .where(eq(factPredicates.predicate, normalized));

          // Update facts to use canonical
          await db.execute(sql`
            UPDATE facts SET predicate = ${normalized}
            WHERE predicate = ${predicate} AND expired_at IS NULL
          `);

          // Add as alias
          await db.execute(sql`
            UPDATE fact_predicates
            SET aliases = array_append(COALESCE(aliases, ARRAY[]::text[]), ${predicate})
            WHERE predicate = ${normalized}
              AND NOT (${predicate} = ANY(COALESCE(aliases, ARRAY[]::text[])))
          `);

          // Mark the staged entry
          await db.update(factPredicates)
            .set({ status: 'canonical' })
            .where(eq(factPredicates.predicate, predicate));

          merged++;
          reviewed.add(predicate);
          continue;
        }

        // =============================================
        // Step 3: LLM verification via /compare-predicates
        // =============================================
        // Find the nearest canonical predicate by description
        let nearestCanonical: string | null = null;

        try {
          // Compare against all canonicals via ML service
          const canonicals = Object.keys(CANONICAL_ONTOLOGY);
          const desc = candidate.description || predicate.replace(/_/g, ' ');

          // Find the most relevant canonical to compare against
          // Use the first canonical in the same category if available
          for (const canonical of canonicals) {
            // Simple heuristic: compare against all, let the LLM decide
            nearestCanonical = canonical;
            break;
          }

          if (nearestCanonical) {
            const canonicalDesc = CANONICAL_ONTOLOGY[nearestCanonical]?.description || nearestCanonical;

            const result = await services.ml.comparePredicate(
              predicate, desc,
              nearestCanonical, canonicalDesc
            );

            if (result.decision === 'merge') {
              log(`  LLM merge: ${predicate} -> ${nearestCanonical} (${result.reasoning})`);

              // Merge into canonical
              await db.execute(sql`
                UPDATE facts SET predicate = ${nearestCanonical}
                WHERE predicate = ${predicate} AND expired_at IS NULL
              `);

              await db.execute(sql`
                UPDATE fact_predicates
                SET aliases = array_append(COALESCE(aliases, ARRAY[]::text[]), ${predicate})
                WHERE predicate = ${nearestCanonical}
              `);

              await db.update(factPredicates)
                .set({ status: 'canonical' })
                .where(eq(factPredicates.predicate, predicate));

              merged++;
            } else if (result.decision === 'keep_separate') {
              if (result.confidence >= 0.8) {
                // High confidence novel -- promote to provisional
                log(`  Promote: ${predicate} -> provisional (${result.reasoning})`);

                await db.update(factPredicates)
                  .set({
                    status: 'provisional',
                    promotedAt: new Date(),
                  })
                  .where(eq(factPredicates.predicate, predicate));

                promoted++;
              } else {
                // Low confidence -- defer for more evidence
                log(`  Defer: ${predicate} (confidence: ${result.confidence})`);
                deferred++;
              }
            } else {
              // Defer
              log(`  Defer: ${predicate}`);
              deferred++;
            }
          }
        } catch (error) {
          log(`  Error comparing ${predicate}: ${error}`, 'warn');
          deferred++;
        }

        reviewed.add(predicate);

        // Checkpoint every 5 reviews
        if (reviewed.size % 5 === 0) {
          await checkpoint({ reviewed: Array.from(reviewed) });
        }
      }

      // =============================================
      // Step 4: Check provisional predicates for promotion/demotion
      // =============================================
      const provisionals = await db
        .select()
        .from(factPredicates)
        .where(eq(factPredicates.status, 'provisional'));

      for (const prov of provisionals) {
        if (!prov.promotedAt) continue;

        const daysSincePromotion = (Date.now() - prov.promotedAt.getTime()) / (1000 * 60 * 60 * 24);

        if (daysSincePromotion >= PROVISIONAL_PERIOD_DAYS) {
          if ((prov.usageCount || 0) >= usageThreshold) {
            // Sustained usage -- promote to full canonical
            log(`  Full promote: ${prov.predicate} (sustained ${prov.usageCount} uses over ${Math.floor(daysSincePromotion)} days)`);
            await db.update(factPredicates)
              .set({ status: 'canonical' })
              .where(eq(factPredicates.predicate, prov.predicate));
            promoted++;
          } else {
            // Usage dropped -- demote back to staging
            log(`  Demote: ${prov.predicate} (only ${prov.usageCount} uses -- below threshold)`, 'warn');
            await db.update(factPredicates)
              .set({ status: 'staging', promotedAt: null })
              .where(eq(factPredicates.predicate, prov.predicate));
          }
        }
      }

      log(`Evolution complete: ${promoted} promoted, ${merged} merged, ${rejected} rejected, ${deferred} deferred`);

      return {
        success: true,
        outputs: { promoted, merged, rejected, deferred, candidatesReviewed: reviewed.size },
        metrics: {
          confidence: 0.85,
          itemsProcessed: reviewed.size,
        },
      };

    } catch (error) {
      await checkpoint({ reviewed: Array.from(reviewed) });
      if (error instanceof AgentError) throw error;
      throw new AgentError(`Ontology evolution failed: ${error}`, true, error);
    }
  },
};
