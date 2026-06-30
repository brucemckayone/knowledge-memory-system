/**
 * Semantic (tolerance) diff for canonical graphs — doc 38 correctness upgrade.
 *
 * The exact structural-hash diff in graph-canonical.ts answers "are these two
 * graphs byte-identical?" — too strict for an LLM-driven pipeline. A
 * non-deterministic agent phrases the SAME fact differently run to run
 * ("role_at" vs "title") and emits entity-name variants ("Elena" vs
 * "Elena Vasquez"), so exact identity fails even on two SAME-order runs and
 * can't separate a genuine order/parallelism effect from extraction noise.
 *
 * This module scores graph OVERLAP with tolerance instead:
 *   - entities match on fuzzy name (case-insensitive bidirectional substring,
 *     as in test/quality/helpers.ts) + normalised type — so "elena" and
 *     "elena vasquez" count as the same referent.
 *   - facts match on matched-subject + matched-object + NORMALISED predicate
 *     (lower-cased, punctuation-folded). Predicate SYNONYMS are NOT collapsed
 *     (lexical only), so fact F1 is a LOWER BOUND on semantic agreement. That
 *     is fine when paired with a determinism control (same corpus, same order,
 *     twice): the question becomes "is forward-vs-reverse F1 ≈ the same-order
 *     F1?" rather than the unanswerable "= 1.0?".
 *
 * Pure (no DB, no test-infra import) so it is unit-testable like
 * graph-canonical.ts. It reads only the CanonicalGraph keys, parsing them back
 * into components — no change to the canonical export.
 *
 * Caveat: bidirectional-substring name matching can over-match very short
 * names (mirrors the existing helpers heuristic). Acceptable for run-to-run
 * overlap scoring; revisit with token/embedding matching if it bites.
 */

import type { CanonicalGraph } from './graph-canonical.js';

/** Precision / recall / F1 for one layer (entities or facts), plus raw counts. */
export interface Prf {
  precision: number;
  recall: number;
  f1: number;
  matchedA: number;
  matchedB: number;
  totalA: number;
  totalB: number;
}

export interface SemanticDiff {
  entity: Prf;
  fact: Prf;
}

// Type-synonym folding — mirrors normalizeEntityType in test/quality/helpers.ts.
const TYPE_SYNONYMS: Record<string, string> = {
  person: 'person', people: 'person', individual: 'person',
  company: 'company', organization: 'company', organisation: 'company', org: 'company', business: 'company',
  place: 'place', location: 'place', city: 'place', country: 'place', region: 'place', geo: 'place',
  project: 'project', initiative: 'project',
  concept: 'concept', technology: 'concept', tool: 'concept', framework: 'concept', skill: 'concept', tech: 'concept',
  product: 'product', service: 'product',
  team: 'team', group: 'team', department: 'team',
};

export function normalizeType(type: string): string {
  const t = type.trim().toLowerCase();
  return TYPE_SYNONYMS[t] ?? t;
}

/** Fold predicate phrasing to a canonical token: lower-case, punctuation→'_'. */
export function normalizePredicate(pred: string): string {
  return pred.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export interface Ent {
  name: string;
  type: string;
}

/** Parse an entity key `name|type` (split on the LAST '|' — type has none). */
export function parseEntityKey(key: string): Ent {
  const i = key.lastIndexOf('|');
  return i < 0 ? { name: key, type: '' } : { name: key.slice(0, i), type: key.slice(i + 1) };
}

export type ObjRef =
  | { kind: 'entity'; ent: Ent }
  | { kind: 'value'; text: string }
  | { kind: 'missing'; raw: string };

function parseObj(key: string): ObjRef {
  if (key.startsWith('value:')) return { kind: 'value', text: key.slice('value:'.length) };
  if (key.startsWith('missing:')) return { kind: 'missing', raw: key };
  return { kind: 'entity', ent: parseEntityKey(key) };
}

export interface ParsedFact {
  subj: Ent;
  pred: string;
  obj: ObjRef;
}

/** Parse a fact key `subj :: pred :: obj`. subj/obj are entity keys (or the
 *  obj may be `value:…`). The predicate is everything between, normalised. */
export function parseFactKey(key: string): ParsedFact {
  const parts = key.split(' :: ');
  const subj = parseEntityKey(parts[0] ?? '');
  const obj = parseObj(parts[parts.length - 1] ?? '');
  const pred = normalizePredicate(parts.slice(1, -1).join(' :: '));
  return { subj, pred, obj };
}

/** Case-insensitive bidirectional substring match (the helpers.ts heuristic). */
function fuzzyNameEq(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return x === y;
  return x === y || x.includes(y) || y.includes(x);
}

function entEq(a: Ent, b: Ent): boolean {
  return normalizeType(a.type) === normalizeType(b.type) && fuzzyNameEq(a.name, b.name);
}

function objEq(a: ObjRef, b: ObjRef): boolean {
  if (a.kind === 'entity' && b.kind === 'entity') return entEq(a.ent, b.ent);
  if (a.kind === 'value' && b.kind === 'value') return fuzzyNameEq(a.text, b.text);
  return false;
}

function factEq(a: ParsedFact, b: ParsedFact): boolean {
  return a.pred === b.pred && entEq(a.subj, b.subj) && objEq(a.obj, b.obj);
}

function f1(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

/** Overlap of two multisets under a tolerant equality. Existence-based (not
 *  strict 1-1): an item counts as matched if ANY item on the other side
 *  matches it. Symmetric precision/recall → F1. Two empty sides score 1. */
function overlap<T>(as: T[], bs: T[], eq: (a: T, b: T) => boolean): Prf {
  const matchedA = as.filter((a) => bs.some((b) => eq(a, b))).length;
  const matchedB = bs.filter((b) => as.some((a) => eq(a, b))).length;
  const precision = as.length === 0 ? (bs.length === 0 ? 1 : 0) : matchedA / as.length;
  const recall = bs.length === 0 ? (as.length === 0 ? 1 : 0) : matchedB / bs.length;
  return { precision, recall, f1: f1(precision, recall), matchedA, matchedB, totalA: as.length, totalB: bs.length };
}

/**
 * Tolerant overlap between two canonical graphs. `a` and `b` are
 * interchangeable (symmetric) — use it for the determinism control
 * (forward vs forward), the litmus (forward vs reverse), or vs-baseline.
 */
export function semanticDiff(a: CanonicalGraph, b: CanonicalGraph): SemanticDiff {
  const entA = a.entities.map(parseEntityKey);
  const entB = b.entities.map(parseEntityKey);
  const factA = a.facts.map((f) => parseFactKey(f.key));
  const factB = b.facts.map((f) => parseFactKey(f.key));
  return {
    entity: overlap(entA, entB, entEq),
    fact: overlap(factA, factB, factEq),
  };
}
