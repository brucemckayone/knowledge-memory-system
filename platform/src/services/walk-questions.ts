/**
 * Walk-question composition skill (iOS API v1 — ASK-013, degraded v1).
 *
 * A DEDICATED skill (distinct from the general reasoning agent) that composes the
 * Voice-C questions a walk presents (design/07-modules/walk.md §"Questions — where
 * they come from"; _research/backend-asks.md ASK-013). It is downstream of the
 * substrate's gap detection: the candidates already exist (findCausalGhosts); this
 * skill turns them into Voice-C questions citing the user's own words and manages
 * the per-session no-repeat contract.
 *
 * DEGRADED V1 (MNEMO-478.1) — what this slice does and does NOT do:
 *   - DOES: compose from ghost candidates, ranked by topology (ghost.confidence)
 *     + recency (entity mention_count). Caps the queue at 5-7. Never repeats a
 *     ghost pattern within a session (the caller passes excludeGhostPatternIds —
 *     478.2's lifecycle table owns the persisted per-session set).
 *   - DEFERS (fluid-contract-minimality): drift-signal weighting; the full
 *     criteria matrix (articulation-point / community participation); a real
 *     hard-topics detector (stubbed to false, mirroring ask.ts deriveIsHardTopic);
 *     resolving the SECOND entity of the missing edge (the Ghost shape carries
 *     only expected entity TYPES, not the partner id) — so target_gap's
 *     between_entity_ids is [focusEntityId] in v1.
 *
 * THE BRIDGE (why this is not a thin wrapper over findCausalGhosts): a Ghost is
 * TOPOLOGICAL — pattern position, expected entity types, a confidence and a
 * reasoning string. It carries neither the user's words nor a citable span. ASK-013
 * needs Voice-C prose ("you talked about the move in march … — where did this
 * begin?") with annotations into that prose. So per ghost the skill lifts the focus
 * entity's recent source memories (the user's own words) and composes over them via
 * composeVoiceCWithLLMFallback(surface:'walk') — the LLM persona shapes the
 * gap-question; the deterministic floor still yields span-bearing, decoder-safe
 * Voice-C when ml-services is unreachable.
 *
 * OUTPUT SHAPE (verbatim ASK-013 "Output shape per question" — snake_case, since
 * 478.2's /api/walks endpoints carry these to iOS):
 *   {
 *     question_id:    <uuid>,
 *     question_prose: <voice-c string>,
 *     annotations:    [{ start, end, source:{ type, id } }],   // BARE [], never null
 *     target_gap:     { type:'missing_causal_edge', between_entity_ids:[...], ghost_pattern_id }
 *   }
 *
 * Annotation spans are UTF-16 offsets into question_prose, re-validated in-bounds
 * (mirrors re-read.ts toReReadAnnotations) so a corrupt span never ships an
 * out-of-bounds offset the iOS decoder would reject.
 *
 * PATTERNS: mirrors services/re-read.ts (compose → annotation mapping, the
 * entity → recent-source-memories query) and services/ask.ts (the deriveIsHardTopic
 * v1 stub). The external seams are injectable via `_deps` (the same test-seam
 * convention as scheduler.ts's _setSchedulerPortForTesting) so the ranking / dedup /
 * shape logic is unit-testable without live ml-services or Qdrant.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { getMemory } from './qdrant.js';
import { findCausalGhosts, type Ghost } from './causal-patterns.js';
import {
  composeVoiceCWithLLMFallback,
  type ComposeInput,
} from './voice-c-compose-llm.js';

// =============================================================================
// Tunables (ASK-013 "Queue management" — initial 5-7; top-N by recency+topology)
// =============================================================================

/** ASK-013 initial queue target — "5-7 questions". */
const DEFAULT_QUEUE_TARGET = 7;
/** ASK-013 floor — the queue should not under-fill below this when material allows. */
const MIN_QUEUE_TARGET = 5;
/** Hard ceiling on the returned queue (defends a caller-supplied limit). */
const MAX_QUEUE_TARGET = 7;
/**
 * Working set of entities to scan for ghosts. We over-gather candidates because a
 * ghost is dropped when its focus entity has no readable source content (we cannot
 * compose an honest question citing the user's words), so the candidate pool must
 * exceed the queue target.
 */
const CANDIDATE_ENTITY_CAP = 12;
/** Recent source memories per focus entity to cite in a question (bounds compose). */
const SOURCE_MEMORY_CAP = 6;

// =============================================================================
// Wire DTOs (snake_case — ASK-013 output shape, carried verbatim by 478.2)
// =============================================================================

/** One underline span over question_prose (UTF-16 offsets). */
export interface WalkQuestionAnnotationDTO {
  start: number;
  end: number;
  source: { type: string; id: string };
}

