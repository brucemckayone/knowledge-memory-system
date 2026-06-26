/**
 * Walk-session lifecycle service (iOS API v1 — ASK-007).
 *
 * Owns the start → answer → skip → end → state lifecycle of a walk session
 * (design/07-modules/walk.md §"Backend integration", §"The state machine";
 * _research/backend-asks.md ASK-007). A walk presents the user their own graph
 * gaps as Voice-C questions one at a time; each answer drops a node into the
 * constellation; ending surfaces a summary letter. This service persists the
 * session + its question queue (migration 054) so /state resumes the exact view
 * and the per-session no-repeat (excludeGhostPatternIds) holds across answers.
 *
 * QUESTION SOURCE: composeWalkQuestions (services/walk-questions.ts, MNEMO-478.1)
 * is the ASK-013 skill that composes the 5-7 questions. This service drives it —
 * once on start, again on each answer with the session's already-asked
 * ghost_pattern_ids as the exclusion set — and PERSISTS the resulting queue.
 *
 * ANSWER INGEST IS NON-BLOCKING (mirrors the /ingest handler discipline,
 * MNEMO backend-ingest-must-be-non-blocking): store() is fast (embed + Qdrant
 * upsert) and mints the memory id; the ~60s extract() graph agent runs OFF the
 * request path via enqueueExtraction. So the answer returns immediately with
 * new_node_id = the stored memory id and new_edge_ids = [] — extraction is async,
 * so edges are NOT known synchronously (degraded-v1; documented in answerWalk).
 * The ingested memory is tagged with the walk session + question via the
 * memory's capture context (store's CaptureContext.walkSessionId/walkQuestionId).
 *
 * ~24h RESUME WINDOW (walk.md §"Open questions" — ~24h resume): a session whose
 * updated_at is older than RESUME_WINDOW_MS is LAZILY flipped to 'abandoned' on
 * read (touchOrAbandon). An abandoned/ended session rejects answer/skip (404 at
 * the route); /state still returns its terminal status so iOS can route.
 *
 * SINGLE-USER-V1: every session is scoped to user_id='v1' (mirrors
 * re_read_letters / user_onboarding_state). A multi-user lift points USER_KEY at
 * the self entity id; not pre-built (fluid-contract-minimality).
 *
 * WIRE CONTRACT (snake_case — verbatim ASK-007 / walk.md §"Endpoints"):
 *
 *   WalkQuestion = { question_id, question_prose, annotations:[{start,end,source:{type,id}}], target_gap }
 *
 *   POST /api/walks
 *     body { thread_entity_id?, source:"radial"|"notification"|"bridge" }
 *     -> { session_id, initial_question_queue: [WalkQuestion, ...] }   (5-7)
 *   POST /api/walks/:id/answer
 *     body { question_id, transcript, captured_at }
 *     -> { next_question?: WalkQuestion, new_node_id: <uuid>, new_edge_ids: [] }
 *   POST /api/walks/:id/skip
 *     body { question_id }
 *     -> { next_question?: WalkQuestion }
 *   POST /api/walks/:id/end
 *     -> { summary_letter: ReReadLetterDTO | null }   (null until 478.3 wires pregen)
 *   GET  /api/walks/:id/state
 *     -> { session_id, status, queue:[WalkQuestion,...], answered:[{question_id,answer_memory_id}], current_question_position }
 *
 * PATTERNS: mirrors services/re-read.ts (parseJsonb, the ::text::jsonb INSERT,
 * single-user-v1 keying, the success-shape discipline) and walk-questions.ts (the
 * injectable `_deps` test seam so the lifecycle is unit-testable without live
 * ml-services / Qdrant / DB).
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { store, enqueueExtraction, type CaptureContext } from '../pipeline.js';
import { composeWalkQuestions, type WalkQuestion } from './walk-questions.js';
import type { ReReadLetterDTO } from './re-read.js';

// =============================================================================
// Single-user-v1 key + tunables
// =============================================================================

/** The single-user-v1 row key (mirrors re_read_letters / user_onboarding_state). */
const USER_KEY = 'v1';

