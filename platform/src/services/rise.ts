/**
 * Rise service (iOS API v1 — ASK-009 degraded v1, "risen plate").
 *
 * GET /api/rise/:annotationId composes the iOS `RiseData` wire shape — the
 * content that rises when the user taps an underlined phrase in composed prose
 * (design/06-rise-interaction.md §"Anatomy of a risen plate"). One tapped
 * annotation resolves to one or more SOURCE entries (the user's own prose), an
 * optional matched PATTERN ("mnemo heard this as…"), and a hard-topics flag.
 *
 * SCOPE — DEGRADED v1 (single-source, leaf):
 *   * `annotationId` is treated as a SOURCE MEMORY ID. iOS passes the memory id
 *     on a first-level rise (the recursive-dive `annotationId` dive-key is a
 *     later span, out of scope here — sources are leaves, `annotations: []`).
 *   * Exactly ZERO-OR-ONE source: the tapped memory itself. No recursive-dive
 *     spans, no multi-source fan-out.
 *
 * RELATIONSHIP to rise-context.ts (UNTOUCHED): that service composes a Voice-C
 * LETTER `{text, annotations}` for GET /api/memories/:id/context — a DIFFERENT
 * surface with a DIFFERENT output shape. This service emits the structured
 * `RiseData` plate. We REUSE its query idea (the pattern-partner join) but emit
 * our own shape; rise-context.ts is not modified and stays unmounted as before.
 *
 * WIRE CONTRACT this service must satisfy (iOS RiseData,
 * Sources/MnemoBackend/ASK/Rise/RiseData.swift) — camelCase, strict decoder:
 *
 *   {
 *     "sources": [                         // BARE array, never null; [] allowed
 *       {
 *         "memoryId":   <uuid>,            // non-empty
 *         "sourceText": <string>,          // non-blank, VERBATIM (Qdrant content)
 *         "createdAt":  <iso8601>,
 *         "strength":   1.0,               // finite double
 *         "annotations": [],               // v1: always [] (leaf — no in-quote spans)
 *         "edgeIds":    [<uuid>...],       // the memory's causal edge ids, or []
 *         "factId":     null               // v1: null (optional/additive)
 *       }
 *     ],
 *     "patternMatch": { ... } | null,      // null when no canonical pattern partner
 *     "isHardTopic": false                 // v1: always false (corpus default)
 *   }
 *
 * "SOURCE LET GO" SUCCESS-SHAPE: an unknown/blank/absent memory id is NOT a 404.
 * iOS detects empty `sources` on the SUCCESS path and renders the "this source
 * has been let go" affordance (RiseData.swift init(from:): [] is a legitimate
 * zero-source rise). So composeRise returns `{sources:[], patternMatch:null,
 * isHardTopic:false}` for a gone/unknown id; the route maps that to 200. 500 is
 * reserved for real failures (Qdrant/DB unreachable).
 *
 * PATTERNS: mirrors services/promises.ts + services/ask.ts (the iOS-wire-shape
 * discipline — camelCase, bare arrays, Qdrant content lift via getMemory).
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { getMemory } from './qdrant.js';

// =============================================================================
// Wire DTOs (camelCase — match RiseData.swift CodingKeys EXACTLY)
// =============================================================================

export interface RiseAnnotationDTO {
  annotationId: string;
  start: number;
  end: number;
  sourceMemoryId: string;
}

export interface RiseSourceDTO {
  memoryId: string;
  /** VERBATIM Qdrant content — NOT trimmed (iOS spans index into it by offset). */
  sourceText: string;
  createdAt: string;
  strength: number;
  /** v1: always [] (leaf — no in-quote recursive-dive spans). */
  annotations: RiseAnnotationDTO[];
  /** The memory's causal edge ids, or [] when none / unavailable. */
  edgeIds: string[];
  /** v1: always null (optional/additive — no fact wired to a rise source yet). */
  factId: string | null;
}

export interface PatternMatchDTO {
  patternText: string;
  partnerMemoryId: string;
  partnerExcerpt: string;
  edgeId: string;
}

export interface RiseDataDTO {
  /** BARE array — never null. [] = "source has been let go" (success-shape). */
  sources: RiseSourceDTO[];
  patternMatch: PatternMatchDTO | null;
  /** v1: always false (corpus: hard-topic detection is a later backend concern). */
  isHardTopic: boolean;
}