/** The gap a question targets. v1: the missing causal edge a ghost names. */
export interface WalkQuestionTargetGap {
  type: 'missing_causal_edge';
  /**
   * The entities the missing edge is between. v1 carries [focusEntityId] only —
   * the Ghost shape exposes expected entity TYPES, not the partner id (deferred).
   */
  between_entity_ids: string[];
  /** The canonical causal pattern whose N-1-of-N coverage produced this ghost. */
  ghost_pattern_id: string;
}

/** A composed walk question (ASK-013 output shape). */
export interface WalkQuestion {
  question_id: string;
  question_prose: string;
  /** BARE array — never null. Spans index into question_prose by UTF-16 offset. */
  annotations: WalkQuestionAnnotationDTO[];
  target_gap: WalkQuestionTargetGap;
}

// =============================================================================
// Injectable seams (test convention — see scheduler.ts _setSchedulerPortForTesting)
// =============================================================================

/** One candidate focus entity + its recency rank (entity_meta.mention_count). */
export interface CandidateEntity {
  entityId: string;
  rank: number;
}

/** The external dependencies composeWalkQuestions drives. Injectable for tests. */
export interface WalkQuestionDeps {
  /** Ordered candidate focus entities to scan for ghosts (recency-ranked). */
  selectCandidateEntities: (threadEntityId: string | undefined) => Promise<CandidateEntity[]>;
  /** Topological gap candidates for one entity. */
  findCausalGhosts: (entityId: string) => Promise<Ghost[]>;
  /** Recent source memory ids linked to one entity (recency-first). */
  getEntitySourceMemories: (entityId: string) => Promise<string[]>;
  /** Lift a memory's content (the user's words) or null when unreadable. */
  getMemoryContent: (memoryId: string) => Promise<string | null>;
  /** Compose Voice-C prose + decoder-safe annotations from the source parts. */
  compose: (input: ComposeInput) => Promise<{ text: string; annotations: WalkQuestionAnnotationDTO[] }>;
  /** Hard-topics suppression signal (v1 stub: always false). */
  isHardTopic: (ghost: Ghost, entityId: string) => Promise<boolean> | boolean;
}

// =============================================================================
// Default seam implementations
// =============================================================================

/**
 * Select the recency-ranked candidate focus entities to scan for ghosts.
 *
 *   - WITH a thread: the thread entity itself (forced first) UNION the entities it
 *     shares a memory with (its neighborhood), recency-ranked by mention_count. This
 *     is the degraded stand-in for "the thread's gapped community".
 *   - WITHOUT a thread: the most-active entities overall (mention_count DESC,
 *     last_mentioned_at DESC) — the degraded stand-in for "the most-densely-gapped
 *     community at this moment" (design/07-modules/walk.md §"Entry points"). In
 *     single-user-v1 every entity is the user's, so top-active is the honest proxy.
 *
 * A cold DB (no entity_meta rows) yields [] → 0 questions, which the walk surfaces
 * as the empty "nothing to walk yet" state (walk.md §"No questions available").
 */
async function selectCandidateEntitiesDefault(threadEntityId: string | undefined): Promise<CandidateEntity[]> {
  const thread = threadEntityId?.trim();
  if (thread) {
    const rows = (await db.execute(sql`
      WITH connected AS (
        SELECT DISTINCT me2.entity_id AS entity_id
          FROM public.memory_entities me1
          JOIN public.memory_entities me2 ON me2.memory_id = me1.memory_id
         WHERE me1.entity_id = ${thread}::uuid
           AND me2.entity_id <> ${thread}::uuid
      ),
      candidates AS (
        SELECT ${thread}::uuid AS entity_id
        UNION
        SELECT entity_id FROM connected
      )
      SELECT c.entity_id::text                  AS entity_id,
             COALESCE(em.mention_count, 0)       AS rank
        FROM candidates c
        LEFT JOIN public.entity_meta em ON em.entity_id = c.entity_id
       ORDER BY (c.entity_id = ${thread}::uuid) DESC, rank DESC
       LIMIT ${CANDIDATE_ENTITY_CAP}
    `)) as unknown as Array<{ entity_id: string; rank: number }>;
    return rows.map((r) => ({ entityId: r.entity_id, rank: Number(r.rank) || 0 }));
  }

  const rows = (await db.execute(sql`
    SELECT em.entity_id::text  AS entity_id,
           em.mention_count     AS rank
      FROM public.entity_meta em
     WHERE em.mention_count >= 1
       AND em.last_mentioned_at IS NOT NULL
     ORDER BY em.mention_count DESC, em.last_mentioned_at DESC
     LIMIT ${CANDIDATE_ENTITY_CAP}
  `)) as unknown as Array<{ entity_id: string; rank: number }>;
  return rows.map((r) => ({ entityId: r.entity_id, rank: Number(r.rank) || 0 }));
}

