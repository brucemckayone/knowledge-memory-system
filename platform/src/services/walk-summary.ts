/**
 * Walk summary-letter pregeneration skill (iOS API v1 — ASK-007, MNEMO-478.3).
 *
 * Composes the walk's SUMMARY LETTER — a short, structured note shown when the user
 * ends a walk (design/07-modules/walk.md §"End walk + summary letter",
 * §"Summary letter pregeneration"). It is a SIBLING of re-read's composeReReadLetter
 * (services/re-read.ts) and MIRRORS it: lift the session's answer memories' content
 * from Qdrant, compose Voice-C prose via composeVoiceCWithLLMFallback (surface
 * 'walk-summary'), map annotations in-bounds, persist.
 *
 * SAME UI, SAME ARCHIVE (walk.md §"End walk + summary letter" — "same UI, same
 * archive, distinct eyebrow"): the summary is persisted into the EXISTING
 * public.re_read_letters table (migration 053) — NOT a parallel table — so the iOS
 * /api/re-read/all archive surfaces walk summaries automatically alongside re-read
 * letters. What distinguishes a walk summary is its eyebrow form `a walk · <day>`
 * (e.g. "a walk · tuesday"). It is is_intro_letter=FALSE, and is_current is set so the
 * thread's current letter reflects the walk where a thread is present.
 *
 * STRUCTURE (more structured than a re-read letter — walk.md §"Summary letter"):
 *   eyebrow `a walk · <day>` + an opening anchor + 1-3 insights (each a Voice-C-ish
 *   sentence naming what was filled, with underlined phrases linking to the answers
 *   via annotations) + an optional closing Voice-C question. 3-5 sentences.
 *   Encouraging, never praise. The LLM persona (surface 'walk-summary') shapes this;
 *   the deterministic floor still yields span-bearing, decoder-safe Voice-C when
 *   ml-services is unreachable.
 *
 * ASYNC PREGEN (walk.md §"Summary letter pregeneration"; mirrors ASK-011's
 * compose-as-material-lands model): the summary is composed FIRE-AND-FORGET as
 * answers land (triggerWalkSummaryPregen, called off the request path from 478.2's
 * answerWalk once >=1 answer exists, and recomposed on each subsequent answer). So
 * when the user ends the walk the letter is already prepared and /end returns it
 * INSTANTLY; if the user ends before the first compose settles, /end returns
 * summary_letter:null and iOS shows the brief `still settling…` state — endWalk
 * NEVER blocks on composition.
 *
 * The composed letter's composition_id is recorded back onto
 * walk_sessions.summary_letter_composition_id so 478.2's endWalk resolves + returns
 * the pregenerated letter.
 *
 * HARD-TOPICS (walk.md / ASK-013): v1 stub — derived false (mirrors ask.ts
 * deriveIsHardTopic / walk-questions.ts isHardTopicDefault). A real register detector
 * lands later; the suppression is wired so it just works when the signal crystallizes
 * (fluid-contract-minimality).
 *
 * SINGLE-USER-V1: scoped to user_id='v1' (mirrors re_read_letters / walk_sessions).
 *
 * PATTERNS: mirrors services/re-read.ts (composeReReadLetter's source lift → compose →
 * annotation mapping → ::text::jsonb supersede+insert) and walk-sessions.ts (the
 * injectable `_deps` test seam, parseJsonb). The external seams are injectable via
 * `_deps` so the shape/eyebrow/persist logic is unit-testable without live
 * ml-services / Qdrant / DB.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { getMemory } from './qdrant.js';
import {
  composeVoiceCWithLLMFallback,
  type ComposeInput,
} from './voice-c-compose-llm.js';
import type { ReReadLetterDTO, ReReadAnnotationDTO } from './re-read.js';

// =============================================================================
// Single-user-v1 key
// =============================================================================

/** The single-user-v1 row key (mirrors re_read_letters / walk_sessions). */
const USER_KEY = 'v1';

/** Cap on answer memories lifted into the summary compose (bounds the prompt). */
const MAX_ANSWER_SOURCES = 8;

