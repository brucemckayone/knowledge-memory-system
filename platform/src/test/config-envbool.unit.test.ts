/**
 * envBool — strict boolean env parsing (bead nmemo-9b4).
 *
 * The defect this encodes: `z.coerce.boolean()` applies `Boolean(value)`, so
 * `EMBED_DESCRIPTIONS=false` and `EMBED_DESCRIPTIONS=0` both evaluated TRUE.
 * The two values an operator would type to turn a flag off turned it on.
 * Pure test — no DB, no ML, no env mutation.
 */
import { describe, it, expect } from 'vitest';
import { envBool } from '../config-env.js';

describe('envBool', () => {
  it('rejects the exact inputs z.coerce.boolean() got backwards', () => {
    // The regression. Under z.coerce.boolean() both of these were `true`.
    expect(envBool(true).parse('false')).toBe(false);
    expect(envBool(true).parse('0')).toBe(false);
  });

  it('accepts the conventional false spellings', () => {
    for (const v of ['false', 'FALSE', 'False', '0', 'no', 'off', ' false ']) {
      expect(envBool(true).parse(v), v).toBe(false);
    }
  });

  it('accepts the conventional true spellings', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'on', ' true ']) {
      expect(envBool(false).parse(v), v).toBe(true);
    }
  });

  it('falls back to the default when unset or blank', () => {
    expect(envBool(false).parse(undefined)).toBe(false);
    expect(envBool(true).parse(undefined)).toBe(true);
    expect(envBool(true).parse('')).toBe(true);
    expect(envBool(true).parse('   ')).toBe(true);
  });

  it('throws on an unrecognised value rather than silently defaulting', () => {
    // Fail-loud: a typo must be a startup failure, not a silent flip.
    expect(() => envBool(false).parse('ture')).toThrow();
    expect(() => envBool(false).parse('2')).toThrow();
    expect(() => envBool(true).parse('maybe')).toThrow();
  });
});
