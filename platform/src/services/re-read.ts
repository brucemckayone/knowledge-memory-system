/**
 * Re-read service (iOS API v1 — ASK-011, read-path v1).
 *
 * Composes the re-read module's read surfaces from the `re_read_letters` table
 * (migration 053). A letter is past-you speaking to current-you, synthesized
 * server-side from past entries on an open thread (design/07-modules/re-read.md
 * §"What the re-read is", §"The composed letter"). Letters are PREGENERATED —
 * iOS reads what is already prepared and NEVER waits (re-read.md §"Letters are
 * pregenerated"). This service owns the read mapping; composeReReadLetter is the
 * on-demand/seed entry that prepares a letter.
 *
 * USER/STREAM KEYING (single-user-v1): every read is scoped to the constant
 * user key 'v1', mirroring user_onboarding_state's id='v1' pin (051) and the way
 * getOpenPromises scopes to the self entity. A multi-user lift points USER_KEY at
 * the self entity id; not pre-built (fluid-contract-minimality).
 *
 * WIRE CONTRACT (camelCase — verbatim per ReReadLetter.swift CodingKeys):
 *
 *   ReReadLetter = {
 *     letterId:             <uuid>,                 // non-empty; archive identity
 *     compositionId:        <uuid>,                 // non-empty; reply-context link
 *     eyebrow:              <string>,               // non-blank; VERBATIM
 *     body:                 <string>,               // non-blank; VERBATIM (spans index in)
 *     annotations:          [{ start, end, source:{type,id} }],  // BARE array, never null
 *     isIntroLetter:        <bool>,                 // false if omitted
 *     isHardTopic:          <bool>,                 // false if omitted
 *     threadFocusEntityIds: ["<uuid>"],             // [] never null; each non-blank
 *     composedAt:           "<iso8601>",            // strict ISO-8601 Z
 *     prevReply:            { replyMemoryId, transcript, recordedAt } | absent  // null/absent → nil
 *   }
 *
 *   GET /api/re-read/current        -> { letter: ReReadLetter | null }
 *   GET /api/re-read/?threadEntityId= -> { letter: ReReadLetter | null }
 *   GET /api/re-read/all            -> { letters: [ReReadLetter, ...] }
 *
 * Decoder guarantees this service upholds (ReReadLetter.init(from:) enforces):
 *   - letterId / compositionId non-empty.
 *   - eyebrow / body non-blank (VERBATIM — never trimmed; annotation spans index
 *     into body by UTF-16 offset).
 *   - annotations is ALWAYS a bare array ([] for empty, never null).
 *   - threadFocusEntityIds is ALWAYS an array ([] for empty, never null).
 *   - composedAt is a valid ISO-8601 date.
 *   - the /all list is list-unique on letterId (the query is one row per letter,
 *     so uniqueness holds by the PK).
 *
 * NO-RESULT IS A 200 SUCCESS-SHAPE, NOT A 404 (mirrors rise.ts): getCurrentLetter
 * / getLetterByThread return null when nothing is prepared; the route wraps that
 * as { letter: null } (re-read.md §"The 'no prepared letter' state" — the caller
 * routes to explore + query, not an empty state). 500 is reserved for real
 * DB/Qdrant failure.
 *
 * PATTERNS: mirrors services/rise.ts (read-service structure + success-shape
 * discipline + getMemory content lift) and services/ask.ts (the compose →
 * AnnotationBlock mapping via composeVoiceCWithLLM).
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { getMemory } from './qdrant.js';
import {
  composeVoiceCWithLLMFallback,
  type ComposeInput,
} from './voice-c-compose-llm.js';

// =============================================================================
// Single-user-v1 key (see header).
// =============================================================================

/** The single-user-v1 row key (mirrors user_onboarding_state id='v1'). */
const USER_KEY = 'v1';

/**
 * Archive cap (re-read.md §"Capacity" — "~30 recent + intro"). The /all list
 * returns the most-recent ~30 letters PLUS the permanent intro letter.
 */
const ARCHIVE_LIMIT = 30;

