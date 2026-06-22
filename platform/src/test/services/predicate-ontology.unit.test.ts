/**
 * Predicate ontology canonicalization — pure unit tests (bead nmemo-hm4.10).
 *
 * The supersession gap behind Elena's 5 coexisting titles and Helix's two HQs:
 * `title`/`role`/`role_at`/… and `headquartered_in`/`hq`/… were not in
 * CANONICAL_ONTOLOGY, so they were neither collapsed to one predicate string
 * nor marked exclusive — and createFact only supersedes an exact, exclusive
 * predicate. These tests pin the fix: the alias sprawl now folds onto the two
 * exclusive canonicals `job_title` and `headquartered_in`, while the existing
 * predicates' normalization and exclusivity are unchanged.
 *
 * Pure: imports only the DB-free predicate-ontology module (no DB, no infra),
 * so it runs under vitest.unit.config.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  CANONICAL_ONTOLOGY,
  normalizePredicate,
  getPredicateInfo,
} from '../../services/predicate-ontology.js';

describe('predicate canonicalization — job_title / headquartered_in (nmemo-hm4.10)', () => {
  describe('title/role sprawl folds onto exclusive job_title', () => {
    it('normalizes title aliases to job_title', () => {
      expect(normalizePredicate('title')).toBe('job_title');
      expect(normalizePredicate('role')).toBe('job_title');
      expect(normalizePredicate('role_at')).toBe('job_title');
      expect(normalizePredicate('position')).toBe('job_title');
      expect(normalizePredicate('designation')).toBe('job_title');
      // whitespace + case are structurally normalized before alias lookup
      expect(normalizePredicate('Current Title')).toBe('job_title');
      expect(normalizePredicate('JOB_ROLE')).toBe('job_title');
    });

    it('job_title is exclusive', () => {
      expect(getPredicateInfo('title')?.isExclusive).toBe(true);
      expect(getPredicateInfo('job_title')?.isExclusive).toBe(true);
    });
  });

  describe('HQ sprawl folds onto exclusive headquartered_in', () => {
    it('normalizes HQ aliases to headquartered_in', () => {
      // "Head Office" -> head_office (whitespace->_) -> headquartered_in
      expect(normalizePredicate('Head Office')).toBe('headquartered_in');
      expect(normalizePredicate('headquarters')).toBe('headquartered_in');
      expect(normalizePredicate('hq')).toBe('headquartered_in');
      expect(normalizePredicate('hq_in')).toBe('headquartered_in');
      expect(normalizePredicate('head_office_in')).toBe('headquartered_in');
    });

    it('headquartered_in is exclusive', () => {
      expect(getPredicateInfo('hq')?.isExclusive).toBe(true);
      expect(getPredicateInfo('headquartered_in')?.isExclusive).toBe(true);
    });
  });

  describe('REGRESSION — existing predicates unchanged', () => {
    it('works_at and lives_in still normalize to themselves', () => {
      expect(normalizePredicate('works_at')).toBe('works_at');
      expect(normalizePredicate('lives_in')).toBe('lives_in');
    });

    it('ceo_of stays a separate exclusive predicate (not folded into job_title)', () => {
      expect(normalizePredicate('ceo_of')).toBe('ceo_of');
      expect(getPredicateInfo('ceo_of')?.isExclusive).toBe(true);
    });

    it('based_in / located_in still belong to lives_in (NOT headquartered_in)', () => {
      // Guards against an HQ alias accidentally hijacking a residence predicate.
      expect(normalizePredicate('based_in')).toBe('lives_in');
      expect(normalizePredicate('located_in')).toBe('lives_in');
    });
  });

  describe('every alias maps to exactly one canonical (no collisions)', () => {
    it('no alias string is claimed by two different canonicals', () => {
      // The load-bearing determinism invariant: aliasToCanonical is a Map, so if
      // two canonicals declared the same alias, normalizePredicate would resolve
      // it to whichever was inserted last — non-deterministic w.r.t. ontology
      // ordering. This must hold across the WHOLE ontology, including the two
      // predicates this bead added.
      const aliasOwner = new Map<string, string>();
      const collisions: string[] = [];

      for (const [canonical, info] of Object.entries(CANONICAL_ONTOLOGY)) {
        for (const rawAlias of info.aliases) {
          const alias = rawAlias.toLowerCase();
          const prior = aliasOwner.get(alias);
          if (prior && prior !== canonical) {
            collisions.push(`alias '${alias}' claimed by both '${prior}' and '${canonical}'`);
          }
          aliasOwner.set(alias, canonical);
        }
      }

      expect(collisions).toEqual([]);
    });

    it("this bead's new aliases do not shadow a canonical key and are claimed only by their own canonical", () => {
      // Scoped to the nmemo-hm4.10 additions. A pre-existing ontology quirk —
      // `founded` lists `created` (itself a canonical key) as an alias — is
      // deliberately OUT of scope here: normalizePredicate checks canonical keys
      // before aliases, so `created` resolves to itself unambiguously and the
      // overlap never affects title/HQ supersession. Asserting only the new
      // aliases keeps this bead from silently depending on (or "fixing") that
      // unrelated overlap; it is called out in the bead report as a risk note.
      const canonicalKeys = new Set(Object.keys(CANONICAL_ONTOLOGY));
      const newAliases: Record<string, string[]> = {
        job_title: CANONICAL_ONTOLOGY.job_title!.aliases,
        headquartered_in: CANONICAL_ONTOLOGY.headquartered_in!.aliases,
      };

      // Owner map across the whole ontology so we can detect a new alias also
      // appearing under some OTHER canonical.
      const aliasOwners = new Map<string, Set<string>>();
      for (const [canonical, info] of Object.entries(CANONICAL_ONTOLOGY)) {
        for (const a of info.aliases) {
          const al = a.toLowerCase();
          (aliasOwners.get(al) ?? aliasOwners.set(al, new Set()).get(al)!).add(canonical);
        }
      }

      const problems: string[] = [];
      for (const [canonical, aliases] of Object.entries(newAliases)) {
        for (const rawAlias of aliases) {
          const alias = rawAlias.toLowerCase();
          if (canonicalKeys.has(alias)) {
            problems.push(`new alias '${alias}' (of ${canonical}) shadows canonical key '${alias}'`);
          }
          const owners = aliasOwners.get(alias) ?? new Set<string>();
          if (owners.size > 1 || (owners.size === 1 && !owners.has(canonical))) {
            problems.push(`new alias '${alias}' (intended for ${canonical}) is also claimed by ${[...owners].join(', ')}`);
          }
        }
      }

      expect(problems).toEqual([]);
    });
  });
});