/**
 * Recent source memory ids linked to an entity (recency-first, capped). Mirrors
 * re-read.ts getThreadSourceMemories; kept local so walk does not depend on re-read.
 */
async function getEntitySourceMemoriesDefault(entityId: string): Promise<string[]> {
  const id = entityId?.trim();
  if (!id) return [];
  const rows = (await db.execute(sql`
    SELECT memory_id::text AS memory_id
      FROM public.memory_entities
     WHERE entity_id = ${id}::uuid
     ORDER BY created_at DESC
     LIMIT ${SOURCE_MEMORY_CAP}
  `)) as unknown as Array<{ memory_id: string }>;
  return rows.map((r) => r.memory_id).filter((m) => !!m);
}

/** Lift a memory's Qdrant content (the same .payload.content rise/re-read read). */
async function getMemoryContentDefault(memoryId: string): Promise<string | null> {
  const point = await getMemory(memoryId);
  const content = point?.payload?.content;
  return typeof content === 'string' && content.trim().length > 0 ? content : null;
}

/** Compose Voice-C prose for the walk surface; floor is span-bearing + decoder-safe. */
async function composeDefault(
  input: ComposeInput,
): Promise<{ text: string; annotations: WalkQuestionAnnotationDTO[] }> {
  const composition = await composeVoiceCWithLLMFallback(input);
  return { text: composition.text, annotations: composition.annotations };
}

/**
 * Hard-topics suppression (ASK-013 "Hard-topics check"). DEFERRED in v1: a real
 * detector (drift + topic-cluster register analysis) lands later; this stub keeps
 * the suppression wired so it just works when the signal crystallizes. Mirrors
 * ask.ts deriveIsHardTopic's conservative v1 floor.
 */
function isHardTopicDefault(_ghost: Ghost, _entityId: string): boolean {
  return false;
}

const DEFAULT_DEPS: WalkQuestionDeps = {
  selectCandidateEntities: selectCandidateEntitiesDefault,
  findCausalGhosts,
  getEntitySourceMemories: getEntitySourceMemoriesDefault,
  getMemoryContent: getMemoryContentDefault,
  compose: composeDefault,
  isHardTopic: isHardTopicDefault,
};

// =============================================================================
// Span re-validation (mirror re-read.ts toReReadAnnotations)
// =============================================================================

/**
 * Re-validate annotation spans in-bounds against the composed prose (start >= 0,
 * end > start, end <= prose.length, non-blank source id). Out-of-bounds / blank-id
 * spans are DROPPED (warn-logged) — a dropped span loses its underline; an
 * out-of-bounds span would blank the iOS screen (decoder invalidSpan).
 */
function toWalkAnnotations(prose: string, raw: WalkQuestionAnnotationDTO[]): WalkQuestionAnnotationDTO[] {
  const len = prose.length;
  const out: WalkQuestionAnnotationDTO[] = [];
  for (const a of raw ?? []) {
    const start = Math.trunc(Number(a?.start));
    const end = Math.trunc(Number(a?.end));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (!(start >= 0 && end > start && end <= len)) {
      console.warn(
        `[walk-questions] dropping out-of-bounds span start=${start} end=${end} ` +
        `prose.length=${len} (would fail iOS decoder invalidSpan)`,
      );
      continue;
    }
    const type = (typeof a?.source?.type === 'string' ? a.source.type : 'memory').trim() || 'memory';
    const id = (typeof a?.source?.id === 'string' ? a.source.id : '').trim();
    if (id.length === 0) {
      console.warn('[walk-questions] dropping span with blank source id');
      continue;
    }
    out.push({ start, end, source: { type, id } });
  }
  return out;
}

// =============================================================================
// public entry point
// =============================================================================

/** A (focus entity, its ghost) pair, carrying the entity's recency rank for sort. */
interface RankedGhost {
  entityId: string;
  entityRank: number;
  ghost: Ghost;
}

/**
 * Compose the walk's question queue (ASK-013). Resolves candidate focus entities for
 * the thread (or the most-active entities when no thread), gathers their ghost
 * candidates, ranks by topology (ghost.confidence) then recency (entity rank), drops
 * session-repeats and hard-topics, and composes Voice-C questions over each focus
 * entity's recent words until the queue target is reached.
 *
 * Returns up to `limit` (default 7, clamped to 1..7) questions — fewer when the
 * graph has fewer composable gaps (an honest short queue, never padded). Never
 * returns the same ghost pattern twice in one call, and never one whose pattern id
 * is in excludeGhostPatternIds (the caller's persisted per-session set — 478.2).
 */
