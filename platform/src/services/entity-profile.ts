/**
 * Entity Profile Service
 *
 * Read-only orchestration layer that assembles entity profiles
 * by combining data from entities, facts, graph, and memories.
 */

import { rawQuery } from '../db/raw.js';
import { sql } from 'drizzle-orm';
import { getEntityById, findEntitiesByName, type EntityType } from './entities.js';
import { getEntityFacts } from './facts.js';
import { findConnectedEntities, type GraphEntity } from './graph.js';
import { qdrant, COLLECTIONS } from './qdrant.js';
import type { Entity, Fact } from '../db/schema.js';

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
}

/**
 * Assemble a full entity profile from multiple data sources
 */
export async function getEntityProfile(entityId: string): Promise<EntityProfile | null> {
  const entity = await getEntityById(entityId);
  if (!entity) return null;

  const [facts, relatedEntities, recentMemories] = await Promise.all([
    getEntityFacts(entityId),
    findConnectedEntities(entityId),
    getEntityMemories(entityId),
  ]);

  return { entity, facts, relatedEntities, recentMemories };
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

// Predicate categories for grouping in the profile display
const PREDICATE_CATEGORIES: Record<string, string[]> = {
  'Identity': ['is_a', 'instance_of', 'type_of', 'alias_of'],
  'Relationships': ['works_at', 'works_with', 'reports_to', 'manages', 'member_of', 'part_of', 'belongs_to'],
  'Attributes': ['has_role', 'has_skill', 'has_title', 'located_in', 'lives_in', 'based_in'],
  'Activities': ['works_on', 'contributes_to', 'created', 'owns', 'uses', 'interested_in'],
};

function categorize(predicate: string): string {
  for (const [category, predicates] of Object.entries(PREDICATE_CATEGORIES)) {
    if (predicates.includes(predicate)) return category;
  }
  return 'Other';
}

/**
 * Format an entity profile for Telegram display (4096 char limit)
 */
export function formatEntityProfile(profile: EntityProfile): string {
  const { entity, facts, relatedEntities, recentMemories } = profile;
  const parts: string[] = [];
  const MAX_LENGTH = 4000; // Leave margin for safety

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
