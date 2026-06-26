/**
 * Unit Tests: Walk-session lifecycle service (ASK-007, MNEMO-478.2).
 *
 * Pure unit — no live DB / Qdrant / ml-services. The external seams
 * (composeWalkQuestions, store, enqueueExtraction) are injected via each entry
 * point's `_deps`, and `db.execute` is replaced with a small STATEFUL in-memory
 * fake that interprets the service's SQL by its static text (INSERT/SELECT/UPDATE
 * against walk_sessions / walk_session_questions). The fake models exactly the
 * columns the lifecycle reads back, so the tests exercise real behavior:
 *   - start composes + persists the 5-7 queue and returns it;
 *   - answer ingests (store + enqueueExtraction), marks answered, re-evals with the
 *     right exclusion set, appends new questions, hands out the next;
 *   - skip marks skipped + hands out the next;
 *   - state returns queue + answered + current position + status;
 *   - a session past the ~24h window is lazily abandoned (answer/skip → 404-equiv,
 *     state surfaces 'abandoned').
 *
 * Loading the service under the no-infra unit config pulls db/index.js (→ config.ts,
 * which process.exit(1)s without DATABASE_URL) and pipeline.js, so both are vi.mock'd
 * to inert stubs; the fake db is installed via the mocked module's `db.execute`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The fake db.execute the service calls. Reassigned per test by installFakeDb().
let fakeExecute: (q: unknown) => Promise<unknown>;

vi.mock('../../db/index.js', () => ({
  db: {
    execute: (q: unknown) => fakeExecute(q),
  },
}));
// pipeline.js is mocked to inert stubs — the real seams are injected via `_deps`.
vi.mock('../../pipeline.js', () => ({
  store: vi.fn(),
  enqueueExtraction: vi.fn(),
}));
// walk-questions.js / re-read.js are imported for types only; stub to keep the
// import graph off real config.
vi.mock('../../services/walk-questions.js', () => ({ composeWalkQuestions: vi.fn() }));
vi.mock('../../services/re-read.js', () => ({}));
// walk-summary.js pulls in qdrant + voice-c-compose-llm (→ config.ts, which
// process.exit(1)s without DATABASE_URL); mock it to inert stubs. The pregen trigger
// is injected via answerWalk's `_deps` where a test asserts on it; getWalkSummaryByComposition
// returns null so endWalk's still-settling path holds (no pregenerated letter seeded).
vi.mock('../../services/walk-summary.js', () => ({
  triggerWalkSummaryPregen: vi.fn(),
  getWalkSummaryByComposition: vi.fn(async () => null),
}));

import {
  startWalk,
  answerWalk,
  skipWalk,
  endWalk,
  getWalkState,
  isValidWalkSource,
  WalkSessionNotFoundError,
} from '../../services/walk-sessions.js';
import type { WalkQuestion } from '../../services/walk-questions.js';

// ---------------------------------------------------------------------------
// SQL flattening — reconstruct the static SQL text + the param list from a
// drizzle `sql` template so the fake can dispatch on the query.
// ---------------------------------------------------------------------------

function flatten(q: any): { text: string; params: unknown[] } {
  let text = '';
  const params: unknown[] = [];
  const chunks: any[] = q?.queryChunks ?? [];
  for (const chunk of chunks) {
    if (chunk == null) continue;
    if (chunk?.constructor?.name === 'StringChunk') {
      text += (chunk.value as string[]).join('');
    } else if (chunk?.queryChunks) {
      const inner = flatten(chunk);
      text += inner.text;
      params.push(...inner.params);
    } else if (chunk?.constructor?.name === 'Param') {
      params.push(chunk.value);
      text += '?';
    } else {
      // raw interpolated value
      params.push(chunk);
      text += '?';
    }
  }
  return { text, params };
}

// ---------------------------------------------------------------------------
// Stateful in-memory fake DB. Models walk_sessions + walk_session_questions for
// the single session under test.
// ---------------------------------------------------------------------------

interface FakeQuestion {
  question_id: string;
  position: number;
  question_prose: string;
  annotations: unknown;
  target_gap: unknown;
  ghost_pattern_id: string | null;
  state: string;
  answer_memory_id: string | null;
}

interface FakeSession {
  session_id: string;
  user_id: string;
  thread_entity_id: string | null;
  source: string | null;
  status: string;
  summary_letter_composition_id: string | null;
  updated_at: Date;
}

function installFakeDb(seed?: { session?: Partial<FakeSession>; questions?: FakeQuestion[] }) {
  const sessions = new Map<string, FakeSession>();
  let nextSessionId = 0;
  const questions: FakeQuestion[] = seed?.questions ? [...seed.questions] : [];

  if (seed?.session) {
    const s: FakeSession = {
      session_id: seed.session.session_id ?? 'S1',
      user_id: 'v1',
      thread_entity_id: seed.session.thread_entity_id ?? null,
      source: seed.session.source ?? 'radial',
      status: seed.session.status ?? 'active',
      summary_letter_composition_id: seed.session.summary_letter_composition_id ?? null,
      updated_at: seed.session.updated_at ?? new Date(),
    };
    sessions.set(s.session_id, s);
  }

  fakeExecute = async (q: unknown) => {
    const { text, params } = flatten(q);

    if (text.includes('INSERT INTO public.walk_sessions')) {
      const id = `S${++nextSessionId}`;
      sessions.set(id, {
        session_id: id,
        user_id: 'v1',
        thread_entity_id: (params[1] as string) ?? null,
        source: (params[2] as string) ?? null,
        status: 'active',
        summary_letter_composition_id: null,
        updated_at: new Date(),
      });
      return [{ session_id: id }];
    }

    if (text.includes('FROM public.walk_sessions') && text.includes('SELECT')) {
      const id = params[0] as string;
      const s = sessions.get(id);
      return s
        ? [
            {
              session_id: s.session_id,
              status: s.status,
              thread_entity_id: s.thread_entity_id,
              summary_letter_composition_id: s.summary_letter_composition_id,
              updated_at: s.updated_at,
            },
          ]
        : [];
    }

    if (text.includes("SET status = 'abandoned'")) {
      const id = params[0] as string;
      const s = sessions.get(id);
      if (s && s.status === 'active') s.status = 'abandoned';
      return [];
    }
    if (text.includes("SET status = 'ended'")) {
      const id = params[0] as string;
      const s = sessions.get(id);
      if (s && s.status === 'active') s.status = 'ended';
      return [];
    }
    if (text.includes('UPDATE public.walk_sessions') && text.includes('SET updated_at = NOW()')) {
      const id = params[0] as string;
      const s = sessions.get(id);
      if (s) s.updated_at = new Date();
      return [];
    }

    if (text.includes('INSERT INTO public.walk_session_questions')) {
      // params order matches the INSERT VALUES list.
      const [questionId, , position, prose, annotations, targetGap, ghostPatternId] = params;
      questions.push({
        question_id: questionId as string,
        position: Number(position),
        question_prose: prose as string,
        annotations,
        target_gap: targetGap,
        ghost_pattern_id: (ghostPatternId as string) ?? null,
        state: 'queued',
        answer_memory_id: null,
      });
      return [];
    }

    if (text.includes("SET state = 'answered'")) {
      const memId = params[0] as string;
      const qid = params[2] as string;
      const row = questions.find((r) => r.question_id === qid);
      if (row) {
        row.state = 'answered';
        row.answer_memory_id = memId;
      }
      return [];
    }
    if (text.includes("SET state = 'skipped'")) {
      const qid = params[1] as string;
      const row = questions.find((r) => r.question_id === qid);
      if (row) row.state = 'skipped';
      return [];
    }

    // takeNextQuestion: flip lowest-position 'queued' to 'asked', RETURNING it.
    if (text.includes("SET state = 'asked'")) {
      const queued = questions
        .filter((r) => r.state === 'queued')
        .sort((a, b) => a.position - b.position);
      const row = queued[0];
      if (!row) return [];
      row.state = 'asked';
      return [row];
    }

    if (text.includes('SELECT DISTINCT ghost_pattern_id')) {
      const set = new Set(questions.map((r) => r.ghost_pattern_id).filter((p) => p != null));
      return [...set].map((ghost_pattern_id) => ({ ghost_pattern_id }));
    }

    if (text.includes('MAX(position)')) {
      const max = questions.reduce((m, r) => Math.max(m, r.position), -1);
      return [{ max_pos: max }];
    }

    // loadQuestions: full position-ordered queue.
    if (text.includes('FROM public.walk_session_questions') && text.includes('ORDER BY position ASC')) {
      return [...questions].sort((a, b) => a.position - b.position);
    }

    throw new Error(`fake db: unhandled query: ${text.slice(0, 80)}`);
  };

  return { sessions, questions };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQuestion(id: string, ghostPatternId: string): WalkQuestion {
  return {
    question_id: id,
    question_prose: `where did ${id} begin?`,
    annotations: [{ start: 0, end: 5, source: { type: 'memory', id: `m-${id}` } }],
    target_gap: { type: 'missing_causal_edge', between_entity_ids: [`e-${id}`], ghost_pattern_id: ghostPatternId },
  };
}

/** A fully-shaped persisted question row for seeding the fake DB. */
function seedRow(
  id: string,
  ghostPatternId: string,
  position: number,
  state: string,
  answerMemoryId: string | null = null,
): FakeQuestion {
  const q = makeQuestion(id, ghostPatternId);
  return {
    question_id: id,
    position,
    question_prose: q.question_prose,
    annotations: q.annotations,
    target_gap: q.target_gap,
    ghost_pattern_id: ghostPatternId,
    state,
    answer_memory_id: answerMemoryId,
  };
}

