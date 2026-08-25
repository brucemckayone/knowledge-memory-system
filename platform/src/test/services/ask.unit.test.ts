/**
 * Unit tests for the ask service (MNEMO-96o8.3 / ASK-015 `POST /api/ask`).
 *
 * PURE unit tests: `search`, the compose seam, and `db` are all mocked, so the
 * subject under test is the DECISION LOGIC — what reaches the composer, when
 * the pool is allowed to be quiet, and what the wire carries.
 *
 * These pin the four behaviours the pre-96o8 service got wrong:
 *
 *   1. The QUERY reaches the composer (it previously did not exist in the
 *      compose input at all, so the "answer" was a summary of the eight
 *      nearest memories).
 *   2. EXCERPTS reach the composer, not whole parent-window bodies.
 *   3. The pool may be QUIET. `answer: null` previously required a literally
 *      empty result set — unreachable on a populated graph — so every question
 *      got a confident answer from whatever was nearest in vector space.
 *   4. A composition failure degrades to the quiet result, NOT to stitched raw
 *      entries. The old deterministic floor concatenated eight lowercased
 *      window bodies, every one underlined: the "page of links" bug.
 *
 * Env note: the service imports `db` (→ `config`, which zod-validates
 * DATABASE_URL at module load), so the runner must provide DATABASE_URL. No
 * connection is opened — `db.execute` is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted by vitest before the SUT import) -----------------------

const searchMock = vi.fn();
vi.mock('../../services/search.js', () => ({
  search: (...args: unknown[]) => searchMock(...args),
}));

const composeMock = vi.fn();
vi.mock('../../services/voice-c-ask-llm.js', async () => {
  class AskLLMError extends Error {
    constructor(public readonly reason: string, message: string) {
      super(message);
      this.name = 'AskLLMError';
    }
  }
  return {
    AskLLMError,
    composeAskWithLLM: (...args: unknown[]) => composeMock(...args),
  };
});

const executeMock = vi.fn();
vi.mock('../../db/index.js', () => ({
  db: { execute: (...args: unknown[]) => executeMock(...args) },
}));

import { answerQuery, dateProse } from '../../services/ask.js';
import { AskLLMError } from '../../services/voice-c-ask-llm.js';

// --- helpers ---------------------------------------------------------------

/** A search result with the fields the ask path reads. */
function result(over: Partial<{
  memoryId: string;
  score: number;
  content: string;
  excerpt: string;
  vectorScore: number;
  createdAt: string;
  matchedUnits: number;
  arms: Array<'vector' | 'graph'>;
}> = {}) {
  return {
    memoryId: over.memoryId ?? 'mem-1',
    score: over.score ?? 0.016,
    content: over.content ?? 'A long parent window body with lots of surrounding prose in it.',
    excerpt: over.excerpt ?? 'I think we might actually leave the city.',
    vectorScore: over.vectorScore ?? 0.72,
    createdAt: over.createdAt ?? '2026-03-03T09:00:00.000Z',
    matchedUnits: over.matchedUnits ?? 2,
    arms: over.arms ?? (['vector'] as Array<'vector' | 'graph'>),
  };
}

function composed(over: Partial<{ text: string; answered: boolean }> = {}) {
  return {
    text: over.text ?? 'the first time was in march.',
    annotations: [],
    answered: over.answered ?? true,
  };
}