/** ~24h resume window (walk.md §"Open questions"). Older sessions → abandoned. */
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The closed entry-point set (walk.md §"Entry points"). */
const VALID_SOURCES = new Set(['radial', 'notification', 'bridge']);

// =============================================================================
// Wire DTOs (snake_case — ASK-007 envelopes; WalkQuestion comes from walk-questions.ts)
// =============================================================================

/** POST /api/walks envelope. */
export interface StartWalkResponse {
  session_id: string;
  /** The composed 5-7 initial questions (ASK-013 shape). [] when the graph is cold. */
  initial_question_queue: WalkQuestion[];
}

/** POST /api/walks/:id/answer envelope. */
export interface AnswerWalkResponse {
  /** The next queued question, or absent when the queue is exhausted. */
  next_question?: WalkQuestion;
  /** The memory id the answer ingest minted (store()). */
  new_node_id: string;
  /**
   * The causal edge ids the answer produced. DEGRADED-V1: extraction is async
   * (off the request path), so edges are NOT known synchronously — always [].
   * iOS animates the placement from new_node_id; edges fill on the next graph
   * fetch after extract() completes (mirrors the /ingest 202 contract).
   */
  new_edge_ids: string[];
}

/** POST /api/walks/:id/skip envelope. */
export interface SkipWalkResponse {
  next_question?: WalkQuestion;
}

/** POST /api/walks/:id/end envelope. summary_letter null until 478.3 wires pregen. */
export interface EndWalkResponse {
  summary_letter: ReReadLetterDTO | null;
}

/** One answered question in the /state resume payload. */
export interface AnsweredQuestion {
  question_id: string;
  answer_memory_id: string | null;
}

/** GET /api/walks/:id/state resume payload. */
export interface WalkStateResponse {
  session_id: string;
  status: string;
  /** The full queue (every persisted question, position-ordered). */
  queue: WalkQuestion[];
  /** The answered list (question_id + the memory the answer minted). */
  answered: AnsweredQuestion[];
  /** Position of the current (lowest queued/asked) question, or null when none. */
  current_question_position: number | null;
}

/** Thrown when a session is missing / expired / terminal — the route maps to 404. */
export class WalkSessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`walk session not found or no longer active: ${sessionId}`);
    this.name = 'WalkSessionNotFoundError';
  }
}

// =============================================================================
// Row shapes + jsonb coercion (mirror re-read.ts parseJsonb)
// =============================================================================

interface SessionRow {
  session_id: string;
  status: string;
  thread_entity_id: string | null;
  summary_letter_composition_id: string | null;
  updated_at: Date | string;
}

interface QuestionRow {
  question_id: string;
  position: number;
  question_prose: string;
  annotations: unknown;
  target_gap: unknown;
  ghost_pattern_id: string | null;
  state: string;
  answer_memory_id: string | null;
}

/** Coerce a JSONB column (parsed object or JSON string) to a value; fallback on null/parse-fail. */
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

/** Row → WalkQuestion (the ASK-013 wire shape iOS pins). annotations always a bare []. */
function toWalkQuestion(row: QuestionRow): WalkQuestion {
  const annotations = parseJsonb<WalkQuestion['annotations']>(row.annotations, []);
  const target_gap = parseJsonb<WalkQuestion['target_gap']>(row.target_gap, {
    type: 'missing_causal_edge',
    between_entity_ids: [],
    ghost_pattern_id: row.ghost_pattern_id ?? '',
  });
  return {
    question_id: row.question_id,
    question_prose: row.question_prose,
    annotations: Array.isArray(annotations) ? annotations : [],
    target_gap,
  };
}

// =============================================================================
// Injectable seams (test convention — mirrors walk-questions.ts _deps)
// =============================================================================

