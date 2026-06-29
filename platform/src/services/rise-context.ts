/**
 * Rise-context service (iOS API v1 — ASK-009).
 *
 * GET /api/memories/:id/context composes a "rise letter": a Voice-C
 * composition that surfaces a single captured memory alongside the entities
 * it touches and the patterns it participates in. This is the FIRST consumer
 * of the LLM Voice-C compose foundation (composeVoiceCWithLLM — the rich path),
 * with the deterministic floor (composeVoiceCWithLLMFallback) as the always-
 * safe degradation.
 *
 * Division of labour (load-bearing — do not move these):
 *
 *   * THIS service owns the SOURCING — what material feeds the composition.
 *     It gathers (a) the memory body from Qdrant (getMemory — the body lives
 *     in Qdrant, NOT a Postgres memories table), (b) the memory's connected
 *     entities (memory_entities ⋈ entities), and (c) any pattern partners
 *     (causal_events ⋈ causal_edges ⋈ causal_patterns sharing this memory).
 *     Each becomes a ComposeInputPart with a source {type, id} so the lifted
 *     phrases map back to their origin.
 *
 *   * voice-c-compose-llm.ts owns the PERSONA + the UTF-16 OFFSETS. It composes
 *     the prose and emits {text, annotations} with in-bounds UTF-16 spans. On
 *     any failure it falls back to the deterministic floor — we never ship
 *     unannotated multi-sentence prose (the iOS VoiceCComposition.fromBackend
 *     decoder would throw `multiSentenceWithoutAnnotations` → blank screen).
 *
 *   * The route (routes/rise-context.ts) owns ONLY the wire concerns: the
 *     path param, the 404-on-unknown-id mapping, the 500-on-failure mapping.
 *
 * WIRE CONTRACT this service must satisfy (iOS RiseContextResponse,
 * Sources/MnemoBackend/ASK/ASK-009.swift):
 *
 *   {
 *     "text": "<composed Voice-C prose, lowercase>",
 *     "annotations": [
 *       { "start": <utf16>, "end": <utf16>, "source": { "type": "memory"|"entity", "id": "..." } }
 *     ]
 *   }
 *
 * The `annotations` field is a BARE JSON ARRAY (AnnotationBlock decodes from a
 * bare array, not a wrapper object) — null is rejected as a contract violation;
 * [] is allowed for single-sentence compositions. The iOS
 * VoiceCComposition.fromBackend(text:annotations:) validates every span's
 * `end <= text.utf16.count` and throws `invalidSpan` on overflow —
 * composeVoiceCWithLLM guarantees in-bounds spans by construction (forward-
 * cursor indexOf in UTF-16 space), so this service never hand-computes offsets.
 *
 * On sourcing failure (memory id unknown) this service THROWS a tagged error
 * (RiseContextNotFoundError) so the route can map it to 404. On compose failure
 * the LLM-fallback helper has already produced a decoder-safe composition; we
 * never reach here with unannotated multi-sentence prose.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { getMemory } from './qdrant.js';
import {
  composeVoiceCWithLLMFallback,
  type ComposeInput,
} from './voice-c-compose-llm.js';

// =============================================================================
// Errors
// =============================================================================

/** Thrown when the memory id is unknown (no Qdrant point). The route maps this
 *  to 404. Distinct from a compose failure (500) so the route can split the two. */
export class RiseContextNotFoundError extends Error {
  constructor(public readonly memoryId: string) {
    super(`rise-context: memory ${memoryId} not found`);
    this.name = 'RiseContextNotFoundError';
  }
}

// =============================================================================
// Wire DTO (camelCase — the iOS RiseContextResponse is Decodable-only and the
// Annotation wire is the bare-array shape from AnnotationBlock.swift)
// =============================================================================

/** One annotation span. `source.type` is 'memory' | 'entity' (the two source
 *  kinds this service emits; AnnotationSource accepts more but we only lift
 *  from memory bodies + connected entities today). */
export interface RiseContextAnnotation {
  /** UTF-16 code-unit offset of the phrase start in `text`. */
  start: number;
  /** UTF-16 code-unit offset one past the phrase end. */
  end: number;
  source: { type: 'memory' | 'entity'; id: string };
}

export interface RiseContextResponse {
  text: string;
  /** Bare array on the wire (AnnotationBlock decodes a bare array, rejects null). */
  annotations: RiseContextAnnotation[];
}

// =============================================================================
// Sourcing
// =============================================================================

interface ConnectedEntity {
  entityId: string;
  /** Lowercased canonical name — Voice-C is always lowercase, and the compose
   *  persona lowercases anyway; pre-lowercasing here keeps the deterministic
   *  fallback (which lowercases each part) consistent with the rich path. */
  canonicalName: string;
}

/** The memory's connected entities (memory_entities ⋈ entities). Returns the
 *  distinct entities mentioned in this memory, deduped by entity id, ordered by
 *  first mention. Empty when the memory has no extraction yet (a freshly-stored
 *  capture before the pipeline runs) — a legitimate state, not an error. */