/** The empty / "source let go" success-shape: zero sources, no pattern. */
const SOURCE_LET_GO: RiseDataDTO = {
  sources: [],
  patternMatch: null,
  isHardTopic: false,
};

/** Cap on partner-excerpt length so the plate stays a glance, not a wall. */
const PARTNER_EXCERPT_MAX = 240;

// =============================================================================
// edge-id sourcing (cheap — the causal edges touching this memory's events)
// =============================================================================

/**
 * The causal edge ids whose cause OR effect event is sourced from this memory.
 * Backs the source's `edgeIds` (the handles act on these in 03c.4). Empty is a
 * legitimate state (a leaf capture with no promoted causal structure yet).
 * Best-effort: any failure → [] (edgeIds is additive — a missing edge list
 * never blocks the rise).
 */
async function getMemoryEdgeIds(memoryId: string): Promise<string[]> {
  try {
    const rows = (await db.execute(sql`
      SELECT DISTINCT ce.id::text AS edge_id
        FROM public.causal_events ev
        JOIN public.causal_edges ce
          ON ce.cause_event_id = ev.id OR ce.effect_event_id = ev.id
       WHERE ev.source_memory_id = ${memoryId}::uuid
         AND ce.expired_at IS NULL
    `)) as unknown as Array<{ edge_id: string }>;
    return rows.map((r) => r.edge_id);
  } catch (err) {
    console.warn(
      `[rise] edge-id lookup failed for memoryId=${memoryId}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

// =============================================================================
// pattern-partner sourcing (a REAL edge + a REAL pattern label)
// =============================================================================

interface PatternPartnerRow {
  partnerMemoryId: string;
  edgeId: string;
  /** causal_patterns.name (preferred) or description — the human pattern label. */
  patternLabel: string | null;
}

/**
 * The FIRST canonical-pattern partner of this memory, carrying a REAL
 * `edgeId` (the causal_edges row joining the two memories' events) and the
 * pattern's label. Adapted from rise-context.ts's getPatternPartners join, but
 * we additionally select the edge id + pattern name so the iOS PatternMatch can
 * carry a non-fabricated `edgeId` and `patternText` (never an invented id).
 *
 * Returns null when there is no canonical-pattern partner — the common case on
 * a fresh graph (→ patternMatch: null).
 */
async function getFirstPatternPartner(memoryId: string): Promise<PatternPartnerRow | null> {
  const rows = (await db.execute(sql`
    SELECT sibling.source_memory_id::text AS partner_memory_id,
           ce.id::text                    AS edge_id,
           cp.name                        AS pattern_name,
           cp.description                 AS pattern_description
      FROM public.causal_events this
      JOIN public.causal_edges ce
        ON ce.cause_event_id = this.id OR ce.effect_event_id = this.id
      JOIN public.causal_events sibling
        ON (ce.cause_event_id = sibling.id OR ce.effect_event_id = sibling.id)
      JOIN public.causal_patterns cp ON cp.id = ce.pattern_id
     WHERE this.source_memory_id = ${memoryId}::uuid
       AND sibling.source_memory_id IS NOT NULL
       AND sibling.source_memory_id <> ${memoryId}::uuid
       AND cp.status = 'canonical'
       AND ce.expired_at IS NULL
     ORDER BY ce.strength DESC
     LIMIT 1
  `)) as unknown as Array<{
    partner_memory_id: string;
    edge_id: string;
    pattern_name: string | null;
    pattern_description: string | null;
  }>;

  const row = rows[0];
  if (!row) return null;
  return {
    partnerMemoryId: row.partner_memory_id,
    edgeId: row.edge_id,
    patternLabel: row.pattern_name ?? row.pattern_description ?? null,
  };
}

/** Lift + truncate a partner memory's Qdrant content for `partnerExcerpt`. */
async function resolvePartnerExcerpt(partnerMemoryId: string): Promise<string | null> {
  let point: Awaited<ReturnType<typeof getMemory>>;
  try {
    point = await getMemory(partnerMemoryId);
  } catch (err) {
    console.warn(
      `[rise] partner Qdrant read failed for memoryId=${partnerMemoryId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  const content = point?.payload?.content;
  if (typeof content !== 'string' || content.trim().length === 0) return null;
  // Truncate to a glance (iOS rejects blank, but tolerates length). Keep it a
  // clean cut on a word boundary where cheap; otherwise hard-slice.
  if (content.length <= PARTNER_EXCERPT_MAX) return content;
  const slice = content.slice(0, PARTNER_EXCERPT_MAX);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > PARTNER_EXCERPT_MAX * 0.6 ? slice.slice(0, lastSpace) : slice) + '…';
}

/**
 * Compose the optional patternMatch. Returns null when there is no canonical
 * partner, OR when the partner's data can't cheaply satisfy the iOS decoder
 * (the decoder rejects a blank patternText/partnerExcerpt and an empty
 * edgeId — so a degenerate partner is dropped to null rather than fabricated).
 *
 * REAL (not invented): `edgeId` is the actual causal_edges row id; `patternText`
 * is the pattern's stored name/description. We do NOT manufacture an edge id.
 */
async function composePatternMatch(memoryId: string): Promise<PatternMatchDTO | null> {
  const partner = await getFirstPatternPartner(memoryId);
  if (!partner) return null;

  // patternText must be non-blank for the iOS decoder. If the pattern carries
  // no name/description, we have no honest label → drop to null (don't invent).
  const patternText = partner.patternLabel?.trim();
  if (!patternText) {
    console.warn(
      `[rise] dropping patternMatch for memoryId=${memoryId}: pattern ${partner.edgeId} has no name/description (no honest patternText)`,
    );
    return null;
  }

  const partnerExcerpt = await resolvePartnerExcerpt(partner.partnerMemoryId);
  if (!partnerExcerpt) {
    console.warn(
      `[rise] dropping patternMatch for memoryId=${memoryId}: partner ${partner.partnerMemoryId} excerpt unreadable`,
    );
    return null;
  }

  return {
    patternText,
    partnerMemoryId: partner.partnerMemoryId,
    partnerExcerpt,
    edgeId: partner.edgeId,
  };
}

// =============================================================================
// public entry point
// =============================================================================

/**
 * Compose the RiseData plate for `annotationId` (treated as a SOURCE MEMORY ID
 * in this degraded v1).
 *
 * Flow:
 *   1. getMemory(id) — the source body (Qdrant `.payload.content`). Absent /
 *      blank → SOURCE_LET_GO (success-shape `{sources:[], patternMatch:null,
 *      isHardTopic:false}` — NOT a 404; iOS detects empty sources).
 *   2. Build the ONE RiseSource: memoryId, sourceText VERBATIM, createdAt,
 *      strength 1.0, annotations [], edgeIds (causal edges touching the memory's
 *      events, or []), factId null.
 *   3. patternMatch: the first canonical-pattern partner with a REAL edge id +
 *      pattern label (or null when none / not honestly fillable).
 *   4. isHardTopic: false (v1).
 *
 * Throws only on a real failure (Qdrant/DB unreachable) — the route maps a
 * throw to 500. A missing memory is NOT a throw (it is the let-go success-shape).
 */
export async function composeRise(annotationId: string): Promise<RiseDataDTO> {
  const memoryId = annotationId?.trim();
  if (!memoryId) return SOURCE_LET_GO;

  // 1. The source body. A missing point / blank content is the let-go success-
  //    shape, NOT an error — iOS renders "this source has been let go".
  const point = await getMemory(memoryId);
  const content = point?.payload?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    return SOURCE_LET_GO;
  }

  // createdAt: prefer the Qdrant payload's capture timestamp; fall back to now
  // (the iOS decoder requires a valid date — a missing one would 500 the decode).
  const capturedAt = point?.payload?.captured_at;
  const createdAt =
    typeof capturedAt === 'string' && !Number.isNaN(Date.parse(capturedAt))
      ? new Date(capturedAt).toISOString()
      : new Date().toISOString();

  // 2 + 3. edge ids and pattern partner are independent best-effort lookups.
  const [edgeIds, patternMatch] = await Promise.all([
    getMemoryEdgeIds(memoryId),
    composePatternMatch(memoryId),
  ]);

  const source: RiseSourceDTO = {
    memoryId,
    sourceText: content, // VERBATIM — iOS spans index by offset (not trimmed).
    createdAt,
    strength: 1.0,
    annotations: [], // v1 leaf.
    edgeIds,
    factId: null, // v1 additive.
  };

  return {
    sources: [source],
    patternMatch,
    isHardTopic: false, // v1.
  };
}