/** External dependencies the lifecycle drives. Injectable for unit tests. */
export interface WalkSessionDeps {
  /** Compose the ASK-013 question queue (walk-questions.ts). */
  composeWalkQuestions: typeof composeWalkQuestions;
  /** Fast store() — mints the memory id (off-request-path extraction follows). */
  store: typeof store;
  /** Kick extraction off the request path. */
  enqueueExtraction: typeof enqueueExtraction;
}

const DEFAULT_DEPS: WalkSessionDeps = {
  composeWalkQuestions,
  store,
  enqueueExtraction,
};

// =============================================================================
// internal: persistence helpers
// =============================================================================

/**
 * Load a session, LAZILY abandoning it when stale (~24h). Returns null when the
 * session does not exist, is already terminal (ended/abandoned), or is flipped to
 * abandoned by this read. `requireActive=false` returns the row regardless of
 * status (used by /state, which surfaces a terminal status rather than 404).
 */
async function loadSession(
  sessionId: string,
  opts: { requireActive: boolean },
): Promise<SessionRow | null> {
  const id = sessionId?.trim();
  if (!id) return null;
  const rows = (await db.execute(sql`
    SELECT session_id::text                       AS session_id,
           status,
           thread_entity_id::text                  AS thread_entity_id,
           summary_letter_composition_id::text     AS summary_letter_composition_id,
           updated_at
      FROM public.walk_sessions
     WHERE session_id = ${id}::uuid
       AND user_id = ${USER_KEY}
     LIMIT 1
  `)) as unknown as SessionRow[];
  const row = rows[0];
  if (!row) return null;

  // Lazy abandon: an 'active' session past the resume window flips to 'abandoned'.
  if (row.status === 'active') {
    const updatedAt = row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at);
    if (Date.now() - updatedAt.getTime() > RESUME_WINDOW_MS) {
      await db.execute(sql`
        UPDATE public.walk_sessions
           SET status = 'abandoned'
         WHERE session_id = ${id}::uuid
           AND user_id = ${USER_KEY}
           AND status = 'active'
      `);
      row.status = 'abandoned';
    }
  }

  if (opts.requireActive && row.status !== 'active') return null;
  return row;
}

/** Load a session's full question queue, position-ordered. */
async function loadQuestions(sessionId: string): Promise<QuestionRow[]> {
  return (await db.execute(sql`
    SELECT question_id::text     AS question_id,
           position,
           question_prose,
           annotations,
           target_gap,
           ghost_pattern_id,
           state,
           answer_memory_id::text AS answer_memory_id
      FROM public.walk_session_questions
     WHERE session_id = ${sessionId}::uuid
     ORDER BY position ASC
  `)) as unknown as QuestionRow[];
}

/**
 * Persist a batch of composed questions onto a session, starting at `startPosition`.
 * Each is inserted 'queued'. ON CONFLICT (question_id) DO NOTHING — a re-eval that
 * re-mints an id never double-inserts (defensive; ids are fresh per compose).
 * jsonb columns use ${JSON.stringify(x)}::text::jsonb (NOT bare ::jsonb) — a bare
 * cast double-encodes a JS string to a JSON string scalar, breaking in-SQL
 * indexing (MNEMO-1f4; see re-read.ts).
 */
async function insertQuestions(
  sessionId: string,
  questions: WalkQuestion[],
  startPosition: number,
): Promise<void> {
  let position = startPosition;
  for (const q of questions) {
    const ghostPatternId = q.target_gap?.ghost_pattern_id ?? null;
    await db.execute(sql`
      INSERT INTO public.walk_session_questions (
        question_id, session_id, position, question_prose,
        annotations, target_gap, ghost_pattern_id, state
      ) VALUES (
        ${q.question_id}::uuid,
        ${sessionId}::uuid,
        ${position},
        ${q.question_prose},
        ${JSON.stringify(q.annotations ?? [])}::text::jsonb,
        ${JSON.stringify(q.target_gap ?? null)}::text::jsonb,
        ${ghostPatternId},
        'queued'
      )
      ON CONFLICT (question_id) DO NOTHING
    `);
    position += 1;
  }
}