// =============================================================================
// Injectable seams (test convention — mirrors walk-sessions.ts / walk-questions.ts)
// =============================================================================

/** The external dependencies the summary compose drives. Injectable for tests. */
export interface WalkSummaryDeps {
  /** Lift a memory's Qdrant content (the user's words) or null when unreadable. */
  getMemoryContent: (memoryId: string) => Promise<string | null>;
  /** Compose Voice-C prose + decoder-safe annotations for the summary surface. */
  compose: (input: ComposeInput) => Promise<{ text: string; annotations: ReReadAnnotationDTO[] }>;
  /** Hard-topics suppression signal (v1 stub: always false). */
  isHardTopic: (sessionId: string) => Promise<boolean> | boolean;
}

/** Lift a memory's Qdrant content (the same .payload.content rise/re-read read). */
async function getMemoryContentDefault(memoryId: string): Promise<string | null> {
  const point = await getMemory(memoryId);
  const content = point?.payload?.content;
  return typeof content === 'string' && content.trim().length > 0 ? content : null;
}

/** Compose Voice-C for the walk-summary surface; floor is span-bearing + decoder-safe. */
async function composeDefault(
  input: ComposeInput,
): Promise<{ text: string; annotations: ReReadAnnotationDTO[] }> {
  const composition = await composeVoiceCWithLLMFallback(input);
  return { text: composition.text, annotations: composition.annotations };
}

/**
 * Hard-topics suppression (walk.md / ASK-013). DEFERRED in v1: a real register
 * detector lands later; this stub keeps the suppression wired so it just works when
 * the signal crystallizes. Mirrors ask.ts deriveIsHardTopic / walk-questions.ts
 * isHardTopicDefault's conservative v1 floor.
 */
function isHardTopicDefault(_sessionId: string): boolean {
  return false;
}

const DEFAULT_DEPS: WalkSummaryDeps = {
  getMemoryContent: getMemoryContentDefault,
  compose: composeDefault,
  isHardTopic: isHardTopicDefault,
};

// =============================================================================
// Span re-validation (mirror re-read.ts toReReadAnnotations)
// =============================================================================

/**
 * Re-validate annotation spans in-bounds against the composed body (start >= 0,
 * end > start, end <= body.length, non-blank source id). Out-of-bounds / blank-id
 * spans are DROPPED (warn-logged) — a dropped span loses its underline; an
 * out-of-bounds span would blank the iOS screen (decoder invalidSpan). Mirrors
 * re-read.ts toReReadAnnotations.
 */
function toSummaryAnnotations(body: string, raw: ReReadAnnotationDTO[]): ReReadAnnotationDTO[] {
  const len = body.length;
  const out: ReReadAnnotationDTO[] = [];
  for (const a of raw ?? []) {
    const start = Math.trunc(Number(a?.start));
    const end = Math.trunc(Number(a?.end));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (!(start >= 0 && end > start && end <= len)) {
      console.warn(
        `[walk-summary] dropping out-of-bounds span start=${start} end=${end} ` +
        `body.length=${len} (would fail iOS decoder invalidSpan)`,
      );
      continue;
    }
    const type = (typeof a?.source?.type === 'string' ? a.source.type : 'memory').trim() || 'memory';
    const id = (typeof a?.source?.id === 'string' ? a.source.id : '').trim();
    if (id.length === 0) {
      console.warn('[walk-summary] dropping span with blank source id');
      continue;
    }
    out.push({ start, end, source: { type, id } });
  }
  return out;
}

// =============================================================================
// Eyebrow — the distinct `a walk · <day>` anchor
// =============================================================================

/**
 * Derive the walk summary's eyebrow (walk.md §"Summary letter" — the distinct
 * `a walk · <day>` form, e.g. "a walk · tuesday"). The day-of-week names WHEN the
 * walk happened; lowercased (Voice-C). Distinct from re-read's "month year · count"
 * eyebrow so the archive visibly differentiates a walk summary from a re-read letter.
 */
function deriveWalkEyebrow(when: Date): string {
  const day = when.toLocaleString('en-US', { weekday: 'long' }).toLowerCase();
  return `a walk · ${day}`;
}

