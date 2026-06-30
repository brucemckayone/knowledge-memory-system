/**
 * Ground-truth correctness scoring (doc 39 §2.A + §3.2, nmemo-hm4.4).
 *
 * PURE, deterministic scoring of a captured {@link RichGraph} against a
 * hand-authored GOLD reference - no LLM, no DB. Where {@link runInvariants}
 * (graph-invariants.ts) checks the graph is SELF-CONSISTENT, this layer checks
 * it is CORRECT: does it faithfully represent the source? Two runs that make the
 * same mistake agree on every doc-38 metric while both being wrong; only a
 * reference graph catches that.
 *
 * The capability is GENERAL - {@link scoreAgainstGold} works for any corpus; the
 * authored `corpus10.gold.json` is merely the first {@link GoldGraph} instance
 * (doc 39 "generalize design"). It reports:
 *  - entity precision/recall/F1 (fuzzy name match vs gold);
 *  - current-fact precision/recall/F1 over ACTIVE facts (subject +
 *    predicate-or-exclusive-group + object, normalised);
 *  - {@link CorrectnessReport.currentStateCorrectness} - for each exclusive
 *    expectation (a person's title, a company's HQ): EXACTLY ONE active fact in
 *    that (subject, group) AND its object matches. This scores the 5-titles /
 *    2-HQs supersession failure directly;
 *  - {@link CorrectnessReport.predicateSprawl} - distinct predicates per
 *    exclusive group present (>1 is the supersession-defeating signal).
 *
 * Allowed imports mirror graph-invariants.ts: a TYPE-ONLY `RichGraph` (erased at
 * runtime) and the pure value `resolveExclusiveGroup`. The fuzzy F1 math is
 * inlined (test/quality/helpers.ts pulls in the DB-backed test setup, so it is
 * not pure-importable) but matches its semantics exactly. So this module never
 * transitively imports the DB pool and stays unit-testable under
 * vitest.unit.config.ts.
 */

import type { RichGraph } from './graph-canonical-query.js';
import { resolveExclusiveGroup } from './graph-invariants.js';

// ============================================
// Gold reference shape
// ============================================

/**
 * Hand-authored reference graph for one corpus: the expected truth used to score
 * CORRECTNESS (not just self-consistency). `currentFacts` are the latest-stated,
 * non-superseded facts; `expiredFacts` are those that SHOULD have been
 * superseded; `exclusiveExpectations` pin the single correct CURRENT value for
 * each exclusive attribute (latest-stated wins). `group` is a
 * {@link resolveExclusiveGroup} name (e.g. `role_title` / `org_hq` / `works_at`).
 */
export interface GoldGraph {
  corpus: string;
  entities: Array<{ name: string; type: string }>;
  currentFacts: Array<{ subject: string; predicate: string; object: string }>;
  expiredFacts?: Array<{ subject: string; predicate: string; object: string }>;
  exclusiveExpectations: Array<{ subject: string; group: string; expectedObject: string }>;
}

// ============================================
// Report shape
// ============================================

/** Precision / recall / F1 triple for one comparison axis. */
export interface PRF1 {
  precision: number;
  recall: number;
  f1: number;
}

/** One gold exclusive expectation, with the verdict + why it failed. */
export interface ExpectationResult {
  subject: string;
  group: string;
  expectedObject: string;
  /** Active objects the graph actually holds for (subject, group). */
  actualObjects: string[];
  /** True iff EXACTLY ONE active object exists and it matches the expectation. */
  pass: boolean;
}

/** Distinct active predicates a SINGLE subject holds in one exclusive group
 * (>1 = real sprawl: the same subject's one logical relation split across
 * several predicate strings). Keyed per-subject so it agrees with the
 * subject-aware `singleActivePerExclusiveGroup` invariant — two DIFFERENT
 * subjects each holding a different predicate in the same coarse group (a
 * person's `lives_in` and an org's `headquartered_in`) is NOT sprawl. */
export interface SprawlEntry {
  subject: string;
  group: string;
  predicateCount: number;
  predicates: string[];
}

