/**
 * Schema Alignment Agent (W27)
 *
 * KARMA agent that normalizes predicates and maintains the ontology.
 * Runs periodically to align non-canonical predicates.
 */

import type { AgentContext, JobResult, GardenerAgent } from '../controller.js';
import { db } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import {
  CANONICAL_ONTOLOGY,
  normalizePredicate,
  findNonCanonicalPredicates,
  normalizeFactPredicates,
  syncOntologyToDb,
  isCanonicalPredicate,
} from '../../services/predicates.js';

interface SchemaAlignmentPayload {
  fullSync?: boolean;
  maxNormalize?: number;
}

export const schemaAlignmentAgent: GardenerAgent = {
  name: 'align-schema',
  tier: 'periodic',

  async execute(context: AgentContext): Promise<JobResult> {
    const { job, log, checkpoint, restoreCheckpoint } = context;
    const payload = job.data as SchemaAlignmentPayload;

    log('Starting schema alignment...');

    // Restore checkpoint
    const state = await restoreCheckpoint() as {
      syncedPredicates?: string[];
      normalizedPredicates?: string[];
    } | null;

    const syncedPredicates = new Set<string>(state?.syncedPredicates || []);
    const normalizedPredicates = new Set<string>(state?.normalizedPredicates || []);

    let ontologySynced = 0;
    let predicatesNormalized = 0;
    let factsUpdated = 0;

    try {
      // Step 1: Sync canonical ontology to database
      if (payload.fullSync || syncedPredicates.size === 0) {
        log('Syncing canonical ontology to database...');
        ontologySynced = await syncOntologyToDb();
        log(`Synced ${ontologySynced} canonical predicates`);

        for (const predicate of Object.keys(CANONICAL_ONTOLOGY)) {
          syncedPredicates.add(predicate);
        }

        await checkpoint({
          syncedPredicates: Array.from(syncedPredicates),
          normalizedPredicates: Array.from(normalizedPredicates),
        });
      }

      // Step 2: Find non-canonical predicates in facts
      log('Finding non-canonical predicates...');
      const nonCanonical = await findNonCanonicalPredicates();

      if (nonCanonical.length === 0) {
        log('All predicates are canonical');
        return {
          success: true,
          outputs: {
            ontologySynced,
            predicatesNormalized: 0,
            factsUpdated: 0,
          },
          metrics: {
            confidence: 1.0,
            itemsProcessed: ontologySynced,
          },
        };
      }

      log(`Found ${nonCanonical.length} non-canonical predicates`);

      // Step 3: Normalize predicates
      const maxToNormalize = payload.maxNormalize || 50;
      const toProcess = nonCanonical.slice(0, maxToNormalize);

      for (const { predicate, count } of toProcess) {
        if (normalizedPredicates.has(predicate)) continue;

        // Get canonical form
        const canonical = normalizePredicate(predicate);

        if (canonical === predicate) {
          // No canonical mapping found - log for manual review
          log(`No canonical mapping for "${predicate}" (${count} facts)`, 'warn');
          await flagForReview(predicate, count);
          normalizedPredicates.add(predicate);
          continue;
        }

        // Ensure canonical predicate exists in ontology
        if (!isCanonicalPredicate(canonical)) {
          log(`Warning: "${canonical}" is not in canonical ontology`, 'warn');
        }

        // Normalize all facts using this predicate
        const updated = await normalizeFactPredicates(predicate, canonical);
        factsUpdated += updated;
        predicatesNormalized++;

        log(`Normalized "${predicate}" -> "${canonical}" (${updated} facts)`);

        // Add as alias in database
        await addPredicateAlias(canonical, predicate);

        normalizedPredicates.add(predicate);

        // Checkpoint every 10 predicates
        if (predicatesNormalized % 10 === 0) {
          await checkpoint({
            syncedPredicates: Array.from(syncedPredicates),
            normalizedPredicates: Array.from(normalizedPredicates),
          });
        }
      }

      log(`Schema alignment complete: ${predicatesNormalized} predicates, ${factsUpdated} facts`);

      return {
        success: true,
        outputs: {
          ontologySynced,
          predicatesNormalized,
          factsUpdated,
          remainingNonCanonical: nonCanonical.length - toProcess.length,
        },
        metrics: {
          confidence: 0.9,
          itemsProcessed: predicatesNormalized + ontologySynced,
        },
      };

    } catch (error) {
      log(`Schema alignment failed: ${error}`, 'error');

      // Save checkpoint on failure
      await checkpoint({
        syncedPredicates: Array.from(syncedPredicates),
        normalizedPredicates: Array.from(normalizedPredicates),
      });

      return { success: false };
    }
  },
};

/**
 * Add alias to canonical predicate in database
 */
async function addPredicateAlias(canonical: string, alias: string): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE fact_predicates
      SET aliases = array_append(
        COALESCE(aliases, ARRAY[]::text[]),
        ${alias}
      )
      WHERE predicate = ${canonical}
        AND NOT (${alias} = ANY(COALESCE(aliases, ARRAY[]::text[])))
    `);
  } catch (error) {
    console.warn(`Failed to add alias ${alias} to ${canonical}:`, error);
  }
}

/**
 * Flag predicate for manual review
 */
async function flagForReview(predicate: string, factCount: number): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO fact_predicates (
        predicate, description, is_canonical, usage_count
      ) VALUES (
        ${predicate},
        'Needs canonical mapping - auto-discovered',
        false,
        ${factCount}
      )
      ON CONFLICT (predicate) DO UPDATE SET
        is_canonical = false,
        usage_count = EXCLUDED.usage_count
    `);
  } catch (error) {
    console.warn(`Failed to flag predicate ${predicate}:`, error);
  }
}