// =============================================================================
// Session answer source lift
// =============================================================================

/** The answer memories a session produced, recency-ordered (the summary's sources). */
async function getSessionAnswerMemories(sessionId: string): Promise<string[]> {
  const id = sessionId?.trim();
  if (!id) return [];
  const rows = (await db.execute(sql`
    SELECT answer_memory_id::text AS answer_memory_id
      FROM public.walk_session_questions
     WHERE session_id = ${id}::uuid
       AND state = 'answered'
       AND answer_memory_id IS NOT NULL
     ORDER BY answered_at DESC NULLS LAST, position ASC
     LIMIT ${MAX_ANSWER_SOURCES}
  `)) as unknown as Array<{ answer_memory_id: string | null }>;
  return rows.map((r) => r.answer_memory_id).filter((m): m is string => !!m);
}

/** The thread a session targets (carried as the summary's thread_entity_id), or null. */
async function getSessionThread(sessionId: string): Promise<string | null> {
  const id = sessionId?.trim();
  if (!id) return null;
  const rows = (await db.execute(sql`
    SELECT thread_entity_id::text AS thread_entity_id
      FROM public.walk_sessions
     WHERE session_id = ${id}::uuid
       AND user_id = ${USER_KEY}
     LIMIT 1
  `)) as unknown as Array<{ thread_entity_id: string | null }>;
  const id2 = rows[0]?.thread_entity_id;
  return typeof id2 === 'string' && id2.trim().length > 0 ? id2.trim() : null;
}

// =============================================================================
// compose + persist
// =============================================================================

/**
 * Compose + persist a walk SUMMARY letter for a session (MNEMO-478.3). Lifts the
 * session's answer memories' content from Qdrant, composes Voice-C prose via the
 * 'walk-summary' surface, maps annotations in-bounds, and persists a new row into the
 * SHARED public.re_read_letters archive (is_intro_letter=FALSE, the distinct
 * `a walk · <day>` eyebrow). The new composition's composition_id is recorded back
 * onto walk_sessions.summary_letter_composition_id so endWalk resolves + returns it.
 *
 * Supersedes any prior current letter for the session's thread (so a recompose on a
 * later answer flips the prior summary's is_current FALSE and inserts a fresh one) —
 * the prior compositions are retained in the archive (immutable), mirroring
 * composeReReadLetter. A session with NO thread inserts an is_current=FALSE archive
 * row (there is no per-thread "current" to supersede).
 *
 * Returns the persisted letter as a ReReadLetterDTO, or null when there are no
 * readable answer sources yet (nothing honest to summarize — the caller treats this
 * as "not ready", and /end returns summary_letter:null).
 *
 * Throws only on a real failure (DB/Qdrant unreachable, compose floor failure).
 */
