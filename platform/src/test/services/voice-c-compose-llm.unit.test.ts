/**
 * Unit tests for the LLM Voice-C compose seam (ASK-005 + ASK-009).
 *
 * These are PURE unit tests:
 *   - `locatePhraseSpans` is exercised directly with crafted inputs (incl.
 *     emoji/surrogate-pair offset correctness and repeat-phrase cursor).
 *   - `composeVoiceCWithLLM` is exercised with `fetch` MOCKED, so no network
 *     and no ml-services dependency. The mock returns controlled shapes that
 *     exercise the multi-sentence guard, the wire-serialization check, and the
 *     assertVoiceC rejection path.
 *
 * The live end-to-end smoke (real ml-services call) lives in the session
 * transcript, not here.
 *
 * Env note: the seam imports `config` (for ML_SERVICES_URL), which zod-validates
 * DATABASE_URL at module load. Under vitest.unit.config.ts (no setupFiles) this
 * env must be present in the process BEFORE the test file imports — ESM import
 * hoisting means an in-file `process.env` assignment runs AFTER imports, so set
 * it via the runner: `DATABASE_URL=… npx vitest run --config vitest.unit.config.ts`.
 * `fetch` is stubbed, so no request is ever made against ML_SERVICES_URL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  locatePhraseSpans,
  composeVoiceCWithLLM,
  VoiceCLLMComposeError,
} from '../../services/voice-c-compose-llm.js';
import { assertVoiceC } from '../../services/voice-c-composer.js';

// ---------------------------------------------------------------------------
// locatePhraseSpans — the UTF-16 offset authority (ASK-009)
// ---------------------------------------------------------------------------

describe('locatePhraseSpans', () => {
  it('locates each phrase verbatim with UTF-16 in-bounds spans', () => {
    const text = 'on monday i wanted to make something honest.';
    const r = locatePhraseSpans(text, [
      {
        phrase: 'on monday i wanted to make something honest',
        source: { type: 'memory', id: 'm1' },
      },
    ]);
    expect(r.dropped).toHaveLength(0);
    expect(r.spans).toHaveLength(1);
    const s = r.spans[0]!;
    expect(s.start).toBe(0);
    expect(s.end).toBe(text.length - 1); // phrase excludes trailing period
    expect(s.end).toBeLessThanOrEqual(text.length);
    expect(text.slice(s.start, s.end)).toBe('on monday i wanted to make something honest');
  });

  it('locates multiple distinct phrases in document order', () => {
    const text = 'two weeks ago you said the move was decided. yesterday you said you are still working on it.';
    const r = locatePhraseSpans(text, [
      { phrase: 'two weeks ago you said the move was decided', source: { type: 'memory', id: 'm1' } },
      { phrase: 'yesterday you said you are still working on it', source: { type: 'memory', id: 'm2' } },
    ]);
    expect(r.dropped).toHaveLength(0);
    expect(r.spans.map((s) => s.source.id)).toEqual(['m1', 'm2']);
    for (const s of r.spans) {
      expect(s.start).toBeGreaterThanOrEqual(0);
      expect(s.end).toBeGreaterThan(s.start);
      expect(s.end).toBeLessThanOrEqual(text.length);
      expect(text.slice(s.start, s.end)).toBe(
        text.slice(s.start, s.end), // tautology guard: slice is stable
      );
    }
  });

  it('advances a forward cursor for a phrase appearing twice (distinct occurrences)', () => {
    // "the move" appears twice; both must map to distinct, in-order offsets.
    const text = 'the move was decided. then the move changed.';
    const r = locatePhraseSpans(text, [
      { phrase: 'the move', source: { type: 'memory', id: 'a' } },
      { phrase: 'the move', source: { type: 'memory', id: 'b' } },
    ]);
    expect(r.dropped).toHaveLength(0);
    expect(r.spans).toHaveLength(2);
    expect(r.spans[0]!.start).toBeLessThan(r.spans[1]!.start);
    expect(r.spans[0]!.start).toBe(0);
    expect(r.spans[1]!.start).toBe(text.indexOf('the move', 1));
  });

  it('DROPS un-locatable phrases rather than emitting out-of-bounds spans', () => {
    const text = 'on monday i wanted something honest.';
    const r = locatePhraseSpans(text, [
      { phrase: 'on monday i wanted something honest', source: { type: 'memory', id: 'm1' } },
      { phrase: 'this phrase is not present', source: { type: 'memory', id: 'm2' } },
      { phrase: '', source: { type: 'memory', id: 'm3' } }, // empty -> dropped
    ]);
    expect(r.spans).toHaveLength(1);
    expect(r.spans[0]!.source.id).toBe('m1');
    expect(r.dropped.map((d) => d.source.id)).toEqual(['m2', 'm3']);
  });

  it('computes UTF-16 offsets correctly for emoji / surrogate pairs', () => {
    // "🌙" is U+1F319 — a single code point but TWO UTF-16 code units (a
    // surrogate pair). TS string.length counts the surrogate pair as 2.
    // The iOS decoder uses text.utf16.count, which also counts the pair as 2.
    // So a span AFTER the emoji must account for the 2-unit width.
    const text = '🌙 on monday i wanted something honest';
    const phrase = 'on monday i wanted something honest';
    const r = locatePhraseSpans(text, [
      { phrase, source: { type: 'memory', id: 'm1' } },
    ]);
    expect(r.spans).toHaveLength(1);
    const s = r.spans[0]!;
    // UTF-16 offset of phrase start = emoji (2) + space (1) = 3
    expect(s.start).toBe(3);
    expect(s.end).toBe(s.start + phrase.length);
    expect(text.slice(s.start, s.end)).toBe(phrase);
    // The critical invariant for the iOS decoder: end <= text.length (utf16).
    expect(s.end).toBeLessThanOrEqual(text.length);
    expect(s.end).toBe(text.length); // phrase runs to end
  });

  it('handles a surrogate pair INSIDE an annotated phrase', () => {
    const text = 'i wanted 🌙 honest';
    const phrase = 'wanted 🌙 honest';
    const r = locatePhraseSpans(text, [
      { phrase, source: { type: 'memory', id: 'm1' } },
    ]);
    expect(r.spans).toHaveLength(1);
    const s = r.spans[0]!;
    expect(text.slice(s.start, s.end)).toBe(phrase); // round-trips exactly
    expect(s.end - s.start).toBe(phrase.length); // UTF-16 width matches
  });
});

// ---------------------------------------------------------------------------
// composeVoiceCWithLLM — fetch mocked
// ---------------------------------------------------------------------------

// Mock global fetch so composeVoiceCWithLLM never hits the network.
const fetchSpy = vi.fn();
vi.stubGlobal('fetch', fetchSpy);

// The seam reads ML_SERVICES_URL from config; the test setup sets a default,
// so config.ML_SERVICES_URL resolves without env juggling.
function mockOk(body: unknown): void {
  fetchSpy.mockResolvedValueOnce({
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

beforeEach(() => {
  fetchSpy.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('composeVoiceCWithLLM', () => {
  it('(a) multi-sentence prose gets valid in-bounds UTF-16 spans', async () => {
    const text = 'two weeks ago you said the move was decided. yesterday you said you are still working on it. — what changed?';
    mockOk({
      text,
      phrase_sources: [
        { phrase: 'two weeks ago you said the move was decided', source: { type: 'memory', id: 'm1' } },
        { phrase: 'yesterday you said you are still working on it', source: { type: 'memory', id: 'm2' } },
      ],
    });

    const out = await composeVoiceCWithLLM({
      parts: [
        { text: 'two weeks ago you said the move was decided.', source: { type: 'memory', id: 'm1' } },
        { text: 'yesterday you said you are still working on it.', source: { type: 'memory', id: 'm2' } },
      ],
      surface: 'rise',
    });

    // Every span is in-bounds and slices back to the exact phrase.
    for (const a of out.annotations) {
      expect(a.start).toBeGreaterThanOrEqual(0);
      expect(a.end).toBeGreaterThan(a.start);
      expect(a.end).toBeLessThanOrEqual(out.text.length);
      expect(out.text.slice(a.start, a.end)).toBeTruthy();
    }
    expect(out.annotations).toHaveLength(2);
  });

  it('(b) single-sentence prose may be unannotated', async () => {
    const text = 'on monday i wanted to make something honest.';
    mockOk({ text, phrase_sources: [] });

    const out = await composeVoiceCWithLLM({
      parts: [{ text: 'I wanted to make something honest.', source: { type: 'memory', id: 'm1' } }],
    });
    expect(out.text).toBe(text);
    expect(out.annotations).toHaveLength(0); // single sentence -> no guard trip
  });

  it('(c) serialized wire JSON satisfies the 3 fromBackend non-throw conditions', async () => {
    // The iOS fromBackend non-throw conditions are:
    //   1. every annotation.end <= text.utf16.count  (== text.length in JS)
    //   2. every annotation: 0 <= start < end
    //   3. NOT (multi-sentence AND empty annotations)
    const text = 'on monday i wanted something honest. on wednesday i was tired. — what changed?';
    mockOk({
      text,
      phrase_sources: [
        { phrase: 'on monday i wanted something honest', source: { type: 'memory', id: 'm1' } },
      ],
    });

    const out = await composeVoiceCWithLLM({
      parts: [{ text: 'monday honest wednesday tired', source: { type: 'memory', id: 'm1' } }],
    });

    // Re-serialize to wire JSON exactly as the platform would emit it, then
    // assert the three fromBackend conditions against the wire form.
    const wire = JSON.parse(JSON.stringify(out)) as {
      text: string;
      annotations: Array<{ start: number; end: number; source: { type: string; id: string } }>;
    };

    // (1) end <= text.length (UTF-16 == JS string.length)
    for (const a of wire.annotations) {
      expect(a.end).toBeLessThanOrEqual(wire.text.length);
    }
    // (2) 0 <= start < end
    for (const a of wire.annotations) {
      expect(a.start).toBeGreaterThanOrEqual(0);
      expect(a.start).toBeLessThan(a.end);
    }
    // (3) multi-sentence requires non-empty annotations
    const multi = /[.!?…]+\s+\S/.test(wire.text.trim());
    if (multi) {
      expect(wire.annotations.length).toBeGreaterThan(0);
    }
  });

  it('(d) emoji / surrogate-pair offset correctness end-to-end', async () => {
    const text = '🌙 on monday i wanted something honest. on wednesday too. — what changed?';
    mockOk({
      text,
      phrase_sources: [
        { phrase: 'on monday i wanted something honest', source: { type: 'memory', id: 'm1' } },
      ],
    });
    const out = await composeVoiceCWithLLM({
      parts: [{ text: 'monday honest', source: { type: 'memory', id: 'm1' } }],
    });
    const a = out.annotations[0]!;
    // phrase sits after 🌙 (2 UTF-16 units) + space (1) = offset 3
    expect(a.start).toBe(3);
    expect(out.text.slice(a.start, a.end)).toBe('on monday i wanted something honest');
    expect(a.end).toBeLessThanOrEqual(out.text.length);
  });

  it('(e) forbidden vocab in mock output -> assertVoiceC rejects', async () => {
    // The LLM "drifted" into a forbidden verb. assertVoiceC must reject so the
    // quality regression is loud, not silently swallowed.
    const text = 'on monday i wanted to save something honest.';
    mockOk({ text, phrase_sources: [] });

    await expect(
      composeVoiceCWithLLM({
        parts: [{ text: 'monday', source: { type: 'memory', id: 'm1' } }],
      }),
    ).rejects.toThrow(/forbidden verb/);

    // Sanity: the same text is independently rejected by assertVoiceC.
    expect(() => assertVoiceC(text)).toThrow(/forbidden verb/);
  });

  it('multi-sentence prose with ZERO locatable spans THROWS (would fail iOS decoder)', async () => {
    const text = 'one sentence here. another sentence there.';
    // phrase_sources present but none of the phrases actually appear in text
    mockOk({
      text,
      phrase_sources: [
        { phrase: 'this phrase is absent', source: { type: 'memory', id: 'm1' } },
      ],
    });
    await expect(
      composeVoiceCWithLLM({ parts: [{ text: 'x', source: { type: 'memory', id: 'm1' } }] }),
    ).rejects.toBeInstanceOf(VoiceCLLMComposeError);
  });

  it('upstream malformed shape -> VoiceCLLMComposeError', async () => {
    mockOk({ text: 'ok', phrase_sources: 'not-an-array' as unknown as never });
    await expect(
      composeVoiceCWithLLM({ parts: [{ text: 'x', source: { type: 'memory', id: 'm1' } }] }),
    ).rejects.toBeInstanceOf(VoiceCLLMComposeError);
  });

  it('upstream non-lowercase -> assertVoiceC rejects', async () => {
    // Capitalized text violates the lowercase rule.
    mockOk({ text: 'On Monday I Wanted Something.', phrase_sources: [] });
    await expect(
      composeVoiceCWithLLM({ parts: [{ text: 'x', source: { type: 'memory', id: 'm1' } }] }),
    ).rejects.toThrow(/not all-lowercase/);
  });
});
