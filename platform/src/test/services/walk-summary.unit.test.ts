/**
 * Unit Tests: Walk summary-letter pregeneration skill (ASK-007, MNEMO-478.3).
 *
 * Pure unit — no live DB / Qdrant / ml-services. The external seams (getMemoryContent,
 * compose, isHardTopic) are injected via composeWalkSummary's `_deps`, and `db` (which
 * pulls config.ts → process.exit(1) without DATABASE_URL) is replaced with a small
 * stateful in-memory fake that interprets the service's SQL by its static text:
 *   - the answered-memories SELECT (the summary's sources)
 *   - the session thread SELECT
 *   - the supersede UPDATE + the INSERT INTO public.re_read_letters (returning the row)
 *   - the summary_letter_composition_id UPDATE onto walk_sessions
 *   - the composition read-back (getWalkSummaryByComposition)
 *
 * Asserts the delivered shape: the distinct `a walk · <day>` eyebrow, a 3-5-sentence-ish
 * body, in-bounds annotations, the SHARED re_read_letters persistence (is_intro_letter
 * FALSE), and that the composition_id is recorded back onto the session.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The fake db the service calls. db.transaction(cb) runs cb with the same fake (no
// real transaction needed for the in-memory model). Reassigned per test by installFakeDb().
let fakeExecute: (q: unknown) => Promise<unknown>;

vi.mock('../../db/index.js', () => ({
  db: {
    execute: (q: unknown) => fakeExecute(q),
    transaction: async (cb: (tx: { execute: (q: unknown) => Promise<unknown> }) => Promise<unknown>) =>
      cb({ execute: (q: unknown) => fakeExecute(q) }),
  },
}));
// qdrant.js / voice-c-compose-llm.js / re-read.js load config.ts at module scope; the
// real seams are injected via `_deps`, so stub these to keep the import graph off config.
vi.mock('../../services/qdrant.js', () => ({ getMemory: vi.fn(async () => null) }));
vi.mock('../../services/voice-c-compose-llm.js', () => ({
  composeVoiceCWithLLMFallback: vi.fn(),
}));
vi.mock('../../services/re-read.js', () => ({}));

import { composeWalkSummary, getWalkSummaryByComposition } from '../../services/walk-summary.js';
import type { ReReadAnnotationDTO } from '../../services/re-read.js';
import type { ComposeInput } from '../../services/voice-c-compose-llm.js';

// ---------------------------------------------------------------------------
// SQL flattening (same helper shape as walk-sessions.unit.test.ts).
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
      params.push(chunk);
      text += '?';
    }
  }
  return { text, params };
}

// ---------------------------------------------------------------------------
// Stateful in-memory fake DB. Models the session's answered questions, its thread,
// and the re_read_letters rows the summary inserts.
// ---------------------------------------------------------------------------

interface FakeLetterRow {
  letter_id: string;
  composition_id: string;
  eyebrow: string;
  body: string;
  annotations: unknown;
  is_intro_letter: boolean;
  is_hard_topic: boolean;
  is_current: boolean;
  thread_entity_id: string | null;
  thread_focus_entity_ids: unknown;
  composed_at: Date;
  prev_reply: unknown;
}

function installFakeDb(seed: {
  answerMemoryIds: string[];
  threadEntityId: string | null;
}) {
  const letters: FakeLetterRow[] = [];
  const session = {
    session_id: 'S1',
    thread_entity_id: seed.threadEntityId,
    summary_letter_composition_id: null as string | null,
  };
  let nextLetter = 0;

  fakeExecute = async (q: unknown) => {
    const { text, params } = flatten(q);

    // answered-memories SELECT.
    if (text.includes("state = 'answered'") && text.includes('answer_memory_id')) {
      return seed.answerMemoryIds.map((id) => ({ answer_memory_id: id }));
    }

    // session thread SELECT.
    if (text.includes('thread_entity_id') && text.includes('FROM public.walk_sessions') && text.includes('SELECT')) {
      return [{ thread_entity_id: session.thread_entity_id }];
    }

    // supersede prior current letter for the thread.
    if (text.includes('SET is_current = FALSE')) {
      for (const l of letters) {
        if (l.thread_entity_id === session.thread_entity_id && l.is_current) l.is_current = false;
      }
      return [];
    }

    // INSERT INTO re_read_letters.
    if (text.includes('INSERT INTO public.re_read_letters')) {
      const n = ++nextLetter;
      // params order matches the VALUES list (user_id; thread_entity_id only when
      // non-null; thread_focus_entity_ids; eyebrow; body; annotations; is_hard_topic;
      // is_current). The two JSON-string params both start with '[' — the FIRST is
      // thread_focus_entity_ids, the SECOND is annotations (VALUES order).
      const jsonParams = params.filter(
        (p) => typeof p === 'string' && (p as string).trim().startsWith('['),
      ) as string[];
      const focusJson = jsonParams[0];
      const annotationsJson = jsonParams[1];
      const eyebrow = params.find(
        (p) => typeof p === 'string' && (p as string).startsWith('a walk · '),
      ) as string;
      const row: FakeLetterRow = {
        letter_id: `L${n}`,
        composition_id: `C${n}`,
        eyebrow,
        body: COMPOSED_BODY,
        annotations: annotationsJson,
        is_intro_letter: false,
        is_hard_topic: false,
        is_current: session.thread_entity_id != null,
        thread_entity_id: session.thread_entity_id,
        thread_focus_entity_ids: focusJson,
        composed_at: new Date(),
        prev_reply: null,
      };
      letters.push(row);
      return [
        {
          letter_id: row.letter_id,
          composition_id: row.composition_id,
          eyebrow: row.eyebrow,
          body: row.body,
          annotations: row.annotations,
          is_intro_letter: row.is_intro_letter,
          is_hard_topic: row.is_hard_topic,
          thread_focus_entity_ids: row.thread_focus_entity_ids,
          composed_at: row.composed_at,
          prev_reply: row.prev_reply,
        },
      ];
    }

    // record composition_id back onto the session.
    if (text.includes('SET summary_letter_composition_id')) {
      session.summary_letter_composition_id = params[0] as string;
      return [];
    }

    // getWalkSummaryByComposition read-back.
    if (text.includes('composition_id = ') && text.includes('FROM public.re_read_letters') && text.includes('SELECT')) {
      // params: [USER_KEY, compositionId] (the query filters user_id then composition_id).
      const cid = params[params.length - 1] as string;
      const row = letters.find((l) => l.composition_id === cid);
      if (!row) return [];
      return [
        {
          letter_id: row.letter_id,
          composition_id: row.composition_id,
          eyebrow: row.eyebrow,
          body: row.body,
          annotations: row.annotations,
          is_intro_letter: row.is_intro_letter,
          is_hard_topic: row.is_hard_topic,
          thread_focus_entity_ids: row.thread_focus_entity_ids,
          composed_at: row.composed_at,
          prev_reply: row.prev_reply,
        },
      ];
    }

    throw new Error(`fake db: unhandled query: ${text.slice(0, 90)}`);
  };

  return { letters, session };
}

// A composed body with two in-bounds annotations + one out-of-bounds (dropped).
const COMPOSED_BODY =
  'you walked through the move in march. you named the cost of leaving. where does the next page begin?';
function composeStub(): { text: string; annotations: ReReadAnnotationDTO[] } {
  return {
    text: COMPOSED_BODY,
    annotations: [
      { start: 0, end: 11, source: { type: 'memory', id: 'm-1' } }, // "you walked "
      { start: 28, end: 33, source: { type: 'memory', id: 'm-2' } }, // "march"
      { start: 9000, end: 9100, source: { type: 'memory', id: 'm-bad' } }, // out of bounds → dropped
    ],
  };
}

beforeEach(() => {
  fakeExecute = async () => {
    throw new Error('fake db not installed');
  };
});

describe('composeWalkSummary (MNEMO-478.3)', () => {
  it('composes the `a walk · <day>` eyebrow, in-bounds annotations, and persists into re_read_letters', async () => {
    const { session, letters } = installFakeDb({
      answerMemoryIds: ['m-1', 'm-2'],
      threadEntityId: 'thread-1',
    });
    const getMemoryContent = vi.fn(async (id: string) => `content for ${id}`);
    const compose = vi.fn(async (_input: ComposeInput) => composeStub());

    const dto = await composeWalkSummary({
      sessionId: 'S1',
      _deps: { getMemoryContent, compose, isHardTopic: () => false },
    });

    expect(dto).not.toBeNull();
    // Distinct eyebrow form: "a walk · <weekday>" (lowercase, Voice-C).
    expect(dto!.eyebrow).toMatch(/^a walk · (monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
    // Body is the composed prose (3-5 sentences-ish — at least one terminal mark).
    expect(dto!.body).toBe(COMPOSED_BODY);
    const sentenceCount = (dto!.body.match(/[.?!]/g) ?? []).length;
    expect(sentenceCount).toBeGreaterThanOrEqual(1);
    expect(sentenceCount).toBeLessThanOrEqual(5);
    // The out-of-bounds span was dropped; the two in-bounds spans survive.
    expect(dto!.annotations).toHaveLength(2);
    for (const a of dto!.annotations) {
      expect(a.start).toBeGreaterThanOrEqual(0);
      expect(a.end).toBeGreaterThan(a.start);
      expect(a.end).toBeLessThanOrEqual(dto!.body.length);
      expect(a.source.id.length).toBeGreaterThan(0);
    }
    // Persisted into the SHARED archive as a non-intro letter.
    expect(letters).toHaveLength(1);
    expect(letters[0]?.is_intro_letter).toBe(false);
    // Lifted content from each answer memory.
    expect(getMemoryContent).toHaveBeenCalledWith('m-1');
    expect(getMemoryContent).toHaveBeenCalledWith('m-2');
    // Composed on the 'walk-summary' surface.
    expect(compose.mock.calls[0]?.[0]?.surface).toBe('walk-summary');
    // composition_id recorded back onto the session so endWalk resolves it.
    expect(session.summary_letter_composition_id).toBe(dto!.compositionId);
  });

  it('returns null when no answer sources are readable (still-settling / nothing to summarize)', async () => {
    installFakeDb({ answerMemoryIds: ['m-1'], threadEntityId: 'thread-1' });
    const getMemoryContent = vi.fn(async () => null); // unreadable
    const compose = vi.fn(async () => composeStub());

    const dto = await composeWalkSummary({
      sessionId: 'S1',
      _deps: { getMemoryContent, compose, isHardTopic: () => false },
    });

    expect(dto).toBeNull();
    // compose is never called when there are no honest sources.
    expect(compose).not.toHaveBeenCalled();
  });

  it('handles a threadless walk (is_current FALSE, no thread focus) and still persists', async () => {
    const { letters } = installFakeDb({ answerMemoryIds: ['m-1'], threadEntityId: null });
    const dto = await composeWalkSummary({
      sessionId: 'S1',
      _deps: {
        getMemoryContent: async (id) => `content ${id}`,
        compose: async () => composeStub(),
        isHardTopic: () => false,
      },
    });
    expect(dto).not.toBeNull();
    expect(dto!.threadFocusEntityIds).toEqual([]);
    expect(letters[0]?.is_current).toBe(false);
  });

  it('requires a sessionId', async () => {
    installFakeDb({ answerMemoryIds: [], threadEntityId: null });
    await expect(
      composeWalkSummary({ sessionId: '   ', _deps: { getMemoryContent: async () => 'x', compose: async () => composeStub(), isHardTopic: () => false } }),
    ).rejects.toThrow(/sessionId is required/);
  });
});

describe('getWalkSummaryByComposition (MNEMO-478.3)', () => {
  it('reads a persisted summary back by composition_id', async () => {
    installFakeDb({ answerMemoryIds: ['m-1', 'm-2'], threadEntityId: 'thread-1' });
    const dto = await composeWalkSummary({
      sessionId: 'S1',
      _deps: {
        getMemoryContent: async (id) => `content ${id}`,
        compose: async () => composeStub(),
        isHardTopic: () => false,
      },
    });
    const readBack = await getWalkSummaryByComposition(dto!.compositionId);
    expect(readBack).not.toBeNull();
    expect(readBack!.compositionId).toBe(dto!.compositionId);
    expect(readBack!.eyebrow).toBe(dto!.eyebrow);
    expect(readBack!.body).toBe(dto!.body);
    expect(readBack!.annotations).toHaveLength(2);
  });

  it('returns null for an unknown composition_id', async () => {
    installFakeDb({ answerMemoryIds: [], threadEntityId: null });
    const dto = await getWalkSummaryByComposition('00000000-0000-0000-0000-000000000099');
    expect(dto).toBeNull();
  });
});
