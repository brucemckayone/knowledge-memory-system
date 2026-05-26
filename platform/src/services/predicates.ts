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

export interface PredicateInfo {
  predicate: string;
  description: string;
  inversePredicate?: string;
  predicateType?: string;
  isExclusive: boolean;
  category?: string;
  aliases: string[];
  isCanonical: boolean;
  usageCount: number;
}

/**
 * Canonical ontology definition
 * Categories: professional, personal, location, education, creation, skills, events
 */
export const CANONICAL_ONTOLOGY: Record<string, {
  description: string;
  inverse?: string;
  type?: string;
  exclusive: boolean;
  category: string;
  aliases: string[];
}> = {
  // Professional relationships
  works_at: {
    description: 'Employment relationship between person and organization',
    inverse: 'employs',
    type: 'employment',
    exclusive: true,
    category: 'professional',
    aliases: ['employed_at', 'works_for', 'employee_of', 'working_at', 'worked_at', 'formerly_at', 'ex_employee_of', 'used_to_work_at'],
  },
  manages: {
    description: 'Manages another person',
    inverse: 'reports_to',
    type: 'hierarchy',
    exclusive: false,
    category: 'professional',
    aliases: ['supervises', 'leads', 'directs', 'oversees'],
  },
  reports_to: {
    description: 'Reports to another person',
    inverse: 'manages',
    type: 'hierarchy',
    exclusive: true,
    category: 'professional',
    aliases: ['managed_by', 'supervised_by', 'under'],
  },
  founded: {
    description: 'Founded an organization',
    type: 'founding',
    exclusive: false,
    category: 'professional',
    aliases: ['created', 'started', 'established', 'co_founded'],
  },
  ceo_of: {
    description: 'CEO of organization',
    type: 'role',
    exclusive: true,
    category: 'professional',
    aliases: ['chief_executive_of', 'runs', 'heads'],
  },
  member_of: {
    description: 'Member of organization/group',
    inverse: 'has_member',
    type: 'membership',
    exclusive: false,
    category: 'professional',
    aliases: ['belongs_to', 'part_of', 'affiliated_with'],
  },

  // Personal relationships
  knows: {
    description: 'Knows another person',
    inverse: 'known_by',
    type: 'social',
    exclusive: false,
    category: 'personal',
    aliases: ['acquainted_with', 'met', 'familiar_with'],
  },
  friend_of: {
    description: 'Friends with another person',
    type: 'social',
    exclusive: false,
    category: 'personal',
    aliases: ['friends_with', 'close_to'],
  },
  married_to: {
    description: 'Married to another person',
    type: 'family',
    exclusive: true,
    category: 'personal',
    aliases: ['spouse_of', 'husband_of', 'wife_of', 'partner_of'],
  },
  parent_of: {
    description: 'Parent of another person',
    inverse: 'child_of',
    type: 'family',
    exclusive: false,
    category: 'personal',
    aliases: ['father_of', 'mother_of'],
  },
  child_of: {
    description: 'Child of another person',
    inverse: 'parent_of',
    type: 'family',
    exclusive: false,
    category: 'personal',
    aliases: ['son_of', 'daughter_of'],
  },
  sibling_of: {
    description: 'Sibling of another person',
    type: 'family',
    exclusive: false,
    category: 'personal',
    aliases: ['brother_of', 'sister_of'],
  },

  // Location relationships
  lives_in: {
    description: 'Residential relationship between person and location',
    type: 'residence',
    exclusive: true,
    category: 'location',
    aliases: ['resides_in', 'based_in', 'located_in', 'living_in', 'lived_in', 'formerly_in', 'used_to_live_in'],
  },
  born_in: {
    description: 'Born in location',
    type: 'origin',
    exclusive: true,
    category: 'location',
    aliases: ['birthplace', 'native_of', 'from'],
  },
  visited: {
    description: 'Visited a location',
    type: 'travel',
    exclusive: false,
    category: 'location',
    aliases: ['traveled_to', 'went_to', 'been_to'],
  },

  // Education
  studied_at: {
    description: 'Studied at institution',
    type: 'education',
    exclusive: false,
    category: 'education',
    aliases: ['attended', 'enrolled_at', 'graduated_from', 'alumnus_of'],
  },
  has_degree: {
    description: 'Has academic degree',
    type: 'qualification',
    exclusive: false,
    category: 'education',
    aliases: ['earned_degree', 'holds_degree', 'degree_in'],
  },

  // Creation/Ownership
  created: {
    description: 'Created something',
    inverse: 'created_by',
    type: 'creation',
    exclusive: false,
    category: 'creation',
    aliases: ['authored', 'built', 'made', 'developed', 'wrote', 'designed'],
  },
  owns: {
    description: 'Owns something',
    inverse: 'owned_by',
    type: 'ownership',
    exclusive: false,
    category: 'creation',
    aliases: ['has', 'possesses', 'owner_of'],
  },

  // Knowledge/Skills
  knows_about: {
    description: 'Has knowledge of topic',
    type: 'knowledge',
    exclusive: false,
    category: 'skills',
    aliases: ['understands', 'familiar_with_topic', 'knowledgeable_in'],
  },
  skilled_in: {
    description: 'Has skill in area',
    type: 'skill',
    exclusive: false,
    category: 'skills',
    aliases: ['proficient_in', 'expert_in', 'good_at', 'specializes_in'],
  },
  interested_in: {
    description: 'Interested in topic',
    type: 'interest',
    exclusive: false,
    category: 'skills',
    aliases: ['likes', 'enjoys', 'passionate_about', 'into'],
  },

  // Events
  attended_event: {
    description: 'Attended an event',
    type: 'participation',
    exclusive: false,
    category: 'events',
    aliases: ['went_to_event', 'participated_in'],
  },
  organized: {
    description: 'Organized an event',
    type: 'participation',
    exclusive: false,
    category: 'events',
    aliases: ['hosted', 'arranged', 'planned'],
  },
  spoke_at: {
    description: 'Spoke at an event',
    type: 'participation',
    exclusive: false,
    category: 'events',
    aliases: ['presented_at', 'gave_talk_at', 'keynote_at'],
  },
};

