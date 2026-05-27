/**
 * Entity Profile Service
 *
 * Read-only orchestration layer that assembles entity profiles
 * by combining data from entities, facts, graph, and memories.
 */

import { db } from '../db/index.js';
import { rawQuery } from '../db/raw.js';
import { eq, sql } from 'drizzle-orm';
import { getEntityById, findEntitiesByName, type EntityType } from './entities.js';
import { getEntityFacts } from './facts.js';
import { findConnectedEntities, type GraphEntity } from './graph.js';
import { qdrant, COLLECTIONS } from './qdrant.js';
import { entityMeta, type Entity, type Fact } from '../db/schema.js';

export interface EntityMemory {
  memoryId: string;
  content: string;
  type: string;
  createdAt: string;
}

export interface EntityProfile {
  entity: Entity & { aliases: string[] };
  facts: Fact[];
  relatedEntities: GraphEntity[];
  recentMemories: EntityMemory[];
  // nmemo-2yv.51 — surface the agent-authored summary alongside the structured
  // facts/relations. Written by causal-agent.ts via update_entity_summary
  // (see doc 06 §entity-summary; bead .55 covers optimistic locking).
  summary: string | null;
  summaryUpdatedAt: Date | null;
}

/**
 * Assemble a full entity profile from multiple data sources.
 *
 * Reads in parallel:
 *  - getEntityFacts (facts table)
 *  - findConnectedEntities (graph traversal)
 *  - getEntityMemories (memory_entities -> Qdrant)
 *  - getEntitySummary (entity_meta.summary + summary_updated_at)
 */
export async function getEntityProfile(entityId: string): Promise<EntityProfile | null> {
  const entity = await getEntityById(entityId);
  if (!entity) return null;

  const [facts, relatedEntities, recentMemories, summaryRow] = await Promise.all([
    getEntityFacts(entityId),
    findConnectedEntities(entityId),
    getEntityMemories(entityId),
    getEntitySummary(entityId),
  ]);

  return {
    entity,
    facts,
    relatedEntities,
    recentMemories,
    summary: summaryRow?.summary ?? null,
    summaryUpdatedAt: summaryRow?.summaryUpdatedAt ?? null,
  };
}

/**
 * Read the agent-authored summary + freshness timestamp for an entity.
 *
 * Returns null when no entity_meta row exists yet (entity newer than the
 * causal agent's first patrol over it). Callers must treat the absence
 * indistinguishably from {summary:null, summaryUpdatedAt:null}.
 */
