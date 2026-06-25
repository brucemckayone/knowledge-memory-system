/**
 * Recent service (iOS API v1 — ASK-002).
 *
 * Supplies the home "recent" section's timeline of one-line pulled quotes,
 * newest-first. Reads from the memory_index Postgres table (written by
 * pipeline.store()'s indexMemoryForRecent hook) joined to memory_entities ⋈
 * entities for the italic entity. This is a CHEAP PG read — never a Qdrant
 * scan — by design (see migration 050_recent_index.sql).
 *
 * Wire shape (camelCase, pinned by the iOS RecentEntry / RecentResponse
 * decoder in Sources/MnemoBackend/ASK/Recent/RecentEntry.swift):
 *
 *   {
 *     "entries": [
 *       {
 *         "entryId":   "<memoryId>",            // canonical memory id
 *         "createdAt": "<iso8601>",             // strict ISO-8601, Z
 *         "pulledLine":"<string|null>",         // bare excerpt; null if none
 *         "fullContent":"<string>",             // the memory body (rise resolves against this)
 *         "italicEntity": { "entityId":"<uuid>", "name":"<canonical_name>" } | null
 *       }
 *     ]
 *   }
 *
 * FAIL-LOUD wire normalization the iOS decoder requires (mirrors routes/hero.ts
 * + routes/notifications.ts posture):
 *   - "entries" is ALWAYS an array, never null (empty => []).
 *   - entryId / fullContent are non-empty strings; a row failing either is
 *     DROPPED (warn-logged), never served — the iOS decoder rejects empty
 *     identity / empty fallback source, and one bad row would blank the whole
 *     section.
 *   - createdAt is emitted via toISOString() (strict ISO-8601 Z).
 *   - italicEntity.name is non-empty and occurs verbatim in fullContent (the
 *     iOS view styles that range); rows where the joined name is absent from
 *     the body emit italicEntity: null instead of a guaranteed-miss span.
 *
 * DOCUMENTED DECISIONS (ASK-002 ambiguities):
 *   - pulledLine excerpt rule: first sentence up to/including the first
 *     sentence-final mark; if longer than 120 chars, truncate at the last
 *     whitespace boundary and append "…". Computed in store()
 *     (pulledLineExcerpt); this service only falls back to an on-the-fly
 *     excerpt when the stored pulled_line is NULL (legacy rows ingested before
 *     migration 050 deployed).
 *   - italicEntity tie-break: among the entities linked to the memory whose
 *     canonical_name occurs verbatim in fullContent, pick the
 *     most-recently-linked one (memory_entities.created_at DESC), breaking
 *     further ties by highest confidence. "Most relevant" is otherwise
 *     unobservable without a ranking signal we do not have in v1; recency of
 *     the link is a stable, deterministic proxy. If NO linked entity's name
 *     occurs in the body, italicEntity is null (per the wire contract).
 *   - Backfill: recent starts from deploy forward. Existing Qdrant memories
 *     ingested before the store() hook landed have no memory_index row and are
 *     absent from /api/recent until a backfill job (follow-up) walks them.
 *     Acceptable for v1 single-user.
 */

import { db, memoryIndex, memoryEntities, entities } from '../db/index.js';
import { desc, eq, sql } from 'drizzle-orm';
import { getMemory } from './qdrant.js';
import { pulledLineExcerpt } from '../pipeline.js';

// --- wire contract ----------------------------------------------------------

export interface RecentItalicEntityDTO {
  entityId: string;
  name: string;
}

export interface RecentEntryDTO {
  entryId: string;
  createdAt: string;
  pulledLine: string | null;
  fullContent: string;
  italicEntity: RecentItalicEntityDTO | null;
}

export interface RecentResponse {
  entries: RecentEntryDTO[];
}

// --- helpers ----------------------------------------------------------------

function nonBlank(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * On-the-fly excerpt for a legacy memory_index row whose pulled_line is NULL
 * (ingested before the store() hook). Identical rule to pulledLineExcerpt so
 * legacy rows render the same excerpt as fresh ones once backfilled.
 */
function excerptFromBody(body: string): string | null {
  const ex = pulledLineExcerpt(body);
  return ex.length > 0 ? ex : null;
}

// --- italic entity resolution ----------------------------------------------

/**
 * Resolve the ONE italic entity for a memory: the most-recently-linked entity
 * whose canonical_name occurs verbatim (case-sensitive) in the memory body.
 * Returns null if the memory has no linked entity, or none whose name appears
 * in the body. See the module header for the tie-break rationale.
 *
 * Two-table join memory_entities ⋈ entities on entityId, ordered by
 * memory_entities.created_at DESC then confidence DESC so the first verbatim
 * hit is the chosen one. The verbatim check is done in JS (not SQL) so the
 * match semantics exactly equal what the iOS view's range(of:) will compute.
 */
async function resolveItalicEntity(memoryId: string, body: string): Promise<RecentItalicEntityDTO | null> {
  const rows = await db
    .select({
      entityId: entities.id,
      name: entities.canonicalName,
    })
    .from(memoryEntities)
    .innerJoin(entities, eq(entities.id, memoryEntities.entityId))
    .where(eq(memoryEntities.memoryId, sql`${memoryId}::uuid`))
    .orderBy(desc(memoryEntities.createdAt), desc(memoryEntities.confidence));

  for (const r of rows) {
    // Verbatim, case-sensitive — matches the iOS ItalicizedLine range(of:)
    // check. canonical_name is stored as the user wrote it / lowercased by
    // extraction; the body is the same source, so a verbatim hit is the norm.
    if (nonBlank(r.name) && body.includes(r.name)) {
      return { entityId: r.entityId, name: r.name };
    }
  }
  return null;
}

// --- public entry point -----------------------------------------------------

/**
 * Plain async core: return up to `limit` recent entries, newest-first, in the
 * iOS wire shape. Callable directly (tests) or via the route handler.
 *
 * A row whose Qdrant content is unreadable, or whose entryId/fullContent would
 * fail the iOS decoder, is DROPPED (warn-logged) — never served — so one bad
 * memory cannot blank the whole section. The empty case is { entries: [] }.
 */
export async function getRecent(limit = 20): Promise<RecentResponse> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 20, 100));

  const rows = await db
    .select()
    .from(memoryIndex)
    .orderBy(desc(memoryIndex.createdAt))
    .limit(safeLimit);

  const entries: RecentEntryDTO[] = [];

  for (const r of rows) {
    // entryId is the PK; a blank here is a corrupt row — drop, don't serve.
    if (!nonBlank(r.memoryId)) {
      console.warn(`[recent] dropping memory_index row: blank memory_id`);
      continue;
    }

    // fullContent lives in Qdrant (the parent window payload content), NOT in
    // memory_index. Fetch it; an unreadable memory is dropped, not fatal.
    const point = await getMemory(r.memoryId);
    const content = point?.payload?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      console.warn(`[recent] dropping memory ${r.memoryId}: unreadable/empty Qdrant content`);
      continue;
    }

    // pulledLine: prefer the stored excerpt; fall back to an on-the-fly excerpt
    // for legacy rows (NULL pulled_line). Trim+empty-check mirrors the iOS
    // decoder (empty pulledLine => nil).
    const pulledLine = nonBlank(r.pulledLine)
      ? r.pulledLine.trim()
      : excerptFromBody(content);

    const italicEntity = await resolveItalicEntity(r.memoryId, content);

    entries.push({
      entryId: r.memoryId,
      createdAt: r.createdAt.toISOString(),
      pulledLine,
      fullContent: content,
      italicEntity,
    });
  }

  return { entries };
}
