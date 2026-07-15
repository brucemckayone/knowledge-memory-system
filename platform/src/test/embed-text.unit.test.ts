/**
 * Unit tests for the cross-corpus recall-lever text helpers (bead nmemo-uhp.14).
 *
 * These are PURE functions (no DB, no ML, no config), so this suite is fast and
 * deterministic. It pins the load-bearing invariant: with the lever OFF (mode
 * 'name', the default) the embedded text is byte-for-byte the name — i.e. pre-.14
 * single-corpus behaviour is unchanged — while the composite modes fold in an
 * authored description only when one actually exists.
 */

import { describe, it, expect } from 'vitest';
import {
  entityEmbedTextFor,
  entityEmbedModeFromFlag,
  factEmbedTextFor,
} from '../services/embed-text.js';

describe('entityEmbedModeFromFlag', () => {
  it('maps the master flag to a mode (off ⇒ name-only, unchanged default)', () => {
    expect(entityEmbedModeFromFlag(false)).toBe('name');
    expect(entityEmbedModeFromFlag(true)).toBe('name_description');
  });
});

describe('entityEmbedTextFor', () => {
  const name = 'RtlCopyMemory';
  const desc = 'copies a block of memory; MISRA C:2012 Rule 21.18 bounds the size';

  it("mode 'name' embeds the name only, ignoring any description (pre-.14 behaviour)", () => {
    expect(entityEmbedTextFor(name, desc, 'name')).toBe(name);
    expect(entityEmbedTextFor(name, null, 'name')).toBe(name);
    expect(entityEmbedTextFor(name, undefined, 'name')).toBe(name);
  });

  it("mode 'name_description' folds in the description when present", () => {
    expect(entityEmbedTextFor(name, desc, 'name_description')).toBe(`${name}\n${desc}`);
  });

  it("mode 'description' embeds the description alone when present", () => {
    expect(entityEmbedTextFor(name, desc, 'description')).toBe(desc);
  });

  it('falls back to the bare name when the description is absent or blank, in every mode', () => {
    for (const mode of ['name', 'name_description', 'description'] as const) {
      expect(entityEmbedTextFor(name, null, mode)).toBe(name);
      expect(entityEmbedTextFor(name, undefined, mode)).toBe(name);
      expect(entityEmbedTextFor(name, '   ', mode)).toBe(name);
    }
  });

  it('trims a padded description before composing', () => {
    expect(entityEmbedTextFor(name, `  ${desc}  `, 'description')).toBe(desc);
  });
});

describe('factEmbedTextFor (shared by createFact + epoch applyPromotion)', () => {
  it('prefers authored source text when present', () => {
    expect(factEmbedTextFor('the pointer must not be null', 'requires', 'non_null')).toBe(
      'the pointer must not be null',
    );
  });

  it('falls back to `predicate object` when source text is absent/blank', () => {
    expect(factEmbedTextFor(null, 'violates', 'Rule_21_18')).toBe('violates Rule_21_18');
    expect(factEmbedTextFor('   ', 'violates', 'Rule_21_18')).toBe('violates Rule_21_18');
  });

  it('handles a missing object value without a dangling space', () => {
    expect(factEmbedTextFor(null, 'is_reentrant', null)).toBe('is_reentrant');
    expect(factEmbedTextFor(undefined, 'is_reentrant', undefined)).toBe('is_reentrant');
  });
});
