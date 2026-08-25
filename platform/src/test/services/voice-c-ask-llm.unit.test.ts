/**
 * Unit tests for the ask compose seam (MNEMO-96o8.2 / ASK-005 ask-mode).
 *
 * PURE unit tests — `fetch` is mocked, so no ml-services dependency. The focus
 * is the two behaviours that kept the ask broken before this seam existed:
 *
 *   1. `assertAskVoice` must accept the user's own proper nouns. The shared
 *      `assertVoiceC` throws on ANY uppercase character while the compose
 *      persona is told to keep proper nouns cased — a contradiction that
 *      rejected every answer mentioning a name and dropped the ask onto the
 *      deterministic floor (which concatenated whole raw entries).
 *   2. A forbidden verb inside a QUOTE from the user is not a voice violation.
 *      The vocabulary rules bind the system, not the person whose words are
 *      being quoted back to them.
 *
 * Env note (same as voice-c-compose-llm.unit.test.ts): the seam imports
 * `config`, which zod-validates DATABASE_URL at module load, so the runner must
 * provide it. `fetch` is stubbed — no request is ever made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  assertAskVoice,
  dropOverlappingSpans,
  locateAskPhrases,
  lowercasePronounI,
  composeAskWithLLM,
  AskLLMError,
} from '../../services/voice-c-ask-llm.js';

// ---------------------------------------------------------------------------
// assertAskVoice — the register, with the quote exemption
// ---------------------------------------------------------------------------

describe('assertAskVoice', () => {
  const noSpans: Array<{ start: number; end: number }> = [];

  it('accepts all-lowercase prose with no citations', () => {
    expect(() =>
      assertAskVoice('the studio, since march.', noSpans, 'The studio since March.'),
    ).not.toThrow();
  });

  it('accepts a proper noun that appears cased in the source material', () => {
    // THE regression this seam exists to prevent: assertVoiceC would throw here.
    const text = 'twice, and both times sideways — the text from Dad was harder than i expected.';
    const source = 'The text from Dad was harder than I expected.';
    expect(() => assertAskVoice(text, noSpans, source)).not.toThrow();
  });

  it('accepts a single-letter name kept cased (the corpus\'s "M")', () => {
    expect(() =>
      assertAskVoice('mostly M, and mostly on the phone.', noSpans, 'Long call with M again.'),
    ).not.toThrow();
  });

  it('rejects a capital the source material does not license', () => {
    // Sentence-initial capitalisation is exactly what the lowercase rule is for.
    expect(() =>
      assertAskVoice('The studio, since march.', noSpans, 'the studio since march'),
    ).toThrow(AskLLMError);
  });

  it('rejects Title Case the model invented', () => {
    expect(() =>
      assertAskVoice('the Big Decision, in march.', noSpans, 'the big decision in march'),
    ).toThrow(/not a proper noun from the source material/);
  });

  it('rejects a forbidden verb in the answer\'s own prose', () => {
    expect(() =>
      assertAskVoice('nothing to share about that yet.', noSpans, 'irrelevant source'),
    ).toThrow(/forbidden verb "share"/);
  });

  it('accepts a forbidden verb inside a citation — the user\'s own words', () => {
    // The user wrote "finish"; quoting them is not the system using the word.
    const text = 'the studio thing — "i need to finish the studio thing" — since march.';
    const quote = 'i need to finish the studio thing';
    const start = text.indexOf(quote);
    expect(start).toBeGreaterThan(-1);
    expect(() =>
      assertAskVoice(text, [{ start, end: start + quote.length }], 'I need to finish the studio thing.'),
    ).not.toThrow();
  });

  it('rejects a system-self reference even inside a citation span', () => {
    // Hard rule 2 admits no exemption: nothing licenses naming the product.
    const text = 'i noticed the move came up twice.';
    expect(() =>
      assertAskVoice(text, [{ start: 0, end: text.length }], text),
    ).toThrow(/system-self reference/);
  });

  it('accepts a possessive built on a name from the source material', () => {
    // Caught live: the user wrote "Maya", the answer said "Maya's question",
    // and a whole-token source check rejected a correct answer.
    expect(() =>
      assertAskVoice(
        "the one still open is Maya's question — whether we'd move back toward Galway.",
        noSpans,
        'Maya asked if we would ever move back toward Galway, closer to mum and dad.',
      ),
    ).not.toThrow();
  });

  it('accepts an apostrophised name from the source material', () => {
    expect(() =>
      assertAskVoice("mostly with O'Brien, in march.", noSpans, "Long call with O'Brien again."),
    ).not.toThrow();
  });

  it('rejects a capitalised pronoun even though the source material is full of "I"', () => {
    // No source exemption here: raw entries are natural text, so a plain source
    // check would license every "I'm" and gut the lowercase rule. (In the live
    // path `lowercasePronounI` repairs this before validation ever sees it —
    // this is the backstop for anything that slips past.)
    expect(() =>
      assertAskVoice("I'm still holding it.", noSpans, "I'm tired. I think I need a break."),
    ).toThrow(/capitalises the pronoun/);
  });

  it('lowercases the pronoun instead of discarding the answer', () => {
    // Live regression: the model quoted an entry written with a capital "I" and
    // one letter sent the whole ask quiet.
    expect(lowercasePronounI("the story of how they met, one I never want to forget."))
      .toBe('the story of how they met, one i never want to forget.');
    expect(lowercasePronounI("I'm still holding it, and I've said so twice."))
      .toBe("i'm still holding it, and i've said so twice.");
  });

  it('repairs the pronoun without moving any other character', () => {
    // Length-preserving is load-bearing: citation offsets are computed after.
    const before = "on monday I wrote it down, and I meant it.";
    const after = lowercasePronounI(before);
    expect(after.length).toBe(before.length);
  });

  it('leaves a capital that is part of a name alone', () => {
    // "Ian" must not become "ian" — \b guards the standalone pronoun only.
    expect(lowercasePronounI('Ian called, and I answered.')).toBe('Ian called, and i answered.');
  });

  it('rejects hedging in the answer\'s own prose', () => {
    expect(() =>
      assertAskVoice('perhaps the move, in march.', noSpans, 'the move in march'),
    ).toThrow(/hedging/);
  });
});

// ---------------------------------------------------------------------------
// locateAskPhrases — exact, then longest-run recovery
// ---------------------------------------------------------------------------

describe('locateAskPhrases', () => {
  const src = { type: 'memory', id: 'm1' } as const;

  it('locates an exactly-copied phrase', () => {
    const text = 'the first time was in march, and it stuck.';
    const r = locateAskPhrases(text, [{ phrase: 'the first time was in march', source: src }]);
    expect(r.dropped).toHaveLength(0);
    expect(r.recovered).toBe(0);
    expect(text.slice(r.spans[0]!.start, r.spans[0]!.end)).toBe('the first time was in march');
  });

  it('recovers the longest word run when the citation was copied from the passage', () => {
    // THE live failure: the answer paraphrased the tail, the citation kept the
    // passage's wording, and every underline was dropped.
    const text = 'dad seemed tired but in good spirits, teasing about the climbing.';
    const r = locateAskPhrases(text, [{
      phrase: 'dad seemed tired but in good spirits, kept teasing me about my climbing',
      source: src,
    }]);
    expect(r.dropped).toHaveLength(0);
    expect(r.recovered).toBe(1);
    expect(text.slice(r.spans[0]!.start, r.spans[0]!.end))
      .toBe('dad seemed tired but in good spirits,');
  });

  it('drops a citation with no run long enough to be meaningful', () => {
    const text = 'nothing about that here.';
    const r = locateAskPhrases(text, [{ phrase: 'the studio decision in march', source: src }]);
    expect(r.spans).toHaveLength(0);
    expect(r.dropped).toHaveLength(1);
  });

  it('never recovers a run shorter than four words', () => {
    // "about that" overlaps, but a two-word underline is a coincidence, not a
    // citation.
    const text = 'nothing about that here at all.';
    const r = locateAskPhrases(text, [{ phrase: 'i said something about that once', source: src }]);
    expect(r.spans).toHaveLength(0);
  });

  it('will not anchor a recovered span mid-word', () => {
    const text = 'the trip was stripped back to one day only.';
    const r = locateAskPhrases(text, [{ phrase: 'was stripped back to one', source: src }]);
    // Exact match exists here, so this mainly pins that whole-word anchoring
    // does not break the ordinary case.
    expect(r.spans).toHaveLength(1);
    expect(text.slice(r.spans[0]!.start, r.spans[0]!.end)).toBe('was stripped back to one');
  });

  it('returns spans in document order after recovery', () => {
    const text = 'first the studio thing happened, then the move came up properly.';
    const r = locateAskPhrases(text, [
      { phrase: 'then the move came up properly today', source: { type: 'memory', id: 'm2' } },
      { phrase: 'first the studio thing happened', source: src },
    ]);
    expect(r.spans).toHaveLength(2);
    expect(r.spans[0]!.start).toBeLessThan(r.spans[1]!.start);
  });
});

// ---------------------------------------------------------------------------
// dropOverlappingSpans — one unambiguous underline per region
// ---------------------------------------------------------------------------

describe('dropOverlappingSpans', () => {
  it('keeps disjoint spans untouched', () => {
    const spans = [
      { start: 0, end: 5 },
      { start: 10, end: 20 },
    ];
    const { kept, dropped } = dropOverlappingSpans(spans);
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(0);
  });

  it('drops a clause span nested inside a sentence span', () => {
    const { kept, dropped } = dropOverlappingSpans([
      { start: 0, end: 40 },
      { start: 10, end: 20 },
    ]);
    expect(kept).toEqual([{ start: 0, end: 40 }]);
    expect(dropped).toEqual([{ start: 10, end: 20 }]);
  });

  it('keeps the longer span when two start at the same offset', () => {
    const { kept } = dropOverlappingSpans([
      { start: 0, end: 10 },
      { start: 0, end: 25 },
    ]);
    expect(kept).toEqual([{ start: 0, end: 25 }]);
  });

  it('treats touching-but-not-overlapping spans as disjoint', () => {
    // end is exclusive, so [0,5) and [5,9) share no code unit.
    const { kept, dropped } = dropOverlappingSpans([
      { start: 0, end: 5 },
      { start: 5, end: 9 },
    ]);
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// composeAskWithLLM — fetch mocked
// ---------------------------------------------------------------------------

describe('composeAskWithLLM', () => {
  const part = {
    text: 'I think we might actually leave the city.',
    date: 'monday the 3rd of march',
    source: { type: 'memory' as const, id: 'm1' },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockAskResponse(body: unknown, ok = true, status = 200) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok,
        status,
        statusText: 'x',
        json: async () => body,
        text: async () => JSON.stringify(body),
      })) as unknown as typeof fetch,
    );
  }

  it('sends the question, the conversation, and the excerpts', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ text: 'the first time was in march.', phrase_sources: [], answered: true }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await composeAskWithLLM({
      query: 'where did the move first come up?',
      parts: [part],
      turns: [{ query: 'what about the city?', answer: 'mostly the noise.' }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]! as unknown as [string, { body: string }];
    expect(call[0]).toContain('/voice-c-ask');
    const sent = JSON.parse(call[1].body);
    // The question is the subject — its absence was the original bug.
    expect(sent.query).toBe('where did the move first come up?');
    expect(sent.turns).toHaveLength(1);
    expect(sent.parts[0].text).toBe(part.text);
    expect(sent.parts[0].date).toBe('monday the 3rd of march');
  });

  it('locates a quoted phrase and returns its UTF-16 span', async () => {
    const text = 'the first time was in march — "i think we might actually leave the city".';
    mockAskResponse({
      text,
      phrase_sources: [
        { phrase: 'i think we might actually leave the city', source: { type: 'memory', id: 'm1' } },
      ],
      answered: true,
    });
    const r = await composeAskWithLLM({ query: 'where did the move first come up?', parts: [part] });
    expect(r.annotations).toHaveLength(1);
    const a = r.annotations[0]!;
    expect(text.slice(a.start, a.end)).toBe('i think we might actually leave the city');
    expect(a.source.id).toBe('m1');
    expect(r.answered).toBe(true);
  });

  it('carries answered=false through for an honest-absence answer', async () => {
    mockAskResponse({
      text: 'nothing about him yet.',
      phrase_sources: [],
      answered: false,
    });
    const r = await composeAskWithLLM({ query: 'what have i said about my brother?', parts: [part] });
    expect(r.answered).toBe(false);
    // A spanless honest absence is allowed: the ask surface renders prose via
    // UnderlinedProse (which degrades gracefully), not through the
    // span-guaranteed `fromBackend` path.
    expect(r.annotations).toHaveLength(0);
  });

  it('accepts a multi-sentence answer with zero spans', async () => {
    mockAskResponse({
      text: 'nothing about him yet. the closest is a call about the house.',
      phrase_sources: [],
      answered: false,
    });
    await expect(
      composeAskWithLLM({ query: 'what about my brother?', parts: [part] }),
    ).resolves.toMatchObject({ answered: false });
  });

  it('throws on a blank query rather than composing something unanchored', async () => {
    mockAskResponse({ text: 'x', phrase_sources: [], answered: true });
    await expect(composeAskWithLLM({ query: '   ', parts: [part] })).rejects.toThrow(AskLLMError);
  });

  it('throws on empty parts', async () => {
    mockAskResponse({ text: 'x', phrase_sources: [], answered: true });
    await expect(composeAskWithLLM({ query: 'anything?', parts: [] })).rejects.toThrow(/parts is empty/);
  });

  it('maps an upstream non-2xx to upstream-error', async () => {
    mockAskResponse({ detail: 'boom' }, false, 503);
    await expect(
      composeAskWithLLM({ query: 'anything?', parts: [part] }),
    ).rejects.toMatchObject({ reason: 'upstream-error' });
  });

  it('maps an unreachable upstream to upstream-unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    await expect(
      composeAskWithLLM({ query: 'anything?', parts: [part] }),
    ).rejects.toMatchObject({ reason: 'upstream-unreachable' });
  });

  it('lets a follow-up reuse a name from the conversation, not just this turn\'s excerpts', async () => {
    // Caught live: the name came from the turn above, so a parts-only source
    // check rejected a correct answer and the ask went quiet.
    mockAskResponse({
      text: "the one still open is Maya's question about moving back.",
      phrase_sources: [],
      answered: true,
    });
    await expect(
      composeAskWithLLM({
        query: "and what did i say i still hadn't answered?",
        parts: [{ text: 'Mum called about the trip.', date: 'last week', source: { type: 'memory', id: 'm2' } }],
        turns: [{
          query: 'what have i been saying about dad?',
          answer: 'mostly warm — and one open thread from Maya about moving back.',
        }],
      }),
    ).resolves.toMatchObject({ answered: true });
  });

  it('rejects an off-voice answer instead of shipping it', async () => {
    mockAskResponse({
      text: 'I noticed the move came up twice.',
      phrase_sources: [],
      answered: true,
    });
    await expect(
      composeAskWithLLM({ query: 'the move?', parts: [part] }),
    ).rejects.toMatchObject({ reason: 'voice-violation' });
  });
});