// =============================================================================
// Wire DTOs (camelCase — match ReReadLetter.swift CodingKeys EXACTLY)
// =============================================================================

/** One underline span over `body`. Matches iOS AnnotationBlock's entry. */
export interface ReReadAnnotationDTO {
  /** UTF-16 code-unit start offset (inclusive). */
  start: number;
  /** UTF-16 code-unit end offset (exclusive). Always > start. */
  end: number;
  /** The source the span cites. `type` is the closed AnnotationSource set. */
  source: { type: string; id: string };
}

/** The user's prior reply to a letter (iOS PrevReply). Verbatim — NOT Voice-C. */
export interface PrevReplyDTO {
  replyMemoryId: string;
  transcript: string;
  recordedAt: string;
}

/** The composed re-read letter (iOS ReReadLetter). Field names are the pinned camelCase. */
export interface ReReadLetterDTO {
  letterId: string;
  compositionId: string;
  eyebrow: string;
  body: string;
  /** BARE array — never null. `[]` for the intro letter (cites nothing). */
  annotations: ReReadAnnotationDTO[];
  isIntroLetter: boolean;
  isHardTopic: boolean;
  /** NEVER null — `[]` when no thread (the intro letter). */
  threadFocusEntityIds: string[];
  composedAt: string;
  /** null until the user replies (iOS decodes null/absent → nil). */
  prevReply: PrevReplyDTO | null;
}

/** GET /api/re-read/current (and ?threadEntityId=) envelope. `letter: null` = no prepared letter. */
export interface ReReadCurrentResponse {
  letter: ReReadLetterDTO | null;
}

/** GET /api/re-read/all envelope. `letters: []` for empty, never null. */
export interface ReReadAllResponse {
  letters: ReReadLetterDTO[];
}

// =============================================================================
// Row shape + row → wire mapping
// =============================================================================

/** The columns a ReReadLetterDTO needs, as read from re_read_letters. */
interface ReReadRow {
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
}

/**
 * Coerce a JSONB column (which may arrive as an already-parsed object/array or as
 * a JSON string depending on the driver) to a value. Returns the fallback on
 * null/parse-failure.
 */
function parseJsonb<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/**
 * Re-shape stored annotations to the wire's {start,end,source:{type,id}} shape,
 * re-validating the UTF-16 in-bounds invariant (start >= 0, end > start, end <=
 * body.length) so a corrupt stored span cannot ship an out-of-bounds offset the
 * iOS decoder would reject (`invalidSpan`). Out-of-bounds / blank-id spans are
 * DROPPED (warn-logged) — mirrors ask.ts's toAskAnnotations posture (a dropped
 * span loses its underline; an out-of-bounds span blanks the screen).
 */
function toReReadAnnotations(body: string, raw: unknown): ReReadAnnotationDTO[] {
  const len = body.length;
  const arr = parseJsonb<Array<{ start?: unknown; end?: unknown; source?: { type?: unknown; id?: unknown } }>>(
    raw,
    [],
  );
  if (!Array.isArray(arr)) return [];
  const out: ReReadAnnotationDTO[] = [];
  for (const a of arr) {
    const start = Math.trunc(Number(a?.start));
    const end = Math.trunc(Number(a?.end));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (!(start >= 0 && end > start && end <= len)) {
      console.warn(
        `[re-read] dropping out-of-bounds span start=${start} end=${end} ` +
        `body.length=${len} (would fail iOS decoder invalidSpan)`,
      );
      continue;
    }
    const type = (typeof a?.source?.type === 'string' ? a.source.type : 'memory').trim() || 'memory';
    const id = (typeof a?.source?.id === 'string' ? a.source.id : '').trim();
    if (id.length === 0) {
      console.warn('[re-read] dropping span with blank source id');
      continue;
    }
    out.push({ start, end, source: { type, id } });
  }
  return out;
}