/**
 * The next question to present: the lowest-position question still 'queued',
 * flipped to 'asked' as it is handed out (so a resume after a hand-out does not
 * re-issue it as "queued" — it is the current question). Returns null when the
 * queue is exhausted.
 */
async function takeNextQuestion(sessionId: string): Promise<WalkQuestion | null> {
  const rows = (await db.execute(sql`
    UPDATE public.walk_session_questions
       SET state = 'asked',
           asked_at = NOW()
     WHERE question_id = (
       SELECT question_id
         FROM public.walk_session_questions
        WHERE session_id = ${sessionId}::uuid
          AND state = 'queued'
        ORDER BY position ASC
        LIMIT 1
     )
    RETURNING question_id::text     AS question_id,
              position,
              question_prose,
              annotations,
              target_gap,
              ghost_pattern_id,
              state,
              answer_memory_id::text AS answer_memory_id
  `)) as unknown as QuestionRow[];
  const row = rows[0];
  return row ? toWalkQuestion(row) : null;
}

/** The set of ghost_pattern_ids already in a session's queue (the no-repeat exclusion). */
async function askedGhostPatternIds(sessionId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT ghost_pattern_id
      FROM public.walk_session_questions
     WHERE session_id = ${sessionId}::uuid
       AND ghost_pattern_id IS NOT NULL
  `)) as unknown as Array<{ ghost_pattern_id: string | null }>;
  return rows.map((r) => r.ghost_pattern_id).filter((p): p is string => !!p);
}

/** Bump updated_at (last activity) so the ~24h resume window measures from now. */
async function touchSession(sessionId: string): Promise<void> {
  await db.execute(sql`
    UPDATE public.walk_sessions
       SET updated_at = NOW()
     WHERE session_id = ${sessionId}::uuid
       AND user_id = ${USER_KEY}
  `);
}

// =============================================================================
// public lifecycle entry points
// =============================================================================

/**
 * POST /api/walks — start a walk session (ASK-007). Inserts a session row, composes
 * the initial 5-7 questions via composeWalkQuestions({threadEntityId}), persists
 * them as the queue, and returns { session_id, initial_question_queue }. A cold
 * graph yields an empty queue (walk.md §"No questions available" — the empty state).
 */
export async function startWalk(args: {
  threadEntityId?: string;
  source: string;
  _deps?: Partial<WalkSessionDeps>;
}): Promise<StartWalkResponse> {
  const deps: WalkSessionDeps = { ...DEFAULT_DEPS, ...(args._deps ?? {}) };
  const threadEntityId = args.threadEntityId?.trim() || undefined;
  const source = (args.source ?? '').trim();

  const sessionRows = (await db.execute(sql`
    INSERT INTO public.walk_sessions (user_id, thread_entity_id, source, status)
    VALUES (
      ${USER_KEY},
      ${threadEntityId ? sql`${threadEntityId}::uuid` : sql`NULL`},
      ${source || null},
      'active'
    )
    RETURNING session_id::text AS session_id
  `)) as unknown as Array<{ session_id: string }>;
  const sessionId = sessionRows[0]!.session_id;

  const queue = await deps.composeWalkQuestions({ threadEntityId });
  await insertQuestions(sessionId, queue, 0);

  return { session_id: sessionId, initial_question_queue: queue };
}

/**
 * POST /api/walks/:id/answer — submit an answer segment (ASK-007). NON-BLOCKING:
 * store() mints the memory id (tagged with the walk session + question), extraction
 * is enqueued OFF the request path. Marks the question answered, re-evaluates the
 * queue (composeWalkQuestions with the session's already-asked ghost_pattern_ids as
 * the exclusion set; new questions are appended), and returns the next question.
 *
 * Throws WalkSessionNotFoundError when the session is missing/terminal (route → 404).
 */
export async function answerWalk(args: {
  sessionId: string;
  questionId: string;
  transcript: string;
  capturedAt?: string;
  _deps?: Partial<WalkSessionDeps>;
}): Promise<AnswerWalkResponse> {
  const deps: WalkSessionDeps = { ...DEFAULT_DEPS, ...(args._deps ?? {}) };
  const session = await loadSession(args.sessionId, { requireActive: true });
  if (!session) throw new WalkSessionNotFoundError(args.sessionId);
  const sessionId = session.session_id;
  const questionId = args.questionId?.trim();
  if (!questionId) throw new Error('answerWalk: questionId is required');

  // 1. NON-BLOCKING INGEST (mirror the /ingest handler): store() is fast and mints
  //    the memory id; the ~60s extract() runs off the request path via
  //    enqueueExtraction. The answer memory is tagged with the walk session +
  //    question so the substrate links the new node to the walked thread.
  const captureContext: CaptureContext = {
    walkSessionId: sessionId,
    walkQuestionId: questionId,
  };
  const transcript = typeof args.transcript === 'string' ? args.transcript : '';
  let capturedAt: Date | undefined;
  if (typeof args.capturedAt === 'string' && args.capturedAt.trim().length > 0) {
    const parsed = new Date(args.capturedAt);
    if (!Number.isNaN(parsed.getTime())) capturedAt = parsed;
  }
  const newNodeId = await deps.store(transcript, {
    source: 'ios_walk_answer',
    timestamp: capturedAt,
    captureContext,
  });
  deps.enqueueExtraction(newNodeId);

  // 2. Mark the answered question (best-effort match on this session). answer_memory_id
  //    links the question to the node the answer minted (the /state answered list).
  await db.execute(sql`
    UPDATE public.walk_session_questions
       SET state = 'answered',
           answer_memory_id = ${newNodeId}::uuid,
           answered_at = NOW()
     WHERE session_id = ${sessionId}::uuid
       AND question_id = ${questionId}::uuid
  `);
  await touchSession(sessionId);

  // 3. RE-EVAL the queue (walk.md §"Question selection", §"Refresh of ghost
  //    candidates"). New ghost candidates from the answer's content may join; the
  //    session's already-asked ghost_pattern_ids are the no-repeat exclusion set.
  //    New questions are appended after the current max position. The substrate's
  //    fresh gaps are not visible synchronously (extraction is async), so this
  //    re-eval surfaces gaps already present — an honest degraded-v1 re-eval.
  const exclude = await askGhostExclusion(sessionId);
  let appended: WalkQuestion[] = [];
  try {
    appended = await deps.composeWalkQuestions({
      threadEntityId: session.thread_entity_id ?? undefined,
      excludeGhostPatternIds: exclude,
    });
  } catch (err) {
    console.warn(
      `[walk-sessions] re-eval composeWalkQuestions failed for session=${sessionId} (continuing):`,
      err instanceof Error ? err.message : err,
    );
  }
  if (appended.length > 0) {
    const maxPos = await nextPosition(sessionId);
    await insertQuestions(sessionId, appended, maxPos);
  }

  // 4. Hand out the next queued question (flipped 'asked'). May be absent when the
  //    queue is exhausted (the walk encourages ending).
  const next = await takeNextQuestion(sessionId);
  const resp: AnswerWalkResponse = { new_node_id: newNodeId, new_edge_ids: [] };
  if (next) resp.next_question = next;
  return resp;
}

/**
 * POST /api/walks/:id/skip — skip the current question (ASK-007). Marks it 'skipped'
 * (silent; walk.md §"Skipping a question") and returns the next queued question.
 * Throws WalkSessionNotFoundError when the session is missing/terminal (route → 404).
 */
export async function skipWalk(args: {
  sessionId: string;
  questionId: string;
}): Promise<SkipWalkResponse> {
  const session = await loadSession(args.sessionId, { requireActive: true });
  if (!session) throw new WalkSessionNotFoundError(args.sessionId);
  const sessionId = session.session_id;
  const questionId = args.questionId?.trim();
  if (!questionId) throw new Error('skipWalk: questionId is required');

  await db.execute(sql`
    UPDATE public.walk_session_questions
       SET state = 'skipped'
     WHERE session_id = ${sessionId}::uuid
       AND question_id = ${questionId}::uuid
  `);
  await touchSession(sessionId);

  const next = await takeNextQuestion(sessionId);
  const resp: SkipWalkResponse = {};
  if (next) resp.next_question = next;
  return resp;
}

/**
 * POST /api/walks/:id/end — end the session (ASK-007). Flips status to 'ended' and
 * returns the pregenerated summary letter when one exists (478.3 wires the pregen
 * via summary_letter_composition_id), else { summary_letter: null }. In THIS task the
 * pregen is not wired, so summary_letter is null until 478.3 lands.
 * Throws WalkSessionNotFoundError when the session is missing (route → 404). An
 * already-ended session is idempotently re-ended (returns its current summary).
 */
export async function endWalk(args: { sessionId: string }): Promise<EndWalkResponse> {
  // requireActive=false: re-ending an already-ended session is idempotent. Only a
  // truly missing session is a 404.
  const session = await loadSession(args.sessionId, { requireActive: false });
  if (!session) throw new WalkSessionNotFoundError(args.sessionId);
  const sessionId = session.session_id;

  if (session.status === 'active') {
    await db.execute(sql`
      UPDATE public.walk_sessions
         SET status = 'ended', updated_at = NOW()
       WHERE session_id = ${sessionId}::uuid
         AND user_id = ${USER_KEY}
         AND status = 'active'
    `);
  }

  // 478.3 wires the pregen: when summary_letter_composition_id points at a composed
  // re_read_letters row, return that letter. In THIS task no pregen exists, so the
  // letter is null (iOS shows the brief `still settling…` state, ASK-007). Reading
  // the letter row is deferred to 478.3's wiring — returning null here is the
  // documented degraded-v1 behavior.
  return { summary_letter: null };
}

/**
 * GET /api/walks/:id/state — the resume payload (ASK-007). Returns the full queue,
 * the answered list, the current-question position, and the session status. Lazily
 * abandons a stale session (the status reflects it). Throws WalkSessionNotFoundError
 * only when the session does not exist (route → 404); a terminal session returns its
 * status so iOS routes to the summary / a fresh walk.
 */
export async function getWalkState(args: { sessionId: string }): Promise<WalkStateResponse> {
  const session = await loadSession(args.sessionId, { requireActive: false });
  if (!session) throw new WalkSessionNotFoundError(args.sessionId);
  const sessionId = session.session_id;

  const rows = await loadQuestions(sessionId);
  const queue = rows.map(toWalkQuestion);
  const answered: AnsweredQuestion[] = rows
    .filter((r) => r.state === 'answered')
    .map((r) => ({ question_id: r.question_id, answer_memory_id: r.answer_memory_id }));

  // The current question is the lowest-position question not yet answered/skipped
  // (an 'asked' one already handed out, else the next 'queued'). null when none.
  const current = rows.find((r) => r.state === 'asked' || r.state === 'queued');

  return {
    session_id: sessionId,
    status: session.status,
    queue,
    answered,
    current_question_position: current ? current.position : null,
  };
}

// =============================================================================
// internal: small query helpers used by the lifecycle entry points
// =============================================================================

/** The session's already-asked ghost_pattern_ids (the no-repeat exclusion set). */
async function askGhostExclusion(sessionId: string): Promise<string[]> {
  return askedGhostPatternIds(sessionId);
}

/** The next free position (max(position)+1, or 0 when the queue is empty). */
async function nextPosition(sessionId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT COALESCE(MAX(position), -1) AS max_pos
      FROM public.walk_session_questions
     WHERE session_id = ${sessionId}::uuid
  `)) as unknown as Array<{ max_pos: number }>;
  const raw = Number(rows[0]?.max_pos ?? -1);
  const max = Number.isFinite(raw) ? raw : -1;
  return max + 1;
}

/** Validate the entry-point source against the closed ASK-007 set. */
export function isValidWalkSource(source: unknown): source is string {
  return typeof source === 'string' && VALID_SOURCES.has(source.trim());
}
