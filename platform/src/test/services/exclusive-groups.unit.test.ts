/**
 * Unit tests for the shared exclusive-group ontology + fact-precedence
 * comparator (src/services/exclusive-groups.ts — bead nmemo-vpz.1 / doc 41
 * §9.1, §5c, §10).
 *
 * Pure / DB-free: runs under vitest.unit.config.ts with zero infra. Covers the
 * group resolution that detection AND createFact supersession now share, and
 * the total order (valid_at → chunk_index → confidence → stable id) that makes
 * supersession order-independent.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveExclusiveGroup,
  compareFactPrecedence,
  latestValid,
  type FactPrecedence,
} from '../../services/exclusive-groups.js';

describe('resolveExclusiveGroup', () => {
  it('folds the title/role sprawl into one role_title group', () => {
    for (const p of [
      'job_title', 'title', 'role', 'role_at', 'position', 'occupation',
      'has_role', 'has_job_title', 'has_title', 'cto_at', 'ceo_of', 'works_as',
    ]) {
      expect(resolveExclusiveGroup(p)).toBe('role_title');
    }
  });

  it('folds HQ, residence and relocation predicates into one location group', () => {
    for (const p of [
      // org HQ
      'headquartered_in', 'headquarters', 'hq', 'head_office_in', 'head_office',
      // person residence (lives_in + aliases)
      'lives_in', 'resides_in', 'based_in', 'located_in', 'lived_in', 'used_to_live_in',
      // relocation verbs
      'relocated_to', 'moved_to', 'relocated',
    ]) {
      expect(resolveExclusiveGroup(p)).toBe('location');
    }
  });

  it('matches on raw OR canonical form (case-insensitive)', () => {
    expect(resolveExclusiveGroup('HEADQUARTERED_IN')).toBe('location');
    expect(resolveExclusiveGroup('Relocated_To')).toBe('location');
  });

  it('keys an ungrouped ontology-exclusive predicate by its canonical form', () => {
    expect(resolveExclusiveGroup('works_at')).toBe('works_at');
    expect(resolveExclusiveGroup('employed_at')).toBe('works_at'); // alias → canonical
    expect(resolveExclusiveGroup('born_in')).toBe('born_in');
    expect(resolveExclusiveGroup('married_to')).toBe('married_to');
    expect(resolveExclusiveGroup('spouse_of')).toBe('married_to');
  });

  it('returns null for non-exclusive / unknown predicates', () => {
    expect(resolveExclusiveGroup('knows')).toBeNull();
    expect(resolveExclusiveGroup('friend_of')).toBeNull();
    expect(resolveExclusiveGroup('visited')).toBeNull();
    expect(resolveExclusiveGroup('totally_made_up_predicate')).toBeNull();
  });
});

describe('compareFactPrecedence — the total order (doc 41 §10)', () => {
  const d = (s: string) => new Date(s);

  it('ranks by valid_at first: later date wins', () => {
    const older: FactPrecedence = { validAt: d('2020-01-01'), id: 'a' };
    const newer: FactPrecedence = { validAt: d('2022-01-01'), id: 'b' };
    expect(compareFactPrecedence(older, newer)).toBeLessThan(0);
    expect(compareFactPrecedence(newer, older)).toBeGreaterThan(0);
    expect(latestValid([older, newer])!.id).toBe('b');
    // order-independent: reversing the input does not change the winner
    expect(latestValid([newer, older])!.id).toBe('b');
  });

  it('a dated fact outranks an undated one', () => {
    const dated: FactPrecedence = { validAt: d('2019-01-01'), id: 'a' };
    const undated: FactPrecedence = { validAt: null, id: 'b' };
    expect(latestValid([dated, undated])!.id).toBe('a');
    expect(latestValid([undated, dated])!.id).toBe('a');
  });

  it('falls back to chunk_index for undated facts (later narration wins)', () => {
    const early: FactPrecedence = { validAt: null, chunkIndex: 1, id: 'a' };
    const late: FactPrecedence = { validAt: null, chunkIndex: 5, id: 'b' };
    expect(latestValid([early, late])!.id).toBe('b');
    expect(latestValid([late, early])!.id).toBe('b');
  });

  it('falls back to confidence when valid_at and chunk_index tie', () => {
    const lowConf: FactPrecedence = { validAt: d('2021-01-01'), confidence: 0.6, id: 'a' };
    const highConf: FactPrecedence = { validAt: d('2021-01-01'), confidence: 0.9, id: 'b' };
    expect(latestValid([lowConf, highConf])!.id).toBe('b');
    expect(latestValid([highConf, lowConf])!.id).toBe('b');
  });

  it('uses the stable id as the final, deterministic tiebreak', () => {
    // identical on every other key → id decides, identically regardless of order
    const x: FactPrecedence = { validAt: d('2021-01-01'), confidence: 0.8, id: 'aaa' };
    const y: FactPrecedence = { validAt: d('2021-01-01'), confidence: 0.8, id: 'zzz' };
    expect(latestValid([x, y])!.id).toBe('zzz');
    expect(latestValid([y, x])!.id).toBe('zzz');
  });

  it('produces a winner independent of insertion order across a mixed group', () => {
    const facts: FactPrecedence[] = [
      { validAt: d('2019-01-01'), confidence: 1.0, id: 'boston' },
      { validAt: d('2022-01-01'), confidence: 0.7, id: 'austin' },
      { validAt: d('2021-01-01'), confidence: 0.9, id: 'denver' },
    ];
    const forwardWinner = latestValid(facts)!.id;
    const reverseWinner = latestValid([...facts].reverse())!.id;
    expect(forwardWinner).toBe('austin'); // latest valid_at, despite lower confidence
    expect(reverseWinner).toBe('austin');
  });
});