/** Normalize thread_focus_entity_ids JSONB → string[] (each non-blank, never null). */
function toThreadFocusIds(raw: unknown): string[] {
  const arr = parseJsonb<unknown[]>(raw, []);
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const v of arr) {
    const id = (typeof v === 'string' ? v : '').trim();
    if (id.length > 0) out.push(id);
  }
  return out;
}

/** Map prev_reply JSONB → PrevReplyDTO | null. Drops a degenerate (blank-field) reply to null. */
function toPrevReply(raw: unknown): PrevReplyDTO | null {
  const obj = parseJsonb<{ replyMemoryId?: unknown; transcript?: unknown; recordedAt?: unknown } | null>(raw, null);
  if (!obj || typeof obj !== 'object') return null;
  const replyMemoryId = (typeof obj.replyMemoryId === 'string' ? obj.replyMemoryId : '').trim();
  const transcript = typeof obj.transcript === 'string' ? obj.transcript : '';
  const recordedAt = typeof obj.recordedAt === 'string' ? obj.recordedAt : '';
  // iOS rejects blank replyMemoryId / blank transcript and requires a valid date.
  // A degenerate stored reply → null (absent) rather than a row the decoder rejects.
  if (replyMemoryId.length === 0 || transcript.trim().length === 0) return null;
  if (recordedAt.length === 0 || Number.isNaN(Date.parse(recordedAt))) return null;
  return {
    replyMemoryId,
    transcript,
    recordedAt: new Date(recordedAt).toISOString(),
  };
}