export async function composeWalkQuestions(args: {
  /** The thread to walk. Omit for the most-active-entities default. */
  threadEntityId?: string;
  /** Ghost pattern ids already asked this session (the no-repeat contract). */
  excludeGhostPatternIds?: string[];
  /** Queue size target. Defaults to 7; clamped to 1..MAX_QUEUE_TARGET. */
  limit?: number;
  /** Test seam — inject stub dependencies. Production passes nothing. */
  _deps?: Partial<WalkQuestionDeps>;
} = {}): Promise<WalkQuestion[]> {
  const deps: WalkQuestionDeps = { ...DEFAULT_DEPS, ...(args._deps ?? {}) };
  const target = Math.min(
    MAX_QUEUE_TARGET,
    Math.max(1, Math.trunc(args.limit ?? DEFAULT_QUEUE_TARGET) || DEFAULT_QUEUE_TARGET),
  );
  const excluded = new Set((args.excludeGhostPatternIds ?? []).map((s) => s?.trim()).filter((s) => !!s));

  // 1. Candidate focus entities, recency-ranked.
  const candidates = await deps.selectCandidateEntities(args.threadEntityId?.trim() || undefined);
  if (candidates.length === 0) return [];

  // 2. Gather each candidate's ghosts into (entity, ghost) pairs, dropping
  //    session-repeats up front. One question per ghost PATTERN: a pattern already
  //    selected (here or via the exclusion set) never recurs.
  const seenPatterns = new Set<string>(excluded);
  const ranked: RankedGhost[] = [];
  for (const cand of candidates) {
    let ghosts: Ghost[];
    try {
      ghosts = await deps.findCausalGhosts(cand.entityId);
    } catch (err) {
      console.warn(
        `[walk-questions] findCausalGhosts failed for ${cand.entityId} (continuing):`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    for (const ghost of ghosts) {
      const pid = ghost.patternId?.trim();
      if (!pid || seenPatterns.has(pid)) continue;
      seenPatterns.add(pid);
      ranked.push({ entityId: cand.entityId, entityRank: cand.rank, ghost });
    }
  }
  if (ranked.length === 0) return [];

  // 3. Rank: topology (ghost.confidence) DESC, then recency (entity rank) DESC.
  ranked.sort((a, b) => b.ghost.confidence - a.ghost.confidence || b.entityRank - a.entityRank);

  // 4. Compose questions until the target is met. A ghost whose focus entity has no
  //    readable source content is SKIPPED (cannot cite the user's words honestly);
  //    a hard-topics ghost is dropped (never surfaced). Per-ghost try/catch: one bad
  //    compose does not sink the queue.
  const questions: WalkQuestion[] = [];
  for (const r of ranked) {
    if (questions.length >= target) break;

    if (await deps.isHardTopic(r.ghost, r.entityId)) continue;

    let parts: ComposeInput['parts'];
    try {
      const memoryIds = await deps.getEntitySourceMemories(r.entityId);
      parts = [];
      for (const memoryId of memoryIds) {
        const content = await deps.getMemoryContent(memoryId);
        if (content == null) continue;
        parts.push({ text: content, source: { type: 'memory', id: memoryId } });
      }
    } catch (err) {
      console.warn(
        `[walk-questions] source lift failed for ${r.entityId} (skipping ghost):`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    if (parts.length === 0) continue; // no words to cite → cannot compose honestly

    let prose: string;
    let rawAnnotations: WalkQuestionAnnotationDTO[];
    try {
      const composition = await deps.compose({ parts, surface: 'walk', hardTopics: false });
      prose = composition.text;
      rawAnnotations = composition.annotations;
    } catch (err) {
      console.warn(
        `[walk-questions] compose failed for ${r.entityId} (skipping ghost):`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    if (prose.trim().length === 0) continue;

    questions.push({
      question_id: randomUUID(),
      question_prose: prose,
      annotations: toWalkAnnotations(prose, rawAnnotations),
      target_gap: {
        type: 'missing_causal_edge',
        between_entity_ids: [r.entityId], // v1: partner id not in the Ghost shape
        ghost_pattern_id: r.ghost.patternId,
      },
    });
  }

  // The queue target floor (MIN_QUEUE_TARGET) is aspirational — when the graph has
  // fewer composable gaps we return what is honest rather than padding. Log when we
  // under-fill so the empirical "too few ghosts" case is visible.
  if (questions.length < MIN_QUEUE_TARGET) {
    console.log(
      `[walk-questions] composed ${questions.length} question(s) (< ${MIN_QUEUE_TARGET} target floor) ` +
      `for thread=${args.threadEntityId ?? '(most-active)'} — graph has few composable gaps`,
    );
  }
  return questions;
}