beforeEach(() => {
  fakeExecute = async () => {
    throw new Error('fake db not installed');
  };
});

describe('startWalk (ASK-007)', () => {
  it('composes the initial queue, persists it, and returns 5-7 questions', async () => {
    installFakeDb();
    const queue = Array.from({ length: 6 }, (_, i) => makeQuestion(`q${i}`, `p${i}`));
    const composeSpy = vi.fn(async () => queue);

    const res = await startWalk({
      source: 'radial',
      threadEntityId: 'thread-1',
      _deps: { composeWalkQuestions: composeSpy as any },
    });

    expect(res.session_id).toBe('S1');
    expect(res.initial_question_queue).toHaveLength(6);
    expect(res.initial_question_queue[0]?.target_gap.ghost_pattern_id).toBe('p0');
    // composeWalkQuestions was called with the thread (no exclusion on start).
    expect(composeSpy).toHaveBeenCalledWith({ threadEntityId: 'thread-1' });
  });

  it('returns an empty queue for a cold graph (no questions available)', async () => {
    installFakeDb();
    const res = await startWalk({
      source: 'radial',
      _deps: { composeWalkQuestions: (async () => []) as any },
    });
    expect(res.initial_question_queue).toEqual([]);
  });
});

describe('answerWalk (ASK-007)', () => {
  it('ingests non-blocking, marks answered, re-evals with the exclusion set, hands out next', async () => {
    const seeded = [seedRow('q0', 'p0', 0, 'asked'), seedRow('q1', 'p1', 1, 'queued')];
    const { questions } = installFakeDb({ session: { session_id: 'S1', thread_entity_id: 'thread-1' }, questions: seeded });

    const storeSpy = vi.fn(async (_text: string, _opts?: any) => 'mem-123');
    const enqueueSpy = vi.fn();
    const composeSpy = vi.fn(async () => [] as WalkQuestion[]); // re-eval yields nothing new

    const res = await answerWalk({
      sessionId: 'S1',
      questionId: 'q0',
      transcript: 'it started in march',
      capturedAt: '2026-06-26T10:00:00Z',
      _deps: { store: storeSpy as any, enqueueExtraction: enqueueSpy as any, composeWalkQuestions: composeSpy as any },
    });

    // Non-blocking ingest: store() minted the node, extraction enqueued off-path.
    expect(storeSpy).toHaveBeenCalledTimes(1);
    expect(storeSpy.mock.calls[0]?.[0]).toBe('it started in march');
    const storeOpts = storeSpy.mock.calls[0]?.[1] as any;
    expect(storeOpts.captureContext).toEqual({ walkSessionId: 'S1', walkQuestionId: 'q0' });
    expect(storeOpts.source).toBe('ios_walk_answer');
    expect(enqueueSpy).toHaveBeenCalledWith('mem-123');

    // The answered question is marked + linked to the node.
    const q0 = questions.find((r) => r.question_id === 'q0')!;
    expect(q0.state).toBe('answered');
    expect(q0.answer_memory_id).toBe('mem-123');

    // Re-eval used the session's already-asked ghost patterns as the exclusion set.
    expect(composeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ threadEntityId: 'thread-1', excludeGhostPatternIds: expect.arrayContaining(['p0', 'p1']) }),
    );

    // Degraded-v1 wire shape: new_node_id set, new_edge_ids always [].
    expect(res.new_node_id).toBe('mem-123');
    expect(res.new_edge_ids).toEqual([]);
    // Next queued question handed out.
    expect(res.next_question?.question_id).toBe('q1');
  });

  it('appends newly composed questions from the re-eval after the current max position', async () => {
    const seeded = [seedRow('q0', 'p0', 0, 'asked')];
    const { questions } = installFakeDb({ session: { session_id: 'S1' }, questions: seeded });
    const composeSpy = vi.fn(async () => [makeQuestion('q9', 'p9')]); // a new candidate

    const res = await answerWalk({
      sessionId: 'S1',
      questionId: 'q0',
      transcript: 'an answer',
      _deps: { store: (async () => 'mem-1') as any, enqueueExtraction: (() => {}) as any, composeWalkQuestions: composeSpy as any },
    });

    const q9 = questions.find((r) => r.question_id === 'q9');
    expect(q9).toBeTruthy();
    expect(q9?.position).toBe(1); // appended after q0 (position 0)
    expect(res.next_question?.question_id).toBe('q9');
  });

  it('throws WalkSessionNotFoundError for a missing session', async () => {
    installFakeDb(); // no seeded session
    await expect(
      answerWalk({
        sessionId: 'NOPE',
        questionId: 'q0',
        transcript: 'x',
        _deps: { store: (async () => 'm') as any, enqueueExtraction: (() => {}) as any, composeWalkQuestions: (async () => []) as any },
      }),
    ).rejects.toBeInstanceOf(WalkSessionNotFoundError);
  });

  it('lazily abandons a session past the ~24h window and rejects the answer', async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const { sessions } = installFakeDb({ session: { session_id: 'S1', status: 'active', updated_at: stale } });
    await expect(
      answerWalk({
        sessionId: 'S1',
        questionId: 'q0',
        transcript: 'x',
        _deps: { store: (async () => 'm') as any, enqueueExtraction: (() => {}) as any, composeWalkQuestions: (async () => []) as any },
      }),
    ).rejects.toBeInstanceOf(WalkSessionNotFoundError);
    expect(sessions.get('S1')?.status).toBe('abandoned');
  });
});

