/**
 * Predicate Ontology Service
 *
 * Manages the canonical predicate ontology for knowledge graph relationships.
 * Live entry points used in production: `normalizePredicate()` (Layer 1
 * structural normalisation, called from the graph_agent path), `CANONICAL_ONTOLOGY`
 * (canonical alias map), `isCanonicalPredicate()`, and `recordPredicateUsage()`
 * (bumps usage counters on every fact creation via `facts.ts::createFact`).
 *
 * The remaining exports (`syncOntologyToDb`, `findNonCanonicalPredicates`,
 * `normalizeFactPredicates`, `transitionPredicateStatus`) are `@deprecated`
 * (nmemo-2yv.23) — they were the API surface of the predicate-evolution
 * orchestrator that was never built. See doc 02 §6 for the deferred design.
 */

import { db } from '../db/index.js';
import { rawQuery } from '../db/raw.js';
import { eq, sql } from 'drizzle-orm';
import { factPredicates } from '../db/schema.js';
import {
  CANONICAL_ONTOLOGY,
  normalizePredicate,
  getPredicateInfo,
  isCanonicalPredicate,
  type PredicateInfo,
} from './predicate-ontology.js';

// The pure ontology (alias map + Layer 1 normalisation) lives in
// `predicate-ontology.ts` so DB-free consumers (e.g. graph-invariants.ts) can
// import it without opening the postgres pool. Re-exported here so existing
// importers (causal-agent, predicate-signature, ontology-* tests) are unchanged.
export { CANONICAL_ONTOLOGY, normalizePredicate, getPredicateInfo, isCanonicalPredicate };
export type { PredicateInfo };

/**
 * Sync ontology to database
 *
 * @deprecated (nmemo-2yv.23) No production caller. The canonical seed is loaded
 * by migration 001_consolidated.sql:157 directly; this TS path is redundant.
 * Kept for documentation/test use; safe to remove once
 * docs/architecture/truth-graph/02-graph-s-hardening.md §6 ("Wire the
 * Ontology Evolution Pipeline") is either revived or struck. See bead .23
 * notes for the drop-vs-revive decision.
 */
export async function syncOntologyToDb(): Promise<number> {
  let synced = 0;

  for (const [predicate, info] of Object.entries(CANONICAL_ONTOLOGY)) {
    try {
      await db.execute(sql`
        INSERT INTO fact_predicates (
          predicate, description, inverse_predicate, predicate_type,
          is_exclusive, category, aliases, is_canonical
        ) VALUES (
          ${predicate},
          ${info.description},
          ${info.inverse || null},
          ${info.type || null},
          ${info.exclusive},
          ${info.category},
          ${sql.raw(`ARRAY[${info.aliases.map(a => `'${a}'`).join(',')}]`)},
          true
        )
        ON CONFLICT (predicate) DO UPDATE SET
          description = EXCLUDED.description,
          inverse_predicate = EXCLUDED.inverse_predicate,
          predicate_type = EXCLUDED.predicate_type,
          is_exclusive = EXCLUDED.is_exclusive,
          category = EXCLUDED.category,
          aliases = EXCLUDED.aliases,
          is_canonical = true
      `);
      synced++;
    } catch (error) {
      console.error(`Failed to sync predicate ${predicate}:`, error);
    }
  }

  return synced;
}

/**
 * Find non-canonical predicates in facts table
 *
 * @deprecated (nmemo-2yv.23) No production caller. Designed as input to the
 * predicate-evolution orchestrator that was never built (the referenced
 * `platform/src/gardener/agents/ontology-evolution.agent.ts` does not exist;
 * the gardener_agent that DOES run handles entity consolidation only).
 * Kept for documentation/test use; safe to remove once
 * docs/architecture/truth-graph/02-graph-s-hardening.md §6 is either
 * revived or struck. See bead .23 notes.
 */
export async function findNonCanonicalPredicates(): Promise<Array<{ predicate: string; count: number }>> {
  const canonicalList = Object.keys(CANONICAL_ONTOLOGY);

  return rawQuery<{ predicate: string; count: number }>(sql`
    SELECT predicate, COUNT(*) as count
    FROM facts
    WHERE predicate NOT IN (${sql.join(canonicalList.map(p => sql`${p}`), sql`, `)})
      AND expired_at IS NULL
    GROUP BY predicate
    ORDER BY count DESC
  `);
}

/**
 * Update facts to use canonical predicate
 *
 * @deprecated (nmemo-2yv.23) No production caller. Designed as the bulk-rewrite
 * step the predicate-evolution orchestrator would invoke after Layer 2/3 review
 * approved a merge; that orchestrator was never built. Kept for documentation/
 * test use; safe to remove once doc 02 §6 is revived or struck.
 * See bead .23 notes.
 */
export async function normalizeFactPredicates(
  fromPredicate: string,
  toPredicate: string
): Promise<number> {
  const result = await db.execute(sql`
    UPDATE facts
    SET predicate = ${toPredicate}
    WHERE predicate = ${fromPredicate}
      AND expired_at IS NULL
  `);

  return (result as unknown as { rowCount: number }).rowCount || 0;
}

/**
 * Record predicate usage
 */
export async function recordPredicateUsage(predicate: string): Promise<void> {
  const canonical = normalizePredicate(predicate);

  await db.execute(sql`
    UPDATE fact_predicates
    SET usage_count = usage_count + 1,
        last_used_at = NOW()
    WHERE predicate = ${canonical}
  `);
}

/**
 * Valid predicate status transitions.
 * All other transitions are invalid and will throw.
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  staging: ['canonical', 'candidate'],
  candidate: ['provisional', 'rejected'],
  provisional: ['canonical', 'staging'],
  rejected: ['staging'],
  // canonical has no outbound transitions — once canonical, always canonical
};

/**
 * Transition a predicate's status with validation.
 * Throws if the transition is not allowed.
 *
 * @deprecated (nmemo-2yv.23) No production caller. The CAS-style state machine
 * is correct (see ontology-state-machine.test.ts) but no orchestrator walks
 * predicates through the staging → candidate → provisional → canonical
 * lifecycle in production. Kept for documentation/test use; safe to remove
 * once doc 02 §6 is revived or struck. See bead .23 notes.
 */
export async function transitionPredicateStatus(
  predicate: string,
  toStatus: string,
  extra?: Partial<{
    promotedAt: Date;
    rejectedAt: Date;
    rejectionReason: string;
  }>
): Promise<void> {
  // Get current status
  const current = await db
    .select({ status: factPredicates.status })
    .from(factPredicates)
    .where(eq(factPredicates.predicate, predicate))
    .limit(1);

  if (!current[0]) {
    throw new Error(`Predicate '${predicate}' not found in fact_predicates`);
  }

  const fromStatus = current[0].status || 'staging';
  const allowed = VALID_TRANSITIONS[fromStatus];

  if (!allowed || !allowed.includes(toStatus)) {
    throw new Error(
      `Invalid status transition: '${fromStatus}' → '${toStatus}' for predicate '${predicate}'. ` +
      `Allowed from '${fromStatus}': ${allowed?.join(', ') || 'none'}`
    );
  }

  await db
    .update(factPredicates)
    .set({
      status: toStatus,
      ...(extra?.promotedAt ? { promotedAt: extra.promotedAt } : {}),
      ...(extra?.rejectedAt ? { rejectedAt: extra.rejectedAt } : {}),
      ...(extra?.rejectionReason ? { rejectionReason: extra.rejectionReason } : {}),
    })
    .where(eq(factPredicates.predicate, predicate));
}