/** Coerce a composed_at column (Date or ISO string) to strict ISO-8601 Z. */
function toComposedAt(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

/**
 * Row → ReReadLetterDTO. composedAt ISO8601; annotations from jsonb (re-validated
 * in-bounds); threadFocusEntityIds always [] not null; prevReply null or nested.
 */
function toReReadLetterDTO(row: ReReadRow): ReReadLetterDTO {
  return {
    letterId: row.letter_id,
    compositionId: row.composition_id,
    eyebrow: row.eyebrow,     // VERBATIM — iOS preserves (not trimmed).
    body: row.body,           // VERBATIM — annotation spans index by offset.
    annotations: toReReadAnnotations(row.body, row.annotations),
    isIntroLetter: row.is_intro_letter,
    isHardTopic: row.is_hard_topic,
    threadFocusEntityIds: toThreadFocusIds(row.thread_focus_entity_ids),
    composedAt: toComposedAt(row.composed_at),
    prevReply: toPrevReply(row.prev_reply),
  };
}

/** The columns every read selects, in the ReReadRow shape toReReadLetterDTO reads. */
const SELECT_LETTER_COLUMNS = sql`
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
`;

// =============================================================================
// public read entry points
// =============================================================================

/**
 * The most-resonant CURRENT letter for the user (re-read.md §"Endpoints" — GET
 * /api/re-read/current). v1 "most-resonant" = the most-recently-composed
 * is_current, non-intro letter (composed_at DESC). Returns null when none is
 * prepared (the no-prepared-letter success-shape — NOT a 404).
 *
 * "Most-resonant" is UNDERSPECIFIED in v1 (the corpus implies a resonance ranking
 * we have no signal for yet); recency of the current composition is the stable,
 * deterministic proxy — adapt when a resonance signal crystallizes
 * (fluid-contract-minimality).
 */
export async function getCurrentLetter(): Promise<ReReadLetterDTO | null> {
  const rows = (await db.execute(sql`
    SELECT ${SELECT_LETTER_COLUMNS}
      FROM public.re_read_letters
     WHERE user_id = ${USER_KEY}
       AND is_current = TRUE
       AND is_intro_letter = FALSE
     ORDER BY composed_at DESC
     LIMIT 1
  `)) as unknown as ReReadRow[];

  const row = rows[0];
  return row ? toReReadLetterDTO(row) : null;
}

/**
 * The CURRENT letter for a specific thread (re-read.md §"Endpoints" — GET
 * /api/re-read/?threadEntityId=). Returns null when there is no current letter
 * for that thread (the explore + query route — NOT a 404).
 */
export async function getLetterByThread(threadEntityId: string): Promise<ReReadLetterDTO | null> {
  const id = threadEntityId?.trim();
  if (!id) return null;

  const rows = (await db.execute(sql`
    SELECT ${SELECT_LETTER_COLUMNS}
      FROM public.re_read_letters
     WHERE user_id = ${USER_KEY}
       AND is_current = TRUE
       AND thread_entity_id = ${id}::uuid
     ORDER BY composed_at DESC
     LIMIT 1
  `)) as unknown as ReReadRow[];

  const row = rows[0];
  return row ? toReReadLetterDTO(row) : null;
}

/**
 * The archive list (re-read.md §"The archive" — "~30 recent + intro"). Recent-
 * first across ALL letters (current + retained prior compositions), capped at
 * ARCHIVE_LIMIT, with the INTRO LETTER forced LAST (permanent archive-bottom).
 * letter_id is the PK, so the list is list-unique by construction (the iOS
 * ReReadAllResponse decoder rejects duplicates — they cannot occur here).
 *
 * The non-intro letters are capped to ARCHIVE_LIMIT; the intro is then appended
 * (so the cap counts "recent letters", with the intro on top of it — matching the
 * corpus "~30 recent + intro").
 */
export async function getAllLetters(): Promise<ReReadLetterDTO[]> {
  // Recent-first NON-intro letters, capped. The intro is fetched + appended
  // separately so it is always present (never pruned) and always last.
  const recentRows = (await db.execute(sql`
    SELECT ${SELECT_LETTER_COLUMNS}
      FROM public.re_read_letters
     WHERE user_id = ${USER_KEY}
       AND is_intro_letter = FALSE
     ORDER BY composed_at DESC
     LIMIT ${ARCHIVE_LIMIT}
  `)) as unknown as ReReadRow[];

  const introRows = (await db.execute(sql`
    SELECT ${SELECT_LETTER_COLUMNS}
      FROM public.re_read_letters
     WHERE user_id = ${USER_KEY}
       AND is_intro_letter = TRUE
     ORDER BY composed_at DESC
     LIMIT 1
  `)) as unknown as ReReadRow[];

  const letters = recentRows.map(toReReadLetterDTO);
  if (introRows[0]) letters.push(toReReadLetterDTO(introRows[0]));
  return letters;
}

// =============================================================================
// compose — the on-demand / seed entry (v1)
// =============================================================================

/**
 * Compose + persist a NEW re-read letter for a thread (ASK-011 read-path v1).
 * This is the on-demand / seed entry: it composes Voice-C prose over the source
 * memories' content via composeVoiceCWithLLM (surface 're-read'), maps the
 * composition → {body, annotations}, derives an eyebrow, and persists a new row
 * marked is_current for the thread (superseding the prior current row).
 *
 * Mirrors ask.ts's compose+annotation mapping precisely: each source memory's
 * Qdrant content becomes a ComposeInput part sourced at its memory id; the
 * composition's annotations map to the {start,end,source:{type,id}} wire shape
 * (re-validated in-bounds against the composed body).
 *
 * Returns the persisted letter as a DTO. Throws only on a real failure (no
 * readable source content, DB/Qdrant unreachable, compose floor failure).
 */
export async function composeReReadLetter(args: {
  threadEntityId: string;
  sourceMemoryIds: string[];
  /** Optional override for the eyebrow; otherwise derived. */
  eyebrow?: string;
  isHardTopic?: boolean;
  /** The focus-area entity ids carried into the reply's thread context. */
  threadFocusEntityIds?: string[];
}): Promise<ReReadLetterDTO> {
  const threadEntityId = args.threadEntityId?.trim();
  if (!threadEntityId) {
    throw new Error('composeReReadLetter: threadEntityId is required');
  }
  const sourceMemoryIds = (args.sourceMemoryIds ?? []).map((s) => s?.trim()).filter((s) => !!s);
  if (sourceMemoryIds.length === 0) {
    throw new Error('composeReReadLetter: at least one sourceMemoryId is required');
  }

  // 1. Lift each source memory's content from Qdrant (the same .payload.content
  //    rise.ts / recent.ts / promises.ts read). A memory with no readable content
  //    is skipped; if none are readable we cannot compose an honest letter → throw.
  const parts: ComposeInput['parts'] = [];
  for (const memoryId of sourceMemoryIds) {
    const point = await getMemory(memoryId);
    const content = point?.payload?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      console.warn(`[re-read] skipping source ${memoryId}: unreadable/empty Qdrant content`);
      continue;
    }
    parts.push({ text: content, source: { type: 'memory', id: memoryId } });
  }
  if (parts.length === 0) {
    throw new Error(
      `composeReReadLetter: no readable source content for thread=${threadEntityId} ` +
      `(sourceMemoryIds=${sourceMemoryIds.join(',')})`,
    );
  }

  const hardTopics = args.isHardTopic ?? false;

  // 2. COMPOSE — LLM first, deterministic floor on any failure. The fallback is
  //    span-bearing by construction, so the letter always carries decoder-safe
  //    annotations (re-read.md §"Underlines" — every phrase from a source is
  //    underlined; tap → rise). Mirrors ask.ts.
  const composeInput: ComposeInput = {
    parts,
    surface: 're-read',
    hardTopics,
  };
  const composition = await composeVoiceCWithLLMFallback(composeInput);
  const body = composition.text;
  if (body.trim().length === 0) {
    throw new Error(`composeReReadLetter: compose returned empty body for thread=${threadEntityId}`);
  }
  const annotations = toReReadAnnotations(body, composition.annotations);

  // 3. Derive an eyebrow (re-read.md §"Elements" — one line anchoring the letter
  //    in time + theme, e.g. "april 2024 · the honest thread"). v1 derives a
  //    month + count anchor; the override wins when provided. Lowercase (Voice-C).
  const eyebrow = (args.eyebrow?.trim() || deriveEyebrow(parts.length)).toLowerCase();

  // 4. threadFocusEntityIds — the focus-area set carried into reply context. v1
  //    defaults to [the thread entity itself] when not provided (the letter is
  //    about that thread). Each non-blank.
  const threadFocusEntityIds = toThreadFocusIds(
    args.threadFocusEntityIds ?? [threadEntityId],
  );

  // 5. PERSIST — supersede the prior current letter for this thread, then insert
  //    the new current row (a fresh composition_id). Prior compositions are
  //    immutable + retained for the archive (is_current flipped FALSE, NOT
  //    deleted). Done in a transaction so a read never sees two current rows.
  const inserted = await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE public.re_read_letters
         SET is_current = FALSE
       WHERE user_id = ${USER_KEY}
         AND thread_entity_id = ${threadEntityId}::uuid
         AND is_current = TRUE
    `);

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
        ${threadEntityId}::uuid,
        ${JSON.stringify(threadFocusEntityIds)}::jsonb,
        ${eyebrow},
        ${body},
        ${JSON.stringify(annotations)}::jsonb,
        FALSE,
        ${hardTopics},
        TRUE,
        NOW(),
        NULL
      )
      RETURNING ${SELECT_LETTER_COLUMNS}
    `)) as unknown as ReReadRow[];

    return rows[0];
  });

  if (!inserted) {
    throw new Error(`composeReReadLetter: insert returned no row for thread=${threadEntityId}`);
  }
  return toReReadLetterDTO(inserted);
}

/**
 * Derive a v1 eyebrow anchor (re-read.md §"Elements"). v1 has no theme labeller,
 * so the anchor is the current month + a source count — a stable, honest stand-in
 * ("june 2026 · 3 entries"). Lowercased by the caller. Adapt when a thread-theme
 * signal crystallizes (fluid-contract-minimality).
 */
function deriveEyebrow(sourceCount: number): string {
  const now = new Date();
  const month = now.toLocaleString('en-US', { month: 'long' });
  const year = now.getFullYear();
  const noun = sourceCount === 1 ? 'entry' : 'entries';
  return `${month} ${year} · ${sourceCount} ${noun}`;
}
