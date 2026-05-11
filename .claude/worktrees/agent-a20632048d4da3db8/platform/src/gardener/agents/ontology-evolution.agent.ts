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
// Re-export for use when entity type promotion is implemented
// @ts-expect-error TS6133 — import used in future entity type promotion logic (see TODO below)
import { invalidateEntityTypeCache } from '../../services/entities.js';

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
        // Step 2b: Inverse registry check — don't merge inverses
        // =============================================
        const inverseMatch = await db
          .select({ predicate: factPredicates.predicate })
          .from(factPredicates)
          .where(eq(factPredicates.inversePredicate, predicate))
          .limit(1);

        if (inverseMatch.length > 0) {
          log(`  Inverse of '${inverseMatch[0]!.predicate}' — keeping separate`);
          // Promote as a separate predicate (it's the inverse direction)
          await db.update(factPredicates)
            .set({ status: 'provisional', promotedAt: new Date() })
            .where(eq(factPredicates.predicate, predicate));
          promoted++;
          reviewed.add(predicate);
          continue;
        }

        // =============================================
        // Step 3: Embedding layer — multi-signal scoring
        // =============================================
        const canonicals = Object.keys(CANONICAL_ONTOLOGY);
        const desc = candidate.description || predicate.replace(/_/g, ' ');
        const enrichedPrompt = `clustering: The relationship '${predicate}' describes ${desc.toLowerCase()}`;

        let candidateEmbedding: number[];
        try {
          const embedResult = await services.ml.embed(enrichedPrompt);
          candidateEmbedding = embedResult.vector || [];
        } catch {
          log(`  Embedding failed for ${predicate} — deferring to LLM`, 'warn');
          candidateEmbedding = [];
        }

        // Score against all canonicals
        const MERGE_THRESHOLD = 0.905;
        const DISTINCT_THRESHOLD = 0.848;

        let bestCanonical = '';
        let bestScore = -1;

        if (candidateEmbedding.length > 0) {
          for (const canonical of canonicals) {
            const canonicalInfo = CANONICAL_ONTOLOGY[canonical];
            if (!canonicalInfo) continue;

            const canonicalPrompt = `clustering: The relationship '${canonical}' describes ${canonicalInfo.description.toLowerCase()}`;

            let canonicalEmbedding: number[];
            try {
              const embedResult = await services.ml.embed(canonicalPrompt);
              canonicalEmbedding = embedResult.vector || [];
            } catch {
              continue;
            }

            if (canonicalEmbedding.length === 0) continue;

            // Cosine similarity
            const dotProduct = candidateEmbedding.reduce((sum, v, i) => sum + v * (canonicalEmbedding[i] || 0), 0);
            const magA = Math.sqrt(candidateEmbedding.reduce((s, v) => s + v * v, 0));
            const magB = Math.sqrt(canonicalEmbedding.reduce((s, v) => s + v * v, 0));
            const cosineSim = magA > 0 && magB > 0 ? dotProduct / (magA * magB) : 0;

            // Multi-signal: cosine 0.50 + type_pair 0.30 + jaro_winkler 0.10 + conceptnet 0.10
            // For now, use cosine similarity as the primary signal
            // (type pair and conceptnet require additional data not available in this context)
            const score = cosineSim;

            if (score > bestScore) {
              bestScore = score;
              bestCanonical = canonical;
            }
          }
        }

        // Route based on threshold zones
        if (bestScore >= MERGE_THRESHOLD && bestCanonical) {
          // Auto-merge — embedding confidence is high enough
          log(`  Embedding auto-merge: ${predicate} → ${bestCanonical} (score: ${bestScore.toFixed(4)})`);

          await db.execute(sql`
            UPDATE facts SET predicate = ${bestCanonical}
            WHERE predicate = ${predicate} AND expired_at IS NULL
          `);

          await db.execute(sql`
            UPDATE fact_predicates
            SET aliases = array_append(COALESCE(aliases, ARRAY[]::text[]), ${predicate})
            WHERE predicate = ${bestCanonical}
              AND NOT (${predicate} = ANY(COALESCE(aliases, ARRAY[]::text[])))
          `);

          await db.update(factPredicates)
            .set({ status: 'canonical' })
            .where(eq(factPredicates.predicate, predicate));

          merged++;
          reviewed.add(predicate);
          continue;
        } else if (bestScore < DISTINCT_THRESHOLD || candidateEmbedding.length === 0) {
          // Clearly distinct OR no embedding available — promote as genuinely novel
          if (candidateEmbedding.length === 0) {
            log(`  No embedding — sending to LLM gate`);
            // Fall through to LLM
          } else {
            log(`  Clearly distinct from all canonicals (best: ${bestCanonical} at ${bestScore.toFixed(4)}) — promoting`);
            await db.update(factPredicates)
              .set({ status: 'provisional', promotedAt: new Date() })
              .where(eq(factPredicates.predicate, predicate));
            promoted++;
            reviewed.add(predicate);
            continue;
          }
        }

        // =============================================
        // Step 4: LLM Gate — review zone (0.848-0.905) or embedding fallback
        // =============================================
        const nearestCanonical = bestCanonical || canonicals[0] || '';
        if (nearestCanonical) {
          const canonicalDesc = CANONICAL_ONTOLOGY[nearestCanonical]?.description || nearestCanonical;

          try {
            const result = await services.ml.comparePredicate(
              predicate, desc,
              nearestCanonical, canonicalDesc
            );

            if (result.decision === 'merge') {
              log(`  LLM merge: ${predicate} → ${nearestCanonical} (${result.reasoning})`);

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
                log(`  Promote: ${predicate} → provisional (${result.reasoning})`);
                await db.update(factPredicates)
                  .set({ status: 'provisional', promotedAt: new Date() })
                  .where(eq(factPredicates.predicate, predicate));
                promoted++;
              } else {
                log(`  Defer: ${predicate} (confidence: ${result.confidence})`);
                deferred++;
              }
            } else {
              log(`  Defer: ${predicate}`);
              deferred++;
            }
          } catch (error) {
            log(`  ML service unavailable for ${predicate} — deferring`, 'warn');
            deferred++;
            reviewed.add(predicate);
            continue;
          }
        }

        reviewed.add(predicate);

        // Checkpoint every 5 reviews
        if (reviewed.size % 5 === 0) {
          await checkpoint({ reviewed: Array.from(reviewed) });
        }
      }

      // =============================================
      // Step 5: Provisional lifecycle management — promotion/demotion
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

      // TODO(KARMA-ENTITY-TYPES): When entity type promotion is implemented,
      // call invalidateEntityTypeCache() here so extraction agents pick up
      // newly promoted types immediately instead of waiting for cache TTL.
      // Example: if (entityTypesPromoted > 0) invalidateEntityTypeCache();

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