beforeEach(() => {
  searchMock.mockReset();
  composeMock.mockReset();
  executeMock.mockReset();
  executeMock.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// The quiet result — reachable at last
// ---------------------------------------------------------------------------

describe('answerQuery — when the pool has nothing to say', () => {
  it('returns the quiet result for a blank query without searching', async () => {
    const r = await answerQuery('   ');
    expect(r.answer).toBeNull();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('returns the quiet result when retrieval finds nothing', async () => {
    searchMock.mockResolvedValue({ results: [] });
    const r = await answerQuery('what did i say about the move?');
    expect(r.answer).toBeNull();
    expect(composeMock).not.toHaveBeenCalled();
  });

  it('returns the quiet result when retrieval is degenerate', async () => {
    // Below the noise band entirely — a broken or empty vector store, not a
    // merely unanswerable question. (Unanswerable-but-present is the
    // composer's call; see the honest-absence test below and the measurements
    // on ASK_ANSWER_MIN_SCORE for why no absolute threshold can separate them.)
    searchMock.mockResolvedValue({
      results: [
        result({ memoryId: 'a', vectorScore: 0.41 }),
        result({ memoryId: 'b', vectorScore: 0.38 }),
        result({ memoryId: 'c', vectorScore: 0.30 }),
      ],
    });
    const r = await answerQuery('what did i say about quantum mechanics?');
    expect(r.answer).toBeNull();
    // No composition call on degenerate retrieval.
    expect(composeMock).not.toHaveBeenCalled();
  });

  it('still composes inside the noise band — the composer judges answerability', async () => {
    // Gibberish and real questions BOTH land here (measured 0.52-0.63), so the
    // service must not pre-judge: it composes and lets the composer say whether
    // the passages answer the question.
    searchMock.mockResolvedValue({ results: [result({ vectorScore: 0.53 })] });
    composeMock.mockResolvedValue(composed({ text: 'nothing here about that at all.', answered: false }));
    const { answer } = await answerQuery('what did i say about lattice gauge theory?');
    expect(composeMock).toHaveBeenCalledTimes(1);
    expect(answer!.answerText).toBe('nothing here about that at all.');
  });

  it('returns the quiet result when composition fails — never stitched raw entries', async () => {
    searchMock.mockResolvedValue({ results: [result({ vectorScore: 0.8 })] });
    composeMock.mockRejectedValue(new AskLLMError('upstream-unreachable', 'ml-services down'));
    const r = await answerQuery('where did the move first come up?');
    expect(r.answer).toBeNull();
  });

  it('returns the quiet result when composition comes back blank', async () => {
    searchMock.mockResolvedValue({ results: [result({ vectorScore: 0.8 })] });
    composeMock.mockResolvedValue({ text: '   ', annotations: [], answered: true });
    const r = await answerQuery('where did the move first come up?');
    expect(r.answer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What reaches the composer
// ---------------------------------------------------------------------------

describe('answerQuery — the compose input', () => {
  it('passes the QUESTION through to composition', async () => {
    searchMock.mockResolvedValue({ results: [result()] });
    composeMock.mockResolvedValue(composed());
    await answerQuery('where did the move first come up?');
    expect(composeMock).toHaveBeenCalledTimes(1);
    expect(composeMock.mock.calls[0]![0]).toMatchObject({
      query: 'where did the move first come up?',
    });
  });

  it('composes from the matched EXCERPT, not the whole parent window', async () => {
    searchMock.mockResolvedValue({
      results: [result({
        excerpt: 'I think we might actually leave the city.',
        content: 'Long rambling entry about the weather and the commute and then the city thing and then dinner.',
      })],
    });
    composeMock.mockResolvedValue(composed());
    await answerQuery('where did the move first come up?');
    const input = composeMock.mock.calls[0]![0] as { parts: Array<{ text: string }> };
    expect(input.parts[0]!.text).toBe('I think we might actually leave the city.');
    expect(input.parts[0]!.text).not.toContain('rambling');
  });

  it('attaches lowercase unabbreviated date prose to each excerpt', async () => {
    searchMock.mockResolvedValue({ results: [result({ createdAt: '2026-02-05T08:00:00.000Z' })] });
    composeMock.mockResolvedValue(composed());
    await answerQuery('what was i saying about dad in february?');
    const input = composeMock.mock.calls[0]![0] as { parts: Array<{ date: string }> };
    expect(input.parts[0]!.date).toBe('thursday the 5th of february');
  });

  it('carries the conversation so a follow-up resolves against it', async () => {
    searchMock.mockResolvedValue({ results: [result()] });
    composeMock.mockResolvedValue(composed());
    const turns = [{ query: 'where did the move first come up?', answer: 'the first time was in march.' }];
    await answerQuery('and what changed after that?', false, { turns });
    expect(composeMock.mock.calls[0]![0]).toMatchObject({ turns });
  });

  it('drops supporting excerpts below the support floor', async () => {
    searchMock.mockResolvedValue({
      results: [
        result({ memoryId: 'strong', vectorScore: 0.81 }),
        result({ memoryId: 'ok', vectorScore: 0.42 }),
        result({ memoryId: 'noise', vectorScore: 0.11 }),
      ],
    });
    composeMock.mockResolvedValue(composed());
    await answerQuery('the move?');
    const input = composeMock.mock.calls[0]![0] as { parts: Array<{ source: { id: string } }> };
    const ids = input.parts.map((p) => p.source.id);
    expect(ids).toContain('strong');
    expect(ids).toContain('ok');
    expect(ids).not.toContain('noise');
  });

  it('ranks by real similarity, not by RRF', async () => {
    // RRF would put `rrf-winner` first; similarity says otherwise.
    searchMock.mockResolvedValue({
      results: [
        result({ memoryId: 'rrf-winner', score: 0.033, vectorScore: 0.55 }),
        result({ memoryId: 'actually-relevant', score: 0.016, vectorScore: 0.88 }),
      ],
    });
    composeMock.mockResolvedValue(composed());
    await answerQuery('the move?');
    const input = composeMock.mock.calls[0]![0] as { parts: Array<{ source: { id: string } }> };
    expect(input.parts[0]!.source.id).toBe('actually-relevant');
  });

  it('drops a graph-only neighbour that never matched the question', async () => {
    // vectorScore 0 == nothing was scored against the query. An entity-
    // expansion neighbour is exactly the "non-relevant post" the epic removes.
    searchMock.mockResolvedValue({
      results: [
        result({ memoryId: 'match', vectorScore: 0.77 }),
        result({ memoryId: 'graph-only', vectorScore: 0, arms: ['graph'] }),
      ],
    });
    composeMock.mockResolvedValue(composed());
    await answerQuery('the move?');
    const input = composeMock.mock.calls[0]![0] as { parts: Array<{ source: { id: string } }> };
    expect(input.parts.map((p) => p.source.id)).toEqual(['match']);
  });
});

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

describe('answerQuery — the wire shape', () => {
  it('shapes a composed answer with bare arrays and the echoed query', async () => {
    searchMock.mockResolvedValue({ results: [result({ memoryId: 'mem-9' })] });
    composeMock.mockResolvedValue({
      text: 'the first time was in march.',
      annotations: [{ start: 0, end: 3, source: { type: 'memory', id: 'mem-9' } }],
      answered: true,
    });
    executeMock.mockResolvedValue([{ entity_id: 'ent-1' }, { entity_id: '  ' }]);

    const { answer } = await answerQuery('where did the move first come up?');
    expect(answer).not.toBeNull();
    expect(answer!.queryText).toBe('where did the move first come up?');
    expect(answer!.answerText).toBe('the first time was in march.');
    expect(Array.isArray(answer!.annotations)).toBe(true);
    expect(answer!.annotations).toHaveLength(1);
    // Blank entity ids are filtered — iOS requires every id non-blank.
    expect(answer!.relevantEntityIds).toEqual(['ent-1']);
    expect(answer!.isHardTopic).toBe(false);
    // No scope was gathered, so the honest echo is absent (not empty).
    expect(answer!.scopedToEntityIds).toBeUndefined();
    expect(Date.parse(answer!.composedAt)).not.toBeNaN();
  });

  it('drops an out-of-bounds span rather than shipping one iOS would reject', async () => {
    searchMock.mockResolvedValue({ results: [result()] });
    composeMock.mockResolvedValue({
      text: 'short.',
      annotations: [
        { start: 0, end: 5, source: { type: 'memory', id: 'mem-1' } },
        { start: 0, end: 999, source: { type: 'memory', id: 'mem-1' } },
        { start: 0, end: 3, source: { type: 'memory', id: '  ' } },
      ],
      answered: true,
    });
    const { answer } = await answerQuery('anything?');
    expect(answer!.annotations).toEqual([
      { start: 0, end: 5, source: { type: 'memory', id: 'mem-1' } },
    ]);
  });

  it('serves the honest-absence prose when the composer says it did not answer', async () => {
    // answered:false is NOT the empty state — material cleared the gate and the
    // composer named the absence, which is more use than the canned copy.
    searchMock.mockResolvedValue({ results: [result({ vectorScore: 0.66 })] });
    composeMock.mockResolvedValue(composed({
      text: 'nothing about him yet. the closest is a call about the house.',
      answered: false,
    }));
    const { answer } = await answerQuery('what have i said about my brother?');
    expect(answer).not.toBeNull();
    expect(answer!.answerText).toContain('nothing about him yet');
  });

  it('flags ambiguity when several excerpts match about equally well', async () => {
    searchMock.mockResolvedValue({
      results: [
        result({ memoryId: 'a', vectorScore: 0.71 }),
        result({ memoryId: 'b', vectorScore: 0.69 }),
        result({ memoryId: 'c', vectorScore: 0.67 }),
      ],
    });
    composeMock.mockResolvedValue(composed({ text: 'three meetings come back.' }));
    const { answer } = await answerQuery('the meeting?');
    expect(answer!.isAmbiguous).toBe(true);
  });

  it('does not flag ambiguity when one excerpt clearly wins', async () => {
    searchMock.mockResolvedValue({
      results: [
        result({ memoryId: 'a', vectorScore: 0.91 }),
        result({ memoryId: 'b', vectorScore: 0.52 }),
        result({ memoryId: 'c', vectorScore: 0.44 }),
      ],
    });
    composeMock.mockResolvedValue(composed());
    const { answer } = await answerQuery('the studio?');
    expect(answer!.isAmbiguous).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The gathered scope
// ---------------------------------------------------------------------------

describe('answerQuery — the gathered-context scope', () => {
  it('answers only from memories inside the gathered scope, and echoes it', async () => {
    searchMock.mockResolvedValue({
      results: [
        result({ memoryId: 'inside', vectorScore: 0.8 }),
        result({ memoryId: 'outside', vectorScore: 0.9 }),
      ],
    });
    // memory_entities join: only `inside` is linked to the gathered entity.
    executeMock.mockResolvedValueOnce([{ memory_id: 'inside' }]);
    executeMock.mockResolvedValueOnce([{ entity_id: 'ent-42' }]);
    composeMock.mockResolvedValue(composed());

    const { answer } = await answerQuery('what about this?', false, {
      contextEntityIds: ['ent-42'],
    });
    const input = composeMock.mock.calls[0]![0] as { parts: Array<{ source: { id: string } }> };
    expect(input.parts.map((p) => p.source.id)).toEqual(['inside']);
    // The honest echo: present because a scope really was applied.
    expect(answer!.scopedToEntityIds).toEqual(['ent-42']);
  });

  it('goes quiet rather than answering outside the scope the user chose', async () => {
    searchMock.mockResolvedValue({ results: [result({ memoryId: 'outside', vectorScore: 0.95 })] });
    executeMock.mockResolvedValueOnce([]); // nothing in scope
    const { answer } = await answerQuery('what about this?', false, {
      contextEntityIds: ['ent-42'],
    });
    expect(answer).toBeNull();
    expect(composeMock).not.toHaveBeenCalled();
  });

  it('ignores blank entity ids and stays a whole-pool ask', async () => {
    searchMock.mockResolvedValue({ results: [result()] });
    composeMock.mockResolvedValue(composed());
    const { answer } = await answerQuery('anything?', false, { contextEntityIds: ['', '   '] });
    expect(answer!.scopedToEntityIds).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dateProse
// ---------------------------------------------------------------------------

describe('dateProse', () => {
  const now = new Date('2026-08-25T00:00:00.000Z');

  it('reads as lowercase unabbreviated prose', () => {
    expect(dateProse('2026-02-05T08:00:00.000Z', now)).toBe('thursday the 5th of february');
  });

  it('uses the right ordinal suffixes', () => {
    expect(dateProse('2026-03-01T00:00:00.000Z', now)).toContain('the 1st of');
    expect(dateProse('2026-03-02T00:00:00.000Z', now)).toContain('the 2nd of');
    expect(dateProse('2026-03-03T00:00:00.000Z', now)).toContain('the 3rd of');
    expect(dateProse('2026-03-04T00:00:00.000Z', now)).toContain('the 4th of');
    expect(dateProse('2026-03-11T00:00:00.000Z', now)).toContain('the 11th of');
    expect(dateProse('2026-03-12T00:00:00.000Z', now)).toContain('the 12th of');
    expect(dateProse('2026-03-13T00:00:00.000Z', now)).toContain('the 13th of');
    expect(dateProse('2026-03-21T00:00:00.000Z', now)).toContain('the 21st of');
  });

  it('appends the year only when it is not the current one', () => {
    expect(dateProse('2024-12-25T00:00:00.000Z', now)).toBe('wednesday the 25th of december, 2024');
    expect(dateProse('2026-12-25T00:00:00.000Z', now)).toBe('friday the 25th of december');
  });

  it('returns empty prose for an unparseable timestamp — never a wrong date', () => {
    expect(dateProse('not-a-date', now)).toBe('');
  });
});
