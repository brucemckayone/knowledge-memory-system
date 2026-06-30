/**
 * Exclusive-group ontology + fact-precedence ordering — the SHARED, DB-free
 * core of supersession (doc 41 §9.1, §5c, §10; bead nmemo-vpz.1 / E1).
 *
 * This module is the single definition of "exclusive group" consumed by BOTH
 * sides of the system that the 2026-06-09 benchmark proved were out of sync:
 *
 *   - DETECTION — the graph-integrity invariant `singleActivePerExclusiveGroup`
 *     (`graph-invariants.ts`) and the predicate-consistency scorer
 *     (`graph-correctness.ts`), which flag coexisting facts in one group.
 *   - PREVENTION — `createFact`'s supersession path (`facts.ts`), which expires
 *     all-but-the-latest-valid fact in a group on write.
 *
 * Before E1, `resolveExclusiveGroup` lived in `graph-invariants.ts` and was
 * used only by detection; `createFact` matched on an EXACT predicate string, so
 * cross-predicate sprawl (`job_title`/`has_job_title`/`has_role`,
 * `lives_in`/`relocated_to`/`headquartered_in`) was never superseded and
 * mutually-exclusive facts coexisted. Lifting the resolver here — and adding the
 * precedence comparator — makes "exclusive" mean the GROUP everywhere, and gives
 * E3's deterministic `promote()` the same total order to reuse.
 *
 * Allowed imports: the pure `predicate-ontology.ts` value module only — so this
 * module never transitively pulls in the DB pool and stays unit-testable under
 * vitest.unit.config.ts (same constraint `graph-invariants.ts` carries).
 */

import { normalizePredicate, getPredicateInfo } from './predicate-ontology.js';

// ============================================
// Exclusive-group resolution
// ============================================

/**
 * Cross-predicate exclusivity groups the canonical ontology does NOT model on
 * its own — the sprawl the benchmark (parallel-ingestion-2026-06-09 §7) said
 * must collapse BEFORE the supersession check. Members are matched against the
 * raw lowercased predicate OR its canonical normalisation.
 *
 * - `role_title` — one current title/role per person. Folds the title sprawl
 *   plus several ontology-exclusive role predicates (`ceo_of`, …) into one group.
 * - `location` — one current location per subject. Deliberately spans BOTH a
 *   person's residence (`lives_in` + relocation verbs) AND an organisation's HQ
 *   (`headquartered_in` + variants), because the benchmark showed a single
 *   subject (e.g. Helix) carrying `lives_in Boston` + `relocated_to Austin` +
 *   `headquartered_in Austin` at once — three predicates, one logical attribute.
 *   Group matching is predicate-only and applied per-subject, so a person's
 *   residence facts and an org's HQ facts each collapse correctly and never
 *   cross-contaminate (a person has no `headquartered_in`; an org has no real
 *   `lives_in`). NOTE: this intentionally over-collapses the rare "geographic
 *   containment" sense of `located_in` (itself flagged as overloaded in the
 *   benchmark) — accepted for E1; revisit if it bites.
 */
export const AUGMENTATION_GROUPS: Record<string, Set<string>> = {
  role_title: new Set([
    'job_title', 'title', 'role_at', 'role', 'position', 'job', 'occupation',
    'works_as', 'serves_as', 'holds_title', 'has_title', 'has_role', 'has_job_title',
    'cto_at', 'cto_of', 'ceo_of', 'cfo_of', 'coo_of',
    'chief_technology_officer', 'chief_executive_officer',
  ]),
  location: new Set([
    // Organisation HQ (the former `org_hq` group)
    'headquartered_in', 'headquarters', 'hq', 'hq_in', 'head_office_in', 'head_office', 'headquartered',
    // Person residence (canonical `lives_in` + its aliases)
    'lives_in', 'resides_in', 'based_in', 'located_in', 'living_in', 'lived_in',
    'formerly_in', 'used_to_live_in',
    // Relocation verbs (predicate sprawl the benchmark flagged for the same attribute)
    'relocated_to', 'moved_to', 'relocated', 'relocation_to', 'moved',
  ]),
};