export interface CorrectnessReport {
  corpus: string;
  /** Entity P/R/F1 (fuzzy, case-insensitive name match vs gold). */
  entities: PRF1;
  /** Current (ACTIVE) fact P/R/F1 vs gold.currentFacts. */
  currentFacts: PRF1;
  /**
   * Fraction (0..1) of gold.exclusiveExpectations that pass: exactly one active
   * fact in the (subject, group) AND its object matches the expectation. 1 when
   * there are no expectations.
   */
  currentStateCorrectness: number;
  /** Per-expectation verdicts (failing entries are `pass === false`). */
  expectations: ExpectationResult[];
  /** Exclusive groups present in the graph with >1 distinct active predicate. */
  predicateSprawl: SprawlEntry[];
  /** Gold entity names not found in the graph. */
  missingEntities: string[];
  /** Graph entity names with no gold counterpart. */
  extraEntities: string[];
  /** Gold current facts not found among the graph's active facts. */
  missingFacts: Array<{ subject: string; predicate: string; object: string }>;
  /** Active graph facts with no gold counterpart (printed subject/pred/object). */
  extraFacts: Array<{ subject: string; predicate: string; object: string }>;
}

// ============================================
// Fuzzy matching (inlined from test/quality/helpers.ts - same semantics)
// ============================================

/** Case-insensitive bidirectional substring match (the helpers.ts fuzzy rule). */
const fuzzyEq = (a: string, b: string): boolean => {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (x === '' || y === '') return x === y;
  return x.includes(y) || y.includes(x);
};

/**
 * Recall: fraction of `expected` matched by some `found`. Recall=1 when nothing
 * is expected. Mirrors `computeRecall` in test/quality/helpers.ts.
 */
function recall(expected: string[], found: string[]): number {
  if (expected.length === 0) return 1;
  let hits = 0;
  for (const e of expected) if (found.some((f) => fuzzyEq(e, f))) hits += 1;
  return hits / expected.length;
}

/**
 * Precision: fraction of `found` matched by some `expected`. Precision=1 when
 * nothing was found and nothing was expected, else 0. Mirrors `computePrecision`.
 */
function precision(expected: string[], found: string[]): number {
  if (found.length === 0) return expected.length === 0 ? 1 : 0;
  let hits = 0;
  for (const f of found) if (expected.some((e) => fuzzyEq(e, f))) hits += 1;
  return hits / found.length;
}

/** Harmonic mean of precision + recall (0 when both are 0). Mirrors `computeF1`. */
const f1 = (p: number, r: number): number => (p + r === 0 ? 0 : (2 * p * r) / (p + r));

const prf1 = (expected: string[], found: string[]): PRF1 => {
  const p = precision(expected, found);
  const r = recall(expected, found);
  return { precision: p, recall: r, f1: f1(p, r) };
};

// ============================================
// Fact normalisation
// ============================================

type RichFact = RichGraph['facts'][number];

/** A fact is active when it has not been superseded/expired. */
const isActive = (f: RichFact): boolean => f.expiredAt == null;

/** Lowercased, whitespace-collapsed key piece for fuzzy fact comparison. */
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Predicate dimension for fact matching: the exclusive GROUP if the predicate
 * resolves to one (so `job_title`/`title`/`cto_at` all compare equal under
 * `role_title`), else the normalised predicate string. Lets a gold fact stated
 * with one predicate match a graph fact stated with a sibling predicate.
 */
const predicateKey = (predicate: string): string => resolveExclusiveGroup(predicate) ?? norm(predicate);

/** A graph fact + its resolved entity names, projected for comparison. */
interface ProjectedFact {
  subject: string;
  predicate: string;
  object: string;
}

/**
 * Canonical comparison string for a fact: `subject :: predicate-or-group ::
 * object`, all normalised. Two facts are "the same" iff these strings match
 * (with fuzzy subject/object substring tolerance handled by the P/R/F1 layer).
 */
const factKey = (f: { subject: string; predicate: string; object: string }): string =>
  `${norm(f.subject)} :: ${predicateKey(f.predicate)} :: ${norm(f.object)}`;

// ============================================
// Scoring
// ============================================

/**
 * Score a captured rich graph against a hand-authored gold reference. Pure +
 * deterministic. Entity names are resolved from ids via `graph.entities`; an
 * object is the linked entity's name when `objectEntityId` is set, else the
 * literal `objectValue`.
 */