async function getEntitySummary(
  entityId: string,
): Promise<{ summary: string | null; summaryUpdatedAt: Date | null } | null> {
  const rows = await db
    .select({
      summary: entityMeta.summary,
      summaryUpdatedAt: entityMeta.summaryUpdatedAt,
    })
    .from(entityMeta)
    .where(eq(entityMeta.entityId, entityId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Get memories that mention an entity, with content from Qdrant
 */
export async function getEntityMemories(
  entityId: string,
  options: { limit?: number } = {}
): Promise<EntityMemory[]> {
  const { limit = 10 } = options;

  // Get memory IDs linked to this entity. The unique index on memory_entities
  // is (memory_id, entity_id, COALESCE(mention_start, -1)), so the same
  // (memory_id, entity_id) pair can repeat once per mention offset. Deduplicate
  // by memory_id via DISTINCT ON in a subquery, keeping the most-recent
  // createdAt per memory, then ORDER BY that createdAt DESC and LIMIT.
  // Without this, heavily-mentioned hub entities silently return fewer
  // memories than the caller requested (bead nmemo-2yv.58 H8).
  const links = await rawQuery<{ memoryId: string }>(sql`
    SELECT memory_id
    FROM (
      SELECT DISTINCT ON (memory_id) memory_id, created_at
      FROM public.memory_entities
      WHERE entity_id = ${entityId}::uuid
      ORDER BY memory_id, created_at DESC
    ) dedup
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);

  if (links.length === 0) return [];

  // Retrieve payloads from Qdrant
  try {
    const points = await qdrant.retrieve(COLLECTIONS.MEMORIES, {
      ids: links.map(l => l.memoryId),
      with_payload: true,
      with_vector: false,
    });

    return points.map(p => {
      const payload = p.payload as Record<string, unknown>;
      return {
        memoryId: String(p.id),
        content: (payload.content || payload.text || '') as string,
        type: (payload.type || 'thought') as string,
        createdAt: (payload.created_at || '') as string,
      };
    });
  } catch (error) {
    // Qdrant may be unavailable — degrade gracefully but log so a persistent
    // outage doesn't masquerade as "this entity has no recent memories" in
    // every downstream consumer (bead nmemo-2yv.58 H6).
    console.warn(
      `[entity-profile.getEntityMemories] qdrant.retrieve failed for entity_id=${entityId}:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * Search entities by name — thin wrapper for the API layer
 */
export async function searchEntities(
  query: string,
  options?: { limit?: number; type?: EntityType; fuzzy?: boolean }
): Promise<Array<Entity & { similarity?: number }>> {
  return findEntitiesByName(query, options);
}

/**
 * Predicate categories for grouping in the profile display.
 *
 * The list is seeded from predicates observed in source/tests as of bead
 * nmemo-2yv.57 (2026-05-27). The categorisation buckets — Identity,
 * Relationships, Attributes, Activities, and the fallback "Other" — are
 * deliberately coarse-grained so newly-coined predicates have a reasonable
 * default home. Expect this list to need expansion as the LLM extracts
 * new predicates; the test-harden skill is the canonical surface for
 * discovering such drift.
 *
 * If the list grows past ~30 predicates, replace with a DB-driven
 * predicate_categories(predicate, category) table seeded from this list,
 * with a runtime cache loaded once at module init.
 */
const PREDICATE_CATEGORIES: Record<string, string[]> = {
  'Identity': ['is_a', 'instance_of', 'type_of', 'alias_of', 'has_label'],
  'Relationships': [
    'works_at', 'works_with', 'reports_to', 'manages', 'member_of',
    'part_of', 'belongs_to', 'employed_at', 'employs', 'worked_at',
    'links', 'knows', 'related', 'related_to',
  ],
  'Attributes': [
    'has_role', 'has_skill', 'has_title', 'located_in', 'lives_in',
    'based_in', 'has_status', 'status', 'started_at', 'scheduled_for',
    'relocated_to', 'amount', 'was_active',
  ],
  'Activities': [
    'works_on', 'contributes_to', 'created', 'owns', 'uses',
    'interested_in', 'reads', 'experiences', 'caused', 'finishes',
    'has', 'next', 'mentions', 'opens', 'visited',
  ],
};

/**
 * Bucket a predicate string into a display category.
 *
 * Exported so tests (and future callers grouping facts elsewhere — e.g.
 * the viz detail panel) can exercise the same categorisation logic
 * without re-implementing it.
 */
export function categorize(predicate: string): string {
  for (const [category, predicates] of Object.entries(PREDICATE_CATEGORIES)) {
    if (predicates.includes(predicate)) return category;
  }
  return 'Other';
}

/**
 * Format an entity profile for Telegram display (4096 char limit)
 */
export function formatEntityProfile(profile: EntityProfile): string {
  const { entity, facts, relatedEntities, recentMemories, summary } = profile;
  const parts: string[] = [];
  const MAX_LENGTH = 4000; // Leave margin for safety
  // Summary is agent-authored prose and can run long. Cap it before downstream
  // truncation eats the structured facts/relations sections — those are more
  // useful per byte than the tail of a narrative paragraph.
  const SUMMARY_BUDGET = 1200;

  // Header
  const typeEmoji: Record<string, string> = {
    person: '👤', company: '🏢', project: '📁', concept: '💡',
    place: '📍', event: '📅', other: '🔹',
  };
  const emoji = typeEmoji[entity.entityType] || '🔹';
  let header = `${emoji} **${entity.canonicalName}** (${entity.entityType})`;
  if (entity.aliases.length > 0) {
    header += `\n_aka: ${entity.aliases.join(', ')}_`;
  }
  parts.push(header);

  // Agent-authored summary, rendered above facts. Omitted when null so the
  // header sits flush against the facts section for entities with no summary
  // yet (causal agent hasn't patrolled them, or summary was cleared).
  if (summary !== null && summary.length > 0) {
    const trimmedSummary = summary.length > SUMMARY_BUDGET
      ? summary.slice(0, SUMMARY_BUDGET - 1) + '…'
      : summary;
    parts.push(`\n**Summary:**\n${trimmedSummary}`);
  }

  // Facts grouped by category
  if (facts.length > 0) {
    const grouped = new Map<string, Fact[]>();
    for (const fact of facts) {
      const cat = categorize(fact.predicate);
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat)!.push(fact);
    }

    const factLines: string[] = [];
    for (const [category, catFacts] of grouped) {
      factLines.push(`\n**${category}:**`);
      for (const fact of catFacts.slice(0, 5)) {
        const value = fact.objectValue || fact.objectEntityId || '?';
        factLines.push(`• ${fact.predicate}: ${value}`);
      }
      if (catFacts.length > 5) {
        factLines.push(`  _...and ${catFacts.length - 5} more_`);
      }
    }
    parts.push(factLines.join('\n'));
  }

  // Related entities
  if (relatedEntities.length > 0) {
    const related = relatedEntities
      .slice(0, 8)
      .map(e => `${e.name} (${e.type})`)
      .join(', ');
    parts.push(`\n**Connected:** ${related}`);
  }

  // Recent memories
  if (recentMemories.length > 0) {
    const memLines = recentMemories.slice(0, 3).map(m => {
      const content = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
      const date = m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '';
      return `• ${content}${date ? ` _(${date})_` : ''}`;
    });
    parts.push(`\n**Recent mentions:**\n${memLines.join('\n')}`);
  }

  let result = parts.join('\n');

  // Truncate gracefully if too long
  if (result.length > MAX_LENGTH) {
    result = result.slice(0, MAX_LENGTH - 20) + '\n\n_...truncated_';
  }

  return result;
}