/**
 * Resolve the exclusivity group a predicate belongs to, or null when it is not
 * exclusive (and so neither checked by {@link AUGMENTATION_GROUPS}-consuming
 * detection nor superseded by prevention).
 *
 * Order matters: augmentation groups win first (they fold several
 * ontology-exclusive predicates like `ceo_of` and `lives_in` into a broader
 * group), then any remaining ontology-exclusive predicate is its own group
 * keyed by its canonical form (e.g. `works_at`, `married_to`, `born_in`).
 */
export function resolveExclusiveGroup(predicate: string): string | null {
  const raw = predicate.toLowerCase();
  const norm = normalizePredicate(predicate);
  for (const [group, members] of Object.entries(AUGMENTATION_GROUPS)) {
    if (members.has(raw) || members.has(norm)) return group;
  }
  if (getPredicateInfo(norm)?.isExclusive) return norm;
  return null;
}

// ============================================
// Fact-precedence ordering (the total order)
// ============================================

/**
 * The minimal shape needed to order two facts within an exclusive group. Kept
 * deliberately narrow (not the full DB `Fact`) so both the live `createFact`
 * path and E3's `promote()` — which orders staged proposals that have no DB row
 * yet — can build it. `chunkIndex` is optional: `createFact` cannot supply it
 * today (it is not a column on `facts`), so the comparator falls through to
 * confidence/id; E4 wires the narration-order source.
 */
export interface FactPrecedence {
  /** Bi-temporal validity start. Null/undefined = undated. */
  validAt: Date | null;
  /** Narration-order fallback for undated facts (doc 41 §5c). Optional today. */
  chunkIndex?: number | null;
  /** Extraction confidence; absent treated as lowest. */
  confidence?: number | null;
  /** Stable identity — the deterministic final tiebreak (doc 41 §10). */
  id: string;
}

// Each field comparator returns >0 when `a` ranks AFTER `b` (a is later / wins),
// <0 when `a` ranks before `b`, 0 on a tie (defer to the next field). Sorting an
// array ascending with compareFactPrecedence therefore puts the WINNER LAST.

function cmpValidAt(a: FactPrecedence, b: FactPrecedence): number {
  const av = a.validAt ?? null;
  const bv = b.validAt ?? null;
  if (av && bv) return av.getTime() - bv.getTime(); // later date wins
  if (av && !bv) return 1;                          // dated beats undated
  if (!av && bv) return -1;
  return 0;                                         // both undated → next key
}

function cmpChunkIndex(a: FactPrecedence, b: FactPrecedence): number {
  const aHas = a.chunkIndex != null;
  const bHas = b.chunkIndex != null;
  if (aHas && bHas) return a.chunkIndex! - b.chunkIndex!; // later in narration wins
  if (aHas && !bHas) return 1;
  if (!aHas && bHas) return -1;
  return 0;
}

function cmpConfidence(a: FactPrecedence, b: FactPrecedence): number {
  return (a.confidence ?? 0) - (b.confidence ?? 0); // higher confidence wins
}

function cmpId(a: FactPrecedence, b: FactPrecedence): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // stable, total, deterministic
}

/**
 * Total order over facts in one exclusive group (doc 41 §10):
 * `valid_at → chunk_index → confidence → stable id`. Independent of the order
 * facts arrived in, so `promote(forward) == promote(reverse)` for the
 * deterministic backbone and `createFact` keeps the latest-VALID fact active
 * rather than the last-COMMITTED one (bead nmemo-bsb).
 *
 * Ascending sort ⇒ the winner is the last element.
 */
export function compareFactPrecedence(a: FactPrecedence, b: FactPrecedence): number {
  return cmpValidAt(a, b) || cmpChunkIndex(a, b) || cmpConfidence(a, b) || cmpId(a, b);
}

/**
 * Convenience: return the single latest-valid fact among a non-empty list
 * (the active winner of an exclusive group). Returns undefined for an empty list.
 */
export function latestValid<T extends FactPrecedence>(facts: readonly T[]): T | undefined {
  if (facts.length === 0) return undefined;
  return [...facts].sort(compareFactPrecedence)[facts.length - 1];
}