export function scoreAgainstGold(graph: RichGraph, gold: GoldGraph): CorrectnessReport {
  const nameById = new Map<string, string>();
  for (const e of graph.entities) nameById.set(e.id, e.name);

  // --- entities (fuzzy P/R/F1) ---
  const goldEntityNames = gold.entities.map((e) => e.name);
  const graphEntityNames = graph.entities.map((e) => e.name);
  const entities = prf1(goldEntityNames, graphEntityNames);
  const missingEntities = goldEntityNames.filter((g) => !graphEntityNames.some((n) => fuzzyEq(g, n)));
  const extraEntities = graphEntityNames.filter((n) => !goldEntityNames.some((g) => fuzzyEq(g, n)));

  // --- current (active) facts ---
  // Project each ACTIVE graph fact to subject/predicate/object names. Skip facts
  // whose subject id is unknown (dangling) - referentialIntegrity owns that.
  const activeProjected: ProjectedFact[] = [];
  for (const f of graph.facts) {
    if (!isActive(f)) continue;
    const subject = nameById.get(f.subjectEntityId);
    if (subject == null) continue;
    const object = f.objectEntityId != null ? nameById.get(f.objectEntityId) ?? '' : f.objectValue ?? '';
    activeProjected.push({ subject, predicate: f.predicate, object });
  }

  // Compare on canonical fact keys (subject + predicate-or-group + object), so a
  // gold fact and a graph fact that differ only in sibling predicate / casing /
  // spacing still match.
  const goldFactKeys = gold.currentFacts.map(factKey);
  const graphFactKeys = activeProjected.map(factKey);
  const currentFacts = prf1(goldFactKeys, graphFactKeys);

  const matchedGold = new Set(graphFactKeys);
  const matchedGraph = new Set(goldFactKeys);
  const missingFacts = gold.currentFacts.filter((g) => !matchedGold.has(factKey(g)));
  const extraFacts = activeProjected.filter((p) => !matchedGraph.has(factKey(p)));

  // --- current-state correctness (the exclusive-expectation scorer) ---
  // Group active facts by (subjectName, exclusive group) -> distinct objects.
  interface GroupBucket { objects: Set<string>; predicates: Set<string> }
  const buckets = new Map<string, GroupBucket>();
  for (const p of activeProjected) {
    const group = resolveExclusiveGroup(p.predicate);
    if (group == null) continue;
    const key = `${norm(p.subject)} :: ${group}`;
    const bucket = buckets.get(key) ?? { objects: new Set<string>(), predicates: new Set<string>() };
    if (p.object !== '') bucket.objects.add(norm(p.object));
    bucket.predicates.add(norm(p.predicate));
    buckets.set(key, bucket);
  }

  const expectations: ExpectationResult[] = gold.exclusiveExpectations.map((exp) => {
    const bucket = buckets.get(`${norm(exp.subject)} :: ${exp.group}`);
    const actualObjects = bucket ? [...bucket.objects] : [];
    // EXACTLY ONE active object AND it matches the expectation (fuzzy).
    const pass = actualObjects.length === 1 && fuzzyEq(actualObjects[0]!, exp.expectedObject);
    return { subject: exp.subject, group: exp.group, expectedObject: exp.expectedObject, actualObjects, pass };
  });
  const currentStateCorrectness =
    expectations.length === 0 ? 1 : expectations.filter((e) => e.pass).length / expectations.length;

  // --- predicate sprawl (per SUBJECT+group, distinct predicate strings) ---
  // Keyed on (subject, group), not group alone: real sprawl is one subject
  // expressing one logical relation under several predicate strings. Two
  // different subjects each in the same coarse group (a person `lives_in`, an
  // org `headquartered_in`) is not sprawl — and a subject-blind count would
  // disagree with the `singleActivePerExclusiveGroup` invariant.
  const predicateSprawl: SprawlEntry[] = [];
  const subjGroupPredicates = new Map<string, { subject: string; group: string; preds: Set<string> }>();
  for (const p of activeProjected) {
    const group = resolveExclusiveGroup(p.predicate);
    if (group == null) continue;
    const key = `${norm(p.subject)} :: ${group}`;
    const entry = subjGroupPredicates.get(key) ?? { subject: norm(p.subject), group, preds: new Set<string>() };
    entry.preds.add(norm(p.predicate));
    subjGroupPredicates.set(key, entry);
  }
  for (const { subject, group, preds } of subjGroupPredicates.values()) {
    if (preds.size > 1) predicateSprawl.push({ subject, group, predicateCount: preds.size, predicates: [...preds] });
  }

  return {
    corpus: gold.corpus,
    entities,
    currentFacts,
    currentStateCorrectness,
    expectations,
    predicateSprawl,
    missingEntities,
    extraEntities,
    missingFacts,
    extraFacts,
  };
}
