/**
 * sourced-prose — grounded synthesis with provenance spans.
 *
 * The pattern extracted from voice-c-composer.ts before the iOS strip (keep list
 * §2.2). Pure: no DB, no ML, no infra.
 */
import { describe, it, expect } from 'vitest';
import {
  composeSourcedProse,
  sliceSpan,
  type ProsePart,
} from '../services/sourced-prose.js';

const src = (id: string) => ({ type: 'fact', id });

describe('composeSourcedProse', () => {
  it('joins parts with single spaces and attaches punctuation without one', () => {
    const { text } = composeSourcedProse([
      { phrase: 'diffusion models' },
      { phrase: 'generate images' },
      { phrase: '.' },
    ]);
    expect(text).toBe('diffusion models generate images.');
  });

  it('records a span that resolves back to exactly its phrase', () => {
    const prose = composeSourcedProse([
      { phrase: 'the model' },
      { phrase: 'uses contrastive pretraining', source: src('f1') },
      { phrase: '.' },
    ]);
    expect(prose.spans).toHaveLength(1);
    expect(sliceSpan(prose, prose.spans[0]!)).toBe('uses contrastive pretraining');
    expect(prose.spans[0]!.source).toEqual({ type: 'fact', id: 'f1' });
  });

  it('gives a REPEATED phrase distinct spans — the reason spans are recorded, not searched', () => {
    // An indexOf-based implementation would give both parts the first offset.
    const prose = composeSourcedProse([
      { phrase: 'improves recall', source: src('f1') },
      { phrase: 'and' },
      { phrase: 'improves recall', source: src('f2') },
    ]);
    expect(prose.spans).toHaveLength(2);
    expect(prose.spans[0]!.start).not.toBe(prose.spans[1]!.start);
    expect(sliceSpan(prose, prose.spans[0]!)).toBe('improves recall');
    expect(sliceSpan(prose, prose.spans[1]!)).toBe('improves recall');
    expect(prose.spans[1]!.source.id).toBe('f2');
  });

  it('every span satisfies 0 <= start < end and lands inside the text', () => {
    const parts: ProsePart[] = [
      { phrase: 'alpha', source: src('a') },
      { phrase: 'beta' },
      { phrase: 'gamma', source: src('c') },
    ];
    const prose = composeSourcedProse(parts);
    for (const s of prose.spans) {
      expect(s.start).toBeGreaterThanOrEqual(0);
      expect(s.end).toBeGreaterThan(s.start);
      expect(s.end).toBeLessThanOrEqual(prose.text.length);
    }
  });

  it('counts offsets in UTF-16 code units, so a surrogate pair is width 2', () => {
    // An emoji outside the BMP is 2 UTF-16 code units. A consumer counting
    // scalar values would disagree, which is why the convention is documented.
    const prose = composeSourcedProse([
      { phrase: '🧠' },
      { phrase: 'memory', source: src('f1') },
    ]);
    expect(prose.text).toBe('🧠 memory');
    // '🧠' = 2 units, ' ' = 1 → the sourced phrase starts at 3.
    expect(prose.spans[0]!.start).toBe(3);
    expect(sliceSpan(prose, prose.spans[0]!)).toBe('memory');
  });

  it('skips empty unsourced phrases', () => {
    const { text, spans } = composeSourcedProse([
      { phrase: '' },
      { phrase: 'kept' },
      { phrase: '' },
    ]);
    expect(text).toBe('kept');
    expect(spans).toEqual([]);
  });

  it('throws when a SOURCED part has an empty phrase (start would equal end)', () => {
    expect(() => composeSourcedProse([{ phrase: '', source: src('f1') }])).toThrow(/empty phrase/);
  });

  it('throws on multi-sentence prose with no attribution at all', () => {
    // The load-bearing guard: several sentences citing nothing is the shape of
    // an ungrounded answer, so it fails loudly instead of reading as grounded.
    expect(() =>
      composeSourcedProse([
        { phrase: 'the model improves recall.' },
        { phrase: 'it also reduces latency.' },
      ]),
    ).toThrow(/multi-sentence text with no attribution/);
  });

  it('allows multi-sentence prose when at least one part is sourced', () => {
    const prose = composeSourcedProse([
      { phrase: 'the model improves recall.', source: src('f1') },
      { phrase: 'it also reduces latency.' },
    ]);
    expect(prose.spans).toHaveLength(1);
  });

  it('allows a SINGLE unattributed sentence', () => {
    const prose = composeSourcedProse([{ phrase: 'nothing is known yet.' }]);
    expect(prose.spans).toEqual([]);
    expect(prose.text).toBe('nothing is known yet.');
  });

  it('does not read a decimal or an abbreviation as a sentence end', () => {
    // "3.4%" and "e.g." would each trip a naive /[.!?]/ count.
    const prose = composeSourcedProse([{ phrase: 'recall rose 3.4% (e.g. on mvtec ad)' }]);
    expect(prose.spans).toEqual([]);
    expect(prose.text).toContain('3.4%');
  });

  it('honours the opt-out for a caller that genuinely wants unattributed prose', () => {
    const prose = composeSourcedProse(
      [{ phrase: 'one sentence.' }, { phrase: 'and another.' }],
      { requireAttributionWhenMultiSentence: false },
    );
    expect(prose.spans).toEqual([]);
  });
});
