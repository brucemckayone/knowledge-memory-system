/**
 * parseContentType whitelist — bead nmemo-awi
 *
 * Acceptance:
 *  - parseContentType('conversational') === 'conversational' (no longer
 *    downgraded to prose), so a /ingest POST with contentType='conversational'
 *    reaches the graph agent with content_type='conversational' and the
 *    conversational system-prompt addendum (graph_agent 3f9.3) fires over HTTP.
 *  - Unknown / garbage values still default to undefined (caller -> 'prose'),
 *    preserving back-compat.
 *  - prose / code-ts / code-sql still round-trip unchanged.
 *
 * Pure function test — no DB / Qdrant / ML service required.
 */

import { describe, it, expect } from 'vitest';
import { parseContentType } from '../../index.js';

describe('parseContentType (nmemo-awi)', () => {
  it('passes conversational through (not downgraded to prose)', () => {
    expect(parseContentType('conversational')).toBe('conversational');
  });

  it('round-trips the existing accepted types', () => {
    expect(parseContentType('prose')).toBe('prose');
    expect(parseContentType('code-ts')).toBe('code-ts');
    expect(parseContentType('code-sql')).toBe('code-sql');
  });

  it('returns undefined for unknown values (caller defaults to prose)', () => {
    expect(parseContentType('garbage')).toBeUndefined();
    expect(parseContentType('')).toBeUndefined();
    expect(parseContentType(undefined)).toBeUndefined();
    expect(parseContentType(null)).toBeUndefined();
    expect(parseContentType(42)).toBeUndefined();
    // case-sensitive: only the exact lowercase token is accepted
    expect(parseContentType('Conversational')).toBeUndefined();
  });
});