export async function composeWalkSummary(args: {
  sessionId: string;
  _deps?: Partial<WalkSummaryDeps>;
}): Promise<ReReadLetterDTO | null> {
  const deps: WalkSummaryDeps = { ...DEFAULT_DEPS, ...(args._deps ?? {}) };
  const sessionId = args.sessionId?.trim();
  if (!sessionId) {
    throw new Error('composeWalkSummary: sessionId is required');
  }

  // 1. Lift the session's answer memories' content (the user's own words from this
  //    walk). A session with no readable answers yet cannot be summarized honestly →
  //    return null ("not ready"); /end shows the still-settling state.
  const answerMemoryIds = await getSessionAnswerMemories(sessionId);
  const parts: ComposeInput['parts'] = [];
  for (const memoryId of answerMemoryIds) {
    const content = await deps.getMemoryContent(memoryId);
    if (content == null) {
      console.warn(`[walk-summary] skipping answer ${memoryId}: unreadable/empty Qdrant content`);
      continue;
    }
    parts.push({ text: content, source: { type: 'memory', id: memoryId } });
  }
  if (parts.length === 0) {
    console.log(`[walk-summary] no readable answer sources for session=${sessionId} — summary not ready`);
    return null;
  }

  const hardTopics = await deps.isHardTopic(sessionId);

  // 2. COMPOSE — LLM first (surface 'walk-summary' drives the structured opening +
  //    1-3 insights + optional closing question), deterministic floor on any failure.
  //    The fallback is span-bearing by construction, so the letter always carries
  //    decoder-safe annotations.
  const composition = await deps.compose({ parts, surface: 'walk-summary', hardTopics });
  const body = composition.text;
  if (body.trim().length === 0) {
    throw new Error(`composeWalkSummary: compose returned empty body for session=${sessionId}`);
  }
  const annotations = toSummaryAnnotations(body, composition.annotations);

  // 3. The eyebrow is the distinct `a walk · <day>` form (Voice-C lowercase).
  const eyebrow = deriveWalkEyebrow(new Date());

  // 4. The thread this walk targeted (the summary's thread_entity_id + the focus set
  //    carried into reply context). A threadless walk has no thread / focus set.
  const threadEntityId = await getSessionThread(sessionId);
  const threadFocusEntityIds = threadEntityId ? [threadEntityId] : [];

  // 5. PERSIST into the SHARED re_read_letters archive. When the walk has a thread,
  //    supersede the thread's prior current letter (a recompose on a later answer
  //    flips the prior summary's is_current FALSE) and insert the new is_current row;
  //    a threadless walk inserts an is_current=FALSE archive row (no per-thread
  //    "current" to hold). Done in a transaction so a read never sees two current
  //    rows for the thread.
  //
  // jsonb columns are written `${JSON.stringify(x)}::text::jsonb` (NOT bare `::jsonb`)
  // — a bare cast double-encodes a JS string to a JSON string scalar, breaking any
  // in-SQL key/element indexing (MNEMO-1f4; see re-read.ts).
  const isCurrent = threadEntityId != null;
  const inserted = await db.transaction(async (tx) => {
    if (threadEntityId) {
      await tx.execute(sql`
        UPDATE public.re_read_letters
           SET is_current = FALSE
         WHERE user_id = ${USER_KEY}
           AND thread_entity_id = ${threadEntityId}::uuid
           AND is_current = TRUE
      `);
    }

    const rows = (await tx.execute(sql`
      INSERT INTO public.re_read_letters (
        user_id,
        thread_entity_id,
        thread_focus_entity_ids,
        eyebrow,
        body,
        annotations,
        is_intro_letter,
        is_hard_topic,
        is_current,
        composed_at,
        prev_reply
      ) VALUES (
        ${USER_KEY},
        ${threadEntityId ? sql`${threadEntityId}::uuid` : sql`NULL`},
        ${JSON.stringify(threadFocusEntityIds)}::text::jsonb,
        ${eyebrow},
        ${body},
        ${JSON.stringify(annotations)}::text::jsonb,
        FALSE,
        ${hardTopics},
        ${isCurrent},
        NOW(),
        NULL
      )
      RETURNING
        letter_id::text              AS letter_id,
        composition_id::text         AS composition_id,
        eyebrow,
        body,
        annotations,
        is_intro_letter,
        is_hard_topic,
        thread_focus_entity_ids,
        composed_at,
        prev_reply
    `)) as unknown as Array<{
      letter_id: string;
      composition_id: string;
      eyebrow: string;
      body: string;
      annotations: unknown;
      is_intro_letter: boolean;
      is_hard_topic: boolean;
      thread_focus_entity_ids: unknown;
      composed_at: Date | string;
      prev_reply: unknown;
    }>;
    const row = rows[0];
    if (!row) {
      throw new Error(`composeWalkSummary: insert returned no row for session=${sessionId}`);
    }

    // 6. Record the composition back onto the session so endWalk resolves + returns it.
    await tx.execute(sql`
      UPDATE public.walk_sessions
         SET summary_letter_composition_id = ${row.composition_id}::uuid
       WHERE session_id = ${sessionId}::uuid
         AND user_id = ${USER_KEY}
    `);

    return row;
  });

  // 7. Re-shape the inserted row to the iOS ReReadLetterDTO. annotations/thread ids are
  //    already validated above; re-run the in-bounds guard on the read-back body so the
  //    returned DTO upholds the same decoder floor re-read.ts's reads do.
  return {
    letterId: inserted.letter_id,
    compositionId: inserted.composition_id,
    eyebrow: inserted.eyebrow,
    body: inserted.body,
    annotations: toSummaryAnnotations(inserted.body, annotations),
    isIntroLetter: inserted.is_intro_letter,
    isHardTopic: inserted.is_hard_topic,
    threadFocusEntityIds: threadFocusEntityIds,
    composedAt:
      inserted.composed_at instanceof Date
        ? inserted.composed_at.toISOString()
        : new Date(inserted.composed_at).toISOString(),
    prevReply: null,
  };
}