async function getConnectedEntities(memoryId: string): Promise<ConnectedEntity[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (e.id)
           e.id::text AS entity_id,
           e.canonical_name
      FROM public.memory_entities me
      JOIN public.entities e ON e.id = me.entity_id
     WHERE me.memory_id = ${memoryId}::uuid
     ORDER BY e.id, me.created_at
  `)) as unknown as Array<{ entity_id: string; canonical_name: string }>;
  return rows.map((r) => ({
    entityId: r.entity_id,
    canonicalName: r.canonical_name,
  }));
}

interface PatternPartner {
  /** The sibling memory that shares a causal pattern with this one. */
  partnerMemoryId: string;
  /** The sibling memory's body, lifted from Qdrant (the body lives there). */
  partnerBody: string;
}

/** Pattern partners: other memories that share a promoted causal pattern with
 *  this memory (causal_events.source_memory_id links events to memories, and
 *  causal_edges.pattern_id groups events into a pattern). Returns the sibling
 *  memory ids whose events share a pattern edge with this memory's events,
 *  capped to MAX_PATTERN_PARTNERS. Empty when there are no patterns yet — the
 *  common case on a fresh graph.
 *
 *  DOCUMENTED DECISION: getPatternInstances does not exist (scoping doc), so
 *  this is a direct bounded SQL. We only surface partners sharing a PROMOTED
 *  pattern (causal_patterns.status = 'canonical') to avoid lifting staging
 *  noise into the rise letter. */
async function getPatternPartners(memoryId: string): Promise<PatternPartner[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT sibling.source_memory_id::text AS partner_memory_id
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
     LIMIT ${MAX_PATTERN_PARTNERS}
  `)) as unknown as Array<{ partner_memory_id: string }>;

  if (rows.length === 0) return [];

  // Lift each partner's body from Qdrant (the body lives there, not Postgres).
  // A partner whose Qdrant point has vanished is dropped (defensive — the join
  // row is stale). We fetch in parallel; the set is bounded to MAX.
  const lifted = await Promise.all(
    rows.map(async (r) => {
      const point = await getMemory(r.partner_memory_id);
      const body = point?.payload?.content;
      return {
        partnerMemoryId: r.partner_memory_id,
        partnerBody: typeof body === 'string' ? body : '',
      };
    }),
  );
  return lifted.filter((p) => p.partnerBody.length > 0);
}

/** Cap on pattern partners surfaced in one rise letter. The composition is a
 *  short Voice-C letter, not a survey — a handful of partners is enough signal
 *  for the "this echoes something said before" braid. */
const MAX_PATTERN_PARTNERS = 3;

// =============================================================================
// Composition
// =============================================================================

/**
 * Compose the rise letter for `memoryId`.
 *
 * Flow:
 *   1. getMemory(id) — the body (Qdrant payload `content`). 404 if absent.
 *   2. getConnectedEntities(id) + getPatternPartners(id) — the neighbor signal.
 *   3. Assemble ComposeInput parts (memory body + entity observations + partner
 *      observations, each with a source {type, id}).
 *   4. composeVoiceCWithLLMFallback — rich LLM prose with the deterministic
 *      floor as the always-safe degradation. Never returns unannotated
 *      multi-sentence prose (the multi-sentence guard inside the LLM path
 *      throws, and the fallback composes a span-per-part deterministic letter).
 *   5. Shape to RiseContextResponse (camelCase; annotations as a bare array).
 *
 * Throws RiseContextNotFoundError on an unknown memory id (route → 404). Any
 * other throw propagates to the route as 500.
 */
export async function composeRiseContext(
  memoryId: string,
): Promise<RiseContextResponse> {
  // 1. The memory body (Qdrant is the source of truth for captured content).
  const point = await getMemory(memoryId);
  if (!point || !point.payload) {
    throw new RiseContextNotFoundError(memoryId);
  }
  const body = point.payload.content;
  if (typeof body !== 'string' || body.trim().length === 0) {
    // A point exists but carries no content — treat as unknown (the rise letter
    // has nothing to rise from). The route maps this to 404, same as a missing
    // point, so iOS surfaces the "this is gone" affordance rather than a 500.
    throw new RiseContextNotFoundError(memoryId);
  }

  // 2. Neighbor signal (both are best-effort; empty is a legitimate state).
  const [entities, partners] = await Promise.all([
    getConnectedEntities(memoryId),
    getPatternPartners(memoryId),
  ]);

  // 3. Assemble compose parts. The memory body is the PRIMARY part (the thing
  //    being risen to); entities and partners are the neighbor observations that
  //    give the letter its connective tissue. Each part carries its source so
  //    lifted phrases map back to their origin in the annotations.
  const input: ComposeInput = {
    surface: 'rise',
    parts: [
      { text: body, source: { type: 'memory', id: memoryId } },
      ...entities.map((e) => ({
        text: e.canonicalName,
        source: { type: 'entity' as const, id: e.entityId },
      })),
      ...partners.map((p) => ({
        text: p.partnerBody,
        source: { type: 'memory' as const, id: p.partnerMemoryId },
      })),
    ],
  };

  // 4. Compose. composeVoiceCWithLLMFallback tries the rich LLM path, and on
  //    ANY failure (upstream-unreachable, multi-sentence-no-spans, assertVoiceC
  //    rejection) falls back to the deterministic floor — a span-per-part
  //    composition that is always decoder-safe. We never reach the return with
  //    unannotated multi-sentence prose.
  const composition = await composeVoiceCWithLLMFallback(input);

  // 5. Shape to the wire. `annotations` is a bare array (AnnotationBlock decodes
  //    a bare array; null is the contract violation). composeVoiceCWithLLM
  //    already emits {start, end, source:{type,id}} in exactly this shape, so
  //    this is a passthrough — we do NOT re-compute offsets here. The source.type
  //    narrows to 'memory'|'entity' (the only kinds our ComposeInput parts
  //    carry); a wider type would be accepted by iOS but we emit only what we
  //    sourced, so the narrowing is sound.
  const annotations: RiseContextAnnotation[] = composition.annotations.map((a) => {
    const type = a.source.type as 'memory' | 'entity';
    return {
      start: a.start,
      end: a.end,
      source: { type, id: a.source.id },
    };
  });
  return {
    text: composition.text,
    annotations,
  };
}