// Build reverse lookup for aliases
const aliasToCanonical: Map<string, string> = new Map();
for (const [canonical, info] of Object.entries(CANONICAL_ONTOLOGY)) {
  for (const alias of info.aliases) {
    aliasToCanonical.set(alias.toLowerCase(), canonical);
  }
}

/**
 * Normalize a predicate to its canonical form
 */
export function normalizePredicate(predicate: string): string {
  const normalized = predicate.toLowerCase().replace(/\s+/g, '_');

  // Check if already canonical
  if (CANONICAL_ONTOLOGY[normalized]) {
    return normalized;
  }

  // Check alias lookup
  const canonical = aliasToCanonical.get(normalized);
  if (canonical) {
    return canonical;
  }

  // Return as-is if not found (will be flagged for review)
  return normalized;
}

/**
 * Get predicate info from ontology
 */
export function getPredicateInfo(predicate: string): PredicateInfo | null {
  const canonical = normalizePredicate(predicate);
  const info = CANONICAL_ONTOLOGY[canonical];

  if (!info) {
    return null;
  }

  return {
    predicate: canonical,
    description: info.description,
    inversePredicate: info.inverse,
    predicateType: info.type,
    isExclusive: info.exclusive,
    category: info.category,
    aliases: info.aliases,
    isCanonical: true,
    usageCount: 0,
  };
}

/**
 * Check if predicate is in canonical ontology
 */
export function isCanonicalPredicate(predicate: string): boolean {
  const normalized = predicate.toLowerCase().replace(/\s+/g, '_');
  return !!CANONICAL_ONTOLOGY[normalized];
}

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