/**
 * Read a pregenerated walk summary letter back by its composition_id (the value
 * walk_sessions.summary_letter_composition_id holds). endWalk calls this to return the
 * letter instantly when pregen has settled; returns null when no row matches (the
 * still-settling path → summary_letter:null). Re-validates annotations in-bounds.
 */
export async function getWalkSummaryByComposition(compositionId: string): Promise<ReReadLetterDTO | null> {
  const id = compositionId?.trim();
  if (!id) return null;
  const rows = (await db.execute(sql`
    SELECT
      letter_id::text              AS letter_id,
      composition_id::text         AS composition_id,
      eyebrow,
      body,
      annotations,
      is_intro_letter,
      is_hard_topic,
      thread_focus_entity_ids,
      composed_at,
      prev_reply
      FROM public.re_read_letters
     WHERE user_id = ${USER_KEY}
       AND composition_id = ${id}::uuid
     LIMIT 1
  `)) as unknown as Array<{
    letter_id: string;
    composition_id: string;
    eyebrow: string;
    body: string;
    annotations: unknown;
    is_intro_letter: boolean;
    is_hard_topic: boolean;
    thread_focus_entity_ids: unknown;
    composed_at: Date | string;
    prev_reply: unknown;
  }>;
  const row = rows[0];
  if (!row) return null;

  const annotations = parseJsonbArray<ReReadAnnotationDTO>(row.annotations);
  const threadFocusEntityIds = parseJsonbArray<string>(row.thread_focus_entity_ids)
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0);
  return {
    letterId: row.letter_id,
    compositionId: row.composition_id,
    eyebrow: row.eyebrow,
    body: row.body,
    annotations: toSummaryAnnotations(row.body, annotations),
    isIntroLetter: row.is_intro_letter,
    isHardTopic: row.is_hard_topic,
    threadFocusEntityIds,
    composedAt:
      row.composed_at instanceof Date ? row.composed_at.toISOString() : new Date(row.composed_at).toISOString(),
    prevReply: null,
  };
}

/** Coerce a JSONB array column (parsed array or JSON string) to T[]; [] on null/parse-fail. */
function parseJsonbArray<T>(value: unknown): T[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// =============================================================================
// async pregen trigger (fire-and-forget — called off the request path from answerWalk)
// =============================================================================

/**
 * Kick a fire-and-forget walk-summary (re)compose for a session (MNEMO-478.3). Called
 * OFF the request path from 478.2's answerWalk once an answer has landed, mirroring
 * ASK-011's compose-as-material-lands model: the summary is prepared as the user
 * walks, so /end returns it instantly. NEVER awaited by the caller and NEVER throws
 * out — a compose failure lands as a warn and the next answer's trigger retries.
 *
 * Each call recomposes from ALL of the session's answers so far (composeWalkSummary
 * supersedes the prior summary), so the summary stays current with the walk.
 */
export function triggerWalkSummaryPregen(
  sessionId: string,
  deps?: Partial<WalkSummaryDeps>,
): void {
  void (async () => {
    try {
      await composeWalkSummary({ sessionId, _deps: deps });
    } catch (err) {
      console.warn(
        `[walk-summary] pregen compose failed for session=${sessionId} (will retry on next answer):`,
        err instanceof Error ? err.message : err,
      );
    }
  })();
}