describe('skipWalk (ASK-007)', () => {
  it('marks the question skipped and hands out the next', async () => {
    const seeded = [seedRow('q0', 'p0', 0, 'asked'), seedRow('q1', 'p1', 1, 'queued')];
    const { questions } = installFakeDb({ session: { session_id: 'S1' }, questions: seeded });

    const res = await skipWalk({ sessionId: 'S1', questionId: 'q0' });
    expect(questions.find((r) => r.question_id === 'q0')?.state).toBe('skipped');
    expect(res.next_question?.question_id).toBe('q1');
  });

  it('returns no next_question when the queue is exhausted', async () => {
    const seeded = [seedRow('q0', 'p0', 0, 'asked')];
    installFakeDb({ session: { session_id: 'S1' }, questions: seeded });
    const res = await skipWalk({ sessionId: 'S1', questionId: 'q0' });
    expect(res.next_question).toBeUndefined();
  });
});

describe('getWalkState (ASK-007)', () => {
  it('returns the queue, answered list, current position, and status', async () => {
    const seeded = [
      seedRow('q0', 'p0', 0, 'answered', 'mem-0'),
      seedRow('q1', 'p1', 1, 'asked'),
      seedRow('q2', 'p2', 2, 'queued'),
    ];
    installFakeDb({ session: { session_id: 'S1', status: 'active' }, questions: seeded });

    const state = await getWalkState({ sessionId: 'S1' });
    expect(state.session_id).toBe('S1');
    expect(state.status).toBe('active');
    expect(state.queue).toHaveLength(3);
    expect(state.queue[0]?.question_id).toBe('q0');
    expect(state.answered).toEqual([{ question_id: 'q0', answer_memory_id: 'mem-0' }]);
    // current = lowest-position not-answered/skipped (the 'asked' q1).
    expect(state.current_question_position).toBe(1);
  });

  it('surfaces an abandoned status for a stale session (no throw)', async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    installFakeDb({ session: { session_id: 'S1', status: 'active', updated_at: stale }, questions: [] });
    const state = await getWalkState({ sessionId: 'S1' });
    expect(state.status).toBe('abandoned');
    expect(state.current_question_position).toBeNull();
  });

  it('throws WalkSessionNotFoundError for a missing session', async () => {
    installFakeDb();
    await expect(getWalkState({ sessionId: 'NOPE' })).rejects.toBeInstanceOf(WalkSessionNotFoundError);
  });
});

describe('endWalk (ASK-007)', () => {
  it('flips an active session to ended and returns summary_letter null (pregen deferred to 478.3)', async () => {
    const { sessions } = installFakeDb({ session: { session_id: 'S1', status: 'active' } });
    const res = await endWalk({ sessionId: 'S1' });
    expect(res.summary_letter).toBeNull();
    expect(sessions.get('S1')?.status).toBe('ended');
  });

  it('throws WalkSessionNotFoundError for a missing session', async () => {
    installFakeDb();
    await expect(endWalk({ sessionId: 'NOPE' })).rejects.toBeInstanceOf(WalkSessionNotFoundError);
  });
});

describe('isValidWalkSource', () => {
  it('accepts the closed entry-point set and rejects others', () => {
    expect(isValidWalkSource('radial')).toBe(true);
    expect(isValidWalkSource('notification')).toBe(true);
    expect(isValidWalkSource('bridge')).toBe(true);
    expect(isValidWalkSource('teleport')).toBe(false);
    expect(isValidWalkSource(undefined)).toBe(false);
    expect(isValidWalkSource(42)).toBe(false);
  });
});
